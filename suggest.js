// Kya Khaye suggestion engine — ingredient normalization + match scoring.
// Shared by server.js and the tests (no DB dependency here).
'use strict';

// Hindi/Punjabi + plural aliases -> canonical ingredient names.
const ALIASES = {
  'atta': 'whole wheat flour', 'whole wheat flour': 'whole wheat flour', 'wheat flour': 'whole wheat flour',
  'dahi': 'yogurt', 'curd': 'yogurt', 'yoghurt': 'yogurt', 'yogurt': 'yogurt',
  'besan': 'gram flour', 'gram flour': 'gram flour', 'chickpea flour': 'gram flour',
  'sarson': 'mustard greens', 'mustard greens': 'mustard greens', 'sarson da saag': 'mustard greens',
  'palak': 'spinach', 'spinach': 'spinach',
  'aloo': 'potato', 'potatoes': 'potato', 'potato': 'potato',
  'pyaaz': 'onion', 'onions': 'onion', 'onion': 'onion',
  'tamatar': 'tomato', 'tomatoes': 'tomato', 'tomato': 'tomato',
  'adrak': 'ginger', 'ginger': 'ginger',
  'lehsun': 'garlic', 'garlic': 'garlic',
  'hari mirch': 'green chili', 'green chili': 'green chili', 'green chillies': 'green chili', 'green chilies': 'green chili',
  'dhania': 'coriander leaves', 'coriander leaves': 'coriander leaves', 'cilantro': 'coriander leaves', 'hara dhania': 'coriander leaves',
  'dhaniya powder': 'coriander powder', 'coriander powder': 'coriander powder', 'dhania powder': 'coriander powder',
  'jeera': 'cumin seeds', 'cumin seeds': 'cumin seeds', 'zeera': 'cumin seeds',
  'haldi': 'turmeric', 'turmeric': 'turmeric',
  'lal mirch': 'red chili powder', 'red chili powder': 'red chili powder', 'red chilli powder': 'red chili powder',
  'mirchi': 'red chili powder',
  'garam masala': 'garam masala',
  'ghee': 'ghee', 'desi ghee': 'ghee',
  'tel': 'oil', 'oil': 'oil', 'sarson oil': 'mustard oil', 'mustard oil': 'mustard oil',
  'namak': 'salt', 'salt': 'salt',
  'cheeni': 'sugar', 'sugar': 'sugar', 'shakkar': 'sugar',
  'doodh': 'milk', 'milk': 'milk',
  'paneer': 'paneer',
  'anda': 'egg', 'ande': 'egg', 'eggs': 'egg', 'egg': 'egg',
  'chawal': 'rice', 'rice': 'rice', 'basmati': 'rice', 'basmati rice': 'rice',
  'rajma': 'kidney beans', 'kidney beans': 'kidney beans',
  'chole': 'chickpeas', 'chickpeas': 'chickpeas', 'kabuli chana': 'chickpeas', 'chana': 'chickpeas',
  'kala chana': 'black chickpeas', 'black chickpeas': 'black chickpeas', 'kale chane': 'black chickpeas',
  'urad dal': 'black lentils', 'black lentils': 'black lentils', 'kali dal': 'black lentils', 'urad': 'black lentils',
  'arhar dal': 'pigeon pea lentils', 'toor dal': 'pigeon pea lentils', 'pigeon pea lentils': 'pigeon pea lentils',
  'moong dal': 'moong lentils', 'moong lentils': 'moong lentils', 'dhuli moong': 'moong lentils',
  'masoor dal': 'red lentils', 'red lentils': 'red lentils',
  'baingan': 'eggplant', 'eggplant': 'eggplant', 'brinjal': 'eggplant',
  'gobhi': 'cauliflower', 'cauliflower': 'cauliflower', 'phool gobhi': 'cauliflower',
  'gajar': 'carrot', 'gajjar': 'carrot', 'carrots': 'carrot', 'carrot': 'carrot',
  'matar': 'peas', 'peas': 'peas', 'green peas': 'peas',
  'shimla mirch': 'capsicum', 'capsicum': 'capsicum', 'bell pepper': 'capsicum',
  'makki atta': 'corn flour', 'corn flour': 'corn flour', 'maize flour': 'corn flour', 'makki ka atta': 'corn flour',
  'maida': 'all-purpose flour', 'all-purpose flour': 'all-purpose flour',
  'suji': 'semolina', 'sooji': 'semolina', 'rava': 'semolina', 'semolina': 'semolina',
  'oats': 'oats', 'bread': 'bread', 'pasta': 'pasta',
  'chicken': 'chicken', 'murgh': 'chicken',
  'fish': 'fish', 'machhi': 'fish',
  'cream': 'cream', 'malai': 'cream',
  'butter': 'butter', 'makhan': 'butter', 'white butter': 'butter',
  'kasuri methi': 'dried fenugreek', 'dried fenugreek': 'dried fenugreek',
  'methi': 'fenugreek leaves', 'fenugreek leaves': 'fenugreek leaves',
  'bajra': 'pearl millet', 'pearl millet': 'pearl millet',
  'imli': 'tamarind', 'tamarind': 'tamarind',
  'nimbu': 'lemon', 'lemon': 'lemon', 'neembu': 'lemon',
  'ajwain': 'carom seeds', 'carom seeds': 'carom seeds',
  'rai': 'mustard seeds', 'mustard seeds': 'mustard seeds',
  'elaichi': 'cardamom', 'cardamom': 'cardamom',
  'laung': 'cloves', 'cloves': 'cloves', 'dalchini': 'cinnamon', 'cinnamon': 'cinnamon',
  'hing': 'asafoetida', 'asafoetida': 'asafoetida',
  'chaat masala': 'chaat masala', 'tandoori masala': 'tandoori masala',
  'soy sauce': 'soy sauce', 'olive oil': 'olive oil', 'honey': 'honey',
  'banana': 'banana', 'basil': 'basil', 'mint leaves': 'mint leaves', 'mint': 'mint leaves',
  'spring onion': 'spring onion', 'spring onions': 'spring onion', 'hari pyaaz': 'spring onion',
  'curry leaves': 'curry leaves', 'kadi patta': 'curry leaves',
  'mixed nuts': 'mixed nuts', 'nuts': 'mixed nuts', 'badam': 'almonds', 'almonds': 'almonds',
  'tamarind chutney': 'tamarind chutney',
  'red chili flakes': 'red chili flakes',
};

