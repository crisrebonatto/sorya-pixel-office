import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentSource, NormalizedEvent } from '../core/types';
import { categorizeTool, clip, fileOf, promptTitle, redactAction } from '../server/redact';
import { FileTailer, TailChunk, num, obj, parseJson, projectOf, str, tsOf } from './tailer';
import { todoStatus } from './claude';

/**
 * Gemini CLI grava as conversas em ~/.gemini/tmp/<projeto>/chats/:
 *  - v0.39+: session-*.jsonl, só anexa; a mesma mensagem (mesmo id) é
 *    reanexada quando muda → a última versão vence ({"$set"}, {"$rewindTo"}).
 *  - até v0.38: session-*.json reescrito inteiro a cada atualização.
 * Chamadas de ferramenta só entram no arquivo depois de concluídas.
 */

const SOURCE: AgentSource = 'gemini';

export class GeminiChatParser {
  private agentId: string | undefined;
  private parentId: string | undefined;
  private seenCalls = new Set<string>();
  private seenUsers = new Set<string>();
  private tokens = new Map<string, { tin: number; tout: number }>();
  private endedTurns = new Set<string>();
  private lastModel: string | undefined;

  constructor(private project: string | undefined, private fileSession: string | undefined) {}

  parseRecord(rec: Record<string, unknown>, replay: boolean, now = Date.now()): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    if (rec['$set'] !== undefined || rec['$rewindTo'] !== undefined) return out;
    // cabeçalho
    if (str(rec['sessionId']) && rec['type'] === undefined) {
      this.setSession(str(rec['sessionId'])!, str(rec['kind']) === 'subagent');
      out.push({ ...this.base(tsOf(rec['startTime'], now), replay), kind: this.parentId ? 'agent-start' : 'session-start' });
      return out;
    }
    if (!this.agentId && this.fileSession) this.setSession(this.fileSession, false);
    if (!this.agentId) return out;
    const type = str(rec['type']);
    const id = str(rec['id']) || '';
    const at = tsOf(rec['timestamp'], now);
    const base = this.base(at, replay);

    if (type === 'user') {
      const text = textOf(rec['content']);
      if (!text || this.seenUsers.has(id)) return out; // functionResponse sintético não tem texto
      this.seenUsers.add(id);
      const title = promptTitle(text);
      if (title) out.push({ ...base, kind: 'prompt', taskTitle: title, key: id });
      return out;
    }
    if (type === 'gemini') {
      const model = str(rec['model']);
      if (model && model !== this.lastModel) {
        this.lastModel = model;
        out.push({ ...base, kind: 'meta', model });
      }
      const tk = obj(rec['tokens']);
      if (id && Object.keys(tk).length) {
        const tin = (num(tk['input']) || 0) + (num(tk['cached']) || 0);
        const tout = (num(tk['output']) || 0) + (num(tk['thoughts']) || 0);
        const prev = this.tokens.get(id) || { tin: 0, tout: 0 };
        if (tin > prev.tin || tout > prev.tout) out.push({ ...base, kind: 'usage', tokensIn: Math.max(0, tin - prev.tin), tokensOut: Math.max(0, tout - prev.tout) });
        this.tokens.set(id, { tin: Math.max(tin, prev.tin), tout: Math.max(tout, prev.tout) });
      }
      const calls = Array.isArray(rec['toolCalls']) ? (rec['toolCalls'] as unknown[]) : [];
      for (const raw of calls) {
        const c = obj(raw);
        const callId = str(c['id']) || id + ':' + str(c['name']);
        if (this.seenCalls.has(callId)) continue;
        this.seenCalls.add(callId);
        const name = str(c['name']) || 'tool';
        const args = c['args'];
        const status = str(c['status']) || 'success';
        const callAt = tsOf(c['timestamp'], at);
        out.push({
          ...base,
          at: callAt,
          kind: 'tool-start',
          tool: name,
          state: categorizeTool(name),
          action: redactAction(name, args),
          file: fileOf(name, args),
          key: callId
        });
        if (status === 'error') out.push({ ...base, at: callAt, kind: 'tool-error', key: callId });
        else if (status === 'awaiting_approval') out.push({ ...base, at: callAt, kind: 'waiting', action: 'pedindo permissão · ' + redactAction(name, args), key: callId });
        if (name === 'write_todos') this.todos(obj(args), base, out);
      }
      // resposta sem ferramentas = fim do turno
      if (!calls.length && textOf(rec['content']) && !this.endedTurns.has(id)) {
        this.endedTurns.add(id);
        out.push({ ...base, kind: this.parentId ? 'agent-stop' : 'turn-end', key: 'turn:' + id });
      }
      return out;
    }
    if (type === 'error') out.push({ ...base, kind: 'tool-error', action: clip('erro: ' + (textOf(rec['content']) || ''), 60), key: 'err:' + id });
    else out.push({ ...base, kind: 'heartbeat' });
    return out;
  }

  private setSession(sessionId: string, sub: boolean): void {
    this.agentId = SOURCE + ':' + sessionId;
    if (sub && this.fileSession && this.fileSession !== sessionId) this.parentId = SOURCE + ':' + this.fileSession;
  }

  private base(at: number, replay: boolean): NormalizedEvent {
    return { kind: 'heartbeat', source: SOURCE, agentId: this.agentId || '', parentId: this.parentId, project: this.project, host: 'terminal', model: this.lastModel, at, replay };
  }

  private todos(input: Record<string, unknown>, base: NormalizedEvent, out: NormalizedEvent[]): void {
    const list = Array.isArray(input['todos']) ? (input['todos'] as unknown[]) : [];
    list.forEach((raw, i) => {
      const t = obj(raw);
      const d = str(t['description']);
      if (d) out.push({ ...base, kind: 'task-upsert', taskId: 'todo' + i, taskTitle: clip(d, 90), taskStatus: todoStatus(str(t['status'])), taskKind: 'todo' });
    });
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => str(obj(p)['text']) || '')
      .join('\n')
      .trim();
  }
  return '';
}

