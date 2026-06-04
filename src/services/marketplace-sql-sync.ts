import fetch from 'node-fetch';
import { QueryResultRow } from 'pg';
import { URLSearchParams } from 'url';
import { config } from '../config/env';
import { pgQuery, withPgTransaction } from '../db/postgres';
import { ebayGet } from './ebay';
import { setSyncStatus } from './channel-sync-status';

type PullResult = { products?: number; orders?: number; customers?: number; inventory?: number; errors?: Record<string, string> };

type SyncContext = {
  userId: string;
  channelAccountId: string;
  log?: any;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function trim(value: unknown) {
  return value == null ? '' : String(value).trim();
}

function num(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function plainText(html: unknown) {
  return typeof html === 'string' ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) : null;
}

function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+[?&]page_info=([^>&]+)[^>]*>\s*;\s*rel="next"/i);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function normalizeNext(next?: string): string | undefined {
  if (!next) return undefined;
  if (next.startsWith('http')) return next.replace(config.ebay.apiBaseUrl, '');
  return next.startsWith('/') ? next : `/${next}`;
}

async function one<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T | null> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows?.[0] || null;
}

async function upsertCatalogItem(params: {
  userId: string;
  sku: string;
  title: string;
  description?: string | null;
  image?: string | null;
  images?: string[];
  metadata?: Record<string, unknown>;
}) {
  return one(
    `INSERT INTO catalog_items (user_id, sku, title, description, image, images, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT (user_id, sku)
     DO UPDATE SET
       title = COALESCE(EXCLUDED.title, catalog_items.title),
       description = COALESCE(EXCLUDED.description, catalog_items.description),
       image = COALESCE(EXCLUDED.image, catalog_items.image),
       images = CASE WHEN jsonb_array_length(EXCLUDED.images) > 0 THEN EXCLUDED.images ELSE catalog_items.images END,
       metadata = catalog_items.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING *`,
    [
      params.userId,
      params.sku,
      params.title || params.sku,
      params.description || null,
      params.image || null,
      JSON.stringify(params.images || []),
      JSON.stringify(params.metadata || {}),
    ],
  );
}

async function upsertMapping(params: {
  userId: string;
  itemId: string;
  channelAccountId: string;
  channel: string;
  channelItemId: string;
  channelVariantId?: string | null;
  sku: string;
  status?: string;
  payload?: Record<string, unknown>;
}) {
  await pgQuery(
    `INSERT INTO item_channel_mappings
       (user_id, item_id, channel_connection_id, channel, channel_item_id, channel_variant_id, sku, status, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'active'), $9::jsonb)
     ON CONFLICT (user_id, channel, channel_item_id, (COALESCE(channel_variant_id, '')))
     DO UPDATE SET
       item_id = EXCLUDED.item_id,
       channel_connection_id = EXCLUDED.channel_connection_id,
       sku = EXCLUDED.sku,
       status = EXCLUDED.status,
       payload = item_channel_mappings.payload || EXCLUDED.payload,
       updated_at = now()`,
    [
      params.userId,
      params.itemId,
      params.channelAccountId,
      params.channel,
      params.channelItemId,
      params.channelVariantId || null,
      params.sku,
      params.status || 'active',
      JSON.stringify(params.payload || {}),
    ],
  );
}

async function ensureCustomer(ctx: SyncContext, channel: string, externalCustomerId: string | null, raw: any) {
  if (!externalCustomerId && !raw) return null;
  const email = trim(raw?.email || raw?.buyer?.email).toLowerCase() || null;
  const phone = trim(raw?.phone || raw?.buyer?.taxAddress?.phoneNumber) || null;
  const name = trim(
    [raw?.first_name || raw?.buyer?.taxAddress?.firstName || raw?.buyer?.name?.firstName, raw?.last_name || raw?.buyer?.taxAddress?.lastName || raw?.buyer?.name?.lastName]
      .filter(Boolean)
      .join(' '),
  ) || trim(raw?.name || raw?.buyer?.username) || null;
  const address = raw?.default_address || raw?.taxAddress || raw?.registrationAddress || raw?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const existing = externalCustomerId
    ? await one('SELECT * FROM customers WHERE user_id = $1 AND channel = $2 AND external_customer_id = $3 LIMIT 1', [ctx.userId, channel, externalCustomerId])
    : null;
  if (existing) return existing;
  return one(
    `INSERT INTO customers (user_id, name, email, phone, channel, external_customer_id, addresses, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     RETURNING *`,
    [
      ctx.userId,
      name,
      email,
      phone,
      channel,
      externalCustomerId,
      JSON.stringify(address ? [address] : []),
      JSON.stringify({ source: `${channel}_sync`, raw }),
    ],
  );
}

