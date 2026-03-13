import fetch from 'node-fetch';
import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { config } from '../config/env';

export type ShopifyFulfillmentInput = {
  channelAccountId: string;
  externalOrderId: string;
  lineItems?: { lineItemId: string; quantity: number }[];
  trackingNumber?: string;
  trackingCompany?: string;
  trackingUrl?: string;
  notifyCustomer?: boolean;
  log: FastifyBaseLogger;
};

export async function createShopifyFulfillment(params: ShopifyFulfillmentInput) {
  const {
    channelAccountId,
    externalOrderId,
    trackingNumber,
    trackingCompany,
    trackingUrl,
    notifyCustomer = true,
    log,
  } = params;

  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'shopify') throw new Error('Account is not Shopify');
  const shopDomain = account.shopDomain;
  if (!shopDomain) throw new Error('Missing shopDomain for Shopify account');

  const version = config.shopify.apiVersion;
  const base = `https://${shopDomain}/admin/api/${version}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': account.accessToken,
  };

  // Fetch fulfillment orders for this order
  const foRes = await fetch(`${base}/orders/${externalOrderId}/fulfillment_orders.json`, { headers });
  if (!foRes.ok) {
    const text = await foRes.text();
    log.warn({ externalOrderId, status: foRes.status }, `Shopify fulfillment_orders fetch failed: ${text}`);
    throw new Error(`Could not fetch fulfillment orders (${foRes.status}): ${text}`);
  }

  const foJson = (await foRes.json()) as { fulfillment_orders?: { id: number; status: string; assigned_location_id: number }[] };
  const fulfillmentOrders = Array.isArray(foJson?.fulfillment_orders) ? foJson.fulfillment_orders : [];
  const openFo = fulfillmentOrders.find((fo) => fo.status === 'open' || fo.status === 'scheduled');
  if (!openFo) {
    const statuses = fulfillmentOrders.map((fo) => fo.status).join(', ');
    log.info(
      { externalOrderId, statuses },
      'Shopify order already fulfilled - skipping (idempotent)'
    );
    return { fulfillment: null, skipped: true };
  }

  const lineItemsByFo: { fulfillment_order_id: number; fulfillment_order_line_items?: { id: number; quantity: number }[] }[] = [
    { fulfillment_order_id: openFo.id },
  ];

  const firstFo = lineItemsByFo[0];
  if (firstFo && params.lineItems && params.lineItems.length > 0) {
    firstFo.fulfillment_order_line_items = params.lineItems.map((li) => ({
      id: Number(li.lineItemId),
      quantity: Math.max(1, Math.floor(li.quantity) || 1),
    }));
  }

  const fulfillmentBody: Record<string, unknown> = {
    line_items_by_fulfillment_order: lineItemsByFo,
    location_id: openFo.assigned_location_id,
    notify_customer: !!notifyCustomer,
  };

  if (trackingNumber || trackingCompany || trackingUrl) {
    fulfillmentBody.tracking_info = {
      number: trackingNumber || undefined,
      company: trackingCompany || undefined,
      url: trackingUrl || undefined,
    };
  }

  const res = await fetch(`${base}/fulfillments.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fulfillment: fulfillmentBody }),
  });

  if (!res.ok) {
    const text = await res.text();
    log.warn({ externalOrderId, status: res.status }, `Shopify fulfillment create failed: ${text}`);
    throw new Error(`Shopify fulfillment create failed (${res.status}): ${text}`);
  }

  const result = (await res.json()) as { fulfillment?: { id: number } };
  log.info({ externalOrderId, fulfillmentId: result?.fulfillment?.id }, 'Shopify fulfillment created');
  return result;
}
