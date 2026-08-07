// Escritório com layout FIXO: as mesas existem desde o início, mesa vazia
// fica vazia. Mesas nascendo e sumindo destruiriam a memória espacial que
// torna o painel legível de relance.

export interface GhostDesk {
  deskIndex: number;
  label: string;
  until: number;
}

const GHOST_MS = 6000;

export class DeskManager {
  private occupied = new Map<number, string>(); // deskIndex -> agentId
  private ghosts: GhostDesk[] = [];

  constructor(private total: number) {}

  get totalDesks(): number {
    return this.total;
  }

  setTotal(total: number): void {
    this.total = total;
  }

  /** agent_id novo ocupa a menor mesa livre. -1 se o escritório está cheio. */
  assign(agentId: string): number {
    for (let i = 0; i < this.total; i++) {
      if (!this.occupied.has(i)) {
        this.occupied.set(i, agentId);
        this.ghosts = this.ghosts.filter(g => g.deskIndex !== i);
        return i;
      }
    }
    return -1;
  }

  /**
   * Libera a mesa mas mantém o nome esmaecido por alguns segundos,
   * para dar tempo de ler o que acabou de acontecer.
   */
  release(agentId: string, label: string): void {
    for (const [desk, id] of this.occupied) {
      if (id === agentId) {
        this.occupied.delete(desk);
        this.ghosts.push({ deskIndex: desk, label, until: Date.now() + GHOST_MS });
        return;
      }
    }
  }

  activeGhosts(): GhostDesk[] {
    const now = Date.now();
    this.ghosts = this.ghosts.filter(g => g.until > now);
    return this.ghosts;
  }

  reset(): void {
    this.occupied.clear();
    this.ghosts = [];
  }
}
