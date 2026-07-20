const express = require('express');
const twilio = require('twilio');
const { processMessage, buildReply } = require('../services/processMessage');
const { sendWhatsApp, isOutboundConfigured } = require('../services/twilioReply');
const { parseCommand, isAffirmative } = require('../services/commands');
const { correctTransaction } = require('../services/aiProvider');
const { isTransaction } = require('../services/transactionSchema');
const { isDbConfigured } = require('../db/pool');
const {
  findOrCreateBusiness,
  setAwaitingFix,
  clearAwaitingFix,
  pendingFixTransactionId,
  setAwaitingReview,
  clearAwaitingReview,
  pendingReviewTransactionId,
} = require('../repositories/businesses');
const {
  insertTransaction,
  findByMessageSid,
  findById,
  findLatestForBusiness,
  updateTransactionFromExtraction,
  confirmTransaction,
  listNeedsReview,
} = require('../repositories/transactions');

const router = express.Router();

const ERROR_TEXT = "Sorry, I couldn't read that one. Please try sending it again.";
const NO_DB_TEXT = "I can't look up your entries right now — my database isn't connected.";

function businessPhone(body) {
  return (body.From || '').replace('whatsapp:', '');
}

// How an entry is read back to the owner: "2,800 KES, Naivas, stock/inventory".
function describe(tx) {
  const amount = Math.round(Number(tx.amount) || 0).toLocaleString('en-KE');
  const vendor = tx.vendor ? `${tx.vendor}, ` : '';
  return `${amount} KES, ${vendor}${tx.category}`;
}

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
      transactionDate: result.transactionDate,
    });
    // null means the UNIQUE index rejected a duplicate MessageSid — the
    // transaction was already recorded, so this is a no-op, not a failure.
    if (!tx) {
      console.log('[webhook] transaction already recorded for this MessageSid — not saving again.');
      return;
    }
    // A new entry ends any correction the owner started and abandoned; otherwise
    // their next text would be read as a fix to something two receipts back.
    await clearAwaitingFix(business.id);
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

// Rewrite an entry from what the owner says is wrong with it. Used both by
// "fix 2400" in one message and by the reply to "what should it be?".
async function applyCorrection(business, tx, correctionText) {
  const corrected = await correctTransaction(tx.raw_extraction || {}, correctionText);

  // The model reports "I couldn't tell what to change" as a near-zero
  // confidence. Rewriting the entry on a guess would be worse than admitting it,
  // so keep waiting rather than mangling a real transaction.
  if (!isTransaction(corrected)) {
    await setAwaitingFix(business.id, tx.id);
    console.log('[webhook] correction not understood', { transactionId: tx.id, correctionText });
    return `I didn't catch what to change. Your last entry is ${describe(tx)}. Reply with the correct amount, category, or vendor — e.g. "2400", "rent", or "Naivas".`;
  }

  const updated = await updateTransactionFromExtraction(tx.id, corrected);
  await clearAwaitingFix(business.id);
  if (!updated) return "I couldn't update that entry — please try again.";

  console.log('[webhook] applied correction', {
    transactionId: tx.id,
    before: { amount: tx.amount, category: tx.category, vendor: tx.vendor },
    after: { amount: updated.amount, category: updated.category, vendor: updated.vendor },
  });
  return `Updated — ${describe(updated)}.`;
}

// Put the next flagged entry in front of the owner, or close the walk if there
// are none left. `prefix` carries the outcome of what they just did ("Confirmed.
// ", "Updated — 5,400 KES, transport. ") so each reply is one message rather
// than two.
//
// The queue is re-read from the database on every step instead of being held in
// memory: the owner can send a new receipt mid-walk, and re-reading means a
// newly flagged entry joins the queue rather than the walk ending on a stale
// list. It also means nothing to reconcile if a step fails.
async function reviewStep(business, prefix = '') {
  const flagged = await listNeedsReview(business.id);

  if (flagged.length === 0) {
    await clearAwaitingReview(business.id);
    // "All done" only makes sense if they just did something. Someone who says
    // 'review' with a clean book has finished nothing.
    return prefix
      ? `${prefix}All done — nothing left to review.`
      : "Nothing needs checking right now — every entry is confirmed.";
  }

  const next = flagged[0];
  await setAwaitingReview(business.id, next.id);

  const remaining = flagged.length === 1 ? '1 entry' : `${flagged.length} entries`;
  return `${prefix}${remaining} to check:\n${describe(next)}.\nReply 'yes' to confirm, or 'fix ...' to correct it.`;
}

