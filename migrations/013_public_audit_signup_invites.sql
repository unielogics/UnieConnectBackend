ALTER TABLE invite_tokens
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_invite_tokens_audit_reference
  ON invite_tokens ((metadata->>'audit_reference'))
  WHERE metadata ? 'audit_reference';
