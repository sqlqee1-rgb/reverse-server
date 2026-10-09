/* Reverse — duel server.
 *
 * Realtime 1v1: both players get the same seed (same tiles), play their own boards for 2:30,
 * combos send bolts to the opponent, filling your own board is a knockout.
 *
 * Server-authoritative: clients predict locally for zero-latency feel, the server replays every
 * move with the very same logic.js and answers with a hash. Garbage cells are chosen here, so both
 * sides stay identical; any mismatch triggers a full resync.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// shared rules: the standalone server repo ships a copy next to this file, the game repo uses the client's file
const L = (() => { try { return require('./logic.js'); } catch (e) { return require('../web/js/logic.js'); } })();

const PORT = +process.env.PORT || 8080;
const PROTOCOL = 1;
const COUNTDOWN = 3000;
const DURATION = L.BALANCE.duel.seconds * 1000;
const GRACE = 25000;          // how long a dropped player keeps their seat
const REMATCH_WINDOW = 30000;
const ROOM_TTL = 10 * 60000;

const players = new Map();    // id -> Player
const byToken = new Map();    // token -> Player
const rooms = new Map();      // code -> { host, at }
const matches = new Set();
let queue = [];
const startedAt = Date.now();
let totalMatches = 0;

const rid = (n) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();
// nicknames are the only user text other players see, so the obvious slurs and obscenities are filtered out
const BAD_WORDS = /(х[уy][йияеёю]|п[иi]зд|(?:^|[^а-яё])[её]б[ауил]|(?:за|на|вы|по|от|про|до|подъ|отъ|у)[её]б[аули]|бля|муда[кч]|пид[оа]р|шлюх|f+u+c+k|sh[i1]t|c+u+n+t|n[i1]gg|f[a@]gg?ot|wh[o0]re|b[i1]tch|porn|nazi|hitler)/i;
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  if (s.length < 2 || BAD_WORDS.test(s.replace(/[\s._*-]/g, ''))) return 'Player';
  return s;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const compact = (st) => st.board.map((t) => (t ? t.v : -1));

class Player {
  constructor(ws, name, bot) {
    this.id = rid(6); this.token = rid(16); this.name = cleanName(name); this.ws = ws; this.bot = !!bot;
    this.match = null; this.side = 0; this.room = null; this.offlineAt = 0; this.rate = { t: 0, n: 0 };
    if (!bot) { players.set(this.id, this); byToken.set(this.token, this); }
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  get online() { return this.bot || (this.ws && this.ws.readyState === 1); }
}

class Match {
  constructor(a, b) {
    this.id = rid(5);
    this.seed = crypto.randomBytes(4).readUInt32LE(0);
    this.p = [a, b];
    this.st = [0, 1].map(() => L.newGame({ mode: 'duel', seed: this.seed, rules: L.DUEL_RULES }));
    this.seq = [0, 0]; this.pend = [0, 0]; this.sent = [0, 0];
    this.rng = [mulberry(this.seed ^ 0x51ed), mulberry(this.seed ^ 0xa3c1)];
    this.startAt = now() + COUNTDOWN; this.endAt = this.startAt + DURATION;
    this.over = false; this.result = null; this.wantRematch = [false, false];
    a.match = this; a.side = 0; b.match = this; b.side = 1;
    removeFromQueue(a); removeFromQueue(b); closeRoom(a); closeRoom(b);
    matches.add(this); totalMatches++;
    this.timer = setTimeout(() => this.finish('time'), this.endAt - now());
    this.p.forEach((p, side) => p.send(this.startMsg(side)));
    if (b.bot) this.botLoop(1);
    if (a.bot) this.botLoop(0);
  }
  startMsg(side) {
    const o = this.p[1 - side];
    return { type: 'start', id: this.id, seed: this.seed, side, countdown: Math.max(0, this.startAt - now()), duration: DURATION,
      you: { name: this.p[side].name }, opp: { name: o.name, bot: o.bot } };
  }
  oppMsg(side) {
    const st = this.st[side];
    return { type: 'opp', score: st.score, board: compact(st), pending: this.pend[side], moves: st.moves, max: st.maxTile };
  }
  resumeMsg(side) {
    const o = 1 - side;
    return { type: 'resume', id: this.id, seed: this.seed, side, you: { name: this.p[side].name },
      opp: { name: this.p[o].name, bot: this.p[o].bot, online: this.p[o].online }, state: this.st[side], seq: this.seq[side],
      pending: this.pend[side], oppState: this.oppMsg(o), countdown: Math.max(0, this.startAt - now()), left: Math.max(0, this.endAt - now()),
      over: this.over, result: this.over ? this.endMsg(side) : null };
  }

  move(p, m) {
    if (this.over) return;
    const side = p.side, st = this.st[side], other = this.p[1 - side];
    if (now() < this.startAt - 250) return p.send({ type: 'error', code: 'early' });
    if (m.seq !== this.seq[side] + 1) return this.resync(p);
    let ev = null;
    if (m.a === 'place' && Number.isInteger(m.c) && m.c >= 0 && m.c < 25 && !st.board[m.c]) ev = L.place(st, m.c);
    else if (m.a === 'rev') ev = L.toggleReverse(st);
    else if (m.a === 'swap') ev = L.swap(st);
    if (!ev) return this.resync(p);
    this.seq[side] = m.seq;
    let sent = 0, cancel = 0, garbage = [];
    if (m.a === 'place') {
      let a = L.attack(ev);
      cancel = Math.min(a, this.pend[side]); this.pend[side] -= cancel; a -= cancel;
      if (a > 0) {
        this.pend[1 - side] += a; this.sent[side] += a; sent = a;
        other.send({ type: 'incoming', n: a, pending: this.pend[1 - side] });
      }
      if (!st.over && this.pend[side] > 0) {
        garbage = L.pickGarbage(st, this.pend[side], this.rng[side]);
        L.addBolts(st, garbage);
        this.pend[side] -= garbage.length;
      }
    }
    p.send({ type: 'ack', seq: m.seq, h: L.hash(st), score: st.score, garbage, pending: this.pend[side], sent, cancel });
    other.send(this.oppMsg(side));
    if (st.over) this.finish('ko', 1 - side);
    else if (other.bot) this.botNudge();
  }
  resync(p) {
    const side = p.side;
    p.send({ type: 'state', state: this.st[side], seq: this.seq[side], pending: this.pend[side] });
  }

  finish(reason, winner) {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.timer); clearTimeout(this.botTimer);
    if (reason === 'time') {
      const a = this.st[0].score, b = this.st[1].score;
      winner = a === b ? -1 : (a > b ? 0 : 1);
    }
    this.result = { reason, winner };
    this.p.forEach((p, side) => p.send(this.endMsg(side)));
    this.closeTimer = setTimeout(() => this.close(), REMATCH_WINDOW);
    console.log(`match ${this.id} ${reason} ${this.st[0].score}:${this.st[1].score}${this.p[1].bot ? ' (bot)' : ''}`);
  }
  endMsg(side) {
    const w = this.result.winner;
    return { type: 'end', result: w === -1 ? 'draw' : (w === side ? 'win' : 'lose'), reason: this.result.reason,
      you: { score: this.st[side].score, max: this.st[side].maxTile, sent: this.sent[side] },
      opp: { score: this.st[1 - side].score, max: this.st[1 - side].maxTile, sent: this.sent[1 - side] }, rematch: REMATCH_WINDOW };
  }
  close() {
    clearTimeout(this.closeTimer); clearTimeout(this.timer); clearTimeout(this.botTimer);
    matches.delete(this);
    this.p.forEach((p) => { if (p.match === this) p.match = null; });
  }
  rematch(p) {
    if (!this.over) return;
    this.wantRematch[p.side] = true;
    const o = this.p[1 - p.side];
    if (o.bot) this.wantRematch[1 - p.side] = true;
    else o.send({ type: 'rematch', from: 'opp' });
    if (this.wantRematch[0] && this.wantRematch[1] && this.p.every((x) => x.online)) {
      const [a, b] = this.p;
      this.close();
      new Match(b.bot ? a : b, b.bot ? b : a); // swap sides each rematch, bots stay second
    }
  }
  leave(p, reason) {
    if (!this.over) this.finish(reason || 'left', 1 - p.side);
    const o = this.p[1 - p.side];
    o.send({ type: 'opp_left' });
    this.close();
  }

  /* ---------- server bot: plays the same rules with human-ish timing ---------- */
  botLoop(side) {
    this.botSide = side;
    const tick = () => {
      if (this.over) return;
      const st = this.st[side];
      const wait = this.startAt - now();
      if (wait > 0) { this.botTimer = setTimeout(tick, wait + 400); return; }
      const cell = botPick(st);
      if (cell == null) return;
      this.move(this.p[side], { seq: this.seq[side] + 1, a: 'place', c: cell });
      if (!this.over) this.botTimer = setTimeout(tick, 950 + Math.random() * 900);
    };
    this.botTimer = setTimeout(tick, Math.max(0, this.startAt - now()) + 700);
  }
  botNudge() { /* the bot keeps its own rhythm; hook left for difficulty tuning */ }
}

