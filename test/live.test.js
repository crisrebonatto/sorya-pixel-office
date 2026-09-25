// Terminal ao vivo: mascaramento (vazamento e falso positivo), privacidade de
// comandos, LiveLog e a extração nos parsers do Claude Code e do Codex.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { maskSecrets, commandPrivacy, isSensitivePath, matchesGlob } = require('../out/server/mask');
const { LiveLog, liveSwitch, formatOutput, parseApplyPatch } = require('../out/core/live');
const { ClaudeTranscriptParser } = require('../out/watchers/claude');
const { CodexRolloutParser } = require('../out/watchers/codex');

// Segredos FALSOS montados em partes: o texto do arquivo não pode parecer um
// token de verdade, senão o push protection do GitHub bloqueia o commit.
const fake = (...parts) => parts.join('');
const T = {
  anthropic: fake('sk-', 'ant-', 'api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
  openai: fake('sk-', 'proj-', 'AbCdEfGhIjKlMnOpQrStUvWx1234'),
  github: fake('gh', 'p_', '16C7e42F292c6912E7710c838347Ae178B4a'),
  githubPat: fake('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'),
  aws: fake('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  google: fake('AI', 'za', 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'),
  slack: fake('xo', 'xb-', '123456789012-1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx'),
  stripe: fake('sk', '_li', 've_', '51H8abcdEFGHijklMNOPqrst'),
  jwtSig: fake('SflKxwRJSMeKKF2QT4fw', 'pMeJf36POk6yJV_adQssw5c')
};
const JWT = fake('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.', T.jwtSig);

// [texto, segredo que não pode sobrar]
const LEAKS = [
  ['ANTHROPIC_API_KEY=' + T.anthropic, T.anthropic],
  ['client = OpenAI(api_key="' + T.openai + '")', T.openai],
  ['token ' + T.github + ' no log', T.github],
  [T.githubPat, T.githubPat],
  ['aws_access_key_id = ' + T.aws, T.aws],
  ['maps key ' + T.google, T.google],
  ['SLACK=' + T.slack, T.slack],
  ['stripe.api_key = "' + T.stripe + '"', T.stripe],
  ['anon: ' + JWT, T.jwtSig],
  ['DATABASE_URL=postgres://admin:Sup3rS3cret@db.example.com:5432/app', 'Sup3rS3cret'],
  ['conectando em mongodb+srv://app:Pa55w0rd@cluster0.mongodb.net/db', 'Pa55w0rd'],
  ['DATABASE_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
  ['export JWT_SECRET="troque-isto-agora"', 'troque-isto-agora'],
  ['PGPASSWORD=local123 psql -h localhost', 'local123'],
  ['{ "apiKey": "k3y-ABCdef123456" }', 'k3y-ABCdef123456'],
  ["const clientSecret = 'abc-def-ghi-123';", 'abc-def-ghi-123'],
  ['  password: s3cr3tP4ss', 's3cr3tP4ss'],
  ['curl -H "Authorization: Bearer abc.def.ghi-1234567890" https://api', 'abc.def.ghi-1234567890'],
  ['curl -H "X-Api-Key: 7f3kd92jf83" https://api', '7f3kd92jf83'],
  ['mysql --password=MyP4ssw0rd! -u root', 'MyP4ssw0rd!'],
  ['GET https://api.x.com/v1?api_key=abc123xyz789&page=2', 'abc123xyz789'],
  ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAC3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'],
  ['saída cortada:\nAAAAC3NzaC1lZDI1NTE5AAAAIOpq\n-----END RSA PRIVATE KEY-----\nfim', 'AAAAC3NzaC1lZDI1NTE5AAAAIOpq'],
  ['cliente CPF 123.456.789-09 ok', '123.456.789-09'],
  ['CNPJ 12.345.678/0001-95', '12.345.678/0001-95'],
  ['cartão 4111 1111 1111 1111 aprovado', '4111 1111 1111 1111'],
  ['Author: Cris <cris@sorya.com.br>', 'cris@sorya.com.br'],
  ['chave solta Zx8Qp2Lm9Rt4Vb7Nc1Kd6Hs3Jf5Gw0Ye na saída', 'Zx8Qp2Lm9Rt4Vb7Nc1Kd6Hs3Jf5Gw0Ye']
];

// código e saída comuns que não podem mudar
const BENIGN = [
  'npm test',
  '12 passed in 1.84s',
  'Tests  18 passed (18)',
  'const token = await getToken();',
  'function handleSubmitButtonClickEventForUserProfile2() {}',
  'commit 9caccc8551709677a8cbc89a30ebbc1e4660dcda',
  'uuid 3f2b8c1e-9d4a-4f6b-8e2a-1c3d5e7f9a0b',
  'import { Header } from "fastapi"',
  '  password: string;',
  'token: Token',
  'headers: { Authorization: `Bearer ${token}` }',
  'const url = `https://x.com?key=${apiKey}`',
  'author: "Cris"',
  'const apiKey = process.env.API_KEY;',
  'if (password.length < 8) return;',
  'secret: ${SECRET}',
  '    at Object.<anonymous> (src/app.test.ts:12:5)',
  ' ✓ src/repricer.test.ts (18 tests) 412ms',
  'To github.com:sorya/dmi.git',
  'const MAX_TOKENS = 4096;'
];

test('mascaramento: nenhum segredo da lista sobra', () => {
  for (const [text, secret] of LEAKS) {
    const r = maskSecrets(text);
    assert.ok(!r.text.includes(secret), `vazou: ${secret}\n  em: ${r.text}`);
    assert.ok(r.count > 0, `não contou: ${text}`);
    assert.equal(maskSecrets(r.text).text, r.text, 'idempotente');
  }
});

test('mascaramento: código e saída comuns ficam iguais', () => {
  for (const text of BENIGN) assert.equal(maskSecrets(text).text, text, `mexeu em: ${text}`);
});

test('mascaramento: chave privada mantém o número de linhas (diffs)', () => {
  const text = 'a\n-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\nb';
  const r = maskSecrets(text);
  assert.equal(r.text.split('\n').length, text.split('\n').length);
  assert.ok(!r.text.includes('AAAA') && r.text.startsWith('a\n') && r.text.endsWith('\nb'));
});

test('privacidade: arquivos sensíveis e comandos que leem arquivo ou imprimem segredo', () => {
  for (const p of ['.env', 'app/.env.local', 'E:\\dev\\x\\.env.production', 'id_rsa', '/home/u/.ssh/config', '/home/u/.aws/credentials', 'certs/server.pem', 'infra/prod.tfvars', 'service-account-prod.json', '.npmrc']) {
    assert.ok(isSensitivePath(p), p);
  }
  for (const p of ['src/app.ts', 'README.md', 'tests/test_env.py', 'docs/secrets-policy.md.txt']) assert.ok(!isSensitivePath(p), p);
  assert.ok(isSensitivePath('db/dump.sql', ['*.sql']));
  assert.ok(matchesGlob('config/prod.json', 'config/prod.json'));
  assert.ok(matchesGlob('a/b/fixtures/x.json', '**/fixtures/**'));

  const show = ['npm test', 'pytest -q', 'npm test 2>&1 | tail -20', 'tail -20', 'npm test | grep -E "fail|pass"', 'env NODE_ENV=test npm test', 'git diff', 'git status', 'pnpm build && pnpm test'];
  for (const c of show) assert.equal(commandPrivacy(c), undefined, c);
  const hide = {
    'cat src/app.ts': 'leitura de arquivo',
    'head -n 20 README.md': 'leitura de arquivo',
    'Get-Content config.json': 'leitura de arquivo',
    'git show HEAD:src/a.ts': 'leitura de arquivo',
    'rg TODO src': 'busca em arquivos',
    'grep -rn senha .': 'busca em arquivos',
    'cat .env': 'arquivo sensível',
    'cd app && cat ~/.ssh/id_rsa': 'arquivo sensível',
    'cp .env.example .env': 'arquivo sensível',
    env: 'pode conter segredos',
    printenv: 'pode conter segredos',
    'echo $OPENAI_API_KEY': 'pode conter segredos',
    'gh auth token': 'pode conter segredos',
    'vercel env pull': 'pode conter segredos',
    'kubectl get secret app -o yaml': 'pode conter segredos'
  };
  for (const [c, why] of Object.entries(hide)) assert.equal(commandPrivacy(c), why, c);
  assert.equal(commandPrivacy('cat db/dump.sql', ['*.sql']), 'arquivo sensível');
});

function ev(agentId, key, live, at = 1000) {
  return { kind: 'heartbeat', source: 'claude', agentId, key, live, at };
}

test('LiveLog: comando + saída, oculto sem guardar saída, diff mascarado, arquivo sensível, dedupe e limpeza', () => {
  const log = new LiveLog();
  const seen = [];
  log.on('entry', (e) => seen.push(JSON.parse(JSON.stringify(e))));
  log.ingest(ev('a1', 'k1', { t: 'cmd', command: 'npm test' }));
  assert.equal(seen.length, 0, 'desligado não guarda nada');

  log.setEnabled(true);
  log.ingest(ev('a1', 'k1', { t: 'cmd', command: 'STRIPE_KEY=' + T.stripe + ' npm test' }));
  log.ingest(ev('a1', 'k1', { t: 'out', output: '\u001b[32mok\u001b[0m\ntoken ' + T.github + '\n3 passed', exitCode: 0 }));
  log.ingest(ev('a1', 'k1', { t: 'out', output: 'duplicado', exitCode: 1 })); // hook + registro
  let [cmd] = log.snapshot();
  assert.equal(cmd.title, 'STRIPE_KEY=‹oculto› npm test');
  assert.deepEqual(cmd.lines, ['ok', 'token ‹oculto›', '3 passed']);
  assert.equal(cmd.status, 'ok');
  assert.equal(cmd.masked, 2);

  log.ingest(ev('a1', 'k2', { t: 'cmd', command: 'cat .env' }));
  log.ingest(ev('a1', 'k2', { t: 'out', output: 'DB_PASSWORD=plaintext-that-looks-normal', exitCode: 0 }));
  const hidden = log.snapshot().find((e) => e.title === 'cat .env');
  assert.equal(hidden.hidden, 'saída oculta: arquivo sensível');
  assert.deepEqual(hidden.lines, []);
  assert.ok(!JSON.stringify(seen).includes('plaintext-that-looks-normal'));

  log.ingest(ev('a1', 'k3', { t: 'diff', files: [{ path: 'src/config.ts', lines: ['@@ -1 +1 @@', '-const apiKey = "";', '+const apiKey = "k3y-ABCdef123456";', ' export {}'] }] }));
  log.ingest(ev('a1', 'k3', { t: 'diff', files: [{ path: 'src/config.ts', lines: ['+x'] }] })); // repetido
  log.ingest(ev('a1', 'k4', { t: 'diff', files: [{ path: '.env', lines: ['+API_KEY=abc'] }] }));
  const diffs = log.snapshot().filter((e) => e.kind === 'diff');
  assert.equal(diffs.length, 2);
  assert.deepEqual(diffs[0].lines, ['@@ -1 +1 @@', '-const apiKey = "";', '+const apiKey = "‹oculto›";', ' export {}']);
  assert.equal(diffs[0].adds, 1);
  assert.equal(diffs[0].dels, 1);
  assert.equal(diffs[1].hidden, 'conteúdo oculto: arquivo sensível');
  assert.deepEqual(diffs[1].lines, []);

  // saída sem comando conhecido: nada
  log.ingest(ev('a1', 'k9', { t: 'out', output: 'solto', exitCode: 0 }));
  assert.ok(!log.snapshot().some((e) => e.lines.includes('solto')));

  log.retain(new Set(['outro']));
  assert.equal(log.snapshot().length, 0);
  log.setEnabled(false);
});

test('LiveLog: saída longa fica com o fim e conta o que cortou', () => {
  const out = formatOutput(Array.from({ length: 200 }, (_, i) => 'linha ' + i).join('\n'));
  assert.equal(out.lines.length, 60);
  assert.equal(out.lines[59], 'linha 199');
  assert.equal(out.omitted, 140);
});

test('parsers: Claude e Codex anexam comando, saída e diff só com o terminal ligado', () => {
  const ids = { sessionId: 's1', agentId: 'claude:s1' };
  const lines = [
    { type: 'assistant', uuid: 'u1', timestamp: '2026-09-25T10:00:00Z', cwd: '/home/u/app', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-09-25T10:00:05Z', cwd: '/home/u/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1\nFAIL x', is_error: true }] }, toolUseResult: { stdout: 'FAIL x', stderr: '' } },
    { type: 'assistant', uuid: 'u3', timestamp: '2026-09-25T10:00:06Z', cwd: '/home/u/app', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/home/u/app/src/a.ts', old_string: 'a', new_string: 'b' } }] } },
    {
      type: 'user',
      uuid: 'u4',
      timestamp: '2026-09-25T10:00:07Z',
      cwd: '/home/u/app',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
      toolUseResult: { filePath: '/home/u/app/src/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }
    },
    { type: 'assistant', uuid: 'u5', timestamp: '2026-09-25T10:00:08Z', cwd: '/home/u/app', message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/home/u/app/src/a.ts' } }] } },
    { type: 'user', uuid: 'u6', timestamp: '2026-09-25T10:00:09Z', cwd: '/home/u/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'conteúdo do arquivo' }] } }
  ];

  liveSwitch.on = false;
  const off = new ClaudeTranscriptParser(ids);
  assert.ok(lines.flatMap((l) => off.parse(l, false)).every((e) => !e.live), 'desligado: nada de conteúdo');

  liveSwitch.on = true;
  try {
    const p = new ClaudeTranscriptParser(ids);
    const live = lines.flatMap((l) => p.parse(l, false)).filter((e) => e.live).map((e) => e.live);
    assert.deepEqual(live, [
      { t: 'cmd', command: 'npm test' },
      { t: 'out', output: 'FAIL x', exitCode: 1, isError: true },
      { t: 'diff', files: [{ path: 'src/a.ts', lines: ['@@ -1,1 +1,1 @@', '-a', '+b'], created: false }] }
    ]);

    const c = new CodexRolloutParser();
    const rows = [
      { timestamp: '2026-09-25T10:00:00Z', type: 'session_meta', payload: { id: 'th1', cwd: '/home/u/app' } },
      { timestamp: '2026-09-25T10:00:01Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'pnpm test'] }) } },
      { timestamp: '2026-09-25T10:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: '18 passed', metadata: { exit_code: 0 } }) } },
      { timestamp: '2026-09-25T10:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: /home/u/app/src/p.ts\n@@\n-x\n+y\n*** Add File: src/n.ts\n+novo\n*** End Patch' } },
      { timestamp: '2026-09-25T10:00:05Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files' } }
    ];
    const clive = rows.flatMap((r) => c.parse(r, false)).filter((e) => e.live).map((e) => e.live);
    assert.deepEqual(clive, [
      { t: 'cmd', command: 'pnpm test' },
      { t: 'out', output: '18 passed', exitCode: 0, isError: false },
      {
        t: 'diff',
        pending: true,
        files: [
          { path: 'src/p.ts', lines: ['@@ trecho @@', '-x', '+y'], created: false, deleted: false },
          { path: 'src/n.ts', lines: ['+novo'], created: true, deleted: false }
        ]
      },
      { t: 'out', output: '', isError: false }
    ]);
    assert.equal(parseApplyPatch('*** Begin Patch\n*** Delete File: a.ts\n*** End Patch')[0].deleted, true);
  } finally {
    liveSwitch.on = false;
  }
});
