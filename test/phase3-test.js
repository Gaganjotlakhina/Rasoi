// Kya Khaye Phase 3 test: To Buy list (manual + auto-add on cook-to-zero, dedupe)
// and family voting (create/vote/change-vote/close, majority + tie-break,
// one-vote-per-member) plus live socket events for both.
// Requires: DATABASE_URL. Run: npm test
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 4174;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('Kya Khaye Phase 3 test — starting server...');
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: Object.assign({}, process.env, { PORT: String(PORT), DATABASE_URL: DB }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  try {
    await waitHealth();
    console.log('server healthy, running Phase 3 checks:\n');

    // setup: household + two members
    const hhName = 'Phase3Fam-' + Date.now().toString(36);
    let r = await api('/api/households', { method: 'POST', body: JSON.stringify({ name: hhName }) });
    ok('create household', r.status === 201);
    const code = r.data.join_code;
    r = await api(`/api/households/${code}/members`, { method: 'POST', body: JSON.stringify({ name: 'Simran', avatar: '🦁', avatar_kind: 'emoji' }) });
    const memA = r.data;
    r = await api(`/api/households/${code}/members`, { method: 'POST', body: JSON.stringify({ name: 'Harpreet', avatar: '🐯', avatar_kind: 'emoji' }) });
    const memB = r.data;
    ok('two members onboarded', !!memA.id && !!memB.id);

    // ---------- to buy: manual ----------
    r = await api(`/api/households/${code}/tobuy`, { method: 'POST', body: JSON.stringify({ name: 'Milk', qty: 2, unit: 'L', member_id: memA.id }) });
    ok('manual add (201, source=manual)', r.status === 201 && r.data.source === 'manual' && r.data.qty === 2 && r.data.unit === 'L', JSON.stringify(r.data));
    const tbId = r.data.id;
    r = await api(`/api/households/${code}/tobuy`);
    ok('list shows the manual item', r.status === 200 && r.data.items.length === 1 && r.data.items[0].name === 'Milk');
    r = await api(`/api/households/${code}/tobuy/${tbId}`, { method: 'PATCH', body: JSON.stringify({ member_id: memA.id, done: true }) });
    ok('check off as bought', r.status === 200 && r.data.done === true);
    r = await api(`/api/households/${code}/tobuy/${tbId}`, { method: 'PATCH', body: JSON.stringify({ member_id: memB.id, done: false, qty: 3 }) });
    ok('uncheck + edit qty', r.status === 200 && r.data.done === false && r.data.qty === 3);
    r = await api(`/api/households/${code}/tobuy/${tbId}?member_id=${memA.id}`, { method: 'DELETE' });
    ok('delete item', r.status === 200 && r.data.ok === true);
    r = await api(`/api/households/${code}/tobuy`);
    ok('list empty after delete', r.data.items.length === 0);
    r = await api(`/api/households/${code}/tobuy`, { method: 'POST', body: JSON.stringify({ name: '', member_id: memA.id }) });
    ok('nameless item rejected (400)', r.status === 400);

    // ---------- to buy: auto-add on adjust-to-zero ----------
    r = await api(`/api/households/${code}/stock`, { method: 'POST', body: JSON.stringify({ name: 'TestAtta', qty: 2, unit: 'kg', location: 'kitchen', member_id: memA.id }) });
    const attaId = r.data.id;
    r = await api(`/api/households/${code}/stock/${attaId}/adjust`, { method: 'POST', body: JSON.stringify({ delta: -2, member_id: memA.id }) });
    ok('adjust to zero (used-up)', r.status === 200 && r.data.qty === 0);
    r = await api(`/api/households/${code}/tobuy`);
    const autoRow = r.data.items.find((x) => x.name === 'TestAtta');
    ok('auto-added to To Buy (source=auto)', !!autoRow && autoRow.source === 'auto' && autoRow.qty === 2 && autoRow.unit === 'kg' && autoRow.done === false, JSON.stringify(autoRow));

    // ---------- to buy: dedupe bumps qty ----------
    r = await api(`/api/households/${code}/stock`, { method: 'POST', body: JSON.stringify({ name: 'TestAtta', qty: 1, unit: 'kg', location: 'kitchen', member_id: memB.id }) });
    r = await api(`/api/households/${code}/stock/${r.data.id}/adjust`, { method: 'POST', body: JSON.stringify({ delta: -1, member_id: memB.id }) });
    r = await api(`/api/households/${code}/tobuy`);
    const attaRows = r.data.items.filter((x) => x.name === 'TestAtta' && !x.done);
    ok('dedupe: one open row, qty bumped to 3', attaRows.length === 1 && attaRows[0].qty === 3, JSON.stringify(attaRows));

    // ---------- to buy: auto-add via cook ----------
    r = await api(`/api/households/${code}/recipes`);
    ok('recipe picker list works', r.status === 200 && r.data.recipes.length > 5);
    const dal = r.data.recipes.find((x) => x.name === 'Dal Makhani');
    ok('Dal Makhani seeded', !!dal);
    r = await api(`/api/households/${code}/stock`, { method: 'POST', body: JSON.stringify({ name: 'black lentils', qty: 0.5, unit: 'cups', location: 'kitchen', member_id: memA.id }) });
    r = await api(`/api/households/${code}/recipes/${dal.id}/cook`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, servings: 4 }) });
    const usedLentils = (r.data.used || []).find((u) => /lentil/i.test(u.name));
    ok('cook used the lentils', r.status === 200 && !!usedLentils, JSON.stringify(r.data.used));
    r = await api(`/api/households/${code}/tobuy`);
    const lentilRow = r.data.items.find((x) => /lentil/i.test(x.name) && !x.done);
    ok('cook-to-zero auto-added lentils', !!lentilRow && lentilRow.source === 'auto' && lentilRow.qty === 0.5, JSON.stringify(lentilRow));

    // ---------- sockets: tobuy:changed reaches the other client ----------
    const sockA = io(BASE, { transports: ['websocket'] });
    const sockB = io(BASE, { transports: ['websocket'] });
    await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);
    sockA.emit('join', { code, memberId: memA.id });
    sockB.emit('join', { code, memberId: memB.id });
    await Promise.all([waitForPresence(sockA, 2), waitForPresence(sockB, 2)]);
    const tbEvtP = waitFor(sockB, 'tobuy:changed', 5000);
    const tbActP = waitFor(sockB, 'activity', 5000);
    r = await api(`/api/households/${code}/tobuy`, { method: 'POST', body: JSON.stringify({ name: 'Sugar', qty: 1, unit: 'kg', member_id: memA.id }) });
    const tbEvt = await tbEvtP;
    ok('B receives live tobuy:changed', tbEvt.action === 'added' && tbEvt.item.name === 'Sugar' && tbEvt.actor.name === 'Simran', JSON.stringify(tbEvt).slice(0, 140));
    const tbAct = await tbActP;
    ok('B receives activity toast for To Buy', /Simran added Sugar to To Buy/.test(tbAct.text), tbAct.text);

    // ---------- polls ----------
    const r1 = dal.id;
    const r2 = (await api(`/api/households/${code}/recipes`)).data.recipes.find((x) => x.name === 'Rajma Chawal').id;
    ok('two recipe ids ready', !!r1 && !!r2 && r1 !== r2);

    r = await api(`/api/households/${code}/polls`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, meal_slot: 'dinner', recipe_ids: [r1, r2] }) });
    ok('create poll (201, open, 2 candidates)', r.status === 201 && r.data.status === 'open' && r.data.candidates.length === 2, JSON.stringify(r.data).slice(0, 120));
    const pollId = r.data.id;
    r = await api(`/api/households/${code}/polls`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, meal_slot: 'lunch', recipe_ids: [r1] }) });
    ok('second open poll rejected (400)', r.status === 400);
    r = await api(`/api/households/${code}/polls`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, meal_slot: 'lunch', recipe_ids: [] }) });
    ok('empty candidate list rejected (400)', r.status === 400);

    r = await api(`/api/households/${code}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, recipe_id: r1 }) });
    ok('A votes r1', r.status === 200 && r.data.candidates.find((c) => c.id === r1).votes === 1);
    r = await api(`/api/households/${code}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memB.id, recipe_id: r2 }) });
    let view = r.data;
    ok('B votes r2 (tally 1-1)', view.candidates.find((c) => c.id === r1).votes === 1 && view.candidates.find((c) => c.id === r2).votes === 1 && view.total_votes === 2);
    r = await api(`/api/households/${code}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, recipe_id: r2 }) });
    view = r.data;
    const c1 = view.candidates.find((c) => c.id === r1), c2 = view.candidates.find((c) => c.id === r2);
    ok('A changes vote: r2=2, r1=0, still 2 total (one row per member)', c1.votes === 0 && c2.votes === 2 && view.total_votes === 2, JSON.stringify(view.candidates.map((c) => [c.name, c.votes])));
    ok('my_voted flags correct for A', c2.my_voted === true && c1.my_voted === false);
    r = await api(`/api/households/${code}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, recipe_id: '00000000-0000-0000-0000-000000000000' }) });
    ok('vote for non-candidate rejected (400)', r.status === 400);

    r = await api(`/api/households/${code}/polls/${pollId}/close`, { method: 'POST', body: JSON.stringify({ member_id: memB.id }) });
    ok('close: winner is majority (r2)', r.status === 200 && r.data.status === 'closed' && r.data.winner && r.data.winner.id === r2, JSON.stringify(r.data.winner));
    r = await api(`/api/households/${code}/polls`);
    ok('open=null, history has the closed poll', r.data.open === null && r.data.history.length === 1 && r.data.history[0].winner.name === 'Rajma Chawal');
    r = await api(`/api/households/${code}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, recipe_id: r1 }) });
    ok('vote on closed poll rejected (400)', r.status === 400);

    // tie-break: earliest vote wins
    r = await api(`/api/households/${code}/polls`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, meal_slot: 'lunch', recipe_ids: [r1, r2] }) });
    const tieId = r.data.id;
    await api(`/api/households/${code}/polls/${tieId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, recipe_id: r1 }) });
    await sleep(60);
    await api(`/api/households/${code}/polls/${tieId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memB.id, recipe_id: r2 }) });
    r = await api(`/api/households/${code}/polls/${tieId}/close`, { method: 'POST', body: JSON.stringify({ member_id: memA.id }) });
    ok('tie 1-1: earliest vote (r1) wins', r.data.winner && r.data.winner.id === r1, JSON.stringify(r.data.winner));

    // close with no votes -> winner null, still closes
    r = await api(`/api/households/${code}/polls`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, meal_slot: 'snack', recipe_ids: [r1] }) });
    const emptyId = r.data.id;
    r = await api(`/api/households/${code}/polls/${emptyId}/close`, { method: 'POST', body: JSON.stringify({ member_id: memA.id }) });
    ok('close with no votes (winner null)', r.status === 200 && r.data.status === 'closed' && r.data.winner === null);

    // socket: poll:changed reaches the other client live
    r = await api(`/api/households/${code}/polls`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, meal_slot: 'breakfast', recipe_ids: [r1, r2] }) });
    const liveId = r.data.id;
    const pollEvtP = waitFor(sockB, 'poll:changed', 5000);
    // collect activity events until the vote toast arrives (a 'created' toast may land first)
    const pollActP = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for vote activity')), 5000);
      const h = (a) => {
        if (/voted for/.test(a.text)) { clearTimeout(t); sockB.off('activity', h); resolve(a); }
      };
      sockB.on('activity', h);
    });
    await api(`/api/households/${code}/polls/${liveId}/vote`, { method: 'POST', body: JSON.stringify({ member_id: memA.id, recipe_id: r1 }) });
    const pollEvt = await pollEvtP;
    ok('B receives live poll:changed', pollEvt.action === 'vote' && pollEvt.poll.id === liveId, JSON.stringify(pollEvt).slice(0, 120));
    const pollAct = await pollActP;
    ok('B receives vote activity toast', /Simran voted for Dal Makhani/.test(pollAct.text), pollAct.text);
    await api(`/api/households/${code}/polls/${liveId}/close`, { method: 'POST', body: JSON.stringify({ member_id: memA.id }) });

    sockA.disconnect(); sockB.disconnect();
  } catch (e) {
    failures++;
    console.log('  FAIL  unexpected error: ' + (e && e.message));
  } finally {
    srv.kill();
  }

  console.log(failures === 0 ? '\n✅ ALL PHASE 3 TESTS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
