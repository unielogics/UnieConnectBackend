ALTER TABLE oms_cortex_chat_messages
  ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_oms_cortex_messages_user_request_role
  ON oms_cortex_chat_messages(user_id, client_request_id, role)
  WHERE client_request_id IS NOT NULL;
