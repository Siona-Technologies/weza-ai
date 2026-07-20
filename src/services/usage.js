// Per-message usage tracking: how many tokens, how many seconds of audio, how
// many WhatsApp messages one inbound receipt actually consumed.
//
// Why this exists: every receipt costs real money (vision tokens, Whisper
// seconds, an outbound message) and nobody knows how much. You can't price a
// product whose cost per customer you've never measured — see README > Cost per
// transaction. This records the *usage*; costRates.js turns usage into money.
//
// Why AsyncLocalStorage rather than returning usage up the call stack: the AI
// modules return a bare extraction object that four layers pass around, and
// threading a second return value through all of them would touch every
// signature for something none of them care about. A module-level "last usage"
// variable would be simpler but wrong — two receipts arriving at once would
// overwrite each other's numbers, and concurrent messages are the normal case,
// not the edge case.
//
// Nothing here can break a message. If tracking is off, or a provider stops
// returning usage, recordUsage is a no-op and the receipt is processed exactly
// as before. Bookkeeping about bookkeeping must never be the thing that loses
// someone's receipt.

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

// Run `fn` with a fresh usage collector attached to this async context.
// Everything awaited inside it — however deep — records into the same array.
function withUsageTracking(fn) {
  return storage.run({ events: [] }, fn);
}

/**
 * Record one billable call.
 *
 * kind:  'vision' | 'categorize' | 'correct' | 'transcribe' | 'whatsapp_out'
 * Fields not relevant to a kind stay null rather than 0, so "we never measured
 * this" stays distinguishable from "this genuinely cost nothing".
 */
function recordUsage(event) {
  const store = storage.getStore();
  if (!store) return; // outside a tracked request (scripts, tests) — ignore.
  store.events.push({
    kind: event.kind,
    provider: event.provider || null,
    model: event.model || null,
    inputTokens: event.inputTokens ?? null,
    outputTokens: event.outputTokens ?? null,
    audioSeconds: event.audioSeconds ?? null,
    messages: event.messages ?? null,
  });
}

// Everything recorded in the current context, or [] outside one.
function collectUsage() {
  const store = storage.getStore();
  return store ? store.events : [];
}

module.exports = { withUsageTracking, recordUsage, collectUsage };
