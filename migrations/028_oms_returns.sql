-- Returns/RMA screen: mirrors asns' shape exactly (a user-scoped header + full WMS payload
-- snapshot in jsonb, no line-item normalization on this side). Populated by upsertWmsReturn
-- (wms-integration.routes.ts) via the standard entityType:'return' -> /internal/wms/events
-- pipeline, pushed by emitReturnToOms (WMS-side, oms-sync.service.ts) on every RMA status
-- transition (requested/authorized/received/restocked/closed/cancelled).
CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  rma_number TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_returns_user_created ON returns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_returns_user_status ON returns(user_id, status);
-- Idempotent re-sync guard: a retried/duplicate WMS emit for the same RMA must not double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_user_rma_dedup ON returns(user_id, rma_number) WHERE rma_number IS NOT NULL;
