CREATE TABLE IF NOT EXISTS channel_sync_status (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  channel_account_id TEXT NOT NULL REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  count INTEGER,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel_account_id, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_channel_sync_status_account
  ON channel_sync_status(channel_account_id, entity_type, status);
