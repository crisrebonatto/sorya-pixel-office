import * as path from 'path';
import { AgentState } from '../core/types';

// O escritório precisa saber QUAL ferramenta rodou e em QUE arquivo — nunca
// o conteúdo. Nada além do que sai daqui entra em estado ou histórico:
//  - arquivos: só o basename
//  - comandos: só o binário (+ subcomando simples, ex.: "git push")
//  - web: só o host
//  - buscas/consultas: nunca o texto da busca

export type ToolCategory = Extract<AgentState, 'reading' | 'writing' | 'running' | 'searching' | 'thinking' | 'waiting'>;

const EXACT: Record<string, ToolCategory> = {
  // Claude Code
  Read: 'reading', Grep: 'reading', Glob: 'reading', LS: 'reading', NotebookRead: 'reading',
  Edit: 'writing', Write: 'writing', MultiEdit: 'writing', NotebookEdit: 'writing',
  Bash: 'running', BashOutput: 'running', KillShell: 'running', KillBash: 'running', Monitor: 'running',
  WebFetch: 'searching', WebSearch: 'searching',
  AskUserQuestion: 'waiting', ExitPlanMode: 'waiting',
  Agent: 'thinking', Task: 'thinking', TodoWrite: 'thinking', TaskCreate: 'thinking', TaskUpdate: 'thinking',
  TaskList: 'thinking', TaskGet: 'thinking', Skill: 'thinking', ToolSearch: 'thinking', SendMessage: 'thinking',
  // Codex
  exec_command: 'running', shell: 'running', shell_command: 'running', local_shell_call: 'running',
  write_stdin: 'running', unified_exec: 'running', apply_patch: 'writing', update_plan: 'thinking',
  view_image: 'reading', web_search_call: 'searching', web_search: 'searching', spawn_agent: 'thinking',
  request_user_input: 'waiting', request_permissions: 'waiting',
  // Gemini CLI
  read_file: 'reading', read_many_files: 'reading', glob: 'reading', grep_search: 'reading',
  search_file_content: 'reading', list_directory: 'reading', write_file: 'writing', replace: 'writing',
  run_shell_command: 'running', web_fetch: 'searching', google_web_search: 'searching',
  write_todos: 'thinking', ask_user: 'waiting',
  // Antigravity
  view_file: 'reading', list_dir: 'reading', find_by_name: 'reading', codebase_search: 'reading',
  view_code_item: 'reading', view_file_outline: 'reading', write_to_file: 'writing',
  replace_file_content: 'writing', multi_replace_file_content: 'writing', run_command: 'running',
  send_command_input: 'running', command_status: 'running', read_terminal: 'running',
  read_url_content: 'searching', search_web: 'searching', browser_subagent: 'searching',
  task_boundary: 'thinking', notify_user: 'thinking',
  // Cursor / Copilot
  Shell: 'running', run_in_terminal: 'running', runTests: 'running', create_file: 'writing',
  replace_string_in_file: 'writing', insert_edit_into_file: 'writing', file_search: 'reading',
  semantic_search: 'reading', fetch_webpage: 'searching', get_errors: 'reading'
};

export function categorizeTool(toolName: string): ToolCategory {
  if (!toolName) return 'thinking';
  const exact = EXACT[toolName];
  if (exact) return exact;
  const n = toolName.toLowerCase();
  if (n.startsWith('mcp') ) {
    if (/(search|fetch|browse|web|url)/.test(n)) return 'searching';
    if (/(read|get|list|view|query|find)/.test(n)) return 'reading';
    return 'running';
  }
  if (/(grep|glob|search_file|codebase|file_search|find_by|list_?dir|read|view|open_file|cat\b|outline)/.test(n)) return 'reading';
  if (/(write|edit|replace|patch|create_file|insert|delete_file|rename|move_file)/.test(n)) return 'writing';
  if (/(shell|bash|exec|command|terminal|run|test|build)/.test(n)) return 'running';
  if (/(web|fetch|url|browser|http|search)/.test(n)) return 'searching';
  if (/(ask|question|confirm|approval|permission)/.test(n)) return 'waiting';
  return 'thinking';
}

/** Ferramentas que costumam pedir permissão (para a heurística de espera). */
export function needsApproval(toolName: string): boolean {
  const c = categorizeTool(toolName);
  return c === 'writing' || c === 'searching' || c === 'running' || toolName.toLowerCase().startsWith('mcp');
}

const FILE_KEYS = ['file_path', 'path', 'notebook_path', 'filePath', 'TargetFile', 'AbsolutePath', 'target_file', 'absolute_path', 'file', 'filename', 'uri'];
const COMMAND_KEYS = ['command', 'cmd', 'CommandLine', 'commandLine', 'script'];
const URL_KEYS = ['url', 'Url', 'URL', 'href'];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function baseName(p: string): string {
  const clean = p.replace(/^file:\/\//, '').replace(/[\\/]+$/, '');
  const b = path.basename(clean.replace(/\\/g, '/'));
  return b.length > 48 ? b.slice(0, 45) + '…' : b;
}

/** Primeiro arquivo citado no input do tool (basename), se houver. */
export function fileOf(toolName: string, input: unknown): string | undefined {
  const obj = asObject(input);
  for (const k of FILE_KEYS) {
    const v = str(obj[k]);
    if (v && !/\s/.test(v.slice(0, 3))) return baseName(v);
  }
  const patch = str(obj['input']) ?? (toolName === 'apply_patch' ? str(obj['command']) ?? str(input) : undefined);
  if (patch && patch.includes('*** ')) {
    const files = patchFiles(patch);
    if (files.length) return files[0];
  }
  return undefined;
}

/** Arquivos de um patch no formato apply_patch do Codex. */
export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) && out.length < 20) out.push(baseName(m[1].trim()));
  return out;
}

