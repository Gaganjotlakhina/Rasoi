// Kya Khaye server — realtime family kitchen stock + dish suggestions. Phase 3.
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
if (!DATABASE_URL) console.warn('[kyakhaye] WARNING: DATABASE_URL is not set');

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

app.get('/health', (req, res) => res.json({ ok: true, app: 'kyakhaye', phase: 3 }));

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
    const prevRow = (await pool.query(
      'SELECT qty FROM rasoi_stock WHERE id = $1 AND household_id = $2',
      [req.params.id, hh.id]
    )).rows[0];
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
    if (action === 'used-up' && prevRow) {
      const usedQty = Math.max(0, Number(prevRow.qty) - item.qty);
      if (usedQty > 0) await autoAddToBuy(hh, item.name, usedQty, item.unit, actor);
    }
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

// ---- to buy grocery list (Phase 3) ----
function tobuyRow(r) {
  return { id: r.id, name: r.name, qty: Number(r.qty), unit: r.unit, source: r.source,
           added_by: r.added_by, done: !!r.done, created_at: r.created_at };
}

function tobuyActivityText(action, item, actor) {
  const n = actor.name;
  switch (action) {
    case 'added': return item.source === 'auto'
      ? `🛒 ${item.name} ran out — added to To Buy`
      : `${n} added ${item.name} to To Buy 🛒`;
    case 'merged': return `🛒 more ${item.name} added to To Buy`;
    case 'updated': return item.done ? `${n} bought ${item.name} ✅` : `${n} put ${item.name} back on the list ↩️`;
    case 'removed': return `${n} removed ${item.name} from To Buy`;
    default: return `${n} updated the To Buy list`;
  }
}

function broadcastTobuy(code, action, item, actor) {
  const c = normCode(code);
  const at = new Date().toISOString();
  const actorSum = { id: actor.id, name: actor.name, avatar: actor.avatar, avatar_kind: actor.avatar_kind };
  io.to(room(c)).emit('tobuy:changed', { action, item, actor: actorSum, at });
  io.to(room(c)).emit('activity', {
    text: tobuyActivityText(action, item, actor),
    avatar: actor.avatar, avatar_kind: actor.avatar_kind, at,
  });
}

// Auto-add a depleted stock item to To Buy. Dedupe: an open row with the same
// name gets its qty bumped instead of creating a duplicate.
async function autoAddToBuy(hh, name, qty, unit, actor) {
  const clean = String(name).trim().slice(0, 60);
  if (!clean) return null;
  const bump = Math.round(Math.max(0, Number(qty) || 0) * 100) / 100;
  const existing = (await pool.query(
    `SELECT * FROM rasoi_tobuy WHERE household_id = $1 AND done = FALSE AND LOWER(TRIM(name)) = LOWER($2) ORDER BY created_at LIMIT 1`,
    [hh.id, clean]
  )).rows[0];
  if (existing) {
    const upd = (await pool.query(
      'UPDATE rasoi_tobuy SET qty = qty + $1 WHERE id = $2 RETURNING *',
      [bump, existing.id]
    )).rows[0];
    const item = tobuyRow(upd);
    broadcastTobuy(hh.join_code, 'merged', item, actor);
    return item;
  }
  const ins = (await pool.query(
    `INSERT INTO rasoi_tobuy (household_id, name, qty, unit, source, added_by)
     VALUES ($1, $2, $3, $4, 'auto', $5) RETURNING *`,
    [hh.id, clean, bump, cleanUnit(unit), actor.id]
  )).rows[0];
  const item = tobuyRow(ins);
  broadcastTobuy(hh.join_code, 'added', item, actor);
  return item;
}

app.get('/api/households/:code/tobuy', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const { rows } = await pool.query(
      'SELECT * FROM rasoi_tobuy WHERE household_id = $1 ORDER BY done ASC, created_at ASC',
      [hh.id]
    );
    res.json({ items: rows.map(tobuyRow) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'lookup failed' }); }
});

app.post('/api/households/:code/tobuy', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Item name is required' });
    const qty = Math.max(0, Math.min(1e6, Number(req.body.qty) || 1));
    const { rows } = await pool.query(
      `INSERT INTO rasoi_tobuy (household_id, name, qty, unit, source, added_by)
       VALUES ($1, $2, $3, $4, 'manual', $5) RETURNING *`,
      [hh.id, name, qty, cleanUnit(req.body.unit), actor.id]
    );
    const item = tobuyRow(rows[0]);
    broadcastTobuy(hh.join_code, 'added', item, actor);
    res.status(201).json(item);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not add item' }); }
});

