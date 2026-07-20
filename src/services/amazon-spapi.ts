import fetch from 'node-fetch';
import { URLSearchParams } from 'url';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';
import { refreshAccessToken } from './amazon-auth';
import { setSyncStatus } from './channel-sync-status';
import { pushOrderToWms } from '../routes/sql-mode.routes';

const aws4 = require('aws4');

type AnyRow = Record<string, any>;
type PullResult = { products?: number; orders?: number; customers?: number; inventory?: number; errors?: Record<string, string> };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function trim(value: unknown) {
  return value == null ? '' : String(value).trim();
}

function num(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function one<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T | null> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows?.[0] || null;
}

export function amazonAppIdKind(appId = config.amazon.appId) {
  if (!appId) return 'missing';
  if (appId.startsWith('amzn1.sellerapps.app.')) return 'seller_app';
  if (appId.startsWith('amzn1.sp.solution.')) return 'sp_solution';
  return 'nonstandard';
}

export function amazonSpApiRegion(region = config.amazon.region) {
  const r = trim(region).toLowerCase();
  if (r === 'eu') return { code: 'eu', host: 'sellingpartnerapi-eu.amazon.com', awsRegion: 'eu-west-1' };
  if (r === 'fe') return { code: 'fe', host: 'sellingpartnerapi-fe.amazon.com', awsRegion: 'us-west-2' };
  return { code: 'na', host: 'sellingpartnerapi-na.amazon.com', awsRegion: 'us-east-1' };
}

export function amazonSpApiConfigHealth() {
  const region = amazonSpApiRegion();
  const oauthReady = Boolean(config.amazon.clientId && config.amazon.clientSecret && config.amazon.appId && config.amazon.redirectUri);
  const signingReady = Boolean(config.amazon.awsAccessKeyId && config.amazon.awsSecretAccessKey);
  return {
    oauthReady,
    signingReady,
    appIdKind: amazonAppIdKind(),
    redirectUri: config.amazon.redirectUri || null,
    region: region.code,
    host: region.host,
  };
}

