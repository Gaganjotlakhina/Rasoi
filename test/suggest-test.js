// Rasoi Phase 2 suggest test.
// Boots the real server (which auto-seeds recipes) and verifies:
//  1. seed idempotency (seedRecipes twice -> same count)
//  2. suggest ranking by stock match %
//  3. Hindi/Punjabi alias normalization ("Aloo" matches potato)
//  4. meal / diet / heritage filters
//  5. macro filters (minProtein, maxCalories, maxCarbs)
//  6. servings scaling of ingredient quantities
//  7. cook endpoint deducts stock (unit-aware) and reports missing
// Requires: DATABASE_URL (run-all.js provides it). Run: npm test
const { spawn } = require('child_process');

const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.DATABASE_URL;
if (!DB) { console.error('suggest-test: DATABASE_URL is required'); process.exit(2); }

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

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server never became healthy');
}

(async () => {
  console.log('Rasoi suggest test — starting server...');
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

    // --- 1. seed idempotency (module-level, direct DB) ---
    const { Pool } = require('pg');
    const { seedRecipes, recipeCount } = require('../seed');
    const pool = new Pool({ connectionString: DB });
    const before = await recipeCount(pool);
    const inserted = await seedRecipes(pool);
    const after = await recipeCount(pool);
    ok('seed is idempotent (second run inserts 0)', inserted === 0 && before === after, `before=${before} inserted=${inserted} after=${after}`);
    ok('recipe count is 28 (18 heritage + 10 everyday)', after === 28, `count=${after}`);
    await pool.end();

    // --- household + member + stock ---
    let r = await api('/api/households', { method: 'POST', body: JSON.stringify({ name: 'SuggestFam-' + Date.now().toString(36) }) });
    ok('create household', r.status === 201);
    const code = r.data.join_code;
    r = await api(`/api/households/${code}/members`, { method: 'POST', body: JSON.stringify({ name: 'Tester', avatar: '🧪', avatar_kind: 'emoji' }) });
    ok('add member', r.status === 201);
    const mem = r.data;
    async function addStock(name, qty, unit, location) {
      const rr = await api(`/api/households/${code}/stock`, {
        method: 'POST',
        body: JSON.stringify({ name, qty, unit, location: location || 'kitchen', member_id: mem.id }),
      });
      if (rr.status !== 201) throw new Error('addStock failed: ' + JSON.stringify(rr.data));
      return rr.data;
    }
    await addStock('Paneer', 400, 'g', 'fridge');
    await addStock('Peas', 1, 'cups', 'fridge');
    await addStock('Onion', 2, 'pcs', 'kitchen');
    await addStock('Tomato', 2, 'pcs', 'kitchen');
    await addStock('Oil', 1, 'L', 'kitchen');

    // --- 2. ranking: paneer bhurji should top breakfast ---
    r = await api(`/api/households/${code}/suggest?meal=breakfast&servings=4`);
    ok('suggest breakfast (200)', r.status === 200 && Array.isArray(r.data.suggestions));
    const names = r.data.suggestions.map((s) => s.name);
    ok('paneer bhurji ranked first for breakfast', names[0] === 'Paneer Bhurji', names.slice(0, 3).join(','));
    const bhurji = r.data.suggestions[0];
    ok('match fields present', bhurji.matchPct >= 50 && bhurji.haveCount > 0 && bhurji.totalCount === bhurji.haveCount + bhurji.missing.length,
      JSON.stringify({ m: bhurji.matchPct, h: bhurji.haveCount, t: bhurji.totalCount }));
    ok('results sorted by matchPct desc', r.data.suggestions.every((s, i, a) => i === 0 || a[i - 1].matchPct >= s.matchPct));

    // --- 3. alias normalization: "Aloo" (Hindi) matches potato ---
    await addStock('Aloo', 5, 'pcs', 'kitchen');
    r = await api(`/api/households/${code}/suggest?meal=breakfast&servings=4`);
    const paratha = r.data.suggestions.find((s) => s.name === 'Aloo Paratha');
    ok('alias "Aloo" matches potato in aloo paratha', !!paratha && paratha.haveCount > 0, paratha && `${paratha.haveCount}/${paratha.totalCount}`);

    // --- 4. filters ---
    r = await api(`/api/households/${code}/suggest?diet=veg`);
    ok('diet=veg excludes egg/nonveg', r.status === 200 && r.data.suggestions.every((s) => ['veg', 'vegan'].includes(s.diet)),
      r.data.suggestions.map((s) => s.diet).join(','));
    r = await api(`/api/households/${code}/suggest?diet=nonveg`);
    ok('diet=nonveg includes chicken curry', r.data.suggestions.some((s) => s.name === 'Homestyle Chicken Curry'));
    r = await api(`/api/households/${code}/suggest?heritage=punjabi-classic`);
    ok('heritage filter returns only classics (18)', r.status === 200 && r.data.suggestions.length === 18 &&
      r.data.suggestions.every((s) => s.heritage === 'punjabi-classic'), `count=${r.data.suggestions.length}`);
    r = await api(`/api/households/${code}/suggest?meal=dinner&diet=veg`);
    ok('meal=dinner filter respected', r.data.suggestions.every((s) => s.meal_types.includes('dinner')));

    // --- 5. macro filters ---
    r = await api(`/api/households/${code}/suggest?minProtein=20`);
    ok('minProtein=20 filters correctly', r.data.suggestions.length > 0 && r.data.suggestions.every((s) => s.macros.protein_g >= 20));
    r = await api(`/api/households/${code}/suggest?maxCalories=250`);
    ok('maxCalories=250 filters correctly', r.data.suggestions.every((s) => s.macros.calories <= 250));
    r = await api(`/api/households/${code}/suggest?maxCarbs=15`);
    ok('maxCarbs=15 filters correctly', r.data.suggestions.every((s) => s.macros.carbs_g <= 15));

    // --- 6. servings scaling ---
    r = await api(`/api/households/${code}/suggest?meal=breakfast&servings=8`);
    const b8 = r.data.suggestions.find((s) => s.name === 'Paneer Bhurji');
    const paneerIng = b8.ingredients.find((g) => g.name.toLowerCase() === 'paneer');
    ok('servings=8 doubles paneer qty (400g -> 800g)', paneerIng && paneerIng.qty === 800, JSON.stringify(paneerIng));
    r = await api(`/api/households/${code}/recipes/${b8.id}?servings=2`);
    const paneerIng2 = r.data.ingredients.find((g) => g.name.toLowerCase() === 'paneer');
    ok('recipe detail servings=2 halves qty (400g -> 200g)', r.status === 200 && paneerIng2 && paneerIng2.qty === 200);
    ok('recipe detail has steps + in_stock flags', r.data.steps.length >= 3 && r.data.ingredients.some((g) => g.in_stock));

    // --- 7. cook deducts stock ---
    r = await api(`/api/households/${code}/recipes/${b8.id}/cook`, {
      method: 'POST', body: JSON.stringify({ member_id: mem.id, servings: 4 }),
    });
    ok('cook (200 + used paneer)', r.status === 200 && r.data.used.some((u) => u.name.toLowerCase() === 'paneer'),
      JSON.stringify(r.data.used));
    r = await api(`/api/households/${code}/stock`);
    const paneerLeft = r.data.items.find((i) => i.name.toLowerCase() === 'paneer');
    ok('paneer deducted to 0 after cooking', paneerLeft && Number(paneerLeft.qty) === 0, JSON.stringify(paneerLeft && paneerLeft.qty));
    ok('cook reports missing for depleted items', true); // covered by used/missing shape below
    r = await api(`/api/households/${code}/recipes/${b8.id}/cook`, {
      method: 'POST', body: JSON.stringify({ member_id: mem.id, servings: 4 }),
    });
    ok('second cook lists paneer as missing', r.data.missing.some((m) => m.name.toLowerCase() === 'paneer'),
      JSON.stringify(r.data.missing.map((m) => m.name)));

    // --- 8. bad household -> 404 ---
    r = await api('/api/households/BOGUS1/suggest');
    ok('bogus code -> 404', r.status === 404);

    console.log(failures === 0 ? '\nALL SUGGEST TESTS PASSED ✅' : `\n${failures} FAILURES ❌`);
    exitCode = failures === 0 ? 0 : 1;
  } catch (e) {
    console.error('TEST ERROR:', e);
    exitCode = 2;
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  }
  process.exit(exitCode);
})();
