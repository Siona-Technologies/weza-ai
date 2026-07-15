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

## AI extraction (Phase 2)

Each inbound message is routed by type and turned into one structured transaction:

- **photo** → Claude vision reads the receipt directly (no separate OCR)
- **voice** → Whisper transcribes → Claude categorizes the transcript
- **text** → Claude categorizes

Claude uses **structured outputs** so the `category` is always one of the fixed
values (`stock/inventory, rent, utilities, transport, staff wages, sales, other`)
— the model can't invent a category. Extractions below a confidence threshold
(0.7) are flagged `needs_review` and the reply asks the owner to confirm.

Requires `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` for voice notes) in `.env`.
Twilio media URLs are fetched with the account's Basic auth before being sent to
Claude/Whisper. Persistence to Postgres and the weekly summary land in Phase 3.

## Project layout

```
server.js            # entry point — loads .env first, then starts the app
src/app.js           # Express app + middleware + routes
src/routes/whatsapp.js          # Twilio webhook: validate, classify, process, reply
src/services/transactionSchema.js  # shared JSON schema + prompt (fixed categories)
src/services/claude.js          # Claude vision + text categorization
src/services/whisper.js         # OpenAI Whisper voice transcription
src/services/twilioMedia.js     # authenticated fetch of Twilio media
src/services/processMessage.js  # pipeline orchestration + reply generator
.env.example         # environment template (never commit .env)
```
