// Roda DENTRO da webview isolada. Só recebe postMessage da extensão;
// nunca fala com a rede (CSP sem connect-src).
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const media = document.body.dataset.media;

  const SPRITES = {
    claude: 'agent-claude.png',
    codex: 'agent-codex.png',
    explore: 'agent-explore.png',
    plan: 'agent-plan.png'
  };

  const STATE_BADGE = {
    idle: '☕',
    thinking: '…',
    reading: '📖',
    writing: '⌨',
    running: '▶',
    searching: '🌐',
    waiting: '✋',
    error: '✖',
    done: '✔'
  };

  let state = { sessionActive: false, agents: [], tasks: [], desks: 8, ghosts: [] };
  let highlightedAgent = null;

  const desksEl = document.getElementById('desks');
  const lampEl = document.getElementById('session-lamp');
  const detailEl = document.getElementById('detail');

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      state = event.data.state;
      render();
    }
  });

  function spriteFor(agent) {
    const type = (agent.type || '').toLowerCase();
    if (agent.source === 'codex') return SPRITES.codex;
    if (SPRITES[type]) return SPRITES[type];
    return SPRITES.claude;
  }

  function elapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? m + 'm ' + String(s).padStart(2, '0') + 's' : s + 's';
  }

  function render() {
    lampEl.classList.toggle('on', !!state.sessionActive);
    renderDesks();
    renderBoard();
  }

  function renderDesks() {
    desksEl.textContent = '';
    const byDesk = new Map();
    for (const agent of state.agents) {
      if (agent.deskIndex >= 0) byDesk.set(agent.deskIndex, agent);
    }
    const ghosts = new Map();
    for (const g of state.ghosts || []) ghosts.set(g.deskIndex, g);

    for (let i = 0; i < state.desks; i++) {
      const desk = document.createElement('div');
      desk.className = 'desk';
      const agent = byDesk.get(i);

      if (agent) {
        desk.classList.add(isActive(agent) ? 'active' : 'inactive');
        if (agent.state === 'waiting') desk.classList.add('waiting');
        if (agent.state === 'error') desk.classList.add('error');
        if (highlightedAgent === agent.id) desk.classList.add('highlight');

        const sprite = document.createElement('div');
        sprite.className = 'agent-sprite';
        sprite.style.backgroundImage = "url('" + media + '/sprites/' + spriteFor(agent) + "')";
        desk.appendChild(sprite);

        const badge = document.createElement('span');
        badge.className = 'state-badge ' + agent.state;
        badge.textContent = STATE_BADGE[agent.state] || '';
        desk.appendChild(badge);

        desk.appendChild(furniture());
        desk.appendChild(label('desk-label', agent.label));
        desk.appendChild(label('desk-action', agent.currentAction || agent.state));

        desk.addEventListener('click', () => {
          highlightedAgent = highlightedAgent === agent.id ? null : agent.id;
          showDetail(agent);
          render();
        });
      } else if (ghosts.has(i)) {
        // Mesa recém-liberada: nome esmaecido por alguns segundos.
        desk.classList.add('empty', 'ghost');
        desk.appendChild(furniture());
        desk.appendChild(label('desk-label', ghosts.get(i).label));
      } else {
        desk.classList.add('empty');
        desk.appendChild(furniture());
        desk.appendChild(label('desk-label', 'mesa ' + (i + 1)));
      }
      desksEl.appendChild(desk);
    }
  }

  function isActive(agent) {
    return agent.state !== 'idle' && agent.state !== 'done';
  }

  function furniture() {
    const el = document.createElement('div');
    el.className = 'desk-furniture';
    return el;
  }

  function label(cls, text) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function renderBoard() {
    const columns = document.querySelectorAll('.board-column');
    for (const column of columns) {
      const status = column.dataset.status;
      const cards = column.querySelector('.cards');
      cards.textContent = '';
      for (const task of state.tasks.filter((t) => t.status === status)) {
        cards.appendChild(renderCard(task));
      }
    }
  }

  function renderCard(task) {
    const card = document.createElement('div');
    card.className = 'card';
    if (highlightedAgent && task.assignee === highlightedAgent) {
      card.classList.add('highlight');
    }

    const source = document.createElement('div');
    source.className = 'card-source';
    const dot = document.createElement('span');
    dot.className = 'card-dot ' + task.source;
    source.appendChild(dot);
    source.appendChild(document.createTextNode(task.source === 'codex' ? 'Codex' : 'Claude'));
    card.appendChild(source);

    card.appendChild(label('card-title', task.title));

    const end = task.completedAt || Date.now();
    card.appendChild(label('card-time', elapsed(end - task.createdAt)));

    // Clicar no card destaca a mesa do agente responsável.
    card.addEventListener('click', () => {
      highlightedAgent = highlightedAgent === task.assignee ? null : task.assignee;
      render();
    });
    return card;
  }

  function showDetail(agent) {
    if (highlightedAgent !== agent.id) {
      detailEl.hidden = true;
      return;
    }
    detailEl.hidden = false;
    detailEl.textContent =
      agent.label + ' · ' + agent.type + ' · ' + agent.state +
      (agent.currentAction ? ' · ' + agent.currentAction : '') +
      ' · ativo há ' + elapsed(Date.now() - agent.startedAt);
  }

  // Relógio dos cards em execução.
  setInterval(() => {
    if (state.tasks.some((t) => t.status === 'running')) renderBoard();
  }, 1000);

  if (vscode) vscode.postMessage({ type: 'ready' });
  render();
})();
