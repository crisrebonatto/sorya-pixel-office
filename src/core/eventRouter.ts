import { StateStore } from './stateStore';
import { NormalizedEvent } from './types';

/**
 * Ponto único de entrada de eventos JÁ normalizados — venham dos watchers
 * de transcript, dos hooks HTTP ou do adaptador de delegação do Codex.
 * Fontes diferentes, formato único: é isso que mantém Codex, Gemini e
 * Antigravity como agentes de primeira classe, não como remendo.
 */
export class EventRouter {
  private listeners: Array<(e: NormalizedEvent) => void> = [];

  constructor(private store: StateStore) {}

  route(event: NormalizedEvent | NormalizedEvent[] | undefined): void {
    if (!event) return;
    const list = Array.isArray(event) ? event : [event];
    for (const e of list) {
      if (!e || !e.agentId) continue;
      try {
        this.store.apply(e);
      } catch (err) {
        // Um evento malformado nunca derruba o escritório.
        console.error('[agent-office] evento ignorado', e.kind, err);
      }
      for (const l of this.listeners) l(e);
    }
  }

  onEvent(listener: (e: NormalizedEvent) => void): void {
    this.listeners.push(listener);
  }
}
