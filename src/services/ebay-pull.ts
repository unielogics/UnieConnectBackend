import { URLSearchParams } from 'url';
import { config } from '../config/env';
import { ebayGet } from './ebay';
import { UpsertContext, upsertEbayInventoryItem, upsertEbayOrder } from './ebay-upsert';

type PullResult = { orders?: number; inventory?: number };

export async function pullEbayAll(params: {
  accessToken: string;
  channelAccountId: string;
  userId: string;
  log: any;
  marketplaceId?: string;
  since?: string;
}): Promise<PullResult> {
  const { accessToken, channelAccountId, userId, log } = params;
  const marketplaceId = params.marketplaceId ?? config.ebay.marketplaceId ?? 'EBAY_US';
  const since = params.since || new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const ctx: UpsertContext = {
    channelAccountId,
    userId,
    log,
    channel: 'ebay',
    marketplaceId,
    source: 'poll',
  };
  const result: PullResult = {};

  // Orders
  try {
    const orders = await fetchOrders({ accessToken, marketplaceId, since });
    for (const order of orders) {
      await upsertEbayOrder(order, ctx);
    }
    result.orders = orders.length;
  } catch (err: any) {
    log?.warn?.({ err }, 'eBay orders pull failed');
  }

  // Inventory items + quantities
  try {
    const inventoryItems = await fetchInventoryItems({ accessToken, marketplaceId });
    for (const item of inventoryItems) {
      await upsertEbayInventoryItem(item, ctx);
    }
    result.inventory = inventoryItems.length;
  } catch (err: any) {
    log?.warn?.({ err }, 'eBay inventory pull failed');
  }

  return result;
}

async function fetchOrders(params: { accessToken: string; marketplaceId: string; since: string }) {
  const { accessToken, marketplaceId, since } = params;
  const now = new Date().toISOString();
  const qs = new URLSearchParams({
    limit: '50',
    filter: `creationdate:[${since}..${now}]`,
  });

  const orders: any[] = [];
  let path: string | undefined = `/sell/fulfillment/v1/order?${qs.toString()}`;
  while (path) {
    const page = await ebayGet<any>(path, accessToken, { marketplaceId });
    const pageOrders = Array.isArray(page?.orders) ? page.orders : [];
    orders.push(...pageOrders);
    path = normalizeNext(page?.next);
  }
  return orders;
}

async function fetchInventoryItems(params: { accessToken: string; marketplaceId: string }) {
  const { accessToken, marketplaceId } = params;
  const inventoryItems: any[] = [];
  let path: string | undefined = '/sell/inventory/v1/inventory_item?limit=50';
  while (path) {
    const page = await ebayGet<any>(path, accessToken, { marketplaceId });
    const items = Array.isArray(page?.inventoryItems) ? page.inventoryItems : [];
    inventoryItems.push(...items);
    path = normalizeNext(page?.next);
  }
  return inventoryItems;
}

function normalizeNext(next?: string): string | undefined {
  if (!next) return undefined;
  if (next.startsWith('http')) {
    return next.replace(config.ebay.apiBaseUrl, '');
  }
  return next.startsWith('/') ? next : `/${next}`;
}


