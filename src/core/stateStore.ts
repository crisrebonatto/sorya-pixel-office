import { EventEmitter } from 'events';
import {
  Activity,
  ActivityKind,
  Agent,
  AgentSource,
  AgentState,
  GhostDesk,
  NormalizedEvent,
  OfficeSnapshot,
  SourceInfo,
  Task,
  TaskStatus
} from './types';
import { DeskManager } from './deskManager';

/**
 * Estado em memória, e SÓ em memória: nada é persistido em disco. Tudo o
 * que o escritório mostra é reconstruído dos registros locais das
 * ferramentas (e dos hooks, quando instalados) a cada ativação.
 */

export interface StoreOptions {
  desks: number;
  /** Sessão ociosa sai do escritório depois deste tempo sem eventos. */
  idleTimeoutMs: number;
  /** Nome exibido para um agente (persona, apelido, fonte). */
  resolveName: (agent: { source: AgentSource; kind: Agent['kind']; type: string; name?: string }) => string;
  now?: () => number;
}

interface PendingTool {
  tool: string;
  since: number;
  needsApproval: boolean;
  state: AgentState;
  action?: string;
}

interface AgentRecord extends Agent {
  pending: Map<string, PendingTool>;
  seen: Set<string>;
  promptTaskId?: string;
  promptCount: number;
  heuristicWaiting: boolean;
  removeAt?: number;
  explicitName?: string;
}

const MAX_ACTIVITY = 240;
const MAX_TASKS = 220;
const MAX_FILES = 30;
const ERROR_HOLD_MS = 5000;
const WAIT_HEURISTIC_MS = 7000;
const STALE_EVENT_MS = 3 * 60 * 60 * 1000;
const SUBAGENT_ORPHAN_MS = 12 * 60 * 1000;
const WORKING_SILENCE_MS = 20 * 60 * 1000;
const SPARK_BUCKET_MS = 10000;
const SPARK_LEN = 30;

export class StateStore extends EventEmitter {
  private agents = new Map<string, AgentRecord>();
  private tasks = new Map<string, Task>();
  private activity: Activity[] = [];
  private sources = new Map<AgentSource, SourceInfo>();
  private hookSources = new Map<AgentSource, number>();
  private spark: number[] = new Array(SPARK_LEN).fill(0);
  private sparkAt = 0;
  private seq = 0;
  private emitTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  readonly desks: DeskManager;
  host: OfficeSnapshot['host'] = {};

