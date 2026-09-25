import { EventEmitter } from 'events';
import { LiveEntry, LiveFileDiff, NormalizedEvent } from './types';
import { commandPrivacy, isSensitivePath, maskSecrets } from '../server/mask';

/**
 * Terminal ao vivo: comandos, saída e diffs de código de cada agente.
 *
 * Opt-in (agentOffice.liveTerminal). Os parsers só anexam conteúdo bruto
 * aos eventos quando `liveSwitch.on`; aqui ele é mascarado (server/mask.ts)
 * e cortado antes de virar LiveEntry — o único formato que sai daqui para
 * a webview ou o navegador. Fica em memória, algumas dezenas de entradas
 * por agente, e some quando o agente sai do escritório.
 */

export const liveSwitch = { on: false };

const MAX_PER_AGENT = 80;
const OUT_LINES = 60;
const DIFF_LINES = 120;
const LINE_CHARS = 240;
const MAX_INPUT = 64 * 1024;

type Partial0 = Omit<LiveEntry, 'id' | 'at' | 'agentId'>;

export class LiveLog extends EventEmitter {
  private byAgent = new Map<string, LiveEntry[]>();
  private byKey = new Map<string, LiveEntry[]>();
  private keysOf = new Map<string, string[]>();
  private seq = 0;
  private hide: string[] = [];

  get enabled(): boolean {
    return liveSwitch.on;
  }

  setEnabled(on: boolean): void {
    liveSwitch.on = on;
    if (!on) this.clear();
  }

  /** Arquivos extras que nunca aparecem (agentOffice.liveTerminalHide). */
  setHidden(patterns: string[] | undefined): void {
    this.hide = (patterns || []).filter((p) => typeof p === 'string' && p.trim());
  }

  ingest(e: NormalizedEvent): void {
    if (!liveSwitch.on || !e.live) return;
    const d = e.live;
    const k = e.key ? e.agentId + '|' + e.key : undefined;

    if (d.t === 'cmd') {
      if (k && this.byKey.has(k)) return;
      const title = formatCommand(d.command);
      const why = commandPrivacy(d.command, this.hide);
      this.push(e, { kind: 'cmd', title: title.text, lines: [], status: 'running', masked: title.count, omitted: 0, hidden: why ? 'saída oculta: ' + why : undefined }, k);
      return;
    }

    if (d.t === 'out') {
      const list = k ? this.byKey.get(k) : undefined;
      if (!list) return; // sem o comando não há o que mostrar
      for (const entry of list) {
        if (entry.status !== 'running') continue; // hook + registro: já veio
        const failed = d.isError === true || (d.exitCode !== undefined && d.exitCode !== 0);
        entry.status = failed ? 'error' : 'ok';
        if (d.exitCode !== undefined) entry.exitCode = d.exitCode;
        if (entry.kind === 'cmd' && !entry.hidden && d.output) {
          const o = formatOutput(d.output);
          entry.lines = o.lines;
          entry.masked += o.count;
          entry.omitted = o.omitted;
        }
        this.emit('entry', entry);
      }
      return;
    }

    for (const f of d.files) {
      const fk = k ? k + '|' + f.path : undefined;
      if (fk && this.byKey.has(fk)) continue;
      const hidden = isSensitivePath(f.path, this.hide);
      const df = hidden ? { lines: [], count: 0, omitted: 0, adds: undefined, dels: undefined } : formatDiff(f);
      const entry = this.push(
        e,
        {
          kind: 'diff',
          title: displayPath(f.path),
          lines: df.lines,
          status: d.pending ? 'running' : 'ok',
          masked: df.count,
          omitted: df.omitted,
          adds: df.adds,
          dels: df.dels,
          created: f.created,
          deleted: f.deleted,
          hidden: hidden ? 'conteúdo oculto: arquivo sensível' : undefined
        },
        fk
      );
      // patch pendente (Codex): o resultado da chamada diz se aplicou
      if (k && d.pending) this.link(k, entry);
    }
  }

