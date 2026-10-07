# Kya Khaye — realtime family kitchen stock (repo: `rasoi`)

Phase 1+2 of the Kya Khaye family meal-planning app: one shared kitchen stock
list (Kitchen / Fridge / Freezer) that updates **live** on every family
member's phone the moment anyone changes anything.

## How it works

1. **Create a household** — name it, get a 6-letter invite code.
2. **Join + onboard** — each person enters their name and picks an avatar:
   an emoji, or a quick selfie (downscaled to 256px in the browser, stored
   as a data URL — no external storage).
3. **Manage stock** — add/edit/delete items, tap −/+ steppers, or "Use up".
4. **Live sync** — Socket.io rooms per household: every change broadcasts
   instantly, with online presence chips and activity toasts
   ("Gaganjot used 2 eggs 🥚").
5. **Voice input** — 🎤 mic button on the add-stock screen uses the browser's
   free Web Speech API. Speak a list ("two kilos of atta, a dozen eggs"),
   check the editable chips, confirm — items are added and broadcast live.

## Run locally

```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/whattoeat
npm start            # http://localhost:3000
npm test             # voice parser unit tests + API/Socket.io smoke test
```

Migrations run automatically at startup from `schema.sql` (idempotent).
All tables are prefixed `rasoi_` so this can share a Postgres instance.

## Deploy (Render, free tier)

`render.yaml` + `Dockerfile` are ready. One-time dashboard steps:

1. Render dashboard → **New → Blueprint**
2. Select the **`rasoi`** repo (`Gaganjotlakhina/rasoi`)
3. When prompted for `DATABASE_URL`, paste the **External Database URL**
   of the existing 1v1 app's Postgres
   (Render dashboard → that database → Connections). Kya Khaye's `rasoi_`-prefixed
   tables will not clash with the 1v1 tables.
4. Apply — every push to `main` redeploys automatically.

Note: the free web plan sleeps after ~15 min idle (first visit after idle
takes ~30–60s to wake; stock data is safe). Upgrade to Starter for always-on.

## Data model

- `rasoi_households` — id, name, join_code (unique 6-char)
- `rasoi_members` — id, household_id, name, avatar (emoji or data URL), avatar_kind
- `rasoi_stock` — id, household_id, name, qty, unit, location
  (kitchen/fridge/freezer), updated_by, updated_at
- `rasoi_recipes`, `rasoi_recipe_ingredients`, `rasoi_recipe_steps` —
  **Phase 2 tables, created empty and ready.** Recipes carry a `heritage`
  tag (`punjabi-classic` for traditional Punjabi home recipes —
  sarson da saag, dal makhani, rajma chawal, dals, saags, tandoori rotis,
  lassi, …) plus an optional `health_note`, per-serving macros, meal types
  and diet flags.

## API (Phase 2 additions)

- `GET /api/households/:code/suggest?meal=&diet=&minProtein=&maxCalories=&maxCarbs=&servings=&heritage=`
  ranked dish ideas scored by % of ingredients in the household's stock.
  Diet filter is hierarchical: `vegan` < `veg` < `egg` < `nonveg` (a `veg`
  filter also shows vegan dishes). `heritage=punjabi-classic` returns only
  the Back home classics shelf.
- `GET /api/households/:code/recipes/:id?servings=` — full recipe detail
  with scaled ingredients, in-stock flags, and missing list.
- `POST /api/households/:code/recipes/:id/cook` `{member_id, servings}` —
  deducts used ingredients from stock (unit-aware, floors at 0) and
  broadcasts to the family live. Returns `{used, missing}`.

Recipes auto-seed on first boot (`seed.js`, idempotent by name).

## API (Phase 4 additions)

- `POST /api/households/:code/scan` `{member_id, image}` — `image` is a
  JPEG/PNG data URL (client downscales to max 1600px). Runs tesseract OCR
  server-side (`oem 1 -psm 6 -l eng`) and parses the text into candidate
  items `[{name, qty, unit}]` for the user to confirm. Returns 400 on a
  missing/invalid image, 403 on an unknown member, 503 when the tesseract
  binary isn't installed (the Docker image installs `tesseract-ocr` +
  `tesseract-ocr-data-eng`; local dev may not have it). OCR can take
  10–30s on the free tier — the request simply takes its time.
- `parse-receipt.js` — receipt/grocery-list text parser (shared by the
  server and tests): drops totals/tax/tender/change/store furniture lines,
  handles `2 x` / `x2` / `2X` / `2 @` quantities and kg/g/L/ml/pack/pcs
  units. Best-effort by design — the app always shows editable chips for
  confirm/correct before anything reaches stock.

## Roadmap

- **Phase 2**: ✅ dish suggestions matched to stock, heritage Punjabi recipe
  collection (28 recipes), macro filters, servings scaler, cook-deducts-stock.
- **Phase 3**: ✅ To Buy list (manual + auto-add on depletion), family voting on meals.
- **Phase 4**: ✅ photo snapshot — scan a grocery list or store receipt into stock.
