import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSource, NormalizedEvent, TaskStatus } from '../core/types';
import { categorizeTool, clip, fileOf, promptTitle, redactAction } from '../server/redact';
import { FileTailer, TailChunk, obj, parseJson, str, tsOf } from './tailer';

/**
 * Antigravity (IDE, app 2.0 e CLI `agy`) não publica API de estado. O que
 * dá para ler com segurança, em ~/.gemini/antigravity[-ide|-cli]/:
 *  - brain/<conversa>/task.md: checklist com [ ] pendente, [/] em andamento,
 *    [x] feito → vira tarefas do quadro;
 *  - brain/<conversa>/.system_generated/logs/transcript.jsonl (builds
 *    novos): passos com tool_calls → estado do agente;
 *  - conversations/<conversa>.pb|.db(-wal): arquivo mudando = agente ativo;
 *  - code_tracker/active/…: cópias pré-edição → quais arquivos ele tocou.
 * Formatos fechados: tudo é defensivo e marcado como best-effort.
 */

const SOURCE: AgentSource = 'antigravity';
const IDLE_AFTER_MS = 75 * 1000;

export function antigravityRoots(home = os.homedir()): string[] {
  const g = path.join(home, '.gemini');
  return [path.join(g, 'antigravity'), path.join(g, 'antigravity-ide'), path.join(g, 'antigravity-cli')];
}

export interface ChecklistItem {
  id: string;
  title: string;
  status: TaskStatus;
  depth: number;
}

