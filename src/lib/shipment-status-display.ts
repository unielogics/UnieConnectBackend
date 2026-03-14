/** Shopify financial statuses – treat as "pending" for shipment display. */
const FINANCIAL_STATUSES = new Set([
  'paid', 'pending', 'authorized', 'open', 'refunded', 'partially_refunded', 'voided',
]);

/**
 * Map WMS/marketplace shipment statuses to display terms.
 * Display: pending, processing, ready, shipped. Financial statuses (paid etc) -> pending.
 */
export function shipmentStatusForDisplay(status?: string | null): string {
  const s = (status || '').toLowerCase();
  if (s === 'shipped' || s === 'completed' || s === 'fulfilled') return 'shipped';
  if (s === 'ready_to_ship' || s === 'ready') return 'ready';
  if (s === 'picking' || s === 'packing' || s === 'processing' || s === 'partial') return 'processing';
  if (s === 'cancelled' || s === 'restocked') return 'cancelled';
  if (FINANCIAL_STATUSES.has(s)) return 'pending';
  return s || 'pending';
}
