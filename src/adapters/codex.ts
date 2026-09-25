import { spawn } from 'child_process';
import * as path from 'path';
import { NormalizedEvent } from '../core/types';
import { clip, promptTitle, redactAction } from '../server/redact';
import { num, obj, parseJson, str } from '../watchers/tailer';
import { todoStatus } from '../watchers/claude';

/**
 * Delegação ao Codex CLI: roda `codex exec --json "<prompt>"` e traduz o
 * stream JSONL para o formato normalizado. A thread também aparece no
 * rollout em ~/.codex/sessions — o chamador registra o thread_id para o
 * watcher de rollouts ignorá-la e o agente não aparecer em dobro.
 *
 * Stream (codex exec --json): thread.started, turn.started,
 * item.started/updated/completed, turn.completed, turn.failed, error.
 */

export interface CodexRun {
  readonly agentId: string | undefined;
  dispose(): void;
}

export function runCodexTask(
  command: string,
  prompt: string,
  cwd: string | undefined,
  emit: (events: NormalizedEvent[]) => void,
  hooks: { onThread?: (threadId: string) => void; onError?: (message: string) => void } = {}
): CodexRun {
  let agentId: string | undefined;
  let finished = false;
  const project = cwd ? path.basename(cwd) : undefined;
  const translator = new CodexExecTranslator(prompt, project);

  const child = spawn(command, ['exec', '--json', prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      const event = line ? parseJson(line) : undefined;
      if (!event) continue;
      const out = translator.translate(event);
      if (translator.threadId && !agentId) {
        agentId = translator.agentId;
        if (hooks.onThread) hooks.onThread(translator.threadId);
      }
      if (translator.turnDone) finished = true;
      if (out.length) emit(out);
    }
  });

  child.on('error', (err) => {
    if (hooks.onError) hooks.onError(String(err.message || err));
  });

  child.on('exit', (code) => {
    const at = Date.now();
    if (!agentId) return;
    const events: NormalizedEvent[] = [];
    if (!finished) {
      events.push({ kind: 'tool-error', source: 'codex', agentId, action: 'codex saiu com código ' + code, at });
      events.push({ kind: 'turn-end', source: 'codex', agentId, taskStatus: code === 0 ? 'done' : 'failed', at });
    }
    emit(events);
    // execução pontual: o agente sai do escritório depois de um respiro
    const id = agentId;
    setTimeout(() => emit([{ kind: 'session-end', source: 'codex', agentId: id, at: Date.now() }]), 4000);
  });

  return {
    get agentId() {
      return agentId;
    },
    dispose: () => {
      if (!child.killed) child.kill();
    }
  };
}

/** Camada de tradução isolada: se o formato mudar, troca-se só esta classe. */
export class CodexExecTranslator {
  threadId: string | undefined;
  turnDone = false;

  constructor(private prompt: string, private project?: string) {}

  get agentId(): string | undefined {
    return this.threadId ? 'codex:' + this.threadId : undefined;
  }

  translate(ev: Record<string, unknown>, now = Date.now()): NormalizedEvent[] {
    const type = str(ev['type']) || '';
    if (type === 'thread.started') {
      this.threadId = str(ev['thread_id']) || 'exec-' + now;
      const base = this.base(now);
      return [
        { ...base, kind: 'session-start', host: 'exec' },
        { ...base, kind: 'prompt', taskTitle: promptTitle(this.prompt) || clip(this.prompt, 90) }
      ];
    }
    if (!this.agentId) return [];
    const base = this.base(now);
    if (type === 'turn.started') return [{ ...base, kind: 'heartbeat', state: 'thinking' }];
    if (type === 'turn.completed') {
      this.turnDone = true;
      const u = obj(ev['usage']);
      return [
        { ...base, kind: 'usage', tokensIn: (num(u['input_tokens']) || 0) + (num(u['cache_write_input_tokens']) || 0), tokensOut: (num(u['output_tokens']) || 0) + (num(u['reasoning_output_tokens']) || 0) },
        { ...base, kind: 'turn-end', taskStatus: 'done' }
      ];
    }
    if (type === 'turn.failed' || type === 'error') {
      this.turnDone = type === 'turn.failed';
      const msg = str(obj(ev['error'])['message']) || str(ev['message']) || 'falha';
      const out: NormalizedEvent[] = [{ ...base, kind: 'tool-error', action: clip('erro: ' + msg, 60) }];
      if (type === 'turn.failed') out.push({ ...base, kind: 'turn-end', taskStatus: 'failed' });
      return out;
    }
    if (type === 'item.started' || type === 'item.completed') {
      const item = obj(ev['item']);
      const itype = str(item['type']) || '';
      const key = 'x:' + (str(item['id']) || now);
      const started = type === 'item.started';
      switch (itype) {
        case 'command_execution': {
          if (started) return [{ ...base, kind: 'tool-start', tool: 'exec_command', state: 'running', action: redactAction('exec_command', { cmd: item['command'] }), key }];
          const code = num(item['exit_code']);
          const failed = str(item['status']) === 'failed' || (code !== undefined && code !== 0);
          return [{ ...base, kind: failed ? 'tool-error' : 'tool-end', key }];
        }
        case 'file_change': {
          const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
          const first = str(obj(changes[0])['path']);
          const file = first ? path.basename(first) : undefined;
          if (started) return [{ ...base, kind: 'tool-start', tool: 'apply_patch', state: 'writing', action: file ? 'editando ' + file + (changes.length > 1 ? ' +' + (changes.length - 1) : '') : 'editando código', file, key }];
          return [{ ...base, kind: str(item['status']) === 'failed' ? 'tool-error' : 'tool-end', key }];
        }
        case 'mcp_tool_call': {
          const name = 'mcp__' + (str(item['server']) || 'mcp') + '__' + (str(item['tool']) || 'tool');
          if (started) return [{ ...base, kind: 'tool-start', tool: name, state: 'running', action: redactAction(name, {}), key }];
          return [{ ...base, kind: item['error'] ? 'tool-error' : 'tool-end', key }];
        }
        case 'web_search':
          return started ? [{ ...base, kind: 'tool-start', tool: 'web_search', state: 'searching', action: 'pesquisando na web', key }] : [{ ...base, kind: 'tool-end', key }];
        case 'todo_list': {
          const items = Array.isArray(item['items']) ? (item['items'] as unknown[]) : [];
          return items
            .map((raw, i) => {
              const t = obj(raw);
              const text = str(t['text']);
              return text ? ({ ...base, kind: 'task-upsert', taskId: 'todo' + i, taskTitle: clip(text, 90), taskStatus: t['completed'] === true ? 'done' : todoStatus('pending'), taskKind: 'plan' } as NormalizedEvent) : undefined;
            })
            .filter((x): x is NormalizedEvent => !!x);
        }
        default:
          return [{ ...base, kind: 'heartbeat' }];
      }
    }
    return [];
  }

  private base(at: number): NormalizedEvent {
    return { kind: 'heartbeat', source: 'codex', agentId: this.agentId || '', project: this.project, at };
  }
}