export function geminiHome(): string {
  return path.join(os.homedir(), '.gemini');
}

/** tmp/<slug>/.project_root guarda o caminho real do projeto. */
function projectFor(chatsFile: string): string | undefined {
  const parts = chatsFile.split(path.sep);
  const ci = parts.lastIndexOf('chats');
  if (ci < 1) return undefined;
  const dir = parts.slice(0, ci).join(path.sep);
  try {
    const root = fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim();
    if (root) return projectOf(root);
  } catch {
    // sem marcador (versões antigas usam hash sha256 no nome da pasta)
  }
  const slug = parts[ci - 1];
  return /^[0-9a-f]{40,}$/.test(slug) ? undefined : slug;
}

function sessionFromName(file: string): string | undefined {
  const base = path.basename(file).replace(/\.jsonl?$/, '');
  if (base.startsWith('session-')) return undefined; // o id completo vem no cabeçalho
  return base;
}

export class GeminiWatcher {
  private parsers = new Map<string, GeminiChatParser>();
  private lines: FileTailer;
  private legacy: FileTailer;
  private lastSeen = 0;

  constructor(private emit: (e: NormalizedEvent[]) => void, opts: { recentMs: number; home?: () => string }) {
    const root = () => path.join(opts.home ? opts.home() : geminiHome(), 'tmp');
    const inChats = (rel: string) => rel.split(/[\\/]/).includes('chats');
    this.lines = new FileTailer(
      { roots: () => [root()], match: (rel, name) => inChats(rel) && name.endsWith('.jsonl'), maxDepth: 3, recentMs: opts.recentMs, initialBytes: 512 * 1024, mode: 'lines', scanMs: 5000, pollMs: 900 },
      (c) => this.onLines(c)
    );
    this.legacy = new FileTailer(
      { roots: () => [root()], match: (rel, name) => inChats(rel) && /^session-.*\.json$/.test(name), maxDepth: 3, recentMs: opts.recentMs, initialBytes: 0, mode: 'whole', scanMs: 5000, pollMs: 1500 },
      (c) => this.onWhole(c)
    );
  }

  start(): void {
    this.lines.start();
    this.legacy.start();
  }

  stop(): void {
    this.lines.stop();
    this.legacy.stop();
  }

  async scanOnce(): Promise<void> {
    await this.lines.scan();
    await this.legacy.scan();
  }

  status(): { found: boolean; tracked: number; lastSeen: number } {
    return { found: this.lines.foundRoots.length > 0, tracked: this.lines.trackedCount() + this.legacy.trackedCount(), lastSeen: this.lastSeen };
  }

  private parser(file: string): GeminiChatParser {
    let p = this.parsers.get(file);
    if (!p) {
      p = new GeminiChatParser(projectFor(file), sessionFromName(file));
      this.parsers.set(file, p);
    }
    return p;
  }

  private onLines(chunk: TailChunk): void {
    const p = this.parser(chunk.file);
    const events: NormalizedEvent[] = [];
    if (chunk.initial) {
      // cabeçalho pode ter ficado antes do trecho lido
      const head = readHead(chunk.file);
      if (head) events.push(...p.parseRecord(head, true));
    }
    const now = Date.now();
    for (const l of chunk.lines || []) {
      const rec = parseJson(l);
      if (rec) events.push(...p.parseRecord(rec, chunk.initial, now));
    }
    this.flush(events);
  }

  private onWhole(chunk: TailChunk): void {
    const data = parseJson(chunk.text || '');
    if (!data) return;
    const p = this.parser(chunk.file);
    const events: NormalizedEvent[] = [];
    const now = Date.now();
    events.push(...p.parseRecord({ sessionId: data['sessionId'], startTime: data['startTime'] }, chunk.initial, now));
    const msgs = Array.isArray(data['messages']) ? (data['messages'] as unknown[]) : [];
    for (const m of msgs) events.push(...p.parseRecord(obj(m), chunk.initial, now));
    this.flush(events);
  }

  private flush(events: NormalizedEvent[]): void {
    const valid = events.filter((e) => e.agentId);
    if (valid.length) {
      this.lastSeen = Date.now();
      this.emit(valid);
    }
  }
}

function readHead(file: string): Record<string, unknown> | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const nl = text.indexOf('\n');
      const rec = parseJson(nl >= 0 ? text.slice(0, nl) : text);
      return rec && rec['type'] === undefined && rec['sessionId'] ? rec : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
