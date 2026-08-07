import { StateStore } from './stateStore';
import { NormalizedEvent } from './types';

/**
 * Consome eventos JÁ normalizados (saídos dos adaptadores) e aplica no
 * estado. Fontes diferentes, formato único: é isso que mantém o Codex
 * como agente de primeira classe, não como remendo.
 */
export class EventRouter {
  constructor(private store: StateStore) {}

  route(event: NormalizedEvent): void {
    switch (event.kind) {
      case 'session-start':
        this.store.startSession();
        break;

      case 'session-end':
        this.store.endSession();
        break;

      case 'agent-start':
        this.store.upsertAgent({
          id: event.agentId ?? `${event.source}-${event.at}`,
          source: event.source,
          type: event.agentType ?? 'agent',
          label: event.agentType ?? event.source,
          state: 'thinking',
          taskId: event.taskId
        });
        if (event.taskId) {
          this.store.updateTaskStatus(event.taskId, 'running');
        }
        break;

      case 'agent-state': {
        if (!event.agentId || !event.state) {
          break;
        }
        const agent = this.store.updateAgentState(event.agentId, event.state, event.action);
        if (agent && event.state === 'error') {
          const taskId = agent.taskId ?? this.store.runningTaskOf(agent.id)?.id;
          if (taskId) {
            this.store.updateTaskStatus(taskId, 'failed');
          }
        }
        break;
      }

      case 'agent-stop': {
        if (!event.agentId) {
          break;
        }
        this.store.updateAgentState(event.agentId, 'done');
        // Mesa libera depois de um respiro, para o "done" ser visível.
        setTimeout(() => this.store.removeAgent(event.agentId!), 2500);
        break;
      }

      case 'task-created':
        this.store.upsertTask({
          id: event.taskId ?? `task-${event.at}`,
          title: event.taskTitle ?? 'tarefa',
          status: event.taskStatus ?? 'pending',
          assignee: event.agentId ?? '',
          source: event.source,
          createdAt: event.at
        });
        break;

      case 'task-updated':
        if (event.taskId && event.taskStatus) {
          this.store.updateTaskStatus(event.taskId, event.taskStatus);
        }
        break;
    }
  }
}
