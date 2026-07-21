// Claude does two jobs in Weza AI (CLAUDE.md tech stack):
//   1. Vision — read a receipt photo directly (no separate OCR).
//   2. Categorization — turn parsed text into fixed transaction fields.
// Both return the shared OUTPUT_SCHEMA shape. Structured outputs
// (output_config.format) guarantee the category is always one of the fixed
// enum values, so the model can never invent a category.

const Anthropic = require('@anthropic-ai/sdk');
const {
  OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  buildCorrectionPrompt,
} = require('./transactionSchema');
const { MOCK, mockCategorize, mockReceipt, mockCorrection } = require('./mockAI');
const { aiClientOptions } = require('./aiClientOptions');
const { recordUsage } = require('./usage');

// Default to the most capable model; override with CLAUDE_MODEL if needed.
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
// low | medium | high | max — medium balances accuracy against WhatsApp latency.
const EFFORT = process.env.CLAUDE_EFFORT || 'medium';

// Claude vision accepts these image media types.
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

let client;
function getClient() {
  if (!client) {
    // Reads ANTHROPIC_API_KEY from the environment.
    client = new Anthropic(aiClientOptions('claude'));
  }
  return client;
}

// Pull the structured JSON out of the response. With adaptive thinking on, the
// response may contain thinking blocks before the final text block.
function parseStructured(response) {
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Claude returned no text block to parse.');
  }
  return JSON.parse(textBlock.text);
}

async function runExtraction(userContent, kind = 'categorize') {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: userContent }],
  });

  recordUsage({
    kind,
    provider: 'anthropic',
    model: MODEL,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  });

  return parseStructured(response);
}

// Receipt photo -> structured transaction.
async function extractFromReceiptImage(buffer, mediaType) {
  if (MOCK) return mockReceipt();
  const media_type = SUPPORTED_IMAGE_TYPES.includes(mediaType) ? mediaType : 'image/jpeg';
  return runExtraction([
    {
      type: 'image',
      source: { type: 'base64', media_type, data: buffer.toString('base64') },
    },
    {
      type: 'text',
      text: 'This is a receipt or invoice photo from a business owner. Extract the transaction.',
    },
  ], 'vision');
}

// Text (typed message, or a Whisper transcript) -> structured transaction.
async function categorizeText(text) {
  if (MOCK) return mockCategorize(text);
  return runExtraction([
    {
      type: 'text',
      text: `The business owner sent this note about a sale or expense:\n\n"${text}"\n\nExtract the transaction.`,
    },
  ]);
}

// An existing transaction + what the owner says is wrong -> corrected transaction.
async function correctTransaction(original, correctionText) {
  if (MOCK) return mockCorrection(original, correctionText);
  return runExtraction([
    { type: 'text', text: buildCorrectionPrompt(original, correctionText) },
  ], 'correct');
}

module.exports = { extractFromReceiptImage, categorizeText, correctTransaction, MODEL };
