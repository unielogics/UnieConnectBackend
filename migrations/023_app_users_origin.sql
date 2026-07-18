-- Client origin + owning-warehouse marker on app_users.
-- origin: 'direct' (self-signed-up at UnieConnect, self-owned) | 'warehouse_invited'
--         (invited by a WMS warehouse, owned by that warehouse).
-- owning_warehouse_code: the inviting warehouse code for warehouse_invited clients; NULL for direct.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS owning_warehouse_code TEXT;
CREATE INDEX IF NOT EXISTS idx_app_users_owning_wh ON app_users (owning_warehouse_code) WHERE owning_warehouse_code IS NOT NULL;