  /** Tudo o que há agora (para quem acabou de abrir). */
  snapshot(): LiveEntry[] {
    const out: LiveEntry[] = [];
    for (const list of this.byAgent.values()) out.push(...list);
    return out;
  }

  /** Esquece agentes que saíram do escritório. */
  retain(ids: Set<string>): void {
    for (const [id, list] of this.byAgent) {
      if (ids.has(id)) continue;
      for (const e of list) this.unlink(e);
      this.byAgent.delete(id);
    }
  }

  clear(): void {
    this.byAgent.clear();
    this.byKey.clear();
    this.keysOf.clear();
  }

  private push(e: NormalizedEvent, p: Partial0, key?: string): LiveEntry {
    const entry: LiveEntry = { id: 'l' + ++this.seq, at: e.at, agentId: e.agentId, ...p };
    let list = this.byAgent.get(e.agentId);
    if (!list) this.byAgent.set(e.agentId, (list = []));
    list.push(entry);
    while (list.length > MAX_PER_AGENT) this.unlink(list.shift()!);
    if (key) this.link(key, entry);
    this.emit('entry', entry);
    return entry;
  }

  private link(key: string, entry: LiveEntry): void {
    const list = this.byKey.get(key);
    if (list) list.push(entry);
    else this.byKey.set(key, [entry]);
    const keys = this.keysOf.get(entry.id);
    if (keys) keys.push(key);
    else this.keysOf.set(entry.id, [key]);
  }

  private unlink(entry: LiveEntry): void {
    for (const key of this.keysOf.get(entry.id) || []) {
      const list = (this.byKey.get(key) || []).filter((x) => x !== entry);
      if (list.length) this.byKey.set(key, list);
      else this.byKey.delete(key);
    }
    this.keysOf.delete(entry.id);
  }
}

// ── Formatação (sempre mascarada) ────────────────────────────────────────

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

function clipLine(l: string): string {
  return l.length > LINE_CHARS ? l.slice(0, LINE_CHARS - 1) + '…' : l;
}

/** Comando mascarado; multilinha (heredoc) mostra só a primeira linha. */
export function formatCommand(command: string): { text: string; count: number } {
  const m = maskSecrets(command.replace(ANSI, '').replace(/\r\n?/g, '\n').trim());
  const lines = m.text.split('\n');
  const first = clipLine(lines[0].trim());
  return { text: lines.length > 1 ? first + '  … (+' + (lines.length - 1) + ' linhas)' : first, count: m.count };
}

/** Saída: fim do texto (onde fica o resultado dos testes), mascarado. */
export function formatOutput(raw: string): { lines: string[]; count: number; omitted: number } {
  let text = raw;
  let dropped = 0;
  if (text.length > MAX_INPUT) {
    const cut = text.length - MAX_INPUT;
    dropped = countNewlines(text, cut) + 1;
    text = text.slice(cut);
    text = text.slice(text.indexOf('\n') + 1); // linha cortada no meio
  }
  text = text.replace(ANSI, '').replace(/\r\n?/g, '\n');
  // barra de progresso reescrita com \r: fica a última versão da linha
  text = text.replace(/[^\n]*\r(?=[^\n])/g, '');
  const m = maskSecrets(text);
  let lines = m.text.split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  const omitted = dropped + Math.max(0, lines.length - OUT_LINES);
  lines = lines.slice(-OUT_LINES).map(clipLine);
  return { lines, count: m.count, omitted };
}

