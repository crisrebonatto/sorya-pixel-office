import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Instalação OPCIONAL de hooks. O escritório já funciona sem nada disso
 * (lê os registros locais); os hooks só trazem precisão ao vivo — em
 * especial o estado "aguardando você", que nenhum registro grava.
 *
 * Regras: faz backup (<arquivo>.agent-office.bak) antes da primeira
 * escrita, só mexe nas entradas marcadas como nossas e desinstala limpo.
 */

export type HookTarget = 'claude' | 'codex' | 'gemini' | 'cursor' | 'copilot';

export interface TargetInfo {
  id: HookTarget;
  label: string;
  file: string;
  detected: boolean;
  installed: boolean;
  needsNode: boolean;
  note?: string;
}

export interface InstallContext {
  port: number;
  token: string;
  hookScript: string; // ~/.agent-office/hook.js
}

type Json = Record<string, unknown>;

const OURS = /agent-office|\/hook\/claude/;

export function claudeSettingsFile(): string {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(home, 'settings.json');
}

function codexHooksFile(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
}

export function targetFiles(): Record<HookTarget, string> {
  const home = os.homedir();
  return {
    claude: claudeSettingsFile(),
    codex: codexHooksFile(),
    gemini: path.join(home, '.gemini', 'settings.json'),
    cursor: path.join(home, '.cursor', 'hooks.json'),
    copilot: path.join(home, '.copilot', 'hooks', 'agent-office.json')
  };
}

const LABELS: Record<HookTarget, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  copilot: 'GitHub Copilot (VS Code)'
};

const NOTES: Partial<Record<HookTarget, string>> = {
  claude: 'hook HTTP (sem dependências); detecta pedidos de permissão na hora',
  codex: 'o Codex pede para revisar hooks novos (/hooks) antes de rodá-los',
  gemini: 'requer Node no PATH',
  cursor: 'requer Node no PATH',
  copilot: 'requer Node no PATH; hooks do agente do VS Code'
};

export function listTargets(): TargetInfo[] {
  const files = targetFiles();
  return (Object.keys(files) as HookTarget[]).map((id) => {
    const file = files[id];
    const dir = id === 'copilot' ? path.dirname(path.dirname(file)) : path.dirname(file);
    return {
      id,
      label: LABELS[id],
      file,
      detected: fs.existsSync(dir),
      installed: isInstalled(id),
      needsNode: id !== 'claude',
      note: NOTES[id]
    };
  });
}