  constructor(private opts: StoreOptions) {
    super();
    this.desks = new DeskManager(opts.desks);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  start(): void {
    this.sweepTimer = setInterval(() => this.sweep(), 2000);
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
  }

  setIdleTimeout(ms: number): void {
    this.opts.idleTimeoutMs = ms;
  }

  // ── Fontes ─────────────────────────────────────────────────────────
  setSource(info: SourceInfo): void {
    const prev = this.sources.get(info.id);
    this.sources.set(info.id, Object.assign({}, prev, info));
    this.changed();
  }

  markHooks(source: AgentSource): void {
    this.hookSources.set(source, this.now());
  }

  private hooksActive(source: AgentSource): boolean {
    const at = this.hookSources.get(source);
    return at !== undefined && this.now() - at < 30 * 60 * 1000;
  }

  // ── Aplicação de eventos ───────────────────────────────────────────
  apply(e: NormalizedEvent): void {
    const now = this.now();
    let agent = this.agents.get(e.agentId);

    if (!agent) {
      // Eventos que só fazem sentido para quem já está no escritório.
      const passive = ['session-end', 'agent-stop', 'turn-end', 'turn-aborted', 'task-remove', 'usage', 'heartbeat', 'meta'];
      if (passive.includes(e.kind)) return;
      // histórico antigo não ressuscita agente
      if (now - e.at > Math.min(this.opts.idleTimeoutMs, STALE_EVENT_MS)) return;
      agent = this.createAgent(e);
    }

    agent.lastEventAt = Math.max(agent.lastEventAt, e.at);
    this.updateMeta(agent, e);
    if (!e.replay) this.bumpSpark(now);

    switch (e.kind) {
      case 'session-start':
      case 'agent-start':
        if (agent.removeAt) agent.removeAt = undefined;
        if (e.kind === 'agent-start') {
          if (agent.state === 'done' || agent.state === 'idle') this.setState(agent, 'thinking', undefined, e.at);
          if (e.taskTitle) this.startSubagentTask(agent, e);
        }
        break;

      case 'prompt': {
        this.finishPromptTask(agent, 'done', e.at);
        agent.pending.clear();
        agent.heuristicWaiting = false;
        this.setState(agent, 'thinking', undefined, e.at);
        agent.promptCount += 1;
        const id = agent.id + ':p' + (e.key || agent.promptCount);
        const title = e.taskTitle || 'Pedido #' + agent.promptCount;
        this.upsertTask({
          id,
          title,
          status: 'running',
          kind: 'prompt',
          assignee: agent.id,
          source: agent.source,
          project: agent.project,
          createdAt: e.at,
          startedAt: e.at
        });
        agent.promptTaskId = id;
        agent.taskId = id;
        this.log(agent, 'prompt', 'novo pedido: ' + title, e);
        break;
      }

      case 'tool-start': {
        const dup = e.key ? agent.seen.has('s:' + e.key) : false;
        if (e.key) this.remember(agent, 's:' + e.key);
        const state = e.state || 'thinking';
        if (e.key) {
          agent.pending.set(e.key, { tool: e.tool || '', since: e.at, needsApproval: !!e.needsApproval, state, action: e.action });
        }
        agent.heuristicWaiting = false;
        this.setState(agent, state, e.action, e.at);
        agent.currentTool = e.tool;
        if (!dup) {
          agent.stats.tools += 1;
          if (state === 'writing') agent.stats.edits += 1;
          if (state === 'running') agent.stats.commands += 1;
          if (state === 'reading') agent.stats.reads += 1;
          if (state === 'searching') agent.stats.searches += 1;
          if (e.file) this.touchFile(agent, e.file);
          if (state === 'waiting') this.notifyWaiting(agent, e);
          else if (e.action) this.log(agent, 'tool', e.action, e);
        }
        break;
      }

      case 'tool-end':
      case 'tool-error': {
        const dup = e.key ? agent.seen.has('e:' + e.key) : false;
        if (e.key) this.remember(agent, 'e:' + e.key);
        const pending = e.key ? agent.pending.get(e.key) : undefined;
        if (e.key) agent.pending.delete(e.key);
        agent.heuristicWaiting = false;
        if (e.kind === 'tool-error') {
          if (!dup) {
            agent.stats.errors += 1;
            this.log(agent, 'error', 'falhou: ' + (e.action || (pending && pending.action) || e.tool || 'ferramenta'), e);
          }
          this.setState(agent, 'error', e.action || (pending && pending.action), e.at);
        } else if (agent.state !== 'idle' || agent.pending.size > 0) {
          const next = [...agent.pending.values()].pop();
          if (next) this.setState(agent, next.state, next.action, e.at);
          else this.setState(agent, 'thinking', undefined, e.at);
        }
        break;
      }

      case 'waiting':
        this.setState(agent, 'waiting', e.action || 'aguardando você', e.at);
        this.notifyWaiting(agent, e);
        break;

      case 'turn-end':
        agent.pending.clear();
        agent.heuristicWaiting = false;
        if (agent.kind === 'subagent') {
          this.stopSubagent(agent, e);
          break;
        }
        if (agent.state !== 'idle') this.log(agent, 'idle', 'terminou o turno', e);
        this.setState(agent, 'idle', undefined, e.at);
        this.finishPromptTask(agent, e.taskStatus === 'failed' ? 'failed' : 'done', e.at);
        break;

      case 'turn-aborted':
        agent.pending.clear();
        agent.heuristicWaiting = false;
        this.setState(agent, 'idle', undefined, e.at);
        if (agent.promptTaskId) this.log(agent, 'error', 'interrompido pelo usuário', e);
        this.finishPromptTask(agent, 'failed', e.at);
        break;

      case 'agent-stop':
        this.stopSubagent(agent, e);
        break;

      case 'session-end':
        this.removeAgent(agent.id, e.at, true);
        break;

      case 'task-upsert':
        if (e.taskId && e.taskTitle !== undefined) {
          const id = agent.id + ':t:' + e.taskId;
          const prev = this.tasks.get(id);
          const status = e.taskStatus || (prev ? prev.status : 'pending');
          this.upsertTask({
            id,
            title: e.taskTitle || (prev ? prev.title : 'tarefa'),
            status,
            kind: e.taskKind || 'todo',
            assignee: agent.id,
            source: agent.source,
            project: agent.project,
            createdAt: prev ? prev.createdAt : e.at,
            startedAt: status === 'running' ? (prev && prev.startedAt) || e.at : prev ? prev.startedAt : undefined,
            completedAt: status === 'done' || status === 'failed' ? (prev && prev.completedAt) || e.at : undefined
          });
          if (!prev && e.taskKind === 'prompt') this.log(agent, 'prompt', 'novo pedido: ' + e.taskTitle, e);
          else if (prev && prev.status !== status && status === 'done') this.log(agent, 'task', 'concluiu: ' + (e.taskTitle || prev.title), e);
        } else if (e.taskId && e.taskStatus) {
          const id = agent.id + ':t:' + e.taskId;
          const prev = this.tasks.get(id);
          if (prev) this.updateTaskStatus(id, e.taskStatus, e.at);
        }
        break;

      case 'task-remove':
        if (e.taskId) {
          this.tasks.delete(agent.id + ':t:' + e.taskId);
          this.changed();
        }
        break;

      case 'usage':
        if (e.tokensIn) agent.stats.tokensIn += e.tokensIn;
        if (e.tokensOut) agent.stats.tokensOut += e.tokensOut;
        break;

      case 'meta':
      case 'heartbeat':
        if (e.kind === 'heartbeat' && e.state && (agent.state === 'idle' || agent.state === 'thinking') && !agent.pending.size) {
          // sinal de atividade sem ferramenta conhecida (ex.: Antigravity)
          this.setState(agent, e.state, e.action, e.at);
        } else if (agent.state === 'error' && e.kind === 'heartbeat' && e.at - agent.stateSince > ERROR_HOLD_MS) {
          this.setState(agent, agent.pending.size ? 'running' : 'thinking', undefined, e.at);
        }
        break;
    }
    this.changed();
  }

  private createAgent(e: NormalizedEvent): AgentRecord {
    const kind = e.parentId || e.kind === 'agent-start' ? 'subagent' : 'session';
    const type = e.agentType || (kind === 'subagent' ? 'subagente' : e.source);
    const label = this.opts.resolveName({ source: e.source, kind, type, name: e.name });
    const agent: AgentRecord = {
      id: e.agentId,
      source: e.source,
      kind,
      parentId: e.parentId,
      type,
      role: e.agentType,
      displayName: label,
      label,
      project: e.project,
      branch: e.branch,
      host: e.host,
      model: e.model,
      deskIndex: this.desks.assign(e.agentId),
      state: 'thinking',
      stateSince: e.at,
      startedAt: e.at,
      lastEventAt: e.at,
      stats: { tools: 0, edits: 0, commands: 0, reads: 0, searches: 0, errors: 0, tokensIn: 0, tokensOut: 0 },
      files: [],
      pending: new Map(),
      seen: new Set(),
      promptCount: 0,
      heuristicWaiting: false,
      explicitName: e.name
    };
    this.agents.set(agent.id, agent);
    if (kind === 'subagent' && (e.taskTitle || e.agentTitle)) this.startSubagentTask(agent, Object.assign({}, e, { taskTitle: e.taskTitle || e.agentTitle }));
    const parent = agent.parentId ? this.agents.get(agent.parentId) : undefined;
    this.log(agent, 'session', kind === 'subagent' ? 'entrou' + (parent ? ' (chamado por ' + parent.label + ')' : '') : 'abriu sessão' + (agent.project ? ' em ' + agent.project : ''), e);
    return agent;
  }

  private updateMeta(agent: AgentRecord, e: NormalizedEvent): void {
    if (e.project) agent.project = e.project;
    if (e.branch) agent.branch = e.branch;
    if (e.host) agent.host = e.host;
    if (e.model) agent.model = e.model;
    let rename = false;
    if (e.agentType && e.agentType !== agent.role) {
      agent.role = e.agentType;
      agent.type = e.agentType;
      rename = true;
    }
    if (e.name && e.name !== agent.explicitName) {
      agent.explicitName = e.name;
      rename = true;
    }
    if (e.parentId && !agent.parentId) agent.parentId = e.parentId;
    if (rename) {
      agent.label = this.opts.resolveName({ source: agent.source, kind: agent.kind, type: agent.type, name: agent.explicitName });
      agent.displayName = agent.label;
    }
  }

  /** Reaplica a resolução de nomes (ex.: fichas de agentes mudaram). */
  renameAll(): void {
    for (const a of this.agents.values()) {
      a.label = this.opts.resolveName({ source: a.source, kind: a.kind, type: a.type, name: a.explicitName });
      a.displayName = a.label;
    }
    for (const t of this.tasks.values()) {
      const a = this.agents.get(t.assignee);
      if (a) t.assigneeName = a.label;
    }
    this.changed();
  }

  private setState(agent: AgentRecord, state: AgentState, action: string | undefined, at: number): void {
    if (agent.state !== state) agent.stateSince = Math.max(at, agent.stateSince);
    agent.state = state;
    agent.currentAction = action;
  }

  private notifyWaiting(agent: AgentRecord, e: NormalizedEvent): void {
    const key = 'w:' + (e.key || e.at);
    if (agent.seen.has(key)) return;
    this.remember(agent, key);
    this.log(agent, 'waiting', e.action || 'aguardando você', e);
    if (!e.replay) this.emit('waiting', agent);
  }

  private remember(agent: AgentRecord, key: string): void {
    agent.seen.add(key);
    if (agent.seen.size > 600) {
      const first = agent.seen.values().next().value;
      if (first !== undefined) agent.seen.delete(first);
    }
  }

  private touchFile(agent: AgentRecord, file: string): void {
    const i = agent.files.indexOf(file);
    if (i >= 0) agent.files.splice(i, 1);
    agent.files.push(file);
    if (agent.files.length > MAX_FILES) agent.files.shift();
  }

  private startSubagentTask(agent: AgentRecord, e: NormalizedEvent): void {
    const id = agent.id + ':sub';
    const prev = this.tasks.get(id);
    if (prev && prev.status === 'running') return;
    this.upsertTask({
      id,
      title: e.taskTitle || agent.label,
      status: 'running',
      kind: 'subagent',
      assignee: agent.id,
      source: agent.source,
      project: agent.project,
      createdAt: e.at,
      startedAt: e.at
    });
    agent.taskId = id;
  }

  private stopSubagent(agent: AgentRecord, e: NormalizedEvent): void {
    if (agent.state !== 'done') this.log(agent, 'done', 'concluiu' + (e.action ? ': ' + e.action : ''), e);
    this.setState(agent, 'done', e.action, e.at);
    agent.pending.clear();
    const id = agent.id + ':sub';
    if (this.tasks.has(id)) this.updateTaskStatus(id, e.taskStatus === 'failed' ? 'failed' : 'done', e.at);
    this.finishPromptTask(agent, e.taskStatus === 'failed' ? 'failed' : 'done', e.at);
    // Dá tempo de acenar e sair andando pela porta antes de liberar a mesa.
    agent.removeAt = this.now() + (e.replay ? 0 : 3500);
  }

  private finishPromptTask(agent: AgentRecord, status: TaskStatus, at: number): void {
    // o pedido do turno e os que chegaram no meio dele (mensagens enfileiradas)
    for (const t of this.tasks.values()) {
      if (t.assignee === agent.id && t.kind === 'prompt' && t.status === 'running') this.updateTaskStatus(t.id, status, at);
    }
    agent.promptTaskId = undefined;
  }

  private removeAgent(id: string, at: number, ended: boolean): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    for (const child of this.agents.values()) {
      if (child.parentId === id) this.removeAgent(child.id, at, ended);
    }
    this.finishPromptTask(agent, agent.state === 'idle' || agent.state === 'done' ? 'done' : 'failed', at);
    const sub = this.tasks.get(agent.id + ':sub');
    if (sub && sub.status === 'running') this.updateTaskStatus(sub.id, 'done', at);
    this.desks.release(agent.id, agent.displayName);
    this.agents.delete(id);
    if (ended && agent.kind === 'session') this.log(agent, 'session', 'saiu do escritório', { at } as NormalizedEvent);
    this.changed();
  }

