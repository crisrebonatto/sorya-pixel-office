import * as os from 'os';
import * as path from 'path';
import { AgentSource, LiveDetail, LiveFileDiff, NormalizedEvent } from '../core/types';
import { liveSwitch, parseApplyPatch, relativeTo } from '../core/live';
import { categorizeTool, clip, fileOf, patchFiles, promptTitle, redactAction } from '../server/redact';
import { FileTailer, TailChunk, num, obj, parseJson, projectOf, str, tsOf } from './tailer';
import { todoStatus } from './claude';

/**
 * Codex (CLI, `codex exec`, extensão openai.chatgpt e app desktop) grava
 * cada thread em $CODEX_HOME/sessions/AAAA/MM/DD/rollout-<ts>-<id>.jsonl,
 * uma linha por vez com flush — seguro para acompanhar ao vivo.
 * Linha: { timestamp, type: session_meta|turn_context|response_item|event_msg, payload }.
 * Pedidos de aprovação NÃO são gravados (só via hook PermissionRequest).
 */

const SOURCE: AgentSource = 'codex';

export class CodexRolloutParser {
  private agentId: string | undefined;
  private parentId: string | undefined;
  private approval: string | undefined;
  private tokens = { tin: 0, tout: 0 };
  private calls = new Map<string, string>();
  private planSize = 0;
  private cwd: string | undefined;
  private base: Partial<NormalizedEvent> = {};

  constructor(private ignore: (threadId: string) => boolean = () => false) {}

  get id(): string | undefined {
    return this.agentId;
  }

