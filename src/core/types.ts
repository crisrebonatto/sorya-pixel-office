// Tipos compartilhados entre watchers, adaptadores de hook, router, store e
// webview. Formato normalizado: serve para Claude Code, Codex, Gemini CLI,
// Antigravity, Cursor, Copilot e qualquer ferramenta que poste eventos.

export type AgentSource =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'copilot'
  | 'cursor'
  | 'windsurf'
  | 'other';

export const SOURCE_LABEL: Record<AgentSource, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  other: 'Outro'
};

/** Nome curto padrão da plaquinha quando não há persona configurada. */
export const SOURCE_SHORT: Record<AgentSource, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  other: 'Agente'
};

export type AgentState =
  | 'idle' // turno encerrado, esperando o próximo prompt
  | 'thinking' // processando entre ferramentas
  | 'reading' // Read, Grep, Glob, view_file…
  | 'writing' // Edit, Write, apply_patch…
  | 'running' // Bash, exec_command, run_shell_command…
  | 'searching' // WebFetch, WebSearch, google_web_search…
  | 'waiting' // precisa de aprovação ou resposta sua
  | 'error' // ferramenta falhou
  | 'done'; // subagente concluiu

export type AgentKind = 'session' | 'subagent';

export interface AgentStats {
  tools: number;
  edits: number;
  commands: number;
  reads: number;
  searches: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
}

export interface Agent {
  id: string;
  source: AgentSource;
  kind: AgentKind;
  parentId?: string;
  type: string; // agent_type / role (rick-construtor, Explore, codex…)
  role?: string;
  displayName: string; // nome da plaquinha (Rick, Sora, Codex…)
  label: string; // nome curto sem desambiguação
  project?: string; // basename do cwd
  branch?: string;
  host?: string; // cli, claude-vscode, codex_vscode, antigravity…
  model?: string;
  deskIndex: number; // -1 = sem mesa (lounge)
  state: AgentState;
  stateSince: number;
  currentAction?: string;
  currentTool?: string;
  taskId?: string;
  startedAt: number;
  lastEventAt: number;
  stats: AgentStats;
  files: string[]; // basenames tocados (últimos N)
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';
export type TaskKind = 'prompt' | 'subagent' | 'todo' | 'plan' | 'hook';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  kind: TaskKind;
  assignee: string; // agent id
  assigneeName?: string;
  source: AgentSource;
  project?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export type ActivityKind = 'session' | 'prompt' | 'tool' | 'error' | 'waiting' | 'done' | 'idle' | 'task';

export interface Activity {
  id: string;
  at: number;
  agentId: string;
  agentName: string;
  source: AgentSource;
  project?: string;
  kind: ActivityKind;
  text: string;
}

export type SourceStatus = 'watching' | 'missing' | 'error' | 'hooks';

export interface SourceInfo {
  id: AgentSource;
  label: string;
  status: SourceStatus;
  detail?: string;
  path?: string;
  lastEventAt?: number;
}

export interface GhostDesk {
  deskIndex: number;
  label: string;
  until: number;
}

export interface OfficeSnapshot {
  sessionActive: boolean;
  desks: number;
  agents: Agent[];
  tasks: Task[];
  ghosts: GhostDesk[];
  activity: Activity[];
  sources: SourceInfo[];
  spark: number[];
  host: { appName?: string; port?: number; hooks?: string[] };
}

// ── Eventos normalizados ────────────────────────────────────────────
export type NormalizedEventKind =
  | 'session-start' // sessão apareceu (senta numa mesa)
  | 'session-end' // sessão encerrou (sai do escritório)
  | 'agent-start' // subagente entrou
  | 'agent-stop' // subagente terminou
  | 'prompt' // prompt do usuário: nova tarefa, estado pensando
  | 'tool-start' // ferramenta começou
  | 'tool-end' // ferramenta terminou bem
  | 'tool-error' // ferramenta falhou
  | 'waiting' // precisa de você (aprovação / pergunta)
  | 'turn-end' // turno encerrado → ocioso
  | 'turn-aborted' // interrompido pelo usuário
  | 'task-upsert' // tarefa explícita (todo, plano, task.md)
  | 'task-remove'
  | 'usage' // tokens
  | 'meta' // metadados (modelo, projeto, host, nome)
  | 'heartbeat'; // atividade sem mudança de estado

export interface NormalizedEvent {
  kind: NormalizedEventKind;
  source: AgentSource;
  agentId: string;
  parentId?: string;
  agentType?: string;
  name?: string; // nome explícito (nickname, título)
  agentTitle?: string; // descrição do subagente (vira o card do kanban)
  project?: string;
  branch?: string;
  host?: string;
  model?: string;
  state?: AgentState; // estado sugerido (tool-start)
  tool?: string;
  action?: string; // já redigido — nunca conteúdo bruto
  file?: string; // basename
  key?: string; // chave de deduplicação (tool_use_id, call_id…)
  taskId?: string;
  taskTitle?: string;
  taskStatus?: TaskStatus;
  taskKind?: TaskKind;
  tokensIn?: number;
  tokensOut?: number;
  needsApproval?: boolean; // ferramenta costuma pedir permissão
  at: number;
  replay?: boolean; // reconstrução do histórico (não notifica, não anima)
}
