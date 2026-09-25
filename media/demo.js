// Modo demonstração: simula um time trabalhando (no mesmo formato do
// snapshot da extensão) para ver o escritório vivo sem nenhum agente real.
// Os nomes seguem o time Sorya: Sora orquestra, Rick constrói, Ravi revisa…
(function () {
  'use strict';
  const AO = (window.AO = window.AO || {});

  const TEAM = [
    { id: 'demo-sora', name: 'Sora', role: 'sora-orquestradora', source: 'claude', kind: 'session', project: 'sorya-dmi', branch: 'feat/pix', host: 'claude-vscode', model: 'claude-opus-5-5', desk: 0, enter: 0 },
    { id: 'demo-rick', name: 'Rick', role: 'rick-construtor', source: 'claude', kind: 'subagent', parent: 'demo-sora', project: 'sorya-dmi', host: 'claude-vscode', model: 'claude-sonnet-5', desk: 1, enter: 2500 },
    { id: 'demo-codex', name: 'Codex', role: 'codex', source: 'codex', kind: 'session', project: 'sorya-nexo', host: 'codex_vscode', model: 'gpt-5-codex', desk: 2, enter: 4000 },
    { id: 'demo-ravi', name: 'Ravi', role: 'ravi-revisor', source: 'claude', kind: 'subagent', parent: 'demo-sora', project: 'sorya-dmi', host: 'claude-vscode', model: 'claude-opus-5-5', desk: 3, enter: 9000 },
    { id: 'demo-gemini', name: 'Gemini', role: 'gemini-cli', source: 'gemini', kind: 'session', project: 'sorya-board', host: 'terminal', model: 'gemini-3-pro', desk: 4, enter: 6000 },
    { id: 'demo-heitor', name: 'Heitor', role: 'heitor-debug', source: 'claude', kind: 'subagent', parent: 'demo-sora', project: 'sorya-dmi', host: 'claude-vscode', model: 'claude-opus-5-5', desk: 5, enter: 12000 },
    { id: 'demo-ag', name: 'Antigravity', role: 'agent manager', source: 'antigravity', kind: 'session', project: 'sorya-guardian', host: 'antigravity', model: 'gemini-3-pro', desk: 6, enter: 7500 },
    { id: 'demo-tome', name: 'Tomé', role: 'tome-qa', source: 'claude', kind: 'subagent', parent: 'demo-sora', project: 'sorya-dmi', host: 'claude-vscode', model: 'claude-sonnet-5', desk: 7, enter: 15000 },
    { id: 'demo-iris', name: 'Íris', role: 'iris-gate6-llm', source: 'claude', kind: 'subagent', parent: 'demo-sora', project: 'sorya-dmi', host: 'claude-vscode', model: 'claude-opus-5-5', desk: 8, enter: 18000 }
  ];

  // Roteiros: [estado, ação, duração ms]. Repetem em loop.
  const SCRIPTS = {
    'demo-sora': [
      ['thinking', 'planejando o pacote PIX', 5000],
      ['reading', 'lendo MEMORY.md', 3500],
      ['reading', 'lendo docs/plans/pix.md', 3000],
      ['thinking', 'delegando T01 ao Rick', 4000],
      ['idle', null, 22000],
      ['reading', 'conferindo o commit do Rick', 4000],
      ['thinking', 'chamando o Ravi para revisar', 4000],
      ['idle', null, 26000]
    ],
    'demo-rick': [
      ['reading', 'lendo routes/pix.py', 3500],
      ['writing', 'editando routes/pix.py', 6000],
      ['writing', 'editando services/pix.py', 5000],
      ['running', 'rodando pytest', 5000],
      ['waiting', 'pedindo permissão · git push', 9000],
      ['running', 'rodando git', 2500],
      ['thinking', 'resumindo a entrega', 3000],
      ['writing', 'editando tests/test_pix.py', 5000]
    ],
    'demo-codex': [
      ['thinking', 'analisando o repricer', 4000],
      ['reading', 'lendo repricer.ts', 3500],
      ['writing', 'aplicando patch · repricer.ts', 6000],
      ['running', 'rodando pnpm test', 6000],
      ['thinking', 'revisando o diff', 3000],
      ['idle', null, 18000]
    ],
    'demo-ravi': [
      ['reading', 'lendo o diff da T01', 5000],
      ['reading', 'lendo services/pix.py', 4000],
      ['running', 'rodando mutmut', 6000],
      ['thinking', 'escrevendo o parecer', 4000],
      ['done', 'revisão aprovada', 4000]
    ],
    'demo-gemini': [
      ['searching', 'pesquisando docs.stripe.com', 4500],
      ['reading', 'lendo board/api.ts', 3500],
      ['writing', 'editando board/report.ts', 5000],
      ['idle', null, 15000]
    ],
    'demo-heitor': [
      ['reading', 'lendo o traceback', 4000],
      ['running', 'rodando pytest -k auth', 5000],
      ['error', 'teste falhou · auth', 5000],
      ['thinking', 'isolando a causa raiz', 5000],
      ['writing', 'editando auth/token.py', 5000],
      ['running', 'rodando pytest -k auth', 4000],
      ['done', 'causa raiz corrigida', 4000]
    ],
    'demo-ag': [
      ['thinking', 'escrevendo implementation_plan.md', 5000],
      ['writing', 'editando guardian/rules.ts', 6000],
      ['searching', 'navegando localhost:3000', 5000],
      ['idle', null, 14000]
    ],
    'demo-tome': [
      ['running', 'subindo o app', 4000],
      ['searching', 'abrindo localhost:8000', 4000],
      ['reading', 'conferindo o checkout', 4000],
      ['done', 'provado na tela', 4000]
    ],
    'demo-iris': [
      ['reading', 'lendo prompts/atendimento.md', 4000],
      ['thinking', 'Gate 6 · OWASP LLM', 5000],
      ['waiting', 'pedindo permissão · Bash', 7000],
      ['running', 'rodando semgrep', 4000],
      ['done', 'Gate 6 · PASS', 4000]
    ]
  };

  const TASKS = {
    'demo-sora': 'Pacote PIX: webhook de pagamento no DMI',
    'demo-rick': 'T01 · rota /api/pix com idempotência',
    'demo-codex': 'Refatorar o cálculo do repricer',
    'demo-ravi': 'Revisão antecipada da T01',
    'demo-gemini': 'Relatório de uso do Board',
    'demo-heitor': 'Teste falhando em auth/token',
    'demo-ag': 'Guardian: regra de bloqueio por IP',
    'demo-tome': 'Provar o checkout na tela',
    'demo-iris': 'Gate 6 · revisão de IA/LLM'
  };

  const BACKLOG = [
    ['demo-sora', 'T02 · reconciliação diária do PIX'],
    ['demo-sora', 'T03 · painel de estornos'],
    ['demo-codex', 'Migrar repricer para jobs Inngest'],
    ['demo-ag', 'Walkthrough do Guardian']
  ];

  // Terminal ao vivo da demo: conteúdo fictício, já como sai do mascaramento.
  const DEMO_CMDS = {
    pytest: { cmd: 'pytest -q tests/test_pix.py', out: ['............                                         [100%]', '12 passed in 1.84s'] },
    git: { cmd: 'git push origin feat/pix', out: ['To github.com:sorya/dmi.git', '   4f2a9c1..8b7d3e0  feat/pix -> feat/pix'] },
    'pnpm test': { cmd: 'pnpm test --filter repricer', out: [' ✓ src/repricer.test.ts (18 tests) 412ms', '', ' Test Files  1 passed (1)', '      Tests  18 passed (18)', '   Duration  1.31s'] },
    mutmut: { cmd: 'mutmut run --paths-to-mutate services/pix.py', out: ['42/42  🎉 39  ⏰ 0  🤔 0  🙁 3', 'Mutation score: 92.9%'] },
    'pytest -k auth': {
      cmd: 'pytest -q -k auth',
      out: ['......                                               [100%]', '6 passed, 31 deselected in 0.88s'],
      fail: ['F.....                                               [100%]', 'FAILED tests/test_token.py::test_refresh_expirado', 'E   AssertionError: esperado 401, veio 200', '1 failed, 5 passed, 31 deselected in 0.92s']
    },
    semgrep: { cmd: 'semgrep --config p/owasp-top-ten prompts/', out: ['Ran 214 rules on 12 files: 0 findings.'] },
    'o app': { cmd: 'uvicorn app.main:app --port 8000', out: ['INFO:     Started server process [4121]', 'INFO:     Uvicorn running on http://127.0.0.1:8000'] }
  };
  const DEMO_DIFFS = {
    'routes/pix.py': [
      '@@ -12,7 +12,11 @@',
      ' @router.post("/api/pix")',
      '-async def criar_pix(body: PixIn):',
      '+async def criar_pix(body: PixIn, idem: str = Header(alias="Idempotency-Key")):',
      '+    if await repo.ja_processado(idem):',
      '+        return await repo.resposta(idem)',
      '     cobranca = await pix.criar(body)',
      '+    await repo.guardar(idem, cobranca)',
      '     return cobranca'
    ],
    'services/pix.py': [
      '@@ -1,6 +1,9 @@',
      ' import hmac',
      '+import hashlib',
      ' ',
      '-WEBHOOK_SECRET = ""',
      '+WEBHOOK_SECRET = "‹oculto›"',
      '+',
      '+def assinatura_valida(corpo: bytes, assinatura: str) -> bool:',
      '+    esperado = hmac.new(WEBHOOK_SECRET.encode(), corpo, hashlib.sha256).hexdigest()',
      '+    return hmac.compare_digest(esperado, assinatura)'
    ],
    'tests/test_pix.py': [
      '@@ -40,3 +40,9 @@',
      '+def test_idempotencia(client):',
      '+    r1 = client.post("/api/pix", json=PIX, headers={"Idempotency-Key": "abc"})',
      '+    r2 = client.post("/api/pix", json=PIX, headers={"Idempotency-Key": "abc"})',
      '+    assert r1.json() == r2.json()',
      '+    assert repo.total() == 1'
    ],
    'repricer.ts': [
      '@@ -18,5 +18,5 @@',
      ' export function preco(custo: number, margem: number) {',
      '-  return Math.round(custo * (1 + margem) * 100) / 100;',
      '+  return centavos(custo) * (100 + margem * 100) / 100 / 100;',
      ' }'
    ],
    'auth/token.py': [
      '@@ -27,6 +27,8 @@',
      ' def refresh(token: Token) -> Token:',
      '+    if token.expira_em < agora():',
      '+        raise TokenExpirado()',
      '     return emitir(token.usuario)'
    ]
  };

  function demoTerm(a, state, action, seqRef) {
    const out = [];
    const now = Date.now();
    if (a._cmd) {
      const c = a._cmd;
      a._cmd = null;
      const failed = state === 'error';
      c.status = failed ? 'error' : 'ok';
      c.exitCode = failed ? 1 : 0;
      c.lines = failed && c._fail ? c._fail : c._ok;
      out.push(c);
    }
    if (state === 'running' && action) {
      const key = action.replace(/^(rodando|subindo) /, '');
      const d = DEMO_CMDS[key] || { cmd: key, out: ['ok'] };
      a._cmd = { id: 'demo-l' + seqRef.n++, at: now, agentId: a.id, kind: 'cmd', title: d.cmd, lines: [], status: 'running', masked: 0, omitted: 0, _ok: d.out, _fail: d.fail };
      out.push(a._cmd);
    } else if (state === 'writing' && action) {
      const file = action.split(' ').pop();
      const lines = DEMO_DIFFS[file] || ['@@ -1,3 +1,4 @@', ' // ' + file, '+// ajuste feito pelo agente', ' export {}'];
      out.push({
        id: 'demo-l' + seqRef.n++,
        at: now,
        agentId: a.id,
        kind: 'diff',
        title: file,
        lines,
        status: 'ok',
        masked: lines.join('\n').split('‹oculto›').length - 1,
        omitted: 0,
        adds: lines.filter((l) => l[0] === '+').length,
        dels: lines.filter((l) => l[0] === '-').length
      });
    }
    return out;
  }

  function start(emit, opts) {
    const names = (opts && opts.names) || {};
    const onLive = opts && opts.onLive;
    const termSeq = { n: 0 };
    const t0 = Date.now();
    const agents = new Map();
    const tasks = new Map();
    const activity = [];
    const spark = new Array(30).fill(0);
    let seq = 0;
    let bucket = 0;

    const log = (a, kind, text) => {
      activity.push({ id: 'demo-ev-' + seq++, at: Date.now(), agentId: a.id, agentName: a.displayName, source: a.source, kind, text });
      if (activity.length > 200) activity.shift();
      bucket++;
    };

    for (const [assignee, title] of BACKLOG) {
      const id = 'demo-backlog-' + seq++;
      const who = TEAM.find((m) => m.id === assignee);
      tasks.set(id, { id, title, status: 'pending', assignee, assigneeName: who.name, source: who.source, project: who.project, createdAt: t0, kind: 'todo' });
    }
    // histórico já feito
    const past = [
      ['demo-rick', 'Migration 0042 · tabela pix_eventos', 'done'],
      ['demo-codex', 'Corrigir arredondamento de centavos', 'done'],
      ['demo-heitor', 'Deploy do Board quebrou no build', 'failed']
    ];
    for (const [assignee, title, status] of past) {
      const id = 'demo-past-' + seq++;
      const who = TEAM.find((m) => m.id === assignee);
      tasks.set(id, { id, title, status, assignee, assigneeName: who.name, source: who.source, project: who.project, createdAt: t0 - 900000, startedAt: t0 - 860000, completedAt: t0 - 400000 - seq * 30000, kind: 'prompt' });
    }

    function tick() {
      const now = Date.now();
      for (const m of TEAM) {
        const since = now - t0 - m.enter;
        if (since < 0) continue;
        let a = agents.get(m.id);
        const script = SCRIPTS[m.id];
        const total = script.reduce((s, x) => s + x[2], 0);
        const cycle = Math.floor(since / total);
        let rem = since % total;
        let step = 0;
        while (rem >= script[step][2]) {
          rem -= script[step][2];
          step++;
        }
        const [state, action] = script[step];
        // subagente que terminou sai e volta no próximo ciclo
        const gone = m.kind === 'subagent' && a && a.state === 'done' && state !== 'done';
        if (gone) {
          agents.delete(m.id);
          const tid = 'demo-task-' + m.id + '-' + (cycle - 1);
          const t = tasks.get(tid);
          if (t && t.status === 'running') {
            t.status = 'done';
            t.completedAt = now;
          }
          continue;
        }
        if (!a) {
          a = {
            id: m.id,
            source: m.source,
            kind: m.kind,
            parentId: m.parent,
            type: m.role,
            role: m.role,
            displayName: names[m.role] || m.name,
            label: m.name,
            project: m.project,
            branch: m.branch,
            host: m.host,
            model: m.model,
            deskIndex: m.desk,
            state: 'thinking',
            startedAt: now,
            lastEventAt: now,
            stateSince: now,
            stats: { tools: 0, edits: 0, commands: 0, reads: 0, errors: 0, tokensIn: 0, tokensOut: 0 },
            files: []
          };
          agents.set(m.id, a);
          log(a, 'session', m.kind === 'subagent' ? 'entrou (chamado pela Sora)' : 'abriu sessão em ' + m.project);
        }
        const tid = 'demo-task-' + m.id + '-' + cycle;
        if (!tasks.has(tid)) {
          const prev = tasks.get('demo-task-' + m.id + '-' + (cycle - 1));
          if (prev && prev.status === 'running') {
            prev.status = 'done';
            prev.completedAt = now;
          }
          tasks.set(tid, {
            id: tid,
            title: cycle === 0 ? TASKS[m.id] : TASKS[m.id] + ' (#' + (cycle + 1) + ')',
            status: 'running',
            assignee: m.id,
            assigneeName: a.displayName,
            source: m.source,
            project: m.project,
            createdAt: now,
            startedAt: now,
            kind: m.kind === 'subagent' ? 'subagent' : 'prompt'
          });
        }
        if (a.state !== state || a.currentAction !== (action || undefined)) {
          if (onLive) {
            const entries = demoTerm(a, state, action, termSeq);
            if (entries.length) onLive(entries);
          }
          a.state = state;
          a.currentAction = action || undefined;
          a.stateSince = now;
          a.lastEventAt = now;
          const s = a.stats;
          if (state !== 'idle' && state !== 'thinking') s.tools++;
          if (state === 'writing') {
            s.edits++;
            const f = (action || '').split(' ').pop();
            if (f && !a.files.includes(f)) a.files.push(f);
          }
          if (state === 'running') s.commands++;
          if (state === 'reading') s.reads++;
          s.tokensIn += 1800 + ((seq * 137) % 5000);
          s.tokensOut += 200 + ((seq * 71) % 900);
          const task = tasks.get(tid);
          if (state === 'error') {
            s.errors++;
            log(a, 'error', action);
            if (task && m.id === 'demo-heitor' && cycle % 2 === 1) {
              task.status = 'failed';
              task.completedAt = now;
            }
          } else if (state === 'waiting') log(a, 'waiting', action);
          else if (state === 'done') {
            log(a, 'done', action);
            if (task && task.status === 'running') {
              task.status = 'done';
              task.completedAt = now;
            }
          } else if (state === 'idle') {
            log(a, 'idle', 'terminou o turno');
            if (task && task.status === 'running') {
              task.status = 'done';
              task.completedAt = now;
            }
          } else if (action) log(a, 'tool', action);
        }
      }
      emit(snapshot());
    }

    function snapshot() {
      return {
        sessionActive: agents.size > 0,
        agents: [...agents.values()],
        tasks: [...tasks.values()],
        activity: activity.slice(),
        ghosts: [],
        sources: [
          { id: 'claude', label: 'Claude Code', status: 'watching' },
          { id: 'codex', label: 'Codex', status: 'watching' },
          { id: 'gemini', label: 'Gemini CLI', status: 'watching' },
          { id: 'antigravity', label: 'Antigravity', status: 'watching' }
        ],
        spark: spark.slice(),
        host: { appName: 'demo' }
      };
    }

    const timer = setInterval(tick, 700);
    const sparkTimer = setInterval(() => {
      spark.push(bucket);
      spark.shift();
      bucket = 0;
    }, 2000);
    tick();
    return {
      stop() {
        clearInterval(timer);
        clearInterval(sparkTimer);
      },
      /** Avança o relógio do demo (screenshots/testes). */
      tick
    };
  }

  AO.demo = { start, TEAM };
})();
