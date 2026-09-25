// Mobília do dev hub em pixel art procedural. Cada peça é pintada uma vez
// num canvas próprio (cache) e desenhada por y-sort a cada quadro; partes
// animadas (telas, LEDs, vapor) são desenhadas por cima em tempo real.
(function () {
  'use strict';
  const AO = (window.AO = window.AO || {});
  const { canvas, ctx2d, Painter, darken, lighten, mix } = AO.px;
  const P = AO.PAL;

  const cache = new Map();

  /** Pinta (uma vez) e devolve o canvas de uma peça. */
  function sprite(key, w, h, paint) {
    let c = cache.get(key);
    if (c) return c;
    c = canvas(w, h);
    const ctx = ctx2d(c);
    paint(new Painter(ctx), ctx);
    cache.set(key, c);
    return c;
  }

  // ── Mesa de trabalho (2 tiles) ─────────────────────────────────────
  // Tampo claro (mesas brancas de estúdio) com frente em madeira.
  function desk() {
    return sprite('desk', 32, 18, (p) => {
      p.rect(0, 1, 32, 12, P.ink);
      p.rect(1, 0, 30, 1, P.ink);
      p.rect(1, 1, 30, 10, P.deskTop);
      p.hline(1, 1, 30, P.deskTopHi);
      p.hline(1, 10, 30, P.deskEdge);
      // frente
      p.rect(1, 11, 30, 4, P.woodDesk);
      p.hline(1, 11, 30, P.woodDeskDark);
      p.hline(1, 14, 30, P.woodDeskFront);
      p.rect(0, 11, 1, 5, P.ink);
      p.rect(31, 11, 1, 5, P.ink);
      p.hline(1, 15, 30, P.ink);
      // pés
      p.rect(2, 15, 2, 3, P.deskLeg);
      p.rect(28, 15, 2, 3, P.deskLeg);
      p.px(2, 17, P.ink);
      p.px(29, 17, P.ink);
    });
  }









  function mug(color) {
    return sprite('mug' + color, 5, 5, (p) => {
      p.rect(0, 0, 4, 5, P.ink);
      p.rect(1, 1, 2, 3, color);
      p.px(1, 1, lighten(color, 0.4));
      p.rect(4, 1, 1, 3, P.ink);
    });
  }

  // ── Cadeiras ──────────────────────────────────────────────────────
  // Cadeira gamer vista de frente (encosto atrás do agente) — accent opcional.
  function chairFront(accent) {
    return sprite('chairF' + accent, 16, 20, (p) => {
      // encosto
      p.rect(3, 0, 10, 12, P.ink);
      p.rect(4, 1, 8, 10, P.chair);
      p.rect(4, 1, 8, 2, P.chairHi);
      p.rect(7, 3, 2, 7, accent);
      // assento
      p.rect(2, 11, 12, 5, P.ink);
      p.rect(3, 12, 10, 3, P.chairHi);
      p.hline(3, 14, 10, P.chair);
      // coluna + rodízios
      p.rect(7, 16, 2, 2, P.ink);
      p.rect(3, 18, 10, 2, P.ink);
      p.rect(4, 18, 8, 1, P.chairLo);
    });
  }

  // Cadeira vista de costas (encosto na frente do agente).
  function chairBack(accent) {
    return sprite('chairB' + accent, 16, 16, (p) => {
      p.rect(3, 0, 10, 11, P.ink);
      p.rect(4, 1, 8, 9, P.chair);
      p.rect(4, 1, 8, 1, P.chairHi);
      p.rect(7, 2, 2, 7, accent);
      p.rect(7, 11, 2, 2, P.ink);
      p.rect(3, 13, 10, 2, P.ink);
      p.rect(4, 13, 8, 1, P.chairLo);
    });
  }

  // ── Plantas ───────────────────────────────────────────────────────
  function plant(kind) {
    const key = 'plant' + kind;
    if (kind === 'tall') {
      return sprite(key, 16, 30, (p) => {
        const leaves = [
          [7, 0, 3, 5], [4, 3, 4, 6], [9, 3, 4, 6], [2, 8, 5, 5], [9, 8, 5, 5],
          [5, 7, 6, 8], [3, 13, 4, 4], [9, 13, 4, 4], [6, 14, 4, 5]
        ];
        for (const [x, y, w, h] of leaves) p.rect(x - 1, y - 1, w + 2, h + 2, P.ink);
        for (const [x, y, w, h] of leaves) p.rect(x, y, w, h, P.leaf);
        for (const [x, y] of [[8, 1], [5, 4], [10, 4], [3, 9], [10, 9], [7, 8], [4, 14], [10, 14], [7, 15]]) {
          p.px(x, y, P.leafHi);
          p.px(x + 1, y + 2, P.leafLo);
        }
        p.rect(4, 20, 8, 10, P.ink);
        p.rect(5, 21, 6, 8, P.pot);
        p.rect(5, 21, 6, 1, P.white);
        p.rect(9, 22, 2, 7, P.potLo);
        p.rect(3, 19, 10, 3, P.ink);
        p.rect(4, 20, 8, 1, P.potLo);
      });
    }
    if (kind === 'desk') {
      return sprite(key, 8, 10, (p) => {
        p.rect(1, 0, 6, 6, P.ink);
        p.rect(0, 2, 8, 3, P.ink);
        p.rect(2, 1, 4, 4, P.leaf);
        p.rect(1, 3, 6, 1, P.leaf);
        p.px(3, 1, P.leafHi);
        p.px(5, 3, P.leafLo);
        p.rect(1, 5, 6, 5, P.ink);
        p.rect(2, 6, 4, 3, P.potTerra);
        p.px(5, 6, P.potTerraLo);
      });
    }
    // arbusto médio
    return sprite(key, 16, 22, (p) => {
      const blobs = [[4, 1, 8, 6], [1, 4, 6, 6], [9, 4, 6, 6], [3, 7, 10, 6]];
      for (const [x, y, w, h] of blobs) p.rect(x - 1, y - 1, w + 2, h + 2, P.ink);
      for (const [x, y, w, h] of blobs) p.rect(x, y, w, h, P.leaf);
      for (const [x, y] of [[6, 2], [3, 5], [11, 5], [8, 8], [5, 9]]) {
        p.px(x, y, P.leafHi);
        p.px(x + 1, y + 1, P.leafHi);
        p.px(x + 2, y + 3, P.leafLo);
      }
      p.rect(3, 13, 10, 9, P.ink);
      p.rect(4, 14, 8, 7, P.potTerra);
      p.rect(4, 14, 8, 1, lighten(P.potTerra, 0.25));
      p.rect(10, 15, 2, 6, P.potTerraLo);
    });
  }

  // ── Server room ───────────────────────────────────────────────────
  function rack() {
    return sprite('rack', 16, 38, (p) => {
      p.rect(0, 0, 16, 38, P.ink);
      p.rect(1, 1, 14, 36, P.rack);
      p.rect(1, 1, 14, 2, P.rackHi);
      for (let i = 0; i < 7; i++) {
        const y = 5 + i * 4;
        p.rect(2, y, 12, 3, P.rackLo);
        p.hline(2, y, 12, P.rackHi);
        p.rect(3, y + 1, 5, 1, P.ink2);
      }
      p.rect(1, 34, 14, 3, P.rackLo);
    });
  }

  function console() {
    return sprite('console', 32, 26, (p) => {
      // mesa escura com dois monitores de monitoramento
      p.rect(0, 12, 32, 10, P.ink);
      p.rect(1, 13, 30, 6, P.rackHi);
      p.hline(1, 13, 30, P.techHi);
      p.rect(1, 19, 30, 2, P.rack);
      p.rect(2, 21, 2, 5, P.ink);
      p.rect(28, 21, 2, 5, P.ink);
      p.rect(2, 0, 13, 11, P.ink);
      p.rect(17, 0, 13, 11, P.ink);
      p.rect(3, 1, 11, 8, P.screenOff);
      p.rect(18, 1, 11, 8, P.screenOff);
      p.rect(8, 11, 2, 2, P.stand);
      p.rect(23, 11, 2, 2, P.stand);
    });
  }

  function acUnit() {
    return sprite('ac', 16, 20, (p) => {
      p.rect(0, 0, 16, 20, P.ink);
      p.rect(1, 1, 14, 18, P.metalHi);
      p.rect(1, 1, 14, 2, P.white);
      for (let y = 5; y < 16; y += 2) p.hline(3, y, 10, P.metal);
      p.rect(11, 3, 3, 1, P.cyan);
    });
  }

  // ── Cozinha ───────────────────────────────────────────────────────
  function counter(w) {
    return sprite('counter' + w, w, 22, (p) => {
      p.rect(0, 2, w, 20, P.ink);
      p.rect(1, 3, w - 2, 6, P.metalHi);
      p.hline(1, 3, w - 2, P.white);
      p.rect(1, 9, w - 2, 12, P.woodDesk);
      p.hline(1, 9, w - 2, P.woodDeskDark);
      for (let x = 1; x < w - 1; x += 16) {
        p.vline(x + 15, 10, 11, P.woodDeskDark);
        p.rect(x + 6, 12, 4, 1, P.metal);
      }
      p.hline(1, 20, w - 2, P.woodDeskDark);
    });
  }

  function coffeeMachine() {
    return sprite('coffee', 14, 18, (p) => {
      p.rect(0, 0, 14, 18, P.ink);
      p.rect(1, 1, 12, 16, '#3a3036');
      p.rect(1, 1, 12, 3, '#4d4148');
      p.rect(3, 6, 8, 7, P.ink);
      p.rect(4, 7, 6, 5, '#1f1a1f');
      p.rect(9, 2, 2, 1, P.red);
      p.rect(5, 10, 4, 2, P.white);
      p.rect(2, 14, 10, 2, '#4d4148');
    });
  }

  function sink() {
    return sprite('sink', 14, 8, (p) => {
      p.rect(0, 2, 14, 6, P.ink);
      p.rect(1, 3, 12, 4, P.metal);
      p.rect(2, 4, 10, 2, P.metalLo);
      p.rect(6, 0, 2, 3, P.ink);
      p.px(6, 0, P.metalHi);
      p.rect(8, 0, 2, 1, P.ink);
    });
  }

  function microwave() {
    return sprite('micro', 14, 10, (p) => {
      p.rect(0, 0, 14, 10, P.ink);
      p.rect(1, 1, 12, 8, P.white);
      p.rect(2, 2, 8, 6, P.ink2);
      p.rect(3, 3, 6, 4, '#3b4a5c');
      p.rect(11, 2, 1, 1, P.green);
      p.rect(11, 4, 1, 3, P.metal);
    });
  }

  function fridge() {
    return sprite('fridge', 16, 38, (p) => {
      p.rect(0, 0, 16, 38, P.ink);
      p.rect(1, 1, 14, 36, P.metalHi);
      p.rect(1, 1, 14, 2, P.white);
      p.hline(1, 13, 14, P.metal);
      p.rect(12, 5, 1, 6, P.metalLo);
      p.rect(12, 16, 1, 10, P.metalLo);
      // ímãs e post-its
      p.rect(3, 6, 3, 3, P.yellow);
      p.rect(4, 17, 3, 3, P.pink);
      p.rect(7, 20, 3, 3, P.cyan);
      p.rect(1, 34, 14, 3, P.metal);
    });
  }

  function vending() {
    return sprite('vending', 24, 40, (p) => {
      p.rect(0, 0, 24, 40, P.ink);
      p.rect(1, 1, 22, 38, '#c9463d');
      p.rect(1, 1, 22, 3, '#e05a4f');
      p.rect(3, 6, 13, 26, P.ink);
      p.rect(4, 7, 11, 24, '#20303d');
      const cans = [P.cyan, P.yellow, P.green, P.orange, P.pink, P.blue];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 3; c++) {
          const col = cans[(r * 3 + c) % cans.length];
          p.rect(5 + c * 3, 8 + r * 6, 2, 4, col);
          p.px(5 + c * 3, 8 + r * 6, lighten(col, 0.5));
        }
        p.hline(4, 13 + r * 6, 11, P.metalLo);
      }
      p.rect(17, 7, 4, 8, P.ink);
      p.rect(18, 8, 2, 3, P.cyan);
      p.rect(18, 12, 2, 2, P.metal);
      p.rect(3, 33, 13, 4, P.ink);
      p.rect(4, 34, 11, 2, '#1a1a22');
      p.rect(17, 18, 4, 1, P.metalHi);
    });
  }

  function waterCooler() {
    return sprite('cooler', 12, 28, (p) => {
      p.rect(2, 0, 8, 11, P.ink);
      p.rect(3, 1, 6, 9, '#8fd3f4');
      p.rect(4, 2, 1, 6, '#c9ecfb');
      p.rect(0, 11, 12, 17, P.ink);
      p.rect(1, 12, 10, 15, P.white);
      p.rect(1, 12, 10, 2, P.metalHi);
      p.rect(3, 16, 2, 2, P.blue);
      p.rect(7, 16, 2, 2, P.red);
      p.rect(2, 22, 8, 3, P.metalHi);
    });
  }

  function roundTable() {
    return sprite('rtable', 26, 20, (p) => {
      p.rect(2, 0, 22, 12, P.ink);
      p.rect(0, 2, 26, 8, P.ink);
      p.rect(3, 1, 20, 10, P.woodDeskHi);
      p.rect(1, 3, 24, 6, P.woodDeskHi);
      p.rect(3, 9, 20, 2, P.woodDesk);
      p.rect(11, 12, 4, 6, P.ink);
      p.rect(12, 12, 2, 6, P.woodDeskDark);
      p.rect(7, 18, 12, 2, P.ink);
    });
  }

  function stool() {
    return sprite('stool', 10, 12, (p) => {
      p.rect(0, 0, 10, 5, P.ink);
      p.rect(1, 1, 8, 3, P.accent);
      p.hline(1, 1, 8, P.accentHi);
      p.rect(4, 5, 2, 5, P.ink);
      p.rect(1, 10, 8, 2, P.ink);
    });
  }

  // ── Lounge ────────────────────────────────────────────────────────
  // Sofá visto de costas (virado para a TV na parede do fundo).
  function sofaBack(w) {
    return sprite('sofaB' + w, w, 20, (p) => {
      p.rect(0, 0, w, 20, P.ink);
      p.rect(1, 1, w - 2, 18, P.sofa);
      p.rect(1, 1, w - 2, 3, P.sofaHi);
      p.rect(1, 12, w - 2, 7, P.sofaLo);
      for (let x = Math.floor(w / 3); x < w - 4; x += Math.floor(w / 3)) p.vline(x, 4, 8, P.sofaLo);
      p.rect(0, 4, 4, 15, P.ink);
      p.rect(1, 5, 2, 13, P.sofaHi);
      p.rect(w - 4, 4, 4, 15, P.ink);
      p.rect(w - 3, 5, 2, 13, P.sofaHi);
    });
  }

  function beanbag(color) {
    return sprite('bean' + color, 18, 14, (p) => {
      p.rect(2, 0, 14, 14, P.ink);
      p.rect(0, 3, 18, 9, P.ink);
      p.rect(3, 1, 12, 12, color);
      p.rect(1, 4, 16, 7, color);
      p.rect(4, 2, 5, 3, lighten(color, 0.3));
      p.rect(3, 10, 12, 2, darken(color, 0.25));
    });
  }

  function coffeeTable() {
    return sprite('ctable', 40, 14, (p) => {
      p.rect(0, 0, 40, 10, P.ink);
      p.rect(1, 1, 38, 6, P.woodDeskHi);
      p.hline(1, 1, 38, lighten(P.woodDeskHi, 0.3));
      p.rect(1, 7, 38, 2, P.woodDesk);
      p.rect(2, 10, 2, 4, P.ink);
      p.rect(36, 10, 2, 4, P.ink);
      // revistas + controle
      p.rect(6, 2, 7, 4, P.white);
      p.rect(7, 3, 5, 1, P.blue);
      p.rect(26, 3, 6, 3, P.ink2);
      p.px(27, 4, P.red);
      p.px(29, 4, P.green);
    });
  }

  function arcade() {
    return sprite('arcade', 18, 40, (p) => {
      p.rect(0, 0, 18, 40, P.ink);
      p.rect(1, 1, 16, 38, '#3b2d6b');
      p.rect(1, 1, 16, 6, '#e05a9f');
      p.rect(3, 2, 12, 4, '#ffd479');
      p.rect(3, 9, 12, 11, P.ink);
      p.rect(4, 10, 10, 9, '#0b0f1c');
      p.rect(1, 21, 16, 6, '#2a2050');
      p.rect(4, 22, 2, 2, P.red);
      p.rect(8, 23, 2, 2, P.cyan);
      p.rect(11, 23, 2, 2, P.yellow);
      p.rect(2, 28, 14, 10, '#2a2050');
      p.rect(6, 31, 6, 4, P.ink);
      p.rect(7, 32, 4, 2, P.yellow);
    });
  }

  function bookshelf(w) {
    return sprite('shelf' + w, w, 36, (p, ctx) => {
      p.rect(0, 0, w, 36, P.ink);
      p.rect(1, 1, w - 2, 34, P.woodDeskDark);
      p.rect(1, 1, w - 2, 2, P.woodDesk);
      const colors = [P.red, P.blue, P.green, P.yellow, P.purple, P.orange, P.cyan, P.pink, P.white];
      const rand = AO.px.rng(w * 7 + 3);
      for (let s = 0; s < 3; s++) {
        const y = 4 + s * 10;
        p.rect(2, y, w - 4, 8, '#3a2618');
        let x = 3;
        while (x < w - 4) {
          const bw = 1 + Math.floor(rand() * 3);
          const bh = 5 + Math.floor(rand() * 3);
          const c = colors[Math.floor(rand() * colors.length)];
          if (rand() < 0.15) {
            x += 2;
            continue;
          }
          p.rect(x, y + 8 - bh, bw, bh, c);
          p.px(x, y + 8 - bh, lighten(c, 0.35));
          x += bw + (rand() < 0.3 ? 1 : 0);
        }
        p.hline(1, y + 8, w - 2, P.woodDesk);
      }
      void ctx;
    });
  }

  function tvCabinet() {
    return sprite('tvcab', 40, 12, (p) => {
      p.rect(0, 0, 40, 12, P.ink);
      p.rect(1, 1, 38, 4, P.woodDeskHi);
      p.rect(1, 5, 38, 6, P.woodDesk);
      p.vline(20, 5, 6, P.woodDeskDark);
      p.rect(6, 1, 10, 3, P.ink2);
      p.rect(24, 2, 8, 2, P.white);
    });
  }

  // ── Área comum ────────────────────────────────────────────────────
  function pingPong() {
    return sprite('pingpong', 48, 30, (p) => {
      p.rect(0, 0, 48, 24, P.ink);
      p.rect(1, 1, 46, 21, '#2f7d5a');
      p.rect(1, 1, 46, 1, '#3f9a70');
      p.vline(1, 1, 21, P.white);
      p.vline(46, 1, 21, P.white);
      p.hline(1, 1, 46, P.white);
      p.hline(1, 21, 46, P.white);
      p.hline(2, 11, 44, 'rgba(255,255,255,0.5)');
      // rede
      p.rect(23, -1 + 1, 2, 22, P.ink);
      p.rect(23, 1, 2, 20, P.metalHi);
      p.rect(1, 22, 46, 2, '#1f5c40');
      p.rect(3, 24, 2, 6, P.ink);
      p.rect(43, 24, 2, 6, P.ink);
      p.rect(22, 24, 4, 5, P.ink);
    });
  }

  function whiteboard() {
    return sprite('wboard', 40, 34, (p, ctx) => {
      p.rect(0, 0, 40, 26, P.ink);
      p.rect(1, 1, 38, 24, P.metalHi);
      p.rect(2, 2, 36, 21, P.white);
      // rabiscos de arquitetura
      p.rect(5, 5, 8, 5, P.blue);
      p.rect(6, 6, 6, 3, P.white);
      p.rect(25, 5, 9, 5, P.accent);
      p.rect(26, 6, 7, 3, P.white);
      p.hline(13, 7, 12, P.ink2);
      p.px(24, 6, P.ink2);
      p.px(24, 8, P.ink2);
      p.rect(15, 13, 9, 5, P.green);
      p.rect(16, 14, 7, 3, P.white);
      p.vline(19, 10, 3, P.ink2);
      AO.font.text(ctx, 'API', 5, 16, P.red);
      AO.font.text(ctx, 'DB', 28, 15, P.purple);
      p.rect(2, 23, 36, 2, P.metal);
      p.rect(4, 23, 3, 1, P.red);
      p.rect(8, 23, 3, 1, P.blue);
      // pés com rodinhas
      p.rect(4, 26, 2, 6, P.ink);
      p.rect(34, 26, 2, 6, P.ink);
      p.rect(2, 32, 6, 2, P.ink);
      p.rect(32, 32, 6, 2, P.ink);
    });
  }

  function standTable() {
    return sprite('standtable', 34, 22, (p) => {
      p.rect(0, 0, 34, 10, P.ink);
      p.rect(1, 1, 32, 6, P.deskTop);
      p.hline(1, 1, 32, P.deskTopHi);
      p.rect(1, 7, 32, 2, P.deskEdge);
      p.rect(15, 10, 4, 10, P.ink);
      p.rect(16, 10, 2, 10, P.metalLo);
      p.rect(9, 20, 16, 2, P.ink);
      // notebook e post-its
      p.rect(4, 2, 7, 4, P.metalLo);
      p.rect(5, 3, 5, 2, P.screenOff);
      p.rect(22, 2, 3, 3, P.yellow);
      p.rect(26, 3, 3, 3, P.pink);
    });
  }

  function printer() {
    return sprite('printer', 18, 20, (p) => {
      p.rect(0, 4, 18, 16, P.ink);
      p.rect(1, 5, 16, 14, P.metalHi);
      p.rect(1, 5, 16, 3, P.white);
      p.rect(3, 0, 12, 6, P.ink);
      p.rect(4, 1, 10, 4, P.paper);
      p.rect(3, 10, 12, 2, P.ink2);
      p.rect(13, 14, 2, 1, P.green);
      p.rect(1, 16, 16, 3, P.metal);
    });
  }

  function trash() {
    return sprite('trash', 10, 12, (p) => {
      p.rect(0, 0, 10, 12, P.ink);
      p.rect(1, 1, 8, 10, P.metal);
      p.rect(1, 1, 8, 2, P.metalHi);
      p.vline(3, 4, 6, P.metalLo);
      p.vline(6, 4, 6, P.metalLo);
    });
  }

  function meetingTable(w) {
    return sprite('mtable' + w, w, 34, (p) => {
      p.rect(0, 0, w, 28, P.ink);
      p.rect(1, 1, w - 2, 24, P.woodDeskHi);
      p.hline(1, 1, w - 2, lighten(P.woodDeskHi, 0.3));
      p.rect(1, 25, w - 2, 2, P.woodDeskFront);
      p.rect(3, 28, 3, 6, P.ink);
      p.rect(w - 6, 28, 3, 6, P.ink);
      // papéis, notebooks e cafés
      p.rect(6, 5, 8, 6, P.white);
      p.rect(7, 6, 6, 1, P.docLine);
      p.rect(7, 8, 4, 1, P.docLine);
      p.rect(w - 18, 14, 10, 7, P.metalLo);
      p.rect(w - 17, 15, 8, 4, P.screenOff);
      p.rect(w / 2 - 2, 8, 3, 3, P.white);
      p.rect(20, 15, 3, 3, P.white);
    });
  }

  function chairSmall(facing) {
    // cadeira simples (sala de reunião): 'down' = encosto atrás; 'up' = encosto à frente
    return sprite('chairS' + facing, 12, 14, (p) => {
      if (facing === 'down') {
        p.rect(1, 0, 10, 8, P.ink);
        p.rect(2, 1, 8, 6, '#5a6a8c');
        p.rect(2, 1, 8, 1, '#7082a8');
        p.rect(0, 7, 12, 5, P.ink);
        p.rect(1, 8, 10, 3, '#7082a8');
        p.rect(2, 12, 2, 2, P.ink);
        p.rect(8, 12, 2, 2, P.ink);
      } else {
        p.rect(0, 2, 12, 5, P.ink);
        p.rect(1, 3, 10, 3, '#7082a8');
        p.rect(1, 5, 10, 8, P.ink);
        p.rect(2, 6, 8, 6, '#5a6a8c');
        p.rect(2, 6, 8, 1, '#7082a8');
      }
    });
  }

  function rug(w, h, base, border) {
    return sprite('rug' + w + 'x' + h + base, w, h, (p) => {
      p.rect(0, 0, w, h, border);
      p.rect(2, 2, w - 4, h - 4, base);
      p.rect(4, 4, w - 8, h - 8, border);
      p.rect(5, 5, w - 10, h - 10, base);
      for (let x = 1; x < w - 1; x += 3) {
        p.px(x, 0, base);
        p.px(x, h - 1, base);
      }
    });
  }

  function doormat() {
    return sprite('doormat', 32, 12, (p, ctx) => {
      p.rect(0, 0, 32, 12, '#3a2a24');
      p.rect(1, 1, 30, 10, '#6d4436');
      p.rect(2, 2, 28, 8, '#7d5040');
      AO.font.text(ctx, 'HELLO', 6, 4, '#e8c9a0');
    });
  }

  function upsBox() {
    return sprite('ups', 16, 18, (p) => {
      p.rect(0, 0, 16, 18, P.ink);
      p.rect(1, 1, 14, 16, P.rack);
      p.rect(1, 1, 14, 2, P.rackHi);
      p.rect(3, 5, 10, 4, P.ink2);
      p.rect(4, 6, 5, 2, P.green);
      p.rect(11, 12, 2, 2, P.yellow);
    });
  }

  AO.furniture = {
    sprite,
    desk,
    mug,
    chairFront,
    chairBack,
    plant,
    rack,
    console,
    acUnit,
    counter,
    coffeeMachine,
    sink,
    microwave,
    fridge,
    vending,
    waterCooler,
    roundTable,
    stool,
    sofaBack,
    beanbag,
    coffeeTable,
    arcade,
    bookshelf,
    tvCabinet,
    pingPong,
    whiteboard,
    standTable,
    printer,
    trash,
    meetingTable,
    chairSmall,
    rug,
    doormat,
    upsBox,
    mix
  };
})();
