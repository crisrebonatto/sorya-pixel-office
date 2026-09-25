// Parsers dos registros locais (Claude Code, Codex, Gemini CLI, Antigravity).
// Roda sobre o JS compilado: `npm test` compila antes.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeTranscriptParser, claudeIdsFromPath, claudeAgentId } = require('../out/watchers/claude');
const { CodexRolloutParser } = require('../out/watchers/codex');
const { GeminiChatParser } = require('../out/watchers/gemini');
const { parseChecklist } = require('../out/watchers/antigravity');

const T0 = Date.parse('2026-09-25T12:00:00Z');
const ts = (s) => new Date(T0 + s * 1000).toISOString();
const kinds = (evs) => evs.map((e) => e.kind);

test('claude: ids a partir do caminho (sessão, subagente, arquivos ignorados)', () => {
  assert.deepEqual(claudeIdsFromPath('-home-me-proj/abc.jsonl'), { sessionId: 'abc', agentId: 'claude:abc' });
  const sub = claudeIdsFromPath('-home-me-proj/abc/subagents/agent-a123.jsonl');
  assert.equal(sub.agentId, 'claude:abc:a123');
  assert.equal(sub.parentId, 'claude:abc');
  assert.equal(claudeIdsFromPath('-home-me-proj/abc.jsonl.superseded-1'), undefined);
  assert.equal(claudeIdsFromPath('-home-me-proj/abc.orphaned-1-x.jsonl'), undefined);
  assert.equal(claudeAgentId('s', 'x'), 'claude:s:x');
});

