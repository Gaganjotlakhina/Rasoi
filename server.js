// Rasoi server — realtime family kitchen stock + dish suggestions. Phase 2.
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { seedRecipes, recipeCount } = require('./seed');
const { recipeView, rankRecipes, applyFilters, normalizeName, convertQty } = require('./suggest');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) console.warn('[rasoi] WARNING: DATABASE_URL is not set');

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  max: 10,
  // Render's external Postgres URLs require TLS; local dev databases usually don't.
  ...( /render\.com|sslmode=require/.test(DATABASE_URL) ? { ssl: { rejectUnauthorized: false } } : {} ),
});

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// 6-char join codes, unambiguous alphabet (no 0/O, 1/I/L).
const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)];
  return s;
}
async function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode();
    const { rows } = await pool.query('SELECT 1 FROM rasoi_households WHERE join_code = $1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('could not generate unique join code');
}

const LOCATIONS = ['kitchen', 'fridge', 'freezer'];

function normCode(c) { return String(c || '').trim().toUpperCase(); }

async function householdByCode(code) {
  const { rows } = await pool.query('SELECT id, name, join_code, created_at FROM rasoi_households WHERE join_code = $1', [normCode(code)]);
  return rows[0] || null;
}
async function memberById(householdId, memberId) {
  if (!memberId) return null;
  const { rows } = await pool.query(
    'SELECT id, household_id, name, avatar, avatar_kind FROM rasoi_members WHERE id = $1 AND household_id = $2',
    [memberId, householdId]
  );
  return rows[0] || null;
}
function cleanName(n) { return String(n || '').trim().slice(0, 60); }
function cleanUnit(u) { return String(u || 'pcs').trim().slice(0, 16) || 'pcs'; }
function validAvatar(avatar, kind) {
  if (kind === 'photo') {
    return typeof avatar === 'string' && avatar.startsWith('data:image/') && avatar.length <= 300000;
  }
  return typeof avatar === 'string' && avatar.trim().length > 0 && avatar.trim().length <= 8;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true, app: 'rasoi', phase: 2 }));

// ---- households ----
app.post('/api/households', async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Household name is required' });
    const join_code = await uniqueCode();
    const { rows } = await pool.query(
      'INSERT INTO rasoi_households (name, join_code) VALUES ($1, $2) RETURNING id, name, join_code',
      [name, join_code]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not create household' }); }
});

app.get('/api/households/:code', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM rasoi_members WHERE household_id = $1', [hh.id]);
    res.json({ ...hh, member_count: rows[0].n });
  } catch (e) { console.error(e); res.status(500).json({ error: 'lookup failed' }); }
});

// ---- members ----
app.post('/api/households/:code/members', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const name = cleanName(req.body.name);
    const avatar_kind = req.body.avatar_kind === 'photo' ? 'photo' : 'emoji';
    const avatar = avatar_kind === 'photo' ? String(req.body.avatar || '') : String(req.body.avatar || '🍳').trim();
    if (!name) return res.status(400).json({ error: 'Your name is required' });
    if (!validAvatar(avatar, avatar_kind)) return res.status(400).json({ error: 'Invalid avatar' });
    const { rows } = await pool.query(
      'INSERT INTO rasoi_members (household_id, name, avatar, avatar_kind) VALUES ($1, $2, $3, $4) RETURNING id, name, avatar, avatar_kind',
      [hh.id, name, avatar, avatar_kind]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not add member' });
  }
});

app.get('/api/households/:code/members', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const { rows } = await pool.query(
      'SELECT id, name, avatar, avatar_kind, created_at FROM rasoi_members WHERE household_id = $1 ORDER BY created_at',
      [hh.id]
    );
    res.json({ members: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'lookup failed' }); }
});

// ---- stock ----
function stockRow(r) {
  return { id: r.id, name: r.name, qty: Number(r.qty), unit: r.unit, location: r.location, updated_by: r.updated_by, updated_at: r.updated_at };
}

