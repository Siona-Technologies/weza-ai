// Local test harness for the Phase 2 AI pipeline — no Twilio, no ngrok, no
// WhatsApp needed. Feeds text / a local image / a local audio file straight
// through the AI pipeline so you can verify extraction with just API keys.
//
// Usage:
//   node scripts/test-extract.js text  "Sold 3 sodas for 150 KES"
//   node scripts/test-extract.js image ./receipt.jpg
//   node scripts/test-extract.js voice ./note.ogg
//
// Vision/categorization run on whichever vendor AI_PROVIDER selects, so the same
// receipt can be scored against both:
//   $env:AI_PROVIDER="openai"; node scripts/test-extract.js image ./receipt2.png
//
// Needs ANTHROPIC_API_KEY or OPENAI_API_KEY in .env depending on AI_PROVIDER;
// voice always needs OPENAI_API_KEY (Whisper).

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { extractFromReceiptImage, categorizeText, MODEL, PROVIDER } = require('../src/services/aiProvider');
const { transcribeAudio } = require('../src/services/whisper');
const { buildReply } = require('../src/services/processMessage');
const { CONFIDENCE_REVIEW_THRESHOLD, isTransaction } = require('../src/services/transactionSchema');
const { MOCK } = require('../src/services/mockAI');

// In mock mode the file bytes are ignored, so a missing file is fine.
function readFile(p) {
  try {
    return fs.readFileSync(p);
  } catch (err) {
    if (MOCK) return Buffer.alloc(0);
    throw err;
  }
}

const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const AUDIO_TYPES = { '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.amr': 'audio/amr' };

async function main() {
  const [mode, arg] = process.argv.slice(2);

  if (!mode || !arg) {
    console.log('Usage:');
    console.log('  node scripts/test-extract.js text  "Sold 3 sodas for 150 KES"');
    console.log('  node scripts/test-extract.js image ./receipt.jpg');
    console.log('  node scripts/test-extract.js voice ./note.ogg');
    process.exit(1);
  }

  // Each vendor reads its own key; name the one that's actually missing.
  const REQUIRED_KEY = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' }[PROVIDER];

  if (MOCK) {
    console.log('(MOCK_AI is on — using stubbed extraction, no API calls)');
  } else {
    console.log(`(provider: ${PROVIDER} — model: ${MODEL})`);
    if (!process.env[REQUIRED_KEY]) {
      console.error(`\n${REQUIRED_KEY} is not set in .env — needed for AI_PROVIDER=${PROVIDER}. Add it, or set MOCK_AI=true to test without keys.\n`);
      process.exit(1);
    }
  }

  let extraction;
  let transcript = null;

  if (mode === 'text') {
    extraction = await categorizeText(arg);
  } else if (mode === 'image') {
    const ext = path.extname(arg).toLowerCase();
    const buffer = readFile(arg);
    extraction = await extractFromReceiptImage(buffer, IMAGE_TYPES[ext] || 'image/jpeg');
  } else if (mode === 'voice') {
    if (!MOCK && !process.env.OPENAI_API_KEY) {
      console.error('\nOPENAI_API_KEY is not set in .env — needed to transcribe voice notes (or set MOCK_AI=true).\n');
      process.exit(1);
    }
    const ext = path.extname(arg).toLowerCase();
    const buffer = readFile(arg);
    transcript = await transcribeAudio(buffer, AUDIO_TYPES[ext] || 'audio/ogg');
    console.log('\nTranscript:', transcript);
    extraction = await categorizeText(transcript);
  } else {
    console.error(`Unknown mode "${mode}". Use text | image | voice.`);
    process.exit(1);
  }

  const recordable = isTransaction(extraction);
  const needsReview = recordable && (extraction.confidence_score ?? 0) < CONFIDENCE_REVIEW_THRESHOLD;

  console.log('\n--- Extracted transaction ---');
  console.log(JSON.stringify(extraction, null, 2));
  console.log('\nis_transaction:', recordable, recordable ? '' : '(would not be saved)');
  console.log('needs_review:', needsReview);
  console.log('\nWhatsApp reply would be:');
  console.log('  ' + buildReply({ extraction, needsReview, isTransaction: recordable }));
  console.log('');
}

main().catch((err) => {
  console.error('\nTest failed:', err.message, '\n');
  process.exit(1);
});