function botPick(st) {
  const e = L.empties(st);
  if (!e.length) return null;
  if (Math.random() < 0.55) {
    let best = -1, bc = e[0];
    for (const c of e) { const p = L.preview(st, c); const v = p.pts + Math.random() * 4; if (v > best) { best = v; bc = c; } }
    return bc;
  }
  const v = st.queue[0], near = e.filter((c) => L.NB[c].some((n) => st.board[n] && st.board[n].v === v));
  const pool = near.length ? near : e;
  return pool[(Math.random() * pool.length) | 0];
}

/* ---------- lobby ---------- */
function removeFromQueue(p) { queue = queue.filter((x) => x !== p); }
function closeRoom(p) { if (p.room) { rooms.delete(p.room); p.room = null; } }
function newCode() { let c; do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(c)); return c; }
function onlineCount() { let n = 0; for (const p of players.values()) if (p.online) n++; return n; }

function handle(p, m) {
  switch (m.type) {
    case 'queue':
      if (p.match && !p.match.over) return;
      if (p.match) p.match.leave(p);
      closeRoom(p);
      if (!queue.includes(p)) queue.push(p);
      queue = queue.filter((x) => x.online);
      p.send({ type: 'queued', n: queue.length });
      if (queue.length >= 2) { const a = queue.shift(), b = queue.shift(); new Match(a, b); }
      return;
    case 'bot':
      if (p.match && !p.match.over) return;
      if (p.match) p.match.leave(p);
      removeFromQueue(p); closeRoom(p);
      new Match(p, new Player(null, 'bot', true));
      return;
    case 'room_create':
      if (p.match && !p.match.over) return;
      if (p.match) p.match.leave(p);
      removeFromQueue(p); closeRoom(p);
      p.room = newCode(); rooms.set(p.room, { host: p, at: now() });
      p.send({ type: 'room', code: p.room });
      return;
    case 'room_join': {
      const r = rooms.get(String(m.code || ''));
      if (!r || !r.host.online || r.host === p) return p.send({ type: 'error', code: 'no_room' });
      if (p.match && !p.match.over) return;
      if (p.match) p.match.leave(p);
      removeFromQueue(p); closeRoom(p);
      rooms.delete(r.host.room); r.host.room = null;
      new Match(r.host, p);
      return;
    }
    case 'cancel': removeFromQueue(p); closeRoom(p); return;
    case 'move': if (p.match) p.match.move(p, m); return;
    case 'sync': if (p.match) p.match.resync(p); return;
    case 'resign': if (p.match && !p.match.over) p.match.finish('resign', 1 - p.side); return;
    case 'rematch': if (p.match) p.match.rematch(p); return;
    case 'leave': if (p.match) p.match.leave(p, 'left'); return;
    case 'ping': p.send({ type: 'pong', t: m.t, online: onlineCount() }); return;
  }
}

