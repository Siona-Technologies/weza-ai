const express = require('express');
const whatsappRoutes = require('./routes/whatsapp');

const app = express();

// Twilio posts webhooks as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check (Render + uptime pings).
app.get('/', (req, res) => {
  res.status(200).send('weza-ai is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'weza-ai' });
});

// WhatsApp / Twilio webhook.
app.use('/webhook', whatsappRoutes);

module.exports = app;
