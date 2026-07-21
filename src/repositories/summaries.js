// Weekly totals and the weekly_summaries record (CLAUDE.md > MVP scope).

const { getPool } = require('../db/pool');

/**
 * Totals for one business over the half-open date range [start, end) — both
 * 'YYYY-MM-DD' — plus how many entries are still awaiting the owner's
 * confirmation. Half-open so adjacent periods can't double-count a day.
 *
 * Transactions are counted by transaction_date, falling back to when we captured
 * them. transaction_date is NULL when a photo's date couldn't be read — we
 * refuse to invent one — but a receipt with no readable date still happened, and
 * dropping it here would leave it out of every week forever, under-reporting the
 * one number the owner cares about. The column stays honestly NULL; the *report*
 * files it under the week it arrived, which is close enough and beats silence.
 *
 * created_at is a UTC TIMESTAMP, so it's converted to the owner's day before the
 * date is taken — otherwise anything captured between midnight and 3am in Kenya
 * lands in the previous week.
 */
async function getTotalsBetween(businessId, start, end) {
  const res = await getPool().query(
    `WITH dated AS (
       SELECT type, amount, needs_review,
              COALESCE(
                transaction_date,
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Africa/Nairobi')::date
              ) AS effective_date
         FROM transactions
        WHERE business_id = $1
     )
     SELECT
       COALESCE(SUM(amount) FILTER (WHERE type = 'sale'), 0)    AS total_sales,
       COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS total_expenses,
       COUNT(*) FILTER (WHERE needs_review)                     AS needs_review_count,
       COUNT(*)                                                 AS transaction_count
       FROM dated
      WHERE effective_date >= $2::date
        AND effective_date <  $3::date`,
    [businessId, start, end],
  );
  const row = res.rows[0];
  return {
    totalSales: Number(row.total_sales),
    totalExpenses: Number(row.total_expenses),
    needsReviewCount: Number(row.needs_review_count),
    transactionCount: Number(row.transaction_count),
  };
}

// The scheduled job's shape: the seven days from a Monday.
async function getWeeklyTotals(businessId, weekStart) {
  const end = new Date(`${weekStart}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 7);
  return getTotalsBetween(businessId, weekStart, end.toISOString().slice(0, 10));
}

// Idempotent: re-running the job for a week updates that week's row rather than
// adding another. See the UNIQUE index in db/schema.sql.
async function upsertWeeklySummary({ businessId, weekStart, totalSales, totalExpenses, estVat }) {
  const res = await getPool().query(
    `INSERT INTO weekly_summaries (business_id, week_start, total_sales, total_expenses, est_vat)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, week_start)
     DO UPDATE SET total_sales    = EXCLUDED.total_sales,
                   total_expenses = EXCLUDED.total_expenses,
                   est_vat        = EXCLUDED.est_vat,
                   generated_at   = CURRENT_TIMESTAMP
     RETURNING *`,
    [businessId, weekStart, totalSales, totalExpenses, estVat],
  );
  return res.rows[0];
}

// Every business we might send a summary to.
async function listBusinesses() {
  const res = await getPool().query('SELECT * FROM businesses ORDER BY id');
  return res.rows;
}

module.exports = { getTotalsBetween, getWeeklyTotals, upsertWeeklySummary, listBusinesses };
