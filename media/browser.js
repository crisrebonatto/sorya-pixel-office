// Ponte do modo navegador (http://127.0.0.1:<porta>/office): faz o papel
// da API da webview. Estado ao vivo chega por Server-Sent Events; ações
// (ex.: limpar o quadro) voltam por POST com cabeçalho próprio.
// Não é carregado dentro do VS Code — lá a webview usa postMessage.
(function () {
  'use strict';
  const KEY = 'agent-office-view';
  // O SSE pode entregar o primeiro quadro antes de office.js carregar:
  // guarda o último e entrega quando a UI avisar 'ready'.
  let ready = false;
  let last = null;
  const deliver = () => {
    if (ready && last) window.postMessage({ type: 'state', state: last }, location.origin);
  };
  window.__AO_HOST = {
    browser: true,
    getState() {
      try {
        return JSON.parse(localStorage.getItem(KEY) || '{}');
      } catch (_) {
        return {};
      }
    },
    setState(s) {
      try {
        localStorage.setItem(KEY, JSON.stringify(s || {}));
      } catch (_) {
        /* armazenamento bloqueado: segue sem lembrar */
      }
    },
    postMessage(msg) {
      if (msg && msg.type === 'ready') {
        ready = true;
        deliver();
      }
      if (!msg || msg.type !== 'clearFinished') return;
      fetch('/office/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Office': '1' }, body: JSON.stringify(msg) }).catch(() => undefined);
    }
  };

  function connect() {
    const es = new EventSource('/office/events');
    es.addEventListener('state', (e) => {
      document.documentElement.classList.remove('ao-offline');
      try {
        last = JSON.parse(e.data);
      } catch (_) {
        return; /* quadro inválido: espera o próximo */
      }
      deliver();
    });
    es.onerror = () => {
      // Editor fechado ou recarregando: com a porta fora do ar o EventSource
      // tenta de novo sozinho; se a resposta foi um erro HTTP ele desiste,
      // então reabrimos na mão.
      document.documentElement.classList.add('ao-offline');
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
    };
  }
  document.title = 'Agent Office — Sorya Dev Hub';
  connect();
})();
