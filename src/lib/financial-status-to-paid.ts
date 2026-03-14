/**
 * Maps marketplace financial/payment statuses to UnieConnect normalized paid status.
 * Paid status is separate from fulfillment status.
 */

export type PaidStatus =
  | 'paid'
  | 'pending'
  | 'not_paid'
  | 'refunded'
  | 'partially_refunded'
  | 'voided'
  | 'authorized'
  | 'partially_paid'
  | 'unknown';

const SHOPIFY_TO_PAID: Record<string, PaidStatus> = {
  paid: 'paid',
  pending: 'pending',
  authorized: 'authorized',
  partially_paid: 'partially_paid',
  refunded: 'refunded',
  partially_refunded: 'partially_refunded',
  voided: 'voided',
  open: 'not_paid',
};

/**
 * Map Shopify financial_status to UnieConnect paid status.
 * Shopify values: pending, authorized, paid, refunded, voided, partially_refunded, partially_paid
 */
export function shopifyFinancialStatusToPaid(financialStatus?: string | null): PaidStatus {
  const s = (financialStatus || '').toLowerCase();
  return SHOPIFY_TO_PAID[s] ?? 'unknown';
}

/**
 * Map Amazon OrderStatus to paid status (inferred).
 * Amazon SP-API does not expose financial status directly.
 * For MFN: Shipped/Unshipped typically imply payment captured; Pending/PendingAvailability implies pending.
 */
export function amazonOrderStatusToPaid(orderStatus?: string | null): PaidStatus {
  const s = (orderStatus || '').trim().toLowerCase();
  if (s === 'pending' || s === 'pendingavailability') return 'pending';
  if (s === 'unshipped' || s === 'partiallyshipped' || s === 'shipped' || s === 'invoiceunconfirmed') return 'paid';
  if (s === 'canceled' || s === 'cancelled' || s === 'unfulfillable') return 'unknown';
  return 'unknown';
}
