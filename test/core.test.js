// Store, nomes, redação e normalização de hooks.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StateStore } = require('../out/core/stateStore');
const { NameDirectory, profileFromText, nameFromSlug } = require('../out/core/names');
const { categorizeTool, summarizeCommand, redactAction, promptTitle } = require('../out/server/redact');
const { normalizeHook, detectSource, parseSource } = require('../out/adapters/hooks');

function makeStore(extra) {
  let clock = Date.parse('2026-09-25T12:00:00Z');
  const store = new StateStore(
    Object.assign({ desks: 12, idleTimeoutMs: 30 * 60000, resolveName: (a) => a.name || (a.kind === 'subagent' ? a.type : a.source), now: () => clock }, extra)
  );
  const at = () => clock;
  return { store, tick: (ms) => (clock += ms), at };
}

test('store: sessão entra, pedido vira card, ferramenta muda estado, turno fecha o card', () => {
  const { store, at } = makeStore();
  store.apply({ kind: 'prompt', source: 'claude', agentId: 'claude:s', project: 'dmi', taskTitle: 'Webhook PIX', at: at() });
  let s = store.snapshot();
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].deskIndex, 0);
  assert.equal(s.agents[0].state, 'thinking');
  assert.deepEqual(s.tasks.map((t) => [t.title, t.status, t.kind]), [['Webhook PIX', 'running', 'prompt']]);

  store.apply({ kind: 'tool-start', source: 'claude', agentId: 'claude:s', tool: 'Edit', state: 'writing', action: 'editando pix.py', file: 'pix.py', key: 't1', at: at() });
  store.apply({ kind: 'tool-start', source: 'claude', agentId: 'claude:s', tool: 'Edit', state: 'writing', action: 'editando pix.py', file: 'pix.py', key: 't1', at: at() });
  s = store.snapshot();
  assert.equal(s.agents[0].state, 'writing');
  assert.equal(s.agents[0].stats.edits, 1, 'mesmo tool_use (hook + transcript) conta uma vez');
  assert.deepEqual(s.agents[0].files, ['pix.py']);

  store.apply({ kind: 'tool-end', source: 'claude', agentId: 'claude:s', key: 't1', at: at() });
  assert.equal(store.snapshot().agents[0].state, 'thinking');
  store.apply({ kind: 'turn-end', source: 'claude', agentId: 'claude:s', at: at() });
  s = store.snapshot();
  assert.equal(s.agents[0].state, 'idle');
  assert.equal(s.tasks[0].status, 'done');
  store.dispose();
});

test('store: espera notifica uma vez; erro volta a pensar depois de um tempo', () => {
  const { store, tick, at } = makeStore();
  const waits = [];
  store.on('waiting', (a) => waits.push(a.id));
  store.apply({ kind: 'prompt', source: 'claude', agentId: 'claude:w', at: at() });
  store.apply({ kind: 'waiting', source: 'claude', agentId: 'claude:w', action: 'pedindo permissão · rodando git push', key: 'k', at: at() });
  store.apply({ kind: 'waiting', source: 'claude', agentId: 'claude:w', action: 'pedindo permissão · rodando git push', key: 'k', at: at() });
  assert.deepEqual(waits, ['claude:w']);
  assert.equal(store.snapshot().agents[0].state, 'waiting');
  // replay (histórico) não notifica
  store.apply({ kind: 'waiting', source: 'claude', agentId: 'claude:w', key: 'k2', at: at(), replay: true });
  assert.equal(waits.length, 1);

  store.apply({ kind: 'tool-error', source: 'claude', agentId: 'claude:w', action: 'rodando pytest', at: at() });
  assert.equal(store.snapshot().agents[0].state, 'error');
  assert.equal(store.snapshot().agents[0].stats.errors, 1);
  tick(6000);
  store.sweep();
  assert.equal(store.snapshot().agents[0].state, 'thinking');
  store.dispose();
});