  parse(line: Record<string, unknown>, replay: boolean, now = Date.now()): NormalizedEvent[] {
    const type = str(line['type']);
    const payload = obj(line['payload']);
    const at = tsOf(line['timestamp'], now);
    const out: NormalizedEvent[] = [];

    if (type === 'session_meta') {
      const id = str(payload['id']) || str(payload['session_id']);
      if (!id || this.ignore(id)) return out;
      this.agentId = SOURCE + ':' + id;
      const src = obj(payload['source']);
      const spawn = obj(obj(src['subagent'])['thread_spawn']);
      const parentThread = str(spawn['parent_thread_id']) || str(payload['parent_thread_id']);
      this.parentId = parentThread ? SOURCE + ':' + parentThread : undefined;
      const git = obj(payload['git']);
      this.cwd = str(payload['cwd']);
      this.base = {
        project: projectOf(payload['cwd']),
        branch: str(git['branch']),
        host: str(payload['originator']) || (typeof payload['source'] === 'string' ? (payload['source'] as string) : undefined)
      };
      const nickname = str(payload['agent_nickname']);
      const role = str(payload['agent_role']);
      this.base.agentType = role || (this.parentId ? 'codex-subagente' : undefined);
      this.base.name = nickname;
      this.base.agentTitle = this.parentId ? clip(nickname || role || 'subagente Codex', 90) : undefined;
      out.push({ ...this.ev(at, replay), kind: this.parentId ? 'agent-start' : 'session-start', taskTitle: this.base.agentTitle });
      return out;
    }
    if (!this.agentId) return out;
    const base = this.ev(at, replay);

    if (type === 'turn_context') {
      this.approval = typeof payload['approval_policy'] === 'string' ? (payload['approval_policy'] as string) : 'granular';
      const model = str(payload['model']);
      if (model) this.base.model = model;
      this.cwd = str(payload['cwd']) || this.cwd;
      out.push({ ...base, kind: 'meta', model, project: projectOf(payload['cwd']) || this.base.project });
      return out;
    }

    if (type === 'event_msg') {
      const t = str(payload['type']);
      switch (t) {
        case 'user_message': {
          const title = promptTitle(str(payload['message']) || '');
          if (title) out.push({ ...base, kind: 'prompt', taskTitle: title, key: 'u:' + at });
          break;
        }
        case 'task_started':
        case 'turn_started':
          out.push({ ...base, kind: 'heartbeat' });
          break;
        case 'task_complete':
        case 'turn_complete':
          if (this.parentId) out.push({ ...base, kind: 'agent-stop' });
          else out.push({ ...base, kind: 'turn-end', key: 'turn:' + (str(payload['turn_id']) || at) });
          break;
        case 'turn_aborted':
          out.push({ ...base, kind: str(payload['reason']) === 'interrupted' ? 'turn-aborted' : 'turn-end' });
          break;
        case 'token_count': {
          const total = obj(obj(payload['info'])['total_token_usage']);
          const tin = (num(total['input_tokens']) || 0) + (num(total['cache_write_input_tokens']) || 0);
          const tout = (num(total['output_tokens']) || 0) + (num(total['reasoning_output_tokens']) || 0);
          const dIn = Math.max(0, tin - this.tokens.tin);
          const dOut = Math.max(0, tout - this.tokens.tout);
          if (dIn || dOut) out.push({ ...base, kind: 'usage', tokensIn: dIn, tokensOut: dOut });
          this.tokens = { tin: Math.max(tin, this.tokens.tin), tout: Math.max(tout, this.tokens.tout) };
          break;
        }
        case 'patch_apply_end':
          if (payload['success'] === false) out.push({ ...base, kind: 'tool-error', key: str(payload['call_id']) });
          if (liveSwitch.on) out.push({ ...base, kind: 'heartbeat', key: str(payload['call_id']), live: { t: 'out', output: '', isError: payload['success'] === false } });
          break;
        case 'patch_apply_begin': {
          const ev: NormalizedEvent = { ...base, kind: 'heartbeat', key: str(payload['call_id']) };
          const files = liveSwitch.on ? this.changesToDiffs(obj(payload['changes'])) : [];
          if (files.length) ev.live = { t: 'diff', files, pending: true };
          out.push(ev);
          break;
        }
        case 'exec_command_end': {
          const ev: NormalizedEvent = { ...base, kind: 'heartbeat', key: str(payload['call_id']) };
          if (liveSwitch.on) {
            const output = str(payload['aggregated_output']) ?? [str(payload['stdout']) || '', str(payload['stderr']) || ''].filter(Boolean).join('\n');
            ev.live = { t: 'out', output, exitCode: num(payload['exit_code']) };
          }
          out.push(ev);
          break;
        }
        case 'error':
          out.push({ ...base, kind: 'tool-error', action: clip('erro: ' + (str(payload['message']) || ''), 60) });
          break;
        default:
          out.push({ ...base, kind: 'heartbeat' });
      }
      return out;
    }

    if (type === 'response_item') {
      const t = str(payload['type']);
      if (t === 'function_call' || t === 'custom_tool_call') {
        const name = str(payload['name']) || 'tool';
        const key = str(payload['call_id']);
        const raw = t === 'custom_tool_call' ? payload['input'] : payload['arguments'];
        const input = typeof raw === 'string' && t === 'function_call' ? safeParse(raw) : raw;
        if (key) this.calls.set(key, name);
        const ev: NormalizedEvent = {
          ...base,
          kind: 'tool-start',
          tool: name,
          state: categorizeTool(name),
          action: redactAction(name, input),
          file: name === 'apply_patch' && typeof input === 'string' ? patchFiles(input)[0] : fileOf(name, input),
          key,
          needsApproval: this.approval === 'untrusted' && categorizeTool(name) !== 'reading'
        };
        if (liveSwitch.on) ev.live = this.liveCall(name, input);
        out.push(ev);
        if (name === 'update_plan') this.plan(obj(input), base, out);
      } else if (t === 'function_call_output' || t === 'custom_tool_call_output') {
        const key = str(payload['call_id']);
        const output = typeof payload['output'] === 'string' ? (payload['output'] as string) : JSON.stringify(payload['output'] || '');
        const code = /Process exited with code (-?\d+)/.exec(output) || /"exit_code"\s*:\s*(-?\d+)/.exec(output);
        const failed = (code && code[1] !== '0') || /^(error|apply_patch verification failed)/i.test(output.trim());
        const ev: NormalizedEvent = { ...base, kind: failed ? 'tool-error' : 'tool-end', key };
        const name = key ? this.calls.get(key) : undefined;
        if (liveSwitch.on && name) ev.live = liveOutput(name, output, !!failed);
        out.push(ev);
        if (key) this.calls.delete(key);
      } else if (t === 'local_shell_call') {
        const action = obj(payload['action']);
        const key = str(payload['call_id']);
        if (key) this.calls.set(key, 'shell');
        const ev: NormalizedEvent = { ...base, kind: 'tool-start', tool: 'shell', state: 'running', action: redactAction('shell', { command: action['command'] }), key };
        if (liveSwitch.on) ev.live = this.liveCall('shell', { command: action['command'] });
        out.push(ev);
        if (str(payload['status']) === 'completed') out.push({ ...base, kind: 'tool-end', key });
      } else if (t === 'web_search_call') {
        out.push({ ...base, kind: 'tool-start', tool: 'web_search_call', state: 'searching', action: 'pesquisando na web' });
      } else {
        out.push({ ...base, kind: 'heartbeat' });
      }
    }
    return out;
  }

