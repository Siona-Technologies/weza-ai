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
# PowerShell: copy .env.example .env

# 3. Run the server (auto-reload)
npm run dev
# or: npm start
```

The server exposes:

- `GET /` and `GET /health` — health checks
- `POST /webhook/whatsapp` — Twilio WhatsApp inbound webhook (classifies photo /
  voice / text, logs the message, and replies with an acknowledgement)

## Testing locally without API keys (mock mode)

You can exercise the whole pipeline — classify → extract → (save) → reply —
with **no API keys and no cost** by setting `MOCK_AI=true` in `.env`. Extraction
is stubbed (keyword heuristics for text, canned results for photo/voice).

With `MOCK_AI=true` in `.env`, no prefix is needed on any command:

```bash
node scripts/test-extract.js text "Sold 3 sodas for 150 KES"
node scripts/test-extract.js image ./anything.jpg   # file bytes ignored in mock
node scripts/test-extract.js voice ./anything.ogg

npm run dev   # full server + webhook, mock mode
# then POST to http://localhost:3000/webhook/whatsapp (see fields below)
```

To enable mock mode for one command only, without touching `.env` — note that
**the syntax differs by shell**:

```bash
# bash / zsh / Git Bash
MOCK_AI=true npm run dev
```

```powershell
# PowerShell — no inline VAR=value prefix exists; set it as a statement first
$env:MOCK_AI="true"; npm run dev
$env:MOCK_AI=""              # unset it again
```

A shell variable **overrides** `.env` (dotenv never clobbers an existing env
var), so if `$env:MOCK_AI` is set, it wins over the file for that whole session.

**Levels of local testing:**

| What you want to test | What you need |
|---|---|
| Whole flow + replies (stubbed AI) | `MOCK_AI=true` — nothing else |
| Real receipt/voice extraction | `ANTHROPIC_API_KEY` (+ `OPENAI_API_KEY` for voice) |
| Persistence to Postgres | `DATABASE_URL` + `npm run migrate` (free cloud Postgres works) |
| Real WhatsApp messages | Twilio sandbox + ngrok (below) |

Turn `MOCK_AI` off (or remove it) to use the real Claude/Whisper path.

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

- **photo** → vision reads the receipt directly (no separate OCR)
- **voice** → Whisper transcribes → the transcript is categorized
- **text** → categorized directly

Both vendors use **structured outputs** so the `category` is always one of the
fixed values (`stock/inventory, rent, utilities, transport, staff wages, sales,
other`) — the model can't invent a category. Extractions below a confidence
threshold (0.8) are flagged `needs_review` and the reply asks the owner to
confirm.

Twilio media URLs are fetched with the account's Basic auth before the bytes are
sent to the model.

### Choosing the AI provider

Vision + categorization run on whichever vendor `AI_PROVIDER` selects. **Voice is
always Whisper (OpenAI)** either way, so `OPENAI_API_KEY` is needed regardless.

| `AI_PROVIDER` | Vision + categorization | Key needed |
|---|---|---|
| `anthropic` (default) | Claude (`CLAUDE_MODEL`, default `claude-opus-4-8`) | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI (`OPENAI_MODEL`, default `gpt-5.6-terra`) | `OPENAI_API_KEY` |

Both providers return the identical schema, so nothing downstream changes — the
flag exists to score them against the same receipts before committing to one:

```powershell
# Same receipt, both vendors — compare amount, date and confidence
node scripts/test-extract.js image .\receipt2.png
$env:AI_PROVIDER="openai"; node scripts/test-extract.js image .\receipt2.png
$env:AI_PROVIDER=""       # back to the default
```

Handwritten receipts are the hard case and the one that decides this — a vendor
that reads printed invoices perfectly can still lose on a creased handwritten
one. Compare on those before switching.

## Database (Phase 3)

Transactions are persisted to PostgreSQL. Each message finds-or-creates a
business by its WhatsApp phone number, then inserts one transaction with the
full AI output (`raw_extraction` JSONB), `confidence_score`, and the
`needs_review` flag. The app runs without a database too — persistence is
skipped when `DATABASE_URL` is unset, so local extraction testing needs no DB.

Set up the schema:

```bash
# 1. Point DATABASE_URL at a Postgres instance in .env
#    (Render managed Postgres, or a local Postgres for dev)
# 2. Apply the schema (idempotent — safe to re-run)
npm run migrate
```

On **Render**: create a managed Postgres, copy its connection string into the
web service's `DATABASE_URL` env var, and run `npm run migrate` (or add it as a
build/deploy step). Set the service **Root Directory** to the backend folder if
a separate frontend is ever added (CLAUDE.md deploy conventions).

## Project layout

```
server.js            # entry point — loads .env first, then starts the app
src/app.js           # Express app + middleware + routes
src/routes/whatsapp.js          # Twilio webhook: validate, classify, process, persist, reply
src/services/transactionSchema.js  # shared JSON schema + prompt (fixed categories)
src/services/claude.js          # Claude vision + text categorization
src/services/whisper.js         # OpenAI Whisper voice transcription
src/services/twilioMedia.js     # authenticated fetch of Twilio media
src/services/processMessage.js  # pipeline orchestration + reply generator
src/db/pool.js                  # Postgres connection pool (optional / graceful)
src/repositories/businesses.js  # find-or-create business by phone
src/repositories/transactions.js # insert transaction + running totals
db/schema.sql                   # database schema (enums, tables, index)
scripts/migrate.js              # applies db/schema.sql  (npm run migrate)
scripts/test-extract.js         # local AI test harness   (npm run test:extract)
.env.example         # environment template (never commit .env)
```
