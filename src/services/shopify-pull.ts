import fetch from 'node-fetch';
import { config } from '../config/env';
import { upsertOrder, upsertProduct, upsertInventory, UpsertContext } from './shopify-upsert';

type PullResult = { products?: number; orders?: number; inventory?: number };

export async function pullShopifyAll(ctx: { shopDomain: string; accessToken: string; channelAccountId: string; userId: string; log: any }): Promise<PullResult> {
  const { shopDomain, accessToken, channelAccountId, userId, log } = ctx;
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

  // Products
  const productsRes = await fetch(`${base}/products.json?limit=250`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
  });
  if (productsRes.ok) {
    const json = await productsRes.json();
    const products = Array.isArray(json?.products) ? json.products : [];
    for (const p of products) {
      await upsertProduct(p, upsertCtx);
    }
    result.products = products.length;
  } else {
    log.warn({ status: productsRes.status }, 'Shopify products pull failed');
  }

  // Orders - last 2 days
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const ordersRes = await fetch(
    `${base}/orders.json?status=any&limit=50&order=updated_at%20desc&updated_at_min=${encodeURIComponent(since)}`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    },
  );
  if (ordersRes.ok) {
    const json = await ordersRes.json();
    const orders = Array.isArray(json?.orders) ? json.orders : [];
    for (const o of orders) {
      await upsertOrder(o, upsertCtx);
    }
    result.orders = orders.length;
  } else {
    log.warn({ status: ordersRes.status }, 'Shopify orders pull failed');
  }

  // Inventory levels - limited attempt via inventory_items/inventory_levels
  // Fetch inventory levels for the first location (best-effort)
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
      } else {
        log.warn({ status: invRes.status }, 'Shopify inventory pull failed');
      }
    }
  }

  return result;
}

