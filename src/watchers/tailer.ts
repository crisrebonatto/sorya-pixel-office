import * as fs from 'fs';
import * as path from 'path';

/**
 * Leitor incremental de arquivos de log, em Node puro (testável fora do
 * VS Code). Descobre arquivos por varredura periódica e lê só o que foi
 * anexado desde a última leitura. Polling em vez de fs.watch: funciona
 * igual em Windows/macOS/Linux, em pastas fora do workspace e em discos de
 * rede, e o custo é desprezível (stat de poucos arquivos por segundo).
 */

export interface TailOptions {
  /** Pastas-raiz a varrer (reavaliadas a cada varredura). */
  roots: () => string[];
  /** Filtro de arquivo por caminho relativo à raiz. */
  match: (rel: string, name: string) => boolean;
  /** Profundidade máxima de pastas. */
  maxDepth: number;
  /** Só acompanha arquivos modificados dentro desta janela. */
  recentMs: number;
  /** Na descoberta, lê no máximo os últimos N bytes (reconstrói o estado). */
  initialBytes: number;
  /** 'lines': entrega linhas novas; 'whole': entrega o arquivo inteiro a cada mudança. */
  mode: 'lines' | 'whole';
  /** Pula pastas pelo nome (ex.: tool-results). */
  skipDir?: (name: string, rel: string) => boolean;
  scanMs?: number;
  pollMs?: number;
}

export interface TailChunk {
  file: string;
  lines?: string[];
  text?: string;
  initial: boolean;
  mtimeMs: number;
}

interface Tracked {
  offset: number;
  size: number;
  mtimeMs: number;
  partial: string;
  initialDone: boolean;
}

const MAX_READ = 4 * 1024 * 1024;

export class FileTailer {
  private files = new Map<string, Tracked>();
  private scanTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private scanning = false;
  private polling = false;
  private stopped = false;
  foundRoots: string[] = [];

  constructor(private opts: TailOptions, private onChunk: (chunk: TailChunk) => void) {}

  start(): void {
    this.stopped = false;
    void this.scan();
    this.scanTimer = setInterval(() => void this.scan(), this.opts.scanMs || 5000);
    this.pollTimer = setInterval(() => void this.poll(), this.opts.pollMs || 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  trackedCount(): number {
    return this.files.size;
  }

  /** Uma varredura completa + leitura (usado em testes e na ativação). */
  async scan(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      const now = Date.now();
      const found: string[] = [];
      const discovered: Array<[string, Tracked]> = [];
      for (const root of this.opts.roots()) {
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(root);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        found.push(root);
        await this.walk(root, root, this.opts.maxDepth, now, discovered);
      }
      // Rasos primeiro (sessão principal antes dos subagentes): na
      // reconstrução, quem chegou antes pega a mesa antes.
      discovered.sort((a, b) => a[0].split(path.sep).length - b[0].split(path.sep).length || a[1].mtimeMs - b[1].mtimeMs);
      for (const [file, t] of discovered) this.files.set(file, t);
      this.foundRoots = found;
      // esquece arquivos frios (voltam se mudarem de novo)
      for (const [file, t] of this.files) {
        if (now - t.mtimeMs > this.opts.recentMs * 2) this.files.delete(file);
      }
      await this.poll();
    } finally {
      this.scanning = false;
    }
  }

  private async walk(root: string, dir: string, depth: number, now: number, discovered: Array<[string, Tracked]>): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        if (depth > 0 && !(this.opts.skipDir && this.opts.skipDir(e.name, rel))) await this.walk(root, full, depth - 1, now, discovered);
        continue;
      }
      if (!e.isFile() || !this.opts.match(rel, e.name) || this.files.has(full)) continue;
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > this.opts.recentMs) continue;
      const start = this.opts.mode === 'lines' ? Math.max(0, st.size - this.opts.initialBytes) : 0;
      discovered.push([full, { offset: start, size: -1, mtimeMs: st.mtimeMs, partial: '', initialDone: false }]);
    }
  }

  /** Lê o que mudou nos arquivos acompanhados. */
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      for (const [file, t] of this.files) {
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(file);
        } catch {
          this.files.delete(file);
          continue;
        }
        if (st.size === t.size && st.mtimeMs === t.mtimeMs) continue;
        const initial = !t.initialDone;
        if (this.opts.mode === 'whole') {
          t.size = st.size;
          t.mtimeMs = st.mtimeMs;
          t.initialDone = true;
          const text = await readRange(file, 0, Math.min(st.size, MAX_READ));
          if (text !== undefined) this.emit({ file, text, initial, mtimeMs: st.mtimeMs });
          continue;
        }
        if (st.size < t.offset) {
          // truncado/reescrito: recomeça do zero
          t.offset = 0;
          t.partial = '';
        }
        const end = Math.min(st.size, t.offset + MAX_READ);
        const chunk = end > t.offset ? await readRange(file, t.offset, end) : '';
        if (chunk === undefined) continue;
        let text = t.partial + chunk;
        // primeira leitura começando no meio do arquivo: descarta a linha cortada
        if (initial && t.offset > 0) {
          const nl = text.indexOf('\n');
          text = nl >= 0 ? text.slice(nl + 1) : '';
        }
        const parts = text.split('\n');
        t.partial = parts.pop() || '';
        t.offset = end;
        t.size = end < st.size ? -1 : st.size;
        t.mtimeMs = end < st.size ? 0 : st.mtimeMs;
        t.initialDone = true;
        const lines = parts.map((l) => l.trim()).filter(Boolean);
        if (lines.length || initial) this.emit({ file, lines, initial, mtimeMs: st.mtimeMs });
      }
    } finally {
      this.polling = false;
    }
  }

  private emit(chunk: TailChunk): void {
    try {
      this.onChunk(chunk);
    } catch (err) {
      console.error('[agent-office] erro ao processar', chunk.file, err);
    }
  }
}

