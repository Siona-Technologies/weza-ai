// PostgreSQL connection pool. The app runs fine without a database (extraction
// still works and replies still send) — persistence is skipped when
// DATABASE_URL is unset, so local dev and the test harness don't need Postgres.

const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates.
//
// By default pg turns a DATE into a Date at *local* midnight, so a stored
// 2026-04-03 becomes 2026-04-02T21:00:00Z in Kenya (UTC+3) — and anything that
// then formats it as UTC (.toISOString(), JSON serialisation) reports the day
// before. A transaction_date has no time or zone attached; it's the date on the
// receipt. Keeping it a string preserves exactly that, and matters most for the
// weekly summary, which is built entirely on date boundaries.
const PG_DATE_OID = 1082;
types.setTypeParser(PG_DATE_OID, (value) => value);

// TIMESTAMP (without time zone) has the same problem, one column over.
//
// Our timestamps are written by CURRENT_TIMESTAMP against a Postgres session in
// UTC, so the stored value *is* UTC — but pg parses it as local time, making a
// row written seconds ago read as three hours old in Kenya (UTC+3). That already
// broke the 'fix' command's 15-minute window once (every pending fix expired
// immediately); created_at would have gone the same way in the weekly summary.
// Parse it as the UTC it actually is.
const PG_TIMESTAMP_OID = 1114;
types.setTypeParser(PG_TIMESTAMP_OID, (value) => new Date(value.replace(' ', 'T') + 'Z'));

let pool;

function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!isDbConfigured()) {
    throw new Error('DATABASE_URL is not set.');
  }
  if (!pool) {
    const url = process.env.DATABASE_URL;
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      // Render managed Postgres requires SSL; local Postgres typically doesn't.
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

module.exports = { getPool, isDbConfigured };
