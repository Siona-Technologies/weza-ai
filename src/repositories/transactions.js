// Persist one extracted transaction. The full AI output is stored in the
// raw_extraction JSONB column so nothing from the model is lost, and
// confidence_score / needs_review carry the trust signal (CLAUDE.md).

const { getPool } = require('../db/pool');

function toDateOrNull(value) {
  if (!value || !String(value).trim()) return null;
  return value; // 'YYYY-MM-DD' string; Postgres casts to DATE
}

async function insertTransaction({ businessId, source, mediaUrl, extraction, needsReview }) {
  const res = await getPool().query(
    `INSERT INTO transactions
       (business_id, type, amount, category, vendor, raw_source, raw_media_url,
        raw_extraction, confidence_score, needs_review, transaction_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
    ],
  );
  return res.rows[0];
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

module.exports = { insertTransaction, getRunningTotals };