async function upsertOrder(ctx: SyncContext, channel: 'shopify' | 'ebay', raw: any) {
  const externalOrderId = channel === 'shopify'
    ? trim(raw?.id)
    : trim(raw?.orderId || raw?.legacyOrderId || raw?.purchaseOrderId);
  if (!externalOrderId) return;

  const customerRaw = channel === 'shopify' ? raw?.customer : raw;
  const externalCustomerId = channel === 'shopify'
    ? trim(raw?.customer?.id) || null
    : trim(raw?.buyer?.username) || null;
  const customer = await ensureCustomer(ctx, channel, externalCustomerId, customerRaw);
  const totals = channel === 'shopify'
    ? {
        subtotal: num(raw?.subtotal_price),
        tax: num(raw?.total_tax),
        shipping: Array.isArray(raw?.shipping_lines) ? raw.shipping_lines.reduce((sum: number, line: any) => sum + num(line?.price), 0) : 0,
        discounts: num(raw?.total_discounts),
        total: num(raw?.total_price),
        currency: raw?.currency || 'USD',
      }
    : {
        subtotal: num(raw?.pricingSummary?.subtotal?.value ?? raw?.pricingSummary?.priceSubtotal?.value),
        tax: num(raw?.pricingSummary?.totalTax?.value),
        shipping: num(raw?.pricingSummary?.deliveryCost?.shippingCost?.value),
        discounts: num(raw?.pricingSummary?.discount?.value),
        total: num(raw?.pricingSummary?.total?.value),
        currency: raw?.pricingSummary?.total?.currency || 'USD',
      };
  const existing = await one('SELECT * FROM orders WHERE user_id = $1 AND channel_connection_id = $2 AND external_order_id = $3 LIMIT 1', [
    ctx.userId,
    ctx.channelAccountId,
    externalOrderId,
  ]);
  const placedAt = channel === 'shopify' ? raw?.created_at : raw?.creationDate;
  const order = existing
    ? await one(
        `UPDATE orders
         SET customer_id = $4, status = $5, paid = $6, placed_at = COALESCE($7::timestamptz, placed_at),
             totals = $8::jsonb, shipping_address = $9::jsonb, billing_address = $10::jsonb,
             metadata = metadata || $11::jsonb, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND channel_connection_id = $3
         RETURNING *`,
        [
          existing.id,
          ctx.userId,
          ctx.channelAccountId,
          customer?.id || null,
          raw?.fulfillment_status || raw?.orderFulfillmentStatus || raw?.orderStatus || 'open',
          raw?.financial_status || raw?.orderPaymentStatus || null,
          placedAt || null,
          JSON.stringify(totals),
          JSON.stringify(raw?.shipping_address || raw?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {}),
          JSON.stringify(raw?.billing_address || {}),
          JSON.stringify({ source: `${channel}_sync`, raw }),
        ],
      )
    : await one(
        `INSERT INTO orders
          (user_id, customer_id, channel_connection_id, channel, external_order_id, order_number, status, paid, placed_at, totals, shipping_address, billing_address, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)
         RETURNING *`,
        [
          ctx.userId,
          customer?.id || null,
          ctx.channelAccountId,
          channel,
          externalOrderId,
          trim(raw?.name || raw?.legacyOrderId || raw?.orderId) || externalOrderId,
          raw?.fulfillment_status || raw?.orderFulfillmentStatus || raw?.orderStatus || 'open',
          raw?.financial_status || raw?.orderPaymentStatus || null,
          placedAt || null,
          JSON.stringify(totals),
          JSON.stringify(raw?.shipping_address || raw?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo || {}),
          JSON.stringify(raw?.billing_address || {}),
          JSON.stringify({ source: `${channel}_sync`, raw }),
        ],
      );
  if (!order) return;

  const lines = channel === 'shopify' ? raw?.line_items : raw?.lineItems;
  await pgQuery('DELETE FROM order_lines WHERE user_id = $1 AND order_id = $2', [ctx.userId, order.id]);
  for (const line of Array.isArray(lines) ? lines : []) {
    const sku = trim(line?.sku || line?.legacySku) || null;
    const item = sku ? await one('SELECT * FROM catalog_items WHERE user_id = $1 AND lower(sku) = lower($2) LIMIT 1', [ctx.userId, sku]) : null;
    const quantity = num(line?.quantity);
    const unitPrice = channel === 'shopify' ? num(line?.price) : num(line?.lineItemCost?.value ?? line?.netPrice?.value);
    await pgQuery(
      `INSERT INTO order_lines (user_id, order_id, item_id, sku, title, quantity, unit_price, total_price, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        ctx.userId,
        order.id,
        item?.id || null,
        sku,
        line?.title || line?.name || line?.itemTitle || sku || `${channel} item`,
        quantity,
        unitPrice,
        quantity * unitPrice,
        JSON.stringify({ source: `${channel}_sync`, raw: line }),
      ],
    );
  }
}

export async function applyShopifyWebhook(params: {
  shopDomain: string;
  topic: string;
  payload: any;
  webhookId?: string | null;
}) {
  const shopDomain = trim(params.shopDomain).toLowerCase();
  const topic = trim(params.topic).toLowerCase();
  if (!shopDomain || !topic) throw new Error('Shopify webhook is missing shop domain or topic');
  const account = await one(
    "SELECT * FROM marketplace_connections WHERE channel = 'shopify' AND lower(shop_domain) = lower($1) AND status = 'connected' ORDER BY updated_at DESC LIMIT 1",
    [shopDomain],
  );
  if (!account?.id || !account.user_id) throw new Error(`No connected Shopify account found for ${shopDomain}`);
  const ctx = { userId: account.user_id, channelAccountId: account.id };
  const payload = params.payload || {};
  const metadata = { source: 'shopify_webhook', topic, webhookId: params.webhookId || null };

  if (topic === 'app/uninstalled') {
    await pgQuery(
      `UPDATE marketplace_connections
       SET status = 'disconnected', metadata = metadata || $3::jsonb, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [account.id, account.user_id, JSON.stringify({ ...metadata, uninstalledAt: new Date().toISOString() })],
    );
    return { accountId: account.id, action: 'connection_disconnected' };
  }

  if (topic.startsWith('orders/')) {
    await upsertOrder(ctx, 'shopify', { ...payload, webhook_metadata: metadata });
    await setSyncStatus(account.id, 'orders', 'synced', { metadata: { topic, webhookId: params.webhookId || null } });
    return { accountId: account.id, action: 'order_upserted' };
  }

  if (topic.startsWith('products/')) {
    if (topic === 'products/delete') {
      await pgQuery(
        `UPDATE item_channel_mappings
         SET status = 'deleted', payload = payload || $4::jsonb, updated_at = now()
         WHERE user_id = $1 AND channel_connection_id = $2 AND channel = 'shopify' AND channel_item_id = $3`,
        [account.user_id, account.id, trim(payload?.id), JSON.stringify(metadata)],
      );
      await setSyncStatus(account.id, 'products', 'synced', { metadata: { topic, webhookId: params.webhookId || null } });
      return { accountId: account.id, action: 'product_deleted' };
    }
    const images = Array.isArray(payload?.images) ? payload.images.map((image: any) => image?.src || image?.url).filter(Boolean) : [];
    let count = 0;
    for (const variant of Array.isArray(payload?.variants) ? payload.variants : []) {
      const sku = trim(variant?.sku);
      if (!sku) continue;
      const item: any = await upsertCatalogItem({
        userId: account.user_id,
        sku,
        title: trim(payload?.title) || sku,
        description: plainText(payload?.body_html),
        image: images[0] || null,
        images,
        metadata: { ...metadata, productId: payload?.id, variantId: variant?.id, inventoryItemId: variant?.inventory_item_id },
      });
      if (item?.id) {
        await upsertMapping({
          userId: account.user_id,
          itemId: item.id,
          channelAccountId: account.id,
          channel: 'shopify',
          channelItemId: trim(payload?.id),
          channelVariantId: trim(variant?.id) || null,
          sku,
          status: payload?.status === 'active' ? 'active' : 'inactive',
          payload: { ...metadata, product: payload, variant, inventory_item_id: variant?.inventory_item_id },
        });
        count++;
      }
    }
    await setSyncStatus(account.id, 'products', 'synced', { count, metadata: { topic, webhookId: params.webhookId || null } });
    return { accountId: account.id, action: 'product_upserted', count };
  }

  if (topic.startsWith('customers/')) {
    await ensureCustomer(ctx, 'shopify', trim(payload?.id) || null, { ...payload, webhook_metadata: metadata });
    await setSyncStatus(account.id, 'customers', 'synced', { metadata: { topic, webhookId: params.webhookId || null } });
    return { accountId: account.id, action: 'customer_upserted' };
  }

  if (topic === 'inventory_levels/update') {
    const mapping: any = await one(
      `SELECT m.*, i.wms_inventory
       FROM item_channel_mappings m
       JOIN catalog_items i ON i.id = m.item_id
       WHERE m.user_id = $1 AND m.channel_connection_id = $2 AND m.payload->>'inventory_item_id' = $3
       LIMIT 1`,
      [account.user_id, account.id, trim(payload?.inventory_item_id)],
    );
    if (mapping?.item_id) {
      await pgQuery(
        `UPDATE catalog_items
         SET wms_inventory = wms_inventory || $3::jsonb,
             metadata = metadata || $4::jsonb,
             updated_at = now()
         WHERE id = $1 AND user_id = $2`,
        [
          mapping.item_id,
          account.user_id,
          JSON.stringify({ shopify: { locationId: String(payload?.location_id || ''), available: num(payload?.available) } }),
          JSON.stringify({ ...metadata, shopifyInventorySyncedAt: new Date().toISOString() }),
        ],
      );
    }
    await setSyncStatus(account.id, 'inventory', 'synced', { metadata: { topic, webhookId: params.webhookId || null } });
    return { accountId: account.id, action: 'inventory_updated', matched: Boolean(mapping?.item_id) };
  }

  return { accountId: account.id, action: 'ignored', topic };
}

