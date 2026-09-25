import * as fs from 'fs';
import * as path from 'path';
import { AgentKind, AgentSource, SOURCE_SHORT } from './types';

/**
 * Nomes das plaquinhas. Times com personas (ex.: Sora orquestra, Rick
 * constrói, Íris faz o gate 6) descrevem cada agente numa ficha .md com
 * frontmatter:
 *
 *   ---
 *   name: rick-construtor
 *   description: Rick — rick-construtor (antes sorya-fullstack-builder). …
 *   ---
 *
 * Daqui sai: slug → persona ("Rick"), aliases antigos → mesma persona e a
 * persona da sessão principal (a ficha que se declara "sessão principal").
 * Várias fichas citam a sessão principal ("chamado pela sessão principal"),
 * então cada uma ganha uma nota e vence a que mais se declara principal.
 */

export interface AgentProfile {
  slug: string;
  persona?: string;
  description?: string;
  aliases: string[];
  main: boolean;
  /** Quanto a ficha se declara a sessão principal (0 = não se declara). */
  mainScore: number;
  file: string;
}

const BUILTIN: Record<string, string> = {
  'general-purpose': 'Assistente',
  explore: 'Explorador',
  plan: 'Planejador',
  'statusline-setup': 'Statusline',
  'claude-code-guide': 'Guia',
  'output-style-setup': 'Estilo',
  subagente: 'Subagente'
};

// Primeiros pedaços de slug que são papel, não nome ("code-reviewer" não é o "Code").
const ROLE_WORDS = new Set([
  'code', 'security', 'test', 'tests', 'data', 'api', 'web', 'ui', 'ux', 'dev', 'build', 'general', 'doc', 'docs',
  'review', 'reviewer', 'sorya', 'frontend', 'backend', 'fullstack', 'full', 'db', 'infra', 'key', 'gate', 'agent',
  'claude', 'qa', 'debug', 'release', 'deploy', 'design', 'prompt', 'copy', 'task', 'plan', 'research', 'senior',
  'junior', 'lead', 'product', 'project', 'git', 'github', 'mobile', 'cloud', 'ops', 'devops', 'sre', 'ml', 'ai',
  'llm', 'database', 'migration', 'migrations', 'bug', 'fix', 'refactor', 'performance', 'perf', 'a11y', 'seo',
  'content', 'writer', 'editor', 'analyst', 'architect', 'expert', 'helper', 'assistant', 'bot', 'the', 'my', 'new'
]);