test('store: subagente cria card, conclui, acena e libera a mesa', () => {
  const { store, tick, at } = makeStore();
  store.apply({ kind: 'prompt', source: 'claude', agentId: 'claude:p', at: at() });
  store.apply({ kind: 'agent-start', source: 'claude', agentId: 'claude:p:a1', parentId: 'claude:p', agentType: 'rick-construtor', taskTitle: 'T01 · rota', at: at() });
  let s = store.snapshot();
  const rick = s.agents.find((a) => a.id === 'claude:p:a1');
  assert.equal(rick.kind, 'subagent');
  assert.equal(rick.deskIndex, 1);
  assert.ok(s.tasks.some((t) => t.title === 'T01 · rota' && t.kind === 'subagent' && t.status === 'running'));
  store.apply({ kind: 'agent-stop', source: 'claude', agentId: 'claude:p:a1', at: at() });
  s = store.snapshot();
  assert.equal(s.agents.find((a) => a.id === 'claude:p:a1').state, 'done');
  assert.equal(s.tasks.find((t) => t.kind === 'subagent').status, 'done');
  tick(4000);
  store.sweep();
  s = store.snapshot();
  assert.ok(!s.agents.some((a) => a.id === 'claude:p:a1'));
  assert.equal(s.ghosts[0].deskIndex, 1, 'nome esmaecido fica na mesa por alguns segundos');
  store.dispose();
});

test('store: histórico antigo não ressuscita agente; sessão ociosa sai no timeout', () => {
  const { store, tick, at } = makeStore({ idleTimeoutMs: 10 * 60000 });
  store.apply({ kind: 'prompt', source: 'codex', agentId: 'codex:old', at: at() - 60 * 60000 });
  assert.equal(store.snapshot().agents.length, 0);
  store.apply({ kind: 'prompt', source: 'codex', agentId: 'codex:new', at: at() });
  store.apply({ kind: 'turn-end', source: 'codex', agentId: 'codex:new', at: at() });
  tick(11 * 60000);
  store.sweep();
  assert.equal(store.snapshot().agents.length, 0);
  store.dispose();
});

test('store: interrupção marca o card como falho; mensagens enfileiradas fecham junto', () => {
  const { store, at } = makeStore();
  store.apply({ kind: 'prompt', source: 'claude', agentId: 'claude:i', taskTitle: 'A', at: at() });
  store.apply({ kind: 'task-upsert', source: 'claude', agentId: 'claude:i', taskId: 'q:1', taskTitle: 'B', taskStatus: 'running', taskKind: 'prompt', at: at() });
  store.apply({ kind: 'turn-aborted', source: 'claude', agentId: 'claude:i', at: at() });
  assert.deepEqual(store.snapshot().tasks.map((t) => t.status), ['failed', 'failed']);
  store.dispose();
});

test('store: heurística de espera sem hooks só para ferramentas que pedem permissão', () => {
  const { store, tick, at } = makeStore();
  store.apply({ kind: 'tool-start', source: 'claude', agentId: 'claude:h', tool: 'WebFetch', state: 'searching', key: 'w1', needsApproval: true, at: at() });
  store.apply({ kind: 'tool-start', source: 'claude', agentId: 'claude:b', tool: 'Bash', state: 'running', key: 'b1', needsApproval: true, at: at() });
  tick(8000);
  store.sweep();
  const s = store.snapshot();
  assert.equal(s.agents.find((a) => a.id === 'claude:h').state, 'waiting');
  assert.equal(s.agents.find((a) => a.id === 'claude:b').state, 'running', 'comando longo não vira espera');
  // com hooks ativos a heurística desliga (o hook avisa de verdade)
  const other = makeStore();
  other.store.markHooks('claude');
  other.store.apply({ kind: 'tool-start', source: 'claude', agentId: 'claude:x', tool: 'Edit', state: 'writing', key: 'e', needsApproval: true, at: other.at() });
  other.tick(9000);
  other.store.sweep();
  assert.equal(other.store.snapshot().agents[0].state, 'writing');
  store.dispose();
  other.store.dispose();
});