  /** Comando (shell/exec_command) ou patch (apply_patch) para o terminal ao vivo. */
  private liveCall(name: string, input: unknown): LiveDetail | undefined {
    if (name === 'apply_patch') {
      const patch = typeof input === 'string' ? input : str(obj(input)['input']) || str(obj(input)['patch']);
      if (!patch) return undefined;
      const files = parseApplyPatch(patch).map((f) => ({ ...f, path: relativeTo(f.path, this.cwd) }));
      return files.length ? { t: 'diff', files, pending: true } : undefined;
    }
    if (!SHELL_CALLS.has(name)) return undefined;
    const command = commandOf(input);
    return command ? { t: 'cmd', command } : undefined;
  }

  private changesToDiffs(changes: Record<string, unknown>): LiveFileDiff[] {
    const files: LiveFileDiff[] = [];
    for (const [file, raw] of Object.entries(changes)) {
      const c = obj(raw);
      const path = relativeTo(file, this.cwd);
      if (c['add']) files.push({ path, created: true, lines: (str(obj(c['add'])['content']) || '').split('\n').map((l) => '+' + l) });
      else if (c['delete']) files.push({ path, deleted: true, lines: [] });
      else if (c['update']) {
        const u = obj(c['update']);
        const diff = (str(u['unified_diff']) || '').split('\n').filter((l) => !/^(---|\+\+\+) /.test(l));
        files.push({ path: relativeTo(str(u['move_path']) || file, this.cwd), lines: diff });
      }
    }
    return files;
  }

  private ev(at: number, replay: boolean): NormalizedEvent {
    return { kind: 'heartbeat', source: SOURCE, agentId: this.agentId || '', parentId: this.parentId, ...this.base, at, replay } as NormalizedEvent;
  }

  private plan(input: Record<string, unknown>, base: NormalizedEvent, out: NormalizedEvent[]): void {
    const steps = Array.isArray(input['plan']) ? (input['plan'] as unknown[]) : [];
    steps.forEach((raw, i) => {
      const s = obj(raw);
      const step = str(s['step']);
      if (step) out.push({ ...base, kind: 'task-upsert', taskId: 'plan' + i, taskTitle: clip(step, 90), taskStatus: todoStatus(str(s['status'])), taskKind: 'plan' });
    });
    for (let i = steps.length; i < this.planSize; i++) out.push({ ...base, kind: 'task-remove', taskId: 'plan' + i });
    this.planSize = steps.length;
  }
}

const SHELL_CALLS = new Set(['shell', 'exec_command', 'shell_command', 'container.exec', 'local_shell', 'unified_exec']);

