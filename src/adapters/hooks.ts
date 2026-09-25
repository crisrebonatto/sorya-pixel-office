import { AgentSource, NormalizedEvent, NormalizedEventKind } from '../core/types';
import { categorizeTool, clip, fileOf, needsApproval, promptTitle, redactAction } from '../server/redact';
import { obj, projectOf, str } from '../watchers/tailer';

/**
 * Normalizador universal de hooks. Cada ferramenta nomeia seus eventos de
 * um jeito (PreToolUse, BeforeTool, beforeShellExecution, pre_run_command…)
 * e manda campos diferentes; aqui tudo vira o mesmo NormalizedEvent.
 * O payload bruto morre aqui — só sai o que redact.ts deixa passar.
 */

const SOURCES = new Set<AgentSource>(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'windsurf', 'other']);

export function parseSource(s: string | undefined): AgentSource | undefined {
  const v = (s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'claudecode') return 'claude';
  if (v === 'geminicli') return 'gemini';
  if (v === 'vscode' || v === 'githubcopilot') return 'copilot';
  if (v === 'agy' || v === 'antigravityide') return 'antigravity';
  if (v === 'devin' || v === 'cascade') return 'windsurf';
  return SOURCES.has(v as AgentSource) ? (v as AgentSource) : undefined;
}

/** Descobre a ferramenta pelo formato do payload quando a URL não diz. */
export function detectSource(p: Record<string, unknown>): AgentSource {
  const explicit = parseSource(str(p['source']));
  if (explicit) return explicit;
  const tp = (str(p['transcript_path']) || str(p['transcriptPath']) || '').replace(/\\/g, '/');
  if (tp.includes('/.claude/')) return 'claude';
  if (tp.includes('/.codex/')) return 'codex';
  if (tp.includes('/antigravity')) return 'antigravity';
  if (tp.includes('/.gemini/')) return 'gemini';
  if (tp.includes('/.copilot/') || tp.includes('/Code/User/')) return 'copilot';
  if (p['cursor_version'] !== undefined || (p['conversation_id'] !== undefined && p['generation_id'] !== undefined)) return 'cursor';
  if (p['trajectory_id'] !== undefined || p['agent_action_name'] !== undefined) return 'windsurf';
  if (p['conversationId'] !== undefined && (p['toolCall'] !== undefined || p['invocationNum'] !== undefined || p['workspacePaths'] !== undefined)) return 'antigravity';
  if (str(p['hook_event_name'])) return 'claude';
  return 'other';
}

/** Nome do evento → tipo canônico (ignora caixa e separadores). */
const EVENT_MAP: Record<string, NormalizedEventKind> = {
  sessionstart: 'session-start',
  sessionend: 'session-end',
  userpromptsubmit: 'prompt',
  userpromptsubmitted: 'prompt',
  beforesubmitprompt: 'prompt',
  beforeagent: 'prompt',
  preuserprompt: 'prompt',
  preinvocation: 'prompt',
  taskstart: 'prompt',
  taskresume: 'prompt',
  pretooluse: 'tool-start',
  beforetool: 'tool-start',
  beforeshellexecution: 'tool-start',
  beforereadfile: 'tool-start',
  beforemcpexecution: 'tool-start',
  preruncommand: 'tool-start',
  prereadcode: 'tool-start',
  prewritecode: 'tool-start',
  premcptooluse: 'tool-start',
  posttooluse: 'tool-end',
  aftertool: 'tool-end',
  aftershellexecution: 'tool-end',
  afterfileedit: 'tool-end',
  aftermcpexecution: 'tool-end',
  postruncommand: 'tool-end',
  postreadcode: 'tool-end',
  postwritecode: 'tool-end',
  postmcptooluse: 'tool-end',
  posttoolusefailure: 'tool-error',
  erroroccurred: 'tool-error',
  permissionrequest: 'waiting',
  notification: 'waiting',
  stop: 'turn-end',
  afteragent: 'turn-end',
  agentstop: 'turn-end',
  postinvocation: 'turn-end',
  postcascaderesponse: 'turn-end',
  postcascaderesponsewithtranscript: 'turn-end',
  taskcomplete: 'turn-end',
  teammateidle: 'turn-end',
  stopfailure: 'tool-error',
  interrupt: 'turn-aborted',
  taskcancel: 'turn-aborted',
  subagentstart: 'agent-start',
  subagentstop: 'agent-stop',
  taskcreated: 'task-upsert',
  taskcompleted: 'task-upsert',
  precompact: 'heartbeat',
  postcompact: 'heartbeat',
  precompress: 'heartbeat',
  afteragentresponse: 'heartbeat',
  afteragentthought: 'heartbeat'
};