export async function pullShopifySql(params: SyncContext & { shopDomain: string; accessToken: string; initialSync?: boolean }): Promise<PullResult> {
  const { shopDomain, accessToken, initialSync, ...ctx } = params;
  const base = `https://${shopDomain}/admin/api/${config.shopify.apiVersion}`;
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken };
  const result: PullResult = { errors: {} };

  try {
    await setSyncStatus(ctx.channelAccountId, 'products', 'syncing');
    let count = 0;
    let pageInfo: string | null = null;
    do {
      const url = pageInfo ? `${base}/products.json?limit=250&page_info=${encodeURIComponent(pageInfo)}` : `${base}/products.json?limit=250`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      for (const product of Array.isArray(body?.products) ? body.products : []) {
        const images = Array.isArray(product?.images) ? product.images.map((image: any) => image?.src || image?.url).filter(Boolean) : [];
        for (const variant of Array.isArray(product?.variants) ? product.variants : []) {
          const sku = trim(variant?.sku);
          if (!sku) continue;
          const item: any = await upsertCatalogItem({
            userId: ctx.userId,
            sku,
            title: trim(product?.title) || sku,
            description: plainText(product?.body_html),
            image: images[0] || null,
            images,
            metadata: { source: 'shopify_sync', productId: product?.id, variantId: variant?.id, inventoryItemId: variant?.inventory_item_id },
          });
          if (item?.id) {
            await upsertMapping({
              userId: ctx.userId,
              itemId: item.id,
              channelAccountId: ctx.channelAccountId,
              channel: 'shopify',
              channelItemId: trim(product?.id),
              channelVariantId: trim(variant?.id) || null,
              sku,
              status: product?.status === 'active' ? 'active' : 'inactive',
              payload: { product, variant, inventory_item_id: variant?.inventory_item_id },
            });
            count++;
          }
        }
      }
      pageInfo = parseNextPageInfo(res.headers.get('link'));
    } while (pageInfo);
    result.products = count;
    await setSyncStatus(ctx.channelAccountId, 'products', 'synced', { count });
  } catch (err: any) {
    const error = err?.message || 'Products sync failed';
    result.errors!.products = error;
    await setSyncStatus(ctx.channelAccountId, 'products', 'error', { error });
  }

  try {
    await setSyncStatus(ctx.channelAccountId, 'orders', 'syncing');
    const since = new Date(Date.now() - (initialSync ? 90 : 7) * MS_PER_DAY).toISOString();
    let count = 0;
    let pageInfo: string | null = null;
    do {
      const url = pageInfo
        ? `${base}/orders.json?status=any&limit=250&page_info=${encodeURIComponent(pageInfo)}`
        : `${base}/orders.json?status=any&limit=250&order=created_at%20desc&created_at_min=${encodeURIComponent(since)}`;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      for (const order of Array.isArray(body?.orders) ? body.orders : []) {
        await upsertOrder(ctx, 'shopify', order);
        count++;
      }
      pageInfo = parseNextPageInfo(res.headers.get('link'));
    } while (pageInfo);
    result.orders = count;
    await setSyncStatus(ctx.channelAccountId, 'orders', 'synced', { count });
  } catch (err: any) {
    const error = err?.message || 'Orders sync failed';
    result.errors!.orders = error;
    await setSyncStatus(ctx.channelAccountId, 'orders', 'error', { error });
  }

  try {
    await setSyncStatus(ctx.channelAccountId, 'customers', 'syncing');
    const count = await syncShopifyCustomers(ctx, base, headers, Boolean(initialSync));
    result.customers = count;
    await setSyncStatus(ctx.channelAccountId, 'customers', 'synced', { count });
  } catch (err: any) {
    const error = err?.message || 'Customers sync failed';
    result.errors!.customers = error;
    await setSyncStatus(ctx.channelAccountId, 'customers', 'error', { error });
  }

  try {
    await setSyncStatus(ctx.channelAccountId, 'inventory', 'syncing');
    const count = await syncShopifyInventory(ctx, base, headers);
    result.inventory = count;
    await setSyncStatus(ctx.channelAccountId, 'inventory', 'synced', { count });
  } catch (err: any) {
    const error = err?.message || 'Inventory sync failed';
    result.errors!.inventory = error;
    await setSyncStatus(ctx.channelAccountId, 'inventory', 'error', { error });
  }

  if (Object.keys(result.errors || {}).length === 0) delete result.errors;
  return result;
}

