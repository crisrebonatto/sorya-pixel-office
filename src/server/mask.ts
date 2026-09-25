/**
 * Mascaramento do terminal ao vivo. Tudo o que chega à tela (comando, saída,
 * diff) passa por aqui antes de sair do processo da extensão.
 *
 * Três camadas, da mais forte para a mais fraca:
 *  1. Arquivos sensíveis (.env, chaves, credenciais) nunca têm conteúdo
 *     mostrado — só o nome.
 *  2. Comandos que imprimem segredos (env, printenv, `gh auth token`…) ou
 *     que leem arquivos inteiros (cat, head…) mostram só o comando.
 *  3. No que sobra, formatos conhecidos de segredo viram ‹oculto›: tokens
 *     com prefixo (sk-, ghp_, AKIA…), JWT, chaves privadas, `SENHA=valor`,
 *     `Authorization: …`, URL com senha, CPF/CNPJ, cartão, e-mail e strings
 *     longas com cara de aleatórias.
 *
 * Padrão não pega 100%: uma senha que parece texto comum passa. Por isso a
 * leitura bruta de arquivos fica de fora e o recurso é opt-in.
 */

export const MASK = '‹oculto›';

// ── Camada 1: arquivos ─────────────────────────────────────────────────
const SENSITIVE_DIR = /(^|\/)\.(aws|ssh|gnupg|kube|docker|azure|gcloud|config\/gcloud)\//i;
const SENSITIVE_FILE = new RegExp(
  '(^|/)(' +
    [
      '\\.env(\\..*)?',
      '\\.envrc',
      '.*\\.(pem|key|p8|p12|pfx|keystore|jks|ppk|asc|gpg|kdbx|tfvars|tfstate(\\.backup)?)',
      'id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?',
      'credentials(\\..*)?',
      'secrets?(\\..*)?',
      '.*\\.secrets?(\\..*)?',
      '\\.npmrc',
      '\\.pypirc',
      '_?\\.?netrc',
      '\\.git-credentials',
      '\\.pgpass',
      '\\.htpasswd',
      '\\.dockercfg',
      'kubeconfig',
      'service[-_]?account.*\\.json',
      '.*-sa-key\\.json',
      'google-services\\.json',
      'GoogleService-Info\\.plist',
      'wp-config\\.php',
      'local\\.settings\\.json',
      'appsettings\\.(production|secrets)\\.json'
    ].join('|') +
    ')$',
  'i'
);

export function isSensitivePath(file: string, extra: string[] = []): boolean {
  const p = file.replace(/\\/g, '/');
  if (SENSITIVE_DIR.test(p) || SENSITIVE_FILE.test(p)) return true;
  return extra.some((g) => matchesGlob(p, g));
}

/** Glob simples: `*` dentro do nome, `**` atravessa pastas; sem `/` casa com o nome do arquivo. */
export function matchesGlob(file: string, glob: string): boolean {
  const g = glob.trim().replace(/\\/g, '/');
  if (!g) return false;
  const re = g
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  const target = g.includes('/') ? file : file.split('/').pop() || file;
  return new RegExp((g.includes('/') ? '(^|/)' : '^') + re + '$', 'i').test(target);
}

