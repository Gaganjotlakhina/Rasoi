/* WhatToEat voice-list parser — shared between browser and node tests.
 * Turns a spoken grocery list like "two kilos of atta, half kilo paneer,
 * a dozen eggs" into [{name, qty, unit}]. Forgiving by design: the UI always
 * shows editable chips for confirm/correct before anything is added. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.WhatToEatVoice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NUM_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    dozen: 12, half: 0.5, quarter: 0.25, couple: 2, few: 3,
  };

  var UNIT_WORDS = {
    kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', kg: 'kg',
    gram: 'g', grams: 'g', g: 'g',
    litre: 'L', litres: 'L', liter: 'L', liters: 'L', l: 'L', ml: 'ml',
    piece: 'pcs', pieces: 'pcs', pcs: 'pcs',
    packet: 'packets', packets: 'packets',
    bunch: 'bunches', bunches: 'bunches',
    cup: 'cups', cups: 'cups',
    tbsp: 'tbsp', 'table spoon': 'tbsp', 'tablespoon': 'tbsp',
    tsp: 'tsp', 'tea spoon': 'tsp', 'teaspoon': 'tsp',
  };

  function parseSegment(seg) {
    var tokens = seg.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;

    var qty = 1, unit = 'pcs', i = 0;

    // quantity: digit ("2"), word ("two"), or word+dozen ("a dozen")
    var firstNum = parseFloat(tokens[0]);
    if (!isNaN(firstNum) && isFinite(firstNum)) {
      qty = firstNum; i = 1;
    } else if (tokens[0] in NUM_WORDS) {
      if (tokens[1] === 'dozen') { qty = NUM_WORDS[tokens[0]] * 12; i = 2; }
      else { qty = NUM_WORDS[tokens[0]]; i = 1; }
    } else if (tokens[0] === 'dozen') {
      qty = 12; i = 1;
    }

    // unit word (two-word units like "table spoon" handled by join check)
    var twoWord = tokens[i] + ' ' + (tokens[i + 1] || '');
    if (twoWord in UNIT_WORDS) { unit = UNIT_WORDS[twoWord]; i += 2; }
    else if (tokens[i] in UNIT_WORDS) { unit = UNIT_WORDS[tokens[i]]; i += 1; }

    // strip filler "of"
    if (tokens[i] === 'of') i += 1;

    var name = tokens.slice(i).join(' ').trim();
    if (!name) return null;
    return { name: name, qty: Math.round(qty * 100) / 100, unit: unit };
  }

  function parseVoiceList(transcript) {
    if (!transcript || !transcript.trim()) return [];
    return transcript
      .split(/,|;|\band\b/)
      .map(parseSegment)
      .filter(Boolean);
  }

  return { parseVoiceList: parseVoiceList, NUM_WORDS: NUM_WORDS, UNIT_WORDS: UNIT_WORDS };
});
