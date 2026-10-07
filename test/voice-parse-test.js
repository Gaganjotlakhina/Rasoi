// Unit tests for the Kya Khaye voice-list parser. No DB needed.
// Run: node test/voice-parse-test.js
const { parseVoiceList } = require('../public/voice-parse.js');

let failures = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}

eq('classic list', parseVoiceList('two kilos of atta, half kilo paneer, a dozen eggs'), [
  { name: 'atta', qty: 2, unit: 'kg' },
  { name: 'paneer', qty: 0.5, unit: 'kg' },
  { name: 'eggs', qty: 12, unit: 'pcs' },
]);
eq('bare item defaults to 1 pcs', parseVoiceList('milk'), [{ name: 'milk', qty: 1, unit: 'pcs' }]);
eq('digits + packets/bunches + "and"', parseVoiceList('3 packets of maggi and 2 bunches of dhaniya'), [
  { name: 'maggi', qty: 3, unit: 'packets' },
  { name: 'dhaniya', qty: 2, unit: 'bunches' },
]);
eq('litres', parseVoiceList('one litre milk'), [{ name: 'milk', qty: 1, unit: 'L' }]);
eq('grams', parseVoiceList('250 grams besan'), [{ name: 'besan', qty: 250, unit: 'g' }]);
eq('empty string', parseVoiceList(''), []);
eq('whitespace only', parseVoiceList('   '), []);
eq('dozen without article', parseVoiceList('dozen bananas'), [{ name: 'bananas', qty: 12, unit: 'pcs' }]);
eq('multi-word item name kept', parseVoiceList('two kilos of whole wheat atta'), [{ name: 'whole wheat atta', qty: 2, unit: 'kg' }]);

console.log(failures === 0 ? '\n✅ VOICE PARSER TESTS PASSED' : `\n❌ ${failures} PARSER TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
