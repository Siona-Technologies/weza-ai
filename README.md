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

Note that ngrok's free tier issues a **new URL every restart**, so step 3 has to
be repeated each session. The `join` code expires after 72 hours.

### Optional: signature validation

Set `TWILIO_AUTH_TOKEN` and `PUBLIC_URL` (your ngrok/Render base URL) in `.env`
to enforce Twilio request-signature validation. If either is unset, validation
is skipped so sandbox testing works out of the box.

### How replies are sent

**Twilio gives a webhook 15 seconds. Receipt extraction takes 10–23s.** Replying
with the result would mean replying after Twilio has hung up: the transaction is
saved, the owner sees nothing, they resend — and a resend is a new message, so
it becomes a second transaction and the books double-count silently.

So the webhook **acknowledges immediately** (empty `<Response/>`, ~200ms) and the
reply is sent afterwards as a separate outbound message over Twilio's REST API,
once the work is actually finished.

This needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` **and**
`TWILIO_WHATSAPP_NUMBER` — a number to send *from*, which TwiML replies never
needed. Without all three, the webhook logs a warning and falls back to replying
in the response, which keeps local `curl` testing working but will time out on
photos.

`MessageSid` is stored on each transaction under a UNIQUE index, so a redelivered
webhook can't write the same transaction twice. Note this guards against Twilio
*redelivering* a message — it can't help if the owner photographs the same
receipt again, since that's a genuinely new message. Getting the reply to them
reliably is what prevents that.

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

### The owner commands: `fix`, `review`, `summary` and `undo`

**`fix`** corrects the most recent entry, either in one message (`fix 2400`) or
as a short exchange (`fix` → "what should it be?" → `it was rent`).

**`review`** walks every flagged entry, oldest first, one at a time:

```
owner: review
bot:   3 entries to check:
       27,650 KES, BRAZ ELECTRONIC SUPPLIERS, stock/inventory.
       Reply 'yes' to confirm, or 'fix ...' to correct it.
owner: yes
bot:   Confirmed. 2 entries to check: ...
```

It confirms nothing on its own. The point of `needs_review` is that a person
looks at the entry, and a single "confirmed all 3" reply is a rubber stamp rather
than a check — so each entry needs its own answer.

Mid-walk, `fix` targets **the entry on screen**, not the newest one, and the walk
resumes automatically once the correction lands. A correction the model couldn't
understand leaves the walk where it is rather than skipping the entry. Plain
agreement (`yes`, `ok`, `sawa`, `ndio`) only counts as confirmation while a walk
is open — out of nowhere, "ok" is ordinary conversation, not a command.

The walk expires after 30 minutes (longer than `fix`'s 15, since a walk is
several exchanges), so an abandoned review can't swallow tomorrow's messages.

**`summary`** answers with the owner's totals on demand. `summary`, `totals`,
`total` and `report` all work, optionally followed by a period:

```
owner: summary
bot:   This week: 40,000 KES sales, 27,650 KES expenses. Net: 12,350 KES.
       Est. VAT: 6,400 KES.
owner: summary today
bot:   Today: nothing recorded yet. Send a photo of a receipt, a voice note,
       or just tell me what you bought or sold.
```

Periods: nothing (the week in progress), `today` (or `leo`), `last week`, and
`month`. Filler words are tolerated — "totals for the month" is the same as
`summary month`.

Bare `summary` means the week **in progress**, not the last complete one: it
answers the question someone asks mid-week. The scheduled job is the opposite —
it reports the week just finished.

Anything after the command that isn't a recognised period means it was never a
report request, and the message falls through to normal extraction. `total 5000`
records a 5,000 transaction; it does not print a report. Swallowing a real
transaction as a mistyped command would lose the owner's money, so the match is
kept deliberately narrow.

The daily figure omits Est. VAT. VAT is a periodic liability, not a daily one,
and putting it against a single day's takings invites reading it as money owed
today. Reading the totals also leaves an open `fix` or `review` walk exactly
where it was.

**`undo`** (also `delete`, `remove`, `cancel`) takes an entry out of the books —
the newest one, or, mid-review, the one on screen:

```
owner: undo
bot:   Removed: 134,680 KES, Tronic Kenya Limited, stock/inventory.
       Reply 'restore' if that was a mistake.
