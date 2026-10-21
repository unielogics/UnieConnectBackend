CREATE TABLE IF NOT EXISTS shopify_compliance_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  webhook_id TEXT NOT NULL UNIQUE,
  shop_domain TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopify_compliance_status_received
  ON shopify_compliance_requests(status, received_at);
