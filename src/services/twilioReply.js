// Sending a WhatsApp reply *after* the webhook has already responded.
//
// The webhook can't wait for us: Twilio hangs up at 15s and receipt extraction
// takes 10-23s, so the reply has to be a fresh outbound message over Twilio's
// REST API instead of TwiML in the webhook response.

const twilio = require('twilio');

// Outbound needs a number to send *from*; TwiML replies didn't, since Twilio
// answered on the same conversation. Without all three we can't send at all, and
// the webhook falls back to replying synchronously (see routes/whatsapp.js).
function isOutboundConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_WHATSAPP_NUMBER
  );
}

let client;
function getClient() {
  if (!client) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

// `to` is the WhatsApp address as Twilio sends it in From, e.g.
// "whatsapp:+254712345678" — pass it through unchanged.
async function sendWhatsApp(to, body) {
  if (!isOutboundConfigured()) {
    throw new Error('Twilio outbound is not configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER).');
  }
  const message = await getClient().messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });

  // Outbound messages are billed per message, and they're easy to forget in a
  // cost model precisely because they're the cheap part — until a chatty review
  // walk sends six of them for one receipt.
  recordUsage({ kind: 'whatsapp_out', provider: 'twilio', messages: 1 });

  return message.sid;
}

module.exports = { sendWhatsApp, isOutboundConfigured };
