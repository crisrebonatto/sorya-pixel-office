// I/O de verdade: leitura incremental de arquivo, instalador de hooks,
// servidor HTTP e o script de hook ponta a ponta.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { FileTailer } = require('../out/watchers/tailer');
const { mergeClaude, mergeGemini, mergeCursor, stripMatcherHooks } = require('../out/hooks/installer');
const { startEventServer } = require('../out/server/httpServer');
const { createOfficeWeb } = require('../out/server/officeWeb');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('tailer: descobre, lê só o anexado, junta linha partida e sobrevive a truncamento', async () => {
  const dir = tmp('ao-tail-');
  const file = path.join(dir, 'proj', 's.jsonl');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
  const got = [];
  const t = new FileTailer({ roots: () => [dir], match: (_r, n) => n.endsWith('.jsonl'), maxDepth: 2, recentMs: 60000, initialBytes: 1 << 20, mode: 'lines' }, (c) => got.push(c));
  await t.scan();
  assert.deepEqual(got.map((c) => [c.initial, c.lines]), [[true, ['{"n":1}', '{"n":2}']]]);
  fs.appendFileSync(file, '{"n":3}\n{"n":');
  await t.poll();
  fs.appendFileSync(file, '4}\n');
  await t.poll();
  assert.deepEqual(got.slice(1).map((c) => c.lines), [['{"n":3}'], ['{"n":4}']]);
  fs.writeFileSync(file, '{"n":9}\n');
  await t.poll();
  assert.deepEqual(got[got.length - 1].lines, ['{"n":9}']);
  t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('tailer: arquivo grande começa pelo fim sem a linha cortada; arquivos velhos são ignorados', async () => {
  const dir = tmp('ao-tail2-');
  const big = path.join(dir, 'big.jsonl');
  fs.writeFileSync(big, Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(40) })).join('\n') + '\n');
  const old = path.join(dir, 'old.jsonl');
  fs.writeFileSync(old, '{"old":true}\n');
  const past = new Date(Date.now() - 3600e3);
  fs.utimesSync(old, past, past);
  const got = [];
  const t = new FileTailer({ roots: () => [dir], match: (_r, n) => n.endsWith('.jsonl'), maxDepth: 1, recentMs: 600e3, initialBytes: 1000, mode: 'lines' }, (c) => got.push(c));
  await t.scan();
  assert.equal(got.length, 1);
  assert.equal(got[0].file, big);
  const lines = got[0].lines.map((l) => JSON.parse(l));
  assert.equal(lines[lines.length - 1].i, 199);
  assert.ok(lines.length > 5 && lines.length < 30);
  t.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = { port: 4517, token: 'tok', hookScript: '/home/me/.agent-office/hook.js' };

test('instalador: Claude — idempotente, preserva hooks alheios e desinstala limpo', () => {
  const mine = { type: 'command', command: '~/.claude/stop-hook-git-check.sh' };
  const settings = { permissions: { allow: ['Skill'] }, hooks: { Stop: [{ matcher: '', hooks: [mine] }] } };
  const once = mergeClaude(settings, ctx);
  const twice = mergeClaude(once, ctx);
  assert.deepEqual(twice, once, 'instalar de novo não duplica');
  assert.deepEqual(once.permissions, settings.permissions);
  assert.equal(once.hooks.Stop.length, 2);
  assert.deepEqual(once.hooks.Stop[0].hooks, [mine]);
  const pre = once.hooks.PreToolUse[0];
  assert.equal(pre.matcher, '*');
  assert.equal(pre.hooks[0].type, 'http');
  assert.equal(pre.hooks[0].url, 'http://127.0.0.1:4517/hook/claude');
  assert.equal(pre.hooks[0].headers.Authorization, 'Bearer tok');
  assert.equal(once.hooks.UserPromptSubmit[0].matcher, undefined);
  const cleaned = stripMatcherHooks(once.hooks);
  assert.deepEqual(cleaned, { Stop: [{ matcher: '', hooks: [mine] }] });
});

test('instalador: Gemini e Cursor usam o script estável', () => {
  const g = mergeGemini({ theme: 'dark' }, ctx);
  assert.equal(g.theme, 'dark');
  assert.equal(g.hooks.BeforeTool[0].hooks[0].command, 'node "/home/me/.agent-office/hook.js" gemini');
  assert.equal(g.hooks.BeforeTool[0].hooks[0].name, 'agent-office');
  const c = mergeCursor({ hooks: { stop: [{ command: 'meu-script' }] } }, ctx);
  assert.equal(c.version, 1);
  assert.deepEqual(c.hooks.stop.map((h) => h.command), ['meu-script', 'node "/home/me/.agent-office/hook.js" cursor']);
  assert.deepEqual(mergeCursor(c, ctx), c);
});

function post(port, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('servidor: token, Host local, rotas /hook/<fonte> e /event', async () => {
  const got = [];
  const server = await startEventServer(46100 + Math.floor(Math.random() * 500), 'segredo', (payload, source, relayed) => got.push({ payload, source, relayed }));
  try {
    assert.equal(await post(server.port, '/hook/claude', { a: 1 }, {}), 401);
    assert.equal(await post(server.port, '/hook/claude', { a: 1 }, { Authorization: 'Bearer errado' }), 401);
    assert.equal(await post(server.port, '/hook/claude', { a: 1 }, { Authorization: 'Bearer segredo', Host: 'evil.example:80' }), 403);
    assert.equal(await post(server.port, '/nada', { a: 1 }, { Authorization: 'Bearer segredo' }), 404);
    assert.equal(await post(server.port, '/hook/gemini', { a: 2 }, { Authorization: 'Bearer segredo' }), 204);
    assert.equal(await post(server.port, '/event', { a: 3 }, { Authorization: 'Bearer segredo', 'X-Agent-Office-Relay': '1' }), 204);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got, [
      { payload: { a: 2 }, source: 'gemini', relayed: false },
      { payload: { a: 3 }, source: undefined, relayed: true }
    ]);
  } finally {
    server.dispose();
  }
});

function request(port, method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('modo navegador: token vira cookie, sem cookie é 401, mídia sem path traversal, SSE e ações', async () => {
  const actions = [];
  let snap = { agents: [], n: 1 };
  let port = 0;
  const web = createOfficeWeb({ mediaPath: path.join(__dirname, '..', 'media'), viewToken: 'v1ew', port: () => port, snapshot: () => snap, onAction: (m) => actions.push(m) });
  const server = await startEventServer(46700 + Math.floor(Math.random() * 500), 'segredo', () => undefined, false, web.handle);
  port = server.port;
  try {
    assert.equal(web.url(true), `http://127.0.0.1:${port}/office?t=v1ew`);
    assert.equal((await request(port, 'GET', '/office')).status, 401);
    assert.equal((await request(port, 'GET', '/office?t=errado')).status, 401);
    const login = await request(port, 'GET', '/office?t=v1ew');
    assert.equal(login.status, 303);
    assert.equal(login.headers.location, '/office');
    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/office/);
    const jar = { Cookie: cookie.split(';')[0] };

    const page = await request(port, 'GET', '/office', jar);
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
    assert.match(page.body, /src="\/office\/media\/browser\.js"/);
    assert.ok(!page.body.includes('{{'), 'placeholders substituídos');
    assert.equal((await request(port, 'GET', '/office', { Cookie: jar.Cookie + 'x' })).status, 401);

    assert.equal((await request(port, 'GET', '/office/media/office.js')).status, 200);
    assert.equal((await request(port, 'GET', '/office/media/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await request(port, 'GET', '/office/media/../../package.json')).status, 404);
    assert.equal((await request(port, 'GET', '/office', { Host: 'evil.example' })).status, 403);
    // o servidor de hooks continua igual
    assert.equal((await request(port, 'GET', '/health')).status, 200);

    assert.equal((await request(port, 'GET', '/office/events')).status, 401);
    const frames = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/office/events', headers: jar }, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.includes('"n":1') && !data.includes('"n":2')) {
            snap = { agents: [], n: 2 };
            web.broadcast(snap);
          }
          if (data.includes('"n":2')) {
            req.destroy();
            resolve(data);
          }
        });
      });
      req.on('error', reject);
    });
    assert.match(frames, /event: state\ndata: \{"agents":\[\],"n":1\}/);
    assert.match(frames, /event: state\ndata: \{"agents":\[\],"n":2\}/);

    const act = JSON.stringify({ type: 'clearFinished' });
    assert.equal((await request(port, 'POST', '/office/action', { 'Content-Type': 'application/json' }, act)).status, 401);
    assert.equal((await request(port, 'POST', '/office/action', Object.assign({ 'Content-Type': 'application/json' }, jar), act)).status, 403);
    assert.equal((await request(port, 'POST', '/office/action', Object.assign({ 'Content-Type': 'application/json', 'X-Agent-Office': '1' }, jar), act)).status, 204);
    assert.deepEqual(actions, [{ type: 'clearFinished' }]);
  } finally {
    web.dispose();
    server.dispose();
  }
});

