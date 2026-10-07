// Kya Khaye Phase 4 test: receipt/grocery-list parser + /scan endpoint.
// Parser tests are pure unit tests (no OCR engine needed). Endpoint tests
// only exercise validation (400/403/404) plus the graceful 503 when the
// tesseract binary is absent — OCR itself is never run in tests.
// Requires: DATABASE_URL. Run: npm test
const { spawn, execSync } = require('child_process');
const { parseReceiptText } = require('../parse-receipt');

const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.DATABASE_URL || 'postgres://localhost/rasoi_test';

let failures = 0;
function ok(name, cond, extra) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

function hasTesseractBin() {
  try { execSync('command -v tesseract', { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}

// ---------- parser unit tests ----------
const WALMART = `
WALMART SUPERCENTRE #1234
TEL 416-555-0100
123456789012
GREAT VALUE MILK 2L 4.97
BANANAS 2 @ 0.59
ATTA 5KG 12.99
EGGS LARGE 12CT 3.49
BREAD 675G 2.97
SUBTOTAL 24.01
GST 1.20
TOTAL 25.21
TENDER 30.00
CHANGE DUE 4.79
THANK YOU FOR SHOPPING
`;

const GROCERY_LIST = `
milk
2 eggs
atta 5kg
a dozen bananas
2 x onions
x2 tomatoes
half kg paneer
`;

function find(items, substr) {
  return items.find((i) => i.name.toLowerCase().includes(substr));
}

function parserTests() {
  console.log('parser unit tests:');
  let items = parseReceiptText(WALMART);
  ok('receipt: finds milk with 2L', (() => { const i = find(items, 'milk'); return i && i.qty === 2 && i.unit === 'L'; })(), JSON.stringify(items));
  ok('receipt: bananas 2 @ 0.59 -> qty 2', (() => { const i = find(items, 'banana'); return i && i.qty === 2; })(), JSON.stringify(items));
  ok('receipt: atta 5kg', (() => { const i = find(items, 'atta'); return i && i.qty === 5 && i.unit === 'kg'; })(), JSON.stringify(items));
  ok('receipt: eggs 12ct -> qty 12 pcs', (() => { const i = find(items, 'egg'); return i && i.qty === 12 && i.unit === 'pcs'; })(), JSON.stringify(items));
  ok('receipt: bread 675g', (() => { const i = find(items, 'bread'); return i && i.qty === 675 && i.unit === 'g'; })(), JSON.stringify(items));
  const names = items.map((i) => i.name.toLowerCase()).join('|');
  ok('receipt: drops totals/tax/tender/change/thanks', !/subtotal|total|gst|tender|change|thank/.test(names), names);
  ok('receipt: drops store header lines', !/walmart|supercentre|tel/.test(names), names);
  ok('receipt: no empty names', items.every((i) => i.name && i.name.trim().length > 0));

  items = parseReceiptText(GROCERY_LIST);
  ok('list: plain item defaults to 1 pcs', (() => { const i = find(items, 'milk'); return i && i.qty === 1 && i.unit === 'pcs'; })());
  ok('list: leading number qty', (() => { const i = find(items, 'egg'); return i && i.qty === 2; })());
  ok('list: attached unit sets qty', (() => { const i = find(items, 'atta'); return i && i.qty === 5 && i.unit === 'kg'; })());
  ok('list: "a dozen bananas" -> 12', (() => { const i = find(items, 'banana'); return i && i.qty === 12; })(), JSON.stringify(items));
  ok('list: "2 x onions"', (() => { const i = find(items, 'onion'); return i && i.qty === 2; })(), JSON.stringify(items));
  ok('list: "x2 tomatoes"', (() => { const i = find(items, 'tomato'); return i && i.qty === 2; })(), JSON.stringify(items));
  ok('list: "half kg paneer"', (() => { const i = find(items, 'paneer'); return i && i.qty === 0.5 && i.unit === 'kg'; })(), JSON.stringify(items));

  ok('empty input -> []', parseReceiptText('').length === 0 && parseReceiptText('   \n  ').length === 0);
  ok('numbers-only lines dropped', parseReceiptText('123456\n$4.99\n***\n---').length === 0);
  ok('price stripped from name', (() => {
    const i = parseReceiptText('CHEDDAR CHEESE 400G 6.49')[0];
    return i && i.name === 'Cheddar Cheese' && i.qty === 400 && i.unit === 'g';
  })());
  ok('never emits empty names (noisy OCR)', (() => {
    const noisy = '$$$ 12.34\nTOTAL\n*** SAVE ***\n   \n###\nGST\n1 @\n';
    return parseReceiptText(noisy).every((i) => i.name.trim().length > 0);
  })());
}

// ---------- endpoint tests ----------
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

const TINY_PNG = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

async function endpointTests() {
  console.log('\nendpoint tests:');
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: Object.assign({}, process.env, { PORT: String(PORT), DATABASE_URL: DB }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  try {
    await waitHealth();
    let r = await api('/api/households', { method: 'POST', body: JSON.stringify({ name: 'ScanFam-' + Date.now().toString(36) }) });
    const code = r.data.join_code;
    r = await api(`/api/households/${code}/members`, { method: 'POST', body: JSON.stringify({ name: 'Gaganjot', avatar: '🦁', avatar_kind: 'emoji' }) });
    const mem = r.data;

    r = await api(`/api/households/BOGUS1/scan`, { method: 'POST', body: JSON.stringify({ member_id: 'x', image: TINY_PNG }) });
    ok('bogus household -> 404', r.status === 404);

    r = await api(`/api/households/${code}/scan`, { method: 'POST', body: JSON.stringify({ member_id: '00000000-0000-0000-0000-000000000000', image: TINY_PNG }) });
    ok('unknown member -> 403', r.status === 403);

    r = await api(`/api/households/${code}/scan`, { method: 'POST', body: JSON.stringify({ member_id: mem.id }) });
    ok('missing image -> 400', r.status === 400);

    r = await api(`/api/households/${code}/scan`, { method: 'POST', body: JSON.stringify({ member_id: mem.id, image: 'not-a-data-url' }) });
    ok('invalid image string -> 400', r.status === 400);

    r = await api(`/api/households/${code}/scan`, { method: 'POST', body: JSON.stringify({ member_id: mem.id, image: 'data:text/plain;base64,aGk=' }) });
    ok('non-image data URL -> 400', r.status === 400);

    r = await api(`/api/households/${code}/scan`, { method: 'POST', body: JSON.stringify({ member_id: mem.id, image: TINY_PNG }) });
    if (hasTesseractBin()) {
      ok('valid scan -> 200 with items array', r.status === 200 && Array.isArray(r.data.items), JSON.stringify(r.data).slice(0, 120));
    } else {
      ok('valid scan without tesseract binary -> 503 graceful', r.status === 503 && /not available/i.test(r.data.error || ''), JSON.stringify(r.data));
    }
  } catch (e) {
    failures++;
    console.log('  FAIL  unexpected error: ' + e.message);
  } finally {
    srv.kill();
  }
}

(async () => {
  console.log('Kya Khaye scan test (Phase 4)...');
  parserTests();
  await endpointTests();
  console.log(failures === 0 ? '\n✅ ALL SCAN TESTS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
