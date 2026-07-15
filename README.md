# weza-ai

WhatsApp-native AI bookkeeping and eTIMS compliance copilot for Kenyan SMEs — a Siona product.

See [CLAUDE.md](./CLAUDE.md) for the full technical plan, schema, and scope.

## Local development (Phase 1)

Requirements: Node.js 18+.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env   # then fill in values as needed

# 3. Run the server (auto-reload)
npm run dev
# or: npm start
```

The server exposes:

- `GET /` and `GET /health` — health checks
- `POST /webhook/whatsapp` — Twilio WhatsApp inbound webhook (classifies photo /
  voice / text, logs the message, and replies with an acknowledgement)

## Connecting the Twilio WhatsApp sandbox

1. Start the local server (`npm run dev`), default port `3000`.
2. Expose it publicly with ngrok:
   ```bash
   ngrok http 3000
   ```
3. In the [Twilio Console](https://console.twilio.com) → Messaging → Try it out →
   WhatsApp sandbox, set **"When a message comes in"** to:
   ```
   https://<your-ngrok-subdomain>.ngrok-free.app/webhook/whatsapp   (POST)
   ```
4. Join the sandbox from your phone (send the `join <code>` message shown in the
   console), then send a text, photo, or voice note. Watch the server logs.

### Optional: signature validation

Set `TWILIO_AUTH_TOKEN` and `PUBLIC_URL` (your ngrok/Render base URL) in `.env`
to enforce Twilio request-signature validation. If either is unset, validation
is skipped so sandbox testing works out of the box.

## Project layout

```
server.js            # entry point — loads .env first, then starts the app
src/app.js           # Express app + middleware + routes
src/routes/whatsapp.js  # Twilio WhatsApp webhook (receive + classify + log)
.env.example         # environment template (never commit .env)
```