export function normalizeHook(sourceHint: AgentSource | undefined, raw: unknown, now = Date.now()): NormalizedEvent[] {
  const p = obj(raw);
  const source = sourceHint && sourceHint !== 'other' ? sourceHint : detectSource(p);
  const eventName =
    str(p['hook_event_name']) || str(p['hookEventName']) || str(p['hookName']) || str(p['agent_action_name']) || str(p['event']) || str(p['type']);
  if (!eventName) return [];
  const canon = eventName.toLowerCase().replace(/[^a-z]/g, '');
  let kind = EVENT_MAP[canon];
  if (!kind) return [];

  const sessionId =
    str(p['session_id']) || str(p['sessionId']) || str(p['conversation_id']) || str(p['conversationId']) || str(p['trajectory_id']) || str(p['taskId']) || str(p['session']) || 'default';
  const subId = str(p['agent_id']) || str(p['agentId']);
  const agentId = source + ':' + sessionId + (subId && subId !== sessionId ? ':' + subId : '');
  const parentId = subId && subId !== sessionId ? source + ':' + sessionId : undefined;
  const roots = (p['workspace_roots'] || p['workspacePaths'] || p['workspaceRoots']) as unknown;
  const cwd = str(p['cwd']) || (Array.isArray(roots) ? str(roots[0]) : undefined);

  const base: NormalizedEvent = {
    kind,
    source,
    agentId,
    parentId,
    agentType: str(p['agent_type']) || str(p['agentType']) || str(p['agent']) || undefined,
    name: str(p['agent_name']) || str(p['teammate_name']) || undefined,
    project: projectOf(cwd),
    model: str(p['model']) || str(p['modelName']) || str(p['model_name']),
    at: now
  };
  if (base.agentType === '') base.agentType = undefined;

  const tool = toolOf(canon, p);
  const events: NormalizedEvent[] = [];

  switch (kind) {
    case 'prompt': {
      const prompt = str(p['prompt']) || str(p['user_prompt']) || str(obj(p['userPromptSubmit'])['prompt']);
      events.push({ ...base, taskTitle: prompt ? promptTitle(prompt) : undefined });
      break;
    }
    case 'tool-start':
    case 'tool-end':
    case 'tool-error': {
      if (!tool.name) {
        if (kind === 'tool-error') {
          const err = str(p['error']) || str(p['message']);
          events.push({ ...base, action: err ? clip('erro: ' + err, 60) : undefined });
          if (canon === 'stopfailure') events.push({ ...base, kind: 'turn-end' });
        }
        break;
      }
      const failed = kind === 'tool-end' && (p['success'] === false || obj(p['tool_response'])['error'] !== undefined || str(p['status']) === 'failed');
      events.push({
        ...base,
        kind: failed ? 'tool-error' : kind,
        tool: tool.name,
        state: categorizeTool(tool.name),
        action: redactAction(tool.name, tool.input),
        file: fileOf(tool.name, tool.input),
        key: tool.key,
        needsApproval: needsApproval(tool.name)
      });
      break;
    }
    case 'waiting': {
      if (canon === 'notification') {
        const nt = (str(p['notification_type']) || str(p['notificationType']) || '').toLowerCase();
        if (!/permission|needs_input|elicitation|toolpermission|input/.test(nt)) {
          events.push({ ...base, kind: 'heartbeat' });
          break;
        }
      }
      const what = tool.name ? redactAction(tool.name, tool.input) : undefined;
      events.push({ ...base, action: what ? 'pedindo permissão · ' + what : 'aguardando você', key: 'hook-wait:' + now });
      break;
    }
    case 'turn-end': {
      const status = (str(p['status']) || '').toLowerCase();
      if (status === 'aborted' || status === 'cancelled') events.push({ ...base, kind: 'turn-aborted' });
      else if (status === 'error') {
        events.push({ ...base, kind: 'tool-error', action: 'erro no turno' });
        events.push({ ...base, kind: 'turn-end' });
      } else events.push(base);
      break;
    }
    case 'agent-start':
    case 'agent-stop':
      events.push(base);
      break;
    case 'task-upsert': {
      const id = str(p['task_id']) || str(p['taskId']);
      const subject = str(p['task_subject']) || str(p['subject']);
      if (id) {
        events.push({
          ...base,
          taskId: id,
          taskTitle: subject ? clip(subject, 90) : undefined,
          taskStatus: canon === 'taskcompleted' ? 'done' : 'pending',
          taskKind: 'hook'
        });
      }
      break;
    }
    default:
      events.push(base);
  }
  return events;
}

