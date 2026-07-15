// IMPORTANT: load env vars first, before any module that reads them.
require('dotenv').config();

const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[weza-ai] server listening on port ${PORT}`);
  if (!process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[weza-ai] TWILIO_AUTH_TOKEN not set — webhook signature validation is disabled.');
  }
});
