// Kya Khaye receipt / grocery-list parser.
// Turns OCR text from a supermarket receipt (e.g. Walmart bill) or a
// handwritten grocery list into candidate stock items: [{name, qty, unit}].
// Forgiving by design: the UI always shows editable chips for confirm/correct
// before anything is added. Favors recall over precision, but never emits
// empty names. Shared by the server and the node tests.
'use strict';

const UNIT_ALIASES = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg',
  g: 'g', gram: 'g', grams: 'g',
  l: 'L', litre: 'L', litres: 'L', liter: 'L', liters: 'L', ml: 'ml',
  pcs: 'pcs', pc: 'pcs', piece: 'pcs', pieces: 'pcs',
  pack: 'packets', packs: 'packets', packet: 'packets', packets: 'packets', pk: 'packets',
  bunch: 'bunches', bunches: 'bunches',
  dozen: 'dozen', doz: 'dozen',
  ct: 'pcs', count: 'pcs',
  oz: 'oz', lb: 'lb', lbs: 'lb',
};

// Receipt furniture that is never a grocery item: totals, taxes, payment,
// store headers/footers. Matched as whole words so item names survive.
const STRONG_JUNK = /\b(sub\s*-?\s*total|grand\s*total|total\s*savings|\bsave\b|\bsavings\b|\btax\b|hst|gst|pst|qst|\btender\b|change\s*due|\bbalance\b|amount\s*due|amount\s*tendered|\bpayment\b|\bvisa\b|master\s*card|mastercard|\bamex\b|\bdebit\b|credit\s*card|\bcash\b|thank\s*you|\bcashier\b|\btransaction\b|\binvoice\b|receipt\s*#|\border\s*#|\bcustomer\b|reprint|duplicate|original|\bcopy\b|signature|\bcoupon\b|\bflyer\b|supercent(er|re)|walmart|costco|loblaws|nofrills|freshco|sobeys|metro\b|tel\b|\bphone\b|\baddress\b|\boperator\b|\bregister\b|\blane\b|\bmanager\b|\bassociate\b|\bdept\b)\b/i;

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, half: 0.5, couple: 2,
};

function titleCase(s) {
  return s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function cleanName(s) {
  let name = String(s || '').replace(/[#*]+/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(/^[-–—:;,.]+|[-–—:;,.]+$/g, '').trim();
  if (name.length > 60) name = name.slice(0, 60).trim();
  if (!/[a-zA-Z]/.test(name)) return '';
  if (STRONG_JUNK.test(name)) return '';
  return titleCase(name);
}

function parseLine(raw) {
  let line = String(raw || '').trim();
  if (line.length < 2) return null;
  if (!/[a-zA-Z]/.test(line)) return null; // pure numbers / separators
  if (STRONG_JUNK.test(line)) return null;
  if (/^\s*(sub\s*-?\s*total|total)\b/i.test(line)) return null;

  // Receipt multi-qty before the trailing price is stripped:
  // "BANANAS 2 @ 0.30" -> qty 2, remainder "BANANAS"
  let qty = null;
  let unit = 'pcs';
  let m = line.match(/(\d+(?:\.\d+)?)\s*@\s*\$?\d/);
  if (m) {
    qty = parseFloat(m[1]);
    line = line.replace(/\s*\d+(?:\.\d+)?\s*@\s*\$?[\d.,]+\s*/, ' ').replace(/\s+/g, ' ').trim();
  }

  // Trailing price: "MILK 2L 4.97", "$12.34", "4.97 F"
  line = line.replace(/\s*\$?\d{1,4}[.,]\d{2}\s*[A-Za-z]?\s*$/, '').trim();

  // "2 x milk" / "2X eggs"
  m = line.match(/^(\d+(?:\.\d+)?)\s*[xX×]\s+/);
  if (m) { qty = parseFloat(m[1]); line = line.slice(m[0].length).trim(); }
  else {
    // "x2 milk"
    m = line.match(/^[xX×]\s*(\d+(?:\.\d+)?)\b/);
    if (m) { qty = parseFloat(m[1]); line = line.slice(m[0].length).trim(); }
  }

  // Leading-number qty: "12 eggs", "2 milk" — plus number words: "a dozen bananas"
  if (qty === null) {
    m = line.match(/^(\d+(?:\.\d+)?)\b\s*/);
    if (m) { qty = parseFloat(m[1]); line = line.slice(m[0].length).trim(); }
    else {
      m = line.match(/^([a-z]+)\s+(dozen)\b/i);
      if (m && NUM_WORDS[m[1].toLowerCase()] !== undefined) {
        qty = NUM_WORDS[m[1].toLowerCase()] * 12;
        line = line.slice(m[0].length).trim();
      } else {
        m = line.match(/^([a-z]+)\b/i);
        if (m && NUM_WORDS[m[1].toLowerCase()] !== undefined) {
          qty = NUM_WORDS[m[1].toLowerCase()];
          line = line.slice(m[0].length).trim();
        }
      }
    }
  }

  // Attached number+unit: "5kg", "500 g", "2L", "12CT", "2PK" (sets qty too when none yet)
  m = line.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|ct|pk)\b/i);
  if (m && UNIT_ALIASES[m[2].toLowerCase()]) {
    unit = UNIT_ALIASES[m[2].toLowerCase()];
    if (qty === null) qty = parseFloat(m[1]);
    line = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  }

  // Bare unit words: "kilos", "packets", "bunch", "dozen"
  m = line.match(/\b(kgs?|ml|kilos?|grams?|litres?|liters?|pcs?|pieces?|packs?|packets?|bunch(?:es)?|dozens?|doz|count|oz|lbs?)\b/i);
  if (m && UNIT_ALIASES[m[1].toLowerCase()]) {
    unit = UNIT_ALIASES[m[1].toLowerCase()];
    line = (line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  }

  // Leading SKUs / long digit runs
  line = line.replace(/^\d{5,}[\s\-]*/, '').replace(/^#\s*\d+[\s\-]*/, '').trim();

  const name = cleanName(line);
  if (!name) return null;
  let finalQty = qty === null ? 1 : Math.round(qty * 100) / 100;
  let finalUnit = unit;
  if (finalUnit === 'dozen') { finalQty = Math.round(finalQty * 12 * 100) / 100; finalUnit = 'pcs'; }
  return { name, qty: finalQty, unit: finalUnit };
}

function parseReceiptText(text) {
  if (!text || !String(text).trim()) return [];
  return String(text).split(/\r?\n/).map(parseLine).filter(Boolean);
}

module.exports = { parseReceiptText, parseLine };
