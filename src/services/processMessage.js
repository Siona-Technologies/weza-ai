// Orchestrates the Phase 2 pipeline for one inbound WhatsApp message:
//
//   photo -> vision                 -> structured transaction
//   voice -> Whisper -> categorize  -> structured transaction
//   text  -> categorize             -> structured transaction
//
// Vision/categorization run on whichever vendor AI_PROVIDER selects; voice is
// always Whisper (OpenAI). Returns the structured extraction plus a needs_review
// flag. Persisting to Postgres and the weekly summary job come in Phase 3.

const { fetchTwilioMedia } = require('./twilioMedia');
const { extractFromReceiptImage, categorizeText } = require('./aiProvider');
const { transcribeAudio } = require('./whisper');
const { CONFIDENCE_REVIEW_THRESHOLD, isTransaction } = require('./transactionSchema');
const { MOCK } = require('./mockAI');

// In mock mode the media bytes are never used, so don't hit Twilio for them.
async function getMedia(mediaUrl) {
  if (MOCK) return { buffer: Buffer.alloc(0), contentType: '' };
  return fetchTwilioMedia(mediaUrl);
}

// Kenyan SMEs (CLAUDE.md) — the owner's day, not the server's.
const KENYA_TZ = 'Africa/Nairobi';

// "Today" where the owner is. Render runs in UTC, so between midnight and 3am in
// Kenya (UTC+3) the UTC date is still yesterday: a sale logged at 00:30 would be
// filed to the previous day, and once a month to the previous week. en-CA gives
// YYYY-MM-DD, which is the format the DATE column wants anyway.
function todayInKenya() {
  return new Date().toLocaleDateString('en-CA', { timeZone: KENYA_TZ });
}

/**
 * The date to file this transaction under.
 *
 * A text or voice note carrying no date means today — the owner is telling us
 * about something as it happens, and the absence of a *spoken* date is not the
 * absence of a date. Storing NULL there drops the entry out of the weekly
 * summary entirely (it's built on date boundaries), so the owner's totals come
 * out short with nothing to show why. Text is the cheapest capture path and
 * probably the most common, which makes this the quietest way to be wrong.
 *
 * A photo is the opposite case. The receipt carries its own date; if the model
 * couldn't read it, stamping today's date on a receipt that might be weeks old
 * invents a fact. Better a NULL we know about than a date we made up.
 */
function effectiveTransactionDate(source, extraction) {
  const stated = extraction && extraction.transaction_date;
  if (stated && String(stated).trim()) return stated;
  return source === 'photo' ? null : todayInKenya();
}

// `source` is 'photo' | 'voice' | 'text' (from the webhook classifier).
async function processMessage({ source, body, mediaUrl, mediaType }) {
  let extraction;
  let transcript = null;

  if (source === 'photo') {
    const { buffer, contentType } = await getMedia(mediaUrl);
    extraction = await extractFromReceiptImage(buffer, contentType);
  } else if (source === 'voice') {
    const { buffer, contentType } = await getMedia(mediaUrl);
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

  // A greeting or bit of small talk is not a failed extraction — it's simply not
  // a transaction. Callers must not persist these.
  const recordable = isTransaction(extraction);
  const needsReview = recordable && confidence < CONFIDENCE_REVIEW_THRESHOLD;

  return {
    source,
    transcript,
    extraction,
    needsReview,
    isTransaction: recordable,
    // Kept beside the extraction rather than written into it, so raw_extraction
    // stays an honest record of what the model actually said.
    transactionDate: effectiveTransactionDate(source, extraction),
  };
}

// WhatsApp reply matching the tone in CLAUDE.md. (Phase 3 owns the real reply
// generator + persistence; this keeps the loop closed for testing.)
function buildReply({ extraction, needsReview, isTransaction: recordable }) {
  if (!recordable) {
    return "I didn't catch a transaction there. Send me a photo of a receipt, a voice note, or just tell me what you bought or sold — e.g. \"bought stock for 2,400\".";
  }

  const amount = Math.round(Number(extraction.amount) || 0).toLocaleString('en-KE');
  const vendor = extraction.vendor ? `${extraction.vendor}, ` : '';
  const verb = extraction.type === 'sale' ? 'recorded as sale' : `recorded as ${extraction.category}`;

  if (needsReview) {
    return `Got it — ${amount} KES, ${vendor}${verb}. I'm not fully sure I read this right — reply 'review' to confirm or 'fix' to correct.`;
  }
  return `Got it — ${amount} KES, ${vendor}${verb}. Reply 'fix' if wrong.`;
}

module.exports = { processMessage, buildReply, effectiveTransactionDate, todayInKenya };
