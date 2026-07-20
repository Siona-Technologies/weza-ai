// What Weza AI actually costs to run, per business.
//
//   npm run cost                  # last 30 days
//   npm run cost -- --days=7
//   npm run cost -- --days=90
//
// The question this answers: if a shop sends 100 receipts a month, what does
// that cost us? You cannot price a product without that number, and until this
// existed nobody had it.
//
// Usage (tokens, audio seconds, messages) is measured exactly. Prices are NOT
// hardcoded — they change, vary by region and vary by account — so they come
// from environment variables and anything unset is reported as UNKNOWN rather
// than quietly counted as zero. Fill them in from your actual OpenAI, Anthropic
// and Twilio invoices. See .env.example.

require('dotenv').config();

const { isDbConfigured, getPool } = require('../src/db/pool');
const { usageSince } = require('../src/repositories/usage');
const { totalUsd, missingRates, toKes, rates } = require('../src/services/costRates');

function parseDays(argv) {
  const arg = argv.find((a) => a.startsWith('--days='));
  if (!arg) return 30;
  const n = Number(arg.slice('--days='.length));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--days must be a positive number, got "${arg}"`);
  return n;
}

function money(usd) {
  const kes = toKes(usd);
  const usdPart = `$${usd.toFixed(4)}`;
  return kes === null ? usdPart : `${usdPart} (~KES ${kes.toFixed(2)})`;
}

function summarise(events) {
  const byKind = {};
  for (const e of events) {
    const k = byKind[e.kind] || (byKind[e.kind] = {
      calls: 0, inputTokens: 0, outputTokens: 0, audioSeconds: 0, messages: 0,
    });
    k.calls++;
    k.inputTokens += e.inputTokens || 0;
    k.outputTokens += e.outputTokens || 0;
    k.audioSeconds += e.audioSeconds || 0;
    k.messages += e.messages || 0;
  }
  return byKind;
}

async function main() {
  const days = parseDays(process.argv.slice(2));

  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set — there is no usage to report on.');
    process.exit(1);
  }

  const events = await usageSince(days);

  console.log(`\n=== Weza AI cost report — last ${days} days ===\n`);

  if (events.length === 0) {
    console.log('No usage recorded in this window.');
    console.log('Usage is captured per inbound WhatsApp message; send one and re-run.\n');
    await getPool().end();
    return;
  }

  // Per business.
  const businesses = new Map();
  for (const e of events) {
    const key = e.businessId ?? 'unattributed';
    if (!businesses.has(key)) businesses.set(key, { phone: e.phone, events: [] });
    businesses.get(key).events.push(e);
  }

  for (const [, { phone, events: evs }] of businesses) {
    const messages = new Set(evs.map((e) => e.messageSid).filter(Boolean)).size;
    const { usd, unpricedCount } = totalUsd(evs);
    const perMessage = messages > 0 ? usd / messages : 0;

    console.log(`${phone || '(unidentified)'}`);
    console.log(`  inbound messages : ${messages}`);
    console.log(`  billable calls   : ${evs.length}`);
    console.log(`  total            : ${money(usd)}${unpricedCount ? `  [${unpricedCount} call(s) unpriced]` : ''}`);
    if (messages > 0) {
      console.log(`  per message      : ${money(perMessage)}`);
      // The number the pricing conversation actually needs.
      console.log(`  at 100 msgs/mo   : ${money(perMessage * 100)}`);
    }

    const byKind = summarise(evs);
    for (const [kind, k] of Object.entries(byKind)) {
      const bits = [`${k.calls} call(s)`];
      if (k.inputTokens || k.outputTokens) bits.push(`${k.inputTokens} in / ${k.outputTokens} out tokens`);
      if (k.audioSeconds) bits.push(`${k.audioSeconds.toFixed(1)}s audio`);
      if (k.messages) bits.push(`${k.messages} message(s)`);
      console.log(`    ${kind.padEnd(13)} ${bits.join(', ')}`);
    }
    console.log('');
  }

  // Totals across everyone.
  const { usd, unpricedCount } = totalUsd(events);
  const allMessages = new Set(events.map((e) => e.messageSid).filter(Boolean)).size;
  console.log('--- all businesses ---');
  console.log(`  inbound messages : ${allMessages}`);
  console.log(`  total            : ${money(usd)}`);
  if (allMessages > 0) console.log(`  per message      : ${money(usd / allMessages)}`);

  const missing = missingRates(events);
  if (missing.length > 0) {
    console.log('\n!!  INCOMPLETE — these rates are not configured, so the figures above');
    console.log('    are an UNDER-COUNT, not a total:');
    for (const m of missing) console.log(`      ${m}`);
    console.log(`    ${unpricedCount} call(s) could not be priced.`);
    console.log('    Set them in .env from your provider invoices, then re-run.');
  }
  if (rates.usdToKes() === null) {
    console.log('\n    (Set USD_TO_KES to also see shillings.)');
  }
  console.log('');

  await getPool().end();
}

main().catch((err) => {
  console.error('[cost] report failed:', err.message);
  process.exit(1);
});
