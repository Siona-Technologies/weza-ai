// Orchestrates the Phase 2 pipeline for one inbound WhatsApp message:
//
//   photo -> Claude vision            -> structured transaction
//   voice -> Whisper -> Claude text   -> structured transaction
//   text  -> Claude text             -> structured transaction
//
// Returns the structured extraction plus a needs_review flag. Persisting to
// Postgres and the weekly summary job come in Phase 3.

const { fetchTwilioMedia } = require('./twilioMedia');
const { extractFromReceiptImage, categorizeText } = require('./claude');
const { transcribeAudio } = require('./whisper');
const { CONFIDENCE_REVIEW_THRESHOLD } = require('./transactionSchema');

// `source` is 'photo' | 'voice' | 'text' (from the webhook classifier).
async function processMessage({ source, body, mediaUrl, mediaType }) {
  let extraction;
  let transcript = null;

  if (source === 'photo') {
    const { buffer, contentType } = await fetchTwilioMedia(mediaUrl);
    extraction = await extractFromReceiptImage(buffer, contentType);
  } else if (source === 'voice') {
    const { buffer, contentType } = await fetchTwilioMedia(mediaUrl);
    transcript = await transcribeAudio(buffer, contentType);
    extraction = await categorizeText(transcript);
  } else if (source === 'text') {
    if (!body || !body.trim()) {
      throw new Error('Empty text message — nothing to categorize.');
    }
    extraction = await categorizeText(body);
  } else {
    throw new Error(`Unsupported message source: ${source}`);
  }

  const confidence = typeof extraction.confidence_score === 'number'
    ? extraction.confidence_score
    : 0;
  const needsReview = confidence < CONFIDENCE_REVIEW_THRESHOLD;

  return { source, transcript, extraction, needsReview };
}

// WhatsApp reply matching the tone in CLAUDE.md. (Phase 3 owns the real reply
// generator + persistence; this keeps the loop closed for testing.)
function buildReply({ extraction, needsReview }) {
  const amount = Math.round(Number(extraction.amount) || 0).toLocaleString('en-KE');
  const vendor = extraction.vendor ? `${extraction.vendor}, ` : '';
  const verb = extraction.type === 'sale' ? 'recorded as sale' : `recorded as ${extraction.category}`;

  if (needsReview) {
    return `Got it — ${amount} KES, ${vendor}${verb}. I'm not fully sure I read this right — reply 'review' to confirm or 'fix' to correct.`;
  }
  return `Got it — ${amount} KES, ${vendor}${verb}. Reply 'fix' if wrong.`;
}

module.exports = { processMessage, buildReply };
