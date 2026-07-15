// Businesses are identified solely by their WhatsApp phone number (MVP: no auth
// beyond the phone number — see CLAUDE.md scope).

const { getPool } = require('../db/pool');

// Find the business for this phone, creating it on first contact. Fills in the
// owner name from the WhatsApp profile if we don't already have one.
async function findOrCreateBusiness({ phone, ownerName }) {
  const res = await getPool().query(
    `INSERT INTO businesses (phone, owner_name)
     VALUES ($1, $2)
     ON CONFLICT (phone)
     DO UPDATE SET owner_name = COALESCE(businesses.owner_name, EXCLUDED.owner_name)
     RETURNING *`,
    [phone, ownerName || null],
  );
  return res.rows[0];
}

module.exports = { findOrCreateBusiness };
