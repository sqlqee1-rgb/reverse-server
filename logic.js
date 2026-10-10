/* REVERSE — pure game logic. No DOM. Deterministic given the seed.
 * Board: 5x5, cells 0..24 (row-major).
 *   outer ring (16 cells) turns clockwise, inner ring (8 cells) counter-clockwise, core (12) never moves.
 * Turn:
 *   1. place the current tile on an empty cell
 *   2. instant merge: equal tiles touching the placed one fuse into it (v * 2^(k-1)), repeats while it keeps matching
 *   3. the rings turn one step (REVERSE booster flips both directions for this turn)
 *   4. gear merges: every group of equal neighbours fuses, x2 points, repeats until stable
 */
(function (root) {
  'use strict';

  var N = 5, CELLS = 25, CORE = 12;
  var OUTER = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5]; // clockwise order
  var INNER = [6, 7, 8, 13, 18, 17, 16, 11];                              // clockwise order
  var RING = [], RIDX = [], NB = [];
  OUTER.forEach(function (c, i) { RING[c] = 'o'; RIDX[c] = i; });
  INNER.forEach(function (c, i) { RING[c] = 'i'; RIDX[c] = i; });
  RING[CORE] = 'c'; RIDX[CORE] = 0;
  for (var c = 0; c < CELLS; c++) {
    var r = (c / N) | 0, k = c % N, n = [];
    if (r > 0) n.push(c - N);
    if (r < N - 1) n.push(c + N);
    if (k > 0) n.push(c - 1);
    if (k < N - 1) n.push(c + 1);
    NB[c] = n;
  }
  var BOOSTERS = ['reverse', 'swap', 'hammer'];
  var BOOSTER_CAP = 3;

  /* ---------- rng (mulberry32, state kept in the game state so saves resume exactly) ---------- */
  function rand(st) {
    st.rs = (st.rs + 0x6D2B79F5) >>> 0;
    var t = st.rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  /* ---------- geometry ---------- */
  function dest(cell, rev) {
    var ring = RING[cell];
    if (ring === 'o') return OUTER[(RIDX[cell] + (rev ? 15 : 1)) % 16];
    if (ring === 'i') return INNER[(RIDX[cell] + (rev ? 1 : 7)) % 8];
    return cell;
  }
  function dist(c) { return Math.abs(((c / N) | 0) - 2) + Math.abs((c % N) - 2); }

  /* ---------- spawning ---------- */
  var BALANCE = {
    base: [[2, 50], [4, 33], [8, 17]],
    tiers: [[256, 16, 9], [1024, 32, 7], [4096, 64, 5]], // [maxTile reached, value, weight]
    ramp: [],                                             // [moves made, value, weight]
    startTiles: 4,
    firstMilestone: 64,
    bolt: { first: 10, every: 10, min: 4, faster: 30, keepFree: 3, bonus: 25 },
    duel: { seconds: 150, maxHit: 4 }
  };
  function spawn(st) {
    var table = BALANCE.base.slice();
    BALANCE.tiers.forEach(function (t) { if (st.maxTile >= t[0]) table.push([t[1], t[2]]); });
    BALANCE.ramp.forEach(function (t) { if (st.moves >= t[0]) table.push([t[1], t[2]]); });
    var total = 0; table.forEach(function (e) { total += e[1]; });
    var x = rand(st) * total;
    for (var i = 0; i < table.length; i++) { x -= table[i][1]; if (x < 0) return table[i][0]; }
    return table[0][0];
  }

  /* ---------- state ---------- */
  function newGame(opts) {
    opts = opts || {};
    var seed = opts.seed != null ? (opts.seed >>> 0) : ((Math.random() * 4294967296) >>> 0);
    var st = {
      ver: 1, mode: opts.mode || 'classic', day: opts.day || null, seed: seed, rs: seed,
      rules: opts.rules || null,
      board: new Array(CELLS).fill(null), queue: [], score: 0, moves: 0, maxTile: 0, nextId: 1,
      boosters: { reverse: 1, swap: 1, hammer: 1 }, rewardIdx: 0,
      nextMilestone: BALANCE.firstMilestone, reverseArmed: false, jammed: false, over: false,
      nextBolt: BALANCE.bolt.first,
      run: { merges: 0, gear: 0, core: 0, bestCombo: 0, used: 0, reverses: 0, bolts: 0 }
    };
    var free = [];
    for (var c = 0; c < CELLS; c++) if (c !== CORE) free.push(c);
    var placed = 0, guard = 0;
    while (placed < BALANCE.startTiles && guard++ < 200) {
      var cell = free.splice((rand(st) * free.length) | 0, 1)[0];
      var v = [2, 4, 8][(rand(st) * 3) | 0];
      if (NB[cell].some(function (n) { return st.board[n] && st.board[n].v === v; })) { free.push(cell); continue; }
      st.board[cell] = { id: st.nextId++, v: v };
      st.maxTile = Math.max(st.maxTile, v);
      placed++;
    }
    for (var i = 0; i < 3; i++) st.queue.push(spawn(st));
    if (st.rules && st.rules.bolts === false) st.nextBolt = 1e12;
    if (st.rules && st.rules.hammer === false) st.boosters.hammer = 0;
    return st;
  }

  function clone(st) { return JSON.parse(JSON.stringify(st)); }
  function empties(st) { var e = []; for (var c = 0; c < CELLS; c++) if (!st.board[c]) e.push(c); return e; }

  function component(board, start) {
    var t = board[start]; if (!t || !t.v) return [];
    var seen = {}, out = [], stack = [start]; seen[start] = 1;
    while (stack.length) {
      var c = stack.pop(); out.push(c);
      NB[c].forEach(function (n) {
        if (!seen[n] && board[n] && board[n].v === t.v) { seen[n] = 1; stack.push(n); }
      });
    }
    return out;
  }
  function allGroups(board) {
    var seen = {}, groups = [];
    for (var c = 0; c < CELLS; c++) {
      if (!board[c] || !board[c].v || seen[c]) continue;
      var g = component(board, c);
      g.forEach(function (x) { seen[x] = 1; });
      if (g.length >= 2) groups.push(g);
    }
    return groups;
  }
  function fuse(st, group, anchor, combo, gear) {
    var b = st.board, base = b[anchor].v;
    var nv = base * Math.pow(2, group.length - 1);
    var core = group.indexOf(CORE) >= 0;
    var pts = nv * combo * (gear ? 2 : 1) * (core ? 2 : 1);
    var from = [], broke = [];
    group.forEach(function (c) {
      NB[c].forEach(function (n) {
        if (b[n] && !b[n].v) { broke.push({ id: b[n].id, cell: n }); b[n] = null; }
      });
    });
    pts += broke.length * BALANCE.bolt.bonus * combo;
    st.run.bolts = (st.run.bolts || 0) + broke.length;
    group.forEach(function (c) { if (c !== anchor) { from.push({ id: b[c].id, cell: c }); b[c] = null; } });
    b[anchor] = { id: b[anchor].id, v: nv };
    st.score += pts;
    st.maxTile = Math.max(st.maxTile, nv);
    st.run.merges++;
    if (gear) st.run.gear++;
    if (core) st.run.core++;
    return { to: anchor, id: b[anchor].id, from: from, broke: broke, base: base, v: nv, size: group.length, pts: pts, core: core };
  }

  function grantRewards(st, events) {
    while (st.maxTile >= st.nextMilestone) {
      var kind = null;
      for (var tries = 0; tries < 3; tries++) {
        var k = BOOSTERS[st.rewardIdx % 3]; st.rewardIdx++;
        if (k === 'hammer' && st.rules && st.rules.hammer === false) continue;
        if (st.boosters[k] < BOOSTER_CAP) { kind = k; break; }
      }
      if (kind) st.boosters[kind]++;
      else st.score += st.nextMilestone;
      events.push({ type: 'reward', kind: kind, at: st.nextMilestone, bonus: kind ? 0 : st.nextMilestone });
      st.nextMilestone *= 2;
    }
  }

  /* rusty bolts: dead cells that turn with the rings; a merge next to one breaks it */
  function dropBolt(st, ev) {
    var B = BALANCE.bolt;
    if (st.nextBolt == null) st.nextBolt = B.first;
    if (st.moves < st.nextBolt) return;
    var free = empties(st).filter(function (c) { return c !== CORE; });
    if (free.length < B.keepFree) return;
    var cell = free[(rand(st) * free.length) | 0];
    var t = { id: st.nextId++, v: 0 };
    st.board[cell] = t;
    st.nextBolt = st.moves + Math.max(B.min, B.every - Math.floor(st.moves / B.faster));
    ev.push({ type: 'bolt', cell: cell, id: t.id });
  }

  /* one full turn. returns the list of events for the animator */
  function place(st, cell) {
    if (st.over || st.jammed || st.board[cell]) return null;
    var ev = [], combo = 0;
    var v = st.queue.shift(); st.queue.push(spawn(st));
    var t = { id: st.nextId++, v: v };
    st.board[cell] = t;
    ev.push({ type: 'place', cell: cell, id: t.id, v: v });

    // phase A: instant merges around the placed tile
    for (;;) {
      var g = component(st.board, cell);
      if (g.length < 2) break;
      combo++;
      ev.push({ type: 'merge', gear: false, combo: combo, groups: [fuse(st, g, cell, combo, false)] });
    }

    // phase B: the gears turn
    var rev = st.reverseArmed; st.reverseArmed = false;
    if (rev) st.run.reverses++;
    var nb = new Array(CELLS).fill(null), moves = [];
    for (var c = 0; c < CELLS; c++) {
      if (!st.board[c]) continue;
      var d = dest(c, rev);
      nb[d] = st.board[c];
      if (d !== c) moves.push({ id: st.board[c].id, from: c, to: d });
    }
    st.board = nb;
    ev.push({ type: 'rotate', rev: rev, moves: moves });

    // phase C: gear merges cascade
    for (;;) {
      var groups = allGroups(st.board);
      if (!groups.length) break;
      combo++;
      var res = groups.map(function (gr) {
        var anchor = gr.slice().sort(function (a, b) {
          if (a === CORE) return -1; if (b === CORE) return 1;
          return dist(a) - dist(b) || st.board[b].id - st.board[a].id;
        })[0];
        return fuse(st, gr, anchor, combo, true);
      });
      ev.push({ type: 'merge', gear: true, combo: combo, groups: res });
    }
    st.run.bestCombo = Math.max(st.run.bestCombo, combo);
    st.moves++;
    grantRewards(st, ev);
    dropBolt(st, ev);

    if (!empties(st).length) {
      if (st.boosters.hammer > 0 && !(st.rules && st.rules.hammer === false)) { st.jammed = true; ev.push({ type: 'jam' }); }
      else { st.over = true; ev.push({ type: 'over' }); }
    }
    return ev;
  }

  function hammer(st, cell) {
    if (st.over || st.boosters.hammer <= 0 || !st.board[cell]) return null;
    var t = st.board[cell];
    st.board[cell] = null;
    st.boosters.hammer--; st.run.used++;
    st.jammed = false;
    return [{ type: 'hammer', cell: cell, id: t.id, v: t.v }];
  }
  function swap(st) {
    if (st.over || st.jammed || st.boosters.swap <= 0) return null;
    var q = st.queue; var a = q[0]; q[0] = q[1]; q[1] = a;
    st.boosters.swap--; st.run.used++;
    return [{ type: 'swap' }];
  }
  function toggleReverse(st) {
    if (st.over || st.jammed) return null;
    if (st.reverseArmed) { st.reverseArmed = false; st.boosters.reverse++; st.run.used--; }
    else { if (st.boosters.reverse <= 0) return null; st.reverseArmed = true; st.boosters.reverse--; st.run.used++; }
    return [{ type: 'reverse', armed: st.reverseArmed }];
  }
  function giveUp(st) { st.jammed = false; st.over = true; return [{ type: 'over' }]; }

  /* what would happen if the current tile went to `cell` */
  function preview(st, cell) {
    if (st.over || st.jammed || st.board[cell]) return null;
    var s = clone(st), ev = place(s, cell), pts = 0, instant = [], gear = [], land = cell, finalV = st.queue[0];
    var placedId = s.nextId - 1;
    ev.forEach(function (e) {
      if (e.type === 'merge') e.groups.forEach(function (g) {
        pts += g.pts;
        g.from.forEach(function (f) { (e.gear ? gear : instant).push(f.id); });
        (e.gear ? gear : instant).push(g.id);
        if (g.id === placedId) finalV = g.v;
      });
      if (e.type === 'rotate') e.moves.forEach(function (m) { if (m.id === placedId) land = m.to; });
    });
    return { pts: pts, instant: instant, gear: gear, land: land, value: finalV, placedId: placedId };
  }

  /* ---------- duel helpers ---------- */
  // bolts a move sends to the opponent: every merge step after the first in one move is one bolt,
  // and every gear (rotation) merge step adds one more
  function attack(ev) {
    var steps = 0, gear = 0;
    (ev || []).forEach(function (e) { if (e.type === 'merge') { steps++; if (e.gear) gear++; } });
    return Math.min(BALANCE.duel.maxHit, Math.max(0, steps - 1) + gear);
  }
  // garbage never fills the last free cell: you only lose by filling the board yourself
  function pickGarbage(st, n, rnd) {
    var free = empties(st).filter(function (c) { return c !== CORE; }), out = [];
    var room = Math.max(0, empties(st).length - 1);
    n = Math.min(n, room, free.length);
    for (var i = 0; i < n; i++) out.push(free.splice((rnd() * free.length) | 0, 1)[0]);
    return out;
  }
  function addBolts(st, cells) {
    var ev = [];
    cells.forEach(function (c) {
      if (st.board[c]) return;
      var t = { id: st.nextId++, v: 0 };
      st.board[c] = t; ev.push({ type: 'bolt', cell: c, id: t.id, garbage: true });
    });
    return ev;
  }
  // owner mode (enabled only by the server for one secret key): double points, and the board never jams —
  // when it gets tight, bolts and then the smallest tiles are cleared. Deterministic on purpose.
  function bossAssist(st, ev) {
    var gained = 0, removed = [];
    (ev || []).forEach(function (e) { if (e.type === 'merge') e.groups.forEach(function (g) { gained += g.pts; }); });
    st.score += gained;
    if (empties(st).length <= 2) {
      var cells = [];
      for (var c = 0; c < CELLS; c++) if (st.board[c]) cells.push(c);
      cells.sort(function (a, b) { return (st.board[a].v - st.board[b].v) || (a - b); }); // bolts (v=0) first
      for (var i = 0; i < cells.length && empties(st).length < 7; i++) {
        var t = st.board[cells[i]];
        removed.push({ id: t.id, cell: cells[i], v: t.v });
        st.board[cells[i]] = null;
      }
      st.over = false; st.jammed = false;
    }
    return { bonus: gained, removed: removed };
  }
  function hash(st) {
    var s = st.score + '|' + st.queue.join(',') + '|' + st.board.map(function (t) { return t ? t.v : '-'; }).join(',');
    return hashSeed(s);
  }

  var api = {
    N: N, CELLS: CELLS, CORE: CORE, OUTER: OUTER, INNER: INNER, RING: RING, NB: NB, BALANCE: BALANCE,
    dest: dest, newGame: newGame, place: place, hammer: hammer, swap: swap, toggleReverse: toggleReverse,
    giveUp: giveUp, preview: preview, empties: empties, clone: clone, hashSeed: hashSeed, allGroups: allGroups,
    attack: attack, pickGarbage: pickGarbage, addBolts: addBolts, hash: hash, bossAssist: bossAssist,
    DUEL_RULES: { bolts: false, hammer: false }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(this);
