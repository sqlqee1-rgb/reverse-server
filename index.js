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
const R = (() => { try { return require('./rank.js'); } catch (e) { return require('../web/js/rank.js'); } })();
const Store = require('./store.js');
const BotsLib = require('./bots.js');
const createSocial = require('./social.js');
const Pay = require('./payments.js');
let store = Store.create(process.env.DATABASE_URL);
let geo = null; try { geo = require('geoip-country'); } catch (e) { console.log('geoip-country not installed'); }
let COUNTRIES = null; try { COUNTRIES = new Set(Object.keys(require('countries-list').countries)); } catch (e) { }

const PORT = +process.env.PORT || 8080;
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
function isBoss(key) {
  if (!ADMIN_KEY || typeof key !== 'string' || key.length !== ADMIN_KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
}
const PROTOCOL = 2;
const COUNTDOWN = 3000;
const DURATION = L.BALANCE.duel.seconds * 1000;
const GRACE = 25000;          // how long a dropped player keeps their seat
const REMATCH_WINDOW = 30000;
const ROOM_TTL = 10 * 60000;
const BOT_WAIT = [6000, 14000];  // if nobody fits by then, a bot of the same level takes the game

const players = new Map();    // id -> Player
const byToken = new Map();    // token -> Player
const rooms = new Map();      // code -> { host, at }
const matches = new Set();
const byAcc = new Map();      // account id -> Player (one live seat per account)
let queue = [];               // casual: first come, first served
let ranked = [];              // ranked: { p, since }, paired by rating with a widening window
let season = R.seasonId();
let shopCache = null;
const bots = new BotsLib.Bots(store, () => season);

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
const isOwnerCode = (k) => isBoss(k);
const social = createSocial({
  R, bots, players, byAcc, BAD_WORDS, cleanName, isBoss,
  store: () => store,
  busy: (p) => busy(p), freeUp: (p) => freeUp(p), meMsg: (p) => meMsg(p), inQueue: (p) => inQueue(p),
  newMatch: (a, b) => new Match(a, b),
  onChange: () => topCache.clear(), topChanged: () => topCache.clear(), shopChanged: () => { shopCache = null; },
});
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const compact = (st) => st.board.map((t) => (t ? t.v : -1));

class Player {
  constructor(ws, acc, bot) {
    this.id = rid(6); this.token = rid(16); this.ws = ws; this.bot = !!bot; this.acc = acc || null;
    this.name = acc ? acc.name : 'bot';
    this.match = null; this.side = 0; this.room = null; this.offlineAt = 0; this.rate = { t: 0, n: 0 }; this.lastOpp = null; this.recent = [];
    this.blocked = new Set();
    this.level = 0.5;   // bots: 0 weakest .. 1 strongest; the training bot sits in the middle
    if (!bot) { players.set(this.id, this); byToken.set(this.token, this); if (acc) byAcc.set(acc.id, this); }
  }
  card() {
    if (this.bot && !this.acc) return { bot: true, name: 'bot', avatar: this.avatar || 0 };
    const a = this.acc;
    const g = social.isGlobal(a);
    return { id: a.id, sid: a.sid, name: a.name, cc: a.cc, avatar: a.avatar, rating: g ? null : a.rating, sGames: g ? null : a.sGames, rank: g ? 'global' : undefined,
      games: a.games, wins: a.wins, streak: a.streak, badge: social.badgeOf(a), badges: social.badgesOf(a) };
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  get online() { return this.bot || (this.ws && this.ws.readyState === 1); }
}

class Match {
  constructor(a, b, opts) {
    this.id = rid(5);
    this.ranked = !!(opts && opts.ranked) && !!a.acc && !!b.acc;
    this.seed = crypto.randomBytes(4).readUInt32LE(0);
    this.p = [a, b];
    this.st = [0, 1].map(() => L.newGame({ mode: 'duel', seed: this.seed, rules: L.DUEL_RULES }));
    this.seq = [0, 0]; this.pend = [0, 0]; this.sent = [0, 0];
    this.rng = [mulberry(this.seed ^ 0x51ed), mulberry(this.seed ^ 0xa3c1)];
    this.startAt = now() + COUNTDOWN; this.endAt = this.startAt + DURATION;
    this.over = false; this.result = null; this.wantRematch = [false, false];
    a.match = this; a.side = 0; b.match = this; b.side = 1;
    removeFromQueue(a); removeFromQueue(b); closeRoom(a); closeRoom(b);
    for (const [x, y] of [[a, b], [b, a]]) if (y.acc) { x.lastOpp = y.acc.id; x.recent = [y.acc.id, ...x.recent.filter((i) => i !== y.acc.id)].slice(0, 3); }
    for (const x of this.p) if (x.bot && x.acc) bots.busy.add(x.acc.id);
    matches.add(this); totalMatches++;
    this.timer = setTimeout(() => this.finish('time'), this.endAt - now());
    this.p.forEach((p, side) => p.send(this.startMsg(side)));
    if (b.bot) this.botLoop(1);
    if (a.bot) this.botLoop(0);
  }
  startMsg(side) {
    const o = this.p[1 - side];
    return { type: 'start', id: this.id, seed: this.seed, side, ranked: this.ranked, countdown: Math.max(0, this.startAt - now()), duration: DURATION,
      you: this.p[side].card(), opp: o.card() };
  }
  oppMsg(side) {
    const st = this.st[side];
    return { type: 'opp', score: st.score, board: compact(st), pending: this.pend[side], moves: st.moves, max: st.maxTile };
  }
  resumeMsg(side) {
    const o = 1 - side;
    return { type: 'resume', id: this.id, seed: this.seed, side, ranked: this.ranked, duration: DURATION, you: this.p[side].card(),
      opp: { ...this.p[o].card(), online: this.p[o].online }, state: this.st[side], seq: this.seq[side],
      pending: this.pend[side], oppState: this.oppMsg(o), countdown: Math.max(0, this.startAt - now()), left: Math.max(0, this.endAt - now()),
      over: this.over, result: this.over ? this.endMsg(side) : null };
  }

  // owner mode never applies to ranked games
  boss(side) { return !this.ranked && !!this.p[side].boss; }
  move(p, m) {
    if (this.over) return;
    const side = p.side, st = this.st[side], other = this.p[1 - side];
    if (now() < this.startAt - 250) return p.send({ type: 'error', code: 'early' });
    if (m.seq !== this.seq[side] + 1) return this.resync(p);
    let ev = null;
    if (m.a === 'place' && Number.isInteger(m.c) && m.c >= 0 && m.c < 25 && !st.board[m.c]) {
      ev = L.place(st, m.c);
      if (ev && this.boss(side)) L.bossAssist(st, ev);
    }
    else if (m.a === 'rev') ev = L.toggleReverse(st);
    else if (m.a === 'swap') ev = L.swap(st);
    if (!ev) return this.resync(p);
    this.seq[side] = m.seq;
    let sent = 0, cancel = 0, garbage = [];
    if (m.a === 'place') {
      let a = L.attack(ev);
      if (this.boss(side)) a = Math.min(L.BALANCE.duel.maxHit + 2, a * 2 + (ev.some((e) => e.type === 'merge') ? 1 : 0));
      cancel = Math.min(a, this.pend[side]); this.pend[side] -= cancel; a -= cancel;
      if (a > 0) {
        this.sent[side] += a; sent = a;
        if (!this.boss(1 - side)) {   // attacks on the owner look sent but never land
          this.pend[1 - side] += a;
          other.send({ type: 'incoming', n: a, pending: this.pend[1 - side] });
        }
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
      const bs = this.ranked ? -1 : this.p.findIndex((x) => x.boss);
      if (bs >= 0 && !this.p[1 - bs].boss && this.st[bs].score <= this.st[1 - bs].score)
        this.st[bs].score = this.st[1 - bs].score + 2 * (5 + Math.floor(Math.random() * 60));
      const a = this.st[0].score, b = this.st[1].score;
      winner = a === b ? -1 : (a > b ? 0 : 1);
    }
    this.result = { reason, winner };
    this.closeTimer = setTimeout(() => this.close(), REMATCH_WINDOW);
    console.log(`match ${this.id} ${this.ranked ? 'ranked ' : ''}${reason} ${this.st[0].score}:${this.st[1].score}${this.p[1].bot ? ' (bot)' : ''}`);
    const send = () => this.p.forEach((p, side) => { p.send(this.endMsg(side)); if (this.rating && p.acc) p.send(meMsg(p)); });
    if (this.ranked) this.settle().catch((e) => console.error('rating update failed', e)).then(send); else send();
  }
  // ranked: Elo update for both accounts, one transaction with the match record
  async settle() {
    const [A, B] = this.p.map((p) => p.acc), w = this.result.winner;
    const mult = BotsLib.farmMult(await store.pairCount(A.id, B.id, now() - 864e5));   // the same two accounts farming each other
    const { dA, dB, before } = BotsLib.applyResult(A, B, w, this.result.reason, mult);
    await store.saveMatch({ id: this.id, season: A.season, reason: this.result.reason, winner: w, a: A.id, b: B.id, aName: A.name, bName: B.name,
      aCc: A.cc, bCc: B.cc, aAvatar: A.avatar, bAvatar: B.avatar, aScore: this.st[0].score, bScore: this.st[1].score,
      aRating: before[0], bRating: before[1], aDelta: dA, bDelta: dB }, A, B);
    this.rating = [{ before: before[0], after: A.rating, delta: dA, sGames: A.sGames, capped: mult < 1 },
      { before: before[1], after: B.rating, delta: dB, sGames: B.sGames, capped: mult < 1 }];
    topCache.clear();
  }
  endMsg(side) {
    const w = this.result.winner;
    return { type: 'end', ranked: this.ranked, result: w === -1 ? 'draw' : (w === side ? 'win' : 'lose'), reason: this.result.reason,
      you: { score: this.st[side].score, max: this.st[side].maxTile, sent: this.sent[side] },
      opp: { score: this.st[1 - side].score, max: this.st[1 - side].maxTile, sent: this.sent[1 - side] }, rematch: this.ranked ? 0 : REMATCH_WINDOW,
      rating: this.rating && !social.isGlobal(this.p[side].acc) ? this.rating[side] : null, global: social.isGlobal(this.p[side].acc) || undefined };
  }
  close() {
    clearTimeout(this.closeTimer); clearTimeout(this.timer); clearTimeout(this.botTimer);
    matches.delete(this);
    this.p.forEach((p) => { if (p.match === this) p.match = null; if (p.bot && p.acc) bots.busy.delete(p.acc.id); });
  }
  rematch(p) {
    if (!this.over || this.ranked) return;   // ranked pairs always go back through matchmaking
    this.wantRematch[p.side] = true;
    const o = this.p[1 - p.side];
    if (o.bot) this.wantRematch[1 - p.side] = true;
    else o.send({ type: 'rematch', from: 'opp' });
    if (this.wantRematch[0] && this.wantRematch[1] && this.p.every((x) => x.online)) {
      const [a, b] = this.p;
      this.close();
      if (b.bot && !b.acc) b.avatar = (b.avatar + 13) % 96;
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
      const me = this.p[side], cell = BotsLib.pick(st, me.level);
      if (cell == null) return;
      this.move(me, { seq: this.seq[side] + 1, a: 'place', c: cell });
      if (!this.over) this.botTimer = setTimeout(tick, BotsLib.thinkTime(me.level));
    };
    this.botTimer = setTimeout(tick, Math.max(0, this.startAt - now()) + 500 + Math.random() * 900);
  }
  botNudge() { /* the bot keeps its own rhythm; hook left for difficulty tuning */ }
}

/* ---------- lobby ---------- */
function removeFromQueue(p) { queue = queue.filter((x) => x !== p); ranked = ranked.filter((e) => e.p !== p); p.botAt = 0; }
function closeRoom(p) { if (p.room) { rooms.delete(p.room); p.room = null; } }
function newCode() { let c; do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(c)); return c; }
function onlineCount() { return social.onlineCount(); }   // people online plus bots that are "online" on their schedule
function humansOnline() { let n = 0; for (const p of players.values()) if (p.online) n++; return n; }
const inQueue = (p) => queue.includes(p) || ranked.some((e) => e.p === p);
const banned = (p) => p.acc && p.acc.bannedUntil > now();
const busy = (p) => p.match && !p.match.over;
function freeUp(p) { if (p.match) p.match.leave(p); removeFromQueue(p); closeRoom(p); }

function meMsg(p) {
  const a = p.acc;
  if (social.isGlobal(a)) {   // the Global rank hides its own rating too
    const m = meMsgRaw(p); Object.assign(m.me, { rating: null, peak: null, sPeak: null, rank: 'global' }); return m;
  }
  return meMsgRaw(p);
}
function meMsgRaw(p) {
  const a = p.acc;
  return { type: 'me', season: { id: season, n: R.seasonNumber(season), ends: R.seasonEnd(season) },
    me: { id: a.id, sid: a.sid, name: a.name, cc: a.cc, ccChangedAt: a.ccChangedAt, avatar: a.avatar, rating: a.rating, peak: a.peak, games: a.games,
      wins: a.wins, losses: a.losses, draws: a.draws, koWins: a.koWins, streak: a.streak, bestStreak: a.bestStreak,
      sGames: a.sGames, sWins: a.sWins, sPeak: a.sPeak, badge: social.badgeOf(a), badges: social.badgesOf(a), donor: a.donor || 0, owner: social.isOwner(a), creatorOn: a.creatorOn !== false, link: a.link || null,
      bannedUntil: a.bannedUntil > now() ? a.bannedUntil : null, mutedUntil: a.mutedUntil > now() ? a.mutedUntil : null } };
}

/* matchmaking: the oldest waiting player gets the closest rating inside both players' windows;
   the window starts at ±100 and widens 25 per second, after a minute anyone fits */
function windowOf(e, t) { const w = (t - e.since) / 1000; return w >= 60 ? Infinity : 100 + 25 * w; }
function matchmake() {
  const t = now();
  ranked = ranked.filter((e) => e.p.online && !busy(e.p));
  ranked.sort((x, y) => x.since - y.since);
  const used = new Set();
  for (const e of ranked) {
    if (used.has(e)) continue;
    let best = null, bd = Infinity;
    for (const f of ranked) {
      if (f === e || used.has(f) || f.p.acc.id === e.p.acc.id) continue;
      const d = Math.abs(e.p.acc.rating - f.p.acc.rating);
      if (d > windowOf(e, t) || d > windowOf(f, t)) continue;
      // avoid instant re-pairing with the last opponent while others might come
      const again = e.p.lastOpp === f.p.acc.id && t - e.since < 30000 ? 400 : 0;
      if (d + again < bd) { bd = d + again; best = f; }
    }
    if (best) { used.add(e); used.add(best); new Match(e.p, best.p, { ranked: true }); }
  }
  // nobody close enough came in time: a bot of the same level takes the game (ranked counts as usual)
  for (const e of ranked) {
    if (used.has(e) || t < e.botAt) continue;
    if (botMatch(e.p, true)) used.add(e);
  }
  ranked = ranked.filter((e) => !used.has(e));
  for (const p of queue.slice()) if (p.botAt && t >= p.botAt && p.online && !busy(p)) botMatch(p, false);
  for (const e of ranked) {
    const w = windowOf(e, t);
    e.p.send({ type: 'queued', mode: 'ranked', wait: t - e.since, window: w === Infinity ? null : Math.round(w), n: ranked.length });
  }
}

function botMatch(p, isRanked) {
  const acc = bots.pick(p.acc.rating, new Set(p.recent));
  if (!acc) return false;
  const bp = new Player(null, acc, true); bp.level = bots.level(acc);
  if (Math.random() < 0.5) new Match(p, bp, { ranked: isRanked }); else new Match(bp, p, { ranked: isRanked });
  return true;
}

/* leaderboards are cached briefly: every finished ranked match clears the cache */
const topCache = new Map();
async function topList(cc) {
  const key = season + ':' + (cc || '*'), hit = topCache.get(key);
  if (hit && now() - hit.t < 15000) return hit.list;
  const list = (await store.top(season, cc, 100)).filter((a) => !social.isGlobal(a)).map((a, i) => ({ pos: i + 1, id: a.id, sid: a.sid, name: a.name, cc: a.cc, avatar: a.avatar,
    rating: a.rating, sGames: a.sGames, sWins: a.sWins, badge: social.badgeOf(a), badges: social.badgesOf(a) }));
  topCache.set(key, { t: now(), list });
  return list;
}
async function profileOf(id) {
  const a = await store.get(id);
  if (!a) return null;
  const g = social.isGlobal(a);
  const [world, country, history, seasons] = await Promise.all([g ? null : store.position(a, null), a.cc && !g ? store.position(a, a.cc) : null,
    store.history(a.id, 15), store.seasonsOf(a.id)]);
  const hidden = new Set((await store.getMany([...new Set(history.flatMap((m) => [m.a, m.b]))])).filter((x) => social.isGlobal(x)).map((x) => x.id));
  return {
    p: { id: a.id, sid: a.sid, name: a.name, cc: a.cc, avatar: a.avatar, rating: g ? null : a.rating, peak: g ? null : a.peak, rank: g ? 'global' : undefined, games: a.games, wins: a.wins, losses: a.losses,
      draws: a.draws, koWins: a.koWins, streak: a.streak, bestStreak: a.bestStreak, sGames: g ? null : a.sGames, sWins: a.sWins, sPeak: g ? null : a.sPeak, createdAt: a.createdAt,
      badge: social.badgeOf(a), badges: social.badgesOf(a), link: a.badge === 'inf' || social.isOwner(a) ? a.link || null : null, status: social.statusOf(byAcc.get(a.id) ? byAcc.get(a.id).acc : a) },
    world, country, seasons,
    history: history.map((m) => {
      const me = m.a === a.id ? 'a' : 'b', op = me === 'a' ? 'b' : 'a', side = me === 'a' ? 0 : 1;
      return { at: m.at, reason: m.reason, result: m.winner === -1 ? 'draw' : m.winner === side ? 'win' : 'lose',
        score: m[me + 'Score'], oppScore: m[op + 'Score'], delta: g ? null : m[me + 'Delta'], rating: g ? null : m[me + 'Rating'],
        opp: { id: m[op], name: m[op + 'Name'], cc: m[op + 'Cc'], avatar: m[op + 'Avatar'], rating: hidden.has(m[op]) ? null : m[op + 'Rating'], rank: hidden.has(m[op]) ? 'global' : undefined } };
    }),
  };
}

async function handle(p, m) {
  if (await social.handle(p, m) !== false) return;
  if (['queue', 'bot', 'room_create', 'room_join'].includes(m.type) && banned(p)) return p.send({ type: 'error', code: 'banned', until: p.acc.bannedUntil });
  switch (m.type) {
    case 'queue':
      if (busy(p)) return;
      freeUp(p);
      if (m.mode === 'ranked') {
        ranked.push({ p, since: now(), botAt: now() + BOT_WAIT[0] + Math.random() * (BOT_WAIT[1] - BOT_WAIT[0]) });
        p.send({ type: 'queued', mode: 'ranked', wait: 0, window: 100, n: ranked.length });
        matchmake();
        return;
      }
      queue = queue.filter((x) => x.online);
      queue.push(p); p.botAt = now() + BOT_WAIT[0] + Math.random() * (BOT_WAIT[1] - BOT_WAIT[0]);
      p.send({ type: 'queued', mode: 'casual', n: queue.length });
      if (queue.length >= 2) { const a = queue.shift(), b = queue.shift(); new Match(a, b); }
      return;
    case 'bot': {
      if (busy(p)) return;
      freeUp(p);
      const bot = new Player(null, null, true); bot.avatar = Math.floor(Math.random() * 96);
      new Match(p, bot);
      return;
    }
    case 'room_create':
      if (busy(p)) return;
      freeUp(p);
      p.room = newCode(); rooms.set(p.room, { host: p, at: now() });
      p.send({ type: 'room', code: p.room });
      return;
    case 'room_join': {
      const r = rooms.get(String(m.code || ''));
      if (!r || !r.host.online || r.host === p) return p.send({ type: 'error', code: 'no_room' });
      if (busy(p)) return;
      freeUp(p);
      rooms.delete(r.host.room); r.host.room = null;
      new Match(r.host, p);
      return;
    }
    case 'cancel': removeFromQueue(p); closeRoom(p); return;
    case 'move': if (p.match) p.match.move(p, m); return;
    case 'sync': if (p.match) p.match.resync(p); return;
    case 'resign': if (busy(p)) p.match.finish('resign', 1 - p.side); return;
    case 'rematch': if (p.match) p.match.rematch(p); return;
    case 'leave': if (p.match) p.match.leave(p, 'left'); return;
    case 'ping': p.send({ type: 'pong', t: m.t, online: onlineCount() }); return;

    case 'top': {
      const cc = m.scope === 'country' ? String(m.cc || p.acc.cc || '').toUpperCase().slice(0, 2) : null;
      if (m.scope === 'country' && !cc) return p.send({ type: 'top', scope: 'country', cc: null, list: [], me: null });
      const g = social.isGlobal(p.acc);
      const [list, pos] = await Promise.all([topList(cc), g ? null : store.position(p.acc, cc)]);
      p.send({ type: 'top', scope: cc ? 'country' : 'world', cc, season: { id: season, n: R.seasonNumber(season), ends: R.seasonEnd(season) },
        list, me: { pos, rating: g ? null : p.acc.rating, sGames: g ? null : p.acc.sGames, rank: g ? 'global' : undefined } });
      return;
    }
    case 'delete_account': {
      if (p.match && !p.match.over) return p.send({ type: 'error', code: 'busy' });
      await deleteAccount(p.acc.id);
      return;
    }
    case 'shop': {
      if (!shopCache) shopCache = { url: await store.getMeta('donate_url') };
      p.send({ type: 'shop', products: Pay.PRODUCTS, donateUrl: shopCache.url || null, play: Pay.configured(), tier: p.acc.donor || 0 });
      return;
    }
    case 'purchase': {
      const prod = Pay.PRODUCTS.find((x) => x.sku === m.sku), tok = String(m.token || '');
      if (!prod || !tok) return p.send({ type: 'purchase', ok: false, sku: m.sku, reason: 'bad' });
      try {
        const v = await Pay.verifyPlay(prod.sku, tok);
        if (!v.ok) return p.send({ type: 'purchase', ok: false, sku: prod.sku, reason: v.reason });
        if (await store.addPurchase(tok, p.acc.id, prod.sku, 'play')) await social.grantDonor(p.acc.id, prod.tier, 'Google Play');
        p.send({ type: 'purchase', ok: true, sku: prod.sku, tier: p.acc.donor || prod.tier });
      } catch (e) { console.error('purchase check failed', e.message); p.send({ type: 'purchase', ok: false, sku: prod.sku, reason: 'server' }); }
      return;
    }
    case 'profile': {
      const id = String(m.id || p.acc.id);
      if (id === p.acc.id) await flush(p);
      const prof = await profileOf(id);
      if (prof && id !== p.acc.id) {
        const row = (await store.friendRows(p.acc.id)).find((r) => r.a === id || r.b === id);
        prof.rel = !row ? 'none' : row.state === 'ok' ? 'friend' : row.a === p.acc.id ? 'sent' : 'incoming';
        prof.blocked = p.blocked ? p.blocked.has(id) : false;
      }
      p.send(prof ? { type: 'profile', ...prof, mine: id === p.acc.id } : { type: 'error', code: 'no_profile' });
      return;
    }
    case 'set_name': {
      const n = cleanName(m.name);
      if (n === 'Player' && String(m.name || '').trim() !== 'Player') return p.send({ type: 'error', code: 'bad_name' });
      p.acc.name = p.name = n; await store.patch(p.acc.id, { name: n }); topCache.clear();
      p.send(meMsg(p)); return;
    }
    case 'set_avatar': {
      const a = Math.floor(+m.a);
      if (!(a >= 0 && a < 96)) return;
      p.acc.avatar = a; await store.patch(p.acc.id, { avatar: a }); topCache.clear();
      p.send(meMsg(p)); return;
    }
    case 'set_country': {
      const cc = String(m.cc || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc) || (COUNTRIES && !COUNTRIES.has(cc))) return p.send({ type: 'error', code: 'bad_country' });
      const wait = p.acc.ccChangedAt ? p.acc.ccChangedAt + R.CC_COOLDOWN - now() : 0;
      if (wait > 0) return p.send({ type: 'error', code: 'cc_wait', days: Math.ceil(wait / 864e5) });
      p.acc.cc = cc; p.acc.ccChangedAt = now(); await store.patch(p.acc.id, { cc, ccChangedAt: p.acc.ccChangedAt }); topCache.clear();
      p.send(meMsg(p)); return;
    }
    case 'recovery': p.send({ type: 'recovery', code: await store.newRecovery(p.acc.id) }); return;
  }
}
// make sure the in-memory account is what the database has before reading a profile
async function flush(p) { const fresh = await store.get(p.acc.id); if (fresh) Object.assign(p.acc, fresh); }

/* season change: archive final standings, soft-reset everybody, refresh live players */
let rolling = null;
function ensureSeason() {
  const cur = R.seasonId();
  if (cur === season && rolling === null && ensureSeason.done) return Promise.resolve();
  if (!rolling) rolling = store.rollover(cur).then(async (n) => {
    if (n || cur !== season) {
      season = cur; topCache.clear();
      await bots.reload();
      await social.loadSeasonBadges();
      for (const p of players.values()) if (p.acc) { await flush(p); p.send(meMsg(p)); }
      console.log('season', cur, n ? '(rolled over ' + n + ')' : '');
    }
    ensureSeason.done = true;
  }).finally(() => { rolling = null; });
  return rolling;
}

function countryOf(req, hint) {
  const h = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(h) && h !== 'XX' && h !== 'T1') return h;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const g = geo && geo.lookup(ip.replace(/^::ffff:/, ''));
  if (g && g.country) return g.country;
  hint = String(hint || '').toUpperCase();
  return /^[A-Z]{2}$/.test(hint) && (!COUNTRIES || COUNTRIES.has(hint)) ? hint : null;
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
    if (pwa.privacy) files['/privacy'] = { type: 'text/html; charset=utf-8', body: Buffer.from(pwa.privacy), cache: 'public, max-age=3600' };
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
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, online: onlineCount(), players: humansOnline(), queue: queue.length, ranked: ranked.length, matches: matches.size,
      total: totalMatches, season, store: store.kind, uptime: Math.round((now() - startedAt) / 1000) }));
    return;
  }
  if (req.url.split('?')[0] === '/delete-account') return deletePage(req, res);
  if (serveWeb(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Reverse duel server\n');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  let me = null, opening = false;
  ws.on('message', async (data) => {
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;
    if (!me) {
      if (m.type !== 'hello' || opening) return;
      if (m.v !== PROTOCOL) { ws.send(JSON.stringify({ type: 'error', code: 'old_client' })); return; }
      opening = true;
      try { me = await hello(ws, req, m); } catch (e) { console.error('hello failed', e); ws.send(JSON.stringify({ type: 'error', code: 'server' })); }
      opening = false;
      return;
    }
    const t = now();
    if (t - me.rate.t > 1000) { me.rate.t = t; me.rate.n = 0; }
    if (++me.rate.n > 25) { if (me.rate.n > 80) ws.terminate(); return; }
    try { await handle(me, m); } catch (e) { console.error('handler error', e); me.send({ type: 'error', code: 'server' }); }
  });
  ws.on('close', () => {
    if (!me || me.ws !== ws) return;
    me.ws = null; me.offlineAt = now();
    social.onBye(me).catch(() => { });
    removeFromQueue(me); closeRoom(me);
    const m = me.match;
    if (m && !m.over) m.p[1 - me.side].send({ type: 'opp_status', online: false });
  });
});

