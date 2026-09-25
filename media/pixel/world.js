// O dev hub: planta fixa (mesas fixas = memória espacial), piso, paredes em
// vista 3/4, decoração de parede, mobília posicionada, assentos e grade de
// navegação. A planta é FIXA de propósito: "a mesa do canto é sempre a do
// Rick" só funciona se nada muda de lugar.
(function () {
  'use strict';
  const AO = (window.AO = window.AO || {});
  const { canvas, ctx2d, Painter, rng, lighten, darken, mix } = AO.px;
  const P = AO.PAL;
  const F = AO.furniture;

  const T = 16;
  // Legenda: # parede · = face de parede · d porta · e entrada
  // S server · O open space · K cozinha · M reunião · L lounge
  const MAP = [
    '##################################',
    '#=======#================#=======#',
    '#=======#================#=======#',
    '#SSSSSSS#OOOOOOOOOOOOOOOO#KKKKKKK#',
    '#SSSSSSS#OOOOOOOOOOOOOOOO#KKKKKKK#',
    '#SSSSSSS#OOOOOOOOOOOOOOOO#KKKKKKK#',
    '#SSSSSSSdOOOOOOOOOOOOOOOOdKKKKKKK#',
    '#SSSSSSS#OOOOOOOOOOOOOOOO#KKKKKKK#',
    '#SSSSSSS#OOOOOOOOOOOOOOOO#KKKKKKK#',
    '#########OOOOOOOOOOOOOOOO#########',
    '#=======#OOOOOOOOOOOOOOOO#=======#',
    '#=======#OOOOOOOOOOOOOOOO#=======#',
    '#MMMMMMM#OOOOOOOOOOOOOOOO#LLLLLLL#',
    '#MMMMMMM#OOOOOOOOOOOOOOOO#LLLLLLL#',
    '#MMMMMMM#OOOOOOOOOOOOOOOO#LLLLLLL#',
    '#MMMMMMMdOOOOOOOOOOOOOOOOdLLLLLLL#',
    '#MMMMMMM#OOOOOOOOOOOOOOOO#LLLLLLL#',
    '#MMMMMMM#OOOOOOOOOOOOOOOO#LLLLLLL#',
    '################ee################'
  ];
  const W = MAP[0].length;
  const H = MAP.length;
  const PX_W = W * T;
  const PX_H = H * T;

  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? '#' : MAP[y][x]);
  const FLOOR_OF = { S: 'S', O: 'O', K: 'K', M: 'M', L: 'L' };

  /** Sala dona de uma célula (portas herdam do vizinho da direita/esquerda). */
  function roomAt(x, y) {
    const c = at(x, y);
    if (FLOOR_OF[c]) return c;
    if (c === 'e') return 'O';
    if (c === 'd') return FLOOR_OF[at(x + 1, y)] || FLOOR_OF[at(x - 1, y)] || 'O';
    if (c === '=') {
      for (let yy = y; yy < H; yy++) {
        const r = at(x, yy);
        if (FLOOR_OF[r]) return r;
      }
    }
    return null;
  }

  // ── Grade de navegação ────────────────────────────────────────────
  const blocked = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      if (!(FLOOR_OF[c] || c === 'd' || c === 'e')) blocked[y * W + x] = 1;
    }
  }
  function block(x, y, w, h) {
    for (let j = 0; j < (h || 1); j++) for (let i = 0; i < (w || 1); i++) blocked[(y + j) * W + x + i] = 1;
  }
  function walkable(x, y) {
    return x >= 0 && y >= 0 && x < W && y < H && !blocked[y * W + x];
  }

  // ── Objetos (y-sort) ──────────────────────────────────────────────
  const objects = [];
  function obj(img, x, y, sortY, dyn, extra) {
    const o = Object.assign({ img, x, y, sortY, dyn }, extra || {});
    objects.push(o);
    return o;
  }

  // ── Mesas (2 fileiras × 6, todos de frente para a câmera) ─────────
  // Agentes sentam atrás de notebooks: rosto visível, nome em cima da
  // cabeça sem cobrir nada. Ordem de preenchimento: do centro para fora.
  const desks = [];
  const DESK_COLS = [14, 18, 12, 20, 10, 22];
  const ROWS = [
    { deskRow: 5, access: 3 },
    { deskRow: 9, access: 7 }
  ];
  for (const r of ROWS) {
    for (const tx of DESK_COLS) {
      const x = tx * T;
      const deskY = r.deskRow * T - 2;
      const seatY = r.deskRow * T + 6;
      desks.push({
        index: desks.length,
        row: r.deskRow,
        tx,
        x,
        deskY,
        seat: { x: x + 16, y: seatY, facing: 'down', sortY: seatY, access: { tx: tx + (tx < 16 ? 1 : 0), ty: r.access } }
      });
    }
    block(10, r.deskRow - 1, 6, 2);
    block(18, r.deskRow - 1, 6, 2);
  }
  // ── Assentos de lazer / pontos de parada ──────────────────────────
  const spots = [];
  function spot(id, kind, tx, ty, opts) {
    const s = Object.assign(
      { id, kind, x: tx * T + 8, y: ty * T + 13, facing: 'down', pose: 'stand', access: { tx, ty } },
      opts || {}
    );
    spots.push(s);
    return s;
  }

  // ── Ambiente dinâmico (preenchido pela cena a cada quadro) ─────────
  // env = { t, agentsByDesk, activity, stats, hour, lights }

  const CONSOLE_MODE = { error: 'error', waiting: 'wait', running: 'term', writing: 'code', reading: 'doc', searching: 'web', thinking: 'think', done: 'done' };

  // Telas animadas (console da server room): conteúdo por modo.
  function drawScreen(ctx, x, y, w, h, mode, t, seed) {
    const p = new Painter(ctx);
    if (!mode) {
      p.rect(x, y, w, h, P.screenOff);
      return;
    }
    const tick = Math.floor(t / 180);
    switch (mode) {
      case 'code': {
        p.rect(x, y, w, h, P.codeBg);
        const cols = [P.synPurple, P.synCyan, P.synGreen, P.synOrange, P.synYellow, P.synGray];
        const r = rng(seed * 31 + Math.floor(t / 900));
        for (let j = 0; j < h - 1; j++) {
          const indent = Math.floor(r() * 3);
          let cx = x + 1 + indent;
          const line = (j + Math.floor(t / 400)) % 9;
          while (cx < x + w - 1 && r() < 0.8) {
            const len = 1 + Math.floor(r() * 3);
            p.rect(cx, y + j, Math.min(len, x + w - 1 - cx), 1, cols[(line + cx) % cols.length]);
            cx += len + 1;
          }
        }
        if (tick % 2 === 0) p.rect(x + 1 + ((t / 150) % (w - 3)), y + h - 1, 1, 1, P.white);
        break;
      }
      case 'term': {
        p.rect(x, y, w, h, P.termBg);
        const r = rng(seed * 17 + Math.floor(t / 250));
        for (let j = 0; j < h; j++) {
          const len = 2 + Math.floor(r() * (w - 4));
          p.rect(x + 1, y + j, len, 1, j === h - 1 ? P.white : P.termGreen);
        }
        break;
      }
      case 'doc': {
        p.rect(x, y, w, h, P.docBg);
        const off = Math.floor(t / 500) % 3;
        for (let j = 1 - off; j < h; j += 2) if (j >= 0) p.rect(x + 1, y + j, w - 3 - ((j * 3) % 4), 1, P.docLine);
        break;
      }
      case 'web': {
        p.rect(x, y, w, h, P.webBg);
        p.rect(x, y, w, 1, P.webBar);
        const cx = x + (w >> 1);
        const cy = y + 1 + ((h - 1) >> 1);
        p.rect(cx - 1, cy - 2, 3, 5, P.blue);
        p.rect(cx - 2, cy - 1, 5, 3, P.blue);
        p.px(cx + ((tick % 3) - 1), cy, P.cyan);
        break;
      }
      case 'wait': {
        p.rect(x, y, w, h, P.codeBg);
        const on = tick % 4 < 2;
        p.rect(x + 1, y + 1, w - 2, h - 2, on ? P.yellow : P.ink2);
        p.rect(x + (w >> 1), y + 2, 1, h - 5, on ? P.ink : P.yellow);
        p.px(x + (w >> 1), y + h - 2, on ? P.ink : P.yellow);
        break;
      }
      case 'error': {
        const on = tick % 2 === 0;
        p.rect(x, y, w, h, on ? P.red : P.redLo);
        p.px(x + (w >> 1) - 1, y + (h >> 1) - 1, P.white);
        p.px(x + (w >> 1) + 1, y + (h >> 1) + 1, P.white);
        p.px(x + (w >> 1), y + (h >> 1), P.white);
        p.px(x + (w >> 1) + 1, y + (h >> 1) - 1, P.white);
        p.px(x + (w >> 1) - 1, y + (h >> 1) + 1, P.white);
        break;
      }
      case 'done': {
        p.rect(x, y, w, h, '#16301f');
        const cx = x + (w >> 1) - 2;
        const cy = y + (h >> 1);
        p.px(cx, cy, P.greenHi);
        p.px(cx + 1, cy + 1, P.greenHi);
        p.px(cx + 2, cy, P.greenHi);
        p.px(cx + 3, cy - 1, P.greenHi);
        p.px(cx + 4, cy - 2, P.greenHi);
        break;
      }
      case 'think': {
        p.rect(x, y, w, h, P.codeBg);
        for (let j = 0; j < h - 2; j += 2) p.rect(x + 1, y + j + 1, 3 + ((j * 5 + seed) % (w - 5)), 1, P.synGray);
        const d = tick % 4;
        for (let i = 0; i < 3; i++) p.px(x + w - 5 + i, y + h - 2, i < d ? P.white : P.synGray);
        break;
      }
      case 'idle':
      default: {
        p.rect(x, y, w, h, '#141827');
        const bx = Math.floor((t / 120 + seed * 7) % ((w - 3) * 2));
        const by = Math.floor((t / 170 + seed * 3) % ((h - 2) * 2));
        const px = bx < w - 3 ? bx : (w - 3) * 2 - bx;
        const py = by < h - 2 ? by : (h - 2) * 2 - by;
        p.rect(x + px, y + py, 3, 2, P.accent);
        break;
      }
    }
  }

  // Mesa: cadeira (atrás) → tampo → agente sentado → notebook e enfeites.
  const laptopBack = F.sprite('laptopBack', 16, 11, (p) => {
    p.rect(1, 0, 14, 9, P.ink);
    p.rect(2, 1, 12, 7, P.metalHi);
    p.hline(2, 1, 12, P.white);
    p.rect(2, 7, 12, 1, P.metal);
    p.rect(0, 8, 16, 3, P.ink);
    p.rect(1, 9, 14, 1, P.metal);
  });
  const lamp = F.sprite('lamp', 9, 14, (p) => {
    p.rect(1, 0, 7, 5, P.ink);
    p.rect(2, 1, 5, 3, P.yellow);
    p.px(2, 1, P.yellowHi);
    p.rect(4, 5, 1, 7, P.ink);
    p.rect(1, 11, 7, 3, P.ink);
    p.rect(2, 12, 5, 1, P.metalLo);
  });
  const books = F.sprite('books', 10, 8, (p) => {
    p.rect(0, 0, 10, 8, P.ink);
    p.rect(1, 1, 8, 2, P.blue);
    p.rect(1, 3, 8, 2, P.accent);
    p.rect(1, 5, 8, 2, P.green);
    p.px(8, 1, P.white);
    p.px(8, 3, P.white);
    p.px(8, 5, P.white);
  });
  for (const d of desks) {
    const base = d.row * T;
    obj(F.chairFront(P.chair), d.x + 8, base - 16, base - 10);
    obj(F.desk(), d.x, d.deskY, base - 9);
    const deco = d.index % 4;
    const plantImg = F.plant('desk');
    const mugImg = F.mug(d.index % 2 ? P.accent : P.cyan);
    obj(laptopBack, d.x + 8, d.deskY + 2, d.seat.sortY + 2, (ctx, env) => {
      const a = env.agentsByDesk[d.index];
      // logo do notebook acende na cor do estado
      ctx.fillStyle = a ? stateColor(a.state) : P.metal;
      ctx.fillRect(d.x + 15, d.deskY + 5, 2, 2);
      if (a && a.state !== 'idle') {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(d.x + 15, d.deskY + 5, 1, 1);
      }
      if (deco === 0) ctx.drawImage(plantImg, d.x + 24, d.deskY - 5);
      else if (deco === 1) ctx.drawImage(mugImg, d.x + 3, d.deskY + 3);
      else if (deco === 2) ctx.drawImage(lamp, d.x + 23, d.deskY - 4);
      else ctx.drawImage(books, d.x + 2, d.deskY + 2);
      if (deco !== 1 && d.index % 3 === 0) ctx.drawImage(mugImg, d.x + 3, d.deskY + 3);
    });
  }
  // divisórias baixas entre as mesas (acabamento)
  for (const r of ROWS) {
    for (const x of [12 * T, 14 * T, 20 * T, 22 * T]) {
      obj(null, x, r.deskRow * T, r.deskRow * T - 9, (ctx) => {
        ctx.fillStyle = P.deskEdge;
        ctx.fillRect(x, r.deskRow * T - 1, 1, 9);
      });
    }
  }

  function stateColor(state) {
    switch (state) {
      case 'waiting':
        return P.yellow;
      case 'error':
        return P.red;
      case 'done':
        return P.green;
      case 'idle':
        return P.synGray;
      default:
        return P.cyan;
    }
  }

  // ── Server room (cols 1–7, linhas 3–8) ────────────────────────────
  const rackImg = F.rack();
  for (let i = 0; i < 4; i++) {
    const x = (1 + i) * T;
    obj(rackImg, x, 4 * T - 38, 4 * T - 1, (ctx, env) => {
      // LEDs piscam mais rápido com mais agentes rodando comandos
      const speed = 90 + 400 / (1 + env.stats.running * 2 + env.stats.active);
      const r = rng(i * 97 + Math.floor(env.t / speed));
      for (let k = 0; k < 7; k++) {
        const y = 4 * T - 38 + 6 + k * 4;
        for (let l = 0; l < 3; l++) {
          const v = r();
          const c = v < 0.55 ? P.green : v < 0.75 ? P.cyan : v < 0.8 ? P.yellow : '#1e3a2a';
          ctx.fillStyle = env.lightsOn ? c : v < 0.4 ? '#1e3a2a' : c;
          ctx.fillRect(x + 10 + l * 1, y, 1, 1);
        }
      }
    }, { light: { x: x + 8, y: 4 * T - 20, r: 18, color: P.green, a: 0.18 } });
  }
  block(1, 3, 4, 1);
  obj(F.upsBox(), 6 * T, 4 * T - 18, 4 * T - 1);
  block(6, 3, 1, 1);
  const consoleImg = F.console();
  obj(consoleImg, 3 * T, 7 * T - 24, 7 * T - 2, (ctx, env) => {
    // tela da esquerda espelha o estado mais urgente do escritório
    drawScreen(ctx, 3 * T + 3, 7 * T - 23, 11, 8, CONSOLE_MODE[env.dominant] || 'idle', env.t, 77);
    // gráfico de atividade (barras)
    const x0 = 3 * T + 18;
    const y0 = 7 * T - 23;
    ctx.fillStyle = '#0f1726';
    ctx.fillRect(x0, y0, 11, 8);
    const bars = env.spark || [];
    for (let i = 0; i < 11; i++) {
      const v = Math.min(7, bars[bars.length - 11 + i] || 0);
      ctx.fillStyle = i === 10 ? P.yellow : P.cyan;
      ctx.fillRect(x0 + i, y0 + 8 - Math.max(1, v), 1, Math.max(1, v));
    }
  });
  block(3, 6, 2, 1);
  obj(F.chairBack(P.chair), 3 * T + 8, 7 * T + 2, 7 * T + 11);
  block(3, 7, 2, 1);

  // ── Cozinha (cols 26–32, linhas 3–8) ──────────────────────────────
  obj(F.counter(48), 26 * T, 4 * T - 22, 4 * T - 1, (ctx, env) => {
    // vapor da cafeteira quando alguém está pegando café
    if (env.coffeeBusy) {
      const t = env.t / 200;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (let i = 0; i < 3; i++) {
        const yy = 4 * T - 40 - ((t * 3 + i * 4) % 10);
        ctx.fillRect(26 * T + 7 + Math.round(Math.sin(t + i) * 1.5), yy, 1, 2);
      }
    }
  });
  obj(F.coffeeMachine(), 26 * T + 1, 4 * T - 36, 4 * T);
  obj(F.sink(), 26 * T + 17, 4 * T - 21, 4 * T);
  obj(F.microwave(), 26 * T + 33, 4 * T - 28, 4 * T);
  block(26, 3, 3, 1);
  obj(F.fridge(), 29 * T, 4 * T - 38, 4 * T - 1);
  block(29, 3, 1, 1);
  obj(F.vending(), 30 * T + 4, 4 * T - 40, 4 * T - 1, null, { light: { x: 31 * T, y: 4 * T - 22, r: 26, color: '#ff7a6b', a: 0.22 } });
  block(30, 3, 2, 1);
  obj(F.waterCooler(), 32 * T + 2, 4 * T - 28, 4 * T - 1);
  block(32, 3, 1, 1);
  obj(F.roundTable(), 28 * T + 3, 7 * T - 18, 7 * T - 1);
  block(28, 6, 2, 1);
  obj(F.stool(), 27 * T + 3, 7 * T - 10, 7 * T - 2);
  obj(F.stool(), 30 * T + 3, 7 * T - 10, 7 * T - 2);
  obj(F.plant('mid'), 32 * T, 9 * T - 22, 9 * T - 1);
  block(32, 8, 1, 1);
  obj(F.trash(), 26 * T + 3, 9 * T - 12, 9 * T - 1);
  block(26, 8, 1, 1);

  spot('coffee', 'coffee', 26, 4, { facing: 'up', pose: 'stand', x: 26 * T + 8, y: 4 * T + 12 });
  spot('cooler', 'cooler', 32, 4, { facing: 'up', pose: 'stand', x: 32 * T + 8, y: 4 * T + 12 });
  spot('vending', 'vending', 30, 4, { facing: 'up', pose: 'stand', x: 31 * T, y: 4 * T + 12 });
  spot('kstool0', 'stool', 27, 7, { facing: 'down', pose: 'coffee', x: 27 * T + 8, y: 7 * T + 4 });
  spot('kstool1', 'stool', 30, 7, { facing: 'down', pose: 'coffee', x: 30 * T + 8, y: 7 * T + 4 });

  // ── Lounge (cols 26–32, linhas 12–17) ─────────────────────────────
  obj(F.rug(80, 56, P.rug, P.rugLo), 27 * T, 13 * T + 4, 0, null, { floor: true });
  obj(F.bookshelf(32), 26 * T, 13 * T - 36, 13 * T - 1);
  block(26, 12, 2, 1);
  obj(F.tvCabinet(), 28 * T + 4, 13 * T - 12, 13 * T - 1);
  block(28, 12, 3, 1);
  obj(F.arcade(), 32 * T - 1, 13 * T - 40, 13 * T - 1, (ctx, env) => {
    // tela do fliperama: "space invaders"
    const x0 = 32 * T + 3;
    const y0 = 13 * T - 30;
    ctx.fillStyle = '#0b0f1c';
    ctx.fillRect(x0, y0, 10, 9);
    const t = Math.floor(env.t / 300);
    ctx.fillStyle = P.greenHi;
    for (let i = 0; i < 3; i++) ctx.fillRect(x0 + 1 + i * 3 + (t % 2), y0 + 1 + (t % 3 === 0 ? 1 : 0), 2, 1);
    ctx.fillStyle = P.pink;
    ctx.fillRect(x0 + 1 + ((t * 2) % 8), y0 + 7, 2, 1);
    ctx.fillStyle = P.yellow;
    ctx.fillRect(x0 + 2 + ((t * 2) % 8), y0 + 3 + (t % 4), 1, 1);
  }, { light: { x: 32 * T + 8, y: 13 * T - 25, r: 20, color: '#c06cff', a: 0.25 } });
  block(32, 12, 1, 1);
  obj(F.coffeeTable(), 28 * T + 4, 14 * T - 12, 14 * T - 1);
  block(28, 13, 3, 1);
  obj(F.sofaBack(48), 28 * T, 16 * T - 18, 16 * T);
  block(28, 15, 3, 1);
  obj(F.beanbag(P.purple), 26 * T - 1, 15 * T - 12, 15 * T - 3);
  obj(F.beanbag(P.cyan), 31 * T + 3, 15 * T - 12, 15 * T - 3);
  obj(F.plant('tall'), 32 * T, 18 * T - 30, 18 * T - 1);
  block(32, 17, 1, 1);
  obj(F.plant('mid'), 26 * T, 18 * T - 22, 18 * T - 1);
  block(26, 17, 1, 1);

  for (let i = 0; i < 3; i++) {
    spot('sofa' + i, 'sofa', 28 + i, 15, { facing: 'up', pose: 'sit', x: (28 + i) * T + 8, y: 15 * T + 10, access: { tx: 28 + i, ty: 16 } });
  }
  spot('bean0', 'bean', 26, 14, { facing: 'down', pose: 'sofa', x: 26 * T + 7, y: 14 * T + 14 });
  spot('bean1', 'bean', 31, 14, { facing: 'down', pose: 'sofa', x: 31 * T + 11, y: 14 * T + 14 });
  spot('arcade', 'arcade', 32, 13, { facing: 'up', pose: 'stand', x: 32 * T + 8, y: 13 * T + 12 });

  // ── Sala de reunião (cols 1–7, linhas 12–17) ──────────────────────
  obj(F.meetingTable(64), 2 * T, 15 * T - 34, 15 * T - 2);
  block(2, 13, 4, 2);
  for (let i = 0; i < 4; i++) {
    obj(F.chairSmall('down'), (2 + i) * T + 2, 13 * T - 13, 13 * T - 6);
    obj(F.chairSmall('up'), (2 + i) * T + 2, 15 * T + 2, 15 * T + 14);
    spot('meet' + i, 'meeting', 2 + i, 12, { facing: 'down', pose: 'sit', x: (2 + i) * T + 8, y: 13 * T - 1 });
    spot('meet' + (i + 4), 'meeting', 2 + i, 15, { facing: 'up', pose: 'sit', x: (2 + i) * T + 8, y: 15 * T + 11 });
  }
  obj(F.plant('tall'), 7 * T, 13 * T - 30, 13 * T - 1);
  block(7, 12, 1, 1);
  obj(F.plant('mid'), 1 * T, 18 * T - 22, 18 * T - 1);
  block(1, 17, 1, 1);

  // ── Open space: área comum (linhas 11–16) ─────────────────────────
  obj(F.pingPong(), 10 * T, 12 * T + 2, 14 * T - 2);
  block(10, 12, 3, 2);
  spot('pong0', 'pong', 9, 12, { facing: 'right', pose: 'stand', x: 9 * T + 10, y: 13 * T + 4 });
  spot('pong1', 'pong', 13, 12, { facing: 'left', pose: 'stand', x: 13 * T + 6, y: 13 * T + 4 });
  obj(F.whiteboard(), 15 * T + 4, 13 * T - 34, 13 * T - 1);
  block(15, 12, 3, 1);
  obj(F.standTable(), 15 * T + 7, 15 * T - 22, 15 * T - 1);
  block(15, 14, 3, 1);
  spot('stand0', 'stand', 15, 15, { facing: 'up', pose: 'stand', x: 15 * T + 12, y: 15 * T + 10 });
  spot('stand1', 'stand', 17, 15, { facing: 'up', pose: 'stand', x: 17 * T + 4, y: 15 * T + 10 });
  spot('stand2', 'stand', 14, 14, { facing: 'right', pose: 'stand', x: 14 * T + 10, y: 14 * T + 12 });
  spot('stand3', 'stand', 18, 14, { facing: 'left', pose: 'stand', x: 18 * T + 6, y: 14 * T + 12 });

  // Canto do build: TV num pedestal mostrando o pipeline + pufes.
  obj(F.rug(80, 64, '#3a4d74', '#2f3f60'), 19 * T + 8, 11 * T + 8, 0, null, { floor: true });
  const tvStand = F.sprite('tvstand', 44, 36, (p) => {
    p.rect(0, 0, 44, 26, P.ink);
    p.rect(1, 1, 42, 24, P.bezel);
    p.rect(2, 2, 40, 21, P.screenOff);
    p.rect(20, 26, 4, 7, P.ink);
    p.rect(21, 26, 2, 7, P.stand);
    p.rect(12, 33, 20, 3, P.ink);
  });
  obj(tvStand, 20 * T + 10, 13 * T - 36, 13 * T - 1, (ctx, env) => drawPipeline(ctx, 20 * T + 12, 13 * T - 34, 40, 21, env), {
    light: { x: 22 * T + 8, y: 13 * T - 24, r: 30, color: '#5fb3ff', a: 0.2 }
  });
  block(21, 12, 3, 1);
  obj(F.beanbag(P.orange), 20 * T + 4, 16 * T - 12, 16 * T - 3);
  obj(F.beanbag(P.green), 23 * T - 2, 16 * T - 12, 16 * T - 3);
  spot('buildbean0', 'bean', 20, 15, { facing: 'down', pose: 'sofa', x: 20 * T + 13, y: 15 * T + 14 });
  spot('buildbean1', 'bean', 23, 15, { facing: 'down', pose: 'sofa', x: 23 * T + 7, y: 15 * T + 14 });

  // plantas, impressora, bebedouro
  obj(F.plant('tall'), 9 * T, 4 * T - 30, 4 * T - 1);
  block(9, 3, 1, 1);
  obj(F.plant('tall'), 24 * T, 4 * T - 30, 4 * T - 1);
  block(24, 3, 1, 1);
  obj(F.printer(), 9 * T - 1, 11 * T - 20, 11 * T - 1);
  block(9, 10, 1, 1);
  obj(F.waterCooler(), 24 * T + 2, 11 * T - 28, 11 * T - 1);
  block(24, 10, 1, 1);
  spot('cooler2', 'cooler', 24, 11, { facing: 'up', pose: 'stand', x: 24 * T + 8, y: 11 * T + 12 });
  obj(F.plant('mid'), 14 * T, 18 * T - 22, 18 * T - 1);
  block(14, 17, 1, 1);
  obj(F.plant('mid'), 19 * T, 18 * T - 22, 18 * T - 1);
  block(19, 17, 1, 1);
  obj(F.doormat(), 16 * T, 17 * T + 2, 0, null, { floor: true });
  obj(F.trash(), 9 * T + 3, 18 * T - 12, 18 * T - 1);
  block(9, 17, 1, 1);

  // Pato de borracha gigante: debugging de patinho, claro.
  const duck = F.sprite('duck', 20, 22, (p) => {
    p.rect(3, 13, 14, 9, P.ink);
    p.rect(4, 14, 12, 7, '#6b5a8a');
    p.rect(4, 14, 12, 1, '#8575a6');
    p.rect(5, 2, 9, 9, P.ink);
    p.rect(3, 7, 15, 8, P.ink);
    p.rect(6, 3, 7, 7, '#ffd23f');
    p.rect(4, 8, 13, 6, '#ffd23f');
    p.rect(6, 3, 3, 2, '#ffe680');
    p.rect(12, 9, 4, 3, '#f28c28');
    p.px(10, 5, P.ink);
    p.rect(5, 12, 11, 1, '#e0b020');
  });
  obj(duck, 23 * T - 2, 18 * T - 22, 18 * T - 1);
  block(23, 17, 1, 1);

  // ── Entrada e pontos ──────────────────────────────────────────────
  const entrance = { tx: 16, ty: 18, x: 16 * T + 16, y: 18 * T + 12 };

  // ── Iluminação fixa ───────────────────────────────────────────────
  const lights = [];
  for (const o of objects) if (o.light) lights.push(o.light);

  // ── Céu por hora do dia ───────────────────────────────────────────
  function skyFor(hour) {
    if (hour >= 6 && hour < 8) return { top: '#f4a582', bottom: '#fbd8a8', city: '#7a6a8a', lit: 0.25, stars: false, sun: '#fff0b0' };
    if (hour >= 8 && hour < 17) return { top: '#79bff0', bottom: '#cdeaf9', city: '#8aa4c2', lit: 0, stars: false, sun: null };
    if (hour >= 17 && hour < 19) return { top: '#6d5b9c', bottom: '#f39b6d', city: '#4a3f63', lit: 0.45, stars: false, sun: '#ffcf6b' };
    return { top: '#0e1330', bottom: '#243463', city: '#1a2140', lit: 0.8, stars: true, sun: null };
  }

  function drawWindow(p, ctx, x, y, w, h, sky, seed) {
    p.rect(x - 1, y - 1, w + 2, h + 2, P.ink);
    // gradiente em faixas (pixelado)
    const bands = 6;
    for (let i = 0; i < bands; i++) {
      p.rect(x, y + Math.floor((i * h) / bands), w, Math.ceil(h / bands), mix(sky.top, sky.bottom, i / (bands - 1)));
    }
    const r = rng(seed);
    if (sky.stars) {
      for (let i = 0; i < 8; i++) p.px(x + Math.floor(r() * w), y + Math.floor(r() * (h * 0.5)), '#e8ecff');
      p.rect(x + w - 8, y + 3, 3, 3, '#f3f0d0');
      p.px(x + w - 8, y + 3, sky.top);
    } else if (sky.sun) {
      p.rect(x + w - 10, y + h - 12, 4, 4, sky.sun);
    }
    // skyline
    let bx = x;
    while (bx < x + w) {
      const bw = 4 + Math.floor(r() * 6);
      const bh = 6 + Math.floor(r() * (h * 0.55));
      p.rect(bx, y + h - bh, Math.min(bw, x + w - bx), bh, sky.city);
      if (sky.lit > 0) {
        for (let wy = y + h - bh + 2; wy < y + h - 1; wy += 2) {
          for (let wx = bx + 1; wx < Math.min(bx + bw - 1, x + w); wx += 2) {
            if (r() < sky.lit * 0.5) p.px(wx, wy, '#ffd98a');
          }
        }
      }
      bx += bw;
    }
    // caixilho em cruz + peitoril
    p.rect(x + (w >> 1), y, 1, h, P.metalHi);
    p.rect(x, y + (h >> 1) - 2, w, 1, P.metalHi);
    p.rect(x - 2, y + h + 1, w + 4, 2, P.metalHi);
    p.hline(x - 2, y + h + 3, w + 4, P.ink);
    void ctx;
  }

  // ── Camada estática: piso, paredes, faces e decoração de parede ────
  function buildStatic(hour) {
    const c = canvas(PX_W, PX_H);
    const ctx = ctx2d(c);
    const p = new Painter(ctx);
    p.rect(0, 0, PX_W, PX_H, P.void);

    const r = rng(1337);
    // pisos
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const room = roomAt(x, y);
        const cell = at(x, y);
        if (!room || cell === '=' || cell === '#') continue;
        drawFloorTile(p, x, y, room, r);
      }
    }
    // tábuas de madeira contínuas no open space (emendas alternadas)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (roomAt(x, y) === 'O' && at(x, y) !== '#' && at(x, y) !== '=') drawWoodSeams(p, x, y);
      }
    }
    // soleiras
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (at(x, y) === 'd') {
          // vão de porta: piso de cada sala até o meio + soleira metálica
          drawFloorTile(p, x, y, roomAt(x - 1, y), r);
          const half = canvas(T, T);
          drawFloorTile(new Painter(ctx2d(half)), 0, 0, roomAt(x + 1, y), r);
          ctx.drawImage(half, 8, 0, 8, T, x * T + 8, y * T, 8, T);
          p.rect(x * T + 7, y * T, 2, T, P.metalLo);
          p.vline(x * T + 7, y * T, T, P.metalHi);
          p.rect(x * T, y * T, T, 2, 'rgba(10,12,30,0.35)');
        }
        if (at(x, y) === 'e') {
          p.rect(x * T, y * T, T, T, '#8a95a8');
          p.rect(x * T, y * T, T, 2, P.metalHi);
          for (let i = 2; i < T; i += 4) p.hline(x * T, y * T + i + 2, T, '#7a8598');
        }
      }
    }
    // faces de parede
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (at(x, y) === '=') drawFace(p, x, y, roomAt(x, y));
      }
    }
    // topo das paredes
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (at(x, y) === '#') drawCap(p, x, y);
      }
    }
    // sombra projetada das paredes/faces no piso (1 faixa escura)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c0 = at(x, y);
        if (!(FLOOR_OF[c0] || c0 === 'd')) continue;
        const up = at(x, y - 1);
        if (up === '=' || up === '#') p.rect(x * T, y * T, T, 3, 'rgba(10,12,30,0.22)');
        const left = at(x - 1, y);
        if (left === '#') p.rect(x * T, y * T, 2, T, 'rgba(10,12,30,0.18)');
      }
    }

    decorateWalls(p, ctx, hour);

    // tapetes e capachos (objetos de piso)
    for (const o of objects) if (o.floor && o.img) ctx.drawImage(o.img, o.x, o.y);
    return c;
  }

  function drawFloorTile(p, x, y, room, r) {
    const X = x * T;
    const Y = y * T;
    switch (room) {
      case 'O': {
        for (let b = 0; b < 2; b++) {
          const shade = (x * 7 + y * 3 + b * 5) % 5;
          const col = shade === 0 ? P.woodAlt : shade === 3 ? P.woodHi : P.wood;
          p.rect(X, Y + b * 8, T, 8, col);
          p.hline(X, Y + b * 8 + 7, T, P.woodLine);
          if (r() < 0.25) p.px(X + Math.floor(r() * 14) + 1, Y + b * 8 + 3, P.woodAlt);
        }
        break;
      }
      case 'K': {
        const alt = (x + y) % 2 === 0;
        p.rect(X, Y, T, T, alt ? P.tile : P.tileAlt);
        p.hline(X, Y + T - 1, T, P.tileLine);
        p.vline(X + T - 1, Y, T, P.tileLine);
        p.px(X + 2, Y + 2, alt ? P.white : P.tile);
        break;
      }
      case 'S': {
        p.rect(X, Y, T, T, (x + y) % 2 ? P.techFloor : P.techFloorAlt);
        p.rect(X, Y, T, 1, P.techHi);
        p.rect(X, Y, 1, T, P.techHi);
        p.rect(X, Y + T - 1, T, 1, P.techLine);
        p.rect(X + T - 1, Y, 1, T, P.techLine);
        if ((x * 3 + y) % 4 === 0) {
          for (let j = 4; j < 12; j += 2) for (let i = 4; i < 12; i += 2) p.px(X + i, Y + j, P.techLine);
        }
        break;
      }
      case 'M': {
        p.rect(X, Y, T, T, (x + y) % 2 ? P.meetFloor : P.meetFloorAlt);
        if ((x + y) % 2 === 0) p.px(X + 8, Y + 8, P.meetLine);
        p.px(X + 3, Y + 12, P.meetLine);
        break;
      }
      case 'L': {
        p.rect(X, Y, T, T, (x + y) % 2 ? P.carpet : P.carpetAlt);
        p.px(X + 4, Y + 4, P.carpetHi);
        p.px(X + 12, Y + 12, P.carpetHi);
        p.px(X + 12, Y + 4, P.carpetLine);
        p.px(X + 4, Y + 12, P.carpetLine);
        break;
      }
    }
  }

  function drawWoodSeams(p, x, y) {
    const X = x * T;
    const Y = y * T;
    for (let b = 0; b < 2; b++) {
      const row = y * 2 + b;
      const off = (row * 11) % 32;
      const gx = x * T;
      for (let s = -32; s < T + 32; s += 32) {
        const sx = gx - (gx % 32) + s + off;
        if (sx >= X && sx < X + T) p.vline(sx, Y + b * 8, 7, P.woodLine);
      }
    }
  }

  const FACE_STYLE = {
    S: { base: '#2c3346', hi: '#363e54', lo: '#232a3b', trim: '#1c2130' },
    O: { base: P.wallFace, hi: P.wallFaceHi, lo: P.wallFaceLo, trim: P.wallTrim },
    K: { base: '#e6dfd2', hi: '#f2ede4', lo: '#d3c9b8', trim: '#b9ac95' },
    M: { base: '#4a3f63', hi: '#564a72', lo: '#3f3656', trim: '#2e2740' },
    L: { base: '#34466a', hi: '#3e5279', lo: '#2c3b5a', trim: '#222e47' }
  };

  function drawFace(p, x, y, room) {
    const s = FACE_STYLE[room] || FACE_STYLE.O;
    const X = x * T;
    const Y = y * T;
    const top = at(x, y - 1) !== '=';
    const bottom = at(x, y + 1) !== '=';
    p.rect(X, Y, T, T, s.base);
    if (room === 'K') {
      // azulejo de metrô na metade de baixo
      if (bottom) {
        for (let j = 0; j < 12; j += 4) {
          p.hline(X, Y + 2 + j, T, s.lo);
          const off = (j / 4) % 2 ? 4 : 0;
          for (let i = off; i < T; i += 8) p.vline(X + i, Y + 2 + j, 4, s.lo);
        }
      } else {
        p.rect(X, Y, T, T, '#8e6f52');
        p.rect(X, Y + 2, T, 11, '#a88563');
        p.hline(X, Y + 2, T, '#bf9a75');
        p.vline(X + 15, Y + 2, 11, '#7a5c42');
        p.rect(X + 6, Y + 8, 4, 1, P.metalHi);
        p.hline(X, Y + 13, T, '#5f4632');
        p.rect(X, Y + 14, T, 2, s.lo);
      }
    } else {
      if (top) {
        p.rect(X, Y, T, 3, s.lo);
        p.hline(X, Y + 3, T, s.hi);
      }
      // painéis verticais sutis
      if (x % 2 === 0) p.vline(X, Y + (top ? 4 : 0), bottom ? 11 : T, s.lo);
    }
    if (bottom) {
      p.rect(X, Y + T - 4, T, 4, s.trim);
      p.hline(X, Y + T - 4, T, s.hi);
    }
  }

  function drawCap(p, x, y) {
    const X = x * T;
    const Y = y * T;
    p.rect(X, Y, T, T, P.wallCap);
    const upC = at(x, y - 1);
    const downC = at(x, y + 1);
    const leftC = at(x - 1, y);
    const rightC = at(x + 1, y);
    if (upC !== '#') p.hline(X, Y, T, P.wallCapHi);
    // borda inferior: se abaixo não é parede, mostra a "espessura" da parede
    if (downC !== '#') {
      p.rect(X, Y + T - 5, T, 5, P.wallCapLo);
      p.hline(X, Y + T - 5, T, P.ink);
    }
    if (leftC !== '#' && leftC !== undefined) p.vline(X, Y, T, P.wallCapHi);
    if (rightC !== '#' && rightC !== undefined) p.vline(X + T - 1, Y, T, P.wallCapLo);
    // textura sutil
    if ((x + y) % 3 === 0) p.px(X + 5, Y + 6, P.wallCapHi);
  }

  // Decoração fixa das faces (janelas, letreiro, pôsteres, TVs).
  function decorateWalls(p, ctx, hour) {
    const sky = skyFor(hour);
    // open space: duas janelas grandes
    drawWindow(p, ctx, 10 * T + 2, T + 4, 42, 20, sky, 11);
    drawWindow(p, ctx, 21 * T + 4, T + 4, 42, 20, sky, 23);
    // letreiro neon (tubos; o brilho vem da luz dinâmica)
    const sx = 14 * T + 4;
    const sy = T + 5;
    p.rect(sx, sy, 88, 20, '#1c2236');
    p.rect(sx + 1, sy + 1, 86, 18, '#232b44');
    p.hline(sx + 1, sy + 1, 86, '#2d3756');
    neonText(ctx, 'SORYA', sx + 7, sy + 4, '#ffb38f', '#c96a47');
    neonText(ctx, 'DEV HUB', sx + 7, sy + 11, '#8ff0ff', '#2aa9c9');
    // ícone </>
    ctx.fillStyle = '#ffd479';
    AO.font.text(ctx, '</>', sx + 62, sy + 8, '#ffd479');
    // relógio (ponteiros são dinâmicos)
    p.rect(13 * T + 1, T + 6, 13, 13, P.ink);
    p.rect(13 * T + 2, T + 7, 11, 11, P.white);
    p.rect(13 * T + 2, T + 7, 11, 1, P.metalHi);
    // pôster
    p.rect(20 * T + 2, T + 6, 12, 16, P.ink);
    p.rect(20 * T + 3, T + 7, 10, 14, P.accent);
    AO.font.text(ctx, 'GO', 20 * T + 5, T + 9, P.white);
    p.rect(20 * T + 5, T + 16, 6, 3, P.yellow);

    // server room: placa + calhas de cabo + ar-condicionado
    p.rect(5 * T + 2, T + 4, 26, 9, P.ink);
    p.rect(5 * T + 3, T + 5, 24, 7, '#1a2233');
    AO.font.text(ctx, 'SRV', 5 * T + 5, T + 6, P.green);
    p.rect(5 * T + 20, T + 7, 2, 2, P.green);
    p.rect(1 * T, T + 1, 4 * T, 2, P.rackLo);
    const ac = F.acUnit();
    ctx.drawImage(ac, 6 * T + 8, T + 14, 16, 12);

    // cozinha: nada além dos armários (faces já pintadas)

    // sala de reunião: TV grande
    p.rect(3 * T - 2, 10 * T + 3, 52, 26, P.ink);
    p.rect(3 * T - 1, 10 * T + 4, 50, 24, P.bezel);
    p.rect(3 * T, 10 * T + 5, 48, 21, P.screenOff);
    // lounge: TV + quadro
    p.rect(28 * T + 2, 10 * T + 3, 44, 24, P.ink);
    p.rect(28 * T + 3, 10 * T + 4, 42, 22, P.bezel);
    p.rect(28 * T + 4, 10 * T + 5, 40, 19, P.screenOff);
    p.rect(26 * T + 3, 10 * T + 6, 22, 16, P.ink);
    p.rect(26 * T + 4, 10 * T + 7, 20, 14, '#f3e2c0');
    p.rect(26 * T + 5, 10 * T + 8, 18, 12, '#8fc6e8');
    p.rect(26 * T + 5, 10 * T + 15, 18, 5, '#6aa84f');
    p.rect(26 * T + 9, 10 * T + 12, 6, 4, '#4d8a3a');
    p.rect(26 * T + 17, 10 * T + 10, 3, 3, '#fff0b0');
    // troféus
    p.rect(31 * T + 2, 10 * T + 18, 12, 2, P.woodDeskDark);
    p.rect(31 * T + 3, 10 * T + 12, 4, 6, P.yellow);
    p.rect(31 * T + 9, 10 * T + 14, 3, 4, P.metalHi);
  }

  function neonText(ctx, str, x, y, tube, shadow) {
    AO.font.text(ctx, str, x + 1, y + 1, shadow);
    AO.font.text(ctx, str, x, y, tube);
  }

  // ── Fundo dinâmico: relógio, TVs e brilho do neon ──────────────────
  function drawDynamicBackground(ctx, env) {
    const p = new Painter(ctx);
    // relógio real
    const now = env.now;
    const cx = 13 * T + 7;
    const cy = T + 12;
    ctx.fillStyle = P.ink;
    const hAng = (((now.getHours() % 12) + now.getMinutes() / 60) / 12) * Math.PI * 2;
    const mAng = (now.getMinutes() / 60) * Math.PI * 2;
    for (let i = 1; i <= 3; i++) ctx.fillRect(Math.round(cx + Math.sin(hAng) * i), Math.round(cy - Math.cos(hAng) * i), 1, 1);
    ctx.fillStyle = P.accent;
    for (let i = 1; i <= 4; i++) ctx.fillRect(Math.round(cx + Math.sin(mAng) * i), Math.round(cy - Math.cos(mAng) * i), 1, 1);
    p.px(cx, cy, P.ink);

    // TV da sala de reunião: gráfico de atividade ao vivo
    const tx = 3 * T;
    const ty = 10 * T + 5;
    p.rect(tx, ty, 48, 21, '#101828');
    AO.font.text(ctx, 'LIVE', tx + 2, ty + 2, P.red);
    const bars = env.spark || [];
    for (let i = 0; i < 22; i++) {
      const v = Math.min(12, bars[bars.length - 22 + i] || 0);
      p.rect(tx + 3 + i * 2, ty + 19 - Math.max(1, v), 1, Math.max(1, v), i === 21 ? P.yellow : P.cyan);
    }
    AO.font.text(ctx, String(env.stats.active), tx + 34, ty + 2, P.greenHi);

    // TV do lounge: jogo de corrida simples
    const gx = 28 * T + 4;
    const gy = 10 * T + 5;
    p.rect(gx, gy, 40, 19, '#2a6f3a');
    p.rect(gx + 12, gy, 16, 19, '#555a66');
    const lane = Math.floor(env.t / 120) % 4;
    for (let i = 0; i < 5; i++) p.rect(gx + 19, gy + ((i * 5 + lane * 2) % 20), 2, 2, P.white);
    p.rect(gx + 14 + (Math.floor(env.t / 900) % 2) * 7, gy + 12, 4, 5, P.red);
    p.rect(gx + 21 - (Math.floor(env.t / 1300) % 2) * 7, gy + 3 + ((env.t / 60) % 10), 4, 5, P.yellow);
  }

  function drawPipeline(ctx, x, y, w, h, env) {
    const p = new Painter(ctx);
    p.rect(x, y, w, h, '#0f1726');
    AO.font.text(ctx, 'CI', x + 2, y + 2, P.metalHi);
    const s = env.stats;
    const stages = [
      { n: s.pending, c: P.metalHi },
      { n: s.runningTasks != null ? s.runningTasks : s.running, c: P.cyan },
      { n: s.done, c: P.green },
      { n: s.failed, c: P.red }
    ];
    for (let i = 0; i < 4; i++) {
      const bx = x + 2 + i * 10;
      const on = stages[i].n > 0;
      p.rect(bx, y + 9, 8, 6, on ? stages[i].c : '#26324a');
      if (i === 1 && on && Math.floor(env.t / 300) % 2) p.rect(bx, y + 9, 8, 6, lighten(P.cyan, 0.3));
      if (i < 3) p.rect(bx + 8, y + 11, 2, 1, '#3a4866');
      AO.font.text(ctx, String(Math.min(9, stages[i].n)), bx + 3, y + 16 - 0, P.white);
    }
    void h;
  }

  AO.world = {
    T,
    W,
    H,
    PX_W,
    PX_H,
    MAP,
    desks,
    spots,
    objects,
    lights,
    entrance,
    walkable,
    buildStatic,
    drawDynamicBackground,
    drawScreen,
    skyFor,
    roomAt,
    stateColor,
    darken,
    lighten
  };
})();
