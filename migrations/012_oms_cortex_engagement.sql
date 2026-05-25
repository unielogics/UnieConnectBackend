-- 012_oms_cortex_engagement.sql
-- Extends oms_cortex_credentials with the fields needed for the
-- Cortex-driven intelligence loop:
--   * cortex_engagement_id   — opaque id of the parent engagement Cortex
--                              requires for seller-optimization runs
--   * intelligence_tier      — demo | fast | standard | slow (controls
--                              refresh cadence on the Cortex side scheduler)
--   * next_intelligence_run_at — last-scheduled-at + interval(tier).
--                              Surfaced in the UI as "next refresh".
--   * webhook_secret_hash    — sha256 of the per-tenant HMAC secret used to
--                              verify Cortex -> UnieConnect callback bodies.
--                              Raw secret is stored encrypted on the Cortex side.

ALTER TABLE oms_cortex_credentials
  ADD COLUMN IF NOT EXISTS cortex_engagement_id TEXT,
  ADD COLUMN IF NOT EXISTS intelligence_tier TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS next_intelligence_run_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_intelligence_run_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_secret_hash TEXT;

-- Restrict tier values without using a Postgres enum (cheap to change later).
ALTER TABLE oms_cortex_credentials
  DROP CONSTRAINT IF EXISTS oms_cortex_credentials_intelligence_tier_chk;
ALTER TABLE oms_cortex_credentials
  ADD CONSTRAINT oms_cortex_credentials_intelligence_tier_chk
  CHECK (intelligence_tier IN ('demo', 'fast', 'standard', 'slow'));

CREATE INDEX IF NOT EXISTS idx_oms_cortex_credentials_tier_next
  ON oms_cortex_credentials(intelligence_tier, next_intelligence_run_at);

-- Persist the cortex_run_id returned by Cortex so the webhook can match
-- the inbound callback to the right oms_intelligence_runs row.
ALTER TABLE oms_intelligence_runs
  ADD COLUMN IF NOT EXISTS cortex_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_oms_intelligence_runs_cortex_run
  ON oms_intelligence_runs(cortex_run_id)
  WHERE cortex_run_id IS NOT NULL;