test('claude: prompt → ferramenta → resultado → fim de turno', () => {
  const p = new ClaudeTranscriptParser({ sessionId: 's1', agentId: 'claude:s1' });
  const base = { cwd: '/home/me/sorya-dmi', gitBranch: 'feat/pix', entrypoint: 'claude-vscode', sessionId: 's1' };
  let evs = p.parse({ ...base, type: 'user', uuid: 'u1', timestamp: ts(0), permissionMode: 'default', message: { role: 'user', content: 'Implementar o webhook do PIX\ncom idempotência' } }, false);
  assert.deepEqual(kinds(evs), ['session-start', 'prompt']);
  assert.equal(evs[1].taskTitle, 'Implementar o webhook do PIX');
  assert.equal(evs[1].project, 'sorya-dmi');
  assert.equal(evs[1].host, 'claude-vscode');

  evs = p.parse({ ...base, type: 'assistant', uuid: 'a1', timestamp: ts(2), message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/home/me/sorya-dmi/routes/pix.py', old_string: 'SEGREDO', new_string: 'x' } }] } }, false);
  const start = evs.find((e) => e.kind === 'tool-start');
  assert.equal(start.state, 'writing');
  assert.equal(start.action, 'editando pix.py');
  assert.equal(start.file, 'pix.py');
  assert.equal(start.needsApproval, true);
  assert.ok(!JSON.stringify(evs).includes('SEGREDO'), 'conteúdo da edição nunca sai do parser');
  const usage = evs.find((e) => e.kind === 'usage');
  assert.deepEqual([usage.tokensIn, usage.tokensOut], [100, 5]);

  // mesma mensagem, outro bloco: não soma tokens de novo
  evs = p.parse({ ...base, type: 'assistant', uuid: 'a2', timestamp: ts(3), message: { id: 'm1', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } }, false);
  assert.ok(!evs.some((e) => e.kind === 'usage'));

  evs = p.parse({ ...base, type: 'user', uuid: 'u2', timestamp: ts(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }, false);
  assert.deepEqual(kinds(evs), ['tool-end']);
  assert.equal(evs[0].key, 't1');

  evs = p.parse({ ...base, type: 'assistant', uuid: 'a3', timestamp: ts(6), message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Pronto.' }] } }, false);
  assert.ok(evs.some((e) => e.kind === 'turn-end'));
  // linha repetida (mesmo uuid, ex.: compactação) é ignorada
  assert.deepEqual(p.parse({ ...base, type: 'assistant', uuid: 'a3', timestamp: ts(6), message: { id: 'm2', stop_reason: 'end_turn', content: [] } }, false), []);
});

test('claude: erro, rejeição, interrupção e texto injetado', () => {
  const p = new ClaudeTranscriptParser({ sessionId: 's2', agentId: 'claude:s2' });
  p.parse({ type: 'user', uuid: 'x0', timestamp: ts(0), message: { content: 'rode os testes' } }, false);
  let evs = p.parse({ type: 'user', uuid: 'x1', timestamp: ts(1), message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'exit 1' }] } }, false);
  assert.deepEqual(kinds(evs), ['tool-error']);
  evs = p.parse({ type: 'user', uuid: 'x2', timestamp: ts(2), message: { content: [{ type: 'tool_result', tool_use_id: 'b2', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } }, false);
  assert.deepEqual(kinds(evs), ['tool-end']);
  evs = p.parse({ type: 'user', uuid: 'x3', timestamp: ts(3), message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }, false);
  assert.deepEqual(kinds(evs), ['turn-aborted']);
  evs = p.parse({ type: 'user', uuid: 'x4', timestamp: ts(4), message: { content: '<command-name>/clear</command-name>' } }, false);
  assert.deepEqual(evs, []);
  evs = p.parse({ type: 'user', uuid: 'x5', timestamp: ts(5), isMeta: true, message: { content: 'meta' } }, false);
  assert.deepEqual(evs, []);
});

test('claude: subagente, aviso de conclusão e mensagens enfileiradas', () => {
  const sub = new ClaudeTranscriptParser({ sessionId: 's3', agentId: 'claude:s3:a9', parentId: 'claude:s3', subagentId: 'a9', agentType: 'rick-construtor', description: 'T01 · rota /api/pix' });
  let evs = sub.parse({ type: 'user', uuid: 'q1', timestamp: ts(0), isSidechain: true, agentId: 'a9', message: { content: 'faça a rota' } }, false);
  assert.equal(evs[0].kind, 'agent-start');
  assert.equal(evs[0].agentType, 'rick-construtor');
  assert.equal(evs[0].taskTitle, 'T01 · rota /api/pix');
  assert.ok(evs.every((e) => e.agentTitle === 'T01 · rota /api/pix' && e.parentId === 'claude:s3'));

  const main = new ClaudeTranscriptParser({ sessionId: 's3', agentId: 'claude:s3' });
  main.parse({ type: 'user', uuid: 'm0', timestamp: ts(0), message: { content: 'pedido' } }, false);
  evs = main.parse({ type: 'attachment', uuid: 'm1', timestamp: ts(9), attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>a9</task-id>\n<status>completed</status>\n</task-notification>' } }, false);
  assert.equal(evs[0].kind, 'agent-stop');
  assert.equal(evs[0].agentId, 'claude:s3:a9');
  assert.equal(evs[0].taskStatus, 'done');

  evs = main.parse({ type: 'attachment', uuid: 'm2', timestamp: ts(10), attachment: { type: 'queued_command', prompt: 'coloca o nome em cima da cabeça' } }, false);
  assert.equal(evs[0].kind, 'task-upsert');
  assert.equal(evs[0].taskKind, 'prompt');
  assert.equal(evs[0].taskStatus, 'running');
  evs = main.parse({ type: 'attachment', uuid: 'm3', timestamp: ts(11), attachment: { type: 'queued_command', prompt: '<agent-message from="x">relatório</agent-message>' } }, false);
  assert.deepEqual(evs, []);
});

test('claude: last-prompt vira o card quando a leitura começou no meio', () => {
  const p = new ClaudeTranscriptParser({ sessionId: 's4', agentId: 'claude:s4' });
  p.parse({ type: 'assistant', uuid: 'z1', timestamp: ts(5), message: { id: 'mm', content: [{ type: 'text', text: '...' }] } }, true);
  const evs = p.parse({ type: 'last-prompt', lastPrompt: 'melhore o pixel office', sessionId: 's4' }, true);
  assert.equal(evs[0].kind, 'prompt');
  assert.equal(evs[0].taskTitle, 'melhore o pixel office');
  assert.equal(evs[0].at, T0 + 5000, 'herda o horário da última linha com timestamp');
  assert.deepEqual(p.parse({ type: 'last-prompt', lastPrompt: 'melhore o pixel office' }, true), []);
});

test('claude: TodoWrite, TaskCreate e TaskUpdate viram tarefas', () => {
  const p = new ClaudeTranscriptParser({ sessionId: 's5', agentId: 'claude:s5' });
  p.parse({ type: 'user', uuid: 'k0', timestamp: ts(0), message: { content: 'plano' } }, false);
  let evs = p.parse({ type: 'assistant', uuid: 'k1', timestamp: ts(1), message: { id: 'n1', content: [{ type: 'tool_use', id: 'tw', name: 'TodoWrite', input: { todos: [{ content: 'Escrever testes', status: 'completed' }, { content: 'Corrigir bug', status: 'in_progress' }, { content: 'Rodar CI', status: 'pending' }] } }] } }, false);
  const todos = evs.filter((e) => e.kind === 'task-upsert');
  assert.deepEqual(todos.map((t) => t.taskStatus), ['done', 'running', 'pending']);

  p.parse({ type: 'assistant', uuid: 'k2', timestamp: ts(2), message: { id: 'n2', content: [{ type: 'tool_use', id: 'tc', name: 'TaskCreate', input: { subject: 'Migrar banco', description: 'x' } }] } }, false);
  evs = p.parse({ type: 'user', uuid: 'k3', timestamp: ts(3), toolUseResult: { task: { id: '7', subject: 'Migrar banco' } }, message: { content: [{ type: 'tool_result', tool_use_id: 'tc', content: 'Task #7 created successfully: Migrar banco' }] } }, false);
  const created = evs.find((e) => e.kind === 'task-upsert');
  assert.deepEqual([created.taskId, created.taskTitle, created.taskStatus], ['7', 'Migrar banco', 'pending']);

  evs = p.parse({ type: 'assistant', uuid: 'k4', timestamp: ts(4), message: { id: 'n3', content: [{ type: 'tool_use', id: 'tu', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }] } }, false);
  assert.equal(evs.find((e) => e.kind === 'task-upsert').taskStatus, 'done');
  evs = p.parse({ type: 'assistant', uuid: 'k5', timestamp: ts(5), message: { id: 'n4', content: [{ type: 'tool_use', id: 'td', name: 'TaskUpdate', input: { taskId: '7', status: 'deleted' } }] } }, false);
  assert.ok(evs.some((e) => e.kind === 'task-remove' && e.taskId === '7'));
});

test('codex: rollout com comando, patch, plano, tokens e fim de turno', () => {
  const p = new CodexRolloutParser();
  let evs = p.parse({ timestamp: ts(0), type: 'session_meta', payload: { id: 'th1', cwd: '/home/me/sorya-nexo', originator: 'codex_vscode', git: { branch: 'main' } } }, false);
  assert.equal(evs[0].kind, 'session-start');
  assert.equal(evs[0].agentId, 'codex:th1');
  assert.equal(evs[0].host, 'codex_vscode');
  p.parse({ timestamp: ts(1), type: 'turn_context', payload: { model: 'gpt-5-codex', approval_policy: 'on-request', cwd: '/home/me/sorya-nexo' } }, false);
  evs = p.parse({ timestamp: ts(2), type: 'event_msg', payload: { type: 'user_message', message: 'refatore o repricer' } }, false);
  assert.equal(evs[0].kind, 'prompt');
  assert.equal(evs[0].model, 'gpt-5-codex');

  evs = p.parse({ timestamp: ts(3), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cd app && pnpm test --filter x', workdir: '/w' }), call_id: 'c1' } }, false);
  assert.equal(evs[0].state, 'running');
  assert.equal(evs[0].action, 'rodando pnpm test');
  evs = p.parse({ timestamp: ts(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Process exited with code 1\nOutput:\nfail' } }, false);
  assert.equal(evs[0].kind, 'tool-error');

  evs = p.parse({ timestamp: ts(5), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/repricer.ts\n@@\n-a\n+b\n*** Add File: src/util.ts\n*** End Patch\n' } }, false);
  assert.equal(evs[0].action, 'editando repricer.ts +1');
  assert.equal(evs[0].file, 'repricer.ts');

  evs = p.parse({ timestamp: ts(6), type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c3', arguments: JSON.stringify({ plan: [{ step: 'Ler código', status: 'completed' }, { step: 'Refatorar', status: 'in_progress' }] }) } }, false);
  assert.deepEqual(evs.filter((e) => e.kind === 'task-upsert').map((e) => e.taskStatus), ['done', 'running']);

  evs = p.parse({ timestamp: ts(7), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, output_tokens: 50 } } } }, false);
  assert.deepEqual([evs[0].tokensIn, evs[0].tokensOut], [1000, 50]);
  evs = p.parse({ timestamp: ts(8), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, output_tokens: 80 } } } }, false);
  assert.deepEqual([evs[0].tokensIn, evs[0].tokensOut], [500, 30]);

  evs = p.parse({ timestamp: ts(9), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'tt' } }, false);
  assert.equal(evs[0].kind, 'turn-end');
});

test('codex: subagente e threads ignoradas (delegadas)', () => {
  const p = new CodexRolloutParser();
  const evs = p.parse({ timestamp: ts(0), type: 'session_meta', payload: { id: 'child', cwd: '/w', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } }, agent_nickname: 'Atlas', agent_role: 'reviewer' } }, false);
  assert.equal(evs[0].kind, 'agent-start');
  assert.equal(evs[0].parentId, 'codex:root');
  assert.equal(evs[0].name, 'Atlas');
  assert.equal(evs[0].agentType, 'reviewer');
  const ignored = new CodexRolloutParser((id) => id === 'mine');
  assert.deepEqual(ignored.parse({ timestamp: ts(0), type: 'session_meta', payload: { id: 'mine', cwd: '/w' } }, false), []);
  assert.deepEqual(ignored.parse({ timestamp: ts(1), type: 'event_msg', payload: { type: 'user_message', message: 'x' } }, false), []);
});

test('gemini: jsonl com upsert por id, ferramentas concluídas e fim de turno', () => {
  const p = new GeminiChatParser('sorya-board', undefined);
  let evs = p.parseRecord({ sessionId: 'g1', projectHash: 'h', startTime: ts(0), kind: 'main' }, false);
  assert.equal(evs[0].kind, 'session-start');
  assert.equal(evs[0].agentId, 'gemini:g1');
  evs = p.parseRecord({ id: 'u1', timestamp: ts(1), type: 'user', content: [{ text: 'gere o relatório' }] }, false);
  assert.equal(evs[0].taskTitle, 'gere o relatório');
  const msg = { id: 'r1', timestamp: ts(2), type: 'gemini', content: '', model: 'gemini-3-pro', tokens: { input: 100, output: 10 }, toolCalls: [{ id: 'k1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', timestamp: ts(2) }] };
  evs = p.parseRecord(msg, false);
  assert.ok(evs.some((e) => e.kind === 'tool-start' && e.action === 'rodando npm test'));
  // reanexada com mais tokens e a mesma chamada: não duplica a ferramenta
  evs = p.parseRecord({ ...msg, tokens: { input: 150, output: 20 } }, false);
  assert.ok(!evs.some((e) => e.kind === 'tool-start'));
  assert.deepEqual(evs.filter((e) => e.kind === 'usage').map((e) => [e.tokensIn, e.tokensOut]), [[50, 10]]);
  evs = p.parseRecord({ id: 'r2', timestamp: ts(3), type: 'gemini', content: 'Pronto!' }, false);
  assert.ok(evs.some((e) => e.kind === 'turn-end'));
  // functionResponse sintético (type user sem texto) não é pedido
  assert.deepEqual(p.parseRecord({ id: 'u2', timestamp: ts(4), type: 'user', content: [{ functionResponse: { id: 'k1' } }] }, false), []);
  assert.deepEqual(p.parseRecord({ $set: { lastUpdated: ts(5) } }, false), []);
});

test('antigravity: checklist do task.md', () => {
  const md = [
    '# Tarefas',
    '- [x] Analisar arquivos <!-- id: 0 -->',
    '    - [x] Ver `home.html` <!-- id: 1 -->',
    '- [/] Implementar recursos compartilhados <!-- id: 7 -->',
    '- [ ] Verificar implementação <!-- id: 6 -->'
  ].join('\r\n');
  const items = parseChecklist(md);
  assert.deepEqual(items.map((i) => [i.id, i.status]), [['0', 'done'], ['7', 'running'], ['6', 'pending']]);
  assert.equal(items[0].title, 'Analisar arquivos');
  assert.equal(parseChecklist('- [ ] só filho\n').length, 1);
});
