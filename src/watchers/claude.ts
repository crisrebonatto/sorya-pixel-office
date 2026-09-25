import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSource, NormalizedEvent, TaskStatus } from '../core/types';
import { categorizeTool, clip, fileOf, needsApproval, promptTitle, redactAction } from '../server/redact';
import { FileTailer, TailChunk, num, obj, parseJson, projectOf, str, tsOf } from './tailer';

/**
 * Claude Code grava cada sessão em ~/.claude/projects/<projeto>/<sessão>.jsonl
 * (terminal, extensão do VS Code/Antigravity/Cursor e app desktop — todos no
 * mesmo lugar). Subagentes ficam em <sessão>/subagents/agent-<id>.jsonl com
 * um .meta.json ao lado (agentType, description, toolUseId).
 *
 * O formato é interno e muda entre versões: tudo aqui é defensivo e ignora
 * o que não reconhece. Ver docs/ARCHITECTURE.md §3.
 */

const SOURCE: AgentSource = 'claude';
const INJECTED = /^(<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|ide_opened_file|ide_selection|ide_diagnostics|system-reminder|session-start-hook|user-prompt-submit-hook|tick|goal)\b|Caveat:)/;

export interface ClaudeIds {
  sessionId: string;
  agentId: string; // id no escritório
  parentId?: string;
  subagentId?: string;
  agentType?: string;
  description?: string;
}

export function claudeAgentId(sessionId: string, subagentId?: string): string {
  return subagentId ? SOURCE + ':' + sessionId + ':' + subagentId : SOURCE + ':' + sessionId;
}

/** Converte linhas de UM arquivo de transcript em eventos normalizados. */
export class ClaudeTranscriptParser {
  private usage = new Map<string, { tin: number; tout: number }>();
  private endedMessages = new Set<string>();
  private seenUuid = new Set<string>();
  private taskCreates = new Map<string, string>();
  private started = false;
  private lastModel: string | undefined;
  private lastAt = 0;
  private sawPrompt = false;
  permissionMode: string | undefined;

  constructor(readonly ids: ClaudeIds) {}

  parse(line: Record<string, unknown>, replay: boolean, now = Date.now()): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    const uuid = str(line['uuid']);
    if (uuid) {
      if (this.seenUuid.has(uuid)) return out; // compactação reanexa linhas
      this.seenUuid.add(uuid);
      if (this.seenUuid.size > 5000) this.seenUuid.clear();
    }
    const type = str(line['type']);
    const stamped = line['timestamp'] !== undefined;
    // linhas sem timestamp (last-prompt, atis-latch) herdam o da última linha
    const at = stamped ? tsOf(line['timestamp'], now) : this.lastAt || now;
    if (stamped) this.lastAt = at;
    const base = this.base(line, at, replay);

    if (!this.started && (type === 'user' || type === 'assistant')) {
      this.started = true;
      if (this.ids.subagentId) {
        out.push({ ...base, kind: 'agent-start', agentType: this.ids.agentType, taskTitle: this.ids.description, parentId: this.ids.parentId });
      } else {
        out.push({ ...base, kind: 'session-start' });
      }
    }

    const pm = str(line['permissionMode']);
    if (pm) this.permissionMode = pm;

