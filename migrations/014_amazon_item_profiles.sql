CREATE TABLE IF NOT EXISTS amazon_item_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES catalog_items(id) ON DELETE CASCADE,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  seller_sku TEXT NOT NULL,
  asin TEXT,
  title TEXT,
  listing_status TEXT NOT NULL DEFAULT 'needs_listing',
  fulfillment_channel TEXT NOT NULL DEFAULT 'UNKNOWN',
  available_fba_qty NUMERIC NOT NULL DEFAULT 0,
  inbound_working_qty NUMERIC NOT NULL DEFAULT 0,
  inbound_shipped_qty NUMERIC NOT NULL DEFAULT 0,
  inbound_receiving_qty NUMERIC NOT NULL DEFAULT 0,
  reserved_qty NUMERIC NOT NULL DEFAULT 0,
  sync_status TEXT NOT NULL DEFAULT 'manual',
  last_amazon_sync_at TIMESTAMPTZ,
  blockers TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, marketplace_id, seller_sku)
);

CREATE INDEX IF NOT EXISTS idx_amazon_item_profiles_user_item ON amazon_item_profiles(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_amazon_item_profiles_user_asin ON amazon_item_profiles(user_id, asin);
CREATE INDEX IF NOT EXISTS idx_amazon_item_profiles_status ON amazon_item_profiles(user_id, listing_status, fulfillment_channel);

CREATE TABLE IF NOT EXISTS amazon_listing_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  marketplace_id TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  seller_sku TEXT NOT NULL,
  asin TEXT,
  product_type TEXT NOT NULL DEFAULT 'PRODUCT',
  fulfillment_channel TEXT NOT NULL DEFAULT 'AMAZON',
  status TEXT NOT NULL DEFAULT 'draft',
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  submission_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amazon_listing_drafts_user_item ON amazon_listing_drafts(user_id, item_id);
CREATE INDEX IF NOT EXISTS idx_amazon_listing_drafts_status ON amazon_listing_drafts(user_id, status);
