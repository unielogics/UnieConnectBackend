CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS oms_pricing_intelligence_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'completed',
  rate_shop_scope TEXT,
  network_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  warehouse_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  recommended_warehouse_code TEXT,
  source_quality TEXT,
  pricing_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC NOT NULL DEFAULT 0,
  due_today NUMERIC NOT NULL DEFAULT 0,
  run_id TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

ALTER TABLE oms_pricing_intelligence_snapshots
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS rate_shop_scope TEXT,
  ADD COLUMN IF NOT EXISTS network_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS warehouse_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS recommended_warehouse_code TEXT,
  ADD COLUMN IF NOT EXISTS source_quality TEXT,
  ADD COLUMN IF NOT EXISTS pricing_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS due_today NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS run_id TEXT,
  ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_oms_pricing_snapshots_user_generated
  ON oms_pricing_intelligence_snapshots(user_id, generated_at DESC);
