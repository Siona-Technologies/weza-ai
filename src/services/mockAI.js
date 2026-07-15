// Mock AI for local testing without API keys. Enable with MOCK_AI=true in .env.
// Produces the same OUTPUT_SCHEMA shape as the real Claude/Whisper path using
// simple keyword heuristics, so you can exercise the whole pipeline for free.

const { CATEGORIES } = require('./transactionSchema');

const MOCK = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.MOCK_AI || '').toLowerCase(),
);

// Keyword -> fixed category. First match wins.
const CATEGORY_HINTS = [
  [/\brent\b/i, 'rent'],
  [/\b(electric|power|water|utility|utilities|kplc|token)\b/i, 'utilities'],
  [/\b(transport|fare|fuel|petrol|diesel|matatu|boda|uber)\b/i, 'transport'],
  [/\b(wage|wages|salary|salaries|staff|casual|worker)\b/i, 'staff wages'],
  [/\b(stock|inventory|goods|supplies|restock|purchase|bought|buy)\b/i, 'stock/inventory'],
  [/\b(sold|sale|sales|customer|revenue)\b/i, 'sales'],
];

function guessCategory(text) {
  for (const [re, cat] of CATEGORY_HINTS) {
    if (re.test(text)) return cat;
  }
  return 'other';
}

function guessType(text) {
  if (/\b(sold|sale|received|customer|revenue|paid me)\b/i.test(text)) return 'sale';
  return 'expense';
}

function guessAmount(text) {
  // Prefer a number attached to a currency word, then "for <n>", then the
  // largest number as a fallback. Naive on purpose — the real model is better.
  const currency = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:kes|ksh|sh|shillings?|bob|\/=|\/-)/i)
    || text.match(/(?:kes|ksh|sh|shillings?)\s*(\d[\d,]*(?:\.\d+)?)/i)
    || text.match(/\bfor\s+(\d[\d,]*(?:\.\d+)?)/i);
  if (currency) return Number(currency[1].replace(/,/g, ''));

  const nums = [...text.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)].map((x) => Number(x[1].replace(/,/g, '')));
  return nums.length ? Math.max(...nums) : 0;
}

function guessVendor(text) {
  const m = text.match(/\b(?:at|from|to)\s+([A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*)?)/);
  return m ? m[1].trim() : '';
}

function mockCategorize(text) {
  let category = guessCategory(text);
  const type = category === 'sales' ? 'sale' : guessType(text);
  // A sale with no better category is a sale.
  if (type === 'sale' && category === 'other') category = 'sales';
  const amount = guessAmount(text);
  const vendor = guessVendor(text);
  return {
    type,
    amount,
    category: CATEGORIES.includes(category) ? category : 'other',
    vendor,
    transaction_date: '',
    confidence_score: amount > 0 ? 0.88 : 0.4, // low confidence when no amount found
    summary: `${amount} KES ${vendor ? vendor + ' ' : ''}${category}`.trim(),
    extracted_text: text,
    _mock: true,
  };
}

// Canned receipt result (real vision needs the image + a key).
function mockReceipt() {
  return {
    type: 'expense',
    amount: 850,
    category: 'stock/inventory',
    vendor: 'Naivas',
    transaction_date: '',
    confidence_score: 0.91,
    summary: '850 KES Naivas stock/inventory',
    extracted_text: 'NAIVAS SUPERMARKET\nSugar 2kg  450\nCooking oil 400\nTOTAL 850',
    _mock: true,
  };
}

// Canned transcript (real transcription needs the audio + a key).
function mockTranscript() {
  return 'I sold ten loaves of bread for 500 shillings today';
}

module.exports = { MOCK, mockCategorize, mockReceipt, mockTranscript };
