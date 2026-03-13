import fetch from 'node-fetch';
import { config } from '../config/env';
import { debugLog } from '../lib/debug-log';
import { upsertOrder, upsertProduct, upsertInventory, upsertCustomerFromApi, UpsertContext } from './shopify-upsert';
import { setSyncStatus } from './channel-sync-status';

type PullResult = { products?: number; orders?: number; customers?: number; inventory?: number };

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_3 = 90;

/** Extract page_info from Shopify Link header for rel=next. */
function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+[?&]page_info=([^>&]+)[^>]*>\s*;\s*rel="next"/i);
  const info = match?.[1];
  return info ? decodeURIComponent(info) : null;
}

export async function pullShopifyAll(ctx: {
  shopDomain: string;
  accessToken: string;
  channelAccountId: string;
  userId: string;
  log: any;
  /** When true (first connection), pull last 3 months of orders and customers with pagination. */
  initialSync?: boolean;
}): Promise<PullResult> {
  const { shopDomain, accessToken, channelAccountId, userId, log, initialSync } = ctx;
  // #region agent log
  debugLog('pullShopifyAll entry', { channelAccountId, userId, initialSync, shopDomain }, 'A');
  // #endregion
  const upsertCtx: UpsertContext = {
    channelAccountId,
    userId,
    log,
    channel: 'shopify',
    source: 'poll',
  };
  const version = config.shopify.apiVersion;
  const base = `https://${shopDomain}/admin/api/${version}`;
  const result: PullResult = {};

  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken };

  // Products - fully paginated (no limit for large catalogs)
  try {
  await setSyncStatus(channelAccountId, 'products', 'syncing');
  let totalProducts = 0;
  let prodPageInfo: string | null = null;
  do {
    const productsUrl = prodPageInfo
      ? `${base}/products.json?limit=250&page_info=${encodeURIComponent(prodPageInfo)}`
      : `${base}/products.json?limit=250`;
    const productsRes = await fetch(productsUrl, { headers });
    if (!productsRes.ok) {
      log.warn({ status: productsRes.status }, 'Shopify products pull failed');
      await setSyncStatus(channelAccountId, 'products', 'error', { error: `HTTP ${productsRes.status}` });
      break;
    }
    const json = await productsRes.json();
    const products = Array.isArray(json?.products) ? json.products : [];
    for (const p of products) {
      await upsertProduct(p, upsertCtx);
    }
    totalProducts += products.length;
    prodPageInfo = parseNextPageInfo(productsRes.headers.get('link'));
  } while (prodPageInfo);
  result.products = totalProducts;
  // #region agent log
  debugLog('products done', { totalProducts }, 'A');
  // #endregion
  await setSyncStatus(channelAccountId, 'products', 'synced', result.products !== undefined ? { count: result.products } : undefined);
  } catch (err: any) {
    log.error({ err }, 'Shopify products sync failed');
    await setSyncStatus(channelAccountId, 'products', 'error', { error: err?.message || 'Products sync failed' });
  }

  // Orders - 3 months on initial sync (paginated), 7 days on subsequent syncs
  try {
  await setSyncStatus(channelAccountId, 'orders', 'syncing');
  const orderDays = initialSync ? DAYS_3 : 7;
  const orderSince = new Date(Date.now() - orderDays * MS_PER_DAY).toISOString();
  const orderLimit = initialSync ? 250 : 50;
  let totalOrders = 0;
  let pageInfo: string | null = null;

  do {
    const ordersUrl = pageInfo
      ? `${base}/orders.json?status=any&limit=${orderLimit}&page_info=${encodeURIComponent(pageInfo)}`
      : `${base}/orders.json?status=any&limit=${orderLimit}&order=created_at%20desc&created_at_min=${encodeURIComponent(orderSince)}`;
    const ordersRes = await fetch(ordersUrl, { headers });
    if (!ordersRes.ok) {
      log.warn({ status: ordersRes.status }, 'Shopify orders pull failed');
      await setSyncStatus(channelAccountId, 'orders', 'error', { error: `HTTP ${ordersRes.status}` });
      break;
    }
    const json = await ordersRes.json();
    const orders = Array.isArray(json?.orders) ? json.orders : [];
    for (const o of orders) {
      await upsertOrder(o, upsertCtx);
    }
    totalOrders += orders.length;
    pageInfo = parseNextPageInfo(ordersRes.headers.get('link'));
  } while (pageInfo);

  result.orders = totalOrders;
  // #region agent log
  debugLog('orders done', { totalOrders }, 'A');
  // #endregion
  await setSyncStatus(channelAccountId, 'orders', 'synced', result.orders !== undefined ? { count: result.orders } : undefined);
  } catch (err: any) {
    log.error({ err }, 'Shopify orders sync failed');
    await setSyncStatus(channelAccountId, 'orders', 'error', { error: err?.message || 'Orders sync failed' });
  }

  // Customers - explicit pull on initial sync (3 months), otherwise derived from orders
  if (initialSync) {
  try {
    await setSyncStatus(channelAccountId, 'customers', 'syncing');
    const customerSince = new Date(Date.now() - DAYS_3 * MS_PER_DAY).toISOString();
    let totalCustomers = 0;
    let custPageInfo: string | null = null;
    do {
      const customersUrl = custPageInfo
        ? `${base}/customers.json?limit=250&page_info=${encodeURIComponent(custPageInfo)}`
        : `${base}/customers.json?limit=250&created_at_min=${encodeURIComponent(customerSince)}`;
      const custRes = await fetch(customersUrl, { headers });
      if (!custRes.ok) {
        log.warn({ status: custRes.status }, 'Shopify customers pull failed');
        await setSyncStatus(channelAccountId, 'customers', 'error', { error: `HTTP ${custRes.status}` });
        break;
      }
      const custJson = await custRes.json();
      const customers = Array.isArray(custJson?.customers) ? custJson.customers : [];
      for (const c of customers) {
        await upsertCustomerFromApi(c, upsertCtx);
      }
      totalCustomers += customers.length;
      custPageInfo = parseNextPageInfo(custRes.headers.get('link'));
    } while (custPageInfo);
    result.customers = totalCustomers;
    await setSyncStatus(channelAccountId, 'customers', 'synced', result.customers !== undefined ? { count: result.customers } : undefined);
  } catch (err: any) {
    log.error({ err }, 'Shopify customers sync failed');
    await setSyncStatus(channelAccountId, 'customers', 'error', { error: err?.message || 'Customers sync failed' });
  }
  } else {
    await setSyncStatus(channelAccountId, 'customers', 'synced'); // customers derived from orders
  }

  // Inventory levels - limited attempt via inventory_items/inventory_levels
  try {
  await setSyncStatus(channelAccountId, 'inventory', 'syncing');
  const locationsRes = await fetch(`${base}/locations.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
  });
  if (locationsRes.ok) {
    const locJson = await locationsRes.json();
    const locations = Array.isArray(locJson?.locations) ? locJson.locations : [];
    if (locations.length > 0) {
      const locId = locations[0].id;
      const invRes = await fetch(`${base}/inventory_levels.json?limit=250&location_ids[]=${locId}`, {
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      });
      if (invRes.ok) {
        const invJson = await invRes.json();
        const levels = Array.isArray(invJson?.inventory_levels) ? invJson.inventory_levels : [];
        for (const lvl of levels) {
          await upsertInventory(lvl, upsertCtx);
        }
        result.inventory = levels.length;
        await setSyncStatus(channelAccountId, 'inventory', 'synced', result.inventory !== undefined ? { count: result.inventory } : undefined);
  } else {
    log.warn({ status: invRes.status }, 'Shopify inventory pull failed');
        await setSyncStatus(channelAccountId, 'inventory', 'error', { error: `HTTP ${invRes.status}` });
      }
    } else {
      await setSyncStatus(channelAccountId, 'inventory', 'synced', { count: 0 });
    }
  } else {
    const errText = await locationsRes.text().catch(() => '');
    const errMsg = locationsRes.status === 403 || locationsRes.status === 401
      ? 'Locations access denied (add read_locations scope and reconnect)'
      : `Locations fetch failed (HTTP ${locationsRes.status})`;
    await setSyncStatus(channelAccountId, 'inventory', 'error', { error: errMsg });
  }
  } catch (err: any) {
    log.error({ err }, 'Shopify inventory sync failed');
    await setSyncStatus(channelAccountId, 'inventory', 'error', { error: err?.message || 'Inventory sync failed' });
  }

  // #region agent log
  debugLog('pullShopifyAll result', result, 'A');
  // #endregion
  return result;
}

