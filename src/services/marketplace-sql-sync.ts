import fetch from 'node-fetch';
import { QueryResultRow } from 'pg';
import { URLSearchParams } from 'url';
import { config } from '../config/env';
import { pgQuery, withPgTransaction } from '../db/postgres';
import { ebayGet } from './ebay';
import { setSyncStatus } from './channel-sync-status';
import { pushOrderToWms } from '../routes/sql-mode.routes';

type PullResult = {
  products?: number;
  orders?: number;
  customers?: number;
  inventory?: number;
  errors?: Record<string, string>;
  warnings?: Record<string, string>;
};

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

function json(value: unknown, fallback: any) {
  return value == null ? fallback : value;
}

function plainText(html: unknown) {
  return typeof html === 'string' ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) : null;
}

function shopifyVariantSku(product: any, variant: any) {
  const explicit = trim(variant?.sku);
  if (explicit) return explicit;
  const handle = trim(product?.handle || product?.title)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `SHOPIFY-${handle || 'VARIANT'}-${trim(variant?.id || variant?.inventory_item_id || 'NOID')}`;
}

async function shopifyGraphql(
  base: string,
  headers: Record<string, string>,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await fetch(`${base}/graphql.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const body: any = await response.json().catch(() => ({}));
  if (!response.ok || body?.errors?.length) {
    const message = body?.errors?.map((error: any) => error?.message).filter(Boolean).join('; ');
    throw new Error(message || `Shopify GraphQL HTTP ${response.status}`);
  }
  return body?.data || {};
}

function shopifyLegacyId(node: any) {
  return trim(node?.legacyResourceId || node?.id);
}

function shopifyAddress(address: any) {
  if (!address) return {};
  return {
    address1: address.address1 || null,
    address2: address.address2 || null,
    city: address.city || null,
    province_code: address.provinceCode || null,
    zip: address.zip || null,
    country_code: address.countryCodeV2 || null,
  };
}

function shopifyCustomer(customer: any) {
  if (!customer) return null;
  return {
    id: shopifyLegacyId(customer),
    first_name: customer.firstName || null,
    last_name: customer.lastName || null,
    email: customer.email || customer.defaultEmailAddress?.emailAddress || null,
    phone: customer.phone || customer.defaultPhoneNumber?.phoneNumber || null,
    default_address: shopifyAddress(customer.defaultAddress),
  };
}

function shopifyOrder(order: any) {
  const money = (set: any) => set?.shopMoney?.amount ?? 0;
  return {
    id: shopifyLegacyId(order),
    name: order?.name,
    created_at: order?.createdAt,
    fulfillment_status: String(order?.displayFulfillmentStatus || 'UNFULFILLED').toLowerCase(),
    financial_status: String(order?.displayFinancialStatus || 'PENDING').toLowerCase(),
    currency: order?.currencyCode || 'USD',
    subtotal_price: money(order?.currentSubtotalPriceSet),
    total_tax: money(order?.currentTotalTaxSet),
    total_discounts: money(order?.currentTotalDiscountsSet),
    total_price: money(order?.currentTotalPriceSet),
    shipping_lines: [{ price: money(order?.totalShippingPriceSet) }],
    customer: shopifyCustomer(order?.customer),
    shipping_address: shopifyAddress(order?.shippingAddress),
    billing_address: shopifyAddress(order?.billingAddress),
    line_items: (order?.lineItems?.nodes || []).map((line: any) => ({
      id: shopifyLegacyId(line),
      sku: line?.sku || null,
      title: line?.title || null,
      quantity: line?.quantity || 0,
      price: money(line?.originalUnitPriceSet),
    })),
  };
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

async function rows<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
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

async function updateShopifyInventoryFromVariant(ctx: SyncContext, itemId: string, variant: any, source: string) {
  if (variant?.inventory_quantity === undefined || variant?.inventory_quantity === null) return false;
  const qty = num(variant.inventory_quantity);
  const inventoryPayload = {
    available: qty,
    inventoryItemId: trim(variant?.inventory_item_id) || null,
    source,
    channelAccountId: ctx.channelAccountId,
  };
  await pgQuery(
    `UPDATE catalog_items
     SET wms_inventory = wms_inventory || $3::jsonb || jsonb_build_object('shopifyStores', COALESCE(wms_inventory->'shopifyStores', '{}'::jsonb) || $5::jsonb),
         metadata = metadata || $4::jsonb,
         updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [
      itemId,
      ctx.userId,
      JSON.stringify({
        shopify: inventoryPayload,
      }),
      JSON.stringify({ shopifyInventorySyncedAt: new Date().toISOString(), shopifyInventorySource: source }),
      JSON.stringify({ [ctx.channelAccountId]: inventoryPayload }),
    ],
  );
  return true;
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

  // Push to the WMS once per order — subsequent polls of the same order shouldn't re-push (the
  // WMS/upsertWmsOrder match is idempotent, but skip the redundant network call). Never throws:
  // a WMS-side failure must not abort the rest of this sync batch.
  const wmsStatus = (order.metadata as any)?.wms?.status;
  if (wmsStatus !== 'pushed') {
    try {
      await pushOrderToWms(ctx.userId, order.id);
    } catch (err: any) {
      ctx.log?.warn?.({ err, orderId: order.id, channel }, 'pushOrderToWms failed during marketplace sync');
    }
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
      const sku = shopifyVariantSku(payload, variant);
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
          payload: { ...metadata, product: payload, variant, inventory_item_id: variant?.inventory_item_id, originalSku: trim(variant?.sku) || null },
        });
        await updateShopifyInventoryFromVariant({ userId: account.user_id, channelAccountId: account.id }, item.id, variant, 'product_webhook_variant');
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
    let cursor: string | null = null;
    do {
      const data = await shopifyGraphql(base, headers, `query UnieConnectProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: UPDATED_AT) {
          nodes { id legacyResourceId title descriptionHtml handle status images(first: 20) { nodes { url } }
            variants(first: 100) { nodes { id legacyResourceId sku price inventoryQuantity inventoryItem { id legacyResourceId } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { first: 100, after: cursor });
      for (const node of data?.products?.nodes || []) {
        const product = {
          id: shopifyLegacyId(node), title: node.title, body_html: node.descriptionHtml, handle: node.handle,
          status: String(node.status || '').toLowerCase(),
        };
        const images = (node?.images?.nodes || []).map((image: any) => image?.url).filter(Boolean);
        for (const variantNode of node?.variants?.nodes || []) {
          const variant = {
            id: shopifyLegacyId(variantNode), sku: variantNode.sku, price: variantNode.price,
            inventory_quantity: variantNode.inventoryQuantity,
            inventory_item_id: shopifyLegacyId(variantNode.inventoryItem),
          };
          const sku = shopifyVariantSku(product, variant);
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
              payload: { product, variant, inventory_item_id: variant?.inventory_item_id, originalSku: trim(variant?.sku) || null },
            });
            await updateShopifyInventoryFromVariant(ctx, item.id, variant, 'product_variant');
            count++;
          }
        }
      }
      const pageInfo = data?.products?.pageInfo;
      cursor = pageInfo?.hasNextPage ? pageInfo?.endCursor || null : null;
    } while (cursor);
    result.products = count;
    await setSyncStatus(ctx.channelAccountId, 'products', 'synced', { count });
  } catch (err: any) {
    const error = err?.message || 'Products sync failed';
    result.errors!.products = error;
    await setSyncStatus(ctx.channelAccountId, 'products', 'error', { error });
  }

  try {
    await setSyncStatus(ctx.channelAccountId, 'orders', 'syncing');
    const configuredBackfillDays = Number(process.env.SHOPIFY_INITIAL_ORDER_BACKFILL_DAYS || 730);
    const backfillDays = Math.min(3650, Math.max(90, Number.isFinite(configuredBackfillDays) ? configuredBackfillDays : 730));
    const windowDays = initialSync ? backfillDays : 7;
    const since = new Date(Date.now() - windowDays * MS_PER_DAY).toISOString();
    let count = 0;
    let cursor: string | null = null;
    do {
      const data = await shopifyGraphql(base, headers, `query UnieConnectOrders($first: Int!, $after: String, $query: String!) {
        orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
          nodes { id legacyResourceId name createdAt displayFulfillmentStatus displayFinancialStatus currencyCode
            currentSubtotalPriceSet { shopMoney { amount } } currentTotalTaxSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } } currentTotalDiscountsSet { shopMoney { amount } }
            currentTotalPriceSet { shopMoney { amount } }
            customer { id legacyResourceId firstName lastName email phone defaultAddress { address1 address2 city provinceCode zip countryCodeV2 } }
            shippingAddress { address1 address2 city provinceCode zip countryCodeV2 }
            billingAddress { address1 address2 city provinceCode zip countryCodeV2 }
            lineItems(first: 100) { nodes { id sku title quantity originalUnitPriceSet { shopMoney { amount } } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`, { first: 100, after: cursor, query: `created_at:>=${since}` });
      for (const order of data?.orders?.nodes || []) {
        await upsertOrder(ctx, 'shopify', shopifyOrder(order));
        count++;
      }
      const pageInfo = data?.orders?.pageInfo;
      cursor = pageInfo?.hasNextPage ? pageInfo?.endCursor || null : null;
    } while (cursor);
    result.orders = count;
    const totalImportedRow = await one<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM orders
       WHERE user_id = $1 AND channel_connection_id = $2 AND channel = 'shopify'`,
      [ctx.userId, ctx.channelAccountId],
    );
    const totalImported = num(totalImportedRow?.count);
    await setSyncStatus(ctx.channelAccountId, 'orders', 'synced', {
      count: totalImported,
      metadata: {
        windowDays,
        rowsProcessed: count,
        totalImported,
        ...(initialSync ? { historicalBackfill: true, historicalBackfillCompletedAt: new Date().toISOString() } : {}),
      },
    });
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
    const inventorySync = await syncShopifyInventory(ctx, base, headers);
    result.inventory = inventorySync.count;
    await setSyncStatus(ctx.channelAccountId, 'inventory', 'synced', {
      count: inventorySync.count,
      metadata: {
        source: inventorySync.source,
        degraded: false,
        warning: null,
        coverage: inventorySync.coverage || 'location_level',
        locationLevelAvailable: inventorySync.locationLevelAvailable !== false,
        notice: inventorySync.notice || null,
      },
    });
  } catch (err: any) {
    const fallback = await syncShopifyInventoryFromMappedVariants(ctx).catch(() => 0);
    if (fallback > 0) {
      result.inventory = fallback;
      result.warnings = { ...(result.warnings || {}), inventory: 'Per-location inventory is unavailable; synchronized store totals from product variants.' };
      await setSyncStatus(ctx.channelAccountId, 'inventory', 'synced', {
        count: fallback,
        metadata: {
          source: 'mapped_variant_fallback',
          degraded: false,
          coverage: 'store_total',
          locationLevelAvailable: false,
          notice: 'Shopify store inventory totals are synchronized. Per-location allocation is not enabled for this installation.',
        },
      });
    } else {
      const error = err?.message || 'Inventory sync failed';
      result.errors!.inventory = error;
      await setSyncStatus(ctx.channelAccountId, 'inventory', 'error', { error });
    }
  }

  if (Object.keys(result.errors || {}).length === 0) delete result.errors;
  return result;
}

async function syncShopifyCustomers(ctx: SyncContext, base: string, headers: Record<string, string>, initialSync: boolean) {
  if (!initialSync) return 0;
  const since = new Date(Date.now() - 90 * MS_PER_DAY).toISOString();
  let count = 0;
  let cursor: string | null = null;
  do {
    const data = await shopifyGraphql(base, headers, `query UnieConnectCustomers($first: Int!, $after: String, $query: String!) {
      customers(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
        nodes { id legacyResourceId firstName lastName email phone defaultAddress { address1 address2 city provinceCode zip countryCodeV2 } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { first: 100, after: cursor, query: `created_at:>=${since}` });
    for (const customerNode of data?.customers?.nodes || []) {
      const customer = shopifyCustomer(customerNode);
      await ensureCustomer(ctx, 'shopify', trim(customer?.id) || null, customer);
      count++;
    }
    const pageInfo = data?.customers?.pageInfo;
    cursor = pageInfo?.hasNextPage ? pageInfo?.endCursor || null : null;
  } while (cursor);
  return count;
}

async function syncShopifyInventory(ctx: SyncContext, base: string, headers: Record<string, string>) {
  let count = 0;
  let cursor: string | null = null;
  do {
    const data = await shopifyGraphql(base, headers, `query UnieConnectInventory($first: Int!, $after: String) {
      inventoryItems(first: $first, after: $after) {
        nodes { id legacyResourceId inventoryLevels(first: 100) { nodes {
          location { id legacyResourceId name } quantities(names: ["available"]) { name quantity }
        } } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { first: 100, after: cursor });
    for (const inventoryItem of data?.inventoryItems?.nodes || []) {
      const inventoryItemId = shopifyLegacyId(inventoryItem);
      const mapping: any = await one(
        `SELECT m.*, i.wms_inventory FROM item_channel_mappings m
         JOIN catalog_items i ON i.id = m.item_id
         WHERE m.user_id = $1 AND m.channel_connection_id = $2 AND m.payload->>'inventory_item_id' = $3 LIMIT 1`,
        [ctx.userId, ctx.channelAccountId, inventoryItemId],
      );
      if (!mapping?.item_id) continue;
      const locations = (inventoryItem?.inventoryLevels?.nodes || []).map((level: any) => ({
        locationId: shopifyLegacyId(level?.location),
        locationName: level?.location?.name || null,
        available: num((level?.quantities || []).find((quantity: any) => quantity?.name === 'available')?.quantity),
      }));
      const available = locations.reduce((sum: number, location: any) => sum + num(location.available), 0);
      await pgQuery(
        `UPDATE catalog_items
         SET wms_inventory = wms_inventory || $3::jsonb || jsonb_build_object('shopifyStores', COALESCE(wms_inventory->'shopifyStores', '{}'::jsonb) || $5::jsonb),
             metadata = metadata || $4::jsonb, updated_at = now()
         WHERE id = $1 AND user_id = $2`,
        [
          mapping.item_id,
          ctx.userId,
          JSON.stringify({ shopify: { available, locations, channelAccountId: ctx.channelAccountId } }),
          JSON.stringify({ shopifyInventorySyncedAt: new Date().toISOString() }),
          JSON.stringify({ [ctx.channelAccountId]: { available, locations, channelAccountId: ctx.channelAccountId, source: 'inventory_levels_graphql' } }),
        ],
      );
      count++;
    }
    const pageInfo = data?.inventoryItems?.pageInfo;
    cursor = pageInfo?.hasNextPage ? pageInfo?.endCursor || null : null;
  } while (cursor);
  return { count, source: 'inventory_levels_graphql', coverage: 'location_level', locationLevelAvailable: true, notice: null };
}

async function syncShopifyInventoryFromMappedVariants(ctx: SyncContext) {
  const mappings = await rows(
    `SELECT m.item_id, m.payload
     FROM item_channel_mappings m
     WHERE m.user_id = $1 AND m.channel_connection_id = $2 AND m.channel = 'shopify'`,
    [ctx.userId, ctx.channelAccountId],
  );
  let count = 0;
  for (const mapping of mappings) {
    const payload = json(mapping.payload, {});
    const variant = payload.variant || {};
    if (await updateShopifyInventoryFromVariant(ctx, mapping.item_id, variant, 'mapped_variant_fallback')) count++;
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
