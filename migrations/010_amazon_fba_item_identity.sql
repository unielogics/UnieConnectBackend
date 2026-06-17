CREATE TABLE IF NOT EXISTS amazon_item_profiles (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  seller_sku TEXT NOT NULL,
  asin TEXT,
  listing_status TEXT NOT NULL DEFAULT 'needs_listing',
  fulfillment_channel TEXT NOT NULL DEFAULT 'unknown',
  fba_available_quantity NUMERIC NOT NULL DEFAULT 0,
  fba_inbound_quantity NUMERIC NOT NULL DEFAULT 0,
  fba_reserved_quantity NUMERIC NOT NULL DEFAULT 0,
  fba_researching_quantity NUMERIC NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  last_amazon_sync_at TIMESTAMPTZ,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_profiles_user_market_sku
  ON amazon_item_profiles(user_id, marketplace_id, seller_sku);
CREATE INDEX IF NOT EXISTS idx_amazon_profiles_user_item
  ON amazon_item_profiles(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_amazon_profiles_user_status
  ON amazon_item_profiles(user_id, listing_status, fulfillment_channel, sync_status);

CREATE TABLE IF NOT EXISTS amazon_listing_drafts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  seller_sku TEXT NOT NULL,
  asin TEXT,
  product_type TEXT,
  fulfillment_channel TEXT NOT NULL DEFAULT 'FBA',
  status TEXT NOT NULL DEFAULT 'draft',
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  submission_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amazon_listing_drafts_user_item
  ON amazon_listing_drafts(user_id, item_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_amazon_listing_drafts_user_status
  ON amazon_listing_drafts(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS amazon_fba_workflows (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  shipment_wizard_draft_id TEXT REFERENCES oms_shipment_wizard_drafts(id) ON DELETE SET NULL,
  shipment_plan_id TEXT REFERENCES shipment_plans(id) ON DELETE SET NULL,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  status TEXT NOT NULL DEFAULT 'draft',
  prep_owner TEXT NOT NULL DEFAULT 'SELLER',
  label_owner TEXT NOT NULL DEFAULT 'SELLER',
  carton_content_source TEXT NOT NULL DEFAULT 'BOX_CONTENT_PROVIDED',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation JSONB NOT NULL DEFAULT '{}'::jsonb,
  amazon_references JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amazon_fba_workflows_user_status
  ON amazon_fba_workflows(user_id, status, updated_at DESC);