app.get('/api/households/:code/stock', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const { rows } = await pool.query(
      'SELECT * FROM rasoi_stock WHERE household_id = $1 ORDER BY updated_at DESC',
      [hh.id]
    );
    res.json({ items: rows.map(stockRow) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'lookup failed' }); }
});

app.post('/api/households/:code/stock', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const name = cleanName(req.body.name);
    const qty = Math.max(0, Math.min(1e6, Number(req.body.qty) || 0));
    const unit = cleanUnit(req.body.unit);
    const location = LOCATIONS.includes(req.body.location) ? req.body.location : 'kitchen';
    if (!name) return res.status(400).json({ error: 'Item name is required' });
    const { rows } = await pool.query(
      `INSERT INTO rasoi_stock (household_id, name, qty, unit, location, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [hh.id, name, qty, unit, location, actor.id]
    );
    const item = stockRow(rows[0]);
    broadcastStock(hh.join_code, 'added', item, actor, { qty });
    res.status(201).json(item);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not add item' }); }
});

app.patch('/api/households/:code/stock/:id', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const sets = ['updated_by = $2', 'updated_at = now()'];
    const vals = [req.params.id, actor.id];
    let i = 3;
    if (req.body.name !== undefined) { const n = cleanName(req.body.name); if (!n) return res.status(400).json({ error: 'Item name is required' }); sets.push(`name = $${i++}`); vals.push(n); }
    if (req.body.qty !== undefined) { sets.push(`qty = $${i++}`); vals.push(Math.max(0, Math.min(1e6, Number(req.body.qty) || 0))); }
    if (req.body.unit !== undefined) { sets.push(`unit = $${i++}`); vals.push(cleanUnit(req.body.unit)); }
    if (req.body.location !== undefined && LOCATIONS.includes(req.body.location)) { sets.push(`location = $${i++}`); vals.push(req.body.location); }
    vals.push(hh.id);
    const { rows } = await pool.query(
      `UPDATE rasoi_stock SET ${sets.join(', ')} WHERE id = $1 AND household_id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = stockRow(rows[0]);
    broadcastStock(hh.join_code, 'updated', item, actor, {});
    res.json(item);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not update item' }); }
});