// ── Camada 2: comandos ─────────────────────────────────────────────────
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'nl', 'xxd', 'od', 'hexdump', 'strings', 'type', 'get-content', 'gc', 'jq', 'yq', 'tac']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'select-string', 'sls', 'findstr']);
const SECRET_CMDS: Array<[string, RegExp?]> = [
  ['printenv'],
  ['env', /^\s*(-\w+\s*)*$/], // env sem comando = imprime o ambiente
  ['set', /^\s*$/],
  ['export', /^\s*(-p)?\s*$/],
  ['declare', /-[a-z]*[xp]/],
  ['gh', /\bauth\s+(token|status\b.*(-t|--show-token))/],
  ['gcloud', /\bauth\s+(print-access-token|print-identity-token|application-default\s+print-access-token)/],
  ['aws', /\b(configure\s+(get|export-credentials)|sts\s+get-session-token|secretsmanager\s+get-secret-value|ssm\s+get-parameters?\b.*--with-decryption|ecr\s+get-login-password)/],
  ['az', /\baccount\s+get-access-token/],
  ['heroku', /\b(config\b|auth:token)/],
  ['vercel', /\benv\b/],
  ['netlify', /\benv\b/],
  ['supabase', /\bsecrets\b/],
  ['doppler', /\bsecrets\b/],
  ['railway', /\bvariables\b/],
  ['fly', /\bsecrets\b/],
  ['flyctl', /\bsecrets\b/],
  ['firebase', /functions:config:get/],
  ['op', /\b(read|item\s+get|inject)\b/],
  ['vault', /\b(read|kv\s+get)\b/],
  ['kubectl', /\b(get|describe)\s+secrets?\b|config\s+view\b.*--raw/],
  ['security', /find-(generic|internet)-password/],
  ['npm', /\btoken\b|config\s+(get|list)\b/],
  ['docker', /\blogin\b/],
  ['openssl']
];

/**
 * Por que a saída de um comando não deve aparecer (ou undefined se pode).
 * O comando em si continua aparecendo, mascarado.
 */
