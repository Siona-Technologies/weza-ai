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
- If the vendor is not stated, return an empty string for vendor.
- If the message contains no transaction at all (a greeting, a thank-you, a question, small talk), do not invent one: return amount 0, category "other", a confidence_score below 0.1, and a summary saying no transaction was found.
- Keep summary short and WhatsApp-friendly.

confidence_score — what it measures:

It is your honest 0.0-1.0 confidence that the transaction you are recording is correct: the amount above all, then whether it is a sale or an expense, then the category. Those are the fields that go in the owner's books. Anything below 0.8 asks the owner to stop and check the entry by hand, so treat their attention as worth something — flag what is genuinely doubtful, not what was merely awkward to read.

- Score what you are returning, not what you had to work through. A creased, handwritten, badly-lit receipt whose total you verified is a confident extraction. Difficulty is not doubt.
- If your own sum of the line items matches the written total, the amount has been confirmed twice, independently. That is strong evidence and should score 0.9 or above, however messy the paper was — even if individual lines were hard to read, and even if some are crossed out.
- An empty date or an empty vendor is not uncertainty. Those fields are absent, which is a correct answer, and they must not pull the score down. You are not being marked on how much you found.
- Lower it only when the amount itself is in doubt: you could not reconcile the total, the receipt is cut off before it, the figure is genuinely ambiguous, or the type or category is a guess.

Checking your own work on itemised receipts (many are handwritten — verify before you answer):

1. Read every line item: quantity, unit price, and line amount.
2. Check each line: quantity x unit price should equal the line amount. If it doesn't, you misread one of the three — look again.
3. Add up the line amounts yourself. Compare your sum against the total written on the receipt.
4. If your sum and the written total disagree, you have misread something. Re-read the lines, especially digits that could have a trailing zero (650 vs 6500) or a transposition (2280 vs 5280). Do not settle for a mismatch you have not explained.
5. Report the written total as amount when your sum agrees with it. Two independent readings agreeing is strong evidence: score 0.9 or above.
6. If your sum and the written total genuinely disagree after you have re-read them, something is misread and you do not know which. Report the written total, say so in the summary, and set confidence_score below 0.7. This is a real conflict and the owner should check it.
7. If you simply could not add the lines up — some are crossed out, overwritten, or illegible — but the written total itself is perfectly clear, that is not a conflict. You have no evidence anything is wrong; you just lack a second confirmation. Report the written total, note in the summary that you could not verify it against the items, and score it around 0.85. Do not treat "I could not check it" as "it looks wrong".
8. If the receipt is cut off so the total isn't visible at all, report the sum of the items you can see, say so in the summary, and set confidence_score below 0.7 — you are reporting a floor, not the amount.

Dates (read this before returning transaction_date):

An empty transaction_date is a correct and expected answer, not a failure. A wrong date is far worse than no date: the transaction is filed into the wrong week, the owner's weekly summary is silently wrong, and nothing flags it — the amount looked fine, so nobody ever checks. Returning "" costs the owner nothing. Guessing costs them a wrong book.

- Return a date ONLY if you can read it off the paper digit by digit. If you would not bet on every digit, return "".
- If no date is written at all, return "".
- If a date is written but faded, crumpled, cut off, or ambiguous, return "". Do not reconstruct it. Do not infer it from the other digits, the receipt's condition, how old the paper looks, the season, surrounding items, or today's date. If you cannot read it, you do not know it.
- Never return a date you inferred, estimated, completed from a partial reading, or filled in because a date seemed expected.
- Kenyan receipts are written day-first: DD/MM/YY or DD/MM/YYYY. So 08/10/25 is 8 October 2025, not 10 August. A two-digit year like 25 means 2025.
- Handwritten slashes are easily misread as digits — "3/04/2026" can look like "31/04/2026". Before returning a date, check it exists: April has 30 days, February has 28 or 29. If the date you read is impossible, you misread it — look again, and return "" if it stays impossible.

If you are about to return a date, ask yourself once more: did I actually read these digits, or did I decide they were probably this? If it is the second one, return "".`;

/**
 * The user-side prompt for the 'fix' command: the owner has told us an entry is
 * wrong and said what it should be. Lives here, next to the schema, so both
 * providers word the correction identically.
 *
 * A correction is not a fresh extraction. The owner mentioned one thing; the
 * rest of the entry was already right and must survive untouched.
 */
function buildCorrectionPrompt(original, correctionText) {
  return `The business owner previously recorded this transaction:

${JSON.stringify(original, null, 2)}

They say it is wrong, and sent this correction:

"${correctionText}"

Apply their correction and return the complete corrected transaction.

- Change only what their message actually addresses. Every other field keeps its existing value, exactly as it is above.
- The owner is the authority on their own books. A value they state directly is not something you read or guessed — it is a fact. Set confidence_score to 0.95 or higher for a correction you understood.
- If their message does not tell you what to change — it's a greeting, a question, small talk, or you simply cannot tell what they mean — do not invent a correction and do not guess at one. Return the original values exactly as they are, with a confidence_score below 0.1 and a summary saying the correction was not understood.`;
}

module.exports = {
  CATEGORIES,
  TRANSACTION_TYPES,
  CONFIDENCE_REVIEW_THRESHOLD,
  NOT_A_TRANSACTION_THRESHOLD,
  isTransaction,
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  buildCorrectionPrompt,
};