// Atomic +/- stepper (and "use up"): qty never goes below 0.
app.post('/api/households/:code/stock/:id/adjust', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const delta = Math.max(-1e6, Math.min(1e6, Number(req.body.delta) || 0));
    const { rows } = await pool.query(
      `UPDATE rasoi_stock
       SET qty = GREATEST(0, qty + $1), updated_by = $2, updated_at = now()
       WHERE id = $3 AND household_id = $4 RETURNING *`,
      [delta, actor.id, req.params.id, hh.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = stockRow(rows[0]);
    const action = delta < 0 && item.qty === 0 ? 'used-up' : 'adjusted';
    broadcastStock(hh.join_code, action, item, actor, { delta });
    res.json(item);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not adjust item' }); }
});

app.delete('/api/households/:code/stock/:id', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.query.member_id || req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const { rows } = await pool.query(
      'DELETE FROM rasoi_stock WHERE id = $1 AND household_id = $2 RETURNING *',
      [req.params.id, hh.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = stockRow(rows[0]);
    broadcastStock(hh.join_code, 'removed', item, actor, {});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not delete item' }); }
});

// ---- recipes & suggestions (Phase 2) ----
async function loadRecipe(id) {
  const r = await pool.query('SELECT * FROM rasoi_recipes WHERE id = $1', [id]);
  if (!r.rows.length) return null;
  const recipe = r.rows[0];
  const ings = await pool.query(
    'SELECT name, qty, unit, note FROM rasoi_recipe_ingredients WHERE recipe_id = $1 ORDER BY id', [id]);
  const steps = await pool.query(
    'SELECT step_no, text FROM rasoi_recipe_steps WHERE recipe_id = $1 ORDER BY step_no', [id]);
  recipe.ingredients = ings.rows.map((x) => ({
    name: x.name, qty: x.qty == null ? null : Number(x.qty), unit: x.unit, note: x.note,
  }));
  recipe.steps = steps.rows;
  recipe.protein_g = Number(recipe.protein_g); recipe.carbs_g = Number(recipe.carbs_g);
  recipe.fat_g = Number(recipe.fat_g); recipe.calories = Number(recipe.calories);
  return recipe;
}

async function loadAllRecipes() {
  const r = await pool.query('SELECT id FROM rasoi_recipes ORDER BY name');
  const out = [];
  for (const row of r.rows) out.push(await loadRecipe(row.id));
  return out.filter(Boolean);
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// GET /api/households/:code/suggest?meal=&diet=&minProtein=&maxCalories=&maxCarbs=&servings=&heritage=
app.get('/api/households/:code/suggest', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const stock = (await pool.query(
      'SELECT name, qty FROM rasoi_stock WHERE household_id = $1', [hh.id])).rows;
    const servings = numOrNull(req.query.servings) || 4;
    const filters = {
      meal: (req.query.meal || 'any').toLowerCase(),
      diet: (req.query.diet || 'any').toLowerCase(),
      heritage: (req.query.heritage || '').toLowerCase(),
      minProtein: numOrNull(req.query.minProtein),
      maxCalories: numOrNull(req.query.maxCalories),
      maxCarbs: numOrNull(req.query.maxCarbs),
    };
    const recipes = applyFilters(await loadAllRecipes(), filters);
    const views = rankRecipes(recipes.map((r) => recipeView(r, stock, servings)));
    res.json({ servings, count: views.length, suggestions: views });
  } catch (e) { console.error(e); res.status(500).json({ error: 'suggest failed' }); }
});

// GET /api/households/:code/recipes/:id?servings=
app.get('/api/households/:code/recipes/:id', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const recipe = await loadRecipe(req.params.id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    const stock = (await pool.query(
      'SELECT name, qty FROM rasoi_stock WHERE household_id = $1', [hh.id])).rows;
    const servings = numOrNull(req.query.servings) || recipe.servings || 4;
    res.json(recipeView(recipe, stock, servings));
  } catch (e) { console.error(e); res.status(500).json({ error: 'lookup failed' }); }
});

// POST /api/households/:code/recipes/:id/cook — deduct used ingredients from
// stock (server-side matching so the whole family sees it live). Body:
// { member_id, servings }. Responds { used:[{name,qty,unit}], missing:[{name,qty,unit}] }.
app.post('/api/households/:code/recipes/:id/cook', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const recipe = await loadRecipe(req.params.id);
    if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
    const servings = Math.max(1, Math.min(24, Number(req.body.servings) || recipe.servings || 4));
    const factor = servings / Math.max(1, recipe.servings);
    const stock = (await pool.query(
      'SELECT * FROM rasoi_stock WHERE household_id = $1', [hh.id])).rows;
    const used = [], missing = [];
    for (const ing of recipe.ingredients) {
      const need = ing.qty == null ? null : Math.round(Number(ing.qty) * factor * 100) / 100;
      const match = stock.find((s) => Number(s.qty) > 0 && normalizeName(s.name) === normalizeName(ing.name));
      if (!match || need == null) { missing.push({ name: ing.name, qty: need, unit: ing.unit || '' }); continue; }
      const inStockUnit = convertQty(need, ing.unit, match.unit);
      if (inStockUnit == null) { missing.push({ name: ing.name, qty: need, unit: ing.unit || '' }); continue; }
      const deduct = Math.min(Number(match.qty), inStockUnit);
      if (deduct <= 0) { missing.push({ name: ing.name, qty: need, unit: ing.unit || '' }); continue; }
      const rows = (await pool.query(
        `UPDATE rasoi_stock SET qty = GREATEST(0, qty - $1), updated_by = $2, updated_at = now()
         WHERE id = $3 AND household_id = $4 RETURNING *`,
        [deduct, actor.id, match.id, hh.id]
      )).rows;
      if (rows.length) {
        const item = stockRow(rows[0]);
        match.qty = item.qty; // keep local copy fresh for later ingredients
        const action = item.qty === 0 ? 'used-up' : 'adjusted';
        broadcastStock(hh.join_code, action, item, actor, { delta: -deduct });
        used.push({ name: item.name, qty: Math.round(deduct * 100) / 100, unit: item.unit });
      }
      if (deduct < inStockUnit) missing.push({ name: ing.name, qty: Math.round((inStockUnit - deduct) * 100) / 100, unit: match.unit });
    }
    res.json({ servings, used, missing });
  } catch (e) { console.error(e); res.status(500).json({ error: 'cook failed' }); }
});

