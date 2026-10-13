/* Reverse — ranked opponents that step in when nobody else is searching.
 *
 * Every bot is a regular account (profile, country, avatar, rating, history) with a hidden skill.
 * When it plays a person its moves come from a policy whose quality and pace follow that skill.
 * In the background bots play each other: results are drawn from the skill gap and run through
 * the same Elo, so ratings, leaderboards and match histories stay alive between real games.
 */
'use strict';
const crypto = require('crypto');
const L = (() => { try { return require('./logic.js'); } catch (e) { return require('../web/js/logic.js'); } })();
const R = (() => { try { return require('./rank.js'); } catch (e) { return require('../web/js/rank.js'); } })();

// popular given names in each country, written the way people type them as nicknames
const NAMES = {
  RU: ['Артём', 'Максим', 'Саша', 'Дима', 'Миша', 'Никита', 'Егор', 'Кирилл', 'Матвей', 'Ваня', 'Лёша', 'Даня', 'Тимур', 'Аня', 'Маша',
    'София', 'Полина', 'Алиса', 'Вика', 'Даша', 'Катя', 'Лиза', 'artem', 'maks_07', 'dimon', 'nikitos', 'Lesha', 'kirill_k', 'sonya', 'dasha_r'],
  KZ: ['Алихан', 'Нурислам', 'Айсултан', 'Аружан', 'Томирис', 'Dias', 'Nurik', 'Aigerim', 'Alikhan', 'Ayaru'],
  UZ: ['Sardor', 'Jasur', 'Bekzod', 'Shohruh', 'Madina', 'Malika', 'Dilnoza', 'Javohir', 'Muhammad', 'Sevinch'],
  UA: ['Богдан', 'Олександр', 'Софія', 'Oleh', 'Яна', 'Назар'],
  BY: ['Влад', 'Ксюша', 'nikita_by', 'Илья'],
  KG: ['Айбек', 'Нурбек', 'Aizhan', 'Bekmyrza'],
  KR: ['민준', '서연', '지우', '하준', '도윤', '서윤', 'Seojun', 'jiwoo', 'haneul', 'minjun_'],
  JP: ['Haruto', 'ゆい', 'Ren', 'ひまり', 'Sota', 'Minato'],
  US: ['Liam', 'Olivia', 'noah', 'Emma', 'James', 'ava.m', 'Ethan', 'Mason'],
  BR: ['Miguel', 'Helena', 'Arthur', 'gabriel', 'Laura', 'Heitor'],
  TR: ['Yusuf', 'Zeynep', 'Elif', 'Ömer'],
  DE: ['Lukas', 'Mia', 'Leon', 'Emilia'],
  IN: ['Aarav', 'Ananya', 'Vihaan', 'Saanvi'],
  ID: ['Rizky', 'Putri', 'Dimas', 'Ayu'],
  PH: ['Angel', 'Nathaniel', 'Jhon'],
  VN: ['Minh', 'Linh', 'Huy'],
};
// how many bots come from each country (the game's audience is mostly Russian-speaking and Korean)
const COUNT = { RU: 16, KZ: 5, UZ: 5, UA: 3, BY: 2, KG: 2, KR: 6, JP: 3, US: 5, BR: 3, TR: 2, DE: 2, IN: 2, ID: 2, PH: 1, VN: 1 };
const TZ = { RU: 3, KZ: 5, UZ: 5, UA: 2, BY: 3, KG: 6, KR: 9, JP: 9, US: -5, BR: -3, TR: 3, DE: 1, IN: 5.5, ID: 7, PH: 8, VN: 7 };
// skill bands per league: [low, high, bots]
const BANDS = [[640, 990, 9], [1000, 1290, 12], [1300, 1590, 12], [1600, 1890, 10], [1900, 2190, 9], [2200, 2520, 8]];
const GAMES = [[12, 45], [15, 70], [40, 120], [80, 170], [120, 240], [170, 330]];

const SIM_EVERY = 6 * 60000;              // one background bot game every ~6 minutes (about 8 a day per bot)
const CATCH_UP = 3 * 864e5;               // after the server slept, fill at most 3 days of games
const BACKFILL = 6;                       // games per bot recorded when the roster is first created

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function gauss(rnd) { return Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd()); }