/** Diff unificado: mascara o conteúdo de cada linha sem mexer nos prefixos. */
export function formatDiff(f: LiveFileDiff): { lines: string[]; count: number; omitted: number; adds: number; dels: number } {
  const prefix: string[] = [];
  const body: string[] = [];
  let adds = 0;
  let dels = 0;
  for (const l of f.lines) {
    if (l.startsWith('@@')) {
      prefix.push('@');
      body.push(l);
      continue;
    }
    const p = l[0] === '+' || l[0] === '-' || l[0] === ' ' ? l[0] : ' ';
    if (p === '+') adds++;
    if (p === '-') dels++;
    prefix.push(p);
    body.push(l[0] === '+' || l[0] === '-' || l[0] === ' ' ? l.slice(1) : l);
  }
  let count = 0;
  let masked: string[];
  const joined = maskSecrets(body.join('\n').replace(ANSI, ''));
  masked = joined.text.split('\n');
  count = joined.count;
  if (masked.length !== body.length) {
    // segurança: se o número de linhas mudou, mascara linha a linha
    count = 0;
    masked = body.map((b) => {
      const r = maskSecrets(b);
      count += r.count;
      return r.text;
    });
  }
  const lines = masked.map((b, i) => (prefix[i] === '@' ? clipLine(b) : clipLine(prefix[i] + b)));
  return { lines: lines.slice(0, DIFF_LINES), count, omitted: Math.max(0, lines.length - DIFF_LINES), adds, dels };
}

/** Caminho curto: relativo como veio; absoluto vira …/pasta/arquivo. */
export function displayPath(p: string): string {
  const n = p.replace(/\\/g, '/');
  if (!/^(\/|[A-Za-z]:\/)/.test(n)) return n;
  const parts = n.split('/').filter(Boolean);
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : n;
}

/** Caminho relativo à pasta de trabalho, quando está dentro dela. */
export function relativeTo(file: string, cwd: string | undefined): string {
  const f = file.replace(/\\/g, '/');
  if (!cwd) return f;
  const c = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return f.toLowerCase().startsWith(c.toLowerCase() + '/') ? f.slice(c.length + 1) : f;
}

function countNewlines(s: string, end: number): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0 && i < end; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

// ── Conversores de formato das ferramentas ──────────────────────────────

/** structuredPatch do Claude Code → linhas unificadas. */
export function linesFromStructuredPatch(patch: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(patch)) return out;
  for (const raw of patch) {
    const h = (raw || {}) as Record<string, unknown>;
    const lines = Array.isArray(h['lines']) ? (h['lines'] as unknown[]).filter((l): l is string => typeof l === 'string') : [];
    out.push(`@@ -${h['oldStart'] ?? '?'},${h['oldLines'] ?? '?'} +${h['newStart'] ?? '?'},${h['newLines'] ?? '?'} @@`);
    out.push(...lines);
  }
  return out;
}

/** Diff simples de um trecho trocado (quando a ferramenta não manda o patch pronto). */
export function linesFromReplace(oldText: string, newText: string): string[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out = ['@@ trecho @@'];
  for (let i = Math.max(0, start - 2); i < start; i++) out.push(' ' + a[i]);
  for (let i = start; i <= endA; i++) out.push('-' + a[i]);
  for (let i = start; i <= endB; i++) out.push('+' + b[i]);
  for (let i = endA + 1; i < Math.min(a.length, endA + 3); i++) out.push(' ' + a[i]);
  return out;
}

/** `*** Begin Patch` do Codex (apply_patch) → diffs por arquivo. */
export function parseApplyPatch(patch: string): LiveFileDiff[] {
  const files: LiveFileDiff[] = [];
  let cur: LiveFileDiff | undefined;
  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (m) {
      cur = { path: m[2].trim(), lines: [], created: m[1] === 'Add', deleted: m[1] === 'Delete' };
      files.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && cur) {
      cur.path = mv[1].trim();
      continue;
    }
    if (!cur || line.startsWith('*** ')) continue;
    if (line.startsWith('@@')) cur.lines.push(line.trim() === '@@' ? '@@ trecho @@' : line);
    else if (/^[ +-]/.test(line)) cur.lines.push(line);
  }
  return files;
}