async function syncShopifyCustomers(ctx: SyncContext, base: string, headers: Record<string, string>, initialSync: boolean) {
  if (!initialSync) return 0;
  const since = new Date(Date.now() - 90 * MS_PER_DAY).toISOString();
  let count = 0;
  let pageInfo: string | null = null;
  do {
    const url = pageInfo
      ? `${base}/customers.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `${base}/customers.json?limit=250&created_at_min=${encodeURIComponent(since)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    for (const customer of Array.isArray(body?.customers) ? body.customers : []) {
      await ensureCustomer(ctx, 'shopify', trim(customer?.id) || null, customer);
      count++;
    }
    pageInfo = parseNextPageInfo(res.headers.get('link'));
  } while (pageInfo);
  return count;
}

async function syncShopifyInventory(ctx: SyncContext, base: string, headers: Record<string, string>) {
  const locationsRes = await fetch(`${base}/locations.json`, { headers });
  if (!locationsRes.ok) throw new Error(locationsRes.status === 401 || locationsRes.status === 403 ? 'Locations access denied. Reconnect Shopify with read_locations scope.' : `HTTP ${locationsRes.status}`);
  const locationsBody: any = await locationsRes.json();
  const location = Array.isArray(locationsBody?.locations) ? locationsBody.locations[0] : null;
  if (!location?.id) return 0;
  const res = await fetch(`${base}/inventory_levels.json?limit=250&location_ids[]=${encodeURIComponent(String(location.id))}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: any = await res.json();
  let count = 0;
  for (const level of Array.isArray(body?.inventory_levels) ? body.inventory_levels : []) {
    const mapping: any = await one(
      `SELECT m.*, i.wms_inventory
       FROM item_channel_mappings m
       JOIN catalog_items i ON i.id = m.item_id
       WHERE m.user_id = $1 AND m.channel_connection_id = $2 AND m.payload->>'inventory_item_id' = $3
       LIMIT 1`,
      [ctx.userId, ctx.channelAccountId, trim(level?.inventory_item_id)],
    );
    if (!mapping?.item_id) continue;
    await pgQuery(
      `UPDATE catalog_items
       SET wms_inventory = wms_inventory || $3::jsonb,
           metadata = metadata || $4::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [
        mapping.item_id,
        ctx.userId,
        JSON.stringify({ shopify: { locationId: String(level.location_id), available: num(level.available) } }),
        JSON.stringify({ shopifyInventorySyncedAt: new Date().toISOString() }),
      ],
    );
    count++;
  }
  return count;
}

