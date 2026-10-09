// End-to-end protocol test: real sockets, client-side prediction checked against server hashes.
const WebSocket = require('ws');
const L = (() => { try { return require('./logic.js'); } catch (e) { return require('../web/js/logic.js'); } })();
const assert = require('assert');
const PORT = 18080 + Math.floor(Math.random() * 1000);
process.env.PORT = PORT;
require('./index.js');
const URL = `ws://127.0.0.1:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, token) {
  const ws = new WebSocket(URL), c = { ws, name, inbox: [], st: null, seq: 0, mismatches: 0, waiters: [] };
  c.send = (o) => ws.send(JSON.stringify(o));
  c.next = (type, ms = 6000) => new Promise((res, rej) => {
    const i = c.inbox.findIndex((m) => m.type === type);
    if (i >= 0) return res(c.inbox.splice(i, 1)[0]);
    const to = setTimeout(() => rej(new Error(name + ' timeout waiting ' + type + ' inbox=' + JSON.stringify(c.inbox.map(m=>m.type+':'+(m.code||m.seq||''))))), ms);
    c.waiters.push({ type, res: (m) => { clearTimeout(to); res(m); } });
  });
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    const w = c.waiters.findIndex((x) => x.type === m.type);
    if (w >= 0) c.waiters.splice(w, 1)[0].res(m); else c.inbox.push(m);
  });
  c.ready = new Promise((r) => ws.on('open', () => { c.send({ type: 'hello', v: 1, name, token }); r(); }));
  return c;
}
// play one predicted move and check the server agrees
async function move(c) {
  const e = L.empties(c.st);
  const cell = e[(Math.random() * e.length) | 0];
  await sleep(45); L.place(c.st, cell); c.seq++;
  c.send({ type: 'move', seq: c.seq, a: 'place', c: cell });
  const ack = await c.next('ack');
  assert.strictEqual(ack.seq, c.seq);
  L.addBolts(c.st, ack.garbage);
  if (ack.h !== L.hash(c.st)) c.mismatches++;
  return ack;
}

(async () => {
  await sleep(200);
  const a = client('Alice'), b = client('Bob');
  await Promise.all([a.ready, b.ready]);
  const wa = await a.next('welcome'); await b.next('welcome');
  // quick match
  a.send({ type: 'queue' }); b.send({ type: 'queue' });
  const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
  assert.strictEqual(sa.seed, sb.seed); assert.notStrictEqual(sa.side, sb.side);
  assert.strictEqual(sa.opp.name, 'Bob');
  for (const [c, s] of [[a, sa], [b, sb]]) c.st = L.newGame({ mode: 'duel', seed: s.seed, rules: L.DUEL_RULES });
  // moves before the countdown are rejected
  a.send({ type: 'move', seq: 1, a: 'place', c: 0 });
  assert.strictEqual((await a.next('error')).code, 'early');
  await sleep(3000);
  let garbageSeen = 0, incoming = 0;
  for (let i = 0; i < 40; i++) {
    const r1 = await move(a); garbageSeen += r1.garbage.length;
    if (a.st.over) break;
    const r2 = await move(b); garbageSeen += r2.garbage.length;
    if (b.st.over) break;
  }
  incoming = a.inbox.filter((m) => m.type === 'incoming').length + b.inbox.filter((m) => m.type === 'incoming').length;
  const oppMsgs = a.inbox.filter((m) => m.type === 'opp').length;
  assert.strictEqual(a.mismatches + b.mismatches, 0, 'prediction must match server');
  console.log('quick match ok: moves', a.st.moves, b.st.moves, 'garbage bolts', garbageSeen, 'incoming msgs', incoming, 'opp updates', oppMsgs);
  // reconnect keeps the seat
  if (!a.st.over && !b.st.over) {
    // wrong seq -> full state resync
    a.send({ type: 'move', seq: a.seq + 5, a: 'place', c: L.empties(a.st)[0] });
    const st = await a.next('state'); assert.strictEqual(st.seq, a.seq);
    a.ws.close(); await sleep(150);
    const a2 = client('Alice', wa.token); await a2.ready; await a2.next('welcome');
    const res = await a2.next('resume');
    assert.strictEqual(res.seq, a.seq); assert.strictEqual(L.hash(res.state), L.hash(a.st));
    console.log('reconnect ok, time left', Math.round(res.left / 1000), 's');
    a2.send({ type: 'resign' });
    const [ea, eb] = await Promise.all([a2.next('end'), b.next('end')]);
    assert.strictEqual(ea.result, 'lose'); assert.strictEqual(eb.result, 'win'); assert.strictEqual(eb.reason, 'resign');
    // rematch: both agree -> new match with swapped sides
    a2.send({ type: 'rematch' }); await b.next('rematch'); b.send({ type: 'rematch' });
    const [r1, r2] = await Promise.all([a2.next('start'), b.next('start')]);
    assert.strictEqual(r1.side, 1 - sa.side);
    console.log('resign + rematch ok');
    a2.send({ type: 'leave' }); await b.next('opp_left');
    a2.ws.close();
  } else console.log('(match ended by KO, reconnect/rematch checks skipped this run)');
  // private room
  const c = client('Cara'), d = client('Dan');
  await Promise.all([c.ready, d.ready]); await c.next('welcome'); await d.next('welcome');
  d.send({ type: 'room_join', code: '0000' }); assert.strictEqual((await d.next('error')).code, 'no_room');
  c.send({ type: 'room_create' }); const room = await c.next('room');
  d.send({ type: 'room_join', code: room.code });
  await Promise.all([c.next('start'), d.next('start')]);
  console.log('room', room.code, 'ok');
  // bot match plays by itself and the result is consistent
  const e = client('Eve'); await e.ready; await e.next('welcome');
  e.send({ type: 'bot' }); const se = await e.next('start');
  assert.ok(se.opp.bot);
  e.st = L.newGame({ mode: 'duel', seed: se.seed, rules: L.DUEL_RULES });
  await sleep(3200);
  for (let i = 0; i < 6; i++) { await move(e); await sleep(300); }
  await sleep(2500);
  const bots = e.inbox.filter((m) => m.type === 'opp').length;
  assert.ok(bots >= 2, 'bot should be moving');
  assert.strictEqual(e.mismatches, 0);
  console.log('bot match ok, bot moves seen', bots);
  const h = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  console.log('healthz', JSON.stringify(h));
  console.log('ALL SERVER TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
