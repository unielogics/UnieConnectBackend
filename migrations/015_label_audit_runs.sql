CREATE TABLE IF NOT EXISTS oms_label_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  row_count INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  estimated_refunds NUMERIC NOT NULL DEFAULT 0,
  optimized_service_savings NUMERIC NOT NULL DEFAULT 0,
  missing_evidence_count INTEGER NOT NULL DEFAULT 0,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oms_label_audit_runs_user_created
  ON oms_label_audit_runs(user_id, created_at DESC);