export async function pullEbaySql(params: SyncContext & { accessToken: string; marketplaceId?: string; since?: string }): Promise<PullResult> {
  const marketplaceId = params.marketplaceId || config.ebay.marketplaceId || 'EBAY_US';
  const since = params.since || new Date(Date.now() - 2 * MS_PER_DAY).toISOString();
  const result: PullResult = { errors: {} };

  try {
    await setSyncStatus(params.channelAccountId, 'orders', 'syncing');
    const orders = await fetchEbayOrders(params.accessToken, marketplaceId, since);
    for (const order of orders) await upsertOrder(params, 'ebay', order);
    result.orders = orders.length;
    await setSyncStatus(params.channelAccountId, 'orders', 'synced', { count: orders.length });
  } catch (err: any) {
    const error = err?.message || 'eBay orders sync failed';
    result.errors!.orders = error;
    await setSyncStatus(params.channelAccountId, 'orders', 'error', { error });
  }

  try {
    await setSyncStatus(params.channelAccountId, 'inventory', 'syncing');
    const items = await fetchEbayInventory(params.accessToken, marketplaceId);
    for (const item of items) {
      const sku = trim(item?.sku);
      if (!sku) continue;
      const catalog: any = await upsertCatalogItem({
        userId: params.userId,
        sku,
        title: trim(item?.product?.title || item?.title) || sku,
        metadata: { source: 'ebay_sync', marketplaceId },
      });
      if (catalog?.id) {
        await upsertMapping({
          userId: params.userId,
          itemId: catalog.id,
          channelAccountId: params.channelAccountId,
          channel: 'ebay',
          channelItemId: sku,
          sku,
          payload: item,
        });
        const quantity = item?.availability?.shipToLocationAvailability?.quantity;
        if (quantity !== undefined) {
          await pgQuery(
            `UPDATE catalog_items
             SET wms_inventory = wms_inventory || $3::jsonb, updated_at = now()
             WHERE id = $1 AND user_id = $2`,
            [catalog.id, params.userId, JSON.stringify({ ebay: { marketplaceId, available: num(quantity) } })],
          );
        }
      }
    }
    result.inventory = items.length;
    result.products = items.length;
    await setSyncStatus(params.channelAccountId, 'inventory', 'synced', { count: items.length });
    await setSyncStatus(params.channelAccountId, 'products', 'synced', { count: items.length });
    await setSyncStatus(params.channelAccountId, 'customers', 'synced', { count: 0, metadata: { derivedFromOrders: true } });
  } catch (err: any) {
    const error = err?.message || 'eBay inventory sync failed';
    result.errors!.inventory = error;
    await setSyncStatus(params.channelAccountId, 'inventory', 'error', { error });
  }

  if (Object.keys(result.errors || {}).length === 0) delete result.errors;
  return result;
}

