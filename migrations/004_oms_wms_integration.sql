CREATE TABLE IF NOT EXISTS oms_wms_credentials (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE,
  warehouse_code TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  passkey_hash TEXT NOT NULL,
  passkey_enc TEXT,
  passkey_prefix TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_wms_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  credential_id TEXT REFERENCES oms_wms_credentials(id) ON DELETE SET NULL,
  client_id TEXT,
  warehouse_code TEXT,
  wms_intermediary_id TEXT,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_oms_wms_credentials_user_wh ON oms_wms_credentials(user_id, warehouse_code, status);
CREATE INDEX IF NOT EXISTS idx_oms_wms_events_user_received ON oms_wms_events(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_wms_events_wh_received ON oms_wms_events(warehouse_code, received_at DESC);

