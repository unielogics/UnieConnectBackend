CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS oms_cortex_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  screen TEXT NOT NULL DEFAULT 'command',
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL DEFAULT 'Cortex chat',
  status TEXT NOT NULL DEFAULT 'active',
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_cortex_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES oms_cortex_chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL DEFAULT '',
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC,
  readiness_notes TEXT,
  cortex_status TEXT,
  cortex_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_cortex_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'readiness',
  screen TEXT NOT NULL DEFAULT 'command',
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  action_label TEXT,
  action_target TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation_id UUID REFERENCES oms_recommendations(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  auto_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_oms_cortex_threads_user_screen ON oms_cortex_chat_threads(user_id, screen, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_cortex_messages_thread_created ON oms_cortex_chat_messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_oms_cortex_tasks_user_status ON oms_cortex_tasks(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_cortex_tasks_user_screen ON oms_cortex_tasks(user_id, screen, status);
