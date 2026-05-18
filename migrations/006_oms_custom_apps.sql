ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

CREATE TABLE IF NOT EXISTS oms_custom_apps (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  template_feature_id TEXT REFERENCES features(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT NOT NULL DEFAULT 'grid',
  status TEXT NOT NULL DEFAULT 'draft',
  visibility TEXT NOT NULL DEFAULT 'private',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_ai_employees (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  app_id TEXT REFERENCES oms_custom_apps(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operations analyst',
  instructions TEXT NOT NULL DEFAULT '',
  autonomy_level TEXT NOT NULL DEFAULT 'guarded',
  allowed_data_sources TEXT[] NOT NULL DEFAULT ARRAY['oms']::TEXT[],
  allowed_actions TEXT[] NOT NULL DEFAULT ARRAY['recommend', 'create_ticket', 'write_ledger']::TEXT[],
  status TEXT NOT NULL DEFAULT 'active',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_workflows (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  app_id TEXT REFERENCES oms_custom_apps(id) ON DELETE SET NULL,
  ai_employee_id TEXT REFERENCES oms_ai_employees(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  guardrail_policy JSONB NOT NULL DEFAULT '{"autonomy":"guarded","approvalRequiredFor":["wms_task_update","tms_dispatch","carrier_purchase","billing_refund_submission","inventory_placement_execution"]}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_workflow_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES oms_workflows(id) ON DELETE SET NULL,
  app_id TEXT REFERENCES oms_custom_apps(id) ON DELETE SET NULL,
  ai_employee_id TEXT REFERENCES oms_ai_employees(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  confidence NUMERIC,
  approval_state TEXT NOT NULL DEFAULT 'not_required',
  approval_requested_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_workflow_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES oms_workflows(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES oms_workflow_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'api',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO features (id, name, description, category, status, price, payload)
VALUES
  (
    'app-studio',
    'App Studio',
    'Create private OMS apps, AI employees, and workflow automations with no-code blocks and scoped APIs.',
    'marketplace',
    'active',
    0,
    '{"tags":["featured","no-code","api","ai-employees"],"metadata":{"route":"marketplace","navLabel":"App Studio","navIcon":"studio"}}'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  status = EXCLUDED.status,
  payload = features.payload || EXCLUDED.payload,
  updated_at = now();

CREATE INDEX IF NOT EXISTS idx_oms_custom_apps_user_status ON oms_custom_apps(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_ai_employees_user_status ON oms_ai_employees(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_workflows_user_status ON oms_workflows(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_workflow_runs_user_created ON oms_workflow_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_workflow_events_user_created ON oms_workflow_events(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_workflow_runs_user_idempotency
  ON oms_workflow_runs(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_workflow_events_user_idempotency
  ON oms_workflow_events(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