/** Texto do comando: `["bash","-lc","npm test"]` vira "npm test". */
function commandOf(input: unknown): string | undefined {
  const i = obj(input);
  const cmd = i['command'] ?? i['cmd'];
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) {
    const parts = cmd.filter((p): p is string => typeof p === 'string');
    const shell = parts.findIndex((p) => /^-(l?c|Command)$/i.test(p));
    if (shell >= 0 && parts[shell + 1] !== undefined) return parts.slice(shell + 1).join(' ');
    return parts.join(' ');
  }
  return typeof input === 'string' ? input : undefined;
}

/**
 * Saída de uma chamada. Formatos vistos: JSON {output, metadata:{exit_code}},
 * texto "Exit code: 0 … Output:\n…" e "Process exited with code 0 … Output:\n…".
 */
function liveOutput(name: string, raw: string, failed: boolean): LiveDetail | undefined {
  if (name === 'apply_patch') return { t: 'out', output: '', isError: failed };
  if (!SHELL_CALLS.has(name)) return undefined;
  let output = raw;
  let exitCode: number | undefined;
  const parsed = safeParse(raw);
  if (parsed && typeof parsed === 'object') {
    const p = obj(parsed);
    output = str(p['output']) ?? raw;
    exitCode = num(obj(p['metadata'])['exit_code']);
  } else {
    const code = /(?:Exit code:|Process exited with code)\s*(-?\d+)/.exec(raw);
    if (code) exitCode = Number(code[1]);
    const at = raw.indexOf('Output:\n');
    if (at >= 0) output = raw.slice(at + 'Output:\n'.length);
  }
  return { t: 'out', output, exitCode, isError: failed };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export class CodexWatcher {
  private parsers = new Map<string, CodexRolloutParser>();
  private tailer: FileTailer;
  private lastSeen = 0;

  constructor(private emit: (e: NormalizedEvent[]) => void, opts: { recentMs: number; home?: () => string; ignore?: (threadId: string) => boolean }) {
    const home = () => (opts.home ? opts.home() : codexHome());
    this.tailer = new FileTailer(
      {
        roots: () => [path.join(home(), 'sessions')],
        match: (_rel, name) => /^rollout-.*\.jsonl$/.test(name),
        maxDepth: 3,
        recentMs: opts.recentMs,
        initialBytes: 768 * 1024,
        mode: 'lines',
        scanMs: 4000,
        pollMs: 700
      },
      (c) => this.onChunk(c, opts.ignore)
    );
  }

  start(): void {
    this.tailer.start();
  }

  stop(): void {
    this.tailer.stop();
  }

  async scanOnce(): Promise<void> {
    await this.tailer.scan();
  }

  status(): { found: boolean; tracked: number; lastSeen: number } {
    return { found: this.tailer.foundRoots.length > 0, tracked: this.tailer.trackedCount(), lastSeen: this.lastSeen };
  }

  private onChunk(chunk: TailChunk, ignore?: (threadId: string) => boolean): void {
    let parser = this.parsers.get(chunk.file);
    if (!parser) {
      parser = new CodexRolloutParser(ignore);
      this.parsers.set(chunk.file, parser);
    }
    // Leitura inicial começou no meio do arquivo: o session_meta ficou para
    // trás. Relê a primeira linha para saber de quem é a thread.
    if (!parser.id && chunk.initial) {
      const first = firstLine(chunk.file);
      if (first) parser.parse(first, true);
    }
    const events: NormalizedEvent[] = [];
    const now = Date.now();
    for (const l of chunk.lines || []) {
      const line = parseJson(l);
      if (line) events.push(...parser.parse(line, chunk.initial, now));
    }
    const valid = events.filter((e) => e.agentId);
    if (valid.length) {
      this.lastSeen = now;
      this.emit(valid);
    }
  }
}

/** Primeira linha JSON de um arquivo (session_meta) sem ler o arquivo todo. */
export function firstLine(file: string): Record<string, unknown> | undefined {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs');
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const nl = text.indexOf('\n');
      return parseJson(nl >= 0 ? text.slice(0, nl) : text);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
