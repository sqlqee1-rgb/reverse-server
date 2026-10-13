/* Reverse — persistence for accounts, ranked results and seasons.
 * Postgres when DATABASE_URL is set, otherwise an in-memory store with the same API (local runs, tests). */
'use strict';
const crypto = require('crypto');
const R = (() => { try { return require('./rank.js'); } catch (e) { return require('../web/js/rank.js'); } })();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function recoveryCode() {
  const b = crypto.randomBytes(12); let s = '';
  for (let i = 0; i < 12; i++) s += ALPHA[b[i] % ALPHA.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8);
}
const randomSid = () => 100000 + crypto.randomInt(900000);   // short public id players share to add friends
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3');

function fresh(name, cc, season) {
  const id = crypto.randomBytes(5).toString('hex'), secret = crypto.randomBytes(24).toString('hex'), recovery = recoveryCode();
  return {
    acc: { id, name, cc: cc || null, ccChangedAt: null, avatar: crypto.randomBytes(1)[0] % 96, createdAt: Date.now(),
      rating: R.START, peak: R.START, games: 0, wins: 0, losses: 0, draws: 0, koWins: 0, streak: 0, bestStreak: 0,
      season, sGames: 0, sWins: 0, sPeak: R.START, donor: 0 },
    secret, recovery, secretHash: sha(secret), recoveryHash: sha(normCode(recovery)),
  };
}

