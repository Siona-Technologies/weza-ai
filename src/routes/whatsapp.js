const express = require('express');
const twilio = require('twilio');
const { processMessage, buildReply } = require('../services/processMessage');
const { isDbConfigured } = require('../db/pool');
const { findOrCreateBusiness } = require('../repositories/businesses');
const { insertTransaction } = require('../repositories/transactions');

const router = express.Router();

// Persist the extracted transaction. Best-effort: a DB failure must not stop us
// replying to the owner. Skipped entirely when no database is configured.
async function saveTransaction(reqBody, result) {
  // Greetings and small talk aren't transactions — recording them would put
  // 0 KES rows in the owner's books and skew the weekly summary.
  if (!result.isTransaction) {
    console.log('[webhook] no transaction in message — nothing to persist.');
    return;
  }
  if (!isDbConfigured()) {
    console.warn('[webhook] DATABASE_URL not set — skipping persistence.');
    return;
  }
  try {
    const phone = (reqBody.From || '').replace('whatsapp:', '');
    const business = await findOrCreateBusiness({ phone, ownerName: reqBody.ProfileName });
    const tx = await insertTransaction({
      businessId: business.id,
      source: result.source,
      mediaUrl: reqBody.MediaUrl0,
      extraction: result.extraction,
      needsReview: result.needsReview,
    });
    console.log('[webhook] saved transaction', {
      transactionId: tx.id,
      businessId: business.id,
      needsReview: tx.needs_review,
    });
  } catch (err) {
    console.error('[webhook] DB save failed:', err.message);
  }
}

/**
 * Classify an incoming Twilio WhatsApp message into one of the MVP capture
 * sources: 'photo', 'voice', or 'text'. See CLAUDE.md > Architecture.
 */
function classifyMessage(body) {
  const numMedia = parseInt(body.NumMedia || '0', 10);
  if (numMedia > 0) {
    const contentType = body.MediaContentType0 || '';
    if (contentType.startsWith('image/')) return 'photo';
    if (contentType.startsWith('audio/')) return 'voice';
    return 'other';
  }
  return 'text';
}

/**
 * Optional Twilio signature validation. Enabled only when TWILIO_AUTH_TOKEN and
 * PUBLIC_URL are set, so local ngrok testing works without extra config.
 */
function validateTwilio(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const publicUrl = process.env.PUBLIC_URL;
  if (!token || !publicUrl) return true; // not enforced in dev

  const signature = req.headers['x-twilio-signature'];
  const url = `${publicUrl.replace(/\/$/, '')}${req.originalUrl}`;
  return twilio.validateRequest(token, signature, url, req.body);
}

function reply(res, text) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  res.type('text/xml').send(twiml.toString());
}

// Twilio WhatsApp inbound webhook.
router.post('/whatsapp', async (req, res) => {
  if (!validateTwilio(req)) {
    console.warn('[webhook] rejected message with invalid Twilio signature');
    return res.status(403).send('Invalid signature');
  }

  const source = classifyMessage(req.body);

  console.log('[webhook] incoming WhatsApp message', {
    from: req.body.From,
    profileName: req.body.ProfileName,
    source,
    body: req.body.Body,
    numMedia: req.body.NumMedia,
    mediaUrl: req.body.MediaUrl0,
    mediaType: req.body.MediaContentType0,
    messageSid: req.body.MessageSid,
  });

  if (source === 'other') {
    return reply(res, "Sorry, I can only read photos of receipts, voice notes, or text. Please send one of those.");
  }

  // Phase 2: run the AI pipeline (vision / Whisper / categorization) and reply
  // with the parsed transaction. Persistence + weekly summaries land in Phase 3.
  try {
    const result = await processMessage({
      source,
      body: req.body.Body,
      mediaUrl: req.body.MediaUrl0,
      mediaType: req.body.MediaContentType0,
    });

    console.log('[webhook] extracted transaction', {
      from: req.body.From,
      source: result.source,
      transcript: result.transcript,
      isTransaction: result.isTransaction,
      needsReview: result.needsReview,
      extraction: result.extraction,
    });

    // Phase 3: persist to Postgres before replying (best-effort).
    await saveTransaction(req.body, result);

    return reply(res, buildReply(result));
  } catch (err) {
    console.error('[webhook] processing failed:', err.message);
    return reply(res, "Sorry, I couldn't read that one. Please try sending it again.");
  }
});

module.exports = router;
