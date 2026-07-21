-- Weza AI database schema (PostgreSQL). Matches CLAUDE.md.
-- Idempotent: safe to run repeatedly (e.g. `npm run migrate` on each Render deploy).

-- Enums. Postgres has no CREATE TYPE IF NOT EXISTS, so guard each one.
DO $$ BEGIN
  CREATE TYPE registration_status AS ENUM ('unregistered', 'registered', 'vat_registered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM ('sale', 'expense');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE capture_source AS ENUM ('photo', 'voice', 'text');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255),
  phone VARCHAR(20) UNIQUE NOT NULL,
  owner_name VARCHAR(255),
  registration_status registration_status DEFAULT 'unregistered',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
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
CREATE INDEX IF NOT EXISTS idx_transactions_raw_extraction ON transactions USING GIN (raw_extraction);

-- The Twilio MessageSid of the message this transaction came from.
--
-- Idempotency key. If the owner resends a receipt (or a webhook is delivered
-- twice), the same MessageSid arrives again — without this, that becomes a
-- second identical transaction and the books silently double-count. Enforced in
-- the database rather than in code so a race between two concurrent deliveries
-- can't slip through. NULLs don't conflict in Postgres, so rows written before
-- this column existed are unaffected.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS message_sid VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_message_sid
  ON transactions (message_sid);

-- Correction state for the 'fix' command.
--
-- Every confirmation reply ends "Reply 'fix' if wrong", so an owner who spots a
-- bad amount answers "fix" and then says what it should be. That second message
-- ("2400") would otherwise look like a brand new transaction and be recorded as
-- one — leaving the wrong entry in place and adding a wrong one beside it. These
-- columns remember which transaction we're waiting on a correction for.
--
-- Deliberately no FK: businesses is created before transactions, and a plain id
-- keeps the schema order simple. A stale id is harmless (the lookup just misses).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS awaiting_fix_transaction_id INT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS awaiting_fix_at TIMESTAMP;

-- Soft delete for the 'undo' command.
--
-- Financial records are not hard-deleted. An owner who removes the wrong entry
-- by mistake has destroyed part of their own books, and there is nothing left to
-- recover it from — so the row stays and every query filters it out instead.
-- That is also what makes 'restore' possible without extra state: the entry to
-- put back is simply the most recently deleted one for that business.
--
-- Deliberately NOT filtered in the message_sid dedupe check: if WhatsApp
-- redelivers a message whose transaction was deleted, that is still the same
-- message, and resurrecting it would undo the owner's decision.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_transactions_live
  ON transactions (business_id, deleted_at);

-- Review state for the 'review' command.
--
-- 'review' walks the owner through every flagged entry one at a time rather than
-- confirming them in bulk: the whole point of needs_review is that a human looks
-- at it, and a single "confirmed all 3" reply is a rubber stamp, not a check.
-- Walking one at a time means each reply ('yes' / 'fix ...') has to be matched
-- against the entry currently on screen, so these columns remember which one
-- that is.
--
-- Separate from awaiting_fix_*: an owner can be mid-review AND answering "what
-- should it be?" for the entry under review, and collapsing both into one pair
-- of columns would lose track of the walk as soon as they corrected something.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS awaiting_review_transaction_id INT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS awaiting_review_at TIMESTAMP;

-- What each inbound message actually consumed: tokens, audio seconds, outbound
-- messages. One row per billable call, several rows per message (a voice note is
-- a transcription AND a categorization AND a reply).
--
-- Kept separate from transactions rather than added as columns, because usage
-- exists for messages that never become transactions — a greeting still costs a
-- categorization call, and those are exactly the costs that would otherwise go
-- unnoticed. business_id is nullable for the same reason: we may not have
-- identified a business yet when the call happens.
--
-- Deliberately stores usage, not money. Prices change and vary by account, so
-- cost is computed at report time from configured rates (src/services/costRates.js).
-- Storing a dollar figure would freeze a guess into the record permanently.
CREATE TABLE IF NOT EXISTS usage_events (
  id SERIAL PRIMARY KEY,
  business_id INT REFERENCES businesses(id),
  message_sid VARCHAR(64),
  kind VARCHAR(32) NOT NULL,      -- vision | categorize | correct | transcribe | whatsapp_out
  provider VARCHAR(32),           -- openai | anthropic | twilio
  model VARCHAR(64),
  input_tokens INT,
  output_tokens INT,
  audio_seconds NUMERIC(10,2),
  messages INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_usage_events_business_created
  ON usage_events (business_id, created_at);

CREATE TABLE IF NOT EXISTS weekly_summaries (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id),
  week_start DATE,
  total_sales DECIMAL(10,2),
  total_expenses DECIMAL(10,2),
  est_vat DECIMAL(10,2),
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One summary per business per week. The job is expected to be re-run — a cron
-- that fires twice, or a manual re-send after a failure — and each run must
-- update that week's row rather than pile up duplicates the owner would be
-- messaged about again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_summaries_business_week
  ON weekly_summaries (business_id, week_start);