    switch (type) {
      case 'user':
        this.parseUser(line, base, out);
        break;
      case 'assistant':
        this.parseAssistant(line, base, out);
        break;
      case 'system': {
        const sub = str(line['subtype']);
        if (sub === 'turn_duration') out.push({ ...base, kind: 'turn-end', key: 'turn:' + (uuid || at) });
        else out.push({ ...base, kind: 'heartbeat' });
        break;
      }
      case 'agent-name': {
        const n = str(line['agentName']) || str(line['name']) || str(line['agent']);
        if (n) out.push({ ...base, kind: 'meta', agentType: n });
        break;
      }
      case 'permission-mode': {
        const m = str(line['permissionMode']) || str(line['mode']);
        if (m) this.permissionMode = m;
        break;
      }
      case 'attachment':
        this.parseAttachment(obj(line['attachment']), base, out, str(line['uuid']));
        break;
      case 'last-prompt': {
        // leitura começou no meio do arquivo: o último pedido vira o card atual
        const lp = str(line['lastPrompt']);
        if (!this.sawPrompt && lp && this.lastAt) {
          this.sawPrompt = true;
          const title = promptTitle(lp);
          if (title) out.push({ ...base, kind: 'prompt', taskTitle: title, key: 'lp' });
        }
        break;
      }
      case 'queue-operation':
        out.push({ ...base, kind: 'heartbeat' });
        break;
      default:
        break;
    }
    return out;
  }

  private base(line: Record<string, unknown>, at: number, replay: boolean): NormalizedEvent {
    // Todo evento carrega os metadados do agente: se o início ficou para
    // trás (histórico antigo), quem criar o agente cria completo.
    return {
      kind: 'heartbeat',
      source: SOURCE,
      agentId: this.ids.agentId,
      parentId: this.ids.parentId,
      agentType: this.ids.agentType,
      agentTitle: this.ids.description,
      project: projectOf(line['cwd']),
      branch: str(line['gitBranch']),
      host: str(line['entrypoint']),
      model: this.lastModel,
      at,
      replay
    };
  }

  private parseUser(line: Record<string, unknown>, base: NormalizedEvent, out: NormalizedEvent[]): void {
    if (line['isMeta'] === true || line['isCompactSummary'] === true) return;
    const message = obj(line['message']);
    const content = message['content'];
    const tur = obj(line['toolUseResult']);

    if (typeof content === 'string') {
      this.userText(content, base, out, str(line['uuid']));
      return;
    }
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = obj(raw);
      const bt = str(block['type']);
      if (bt === 'tool_result') {
        const key = str(block['tool_use_id']);
        const text = typeof block['content'] === 'string' ? (block['content'] as string) : '';
        const rejected = /doesn't want to proceed with this tool use|tool use was rejected/i.test(text);
        if (block['is_error'] === true && !rejected) {
          out.push({ ...base, kind: 'tool-error', key });
        } else {
          out.push({ ...base, kind: 'tool-end', key });
        }
        // TaskCreate devolve o id da tarefa no resultado
        if (key && this.taskCreates.has(key)) {
          const subject = this.taskCreates.get(key)!;
          this.taskCreates.delete(key);
          const task = obj(tur['task']);
          const id = str(task['id']) || (/#(\d+)/.exec(text) || [])[1];
          if (id) out.push({ ...base, kind: 'task-upsert', taskId: id, taskTitle: subject, taskStatus: 'pending', taskKind: 'todo' });
        }
      } else if (bt === 'text') {
        this.userText(str(block['text']) || '', base, out, str(line['uuid']));
      }
    }
  }

  private userText(text: string, base: NormalizedEvent, out: NormalizedEvent[], uuid?: string): void {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('[Request interrupted by user')) {
      out.push({ ...base, kind: 'turn-aborted' });
      return;
    }
    const note = /<task-notification>[\s\S]*?<task-id>([^<]+)<\/task-id>[\s\S]*?(?:<status>([^<]+)<\/status>)?/.exec(t);
    if (note) {
      // subagente em background terminou
      const status = (note[2] || '').trim();
      out.push({
        ...base,
        kind: 'agent-stop',
        agentId: claudeAgentId(this.ids.sessionId, note[1].trim()),
        parentId: this.ids.agentId,
        taskStatus: /fail|error|kill/i.test(status) ? 'failed' : 'done'
      });
      return;
    }
    if (INJECTED.test(t)) return;
    const title = promptTitle(t);
    if (!title) return;
    this.sawPrompt = true;
    out.push({ ...base, kind: 'prompt', taskTitle: title, key: uuid });
  }

  /** Mensagens enfileiradas no meio do turno e avisos de subagentes. */
  private parseAttachment(att: Record<string, unknown>, base: NormalizedEvent, out: NormalizedEvent[], uuid?: string): void {
    if (str(att['type']) !== 'queued_command') {
      out.push({ ...base, kind: 'heartbeat' });
      return;
    }
    const prompt = (str(att['prompt']) || '').trim();
    if (!prompt) return;
    if (prompt.includes('<task-notification>')) {
      this.userText(prompt, base, out, uuid);
      return;
    }
    if (prompt.startsWith('<') || INJECTED.test(prompt)) return; // relatórios de subagente, avisos do sistema
    const title = promptTitle(prompt);
    if (!title) return;
    // pedido novo sem encerrar o turno em andamento
    out.push({ ...base, kind: 'task-upsert', taskId: 'q:' + (uuid || base.at), taskTitle: title, taskStatus: 'running', taskKind: 'prompt' });
  }

  private parseAssistant(line: Record<string, unknown>, base: NormalizedEvent, out: NormalizedEvent[]): void {
    const message = obj(line['message']);
    const mid = str(message['id']) || str(line['requestId']) || '';
    const model = str(message['model']);
    if (model && model !== '<synthetic>' && model !== this.lastModel) {
      this.lastModel = model;
      out.push({ ...base, kind: 'meta', model });
    }
    // tokens: várias linhas por mensagem (uma por bloco) — soma só o delta
    const usage = obj(message['usage']);
    if (mid && Object.keys(usage).length) {
      const tin = (num(usage['input_tokens']) || 0) + (num(usage['cache_creation_input_tokens']) || 0) + (num(usage['cache_read_input_tokens']) || 0);
      const tout = num(usage['output_tokens']) || 0;
      const prev = this.usage.get(mid) || { tin: 0, tout: 0 };
      const dIn = Math.max(0, tin - prev.tin);
      const dOut = Math.max(0, tout - prev.tout);
      if (dIn || dOut) out.push({ ...base, kind: 'usage', tokensIn: dIn, tokensOut: dOut });
      this.usage.set(mid, { tin: Math.max(tin, prev.tin), tout: Math.max(tout, prev.tout) });
      if (this.usage.size > 400) this.usage.delete(this.usage.keys().next().value as string);
    }

    if (line['isApiErrorMessage'] === true) {
      const err = str(line['error']) || 'erro da API';
      out.push({ ...base, kind: 'tool-error', action: 'API: ' + err, key: 'api:' + mid });
      out.push({ ...base, kind: 'turn-end', key: 'turn:' + mid });
      return;
    }

    const content = Array.isArray(message['content']) ? (message['content'] as unknown[]) : [];
    for (const raw of content) {
      const block = obj(raw);
      const bt = str(block['type']);
      if (bt === 'tool_use') {
        const name = str(block['name']) || 'tool';
        const input = block['input'];
        const key = str(block['id']);
        out.push({
          ...base,
          kind: 'tool-start',
          tool: name,
          state: categorizeTool(name),
          action: redactAction(name, input),
          file: fileOf(name, input),
          key,
          needsApproval: this.approvalLikely(name)
        });
        this.todoEvents(name, obj(input), key, base, out);
      } else if (bt === 'thinking' || bt === 'text') {
        out.push({ ...base, kind: 'heartbeat' });
      }
    }
    const stop = str(message['stop_reason']);
    if ((stop === 'end_turn' || stop === 'max_tokens' || stop === 'stop_sequence') && mid && !this.endedMessages.has(mid)) {
      this.endedMessages.add(mid);
      if (this.endedMessages.size > 400) this.endedMessages.clear();
      out.push({ ...base, kind: 'turn-end', key: 'turn:' + mid });
    }
  }

  private approvalLikely(tool: string): boolean {
    const mode = this.permissionMode;
    if (mode === 'bypassPermissions' || mode === 'dontAsk' || mode === 'auto') return false;
    const c = categorizeTool(tool);
    if (mode === 'acceptEdits' && c === 'writing') return false;
    return needsApproval(tool);
  }

  private todoEvents(name: string, input: Record<string, unknown>, key: string | undefined, base: NormalizedEvent, out: NormalizedEvent[]): void {
    if (name === 'TodoWrite' && Array.isArray(input['todos'])) {
      (input['todos'] as unknown[]).forEach((raw, i) => {
        const t = obj(raw);
        const content = str(t['content']) || str(t['activeForm']);
        if (!content) return;
        const id = str(t['id']) || 'todo' + i;
        out.push({ ...base, kind: 'task-upsert', taskId: id, taskTitle: clip(content, 90), taskStatus: todoStatus(str(t['status'])), taskKind: 'todo' });
      });
    } else if (name === 'TaskCreate' && key) {
      const subject = str(input['subject']) || str(input['description']);
      if (subject) this.taskCreates.set(key, clip(subject, 90));
    } else if (name === 'TaskUpdate') {
      const id = str(input['taskId']) || str(input['task_id']) || str(input['id']);
      if (!id) return;
      const status = str(input['status']);
      if (status === 'deleted') {
        out.push({ ...base, kind: 'task-remove', taskId: id });
        return;
      }
      const subject = str(input['subject']);
      out.push({
        ...base,
        kind: 'task-upsert',
        taskId: id,
        taskTitle: subject ? clip(subject, 90) : undefined,
        taskStatus: status ? todoStatus(status) : undefined,
        taskKind: 'todo'
      });
    }
  }
}