// 'fix' and 'review': the two words every reply invites the owner to send back.
async function handleCommand(body, command) {
  if (!isDbConfigured()) return NO_DB_TEXT;

  const business = await findOrCreateBusiness({
    phone: businessPhone(body),
    ownerName: body.ProfileName,
  });

  // 'review' walks the flagged entries one at a time. It confirms nothing on its
  // own — the owner has to look at each entry and say so, which is the entire
  // point of the needs_review flag.
  if (command.name === 'review') {
    await clearAwaitingFix(business.id);
    return reviewStep(business);
  }

  const last = await findLatestForBusiness(business.id);

  if (!last) {
    return "I don't have any entries for you yet. Send a photo of a receipt, a voice note, or just tell me what you bought or sold.";
  }

  // Bare "fix": show them what we have and wait for the correction.
  if (!command.argument) {
    await setAwaitingFix(business.id, last.id);
    return `Your last entry: ${describe(last)}. What should it be? Reply with the correction — e.g. "2400", "it was rent", or "Naivas".`;
  }

  // "fix 2400" — intent and correction in one message.
  return applyCorrection(business, last, command.argument);
}

// Is this message the answer to a "what should it be?" we asked earlier?
async function pendingCorrection(body) {
  if (!isDbConfigured()) return null;
  const business = await findOrCreateBusiness({
    phone: businessPhone(body),
    ownerName: body.ProfileName,
  });
  const txId = await pendingFixTransactionId(business.id);
  if (!txId) return null;
  const tx = await findById(txId);
  return tx ? { business, tx } : null;
}

// Is there a review walk open, and which entry is on screen?
async function pendingReview(body) {
  if (!isDbConfigured()) return null;
  const business = await findOrCreateBusiness({
    phone: businessPhone(body),
    ownerName: body.ProfileName,
  });
  const txId = await pendingReviewTransactionId(business.id);
  if (!txId) return null;
  const tx = await findById(txId);
  return tx ? { business, tx } : null;
}

// Correct an entry and, if a review walk is open, move on to the next one.
//
// applyCorrection re-arms the fix state when it couldn't tell what to change, so
// that is what we check: still armed means the owner was asked again and the
// walk must stay where it is. Advancing on a correction we failed to apply would
// skip the entry they were trying to fix.
async function correctThenContinue(business, tx, correctionText) {
  const message = await applyCorrection(business, tx, correctionText);

  if (await pendingFixTransactionId(business.id)) return message;
  if (!(await pendingReviewTransactionId(business.id))) return message;

  return reviewStep(business, `${message} `);
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

// One inbound message -> the text to reply with. A message is either a command
// ('fix' / 'review'), a step in an open review walk, the answer to a correction
// we asked for, or a new transaction.
async function handleInbound(body, source) {
  // Only text can be a command. A photo sent mid-correction is a new receipt,
  // not an answer to "what should it be?".
  if (source === 'text') {
    const command = parseCommand(body.Body);

    // 'review' always starts (or restarts) the walk from the top of the queue.
    if (command && command.name === 'review') {
      console.log('[webhook] command', { name: 'review' });
      return handleCommand(body, command);
    }

    // Mid-walk, replies are about the entry on screen — not the newest entry,
    // which is what 'fix' means everywhere else.
    const review = await pendingReview(body);
    if (review) {
      if (isAffirmative(body.Body)) {
        await confirmTransaction(review.tx.id);
        console.log('[webhook] review: confirmed', { transactionId: review.tx.id });
        return reviewStep(review.business, 'Confirmed. ');
      }

      if (command && command.name === 'fix') {
        // "fix 5400" — correct this entry and carry on down the queue.
        if (command.argument) {
          console.log('[webhook] review: correcting', { transactionId: review.tx.id });
          return correctThenContinue(review.business, review.tx, command.argument);
        }
        // Bare "fix" — ask what it should be. Their answer arrives as an
        // ordinary message and rejoins the walk through pendingCorrection below.
        await setAwaitingFix(review.business.id, review.tx.id);
        return `${describe(review.tx)}. What should it be? Reply with the correction — e.g. "2400", "it was rent", or "Naivas".`;
      }
    }

    if (command) {
      console.log('[webhook] command', { name: command.name, argument: command.argument });
      return handleCommand(body, command);
    }

    const pending = await pendingCorrection(body);
    if (pending) {
      console.log('[webhook] treating message as a correction', { transactionId: pending.tx.id });
      return correctThenContinue(pending.business, pending.tx, (body.Body || '').trim());
    }
  }

  return handleMessage(body, source);
}

// Async path: the webhook has already answered Twilio, so nothing here can be
// reported back through the response. Everything must be caught and logged, and
// the owner is told over WhatsApp instead.
async function processAndReply(body, source) {
  let text;
  try {
    text = await handleInbound(body, source);
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
      return reply(res, await handleInbound(req.body, source));
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
