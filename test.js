// End-to-end protocol test over real sockets. Uses Postgres when DATABASE_URL is set, memory otherwise.
const WebSocket = require('ws');
const assert = require('assert');
const L = (() => { try { return require('./logic.js'); } catch (e) { return require('../web/js/logic.js'); } })();
const R = (() => { try { return require('./rank.js'); } catch (e) { return require('../web/js/rank.js'); } })();
const PORT = 18080 + Math.floor(Math.random() * 1000);
process.env.PORT = PORT;
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'test-boss-key';
const srv = require('./index.js');
const URL = `ws://127.0.0.1:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, extra) {
  const ws = new WebSocket(URL), c = { ws, name, inbox: [], waiters: [], st: null, seq: 0, mism: 0 };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.next = (type, ms = 8000) => new Promise((res, rej) => {
    const i = c.inbox.findIndex((m) => m.type === type);
    if (i >= 0) return res(c.inbox.splice(i, 1)[0]);
    const to = setTimeout(() => rej(new Error(name + ' timeout waiting ' + type + ' inbox=' + c.inbox.map((m) => m.type).join(','))), ms);
    c.waiters.push({ type, res: (m) => { clearTimeout(to); res(m); } });
  });
  c.drop = (type) => { c.inbox = c.inbox.filter((m) => m.type !== type); };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const w = c.waiters.findIndex((x) => x.type === m.type);
    if (w >= 0) c.waiters.splice(w, 1)[0].res(m); else c.inbox.push(m);
  });
  c.ready = new Promise((r) => ws.on('open', () => { c.send({ type: 'hello', v: 2, name, ...(extra || {}) }); r(); }));
  return c;
}
async function login(name, extra) {
  const c = client(name, extra); await c.ready;
  c.welcome = await c.next('welcome'); c.me = (await c.next('me')).me;
  return c;
}
async function move(c) {
  const e = L.empties(c.st);
  await sleep(45);
  const cell = e[(Math.random() * e.length) | 0];
  L.place(c.st, cell); c.seq++;
  c.send({ type: 'move', seq: c.seq, a: 'place', c: cell });
  const ack = await c.next('ack');
  L.addBolts(c.st, ack.garbage);
  if (ack.h !== L.hash(c.st)) c.mism++;
  return ack;
}
async function startBoth(a, b) {
  const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
  for (const [c, s] of [[a, sa], [b, sb]]) { c.st = L.newGame({ mode: 'duel', seed: s.seed, rules: L.DUEL_RULES }); c.seq = 0; }
  return [sa, sb];
}

(async () => {
  await srv.ready; await srv.botsReady;
  // ----- rank math -----
  assert.strictEqual(R.rankOf(1000).tier, 'silver'); assert.strictEqual(R.rankOf(1000).div, 3);
  assert.strictEqual(R.rankOf(1250).div, 1); assert.strictEqual(R.rankOf(799).tier, 'bronze'); assert.strictEqual(R.rankOf(2400).tier, 'master');
  assert.strictEqual(R.delta(1000, 1000, 1, 0), 20); assert.strictEqual(R.delta(1000, 1000, 0, 20), -14);
  assert.strictEqual(R.softReset(1500), 1300); assert.strictEqual(R.seasonEnd('2026-12'), Date.UTC(2027, 0, 1));

  // ----- accounts -----
  const a = await login('Alice', { region: 'KR' }), b = await login('Bob', { region: 'RU' });
  assert.ok(a.welcome.acc.created && a.welcome.acc.secret && /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(a.welcome.acc.recovery));
  assert.strictEqual(a.me.rating, R.START); assert.strictEqual(a.me.cc, 'KR');
  // sign back in with the stored secret
  const a2 = await login('Alice', { acc: { id: a.welcome.acc.id, secret: a.welcome.acc.secret } });
  assert.strictEqual(a2.welcome.acc.id, a.welcome.acc.id); assert.ok(!a2.welcome.acc.created);
  a.ws.close(); const A = a2;

  // ----- casual match still works, boss never applies to ranked -----
  A.send({ type: 'queue' }); b.send({ type: 'queue' });
  let [sa] = await startBoth(A, b);
  assert.strictEqual(sa.ranked, false); assert.strictEqual(sa.opp.name, 'Bob');
  await sleep(3050);
  for (let i = 0; i < 6; i++) { await move(A); await move(b); }
  A.send({ type: 'resign' }); await Promise.all([A.next('end'), b.next('end')]);
  A.send({ type: 'leave' }); await b.next('opp_left');

  // ----- ranked: matchmaking, Elo, profile, leaderboards -----
  for (let g = 0; g < 3; g++) {
    A.drop('queued'); b.drop('queued');
    A.send({ type: 'queue', mode: 'ranked' }); b.send({ type: 'queue', mode: 'ranked' });
    const [ra, rb] = await startBoth(A, b);
    assert.ok(ra.ranked && rb.ranked); assert.strictEqual(typeof ra.opp.rating, 'number');
    await sleep(3050);
    for (let i = 0; i < 5; i++) { await move(A); await move(b); }
    (g % 2 ? b : A).send({ type: 'resign' });
    const [ea, eb] = await Promise.all([A.next('end'), b.next('end')]);
    assert.ok(ea.ranked && ea.rating && eb.rating);
    assert.strictEqual(ea.rating.delta + eb.rating.delta === 0 || ea.rating.capped, true);
    if (g === 0) { assert.strictEqual(ea.result, 'lose'); assert.strictEqual(ea.rating.delta, -20); assert.strictEqual(eb.rating.delta, 20); }
    A.me = (await A.next('me')).me; b.me = (await b.next('me')).me;
    A.send({ type: 'leave' }); await b.next('opp_left');
  }
  assert.strictEqual(A.me.sGames, 3); assert.strictEqual(b.me.wins, 2); assert.strictEqual(A.me.wins, 1);
  console.log('ranked ok: Alice', A.me.rating, 'Bob', b.me.rating, 'desyncs', A.mism + b.mism);
  assert.strictEqual(A.mism + b.mism, 0);

  const human = (l) => l.filter((x) => !srv.bots.isBot(x.id)), posOf = (l, id) => (l.find((x) => x.id === id) || {}).pos;
  A.send({ type: 'top', scope: 'world' });
  const top = await A.next('top');
  assert.strictEqual(human(top.list).length, 2); assert.strictEqual(human(top.list)[0].id, b.me.id);
  assert.strictEqual(top.me.pos, posOf(top.list, A.me.id)); assert.ok(posOf(top.list, b.me.id) < top.me.pos);
  assert.ok(top.list.length > 30, 'bots fill the leaderboard');
  b.send({ type: 'top', scope: 'country' });
  const topRu = await b.next('top');
  assert.strictEqual(topRu.cc, 'RU'); assert.strictEqual(human(topRu.list).length, 1); assert.strictEqual(topRu.me.pos, posOf(topRu.list, b.me.id));
  assert.ok(topRu.list.every((x) => x.cc === 'RU'));
  A.send({ type: 'profile', id: b.me.id });
  const pb = await A.next('profile');
  assert.strictEqual(pb.p.name, 'Bob'); assert.strictEqual(pb.history.length, 3); assert.strictEqual(pb.world, posOf(top.list, b.me.id)); assert.ok(!pb.mine);
  assert.strictEqual(pb.history[0].opp.name, 'Alice');
  console.log('leaderboards + profile ok:', top.list.map((x) => x.name + ' ' + x.rating).join(', '));

  // ----- profile settings -----
  A.send({ type: 'set_name', name: 'Алиса' }); assert.strictEqual((await A.next('me')).me.name, 'Алиса');
  A.send({ type: 'set_name', name: 'бля' }); assert.strictEqual((await A.next('error')).code, 'bad_name');
  A.send({ type: 'set_avatar', a: 42 }); assert.strictEqual((await A.next('me')).me.avatar, 42);
  A.send({ type: 'set_country', cc: 'JP' }); assert.strictEqual((await A.next('me')).me.cc, 'JP');
  A.send({ type: 'set_country', cc: 'KR' }); const w = await A.next('error'); assert.strictEqual(w.code, 'cc_wait'); assert.strictEqual(w.days, 30);
  A.send({ type: 'set_country', cc: 'ZZ' }); assert.strictEqual((await A.next('error')).code, 'bad_country');

  // ----- moving the account to another phone with the recovery code -----
  const moved = await login('x', { recover: A.welcome.acc.recovery || a.welcome.acc.recovery });
  assert.ok(moved.welcome.acc.recovered && moved.welcome.acc.secret); assert.strictEqual(moved.me.name, 'Алиса'); assert.strictEqual(moved.me.rating, A.me.rating);
  const bad = client('y', { recover: 'AAAA-BBBB-CCCC' }); await bad.ready; assert.strictEqual((await bad.next('error')).code, 'bad_code');
  moved.send({ type: 'recovery' }); const nr = await moved.next('recovery'); assert.ok(/^[A-Z0-9]{4}-/.test(nr.code));
  console.log('settings + account transfer ok');

  // ----- ranked queue keeps players with distant ratings apart at first -----
  const c1 = await login('Low'), c2 = await login('High');
  await srv.store.patch(c2.me.id, { rating: 1600 });
  c2.ws.close(); await sleep(100);
  const c2b = await login('High', { acc: { id: c2.welcome.acc.id, secret: c2.welcome.acc.secret } });
  c1.send({ type: 'queue', mode: 'ranked' }); c2b.send({ type: 'queue', mode: 'ranked' });
  await sleep(2500);
  assert.ok(!c1.inbox.some((m) => m.type === 'start'), 'a 600-point gap must not match within seconds');
  const q = c1.inbox.filter((m) => m.type === 'queued').pop(); assert.ok(q && q.window > 100);
  c1.send({ type: 'cancel' }); c2b.send({ type: 'cancel' });
  console.log('matchmaking window ok, after', Math.round(q.wait / 1000), 's window ±' + q.window);

  // ----- owner mode: on in casual games, never in ranked (the client predicts plain rules, so hashes must match) -----
  const boss = await login('Boss', { key: process.env.ADMIN_KEY }), pl = await login('Plain');
  assert.strictEqual(boss.welcome.boss, true); assert.ok(!pl.welcome.boss);
  boss.send({ type: 'queue', mode: 'ranked' }); pl.send({ type: 'queue', mode: 'ranked' });
  const [rb] = await startBoth(boss, pl); assert.ok(rb.ranked);
  await sleep(3050);
  for (let i = 0; i < 8; i++) { await move(boss); await move(pl); }
  assert.strictEqual(boss.mism, 0, 'ranked games must not give the owner any help');
  boss.send({ type: 'resign' }); const eb = await boss.next('end'); assert.strictEqual(eb.result, 'lose');
  boss.send({ type: 'leave' }); pl.send({ type: 'leave' });
  console.log('owner mode is off in ranked ok');

  // ----- bots: a full roster, one takes the game when nobody else is searching -----
  assert.strictEqual(srv.bots.list.size, 60);
  const lone = await login('Lone');
  const t0 = Date.now();
  lone.send({ type: 'queue', mode: 'ranked' });
  const bs = await lone.next('start', 20000), waited = Date.now() - t0;
  assert.ok(waited >= 5500 && waited < 16000, 'bot steps in after 6-14 s, took ' + waited);
  assert.ok(bs.ranked && srv.bots.isBot(bs.opp.id) && !bs.opp.bot && bs.opp.name && bs.opp.cc && typeof bs.opp.rating === 'number');
  assert.ok(Math.abs(bs.opp.rating - lone.me.rating) < 300);
  lone.st = L.newGame({ mode: 'duel', seed: bs.seed, rules: L.DUEL_RULES }); lone.seq = 0;
  await sleep(3050);
  for (let i = 0; i < 4; i++) await move(lone);
  await sleep(2500);
  const botOpp = lone.inbox.filter((m) => m.type === 'opp').pop();
  assert.ok(botOpp && botOpp.moves > 0, 'the bot plays its own board');
  lone.send({ type: 'resign' }); const le = await lone.next('end');
  assert.ok(le.ranked && le.rating && le.rating.delta < 0);
  lone.send({ type: 'profile', id: bs.opp.id }); const bp = await lone.next('profile');
  assert.strictEqual(bp.history[0].opp.id, lone.me.id); assert.ok(bp.p.games >= 10 && bp.p.sGames >= 3 && bp.world > 0);
  lone.send({ type: 'leave' }); await sleep(100);
  lone.drop('queued'); lone.send({ type: 'queue' });
  const cs = await lone.next('start', 20000);
  assert.ok(!cs.ranked && srv.bots.isBot(cs.opp.id) && cs.opp.id !== bs.opp.id);
  lone.send({ type: 'leave' });
  const sim = await srv.bots.simulate(Date.now());
  assert.ok(sim && sim.A !== sim.B && Math.abs(sim.A.rating - sim.B.rating) < 400);
  console.log('bots ok: ranked opponent', bs.opp.name, bs.opp.cc, bs.opp.rating, 'after', (waited / 1000).toFixed(1) + 's; casual', cs.opp.name);

  // ----- social: short ids, friends, presence, invitations, chat, reports, the owner's moderation chat -----
  const u1 = await login('Uno', { region: 'RU' }), u2 = await login('Dos'), u3 = await login('Tres');
  assert.ok(/^\d{6}$/.test(String(u1.me.sid)) && u1.me.sid !== u2.me.sid);
  await u1.next('social');
  u1.send({ type: 'friend_add', sid: u2.me.sid }); await u1.next('friend_sent');
  const fr = await u2.next('friend_req'); assert.strictEqual(fr.from.id, u1.me.id);
  u2.send({ type: 'friend_answer', id: u1.me.id, ok: true }); await u1.next('friend_ok');
  u1.drop('friends'); u1.send({ type: 'friends' }); const fl = await u1.next('friends');
  assert.strictEqual(fl.list[0].id, u2.me.id); assert.strictEqual(fl.list[0].status.s, 'online');
  const someBot = [...srv.bots.list.values()][0];
  u1.send({ type: 'friend_add', sid: someBot.sid }); await u1.next('friend_sent');
  u1.drop('friends'); u1.send({ type: 'friends' }); assert.ok((await u1.next('friends')).outgoing.some((x) => x.id === someBot.id), 'bots never answer');
  u1.send({ type: 'say', to: u2.me.id, text: 'привет бля' }); const dm = await u2.next('dm');
  assert.ok(dm.msg.text.startsWith('привет') && dm.msg.text.includes('*') && !dm.msg.text.includes('бля'));
  u3.send({ type: 'say', to: u1.me.id, text: 'hi' }); assert.strictEqual((await u3.next('error')).code, 'not_friend');
  await sleep(1300); u1.drop('chat'); u3.send({ type: 'say', text: 'hello all www.spam.com' }); const wc = await u1.next('chat');
  assert.strictEqual(wc.msg.from.id, u3.me.id); assert.ok(!wc.msg.text.includes('spam.com'));
  u2.send({ type: 'dms' }); const dl = await u2.next('dms'); assert.strictEqual(dl.list[0].with.id, u1.me.id); assert.strictEqual(dl.list[0].unread, 1);
  // a duel invitation between friends starts a casual match
  u1.send({ type: 'challenge', id: u2.me.id }); const ci = await u2.next('challenge_in'); await u1.next('challenge_wait');
  u2.send({ type: 'challenge_answer', cid: ci.cid, ok: true });
  const [c1s] = await Promise.all([u1.next('start'), u2.next('start')]); assert.ok(!c1s.ranked && c1s.opp.id === u2.me.id);
  u1.send({ type: 'leave' }); await sleep(100);
  // a report lands in the owner's moderation chat with buttons, and the owner acts on it
  u3.send({ type: 'report', id: u1.me.id, reason: 'chat', comment: 'ругается', msg: dm.msg.id }); await u3.next('reported');
  const own = await login('Owner', { key: process.env.ADMIN_KEY }); assert.ok(own.me.owner || (await own.next('me')).me.owner);
  own.send({ type: 'dms' }); const odl = await own.next('dms'); assert.strictEqual(odl.list[0].with.id, 'admin'); assert.ok(odl.list[0].unread >= 1);
  own.send({ type: 'dm_open', id: 'admin' }); const ah = await own.next('dm_history');
  const rep = ah.list.filter((m) => m.kind === 'report').pop(); assert.ok(rep && rep.data.rid && rep.data.target.id === u1.me.id && rep.data.state === 'open');
  u1.drop('dm'); own.send({ type: 'admin', act: 'mute', dur: '1h', target: u1.me.id, rid: rep.data.rid });
  const upd = await own.next('msg_update'); assert.strictEqual(upd.data.state, 'done');
  const note = await u1.next('dm'); assert.strictEqual(note.msg.data.key, 'mute');
  await sleep(1300); u1.send({ type: 'say', text: 'still here' }); assert.strictEqual((await u1.next('error')).code, 'muted');
  own.drop('dm'); own.send({ type: 'say', to: 'admin', text: '/badge ' + u2.me.sid + ' https://www.tiktok.com/@dos' });
  u2.drop('me'); const u2me = (await u2.next('me')).me; assert.strictEqual(u2me.badge, 'inf'); assert.ok(u2me.link.includes('tiktok'));
  u1.send({ type: 'profile', id: u2.me.id }); const p2 = await u1.next('profile'); assert.strictEqual(p2.p.badge, 'inf'); assert.strictEqual(p2.rel, 'friend');
  own.send({ type: 'say', to: 'admin', text: '/ban ' + u3.me.sid + ' 1d spam' }); const bn = await u3.next('banned'); assert.ok(bn.until > Date.now());
  u3.send({ type: 'queue', mode: 'ranked' }); assert.strictEqual((await u3.next('error')).code, 'banned');
  own.send({ type: 'say', to: 'admin', text: '/info ' + u2.me.sid });
  let info; for (let i = 0; i < 6 && !(info && info.msg.kind === 'info'); i++) info = await own.next('dm');
  assert.strictEqual(info.msg.data.target.sid, u2.me.sid);
  own.send({ type: 'say', to: 'admin', text: '/creator on' });
  u2.send({ type: 'block', id: u1.me.id }); await u2.next('blocked');
  await sleep(1300); u1.send({ type: 'say', to: u2.me.id, text: 'hey' }); const ew = await u1.next('error'); assert.ok(['cant_write', 'muted', 'not_friend'].includes(ew.code));
  const hz = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json(); assert.ok(hz.online >= hz.players);
  console.log('social ok: ids', u1.me.sid, u2.me.sid, '| online', hz.online, 'players', hz.players);

  // ----- account deletion: in the app and on the web page with the transfer code -----
  const del = await login('Gone'), delOpp = await login('Stay');
  del.send({ type: 'queue', mode: 'ranked' }); delOpp.send({ type: 'queue', mode: 'ranked' });
  await startBoth(del, delOpp); await sleep(3050); await move(del); await move(delOpp);
  del.send({ type: 'delete_account' }); assert.strictEqual((await del.next('error')).code, 'busy');
  del.send({ type: 'resign' }); await del.next('end'); del.send({ type: 'leave' }); delOpp.send({ type: 'leave' });
  await sleep(150);
  del.send({ type: 'delete_account' }); await del.next('deleted');
  assert.strictEqual(await srv.store.get(del.me.id), null);
  delOpp.send({ type: 'profile' }); const sp = await delOpp.next('profile');
  assert.strictEqual(sp.history[0].opp.id, 'deleted'); assert.strictEqual(sp.history[0].opp.name, null);
  const webDel = await login('WebGone');
  const page = await (await fetch(`http://127.0.0.1:${PORT}/delete-account`)).text(); assert.ok(page.includes('code'));
  const bad2 = await (await fetch(`http://127.0.0.1:${PORT}/delete-account`, { method: 'POST', body: 'code=AAAA-BBBB-CCCC', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  assert.ok(bad2.includes('Код не подошёл'));
  const ok2 = await (await fetch(`http://127.0.0.1:${PORT}/delete-account`, { method: 'POST', body: 'code=' + encodeURIComponent(webDel.welcome.acc.recovery), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).text();
  assert.ok(ok2.includes('Аккаунт удалён')); await webDel.next('deleted');
  assert.strictEqual(await srv.store.get(webDel.me.id), null);
  console.log('account deletion ok (app + web)');

  // ----- season rollover archives standings and soft-resets ratings -----
  const store = srv.store, before = (await store.get(A.me.id)).rating;
  await store.rollover('2099-01');
  const after = await store.get(A.me.id), seasons = await store.seasonsOf(A.me.id);
  const bobSeason = (await store.seasonsOf(b.me.id))[0];
  assert.strictEqual(after.rating, R.softReset(before)); assert.strictEqual(after.sGames, 0); assert.ok(seasons[0].rank > bobSeason.rank);
  console.log('season rollover ok:', before, '->', after.rating, 'archived rank', seasons[0].rank);

  const h = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  console.log('healthz', JSON.stringify(h));
  console.log('ALL SERVER TESTS PASSED (' + store.kind + ')');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
