// Cola da UI da webview: recebe o snapshot da extensão (postMessage),
// alimenta a cena em pixel art, o kanban inferior, o feed e o painel de
// detalhe. Roda isolada: CSP sem connect-src, nunca fala com a rede.
(function () {
  'use strict';
  const AO = window.AO;
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const STATE_LABEL = {
    idle: 'ocioso',
    thinking: 'pensando',
    reading: 'lendo',
    writing: 'escrevendo',
    running: 'rodando comando',
    searching: 'pesquisando',
    waiting: 'aguardando você',
    error: 'erro',
    done: 'concluiu'
  };
  const STATE_DOT = {
    idle: '#8b867e',
    thinking: '#c792ea',
    reading: '#4e8cf7',
    writing: '#e38b66',
    running: '#4fd1e8',
    searching: '#4e8cf7',
    waiting: '#e0b84a',
    error: '#e06464',
    done: '#6db86f'
  };
  const HOST_LABEL = {
    'claude-vscode': 'VS Code',
    vscode: 'VS Code',
    antigravity: 'Antigravity',
    cursor: 'Cursor',
    windsurf: 'Windsurf',
    cli: 'terminal',
    terminal: 'terminal',
    desktop: 'desktop',
    remote_desktop: 'desktop',
    'sdk-cli': 'SDK',
    'sdk-ts': 'SDK',
    'sdk-py': 'SDK',
    codex_cli_rs: 'terminal',
    codex_vscode: 'VS Code',
    exec: 'codex exec'
  };

  let snapshot = emptySnapshot();
  let live = emptySnapshot();
  let demo = null;
  let selected = null;
  const saved = (vscode && vscode.getState()) || {};

  function emptySnapshot() {
    return { agents: [], tasks: [], activity: [], ghosts: [], sources: [], spark: [], host: {}, sessionActive: false };
  }

  // ── Cena ─────────────────────────────────────────────────────────
  const scene = AO.scene.mount($('#office'), {
    font: getComputedStyle(document.body).fontFamily,
    onSelect(id) {
      select(id, false);
    },
    forceHour: window.__AO_FORCE_HOUR
  });

  // ── Mensagens da extensão ───────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      live = normalize(msg.state);
      if (!demo) apply(live);
    } else if (msg.type === 'demo') {
      setDemo(!!msg.on);
    } else if (msg.type === 'focus' && msg.agentId) {
      select(msg.agentId, true);
    }
  });

  function normalize(s) {
    const out = Object.assign(emptySnapshot(), s || {});
    for (const a of out.agents) {
      a.displayName = a.displayName || a.label || a.type || a.source;
      a.stats = a.stats || {};
      a.files = a.files || [];
    }
    return out;
  }

  function apply(s) {
    snapshot = s;
    scene.setAgents(s.agents, s.ghosts);
    scene.setStats(stats(s), s.spark);
    renderTopbar();
    renderBoard();
    renderFeed();
    renderDetail();
    renderEmpty();
  }

  function stats(s) {
    const count = (st) => s.tasks.filter((t) => t.status === st).length;
    return {
      active: s.agents.length,
      running: s.agents.filter((a) => a.state === 'running').length,
      waiting: s.agents.filter((a) => a.state === 'waiting').length,
      pending: count('pending'),
      done: count('done'),
      failed: count('failed'),
      runningTasks: count('running')
    };
  }

  // ── Barra superior ──────────────────────────────────────────────
  function renderTopbar() {
    const st = stats(snapshot);
    setCounter('active', st.active);
    setCounter('waiting', st.waiting, st.waiting > 0);
    setCounter('running', st.runningTasks);
    setCounter('failed', st.failed, st.failed > 0);
    const host = snapshot.host || {};
    $('#host-chip').textContent = demo ? 'demo' : host.appName || '';

    const box = $('#sources');
    box.textContent = '';
    const bySource = {};
    for (const a of snapshot.agents) bySource[a.source] = (bySource[a.source] || 0) + 1;
    const list = snapshot.sources.length ? snapshot.sources : Object.keys(bySource).map((id) => ({ id, status: 'watching' }));
    for (const src of list) {
      const info = AO.sourceInfo(src.id);
      const n = bySource[src.id] || 0;
      const chip = el('span', 'source ' + (src.status || 'missing') + (n ? ' live' : ''));
      chip.style.setProperty('--dot', info.color);
      chip.title = (src.label || info.label) + ' — ' + (src.detail || statusText(src.status));
      chip.appendChild(el('i'));
      chip.appendChild(el('span', 'src-label', src.label || info.label));
      if (n) chip.appendChild(el('b', null, String(n)));
      box.appendChild(chip);
    }
  }

  function statusText(s) {
    return { watching: 'monitorando', hooks: 'via hooks', missing: 'não encontrado nesta máquina', error: 'erro ao ler', idle: 'sem atividade recente' }[s] || s || '';
  }

  function setCounter(k, n, hot) {
    const c = $('.counter[data-k="' + k + '"]');
    c.querySelector('b').textContent = String(n);
    c.classList.toggle('hot', !!hot);
  }

  // ── Kanban inferior ─────────────────────────────────────────────
  function agentById(id) {
    return snapshot.agents.find((a) => a.id === id);
  }

  function renderBoard() {
    for (const col of document.querySelectorAll('.column')) {
      const status = col.dataset.status;
      let tasks = snapshot.tasks.filter((t) => t.status === status);
      tasks.sort((a, b) => (b.completedAt || b.startedAt || b.createdAt) - (a.completedAt || a.startedAt || a.createdAt));
      if (status === 'done' || status === 'failed') tasks = tasks.slice(0, 60);
      col.querySelector('.count').textContent = String(tasks.length);
      const box = col.querySelector('.cards');
      const keep = new Map();
      for (const c of box.children) keep.set(c.dataset.id, c);
      const wanted = new Set(tasks.map((t) => t.id));
      for (const [id, c] of keep) if (!wanted.has(id)) c.remove();
      // Reaproveita os cards existentes e só move o que mudou de posição:
      // reinserir tudo reiniciaria a animação de entrada a cada snapshot.
      tasks.forEach((t, i) => {
        let card = keep.get(t.id);
        if (!card) {
          card = el('div', 'card new');
          card.addEventListener('animationend', () => card.classList.remove('new'), { once: true });
        }
        fillCard(card, t);
        if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
      });
    }
  }

  function fillCard(card, t) {
    card.dataset.id = t.id;
    const a = agentById(t.assignee);
    const info = AO.sourceInfo(t.source);
    card.style.setProperty('--src', info.color);
    card.classList.toggle('highlight', !!selected && t.assignee === selected);
    card.classList.toggle('waiting', !!a && a.state === 'waiting' && t.status === 'running');
    card.textContent = '';
    if (t.kind && t.kind !== 'prompt') card.appendChild(el('div', 'kind', kindLabel(t.kind)));
    card.appendChild(el('div', 'card-title', t.title));
    const meta = el('div', 'card-meta');
    meta.appendChild(el('span', 'who', t.assigneeName || (a && a.displayName) || info.label));
    if (t.project) meta.appendChild(el('span', 'proj', t.project));
    const time = el('time', null, elapsed(t));
    time.dataset.start = String(t.startedAt || t.createdAt);
    if (t.completedAt) time.dataset.end = String(t.completedAt);
    meta.appendChild(time);
    card.appendChild(meta);
    card.onclick = () => select(t.assignee, true);
    card.title = t.title;
  }

  function kindLabel(k) {
    return { subagent: 'subagente', todo: 'to-do', plan: 'plano', hook: 'tarefa' }[k] || k;
  }

  function elapsed(t) {
    const start = t.startedAt || t.createdAt;
    if (t.completedAt) {
      const d = t.completedAt - start;
      return d >= 1000 ? fmtDur(d) : clock(t.completedAt).slice(0, 5);
    }
    return fmtDur(Date.now() - start);
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  // ── Feed ────────────────────────────────────────────────────────
  function renderFeed() {
    const ol = $('#feed ol');
    const items = snapshot.activity.slice(-80).sort((a, b) => b.at - a.at);
    const keep = new Map();
    for (const li of ol.children) keep.set(li.dataset.id, li);
    const wanted = new Set(items.map((it) => it.id));
    for (const [id, li] of keep) if (!wanted.has(id)) li.remove();
    // mais recente no topo; itens existentes só se movem se a ordem mudou
    items.forEach((it, i) => {
      let li = keep.get(it.id);
      if (!li) {
        li = el('li', (it.kind || '') + (ol.children.length ? ' new' : ''));
        li.dataset.id = it.id;
        li.style.setProperty('--src', AO.sourceInfo(it.source).color);
        li.appendChild(el('time', null, clock(it.at)));
        li.appendChild(el('span', 'who', it.agentName || ''));
        li.appendChild(el('span', 'what', it.text));
        li.title = (it.agentName || '') + ' ' + it.text;
        li.onclick = () => select(it.agentId, true);
        li.addEventListener('animationend', () => li.classList.remove('new'), { once: true });
      }
      if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] || null);
    });
  }

  function clock(ms) {
    const d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  }

  // ── Seleção + detalhe ───────────────────────────────────────────
  function select(id, fromUi) {
    selected = id || null;
    scene.select(selected);
    scene.highlight(null);
    if (fromUi && vscode && selected) vscode.postMessage({ type: 'select', agentId: selected });
    renderBoard();
    renderDetail();
  }

  function renderDetail() {
    const box = $('#detail');
    const a = selected && agentById(selected);
    if (!a) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.textContent = '';
    const info = AO.sourceInfo(a.source);

    const head = el('div', 'd-head');
    const look = AO.chars.lookFor(
      a.kind === 'session' ? a.source + ':' + (a.displayName || a.project || a.id) : (a.displayName || a.type || '') + ':' + a.source,
      a.source,
      a.kind,
      a.type
    );
    const portrait = AO.chars.portrait(look, 3);
    portrait.className = 'd-portrait';
    head.appendChild(portrait);
    const names = el('div');
    names.appendChild(el('div', 'd-name', a.displayName));
    names.appendChild(el('div', 'd-role', [a.role || a.type, info.label].filter(Boolean).join(' · ')));
    head.appendChild(names);
    const close = el('button', 'd-close ghost', '×');
    close.title = 'Fechar';
    close.onclick = () => select(null, true);
    head.appendChild(close);
    box.appendChild(head);

    const st = el('div', 'd-state ' + a.state);
    st.style.setProperty('--dot', STATE_DOT[a.state] || '#888');
    st.appendChild(el('i'));
    st.appendChild(el('span', null, (a.currentAction || STATE_LABEL[a.state] || a.state) + ' · há ' + fmtDur(Date.now() - (a.stateSince || a.lastEventAt))));
    box.appendChild(st);

    const meta = el('dl', 'd-meta');
    const row = (k, v) => {
      if (!v) return;
      meta.appendChild(el('dt', null, k));
      const dd = el('dd', null, v);
      dd.title = v;
      meta.appendChild(dd);
    };
    row('projeto', a.project + (a.branch ? ' · ' + a.branch : ''));
    row('onde', HOST_LABEL[a.host] || a.host);
    row('modelo', a.model);
    row('mesa', a.deskIndex >= 0 ? 'mesa ' + (a.deskIndex + 1) : 'sem mesa (lounge)');
    row('ativo há', fmtDur(Date.now() - a.startedAt));
    if (a.parentId) {
      const p = agentById(a.parentId);
      row('chamado por', p ? p.displayName : 'sessão principal');
    }
    box.appendChild(meta);

    const s = a.stats || {};
    const grid = el('div', 'd-stats');
    const stat = (n, label) => {
      const d = el('div');
      d.appendChild(el('b', null, fmtNum(n || 0)));
      d.appendChild(el('span', null, label));
      grid.appendChild(d);
    };
    stat(s.tools, 'ferramentas');
    stat(s.edits, 'edições');
    stat(s.commands, 'comandos');
    stat(s.reads, 'leituras');
    stat(s.errors, 'erros');
    stat((s.tokensIn || 0) + (s.tokensOut || 0), 'tokens');
    box.appendChild(grid);

    if (a.files && a.files.length) {
      box.appendChild(el('div', 'd-sec', 'arquivos tocados'));
      const files = el('div', 'd-files');
      for (const f of a.files.slice(-12).reverse()) files.appendChild(el('span', null, f));
      box.appendChild(files);
    }

    const tasks = snapshot.tasks.filter((t) => t.assignee === a.id).slice(-5).reverse();
    if (tasks.length) {
      box.appendChild(el('div', 'd-sec', 'tarefas'));
      const ul = el('ul', 'd-log');
      for (const t of tasks) {
        const li = el('li');
        li.appendChild(el('time', null, { pending: '○', running: '◐', done: '●', failed: '✕' }[t.status] || '·'));
        li.appendChild(el('span', null, t.title));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }

    const log = snapshot.activity.filter((x) => x.agentId === a.id).slice(-8).reverse();
    if (log.length) {
      box.appendChild(el('div', 'd-sec', 'últimas ações'));
      const ul = el('ul', 'd-log');
      for (const it of log) {
        const li = el('li');
        li.appendChild(el('time', null, clock(it.at)));
        li.appendChild(el('span', null, it.text));
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
  }

  function fmtNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // ── Estado vazio ────────────────────────────────────────────────
  function renderEmpty() {
    const box = $('#empty');
    const empty = !demo && snapshot.agents.length === 0;
    box.hidden = !empty;
    if (!empty) return;
    const ul = $('#empty-sources');
    ul.textContent = '';
    for (const src of snapshot.sources) {
      const li = el('li', src.status || '');
      li.appendChild(el('i'));
      li.appendChild(el('span', null, (src.label || AO.sourceInfo(src.id).label) + ' — ' + statusText(src.status)));
      if (src.path) li.appendChild(el('code', null, src.path));
      ul.appendChild(li);
    }
  }

  // ── Demo ────────────────────────────────────────────────────────
  function setDemo(on) {
    if (on && !demo) {
      demo = AO.demo.start((s) => apply(normalize(s)), { names: snapshot.names });
    } else if (!on && demo) {
      demo.stop();
      demo = null;
      apply(live);
    }
    $('#btn-demo').classList.toggle('on', !!demo);
    if (vscode) vscode.setState(Object.assign(saved, { demo: !!demo }));
  }
  $('#btn-demo').onclick = () => setDemo(!demo);
  for (const b of document.querySelectorAll('.column .clear')) {
    b.onclick = (e) => {
      e.stopPropagation();
      if (vscode && !demo) vscode.postMessage({ type: 'clearFinished' });
    };
  }
  $('#btn-demo-empty').onclick = () => setDemo(true);

  // ── Feed lateral: só aparece quando não rouba tamanho do escritório ──
  const feedPref = () => saved.feed || 'auto';
  function layoutFeed() {
    const main = $('#main');
    const r = main.getBoundingClientRect();
    const needW = r.height * (AO.world.PX_W / AO.world.PX_H);
    const auto = r.width - 290 >= needW * 0.94;
    const show = feedPref() === 'on' ? true : feedPref() === 'off' ? false : auto;
    main.classList.toggle('with-feed', show);
    $('#btn-feed').classList.toggle('on', show);
    scene.layout();
  }
  $('#btn-feed').onclick = () => {
    const showing = $('#main').classList.contains('with-feed');
    saved.feed = showing ? 'off' : 'on';
    if (vscode) vscode.setState(saved);
    layoutFeed();
  };
  new ResizeObserver(layoutFeed).observe($('#main'));

  // ── Zoom ────────────────────────────────────────────────────────
  $('#btn-zoom-in').onclick = () => scene.zoomBy(1);
  $('#btn-zoom-out').onclick = () => scene.zoomBy(-1);
  $('#btn-zoom-fit').onclick = () => scene.zoomBy(0);

  // ── Divisor arrastável (altura do dock persiste no estado da view) ──
  (function splitter() {
    const sp = $('#splitter');
    const root = document.documentElement;
    if (saved.dockH) root.style.setProperty('--dock-h', saved.dockH + 'px');
    let startY = 0;
    let startH = 0;
    const move = (e) => {
      const h = Math.max(110, Math.min(window.innerHeight - 200, startH + (startY - e.clientY)));
      root.style.setProperty('--dock-h', h + 'px');
      scene.layout();
    };
    const up = () => {
      sp.classList.remove('drag');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      saved.dockH = $('#dock').getBoundingClientRect().height;
      if (vscode) vscode.setState(saved);
    };
    sp.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startH = $('#dock').getBoundingClientRect().height;
      sp.classList.add('drag');
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });
  })();

  // Relógios dos cards e do detalhe.
  setInterval(() => {
    for (const t of document.querySelectorAll('.card-meta time')) {
      if (t.dataset.end) continue;
      t.textContent = fmtDur(Date.now() - Number(t.dataset.start));
    }
    if (selected) renderDetail();
  }, 1000);

  if (vscode) vscode.postMessage({ type: 'ready' });
  apply(snapshot);
  if (saved.demo || window.__AO_DEMO) setDemo(true);
})();
