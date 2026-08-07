import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { NormalizedEvent } from '../core/types';

/**
 * Adaptador do Codex CLI.
 *
 * O fluxo: Claude (ou você) chama o comando de delegação → o adaptador
 * registra a tarefa com assignee codex → executa o CLI capturando o
 * stream de eventos JSON → traduz cada evento para o formato normalizado
 * → entrega ao mesmo router dos hooks.
 *
 * A tradução vive isolada em translateCodexEvent() de propósito: a
 * sintaxe exata do stream JSON do Codex CLI pode mudar entre versões
 * (confirme o flag na documentação atual antes de confiar). Se o formato
 * mudar, você troca esta função, não a arquitetura.
 */

export interface CodexRun {
  agentId: string;
  taskId: string;
  dispose(): void;
}

export function runCodexTask(
  command: string,
  prompt: string,
  cwd: string | undefined,
  emit: (event: NormalizedEvent) => void
): CodexRun {
  const agentId = `codex-${crypto.randomBytes(4).toString('hex')}`;
  const taskId = `task-${agentId}`;
  const now = Date.now();

  emit({
    kind: 'task-created',
    source: 'codex',
    agentId,
    taskId,
    taskTitle: prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt,
    taskStatus: 'pending',
    at: now
  });
  emit({ kind: 'agent-start', source: 'codex', agentId, agentType: 'Codex', taskId, at: now });

  // `codex exec --json` é a forma documentada de obter o stream de
  // eventos em JSONL. Se a sua versão usar outro flag, ajuste aqui.
  const child = spawn(command, ['exec', '--json', prompt], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const event = translateCodexEvent(line, agentId, taskId);
        if (event) {
          emit(event);
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  child.on('error', () => {
    emit({ kind: 'agent-state', source: 'codex', agentId, state: 'error', at: Date.now() });
    emit({ kind: 'task-updated', source: 'codex', taskId, taskStatus: 'failed', at: Date.now() });
  });

  child.on('exit', (code) => {
    const at = Date.now();
    if (code === 0) {
      emit({ kind: 'task-updated', source: 'codex', taskId, taskStatus: 'done', at });
    } else {
      emit({ kind: 'agent-state', source: 'codex', agentId, state: 'error', at });
      emit({ kind: 'task-updated', source: 'codex', taskId, taskStatus: 'failed', at });
    }
    emit({ kind: 'agent-stop', source: 'codex', agentId, at });
  });

  return {
    agentId,
    taskId,
    dispose: () => child.kill()
  };
}

/**
 * Camada de tradução isolada: JSONL do Codex → evento normalizado.
 * Mapeamento (nomes de tipo defensivos, cobrindo variações conhecidas):
 *   início de thread  → agente senta na mesa (já feito no start)
 *   início de turno   → thinking
 *   execução de comando → running
 *   alteração de arquivo → writing
 *   erro              → error
 */
export function translateCodexEvent(
  line: string,
  agentId: string,
  taskId: string
): NormalizedEvent | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined; // linha que não é JSON não interessa
  }

  const type = String(parsed['type'] ?? parsed['event'] ?? '');
  const at = Date.now();
  const base = { source: 'codex' as const, agentId, at };

  if (/turn[._-]?start|task[._-]?start/i.test(type)) {
    return { ...base, kind: 'agent-state', state: 'thinking' };
  }
  if (/command|exec|shell/i.test(type)) {
    return { ...base, kind: 'agent-state', state: 'running', action: 'rodando comando' };
  }
  if (/patch|file[._-]?change|apply/i.test(type)) {
    return { ...base, kind: 'agent-state', state: 'writing', action: 'alterando arquivo' };
  }
  if (/error|fail/i.test(type)) {
    return { ...base, kind: 'agent-state', state: 'error' };
  }
  if (/complete|turn[._-]?end|task[._-]?end/i.test(type)) {
    return { ...base, kind: 'task-updated', taskId, taskStatus: 'done' };
  }
  return undefined;
}
