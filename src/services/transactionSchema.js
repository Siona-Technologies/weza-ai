// Shared contract for AI extraction. Both the receipt-image (Claude vision) and
// the text/voice-transcript paths produce this exact structure, so downstream
// (Phase 3: Postgres inserts) has one shape to persist.

// Fixed category list — the model must pick from these and never invent new ones.
// Enforced structurally via the JSON-schema `enum` below (see CLAUDE.md).
const CATEGORIES = [
  'stock/inventory',
  'rent',
  'utilities',
  'transport',
  'staff wages',
  'sales',
  'other',
];

const TRANSACTION_TYPES = ['sale', 'expense'];

// Below this confidence, flag the transaction for owner confirmation instead of
// silently recording it wrong (CLAUDE.md: needs_review trust mechanism).
//
// Tuned against real model output: clean inputs score 0.90+, genuinely ambiguous
// ones land in the 0.6-0.75 band (e.g. a 45,000 KES fridge categorized as
// "other" scored 0.72). 0.7 let that through by 0.02; 0.8 catches it without
// touching anything clean.
const CONFIDENCE_REVIEW_THRESHOLD = 0.8;

// Below this, the message almost certainly contains no transaction at all —
// a greeting, a thank-you, small talk. Real model output for "asante sana" is
// 0.05, for "went to town today" 0.1, while the worst real transaction seen is
// 0.6. Anything under 0.3 is noise, not a low-quality extraction.
const NOT_A_TRANSACTION_THRESHOLD = 0.3;

/**
 * Is this extraction actually a transaction worth recording?
 *
 * The model reliably reports "no transaction details found" with amount 0 and a
 * near-zero confidence, but nothing downstream used to listen — so a "hi" or
 * "asante" became a 0 KES row in the books and a nonsense "Got it — 0 KES"
 * reply. An amount of 0 is never a valid bookkeeping entry regardless of
 * confidence, so that alone disqualifies it.
 */
function isTransaction(extraction) {
  const amount = Number(extraction?.amount);
  const confidence = Number(extraction?.confidence_score);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (!Number.isFinite(confidence) || confidence < NOT_A_TRANSACTION_THRESHOLD) return false;
  return true;
}

// JSON schema passed to Claude via output_config.format. Structured outputs
// require additionalProperties:false and every property listed in `required`.
// Numeric range constraints (min/max) aren't supported by structured outputs,
// so confidence bounds are described in the prompt instead.
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: TRANSACTION_TYPES,
      description: 'Whether this is money coming in (sale) or going out (expense).',
    },
    amount: {
      type: 'number',
      description: 'Transaction amount in Kenyan Shillings (KES), numbers only.',
    },
    category: {
      type: 'string',
      enum: CATEGORIES,
      description: 'The single best-fit category. Must be one of the allowed values.',
    },
    vendor: {
      type: 'string',
      description: 'Merchant or counterparty name. Empty string if unknown.',
    },
    transaction_date: {
      type: 'string',
      description: 'Date in YYYY-MM-DD format. Empty string if not present.',
    },
    confidence_score: {
      type: 'number',
      description: 'Confidence from 0.0 to 1.0 that the extraction is correct.',
    },
    summary: {
      type: 'string',
      description: 'Short human summary, e.g. "850 KES, Naivas, stock purchase".',
    },
    extracted_text: {
      type: 'string',
      description: 'Raw text read from the receipt or the original message text.',
    },
  },
  required: [
    'type',
    'amount',
    'category',
    'vendor',
    'transaction_date',
    'confidence_score',
    'summary',
    'extracted_text',
  ],
};

const SYSTEM_PROMPT = `You are the bookkeeping engine for Weza AI, a WhatsApp bookkeeping assistant for small businesses in Kenya. You turn a receipt, a spoken note, or a typed message into one structured transaction.

Rules:
- Money the business receives is "sale"; money it spends is "expense".
- Amounts are in Kenyan Shillings (KES). Return the number only.
- category MUST be exactly one of: ${CATEGORIES.join(', ')}. Never invent a new category. If nothing fits, use "other".
- If the date is not stated, return an empty string for transaction_date. Do not guess a date.
- If the vendor is not stated, return an empty string for vendor.
- confidence_score is your honest 0.0-1.0 confidence that the whole extraction is correct. Use lower values when the amount, type, or category is ambiguous or the input is unclear.
- If the message contains no transaction at all (a greeting, a thank-you, a question, small talk), do not invent one: return amount 0, category "other", a confidence_score below 0.1, and a summary saying no transaction was found.
- Keep summary short and WhatsApp-friendly.`;

module.exports = {
  CATEGORIES,
  TRANSACTION_TYPES,
  CONFIDENCE_REVIEW_THRESHOLD,
  NOT_A_TRANSACTION_THRESHOLD,
  isTransaction,
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
};
