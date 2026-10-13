/* Reverse — friends, presence, duel invitations, world chat, private messages, reports and the owner's moderation chat.
 *
 * The owner (an account that entered the owner code once) gets every report in a private "moderation" chat with
 * buttons, and runs the game from there: badges, bans, mutes, nickname resets, leaderboard removals, announcements.
 * Players get moderation decisions as messages from "Reverse" in their own inbox.
 */
'use strict';
const crypto = require('crypto');

const WORLD_KEEP = 80;                 // world chat lines kept in memory and sent on open
const TEXT_MAX = 240;
const FRIENDS_MAX = 200;
const CHALLENGE_TTL = 30000;
const REPORTS_PER_DAY = 15;
const REASONS = ['nick', 'chat', 'cheat', 'other'];
const DUR = { '1h': 36e5, '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, forever: 1000 * 365 * 864e5 };
const BAN_DUR = ['1d', '7d', '30d', 'forever'], MUTE_DUR = ['1h', '1d', '7d'];
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|ru|net|org|io|gg|me|xyz|su|kz|uz|tk|ly|link|site|online|top|shop)\b\S*/gi;

const rid = (n) => crypto.randomBytes(n).toString('hex');

module.exports = function createSocial(ctx) {
  const { R, bots, players, byAcc, busy, freeUp, meMsg, newMatch, inQueue, cleanName, BAD_WORDS, onChange } = ctx;
  const store = () => ctx.store();
  const now = () => Date.now();
  const badWordsAll = new RegExp(BAD_WORDS.source, 'gi');
  let world = [];                       // [{ id, at, from, text, kind }]
  const challenges = new Map();         // cid -> { from: Player, to: Player, timer }

  /* ---------- who is who ---------- */
  function badgeOf(a) { return a && a.role === 'owner' && a.creatorOn !== false ? 'creator' : a && a.badge === 'inf' ? 'inf' : null; }
  const isOwner = (a) => !!a && a.role === 'owner';
  // what other players may see about an account
  function card(a) {
    if (!a) return null;
    return { id: a.id, sid: a.sid, name: a.name, cc: a.cc, avatar: a.avatar, rating: a.rating, sGames: a.sGames, badge: badgeOf(a) };
  }
  // live object for online people, the database for the rest
  async function acc(id) { const p = byAcc.get(id); return p ? p.acc : store().get(id); }
  async function accs(ids) {
    const out = new Map(), miss = [];
    for (const id of new Set(ids)) { const p = byAcc.get(id); if (p) out.set(id, p.acc); else miss.push(id); }
    for (const a of await store().getMany(miss)) out.set(a.id, a);
    return out;
  }
  function live(id) { const p = byAcc.get(id); return p && p.online ? p : null; }
  function sendTo(id, o) { const p = live(id); if (p) p.send(o); }
  function owners() { return [...players.values()].filter((p) => p.online && isOwner(p.acc)); }

  /* presence: online / searching / playing / offline with "last seen" */
  function statusOf(a) {
    if (!a) return { s: 'offline' };
    if (bots.isBot(a.id)) return bots.status(a, now());
    const p = byAcc.get(a.id);
    if (p && p.online) {
      if (busy(p)) return { s: 'playing', ranked: !!p.match.ranked };
      if (inQueue(p)) return { s: 'searching' };
      return { s: 'online' };
    }
    return { s: 'offline', seen: a.lastSeen || null };
  }
  function onlineCount() {
    let n = 0; for (const p of players.values()) if (p.online) n++;
    return n + bots.onlineCount(now());
  }

  /* ---------- text hygiene ---------- */
  function clean(text, owner) {
    let s = String(text || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
    s = s.replace(badWordsAll, (w) => '*'.repeat(Math.min(6, w.length)));
    if (!owner) s = s.replace(URL_RE, '***');
    return s;
  }
  function gate(p) {
    const a = p.acc, t = now();
    if (a.bannedUntil > t) return { code: 'banned', until: a.bannedUntil };
    if (a.mutedUntil > t) return { code: 'muted', until: a.mutedUntil };
    const r = p.chatRate || (p.chatRate = { last: 0, win: t, n: 0, text: '', textAt: 0 });
    if (isOwner(a)) return null;
    if (t - r.win > 60000) { r.win = t; r.n = 0; }
    if (t - r.last < 1200 || r.n >= 15) return { code: 'slow' };
    return null;
  }
  function spam(p, text) {
    const r = p.chatRate, t = now();
    if (r.text === text && t - r.textAt < 30000 && !isOwner(p.acc)) return true;
    r.text = text; r.textAt = t; r.last = t; r.n++;
    return false;
  }

  /* ---------- hello / bye ---------- */
  async function onHello(p, m) {
    if (ctx.isBoss(m.key) && !isOwner(p.acc)) {
      p.acc.role = 'owner'; await store().patch(p.acc.id, { role: 'owner' });
      await sys('admin', 'owner_new', { name: p.acc.name, sid: p.acc.sid });
    }
    p.lang = m.lang === 'en' ? 'en' : 'ru';
    for (const id of await store().blocksOf(p.acc.id)) p.blocked.add(id);
    await summary(p);
    if (p.acc.bannedUntil > now()) p.send({ type: 'banned', until: p.acc.bannedUntil, reason: p.acc.banReason || '' });
  }
  async function summary(p) {
    const s = store(), me = p.acc.id;
    const [rows, unread] = await Promise.all([s.friendRows(me), s.unread(me)]);
    let admin = 0;
    if (isOwner(p.acc)) admin = await adminUnread(me);
    p.send({ type: 'social', requests: rows.filter((r) => r.b === me && r.state === 'pending').length, unread: unread + admin,
      owner: isOwner(p.acc), blocked: [...p.blocked] });
  }
  async function adminUnread(id) {
    const seen = +(await store().getMeta('adminseen:' + id)) || 0;
    return (await store().adminChat(200)).filter((m) => m.id > seen && m.src !== id).length;
  }
  async function onBye(p) {
    p.acc.lastSeen = now();
    try { await store().patch(p.acc.id, { lastSeen: p.acc.lastSeen }); } catch (e) { }
    for (const [cid, c] of challenges) if (c.from === p || c.to === p) dropChallenge(cid, c.from === p ? 'gone' : 'offline');
  }

  /* ---------- friends ---------- */
  async function friendsOf(id) {
    const rows = await store().friendRows(id);
    return {
      ok: rows.filter((r) => r.state === 'ok').map((r) => (r.a === id ? r.b : r.a)),
      inc: rows.filter((r) => r.state === 'pending' && r.b === id).map((r) => r.a),
      out: rows.filter((r) => r.state === 'pending' && r.a === id).map((r) => r.b),
      rows,
    };
  }
  async function areFriends(x, y) { return (await store().friendRows(x)).some((r) => r.state === 'ok' && (r.a === y || r.b === y)); }
  async function friendsMsg(p) {
    const me = p.acc.id, f = await friendsOf(me);
    const m = await accs([...f.ok, ...f.inc, ...f.out, ...p.blocked]);
    const c = (id) => { const a = m.get(id); return a ? { ...card(a), status: statusOf(a) } : null; };
    const rank = { playing: 0, searching: 1, online: 2, offline: 3 };
    const list = f.ok.map(c).filter(Boolean).sort((x, y) => rank[x.status.s] - rank[y.status.s] || (y.status.seen || 0) - (x.status.seen || 0) || x.name.localeCompare(y.name));
    p.send({ type: 'friends', list, incoming: f.inc.map(c).filter(Boolean), outgoing: f.out.map(c).filter(Boolean),
      blocked: [...p.blocked].map((id) => (m.get(id) ? card(m.get(id)) : null)).filter(Boolean) });
  }
  async function friendAdd(p, m) {
    const s = store(), me = p.acc.id;
    const t = m.sid ? await s.findBySid(String(m.sid).replace(/\D/g, '')) : m.id ? await s.get(String(m.id)) : null;
    if (!t) return p.send({ type: 'error', code: 'no_player' });
    if (t.id === me) return p.send({ type: 'error', code: 'self' });
    const f = await friendsOf(me);
    if (f.ok.includes(t.id)) return p.send({ type: 'error', code: 'already' });
    if (f.ok.length >= FRIENDS_MAX) return p.send({ type: 'error', code: 'friends_full' });
    if (f.inc.includes(t.id)) return friendAnswer(p, { id: t.id, ok: true });   // they asked first: that's a yes
    if (!f.out.includes(t.id)) {
      await s.friendSet(me, t.id, 'pending');
      const tb = live(t.id);
      if (tb && !tb.blocked.has(me)) { tb.send({ type: 'friend_req', from: card(p.acc) }); }
    }
    p.send({ type: 'friend_sent', to: card(t) });
    await friendsMsg(p);
  }
  async function friendAnswer(p, m) {
    const s = store(), me = p.acc.id, other = String(m.id || '');
    const row = (await s.friendRows(me)).find((r) => r.a === other && r.b === me && r.state === 'pending');
    if (!row) return friendsMsg(p);
    if (m.ok) {
      await s.friendSet(other, me, 'ok');
      sendTo(other, { type: 'friend_ok', who: card(p.acc) });
      const o = live(other); if (o) await friendsMsg(o);
    } else await s.friendDel(other, me);
    await friendsMsg(p);
  }

  /* ---------- duel invitations ---------- */
  function dropChallenge(cid, reason) {
    const c = challenges.get(cid); if (!c) return;
    clearTimeout(c.timer); challenges.delete(cid);
    c.from.send({ type: 'challenge_no', cid, reason });
    c.to.send({ type: 'challenge_gone', cid });
  }
  async function challenge(p, m) {
    const id = String(m.id || ''), q = live(id);
    if (busy(p)) return;
    for (const [cid, c] of challenges) if (c.from === p) dropChallenge(cid, 'cancel');
    const no = (reason) => p.send({ type: 'challenge_no', cid: null, reason });
    if (p.acc.bannedUntil > now()) return no('banned');
    if (!(await areFriends(p.acc.id, id))) return no('not_friend');
    if (!q) return no('offline');
    if (busy(q)) return no('busy');
    if (q.blocked && q.blocked.has(p.acc.id)) return no('declined');
    const cid = rid(6);
    const c = { from: p, to: q, timer: setTimeout(() => dropChallenge(cid, 'timeout'), CHALLENGE_TTL) };
    challenges.set(cid, c);
    q.send({ type: 'challenge_in', cid, from: card(p.acc), ttl: CHALLENGE_TTL });
    p.send({ type: 'challenge_wait', cid, to: card(q.acc), ttl: CHALLENGE_TTL });
  }
  function challengeAnswer(p, m) {
    const c = challenges.get(m.cid);
    if (!c || c.to !== p) return;
    if (!m.ok) return dropChallenge(m.cid, 'declined');
    clearTimeout(c.timer); challenges.delete(m.cid);
    if (!c.from.online || busy(c.from)) { p.send({ type: 'challenge_gone', cid: m.cid }); return c.from.send({ type: 'challenge_no', cid: m.cid, reason: 'gone' }); }
    if (busy(p)) return c.from.send({ type: 'challenge_no', cid: m.cid, reason: 'busy' });
    freeUp(c.from); freeUp(p);
    newMatch(c.from, p);
  }

  /* ---------- chat ---------- */
  function worldLine(row, a) { return { id: row.id, at: row.at, from: row.src === 'sys' ? null : card(a), text: row.text, kind: row.kind }; }
  async function loadWorld() {
    const rows = await store().world(WORLD_KEEP), m = await accs(rows.filter((r) => r.src !== 'sys').map((r) => r.src));
    world = rows.filter((r) => r.src === 'sys' || m.has(r.src)).map((r) => worldLine(r, m.get(r.src)));
  }
  function pushWorld(line) {
    world.push(line); if (world.length > WORLD_KEEP) world.shift();
    const author = line.from && line.from.id;
    for (const q of players.values()) if (q.online && !(author && q.blocked && q.blocked.has(author))) q.send({ type: 'chat', msg: line });
  }
  async function say(p, m) {
    const g = gate(p); if (g) return p.send({ type: 'error', ...g });
    const owner = isOwner(p.acc), text = clean(m.text, owner);
    if (!text) return;
    if (m.to === 'admin') { if (!owner) return; return adminInput(p, String(m.text || '').trim().slice(0, 400)); }
    if (spam(p, text)) return p.send({ type: 'error', code: 'spam' });
    if (m.to == null) {
      const row = await store().addMsg({ src: p.acc.id, dst: null, text });
      return pushWorld(worldLine(row, p.acc));
    }
    const to = String(m.to), t = await acc(to);
    if (!t || to === 'sys') return p.send({ type: 'error', code: 'no_player' });
    if (!owner && !isOwner(t) && !(await areFriends(p.acc.id, to))) return p.send({ type: 'error', code: 'not_friend' });
    const theirBlocks = live(to) ? live(to).blocked : new Set(await store().blocksOf(to));
    if (theirBlocks.has(p.acc.id) || p.blocked.has(to)) return p.send({ type: 'error', code: 'cant_write' });
    const row = await store().addMsg({ src: p.acc.id, dst: to, text });
    sendTo(to, { type: 'dm', msg: row, with: card(p.acc) });
    p.send({ type: 'dm', msg: row, with: card(t) });
  }
  async function dmList(p) {
    const me = p.acc.id, list = await store().dmList(me), m = await accs(list.map((e) => e.partner).filter((x) => x !== 'sys'));
    const out = list.filter((e) => e.partner === 'sys' || m.has(e.partner))
      .map((e) => ({ with: e.partner === 'sys' ? { id: 'sys' } : { ...card(m.get(e.partner)), status: statusOf(m.get(e.partner)) }, last: e.last, unread: e.unread }));
    if (isOwner(p.acc)) {
      const a = await store().adminChat(1);
      out.unshift({ with: { id: 'admin' }, last: a[0] || null, unread: await adminUnread(me), pinned: true });
    }
    p.send({ type: 'dms', list: out });
  }
  async function dmOpen(p, m) {
    const me = p.acc.id, id = String(m.id || '');
    if (id === 'admin') {
      if (!isOwner(p.acc)) return;
      const list = await store().adminChat(80);
      await store().setMeta('adminseen:' + me, String(list.length ? list[list.length - 1].id : 0));
      return p.send({ type: 'dm_history', with: { id: 'admin' }, list, canWrite: true });
    }
    if (id === 'sys') {
      const list = await store().convo(me, 'sys', 60); await store().markSeen(me, 'sys');
      return p.send({ type: 'dm_history', with: { id: 'sys' }, list, canWrite: false });
    }
    const t = await acc(id); if (!t) return p.send({ type: 'error', code: 'no_player' });
    const list = await store().convo(me, id, 60); await store().markSeen(me, id);
    const canWrite = isOwner(p.acc) || isOwner(t) || await areFriends(me, id);
    p.send({ type: 'dm_history', with: { ...card(t), status: statusOf(t) }, list, canWrite });
  }

  /* ---------- reports ---------- */
  async function report(p, m) {
    const s = store(), me = p.acc.id, target = String(m.id || ''), reason = REASONS.includes(m.reason) ? m.reason : 'other';
    const t = await acc(target);
    if (!t || target === me) return p.send({ type: 'error', code: 'no_player' });
    if (await s.reportsBy(me, now() - 864e5) >= REPORTS_PER_DAY) return p.send({ type: 'error', code: 'report_limit' });
    if (await s.openReportOf(me, target)) return p.send({ type: 'reported' });
    let context = null;
    if (m.msg) { const msg = await s.getMsg(m.msg); if (msg && msg.src === target) context = msg.text; }
    const comment = clean(m.comment, false).slice(0, 200) || null;
    const r = await s.addReport({ src: me, target, reason, comment, context });
    const stats = await s.reportStats(target);
    const row = await s.addMsg({ src: 'sys', dst: 'admin', text: 'report', kind: 'report',
      data: { rid: r.id, state: 'open', reason, comment, context, target: info(t, stats), from: card(p.acc) } });
    await s.setReport(r.id, { msg: row.id });
    for (const o of owners()) o.send({ type: 'dm', msg: row, with: { id: 'admin' } });
    p.send({ type: 'reported' });
  }
  // what the owner sees about a player: the public card plus moderation state
  function info(a, stats) {
    return { ...card(a), bot: bots.isBot(a.id), games: a.games, wins: a.wins, created: a.createdAt, link: a.link || null, rawBadge: a.badge || null,
      bannedUntil: a.bannedUntil > now() ? a.bannedUntil : null, mutedUntil: a.mutedUntil > now() ? a.mutedUntil : null,
      reports: stats || null, status: statusOf(a) };
  }

  /* ---------- the owner's moderation chat ---------- */
  async function sys(dst, key, params) {
    const row = await store().addMsg({ src: 'sys', dst, text: key, kind: 'sys', data: { key, ...(params || {}) } });
    if (dst === 'admin') for (const o of owners()) o.send({ type: 'dm', msg: row, with: { id: 'admin' } });
    else sendTo(dst, { type: 'dm', msg: row, with: { id: 'sys' } });
    return row;
  }
  async function adminInput(p, text) {
    const row = await store().addMsg({ src: p.acc.id, dst: 'admin', text, kind: 'text' });
    for (const o of owners()) o.send({ type: 'dm', msg: row, with: { id: 'admin' } });
    if (text.startsWith('/')) await command(p, text);
  }
  async function findTarget(ref) {
    const s = store(), x = String(ref || '').replace(/^#/, '');
    if (/^\d{6}$/.test(x)) return s.findBySid(x);
    return x ? s.get(x) : null;
  }
  async function command(p, text) {
    const [cmd, ref, ...rest] = text.slice(1).split(/\s+/), c = (cmd || '').toLowerCase();
    if (c === 'help' || c === 'помощь') return sys('admin', 'help');
    if (c === 'stats') {
      const st = await store().stats(), open = (await store().openReports(500)).length;
      let humans = 0; for (const q of players.values()) if (q.online) humans++;
      return sys('admin', 'stats', { humans, bots: bots.onlineCount(now()), accounts: st.accounts, matches: st.matches, open });
    }
    if (c === 'reports') {
      const list = await store().openReports(10);
      await sys('admin', 'reports', { n: list.length });
      for (const r of list) {
        const t = await acc(r.target); if (!t) continue;
        const row = await store().addMsg({ src: 'sys', dst: 'admin', text: 'report', kind: 'report',
          data: { rid: r.id, state: 'open', reason: r.reason, comment: r.comment, context: r.context, target: info(t, await store().reportStats(r.target)), from: null, again: true } });
        await store().setReport(r.id, { msg: row.id });
        for (const o of owners()) o.send({ type: 'dm', msg: row, with: { id: 'admin' } });
      }
      return;
    }
    if (c === 'announce') {
      const msg = text.replace(/^\/announce\s*/i, '').trim().slice(0, TEXT_MAX);
      if (!msg) return sys('admin', 'usage', { cmd: 'announce' });
      const row = await store().addMsg({ src: 'sys', dst: null, text: msg, kind: 'announce' });
      pushWorld(worldLine(row, null));
      return sys('admin', 'done', { act: 'announce' });
    }
    if (c === 'creator') {
      const on = ref !== 'off';
      p.acc.creatorOn = on; await store().patch(p.acc.id, { creatorOn: on }); p.send(meMsg(p)); onChange();
      return sys('admin', 'done', { act: on ? 'creator_on' : 'creator_off' });
    }
    const map = { info: 'info', badge: 'badge', unbadge: 'unbadge', link: 'link', ban: 'ban', unban: 'unban', mute: 'mute', unmute: 'unmute', rename: 'rename', untop: 'untop' };
    if (!map[c]) return sys('admin', 'unknown', { cmd: c });
    const t = await findTarget(ref);
    if (!t) return sys('admin', 'no_player', { ref: ref || '' });
    if (c === 'info') return postInfo(t);
    let dur = rest[0], extra = rest.slice(1).join(' ');
    if (c === 'badge' || c === 'link') { extra = rest.join(' '); dur = null; }
    if (c === 'ban' && !BAN_DUR.includes(dur)) return sys('admin', 'usage', { cmd: 'ban' });
    if (c === 'mute' && !MUTE_DUR.includes(dur)) return sys('admin', 'usage', { cmd: 'mute' });
    return act(p, { act: c, target: t.id, dur, extra });
  }
  async function postInfo(t) {
    const row = await store().addMsg({ src: 'sys', dst: 'admin', text: 'info', kind: 'info', data: { target: info(t, await store().reportStats(t.id)) } });
    for (const o of owners()) o.send({ type: 'dm', msg: row, with: { id: 'admin' } });
  }
  const linkOk = (u) => /^https:\/\/[^\s<>"']{4,200}$/i.test(u || '');

  // one moderation action, from a button or a command
  async function act(p, m) {
    if (!isOwner(p.acc)) return;
    const s = store(), a = await acc(String(m.target || '')), what = m.act, t0 = now();
    if (!a) return sys('admin', 'no_player', { ref: m.target || '' });
    const lp = byAcc.get(a.id), set = async (f) => { Object.assign(a, f); if (lp) Object.assign(lp.acc, f); await s.patch(a.id, f); };
    const who = { name: a.name, sid: a.sid };
    let note = null;
    switch (what) {
      case 'ban': {
        const dur = BAN_DUR.includes(m.dur) ? m.dur : '1d', until = t0 + DUR[dur], reason = String(m.extra || '').slice(0, 120);
        await set({ bannedUntil: until, banReason: reason || null });
        if (lp) { freeUp(lp); lp.send({ type: 'banned', until, reason }); }
        await sys(a.id, 'ban', { until, dur, reason });
        note = { dur }; ctx.topChanged(); break;
      }
      case 'unban': await set({ bannedUntil: null, banReason: null }); if (lp) lp.send({ type: 'banned', until: null }); await sys(a.id, 'unban'); ctx.topChanged(); break;
      case 'mute': {
        const dur = MUTE_DUR.includes(m.dur) ? m.dur : '1h', until = t0 + DUR[dur];
        await set({ mutedUntil: until }); await sys(a.id, 'mute', { until, dur }); note = { dur }; break;
      }
      case 'unmute': await set({ mutedUntil: null }); await sys(a.id, 'unmute'); break;
      case 'rename': {
        const old = a.name, name = 'Player ' + a.sid;
        await set({ name }); await sys(a.id, 'rename', { old }); note = { old }; ctx.topChanged(); break;
      }
      case 'untop': {
        await set({ rating: R.START, sGames: 0, sWins: 0, sPeak: R.START }); await sys(a.id, 'untop'); ctx.topChanged(); break;
      }
      case 'badge': {
        const link = linkOk(m.extra) ? m.extra : a.link || null;
        await set({ badge: 'inf', link }); await sys(a.id, 'badge'); ctx.topChanged(); break;
      }
      case 'unbadge': await set({ badge: null }); await sys(a.id, 'unbadge'); ctx.topChanged(); break;
      case 'link': {
        if (m.extra && !linkOk(m.extra)) return sys('admin', 'bad_link');
        await set({ link: m.extra || null }); break;
      }
      case 'dismiss': break;
      default: return;
    }
    if (lp) lp.send(meMsg(lp));
    // the report this came from, and every other open report on the same player, are settled with it
    const label = what === 'dismiss' ? 'dismissed' : what;
    if (m.rid || ['ban', 'mute', 'rename', 'untop'].includes(what)) {
      const open = (await s.openReports(500)).filter((r) => r.target === a.id && (what !== 'dismiss' || r.id === +m.rid));
      for (const r of open) {
        await s.setReport(r.id, { state: what === 'dismiss' ? 'rejected' : 'done', action: label + (note && note.dur ? ':' + note.dur : '') });
        if (r.msg) {
          const msg = await s.getMsg(r.msg);
          if (msg && msg.data) {
            const data = { ...msg.data, state: what === 'dismiss' ? 'rejected' : 'done', action: label, dur: note && note.dur || null, at: t0 };
            await s.setMsgData(r.msg, data);
            for (const o of owners()) o.send({ type: 'msg_update', id: r.msg, data });
          }
        }
      }
    }
    if (what !== 'dismiss') await sys('admin', 'done', { act: what, ...who, ...(note || {}) });
    onChange();
  }

  /* ---------- message router ---------- */
  async function handle(p, m) {
    switch (m.type) {
      case 'friends': return friendsMsg(p);
      case 'friend_add': return friendAdd(p, m);
      case 'friend_answer': return friendAnswer(p, m);
      case 'friend_remove': await store().friendDel(p.acc.id, String(m.id || '')); return friendsMsg(p);
      case 'block': {
        const id = String(m.id || ''); if (!id || id === p.acc.id) return;
        await store().block(p.acc.id, id); await store().friendDel(p.acc.id, id); p.blocked.add(id);
        p.send({ type: 'blocked', list: [...p.blocked] }); return;
      }
      case 'unblock': {
        const id = String(m.id || ''); await store().unblock(p.acc.id, id); p.blocked.delete(id);
        p.send({ type: 'blocked', list: [...p.blocked] }); return friendsMsg(p);
      }
      case 'challenge': return challenge(p, m);
      case 'challenge_answer': return challengeAnswer(p, m);
      case 'challenge_cancel': { const c = challenges.get(m.cid); if (c && c.from === p) dropChallenge(m.cid, 'cancel'); return; }
      case 'chat_open': return p.send({ type: 'chat_history', list: world.filter((l) => !(l.from && p.blocked.has(l.from.id))) });
      case 'say': return say(p, m);
      case 'dms': return dmList(p);
      case 'dm_open': return dmOpen(p, m);
      case 'dm_seen': {
        const id = String(m.id || '');
        if (id === 'admin') { if (isOwner(p.acc)) { const l = await store().adminChat(1); await store().setMeta('adminseen:' + p.acc.id, String(l.length ? l[0].id : 0)); } }
        else await store().markSeen(p.acc.id, id);
        return;
      }
      case 'report': return report(p, m);
      case 'admin': return act(p, m);
      case 'admin_info': { if (!isOwner(p.acc)) return; const t = await findTarget(m.target); return t ? postInfo(t) : sys('admin', 'no_player', { ref: m.target || '' }); }
      case 'social': return summary(p);
      default: return false;
    }
  }

  setInterval(() => { store().prune().catch(() => { }); }, 3600e3);
  return { handle, onHello, onBye, statusOf, onlineCount, card, badgeOf, isOwner, loadWorld, info };
};
