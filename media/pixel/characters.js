// Personagens chibi procedurais — vista top-down 3/4, cabeça grande, cabelo
// com volume e contorno escuro. Cada aparência vira uma sprite sheet gerada
// em runtime a partir de mapas de pixels em camadas (corpo → cabeça → cabelo
// → acessórios) com contorno automático. Sem assets externos.
(function () {
  'use strict';
  const AO = (window.AO = window.AO || {});
  const { canvas, ctx2d, darken, lighten, mix, hash, Grid } = AO.px;

  // Célula de 18×28; o "core" de 16×24 fica em (1, 2). Âncora = pés.
  const CW = 18;
  const CH = 28;
  const OX = 1;
  const OY = 2;
  const ANCHOR_X = 9;
  const ANCHOR_Y = 26;

  // ── Cabeças (core coords; a cabeça ocupa y1..11) ──────────────────
  const HEAD = {
    down: [
      '....ssssssss....',
      '...ssssssssss...',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..sssessssesss..',
      '..sssessssesss..',
      '..ssbssssssbss..',
      '...SssssssssS...',
      '....SSssssSS....'
    ],
    up: [
      '....ssssssss....',
      '...ssssssssss...',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '...ssssssssss...',
      '....SSSSSSSS....'
    ],
    left: [
      '.....ssssss.....',
      '...ssssssssss...',
      '..sssssssssss...',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssssssssssss..',
      '..ssessssssss...',
      '..ssesssssssss..',
      '..sssbssssssss..',
      '...sssssssss....',
      '....SSsssSS.....'
    ]
  };

  // Variações de olhos (frente e perfil) por expressão.
  const EYES = {
    normal: { down: [[5, 7], [5, 8], [10, 7], [10, 8]], left: [[4, 7], [4, 8]] },
    happy: { down: [[4, 8], [5, 7], [6, 8], [9, 8], [10, 7], [11, 8]], left: [[3, 8], [4, 7], [5, 8]] },
    closed: { down: [[4, 8], [5, 8], [6, 8], [9, 8], [10, 8], [11, 8]], left: [[3, 8], [4, 8], [5, 8]] },
    x: { down: [[4, 7], [6, 7], [5, 8], [4, 9], [6, 9], [9, 7], [11, 7], [10, 8], [9, 9], [11, 9]], left: [[3, 7], [5, 7], [4, 8], [3, 9], [5, 9]] }
  };

  // ── Cabelos: cada estilo tem frente (down), costas (up) e perfil (left) ─
  // 'h' base, 'H' sombra, 'L' brilho. Linhas começam em core y = -1.
  const HAIR = {
    short: {
      down: [
        '................',
        '....hhhhhhhh....',
        '...hhLLhhhhhh...',
        '..hhLLhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hHhhhHhhhHhh..',
        '..H.H......H.H..',
        '..H..........H..'
      ],
      up: [
        '................',
        '....hhhhhhhh....',
        '...hhhhhhhhhh...',
        '..hhhLLhhhhhhh..',
        '..hhLLhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..HhhhhhhhhhhH..',
        '...HHhhhhhhHH...'
      ],
      left: [
        '................',
        '.....hhhhhhh....',
        '...hhhhhhLLhh...',
        '..hhhhhhLLhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hHhh.hhhhhhh..',
        '..H.....Shhhhh..',
        '........ShhhhH..',
        '.........HhhH...',
        '..........HH....'
      ]
    },
    spiky: {
      down: [
        '...h..h..h..h...',
        '...hh.hh.hh.hh..',
        '..hhhhhhhhhhhhh.',
        '..hhLLhhhhhhhhh.',
        '.hhLLhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '..hhhhhhhhhhhh..',
        '..hhHhhhHhhHhh..',
        '..hH.H.hH.H.Hh..',
        '..H..........H..'
      ],
      up: [
        '...h..h..h..h...',
        '...hh.hh.hh.hh..',
        '..hhhhhhhhhhhhh.',
        '.hhhhLLhhhhhhhh.',
        '.hhhLLhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..HhhhhhhhhhhH..',
        '...HhHhHHhHhH...'
      ],
      left: [
        '.....h..h..h....',
        '.....hh.hh.hhh..',
        '...hhhhhhhhhhhh.',
        '..hhhhhhLLhhhhh.',
        '..hhhhhLLhhhhhhh',
        '..hhhhhhhhhhhhh.',
        '..hhhhhhhhhhhh..',
        '.hhHh.hhhhhhhh..',
        '.hH.....Shhhhh..',
        '........ShhhhH..',
        '.........HhhH...',
        '..........HH....'
      ]
    },
    bob: {
      down: [
        '................',
        '....hhhhhhhh....',
        '...hhLLhhhhhh...',
        '..hhLLhhhhhhhh..',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhH........Hhh.',
        '.hh..........hh.',
        '.hh..........hh.',
        '.hH..........Hh.',
        '.HH..........HH.'
      ],
      up: [
        '................',
        '....hhhhhhhh....',
        '...hhhhhhhhhh...',
        '..hhhLLhhhhhhh..',
        '.hhhLLhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.HHhhhhhhhhhhHH.',
        '..HHHHHHHHHHHH..'
      ],
      left: [
        '................',
        '.....hhhhhhh....',
        '...hhhhhhLLhh...',
        '..hhhhhhLLhhhh..',
        '..hhhhhhhhhhhhh.',
        '..hhhhhhhhhhhhh.',
        '..hhhhhhhhhhhhh.',
        '..hHhh.hhhhhhhh.',
        '..H.....hhhhhhh.',
        '.......hhhhhhhh.',
        '.......hhhhhhhh.',
        '.......HhhhhhHh.',
        '........HHHHHH..'
      ]
    },
    long: {
      down: [
        '................',
        '....hhhhhhhh....',
        '...hhLLhhhhhh...',
        '..hhLLhhhhhhhh..',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhH.h....h.Hhh.',
        '.hh..........hh.',
        '.hh..........hh.',
        '.hh..........hh.',
        '.hh..........hh.',
        '.hH..........Hh.',
        '.hH..........Hh.',
        '.HH..........HH.',
        '..H..........H..'
      ],
      up: [
        '................',
        '....hhhhhhhh....',
        '...hhhhhhhhhh...',
        '..hhhLLhhhhhhh..',
        '.hhhLLhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..HhhhhhhhhhhH..',
        '...HHHHHHHHHH...'
      ],
      left: [
        '................',
        '.....hhhhhhh....',
        '...hhhhhhLLhh...',
        '..hhhhhhLLhhhh..',
        '..hhhhhhhhhhhhh.',
        '..hhhhhhhhhhhhh.',
        '..hhhhhhhhhhhhh.',
        '..hHhh.hhhhhhhh.',
        '..H.....hhhhhhh.',
        '.......hhhhhhhh.',
        '.......hhhhhhhh.',
        '.......hhhhhhhh.',
        '........hhhhhhh.',
        '........hhhhhhh.',
        '........Hhhhhhh.',
        '.........HhhhH..',
        '..........HHH...'
      ]
    },
    ponytail: {
      down: [
        '................',
        '....hhhhhhhh....',
        '...hhLLhhhhhh...',
        '..hhLLhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhHhhhhhhHhh..',
        '..hH........Hh..',
        '..H..........H..'
      ],
      up: [
        '................',
        '....hhhhhhhh....',
        '...hhhhhhhhhh...',
        '..hhhLLhhhhhhh..',
        '..hhLLhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhQQhhhhh..',
        '..hhhhhhhhhhhh..',
        '..Hhhhhhhhhhhh..',
        '...HHhhhhhhHH...',
        '......hhhh......',
        '......hhhh......',
        '......hhhh......',
        '.......HH.......'
      ],
      left: [
        '................',
        '.....hhhhhhh....',
        '...hhhhhhLLhh...',
        '..hhhhhhLLhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhQh.',
        '..hhhhhhhhhhhhhh',
        '..hHhh.hhhhhhhhh',
        '..H.....Shhhhhhh',
        '........ShhhhHhh',
        '.........HhhH.hh',
        '..........HH..Hh',
        '..............H.'
      ]
    },
    bun: {
      down: [
        '.....hhhhhh.....',
        '....hLhhhhhh....',
        '.....HhhhhH.....',
        '...hhhhhhhhhh...',
        '..hhLLhhhhhhhh..',
        '..hLLhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hH.hhhhhh.Hh..',
        '..H..........H..'
      ],
      up: [
        '.....hhhhhh.....',
        '....hLhhhhhh....',
        '.....HhhhhH.....',
        '...hhhhhhhhhh...',
        '..hhhLLhhhhhhh..',
        '..hhLLhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..HhhhhhhhhhhH..',
        '...HHhhhhhhHH...'
      ],
      left: [
        '.......hhhhhh...',
        '......hLhhhhhh..',
        '.......HhhhhH...',
        '...hhhhhhhhhhh..',
        '..hhhhhhLLhhhh..',
        '..hhhhhLLhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hHhh.hhhhhhh..',
        '..H.....Shhhhh..',
        '........ShhhhH..',
        '.........HhhH...',
        '..........HH....'
      ]
    },
    curly: {
      down: [
        '....hhhhhhhh....',
        '..hhhhhhhhhhhh..',
        '.hhhhLLhhhhhhhh.',
        '.hhhLLhhhhhhhhh.',
        'hhhhhhhhhhhhhhhh',
        'hhhhhhhhhhhhhhhh',
        'hhhhhhhhhhhhhhhh',
        'hhhHhHhhhhHhHhhh',
        '.hh..........hh.',
        'hhH..........Hhh',
        '.hH..........Hh.',
        '..H..........H..'
      ],
      up: [
        '....hhhhhhhh....',
        '..hhhhhhhhhhhh..',
        '.hhhhhhhhhhhhhh.',
        '.hhhhLLhhhhhhhh.',
        'hhhhLLhhhhhhhhhh',
        'hhhhhhhhhhhhhhhh',
        'hhhhhhhhhhhhhhhh',
        'hhhhhhhhhhhhhhhh',
        'hhhhhhhhhhhhhhhh',
        '.hhhhhhhhhhhhhh.',
        '.hhhhhhhhhhhhhh.',
        '..HhHhhhhhhHhH..',
        '...HHHHHHHHHH...'
      ],
      left: [
        '.....hhhhhhhh...',
        '...hhhhhhhhhhh..',
        '..hhhhhhhLLhhhh.',
        '.hhhhhhhLLhhhhhh',
        '.hhhhhhhhhhhhhhh',
        'hhhhhhhhhhhhhhhh',
        '.hhhhhhhhhhhhhhh',
        '.hhHh.hhhhhhhhhh',
        '..h.....Shhhhhh.',
        '........Shhhhhhh',
        '.........HhhhhH.',
        '..........HhHH..'
      ]
    },
    buzz: {
      down: [
        '................',
        '................',
        '....hhhhhhhh....',
        '...hhhhhhhhhh...',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..HhhhhhhhhhhH..',
        '..H..........H..'
      ],
      up: [
        '................',
        '................',
        '....hhhhhhhh....',
        '...hhhhhhhhhh...',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..HhhhhhhhhhhH..',
        '...HHHHHHHHHH...'
      ],
      left: [
        '................',
        '................',
        '.....hhhhhhh....',
        '...hhhhhhhhhh...',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..hhhhhhhhhhhh..',
        '..Hhhhhhhhhhhh..',
        '........Shhhhh..',
        '........ShhhhH..',
        '.........HhhH...',
        '..........HH....'
      ]
    }
  };

  const HAIR_STYLES = Object.keys(HAIR);

  // ── Corpo (core y12..22) ──────────────────────────────────────────
  // Poses montadas por código: offsets de braços/pernas por quadro.
  function torsoFront(g, oy, back) {
    const y = OY + oy;
    g.fill(OX + 5, y + 12, 6, 1, 't');
    g.fill(OX + 4, y + 13, 8, 5, 't');
    g.fill(OX + 4, y + 13, 1, 5, 'T');
    g.fill(OX + 11, y + 13, 1, 5, 'T');
    if (!back) {
      // gola em V e logo no peito
      g.set(OX + 7, y + 12, 'S');
      g.set(OX + 8, y + 12, 'S');
      g.set(OX + 9, y + 14, 'a');
    } else {
      g.fill(OX + 5, y + 12, 6, 1, 'T');
    }
    g.fill(OX + 5, y + 17, 6, 1, 'T');
  }

  function armsFront(g, oy, l, r) {
    // l/r: deslocamento vertical da mão (balanço)
    const y = OY + oy;
    g.fill(OX + 3, y + 13, 1, 3 + l, 'u');
    g.set(OX + 3, y + 16 + l, 's');
    g.fill(OX + 12, y + 13, 1, 3 + r, 'u');
    g.set(OX + 12, y + 16 + r, 's');
  }

  function legsFront(g, lLift, rLift) {
    const y = OY;
    g.fill(OX + 4, y + 18, 8, 1, 'p');
    // perna esquerda (do observador)
    g.fill(OX + 5, y + 19, 3, 2 - lLift, 'p');
    g.fill(OX + 5, y + 21 - lLift, 3, 1, 'f');
    // perna direita
    g.fill(OX + 8, y + 19, 3, 2 - rLift, 'p');
    g.fill(OX + 8, y + 21 - rLift, 3, 1, 'f');
    g.set(OX + 7, y + 19, 'P');
    g.set(OX + 8, y + 19, 'P');
  }

  function torsoSide(g, oy) {
    const y = OY + oy;
    g.fill(OX + 5, y + 12, 6, 1, 't');
    g.fill(OX + 5, y + 13, 6, 5, 't');
    g.fill(OX + 10, y + 13, 1, 5, 'T');
    g.fill(OX + 5, y + 17, 6, 1, 'T');
    g.set(OX + 5, y + 12, 'S');
  }

  function armSide(g, oy, swing) {
    // swing: -1 (à frente), 0, 1 (atrás)
    const y = OY + oy;
    const x = OX + 7 + swing;
    g.fill(x, y + 13, 2, 3, 'u');
    g.fill(x, y + 16, 2, 1, 's');
  }

  function legsSide(g, stride) {
    const y = OY;
    g.fill(OX + 5, y + 18, 6, 1, 'p');
    if (stride === 0) {
      g.fill(OX + 6, y + 19, 4, 2, 'p');
      g.fill(OX + 5, y + 21, 5, 1, 'f');
    } else {
      // passada: perna da frente e de trás afastadas
      const front = stride > 0 ? 4 : 5;
      const back = stride > 0 ? 9 : 8;
      g.fill(OX + front, y + 19, 2, 2, 'p');
      g.fill(OX + front - 1, y + 21, 3, 1, 'f');
      g.fill(OX + back, y + 19, 2, 2, 'P');
      g.fill(OX + back, y + 21, 3, 1, 'f');
    }
  }

  // ── Montagem de cabeça + cabelo + acessórios ──────────────────────
  function head(g, dir, oy, look) {
    const rows = HEAD[dir === 'right' ? 'left' : dir];
    g.stamp(rows, OX, OY + oy + 1);
    if (dir !== 'up') {
      const eyes = (EYES[look.expr] || EYES.normal)[dir === 'down' ? 'down' : 'left'];
      // limpa olhos padrão antes de aplicar a expressão
      for (let y = 7; y <= 9; y++) {
        for (let x = 2; x <= 13; x++) {
          if (g.get(OX + x, OY + oy + y) === 'e') g.set(OX + x, OY + oy + y, 's');
        }
      }
      for (const [x, y] of eyes) g.set(OX + x, OY + oy + y, 'e');
    }
    const style = HAIR[look.hair] || HAIR.short;
    const hair = style[dir === 'right' ? 'left' : dir];
    g.stamp(hair, OX, OY + oy - 1);
    accessories(g, dir, oy, look);
  }

  function accessories(g, dir, oy, look) {
    const y = OY + oy;
    if (look.glasses && dir !== 'up') {
      // armação fina: aro superior, laterais e ponte — sem lente opaca
      if (dir === 'down') {
        g.fill(OX + 4, y + 6, 3, 1, 'g');
        g.fill(OX + 9, y + 6, 3, 1, 'g');
        g.set(OX + 4, y + 7, 'g');
        g.set(OX + 6, y + 7, 'g');
        g.set(OX + 9, y + 7, 'g');
        g.set(OX + 11, y + 7, 'g');
        g.fill(OX + 7, y + 7, 2, 1, 'g');
        g.set(OX + 4, y + 8, 'G');
        g.set(OX + 6, y + 8, 'G');
        g.set(OX + 9, y + 8, 'G');
        g.set(OX + 11, y + 8, 'G');
      } else {
        g.fill(OX + 3, y + 6, 3, 1, 'g');
        g.set(OX + 3, y + 7, 'g');
        g.fill(OX + 5, y + 7, 3, 1, 'g');
        g.set(OX + 5, y + 8, 'G');
      }
    }
    if (look.headphones && !look.cap) {
      if (dir === 'down' || dir === 'up') {
        g.fill(OX + 4, y + 0, 8, 1, 'q');
        g.set(OX + 3, y + 1, 'q');
        g.set(OX + 12, y + 1, 'q');
        g.fill(OX + 1, y + 6, 2, 4, 'Q');
        g.fill(OX + 13, y + 6, 2, 4, 'Q');
        g.fill(OX + 1, y + 6, 1, 4, 'q');
        g.fill(OX + 14, y + 6, 1, 4, 'q');
      } else {
        g.fill(OX + 6, y + 0, 5, 1, 'q');
        g.fill(OX + 8, y + 6, 2, 4, 'Q');
        g.fill(OX + 10, y + 6, 1, 4, 'q');
      }
    }
    if (look.cap) {
      // boné: copa arredondada + aba escura; o cabelo aparece por baixo
      if (dir === 'down') {
        g.fill(OX + 4, y + 0, 8, 1, 'c');
        g.fill(OX + 3, y + 1, 10, 2, 'c');
        g.set(OX + 7, y - 1, 'C');
        g.set(OX + 8, y - 1, 'C');
        g.fill(OX + 5, y + 1, 2, 1, 'w');
        g.fill(OX + 2, y + 3, 12, 1, 'C');
      } else if (dir === 'up') {
        g.fill(OX + 4, y + 0, 8, 1, 'c');
        g.fill(OX + 3, y + 1, 10, 3, 'c');
        g.set(OX + 7, y - 1, 'C');
        g.set(OX + 8, y - 1, 'C');
        g.fill(OX + 6, y + 3, 4, 1, 'h');
      } else {
        g.fill(OX + 5, y + 0, 7, 1, 'c');
        g.fill(OX + 3, y + 1, 10, 2, 'c');
        g.set(OX + 8, y - 1, 'C');
        g.fill(OX + 0, y + 3, 7, 1, 'C');
        g.fill(OX + 7, y + 3, 6, 1, 'c');
      }
    }
  }

  /** Braço erguido (mão acima da cabeça), fora da silhueta da cabeça. */
  function raisedArm(g, oy, wobble) {
    const y = OY + oy;
    g.set(OX + 12, y + 13, 'u');
    g.set(OX + 13, y + 12, 'u');
    g.fill(OX + 14, y + 4, 1, 8, 'u');
    g.fill(OX + 14 + wobble, y + 1, 2, 3, 's');
  }

  // ── Quadros ───────────────────────────────────────────────────────
  // Cada quadro devolve uma Grid já com contorno.
  function frame(look, name) {
    const g = new Grid(CW, CH);
    const [pose, dir, n] = name.split(':');
    const i = Number(n || 0);

    if (pose === 'stand' || pose === 'walk') {
      const walking = pose === 'walk';
      const bob = walking && (i === 1 || i === 3) ? -1 : 0;
      const breath = !walking && i === 1 ? 1 : 0;
      if (dir === 'down' || dir === 'up') {
        legsFront(g, walking && i === 1 ? 1 : 0, walking && i === 3 ? 1 : 0);
        torsoFront(g, bob, dir === 'up');
        const sw = walking ? (i === 1 ? 1 : i === 3 ? -1 : 0) : 0;
        armsFront(g, bob, sw > 0 ? 1 : 0, sw < 0 ? 1 : 0);
        head(g, dir, bob + breath, look);
      } else {
        const stride = walking ? (i === 1 ? 1 : i === 3 ? -1 : 0) : 0;
        legsSide(g, stride);
        torsoSide(g, bob);
        armSide(g, bob, walking ? (i === 1 ? -1 : i === 3 ? 1 : 0) : 0);
        head(g, 'left', bob + breath, look);
      }
    } else if (pose === 'sit') {
      // Sentado atrás da mesa: só tronco e cabeça; a mesa esconde o resto.
      const oy = 2;
      const typing = n === 'type0' || n === 'type1';
      const alt = n === 'type1';
      if (dir === 'down') {
        torsoFront(g, oy, false);
        if (n === 'hand0' || n === 'hand1') {
          // braço levantado (mão acima da cabeça, lado direito)
          raisedArm(g, oy, n === 'hand1' ? 1 : 0);
          g.fill(OX + 3, OY + oy + 13, 1, 3, 'u');
          g.set(OX + 3, OY + oy + 16, 's');
        } else if (typing || n === 'idle') {
          // braços dobrados, mãos à frente no teclado
          g.fill(OX + 3, OY + oy + 13, 1, 3, 'u');
          g.fill(OX + 12, OY + oy + 13, 1, 3, 'u');
          g.fill(OX + 4, OY + oy + 16, 2, 1, 'u');
          g.fill(OX + 10, OY + oy + 16, 2, 1, 'u');
          g.fill(OX + 5, OY + oy + (typing && alt ? 16 : 17), 2, 1, 's');
          g.fill(OX + 9, OY + oy + (typing && !alt ? 16 : 17), 2, 1, 's');
        }
        head(g, 'down', oy + (n === 'idle' ? 0 : 0), look);
      } else {
        // de costas para a câmera, olhando o monitor
        torsoFront(g, oy, true);
        if (n === 'hand0' || n === 'hand1') {
          raisedArm(g, oy, n === 'hand1' ? 1 : 0);
          g.fill(OX + 3, OY + oy + 13, 1, 3, 'u');
        } else {
          const lift = typing ? (alt ? 1 : 0) : 0;
          g.fill(OX + 3, OY + oy + 13 - lift, 1, 3, 'u');
          g.fill(OX + 12, OY + oy + 13 - (typing && !alt ? 1 : 0), 1, 3, 'u');
          g.set(OX + 3, OY + oy + 12 - lift, 's');
          g.set(OX + 12, OY + oy + 12 - (typing && !alt ? 1 : 0), 's');
        }
        head(g, 'up', oy, look);
      }
    } else if (pose === 'wave') {
      legsFront(g, 0, 0);
      torsoFront(g, 0, false);
      armsFront(g, 0, 0, 0);
      g.fill(OX + 12, OY + 13, 1, 4, '');
      raisedArm(g, 0, i ? 1 : 0);
      head(g, 'down', 0, look);
    } else if (pose === 'coffee') {
      legsFront(g, 0, 0);
      torsoFront(g, 0, false);
      armsFront(g, 0, 0, 0);
      head(g, 'down', 0, look);
      // caneca na mão direita, subindo no gole (desenhada por cima do corpo)
      const cy = i ? 10 : 14;
      g.fill(OX + 12, OY + 13, 1, 4, '');
      g.fill(OX + 10, OY + 15, 3, 1, 'u');
      g.fill(OX + 9, OY + cy, 3, 3, 'w');
      g.set(OX + 12, OY + cy + 1, 'w');
      g.fill(OX + 9, OY + cy, 3, 1, 'x');
      g.set(OX + 10, OY + cy + 3, 's');
    } else if (pose === 'sofa') {
      // sentado de frente, pernas dobradas visíveis
      const oy = 3;
      g.fill(OX + 4, OY + 19, 8, 2, 'p');
      g.fill(OX + 4, OY + 21, 3, 1, 'f');
      g.fill(OX + 9, OY + 21, 3, 1, 'f');
      torsoFront(g, oy - 1, false);
      g.fill(OX + 3, OY + oy + 12, 1, 3, 'u');
      g.fill(OX + 12, OY + oy + 12, 1, 3, 'u');
      g.set(OX + 3, OY + oy + 15, 's');
      g.set(OX + 12, OY + oy + 15, 's');
      head(g, 'down', oy - 1 + (i ? 1 : 0), look);
    }

    g.outline('k');
    return g;
  }

  // Lista canônica de quadros da sheet.
  const FRAMES = [];
  for (const d of ['down', 'up', 'left']) {
    FRAMES.push('stand:' + d + ':0', 'stand:' + d + ':1');
    for (let i = 0; i < 4; i++) FRAMES.push('walk:' + d + ':' + i);
  }
  for (const n of ['type0', 'type1', 'idle', 'hand0', 'hand1']) {
    FRAMES.push('sit:down:' + n, 'sit:up:' + n);
  }
  FRAMES.push('wave:down:0', 'wave:down:1', 'coffee:down:0', 'coffee:down:1', 'sofa:down:0', 'sofa:down:1');

  // ── Aparência ─────────────────────────────────────────────────────
  const SKINS = [
    ['#f7d7bb', '#e8b995'],
    ['#efc19d', '#d9a07a'],
    ['#dba27a', '#bf8460'],
    ['#b97d57', '#9a6243'],
    ['#8e5b3c', '#724430'],
    ['#6a4130', '#553224']
  ];
  const HAIRS = [
    '#2b2427', '#4a3228', '#744a2c', '#9a4d2b', '#d9b267', '#ece3d3',
    '#c7642f', '#3d5fbf', '#d06a9e', '#7f7f8c', '#2f4a3a', '#5b3a6e'
  ];
  const PANTS = ['#353448', '#2f3a52', '#4a3f38', '#3b4a3f', '#43404f'];

  function paletteFor(look) {
    const shirt = look.shirt;
    const hair = look.hairColor;
    return {
      k: mix(darken(hair, 0.55), '#1b1726', 0.55),
      s: look.skin[0],
      S: look.skin[1],
      b: mix(look.skin[0], '#f07f8a', 0.45),
      e: '#2a2233',
      h: hair,
      H: darken(hair, 0.28),
      L: lighten(hair, 0.32),
      t: shirt,
      T: darken(shirt, 0.22),
      u: darken(shirt, 0.1),
      a: look.logo || lighten(shirt, 0.6),
      p: look.pants,
      P: darken(look.pants, 0.25),
      f: '#2a2530',
      q: '#2b2d38',
      Q: look.accent || '#c96a47',
      g: '#2b2d38',
      G: 'rgba(200,230,255,0.55)',
      c: look.accent || shirt,
      C: darken(look.accent || shirt, 0.3),
      w: '#f7f5f0',
      x: '#6b4226'
    };
  }

  /**
   * Aparência determinística. `seed` define rosto/cabelo; `outfit` vem da
   * fonte (Claude, Codex…) e `role` decide acessórios.
   */
  function lookFor(seed, source, role, type) {
    const h = hash(seed);
    const info = AO.sourceInfo(source);
    const sub = role === 'subagent';
    const t = String(type || '').toLowerCase();
    const shirt = sub ? lighten(info.shirt, 0.18) : info.shirt;
    return {
      key: seed + '|' + source + '|' + role + '|' + t,
      skin: SKINS[h % SKINS.length],
      hair: HAIR_STYLES[(h >>> 3) % HAIR_STYLES.length],
      hairColor: HAIRS[(h >>> 7) % HAIRS.length],
      pants: PANTS[(h >>> 11) % PANTS.length],
      shirt,
      logo: source === 'claude' ? '#fbe3d2' : source === 'codex' ? '#10a37f' : lighten(shirt, 0.65),
      accent: info.color,
      headphones: !sub,
      glasses: t === 'plan' || (sub && (h >>> 13) % 4 === 0),
      cap: t === 'explore',
      expr: 'normal'
    };
  }

  // ── Sheets (cache por aparência + expressão) ──────────────────────
  const cache = new Map();

  function sheet(look) {
    const key = look.key + '|' + look.expr;
    let s = cache.get(key);
    if (s) return s;
    const cols = 8;
    const rows = Math.ceil((FRAMES.length + 8) / cols);
    const c = canvas(cols * CW, rows * CH);
    const ctx = ctx2d(c);
    const pal = paletteFor(look);
    const index = {};
    let n = 0;
    const place = (name, grid) => {
      const x = (n % cols) * CW;
      const y = Math.floor(n / cols) * CH;
      grid.paint(ctx, pal, x, y);
      index[name] = { x, y };
      n++;
    };
    for (const name of FRAMES) {
      const g = frame(look, name);
      place(name, g);
      if (name.includes(':left:')) place(name.replace(':left:', ':right:'), g.flipped());
    }
    s = { canvas: c, index, w: CW, h: CH, ax: ANCHOR_X, ay: ANCHOR_Y };
    cache.set(key, s);
    return s;
  }

  /** Desenha um quadro com a âncora (pés) em (x, y) no contexto nativo. */
  function draw(ctx, look, name, x, y) {
    const s = sheet(look);
    const f = s.index[name] || s.index['stand:down:0'];
    ctx.drawImage(s.canvas, f.x, f.y, CW, CH, Math.round(x - ANCHOR_X), Math.round(y - ANCHOR_Y), CW, CH);
  }

  /** Retrato (cabeça + ombros) para o painel de detalhe. */
  function portrait(look, scale) {
    const s = sheet(look);
    const f = s.index['stand:down:0'];
    const c = canvas(CW * scale, 18 * scale);
    const ctx = ctx2d(c);
    ctx.drawImage(s.canvas, f.x, f.y, CW, 18, 0, 0, CW * scale, 18 * scale);
    return c;
  }

  AO.chars = { lookFor, sheet, draw, portrait, FRAMES, CW, CH, ANCHOR_X, ANCHOR_Y, HAIR_STYLES, SKINS, HAIRS };
})();