/* ---------- the game itself as a web app (iPhone: Safari → Add to Home Screen) ---------- */
const WEB = (() => {
  try {
    const pwa = require('./pwa.js');
    const html = fs.readFileSync(path.join(__dirname, 'game.html'));
    const files = {
      '/': { type: 'text/html; charset=utf-8', body: html, cache: 'no-cache' },
      '/manifest.webmanifest': { type: 'application/manifest+json', body: Buffer.from(JSON.stringify(pwa.manifest)), cache: 'public, max-age=3600' },
      '/sw.js': { type: 'text/javascript; charset=utf-8', body: Buffer.from(pwa.sw), cache: 'no-cache' },
    };
    for (const [p, b64] of Object.entries(pwa.icons)) files[p] = { type: 'image/png', body: Buffer.from(b64, 'base64'), cache: 'public, max-age=604800' };
    for (const f of Object.values(files)) if (!f.type.startsWith('image/')) f.gz = zlib.gzipSync(f.body, { level: 9 });
    files['/index.html'] = files['/'];
    console.log('web app', pwa.version, Math.round(html.length / 1024) + 'KB');
    return files;
  } catch (e) { console.log('web app not bundled (' + e.message + ')'); return null; }
})();
function serveWeb(req, res) {
  const f = WEB && WEB[req.url.split('?')[0]];
  if (!f || req.method !== 'GET' && req.method !== 'HEAD') return false;
  const gz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': f.cache, 'Vary': 'Accept-Encoding',
    ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : (gz ? f.gz : f.body));
  return true;
}

