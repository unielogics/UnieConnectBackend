ALTER TABLE oms_warehouse_links
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE oms_warehouse_links
SET created_at = COALESCE(connected_at, now()),
    updated_at = COALESCE(connected_at, now())
WHERE created_at IS NULL
   OR updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_oms_warehouse_links_user_updated
  ON oms_warehouse_links (user_id, updated_at DESC);