/* the fixed roster: names, countries, avatars, skills; ids are stable so a restart finds the same accounts */
function roster() {
  const rnd = mulberry(0x5eed2026);
  const slots = shuffle(Object.entries(COUNT).flatMap(([cc, n]) => Array(n).fill(cc)), rnd);
  const names = {}; for (const cc of Object.keys(NAMES)) names[cc] = shuffle(NAMES[cc].slice(), rnd);
  const skills = BANDS.flatMap(([lo, hi, n], li) => Array.from({ length: n }, (_, i) =>
    ({ skill: Math.round(lo + (hi - lo) * (i + 0.2 + rnd() * 0.6) / n), league: li })));
  return skills.map((s, i) => {
    const cc = slots[i];
    return { key: i, id: crypto.createHash('sha256').update('reverse-bot:' + i).digest('hex').slice(0, 10), name: names[cc].pop(), cc,
      avatar: Math.floor(rnd() * 96), skill: s.skill, league: s.league };
  });
}

// how well a bot plays: 0 (weakest bronze) .. 1 (top master)
const levelOf = (skill) => Math.max(0, Math.min(1, (skill - 640) / 1880));

/* believable starting stats: replay an Elo career from 1000 against opponents near the current rating */
function career(b, now) {
  const rnd = mulberry(0xb07 + b.key * 7919), s = levelOf(b.skill), [gmin, gmax] = GAMES[b.league];
  const want = gmin + Math.floor(rnd() * (gmax - gmin));
  let r = R.START, peak = r, w = 0, l = 0, d = 0, ko = 0, streak = 0, best = 0, n = 0;
  while (n < want || (Math.abs(r - b.skill) > 60 && n < gmax + 160)) {
    const opp = r + gauss(rnd) * 90, p = R.expected(b.skill, opp), x = rnd();
    const sc = x < 0.02 ? 0.5 : x < 0.02 + 0.98 * p ? 1 : 0;
    r += R.delta(r, opp, sc, n, 1); n++;
    peak = Math.max(peak, r);
    if (sc === 1) { w++; streak = streak > 0 ? streak + 1 : 1; if (rnd() < 0.05 + 0.4 * s) ko++; }
    else if (sc === 0) { l++; streak = streak < 0 ? streak - 1 : -1; } else { d++; streak = 0; }
    best = Math.max(best, streak);
  }
  return { id: b.id, name: b.name, cc: b.cc, avatar: b.avatar, rating: r, peak, games: n, wins: w, losses: l, draws: d, koWins: ko,
    streak, bestStreak: best, sGames: n, sWins: w, sPeak: peak, createdAt: now - (2 + rnd() * 10) * 864e5, skill: b.skill };
}

/* one ranked result applied to two accounts — used for people and bots alike */
function applyResult(A, B, winner, reason, mult) {
  const sA = winner === -1 ? 0.5 : winner === 0 ? 1 : 0;
  const dA = R.delta(A.rating, B.rating, sA, A.games, mult), dB = R.delta(B.rating, A.rating, 1 - sA, B.games, mult);
  const before = [A.rating, B.rating];
  [[A, dA, sA], [B, dB, 1 - sA]].forEach(([x, d, sc]) => {
    x.rating += d; x.peak = Math.max(x.peak, x.rating); x.sPeak = Math.max(x.sPeak, x.rating);
    x.games++; x.sGames++;
    if (sc === 1) { x.wins++; x.sWins++; x.streak = x.streak > 0 ? x.streak + 1 : 1; if (reason === 'ko') x.koWins++; }
    else if (sc === 0) { x.losses++; x.streak = x.streak < 0 ? x.streak - 1 : -1; }
    else { x.draws++; x.streak = 0; }
    x.bestStreak = Math.max(x.bestStreak, x.streak);
  });
  return { dA, dB, before };
}
const farmMult = (n) => (n >= 6 ? 0 : n >= 3 ? 0.5 : 1);

