CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS marketplace_connections (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  display_name TEXT,
  shop_domain TEXT,
  selling_partner_id TEXT,
  marketplace_id TEXT,
  external_account_id TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TIMESTAMPTZ,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_uom TEXT,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  supplier_id TEXT,
  image TEXT,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  upc TEXT,
  ean TEXT,
  asin TEXT,
  category TEXT,
  sub_category TEXT,
  lob TEXT,
  weight NUMERIC,
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  archived BOOLEAN NOT NULL DEFAULT false,
  wms_inventory JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, sku)
);

CREATE TABLE IF NOT EXISTS item_channel_mappings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  channel_item_id TEXT NOT NULL,
  channel_variant_id TEXT,
  sku TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  channel TEXT,
  external_customer_id TEXT,
  addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_channel_mappings (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  external_customer_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, channel, external_customer_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  channel_connection_id TEXT REFERENCES marketplace_connections(id) ON DELETE SET NULL,
  channel TEXT,
  external_order_id TEXT,
  order_number TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  paid TEXT,
  placed_at TIMESTAMPTZ,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  billing_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  tracking_number TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES catalog_items(id) ON DELETE SET NULL,
  sku TEXT,
  title TEXT,
  quantity NUMERIC NOT NULL DEFAULT 0,
  unit_price NUMERIC NOT NULL DEFAULT 0,
  total_price NUMERIC NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ship_from_locations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  facility_type TEXT NOT NULL DEFAULT 'warehouse',
  status TEXT NOT NULL DEFAULT 'active',
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  latitude NUMERIC,
  longitude NUMERIC,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, code)
);

CREATE TABLE IF NOT EXISTS shipment_plans (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
  ship_from_location_id TEXT REFERENCES ship_from_locations(id) ON DELETE SET NULL,
  facility_id TEXT REFERENCES facilities(id) ON DELETE SET NULL,
  internal_shipment_id TEXT,
  shipment_title TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  prep_services_only BOOLEAN NOT NULL DEFAULT false,
  marketplace_id TEXT,
  marketplace_type TEXT,
  order_no TEXT,
  receipt_no TEXT,
  order_date TIMESTAMPTZ,
  estimated_arrival_date TIMESTAMPTZ,
  ship_from_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shipment_activity_log (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  shipment_plan_id TEXT REFERENCES shipment_plans(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  summary TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asns (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  shipment_plan_id TEXT REFERENCES shipment_plans(id) ON DELETE SET NULL,
  asn_number TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  shipment_plan_id TEXT REFERENCES shipment_plans(id) ON DELETE SET NULL,
  invoice_id TEXT,
  description TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'open',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'oms',
  status TEXT NOT NULL DEFAULT 'active',
  price NUMERIC NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_features (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'enabled',
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(user_id, feature_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invite_tokens (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'ecommerce_client',
  created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  used_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  note TEXT NOT NULL,
  body TEXT,
  author_id TEXT,
  pinned BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transportation_templates (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ltl',
  service_tier TEXT NOT NULL DEFAULT 'standard',
  origin JSONB NOT NULL DEFAULT '{}'::jsonb,
  destination JSONB NOT NULL DEFAULT '{}'::jsonb,
  package_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_accounts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_warehouse_links (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
  oms_account_id TEXT REFERENCES oms_accounts(id) ON DELETE CASCADE,
  facility_id TEXT REFERENCES facilities(id) ON DELETE SET NULL,
  warehouse_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  connection_code TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(user_id, warehouse_code)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  return_url TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO features (id, name, description, category, status, price, payload)
VALUES
  ('marketplace-connections', 'Marketplace Connections', 'Connect Amazon, Shopify, eBay, and CSV commerce feeds.', 'marketplace', 'active', 0, '{}'::jsonb),
  ('inventory-intelligence', 'Inventory Intelligence', 'Forecast placement, stockout risk, pallet footprint, and multi-warehouse recommendations.', 'oms', 'active', 0, '{}'::jsonb),
  ('label-audit', 'Label Audit', 'Audit carrier labels, refunds, and disputes from uploads or carrier evidence.', 'audit', 'active', 0, '{}'::jsonb),
  ('business-double', 'Business Double', 'AI operating model for current versus optimized fulfillment strategy.', 'intelligence', 'active', 0, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_marketplace_connections_user_channel ON marketplace_connections(user_id, channel, status);
CREATE INDEX IF NOT EXISTS idx_catalog_items_user_updated ON catalog_items(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_items_user_sku ON catalog_items(user_id, sku);
CREATE INDEX IF NOT EXISTS idx_item_mappings_user_item ON item_channel_mappings(user_id, item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_mappings_user_external
  ON item_channel_mappings(user_id, channel, channel_item_id, COALESCE(channel_variant_id, ''));
CREATE INDEX IF NOT EXISTS idx_customers_user_updated ON customers(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_user_placed ON orders(user_id, placed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_lines_user_sku ON order_lines(user_id, sku);
CREATE INDEX IF NOT EXISTS idx_suppliers_user_updated ON suppliers(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ship_from_user_supplier ON ship_from_locations(user_id, supplier_id);
CREATE INDEX IF NOT EXISTS idx_facilities_user_code ON facilities(user_id, code);
CREATE INDEX IF NOT EXISTS idx_shipment_plans_user_updated ON shipment_plans(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipment_activity_user_created ON shipment_activity_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asns_user_plan ON asns(user_id, shipment_plan_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_user_plan ON invoice_lines(user_id, shipment_plan_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_entity ON notes(user_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_status ON api_keys(user_id, status);
CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token);
CREATE INDEX IF NOT EXISTS idx_oms_links_user_code ON oms_warehouse_links(user_id, warehouse_code);