/* account deletion (in the app, or on the web page with the transfer code): the seat is closed,
   the profile and season results are removed, past opponents keep an anonymous line in their history */
async function deleteAccount(id) {
  const ok = await store.remove(id);
  const p = byAcc.get(id);
  if (p) {
    freeUp(p);
    players.delete(p.id); byToken.delete(p.token); byAcc.delete(id);
    const ws = p.ws; p.ws = null;
    if (ws) { try { ws.send(JSON.stringify({ type: 'deleted' })); ws.close(4001, 'deleted'); } catch (e) { } }
  }
  topCache.clear();
  console.log('account deleted', id, ok);
  return ok;
}
const delTries = new Map();   // ip -> { n, t }: a few code attempts per hour
function deletePage(req, res) {
  const page = (body) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reverse — удаление аккаунта</title>
<style>body{margin:0;background:#130b30;color:#f6f1ff;font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{max-width:460px;width:100%}h1{font-size:24px;margin:0 0 12px}p{color:#cfc6f2}.box{background:#241a55;border-radius:18px;padding:18px;margin:16px 0;box-shadow:0 4px 0 #0b0620}
input{box-sizing:border-box;width:100%;height:52px;border:0;border-radius:12px;background:#1b1342;color:#fff;font:700 20px monospace;letter-spacing:.08em;text-align:center;text-transform:uppercase}
button{width:100%;height:52px;margin-top:12px;border:0;border-radius:14px;background:#ff4d6d;color:#fff;font:700 17px system-ui;box-shadow:0 4px 0 #8a1830}
small{color:#a99ed8}.ok{color:#5df2a8}.err{color:#ff8fa3}</style></head><body><main>${body}</main></body></html>`);
  };
  const form = (msg) => page(`<h1>Удаление онлайн-аккаунта Reverse</h1>
<p>Онлайн-аккаунт хранит ник, страну, аватар, рейтинг, историю матчей, друзей и сообщения. Его можно удалить в игре: <b>Профиль → Удалить онлайн-аккаунт</b>. Если доступа к телефону нет, введите код переноса (Профиль → Перенос на другой телефон).</p>
<p><small>Delete your Reverse online account: in the game open Profile → Delete online account, or enter your transfer code below. Your profile, rating and season results are removed at once; opponents keep an anonymous line in their match history. Records stored only on your device are removed by uninstalling the app.</small></p>
<form class="box" method="post" action="/delete-account">${msg || ''}<input name="code" maxlength="20" placeholder="XXXX-XXXX-XXXX" autocomplete="off" required><button>Удалить аккаунт / Delete</button></form>`);
  if (req.method === 'GET' || req.method === 'HEAD') return form();
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const t = now(), tr = delTries.get(ip) || { n: 0, t };
  if (t - tr.t > 3600000) { tr.n = 0; tr.t = t; }
  delTries.set(ip, tr);
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy(); });
  req.on('end', async () => {
    if (++tr.n > 8) return form('<p class="err">Слишком много попыток, попробуйте через час.</p>');
    const code = new URLSearchParams(body).get('code') || '';
    try {
      const id = await store.idByCode(code);
      if (!id) return form('<p class="err">Код не подошёл / Wrong code.</p>');
      const p = byAcc.get(id);
      if (p && p.match && !p.match.over) return form('<p class="err">Сейчас идёт матч, попробуйте после него.</p>');
      await deleteAccount(id);
      page('<h1 class="ok">Аккаунт удалён</h1><p>Онлайн-профиль, рейтинг и результаты сезонов удалены. Account deleted.</p>');
    } catch (e) { console.error('delete failed', e); form('<p class="err">Ошибка сервера, попробуйте позже.</p>'); }
  });
}

// sign in (or create an account), then take over this account's live seat if it has one
async function hello(ws, req, m) {
  await ensureSeason();
  let acc = null, created = null, recovered = null;
  if (m.recover) {
    const r = await store.recover(m.recover);
    if (r) { acc = r.acc; recovered = r.secret; }
    else ws.send(JSON.stringify({ type: 'error', code: 'bad_code' }));
  }
  if (!acc && m.acc && m.acc.id && m.acc.secret) acc = await store.auth(String(m.acc.id), String(m.acc.secret));
  if (!acc) {
    const c = await store.create(cleanName(m.name), countryOf(req, m.region), season);
    acc = c.acc; created = c;
  }
  let p = byAcc.get(acc.id);
  if (p) {                                   // reconnect or second device: one seat per account
    if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch (e) { } }
    p.ws = ws; p.offlineAt = 0; Object.assign(p.acc, acc);
  } else p = new Player(ws, acc);
  p.boss = isBoss(m.key);
  p.send({ type: 'welcome', token: p.token, online: onlineCount(), protocol: PROTOCOL, ...(p.boss ? { boss: true } : {}),
    acc: created ? { id: acc.id, secret: created.secret, recovery: created.recovery, created: true }
      : recovered ? { id: acc.id, secret: recovered, recovered: true } : { id: acc.id } });
  p.send(meMsg(p));
  // friends, inbox and moderation state load in the background so the first game messages are never dropped
  social.onHello(p, m).then(() => { if (isOwnerCode(m.key)) p.send(meMsg(p)); }).catch((e) => console.error('social hello failed', e.message));
  if (p.match) {
    p.send(p.match.resumeMsg(p.side));
    p.match.p[1 - p.side].send({ type: 'opp_status', online: true });
  }
  return p;
}