/* ---------- how a bot plays a real match ---------- */
// a move: stronger bots look at the score and at the room left after the move, weaker ones play by feel
function pick(st, s) {
  const e = L.empties(st);
  if (!e.length) return null;
  const r = Math.random();
  if (r < 0.12 * (1 - s)) return e[(Math.random() * e.length) | 0];
  if (r < 0.15 + 0.8 * s) {
    let best = -1e9, bc = e[0];
    for (const c of e) {
      const p = L.preview(st, c), x = L.clone(st); L.place(x, c);
      const v = p.pts + (2 + 6 * s) * L.empties(x).length + Math.random() * 3;
      if (v > best) { best = v; bc = c; }
    }
    return bc;
  }
  const v = st.queue[0], near = e.filter((c) => L.NB[c].some((n) => st.board[n] && st.board[n].v === v));
  const pool = near.length ? near : e;
  return pool[(Math.random() * pool.length) | 0];
}
// pace: weak bots take about 2.4 s a move, the best about 0.9 s, with human-like jitter and pauses
function thinkTime(s) {
  let t = (2.4 - 1.5 * s) * (0.65 + Math.random() * 0.7);
  if (Math.random() < 0.07) t += 1 + Math.random() * 2;
  return t * 1000;
}
// a plausible 2:30 score for a skill level (measured from the policy above)
function scoreFor(s) { return Math.max(40, 2 * Math.round(3370 * Math.exp(1.49 * s) * Math.exp(gauss(Math.random) * 0.33) / 2)); }

