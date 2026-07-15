const express = require('express');
const twilio = require('twilio');

const router = express.Router();

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

// Twilio WhatsApp inbound webhook.
router.post('/whatsapp', (req, res) => {
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

  // Phase 1: acknowledge receipt. Real AI extraction + replies land in Phase 2/3.
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message('Weza AI received your message — full bookkeeping features are coming soon.');

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
