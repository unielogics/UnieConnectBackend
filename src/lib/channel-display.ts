/**
 * Human-readable channel labels for display in UI.
 */
export function channelDisplayLabel(account: { channel: string; shopDomain?: string; sellingPartnerId?: string }): string {
  const ch = String(account?.channel || '').toLowerCase();
  if (ch === 'shopify' && account?.shopDomain) {
    return `Shopify (${account.shopDomain})`;
  }
  if (ch === 'amazon') return 'Amazon';
  if (ch === 'ebay') return 'eBay';
  return ch ? ch.charAt(0).toUpperCase() + ch.slice(1) : 'Unknown';
}