/* active hours: people play in the afternoon and evening of their own time zone */
function activity(cc, t) {
  const h = (((new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60 + (TZ[cc] || 0)) % 24) + 24) % 24;
  return h < 2 ? 0.6 : h < 8 ? 0.12 : h < 12 ? 0.55 : h < 18 ? 1 : 1.4;
}
function weighted(list, wf) {
  let sum = 0; const ws = list.map((x) => { const w = Math.max(0, wf(x)); sum += w; return w; });
  let r = Math.random() * sum;
  for (let i = 0; i < list.length; i++) { r -= ws[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}

const SLOT = 15 * 60000;
const hashf = (s) => crypto.createHash('sha1').update(s).digest().readUInt32LE(0) / 4294967296;

class Bots {
  constructor(store, getSeason) { this.store = store; this.season = getSeason; this.list = new Map(); this.busy = new Set(); this.running = false; }
  setStore(store) { this.store = store; }
  level(acc) { return levelOf(acc.skill); }
  isBot(id) { return this.list.has(id); }

  async init() {
    const have = new Map((await this.store.bots()).map((b) => [b.id, b]));
    const now = Date.now(), fresh = [];
    for (const b of roster()) {
      if (have.has(b.id)) continue;
      const acc = { ...career(b, now), season: this.season() };
      await this.store.insertBot(acc);
      fresh.push(acc.id);
    }
    await this.reload();
    this.ready = true;
    if (fresh.length) {
      // a couple of days of recorded games so new profiles have a history
      this.running = true;
      try {
        const n = Math.round(BACKFILL * fresh.length / 2), from = now - 30 * 3600e3;
        for (let i = 0; i < n; i++) await this.simulate(from + (i + Math.random()) * (now - from) / n);
        await this.store.setMeta('botsim', String(now));
      } finally { this.running = false; }
    }
    console.log('bots:', this.list.size, fresh.length ? '(' + fresh.length + ' new)' : '');
    await this.catchUp();
  }
  async reload() {
    this.list = new Map((await this.store.bots()).map((b) => [b.id, b]));
  }

  /* a bot for a person who has been waiting: close in rating, not busy, not someone they just played */
  pick(rating, avoid) {
    const free = [...this.list.values()].filter((b) => !this.busy.has(b.id) && !(avoid && avoid.has(b.id)));
    if (!free.length) return null;
    free.sort((x, y) => Math.abs(x.rating - rating) - Math.abs(y.rating - rating));
    const near = free.slice(0, 4).filter((b, i) => i === 0 || Math.abs(b.rating - rating) <= 160);
    return near[(Math.random() * near.length) | 0];
  }

  /* presence: a 15-minute schedule that follows each bot's time zone; a bot in a real match is "playing" */
  _slot(a, slot) {
    const h = hashf(a.id + ':' + slot), on = Math.min(0.7, activity(a.cc, slot * SLOT + SLOT / 2) * 0.42);
    return h < on * 0.35 ? 'playing' : h < on ? 'online' : null;
  }
  status(a, t) {
    if (this.busy.has(a.id)) return { s: 'playing', ranked: true };
    const slot = Math.floor(t / SLOT), cur = this._slot(a, slot);
    if (cur) return cur === 'playing' ? { s: 'playing', ranked: hashf(a.id + 'r' + slot) < 0.7 } : { s: 'online' };
    for (let k = 1; k < 300; k++) {
      if (this._slot(a, slot - k)) return { s: 'offline', seen: (slot - k + 1) * SLOT - Math.floor(hashf(a.id + 'e' + (slot - k)) * SLOT * 0.7) };
    }
    return { s: 'offline', seen: t - 4 * 864e5 };
  }
  onlineCount(t) {
    const slot = Math.floor(t / SLOT); let n = 0;
    for (const b of this.list.values()) if (this.busy.has(b.id) || this._slot(b, slot)) n++;
    return n;
  }

  /* ---------- background games between bots ---------- */
  async simulate(at) {
    const pool = [...this.list.values()].filter((b) => !this.busy.has(b.id));
    if (pool.length < 2) return null;
    const A = weighted(pool, (b) => activity(b.cc, at));
    const cands = pool.filter((b) => b !== A && Math.abs(b.rating - A.rating) <= 220);
    if (!cands.length) return null;
    const B = weighted(cands, (b) => activity(b.cc, at) / (1 + Math.abs(b.rating - A.rating) / 120));
    const sa = levelOf(A.skill), sb = levelOf(B.skill), p = R.expected(A.skill, B.skill), x = Math.random();
    const winner = x < 0.02 ? -1 : x < 0.02 + 0.98 * p ? 0 : 1;
    const reason = winner !== -1 && Math.random() < 0.05 + 0.45 * (sa + sb) / 2 ? 'ko' : 'time';
    let sc = [scoreFor(sa), scoreFor(sb)];
    if (winner === -1) sc[1] = sc[0];
    else {
      const w = winner, l = 1 - w;
      if (reason === 'time' && sc[w] <= sc[l]) sc[l] = Math.max(20, 2 * Math.round(sc[w] * (0.6 + Math.random() * 0.37) / 2));
      if (reason === 'ko') sc[l] = 2 * Math.round(sc[l] * (0.35 + Math.random() * 0.45) / 2);
    }
    const mult = farmMult(await this.store.pairCount(A.id, B.id, at - 864e5));
    const r = applyResult(A, B, winner, reason, mult);
    await this.store.saveMatch({ id: crypto.randomBytes(5).toString('hex'), at, season: R.seasonId(at) === this.season() ? this.season() : A.season,
      reason, winner, a: A.id, b: B.id, aName: A.name, bName: B.name, aCc: A.cc, bCc: B.cc, aAvatar: A.avatar, bAvatar: B.avatar,
      aScore: sc[0], bScore: sc[1], aRating: r.before[0], bRating: r.before[1], aDelta: r.dA, bDelta: r.dB }, A, B);
    return { A, B, winner };
  }
  // play the games that "happened" while the server slept, then keep going in real time
  async catchUp() {
    if (this.running) return 0;
    this.running = true;
    let n = 0;
    try {
      const now = Date.now();
      let last = +(await this.store.getMeta('botsim')) || now;
      if (now - last > CATCH_UP) last = now - CATCH_UP;
      while (true) {
        const next = last + SIM_EVERY * (0.5 + Math.random());
        if (next > now) break;
        last = next;
        if (await this.simulate(last)) n++;
      }
      await this.store.setMeta('botsim', String(last));
    } catch (e) { console.error('bot games failed', e.message); } finally { this.running = false; }
    return n;
  }
}

module.exports = { Bots, applyResult, farmMult, pick, thinkTime, levelOf, roster, NAMES };
