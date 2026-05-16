CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS oms_business_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  forecast_horizon_months INTEGER NOT NULL DEFAULT 6,
  current_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  optimized_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  savings JSONB NOT NULL DEFAULT '{}'::jsonb,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_business_plan_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES oms_business_plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, version)
);

CREATE TABLE IF NOT EXISTS oms_inventory_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  horizon_month TEXT NOT NULL,
  channel TEXT,
  demand_region TEXT,
  forecast_units NUMERIC NOT NULL DEFAULT 0,
  confidence NUMERIC NOT NULL DEFAULT 0,
  source JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_inventory_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  plan_id UUID REFERENCES oms_business_plans(id) ON DELETE SET NULL,
  sku TEXT NOT NULL,
  warehouse_code TEXT,
  proposed_units NUMERIC NOT NULL DEFAULT 0,
  executable_units NUMERIC NOT NULL DEFAULT 0,
  min_viable_units NUMERIC NOT NULL DEFAULT 0,
  pallet_cube_ft NUMERIC NOT NULL DEFAULT 0,
  pallet_weight_lbs NUMERIC NOT NULL DEFAULT 0,
  fill_percent NUMERIC NOT NULL DEFAULT 0,
  service_tier TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'projected',
  constraints JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_sku_intelligence_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  item_id TEXT,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_shipment_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  plan_id UUID REFERENCES oms_business_plans(id) ON DELETE SET NULL,
  supplier_id TEXT,
  service_tier TEXT NOT NULL DEFAULT 'standard',
  origin JSONB NOT NULL DEFAULT '{}'::jsonb,
  destination JSONB NOT NULL DEFAULT '{}'::jsonb,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_shipment_wizard_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  supplier_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  requires_bol BOOLEAN NOT NULL DEFAULT true,
  requires_labels BOOLEAN NOT NULL DEFAULT false,
  selected_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  package_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  cortex_routing JSONB NOT NULL DEFAULT '{}'::jsonb,
  shipment_plan_id TEXT,
  asn_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_label_audit_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking_number TEXT,
  finding_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  refund_amount NUMERIC NOT NULL DEFAULT 0,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_execution_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  event_type TEXT NOT NULL,
  source_system TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_copilot_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  screen TEXT NOT NULL,
  prompt TEXT,
  response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_integration_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  system TEXT NOT NULL,
  status TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, system)
);

CREATE INDEX IF NOT EXISTS idx_oms_business_plans_user_status ON oms_business_plans(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_inventory_forecasts_user_sku ON oms_inventory_forecasts(user_id, sku, horizon_month);
CREATE INDEX IF NOT EXISTS idx_oms_allocations_user_sku ON oms_inventory_allocations(user_id, sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_sku_snapshots_user_sku ON oms_sku_intelligence_snapshots(user_id, sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_wizard_user_status ON oms_shipment_wizard_drafts(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_label_findings_user_status ON oms_label_audit_findings(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_ledger_user_created ON oms_execution_ledger(user_id, created_at DESC);