test('script de hook: repassa a todas as janelas, limpa endpoint órfão e sai com 0', async () => {
  const home = tmp('ao-home-');
  fs.mkdirSync(path.join(home, 'endpoints'), { recursive: true });
  const got = [];
  const server = await startEventServer(46700 + Math.floor(Math.random() * 500), 'tok2', (payload, source) => got.push({ payload, source }));
  fs.writeFileSync(path.join(home, 'endpoints', '1.json'), JSON.stringify({ port: server.port, token: 'tok2', pid: process.pid }));
  // janela que morreu sem limpar: porta fechada + pid inexistente
  fs.writeFileSync(path.join(home, 'endpoints', '2.json'), JSON.stringify({ port: 1, token: 'x', pid: 999999 }));
  const script = path.join(__dirname, '..', 'bin', 'agent-office-hook.js');
  const input = JSON.stringify({ hook_event_name: 'BeforeTool', session_id: 'g1', tool_name: 'read_file' });
  const child = require('child_process').spawn(process.execPath, [script, 'gemini'], { env: Object.assign({}, process.env, { AGENT_OFFICE_HOME: home }) });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(input);
  const code = await new Promise((r) => child.on('exit', r));
  server.dispose();
  assert.equal(code, 0);
  assert.equal(out, '{}', 'Gemini exige JSON no stdout');
  assert.deepEqual(got, [{ payload: JSON.parse(input), source: 'gemini' }]);
  assert.ok(!fs.existsSync(path.join(home, 'endpoints', '2.json')), 'endpoint órfão removido');
  // sem nenhuma janela: ainda sai com 0, sem imprimir nada (Claude)
  const r = spawnSync(process.execPath, [script, 'claude'], { input, env: Object.assign({}, process.env, { AGENT_OFFICE_HOME: path.join(home, 'nada') }) });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('projeto: worktrees contam como o repositório de origem', () => {
  const { projectOf, projectRootOf, seenCwds } = require('../out/watchers/tailer');
  const dir = tmp('ao-proj-');
  const repo = path.join(dir, 'sorya-guardian');
  const wt = path.join(dir, 'wt-gemini');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt-gemini'), { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + path.join(repo, '.git', 'worktrees', 'wt-gemini') + '\n');
  assert.equal(projectOf(repo), 'sorya-guardian');
  assert.equal(projectOf(wt), 'sorya-guardian');
  assert.equal(projectOf('E:\\dev\\sorya-nexo\\.claude\\worktrees\\agent-a4a9ad94a46d73aca'), 'sorya-nexo');
  assert.equal(projectOf('/home/u/sorya-nexo/.claude/worktrees/agent-1/packages/api'), 'sorya-nexo');
  assert.equal(projectOf('E:\\dev\\sorya-control\\'), 'sorya-control');
  assert.equal(projectOf(''), undefined);
  // pastas vistas viram lugares onde procurar fichas (.claude/agents do projeto)
  assert.ok(seenCwds().includes(wt));
  assert.equal(projectRootOf('E:\\dev\\sorya-nexo\\.claude\\worktrees\\agent-a4a9'), 'E:\\dev\\sorya-nexo');
  assert.equal(projectRootOf('/home/u/sorya-dmi'), '/home/u/sorya-dmi');
  fs.rmSync(dir, { recursive: true, force: true });
});
