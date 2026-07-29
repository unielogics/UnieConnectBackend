-- Tracks whether a client's fulfillment is running normally, degraded (their PRIMARY warehouse
-- relationship was severed by the warehouse but at least one peer-network warehouse link remains),
-- or blocked (zero connected warehouse links remain at all).
-- active: normal. paused: primary link severed, a peer link remains, informational banner only.
-- blocked: zero connected links remain, hard-gate banner (not dismissible).
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS fulfillment_status_note TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS fulfillment_status_at TIMESTAMPTZ;
