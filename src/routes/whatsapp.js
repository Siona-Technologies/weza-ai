const express = require('express');
const twilio = require('twilio');
const { processMessage, buildReply } = require('../services/processMessage');
const { sendWhatsApp, isOutboundConfigured } = require('../services/twilioReply');
const { isDbConfigured } = require('../db/pool');
const { findOrCreateBusiness } = require('../repositories/businesses');
const { insertTransaction, findByMessageSid } = require('../repositories/transactions');

const router = express.Router();

const ERROR_TEXT = "Sorry, I couldn't read that one. Please try sending it again.";

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
      messageSid: reqBody.MessageSid,
    });
    // null means the UNIQUE index rejected a duplicate MessageSid — the
    // transaction was already recorded, so this is a no-op, not a failure.
    if (!tx) {
      console.log('[webhook] transaction already recorded for this MessageSid — not saving again.');
      return;
    }
    console.log('[webhook] saved transaction', {
      transactionId: tx.id,
      businessId: business.id,
      needsReview: tx.needs_review,
    });
  } catch (err) {
    console.error('[webhook] DB save failed:', err.message);
  }
}

// Cheap pre-check so a redelivered message doesn't pay for the AI call twice.
// Fails open: the UNIQUE index on message_sid is the real guarantee, so a
// dropped message would be worse than a duplicate attempt here.
async function alreadyRecorded(messageSid) {
  if (!messageSid || !isDbConfigured()) return false;
  try {
    return Boolean(await findByMessageSid(messageSid));
  } catch (err) {
    console.error('[webhook] idempotency check failed:', err.message);
    return false;
  }
}

// The slow part: extract, persist, and work out what to say back.
async function handleMessage(body, source) {
  const started = Date.now();
  const result = await processMessage({
    source,
    body: body.Body,
    mediaUrl: body.MediaUrl0,
    mediaType: body.MediaContentType0,
  });

  console.log('[webhook] extracted transaction', {
    from: body.From,
    source: result.source,
    transcript: result.transcript,
    isTransaction: result.isTransaction,
    needsReview: result.needsReview,
    elapsedMs: Date.now() - started,
    extraction: result.extraction,
  });

  await saveTransaction(body, result);
  return buildReply(result);
}

// Async path: the webhook has already answered Twilio, so nothing here can be
// reported back through the response. Everything must be caught and logged, and
// the owner is told over WhatsApp instead.
async function processAndReply(body, source) {
  let text;
  try {
    text = await handleMessage(body, source);
  } catch (err) {
    console.error('[webhook] processing failed:', err.message);
    text = ERROR_TEXT;
  }
  try {
    const sid = await sendWhatsApp(body.From, text);
    console.log('[webhook] reply sent', { to: body.From, sid });
  } catch (err) {
    // The owner gets nothing. Loud, because it's invisible from their side.
    console.error('[webhook] FAILED TO SEND REPLY:', err.message);
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

// Reply inside the webhook response (TwiML).
function reply(res, text) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(text);
  res.type('text/xml').send(twiml.toString());
}

// Acknowledge without saying anything — the reply comes later, over the REST API.
function ack(res) {
  res.type('text/xml').send('<Response></Response>');
}

// Twilio WhatsApp inbound webhook.
//
// Twilio gives a webhook 15 seconds. Receipt extraction takes 10-23s, so
// answering with the result would mean answering after Twilio has hung up: the
// transaction gets saved, the owner sees no reply, and they resend. So we
// acknowledge immediately and send the reply as a separate outbound message once
// the work is actually done.
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

  // Cheap and instant — no AI involved, so answer in the response.
  if (source === 'other') {
    return reply(res, "Sorry, I can only read photos of receipts, voice notes, or text. Please send one of those.");
  }

  // A redelivery of a message we've already banked. The owner was replied to the
  // first time; saying it again would be noise.
  if (await alreadyRecorded(req.body.MessageSid)) {
    console.log('[webhook] duplicate MessageSid — already recorded, skipping.', {
      messageSid: req.body.MessageSid,
    });
    return ack(res);
  }

  // Without an outbound number there's nowhere to send a later reply from, so
  // fall back to answering in the response. Fine for local curl testing and text
  // (~3s); a photo would still outrun Twilio's 15s.
  if (!isOutboundConfigured()) {
    console.warn('[webhook] TWILIO_WHATSAPP_NUMBER not set — replying synchronously (photos may time out).');
    try {
      return reply(res, await handleMessage(req.body, source));
    } catch (err) {
      console.error('[webhook] processing failed:', err.message);
      return reply(res, ERROR_TEXT);
    }
  }

  // Answer Twilio now, work afterwards. Deliberately not awaited — the response
  // must not wait on the AI call.
  ack(res);
  processAndReply(req.body, source);
});

module.exports = router;
