// PostgreSQL connection pool. The app runs fine without a database (extraction
// still works and replies still send) — persistence is skipped when
// DATABASE_URL is unset, so local dev and the test harness don't need Postgres.

const { Pool } = require('pg');

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
