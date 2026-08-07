import { EventEmitter } from 'events';
import { Agent, OfficeState, Task } from './types';
import { DeskManager, GhostDesk } from './deskManager';

export interface OfficeSnapshot extends OfficeState {
  ghosts: GhostDesk[];
}

/**
 * Estado em memória, e SÓ em memória. Nada é persistido em disco na v1:
 * tudo morre com a sessão. Histórico entre sessões é feature separada,
 * com decisões próprias de privacidade e TTL.
 */
export class StateStore extends EventEmitter {
  private sessionActive = false;
  private agents = new Map<string, Agent>();
  private tasks = new Map<string, Task>();
  readonly desks: DeskManager;

  constructor(deskCount: number) {
    super();
    this.desks = new DeskManager(deskCount);
  }

  snapshot(): OfficeSnapshot {
    return {
      sessionActive: this.sessionActive,
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      desks: this.desks.totalDesks,
      ghosts: this.desks.activeGhosts()
    };
  }

  private changed(): void {
    this.emit('change', this.snapshot());
  }

  startSession(): void {
    this.sessionActive = true;
    this.changed();
  }

  endSession(): void {
    this.sessionActive = false;
    for (const agent of this.agents.values()) {
      this.desks.release(agent.id, agent.label);
    }
    this.agents.clear();
    this.changed();
  }

  upsertAgent(partial: Omit<Agent, 'deskIndex' | 'startedAt' | 'lastEventAt'>): Agent {
    const existing = this.agents.get(partial.id);
    const now = Date.now();
    if (existing) {
      Object.assign(existing, partial, { lastEventAt: now });
      this.changed();
      return existing;
    }
    const agent: Agent = {
      ...partial,
      deskIndex: this.desks.assign(partial.id),
      startedAt: now,
      lastEventAt: now
    };
    this.agents.set(agent.id, agent);
    this.sessionActive = true;
    this.changed();
    return agent;
  }

  updateAgentState(agentId: string, state: Agent['state'], action?: string): Agent | undefined {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return undefined;
    }
    agent.state = state;
    agent.currentAction = action;
    agent.lastEventAt = Date.now();
    if (state === 'waiting') {
      this.emit('waiting', agent);
    }
    this.changed();
    return agent;
  }

  removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    this.desks.release(agent.id, agent.label);
    this.agents.delete(agentId);
    this.changed();
  }

  upsertTask(task: Task): void {
    const existing = this.tasks.get(task.id);
    if (existing) {
      Object.assign(existing, task);
    } else {
      this.tasks.set(task.id, task);
    }
    this.changed();
  }

  updateTaskStatus(taskId: string, status: Task['status']): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    task.status = status;
    if (status === 'done' || status === 'failed') {
      task.completedAt = Date.now();
    }
    this.changed();
  }

  /** Tarefa em execução atribuída a um agente, se houver. */
  runningTaskOf(agentId: string): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.assignee === agentId && task.status === 'running') {
        return task;
      }
    }
    return undefined;
  }
}
