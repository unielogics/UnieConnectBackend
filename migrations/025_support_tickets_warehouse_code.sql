-- Needed so a client's reply (support.service.ts addTicketMessage) can be pushed back to the
-- right WMS warehouse via callWmsInternal -- previously support_tickets had no way to address
-- which warehouse a WMS-originated ticket belongs to. Populated by upsertWmsSupportTicket
-- (wms-integration.routes.ts) at ingest time, which already receives warehouseCode as a
-- parameter but never persisted it.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS warehouse_code TEXT;
CREATE INDEX IF NOT EXISTS idx_support_tickets_warehouse_code ON support_tickets(warehouse_code);