app.patch('/api/households/:code/tobuy/:id', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const sets = [];
    const vals = [req.params.id];
    let i = 2;
    if (req.body.done !== undefined) { sets.push(`done = $${i++}`); vals.push(!!req.body.done); }
    if (req.body.qty !== undefined) { sets.push(`qty = $${i++}`); vals.push(Math.max(0, Math.min(1e6, Number(req.body.qty) || 0))); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(hh.id);
    const { rows } = await pool.query(
      `UPDATE rasoi_tobuy SET ${sets.join(', ')} WHERE id = $1 AND household_id = $${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = tobuyRow(rows[0]);
    broadcastTobuy(hh.join_code, 'updated', item, actor);
    res.json(item);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not update item' }); }
});

app.delete('/api/households/:code/tobuy/:id', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.query.member_id || req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const { rows } = await pool.query(
      'DELETE FROM rasoi_tobuy WHERE id = $1 AND household_id = $2 RETURNING *',
      [req.params.id, hh.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    broadcastTobuy(hh.join_code, 'removed', tobuyRow(rows[0]), actor);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not delete item' }); }
});

// ---- family voting (Phase 3) ----
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];

async function pollView(hh, pollId, myMemberId) {
  const p = (await pool.query(
    'SELECT * FROM rasoi_polls WHERE id = $1 AND household_id = $2', [pollId, hh.id]
  )).rows[0];
  if (!p) return null;
  const cands = (await pool.query(
    `SELECT r.id, r.name, r.diet, r.heritage FROM rasoi_poll_candidates c
     JOIN rasoi_recipes r ON r.id = c.recipe_id WHERE c.poll_id = $1`, [pollId]
  )).rows;
  const votes = (await pool.query(
    `SELECT v.recipe_id, v.member_id, v.voted_at, m.name, m.avatar, m.avatar_kind
     FROM rasoi_votes v JOIN rasoi_members m ON m.id = v.member_id
     WHERE v.poll_id = $1 ORDER BY v.voted_at`, [pollId]
  )).rows;
  const creator = p.created_by ? await memberById(hh.id, p.created_by) : null;
  const winner = p.winner_recipe_id
    ? (await pool.query('SELECT id, name FROM rasoi_recipes WHERE id = $1', [p.winner_recipe_id])).rows[0] || null
    : null;
  const totalMembers = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM rasoi_members WHERE household_id = $1', [hh.id]
  )).rows[0].n;
  return {
    id: p.id, meal_slot: p.meal_slot, status: p.status,
    created_by: creator ? { id: creator.id, name: creator.name, avatar: creator.avatar, avatar_kind: creator.avatar_kind } : null,
    created_at: p.created_at, closed_at: p.closed_at,
    candidates: cands.map((c) => {
      const cv = votes.filter((v) => v.recipe_id === c.id);
      return {
        id: c.id, name: c.name, diet: c.diet, heritage: c.heritage,
        votes: cv.length,
        voters: cv.map((v) => ({ member_id: v.member_id, name: v.name, avatar: v.avatar, avatar_kind: v.avatar_kind })),
        my_voted: myMemberId ? cv.some((v) => v.member_id === myMemberId) : false,
      };
    }),
    total_votes: votes.length, total_members: totalMembers,
    winner: winner ? { id: winner.id, name: winner.name } : null,
  };
}

function pollActivityText(action, poll, actor, extra) {
  const n = actor.name, slot = poll.meal_slot;
  if (action === 'created') return `🗳️ ${n} started a family vote for ${slot}!`;
  if (action === 'vote') return `🗳️ ${n} voted for ${extra && extra.recipe_name ? extra.recipe_name : 'a dish'}`;
  if (action === 'closed') return poll.winner ? `🎉 ${slot} is decided: ${poll.winner.name}!` : `🗳️ the ${slot} vote closed with no votes`;
  return `🗳️ vote updated`;
}

function broadcastPoll(code, action, poll, actor, extra) {
  const c = normCode(code);
  const at = new Date().toISOString();
  const actorSum = { id: actor.id, name: actor.name, avatar: actor.avatar, avatar_kind: actor.avatar_kind };
  io.to(room(c)).emit('poll:changed', { action, poll, actor: actorSum, at });
  io.to(room(c)).emit('activity', {
    text: pollActivityText(action, poll, actor, extra),
    avatar: actor.avatar, avatar_kind: actor.avatar_kind, at,
  });
}

app.post('/api/households/:code/polls', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const alreadyOpen = (await pool.query(
      "SELECT id FROM rasoi_polls WHERE household_id = $1 AND status = 'open' LIMIT 1", [hh.id]
    )).rows[0];
    if (alreadyOpen) return res.status(400).json({ error: 'Finish the current vote first' });
    const slot = MEAL_SLOTS.includes(String(req.body.meal_slot || '').toLowerCase())
      ? String(req.body.meal_slot).toLowerCase() : 'dinner';
    const ids = [...new Set((req.body.recipe_ids || []).filter(Boolean))].slice(0, 4);
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one dish' });
    const found = (await pool.query('SELECT id FROM rasoi_recipes WHERE id = ANY($1)', [ids])).rows;
    if (found.length !== ids.length) return res.status(400).json({ error: 'Unknown recipe' });
    const poll = (await pool.query(
      `INSERT INTO rasoi_polls (household_id, meal_slot, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [hh.id, slot, actor.id]
    )).rows[0];
    for (const rid of ids) {
      await pool.query('INSERT INTO rasoi_poll_candidates (poll_id, recipe_id) VALUES ($1, $2)', [poll.id, rid]);
    }
    const view = await pollView(hh, poll.id, actor.id);
    broadcastPoll(hh.join_code, 'created', view, actor);
    res.status(201).json(view);
  } catch (e) { console.error(e); res.status(500).json({ error: 'could not create poll' }); }
});

