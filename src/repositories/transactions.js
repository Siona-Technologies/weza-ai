// Persist one extracted transaction. The full AI output is stored in the
// raw_extraction JSONB column so nothing from the model is lost, and
// confidence_score / needs_review carry the trust signal (CLAUDE.md).

const { getPool } = require('../db/pool');

// A date the model misread can be impossible ("2026-04-31" — April has 30 days).
// Postgres rejects it with "date/time field value out of range", which the
// caller's catch would swallow: the owner is told "Got it" while nothing is
// saved. A bad date must not cost us the whole transaction, so drop just the
// date and keep the row. The raw value survives in raw_extraction either way.
function toDateOrNull(value) {
  if (!value || !String(value).trim()) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) return null;

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Date rolls impossible values over (Apr 31 -> May 1), so a round-trip that
  // doesn't come back identical means the input wasn't a real calendar date.
  const isReal = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;

  if (!isReal) {
    console.warn(`[transactions] dropping impossible transaction_date "${value}"`);
    return null;
  }
  return value; // 'YYYY-MM-DD' string; Postgres casts to DATE
}

// Has this message already been turned into a transaction? Lets the webhook skip
// a redundant (and slow, and paid-for) AI call when a message arrives twice.
// This is the cheap check; the UNIQUE index is the actual guarantee.
async function findByMessageSid(messageSid) {
  if (!messageSid) return null;
  const res = await getPool().query(
    'SELECT * FROM transactions WHERE message_sid = $1',
    [messageSid],
  );
  return res.rows[0] || null;
}

// Returns the inserted row, or null if this messageSid was already recorded —
// ON CONFLICT DO NOTHING makes a duplicate a no-op rather than an error, so two
// concurrent deliveries of the same message can't both write.
async function insertTransaction({ businessId, source, mediaUrl, extraction, needsReview, messageSid }) {
  const res = await getPool().query(
    `INSERT INTO transactions
       (business_id, type, amount, category, vendor, raw_source, raw_media_url,
        raw_extraction, confidence_score, needs_review, transaction_date, message_sid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (message_sid) DO NOTHING
     RETURNING *`,
    [
      businessId,
      extraction.type,
      extraction.amount,
      extraction.category,
      extraction.vendor || null,
      source,
      mediaUrl || null,
      JSON.stringify(extraction),
      extraction.confidence_score,
      needsReview,
      toDateOrNull(extraction.transaction_date),
      messageSid || null,
    ],
  );
  return res.rows[0] || null;
}

// Running per-business totals (CLAUDE.md MVP scope). Used by the reply and,
// later, the weekly summary job.
async function getRunningTotals(businessId) {
  const res = await getPool().query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type = 'sale'), 0)    AS total_sales,
       COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS total_expenses
     FROM transactions
     WHERE business_id = $1`,
    [businessId],
  );
  return {
    totalSales: Number(res.rows[0].total_sales),
    totalExpenses: Number(res.rows[0].total_expenses),
  };
}

module.exports = { insertTransaction, getRunningTotals, findByMessageSid };
