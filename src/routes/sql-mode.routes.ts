import { createHash, randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { FastifyInstance } from 'fastify';
import { config } from '../config/env';
import { pgQuery, withPgTransaction } from '../db/postgres';
import { CAN_MANAGE_USERS, isValidRole, normalizeRole } from '../lib/roles';

type AnyRow = Record<string, any>;

const number = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const money = (value: unknown) => Math.round(number(value) * 100) / 100;
const json = (value: unknown, fallback: any) => (value == null ? fallback : value);
const iso = (value: unknown) => (value ? new Date(value as any).toISOString() : undefined);
const trim = (value: unknown) => (value == null ? '' : String(value).trim());
const normalizedEmail = (value: unknown) => trim(value).toLowerCase();

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

function requireManager(req: any, reply: any): string | null {
  const userId = requireUser(req, reply);
  if (!userId) return null;
  const role = normalizeRole(req.user?.role);
  if (!CAN_MANAGE_USERS.includes(role)) {
    reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    return null;
  }
  return userId;
}

async function one<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T | null> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows[0] || null;
}

async function rows<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

function pagination(query: any) {
  return {
    limit: Math.min(500, Math.max(1, Number(query?.limit || 200))),
    offset: Math.max(0, Number(query?.offset || 0)),
  };
}

function addressText(address: any): string | null {
  if (!address || typeof address !== 'object') return null;
  return [
    address.addressLine1 || address.line1 || address.street,
    address.city,
    address.state || address.stateOrProvinceCode,
    address.zipCode || address.postalCode,
    address.country,
  ]
    .filter(Boolean)
    .join(', ') || null;
}

function channelDisplay(row: AnyRow) {
  return row.display_name || row.shop_domain || row.selling_partner_id || row.external_account_id || row.channel;
}

function mapChannel(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    status: row.status,
    displayName: row.display_name,
    shopDomain: row.shop_domain,
    sellingPartnerId: row.selling_partner_id,
    marketplaceId: row.marketplace_id,
    externalAccountId: row.external_account_id,
    scopes: row.scopes || [],
    metadata: json(row.metadata, {}),
    lastSyncAt: iso(row.last_sync_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    label: channelDisplay(row),
  };
}

function mapItem(row: AnyRow, extra: Record<string, unknown> = {}) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    sku: row.sku,
    title: row.title,
    description: row.description,
    attributes: json(row.attributes, {}),
    defaultUom: row.default_uom,
    tags: row.tags || [],
    supplierId: row.supplier_id,
    image: row.image,
    images: json(row.images, []),
    upc: row.upc,
    ean: row.ean,
    asin: row.asin,
    category: row.category,
    subCategory: row.sub_category,
    lob: row.lob,
    weight: row.weight == null ? undefined : number(row.weight),
    dimensions: json(row.dimensions, {}),
    archived: row.archived,
    wmsInventory: json(row.wms_inventory, {}),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...extra,
  };
}