app.get('/api/households/:code/polls', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const myId = req.query.member_id || null;
    const openRow = (await pool.query(
      "SELECT id FROM rasoi_polls WHERE household_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1", [hh.id]
    )).rows[0];
    const histRows = (await pool.query(
      "SELECT id FROM rasoi_polls WHERE household_id = $1 AND status = 'closed' ORDER BY closed_at DESC LIMIT 10", [hh.id]
    )).rows;
    const open = openRow ? await pollView(hh, openRow.id, myId) : null;
    const history = [];
    for (const r of histRows) history.push(await pollView(hh, r.id, myId));
    res.json({ open, history });
  } catch (e) { console.error(e); res.status(500).json({ error: 'lookup failed' }); }
});

app.post('/api/households/:code/polls/:id/vote', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const poll = (await pool.query(
      'SELECT id, status FROM rasoi_polls WHERE id = $1 AND household_id = $2', [req.params.id, hh.id]
    )).rows[0];
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    if (poll.status !== 'open') return res.status(400).json({ error: 'This vote is closed' });
    const cand = (await pool.query(
      `SELECT r.name FROM rasoi_poll_candidates c JOIN rasoi_recipes r ON r.id = c.recipe_id
       WHERE c.poll_id = $1 AND c.recipe_id = $2`, [poll.id, req.body.recipe_id]
    )).rows[0];
    if (!cand) return res.status(400).json({ error: 'Pick one of the nominated dishes' });
    await pool.query(
      `INSERT INTO rasoi_votes (poll_id, member_id, recipe_id) VALUES ($1, $2, $3)
       ON CONFLICT (poll_id, member_id) DO UPDATE SET recipe_id = EXCLUDED.recipe_id, voted_at = now()`,
      [poll.id, actor.id, req.body.recipe_id]
    );
    const view = await pollView(hh, poll.id, actor.id);
    broadcastPoll(hh.join_code, 'vote', view, actor, { recipe_name: cand.name });
    res.json(view);
  } catch (e) { console.error(e); res.status(500).json({ error: 'vote failed' }); }
});

app.post('/api/households/:code/polls/:id/close', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const actor = await memberById(hh.id, req.body.member_id);
    if (!actor) return res.status(403).json({ error: 'Unknown member' });
    const poll = (await pool.query(
      'SELECT id, status FROM rasoi_polls WHERE id = $1 AND household_id = $2', [req.params.id, hh.id]
    )).rows[0];
    if (!poll) return res.status(404).json({ error: 'Poll not found' });
    if (poll.status !== 'open') return res.status(400).json({ error: 'Already closed' });
    // Winner: most votes; tie -> earliest vote wins.
    const win = (await pool.query(
      `SELECT recipe_id FROM rasoi_votes WHERE poll_id = $1
       GROUP BY recipe_id ORDER BY COUNT(*) DESC, MIN(voted_at) ASC LIMIT 1`, [poll.id]
    )).rows[0];
    await pool.query(
      `UPDATE rasoi_polls SET status = 'closed', winner_recipe_id = $2, closed_at = now() WHERE id = $1`,
      [poll.id, win ? win.recipe_id : null]
    );
    const view = await pollView(hh, poll.id, actor.id);
    broadcastPoll(hh.join_code, 'closed', view, actor);
    res.json(view);
  } catch (e) { console.error(e); res.status(500).json({ error: 'close failed' }); }
});

// GET /api/households/:code/recipes — light picker list (used when starting a vote)
app.get('/api/households/:code/recipes', async (req, res) => {
  try {
    const hh = await householdByCode(req.params.code);
    if (!hh) return res.status(404).json({ error: 'Household not found' });
    const { rows } = await pool.query(
      'SELECT id, name, diet, heritage, meal_types FROM rasoi_recipes ORDER BY heritage DESC, name ASC'
    );
    res.json({ recipes: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'lookup failed' }); }
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
        if (action === 'used-up' && deduct > 0) {
          await autoAddToBuy(hh, item.name, deduct, item.unit, actor);
        }
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
      console.log(`[kyakhaye] seeded ${n} recipes`);
    }
  } catch (e) { console.error('[kyakhaye] recipe seed failed:', e.message); }
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[kyakhaye] listening on :${PORT}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((e) => { console.error('[kyakhaye] failed to start:', e.message); process.exit(1); });
}

module.exports = { app, server, io, start, pool };
