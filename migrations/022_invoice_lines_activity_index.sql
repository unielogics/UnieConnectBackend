-- Billing cockpit: the OMS Billing screen now runs date-windowed range queries + a paginated
-- invoice ledger over invoice_lines. The table previously had only idx_invoice_lines_user_plan
-- (user_id, shipment_plan_id), which does not help time-range filtering or the created_at DESC
-- ordering used by the ledger. Add a covering index for that access pattern.
CREATE INDEX IF NOT EXISTS idx_invoice_lines_user_created
  ON invoice_lines (user_id, created_at DESC);

-- NOTE: we intentionally do NOT create an expression index on
-- ((payload->>'periodStart')::timestamptz). Casting text -> timestamptz is only STABLE (it depends
-- on the TimeZone / DateStyle GUCs), and Postgres rejects non-IMMUTABLE functions in index
-- expressions, which would fail this migration. The billing queries filter on
-- COALESCE((payload->>'periodStart')::timestamptz, created_at) for correctness; invoice_lines is
-- per-user and small, so the created_at index above plus a per-user sort is sufficient.
