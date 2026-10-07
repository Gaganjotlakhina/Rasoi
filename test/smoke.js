// WhatToEat Phase 1 smoke test.
// Spins up the server, then verifies:
//  1. REST: create household -> join code works
//  2. REST: member onboarding (emoji + photo avatar kinds)
//  3. REST: stock CRUD (add / adjust / patch / delete)
//  4. Socket.io: two clients in one household room — a stock change made via
//     REST on "client A" must arrive as a live event on "client B"
//  5. Presence: both members appear in the online list
// Requires: DATABASE_URL (defaults to postgres://localhost/rasoi_test)
// Run: npm test
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.DATABASE_URL || 'postgres://localhost/rasoi_test';

let failures = 0;
function ok(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

async function api(path, opts) {
  const res = await fetch(BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function waitFor(emitter, ev, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + ev)), timeoutMs || 5000);
    emitter.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
}

// presence is emitted on every join; wait until the list has >= count members
function waitForPresence(sock, count, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for presence with ${count} members`)), timeoutMs || 8000);
    const h = (p) => {
      if (p.members && p.members.length >= count) { clearTimeout(t); sock.off('presence', h); resolve(p); }
    };
    sock.on('presence', h);
  });
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server never became healthy');
}

(async () => {
  console.log('WhatToEat smoke test — starting server...');
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: Object.assign({}, process.env, { PORT: String(PORT), DATABASE_URL: DB }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let exitCode = 0;
  try {
    await waitHealth();
    console.log('server healthy, running checks:\n');

    // 1. household
    const hhName = 'SmokeFam-' + Date.now().toString(36);
    let r = await api('/api/households', { method: 'POST', body: JSON.stringify({ name: hhName }) });
    ok('create household (201 + 6-char code)', r.status === 201 && /^[A-Z2-9]{6}$/.test(r.data.join_code), JSON.stringify(r.data));
    const code = r.data.join_code;

    r = await api('/api/households/' + code);
    ok('join household by code', r.status === 200 && r.data.name === hhName);
    r = await api('/api/households/BOGUS1');
    ok('bogus code -> 404', r.status === 404);

    // 2. members (emoji + photo kinds)
    r = await api(`/api/households/${code}/members`, { method: 'POST', body: JSON.stringify({ name: 'Gaganjot', avatar: '🦁', avatar_kind: 'emoji' }) });
    ok('add member (emoji avatar)', r.status === 201 && !!r.data.id);
    const memA = r.data;
    const tinyPhoto = 'data:image/jpeg;base64,' + Buffer.alloc(100).toString('base64');
    r = await api(`/api/households/${code}/members`, { method: 'POST', body: JSON.stringify({ name: 'Tester', avatar: tinyPhoto, avatar_kind: 'photo' }) });
    ok('add member (photo avatar)', r.status === 201 && r.data.avatar_kind === 'photo');
    const memB = r.data;
    r = await api(`/api/households/${code}/members`, { method: 'POST', body: JSON.stringify({ name: '', avatar: '😀', avatar_kind: 'emoji' }) });
    ok('nameless member rejected (400)', r.status === 400);

    // 3. stock CRUD
    r = await api(`/api/households/${code}/stock`, { method: 'POST', body: JSON.stringify({ name: 'Eggs', qty: 12, unit: 'pcs', location: 'fridge', member_id: memA.id }) });
    ok('add stock item', r.status === 201 && r.data.qty === 12 && r.data.location === 'fridge');
    const itemId = r.data.id;
    r = await api(`/api/households/${code}/stock/${itemId}/adjust`, { method: 'POST', body: JSON.stringify({ delta: -2, member_id: memA.id }) });
    ok('adjust -2 (deduction)', r.status === 200 && r.data.qty === 10);
    r = await api(`/api/households/${code}/stock/${itemId}/adjust`, { method: 'POST', body: JSON.stringify({ delta: -99, member_id: memA.id }) });
    ok('qty floors at 0, never negative', r.status === 200 && r.data.qty === 0);
    r = await api(`/api/households/${code}/stock/${itemId}`, { method: 'PATCH', body: JSON.stringify({ qty: 6, member_id: memA.id }) });
    ok('patch qty back to 6', r.status === 200 && r.data.qty === 6);
    r = await api(`/api/households/${code}/stock`);
    ok('list stock (1 item)', r.status === 200 && r.data.items.length === 1 && r.data.items[0].name === 'Eggs');

    // 4+5. realtime: two socket clients, REST change on A must reach B live
    const sockA = io(BASE, { transports: ['websocket'] });
    const sockB = io(BASE, { transports: ['websocket'] });
    await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);
    sockA.emit('join', { code, memberId: memA.id });
    sockB.emit('join', { code, memberId: memB.id });
    const presenceA = waitForPresence(sockA, 2);
    const presenceB = waitForPresence(sockB, 2);
    const [pa, pb] = await Promise.all([presenceA, presenceB]);
    const names = (p) => p.members.map((m) => m.name).sort().join(',');
    ok('presence lists both members (A sees)', names(pa) === 'Gaganjot,Tester', names(pa));
    ok('presence lists both members (B sees)', names(pb) === 'Gaganjot,Tester', names(pb));

    const changedOnB = waitFor(sockB, 'stock:changed', 5000);
    const activityOnB = waitFor(sockB, 'activity', 5000);
    r = await api(`/api/households/${code}/stock/${itemId}/adjust`, { method: 'POST', body: JSON.stringify({ delta: -2, member_id: memA.id }) });
    const evt = await changedOnB;
    ok('B receives live stock:changed', evt.item.id === itemId && evt.item.qty === 4 && evt.actor.name === 'Gaganjot', JSON.stringify(evt).slice(0, 120));
    const act = await activityOnB;
    ok('B receives activity toast ("Gaganjot used 2 pcs Eggs")', /Gaganjot used 2 pcs Eggs/.test(act.text), act.text);

    // second household isolation: event must NOT leak to another room
    r = await api('/api/households', { method: 'POST', body: JSON.stringify({ name: 'OtherFam-' + Date.now().toString(36) }) });
    const code2 = r.data.join_code;
    r = await api(`/api/households/${code2}/members`, { method: 'POST', body: JSON.stringify({ name: 'Stranger', avatar: '👽', avatar_kind: 'emoji' }) });
    const sockC = io(BASE, { transports: ['websocket'] });
    await waitFor(sockC, 'connect');
    sockC.emit('join', { code: code2, memberId: r.data.id });
    await waitFor(sockC, 'presence', 5000);
    let leaked = false;
    sockC.on('stock:changed', () => { leaked = true; });
    await api(`/api/households/${code}/stock/${itemId}/adjust`, { method: 'POST', body: JSON.stringify({ delta: 1, member_id: memA.id }) });
    await new Promise((res) => setTimeout(res, 800));
    ok('no cross-household event leak', !leaked);
    sockC.disconnect();

    // delete
    r = await api(`/api/households/${code}/stock/${itemId}?member_id=${memA.id}`, { method: 'DELETE' });
    ok('delete item', r.status === 200 && r.data.ok === true);
    r = await api(`/api/households/${code}/stock`);
    ok('stock empty after delete', r.data.items.length === 0);

    sockA.disconnect(); sockB.disconnect();
  } catch (e) {
    failures++;
    console.log('  FAIL  unexpected error: ' + e.message);
  } finally {
    srv.kill();
  }

  console.log(failures === 0 ? '\n✅ ALL SMOKE TESTS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
