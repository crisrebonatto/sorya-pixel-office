// Gera uma "home" falsa com registros de todas as fontes, roda os watchers
// reais + StateStore e grava o snapshot em dev/snapshot.json — para ver o
// escritório com o pipeline de verdade (não o demo). Uso:
//   npm run compile && node dev/fixture-office.js [pastaDeFichasDeAgentes]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const out = path.join(__dirname, '..', 'out');
const { StateStore } = require(out + '/core/stateStore');
const { EventRouter } = require(out + '/core/eventRouter');
const { NameDirectory } = require(out + '/core/names');
const { ClaudeWatcher } = require(out + '/watchers/claude');
const { CodexWatcher } = require(out + '/watchers/codex');
const { GeminiWatcher } = require(out + '/watchers/gemini');
const { AntigravityWatcher } = require(out + '/watchers/antigravity');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fixture-'));
const now = Date.now();
const iso = (s) => new Date(now - s * 1000).toISOString();
const w = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
};
const agentsDir = process.argv[2];

// ── Claude: Sora (sessão) + Rick e Ravi (subagentes) ─────────────────
const proj = path.join(home, '.claude', 'projects', '-home-me-sorya-dmi');
const base = { cwd: '/home/me/sorya-dmi', gitBranch: 'feat/pix', entrypoint: 'claude-vscode', sessionId: 'S1', version: '2.1.282' };
const asst = (id, s, blocks, stop) => ({ ...base, type: 'assistant', uuid: id, timestamp: iso(s), message: { id: 'm-' + id, model: 'claude-opus-5-5', stop_reason: stop || 'tool_use', usage: { input_tokens: 800, cache_read_input_tokens: 42000, output_tokens: 600 }, content: blocks } });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, s, tid, err) => ({ ...base, type: 'user', uuid: id, timestamp: iso(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: !!err, content: err ? 'exit 1' : 'ok' }] } });
w(path.join(proj, 'S1.jsonl'), [
  { ...base, type: 'user', uuid: 'u1', timestamp: iso(300), permissionMode: 'acceptEdits', message: { role: 'user', content: 'Pacote PIX: webhook de pagamento no DMI com idempotência' } },
  asst('a1', 290, [tool('t1', 'Read', { file_path: '/home/me/sorya-dmi/MEMORY.md' })]),
  result('r1', 288, 't1'),
  asst('a2', 280, [tool('t2', 'Agent', { description: 'T01 · rota /api/pix com idempotência', subagent_type: 'rick-construtor', prompt: '...' })]),
  asst('a3', 200, [tool('t3', 'Agent', { description: 'Revisão antecipada da T01', subagent_type: 'ravi-revisor', prompt: '...' })]),
  asst('a4', 20, [tool('t4', 'Bash', { command: 'git status --porcelain' })])
]);
const sub = (id, type, desc, lines) => {
  const d = path.join(proj, 'S1', 'subagents');
  w(path.join(d, 'agent-' + id + '.jsonl'), lines.map((l) => ({ ...l, isSidechain: true, agentId: id })));
  fs.writeFileSync(path.join(d, 'agent-' + id + '.meta.json'), JSON.stringify({ agentType: type, description: desc, toolUseId: 'x' }));
};
sub('rick1', 'rick-construtor', 'T01 · rota /api/pix com idempotência', [
  { ...base, type: 'user', uuid: 'ru', timestamp: iso(275), message: { content: 'faça a T01' } },
  asst('ra1', 260, [tool('rt1', 'Edit', { file_path: '/home/me/sorya-dmi/routes/pix.py', old_string: 'a', new_string: 'b' })]),
  result('rr1', 255, 'rt1'),
  asst('ra2', 12, [tool('rt2', 'Edit', { file_path: '/home/me/sorya-dmi/services/pix_service.py', old_string: 'a', new_string: 'b' })])
]);
sub('ravi1', 'ravi-revisor', 'Revisão antecipada da T01', [
  { ...base, type: 'user', uuid: 'vu', timestamp: iso(190), message: { content: 'revise' } },
  asst('va1', 30, [tool('vt1', 'Bash', { command: 'pytest -q tests/test_pix.py' })]),
  result('vr1', 25, 'vt1', true),
  asst('va2', 8, [tool('vt2', 'Read', { file_path: '/home/me/sorya-dmi/tests/test_pix.py' })])
]);