test('store: nomes repetidos ganham o projeto; mesas acabam → lounge', () => {
  const { store, at } = makeStore({ desks: 4, resolveName: () => 'Sora' });
  for (const [i, p] of ['dmi', 'nexo', 'board', 'guardian', 'extra'].entries()) {
    store.apply({ kind: 'prompt', source: 'claude', agentId: 'claude:' + i, project: p, at: at() });
  }
  const s = store.snapshot();
  assert.ok(s.agents.some((a) => a.displayName === 'Sora · nexo'));
  assert.equal(s.agents.find((a) => a.project === 'extra').deskIndex, -1);
  store.dispose();
});

test('nomes: várias fichas citam a sessão principal, vence quem se declara principal', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-names-main-'));
  fs.writeFileSync(
    path.join(dir, 'sora.md'),
    '---\r\nname: sora-orquestradora\r\ndescription: Sora — sora-orquestradora (antes sorya-orquestrador). O orquestrador do ecossistema Sorya, a sessão principal que fala com o dono. Não é para ser chamado como subagente; é a ficha de quem coordena os outros 27.\r\n---\r\n# Sora\r\n'
  );
  fs.writeFileSync(path.join(dir, 'ravi.md'), '---\nname: ravi-revisor\ndescription: Ravi — ravi-revisor. Revisa cada entrega quando chamado pela sessão principal.\n---\n');
  fs.writeFileSync(path.join(dir, 'tome.md'), '---\nname: tome-qa\ndescription: Tomé — tome-qa. Reporta à sessão principal o resultado dos testes.\n---\n');
  fs.writeFileSync(path.join(dir, 'heitor.md'), '---\nname: heitor-orquestrador-de-testes\ndescription: Heitor — heitor-orquestrador-de-testes. O orquestrador de testes e2e.\n---\n');
  const names = new NameDirectory(() => [dir]);
  names.load();
  assert.equal(names.mainName(), 'Sora');
  assert.equal(names.resolve({ source: 'claude', kind: 'session', type: 'claude' }), 'Sora');
  assert.equal(names.resolve({ source: 'claude', kind: 'subagent', type: 'ravi-revisor' }), 'Ravi');
  // duas fichas empatadas como principal: ninguém vence, fica "Claude"
  fs.writeFileSync(path.join(dir, 'sora.md'), '---\nname: sora\ndescription: Sora — sora. A sessão principal.\n---\n');
  fs.writeFileSync(path.join(dir, 'lia.md'), '---\nname: lia\ndescription: Lia — lia. A sessão principal.\n---\n');
  names.load();
  assert.equal(names.mainName(), undefined);
  assert.equal(names.resolve({ source: 'claude', kind: 'session', type: 'claude' }), 'Claude');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nomes: persona da ficha, aliases antigos, CRLF, sessão principal e overrides', () => {
  const sora = profileFromText('---\r\nname: sora-orquestradora\r\ndescription: Sora — sora-orquestradora (antes sorya-orquestrador). O orquestrador do ecossistema, a sessão principal.\r\n---\r\n# x', 'a.md');
  assert.deepEqual([sora.slug, sora.persona, sora.aliases, sora.main], ['sora-orquestradora', 'Sora', ['sorya-orquestrador'], true]);
  const iris = profileFromText('---\nname: iris-gate6-llm\ndescription: "Íris — iris-gate6-llm (antes security-llm-guardian). Gate 6."\ntools: Read\n---', 'b.md');
  assert.equal(iris.persona, 'Íris');
  assert.equal(nameFromSlug('heitor-debug'), 'Heitor');
  assert.equal(nameFromSlug('code-reviewer'), 'Code Reviewer');
  assert.equal(nameFromSlug('general-purpose'), 'Assistente');

  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-names-'));
  fs.writeFileSync(path.join(dir, 'sora.md'), '---\nname: sora-orquestradora\ndescription: Sora — sora-orquestradora. A sessão principal que fala com o dono.\n---\n');
  fs.writeFileSync(path.join(dir, 'rick.md'), '---\nname: rick-construtor\ndescription: Rick — rick-construtor (antes sorya-fullstack-builder). Constrói.\n---\n');
  const names = new NameDirectory(() => [dir]);
  assert.equal(names.load(), 3);
  assert.equal(names.resolve({ source: 'claude', kind: 'subagent', type: 'rick-construtor' }), 'Rick');
  assert.equal(names.resolve({ source: 'claude', kind: 'subagent', type: 'sorya-fullstack-builder' }), 'Rick');
  assert.equal(names.resolve({ source: 'claude', kind: 'session', type: 'claude' }), 'Sora');
  assert.equal(names.resolve({ source: 'codex', kind: 'session', type: 'codex' }), 'Codex');
  assert.equal(names.resolve({ source: 'claude', kind: 'subagent', type: 'tome-qa' }), 'Tome');
  names.setOverrides({ codex: 'Atlas', 'tome-qa': 'Tomé' });
  assert.equal(names.resolve({ source: 'codex', kind: 'session', type: 'codex' }), 'Atlas');
  assert.equal(names.resolve({ source: 'claude', kind: 'subagent', type: 'tome-qa' }), 'Tomé');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redação: categorias de todas as ferramentas e nada de conteúdo sensível', () => {
  assert.equal(categorizeTool('Read'), 'reading');
  assert.equal(categorizeTool('apply_patch'), 'writing');
  assert.equal(categorizeTool('run_shell_command'), 'running');
  assert.equal(categorizeTool('search_file_content'), 'reading');
  assert.equal(categorizeTool('google_web_search'), 'searching');
  assert.equal(categorizeTool('write_to_file'), 'writing');
  assert.equal(categorizeTool('mcp__github__list_pull_requests'), 'reading');
  assert.equal(categorizeTool('AskUserQuestion'), 'waiting');

  assert.equal(summarizeCommand('cd /x && npm test -- --token=abc123'), 'npm test');
  assert.equal(summarizeCommand('API_KEY=segredo curl https://api.x.com -H "Authorization: Bearer y"'), 'curl');
  assert.equal(summarizeCommand(['bash', '-lc', 'git push origin main']), 'git push');
  assert.equal(summarizeCommand('/usr/bin/python3 /tmp/x.py'), 'python3');

  const out = [
    redactAction('Bash', { command: 'psql postgres://user:senha@db/prod -c "drop table x"' }),
    redactAction('WebFetch', { url: 'https://docs.stripe.com/api?key=sk_live_123', prompt: 'segredo' }),
    redactAction('Write', { file_path: 'C:\\Users\\me\\proj\\.env', content: 'SECRET=1' }),
    redactAction('Grep', { pattern: 'password=.*' }),
    redactAction('Agent', { description: 'Revisar a T01', prompt: 'conteúdo longo com segredo' })
  ];
  assert.deepEqual(out, ['rodando psql', 'consultando docs.stripe.com', 'escrevendo .env', 'buscando no código', 'delegando: Revisar a T01']);
  assert.ok(!out.join(' ').match(/senha|sk_live|SECRET|password|segredo/));
  assert.equal(promptTitle('<system-reminder>x</system-reminder>\nCorrija o bug do login\nmais detalhes'), 'Corrija o bug do login');
});

