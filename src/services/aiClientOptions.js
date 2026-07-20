// Shared client options for every AI call (Claude, OpenAI, Whisper).
//
// Both SDKs already retry 408, 409, 429 and 5xx with exponential backoff, and
// honour retry-after / x-should-retry. So there is deliberately no retry loop of
// our own here: a second layer would multiply against theirs (3 x 3 = 9 attempts
// during an outage) rather than add resilience. What the SDKs get wrong for us
// is the defaults.

// The default is TEN MINUTES. The webhook is async now, so nothing forces a
// reply — which means a hung request just leaves the owner staring at WhatsApp
// with no answer and no error. Real extractions measure 4-23s (Claude is the
// slow one), so 45s is ~2x headroom over the worst case we've seen, and a call
// that exceeds it is stuck rather than slow.
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45_000);

// Kept at the SDK default of 2. Worst case is roughly timeout x 3 plus backoff
// (~2.5 min) before the owner is told we couldn't read it — long, but only when
// every attempt hangs. Raising this trades a longer silence for a better chance
// on a provider having a bad minute; lower it if owners complain about waiting.
const MAX_RETRIES = Number(process.env.AI_MAX_RETRIES || 2);

// The SDKs log retries at info level — but info also logs every request, which
// would bury the webhook logs. A retry is a signal worth seeing; a normal
// request isn't. So pass info through only when it's a retry, and raise it to
// warn because it means a provider is struggling.
function retryOnlyLogger(label) {
  return {
    error: (...args) => console.error(`[${label}]`, ...args),
    warn: (...args) => console.warn(`[${label}]`, ...args),
    info: (message, ...args) => {
      if (typeof message === 'string' && /retrying/i.test(message)) {
        console.warn(`[${label}] ${message}`, ...args);
      }
    },
    debug: () => {},
  };
}

function aiClientOptions(label) {
  return {
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    logLevel: 'info',
    logger: retryOnlyLogger(label),
  };
}

module.exports = { aiClientOptions, TIMEOUT_MS, MAX_RETRIES };
