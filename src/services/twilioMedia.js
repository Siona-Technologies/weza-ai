// Twilio media URLs (MediaUrl0, etc.) are protected by HTTP Basic auth using
// the account SID + auth token. We fetch the bytes ourselves before handing
// them to Claude (vision) or Whisper (audio) — a bare URL would 401.

async function fetchTwilioMedia(url) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set — cannot fetch media.');
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

  if (!res.ok) {
    throw new Error(`Failed to fetch Twilio media (${res.status} ${res.statusText}) from ${url}`);
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

module.exports = { fetchTwilioMedia };
