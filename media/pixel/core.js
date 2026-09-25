// Núcleo de desenho pixel art da webview: canvas offscreen, utilitários de
// cor, grade de pixels com contorno automático e a paleta canônica do dev hub.
// Tudo é desenhado em runtime — nenhum asset externo, nada de rede.
(function () {
  'use strict';
  const AO = (window.AO = window.AO || {});

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  function ctx2d(c) {
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    return ctx;
  }

  // ── Cor ────────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }

  /** Mistura linear entre duas cores hex (t = 0 → a, t = 1 → b). */
  function mix(a, b, t) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
  }

  /** Sombra com leve desvio para o roxo (sombras "frias" ficam mais pixel art). */
  function darken(hex, t) {
    return mix(hex, '#1a1328', t);
  }

  /** Luz com leve desvio para o creme (luzes "quentes"). */
  function lighten(hex, t) {
    return mix(hex, '#fff6e6', t);
  }

  function rgba(hex, a) {
    const [r, g, b] = hexToRgb(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  // Hash determinístico (FNV-1a) — aparência estável por agente/projeto.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // PRNG pequeno e determinístico (mulberry32) para variações de cenário.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Pintor direto em contexto 2D ──────────────────────────────────
  class Painter {
    constructor(ctx) {
      this.ctx = ctx;
    }
    rect(x, y, w, h, color) {
      if (!color || w <= 0 || h <= 0) return;
      this.ctx.fillStyle = color;
      this.ctx.fillRect(x, y, w, h);
    }
    px(x, y, color) {
      this.rect(x, y, 1, 1, color);
    }
    hline(x, y, w, color) {
      this.rect(x, y, w, 1, color);
    }
    vline(x, y, h, color) {
      this.rect(x, y, 1, h, color);
    }
    /** Retângulo com contorno de 1px. */
    box(x, y, w, h, fill, outline) {
      this.rect(x, y, w, h, outline);
      this.rect(x + 1, y + 1, w - 2, h - 2, fill);
    }
    /** Retângulo com cantos "arredondados" de 1px (cantos transparentes). */
    rounded(x, y, w, h, color) {
      this.rect(x + 1, y, w - 2, h, color);
      this.rect(x, y + 1, w, h - 2, color);
    }
    /** Pinta um mapa de caracteres (cada char → cor da paleta; '.' é vazio). */
    map(rows, pal, x, y, flip) {
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        for (let i = 0; i < row.length; i++) {
          const color = pal[row[i]];
          if (!color) continue;
          this.px(flip ? x + row.length - 1 - i : x + i, y + j, color);
        }
      }
    }
  }

  // ── Grade de pixels (para sprites compostos em camadas) ────────────
  class Grid {
    constructor(w, h) {
      this.w = w;
      this.h = h;
      this.cells = new Array(w * h).fill('');
    }
    get(x, y) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return '';
      return this.cells[y * this.w + x];
    }
    set(x, y, k) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      this.cells[y * this.w + x] = k;
    }
    fill(x, y, w, h, k) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, k);
    }
    /** Carimba um mapa de strings; '.' e ' ' são transparentes. */
    stamp(rows, ox, oy, flip) {
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch === '.' || ch === ' ') continue;
          this.set(flip ? ox + row.length - 1 - i : ox + i, oy + j, ch);
        }
      }
    }
    /** Contorno automático: célula vazia vizinha (4-conexa) de célula cheia. */
    outline(key) {
      const add = [];
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          if (this.get(x, y)) continue;
          const n = this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1);
          if (n && n !== key) add.push([x, y]);
        }
      }
      for (const [x, y] of add) this.set(x, y, key);
    }
    flipped() {
      const g = new Grid(this.w, this.h);
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) g.set(this.w - 1 - x, y, this.get(x, y));
      return g;
    }
    paint(ctx, pal, ox, oy) {
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          const k = this.cells[y * this.w + x];
          if (!k) continue;
          const color = pal[k];
          if (!color) continue;
          ctx.fillStyle = color;
          ctx.fillRect(ox + x, oy + y, 1, 1);
        }
      }
    }
  }

  // ── Paleta do dev hub ─────────────────────────────────────────────
  // Interior quente (madeira, creme) com paredes navy e acentos neon — a
  // UI em volta continua no DNA Sorya (#0D0D0C, terracota #C96A47).
  const PAL = {
    ink: '#1b1726',
    ink2: '#2a2536',
    void: '#11141d',

    wallCap: '#28304a',
    wallCapHi: '#3a4566',
    wallCapLo: '#1a2032',
    wallFace: '#34425f',
    wallFaceHi: '#40506f',
    wallFaceLo: '#2a3550',
    wallTrim: '#222b40',
    baseboard: '#1f2638',

    wood: '#b9854f',
    woodAlt: '#ad7a46',
    woodLine: '#8e5f34',
    woodHi: '#c9965f',

    tile: '#ece5d8',
    tileAlt: '#e2d9c8',
    tileLine: '#cdbfa8',

    carpet: '#4b6792',
    carpetAlt: '#44608a',
    carpetHi: '#5877a4',
    carpetLine: '#3d5780',

    techFloor: '#4f5566',
    techFloorAlt: '#484e5e',
    techLine: '#3b404e',
    techHi: '#5c6376',

    meetFloor: '#6a5a7e',
    meetFloorAlt: '#62537a',
    meetLine: '#54476a',

    deskTop: '#e9e4da',
    deskTopHi: '#f6f2ea',
    deskEdge: '#c9c1b2',
    deskFront: '#a99f8f',
    deskLeg: '#5b5566',

    woodDesk: '#c38b55',
    woodDeskHi: '#d49e67',
    woodDeskFront: '#96633a',
    woodDeskDark: '#6e4526',

    chair: '#3b4050',
    chairHi: '#4d5366',
    chairLo: '#2a2e3a',

    bezel: '#262833',
    bezelHi: '#3b3e4d',
    stand: '#555a6a',
    screenOff: '#1a1e2b',
    codeBg: '#1d2233',
    termBg: '#0e1512',
    termGreen: '#5af78e',
    docBg: '#f3efe6',
    docLine: '#9aa1ad',
    webBar: '#4e8cf7',
    webBg: '#eaf1f8',

    synCyan: '#7fd3ec',
    synGreen: '#b8e986',
    synOrange: '#f59a6c',
    synPurple: '#c792ea',
    synYellow: '#ffd479',
    synGray: '#7d86a8',

    leaf: '#4f9d4a',
    leafLo: '#367537',
    leafHi: '#78c261',
    pot: '#ece8df',
    potLo: '#c9c2b3',
    potTerra: '#c9714c',
    potTerraLo: '#9c5033',

    metal: '#9aa3b2',
    metalHi: '#c2c9d4',
    metalLo: '#6c7485',
    rack: '#2b2f3c',
    rackHi: '#3c4254',
    rackLo: '#1e212b',

    white: '#f7f5f0',
    paper: '#fbf8f1',
    red: '#e06464',
    redLo: '#b04545',
    green: '#6db86f',
    greenHi: '#9be08f',
    yellow: '#e0b84a',
    yellowHi: '#ffe08a',
    blue: '#4e8cf7',
    cyan: '#4fd1e8',
    pink: '#ee7fb0',
    purple: '#a879f4',
    orange: '#e98a4f',

    accent: '#c96a47',
    accentHi: '#e38b66',
    ok: '#6db86f',
    warn: '#e0b84a',
    error: '#e06464',

    sofa: '#c9714c',
    sofaHi: '#dd8a63',
    sofaLo: '#9c5033',
    rug: '#d8c7a3',
    rugLo: '#bfae8a',
    rugHi: '#e8dcc0'
  };

  // Cor de marca por fonte de agente (UI + uniforme dos bonecos).
  const SOURCES = {
    claude: { label: 'Claude Code', color: '#d97757', shirt: '#d97757' },
    codex: { label: 'Codex', color: '#10a37f', shirt: '#2f3a44' },
    gemini: { label: 'Gemini CLI', color: '#4e8cf7', shirt: '#3d6fd6' },
    antigravity: { label: 'Antigravity', color: '#a879f4', shirt: '#7c55d6' },
    copilot: { label: 'Copilot', color: '#c9cdd6', shirt: '#4a4f5c' },
    cursor: { label: 'Cursor', color: '#e8e8e8', shirt: '#e3e3e3' },
    other: { label: 'Outro', color: '#8c9bab', shirt: '#6b7a8f' }
  };

  function sourceInfo(id) {
    return SOURCES[id] || SOURCES.other;
  }

  AO.px = { canvas, ctx2d, hexToRgb, rgbToHex, mix, darken, lighten, rgba, hash, rng, Painter, Grid };
  AO.PAL = PAL;
  AO.SOURCES = SOURCES;
  AO.sourceInfo = sourceInfo;
})();