// ---- realtime ----
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const room = (code) => `hh:${normCode(code)}`;

// presence: join_code -> Map(socketId -> {memberId, name, avatar, avatar_kind})
const presence = new Map();

function emitPresence(code) {
  const c = normCode(code);
  const map = presence.get(c) || new Map();
  const members = [...map.values()];
  io.to(room(c)).emit('presence', { members });
}

function activityText(action, item, actor, extra) {
  const n = actor.name;
  const qty = (v) => (Number.isInteger(v) ? v : Number(v.toFixed(2)));
  switch (action) {
    case 'added': return `${n} added ${qty(extra.qty)} ${item.unit} ${item.name}`;
    case 'adjusted':
      return extra.delta < 0
        ? `${n} used ${qty(Math.abs(extra.delta))} ${item.unit} ${item.name}`
        : `${n} added ${qty(extra.delta)} ${item.unit} ${item.name}`;
    case 'used-up': return `${n} used up ${item.name} ✨`;
    case 'updated': return `${n} updated ${item.name}`;
    case 'removed': return `${n} removed ${item.name}`;
    default: return `${n} changed ${item.name}`;
  }
}

function broadcastStock(code, action, item, actor, extra) {
  const c = normCode(code);
  const payload = {
    action,
    item,
    actor: { id: actor.id, name: actor.name, avatar: actor.avatar, avatar_kind: actor.avatar_kind },
    at: new Date().toISOString(),
  };
  io.to(room(c)).emit('stock:changed', payload);
  io.to(room(c)).emit('activity', {
    text: activityText(action, item, actor, extra || {}),
    avatar: actor.avatar,
    avatar_kind: actor.avatar_kind,
    at: payload.at,
  });
}

io.on('connection', (socket) => {
  socket.on('join', async ({ code, memberId }) => {
    try {
      const c = normCode(code);
      const hh = await householdByCode(c);
      const member = hh && await memberById(hh.id, memberId);
      if (!hh || !member) { socket.emit('join:error', { error: 'Invalid household or member' }); return; }
      socket.join(room(c));
      socket.data.hhCode = c;
      if (!presence.has(c)) presence.set(c, new Map());
      presence.get(c).set(socket.id, {
        memberId: member.id, name: member.name, avatar: member.avatar, avatar_kind: member.avatar_kind,
      });
      socket.emit('join:ok', { code: c });
      emitPresence(c);
    } catch (e) { console.error(e); socket.emit('join:error', { error: 'join failed' }); }
  });

  socket.on('disconnect', () => {
    const c = socket.data.hhCode;
    if (c && presence.has(c)) {
      presence.get(c).delete(socket.id);
      emitPresence(c);
    }
  });
});

async function start() {
  await migrate();
  try {
    if ((await recipeCount(pool)) === 0) {
      const n = await seedRecipes(pool);
      console.log(`[rasoi] seeded ${n} recipes`);
    }
  } catch (e) { console.error('[rasoi] recipe seed failed:', e.message); }
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[rasoi] listening on :${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((e) => { console.error('[rasoi] failed to start:', e.message); process.exit(1); });
}

module.exports = { app, server, io, start, pool };