test('hooks: Claude Code (PreToolUse, PermissionRequest, Notification, subagente)', () => {
  let evs = normalizeHook('claude', { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/home/me/dmi', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't9' }, 1);
  assert.equal(evs[0].kind, 'tool-start');
  assert.equal(evs[0].agentId, 'claude:s');
  assert.equal(evs[0].action, 'rodando npm test');
  assert.equal(evs[0].key, 't9');
  assert.equal(evs[0].project, 'dmi');
  evs = normalizeHook('claude', { hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'git push' } }, 2);
  assert.equal(evs[0].kind, 'waiting');
  assert.equal(evs[0].action, 'pedindo permissão · rodando git push');
  evs = normalizeHook('claude', { hook_event_name: 'Notification', session_id: 's', notification_type: 'idle_prompt' }, 3);
  assert.equal(evs[0].kind, 'heartbeat');
  evs = normalizeHook('claude', { hook_event_name: 'Notification', session_id: 's', notification_type: 'permission_prompt' }, 3);
  assert.equal(evs[0].kind, 'waiting');
  evs = normalizeHook('claude', { hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a1', agent_type: 'ravi-revisor' }, 4);
  assert.deepEqual([evs[0].kind, evs[0].agentId, evs[0].parentId, evs[0].agentType], ['agent-start', 'claude:s:a1', 'claude:s', 'ravi-revisor']);
  evs = normalizeHook(undefined, { hook_event_name: 'UserPromptSubmit', session_id: 's', transcript_path: '/home/me/.claude/projects/x/s.jsonl', prompt: 'faça X' }, 5);
  assert.deepEqual([evs[0].source, evs[0].kind, evs[0].taskTitle], ['claude', 'prompt', 'faça X']);
});

test('hooks: Gemini, Cursor, Antigravity, Windsurf, Copilot e genérico', () => {
  let evs = normalizeHook('gemini', { hook_event_name: 'BeforeTool', session_id: 'g', tool_name: 'replace', tool_input: { file_path: '/p/a.ts' } }, 1);
  assert.deepEqual([evs[0].agentId, evs[0].kind, evs[0].action], ['gemini:g', 'tool-start', 'editando a.ts']);
  evs = normalizeHook('gemini', { hook_event_name: 'Notification', session_id: 'g', notification_type: 'ToolPermission' }, 1);
  assert.equal(evs[0].kind, 'waiting');
  evs = normalizeHook(undefined, { hook_event_name: 'beforeShellExecution', conversation_id: 'c', generation_id: 'gen', command: 'pnpm build', cursor_version: '3.9', workspace_roots: ['/w/app'] }, 1);
  assert.deepEqual([evs[0].source, evs[0].agentId, evs[0].action, evs[0].project], ['cursor', 'cursor:c', 'rodando pnpm build', 'app']);
  evs = normalizeHook('cursor', { hook_event_name: 'stop', conversation_id: 'c', status: 'aborted' }, 2);
  assert.equal(evs[0].kind, 'turn-aborted');
  evs = normalizeHook('antigravity', { hookEventName: 'PreToolUse', conversationId: 'ag', toolCall: { name: 'run_command', args: { CommandLine: 'npm run dev' } } }, 1);
  assert.deepEqual([evs[0].agentId, evs[0].action], ['antigravity:ag', 'rodando npm run']);
  evs = normalizeHook(undefined, { agent_action_name: 'pre_write_code', trajectory_id: 'tr', tool_info: { file_path: '/x/y.py' } }, 1);
  assert.deepEqual([evs[0].source, evs[0].kind, evs[0].file], ['windsurf', 'tool-start', 'y.py']);
  evs = normalizeHook('copilot', { hook_event_name: 'PreToolUse', session_id: 'v', tool_name: 'run_in_terminal', tool_input: { command: 'make test' } }, 1);
  assert.deepEqual([evs[0].agentId, evs[0].action], ['copilot:v', 'rodando make test']);
  evs = normalizeHook(undefined, { source: 'other', event: 'PreToolUse', session: 'x', tool: 'Edit', file: '/a/b.go' }, 1);
  assert.deepEqual([evs[0].agentId, evs[0].file], ['other:x', 'b.go']);
  assert.deepEqual(normalizeHook('claude', { hook_event_name: 'EventoDesconhecido' }), []);
  assert.equal(detectSource({ transcript_path: 'C:\\Users\\me\\.codex\\sessions\\x.jsonl' }), 'codex');
  assert.equal(parseSource('Claude-Code'), 'claude');
});
