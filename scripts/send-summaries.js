// Weekly summary job (CLAUDE.md > Architecture: "Backend -> scheduled weekly job
// -> summary message -> WhatsApp (owner)").
//
// Run it from a scheduler — Render Cron, or cron on a box — rather than an
// in-process timer, so it doesn't depend on the web service being awake:
//
//   npm run summary                      # last complete week, sends
//   npm run summary -- --dry-run         # print what would be sent, send nothing
//   npm run summary -- --week=2026-07-06 # a specific week (must be a Monday)
//   npm run summary -- --this-week       # the week in progress, for testing
//
// IMPORTANT: this sends a *business-initiated* message. WhatsApp only allows
// free-form messages within 24 hours of the owner's last message to you; outside
// that window Meta requires a pre-approved template, on Twilio as much as on
// Meta directly. Until a template is approved, summaries reach only owners who
// happen to have messaged in the last day. Twilio reports this as error 63016.

require('dotenv').config();

const { isDbConfigured, getPool } = require('../src/db/pool');
const { listBusinesses, getWeeklyTotals, upsertWeeklySummary } = require('../src/repositories/summaries');
const { estimateVat, weekStart, previousWeekStart, buildSummaryMessage } = require('../src/services/weeklySummary');
const { sendWhatsApp, isOutboundConfigured } = require('../src/services/twilioReply');

function parseArgs(argv) {
  const args = { dryRun: false, week: null, thisWeek: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--this-week') args.thisWeek = true;
    else if (a.startsWith('--week=')) args.week = a.slice('--week='.length);
  }
  return args;
}

function resolveWeek({ week, thisWeek }) {
  if (week) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error(`--week must be YYYY-MM-DD, got "${week}"`);
    const d = new Date(`${week}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) throw new Error(`--week is not a real date: "${week}"`);
    if (d.getUTCDay() !== 1) throw new Error(`--week must be a Monday; ${week} is not.`);
    return { start: week, label: 'That week' };
  }
  if (thisWeek) return { start: weekStart(), label: 'This week' };
  return { start: previousWeekStart(), label: 'Last week' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set — nothing to summarise.');
    process.exit(1);
  }

  const { start, label } = resolveWeek(args);
  const sending = !args.dryRun;

  if (sending && !isOutboundConfigured()) {
    console.error('Twilio outbound is not configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER).');
    console.error('Re-run with --dry-run to preview the messages instead.');
    process.exit(1);
  }

  console.log(`[summary] week beginning ${start} (${label})${args.dryRun ? ' — DRY RUN, nothing will be sent' : ''}`);

  const businesses = await listBusinesses();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const business of businesses) {
    const totals = await getWeeklyTotals(business.id, start);

    // An owner who recorded nothing doesn't need telling they recorded nothing.
    if (totals.transactionCount === 0) {
      console.log(`[summary] ${business.phone}: no transactions — skipped.`);
      skipped++;
      continue;
    }

    const estVat = estimateVat(totals.totalSales);
    const message = buildSummaryMessage({ ...totals, estVat }, { label });

    // Record it even on a dry run? No — a dry run must not write either.
    if (!args.dryRun) {
      await upsertWeeklySummary({
        businessId: business.id,
        weekStart: start,
        totalSales: totals.totalSales,
        totalExpenses: totals.totalExpenses,
        estVat,
      });
    }

    console.log(`[summary] ${business.phone}: ${totals.transactionCount} txn(s)`);
    console.log(`          ${message}`);

    if (args.dryRun) continue;

    try {
      const sid = await sendWhatsApp(`whatsapp:${business.phone}`, message);
      console.log(`          sent (${sid})`);
      sent++;
    } catch (err) {
      failed++;
      if (err && (err.code === 63016 || /outside.*window|freeform/i.test(err.message || ''))) {
        console.error('          NOT SENT — outside WhatsApp\'s 24h window. This needs a Meta-approved');
        console.error('          template; free-form business-initiated messages are blocked.');
      } else {
        console.error(`          send failed: ${err.message}`);
      }
    }
  }

  console.log(`[summary] done — ${sent} sent, ${skipped} skipped (no activity), ${failed} failed.`);
  await getPool().end();
}

main().catch((err) => {
  console.error('[summary] job failed:', err.message);
  process.exit(1);
});