/* ---------- transport ---------- */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/healthz' || req.url.startsWith('/healthz?')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, online: onlineCount(), queue: queue.length, matches: matches.size,
      total: totalMatches, uptime: Math.round((now() - startedAt) / 1000) }));
    return;
  }
  if (serveWeb(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Reverse duel server\n');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  let me = null;
  ws.on('message', (data) => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;
    if (!me) {
      if (m.type !== 'hello') return;
      if (m.v !== PROTOCOL) { ws.send(JSON.stringify({ type: 'error', code: 'old_client' })); return; }
      const old = m.token && byToken.get(String(m.token));
      if (old) {            // reconnect: take the seat back
        if (old.ws && old.ws !== ws) try { old.ws.terminate(); } catch (e) { }
        me = old; me.ws = ws; me.offlineAt = 0; if (m.name) me.name = cleanName(m.name);
      } else me = new Player(ws, m.name);
      me.send({ type: 'welcome', id: me.id, token: me.token, online: onlineCount(), protocol: PROTOCOL });
      if (me.match) {
        me.send(me.match.resumeMsg(me.side));
        me.match.p[1 - me.side].send({ type: 'opp_status', online: true });
      }
      return;
    }
    const t = now();
    if (t - me.rate.t > 1000) { me.rate.t = t; me.rate.n = 0; }
    if (++me.rate.n > 25) { if (me.rate.n > 80) ws.terminate(); return; }
    try { handle(me, m); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    if (!me || me.ws !== ws) return;
    me.ws = null; me.offlineAt = now();
    removeFromQueue(me); closeRoom(me);
    const m = me.match;
    if (m && !m.over) m.p[1 - me.side].send({ type: 'opp_status', online: false });
  });
});

// heartbeat, abandoned seats, stale rooms, lobby counters
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch (e) { } });
}, 25000);
setInterval(() => {
  const t = now();
  for (const p of players.values()) {
    if (p.ws || !p.offlineAt || t - p.offlineAt < GRACE) continue;
    if (p.match) p.match.leave(p, 'left');
    players.delete(p.id); byToken.delete(p.token);
  }
  for (const [code, r] of rooms) if (t - r.at > ROOM_TTL || !r.host.online) { rooms.delete(code); r.host.room = null; }
}, 5000);
setInterval(() => {
  const n = onlineCount();
  for (const p of players.values()) if (!p.match) p.send({ type: 'online', n, queue: queue.length });
}, 15000);

server.listen(PORT, '0.0.0.0', () => console.log(`reverse duel server on :${PORT}`));
process.on('SIGTERM', () => { wss.clients.forEach((ws) => ws.close(1012, 'restart')); server.close(() => process.exit(0)); });

module.exports = { server, wss };
