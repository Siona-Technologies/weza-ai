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

// How long a pending "fix" stays open. An owner who says "fix" and then wanders
// off must not have tomorrow's receipt swallowed as a correction to yesterday's
// entry, so the state expires rather than waiting forever.
const AWAITING_FIX_TTL_MINUTES = 15;

async function setAwaitingFix(businessId, transactionId) {
  await getPool().query(
    `UPDATE businesses
        SET awaiting_fix_transaction_id = $2,
            awaiting_fix_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [businessId, transactionId],
  );
}

async function clearAwaitingFix(businessId) {
  await getPool().query(
    `UPDATE businesses
        SET awaiting_fix_transaction_id = NULL,
            awaiting_fix_at = NULL
      WHERE id = $1`,
    [businessId],
  );
}

// The transaction this business is currently correcting, or null if there isn't
// one or it's gone stale.
//
// The age check is done in SQL, deliberately. awaiting_fix_at is a TIMESTAMP
// (no zone), and pg hands those to JS as Date objects at *local* midnight-style
// offsets — so in Kenya (UTC+3) a row written seconds ago reads as three hours
// old and every pending fix expired instantly. Comparing inside Postgres, where
// the value was written, sidesteps the client's timezone entirely.
async function pendingFixTransactionId(businessId) {
  const res = await getPool().query(
    `SELECT awaiting_fix_transaction_id
       FROM businesses
      WHERE id = $1
        AND awaiting_fix_transaction_id IS NOT NULL
        AND awaiting_fix_at > CURRENT_TIMESTAMP - ($2 || ' minutes')::interval`,
    [businessId, String(AWAITING_FIX_TTL_MINUTES)],
  );
  return res.rows[0] ? res.rows[0].awaiting_fix_transaction_id : null;
}

// How long a review walk stays open. Longer than the fix window because a walk
// is several exchanges, not one: an owner clearing four flagged entries while
// serving customers can easily take twenty minutes between replies, and having
// the session expire underneath them would silently turn their next "yes" into
// an ordinary message.
const AWAITING_REVIEW_TTL_MINUTES = 30;

async function setAwaitingReview(businessId, transactionId) {
  await getPool().query(
    `UPDATE businesses
        SET awaiting_review_transaction_id = $2,
            awaiting_review_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [businessId, transactionId],
  );
}

async function clearAwaitingReview(businessId) {
  await getPool().query(
    `UPDATE businesses
        SET awaiting_review_transaction_id = NULL,
            awaiting_review_at = NULL
      WHERE id = $1`,
    [businessId],
  );
}

// The entry currently on screen in a review walk, or null if there isn't one or
// it's gone stale. Age compared in SQL for the same timezone reason as
// pendingFixTransactionId above — see that comment before changing this.
async function pendingReviewTransactionId(businessId) {
  const res = await getPool().query(
    `SELECT awaiting_review_transaction_id
       FROM businesses
      WHERE id = $1
        AND awaiting_review_transaction_id IS NOT NULL
        AND awaiting_review_at > CURRENT_TIMESTAMP - ($2 || ' minutes')::interval`,
    [businessId, String(AWAITING_REVIEW_TTL_MINUTES)],
  );
  return res.rows[0] ? res.rows[0].awaiting_review_transaction_id : null;
}

module.exports = {
  findOrCreateBusiness,
  setAwaitingFix,
  clearAwaitingFix,
  pendingFixTransactionId,
  AWAITING_FIX_TTL_MINUTES,
  setAwaitingReview,
  clearAwaitingReview,
  pendingReviewTransactionId,
  AWAITING_REVIEW_TTL_MINUTES,
};
