// A cena viva: atores (agentes) andando pelo dev hub com pathfinding em
// grade, comportamento por estado, balões de status, plaquinha de nome em
// cima da cabeça, iluminação por hora do dia e escala nítida.
(function () {
  'use strict';
  const AO = (window.AO = window.AO || {});
  const { canvas, ctx2d, Painter, hash, rgba } = AO.px;
  const P = AO.PAL;
  const WORLD = AO.world;
  const CH = AO.chars;
  const T = WORLD.T;

  const SPEED = 46; // px nativos por segundo (~3 tiles/s)
  const IDLE_AT_DESK_MS = 14000;
  const COFFEE_MS = 16000;
  const WORKING = new Set(['thinking', 'reading', 'writing', 'running', 'searching', 'waiting', 'error']);

  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Pathfinding (BFS 4-conexo na grade do mundo) ──────────────────
  function findPath(sx, sy, tx, ty, extraOk) {
    const W = WORLD.W;
    const H = WORLD.H;
    const ok = (x, y) => WORLD.walkable(x, y) || (extraOk && extraOk(x, y));
    if (sx === tx && sy === ty) return [];
    const prev = new Int32Array(W * H).fill(-1);
    const q = [sy * W + sx];
    prev[sy * W + sx] = sy * W + sx;
    const goal = ty * W + tx;
    while (q.length) {
      const cur = q.shift();
      if (cur === goal) break;
      const cx = cur % W;
      const cy = (cur / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (prev[ni] !== -1) continue;
        if (!ok(nx, ny) && ni !== goal) continue;
        prev[ni] = cur;
        q.push(ni);
      }
    }
    if (prev[goal] === -1) return null;
    const path = [];
    let c = goal;
    while (c !== sy * W + sx) {
      path.push({ tx: c % W, ty: (c / W) | 0 });
      c = prev[c];
    }
    return path.reverse();
  }

  const tileCenter = (tx, ty) => ({ x: tx * T + 8, y: ty * T + 12 });
  const tileOf = (x, y) => ({ tx: Math.floor(x / T), ty: Math.floor((y - 6) / T) });

  // ── Ícones de status (pixel art 7×5) ──────────────────────────────
  const ICONS = {
    thinking: ['.......', '.......', '#.#.#..', '.......', '.......'],
    reading: ['#####..', '#...#..', '#.#.#..', '#...#..', '#####..'],
    writing: ['....##.', '...#.#.', '..#.#..', '.#.#...', '##.....'],
    running: ['#......', '.#.....', '#..###.', '.......', '.......'],
    searching: ['.###...', '#...#..', '#...#..', '.###...', '....##.'],
    waiting: ['...#...', '...#...', '...#...', '.......', '...#...'],
    error: ['.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.'],
    done: ['......#', '.....#.', '#...#..', '.#.#...', '..#....'],
    idle: ['.####..', '...#...', '..#....', '.####..', '.......'],
    coffee: ['.#.#...', '#####..', '#...##.', '#...#..', '.###...']
  };
  const ICON_TAG_COLOR = {
    thinking: '#c9a8f0',
    reading: '#8fb8ff',
    writing: '#f2a27e',
    running: '#6fe0a0',
    searching: '#8fb8ff',
    done: '#8fe08f',
    idle: '#8b867e',
    coffee: '#d9a878'
  };

  // ── Ator ──────────────────────────────────────────────────────────
  class Actor {
    constructor(agent, now) {
      this.id = agent.id;
      this.agent = agent;
      this.look = CH.lookFor(lookSeed(agent), agent.source, agent.kind, agent.type);
      const e = WORLD.entrance;
      this.x = e.x + (hash(agent.id) % 2 ? -8 : 8);
      this.y = e.y + 18;
      this.dir = 'up';
      this.mode = 'walking';
      this.path = [];
      this.goal = null; // { kind, spot }
      this.pose = null; // pose ao chegar
      this.facing = 'up';
      this.stateSince = now;
      this.lastState = agent.state;
      this.idleSince = agent.state === 'idle' ? now : 0;
      this.leisure = null;
      this.leisureUntil = 0;
      this.alpha = 0;
      this.leaving = false;
      this.gone = false;
      this.seed = hash(agent.id) % 1000;
      this.animT = 0;
      this.slide = null;
      this.enteredAt = now;
    }
  }

  function lookSeed(agent) {
    // Sessões: aparência estável por fonte+projeto; subagentes: por nome.
    const name = agent.label || agent.displayName;
    if (agent.kind === 'session') return (agent.source || '') + ':' + (name || agent.project || agent.id);
    return (name || agent.type || '') + ':' + (agent.source || '');
  }

  // ── Controlador da cena ───────────────────────────────────────────
  function mount(el, opts) {
    const options = opts || {};
    const display = el;
    const dctx = display.getContext('2d');
    const buffer = canvas(WORLD.PX_W, WORLD.PX_H);
    const bctx = ctx2d(buffer);
    let inter = null;
    let staticLayer = null;
    let staticHour = -1;
    const lightCanvas = canvas(WORLD.PX_W, WORLD.PX_H);
    const lctx = ctx2d(lightCanvas);

    const actors = new Map();
    let agents = [];
    let ghosts = [];
    let stats = { active: 0, running: 0, waiting: 0, pending: 0, done: 0, failed: 0 };
    let spark = [];
    let hover = null;
    let selected = null;
    let highlighted = null;
    let ambient = 0.5;
    const reserved = new Map(); // spotId -> actorId

    const view = { scale: 1, ox: 0, oy: 0, zoom: 0, panX: 0, panY: 0, dpr: 1, cssW: 0, cssH: 0, userZoom: false };
    // Foco da câmera em painéis estreitos: as mesas do open space.
    const FOCUS = { x: WORLD.PX_W / 2, y: 7 * T };

    // ── Entrada de estado ───────────────────────────────────────────
    function setAgents(list, ghostList) {
      agents = list || [];
      ghosts = ghostList || [];
      const now = performance.now();
      const seen = new Set();
      for (const a of agents) {
        seen.add(a.id);
        let actor = actors.get(a.id);
        if (!actor) {
          actor = new Actor(a, now);
          if (reduceMotion) placeAtGoal(actor, now);
          actors.set(a.id, actor);
        }
        if (actor.lastState !== a.state) {
          actor.stateSince = now;
          if (a.state === 'idle') actor.idleSince = now;
          if (WORKING.has(a.state)) {
            actor.leisure = null;
            releaseSpot(actor);
          }
          actor.lastState = a.state;
        }
        actor.agent = a;
        actor.leaving = false;
      }
      for (const actor of actors.values()) {
        if (!seen.has(actor.id) && !actor.leaving) {
          actor.leaving = true;
          releaseSpot(actor);
        }
      }
    }

    function setStats(s, sparkline) {
      stats = Object.assign(stats, s || {});
      spark = sparkline || spark;
    }

    // ── Decisão de destino ──────────────────────────────────────────
    function desiredGoal(actor, now) {
      const a = actor.agent;
      if (actor.leaving) return { kind: 'exit' };
      const desk = a.deskIndex >= 0 ? WORLD.desks[a.deskIndex] : null;
      if (a.state === 'done' && a.kind === 'subagent') return { kind: 'wave', desk };
      if (WORKING.has(a.state) || a.state === 'done') {
        if (desk) return { kind: 'desk', desk };
        return { kind: 'leisure', overflow: true };
      }
      // idle
      if (!desk) return { kind: 'leisure', overflow: true };
      if (now - actor.idleSince < IDLE_AT_DESK_MS) return { kind: 'desk', desk };
      return { kind: 'leisure' };
    }

    function spotFree(s, actor) {
      const r = reserved.get(s.id);
      return !r || r === actor.id;
    }

    function reserveSpot(actor, s) {
      releaseSpot(actor);
      reserved.set(s.id, actor.id);
      actor.leisure = s;
    }

    function releaseSpot(actor) {
      if (actor.leisure && reserved.get(actor.leisure.id) === actor.id) reserved.delete(actor.leisure.id);
      actor.leisure = null;
    }

    function pickLeisure(actor, now, overflow) {
      const r = (hash(actor.id + ':' + Math.floor(now / 60000)) % 1000) / 1000;
      const prefer = overflow
        ? ['bean', 'sofa', 'stand', 'meeting']
        : now - actor.idleSince < IDLE_AT_DESK_MS + COFFEE_MS
          ? ['coffee', 'stool', 'cooler', 'vending']
          : r < 0.3
            ? ['sofa', 'bean', 'arcade']
            : r < 0.55
              ? ['pong', 'arcade', 'sofa']
              : r < 0.8
                ? ['bean', 'stand', 'sofa']
                : ['stool', 'cooler', 'sofa', 'bean'];
      for (const kind of prefer.concat(['sofa', 'bean', 'stand', 'meeting', 'stool'])) {
        const free = WORLD.spots.filter((s) => s.kind === kind && spotFree(s, actor));
        if (free.length) return free[hash(actor.id + kind) % free.length];
      }
      return null;
    }

    // ── Atualização por quadro ──────────────────────────────────────
    function update(dt, now) {
      for (const actor of actors.values()) {
        actor.animT += dt;
        actor.alpha = Math.min(1, actor.alpha + dt / 400);
        const goal = desiredGoal(actor, now);
        let target = null;
        if (goal.kind === 'exit') {
          target = { access: { tx: WORLD.entrance.tx, ty: WORLD.entrance.ty }, x: WORLD.entrance.x, y: WORLD.entrance.y + 22, pose: 'exit', facing: 'down', id: 'exit' };
        } else if (goal.kind === 'desk' || goal.kind === 'wave') {
          const s = goal.desk.seat;
          if (goal.kind === 'wave' && now - actor.stateSince > 1800 && actor.mode !== 'walking') {
            target = { access: { tx: WORLD.entrance.tx, ty: WORLD.entrance.ty }, x: WORLD.entrance.x, y: WORLD.entrance.y + 22, pose: 'exit', facing: 'down', id: 'exit' };
          } else {
            target = { access: s.access, x: s.x, y: s.y, pose: goal.kind === 'wave' ? 'wave' : 'desk', facing: s.facing, id: 'desk' + goal.desk.index };
          }
        } else {
          if (!actor.leisure || (!goal.overflow && actor.leisure.kind === 'coffee' && now - actor.idleSince > IDLE_AT_DESK_MS + COFFEE_MS)) {
            const s = pickLeisure(actor, now, goal.overflow);
            if (s && (!actor.leisure || s.id !== actor.leisure.id)) reserveSpot(actor, s);
          }
          const s = actor.leisure;
          if (s) target = { access: s.access, x: s.x, y: s.y, pose: s.pose, facing: s.facing, id: s.id, spot: s };
        }
        if (target) steer(actor, target, dt, now);
        if (actor.leaving && actor.mode === 'arrived' && actor.goalId === 'exit') {
          actor.alpha -= dt / 300;
          if (actor.alpha <= 0) actor.gone = true;
        }
      }
      for (const [id, actor] of actors) if (actor.gone) actors.delete(id);
    }

    function placeAtGoal(actor, now) {
      const goal = desiredGoal(actor, now);
      if (goal.kind === 'desk' && goal.desk) {
        actor.x = goal.desk.seat.x;
        actor.y = goal.desk.seat.y;
        actor.mode = 'arrived';
        actor.goalId = 'desk' + goal.desk.index;
        actor.pose = 'desk';
        actor.facing = goal.desk.seat.facing;
      }
    }

    function steer(actor, target, dt, now) {
      if (actor.goalId !== target.id) {
        // novo destino: levanta (se sentado) e calcula rota
        actor.goalId = target.id;
        actor.mode = 'walking';
        actor.pose = null;
        actor.target = target;
        const from = actor.seatAccess || tileOf(actor.x, actor.y);
        if (actor.seatAccess) {
          const c = tileCenter(actor.seatAccess.tx, actor.seatAccess.ty);
          actor.x = c.x;
          actor.y = c.y;
          actor.seatAccess = null;
        }
        const start = WORLD.walkable(from.tx, from.ty) ? from : nearestWalkable(from);
        const path = findPath(start.tx, start.ty, target.access.tx, target.access.ty, (x, y) => y >= WORLD.H - 1);
        actor.path = path || [];
        if (reduceMotion) {
          actor.path = [];
          actor.x = target.x;
          actor.y = target.y;
          arrive(actor, target, now);
          return;
        }
      }
      if (actor.mode === 'arrived') return;
      if (actor.mode === 'walking') {
        let budget = (SPEED * dt) / 1000;
        while (budget > 0) {
          let nx;
          let ny;
          let final = false;
          if (actor.path.length) {
            const c = tileCenter(actor.path[0].tx, actor.path[0].ty);
            nx = c.x;
            ny = c.y;
          } else {
            nx = target.x;
            ny = target.y;
            final = true;
          }
          const dx = nx - actor.x;
          const dy = ny - actor.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.01) {
            if (Math.abs(dx) > Math.abs(dy)) actor.dir = dx > 0 ? 'right' : 'left';
            else actor.dir = dy > 0 ? 'down' : 'up';
          }
          if (dist <= budget) {
            actor.x = nx;
            actor.y = ny;
            budget -= dist;
            if (final) {
              arrive(actor, target, now);
              break;
            }
            actor.path.shift();
          } else {
            actor.x += (dx / dist) * budget;
            actor.y += (dy / dist) * budget;
            budget = 0;
          }
        }
      }
    }

    function nearestWalkable(t) {
      for (let r = 1; r < 6; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (WORLD.walkable(t.tx + dx, t.ty + dy)) return { tx: t.tx + dx, ty: t.ty + dy };
          }
        }
      }
      return { tx: WORLD.entrance.tx, ty: WORLD.entrance.ty - 1 };
    }

    function arrive(actor, target, now) {
      actor.mode = 'arrived';
      actor.pose = target.pose;
      actor.facing = target.facing;
      actor.dir = target.facing === 'right' || target.facing === 'left' ? target.facing : target.facing;
      actor.seatAccess = target.access;
      actor.arrivedAt = now;
    }

    // ── Quadro do sprite conforme pose/estado ───────────────────────
    function frameFor(actor, t) {
      const a = actor.agent;
      if (actor.mode === 'walking') {
        const f = reduceMotion ? 0 : Math.floor(actor.animT / 125) % 4;
        return 'walk:' + actor.dir + ':' + f;
      }
      const pose = actor.pose;
      const slow = Math.floor((t + actor.seed * 37) / 600) % 2;
      if (pose === 'desk') {
        const face = actor.facing === 'up' ? 'up' : 'down';
        if (a.state === 'waiting') return 'sit:' + face + ':hand' + (Math.floor(t / 400) % 2);
        if (a.state === 'writing' || a.state === 'running') return 'sit:' + face + ':type' + (Math.floor((t + actor.seed * 11) / 160) % 2);
        if (a.state === 'reading' || a.state === 'searching') {
          return 'sit:' + face + ':' + (Math.floor((t + actor.seed * 13) / 900) % 3 === 0 ? 'type0' : 'idle');
        }
        return 'sit:' + face + ':idle';
      }
      if (pose === 'wave') return 'wave:down:' + (Math.floor(t / 250) % 2);
      if (pose === 'sit') return (actor.facing === 'up' ? 'sit:up:' : 'sit:down:') + 'idle';
      if (pose === 'sofa') return 'sofa:down:' + (reduceMotion ? 0 : slow);
      if (pose === 'coffee') return 'coffee:down:' + (Math.floor((t + actor.seed * 29) / 1800) % 3 === 0 ? 1 : 0);
      if (pose === 'exit') return 'walk:down:' + (Math.floor(actor.animT / 125) % 4);
      if (pose === 'stand' && actor.target && actor.target.spot && actor.target.spot.kind === 'coffee') {
        return (t - (actor.arrivedAt || 0)) % 7000 < 3000 ? 'stand:up:0' : 'coffee:down:' + (Math.floor(t / 1500) % 2);
      }
      const dir = actor.facing === 'left' || actor.facing === 'right' || actor.facing === 'up' ? actor.facing : 'down';
      return 'stand:' + dir + ':' + (reduceMotion ? 0 : slow);
    }

    function exprFor(actor, t) {
      const a = actor.agent;
      if (a.state === 'error') return 'x';
      if (a.state === 'done' || actor.pose === 'wave') return 'happy';
      if (!reduceMotion && (t + actor.seed * 53) % 3700 < 130) return 'closed';
      if (a.state === 'idle' && (actor.pose === 'sofa' || actor.pose === 'sit') && (t + actor.seed * 17) % 9000 < 2600) return 'closed';
      return 'normal';
    }

    // ── Render ──────────────────────────────────────────────────────
    function render(t) {
      const now = new Date();
      const hour = options.forceHour != null ? options.forceHour : now.getHours() + now.getMinutes() / 60;
      const hourKey = Math.floor(hour);
      if (!staticLayer || staticHour !== hourKey) {
        staticLayer = WORLD.buildStatic(hourKey);
        staticHour = hourKey;
      }
      bctx.drawImage(staticLayer, 0, 0);

      const agentsByDesk = {};
      for (const actor of actors.values()) {
        const a = actor.agent;
        if (a.deskIndex >= 0 && actor.mode === 'arrived' && actor.pose === 'desk') agentsByDesk[a.deskIndex] = a;
      }
      const coffeeBusy = [...actors.values()].some((x) => x.mode === 'arrived' && x.target && x.target.spot && x.target.spot.kind === 'coffee');
      const lightsOn = actors.size > 0;
      const env = { t, now, agentsByDesk, stats, spark, coffeeBusy, lightsOn, dominant: dominantState() };
      WORLD.drawDynamicBackground(bctx, env);

      // lista y-sort: mobília + atores
      const list = [];
      for (const o of WORLD.objects) if (!o.floor) list.push({ y: o.sortY, o });
      for (const actor of actors.values()) {
        let sy = actor.y;
        if (actor.mode === 'arrived' && actor.pose === 'desk') {
          const d = WORLD.desks[actor.agent.deskIndex];
          if (d) sy = d.seat.sortY;
        }
        if (actor.mode === 'arrived' && actor.pose === 'sit' && actor.facing === 'up') sy = actor.y - 2;
        list.push({ y: sy, a: actor });
      }
      list.sort((p, q) => p.y - q.y);

      // sombras dos atores no chão
      for (const actor of actors.values()) {
        if (actor.mode === 'arrived' && (actor.pose === 'desk' || actor.pose === 'sit')) continue;
        bctx.fillStyle = 'rgba(20,14,30,' + 0.28 * actor.alpha + ')';
        bctx.fillRect(Math.round(actor.x) - 5, Math.round(actor.y) - 1, 10, 2);
        bctx.fillRect(Math.round(actor.x) - 4, Math.round(actor.y) - 2, 8, 1);
      }

      // anel de seleção/destaque no chão
      for (const id of [selected, highlighted]) {
        const actor = id && actors.get(id);
        if (!actor) continue;
        const pulse = reduceMotion ? 0 : Math.floor(t / 200) % 2;
        bctx.strokeStyle = id === selected ? P.accentHi : P.yellowHi;
        bctx.lineWidth = 1;
        bctx.strokeRect(Math.round(actor.x) - 7 - pulse + 0.5, Math.round(actor.y) - 3 - pulse + 0.5, 14 + pulse * 2, 5 + pulse * 2);
      }

      for (const item of list) {
        if (item.o) {
          const o = item.o;
          if (o.img) bctx.drawImage(o.img, o.x, o.y);
          if (o.dyn) o.dyn(bctx, env);
        } else {
          const actor = item.a;
          actor.look.expr = exprFor(actor, t);
          const name = frameFor(actor, t);
          bctx.globalAlpha = Math.max(0, Math.min(1, actor.alpha));
          CH.draw(bctx, actor.look, name, actor.x, actor.y);
          bctx.globalAlpha = 1;
        }
      }

      // bola de pingue-pongue quando os dois lados estão ocupados
      const p0 = [...actors.values()].find((x) => x.mode === 'arrived' && x.target && x.target.id === 'pong0');
      const p1 = [...actors.values()].find((x) => x.mode === 'arrived' && x.target && x.target.id === 'pong1');
      if (p0 && p1) {
        const ph = (t / 900) % 2;
        const k = ph < 1 ? ph : 2 - ph;
        const bx = 10 * T + 4 + k * 40;
        const by = 12 * T - 2 - Math.sin(k * Math.PI) * 6;
        bctx.fillStyle = 'rgba(0,0,0,0.25)';
        bctx.fillRect(Math.round(bx), 12 * T + 2, 2, 1);
        bctx.fillStyle = P.white;
        bctx.fillRect(Math.round(bx), Math.round(by), 2, 2);
      }

      drawLighting(env, hour, t);

      present(t);
    }

    // Estado mais urgente entre os agentes (para telas ambiente).
    const URGENCY = ['error', 'waiting', 'running', 'writing', 'reading', 'searching', 'thinking', 'done', 'idle'];
    function dominantState() {
      let best = 'idle';
      for (const actor of actors.values()) {
        const st = actor.agent.state;
        if (URGENCY.indexOf(st) >= 0 && URGENCY.indexOf(st) < URGENCY.indexOf(best)) best = st;
      }
      return actors.size ? best : null;
    }

    function headY(actor) {
      const seated = actor.mode === 'arrived' && (actor.pose === 'desk' || actor.pose === 'sit');
      if (seated) return actor.y - 22;
      if (actor.pose === 'sofa' && actor.mode === 'arrived') return actor.y - 21;
      return actor.y - 24;
    }

    function drawLighting(env, hour, t) {
      const night = hour < 6.5 || hour >= 18.5;
      const dusk = !night && (hour < 8 || hour >= 17);
      const target = env.lightsOn ? (night ? 0.3 : dusk ? 0.12 : 0) : night ? 0.58 : dusk ? 0.4 : 0.3;
      ambient += (target - ambient) * 0.05;
      if (ambient < 0.02) return;
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, WORLD.PX_W, WORLD.PX_H);
      lctx.fillStyle = 'rgba(8,10,34,' + ambient.toFixed(3) + ')';
      lctx.fillRect(0, 0, WORLD.PX_W, WORLD.PX_H);
      lctx.globalCompositeOperation = 'destination-out';
      const glow = (x, y, r, a) => {
        const g = lctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(0,0,0,' + a + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        lctx.fillStyle = g;
        lctx.fillRect(x - r, y - r, r * 2, r * 2);
      };
      // janelas de dia
      if (!night) {
        glow(10 * T + 23, 3 * T + 8, 46, 0.7);
        glow(21 * T + 25, 3 * T + 8, 46, 0.7);
      }
      // letreiro
      const flicker = reduceMotion ? 1 : (t % 7000 < 90 ? 0.4 : 1);
      glow(14 * T + 48, T + 16, 44, 0.75 * flicker);
      // monitores ocupados
      for (const d of WORLD.desks) {
        const a = env.agentsByDesk[d.index];
        if (!a) continue;
        glow(d.x + 16, d.deskY + (d.row === 'far' ? 4 : -2), 26, 0.85);
      }
      for (const L of WORLD.lights) glow(L.x, L.y, L.r, 0.6);
      if (env.lightsOn) {
        // pendentes de luz sobre as ilhas
        for (const cx of [12, 17, 22]) glow(cx * T, 6 * T, 52, 0.55);
      }
      lctx.globalCompositeOperation = 'source-over';
      bctx.drawImage(lightCanvas, 0, 0);
      // brilho colorido aditivo (neon, telas)
      bctx.save();
      bctx.globalCompositeOperation = 'lighter';
      const colored = (x, y, r, color, a) => {
        const g = bctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(color, a * ambient * 1.6));
        g.addColorStop(1, rgba(color, 0));
        bctx.fillStyle = g;
        bctx.fillRect(x - r, y - r, r * 2, r * 2);
      };
      colored(14 * T + 30, T + 12, 30, '#ff8a5b', 0.35 * flicker);
      colored(14 * T + 60, T + 20, 30, '#4fe0ff', 0.3 * flicker);
      for (const L of WORLD.lights) colored(L.x, L.y, L.r, L.color, L.a * 2);
      for (const d of WORLD.desks) {
        const a = env.agentsByDesk[d.index];
        if (!a) continue;
        colored(d.x + 16, d.deskY + 2, 20, WORLD.stateColor(a.state), 0.3);
      }
      bctx.restore();
    }

    // ── Apresentação (escala nítida + textos em alta resolução) ──────
    function layout() {
      const rect = display.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      view.dpr = dpr;
      view.cssW = Math.max(50, Math.floor(rect.width));
      view.cssH = Math.max(50, Math.floor(rect.height));
      display.style.width = view.cssW + 'px';
      display.style.height = view.cssH + 'px';
      display.width = Math.floor(view.cssW * dpr);
      display.height = Math.floor(view.cssH * dpr);
      const fit = Math.min(display.width / WORLD.PX_W, display.height / WORLD.PX_H);
      if (!view.userZoom) {
        // Painel estreito (barra lateral): aproxima até ficar legível e
        // centra nas mesas; arrastar move a câmera, ▣ volta ao mapa inteiro.
        if (fit / dpr < 0.95) {
          view.zoom = Math.min(6, Math.ceil(Math.log((1.25 * dpr) / fit) / Math.log(1.25)));
          const sc = fit * Math.pow(1.25, view.zoom);
          view.panX = ((WORLD.PX_W / 2 - FOCUS.x) * sc) / dpr;
          view.panY = ((WORLD.PX_H / 2 - FOCUS.y) * sc) / dpr;
        } else {
          view.zoom = 0;
          view.panX = 0;
          view.panY = 0;
        }
      }
      const scale = view.zoom ? fit * Math.pow(1.25, view.zoom) : fit;
      view.scale = scale;
      const w = WORLD.PX_W * scale;
      const h = WORLD.PX_H * scale;
      view.ox = Math.round((display.width - w) / 2 + view.panX * dpr);
      view.oy = Math.round((display.height - h) / 2 + view.panY * dpr);
      clampPan();
      const k = Math.min(8, Math.max(1, Math.ceil(scale)));
      if (!inter || inter.width !== WORLD.PX_W * k) {
        inter = canvas(WORLD.PX_W * k, WORLD.PX_H * k);
      }
    }

    function clampPan() {
      const w = WORLD.PX_W * view.scale;
      const h = WORLD.PX_H * view.scale;
      if (w <= display.width) view.ox = Math.round((display.width - w) / 2);
      else view.ox = Math.min(0, Math.max(display.width - w, view.ox));
      if (h <= display.height) view.oy = Math.round((display.height - h) / 2);
      else view.oy = Math.min(0, Math.max(display.height - h, view.oy));
    }

    function present(t) {
      const s = view.scale;
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.fillStyle = '#0b0c10';
      dctx.fillRect(0, 0, display.width, display.height);
      const w = Math.round(WORLD.PX_W * s);
      const h = Math.round(WORLD.PX_H * s);
      if (Math.abs(s - Math.round(s)) < 0.001) {
        dctx.imageSmoothingEnabled = false;
        dctx.drawImage(buffer, view.ox, view.oy, w, h);
      } else {
        // sharp-bilinear: vizinho mais próximo até k inteiro, bilinear até o alvo
        const k = inter.width / WORLD.PX_W;
        const ictx = inter.getContext('2d');
        ictx.imageSmoothingEnabled = false;
        ictx.drawImage(buffer, 0, 0, inter.width, inter.height);
        dctx.imageSmoothingEnabled = true;
        dctx.imageSmoothingQuality = 'high';
        dctx.drawImage(inter, view.ox, view.oy, w, h);
        void k;
      }
      drawLabels(t);
    }

    function toScreen(x, y) {
      return { x: view.ox + x * view.scale, y: view.oy + y * view.scale };
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    // Plaquinha de nome em cima da cabeça (pedido do dono: "o nome dele
    // em cima da cabeça").
    function drawLabels(t) {
      const dpr = view.dpr;
      const fontPx = Math.max(9, Math.min(13, Math.round(view.scale * 3.6 / dpr))) * dpr;
      dctx.font = '600 ' + fontPx + 'px ' + (options.font || 'system-ui, sans-serif');
      dctx.textBaseline = 'middle';
      dctx.textAlign = 'center';

      // mesas recém-liberadas: nome esmaecido
      for (const g of ghosts) {
        const d = WORLD.desks[g.deskIndex];
        if (!d) continue;
        const pos = toScreen(d.seat.x, d.seat.y - 24);
        tag(pos.x, pos.y, g.label, null, 0.35, false, fontPx);
      }

      const list = [...actors.values()].sort((a, b) => a.x - b.x);
      const placed = [];
      for (const actor of list) {
        if (actor.alpha < 0.2) continue;
        const a = actor.agent;
        const pos = toScreen(actor.x, headY(actor) - 3);
        const info = AO.sourceInfo(a.source);
        const emphasis = actor.id === selected || actor.id === hover || actor.id === highlighted;
        const icon = iconFor(actor);
        // Plaquinhas vizinhas que colidem sobem um degrau (até dois).
        const size = tagSize(a.displayName || a.label, info.color, fontPx, icon);
        let y = pos.y;
        for (let k = 0; k < 2; k++) {
          const hit = placed.some((r) => pos.x - size.w / 2 < r.x2 && pos.x + size.w / 2 > r.x1 && y - size.h < r.y2 && y > r.y1);
          if (!hit) break;
          y -= size.h + 2 * view.dpr;
        }
        placed.push({ x1: pos.x - size.w / 2 - view.dpr, x2: pos.x + size.w / 2 + view.dpr, y1: y - size.h, y2: y });
        const top = tag(pos.x, y, a.displayName || a.label, info.color, actor.alpha, emphasis, fontPx, a.state, icon);
        if (a.state === 'waiting') bang(pos.x, top, fontPx, t + actor.seed * 91);
      }

      // tooltip do hover
      const h = hover && actors.get(hover);
      if (h) {
        const a = h.agent;
        const pos = toScreen(h.x, h.y + 4);
        const line1 = (a.displayName || a.label) + (a.role ? ' · ' + a.role : '');
        const line2 = (a.currentAction || stateLabel(a.state)) + (a.project ? ' — ' + a.project : '');
        const small = Math.round(fontPx * 0.92);
        dctx.font = '600 ' + small + 'px ' + (options.font || 'system-ui, sans-serif');
        const w1 = dctx.measureText(line1).width;
        dctx.font = '400 ' + small + 'px ' + (options.font || 'system-ui, sans-serif');
        const w2 = dctx.measureText(line2).width;
        const w = Math.max(w1, w2) + 16 * dpr;
        const hh = small * 2 + 14 * dpr;
        let x = pos.x - w / 2;
        x = Math.max(4 * dpr, Math.min(display.width - w - 4 * dpr, x));
        let y = pos.y + 6 * dpr;
        if (y + hh > display.height - 4 * dpr) y = pos.y - hh - view.scale * 30;
        dctx.fillStyle = 'rgba(13,13,12,0.92)';
        roundRect(dctx, x, y, w, hh, 5 * dpr);
        dctx.fill();
        dctx.strokeStyle = 'rgba(255,255,255,0.12)';
        dctx.lineWidth = dpr;
        dctx.stroke();
        dctx.textAlign = 'left';
        dctx.fillStyle = '#eceae6';
        dctx.font = '600 ' + small + 'px ' + (options.font || 'system-ui, sans-serif');
        dctx.fillText(line1, x + 8 * dpr, y + 5 * dpr + small / 2);
        dctx.fillStyle = '#a8a39b';
        dctx.font = '400 ' + small + 'px ' + (options.font || 'system-ui, sans-serif');
        dctx.fillText(line2, x + 8 * dpr, y + 9 * dpr + small * 1.5);
        dctx.textAlign = 'center';
      }
      void t;
    }

    function iconFor(actor) {
      const a = actor.agent;
      if (actor.mode === 'walking') return null;
      if (actor.target && actor.target.spot && (actor.target.spot.kind === 'coffee' || actor.target.spot.kind === 'stool')) return 'coffee';
      if (a.state === 'idle') return actor.pose === 'desk' ? 'idle' : null;
      return ICONS[a.state] ? a.state : null;
    }

    function pixelIcon(name, x, y, px, color) {
      const icon = ICONS[name];
      if (!icon) return;
      dctx.fillStyle = color;
      for (let j = 0; j < 5; j++) {
        for (let i = 0; i < 7; i++) {
          if (icon[j][i] === '#') dctx.fillRect(Math.round(x + i * px), Math.round(y + j * px), px, px);
        }
      }
    }

    function tagSize(text, color, fontPx, icon) {
      const dpr = view.dpr;
      const px = Math.max(1, Math.round(fontPx / 9));
      const tw = dctx.measureText(String(text || '').slice(0, 22)).width;
      return { w: tw + 10 * dpr + (color ? 7 * dpr : 0) + (icon ? 7 * px + 5 * dpr : 0), h: fontPx + 5 * dpr };
    }

    function tag(cx, cy, text, color, alpha, emphasis, fontPx, state, icon) {
      const dpr = view.dpr;
      const label = String(text || '').slice(0, 22);
      const tw = dctx.measureText(label).width;
      const dot = color ? 7 * dpr : 0;
      const px = Math.max(1, Math.round(fontPx / 9));
      const iw = icon ? 7 * px + 5 * dpr : 0;
      const padX = 5 * dpr;
      const w = tw + padX * 2 + dot + iw;
      const h = fontPx + 5 * dpr;
      const x = Math.round(cx - w / 2);
      const y = Math.round(cy - h);
      dctx.globalAlpha = alpha;
      const waiting = state === 'waiting';
      const error = state === 'error';
      dctx.fillStyle = waiting ? 'rgba(224,184,74,0.96)' : error ? 'rgba(170,52,52,0.94)' : 'rgba(13,13,12,0.8)';
      roundRect(dctx, x, y, w, h, h / 2);
      dctx.fill();
      if (emphasis) {
        dctx.strokeStyle = P.accentHi;
        dctx.lineWidth = 1.5 * dpr;
        dctx.stroke();
      }
      if (color) {
        dctx.fillStyle = waiting ? '#3a2a05' : color;
        dctx.beginPath();
        dctx.arc(x + padX + 2.5 * dpr, y + h / 2, 2.5 * dpr, 0, Math.PI * 2);
        dctx.fill();
      }
      const fg = waiting ? '#241a02' : '#f3f1ec';
      dctx.fillStyle = fg;
      dctx.fillText(label, x + padX + dot + tw / 2, y + h / 2 + 0.5 * dpr);
      if (icon) {
        const ix = x + padX + dot + tw + 4 * dpr;
        const iy = y + (h - 5 * px) / 2;
        const col = waiting || error ? fg : ICON_TAG_COLOR[icon] || '#cfcac2';
        pixelIcon(icon, ix, iy, px, col);
      }
      dctx.globalAlpha = 1;
      return y;
    }

    // Balão "!" quicando acima da plaquinha: o único estado que exige você.
    function bang(cx, top, fontPx, t) {
      const dpr = view.dpr;
      const px = Math.max(2, Math.round(fontPx / 6));
      const bob = reduceMotion ? 0 : Math.round(Math.sin(t / 170) * 2 * dpr);
      const w = 7 * px;
      const h = 9 * px;
      const x = Math.round(cx - w / 2);
      const y = Math.round(top - h - 3 * dpr + bob);
      dctx.fillStyle = '#1b1726';
      dctx.fillRect(x + px, y, w - 2 * px, h);
      dctx.fillRect(x, y + px, w, h - 2 * px);
      dctx.fillStyle = P.yellow;
      dctx.fillRect(x + px, y + px, w - 2 * px, h - 2 * px);
      dctx.fillStyle = '#1b1726';
      dctx.fillRect(x + 3 * px, y + 2 * px, px, 3 * px);
      dctx.fillRect(x + 3 * px, y + 6 * px, px, px);
      dctx.fillRect(x + 3 * px, y + h, px, px);
    }

    function stateLabel(s) {
      return (
        {
          idle: 'ocioso',
          thinking: 'pensando',
          reading: 'lendo',
          writing: 'escrevendo',
          running: 'rodando comando',
          searching: 'pesquisando',
          waiting: 'aguardando você',
          error: 'erro',
          done: 'concluiu'
        }[s] || s
      );
    }

    // ── Interação ───────────────────────────────────────────────────
    function pick(clientX, clientY) {
      const r = display.getBoundingClientRect();
      const x = ((clientX - r.left) * view.dpr - view.ox) / view.scale;
      const y = ((clientY - r.top) * view.dpr - view.oy) / view.scale;
      let best = null;
      for (const actor of actors.values()) {
        const top = headY(actor) - 4;
        if (x >= actor.x - 8 && x <= actor.x + 8 && y >= top && y <= actor.y + 2) {
          if (!best || actor.y > best.y) best = actor;
        }
      }
      return best ? best.id : null;
    }

    let drag = null;
    display.addEventListener('mousemove', (e) => {
      if (drag) {
        view.panX = drag.px + (e.clientX - drag.x);
        view.panY = drag.py + (e.clientY - drag.y);
        layout();
        return;
      }
      const id = pick(e.clientX, e.clientY);
      hover = id;
      display.style.cursor = id ? 'pointer' : view.zoom > 0 ? 'grab' : 'default';
    });
    display.addEventListener('mouseleave', () => {
      hover = null;
      drag = null;
    });
    display.addEventListener('mousedown', (e) => {
      if (!pick(e.clientX, e.clientY) && view.zoom > 0) drag = { x: e.clientX, y: e.clientY, px: view.panX, py: view.panY };
    });
    window.addEventListener('mouseup', () => {
      drag = null;
    });
    display.addEventListener('click', (e) => {
      const id = pick(e.clientX, e.clientY);
      selected = id && id !== selected ? id : null;
      if (options.onSelect) options.onSelect(selected);
    });
    display.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );

    function zoomBy(step) {
      view.userZoom = true;
      if (step === 0) {
        view.zoom = 0;
        view.panX = 0;
        view.panY = 0;
      } else {
        view.zoom = Math.max(0, Math.min(6, view.zoom + step));
        if (view.zoom === 0) {
          view.panX = 0;
          view.panY = 0;
        }
      }
      layout();
    }

    // ── Loop ────────────────────────────────────────────────────────
    let last = performance.now();
    let acc = 0;
    let running = true;
    function loop(ts) {
      if (!running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(100, ts - last);
      last = ts;
      acc += dt;
      if (acc < 1000 / 30) return; // 30 fps bastam para pixel art
      const step = acc;
      acc = 0;
      if (document.hidden) return;
      update(step, ts);
      render(ts);
    }

    const ro = new ResizeObserver(() => layout());
    ro.observe(display.parentElement);
    layout();
    requestAnimationFrame(loop);

    return {
      setAgents,
      setStats,
      select(id) {
        selected = id;
      },
      highlight(id) {
        highlighted = id;
      },
      zoomBy,
      layout,
      /** Para testes/screenshots: avança a simulação sem esperar tempo real. */
      simulate(ms) {
        const stepMs = 50;
        for (let i = 0; i < ms; i += stepMs) {
          last += stepMs;
          update(stepMs, last);
        }
        render(last);
      },
      stop() {
        running = false;
        ro.disconnect();
      },
      actors
    };
  }

  AO.scene = { mount, findPath, lookSeed };
})();