owner: restore
bot:   Back in: 134,680 KES, Tronic Kenya Limited, stock/inventory.
```

**Nothing is actually deleted.** `deleted_at` is set and every query that counts
money filters the row out. An owner who removes the wrong entry has destroyed
part of their own books, and a hard delete leaves nothing to recover from — so
the row stays. `restore` puts back the most recently removed entry, which needs
no extra state: `deleted_at` is itself the record of what went last.

That is also why `undo` doesn't ask "are you sure?" first. A confirmation step
costs a round trip on every legitimate delete to guard against a rare mistake;
because the delete is reversible, the common case stays one message.

Like `review`, only the bare word counts — "delete the old stock 2000" is a
message about stock and is recorded as one.

The dedupe check on `message_sid` deliberately still sees deleted rows. If
WhatsApp redelivers a message whose entry the owner removed, that is the same
message, and re-creating it would quietly overrule them.

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

### Timeouts and retries

Both SDKs already retry `408`, `409`, `429` and `5xx` with exponential backoff,
honouring `retry-after`. There is deliberately **no retry loop of our own** — a
second layer would multiply against theirs (3 × 3 = 9 attempts during an outage)
instead of adding resilience.

What we do set is the defaults, in `src/services/aiClientOptions.js`:

| Setting | Default | Why |
|---|---|---|
| `AI_TIMEOUT_MS` | `45000` | The SDK default is **10 minutes**. Since replies are async, a hung request just leaves the owner with no answer and no error. Real extractions take 4–23s. |
| `AI_MAX_RETRIES` | `2` | SDK default. Worst case before the owner is told we failed ≈ timeout × 3 + backoff. |

Retries are logged (`[claude] ... retrying, 1 attempts remaining`); ordinary
requests aren't, so a retry stands out as the signal it is. Auth failures (401)
are never retried — that's a dead key, not a bad minute.

## Receipt images

The photo used to be read by the vision model and thrown away. `raw_media_url`
held a *Twilio* link — which needs our Twilio credentials to open, and which
Twilio eventually deletes — so a disputed entry had no evidence behind it, in a
product whose whole job is keeping records.

Photos are now uploaded to Cloudinary and the reference stored on the
transaction (`image_url`, `image_public_id`). Set `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY` and `CLOUDINARY_API_SECRET` to switch it on.

**Without those keys nothing breaks** — the receipt simply isn't kept, exactly as
before, and the log says so. The same is true if the upload fails: the numbers
are already extracted by that point, and losing the transaction because a third
party was slow would be a far worse outcome than losing the picture. Both
columns stay NULL and the entry is saved regardless.

**Receipts are not on a public URL.** They are uploaded as `authenticated`, so
the stored URL can't be fetched by anyone who has it; viewing one needs a signed,
time-limited link generated by `signedUrlFor()` (15 minutes by default).
Cloudinary's default is public delivery, which would put customer receipts —
vendor, amounts, sometimes a KRA PIN — on a guessable public address.

Each business gets its own subfolder, so everything belonging to one owner can be
found and deleted in one place. `deleteBusinessImages()` exists for that reason:
a data deletion request is a legal obligation, and discovering there was no way
to honour one would be the wrong moment to find out.

Only photos are kept. Voice notes are transcribed and the audio discarded — it is
the more sensitive recording of the two and we have no use for it afterwards.

Where the images physically live is still an open question (Kenya's Data
Protection Act constrains moving personal data abroad), so it is deliberately not
hardcoded: the account's region and `CLOUDINARY_FOLDER` carry it, which makes
answering that question configuration rather than a migration.

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

## Weekly summary

```bash
npm run summary                       # last complete week, sends over WhatsApp
npm run summary -- --dry-run          # print what would be sent, send nothing
npm run summary -- --this-week        # the week in progress (testing)
npm run summary -- --week=2026-07-06  # a specific week (must be a Monday)
```

Run it from a scheduler (Render Cron, or plain cron) rather than an in-process
timer, so it doesn't depend on the web service being awake. Weeks start Monday,
in **Africa/Nairobi** — Render runs UTC, and a summary generated at 00:30 in
Kenya would otherwise be filed to the previous week.

Businesses with no transactions that week are skipped; nobody needs telling they
recorded nothing. Re-runs update that week's row rather than duplicating it
(UNIQUE on `business_id, week_start`), so a cron that fires twice is harmless.

Transactions are counted by `transaction_date`, falling back to the day they were
captured. That fallback matters: a photo whose date the model couldn't read
stores NULL (we don't invent dates), and without it those receipts would fall out
of every week forever.

### Two things to know before relying on it

**Est. VAT is 16% of sales, with no credit for input VAT** — matching the worked
example in CLAUDE.md (45,000 sales, 12,000 expenses → "Est. VAT: 7,200"). A
VAT-registered business actually owes output minus input VAT, which on those
numbers is 5,280, so this **overstates** the liability. It's labelled "Est." and
most of the target segment isn't VAT-registered, so it reads as an exposure
estimate rather than a filing figure. `estimateVat()` in
`src/services/weeklySummary.js` is the one line to change.

**Sending needs an approved template.** WhatsApp only allows free-form messages
within 24 hours of the owner's last message. The weekly summary is
business-initiated by definition, so outside that window Meta requires a
pre-approved template — on Twilio exactly as on Meta directly. Until one is
approved, summaries reach only owners who happened to message in the last day.
Twilio reports this as error `63016`, which the job calls out explicitly.

## Cost per transaction

```bash
npm run cost               # last 30 days, per business
npm run cost -- --days=7
```

Answers the question pricing depends on: **if a shop sends 100 receipts a month,
what does that cost us?** Every inbound message records what it consumed —
vision/categorization tokens, Whisper audio seconds, outbound messages — into
`usage_events`, one row per billable call.

Usage is measured exactly. **Prices are not hardcoded**, because they change,
vary by region and vary by account; a plausible-looking default would produce a
confidently wrong report that pricing decisions then get made on. Rates come from
the environment (see `.env.example`) and anything unset is reported as UNKNOWN,
with the report stating plainly that its total is an under-count:

```
!!  INCOMPLETE — these rates are not configured, so the figures above
    are an UNDER-COUNT, not a total:
      COST_ANTHROPIC_INPUT_PER_MTOK
```

Fill the rates in from your own OpenAI, Anthropic and Twilio invoices. Set
`USD_TO_KES` to also see shillings.

Two things worth knowing before reading a report:

**The system prompt dominates short messages.** A five-word text still sends the
whole extraction prompt — about 2,500 input tokens against ~100 output. Cost per
message is therefore fairly flat regardless of message length, and photos are the
expensive case because the image adds to that floor.

**Usage tracking can never fail a message.** It runs inside an
`AsyncLocalStorage` context and every write is best-effort — if the database is
down or a provider stops returning usage, the receipt is still processed and
answered. Bookkeeping about bookkeeping must not be what loses someone's receipt.

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
