CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS oms_cortex_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  cortex_credential_id TEXT,
  cortex_tenant_key TEXT,
  api_username TEXT NOT NULL,
  secret_enc TEXT,
  secret_prefix TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  model_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active',
  provisioning_error TEXT,
  last_verified_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id),
  UNIQUE(api_username)
);

CREATE INDEX IF NOT EXISTS idx_oms_cortex_credentials_status ON oms_cortex_credentials(status);
CREATE INDEX IF NOT EXISTS idx_oms_cortex_credentials_tenant_key ON oms_cortex_credentials(cortex_tenant_key);
