// Chooses which AI vendor does vision + categorization, so both can be compared
// against the same receipts before committing to one (see README: benchmarking).
//
// Voice is unaffected — whisper.js is OpenAI either way.
//
// AI_PROVIDER=anthropic (default) -> Claude, per the current CLAUDE.md tech stack
// AI_PROVIDER=openai              -> OpenAI
//
// Both modules export { extractFromReceiptImage, categorizeText, MODEL } and
// return the same OUTPUT_SCHEMA shape, so nothing downstream changes.

const PROVIDERS = {
  anthropic: () => require('./claude'),
  openai: () => require('./openai'),
};

const NAME = (process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase();

if (!PROVIDERS[NAME]) {
  throw new Error(
    `Unknown AI_PROVIDER "${NAME}". Expected one of: ${Object.keys(PROVIDERS).join(', ')}.`
  );
}

const provider = PROVIDERS[NAME]();

module.exports = {
  extractFromReceiptImage: provider.extractFromReceiptImage,
  categorizeText: provider.categorizeText,
  MODEL: provider.MODEL,
  PROVIDER: NAME,
};