async function readRange(file: string, start: number, end: number): Promise<string | undefined> {
  if (end <= start) return '';
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, end - start, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

/** JSON.parse tolerante: linha inválida vira undefined. */
export function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function tsOf(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!isNaN(t)) return t;
  }
  return fallback;
}

const projectCache = new Map<string, string | undefined>();

/**
 * Nome do projeto a partir do cwd: o nome da pasta, mas worktrees contam
 * como o repositório de origem. Assim um subagente isolado em
 * `<repo>/.claude/worktrees/agent-a4a9…` ou num `git worktree` aparece no
 * projeto certo (e no filtro "projeto local").
 */
export function projectOf(cwd: unknown): string | undefined {
  const c = str(cwd);
  if (!c) return undefined;
  if (projectCache.has(c)) return projectCache.get(c);
  if (projectCache.size > 500) projectCache.clear();
  const p = resolveProject(c);
  projectCache.set(c, p);
  return p;
}

/** Pastas de trabalho vistas nos registros (para achar fichas de agentes do projeto). */
export function seenCwds(): string[] {
  return [...projectCache.keys()];
}

/** Raiz do projeto: tira o sufixo `.claude/worktrees/<id>` de worktree isolado. */
export function projectRootOf(cwd: string): string {
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/.exec(cwd);
  return m ? m[1] : cwd;
}

function resolveProject(cwd: string): string | undefined {
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const claudeWt = /^(.*)\/\.claude\/worktrees\/[^/]+(?:\/|$)/.exec(norm);
  if (claudeWt) return path.posix.basename(claudeWt[1]) || undefined;
  try {
    // worktree do git: o `.git` é um arquivo "gitdir: <repo>/.git/worktrees/<nome>"
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(cwd, '.git'), 'utf8'));
    const gitdir = m ? path.resolve(cwd, m[1]).replace(/\\/g, '/') : '';
    const repo = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(gitdir);
    if (repo) return path.posix.basename(repo[1]) || undefined;
  } catch {
    // sem .git, .git é pasta (repo normal) ou cwd de outra máquina
  }
  return path.posix.basename(norm) || undefined;
}