function mapSupplier(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    address: json(row.address, {}),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCustomer(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    channel: row.channel,
    externalCustomerId: row.external_customer_id,
    addresses: json(row.addresses, []),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapOrder(row: AnyRow, lines: AnyRow[] = []) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    customerId: row.customer_id,
    channelAccountId: row.channel_connection_id,
    channel: row.channel,
    externalOrderId: row.external_order_id,
    orderNumber: row.order_number,
    status: row.status,
    paid: row.paid,
    placedAt: iso(row.placed_at),
    totals: json(row.totals, {}),
    shippingAddress: json(row.shipping_address, {}),
    billingAddress: json(row.billing_address, {}),
    trackingNumber: row.tracking_number,
    metadata: json(row.metadata, {}),
    lines: lines.map((line) => ({
      _id: line.id,
      id: line.id,
      itemId: line.item_id,
      sku: line.sku,
      title: line.title,
      quantity: number(line.quantity),
      unitPrice: money(line.unit_price),
      totalPrice: money(line.total_price),
      metadata: json(line.metadata, {}),
    })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapFacility(row: AnyRow) {
  const address = json(row.address, {});
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    code: row.code,
    name: row.name,
    facilityType: row.facility_type,
    type: row.facility_type,
    status: row.status,
    address,
    latitude: row.latitude == null ? undefined : number(row.latitude),
    longitude: row.longitude == null ? undefined : number(row.longitude),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapShipFrom(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    supplierId: row.supplier_id,
    name: row.name,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    address: json(row.address, {}),
    isDefault: row.is_default,
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapShipmentPlan(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    supplierId: row.supplier_id,
    shipFromLocationId: row.ship_from_location_id,
    facilityId: row.facility_id,
    internalShipmentId: row.internal_shipment_id,
    shipmentTitle: row.shipment_title,
    status: row.status,
    prepServicesOnly: row.prep_services_only,
    marketplaceId: row.marketplace_id,
    marketplaceType: row.marketplace_type,
    orderNo: row.order_no,
    receiptNo: row.receipt_no,
    orderDate: iso(row.order_date),
    estimatedArrivalDate: iso(row.estimated_arrival_date),
    shipFromAddress: json(row.ship_from_address, {}),
    items: json(row.items, []),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapFeature(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    status: row.status,
    price: money(row.price),
    payload: json(row.payload, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapUser(row: AnyRow) {
  return {
    id: row.id,
    userId: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    llcName: row.llc_name,
    billingAddress: json(row.billing_address, null),
    enabledFeatures: row.enabled_features || [],
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function writeLedger(userId: string, params: { entityType: string; entityId?: string | null; eventType: string; sourceSystem?: string; summary: string; payload?: any; confidence?: number }) {
  await pgQuery(
    `INSERT INTO oms_execution_ledger
      (user_id, entity_type, entity_id, event_type, source_system, summary, payload, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      userId,
      params.entityType,
      params.entityId || null,
      params.eventType,
      params.sourceSystem || 'oms',
      params.summary,
      JSON.stringify(params.payload || {}),
      params.confidence ?? null,
    ],
  ).catch(() => null);
}

async function closestFacility(userId: string) {
  return one('SELECT * FROM facilities WHERE (user_id = $1 OR user_id IS NULL) AND status = $2 ORDER BY user_id NULLS LAST, created_at ASC LIMIT 1', [userId, 'active']);
}

async function seedDefaultFacility(userId: string) {
  const existing = await closestFacility(userId);
  if (existing) return existing;
  return one(
    `INSERT INTO facilities (user_id, code, name, facility_type, address, latitude, longitude, metadata)
     VALUES ($1, 'NJ-01', 'New Jersey Market Hub', 'warehouse', $2::jsonb, 40.7357, -74.1724, '{"source":"sql_default"}'::jsonb)
     ON CONFLICT (user_id, code) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [userId, JSON.stringify({ city: 'Newark', state: 'NJ', stateOrProvinceCode: 'NJ', country: 'US' })],
  );
}

export async function sqlModeRoutes(app: FastifyInstance) {
  app.get('/legacy/status', async () => ({
    mongo: 'purged',
    replacement: 'aurora_postgres',
    message: 'Legacy Mongo-backed feature groups are served by Aurora SQL routes.',
  }));

  app.get('/channel-accounts', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM marketplace_connections WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return data.map(mapChannel);
  });

  app.delete('/channel-accounts/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM marketplace_connections WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(userId, { entityType: 'marketplace_connection', entityId: deleted.id, eventType: 'deleted', summary: `Removed ${deleted.channel} marketplace connection.` });
    return { success: true };
  });

  app.get('/channel-accounts/:id/debug', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const account = await one('SELECT * FROM marketplace_connections WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    return {
      account: mapChannel(account),
      storage: 'aurora_postgres',
      tokenPresent: Boolean(account.access_token_enc || account.refresh_token_enc),
      lastSyncAt: iso(account.last_sync_at),
    };
  });

  app.get('/channel-accounts/:id/sync-status', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const account = await one('SELECT * FROM marketplace_connections WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    return {
      accountId: account.id,
      channel: account.channel,
      status: account.status,
      syncStatus: account.last_sync_at ? 'complete' : 'pending',
      lastSyncAt: iso(account.last_sync_at),
      source: 'aurora_postgres',
    };
  });

  app.post('/channel-accounts/:id/refresh', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const account = await one(
      'UPDATE marketplace_connections SET last_sync_at = now(), updated_at = now(), metadata = metadata || $3::jsonb WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, userId, JSON.stringify({ lastManualRefresh: new Date().toISOString(), refreshMode: 'sql_mode' })],
    );
    if (!account) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(userId, { entityType: 'marketplace_connection', entityId: account.id, eventType: 'refresh_requested', summary: `Refresh requested for ${account.channel} marketplace connection.`, payload: { accountId: account.id } });
    return { success: true, account: mapChannel(account), syncStatus: 'queued' };
  });

  app.get('/auth/shopify/start', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const shop = trim(req.query?.shop).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!shop) return reply.code(400).send({ error: 'shop is required' });
    const state = randomBytes(18).toString('hex');
    await pgQuery(
      'INSERT INTO oauth_states (user_id, channel, state, payload) VALUES ($1, $2, $3, $4::jsonb)',
      [userId, 'shopify', state, JSON.stringify({ shop })],
    );
    if (!config.shopify.clientId || !config.shopify.clientSecret || !config.shopify.appBaseUrl) {
      await one(
        `INSERT INTO marketplace_connections (user_id, channel, status, display_name, shop_domain, metadata)
         VALUES ($1, 'shopify', 'needs_configuration', $2, $2, $3::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [userId, shop, JSON.stringify({ reason: 'missing_shopify_oauth_env', state })],
      );
      return reply.code(503).send({ error: 'Shopify OAuth is missing server configuration', state });
    }
    const redirectUri = `${config.shopify.appBaseUrl.replace(/\/+$/, '')}/api/v1/auth/shopify/callback`;
    const params = new URLSearchParams({
      client_id: config.shopify.clientId,
      scope: 'read_products,read_orders,read_inventory',
      redirect_uri: redirectUri,
      state,
    });
    return reply.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
  });

  app.get('/auth/shopify/callback', async (req: any, reply) => {
    const state = trim(req.query?.state);
    const code = trim(req.query?.code);
    const shop = trim(req.query?.shop);
    const saved = await one('SELECT * FROM oauth_states WHERE state = $1 AND channel = $2 AND used_at IS NULL AND expires_at > now()', [state, 'shopify']);
    if (!saved || !code || !shop) return reply.code(400).send({ error: 'Invalid Shopify OAuth state' });
    let tokenPayload: any = {};
    try {
      const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret, code }),
      } as any);
      tokenPayload = await res.json();
      if (!res.ok) throw new Error(tokenPayload?.error || 'Shopify token exchange failed');
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'Shopify token exchange failed' });
    }
    const account = await one(
      `INSERT INTO marketplace_connections
        (user_id, channel, status, display_name, shop_domain, access_token_enc, scopes, metadata, last_sync_at)
       VALUES ($1, 'shopify', 'connected', $2, $2, $3, $4, $5::jsonb, now())
       RETURNING *`,
      [saved.user_id, shop, tokenPayload.access_token || null, String(tokenPayload.scope || '').split(',').filter(Boolean), JSON.stringify({ oauthCompletedAt: new Date().toISOString() })],
    );
    await pgQuery('UPDATE oauth_states SET used_at = now() WHERE state = $1', [state]);
    await writeLedger(saved.user_id, { entityType: 'marketplace_connection', entityId: account?.id, eventType: 'connected', summary: `Shopify marketplace connected for ${shop}.` });
    return reply.redirect(`${config.frontendOrigin.replace(/\/+$/, '')}/dashboard?connected=shopify`);
  });

  for (const channel of ['amazon', 'ebay']) {
    app.get(`/auth/${channel}/start`, async (req: any, reply) => {
      const userId = requireUser(req, reply);
      if (!userId) return;
      const state = randomBytes(18).toString('hex');
      await pgQuery(
        'INSERT INTO oauth_states (user_id, channel, state, payload) VALUES ($1, $2, $3, $4::jsonb)',
        [userId, channel, state, JSON.stringify(req.query || {})],
      );
      await one(
        `INSERT INTO marketplace_connections (user_id, channel, status, display_name, metadata)
         VALUES ($1, $2, 'needs_authorization', $3, $4::jsonb)
         RETURNING *`,
        [userId, channel, `${channel.toUpperCase()} pending authorization`, JSON.stringify({ state, note: 'Provider token exchange is stored in Aurora when callback completes.' })],
      );
      return reply.code(202).send({
        status: 'needs_provider_authorization',
        channel,
        state,
        message: `${channel} OAuth state was created in Aurora. Complete provider app configuration before token exchange is enabled.`,
      });
    });

    app.get(`/auth/${channel}/callback`, async (req: any, reply) => {
      const state = trim(req.query?.state);
      const saved = await one('SELECT * FROM oauth_states WHERE state = $1 AND channel = $2 AND used_at IS NULL AND expires_at > now()', [state, channel]);
      if (!saved) return reply.code(400).send({ error: `Invalid ${channel} OAuth state` });
      await pgQuery('UPDATE oauth_states SET used_at = now() WHERE state = $1', [state]);
      await pgQuery(
        `UPDATE marketplace_connections
         SET status = 'needs_token_exchange', updated_at = now(), metadata = metadata || $3::jsonb
         WHERE user_id = $1 AND channel = $2 AND status = 'needs_authorization'`,
        [saved.user_id, channel, JSON.stringify({ callbackReceivedAt: new Date().toISOString(), query: req.query || {} })],
      );
      return reply.redirect(`${config.frontendOrigin.replace(/\/+$/, '')}/dashboard?connected=${channel}&status=pending-token-exchange`);
    });
  }

  app.post('/webhooks/shopify', async (_req: any, reply) => reply.code(202).send({ accepted: true, storage: 'aurora_postgres' }));
  app.post('/webhooks/ebay/account-deletion', async (_req: any, reply) => reply.code(200).send({ accepted: true }));

  app.get('/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const channel = trim(req.query?.channel);
    const values: unknown[] = [userId, limit, offset];
    let where = 'i.user_id = $1';
    if (channel && channel !== 'unmapped') {
      values.push(channel);
      where += ` AND EXISTS (SELECT 1 FROM item_channel_mappings m WHERE m.item_id = i.id AND m.channel = $${values.length})`;
    } else if (channel === 'unmapped') {
      where += ' AND NOT EXISTS (SELECT 1 FROM item_channel_mappings m WHERE m.item_id = i.id)';
    }
    const data = await rows(`SELECT i.* FROM catalog_items i WHERE ${where} ORDER BY i.updated_at DESC LIMIT $2 OFFSET $3`, values);
    const ids = data.map((item) => item.id);
    const mappings = ids.length
      ? await rows(
          `SELECT m.*, c.display_name, c.shop_domain, c.selling_partner_id
           FROM item_channel_mappings m
           LEFT JOIN marketplace_connections c ON c.id = m.channel_connection_id
           WHERE m.user_id = $1 AND m.item_id = ANY($2::text[])`,
          [userId, ids],
        )
      : [];
    const byItem = mappings.reduce<Record<string, AnyRow[]>>((acc, row) => {
      const key = String(row.item_id);
      if (!acc[key]) acc[key] = [];
      acc[key]!.push(row);
      return acc;
    }, {});
    return data.map((item) => {
      const itemMappings = byItem[item.id] || [];
      return mapItem(item, {
        channels: [...new Set(itemMappings.map((m) => m.channel))],
        mappings: itemMappings.map((m) => ({
          _id: m.id,
          id: m.id,
          channel: m.channel,
          channelDisplay: m.display_name || m.shop_domain || m.selling_partner_id || m.channel,
          channelAccountId: m.channel_connection_id,
          channelItemId: m.channel_item_id,
          channelVariantId: m.channel_variant_id,
          status: m.status,
        })),
      });
    });
  });

  app.post('/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!trim(body.sku) || !trim(body.title)) return reply.code(400).send({ error: 'sku and title required' });
    try {
      const item = await one(
        `INSERT INTO catalog_items
          (user_id, sku, title, description, attributes, default_uom, tags, supplier_id, image, images, upc, ean, asin, category, sub_category, lob, weight, dimensions)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18::jsonb)
         RETURNING *`,
        [
          userId,
          trim(body.sku),
          trim(body.title),
          body.description || null,
          JSON.stringify(body.attributes || {}),
          body.defaultUom || null,
          Array.isArray(body.tags) ? body.tags : [],
          body.supplierId || null,
          body.image || null,
          JSON.stringify(Array.isArray(body.images) ? body.images : []),
          body.upc || null,
          body.ean || null,
          body.asin || null,
          body.category || null,
          body.subCategory || null,
          body.lob || null,
          body.weight === '' || body.weight == null ? null : Number(body.weight),
          JSON.stringify(body.dimensions || {}),
        ],
      );
      await writeLedger(userId, { entityType: 'catalog_item', entityId: item?.id, eventType: 'created', summary: `Catalog item ${trim(body.sku)} created in Aurora.` });
      return mapItem(item || {});
    } catch (err: any) {
      req.log.error({ err }, 'failed to create SQL item');
      return reply.code(400).send({ error: 'Could not create item', detail: err?.message });
    }
  });

  app.get('/items/:id/wms-activities', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT * FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    return {
      sku: item.sku,
      source: 'aurora_postgres_wms_projection',
      wmsInventory: json(item.wms_inventory, {}),
      inventoryByWarehouse: [],
      activities: [],
      message: 'Live WMS activity is exposed after WMS event streaming is connected to Aurora.',
    };
  });

  app.get('/items/:id/shipment-activity', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT sku FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!item) return reply.code(404).send({ error: 'Not found' });
    const events = await rows(
      `SELECT * FROM shipment_activity_log
       WHERE user_id = $1 AND payload->>'sku' = $2
       ORDER BY created_at DESC LIMIT 100`,
      [userId, item.sku],
    );
    return { events, total: events.length };
  });

  app.get('/items/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT * FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!item) return reply.code(404).send({ error: 'Not found' });
    const mappings = await rows('SELECT * FROM item_channel_mappings WHERE item_id = $1 AND user_id = $2 ORDER BY updated_at DESC', [item.id, userId]);
    return mapItem(item, {
      channels: [...new Set(mappings.map((m) => m.channel))],
      mappings: mappings.map((m) => ({ _id: m.id, id: m.id, channel: m.channel, channelAccountId: m.channel_connection_id, channelItemId: m.channel_item_id, status: m.status })),
    });
  });

  app.patch('/items/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const item = await one(
      `UPDATE catalog_items
       SET title = COALESCE($3, title),
           description = COALESCE($4, description),
           attributes = COALESCE($5::jsonb, attributes),
           default_uom = COALESCE($6, default_uom),
           tags = COALESCE($7, tags),
           supplier_id = $8,
           image = $9,
           images = COALESCE($10::jsonb, images),
           upc = $11,
           ean = $12,
           asin = $13,
           category = $14,
           sub_category = $15,
           lob = $16,
           weight = $17,
           dimensions = COALESCE($18::jsonb, dimensions),
           archived = COALESCE($19, archived),
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        req.params.id,
        userId,
        body.title === undefined ? null : trim(body.title),
        body.description === undefined ? null : body.description,
        body.attributes === undefined ? null : JSON.stringify(body.attributes || {}),
        body.defaultUom === undefined ? null : body.defaultUom,
        body.tags === undefined ? null : (Array.isArray(body.tags) ? body.tags : []),
        body.supplierId === undefined ? null : body.supplierId || null,
        body.image === undefined ? null : body.image || null,
        body.images === undefined ? null : JSON.stringify(Array.isArray(body.images) ? body.images : []),
        body.upc === undefined ? null : body.upc || null,
        body.ean === undefined ? null : body.ean || null,
        body.asin === undefined ? null : body.asin || null,
        body.category === undefined ? null : body.category || null,
        body.subCategory === undefined ? null : body.subCategory || null,
        body.lob === undefined ? null : body.lob || null,
        body.weight === undefined || body.weight === '' ? null : Number(body.weight),
        body.dimensions === undefined ? null : JSON.stringify(body.dimensions || {}),
        body.archived === undefined ? null : Boolean(body.archived),
      ],
    );
    if (!item) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(userId, { entityType: 'catalog_item', entityId: item.id, eventType: 'updated', summary: `Catalog item ${item.sku} updated.` });
    return mapItem(item);
  });

  app.post('/items/:id/map', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!body.channelAccountId || !body.channelItemId) return reply.code(400).send({ error: 'channelAccountId and channelItemId required' });
    const item = await one('SELECT * FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    const account = await one('SELECT * FROM marketplace_connections WHERE id = $1 AND user_id = $2', [body.channelAccountId, userId]);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    if (!account) return reply.code(400).send({ error: 'Invalid channelAccountId' });
    const mapping = await one(
      `INSERT INTO item_channel_mappings (user_id, item_id, channel_connection_id, channel, channel_item_id, channel_variant_id, sku, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'active'))
       ON CONFLICT (user_id, channel, channel_item_id, (COALESCE(channel_variant_id, '')))
       DO UPDATE SET item_id = EXCLUDED.item_id, channel_connection_id = EXCLUDED.channel_connection_id, sku = EXCLUDED.sku, status = EXCLUDED.status, updated_at = now()
       RETURNING *`,
      [userId, item.id, account.id, account.channel, trim(body.channelItemId), body.channelVariantId || null, body.sku || item.sku, body.status || 'active'],
    );
    return { _id: mapping?.id, id: mapping?.id, ...mapping };
  });

  app.get('/mappings/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const items = await rows('SELECT id, sku, title FROM catalog_items WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    const mappings = await rows('SELECT * FROM item_channel_mappings WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return { items: items.map((i) => ({ _id: i.id, ...i })), mappings: mappings.map((m) => ({ _id: m.id, ...m })) };
  });

  app.get('/customers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const search = trim(req.query?.search || req.query?.q);
    const values: unknown[] = [userId, limit, offset];
    let where = 'user_id = $1';
    if (search) {
      values.push(`%${search}%`);
      where += ` AND (name ILIKE $${values.length} OR email ILIKE $${values.length} OR company ILIKE $${values.length})`;
    }
    const data = await rows(`SELECT * FROM customers WHERE ${where} ORDER BY updated_at DESC LIMIT $2 OFFSET $3`, values);
    return data.map(mapCustomer);
  });

  app.post('/customers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const customer = await one(
      `INSERT INTO customers (user_id, name, email, phone, company, channel, external_customer_id, addresses, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
       RETURNING *`,
      [userId, body.name || null, normalizedEmail(body.email) || null, body.phone || null, body.company || null, body.channel || null, body.externalCustomerId || null, JSON.stringify(body.addresses || []), JSON.stringify(body.metadata || {})],
    );
    return mapCustomer(customer || {});
  });

  app.get('/customers/:id/orders', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM orders WHERE user_id = $1 AND customer_id = $2 ORDER BY placed_at DESC NULLS LAST, created_at DESC LIMIT 200', [userId, req.params.id]);
    const totalValue = data.reduce((sum, row) => sum + number(json(row.totals, {}).total), 0);
    const byStatus = data.reduce<Record<string, number>>((acc, row) => {
      const status = row.status || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return {
      orders: data.map((row) => mapOrder(row)),
      total: data.length,
      summary: {
        totalOrders: data.length,
        totalValue: money(totalValue),
        ordersByStatus: Object.entries(byStatus).map(([_id, count]) => ({ _id, count })),
      },
    };
  });

  app.get('/customers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const customer = await one('SELECT * FROM customers WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!customer) return reply.code(404).send({ error: 'Not found' });
    return mapCustomer(customer);
  });

  app.patch('/customers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const customer = await one(
      `UPDATE customers
       SET name = COALESCE($3, name), email = COALESCE($4, email), phone = COALESCE($5, phone), company = COALESCE($6, company),
           addresses = COALESCE($7::jsonb, addresses), metadata = metadata || COALESCE($8::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.name ?? null, body.email === undefined ? null : normalizedEmail(body.email), body.phone ?? null, body.company ?? null, body.addresses === undefined ? null : JSON.stringify(body.addresses || []), body.metadata === undefined ? null : JSON.stringify(body.metadata || {})],
    );
    if (!customer) return reply.code(404).send({ error: 'Not found' });
    return mapCustomer(customer);
  });

  app.post('/customers/:id/map', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const customer = await one('SELECT * FROM customers WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!customer) return reply.code(404).send({ error: 'Customer not found' });
    const mapping = await one(
      `INSERT INTO customer_channel_mappings (user_id, customer_id, channel_connection_id, channel, external_customer_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (user_id, channel, external_customer_id)
       DO UPDATE SET customer_id = EXCLUDED.customer_id, channel_connection_id = EXCLUDED.channel_connection_id, payload = EXCLUDED.payload, updated_at = now()
       RETURNING *`,
      [userId, customer.id, body.channelAccountId || null, body.channel || customer.channel || 'manual', body.externalCustomerId || body.channelCustomerId, JSON.stringify(body.payload || {})],
    );
    return { _id: mapping?.id, id: mapping?.id, ...mapping };
  });

  app.get('/mappings/customers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const customers = await rows('SELECT id, name, email FROM customers WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    const mappings = await rows('SELECT * FROM customer_channel_mappings WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return { customers: customers.map((c) => ({ _id: c.id, ...c })), mappings: mappings.map((m) => ({ _id: m.id, ...m })) };
  });

  app.get('/orders', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const data = await rows('SELECT * FROM orders WHERE user_id = $1 ORDER BY placed_at DESC NULLS LAST, created_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
    return data.map((row) => mapOrder(row));
  });

  app.get('/orders/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const order = await one('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!order) return reply.code(404).send({ error: 'Not found' });
    const lines = await rows('SELECT * FROM order_lines WHERE order_id = $1 AND user_id = $2 ORDER BY created_at ASC', [order.id, userId]);
    return mapOrder(order, lines);
  });

  app.get('/suppliers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const data = await rows('SELECT * FROM suppliers WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
    return data.map(mapSupplier);
  });

  app.post('/suppliers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!trim(body.name)) return reply.code(400).send({ error: 'name required' });
    const supplier = await one(
      `INSERT INTO suppliers (user_id, name, email, phone, status, address, metadata)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), $6::jsonb, $7::jsonb) RETURNING *`,
      [userId, trim(body.name), normalizedEmail(body.email) || null, body.phone || null, body.status || 'active', JSON.stringify(body.address || {}), JSON.stringify(body.metadata || {})],
    );
    return mapSupplier(supplier || {});
  });

  app.get('/suppliers/:id/products', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM catalog_items WHERE user_id = $1 AND supplier_id = $2 ORDER BY updated_at DESC', [userId, req.params.id]);
    return { items: data.map((row) => mapItem(row)), total: data.length };
  });

  app.get('/suppliers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const supplier = await one('SELECT * FROM suppliers WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!supplier) return reply.code(404).send({ error: 'Not found' });
    return mapSupplier(supplier);
  });

  app.patch('/suppliers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const supplier = await one(
      `UPDATE suppliers
       SET name = COALESCE($3, name), email = COALESCE($4, email), phone = COALESCE($5, phone), status = COALESCE($6, status),
           address = COALESCE($7::jsonb, address), metadata = metadata || COALESCE($8::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.name ?? null, body.email === undefined ? null : normalizedEmail(body.email), body.phone ?? null, body.status ?? null, body.address === undefined ? null : JSON.stringify(body.address || {}), body.metadata === undefined ? null : JSON.stringify(body.metadata || {})],
    );
    if (!supplier) return reply.code(404).send({ error: 'Not found' });
    return mapSupplier(supplier);
  });

  app.delete('/suppliers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM suppliers WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });

  app.get('/ship-from-locations', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM ship_from_locations WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return data.map(mapShipFrom);
  });

  app.post('/ship-from-locations', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const loc = await one(
      `INSERT INTO ship_from_locations (user_id, supplier_id, name, contact_name, phone, email, address, is_default, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb) RETURNING *`,
      [userId, body.supplierId || null, body.name || 'Ship-from location', body.contactName || null, body.phone || null, body.email || null, JSON.stringify(body.address || {}), Boolean(body.isDefault), JSON.stringify(body.metadata || {})],
    );
    return mapShipFrom(loc || {});
  });

  app.get('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const loc = await one('SELECT * FROM ship_from_locations WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!loc) return reply.code(404).send({ error: 'Not found' });
    return mapShipFrom(loc);
  });

  app.patch('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const loc = await one(
      `UPDATE ship_from_locations
       SET supplier_id = COALESCE($3, supplier_id), name = COALESCE($4, name), contact_name = COALESCE($5, contact_name),
           phone = COALESCE($6, phone), email = COALESCE($7, email), address = COALESCE($8::jsonb, address),
           is_default = COALESCE($9, is_default), metadata = metadata || COALESCE($10::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.supplierId ?? null, body.name ?? null, body.contactName ?? null, body.phone ?? null, body.email ?? null, body.address === undefined ? null : JSON.stringify(body.address || {}), body.isDefault === undefined ? null : Boolean(body.isDefault), body.metadata === undefined ? null : JSON.stringify(body.metadata || {})],
    );
    if (!loc) return reply.code(404).send({ error: 'Not found' });
    return mapShipFrom(loc);
  });

  app.delete('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM ship_from_locations WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });

  app.get('/facilities', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    await seedDefaultFacility(userId);
    const data = await rows('SELECT * FROM facilities WHERE user_id = $1 OR user_id IS NULL ORDER BY code ASC', [userId]);
    return data.map(mapFacility);
  });

  app.post('/facilities', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!trim(body.code) || !trim(body.name)) return reply.code(400).send({ error: 'code and name required' });
    const facility = await one(
      `INSERT INTO facilities (user_id, code, name, facility_type, status, address, latitude, longitude, metadata)
       VALUES ($1, $2, $3, COALESCE($4, 'warehouse'), COALESCE($5, 'active'), $6::jsonb, $7, $8, $9::jsonb)
       ON CONFLICT (user_id, code) DO UPDATE SET name = EXCLUDED.name, facility_type = EXCLUDED.facility_type, status = EXCLUDED.status, address = EXCLUDED.address, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, metadata = EXCLUDED.metadata, updated_at = now()
       RETURNING *`,
      [userId, trim(body.code), trim(body.name), body.facilityType || body.type || 'warehouse', body.status || 'active', JSON.stringify(body.address || {}), body.latitude == null ? null : Number(body.latitude), body.longitude == null ? null : Number(body.longitude), JSON.stringify(body.metadata || {})],
    );
    return mapFacility(facility || {});
  });

  app.get('/shipment-plans/activity', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const data = await rows('SELECT * FROM shipment_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
    return { events: data.map((e) => ({ _id: e.id, id: e.id, action: e.action, summary: e.summary, payload: json(e.payload, {}), createdAt: iso(e.created_at) })), total: data.length };
  });

  app.post('/shipment-plans/estimate-service-fees', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const units = items.reduce((sum: number, item: any) => sum + number(item.quantity, 1), 0);
    return {
      currency: 'USD',
      lineItems: [
        { code: 'receiving', label: 'Receiving', amount: money(Math.max(12, units * 0.18)) },
        { code: 'prep', label: 'Prep services', amount: money(units * 0.35) },
        { code: 'palletization', label: 'Palletization estimate', amount: money(Math.ceil(units / 80) * 18) },
      ],
      total: money(Math.max(12, units * 0.18) + units * 0.35 + Math.ceil(units / 80) * 18),
      source: 'aurora_sql_estimate',
    };
  });

  app.get('/shipment-plans/closest-facility-preview', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const facility = await seedDefaultFacility(userId);
    return { facilityId: facility?.id || null, facility: facility ? mapFacility(facility) : null, distanceMiles: null, shipFromAddress: undefined };
  });

  app.get('/shipment-plans', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const status = trim(req.query?.status);
    const values: unknown[] = [userId, limit, offset];
    let where = 'user_id = $1';
    if (status) {
      values.push(status);
      where += ` AND status = $${values.length}`;
    }
    const data = await rows(`SELECT * FROM shipment_plans WHERE ${where} ORDER BY updated_at DESC LIMIT $2 OFFSET $3`, values);
    return { plans: data.map(mapShipmentPlan), total: data.length, limit, offset };
  });

  app.post('/shipment-plans', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const facility = body.facilityId ? await one('SELECT * FROM facilities WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)', [body.facilityId, userId]) : await seedDefaultFacility(userId);
    const shipFrom = body.shipFromLocationId ? await one('SELECT * FROM ship_from_locations WHERE id = $1 AND user_id = $2', [body.shipFromLocationId, userId]) : null;
    const plan = await one(
      `INSERT INTO shipment_plans
        (user_id, supplier_id, ship_from_location_id, facility_id, internal_shipment_id, shipment_title, status, prep_services_only, marketplace_id, marketplace_type, order_no, receipt_no, order_date, estimated_arrival_date, ship_from_address, items, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb)
       RETURNING *`,
      [
        userId,
        body.supplierId || null,
        body.shipFromLocationId || null,
        facility?.id || null,
        `UC-${Date.now().toString(36).toUpperCase()}`,
        body.shipmentTitle || `Shipment ${new Date().toLocaleDateString('en-US')}`,
        Boolean(body.prepServicesOnly),
        body.marketplaceId || null,
        body.marketplaceType || null,
        body.orderNo || null,
        body.receiptNo || null,
        body.orderDate ? new Date(body.orderDate) : null,
        body.estimatedArrivalDate ? new Date(body.estimatedArrivalDate) : null,
        JSON.stringify(shipFrom?.address || body.shipFromAddress || {}),
        JSON.stringify(Array.isArray(body.items) ? body.items : []),
        JSON.stringify({ autoRoutedBy: 'cortex_oms', warehouseSelectionHiddenFromClient: true }),
      ],
    );
    await pgQuery('INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary, payload) VALUES ($1, $2, $3, $4, $5::jsonb)', [userId, plan?.id, 'created', 'Shipment plan created in Aurora SQL mode.', JSON.stringify({ planId: plan?.id })]);
    return mapShipmentPlan(plan || {});
  });

  app.get('/shipment-plans/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    return mapShipmentPlan(plan);
  });

  app.put('/shipment-plans/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const plan = await one(
      `UPDATE shipment_plans
       SET items = COALESCE($3::jsonb, items), order_no = COALESCE($4, order_no), receipt_no = COALESCE($5, receipt_no),
           order_date = COALESCE($6, order_date), estimated_arrival_date = COALESCE($7, estimated_arrival_date),
           shipment_title = COALESCE($8, shipment_title), status = COALESCE($9, status), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.items === undefined ? null : JSON.stringify(body.items || []), body.orderNo ?? null, body.receiptNo ?? null, body.orderDate ? new Date(body.orderDate) : null, body.estimatedArrivalDate ? new Date(body.estimatedArrivalDate) : null, body.shipmentTitle ?? null, body.status ?? null],
    );
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    return mapShipmentPlan(plan);
  });

  app.post('/shipment-plans/:id/submit', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId, 'submitted']);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    await pgQuery('INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary) VALUES ($1, $2, $3, $4)', [userId, plan.id, 'submitted', 'Shipment plan submitted for WMS/Cortex execution.']);
    return mapShipmentPlan(plan);
  });

  app.post('/shipment-plans/:id/cancel', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId, 'cancelled']);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    await pgQuery('INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary) VALUES ($1, $2, $3, $4)', [userId, plan.id, 'cancelled', 'Shipment plan cancelled.']);
    return mapShipmentPlan(plan);
  });

  app.get('/shipment-plans/:id/closest-facility', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const facility = plan.facility_id ? await one('SELECT * FROM facilities WHERE id = $1', [plan.facility_id]) : await seedDefaultFacility(userId);
    return { facilityId: facility?.id || null, facility: facility ? mapFacility(facility) : null, distanceMiles: null };
  });

  app.post('/shipment-plans/:id/create-asn', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const asn = await one(
      `INSERT INTO asns (user_id, shipment_plan_id, asn_number, status, payload)
       VALUES ($1, $2, $3, 'created', $4::jsonb) RETURNING *`,
      [userId, plan.id, `ASN-${Date.now().toString(36).toUpperCase()}`, JSON.stringify({ shipmentPlan: mapShipmentPlan(plan), source: 'aurora_postgres' })],
    );
    await pgQuery('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2', [plan.id, userId, 'asn_created']);
    return { asn: { _id: asn?.id, id: asn?.id, asnNumber: asn?.asn_number, status: asn?.status, payload: json(asn?.payload, {}), createdAt: iso(asn?.created_at) }, plan: mapShipmentPlan({ ...plan, status: 'asn_created' }) };
  });

  app.post('/shipment-plans/:id/rate-shop-to-warehouse', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const items = Array.isArray(plan.items) ? plan.items : [];
    const units = items.reduce((sum: number, item: any) => sum + number(item.quantity, 1), 0);
    const base = Math.max(125, units * 1.85);
    return {
      planId: plan.id,
      currency: 'USD',
      rates: [
        { serviceTier: 'economy', carrier: 'Cortex LTL', amount: money(base * 0.86), transitDays: 5, recommendation: 'Best cost when consolidation is allowed.' },
        { serviceTier: 'standard', carrier: 'Cortex LTL', amount: money(base), transitDays: 3, recommendation: 'Balanced speed and utilization.' },
        { serviceTier: 'priority', carrier: 'Cortex LTL', amount: money(base * 1.28), transitDays: 2, recommendation: 'Faster movement with lower consolidation tolerance.' },
      ],
      source: 'aurora_sql_rate_model',
    };
  });

  app.get('/shipment-plans/:id/estimated-cost', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const units = Array.isArray(plan.items) ? plan.items.reduce((sum: number, item: any) => sum + number(item.quantity, 1), 0) : 0;
    return { currency: 'USD', total: money(95 + units * 1.1), source: 'aurora_sql_estimate', facilityId: plan.facility_id };
  });

  app.get('/invoices', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const shipmentPlanId = trim(req.query?.shipmentPlanId);
    const data = shipmentPlanId
      ? await rows('SELECT * FROM invoice_lines WHERE user_id = $1 AND shipment_plan_id = $2 ORDER BY created_at DESC', [userId, shipmentPlanId])
      : await rows('SELECT * FROM invoice_lines WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [userId]);
    return { invoices: data.map((line) => ({ _id: line.id, id: line.id, shipmentPlanId: line.shipment_plan_id, invoiceId: line.invoice_id, description: line.description, amount: money(line.amount), currency: line.currency, status: line.status, payload: json(line.payload, {}), createdAt: iso(line.created_at) })) };
  });

  app.get('/notes', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const entityType = trim(req.query?.entityType);
    const entityId = trim(req.query?.entityId);
    if (!entityType || !entityId) return reply.code(400).send({ error: 'entityType and entityId required' });
    const data = await rows('SELECT * FROM notes WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC', [userId, entityType, entityId]);
    return { notes: data.map((n) => ({ _id: n.id, id: n.id, entityType: n.entity_type, entityId: n.entity_id, note: n.note, body: n.body, pinned: n.pinned, authorId: n.author_id, createdAt: iso(n.created_at), updatedAt: iso(n.updated_at) })) };
  });

  app.post('/notes', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!body.entityType || !body.entityId || !(body.note || body.body)) return reply.code(400).send({ error: 'entityType, entityId and note required' });
    const note = await one(
      `INSERT INTO notes (user_id, entity_type, entity_id, note, body, author_id, pinned, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
      [userId, body.entityType, body.entityId, body.note || body.body, body.body || body.note, userId, Boolean(body.pinned), JSON.stringify(body.metadata || {})],
    );
    return { _id: note?.id, id: note?.id, entityType: note?.entity_type, entityId: note?.entity_id, note: note?.note, body: note?.body, createdAt: iso(note?.created_at) };
  });

  app.get('/features', async () => {
    const data = await rows('SELECT * FROM features ORDER BY category, name');
    return { features: data.map(mapFeature) };
  });

  app.get('/features/marketplace', async () => {
    const data = await rows("SELECT * FROM features WHERE category = 'marketplace' OR id = 'marketplace-connections' ORDER BY name");
    return { features: data.map(mapFeature) };
  });

  app.get('/features/:id', async (req: any, reply) => {
    const feature = await one('SELECT * FROM features WHERE id = $1', [req.params.id]);
    if (!feature) return reply.code(404).send({ error: 'Not found' });
    return mapFeature(feature);
  });

  app.get('/user/features', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows(
      `SELECT f.*, uf.status AS user_status, uf.enabled_at
       FROM features f
       LEFT JOIN user_features uf ON uf.feature_id = f.id AND uf.user_id = $1
       ORDER BY f.category, f.name`,
      [userId],
    );
    return { features: data.map((f) => ({ ...mapFeature(f), userStatus: f.user_status || 'available', enabledAt: iso(f.enabled_at) })) };
  });

  for (const action of ['enable', 'purchase']) {
    app.post(`/features/:id/${action}`, async (req: any, reply) => {
      const userId = requireUser(req, reply);
      if (!userId) return;
      const feature = await one(
        `INSERT INTO user_features (user_id, feature_id, status, payload)
         VALUES ($1, $2, 'enabled', $3::jsonb)
         ON CONFLICT (user_id, feature_id) DO UPDATE SET status = 'enabled', enabled_at = now(), payload = EXCLUDED.payload
         RETURNING *`,
        [userId, req.params.id, JSON.stringify({ action, at: new Date().toISOString() })],
      );
      return { success: true, featureId: feature?.feature_id || req.params.id, status: 'enabled' };
    });
  }

  app.post('/features/:id/disable', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    await pgQuery(
      `INSERT INTO user_features (user_id, feature_id, status)
       VALUES ($1, $2, 'disabled')
       ON CONFLICT (user_id, feature_id) DO UPDATE SET status = 'disabled'`,
      [userId, req.params.id],
    );
    return { success: true, featureId: req.params.id, status: 'disabled' };
  });

  app.get('/transportation-templates', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM transportation_templates WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return { templates: data.map((t) => ({ _id: t.id, id: t.id, name: t.name, mode: t.mode, serviceTier: t.service_tier, origin: json(t.origin, {}), destination: json(t.destination, {}), packageRules: json(t.package_rules, {}), payload: json(t.payload, {}), createdAt: iso(t.created_at), updatedAt: iso(t.updated_at) })) };
  });

  app.get('/transportation-templates/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const t = await one('SELECT * FROM transportation_templates WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!t) return reply.code(404).send({ error: 'Not found' });
    return { _id: t.id, id: t.id, name: t.name, mode: t.mode, serviceTier: t.service_tier, origin: json(t.origin, {}), destination: json(t.destination, {}), packageRules: json(t.package_rules, {}), payload: json(t.payload, {}) };
  });

  app.post('/transportation-templates', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const t = await one(
      `INSERT INTO transportation_templates (user_id, name, mode, service_tier, origin, destination, package_rules, payload)
       VALUES ($1, $2, COALESCE($3, 'ltl'), COALESCE($4, 'standard'), $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) RETURNING *`,
      [userId, body.name || 'Transportation template', body.mode || 'ltl', body.serviceTier || 'standard', JSON.stringify(body.origin || {}), JSON.stringify(body.destination || {}), JSON.stringify(body.packageRules || {}), JSON.stringify(body.payload || {})],
    );
    return { _id: t?.id, id: t?.id, ...t };
  });

  app.put('/transportation-templates/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const t = await one(
      `UPDATE transportation_templates SET name = COALESCE($3, name), mode = COALESCE($4, mode), service_tier = COALESCE($5, service_tier),
       origin = COALESCE($6::jsonb, origin), destination = COALESCE($7::jsonb, destination), package_rules = COALESCE($8::jsonb, package_rules),
       payload = payload || COALESCE($9::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.name ?? null, body.mode ?? null, body.serviceTier ?? null, body.origin === undefined ? null : JSON.stringify(body.origin || {}), body.destination === undefined ? null : JSON.stringify(body.destination || {}), body.packageRules === undefined ? null : JSON.stringify(body.packageRules || {}), body.payload === undefined ? null : JSON.stringify(body.payload || {})],
    );
    if (!t) return reply.code(404).send({ error: 'Not found' });
    return { _id: t.id, id: t.id, ...t };
  });

  app.delete('/transportation-templates/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM transportation_templates WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });

  app.get('/users', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const data = await rows('SELECT id, email, role, first_name, last_name, phone, llc_name, billing_address, enabled_features, last_login_at, created_at, updated_at FROM app_users ORDER BY created_at DESC');
    return { users: data.map(mapUser) };
  });

  app.post('/users', async (req: any, reply) => {
    const managerId = requireManager(req, reply);
    if (!managerId) return;
    const body = req.body || {};
    const email = normalizedEmail(body.email);
    if (!email || !body.password) return reply.code(400).send({ error: 'Email and password required' });
    const role = isValidRole(body.role) ? body.role : 'ecommerce_client';
    const passwordHash = await bcrypt.hash(String(body.password), 10);
    const user = await one(
      `INSERT INTO app_users (id, email, password_hash, role, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, role, first_name, last_name, phone, llc_name, billing_address, enabled_features, last_login_at, created_at, updated_at`,
      [randomUUID(), email, passwordHash, role, body.firstName || null, body.lastName || null, body.phone || null],
    );
    await pgQuery('INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)', [user?.id, 'created_by_manager', JSON.stringify({ managerId })]);
    return mapUser(user || {});
  });

  app.post('/users/invites', async (req: any, reply) => {
    const managerId = requireManager(req, reply);
    if (!managerId) return;
    const role = isValidRole(req.body?.role) ? req.body.role : 'ecommerce_client';
    const token = randomBytes(24).toString('hex');
    await pgQuery('INSERT INTO invite_tokens (token, role, created_by) VALUES ($1, $2, $3)', [token, role, managerId]);
    return { inviteLink: `/signup?token=${encodeURIComponent(token)}`, token, role, expiresInDays: 7 };
  });

  app.get('/users/:userId/activity', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const data = await rows('SELECT * FROM app_user_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [req.params.userId]);
    return { events: data.map((e) => ({ _id: e.id, id: e.id, action: e.action, metadata: json(e.metadata, {}), createdAt: iso(e.created_at) })), total: data.length };
  });

  app.post('/oms/connect', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const code = trim(req.body?.connectionCode || req.body?.warehouseCode);
    if (!code) return reply.code(400).send({ error: 'connectionCode required' });
    const facility = await one('SELECT * FROM facilities WHERE code = $1 AND (user_id = $2 OR user_id IS NULL)', [code, userId]) || await seedDefaultFacility(userId);
    const link = await one(
      `INSERT INTO oms_warehouse_links (user_id, facility_id, warehouse_code, connection_code, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (user_id, warehouse_code) DO UPDATE SET status = 'connected', connected_at = now(), metadata = EXCLUDED.metadata
       RETURNING *`,
      [userId, facility?.id || null, facility?.code || code, code, JSON.stringify({ connectedBy: 'sql_mode', connectedAt: new Date().toISOString() })],
    );
    return { success: true, message: 'Warehouse connected.', warehouseCode: link?.warehouse_code || code };
  });

  app.get('/oms/warehouses', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows(
      `SELECT l.*, f.name, f.address
       FROM oms_warehouse_links l
       LEFT JOIN facilities f ON f.id = l.facility_id
       WHERE l.user_id = $1 AND l.status = 'connected'
       ORDER BY l.connected_at DESC`,
      [userId],
    );
    return {
      warehouses: data.map((row) => {
        const address = json(row.address, {});
        return {
          warehouseCode: row.warehouse_code,
          name: row.name || row.warehouse_code,
          state: address.state || address.stateOrProvinceCode || null,
          city: address.city || null,
          address: addressText(address),
          connectedAt: iso(row.connected_at),
        };
      }),
    };
  });

  app.delete('/oms/warehouses/:warehouseCode', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    await pgQuery('UPDATE oms_warehouse_links SET status = $3 WHERE user_id = $1 AND warehouse_code = $2', [userId, req.params.warehouseCode, 'removed']);
    return { success: true };
  });

  app.post('/oms/warehouses/:warehouseCode/test', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const link = await one('SELECT * FROM oms_warehouse_links WHERE user_id = $1 AND warehouse_code = $2 AND status = $3', [userId, req.params.warehouseCode, 'connected']);
    return { ok: Boolean(link), warehouseCode: req.params.warehouseCode, source: 'aurora_postgres' };
  });

  app.get('/oms/accounts', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const data = await rows('SELECT * FROM oms_accounts ORDER BY created_at DESC');
    return { accounts: data.map((a) => ({ id: a.id, companyName: a.company_name, email: a.email, status: a.status, createdAt: iso(a.created_at) })) };
  });

  app.post('/oms/accounts', async (req: any, reply) => {
    const managerId = requireManager(req, reply);
    if (!managerId) return;
    const body = req.body || {};
    if (!trim(body.companyName) || !normalizedEmail(body.email)) return reply.code(400).send({ error: 'companyName and email required' });
    const account = await one(
      'INSERT INTO oms_accounts (user_id, company_name, email, metadata) VALUES ($1, $2, $3, $4::jsonb) RETURNING *',
      [managerId, trim(body.companyName), normalizedEmail(body.email), JSON.stringify({ createdBy: managerId })],
    );
    return { id: account?.id, companyName: account?.company_name, email: account?.email, status: account?.status, createdAt: iso(account?.created_at) };
  });

  app.get('/oms/accounts/:id', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const account = await one('SELECT * FROM oms_accounts WHERE id = $1', [req.params.id]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    return { id: account.id, companyName: account.company_name, email: account.email, status: account.status, createdAt: iso(account.created_at) };
  });

  app.post('/oms/accounts/:id/api-keys', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const account = await one('SELECT * FROM oms_accounts WHERE id = $1', [req.params.id]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    const raw = `uc_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const prefix = raw.slice(0, 10);
    await pgQuery('INSERT INTO api_keys (user_id, name, key_hash, prefix, scopes) VALUES ($1, $2, $3, $4, $5)', [account.user_id || req.user.userId, req.body?.name || 'OMS API Key', keyHash, prefix, ['oms:connect']]);
    return { apiKey: raw, warning: 'Save this key now. It is not shown again.' };
  });

  app.post('/oms/accounts/:id/link-warehouse', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const account = await one('SELECT * FROM oms_accounts WHERE id = $1', [req.params.id]);
    const facility = await one('SELECT * FROM facilities WHERE id = $1', [req.body?.facilityId]);
    if (!account || !facility) return reply.code(404).send({ error: 'Account or facility not found' });
    await pgQuery(
      `INSERT INTO oms_warehouse_links (user_id, oms_account_id, facility_id, warehouse_code, status, metadata)
       VALUES ($1, $2, $3, $4, 'connected', $5::jsonb)
       ON CONFLICT (user_id, warehouse_code) DO UPDATE SET oms_account_id = EXCLUDED.oms_account_id, facility_id = EXCLUDED.facility_id, status = 'connected', connected_at = now()`,
      [account.user_id || req.user.userId, account.id, facility.id, facility.code, JSON.stringify({ linkedBy: req.user.userId })],
    );
    return { success: true, message: 'Linked.' };
  });

  app.get('/oms/facilities', async (req: any, reply) => {
    const userId = requireManager(req, reply);
    if (!userId) return;
    await seedDefaultFacility(userId);
    const data = await rows('SELECT * FROM facilities ORDER BY code ASC');
    return { facilities: data.map(mapFacility) };
  });

  app.post('/shopify/inventory', async (_req: any, reply) => reply.code(202).send({ accepted: true, source: 'aurora_postgres' }));

  app.get('/amazon/send-to-amazon/workflows', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows("SELECT * FROM oms_shipment_wizard_drafts WHERE user_id = $1 AND package_plan->>'channel' = 'amazon' ORDER BY created_at DESC", [userId]);
    return { workflows: data };
  });

  app.post('/amazon/send-to-amazon/workflows', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const draft = await one(
      `INSERT INTO oms_shipment_wizard_drafts (user_id, supplier_id, selected_items, package_plan, cortex_routing)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb) RETURNING *`,
      [userId, req.body?.supplierId || null, JSON.stringify(req.body?.items || []), JSON.stringify({ ...(req.body || {}), channel: 'amazon' }), JSON.stringify({ mode: 'auto_routed' })],
    );
    return { workflowId: draft?.id, workflow: draft };
  });

  const amazonPending = async (_req: any, reply: any) => reply.code(202).send({ status: 'pending_provider_integration', source: 'aurora_postgres' });
  app.get('/amazon/send-to-amazon/workflows/:workflowId', amazonPending);
  app.post('/amazon/send-to-amazon/workflows/:workflowId/placement-preview', amazonPending);
  app.post('/amazon/send-to-amazon/workflows/:workflowId/confirm-placement', amazonPending);
  app.post('/amazon/send-to-amazon/workflows/:workflowId/shipments/:shipmentId/labels', amazonPending);
  app.post('/amazon/inventory', amazonPending);
  app.post('/amazon/fulfillment', amazonPending);
  app.post('/amazon/inbound/plan', amazonPending);
  app.post('/amazon/inbound/shipment', amazonPending);
  app.get('/amazon/inbound/:shipmentId/labels', amazonPending);
  app.post('/amazon/inbound/workflows/draft', amazonPending);
  app.post('/amazon/inbound/workflows/sku-labels', amazonPending);
  app.get('/amazon/inbound/history', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plans = await rows('SELECT * FROM shipment_plans WHERE user_id = $1 AND marketplace_type = $2 ORDER BY created_at DESC LIMIT 100', [userId, 'FBA']);
    return { history: plans.map(mapShipmentPlan) };
  });
  app.get('/amazon/inbound/history/:workflowOrShipmentId', amazonPending);
  app.get('/amazon/catalog/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const items = await rows('SELECT * FROM catalog_items WHERE user_id = $1 AND asin IS NOT NULL ORDER BY updated_at DESC LIMIT 200', [userId]);
    return { items: items.map((row) => mapItem(row)) };
  });
  app.get('/amazon/shipping/labels/:shipmentId', amazonPending);
  app.post('/amazon/shipping/shipments', amazonPending);
}
