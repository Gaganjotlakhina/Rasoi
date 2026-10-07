-- Rasoi schema. All tables prefixed rasoi_ so this can share a Postgres
-- instance with other apps. Safe to run repeatedly (IF NOT EXISTS).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS rasoi_households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  join_code CHAR(6) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rasoi_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES rasoi_households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🍳',
  avatar_kind TEXT NOT NULL DEFAULT 'emoji' CHECK (avatar_kind IN ('emoji', 'photo')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rasoi_members_household_idx ON rasoi_members(household_id);

CREATE TABLE IF NOT EXISTS rasoi_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES rasoi_households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qty NUMERIC NOT NULL DEFAULT 0 CHECK (qty >= 0),
  unit TEXT NOT NULL DEFAULT 'pcs',
  location TEXT NOT NULL CHECK (location IN ('kitchen', 'fridge', 'freezer')),
  updated_by UUID REFERENCES rasoi_members(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rasoi_stock_household_idx ON rasoi_stock(household_id);

-- ---------------------------------------------------------------------------
-- Phase 2 (recipes) — tables created now so the data model is ready.
-- Product direction: the collection leans into Punjabi/Sikh heritage.
-- Traditional home recipes (sarson da saag, dal makhani, rajma chawal,
-- dals, saags, tandoori rotis, lassi, ...) carry heritage='punjabi-classic'
-- and an optional health_note framing them as wholesome heritage food.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rasoi_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  heritage TEXT NOT NULL DEFAULT '' CHECK (heritage IN ('', 'punjabi-classic')),
  health_note TEXT NOT NULL DEFAULT '',
  meal_types TEXT[] NOT NULL DEFAULT '{}', -- e.g. {breakfast,lunch,dinner,snack}
  diet TEXT NOT NULL DEFAULT 'veg' CHECK (diet IN ('veg', 'nonveg', 'egg', 'vegan')),
  servings INT NOT NULL DEFAULT 4,
  prep_minutes INT NOT NULL DEFAULT 20,
  protein_g NUMERIC NOT NULL DEFAULT 0,
  carbs_g NUMERIC NOT NULL DEFAULT 0,
  fat_g NUMERIC NOT NULL DEFAULT 0,
  calories NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rasoi_recipes_heritage_idx ON rasoi_recipes(heritage);

CREATE TABLE IF NOT EXISTS rasoi_recipe_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES rasoi_recipes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qty NUMERIC,
  unit TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS rasoi_recipe_ingredients_recipe_idx ON rasoi_recipe_ingredients(recipe_id);

CREATE TABLE IF NOT EXISTS rasoi_recipe_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES rasoi_recipes(id) ON DELETE CASCADE,
  step_no INT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rasoi_recipe_steps_recipe_idx ON rasoi_recipe_steps(recipe_id);
