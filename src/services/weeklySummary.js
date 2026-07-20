// The weekly summary: totals, estimated VAT, and the message the owner receives
// (CLAUDE.md > MVP scope, Reply tone).

const KENYA_TZ = 'Africa/Nairobi';

// Kenya's standard VAT rate.
const VAT_RATE = 0.16;

/**
 * Estimated VAT for the week.
 *
 * NOTE: this is 16% of sales, with no credit for input VAT on purchases —
 * matching the worked example in CLAUDE.md (45,000 sales, 12,000 expenses ->
 * "Est. VAT: 7,200"). A VAT-registered business actually owes output VAT minus
 * input VAT, which on those numbers would be 5,280, so this **overstates** the
 * liability by the VAT on expenses.
 *
 * It is labelled "Est." and most of the target segment isn't VAT-registered at
 * all (CLAUDE.md > Competitive context), so this reads as an exposure estimate
 * rather than a filing figure. If that changes, this is the one line to change.
 */
function estimateVat(totalSales) {
  return Math.round(Number(totalSales || 0) * VAT_RATE * 100) / 100;
}

/**
 * The Monday of the week containing `reference`, as 'YYYY-MM-DD'.
 *
 * Computed in the owner's timezone, not the server's: Render runs UTC, so late
 * on a Sunday evening in Kenya (UTC+3) the server is still on Sunday — but at
 * 00:30 Monday in Kenya it's still Sunday in UTC, which would put the boundary
 * in the wrong week. Same trap as transaction dates.
 */
function weekStart(reference = new Date()) {
  const kenyaToday = reference.toLocaleDateString('en-CA', { timeZone: KENYA_TZ });
  const d = new Date(`${kenyaToday}T00:00:00Z`);
  // getUTCDay: 0=Sunday..6=Saturday. Weeks start Monday.
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}

// The Monday before the current one — the last *complete* week, which is what a
// summary should report. Running on Monday morning covers Mon-Sun just gone.
function previousWeekStart(reference = new Date()) {
  const d = new Date(`${weekStart(reference)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

function formatKes(amount) {
  return Math.round(Number(amount) || 0).toLocaleString('en-KE');
}

/**
 * The WhatsApp message, in the tone CLAUDE.md specifies:
 *
 *   This week: 45,000 KES sales, 12,000 KES expenses. Est. VAT: 7,200 KES.
 *   3 items need your confirmation — reply 'review'.
 */
function buildSummaryMessage({ totalSales, totalExpenses, estVat, needsReviewCount }, { label = 'Last week' } = {}) {
  const parts = [
    `${label}: ${formatKes(totalSales)} KES sales, ${formatKes(totalExpenses)} KES expenses.`,
    `Est. VAT: ${formatKes(estVat)} KES.`,
  ];
  if (needsReviewCount > 0) {
    const item = needsReviewCount === 1 ? 'item needs' : 'items need';
    parts.push(`${needsReviewCount} ${item} your confirmation — reply 'review'.`);
  }
  return parts.join(' ');
}

module.exports = {
  VAT_RATE,
  estimateVat,
  weekStart,
  previousWeekStart,
  buildSummaryMessage,
  formatKes,
};