async function ensureAccessToken(connection: AnyRow) {
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
  let accessToken = trim(connection.access_token_enc);
  if ((!accessToken || expiresAt < Date.now() + 60_000) && connection.refresh_token_enc) {
    const token = await refreshAccessToken(connection.refresh_token_enc);
    accessToken = token.access_token;
    const tokenExpiresAt = new Date(Date.now() + Math.max(1, token.expires_in || 3600) * 1000).toISOString();
    connection.access_token_enc = accessToken;
    connection.token_expires_at = tokenExpiresAt;
    if (token.refresh_token) connection.refresh_token_enc = token.refresh_token;
    await pgQuery(
      `UPDATE marketplace_connections
       SET access_token_enc = $3,
           refresh_token_enc = COALESCE($4, refresh_token_enc),
           token_expires_at = $5,
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [connection.id, connection.user_id, accessToken, token.refresh_token || null, tokenExpiresAt],
    );
  }
  if (!accessToken) throw new Error('Amazon connection is missing LWA access token. Reconnect Amazon Seller Central.');
  return accessToken;
}

export async function amazonRequest(connection: AnyRow, method: string, path: string, body?: unknown) {
  const health = amazonSpApiConfigHealth();
  if (!health.signingReady) throw new Error('Amazon SP-API AWS signing credentials are not configured');
  const { host, awsRegion } = amazonSpApiRegion(connection.metadata?.region || config.amazon.region);
  const accessToken = await ensureAccessToken(connection);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = aws4.sign(
    {
      host,
      path,
      method,
      service: 'execute-api',
      region: awsRegion,
      headers: {
        host,
        accept: 'application/json',
        'content-type': 'application/json',
        'x-amz-access-token': accessToken,
      },
      body: payload,
    },
    {
      accessKeyId: config.amazon.awsAccessKeyId,
      secretAccessKey: config.amazon.awsSecretAccessKey,
      sessionToken: config.amazon.awsSessionToken || undefined,
    },
  );

  const res = await fetch(`https://${host}${path}`, {
    method,
    headers: request.headers as Record<string, string>,
    body: payload,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = json?.errors?.[0]?.message || json?.message || text || `HTTP ${res.status}`;
    throw new Error(`Amazon SP-API ${method} ${path.split('?')[0]} failed (${res.status}): ${message}`);
  }
  return json;
}

function money(raw: any) {
  return {
    amount: num(raw?.Amount),
    currency: raw?.CurrencyCode || 'USD',
  };
}

async function ensureAmazonCustomer(ctx: { userId: string }, order: any) {
  const externalCustomerId = trim(order?.BuyerInfo?.BuyerEmail || order?.BuyerInfo?.BuyerName || order?.AmazonOrderId) || null;
  if (!externalCustomerId) return null;
  const existing = await one('SELECT * FROM customers WHERE user_id = $1 AND channel = $2 AND external_customer_id = $3 LIMIT 1', [
    ctx.userId,
    'amazon',
    externalCustomerId,
  ]);
  if (existing) return existing;
  return one(
    `INSERT INTO customers (user_id, name, email, channel, external_customer_id, addresses, metadata)
     VALUES ($1, $2, $3, 'amazon', $4, $5::jsonb, $6::jsonb)
     RETURNING *`,
    [
      ctx.userId,
      trim(order?.BuyerInfo?.BuyerName) || 'Amazon buyer',
      trim(order?.BuyerInfo?.BuyerEmail) || null,
      externalCustomerId,
      JSON.stringify(order?.ShippingAddress ? [order.ShippingAddress] : []),
      JSON.stringify({ source: 'amazon_sync', piiLimited: !order?.BuyerInfo?.BuyerEmail }),
    ],
  );
}

async function upsertAmazonOrder(params: { userId: string; channelAccountId: string; connection: AnyRow; order: any }) {
  const { userId, channelAccountId, connection, order } = params;
  const externalOrderId = trim(order?.AmazonOrderId);
  if (!externalOrderId) return false;
  const customer = await ensureAmazonCustomer({ userId }, order);
  const total = money(order?.OrderTotal);
  const totals = { subtotal: total.amount, tax: 0, shipping: 0, discounts: 0, total: total.amount, currency: total.currency };
  const existing = await one('SELECT * FROM orders WHERE user_id = $1 AND channel_connection_id = $2 AND external_order_id = $3 LIMIT 1', [
    userId,
    channelAccountId,
    externalOrderId,
  ]);
  const common = [
    customer?.id || null,
    trim(order?.OrderStatus) || 'open',
    ['Unshipped', 'PartiallyShipped', 'Shipped'].includes(trim(order?.OrderStatus)) ? 'paid' : null,
    order?.PurchaseDate || order?.LastUpdateDate || null,
    JSON.stringify(totals),
    JSON.stringify(order?.ShippingAddress || {}),
    JSON.stringify({}),
    JSON.stringify({ source: 'amazon_sync', raw: order }),
  ];
  const saved = existing
    ? await one(
        `UPDATE orders
         SET customer_id = $4, status = $5, paid = $6, placed_at = COALESCE($7::timestamptz, placed_at),
             totals = $8::jsonb, shipping_address = $9::jsonb, billing_address = $10::jsonb,
             metadata = metadata || $11::jsonb, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND channel_connection_id = $3
         RETURNING *`,
        [existing.id, userId, channelAccountId, ...common],
      )
    : await one(
        `INSERT INTO orders
          (user_id, customer_id, channel_connection_id, channel, external_order_id, order_number, status, paid, placed_at, totals, shipping_address, billing_address, metadata)
         VALUES ($1, $2, $3, 'amazon', $4, $5, $6, $7, COALESCE($8::timestamptz, now()), $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
         RETURNING *`,
        [userId, customer?.id || null, channelAccountId, externalOrderId, trim(order?.SellerOrderId) || externalOrderId, ...common.slice(1)],
      );
  if (!saved?.id) return true;

  try {
    const itemPage = await amazonRequest(connection, 'GET', `/orders/v0/orders/${encodeURIComponent(externalOrderId)}/orderItems`);
    const items = Array.isArray(itemPage?.payload?.OrderItems) ? itemPage.payload.OrderItems : [];
    await pgQuery('DELETE FROM order_lines WHERE user_id = $1 AND order_id = $2', [userId, saved.id]);
    for (const line of items) {
      const sku = trim(line?.SellerSKU) || null;
      const catalog = sku ? await one('SELECT * FROM catalog_items WHERE user_id = $1 AND lower(sku) = lower($2) LIMIT 1', [userId, sku]) : null;
      const quantity = num(line?.QuantityOrdered);
      const itemPrice = money(line?.ItemPrice);
      await pgQuery(
        `INSERT INTO order_lines (user_id, order_id, item_id, sku, title, quantity, unit_price, total_price, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          userId,
          saved.id,
          catalog?.id || null,
          sku,
          trim(line?.Title) || sku || 'Amazon item',
          quantity,
          quantity ? itemPrice.amount / quantity : itemPrice.amount,
          itemPrice.amount,
          JSON.stringify({ source: 'amazon_order_items_sync', raw: line }),
        ],
      );
    }
  } catch {
    await pgQuery(
      `UPDATE orders
       SET metadata = metadata || $3::jsonb, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [saved.id, userId, JSON.stringify({ amazonOrderItemsSync: 'failed_or_not_authorized' })],
    );
  }

  // Push to the WMS once per order (subsequent poll cycles skip — the WMS-side match is
  // idempotent, but avoid the redundant network call). Never throws: a WMS failure must not
  // abort the rest of this Amazon sync batch.
  if ((saved.metadata as any)?.wms?.status !== 'pushed') {
    try {
      await pushOrderToWms(userId, saved.id);
    } catch {
      // logged/recorded inside pushOrderToWms; swallow here so the batch continues
    }
  }
  return true;
}

async function fetchAmazonOrders(connection: AnyRow, marketplaceId: string, since: string) {
  const orders: any[] = [];
  let nextToken = '';
  do {
    const qs = new URLSearchParams();
    if (nextToken) {
      qs.set('NextToken', nextToken);
    } else {
      qs.set('MarketplaceIds', marketplaceId);
      qs.set('CreatedAfter', since);
      qs.set('MaxResultsPerPage', '100');
    }
    const page = await amazonRequest(connection, 'GET', `/orders/v0/orders?${qs.toString()}`);
    orders.push(...(Array.isArray(page?.payload?.Orders) ? page.payload.Orders : []));
    nextToken = trim(page?.payload?.NextToken);
  } while (nextToken);
  return orders;
}

async function upsertAmazonProfile(params: {
  userId: string;
  channelAccountId: string;
  marketplaceId: string;
  sellerSku: string;
  asin?: string | null;
  title?: string | null;
  listingStatus?: string;
  fulfillmentChannel?: string;
  inventory?: Record<string, number>;
  raw?: Record<string, unknown>;
}) {
  const catalog = await one(
    `SELECT * FROM catalog_items
     WHERE user_id = $1 AND (lower(sku) = lower($2) OR ($3 <> '' AND asin = $3))
     ORDER BY CASE WHEN lower(sku) = lower($2) THEN 0 ELSE 1 END
     LIMIT 1`,
    [params.userId, params.sellerSku, params.asin || ''],
  );
  const blockers: string[] = [];
  if (!params.sellerSku) blockers.push('Missing Amazon seller SKU');
  if (!params.asin) blockers.push('Missing ASIN or Amazon listing mapping');
  const inv = params.inventory || {};
  return one(
    `INSERT INTO amazon_item_profiles (
      id, user_id, item_id, channel_connection_id, marketplace_id, seller_sku, asin, title,
      listing_status, fulfillment_channel, available_fba_qty, inbound_working_qty,
      inbound_shipped_qty, inbound_receiving_qty, reserved_qty, sync_status, last_amazon_sync_at, blockers, raw
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'sp_api_synced', now(), $16::text[], $17::jsonb)
    ON CONFLICT (user_id, marketplace_id, seller_sku)
    DO UPDATE SET item_id = COALESCE(EXCLUDED.item_id, amazon_item_profiles.item_id),
      channel_connection_id = EXCLUDED.channel_connection_id,
      asin = COALESCE(EXCLUDED.asin, amazon_item_profiles.asin),
      title = COALESCE(EXCLUDED.title, amazon_item_profiles.title),
      listing_status = EXCLUDED.listing_status,
      fulfillment_channel = EXCLUDED.fulfillment_channel,
      available_fba_qty = EXCLUDED.available_fba_qty,
      inbound_working_qty = EXCLUDED.inbound_working_qty,
      inbound_shipped_qty = EXCLUDED.inbound_shipped_qty,
      inbound_receiving_qty = EXCLUDED.inbound_receiving_qty,
      reserved_qty = EXCLUDED.reserved_qty,
      blockers = EXCLUDED.blockers,
      raw = amazon_item_profiles.raw || EXCLUDED.raw,
      sync_status = EXCLUDED.sync_status,
      last_amazon_sync_at = now(),
      updated_at = now()
    RETURNING *`,
    [
      `${params.userId}:amazon:${params.marketplaceId}:${params.sellerSku}`,
      params.userId,
      catalog?.id || null,
      params.channelAccountId,
      params.marketplaceId,
      params.sellerSku,
      params.asin || catalog?.asin || null,
      params.title || catalog?.title || params.sellerSku,
      params.listingStatus || (params.asin ? 'active' : 'needs_listing'),
      params.fulfillmentChannel || 'AMAZON',
      num(inv.available),
      num(inv.inboundWorking),
      num(inv.inboundShipped),
      num(inv.inboundReceiving),
      num(inv.reserved),
      blockers,
      JSON.stringify({ source: 'amazon_sp_api', ...(params.raw || {}) }),
    ],
  );
}

async function syncAmazonInventory(params: { userId: string; channelAccountId: string; connection: AnyRow; marketplaceId: string }) {
  const { userId, channelAccountId, connection, marketplaceId } = params;
  let count = 0;
  let nextToken = '';
  do {
    const qs = new URLSearchParams();
    if (nextToken) qs.set('nextToken', nextToken);
    qs.set('details', 'true');
    qs.set('granularityType', 'Marketplace');
    qs.set('granularityId', marketplaceId);
    qs.set('marketplaceIds', marketplaceId);
    const page = await amazonRequest(connection, 'GET', `/fba/inventory/v1/summaries?${qs.toString()}`);
    const summaries = Array.isArray(page?.payload?.inventorySummaries) ? page.payload.inventorySummaries : [];
    for (const summary of summaries) {
      const sellerSku = trim(summary?.sellerSku);
      if (!sellerSku) continue;
      const details = summary?.inventoryDetails || {};
      await upsertAmazonProfile({
        userId,
        channelAccountId,
        marketplaceId,
        sellerSku,
        asin: trim(summary?.asin) || null,
        title: trim(summary?.productName) || null,
        listingStatus: 'active',
        fulfillmentChannel: 'AMAZON',
        inventory: {
          available: num(details?.fulfillableQuantity ?? summary?.totalQuantity),
          inboundWorking: num(details?.inboundWorkingQuantity),
          inboundShipped: num(details?.inboundShippedQuantity),
          inboundReceiving: num(details?.inboundReceivingQuantity),
          reserved: num(details?.reservedQuantity?.totalReservedQuantity ?? details?.reservedQuantity),
        },
        raw: { inventorySummary: summary },
      });
      count++;
    }
    nextToken = trim(page?.pagination?.nextToken || page?.payload?.nextToken);
  } while (nextToken);
  return count;
}

async function syncAmazonCatalog(params: { userId: string; channelAccountId: string; connection: AnyRow; marketplaceId: string }) {
  const { userId, channelAccountId, connection, marketplaceId } = params;
  const items = await pgQuery<AnyRow>(
    `SELECT DISTINCT COALESCE(p.asin, i.asin) AS asin,
            COALESCE(p.seller_sku, i.sku) AS seller_sku,
            i.id AS item_id
     FROM catalog_items i
     LEFT JOIN amazon_item_profiles p ON p.item_id = i.id AND p.user_id = i.user_id
     WHERE i.user_id = $1 AND i.archived = false AND COALESCE(p.asin, i.asin) IS NOT NULL
     ORDER BY COALESCE(p.asin, i.asin)
     LIMIT 50`,
    [userId],
  );
  let count = 0;
  for (const row of items?.rows || []) {
    const asin = trim(row.asin);
    if (!asin) continue;
    const qs = new URLSearchParams({
      marketplaceIds: marketplaceId,
      includedData: 'summaries,attributes,images,productTypes,salesRanks',
    });
    const catalog = await amazonRequest(connection, 'GET', `/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${qs.toString()}`);
    const summary = Array.isArray(catalog?.summaries) ? catalog.summaries[0] : null;
    const image = Array.isArray(catalog?.images?.[0]?.images) ? catalog.images[0].images[0]?.link : null;
    await upsertAmazonProfile({
      userId,
      channelAccountId,
      marketplaceId,
      sellerSku: trim(row.seller_sku) || asin,
      asin,
      title: trim(summary?.itemName) || null,
      listingStatus: 'active',
      fulfillmentChannel: 'AMAZON',
      raw: { catalogItem: catalog },
    });
    if (row.item_id) {
      await pgQuery(
        `UPDATE catalog_items
         SET title = COALESCE($3, title),
             image = COALESCE($4, image),
             asin = COALESCE($5, asin),
             metadata = metadata || $6::jsonb,
             updated_at = now()
         WHERE id = $1 AND user_id = $2`,
        [row.item_id, userId, trim(summary?.itemName) || null, image || null, asin, JSON.stringify({ amazonCatalogSyncedAt: new Date().toISOString() })],
      );
    }
    count++;
  }
  return count;
}

export async function pullAmazonSql(params: { userId: string; channelAccountId: string; connection: AnyRow; initialSync?: boolean; log?: any }): Promise<PullResult> {
  const marketplaceId = params.connection.marketplace_id || 'ATVPDKIKX0DER';
  const result: PullResult = { errors: {} };

  try {
    await setSyncStatus(params.channelAccountId, 'inventory', 'syncing');
    const count = await syncAmazonInventory({ ...params, marketplaceId });
    result.inventory = count;
    result.products = Math.max(result.products || 0, count);
    await setSyncStatus(params.channelAccountId, 'inventory', 'synced', { count });
  } catch (err: any) {
    const error = err?.message || 'Amazon inventory sync failed';
    result.errors!.inventory = error;
    await setSyncStatus(params.channelAccountId, 'inventory', 'error', { error });
  }

  try {
    await setSyncStatus(params.channelAccountId, 'products', 'syncing');
    const count = await syncAmazonCatalog({ ...params, marketplaceId });
    result.products = Math.max(result.products || 0, count);
    await setSyncStatus(params.channelAccountId, 'products', 'synced', { count });
  } catch (err: any) {
    const error = err?.message || 'Amazon catalog sync failed';
    result.errors!.products = error;
    await setSyncStatus(params.channelAccountId, 'products', 'error', { error });
  }

  try {
    await setSyncStatus(params.channelAccountId, 'orders', 'syncing');
    const since = new Date(Date.now() - (params.initialSync ? 30 : 7) * MS_PER_DAY).toISOString();
    const orders = await fetchAmazonOrders(params.connection, marketplaceId, since);
    let count = 0;
    for (const order of orders) {
      if (await upsertAmazonOrder({
        userId: params.userId,
        channelAccountId: params.channelAccountId,
        connection: params.connection,
        order,
      })) count++;
    }
    result.orders = count;
    await setSyncStatus(params.channelAccountId, 'orders', 'synced', { count });
    await setSyncStatus(params.channelAccountId, 'customers', 'synced', { count, metadata: { derivedFromOrders: true } });
  } catch (err: any) {
    const error = err?.message || 'Amazon orders sync failed';
    result.errors!.orders = error;
    await setSyncStatus(params.channelAccountId, 'orders', 'error', { error });
  }

  if (Object.keys(result.errors || {}).length === 0) delete result.errors;
  return result;
}

export async function getAmazonAccountHealth(userId: string) {
  const rows = await pgQuery<AnyRow>(
    `SELECT id, status, display_name, selling_partner_id, marketplace_id, access_token_enc, refresh_token_enc, token_expires_at, metadata, last_sync_at
     FROM marketplace_connections
     WHERE user_id = $1 AND channel = 'amazon' AND status <> 'archived'
     ORDER BY updated_at DESC`,
    [userId],
  );
  const configHealth = amazonSpApiConfigHealth();
  return {
    config: configHealth,
    readyForLiveSync: configHealth.oauthReady && configHealth.signingReady,
    connections: (rows?.rows || []).map((row) => ({
      id: row.id,
      status: row.status,
      displayName: row.display_name,
      sellingPartnerId: row.selling_partner_id,
      marketplaceId: row.marketplace_id,
      hasAccessToken: Boolean(row.access_token_enc),
      hasRefreshToken: Boolean(row.refresh_token_enc),
      tokenExpiresAt: row.token_expires_at,
      lastSyncAt: row.last_sync_at,
      authorized: Boolean(row.refresh_token_enc),
      metadata: row.metadata || {},
    })),
  };
}

export async function getAmazonInboundLabels(connection: AnyRow, shipmentId: string, query: AnyRow = {}) {
  const qs = new URLSearchParams({
    PageType: trim(query.PageType || query.pageType || 'PackageLabel_Letter_2'),
    LabelType: trim(query.LabelType || query.labelType || 'UNIQUE'),
  });
  const numberOfPackages = trim(query.NumberOfPackages || query.numberOfPackages);
  const packageLabelsToPrint = trim(query.PackageLabelsToPrint || query.packageLabelsToPrint);
  if (numberOfPackages) qs.set('NumberOfPackages', numberOfPackages);
  if (packageLabelsToPrint) qs.set('PackageLabelsToPrint', packageLabelsToPrint);
  return amazonRequest(connection, 'GET', `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/labels?${qs.toString()}`);
}