// ── Codex (extensão do VS Code) ──────────────────────────────────────
const d = new Date(now);
const day = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
w(path.join(day, 'rollout-2026-09-25T12-00-00-T1.jsonl'), [
  { timestamp: iso(240), type: 'session_meta', payload: { id: 'T1', cwd: '/home/me/sorya-nexo', originator: 'codex_vscode', cli_version: '0.157.0', git: { branch: 'main' } } },
  { timestamp: iso(239), type: 'turn_context', payload: { model: 'gpt-5-codex', approval_policy: 'on-request', cwd: '/home/me/sorya-nexo' } },
  { timestamp: iso(238), type: 'event_msg', payload: { type: 'user_message', message: 'Refatorar o cálculo do repricer para centavos inteiros' } },
  { timestamp: iso(200), type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'p1', arguments: JSON.stringify({ plan: [{ step: 'Mapear arredondamentos', status: 'completed' }, { step: 'Trocar float por int', status: 'in_progress' }, { step: 'Rodar testes', status: 'pending' }] }) } },
  { timestamp: iso(15), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c9', arguments: JSON.stringify({ cmd: 'pnpm test --filter repricer' }) } }
]);

// ── Gemini CLI ───────────────────────────────────────────────────────
const gdir = path.join(home, '.gemini', 'tmp', 'sorya-board');
fs.mkdirSync(gdir, { recursive: true });
fs.writeFileSync(path.join(gdir, '.project_root'), '/home/me/sorya-board');
w(path.join(gdir, 'chats', 'session-2026-09-25T12-00-G1abcdef.jsonl'), [
  { sessionId: 'G1abcdef-0000', projectHash: 'h', startTime: iso(120), lastUpdated: iso(5), kind: 'main' },
  { id: 'gu1', timestamp: iso(118), type: 'user', content: [{ text: 'Gerar o relatório de uso do Board' }] },
  { id: 'gm1', timestamp: iso(6), type: 'gemini', content: '', model: 'gemini-3-pro', tokens: { input: 9000, output: 300 }, toolCalls: [{ id: 'gc1', name: 'google_web_search', args: { query: 'x' }, status: 'success', timestamp: iso(6) }] }
]);

// ── Antigravity: task.md ─────────────────────────────────────────────
w(path.join(home, '.gemini', 'antigravity', 'brain', 'conv-guardian', 'task.md'), [
  '# Guardian: bloqueio por IP',
  '- [x] Ler as regras atuais <!-- id: 0 -->',
  '- [/] Implementar a regra de bloqueio <!-- id: 1 -->',
  '- [ ] Escrever o walkthrough <!-- id: 2 -->'
]);

(async () => {
  const names = new NameDirectory(() => (agentsDir ? [agentsDir] : []));
  names.load();
  const store = new StateStore({ desks: 12, idleTimeoutMs: 30 * 60000, resolveName: (a) => names.resolve(a) });
  const router = new EventRouter(store);
  const emit = (e) => router.route(e);
  const opts = { recentMs: 6 * 3600e3, home: () => home };
  const ws = [
    new ClaudeWatcher(emit, { recentMs: opts.recentMs, home: () => path.join(home, '.claude') }),
    new CodexWatcher(emit, { recentMs: opts.recentMs, home: () => path.join(home, '.codex') }),
    new GeminiWatcher(emit, { recentMs: opts.recentMs, home: () => path.join(home, '.gemini') }),
    new AntigravityWatcher(emit, opts)
  ];
  for (const x of ws) await x.scanOnce();
  const snap = store.snapshot();
  snap.sources = ['claude', 'codex', 'gemini', 'antigravity'].map((id) => ({ id, status: 'watching' }));
  snap.host = { appName: 'Antigravity', port: 4517, hooks: [] };
  snap.names = names.personas();
  fs.writeFileSync(path.join(__dirname, 'snapshot.json'), JSON.stringify(snap, null, 1));
  for (const a of snap.agents) console.log(a.displayName.padEnd(12), a.source.padEnd(12), String(a.deskIndex).padEnd(3), a.state.padEnd(10), a.currentAction || '');
  console.log(snap.tasks.length, 'tarefas;', snap.activity.length, 'eventos no feed');
  store.dispose();
  fs.rmSync(home, { recursive: true, force: true });
})();