function normalizeName(raw) {
  let s = String(raw || '').toLowerCase().trim();
  s = s.replace(/\([^)]*\)/g, '').trim();           // drop (notes)
  s = s.replace(/^(fresh|dried|ground|powdered)\s+/, '');
  if (ALIASES[s]) return ALIASES[s];
  // naive de-pluralize
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 3 && s.endsWith('ses')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return ALIASES[s] || s;
}

// diet hierarchy: vegan < veg < egg < nonveg. Filter shows that level and below.
const DIET_LEVEL = { vegan: 0, veg: 1, egg: 2, nonveg: 3 };
function dietPasses(recipeDiet, filterDiet) {
  if (!filterDiet || filterDiet === 'any') return true;
  const r = DIET_LEVEL[recipeDiet];
  const f = DIET_LEVEL[filterDiet];
  if (r === undefined || f === undefined) return true;
  return r <= f;
}

function scaleQty(qty, recipeServings, servings) {
  if (qty == null) return null;
  const factor = servings / Math.max(1, recipeServings);
  const v = Number(qty) * factor;
  return Math.round(v * 100) / 100;
}

// Simple unit conversion for cook-deduct. Returns null when incompatible.
const UNIT_BASE = { g: ['g', 1], kg: ['g', 1000], mg: ['g', 0.001], ml: ['ml', 1], L: ['ml', 1000], l: ['ml', 1000] };
const SPOON_ML = { tsp: 5, tbsp: 15, cups: 240, cup: 240 };
function convertQty(qty, fromUnit, toUnit) {
  const f = String(fromUnit || '').trim(), t = String(toUnit || '').trim();
  if (!f || !t) return qty; // unitless — assume comparable
  if (f === t) return qty;
  const fb = UNIT_BASE[f], tb = UNIT_BASE[t];
  if (fb && tb && fb[0] === tb[0]) return (qty * fb[1]) / tb[1];
  const fm = SPOON_ML[f.toLowerCase()], tm = SPOON_ML[t.toLowerCase()];
  if (fm && tm) return (qty * fm) / tm;
  return null;
}