const PERSONA_RE = /^\s*["'“]?([\p{Lu}][\p{L}\p{M}'’.]{0,23}(?:\s[\p{Lu}][\p{L}\p{M}'’.]{0,23})?)\s+[—–-]{1,2}\s+/u;
const ALIAS_RE = /\((?:antes|ex|formerly|previously|antigo)[:\s]+([a-z0-9][\w.-]*)\)/giu;
const MAIN_RE = /sess[ãa]o principal|main session|orquestrador(?:a)? d|orchestrator of/i;
const MAIN_SELF_RE = /(?:^|[^\p{L}])(?:[ée] a|sou a|a|is the|the)\s+(?:sess[ãa]o principal|main session)/iu;
const NOT_SUBAGENT_RE = /n[ãa]o\s+(?:[ée]|deve\s+ser)\s+(?:para\s+ser\s+)?(?:chamad[oa]|invocad[oa]|usad[oa])\s+como\s+sub-?agente|not\s+(?:meant\s+)?to\s+be\s+(?:called|invoked|used)\s+as\s+a\s+sub-?agent/iu;
const CALLED_BY_MAIN_RE = /(?:pela|pelo|da|do|na|no|à|para\s+a|by\s+the|from\s+the|to\s+the)\s+(?:sess[ãa]o principal|main session)/iu;

function mainScore(slug: string, description: string | undefined): number {
  if (!description) return 0;
  let score = 0;
  if (MAIN_RE.test(description)) score += 1;
  if (MAIN_SELF_RE.test(description)) score += 2;
  if (NOT_SUBAGENT_RE.test(description)) score += 2;
  if (/orquestr|orchestr/i.test(slug)) score += 2;
  if (CALLED_BY_MAIN_RE.test(description)) score -= 2;
  return Math.max(0, score);
}

export function parseFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // fichas editadas no Windows chegam com CRLF (e às vezes BOM)
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  const lines = text.slice(text.indexOf('\n') + 1, end).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(value.startsWith('|') ? '\n' : ' ');
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

export function profileFromText(text: string, file: string): AgentProfile | undefined {
  const fm = parseFrontmatter(text);
  const slug = (fm['name'] || path.basename(file, '.md')).trim();
  if (!slug) return undefined;
  const description = fm['description'];
  const m = description ? PERSONA_RE.exec(description) : null;
  const persona = m ? m[1].trim() : undefined;
  const aliases: string[] = [];
  if (description) {
    let a: RegExpExecArray | null;
    ALIAS_RE.lastIndex = 0;
    while ((a = ALIAS_RE.exec(description))) aliases.push(a[1].toLowerCase());
  }
  const score = mainScore(slug, description);
  return { slug, persona, description, aliases, main: score > 0, mainScore: score, file };
}

/** "heitor-debug" → "Heitor"; "code-reviewer" → "Code Reviewer". */
export function nameFromSlug(slug: string): string {
  const clean = slug.trim();
  if (!clean) return clean;
  const builtin = BUILTIN[clean.toLowerCase()];
  if (builtin) return builtin;
  const parts = clean.split(/[-_\s]+/).filter(Boolean);
  if (parts.length > 1 && !ROLE_WORDS.has(parts[0].toLowerCase()) && /^\p{L}+$/u.test(parts[0])) {
    return cap(parts[0]);
  }
  return parts.map(cap).join(' ');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export class NameDirectory {
  private bySlug = new Map<string, AgentProfile>();
  private mainPersona: string | undefined;
  private overrides: Record<string, string> = {};

  constructor(private dirs: () => string[]) {}

  setOverrides(map: Record<string, string> | undefined): void {
    this.overrides = {};
    for (const [k, v] of Object.entries(map || {})) {
      if (typeof v === 'string' && v.trim()) this.overrides[k.toLowerCase()] = v.trim();
    }
  }

  /** Relê as fichas. Barato: poucas dezenas de arquivos pequenos. */
  load(): number {
    const next = new Map<string, AgentProfile>();
    const best = new Map<string, number>(); // persona → maior nota de "sessão principal"
    for (const dir of this.dirs()) {
      for (const file of listMarkdown(dir, 4, 1500)) {
        let text: string;
        try {
          const st = fs.statSync(file);
          if (st.size > 512 * 1024) continue;
          text = fs.readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const p = profileFromText(text, file);
        if (!p) continue;
        next.set(p.slug.toLowerCase(), p);
        for (const a of p.aliases) if (!next.has(a)) next.set(a, p);
        if (p.main && p.persona) best.set(p.persona, Math.max(best.get(p.persona) || 0, p.mainScore));
      }
    }
    this.bySlug = next;
    // vence a persona com a maior nota; empate entre personas = ninguém
    const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
    this.mainPersona = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : undefined;
    return next.size;
  }

  /** Persona da sessão principal, se alguma ficha se declara assim. */
  mainName(): string | undefined {
    return this.mainPersona;
  }

  profile(slug: string): AgentProfile | undefined {
    return this.bySlug.get(slug.toLowerCase());
  }

  /** Mapa slug → persona, para o modo demo e a UI. */
  personas(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [slug, p] of this.bySlug) if (p.persona) out[slug] = p.persona;
    return out;
  }

  resolve(a: { source: AgentSource; kind: AgentKind; type: string; name?: string }): string {
    const type = (a.type || '').trim();
    const o = this.overrides;
    if (a.kind === 'subagent' || (type && type !== a.source)) {
      const key = type.toLowerCase();
      if (o[key]) return o[key];
      const p = this.bySlug.get(key);
      if (p && p.persona) return p.persona;
      if (a.name) return a.name;
      if (type && type !== a.source) return nameFromSlug(type);
    }
    if (o[a.source]) return o[a.source];
    if (a.name) return a.name;
    if (a.source === 'claude' && this.mainPersona) return this.mainPersona;
    return SOURCE_SHORT[a.source] || a.source;
  }
}

function listMarkdown(dir: string, depth: number, max: number): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (left > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, left - 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(dir, depth);
  return out;
}