export function nodeAvailable(): boolean {
  try {
    const r = spawnSync('node', ['--version'], { timeout: 4000, shell: process.platform === 'win32' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function readJson(file: string): Json {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const v = JSON.parse(text); // JSON inválido: aborta sem escrever nada
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('formato inesperado em ' + file);
  return v as Json;
}

function writeJson(file: string, data: Json): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = file + '.agent-office.bak';
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function commandFor(ctx: InstallContext, source: string): string {
  return 'node "' + ctx.hookScript + '" ' + source;
}

// ── Mesclagem pura (testável) ────────────────────────────────────────

const CLAUDE_EVENTS: Array<[string, boolean]> = [
  ['UserPromptSubmit', false],
  ['PreToolUse', true],
  ['PostToolUse', true],
  ['PostToolUseFailure', true],
  ['PermissionRequest', true],
  ['Notification', false],
  ['Stop', false],
  ['SubagentStart', false],
  ['SubagentStop', false],
  ['SessionEnd', false]
];

/** Remove de um bloco `hooks` (formato Claude/Codex/Gemini) as entradas nossas. */
export function stripMatcherHooks(hooks: Json): Json {
  const out: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => {
        const group = g as Json;
        if (!Array.isArray(group['hooks'])) return group;
        const inner = (group['hooks'] as Json[]).filter((h) => !OURS.test(String(h['url'] || '') + ' ' + String(h['command'] || '') + ' ' + String(h['name'] || '')));
        return inner.length ? Object.assign({}, group, { hooks: inner }) : undefined;
      })
      .filter(Boolean);
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function mergeClaude(settings: Json, ctx: InstallContext): Json {
  const hooks = stripMatcherHooks((settings['hooks'] as Json) || {});
  for (const [event, tool] of CLAUDE_EVENTS) {
    const handler = {
      type: 'http',
      url: 'http://127.0.0.1:' + ctx.port + '/hook/claude',
      headers: { Authorization: 'Bearer ' + ctx.token },
      timeout: 3
    };
    const group: Json = tool ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
    hooks[event] = ((hooks[event] as unknown[]) || []).concat([group]);
  }
  return Object.assign({}, settings, { hooks });
}

export function mergeCodex(file: Json, ctx: InstallContext): Json {
  const hooks = stripMatcherHooks((file['hooks'] as Json) || {});
  const events: Array<[string, boolean, boolean]> = [
    ['SessionStart', false, true],
    ['UserPromptSubmit', false, true],
    ['PreToolUse', true, true],
    ['PermissionRequest', true, true],
    ['PostToolUse', true, true],
    ['Stop', false, true],
    ['SubagentStart', false, true],
    ['SubagentStop', false, true]
  ];
  for (const [event, tool, async] of events) {
    const handler: Json = { type: 'command', command: commandFor(ctx, 'codex'), timeout: 5, statusMessage: 'agent-office' };
    if (async) handler['async'] = true;
    const group: Json = tool ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
    hooks[event] = ((hooks[event] as unknown[]) || []).concat([group]);
  }
  return Object.assign({}, file, { hooks });
}

export function mergeGemini(settings: Json, ctx: InstallContext): Json {
  const hooks = stripMatcherHooks((settings['hooks'] as Json) || {});
  const events: Array<[string, boolean]> = [
    ['SessionStart', false],
    ['SessionEnd', false],
    ['BeforeAgent', false],
    ['AfterAgent', false],
    ['BeforeTool', true],
    ['AfterTool', true],
    ['Notification', false]
  ];
  for (const [event, tool] of events) {
    const handler = { type: 'command', command: commandFor(ctx, 'gemini'), name: 'agent-office', timeout: 3000 };
    const group: Json = tool ? { matcher: '*', hooks: [handler] } : { hooks: [handler] };
    hooks[event] = ((hooks[event] as unknown[]) || []).concat([group]);
  }
  return Object.assign({}, settings, { hooks });
}

/** Cursor e Copilot: lista plana de handlers por evento. */
function stripFlat(hooks: Json): Json {
  const out: Json = {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) {
      out[event] = list;
      continue;
    }
    const kept = (list as Json[]).filter((h) => !OURS.test(String(h['command'] || '') + ' ' + String(h['bash'] || '')));
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function mergeCursor(file: Json, ctx: InstallContext): Json {
  const hooks = stripFlat((file['hooks'] as Json) || {});
  for (const event of ['beforeSubmitPrompt', 'beforeShellExecution', 'afterShellExecution', 'afterFileEdit', 'beforeMCPExecution', 'afterMCPExecution', 'stop']) {
    hooks[event] = ((hooks[event] as unknown[]) || []).concat([{ command: commandFor(ctx, 'cursor'), timeout: 3 }]);
  }
  return Object.assign({ version: 1 }, file, { hooks });
}

export function copilotFile(ctx: InstallContext): Json {
  const hooks: Json = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']) {
    hooks[event] = [{ type: 'command', command: commandFor(ctx, 'copilot'), timeout: 5 }];
  }
  return { hooks };
}

// ── Operações em disco ────────────────────────────────────────────────

export function isInstalled(id: HookTarget): boolean {
  const file = targetFiles()[id];
  try {
    return OURS.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

export function install(id: HookTarget, ctx: InstallContext): string {
  const file = targetFiles()[id];
  switch (id) {
    case 'claude':
      writeJson(file, mergeClaude(readJson(file), ctx));
      break;
    case 'codex':
      writeJson(file, mergeCodex(readJson(file), ctx));
      break;
    case 'gemini':
      writeJson(file, mergeGemini(readJson(file), ctx));
      break;
    case 'cursor':
      writeJson(file, mergeCursor(readJson(file), ctx));
      break;
    case 'copilot':
      writeJson(file, copilotFile(ctx));
      break;
  }
  return file;
}

export function uninstall(id: HookTarget): string | undefined {
  const file = targetFiles()[id];
  if (!fs.existsSync(file) || !isInstalled(id)) return undefined;
  if (id === 'copilot') {
    fs.unlinkSync(file);
    return file;
  }
  const data = readJson(file);
  const hooks = (data['hooks'] as Json) || {};
  const cleaned = id === 'cursor' ? stripFlat(hooks) : stripMatcherHooks(hooks);
  const next = Object.assign({}, data);
  if (Object.keys(cleaned).length) next['hooks'] = cleaned;
  else delete next['hooks'];
  writeJson(file, next);
  return file;
}