// heartbeat, abandoned seats, stale rooms, lobby counters
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch (e) { } });
}, 25000);
setInterval(() => {
  const t = now();
  for (const p of players.values()) {
    if (p.ws || !p.offlineAt || t - p.offlineAt < GRACE) continue;
    if (p.match) p.match.leave(p, 'left');
    players.delete(p.id); byToken.delete(p.token); if (p.acc && byAcc.get(p.acc.id) === p) byAcc.delete(p.acc.id);
  }
  for (const [code, r] of rooms) if (t - r.at > ROOM_TTL || !r.host.online) { rooms.delete(code); r.host.room = null; }
}, 5000);
setInterval(() => {
  const n = onlineCount();
  for (const p of players.values()) if (!p.match) p.send({ type: 'online', n, queue: queue.length, ranked: ranked.length });
}, 15000);
setInterval(matchmake, 1000);
setInterval(() => { bots.catchUp().then((n) => { if (n) topCache.clear(); }); }, 60000);
setInterval(() => { if (R.seasonId() !== season) ensureSeason().catch((e) => console.error('season rollover failed', e)); }, 60000);

// if the database is unreachable (expired free plan, wrong URL) the game still runs on the in-memory store
// one-time ID moves, "OLD>NEW,OLD>NEW" (default: the owner's 429582 becomes 000001). Each move runs once, recorded in meta.
async function sidMoves() {
  for (const mv of String(process.env.SID_MOVES || '429582>1').split(/[,\s]+/).filter(Boolean)) {
    const [from, to] = mv.split('>').map(Number); if (!from || !to) continue;
    const key = 'sidmove:' + from + '>' + to;
    if (await store.getMeta(key)) continue;
    const r = await store.moveSid(from, to);
    if (r !== 'no_source') await store.setMeta(key, r);
    console.log('id move', from, '->', to, r);
  }
}
const ready = store.init().then(sidMoves).then(() => store.markGlobal(social.GLOBAL_SIDS)).catch((e) => {
  console.error('DATABASE UNAVAILABLE, running on memory store (ratings will not persist):', e.message);
  store = Store.create(null);
  return store.init();
}).then(() => { bots.setStore(store); return ensureSeason(); }).then(() => new Promise((res) => server.listen(PORT, '0.0.0.0', () => {
  console.log(`reverse duel server on :${PORT}, ${store.kind} store, season ${season}`); res();
}))).catch((e) => { console.error('startup failed', e); process.exit(1); });
// bots come up right after: players can already connect while missed background games are filled in
const botsReady = ready.then(() => bots.init()).then(() => { topCache.clear(); return Promise.all([social.loadWorld(), social.loadSeasonBadges()]); }).catch((e) => console.error('bots failed to start', e));
process.on('SIGTERM', () => { wss.clients.forEach((ws) => ws.close(1012, 'restart')); server.close(() => process.exit(0)); });

module.exports = { server, wss, ready, botsReady, bots, social, get store() { return store; } };
