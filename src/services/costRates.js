// Turning recorded usage (see usage.js) into money.
//
// DELIBERATELY NOT HARDCODED. Model prices, Whisper's per-minute rate and
// Twilio's per-message WhatsApp fee all change, vary by region, and vary by
// account. A plausible-looking number baked in here would produce a cost report
// that is confidently wrong — which is worse than no report at all, because
// pricing decisions would get made on it.
//
// So rates come from the environment, and anything unset is reported as UNKNOWN
// rather than silently treated as zero. Fill them in from your actual OpenAI,
// Anthropic and Twilio invoices — those are the only authoritative source for
// what *you* are charged.
//
// All rates are in USD. KES conversion is applied at the end, so there's one
// place to update when the shilling moves.

function num(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// USD per 1,000,000 tokens, per provider. Input and output are priced
// differently by every vendor, so they're separate.
function tokenRates(provider) {
  const p = (provider || '').toUpperCase();
  return {
    input: num(`COST_${p}_INPUT_PER_MTOK`),
    output: num(`COST_${p}_OUTPUT_PER_MTOK`),
  };
}

const rates = {
  tokenRates,
  whisperPerMinute: () => num('COST_WHISPER_PER_MINUTE'),   // USD per audio minute
  whatsappPerMessage: () => num('COST_WHATSAPP_PER_MESSAGE'), // USD per outbound message
  usdToKes: () => num('USD_TO_KES'),
};

/**
 * Cost of one usage event in USD, or null if the rate it needs isn't configured.
 *
 * null propagates on purpose: a report that can't price transcription should say
 * so, not quietly report an under-count as though it were the total.
 */
function costUsd(event) {
  if (event.kind === 'whatsapp_out') {
    const rate = rates.whatsappPerMessage();
    return rate === null ? null : rate * (event.messages || 0);
  }

  if (event.kind === 'transcribe') {
    const rate = rates.whisperPerMinute();
    if (rate === null || event.audioSeconds === null) return null;
    return rate * (event.audioSeconds / 60);
  }

  // Token-based: vision, categorize, correct.
  const { input, output } = rates.tokenRates(event.provider);
  if (input === null || output === null) return null;
  if (event.inputTokens === null && event.outputTokens === null) return null;
  return (
    (input * (event.inputTokens || 0)) / 1e6 +
    (output * (event.outputTokens || 0)) / 1e6
  );
}

/**
 * Total a list of events.
 *
 * Returns { usd, pricedCount, unpricedCount } — never a bare number, because
 * "3.40" and "3.40 but we couldn't price 40% of the events" mean very different
 * things and the caller has to be able to tell them apart.
 */
function totalUsd(events) {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  for (const e of events) {
    const c = costUsd(e);
    if (c === null) unpriced++;
    else { usd += c; priced++; }
  }
  return { usd, pricedCount: priced, unpricedCount: unpriced };
}

// Which rates are missing — so the report can name them instead of just showing
// a suspiciously small number.
function missingRates(events) {
  const missing = new Set();
  for (const e of events) {
    if (costUsd(e) !== null) continue;
    if (e.kind === 'whatsapp_out') missing.add('COST_WHATSAPP_PER_MESSAGE');
    else if (e.kind === 'transcribe') missing.add('COST_WHISPER_PER_MINUTE');
    else if (e.provider) {
      const p = e.provider.toUpperCase();
      if (rates.tokenRates(e.provider).input === null) missing.add(`COST_${p}_INPUT_PER_MTOK`);
      if (rates.tokenRates(e.provider).output === null) missing.add(`COST_${p}_OUTPUT_PER_MTOK`);
    }
  }
  return [...missing].sort();
}

function toKes(usd) {
  const rate = rates.usdToKes();
  return rate === null ? null : usd * rate;
}

module.exports = { costUsd, totalUsd, missingRates, toKes, rates };
