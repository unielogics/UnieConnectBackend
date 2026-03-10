import fetch from 'node-fetch';
import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { ItemExternal } from '../models/item-external';
import { config } from '../config/env';

export type ShopifyInventoryUpdate = {
  sku: string;
  quantity: number;
  locationId?: string;
};

export async function pushShopifyInventory(
  channelAccountId: string,
  updates: ShopifyInventoryUpdate[],
  log: FastifyBaseLogger
) {
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

  let defaultLocationId: string | undefined;
  const needsDefaultLocation = updates.some((u) => !u.locationId);
  if (needsDefaultLocation) {
    const locRes = await fetch(`${base}/locations.json`, { headers });
    if (!locRes.ok) {
      log.warn({ status: locRes.status }, 'Shopify locations fetch failed');
      throw new Error('Could not fetch locations');
    }
    const locJson = (await locRes.json()) as { locations?: { id: number }[] };
    const locations = Array.isArray(locJson?.locations) ? locJson.locations : [];
    const firstLoc = locations[0];
    if (!firstLoc) throw new Error('No locations found for Shopify store');
    defaultLocationId = String(firstLoc.id);
  }

  for (const update of updates) {
    const sku = (update.sku || '').trim();
    if (!sku) continue;
    const locationId = update.locationId || defaultLocationId;
    if (!locationId) {
      log.warn({ sku }, 'Shopify inventory push skipped: no locationId');
      continue;
    }

    const mapping = await ItemExternal.findOne({
      channelAccountId,
      channel: 'shopify',
      sku,
    })
      .lean()
      .exec();

    if (!mapping) {
      log.warn({ sku }, 'Shopify inventory push skipped: no variant mapping for SKU');
      continue;
    }

    const inventoryItemId = mapping.raw?.inventory_item_id;
    if (!inventoryItemId) {
      log.warn({ sku }, 'Shopify inventory push skipped: variant missing inventory_item_id');
      continue;
    }

    const body = {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: Math.max(0, Math.floor(Number(update.quantity) || 0)),
    };

    const res = await fetch(`${base}/inventory_levels/set.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      log.warn({ sku, status: res.status }, `Shopify inventory set failed: ${text}`);
      throw new Error(`Shopify inventory set failed (${res.status}): ${text}`);
    }

    log.info({ sku, quantity: body.available }, 'Shopify inventory updated');
  }
}
