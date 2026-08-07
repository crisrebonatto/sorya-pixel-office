// Tipos compartilhados entre servidor, router, store e webview.
// Formato normalizado: serve tanto para Claude Code quanto para Codex.

export type AgentSource = 'claude' | 'codex';

export type AgentState =
  | 'idle'      // sentado, sem tarefa
  | 'thinking'  // processando
  | 'reading'   // Read, Grep, Glob
  | 'writing'   // Edit, Write, NotebookEdit
  | 'running'   // Bash, comandos
  | 'searching' // WebFetch, WebSearch
  | 'waiting'   // precisa de aprovação
  | 'error'     // falhou
  | 'done';     // concluiu

export interface Agent {
  id: string;              // agent_id do hook
  source: AgentSource;
  type: string;            // agent_type: Explore, Plan, custom
  label: string;           // nome exibido
  deskIndex: number;       // mesa atribuída (-1 = sem mesa livre)
  state: AgentState;
  currentAction?: string;  // "editando auth.ts"
  taskId?: string;
  startedAt: number;
  lastEventAt: number;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;        // agent id
  source: AgentSource;
  createdAt: number;
  completedAt?: number;
}

export interface OfficeState {
  sessionActive: boolean;
  agents: Agent[];
  tasks: Task[];
  desks: number;
}

// Evento já normalizado, saído dos adaptadores e consumido pelo router.
export type NormalizedEventKind =
  | 'session-start'
  | 'session-end'
  | 'agent-start'
  | 'agent-stop'
  | 'agent-state'
  | 'task-created'
  | 'task-updated';

export interface NormalizedEvent {
  kind: NormalizedEventKind;
  source: AgentSource;
  agentId?: string;
  agentType?: string;
  state?: AgentState;
  action?: string;         // já redigido — nunca conteúdo bruto
  taskId?: string;
  taskTitle?: string;
  taskStatus?: TaskStatus;
  at: number;
}
