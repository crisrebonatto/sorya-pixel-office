import { NormalizedEvent, TaskStatus } from '../core/types';
import { categorizeTool, redactAction } from '../server/redact';

/**
 * Adaptador dos hooks do Claude Code.
 * Recebe o JSON bruto que o hook HTTP postou e devolve o evento
 * normalizado — já redigido. O payload bruto morre aqui.
 *
 * Campos-chave do hook:
 *  - agent_id: identifica unicamente o subagente (o número da mesa)
 *  - agent_type: o tipo (Explore, Plan, custom) — o skin do sprite
 */
export function normalizeClaudeEvent(raw: unknown): NormalizedEvent | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const payload = raw as Record<string, unknown>;
  const eventName = str(payload['hook_event_name']) ?? str(payload['event']);
  if (!eventName) {
    return undefined;
  }

  const at = Date.now();
  // Sessão principal também ocupa mesa: sem agent_id, cai no session_id.
  const agentId = str(payload['agent_id']) ?? str(payload['session_id']);
  const agentType = str(payload['agent_type']) ?? 'Claude';
  const base = { source: 'claude' as const, agentId, agentType, at };

  switch (eventName) {
    case 'SessionStart':
      return { ...base, kind: 'session-start' };

    case 'SessionEnd':
      return { ...base, kind: 'session-end' };

    case 'SubagentStart':
      return { ...base, kind: 'agent-start' };

    case 'SubagentStop':
      return { ...base, kind: 'agent-stop' };

    case 'PreToolUse': {
      const toolName = str(payload['tool_name']) ?? '';
      return {
        ...base,
        kind: 'agent-state',
        state: categorizeTool(toolName),
        action: redactAction(toolName, payload['tool_input'])
      };
    }

    case 'PostToolUse':
      return { ...base, kind: 'agent-state', state: 'thinking' };

    case 'PostToolUseFailure':
      return { ...base, kind: 'agent-state', state: 'error' };

    case 'Notification': {
      const type = str(payload['notification_type']);
      if (type && type !== 'agent_needs_input' && type !== 'permission_request') {
        return undefined;
      }
      return { ...base, kind: 'agent-state', state: 'waiting', action: 'aguardando você' };
    }

    case 'PermissionRequest':
      return { ...base, kind: 'agent-state', state: 'waiting', action: 'pedindo permissão' };

    case 'TaskCreated':
      return {
        ...base,
        kind: 'task-created',
        taskId: str(payload['task_id']) ?? `claude-${at}`,
        taskTitle: str(payload['task_title']) ?? str(payload['title']) ?? 'tarefa',
        taskStatus: 'pending'
      };

    case 'TaskCompleted':
      return {
        ...base,
        kind: 'task-updated',
        taskId: str(payload['task_id']) ?? '',
        taskStatus: 'done' as TaskStatus
      };

    case 'TeammateIdle':
      return { ...base, kind: 'agent-state', state: 'idle' };

    case 'Stop':
      return { ...base, kind: 'agent-state', state: 'idle' };

    default:
      return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