async function fetchEbayOrders(accessToken: string, marketplaceId: string, since: string) {
  const qs = new URLSearchParams({
    limit: '50',
    filter: `creationdate:[${since}..${new Date().toISOString()}]`,
  });
  const orders: any[] = [];
  let path: string | undefined = `/sell/fulfillment/v1/order?${qs.toString()}`;
  while (path) {
    const page: any = await ebayGet(path, accessToken, { marketplaceId });
    orders.push(...(Array.isArray(page?.orders) ? page.orders : []));
    path = normalizeNext(page?.next);
  }
  return orders;
}

async function fetchEbayInventory(accessToken: string, marketplaceId: string) {
  const items: any[] = [];
  let path: string | undefined = '/sell/inventory/v1/inventory_item?limit=50';
  while (path) {
    const page: any = await ebayGet(path, accessToken, { marketplaceId });
    items.push(...(Array.isArray(page?.inventoryItems) ? page.inventoryItems : []));
    path = normalizeNext(page?.next);
  }
  return items;
}

export async function markMarketplaceRefresh(accountId: string, userId: string, syncResult: PullResult) {
  return withPgTransaction(async (client) => {
    const res = await client.query(
      `UPDATE marketplace_connections
       SET last_sync_at = now(),
           updated_at = now(),
           metadata = metadata || $3::jsonb
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        accountId,
        userId,
        JSON.stringify({
          lastManualRefresh: new Date().toISOString(),
          refreshMode: 'api_pull',
          lastSyncResult: syncResult,
        }),
      ],
    );
    return res.rows[0] || null;
  });
}
