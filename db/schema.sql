-- BHARAT RESUME — Postgres schema (PRD §13.1)
-- Apply by pasting into Supabase → SQL Editor → New query → Run.
-- Re-running this file is safe: every CREATE uses IF NOT EXISTS.

-- ============================================================
-- Tables
-- ============================================================

-- users — one row per phone hash. We never store the raw phone.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid BOOLEAN DEFAULT FALSE,
  last_active_at TIMESTAMPTZ DEFAULT NOW()
);

-- resumes — one user can have multiple versions; we keep history for telemetry.
CREATE TABLE IF NOT EXISTS resumes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  resume_json JSONB NOT NULL,
  jd_text TEXT,
  jd_keywords JSONB,
  ats_score INT,
  pdf_storage_path TEXT,
  watermarked BOOLEAN DEFAULT TRUE,
  iteration_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- payments — one row per Razorpay payment_link, lifecycle tracked via status.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  razorpay_payment_link_id TEXT,
  razorpay_payment_id TEXT,
  amount INT,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

-- events — telemetry. Every meaningful action. Taxonomy: PRD §13.2.
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  event_name TEXT NOT NULL,
  state_at_event TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_event_name ON events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_user_id_created_at ON events(user_id, created_at);

-- ============================================================
-- Row Level Security — defense in depth
-- ============================================================
-- Our server uses the service_role key, which bypasses RLS. Enabling RLS
-- with no policies means: if the service_role key ever leaks AND an attacker
-- only has access via the public anon key (e.g., through Supabase's
-- auto-generated REST endpoints), they get nothing back. Belt + suspenders.

ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE resumes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE events   ENABLE ROW LEVEL SECURITY;
-- (No policies = deny all for non-service roles. That's intentional.)