interface ToolRef {
  name?: string;
  input?: unknown;
  key?: string;
}

/** Extrai nome/entrada/chave do tool para cada dialeto de hook. */
function toolOf(canon: string, p: Record<string, unknown>): ToolRef {
  const key = str(p['tool_use_id']) || str(p['toolUseId']) || str(p['call_id']);
  const name = str(p['tool_name']) || str(p['toolName']);
  if (name) return { name, input: p['tool_input'] ?? p['toolInput'] ?? p['parameters'], key };
  // Antigravity
  const tc = obj(p['toolCall']);
  if (str(tc['name'])) return { name: str(tc['name']), input: tc['args'], key: key || str(p['stepIdx']) };
  // Cline
  for (const k of ['preToolUse', 'postToolUse']) {
    const t = obj(p[k]);
    if (str(t['toolName'])) return { name: str(t['toolName']), input: t['parameters'], key };
  }
  // Cursor
  const gen = str(p['generation_id']);
  if (canon === 'beforeshellexecution' || canon === 'aftershellexecution') return { name: 'Shell', input: { command: p['command'] }, key: gen && gen + ':sh' };
  if (canon === 'beforereadfile') return { name: 'Read', input: { file_path: p['file_path'] }, key: gen && gen + ':rd' };
  if (canon === 'afterfileedit') return { name: 'Write', input: { file_path: p['file_path'] }, key: gen && gen + ':wr:' + str(p['file_path']) };
  if (canon === 'beforemcpexecution' || canon === 'aftermcpexecution') return { name: 'mcp:' + (str(p['tool_name']) || str(p['server']) || 'tool'), input: {}, key: gen && gen + ':mcp' };
  // Windsurf
  const ti = obj(p['tool_info']);
  const traj = str(p['execution_id']) || str(p['trajectory_id']);
  if (canon === 'preruncommand' || canon === 'postruncommand') return { name: 'run_command', input: { command: ti['command_line'] ?? ti['command'] }, key: traj && traj + ':cmd' };
  if (canon === 'prewritecode' || canon === 'postwritecode') return { name: 'write_to_file', input: { file_path: ti['file_path'] }, key: traj && traj + ':wr' };
  if (canon === 'prereadcode' || canon === 'postreadcode') return { name: 'view_file', input: { file_path: ti['file_path'] }, key: traj && traj + ':rd' };
  if (canon === 'premcptooluse' || canon === 'postmcptooluse') return { name: 'mcp:' + (str(ti['mcp_tool_name']) || 'tool'), input: {}, key: traj && traj + ':mcp' };
  // Genérico: { tool, detail|file|command }
  const g = str(p['tool']);
  if (g) return { name: g, input: { file_path: p['file'], command: p['command'], url: p['url'] }, key: str(p['key']) || key };
  return { key };
}