/** Lê um task.md no formato do Antigravity. */
export function parseChecklist(md: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const re = /^(\s*)[-*+]\s+\[( |x|X|\/|-)\]\s+(.+?)\s*$/;
  md.split(/\r?\n/).forEach((line, i) => {
    const m = re.exec(line);
    if (!m) return;
    const idm = /<!--\s*id:\s*([\w.-]+)\s*-->/.exec(m[3]);
    const title = m[3].replace(/<!--[\s\S]*?-->/g, '').replace(/[`*_]/g, '').trim();
    if (!title) return;
    const mark = m[2];
    items.push({
      id: idm ? idm[1] : 'l' + i,
      title: clip(title, 90),
      status: mark === 'x' || mark === 'X' ? 'done' : mark === '/' ? 'running' : mark === '-' ? 'failed' : 'pending',
      depth: Math.floor(m[1].replace(/\t/g, '    ').length / 2)
    });
  });
  const top = items.filter((i) => i.depth === 0);
  return top.length ? top : items;
}

function conversationOf(file: string): string | undefined {
  const parts = file.split(path.sep);
  const bi = parts.lastIndexOf('brain');
  if (bi >= 0 && parts[bi + 1]) return parts[bi + 1];
  const ci = parts.lastIndexOf('conversations');
  if (ci >= 0 && parts[ci + 1]) return parts[ci + 1].replace(/\.(pb|db|db-wal|db-shm)$/, '');
  return undefined;
}

export class AntigravityWatcher {
  private tasks: FileTailer;
  private transcripts: FileTailer;
  private conversations: FileTailer;
  private known = new Map<string, { ids: Set<string>; lastActive: number; idle: boolean; live: boolean }>();
  private tracker = new Set<string>();
  private trackerTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private lastSeen = 0;
  private lastActiveConv: string | undefined;

  constructor(private emit: (e: NormalizedEvent[]) => void, private opts: { recentMs: number; home?: () => string; ideName?: string }) {
    const roots = () => antigravityRoots(opts.home ? opts.home() : os.homedir());
    const brain = () => roots().map((r) => path.join(r, 'brain'));
    this.tasks = new FileTailer(
      { roots: brain, match: (_rel, name) => name === 'task.md', maxDepth: 1, recentMs: opts.recentMs, initialBytes: 0, mode: 'whole', scanMs: 5000, pollMs: 1500 },
      (c) => this.onTaskMd(c)
    );
    this.transcripts = new FileTailer(
      {
        roots: brain,
        match: (rel, name) => name === 'transcript.jsonl' && rel.includes('.system_generated'),
        maxDepth: 4,
        recentMs: opts.recentMs,
        initialBytes: 256 * 1024,
        mode: 'lines',
        skipDir: (name) => name === 'scratch' || name === '.tempmediaStorage' || name === '.user_uploaded',
        scanMs: 5000,
        pollMs: 1000
      },
      (c) => this.onTranscript(c)
    );
    this.conversations = new FileTailer(
      {
        roots: () => roots().map((r) => path.join(r, 'conversations')),
        match: (_rel, name) => /\.(pb|db-wal|db)$/.test(name),
        maxDepth: 0,
        recentMs: 10 * 60 * 1000,
        initialBytes: 0,
        mode: 'lines',
        scanMs: 3000,
        pollMs: 1500
      },
      (c) => this.onConversation(c)
    );
  }

  start(): void {
    this.tasks.start();
    this.transcripts.start();
    this.conversations.start();
    this.trackerTimer = setInterval(() => this.scanTracker(), 4000);
    this.idleTimer = setInterval(() => this.checkIdle(), 5000);
  }

  stop(): void {
    this.tasks.stop();
    this.transcripts.stop();
    this.conversations.stop();
    if (this.trackerTimer) clearInterval(this.trackerTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
  }

  async scanOnce(): Promise<void> {
    await this.tasks.scan();
    await this.transcripts.scan();
  }

  status(): { found: boolean; tracked: number; lastSeen: number } {
    const found = this.tasks.foundRoots.length > 0 || this.conversations.foundRoots.length > 0;
    return { found, tracked: this.tasks.trackedCount() + this.conversations.trackedCount(), lastSeen: this.lastSeen };
  }

  private base(conv: string, at: number, replay: boolean): NormalizedEvent {
    return { kind: 'heartbeat', source: SOURCE, agentId: SOURCE + ':' + conv, host: 'antigravity', at, replay };
  }

  private touch(conv: string, at: number, replay: boolean, events: NormalizedEvent[]): void {
    let k = this.known.get(conv);
    if (!k) {
      k = { ids: new Set(), lastActive: at, idle: false, live: false };
      this.known.set(conv, k);
    }
    // Histórico: o store decide se é recente. Ao vivo: (re)apresenta o agente
    // a cada episódio de atividade — ele pode ter saído por ociosidade.
    if (replay || k.idle || !k.live) events.push({ ...this.base(conv, at, replay), kind: 'session-start' });
    k.lastActive = Math.max(k.lastActive, at);
    if (!replay) {
      k.idle = false;
      k.live = true;
      this.lastActiveConv = conv;
    }
  }

  private onTaskMd(chunk: TailChunk): void {
    const conv = conversationOf(chunk.file);
    if (!conv) return;
    const at = chunk.mtimeMs || Date.now();
    const events: NormalizedEvent[] = [];
    this.touch(conv, at, chunk.initial, events);
    const items = parseChecklist(chunk.text || '');
    const k = this.known.get(conv)!;
    const next = new Set<string>();
    const base = this.base(conv, at, chunk.initial);
    for (const it of items) {
      next.add(it.id);
      events.push({ ...base, kind: 'task-upsert', taskId: it.id, taskTitle: it.title, taskStatus: it.status, taskKind: 'plan' });
    }
    for (const old of k.ids) if (!next.has(old)) events.push({ ...base, kind: 'task-remove', taskId: old });
    k.ids = next;
    const running = items.find((i) => i.status === 'running');
    if (running && !chunk.initial) events.push({ ...base, kind: 'heartbeat', action: running.title });
    this.flush(events);
  }

  private onTranscript(chunk: TailChunk): void {
    const conv = conversationOf(chunk.file);
    if (!conv) return;
    const events: NormalizedEvent[] = [];
    const now = Date.now();
    for (const l of chunk.lines || []) {
      const step = parseJson(l);
      if (!step) continue;
      const at = tsOf(step['created_at'] ?? step['createdAt'], now);
      this.touch(conv, at, chunk.initial, events);
      const base = this.base(conv, at, chunk.initial);
      const type = String(step['type'] || '').toUpperCase();
      const status = String(step['status'] || '').toUpperCase();
      const key = conv + ':' + String(step['step_index'] ?? step['stepIndex'] ?? at);
      if (type.includes('USER_INPUT')) {
        const raw = typeof step['content'] === 'string' ? (step['content'] as string) : '';
        const req = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw);
        const title = promptTitle(req ? req[1] : raw);
        events.push({ ...base, kind: 'prompt', taskTitle: title, key });
        continue;
      }
      const calls = Array.isArray(step['tool_calls']) ? (step['tool_calls'] as unknown[]) : [];
      calls.forEach((raw, i) => {
        const c = obj(raw);
        const name = str(c['name']) || str(obj(c['function'])['name']) || 'tool';
        const args = c['args'] ?? c['arguments'] ?? obj(c['function'])['arguments'];
        events.push({ ...base, kind: 'tool-start', tool: name, state: categorizeTool(name), action: redactAction(name, args), file: fileOf(name, args), key: key + ':' + i });
      });
      if (/ERROR|FAIL/.test(status)) events.push({ ...base, kind: 'tool-error', key: key + ':0' });
      else if (!calls.length && /DONE|COMPLETE|SUCCESS/.test(status) && type.includes('PLANNER')) events.push({ ...base, kind: 'heartbeat' });
    }
    this.flush(events);
  }

  private onConversation(chunk: TailChunk): void {
    if (chunk.initial) return; // só mudança ao vivo conta como atividade
    const conv = conversationOf(chunk.file);
    if (!conv) return;
    const events: NormalizedEvent[] = [];
    const at = chunk.mtimeMs || Date.now();
    this.touch(conv, at, false, events);
    // atividade sem outro sinal: acorda o agente sem inflar estatísticas
    events.push({ ...this.base(conv, at, false), kind: 'heartbeat', state: 'thinking', action: 'trabalhando' });
    this.flush(events);
  }

  /** Arquivos novos em code_tracker/active = arquivos que o agente editou. */
  private scanTracker(): void {
    const root = this.opts.home ? this.opts.home() : os.homedir();
    const events: NormalizedEvent[] = [];
    for (const r of antigravityRoots(root)) {
      const dir = path.join(r, 'code_tracker', 'active');
      let repos: string[];
      try {
        repos = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const repo of repos) {
        let files: string[];
        try {
          files = fs.readdirSync(path.join(dir, repo));
        } catch {
          continue;
        }
        for (const f of files) {
          const id = repo + '/' + f;
          if (this.tracker.has(id)) continue;
          const first = this.tracker.size === 0 && !this.lastActiveConv;
          this.tracker.add(id);
          if (first || !this.lastActiveConv) continue;
          const name = f.replace(/^[0-9a-f]{6,}_/, '');
          const conv = this.lastActiveConv;
          events.push({ ...this.base(conv, Date.now(), false), kind: 'tool-start', tool: 'replace_file_content', state: 'writing', action: 'editando ' + name, file: name, key: 'ct:' + id });
        }
      }
    }
    this.flush(events);
  }

  private checkIdle(): void {
    const now = Date.now();
    const events: NormalizedEvent[] = [];
    for (const [conv, k] of this.known) {
      if (!k.idle && now - k.lastActive > IDLE_AFTER_MS) {
        k.idle = true;
        events.push({ ...this.base(conv, now, false), kind: 'turn-end' });
      }
    }
    this.flush(events);
  }

  private flush(events: NormalizedEvent[]): void {
    if (!events.length) return;
    this.lastSeen = Date.now();
    this.emit(events);
  }
}

