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

CREATE TABLE IF NOT EXISTS weekly_summaries (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES businesses(id),
  week_start DATE,
  total_sales DECIMAL(10,2),
  total_expenses DECIMAL(10,2),
  est_vat DECIMAL(10,2),
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
