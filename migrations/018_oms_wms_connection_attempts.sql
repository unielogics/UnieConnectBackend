CREATE TABLE IF NOT EXISTS oms_wms_connection_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  connection_code_hash TEXT,
  warehouse_code TEXT,
  oms_intermediary_id TEXT,
  wms_intermediary_id TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oms_wms_conn_attempts_user_idx
  ON oms_wms_connection_attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oms_wms_conn_attempts_user_wh_idx
  ON oms_wms_connection_attempts (user_id, warehouse_code, created_at DESC);
CREATE INDEX IF NOT EXISTS oms_wms_conn_attempts_status_idx
  ON oms_wms_connection_attempts (status, created_at DESC);
