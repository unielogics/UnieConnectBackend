/**
 * Order status converter: maps marketplace fulfillment statuses to/from UnieWMS canonical statuses.
 * UnieWMS is the source of truth for fulfillment; this module enables bidirectional mapping.
 */

/** UnieWMS canonical fulfillment statuses (source of truth) */
export const UNIE_WMS_STATUSES = [
  'pending',
  'picking',
  'packing',
  'shipped',
  'completed',
  'cancelled',
] as const;

export type UnieWmsStatus = (typeof UNIE_WMS_STATUSES)[number];

const UNIE_WMS_SET = new Set<string>(UNIE_WMS_STATUSES);

/** Check if a string is a valid UnieWMS status */
export function isUnieWmsStatus(s?: string | null): s is UnieWmsStatus {
  return Boolean(s && UNIE_WMS_SET.has(s));
}

/** Map unknown WMS status to canonical (e.g. ready_to_ship -> packing, fulfilled -> shipped) */
export function normalizeWmsStatus(status?: string | null): UnieWmsStatus {
  const s = (status || '').toLowerCase().replace(/-/g, '_');
  if (UNIE_WMS_SET.has(s)) return s as UnieWmsStatus;
  if (s === 'ready_to_ship' || s === 'ready') return 'packing';
  if (s === 'fulfilled' || s === 'partial' || s === 'partially_fulfilled') return 'shipped';
  if (s === 'restocked' || s === 'canceled') return 'cancelled';
  return 'pending';
}

/**
 * Map Shopify fulfillment_status to UnieWMS status.
 * Shopify: null, unfulfilled, partial, fulfilled, restocked, scheduled, etc.
 */
export function shopifyFulfillmentToWmsStatus(fulfillmentStatus?: string | null): UnieWmsStatus {
  const s = (fulfillmentStatus || 'unfulfilled').toLowerCase();
  if (s === 'fulfilled' || s === 'partially_fulfilled' || s === 'partial') return 'shipped';
  if (s === 'restocked') return 'cancelled';
  // unfulfilled, null, scheduled, open, on_hold, in_progress, pending_fulfillment -> pending
  return 'pending';
}

/**
 * Map Amazon OrderStatus to UnieWMS status.
 * Amazon: Pending, PendingAvailability, Unshipped, PartiallyShipped, Shipped, InvoiceUnconfirmed, Canceled, Unfulfillable
 */
export function amazonOrderStatusToWmsStatus(orderStatus?: string | null): UnieWmsStatus {
  const s = (orderStatus || '').trim();
  const lower = s.toLowerCase();
  if (lower === 'shipped' || lower === 'partiallyshipped') return 'shipped';
  if (lower === 'invoiceunconfirmed') return 'shipped'; // all items shipped, awaiting invoice
  if (lower === 'canceled' || lower === 'cancelled' || lower === 'unfulfillable') return 'cancelled';
  // Pending, PendingAvailability, Unshipped -> pending
  return 'pending';
}