/**
 * Resume um comando de shell sem argumentos sensíveis: pega o primeiro
 * comando "de verdade" (pula cd/export/env…) e devolve binário + subcomando.
 */
export function summarizeCommand(command: unknown): string | undefined {
  let text: string | undefined;
  if (Array.isArray(command)) {
    const parts = command.filter((x) => typeof x === 'string') as string[];
    // ["bash","-lc","npm test"] → usa o script
    const lc = parts.findIndex((p) => p === '-lc' || p === '-c');
    text = lc >= 0 && parts[lc + 1] ? parts[lc + 1] : parts.join(' ');
  } else {
    text = str(command);
  }
  if (!text) return undefined;
  const segments = text.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  const SKIP = new Set(['cd', 'export', 'set', 'source', '.', 'env', 'sudo', 'time', 'nohup', 'exec', 'echo', 'true', 'pushd', 'popd']);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).filter((t) => !/^[A-Z_][A-Z0-9_]*=/.test(t));
    if (!tokens.length) continue;
    let i = 0;
    while (i < tokens.length && SKIP.has(tokens[i])) i = tokens[i] === 'cd' || tokens[i] === 'pushd' ? tokens.length : i + 1;
    if (i >= tokens.length) continue;
    const bin = baseName(tokens[i].replace(/^["']|["']$/g, ''));
    if (!bin || bin.length > 30) continue;
    const sub = tokens[i + 1];
    const simpleSub = sub && /^[a-z][a-z0-9:_-]{1,20}$/.test(sub) ? ' ' + sub : '';
    return bin + simpleSub;
  }
  return undefined;
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // input textual (apply_patch freeform)
    }
    return { input: v };
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Rótulo da ação exibido na mesa/feed a partir de um tool call, já sem
 * conteúdo sensível.
 */
export function redactAction(toolName: string, toolInput: unknown): string {
  const input = asObject(toolInput);
  const category = categorizeTool(toolName);

  if (toolName === 'Agent' || toolName === 'Task' || toolName === 'spawn_agent') {
    const d = str(input['description']) ?? str(input['agent_type']) ?? str(input['subagent_type']);
    return d ? 'delegando: ' + clip(d, 60) : 'delegando a um subagente';
  }
  if (toolName === 'TodoWrite' || toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'update_plan' || toolName === 'write_todos') {
    return 'atualizando o plano';
  }
  if (category === 'waiting') return 'perguntando a você';

  const file = fileOf(toolName, toolInput);
  if (category === 'writing') {
    if (toolName === 'apply_patch') {
      const patch = str(input['input']) ?? str(input['command']) ?? (typeof toolInput === 'string' ? toolInput : undefined);
      const files = patch ? patchFiles(patch) : [];
      if (files.length) return 'editando ' + files[0] + (files.length > 1 ? ' +' + (files.length - 1) : '');
    }
    const verb = /write|create/i.test(toolName) ? 'escrevendo' : 'editando';
    return file ? verb + ' ' + file : verb + ' código';
  }
  if (category === 'reading') {
    if (file) return 'lendo ' + file;
    if (/grep|search|glob|find/i.test(toolName)) return 'buscando no código';
    if (/list|dir|ls/i.test(toolName)) return 'listando pastas';
    return 'lendo';
  }
  if (category === 'running') {
    for (const k of COMMAND_KEYS) {
      const cmd = summarizeCommand(input[k]);
      if (cmd) return 'rodando ' + cmd;
    }
    if (toolName.toLowerCase().startsWith('mcp')) return 'chamando ' + mcpLabel(toolName);
    return 'rodando comando';
  }
  if (category === 'searching') {
    for (const k of URL_KEYS) {
      const u = str(input[k]);
      const h = u ? hostOf(u) : undefined;
      if (h) return 'consultando ' + h;
    }
    if (toolName.toLowerCase().startsWith('mcp')) return 'consultando ' + mcpLabel(toolName);
    return 'pesquisando na web';
  }
  if (toolName.toLowerCase().startsWith('mcp')) return 'chamando ' + mcpLabel(toolName);
  return clip(toolName, 40);
}

/** mcp__github__list_pull_requests → "github · list_pull_requests" */
export function mcpLabel(toolName: string): string {
  const parts = toolName.split(/__|:/).filter(Boolean);
  if (parts.length >= 3) return parts[1] + ' · ' + parts.slice(2).join('_');
  return toolName.replace(/^mcp_?/, '');
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** Título de tarefa a partir de um prompt: primeira linha útil, curta. */
export function promptTitle(prompt: string, max = 90): string | undefined {
  const lines = prompt
    .replace(/<[^>]{1,40}>[\s\S]*?<\/[^>]{1,40}>/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('[') && !l.startsWith('<'));
  const first = lines[0];
  return first ? clip(first, max) : undefined;
}