export function todoStatus(s: string | undefined): TaskStatus {
  switch ((s || '').toLowerCase()) {
    case 'in_progress':
    case 'in-progress':
    case 'running':
      return 'running';
    case 'completed':
    case 'done':
    case 'closed':
      return 'done';
    case 'cancelled':
    case 'canceled':
    case 'failed':
    case 'blocked':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Identifica sessão/subagente a partir do caminho relativo a projects/. */
export function claudeIdsFromPath(rel: string): ClaudeIds | undefined {
  const parts = rel.split(/[\\/]/);
  const file = parts[parts.length - 1];
  if (!file.endsWith('.jsonl') || /\.orphaned-|\.superseded-/.test(file)) return undefined;
  const agentMatch = /^agent-(.+)\.jsonl$/.exec(file);
  if (agentMatch) {
    const si = parts.indexOf('subagents');
    if (si < 1) return undefined;
    const sessionId = parts[si - 1];
    const subagentId = agentMatch[1];
    return { sessionId, subagentId, agentId: claudeAgentId(sessionId, subagentId), parentId: claudeAgentId(sessionId) };
  }
  if (parts.length !== 2) return undefined;
  const sessionId = file.replace(/\.jsonl$/, '');
  return { sessionId, agentId: claudeAgentId(sessionId) };
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Observa ~/.claude/projects (transcripts) e ~/.claude/sessions (uma ficha
 * por processo vivo: status busy/idle, entrypoint, cwd).
 */
export class ClaudeWatcher {
  private parsers = new Map<string, ClaudeTranscriptParser>();
  private sessionFiles = new Map<string, { sessionId: string; status?: string; pid?: number }>();
  private deadSessions = new Set<string>();
  private transcripts: FileTailer;
  private sessions: FileTailer;
  private reaper: NodeJS.Timeout | undefined;
  private lastSeen = 0;

  constructor(private emit: (e: NormalizedEvent[]) => void, private opts: { recentMs: number; home?: () => string }) {
    const home = () => (opts.home ? opts.home() : claudeHome());
    this.transcripts = new FileTailer(
      {
        roots: () => [path.join(home(), 'projects')],
        match: (rel, name) => name.endsWith('.jsonl') && !!claudeIdsFromPath(rel),
        maxDepth: 5,
        recentMs: opts.recentMs,
        initialBytes: 768 * 1024,
        mode: 'lines',
        skipDir: (name) => name === 'tool-results' || name === 'memory',
        scanMs: 4000,
        pollMs: 700
      },
      (c) => this.onTranscript(home(), c)
    );
    this.sessions = new FileTailer(
      {
        roots: () => [path.join(home(), 'sessions')],
        match: (_rel, name) => /^\d+\.json$/.test(name),
        maxDepth: 0,
        recentMs: 7 * 24 * 60 * 60 * 1000,
        initialBytes: 64 * 1024,
        mode: 'whole',
        scanMs: 3000,
        pollMs: 1500
      },
      (c) => this.onSessionFile(c)
    );
  }

  start(): void {
    this.transcripts.start();
    this.sessions.start();
    this.reaper = setInterval(() => this.reapSessions(), 3000);
  }

  stop(): void {
    this.transcripts.stop();
    this.sessions.stop();
    if (this.reaper) clearInterval(this.reaper);
  }

  status(): { found: boolean; tracked: number; lastSeen: number } {
    return { found: this.transcripts.foundRoots.length > 0, tracked: this.transcripts.trackedCount(), lastSeen: this.lastSeen };
  }

  /** Para testes: uma varredura síncrona-ish. */
  async scanOnce(): Promise<void> {
    await this.sessions.scan();
    await this.transcripts.scan();
  }

  private onTranscript(home: string, chunk: TailChunk): void {
    const rel = path.relative(path.join(home, 'projects'), chunk.file);
    let parser = this.parsers.get(chunk.file);
    if (!parser) {
      const ids = claudeIdsFromPath(rel);
      if (!ids) return;
      if (ids.subagentId) {
        const meta = readJson(chunk.file.replace(/\.jsonl$/, '.meta.json'));
        ids.agentType = str(meta['agentType']);
        ids.description = str(meta['description']);
      }
      parser = new ClaudeTranscriptParser(ids);
      this.parsers.set(chunk.file, parser);
    }
    const events: NormalizedEvent[] = [];
    const now = Date.now();
    for (const l of chunk.lines || []) {
      const line = parseJson(l);
      if (line) events.push(...parser.parse(line, chunk.initial, now));
    }
    // Processo já encerrado: o histórico só alimenta o parser, não o escritório.
    if (chunk.initial && this.deadSessions.has(parser.ids.sessionId)) return;
    if (events.length) {
      this.lastSeen = now;
      this.emit(events);
    }
  }

  private onSessionFile(chunk: TailChunk): void {
    const data = parseJson(chunk.text || '');
    if (!data) return;
    const sessionId = str(data['sessionId']);
    const pid = num(data['pid']);
    if (!sessionId) return;
    const prev = this.sessionFiles.get(chunk.file);
    const status = str(data['status']);
    this.sessionFiles.set(chunk.file, { sessionId, status, pid });
    if (pid && !pidAlive(pid)) {
      this.deadSessions.add(sessionId);
      this.emit([{ kind: 'session-end', source: SOURCE, agentId: claudeAgentId(sessionId), at: Date.now() }]);
      return;
    }
    this.deadSessions.delete(sessionId);
    const at = tsOf(data['statusUpdatedAt'] ?? data['updatedAt'], Date.now());
    const base: NormalizedEvent = {
      kind: 'meta',
      source: SOURCE,
      agentId: claudeAgentId(sessionId),
      project: projectOf(data['cwd']),
      host: str(data['entrypoint']),
      at,
      replay: chunk.initial
    };
    const events: NormalizedEvent[] = [base];
    if (status === 'waiting' && (!prev || prev.status !== 'waiting')) {
      const why = str(data['waitingFor']);
      events.push({ ...base, kind: 'waiting', action: why ? 'aguardando: ' + why : 'aguardando você', key: 'sess:' + at });
    }
    if (prev && prev.sessionId !== sessionId) {
      // /clear troca a sessão no mesmo processo
      events.unshift({ kind: 'session-end', source: SOURCE, agentId: claudeAgentId(prev.sessionId), at });
    }
    this.emit(events);
  }

  /** Processos que sumiram: a ficha de sessão foi apagada ou o pid morreu. */
  reapSessions(): void {
    for (const [file, s] of this.sessionFiles) {
      const gone = !fs.existsSync(file);
      const dead = !gone && s.pid !== undefined && !pidAlive(s.pid);
      if (gone || dead) {
        this.sessionFiles.delete(file);
        this.deadSessions.add(s.sessionId);
        this.emit([{ kind: 'session-end', source: SOURCE, agentId: claudeAgentId(s.sessionId), at: Date.now() }]);
      }
    }
  }
}

export function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