  // ── Tarefas ────────────────────────────────────────────────────────
  private upsertTask(task: Task): void {
    const agent = this.agents.get(task.assignee);
    task.assigneeName = agent ? agent.label : task.assigneeName;
    const prev = this.tasks.get(task.id);
    this.tasks.set(task.id, Object.assign({}, prev, task));
    if (this.tasks.size > MAX_TASKS) this.pruneTasks();
  }

  private updateTaskStatus(id: string, status: TaskStatus, at: number): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = status;
    if (status === 'running' && !t.startedAt) t.startedAt = at;
    if (status === 'done' || status === 'failed') t.completedAt = t.completedAt && t.status === status ? t.completedAt : at;
    else t.completedAt = undefined;
  }

  private pruneTasks(): void {
    const finished = [...this.tasks.values()]
      .filter((t) => t.status === 'done' || t.status === 'failed')
      .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
    while (this.tasks.size > MAX_TASKS && finished.length) this.tasks.delete(finished.shift()!.id);
  }

  /** Limpa as colunas Feito/Falhou (comando da UI). */
  clearFinished(): void {
    for (const [id, t] of this.tasks) if (t.status === 'done' || t.status === 'failed') this.tasks.delete(id);
    this.changed();
  }

  // ── Feed ───────────────────────────────────────────────────────────
  private log(agent: AgentRecord, kind: ActivityKind, text: string, e: Pick<NormalizedEvent, 'at'>): void {
    this.activity.push({
      id: 'ev' + this.seq++,
      at: e.at,
      agentId: agent.id,
      agentName: agent.label,
      source: agent.source,
      kind,
      text
    });
    if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
  }

  private bumpSpark(now: number): void {
    this.rollSpark(now);
    this.spark[this.spark.length - 1] += 1;
  }

  private rollSpark(now: number): void {
    if (!this.sparkAt) this.sparkAt = now;
    while (now - this.sparkAt >= SPARK_BUCKET_MS) {
      this.spark.push(0);
      this.spark.shift();
      this.sparkAt += SPARK_BUCKET_MS;
    }
  }

  // ── Varredura periódica ───────────────────────────────────────────
  sweep(): void {
    const now = this.now();
    let dirty = false;
    this.rollSpark(now);
    for (const agent of [...this.agents.values()]) {
      if (agent.removeAt && now >= agent.removeAt) {
        this.removeAgent(agent.id, now, false);
        dirty = true;
        continue;
      }
      const silent = now - agent.lastEventAt;
      if (agent.state === 'error' && now - agent.stateSince > ERROR_HOLD_MS) {
        this.setState(agent, agent.pending.size ? 'running' : 'thinking', undefined, now);
        dirty = true;
      }
      // Heurística de espera (sem hooks): ferramenta que costuma pedir
      // permissão está pendente há um tempo e o registro ficou em silêncio.
      if (!this.hooksActive(agent.source) && agent.state !== 'waiting' && agent.pending.size) {
        for (const p of agent.pending.values()) {
          if (p.needsApproval && p.state !== 'running' && now - p.since > WAIT_HEURISTIC_MS && silent > WAIT_HEURISTIC_MS) {
            agent.heuristicWaiting = true;
            this.setState(agent, 'waiting', 'aguardando aprovação?', now);
            this.log(agent, 'waiting', 'parece aguardar sua aprovação (' + (p.action || p.tool) + ')', { at: now });
            dirty = true;
            break;
          }
        }
      }
      if (agent.kind === 'subagent' && agent.state !== 'done' && silent > SUBAGENT_ORPHAN_MS) {
        this.stopSubagent(agent, { kind: 'agent-stop', source: agent.source, agentId: agent.id, at: now });
        dirty = true;
        continue;
      }
      if (agent.kind === 'session') {
        const limit = agent.state === 'idle' ? this.opts.idleTimeoutMs : Math.max(this.opts.idleTimeoutMs, WORKING_SILENCE_MS);
        if (silent > limit) {
          this.removeAgent(agent.id, now, true);
          dirty = true;
        }
      }
    }
    if (dirty) this.changed();
  }

  // ── Snapshot ───────────────────────────────────────────────────────
  snapshot(): OfficeSnapshot {
    const agents = [...this.agents.values()];
    // Desambigua nomes repetidos (duas "Sora" em projetos diferentes).
    const counts = new Map<string, number>();
    for (const a of agents) counts.set(a.label, (counts.get(a.label) || 0) + 1);
    const out: Agent[] = agents.map((a) => {
      const displayName = (counts.get(a.label) || 0) > 1 && a.kind === 'session' && a.project ? a.label + ' · ' + a.project : a.label;
      const { pending, seen, promptTaskId, promptCount, heuristicWaiting, removeAt, explicitName, ...pub } = a;
      void pending;
      void seen;
      void promptTaskId;
      void promptCount;
      void heuristicWaiting;
      void removeAt;
      void explicitName;
      return Object.assign({}, pub, { displayName, stats: Object.assign({}, a.stats), files: a.files.slice() });
    });
    this.rollSpark(this.now());
    return {
      sessionActive: out.length > 0,
      desks: this.desks.totalDesks,
      agents: out,
      tasks: [...this.tasks.values()].map((t) => Object.assign({}, t)),
      ghosts: this.desks.activeGhosts() as GhostDesk[],
      // reconstrução lê arquivo por arquivo: o feed sai em ordem de horário
      activity: this.activity
        .slice(-150)
        .map((a, i) => ({ a, i }))
        .sort((x, y) => x.a.at - y.a.at || x.i - y.i)
        .map((x) => x.a),
      sources: [...this.sources.values()],
      spark: this.spark.slice(),
      host: Object.assign({}, this.host, { hooks: [...this.hookSources.keys()].filter((s) => this.hooksActive(s)) })
    };
  }

  agentCount(): number {
    return this.agents.size;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  /** Emite 'change' no máximo ~8×/s: rajadas de eventos viram um snapshot. */
  private changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit('change', this.snapshot());
    }, 120);
  }

  /** Emissão imediata (testes / primeira pintura). */
  flush(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = undefined;
    }
    this.emit('change', this.snapshot());
  }
}
