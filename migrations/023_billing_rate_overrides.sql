CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Approved "AI billing plan" rate overrides. When a seller approves a billing recommendation on the
-- OMS Billing screen, the approved per-category reduction is persisted here as a PCT (fraction).
-- getBillingProfit reads active overrides to compute the "optimized / you save" projection — so the
-- savings number reflects only what has actually been approved (and collapses to $0 when nothing is
-- approved), replacing the old cosmetic hardcoded multipliers.
--
-- ADVISORY PROJECTION ONLY: this does NOT change what the WMS actually bills. `current` stays WMS
-- truth; `optimized` = current * (1 - pct_override) is a projection surfaced to the seller.
CREATE TABLE IF NOT EXISTS billing_rate_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,                       -- freight | storage | handling | accessorials | materials
  warehouse_code TEXT,                          -- NULL = applies to the whole category (all warehouses)
  pct_override NUMERIC NOT NULL DEFAULT 0,      -- fraction, e.g. 0.16 = 16% reduction; optimized = current*(1-pct)
  flat_override NUMERIC,                        -- optional absolute-delta alternative (unused for now)
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',        -- active | superseded | revoked
  source_recommendation_id UUID REFERENCES oms_recommendations(id) ON DELETE SET NULL,
  source_action_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,  -- itemized action, carrier/lane/tier rationale
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one ACTIVE override per (user, category, warehouse). Guarantees idempotent approvals — a
-- plan-level approval and a per-category approval rewrite the same row instead of stacking, so
-- savings can never double-count. COALESCE folds NULL warehouse_code to '' for the uniqueness key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_rate_overrides_active_unique
  ON billing_rate_overrides (user_id, category, COALESCE(warehouse_code, ''))
  WHERE status = 'active';

-- Lookup index for the read path (getBillingProfit loads active overrides windowed by effective_from).
CREATE INDEX IF NOT EXISTS idx_billing_rate_overrides_lookup
  ON billing_rate_overrides (user_id, status, effective_from);
