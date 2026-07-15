# Weza AI

WhatsApp-first AI bookkeeping and tax-compliance assistant for Kenyan SMEs. A business
owner sends a photo of a receipt, a voice note, or a text describing a sale/expense over
WhatsApp. The system extracts and categorizes the transaction with AI, tracks running
totals, and sends back a weekly summary with an estimated VAT position — no app download,
no dashboard login required for the MVP.

## Current stage

This is a fresh build, MVP scope only (see "Explicitly out of scope" below). Validation
conversations with real SME owners are running in parallel with this build — the technical
plan assumes that validation, it doesn't wait on it.

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node.js + Express | |
| Database | PostgreSQL | Hosted on Render (one-click managed Postgres). Chosen over MySQL specifically for native JSONB support — see schema below. |
| Messaging | Twilio WhatsApp API | Sandbox for local dev, real WhatsApp Business number for pilot. |
| Receipt parsing | Claude API (vision) | Send the receipt image directly, no custom OCR. |
| Voice parsing | Whisper (OpenAI) | Transcribe first, then pass transcript through the same categorization step as text. |
| Categorization | Claude API | Structures parsed input into fixed transaction fields; must only pick from the fixed category list below, never invent categories. |
| Image storage | Cloudinary | Multer-based upload, same pattern as prior projects. |
| Hosting | Render | Root Directory must point at the backend subfolder if the repo has a separate frontend later. |

## Environment and deploy conventions (lessons carried over from prior projects)

- `.env` must be loaded first in `server.js`, before any other requires that depend on env vars.
- Never let a nested `.git` folder end up inside a subdirectory — it causes push conflicts.
- On Render, explicitly set Root Directory to the backend folder if the repo isn't backend-only.
- Keep secrets (Twilio, Claude API, Cloudinary, DB connection string) in `.env`, never committed.

## Architecture / message flow

```
WhatsApp (owner) -> Twilio webhook -> Express backend (Render)
  -> image message -> Claude vision -> categorization -> Postgres + Cloudinary
  -> voice message -> Whisper -> categorization -> Postgres
  -> text message  -> categorization -> Postgres
Backend -> scheduled weekly job -> summary message -> WhatsApp (owner)
```

Fixed expense/sale category list (do not let the model invent new ones):
stock/inventory, rent, utilities, transport, staff wages, sales, other.

## Database schema (PostgreSQL)

```sql
CREATE TYPE registration_status AS ENUM ('unregistered', 'registered', 'vat_registered');
CREATE TYPE transaction_type AS ENUM ('sale', 'expense');
CREATE TYPE capture_source AS ENUM ('photo', 'voice', 'text');

CREATE TABLE businesses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  phone VARCHAR(20) UNIQUE NOT NULL,
  owner_name VARCHAR(255),
  registration_status registration_status DEFAULT 'unregistered',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id),
  type transaction_type NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  category VARCHAR(100),
  vendor VARCHAR(255),
  raw_source capture_source NOT NULL,
  raw_media_url VARCHAR(500),
  raw_extraction JSONB,          -- full structured AI output: vendor, amount, date, extracted text
  confidence_score DECIMAL(3,2),
  needs_review BOOLEAN DEFAULT FALSE,
  transaction_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_transactions_raw_extraction ON transactions USING GIN (raw_extraction);

CREATE TABLE weekly_summaries (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id),
  week_start DATE,
  total_sales DECIMAL(10,2),
  total_expenses DECIMAL(10,2),
  est_vat DECIMAL(10,2),
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

`needs_review` is the trust mechanism: any extraction below a confidence threshold
(start at 0.7) gets flagged for the owner to confirm rather than silently recorded wrong.

## MVP scope

**In scope**
- WhatsApp capture: photo, voice note, text
- AI categorization into the fixed category list
- Running per-business totals
- Weekly summary message with estimated VAT
- Confidence-based review flagging

**Explicitly out of scope for MVP — do not build yet**
- Web dashboard
- Real-time eTIMS invoice transmission / KRA QR code integration
- Multi-user or staff access
- Any auth system beyond identifying a business by WhatsApp phone number

## Build order (matches the 8-week roadmap)

1. Repo scaffold, Express skeleton, Twilio sandbox + webhook receiving/logging via ngrok
2. Claude vision wired to receipt photos; Whisper wired to voice notes; categorization prompt
3. Postgres schema live on Render; transaction inserts with confidence scoring; reply generator
4. Deploy to Render with real Twilio webhook; onboard first pilot businesses

## Reply tone (WhatsApp messages back to the owner)

Short, specific, WhatsApp-native. Example:
> Got it — 850 KES, Naivas, recorded as stock purchase. Reply 'fix' if wrong.

Weekly summary example:
> This week: 45,000 KES sales, 12,000 KES expenses. Est. VAT: 7,200 KES. 3 items need your confirmation — reply 'review'.

## Competitive context (for framing product decisions, not for copying)

Existing Kenyan players (LedgerFlow, ZYNO Books, Cute Profit, Veira, Qwan, Odibooks) are
largely dashboard/POS-first with automation added on top. KRA also runs its own WhatsApp
eTIMS chatbot for direct invoice generation. Weza AI's differentiation is being WhatsApp-native
end-to-end with zero dashboard requirement, AI-first extraction from photo/voice rather than
manual entry, and targeting the non-VAT informal-to-formal segment that assumed exemption.