export function commandPrivacy(command: string, extraFiles: string[] = []): string | undefined {
  for (const stage of pipelines(command)) {
    for (let i = 0; i < stage.length; i++) {
      const words = stage[i];
      if (!words.length) continue;
      const bin = words[0];
      const rest = words.slice(1);
      const args = rest.join(' ');
      for (const w of words) {
        if (/[\\/.]/.test(w) && isSensitivePath(unquote(w).replace(/^[<>]+/, ''), extraFiles)) return 'arquivo sensível';
        if (/\$(\{|env:)?[A-Za-z_]\w*/.test(w)) {
          const name = /\$(?:\{|env:)?([A-Za-z_]\w*)/.exec(w)![1];
          if (isSecretName(name)) return 'pode conter segredos';
        }
      }
      for (const [name, re] of SECRET_CMDS) if (bin === name && (!re || re.test(args))) return 'pode conter segredos';
      const positional = positionals(rest);
      if (READERS.has(bin) && positional.length >= 1) return 'leitura de arquivo';
      if (SEARCHERS.has(bin) && (i === 0 || positional.length >= 2)) return 'busca em arquivos';
      if (bin === 'git' && rest[0] === 'show' && rest.some((w) => /^[^-].*:./.test(w))) return 'leitura de arquivo';
    }
  }
  return undefined;
}

/** Quebra em pipelines (&&, ||, ;, quebra de linha) e estágios (|); cada estágio vira palavras. */
function pipelines(command: string): string[][][] {
  const out: string[][][] = [];
  for (const chain of splitOutsideQuotes(command, /^(&&|\|\||;|\n)/)) {
    out.push(splitOutsideQuotes(chain, /^\|(?!\|)/).map(words));
  }
  return out;
}

function splitOutsideQuotes(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const m = sep.exec(s.slice(i, i + 2));
    if (m) {
      parts.push(cur);
      cur = '';
      i += m[0].length - 1;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function words(stage: string): string[] {
  const ws = (stage.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w);
  // pula atribuições de ambiente e prefixos que não mudam o comando
  while (ws.length && (/^[A-Za-z_]\w*=/.test(ws[0]) || /^(sudo|time|command|exec|nohup|nice|builtin|\\)$/.test(ws[0]))) ws.shift();
  if (ws.length) ws[0] = unquote(ws[0]).replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return ws;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^[<>|&]|^\d*>/.test(a)) break; // redirecionamento
    if (a.startsWith('-')) {
      if (/^-(n|c|e|f|m|A|B|C|-lines|-bytes|-max-count|-regexp|-context)$/.test(a)) i++; // flag com valor
      continue;
    }
    if (/^\d+$/.test(a)) continue;
    out.push(a);
  }
  return out;
}

function unquote(w: string): string {
  return w.replace(/^["']|["']$/g, '');
}

// ── Camada 3: padrões ──────────────────────────────────────────────────
const KEY_NAME =
  /pass(word|wd|phrase)?$|^pwd$|pass(word|wd)[_-]?|secret|token(?!s|iz|[_-]?(count|limit|type|usage|budget|len))|api[_-]?key|apikey|access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|master[_-]?key|credential|^auth$|authorization|auth[_-]?(token|key|secret)|cookie|session[_-]?(id|key|token|secret)|signature|^dsn$|conn(ection)?[_-]?str(ing)?|database[_-]?url|db[_-]?url|redis[_-]?url|mongo(db)?[_-]?ur[il]|^salt$/i;

export function isSecretName(name: string): boolean {
  return KEY_NAME.test(name);
}

const PLACEHOLDER = /^(\d{1,6}|\$\{.*\}|\{\{.*\}\}|<[^>]*>|x{3,}|\*+|\.{3,}|(your|my)[-_ ].*|changeme|placeholder|example|dummy|redacted|null|undefined|none|true|false|string|number|‹oculto›)$/i;

const CODE_WORD = /^(await|new|this|self|require|import|function|async|yield|typeof|get|os\.environ|process\.env|env)\b/;
const TYPE_LIKE = /^(string|number|boolean|bigint|any|unknown|never|void|object|str|int|bool|bytes|Optional\[.*\]|[A-Z][A-Za-z0-9_]*(<.*>|\[\])?( \| [A-Za-z0-9_<>[\]]+)*)$/;

const TOKEN_RES: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bsbp_[A-Za-z0-9]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g // JWT (inclui chaves do Supabase)
];

export interface Masked {
  text: string;
  count: number;
}

/** Troca segredos por ‹oculto›. Idempotente. */
export function maskSecrets(input: string): Masked {
  let count = 0;
  const hit = () => {
    count++;
    return MASK;
  };
  let t = input;

  // chave privada: do BEGIN ao END (ou até o fim, se cortada); END órfão
  // esconde o que vem antes. Cada linha vira ‹oculto› (diffs mantêm as linhas).
  const perLine = (block: string) => {
    count++;
    return block
      .split('\n')
      .map((l) => (l.trim() ? MASK : l))
      .join('\n');
  };
  t = t.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, perLine);
  t = t.replace(/^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/, perLine);

  // URL com usuário:senha@ e parâmetros de query sensíveis
  t = t.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"]+):([^\s@/'"]+)@/gi, (_m, scheme, user) => {
    count++;
    return scheme + user + ':' + MASK + '@';
  });
  t = t.replace(/([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|pwd|sig|signature|auth)=)([^&\s'"`#]+)/gi, (_m, k, v) =>
    v === MASK || /^(\$\{|\{\{|%s|:)/.test(v) ? _m : (count++, k + MASK)
  );

  // cabeçalhos e esquemas de autenticação
  // (só a sintaxe de cabeçalho `Nome: valor`; `const cookie = x` é código)
  t = t.replace(/\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|cookie|set-cookie)(\s*:\s*)(["'`]?)([^\r\n"'`,;})]+)/gi, (m, k, sep, q, v) =>
    v.trim() === MASK || v.includes('${') || /[([]/.test(v) || /^[A-Za-z_$][\w$.]*\s*\+/.test(v.trim()) || (/^[A-Za-z_$][\w$.]*$/.test(v.trim()) && !/\d/.test(v)) ? m : (count++, k + sep + q + MASK)
  );
  t = t.replace(/\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{12,})/g, (_m, s) => (count++, s + ' ' + MASK));

  // tokens com formato conhecido
  for (const re of TOKEN_RES) t = t.replace(re, hit);

  // nome_sensível = "literal"  |  "nome_sensível": "literal"  |  nome_sensível: 'literal'
  // (literal seguido de `+` é prefixo concatenado, não o segredo: 'Bearer ' + token)
  t = t.replace(/(["']?)([A-Za-z_][\w.-]*)\1(\s*(?::|=|:=|=>)\s*)(["'`])([^"'`\n]{3,}?)\4(?!\s*\+)/g, (m, q1, name, sep, q, value) => {
    if (!isSecretName(name) || PLACEHOLDER.test(value.trim())) return m;
    // nome de configuração (`agentOffice.token`) e esquema sozinho (`Bearer `)
    if (/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)+$/.test(value) || /^(Bearer|Basic|Token)\s*$/i.test(value)) return m;
    // template com variável (`Bearer ${token}`): o segredo está na variável, não no texto
    if (/\$\{|\{\{/.test(value) && !/[A-Za-z0-9_-]{16,}/.test(value.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, ''))) return m;
    count++;
    return q1 + name + q1 + sep + q + MASK + q;
  });
  // NOME_SENSIVEL=valor (env, shell, .properties), no início ou depois de espaço
  t = t.replace(/(^|[\s;])((?:export\s+|set\s+|\$env:)?)([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'#;]+)/gm, (m, pre, kw, name, sep, value) => {
    const bare = value.replace(/^["']|["']$/g, '');
    if (!isSecretName(name) || !bare || PLACEHOLDER.test(bare) || bare.includes(MASK)) return m;
    // código (`const token = await x()`): só nome em MAIÚSCULAS aceita espaço no `=`
    if (/\s/.test(sep) && name !== name.toUpperCase()) return m;
    if (CODE_WORD.test(bare) || /[(\[{]/.test(bare) || /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)+$/.test(bare)) return m;
    count++;
    const q = /^["']/.test(value) ? value[0] : '';
    return pre + kw + name + sep + q + MASK + q;
  });
  // YAML/INI sem aspas: `password: hunter2` no começo da linha (não pega tipos: `token: string;`)
  t = t.replace(/^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*)(:\s+)([^\s#'"`{}[\],;|>&][^#\n]*?)[ \t]*$/gm, (m, pre, name, sep, value) => {
    if (!isSecretName(name) || PLACEHOLDER.test(value) || value.includes(MASK) || /[;,]$/.test(value) || TYPE_LIKE.test(value) || CODE_WORD.test(value.split(/\s/)[0])) return m;
    count++;
    return pre + name + sep + MASK;
  });
  // --password valor | --api-key=valor | -Token valor
  t = t.replace(/(\s--?[\w-]*(?:password|passwd|secret|token|api-?key|apikey|auth|credential)[\w-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/gi, (m, flag, sep, value) =>
    value.includes(MASK) ? m : (count++, flag + sep + MASK)
  );

  // dados pessoais: CPF, CNPJ, cartão (Luhn) e e-mail
  t = t.replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, hit);
  t = t.replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, hit);
  t = t.replace(/\b[3-6](?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? hit() : m));
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, hit);

  // strings longas com cara de aleatórias (chaves sem prefixo conhecido)
  t = t.replace(/(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{28,}(?![A-Za-z0-9+_=-])/g, (m) => (looksRandom(m) ? hit() : m));

  return { text: t, count };
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Aleatória = mistura maiúscula, minúscula e dígitos, sem palavras (camelCase
 * longo tem várias sequências de minúsculas), com entropia alta e troca de
 * tipo de caractere frequente. Hex puro (hash de commit) não entra.
 */
export function looksRandom(s: string): boolean {
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) return false;
  if ((s.match(/\d/g) || []).length < 2) return false;
  // palavras (≥ 4 minúsculas seguidas) são coisa de identificador
  if ((s.match(/[a-z]{4,}/g) || []).length > 1) return false;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let entropy = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    entropy -= p * Math.log2(p);
  }
  const cls = (c: string) => (/[a-z]/.test(c) ? 1 : /[A-Z]/.test(c) ? 2 : /\d/.test(c) ? 3 : 4);
  let changes = 0;
  for (let i = 1; i < s.length; i++) if (cls(s[i]) !== cls(s[i - 1])) changes++;
  return entropy >= 3.6 && changes / (s.length - 1) >= 0.3;
}
