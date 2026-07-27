-- Client-facing Inbox: duplicates what emitEmailEvent (WMS) already sent to this client, so the
-- OMS Inbox screen can show it without the client needing to check their real email. Pushed by
-- enqueueMailboxMessageOmsSync (WMS-side, mailbox-oms-sync.service.ts) via the standard
-- entityType:'mailbox_message' -> /internal/wms/events pipeline. Only client-directed,
-- emitEmailEvent-originated sends land here -- never internal-ops-only WMS Message threads.
CREATE TABLE IF NOT EXISTS oms_mailbox_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT,
  from_email TEXT,
  thread_id TEXT,
  wms_message_id TEXT,
  event_type TEXT,
  warehouse_code TEXT,
  read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oms_mailbox_messages_user_created ON oms_mailbox_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_mailbox_messages_user_read ON oms_mailbox_messages(user_id, read);
-- Idempotent re-sync guard: a retried/duplicate WMS emit for the same message must not double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_mailbox_messages_wms_dedup ON oms_mailbox_messages(user_id, wms_message_id) WHERE wms_message_id IS NOT NULL;