// Score one recipe against a household's stock.
// stock: [{name, qty}]. Returns {haveCount, totalCount, missing:[{name,qty,unit}]}.
function scoreRecipe(recipe, stock, servings) {
  const have = new Set();
  for (const s of stock) {
    if (Number(s.qty) > 0) have.add(normalizeName(s.name));
  }
  const missing = [];
  let haveCount = 0;
  for (const ing of recipe.ingredients) {
    if (have.has(normalizeName(ing.name))) haveCount++;
    else missing.push({ name: ing.name, qty: scaleQty(ing.qty, recipe.servings, servings), unit: ing.unit || '' });
  }
  const totalCount = recipe.ingredients.length;
  return {
    haveCount, totalCount, missing,
    matchPct: totalCount ? Math.round((haveCount / totalCount) * 100) : 0,
  };
}

function recipeView(recipe, stock, servings) {
  const s = scoreRecipe(recipe, stock, servings);
  return {
    id: recipe.id, name: recipe.name, description: recipe.description,
    heritage: recipe.heritage, health_note: recipe.health_note,
    meal_types: recipe.meal_types, diet: recipe.diet,
    servings, base_servings: recipe.servings, prep_minutes: recipe.prep_minutes,
    macros: {
      protein_g: Number(recipe.protein_g), carbs_g: Number(recipe.carbs_g),
      fat_g: Number(recipe.fat_g), calories: Number(recipe.calories),
    },
    ingredients: recipe.ingredients.map((ing) => ({
      name: ing.name, note: ing.note || '',
      qty: scaleQty(ing.qty, recipe.servings, servings), unit: ing.unit || '',
      in_stock: stock.some((x) => Number(x.qty) > 0 && normalizeName(x.name) === normalizeName(ing.name)),
    })),
    steps: recipe.steps.slice().sort((a, b) => a.step_no - b.step_no).map((x) => x.text),
    haveCount: s.haveCount, totalCount: s.totalCount,
    matchPct: s.matchPct, missing: s.missing,
  };
}

// Rank recipes: match% desc, then fewer missing, then higher protein.
function rankRecipes(views) {
  return views.slice().sort((a, b) =>
    b.matchPct - a.matchPct ||
    a.missing.length - b.missing.length ||
    b.macros.protein_g - a.macros.protein_g
  );
}

function applyFilters(recipes, f) {
  return recipes.filter((r) => {
    if (f.meal && f.meal !== 'any' && !r.meal_types.includes(f.meal)) return false;
    if (!dietPasses(r.diet, f.diet)) return false;
    if (f.heritage && r.heritage !== f.heritage) return false;
    if (f.minProtein != null && Number(r.protein_g) < f.minProtein) return false;
    if (f.maxCalories != null && Number(r.calories) > f.maxCalories) return false;
    if (f.maxCarbs != null && Number(r.carbs_g) > f.maxCarbs) return false;
    return true;
  });
}

module.exports = {
  normalizeName, dietPasses, scaleQty, convertQty,
  scoreRecipe, recipeView, rankRecipes, applyFilters, DIET_LEVEL,
};
