// Applies db/schema.sql to the database in DATABASE_URL. Idempotent — run it on
// each deploy. Usage: npm run migrate

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getPool, isDbConfigured } = require('../src/db/pool');

async function main() {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set. Add it to .env (or the Render environment) first.');
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const pool = getPool();

  console.log('[migrate] applying db/schema.sql ...');
  await pool.query(sql);
  console.log('[migrate] done — tables and enums are in place.');

  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