/* ---------------- in memory ---------------- */
class MemoryStore {
  constructor() {
    this.acc = new Map(); this.sec = new Map(); this.rec = new Map(); this.matches = []; this.seasons = []; this.meta = new Map(); this.kind = 'memory';
    this.sids = new Map(); this.fr = new Map(); this.blk = new Set(); this.msgs = []; this.msgSeq = 0; this.reps = []; this.repSeq = 0;
  }
  async init() {}
  _sid(id) { let s; do { s = randomSid(); } while (this.sids.has(s)); this.sids.set(s, id); return s; }
  async create(name, cc, season) {
    const f = fresh(name, cc, season);
    f.acc.sid = this._sid(f.acc.id); f.acc.creatorOn = true;
    this.acc.set(f.acc.id, f.acc); this.sec.set(f.acc.id, f.secretHash); this.rec.set(f.recoveryHash, f.acc.id);
    return { acc: { ...f.acc }, secret: f.secret, recovery: f.recovery };
  }
  async auth(id, secret) { return this.sec.get(id) === sha(secret) ? { ...this.acc.get(id) } : null; }
  async recover(code) {
    const id = this.rec.get(sha(normCode(code))); if (!id) return null;
    const secret = crypto.randomBytes(24).toString('hex'); this.sec.set(id, sha(secret));
    return { acc: { ...this.acc.get(id) }, secret };
  }
  async newRecovery(id) {
    for (const [h, v] of this.rec) if (v === id) this.rec.delete(h);
    const code = recoveryCode(); this.rec.set(sha(normCode(code)), id); return code;
  }
  async get(id) { const a = this.acc.get(id); return a ? { ...a } : null; }
  async patch(id, fields) { const a = this.acc.get(id); if (a) Object.assign(a, fields); }
  async saveMatch(m, a, b) {
    this.acc.set(a.id, { ...a }); this.acc.set(b.id, { ...b });
    this.matches.unshift({ ...m, at: m.at || Date.now() }); if (this.matches.length > 5000) this.matches.length = 5000;
  }
  async bots() { return [...this.acc.values()].filter((a) => a.bot).map((a) => ({ ...a })); }
  async insertBot(a) {
    if (this.acc.has(a.id)) return;
    this.acc.set(a.id, { ...a, bot: true, ccChangedAt: null, sid: this._sid(a.id), creatorOn: true }); this.sec.set(a.id, sha(crypto.randomBytes(16)));
  }
  async findBySid(sid) { const id = this.sids.get(+sid); return id ? this.get(id) : null; }
  async getMany(ids) { return ids.map((i) => this.acc.get(i)).filter(Boolean).map((a) => ({ ...a })); }
  /* friends: one row per pair, a = who asked; state 'pending' or 'ok' */
  async friendRows(x) { return [...this.fr.values()].filter((r) => r.a === x || r.b === x).map((r) => ({ ...r })); }
  async friendSet(a, b, state) { this.fr.delete(b + '|' + a); this.fr.set(a + '|' + b, { a, b, state, at: Date.now() }); }
  async friendDel(x, y) { this.fr.delete(x + '|' + y); this.fr.delete(y + '|' + x); }
  async blocksOf(x) { return [...this.blk].filter((k) => k.startsWith(x + '|')).map((k) => k.split('|')[1]); }
  async block(a, b) { this.blk.add(a + '|' + b); }
  async unblock(a, b) { this.blk.delete(a + '|' + b); }
  /* messages: dst null = world chat, 'admin' = the owner's moderation chat, otherwise a person */
  async addMsg(m) {
    const row = { id: ++this.msgSeq, at: m.at || Date.now(), src: m.src, dst: m.dst == null ? null : m.dst, text: m.text, kind: m.kind || 'text', data: m.data || null, seen: false };
    this.msgs.push(row); if (this.msgs.length > 20000) this.msgs.shift();
    return { ...row };
  }
  async world(limit) { return this.msgs.filter((m) => m.dst === null).slice(-limit).map((m) => ({ ...m })); }
  async adminChat(limit) { return this.msgs.filter((m) => m.dst === 'admin').slice(-limit).map((m) => ({ ...m })); }
  async convo(x, y, limit) { return this.msgs.filter((m) => (m.src === x && m.dst === y) || (m.src === y && m.dst === x)).slice(-limit).map((m) => ({ ...m })); }
  async dmList(x) {
    const by = new Map();
    for (const m of this.msgs) {
      if (m.dst === null || m.dst === 'admin') continue;
      if (m.src !== x && m.dst !== x) continue;
      const p = m.src === x ? m.dst : m.src, e = by.get(p) || { partner: p, last: null, unread: 0 };
      e.last = { ...m }; if (m.dst === x && !m.seen) e.unread++;
      by.set(p, e);
    }
    return [...by.values()].sort((a, b) => b.last.id - a.last.id);
  }
  async markSeen(x, y) { for (const m of this.msgs) if (m.dst === x && m.src === y) m.seen = true; }
  async unread(x) { return this.msgs.filter((m) => m.dst === x && !m.seen).length; }
  async getMsg(id) { const m = this.msgs.find((q) => q.id === +id); return m ? { ...m } : null; }
  async setMsgData(id, data) { const m = this.msgs.find((q) => q.id === +id); if (m) m.data = data; }
  async prune() { const t = Date.now() - 7 * 864e5; this.msgs = this.msgs.filter((m) => m.dst !== null || m.at > t); }
  /* reports */
  async addReport(r) { const row = { id: ++this.repSeq, at: Date.now(), state: 'open', action: null, msg: null, ...r }; this.reps.push(row); return { ...row }; }
  async getReport(id) { const r = this.reps.find((q) => q.id === +id); return r ? { ...r } : null; }
  async setReport(id, f) { const r = this.reps.find((q) => q.id === +id); if (r) Object.assign(r, f); }
  async openReports(limit) { return this.reps.filter((r) => r.state === 'open').slice(-limit).map((r) => ({ ...r })); }
  async reportStats(target) { const l = this.reps.filter((r) => r.target === target); return { total: l.length, open: l.filter((r) => r.state === 'open').length }; }
  async reportsBy(src, since) { return this.reps.filter((r) => r.src === src && r.at > since).length; }
  async openReportOf(src, target) { const r = this.reps.find((q) => q.src === src && q.target === target && q.state === 'open'); return r ? { ...r } : null; }
  async getMeta(k) { return this.meta.get(k) || null; }
  async seasonBadges() { return this.seasons.filter((x) => x.rank <= 100).map((x) => ({ account: x.account, season: x.season, rank: x.rank })); }
  async addPurchase(token, account, sku, source) { this.buys = this.buys || new Map(); if (this.buys.has(token)) return false; this.buys.set(token, { account, sku, source }); return true; }
  async setMeta(k, v) { this.meta.set(k, String(v)); }
  async pairCount(x, y, since) { return this.matches.filter((m) => m.at > since && ((m.a === x && m.b === y) || (m.a === y && m.b === x))).length; }
  _board(season, cc) {
    const now = Date.now();
    return [...this.acc.values()].filter((a) => a.season === season && a.sGames >= R.PLACEMENT && (!cc || a.cc === cc) && !(a.bannedUntil > now))
      .sort((p, q) => q.rating - p.rating || q.sWins - p.sWins || p.createdAt - q.createdAt);
  }
  async top(season, cc, limit) { return this._board(season, cc).slice(0, limit).map((a) => ({ ...a })); }
  async position(acc, cc) {
    if (acc.sGames < R.PLACEMENT) return null;
    const i = this._board(acc.season, cc).findIndex((a) => a.id === acc.id); return i < 0 ? null : i + 1;
  }
  async history(id, limit) { return this.matches.filter((m) => m.a === id || m.b === id).sort((p, q) => q.at - p.at).slice(0, limit); }
  async seasonsOf(id) { return this.seasons.filter((s) => s.account === id).sort((p, q) => (p.season < q.season ? 1 : -1)); }
  async rollover(season) {
    const old = [...new Set([...this.acc.values()].filter((a) => a.season !== season).map((a) => a.season))];
    for (const s of old) {
      this._board(s, null).forEach((a, i) => this.seasons.push({ account: a.id, season: s, rating: a.rating, peak: a.sPeak, rank: i + 1 }));
      for (const a of this.acc.values()) if (a.season === s) { a.rating = R.softReset(a.rating); a.season = season; a.sGames = 0; a.sWins = 0; a.sPeak = a.rating; }
    }
    return old.length;
  }
  async idByCode(code) { return this.rec.get(sha(normCode(code))) || null; }
  // account deletion: the profile goes away, opponents keep their match lines with an anonymous name
  async remove(id) {
    if (!this.acc.has(id)) return false;
    this.acc.delete(id); this.sec.delete(id);
    for (const [h, v] of this.rec) if (v === id) this.rec.delete(h);
    this.seasons = this.seasons.filter((s) => s.account !== id);
    for (const m of this.matches) for (const k of ['a', 'b']) if (m[k] === id) { m[k] = 'deleted'; m[k + 'Name'] = null; m[k + 'Cc'] = null; m[k + 'Avatar'] = null; }
    for (const k of [...this.fr.keys()]) if (k.split('|').includes(id)) this.fr.delete(k);
    for (const k of [...this.blk]) if (k.split('|').includes(id)) this.blk.delete(k);
    this.msgs = this.msgs.filter((m) => m.src !== id && m.dst !== id);
    this.reps = this.reps.filter((r) => r.src !== id);
    for (const [s2, v] of this.sids) if (v === id) this.sids.delete(s2);
    return true;
  }
  async stats() { return { accounts: this.acc.size, matches: this.matches.length }; }
}

