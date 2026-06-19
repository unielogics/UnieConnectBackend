CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS oms_sku_fulfillment_economics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  anchor_warehouse_code TEXT,
  rate_shop_scope TEXT,
  network_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_quality TEXT,
  confidence NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  current_per_unit NUMERIC,
  optimized_per_unit NUMERIC,
  receiving_per_unit NUMERIC,
  prep_lab_per_unit NUMERIC,
  pick_per_unit NUMERIC,
  pack_per_unit NUMERIC,
  order_handling_per_unit NUMERIC,
  storage_per_unit_month NUMERIC,
  domestic_label_per_unit NUMERIC,
  transfer_ltl_per_unit NUMERIC,
  total_per_unit NUMERIC,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  quantity_recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
  pricing_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_id TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

ALTER TABLE oms_sku_fulfillment_economics
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS workflow_type TEXT NOT NULL DEFAULT 'DTC',
  ADD COLUMN IF NOT EXISTS anchor_warehouse_code TEXT,
  ADD COLUMN IF NOT EXISTS rate_shop_scope TEXT,
  ADD COLUMN IF NOT EXISTS network_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_quality TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS current_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS optimized_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS receiving_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS prep_lab_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS pick_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS pack_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS order_handling_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS storage_per_unit_month NUMERIC,
  ADD COLUMN IF NOT EXISTS domestic_label_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS transfer_ltl_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS total_per_unit NUMERIC,
  ADD COLUMN IF NOT EXISTS blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS source_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS quantity_recommendation JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS pricing_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS run_id TEXT,
  ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_sku_econ_unique_current
  ON oms_sku_fulfillment_economics(user_id, item_id, workflow_type, COALESCE(anchor_warehouse_code, ''));

CREATE INDEX IF NOT EXISTS idx_oms_sku_econ_user_item
  ON oms_sku_fulfillment_economics(user_id, item_id, generated_at DESC);
