// OpenAI vision + categorization — the same two jobs claude.js does, against
// OpenAI instead. Both modules export the identical interface and return the
// shared OUTPUT_SCHEMA shape, so aiProvider.js can swap between them and nothing
// downstream (pipeline, DB, reply generator) can tell the difference.
//
// Structured outputs work differently here than on Anthropic:
//   Anthropic: output_config.format = { type: 'json_schema', schema }
//   OpenAI:    response_format      = { type: 'json_schema', json_schema: { strict: true, schema } }
// Both guarantee the fixed category enum, which is the point — the model can
// never invent a category (CLAUDE.md).

const OpenAI = require('openai');
const { OUTPUT_SCHEMA, SYSTEM_PROMPT } = require('./transactionSchema');
const { MOCK, mockCategorize, mockReceipt } = require('./mockAI');

// gpt-5.6-terra balances accuracy against latency; -sol is stronger but slower
// (latency is already the binding constraint — see the 15s Twilio webhook
// timeout), -luna is cheapest. Override with OPENAI_MODEL.
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-terra';

// OpenAI vision accepts these image media types.
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

let client;
function getClient() {
  if (!client) {
    // Reads OPENAI_API_KEY from the environment — the same key whisper.js uses.
    client = new OpenAI();
  }
  return client;
}

async function runExtraction(userContent) {
  const response = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'transaction',
        strict: true,
        schema: OUTPUT_SCHEMA,
      },
    },
  });

  const message = response.choices?.[0]?.message;
  // Under strict structured outputs the model can decline instead of answering;
  // that arrives as a `refusal`, not as malformed JSON.
  if (message?.refusal) {
    throw new Error(`OpenAI refused the extraction: ${message.refusal}`);
  }
  if (!message?.content) {
    throw new Error('OpenAI returned no content to parse.');
  }
  return JSON.parse(message.content);
}

// Receipt photo -> structured transaction.
async function extractFromReceiptImage(buffer, mediaType) {
  if (MOCK) return mockReceipt();
  const media_type = SUPPORTED_IMAGE_TYPES.includes(mediaType) ? mediaType : 'image/jpeg';
  return runExtraction([
    {
      type: 'image_url',
      image_url: { url: `data:${media_type};base64,${buffer.toString('base64')}` },
    },
    {
      type: 'text',
      text: 'This is a receipt or invoice photo from a business owner. Extract the transaction.',
    },
  ]);
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

module.exports = { extractFromReceiptImage, categorizeText, MODEL };