/* ---------------- Postgres ---------------- */
const COLS = {
  id: 'id', name: 'name', cc: 'cc', ccChangedAt: 'cc_changed_at', avatar: 'avatar', createdAt: 'created_at',
  rating: 'rating', peak: 'peak', games: 'games', wins: 'wins', losses: 'losses', draws: 'draws', koWins: 'ko_wins',
  streak: 'streak', bestStreak: 'best_streak', season: 'season', sGames: 's_games', sWins: 's_wins', sPeak: 's_peak',
  sid: 'sid', role: 'role', badge: 'badge', link: 'link', creatorOn: 'creator_on', bannedUntil: 'banned_until', banReason: 'ban_reason',
  mutedUntil: 'muted_until', lastSeen: 'last_seen', donor: 'donor',
};
const TIMES = new Set(['ccChangedAt', 'bannedUntil', 'mutedUntil', 'lastSeen']);
const SELECT = Object.entries(COLS).map(([k, c]) => (c === k ? c : `${c} AS "${k}"`)).join(', ');
const ms = (v) => (v == null ? null : +new Date(v));
const fix = (r) => r && { ...r, ccChangedAt: ms(r.ccChangedAt), createdAt: ms(r.createdAt), bannedUntil: ms(r.bannedUntil), mutedUntil: ms(r.mutedUntil), lastSeen: ms(r.lastSeen) };

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(url) || !/\./.test(new URL(url).hostname);
    this.pool = new Pool({ connectionString: url, max: 5, ssl: local ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 });
    this.pool.on('error', (e) => console.error('postgres idle client error:', e.message));   // never crash on a dropped idle connection
    this.kind = 'postgres';
  }
  q(text, params) { return this.pool.query(text, params); }
  async init() {
    await this.q(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, recovery_hash TEXT UNIQUE, name TEXT NOT NULL, cc TEXT, cc_changed_at TIMESTAMPTZ,
        avatar INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        rating INT NOT NULL, peak INT NOT NULL, games INT NOT NULL DEFAULT 0, wins INT NOT NULL DEFAULT 0, losses INT NOT NULL DEFAULT 0,
        draws INT NOT NULL DEFAULT 0, ko_wins INT NOT NULL DEFAULT 0, streak INT NOT NULL DEFAULT 0, best_streak INT NOT NULL DEFAULT 0,
        season TEXT NOT NULL, s_games INT NOT NULL DEFAULT 0, s_wins INT NOT NULL DEFAULT 0, s_peak INT NOT NULL);
      CREATE INDEX IF NOT EXISTS accounts_board ON accounts (season, rating DESC) WHERE s_games >= ${R.PLACEMENT};
      CREATE INDEX IF NOT EXISTS accounts_board_cc ON accounts (season, cc, rating DESC) WHERE s_games >= ${R.PLACEMENT};
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), season TEXT NOT NULL, reason TEXT NOT NULL, winner SMALLINT NOT NULL,
        a TEXT NOT NULL, b TEXT NOT NULL, a_name TEXT, b_name TEXT, a_cc TEXT, b_cc TEXT, a_avatar INT, b_avatar INT,
        a_score INT, b_score INT, a_rating INT, b_rating INT, a_delta INT, b_delta INT);
      CREATE INDEX IF NOT EXISTS matches_a ON matches (a, at DESC);
      CREATE INDEX IF NOT EXISTS matches_b ON matches (b, at DESC);
      CREATE TABLE IF NOT EXISTS season_results (account TEXT NOT NULL, season TEXT NOT NULL, rating INT NOT NULL, peak INT NOT NULL, rank INT NOT NULL,
        PRIMARY KEY (account, season));
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bot BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS skill INT;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS sid INT UNIQUE;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS badge TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS link TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS creator_on BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ban_reason TEXT;
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, state TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (a, b));
      CREATE INDEX IF NOT EXISTS friends_b ON friends (b);
      CREATE TABLE IF NOT EXISTS blocks (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
      CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), src TEXT NOT NULL, dst TEXT,
        text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', data JSONB, seen BOOLEAN NOT NULL DEFAULT false);
      CREATE INDEX IF NOT EXISTS messages_dst ON messages (dst, id DESC);
      CREATE INDEX IF NOT EXISTS messages_src ON messages (src, id DESC);
      CREATE TABLE IF NOT EXISTS reports (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), src TEXT NOT NULL, target TEXT NOT NULL,
        reason TEXT NOT NULL, comment TEXT, context TEXT, state TEXT NOT NULL DEFAULT 'open', action TEXT, msg BIGINT);
      CREATE INDEX IF NOT EXISTS reports_target ON reports (target);
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS donor INT NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS purchases (token TEXT PRIMARY KEY, account TEXT NOT NULL, sku TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), source TEXT NOT NULL);`);
    // accounts made before short ids existed get one now
    const missing = (await this.q(`SELECT id FROM accounts WHERE sid IS NULL`)).rows;
    for (const r of missing) await this._setSid(r.id);
  }
  async _setSid(id) {
    for (let i = 0; i < 20; i++) {
      const sid = randomSid();
      try { const r = await this.q(`UPDATE accounts SET sid = $2 WHERE id = $1 AND sid IS NULL`, [id, sid]); if (r.rowCount) return sid; return null; }
      catch (e) { if (e.code !== '23505') throw e; }
    }
    throw new Error('no free short id');
  }
  async create(name, cc, season) {
    const f = fresh(name, cc, season), a = f.acc;
    await this.q(`INSERT INTO accounts (id, secret_hash, recovery_hash, name, cc, avatar, rating, peak, season, s_peak) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$7)`,
      [a.id, f.secretHash, f.recoveryHash, a.name, a.cc, a.avatar, a.rating, season]);
    a.sid = await this._setSid(a.id); a.creatorOn = true;
    return { acc: a, secret: f.secret, recovery: f.recovery };
  }
  async auth(id, secret) {
    const r = await this.q(`UPDATE accounts SET last_seen = now() WHERE id = $1 AND secret_hash = $2 RETURNING ${SELECT}`, [String(id), sha(secret)]);
    return fix(r.rows[0]) || null;
  }
  async recover(code) {
    const secret = crypto.randomBytes(24).toString('hex');
    const r = await this.q(`UPDATE accounts SET secret_hash = $2, last_seen = now() WHERE recovery_hash = $1 RETURNING ${SELECT}`, [sha(normCode(code)), sha(secret)]);
    return r.rows[0] ? { acc: fix(r.rows[0]), secret } : null;
  }
  async newRecovery(id) { const code = recoveryCode(); await this.q(`UPDATE accounts SET recovery_hash = $2 WHERE id = $1`, [id, sha(normCode(code))]); return code; }
  async get(id) { const r = await this.q(`SELECT ${SELECT} FROM accounts WHERE id = $1`, [String(id)]); return fix(r.rows[0]) || null; }
  async patch(id, fields) {
    const keys = Object.keys(fields).filter((k) => COLS[k]); if (!keys.length) return;
    const vals = keys.map((k) => (TIMES.has(k) && fields[k] != null ? new Date(fields[k]) : fields[k]));
    await this.q(`UPDATE accounts SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...vals]);
  }
  async saveMatch(m, a, b) {
    const c = await this.pool.connect();
    const upd = `UPDATE accounts SET rating=$2, peak=$3, games=$4, wins=$5, losses=$6, draws=$7, ko_wins=$8, streak=$9, best_streak=$10, s_games=$11, s_wins=$12, s_peak=$13 WHERE id=$1`;
    const row = (x) => [x.id, x.rating, x.peak, x.games, x.wins, x.losses, x.draws, x.koWins, x.streak, x.bestStreak, x.sGames, x.sWins, x.sPeak];
    try {
      await c.query('BEGIN');
      await c.query(upd, row(a)); await c.query(upd, row(b));
      await c.query(`INSERT INTO matches (id, season, reason, winner, a, b, a_name, b_name, a_cc, b_cc, a_avatar, b_avatar, a_score, b_score, a_rating, b_rating, a_delta, b_delta, at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [m.id, m.season, m.reason, m.winner, m.a, m.b, m.aName, m.bName, m.aCc, m.bCc, m.aAvatar, m.bAvatar, m.aScore, m.bScore, m.aRating, m.bRating, m.aDelta, m.bDelta,
        new Date(m.at || Date.now())]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async pairCount(x, y, since) {
    const r = await this.q(`SELECT count(*)::int AS n FROM matches WHERE at > $3 AND ((a=$1 AND b=$2) OR (a=$2 AND b=$1))`, [x, y, new Date(since)]);
    return r.rows[0].n;
  }
  async top(season, cc, limit) {
    const r = await this.q(`SELECT ${SELECT} FROM accounts WHERE season = $1 AND s_games >= ${R.PLACEMENT} ${cc ? 'AND cc = $3' : ''}
      AND (banned_until IS NULL OR banned_until < now()) ORDER BY rating DESC, s_wins DESC, created_at ASC LIMIT $2`, cc ? [season, limit, cc] : [season, limit]);
    return r.rows.map(fix);
  }
  async position(acc, cc) {
    if (acc.sGames < R.PLACEMENT) return null;
    const r = await this.q(`SELECT count(*)::int AS n FROM accounts WHERE season = $1 AND s_games >= ${R.PLACEMENT} ${cc ? 'AND cc = $5' : ''}
      AND (banned_until IS NULL OR banned_until < now())
      AND (rating > $2 OR (rating = $2 AND (s_wins > $3 OR (s_wins = $3 AND created_at < $4))))`,
    cc ? [acc.season, acc.rating, acc.sWins, new Date(acc.createdAt), cc] : [acc.season, acc.rating, acc.sWins, new Date(acc.createdAt)]);
    return r.rows[0].n + 1;
  }
  async history(id, limit) {
    const r = await this.q(`SELECT id, extract(epoch from at)*1000 AS at, reason, winner, a, b, a_name AS "aName", b_name AS "bName", a_cc AS "aCc", b_cc AS "bCc",
      a_avatar AS "aAvatar", b_avatar AS "bAvatar", a_score AS "aScore", b_score AS "bScore", a_rating AS "aRating", b_rating AS "bRating", a_delta AS "aDelta", b_delta AS "bDelta"
      FROM matches WHERE a = $1 OR b = $1 ORDER BY at DESC LIMIT $2`, [id, limit]);
    return r.rows.map((x) => ({ ...x, at: +x.at }));
  }
  async seasonsOf(id) {
    const r = await this.q(`SELECT season, rating, peak, rank FROM season_results WHERE account = $1 ORDER BY season DESC`, [id]);
    return r.rows;
  }
  async rollover(season) {
    const old = (await this.q(`SELECT DISTINCT season FROM accounts WHERE season <> $1`, [season])).rows.map((x) => x.season);
    for (const s of old) {
      await this.q(`INSERT INTO season_results (account, season, rating, peak, rank)
        SELECT id, season, rating, s_peak, row_number() OVER (ORDER BY rating DESC, s_wins DESC, created_at ASC)
        FROM accounts WHERE season = $1 AND s_games >= ${R.PLACEMENT} ON CONFLICT DO NOTHING`, [s]);
      await this.q(`UPDATE accounts SET rating = round(${R.START} + (rating - ${R.START}) * 0.6), season = $2, s_games = 0, s_wins = 0,
        s_peak = round(${R.START} + (rating - ${R.START}) * 0.6) WHERE season = $1`, [s, season]);
    }
    return old.length;
  }
  async bots() {
    const r = await this.q(`SELECT ${SELECT}, skill FROM accounts WHERE bot`);
    return r.rows.map(fix);
  }
  async insertBot(a) {
    await this.q(`INSERT INTO accounts (id, secret_hash, name, cc, avatar, created_at, rating, peak, games, wins, losses, draws, ko_wins, streak, best_streak,
      season, s_games, s_wins, s_peak, bot, skill) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true,$20) ON CONFLICT (id) DO NOTHING`,
    [a.id, sha(crypto.randomBytes(16).toString('hex')), a.name, a.cc, a.avatar, new Date(a.createdAt), a.rating, a.peak, a.games, a.wins, a.losses, a.draws,
      a.koWins, a.streak, a.bestStreak, a.season, a.sGames, a.sWins, a.sPeak, a.skill]);
    await this._setSid(a.id);
  }
  async findBySid(sid) { const r = await this.q(`SELECT ${SELECT} FROM accounts WHERE sid = $1`, [+sid || 0]); return fix(r.rows[0]) || null; }
  async getMany(ids) { if (!ids.length) return []; const r = await this.q(`SELECT ${SELECT} FROM accounts WHERE id = ANY($1)`, [ids]); return r.rows.map(fix); }
  async friendRows(x) { return (await this.q(`SELECT a, b, state, extract(epoch from at)*1000 AS at FROM friends WHERE a = $1 OR b = $1`, [x])).rows.map((r) => ({ ...r, at: +r.at })); }
  async friendSet(a, b, state) {
    await this.q(`DELETE FROM friends WHERE a = $2 AND b = $1`, [a, b]);
    await this.q(`INSERT INTO friends (a, b, state) VALUES ($1, $2, $3) ON CONFLICT (a, b) DO UPDATE SET state = EXCLUDED.state, at = now()`, [a, b, state]);
  }
  async friendDel(x, y) { await this.q(`DELETE FROM friends WHERE (a = $1 AND b = $2) OR (a = $2 AND b = $1)`, [x, y]); }
  async blocksOf(x) { return (await this.q(`SELECT b FROM blocks WHERE a = $1`, [x])).rows.map((r) => r.b); }
  async block(a, b) { await this.q(`INSERT INTO blocks (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a, b]); }
  async unblock(a, b) { await this.q(`DELETE FROM blocks WHERE a = $1 AND b = $2`, [a, b]); }
  _msg(r) { return r && { id: +r.id, at: +new Date(r.at), src: r.src, dst: r.dst, text: r.text, kind: r.kind, data: r.data, seen: r.seen }; }
  async addMsg(m) {
    const r = await this.q(`INSERT INTO messages (at, src, dst, text, kind, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [new Date(m.at || Date.now()), m.src, m.dst == null ? null : m.dst, m.text, m.kind || 'text', m.data ? JSON.stringify(m.data) : null]);
    return this._msg(r.rows[0]);
  }
  async world(limit) { return (await this.q(`SELECT * FROM messages WHERE dst IS NULL ORDER BY id DESC LIMIT $1`, [limit])).rows.reverse().map((r) => this._msg(r)); }
  async adminChat(limit) { return (await this.q(`SELECT * FROM messages WHERE dst = 'admin' ORDER BY id DESC LIMIT $1`, [limit])).rows.reverse().map((r) => this._msg(r)); }
  async convo(x, y, limit) {
    return (await this.q(`SELECT * FROM messages WHERE (src = $1 AND dst = $2) OR (src = $2 AND dst = $1) ORDER BY id DESC LIMIT $3`, [x, y, limit])).rows.reverse().map((r) => this._msg(r));
  }
  async dmList(x) {
    const last = (await this.q(`SELECT DISTINCT ON (partner) * FROM (SELECT CASE WHEN src = $1 THEN dst ELSE src END AS partner, * FROM messages
      WHERE (src = $1 AND dst IS NOT NULL AND dst <> 'admin') OR dst = $1) t ORDER BY partner, id DESC`, [x])).rows;
    const un = new Map((await this.q(`SELECT src, count(*)::int AS n FROM messages WHERE dst = $1 AND NOT seen GROUP BY src`, [x])).rows.map((r) => [r.src, r.n]));
    return last.map((r) => ({ partner: r.partner, last: this._msg(r), unread: un.get(r.partner) || 0 })).sort((a, b) => b.last.id - a.last.id);
  }
  async markSeen(x, y) { await this.q(`UPDATE messages SET seen = true WHERE dst = $1 AND src = $2 AND NOT seen`, [x, y]); }
  async unread(x) { return (await this.q(`SELECT count(*)::int AS n FROM messages WHERE dst = $1 AND NOT seen`, [x])).rows[0].n; }
  async getMsg(id) { return this._msg((await this.q(`SELECT * FROM messages WHERE id = $1`, [+id])).rows[0]) || null; }
  async setMsgData(id, data) { await this.q(`UPDATE messages SET data = $2 WHERE id = $1`, [+id, JSON.stringify(data)]); }
  async prune() { await this.q(`DELETE FROM messages WHERE dst IS NULL AND at < now() - interval '7 days'`); }
  _rep(r) { return r && { ...r, id: +r.id, at: +new Date(r.at), msg: r.msg == null ? null : +r.msg }; }
  async addReport(r) {
    const x = await this.q(`INSERT INTO reports (src, target, reason, comment, context) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [r.src, r.target, r.reason, r.comment || null, r.context || null]);
    return this._rep(x.rows[0]);
  }
  async getReport(id) { return this._rep((await this.q(`SELECT * FROM reports WHERE id = $1`, [+id])).rows[0]) || null; }
  async setReport(id, f) {
    const keys = Object.keys(f).filter((k) => ['state', 'action', 'msg'].includes(k)); if (!keys.length) return;
    await this.q(`UPDATE reports SET ${keys.map((k, i) => k + ' = $' + (i + 2)).join(', ')} WHERE id = $1`, [+id, ...keys.map((k) => f[k])]);
  }
  async openReports(limit) { return (await this.q(`SELECT * FROM reports WHERE state = 'open' ORDER BY id DESC LIMIT $1`, [limit])).rows.reverse().map((r) => this._rep(r)); }
  async reportStats(target) {
    const r = (await this.q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'open')::int AS open FROM reports WHERE target = $1`, [target])).rows[0];
    return { total: r.total, open: r.open };
  }
  async reportsBy(src, since) { return (await this.q(`SELECT count(*)::int AS n FROM reports WHERE src = $1 AND at > $2`, [src, new Date(since)])).rows[0].n; }
  async openReportOf(src, target) { return this._rep((await this.q(`SELECT * FROM reports WHERE src = $1 AND target = $2 AND state = 'open' LIMIT 1`, [src, target])).rows[0]) || null; }
  async getMeta(k) { const r = await this.q(`SELECT v FROM meta WHERE k = $1`, [k]); return r.rows[0] ? r.rows[0].v : null; }
  // season placements that earn a badge (top 100 of the world)
  async seasonBadges() { return (await this.q(`SELECT account, season, rank FROM season_results WHERE rank <= 100`)).rows; }
  async addPurchase(token, account, sku, source) {
    const r = await this.q(`INSERT INTO purchases (token, account, sku, source) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [token, account, sku, source]);
    return r.rowCount > 0;
  }
  async setMeta(k, v) { await this.q(`INSERT INTO meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, String(v)]); }
  async idByCode(code) {
    const r = await this.q(`SELECT id FROM accounts WHERE recovery_hash = $1`, [sha(normCode(code))]);
    return r.rows[0] ? r.rows[0].id : null;
  }
  async remove(id) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(`DELETE FROM accounts WHERE id = $1`, [id]);
      await c.query(`DELETE FROM season_results WHERE account = $1`, [id]);
      await c.query(`UPDATE matches SET a = 'deleted', a_name = NULL, a_cc = NULL, a_avatar = NULL WHERE a = $1`, [id]);
      await c.query(`UPDATE matches SET b = 'deleted', b_name = NULL, b_cc = NULL, b_avatar = NULL WHERE b = $1`, [id]);
      await c.query(`DELETE FROM friends WHERE a = $1 OR b = $1`, [id]);
      await c.query(`DELETE FROM blocks WHERE a = $1 OR b = $1`, [id]);
      await c.query(`DELETE FROM messages WHERE src = $1 OR dst = $1`, [id]);
      await c.query(`DELETE FROM reports WHERE src = $1`, [id]);
      await c.query('COMMIT');
      return r.rowCount > 0;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async stats() {
    const r = await this.q(`SELECT (SELECT count(*) FROM accounts)::int AS accounts, (SELECT count(*) FROM matches)::int AS matches`);
    return r.rows[0];
  }
}

module.exports = { create: (url) => (url ? new PgStore(url) : new MemoryStore()), normCode };
