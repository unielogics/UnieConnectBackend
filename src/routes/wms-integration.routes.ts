import { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';
import {
  registerWmsCredential,
  verifyIncomingWmsCredential,
} from '../services/oms-wms-credentials.service';

function headerValue(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

async function requireInternalOrUser(req: any, reply: any): Promise<string | null> {
  const provided = headerValue(req.headers['x-internal-api-key']);
  if (provided && config.internalApiKey && provided === config.internalApiKey) {
    const userId = String(req.body?.userId || req.user?.userId || '');
    if (!userId) {
      reply.code(400).send({ error: 'userId is required when registering credentials with the internal key' });
      return null;
    }
    return userId;
  }
  const userId = req.user?.userId;
  if (userId) return String(userId);
  reply.code(401).send({ error: 'Unauthorized' });
  return null;
}

function requireInternalKey(req: any, reply: any): boolean {
  const provided = headerValue(req.headers['x-internal-api-key']);
  if (provided && config.internalApiKey && provided === config.internalApiKey) return true;
  reply.code(401).send({ error: 'Unauthorized' });
  return false;
}

function safeInviteMetadata(metadata: any) {
  const profile = metadata?.prefillProfile || {};
  return {
    source: metadata?.source,
    warehouseCode: metadata?.warehouseCode,
    wmsIntermediaryId: metadata?.wmsIntermediaryId,
    intermediaryNumber: metadata?.intermediaryNumber,
    networkPolicy: metadata?.networkPolicy || null,
    prefillProfile: {
      email: profile.email || '',
      firstName: profile.firstName || '',
      lastName: profile.lastName || '',
      phone: profile.phone || '',
      companyName: profile.companyName || '',
      llcName: profile.llcName || profile.companyName || '',
      billingAddress: profile.billingAddress || null,
    },
  };
}

async function verifyWmsCallback(req: any, reply: any) {
  const clientId = headerValue(req.headers['x-wms-client-id']);
  const passkey = headerValue(req.headers['x-wms-passkey']);
  if (!clientId || !passkey) {
    reply.code(401).send({ error: 'WMS callback credentials required' });
    return null;
  }
  const credential = await verifyIncomingWmsCredential(clientId, passkey);
  if (!credential) {
    reply.code(401).send({ error: 'Invalid WMS callback credentials' });
    return null;
  }
  return credential;
}

function normalizeInventoryRows(body: any): Array<{ sku: string; snapshot: Record<string, unknown> }> {
  const source = body?.inventory || body?.items || body?.skus || [];
  if (Array.isArray(source)) {
    return source
      .map((row) => ({
        sku: String(row?.sku || row?.sellerSku || row?.itemSku || '').trim(),
        snapshot: {
          inbound: Number(row?.inbound || 0),
          received: Number(row?.received || 0),
          available: Number(row?.available ?? row?.onHand ?? row?.quantity ?? 0),
          orders: Number(row?.orders || row?.allocated || 0),
          shippedToday: Number(row?.shippedToday || row?.shipped_today || 0),
          openAsnsCount: Number(row?.openAsnsCount || row?.open_asns_count || 0),
          receiving: Number(row?.receiving || 0),
          source: 'wms_inventory_snapshot',
        },
      }))
      .filter((row) => row.sku);
  }
  if (source && typeof source === 'object') {
    return Object.entries(source)
      .map(([sku, value]: [string, any]) => ({
        sku: String(sku || '').trim(),
        snapshot: {
          inbound: Number(value?.inbound || 0),
          received: Number(value?.received || 0),
          available: Number(value?.available ?? value?.onHand ?? value?.quantity ?? 0),
          orders: Number(value?.orders || value?.allocated || 0),
          shippedToday: Number(value?.shippedToday || value?.shipped_today || 0),
          openAsnsCount: Number(value?.openAsnsCount || value?.open_asns_count || 0),
          receiving: Number(value?.receiving || 0),
          source: 'wms_inventory_snapshot',
        },
      }))
      .filter((row) => row.sku);
  }
  return [];
}

async function applyInventorySnapshot(params: {
  userId: string;
  warehouseCode: string;
  body: any;
}) {
  const rows = normalizeInventoryRows(params.body);
  let applied = 0;
  let unmatched = 0;
  for (const row of rows) {
    const snapshot = {
      ...row.snapshot,
      warehouseCode: params.warehouseCode,
      updatedAt: new Date().toISOString(),
    };
    const result = await pgQuery(
      `UPDATE catalog_items
       SET wms_inventory = jsonb_set(
             COALESCE(wms_inventory, '{}'::jsonb),
             ARRAY[$3],
             $4::jsonb,
             true
           ),
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{lastWmsInventorySnapshotAt}',
             to_jsonb(now()::text),
             true
           ),
           updated_at = now()
       WHERE user_id = $1
         AND sku = $2`,
      [params.userId, row.sku, params.warehouseCode, JSON.stringify(snapshot)],
    );
    const rowCount = result?.rowCount || 0;
    if (rowCount > 0) applied += rowCount;
    else unmatched += 1;
  }
  return { received: rows.length, applied, unmatched };
}

function bodyPayload(body: any): any {
  return body?.payload && typeof body.payload === 'object' ? body.payload : body || {};
}

function textValue(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return null;
}

function wmsMetadata(body: any, warehouseCode: string) {
  const payload = bodyPayload(body);
  return {
    source: 'wms',
    sourceSystem: 'uniewms',
    warehouseCode,
    wmsEntityId: String(body.entityId || body.entity_id || payload.id || payload._id || ''),
    wmsIntermediaryId: body.wmsIntermediaryId || body.wms_intermediary_id || null,
    externalReference: body.externalReference || payload.sku || payload.orderNumber || payload.asnNumber || payload.vendorNumber || payload.customerNumber || null,
    operation: body.operation || null,
    lastWmsSyncAt: new Date().toISOString(),
    raw: payload,
  };
}

// Fixed stage-rank per entity. A WMS event may NOT downgrade a more-advanced status (the
// 30-min batch drain can deliver events out of order — a stale 'picking' must not overwrite
// 'shipped'). 'cancelled' is terminal (only an explicit reopen elsewhere can leave it).
const WMS_STATUS_RANK: Record<string, Record<string, number>> = {
  order: { pending: 0, confirmed: 1, picking: 2, packing: 3, ready_to_ship: 4, shipped: 5, completed: 6 },
  // ASN receiving lifecycle; putaway is tracked separately in payload, not this column.
  asn: { 'in-transit': 0, pending: 0, partial: 1, received: 2, completed: 3 },
}

/**
 * Decide whether an incoming WMS status may be applied to the current stored status.
 * - unknown/absent statuses pass through (never block on something we don't rank),
 * - 'cancelled' is terminal: once cancelled, a non-cancelled WMS event cannot revive it,
 * - otherwise apply only when incoming rank >= current rank (no downgrade).
 */
function wmsStatusAllowsTransition(entity: 'order' | 'asn', current?: string | null, incoming?: string | null): boolean {
  const cur = String(current || '').trim().toLowerCase()
  const inc = String(incoming || '').trim().toLowerCase()
  if (!inc) return false
  if (!cur) return true
  if (cur === inc) return true
  if (cur === 'cancelled') return inc === 'cancelled'
  if (inc === 'cancelled') return true // cancellation may always be applied to a non-terminal order
  const ranks = WMS_STATUS_RANK[entity] || {}
  const rc = ranks[cur]
  const ri = ranks[inc]
  if (rc === undefined || ri === undefined) return true // don't block on unranked statuses
  return ri >= rc
}

async function upsertWmsItem(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const sku = textValue(payload.sku, body.externalReference);
  if (!sku) return { skipped: true, reason: 'missing_sku' };
  const metadata = wmsMetadata(body, warehouseCode);
  const archived = body.operation === 'archived' || payload.archived === true || payload.status === 'archived';
  const dimensions = payload.dimensions || {
    length: payload.length,
    width: payload.width,
    height: payload.height,
  };
  const result = await pgQuery(
    `INSERT INTO catalog_items
      (user_id, sku, title, description, image, images, upc, ean, asin, category, sub_category, lob, weight, dimensions, archived, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb)
     ON CONFLICT (user_id, sku) DO UPDATE SET
      title = EXCLUDED.title,
      description = COALESCE(EXCLUDED.description, catalog_items.description),
      image = COALESCE(EXCLUDED.image, catalog_items.image),
      images = CASE WHEN jsonb_array_length(EXCLUDED.images) > 0 THEN EXCLUDED.images ELSE catalog_items.images END,
      upc = COALESCE(EXCLUDED.upc, catalog_items.upc),
      ean = COALESCE(EXCLUDED.ean, catalog_items.ean),
      asin = COALESCE(EXCLUDED.asin, catalog_items.asin),
      category = COALESCE(EXCLUDED.category, catalog_items.category),
      sub_category = COALESCE(EXCLUDED.sub_category, catalog_items.sub_category),
      lob = COALESCE(EXCLUDED.lob, catalog_items.lob),
      weight = COALESCE(EXCLUDED.weight, catalog_items.weight),
      dimensions = CASE WHEN EXCLUDED.dimensions <> '{}'::jsonb THEN EXCLUDED.dimensions ELSE catalog_items.dimensions END,
      archived = EXCLUDED.archived,
      metadata = catalog_items.metadata || EXCLUDED.metadata,
      updated_at = now()
     RETURNING id`,
    [
      userId,
      sku,
      textValue(payload.title, payload.itemName, payload.name, sku),
      textValue(payload.description, payload.itemDescription),
      textValue(payload.image),
      JSON.stringify(Array.isArray(payload.images) ? payload.images : payload.image ? [payload.image] : []),
      textValue(payload.upc),
      textValue(payload.ean),
      textValue(payload.asin),
      textValue(payload.category),
      textValue(payload.subCategory, payload.sub_category),
      textValue(payload.lob, payload.productType),
      payload.weight ? Number(payload.weight) : null,
      JSON.stringify(dimensions || {}),
      archived,
      JSON.stringify(metadata),
    ],
  );
  return { upserted: result?.rows?.[0]?.id || null };
}

async function upsertWmsSupplier(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const name = textValue(payload.name, `${payload.firstName || ''} ${payload.lastName || ''}`, payload.vendorNumber, body.externalReference);
  if (!name) return { skipped: true, reason: 'missing_supplier_name' };
  const metadata = wmsMetadata(body, warehouseCode);
  const existing = await pgQuery(
    `SELECT id FROM suppliers
     WHERE user_id = $1
       AND (metadata->>'wmsEntityId' = $2 OR metadata->>'externalReference' = $3)
     LIMIT 1`,
    [userId, metadata.wmsEntityId, String(metadata.externalReference || '')],
  );
  const address = {
    addressLine1: payload.addressLine1,
    addressLine2: payload.addressLine2,
    city: payload.city,
    state: payload.state,
    zipCode: payload.zipCode,
    country: payload.country,
  };
  if (existing?.rows?.[0]?.id) {
    await pgQuery(
      `UPDATE suppliers
       SET name=$3, email=$4, phone=$5, status=$6, address=$7::jsonb, metadata=metadata || $8::jsonb, updated_at=now()
       WHERE user_id=$1 AND id=$2`,
      [userId, existing.rows[0].id, name, textValue(payload.email), textValue(payload.phone), textValue(payload.status) || 'active', JSON.stringify(address), JSON.stringify(metadata)],
    );
    return { upserted: existing.rows[0].id };
  }
  const inserted = await pgQuery(
    `INSERT INTO suppliers (user_id, name, email, phone, status, address, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
     RETURNING id`,
    [userId, name, textValue(payload.email), textValue(payload.phone), textValue(payload.status) || 'active', JSON.stringify(address), JSON.stringify(metadata)],
  );
  return { upserted: inserted?.rows?.[0]?.id || null };
}

async function upsertWmsCustomer(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const name = textValue(payload.name, `${payload.firstName || ''} ${payload.lastName || ''}`, payload.customerNumber, body.externalReference);
  const metadata = wmsMetadata(body, warehouseCode);
  const externalCustomerId = metadata.wmsEntityId || String(body.entityId || '');
  if (!name && !externalCustomerId) return { skipped: true, reason: 'missing_customer_identity' };
  const address = {
    addressLine1: payload.addressLine1,
    addressLine2: payload.addressLine2,
    city: payload.city,
    state: payload.state,
    zipCode: payload.zipCode,
    country: payload.country,
  };
  const existing = await pgQuery('SELECT id FROM customers WHERE user_id=$1 AND external_customer_id=$2 LIMIT 1', [userId, externalCustomerId]);
  if (existing?.rows?.[0]?.id) {
    await pgQuery(
      `UPDATE customers
       SET name=$3, email=$4, phone=$5, company=$6, addresses=$7::jsonb, metadata=metadata || $8::jsonb, updated_at=now()
       WHERE user_id=$1 AND id=$2`,
      [userId, existing.rows[0].id, name, textValue(payload.email), textValue(payload.phone), textValue(payload.company), JSON.stringify([address]), JSON.stringify(metadata)],
    );
    return { upserted: existing.rows[0].id };
  }
  const result = await pgQuery(
    `INSERT INTO customers (user_id, name, email, phone, company, channel, external_customer_id, addresses, metadata)
     VALUES ($1,$2,$3,$4,$5,'wms',$6,$7::jsonb,$8::jsonb)
     RETURNING id`,
    [userId, name, textValue(payload.email), textValue(payload.phone), textValue(payload.company), externalCustomerId, JSON.stringify([address]), JSON.stringify(metadata)],
  );
  return { upserted: result?.rows?.[0]?.id || null };
}

async function upsertWmsOrder(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const externalOrderId = String(body.entityId || payload.id || payload._id || '');
  const wmsOrderNumber = textValue(payload.orderNumber, body.externalReference);
  // The client's ORIGINAL OMS order id/number travels back as alternativeOrderNumber. This is
  // the correct join key — the WMS number/_id are NOT stored on the native order.
  const altOrderNumber = textValue(payload.alternativeOrderNumber);
  const orderNumber = textValue(wmsOrderNumber, altOrderNumber, externalOrderId);
  if (!externalOrderId && !orderNumber) return { skipped: true, reason: 'missing_order_identity' };
  const metadata = wmsMetadata(body, warehouseCode);

  // Identity match precedence (all scoped to user_id = this OMS account):
  //  1. alternativeOrderNumber → the client's native order (id / order_number / external_order_id).
  //     THIS is what prevents the duplicate 'wms' shadow: it finds the order the client placed.
  //  2. Fallback: the WMS _id / WMS number (for orders that originated in the WMS, no native row,
  //     and for rows we already stamped on a prior sync).
  let existing: any = null;
  if (altOrderNumber) {
    existing = await pgQuery(
      `SELECT id, status FROM orders
       WHERE user_id=$1 AND (id::text=$2 OR order_number=$2 OR external_order_id=$2)
       LIMIT 1`,
      [userId, altOrderNumber],
    );
  }
  if (!existing?.rows?.[0]?.id) {
    existing = await pgQuery(
      `SELECT id, status FROM orders
       WHERE user_id=$1 AND (
         (external_order_id IS NOT NULL AND external_order_id=$2) OR
         (metadata->>'wmsEntityId')=$2 OR
         ($3 <> '' AND (order_number=$3 OR (metadata->>'wmsOrderNumber')=$3))
       ) LIMIT 1`,
      [userId, externalOrderId || ' ', wmsOrderNumber || ''],
    );
  }

  const matchedId = existing?.rows?.[0]?.id || null;
  const currentStatus = existing?.rows?.[0]?.status || null;
  const incomingStatus = textValue(payload.status);
  const hasTotals = payload.totals != null || payload.totalQuantity != null || payload.totalValue != null;
  const hasShipping = payload.shipping?.address != null || payload.shippingAddress != null;
  const totals = payload.totals || { quantity: payload.totalQuantity, value: payload.totalValue };

  let orderId = matchedId;
  if (orderId) {
    // Stamp WMS ids into metadata for fast future matches, WITHOUT overwriting the client's
    // native order_number / external_order_id. Only advance status forward, and only overwrite
    // totals/shipping when the WMS event actually carries them (else keep OMS-owned values).
    const applyStatus = incomingStatus && wmsStatusAllowsTransition('order', currentStatus, incomingStatus);
    const metaWithWms = { ...metadata, wmsOrderNumber: wmsOrderNumber || undefined, wmsEntityId: externalOrderId || undefined };
    await pgQuery(
      `UPDATE orders SET
         status = CASE WHEN $3::boolean THEN $4 ELSE status END,
         totals = CASE WHEN $5::boolean THEN $6::jsonb ELSE totals END,
         shipping_address = CASE WHEN $7::boolean THEN $8::jsonb ELSE shipping_address END,
         tracking_number = COALESCE($9::text, tracking_number),
         metadata = metadata || $10::jsonb,
         updated_at = now()
       WHERE user_id=$1 AND id=$2`,
      [
        userId,
        orderId,
        Boolean(applyStatus),
        incomingStatus || currentStatus || 'open',
        hasTotals,
        JSON.stringify(totals || {}),
        hasShipping,
        JSON.stringify(payload.shipping?.address || payload.shippingAddress || {}),
        textValue(payload.trackingNumber, payload.shipping?.trackingNumber),
        JSON.stringify(metaWithWms),
      ],
    );
  } else {
    // No native match → this is a genuinely WMS-origin order. Create a wms-channel row.
    const inserted = await pgQuery(
      `INSERT INTO orders (user_id, channel, external_order_id, order_number, status, totals, shipping_address, tracking_number, metadata)
       VALUES ($1,'wms',$2,$3,$4,$5::jsonb,$6::jsonb,$7::text,$8::jsonb)
       RETURNING id`,
      [
        userId,
        externalOrderId,
        orderNumber,
        incomingStatus || 'open',
        JSON.stringify(totals || {}),
        JSON.stringify(payload.shipping?.address || payload.shippingAddress || {}),
        textValue(payload.trackingNumber, payload.shipping?.trackingNumber),
        JSON.stringify({ ...metadata, wmsOrderNumber: wmsOrderNumber || undefined, wmsEntityId: externalOrderId || undefined }),
      ],
    );
    orderId = inserted?.rows?.[0]?.id;
  }
  // Only (re)write line items when the WMS event actually carries them, so a status-only event
  // doesn't wipe the client's order lines.
  if (orderId && Array.isArray(payload.lineItems) && payload.lineItems.length > 0) {
    await pgQuery('DELETE FROM order_lines WHERE user_id=$1 AND order_id=$2', [userId, orderId]);
    for (const line of payload.lineItems) {
      await pgQuery(
        `INSERT INTO order_lines (user_id, order_id, sku, title, quantity, unit_price, total_price, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          userId,
          orderId,
          textValue(line.sku),
          textValue(line.itemName, line.title, line.sku),
          Number(line.quantity || 0),
          Number(line.unitPrice || 0),
          Number(line.totalPrice || (Number(line.quantity || 0) * Number(line.unitPrice || 0))),
          JSON.stringify({ source: 'wms', raw: line }),
        ],
      );
    }
  }
  return { upserted: orderId || null };
}

async function upsertWmsAsn(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const metadata = wmsMetadata(body, warehouseCode);
  const externalId = String(body.entityId || payload.id || payload._id || '');
  const wmsAsnNumber = textValue(payload.asnNumber, body.externalReference);
  // The client's ORIGINAL OMS ASN identity travels back as alternativeOrderNumber / poNumber
  // (OMS sends its own ASN-xxxx as poNumber at create). Use it to find the native ASN.
  const altRef = textValue(payload.alternativeOrderNumber, payload.poNumber);
  const asnNumber = textValue(wmsAsnNumber, altRef, externalId);
  if (!externalId && !asnNumber) return { skipped: true, reason: 'missing_asn_identity' };

  // Identity precedence (scoped user_id): 1) the client's native ASN by its own number /
  // the wmsExecution linkage carrying alternativeOrderNumber; 2) fallback to the WMS id/number
  // we may have already stamped. This avoids creating a duplicate 'wms' ASN alongside the
  // client's projected ASN.
  let existing: any = null;
  if (altRef) {
    existing = await pgQuery(
      `SELECT id, status FROM asns
       WHERE user_id=$1 AND (asn_number=$2 OR payload->>'poNumber'=$2 OR payload->'wmsExecution'->>'asnNumber'=$2)
       LIMIT 1`,
      [userId, altRef],
    );
  }
  if (!existing?.rows?.[0]?.id) {
    existing = await pgQuery(
      `SELECT id, status FROM asns
       WHERE user_id=$1 AND ((payload->>'wmsEntityId')=$2 OR ($3 <> '' AND asn_number=$3))
       LIMIT 1`,
      [userId, externalId || ' ', wmsAsnNumber || ''],
    );
  }

  const matchedId = existing?.rows?.[0]?.id || null;
  const currentStatus = existing?.rows?.[0]?.status || null;
  const incomingStatus = textValue(payload.status, body.operation);
  const asnPayload = { ...payload, ...metadata };
  if (matchedId) {
    // Advance status forward only; keep the native asn_number (don't overwrite with the WMS one).
    const applyStatus = incomingStatus && wmsStatusAllowsTransition('asn', currentStatus, incomingStatus);
    await pgQuery(
      `UPDATE asns
       SET status = CASE WHEN $3::boolean THEN $4 ELSE status END,
           payload = payload || $5::jsonb,
           updated_at = now()
       WHERE user_id=$1 AND id=$2`,
      [userId, matchedId, Boolean(applyStatus), incomingStatus || currentStatus || 'created', JSON.stringify(asnPayload)],
    );
    return { upserted: matchedId };
  }
  const inserted = await pgQuery(
    `INSERT INTO asns (user_id, asn_number, status, payload)
     VALUES ($1,$2,$3,$4::jsonb)
     RETURNING id`,
    [userId, asnNumber, incomingStatus || 'created', JSON.stringify(asnPayload)],
  );
  return { upserted: inserted?.rows?.[0]?.id || null };
}

async function upsertWmsInvoice(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const metadata = wmsMetadata(body, warehouseCode);
  const externalId = String(body.entityId || payload.id || payload._id || '');
  const invoiceNumber = textValue(payload.invoiceNumber, body.externalReference, externalId);
  if (!externalId && !invoiceNumber) return { skipped: true, reason: 'missing_invoice_identity' };
  const existing = await pgQuery(
    `SELECT id FROM invoice_lines
     WHERE user_id=$1
       AND (payload->>'wmsEntityId'=$2 OR invoice_id=$3)
     LIMIT 1`,
    [userId, externalId, invoiceNumber],
  );
  const total = Number(payload?.totals?.total || payload?.total || payload?.amount || 0);
  const invoicePayload = { ...payload, ...metadata };
  if (existing?.rows?.[0]?.id) {
    await pgQuery(
      `UPDATE invoice_lines
       SET description=$3, amount=$4, status=$5, payload=$6::jsonb, updated_at=now()
       WHERE user_id=$1 AND id=$2`,
      [
        userId,
        existing.rows[0].id,
        `WMS invoice ${invoiceNumber || externalId}`,
        total,
        textValue(payload.status, body.operation) || 'open',
        JSON.stringify(invoicePayload),
      ],
    );
    return { upserted: existing.rows[0].id };
  }
  const inserted = await pgQuery(
    `INSERT INTO invoice_lines (user_id, invoice_id, description, amount, status, payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id`,
    [
      userId,
      invoiceNumber || externalId,
      `WMS invoice ${invoiceNumber || externalId}`,
      total,
      textValue(payload.status, body.operation) || 'open',
      JSON.stringify(invoicePayload),
    ],
  );
  return { upserted: inserted?.rows?.[0]?.id || null };
}

function normalizeSupportStatus(value: unknown): string {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'in_progress') return 'in-progress';
  if (['open', 'in-progress', 'waiting_client', 'resolved', 'closed'].includes(status)) return status;
  return 'open';
}

function normalizeSupportPriority(value: unknown): string {
  const priority = String(value || '').trim().toLowerCase();
  if (priority === 'medium') return 'med';
  if (['low', 'med', 'high', 'urgent'].includes(priority)) return priority;
  return 'med';
}

async function upsertWmsSupportTicket(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const wmsTicketId = textValue(payload.id, body.entityId, body.entity_id);
  const subject = textValue(payload.subject, payload.ticketNumber, body.externalReference);
  if (!wmsTicketId || !subject) return { skipped: true, reason: 'missing_support_ticket_identity' };

  const existing = await pgQuery(
    `SELECT id FROM support_tickets
     WHERE user_id=$1 AND entity_type='support_ticket' AND entity_id=$2
     LIMIT 1`,
    [userId, wmsTicketId],
  );

  const ticketValues = [
    userId,
    existing?.rows?.[0]?.id || null,
    subject,
    textValue(payload.body),
    wmsTicketId,
    normalizeSupportPriority(payload.priority),
    normalizeSupportStatus(payload.status),
    textValue(payload.owner) || 'WMS',
  ];

  let ticketId = existing?.rows?.[0]?.id;
  if (ticketId) {
    await pgQuery(
      `UPDATE support_tickets
       SET subject=$3, body=$4, channel='wms', priority=$6, status=$7, owner=$8, updated_at=now()
       WHERE user_id=$1 AND id=$2`,
      ticketValues,
    );
  } else {
    // Own param list: the shared ticketValues includes $2 (existing id) which the INSERT never
    // references → untyped bare-null param → 42P18. Cast the nullable body param too.
    const inserted = await pgQuery(
      `INSERT INTO support_tickets (user_id, subject, body, entity_type, entity_id, channel, priority, status, owner)
       VALUES ($1,$2,$3::text,'support_ticket',$4,'wms',$5,$6,$7)
       RETURNING id`,
      [ticketValues[0], ticketValues[2], ticketValues[3], ticketValues[4], ticketValues[5], ticketValues[6], ticketValues[7]],
    );
    ticketId = inserted?.rows?.[0]?.id;
  }

  if (ticketId && payload.message) {
    await upsertWmsSupportTicketMessage(userId, warehouseCode, {
      ...body,
      payload: {
        ...payload,
        message: payload.message,
      },
    });
  }

  return { upserted: ticketId || null };
}

async function upsertWmsSupportTicketMessage(userId: string, warehouseCode: string, body: any) {
  const payload = bodyPayload(body);
  const wmsTicketId = textValue(payload.id, payload.ticketId, payload.ticket_id);
  const message = payload.message || payload;
  const text = textValue(message.body);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (!wmsTicketId || (!text && attachments.length === 0)) return { skipped: true, reason: 'missing_support_message_identity' };

  const ticket = await pgQuery(
    `SELECT id FROM support_tickets
     WHERE user_id=$1 AND entity_type='support_ticket' AND entity_id=$2
     LIMIT 1`,
    [userId, wmsTicketId],
  );
  const ticketId = ticket?.rows?.[0]?.id;
  if (!ticketId) return { skipped: true, reason: 'missing_parent_support_ticket' };

  const authorName = textValue(message.authorName) || 'WMS';
  const duplicate = await pgQuery(
    `SELECT id FROM support_ticket_messages
     WHERE user_id=$1 AND ticket_id=$2 AND COALESCE(body,'')=$3 AND COALESCE(author_name,'')=$4
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, ticketId, text || '', authorName],
  );
  if (duplicate?.rows?.[0]?.id) return { upserted: duplicate.rows[0].id, duplicate: true };

  const inserted = await pgQuery(
    `INSERT INTO support_ticket_messages (user_id, ticket_id, author_type, author_name, body, attachments)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id`,
    [
      userId,
      ticketId,
      textValue(message.authorType) || 'warehouse',
      authorName,
      text || null,
      JSON.stringify(attachments),
    ],
  );

  await pgQuery(
    `UPDATE support_tickets
     SET status = CASE WHEN status IN ('resolved','closed') THEN status ELSE 'in-progress' END,
         updated_at = now()
     WHERE user_id=$1 AND id=$2`,
    [userId, ticketId],
  );

  return { upserted: inserted?.rows?.[0]?.id || null };
}

async function applyEntityEvent(params: { userId: string; warehouseCode: string; body: any }) {
  const entityType = String(params.body.entityType || params.body.entity_type || '').toLowerCase();
  if (!['entity_upsert', 'entity_status', 'entity_archive'].includes(String(params.body.eventType || ''))) return null;
  if (entityType === 'item' || entityType === 'catalog_item') return upsertWmsItem(params.userId, params.warehouseCode, params.body);
  if (entityType === 'supplier' || entityType === 'vendor') return upsertWmsSupplier(params.userId, params.warehouseCode, params.body);
  if (entityType === 'customer') return upsertWmsCustomer(params.userId, params.warehouseCode, params.body);
  if (entityType === 'order') return upsertWmsOrder(params.userId, params.warehouseCode, params.body);
  if (entityType === 'asn') return upsertWmsAsn(params.userId, params.warehouseCode, params.body);
  if (entityType === 'invoice') return upsertWmsInvoice(params.userId, params.warehouseCode, params.body);
  if (entityType === 'support_ticket') return upsertWmsSupportTicket(params.userId, params.warehouseCode, params.body);
  if (entityType === 'support_ticket_message') return upsertWmsSupportTicketMessage(params.userId, params.warehouseCode, params.body);
  return { skipped: true, reason: `unsupported_entity_type:${entityType}` };
}

async function acceptWmsEvent(req: any, reply: any, defaultEventType: string) {
  const credential = await verifyWmsCallback(req, reply);
  if (!credential) return;

  const body = req.body || {};
  const idempotencyKey = headerValue(req.headers['idempotency-key']) || body.idempotencyKey || `${credential.client_id}:${defaultEventType}:${Date.now()}`;
  const eventType = body.eventType || defaultEventType;
  const warehouseCode = String(body.warehouseCode || credential.warehouse_code || '').trim();
  const payload = {
    ...body,
    clientId: credential.client_id,
    warehouseCode,
  };

  const event = await pgQuery(
    `INSERT INTO oms_wms_events
      (user_id, credential_id, client_id, warehouse_code, wms_intermediary_id, event_type, entity_type, entity_id, idempotency_key, payload)
     VALUES ($1, $2, $3, $4, $5::text, $6, $7::text, $8::text, $9, $10::jsonb)
     ON CONFLICT (client_id, idempotency_key) DO UPDATE SET
      payload = EXCLUDED.payload,
      received_at = now()
     RETURNING *`,
    [
      credential.user_id,
      credential.id,
      credential.client_id,
      warehouseCode,
      body.wmsIntermediaryId || body.wms_intermediary_id || null,
      eventType,
      body.entityType || body.entity_type || null,
      body.entityId || body.entity_id || null,
      idempotencyKey,
      JSON.stringify(payload),
    ],
  );

  const inventoryApplied = eventType === 'inventory_snapshot'
    ? await applyInventorySnapshot({
        userId: String(credential.user_id),
        warehouseCode,
        body,
      })
    : null;
  const entityApplied = await applyEntityEvent({
    userId: String(credential.user_id),
    warehouseCode,
    body: {
      ...body,
      eventType,
    },
  });

  await pgQuery(
    `INSERT INTO oms_execution_ledger
      (user_id, entity_type, entity_id, event_type, source_system, summary, payload)
     VALUES ($1, $2, $3, $4, 'wms', $5, $6::jsonb)`,
    [
      credential.user_id,
      body.entityType || body.entity_type || 'wms_event',
      body.entityId || body.entity_id || event?.rows[0]?.id || null,
      eventType,
      body.summary || `WMS ${eventType} received from ${body.warehouseCode || credential.warehouse_code}.`,
      JSON.stringify(payload),
    ],
  );

  return reply.code(202).send({ accepted: true, event: event?.rows[0] || null, inventoryApplied, entityApplied });
}

export async function wmsIntegrationRoutes(app: FastifyInstance) {
  app.post('/internal/wms/oms-invites', async (req: any, reply) => {
    if (!requireInternalKey(req, reply)) return;
    const body = req.body || {};
    const profile = body.profile || {};
    const email = String(profile.email || '').toLowerCase().trim();
    const warehouseCode = String(body.warehouseCode || '').trim();
    const wmsIntermediaryId = String(body.wmsIntermediaryId || '').trim();
    const connectionCode = String(body.connectionCode || '').trim().toUpperCase();
    if (!email || !warehouseCode || !wmsIntermediaryId || !connectionCode) {
      return reply.code(400).send({
        error: 'email, warehouseCode, wmsIntermediaryId, and connectionCode are required',
      });
    }

    const metadata = {
      source: 'wms_intermediary_invite',
      warehouseCode,
      wmsIntermediaryId,
      intermediaryNumber: body.intermediaryNumber || null,
      connectionCode,
      networkPolicy: body.networkPolicy || {},
      prefillProfile: {
        email,
        firstName: String(profile.firstName || '').trim(),
        lastName: String(profile.lastName || '').trim(),
        phone: String(profile.phone || '').trim(),
        companyName: String(profile.companyName || '').trim(),
        llcName: String(profile.llcName || profile.companyName || '').trim(),
        billingAddress: profile.billingAddress || null,
      },
    };

    const existing = await pgQuery<{ token: string; expires_at: string; metadata: any }>(
      `SELECT token, expires_at, metadata
       FROM invite_tokens
       WHERE used_at IS NULL
         AND expires_at > now()
         AND metadata->>'source' = 'wms_intermediary_invite'
         AND metadata->>'warehouseCode' = $1
         AND metadata->>'wmsIntermediaryId' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [warehouseCode, wmsIntermediaryId],
    );
    const existingInvite = existing?.rows[0];
    if (existingInvite) {
      return {
        status: 'pending',
        token: existingInvite.token,
        inviteLink: `${config.frontendOrigin}/signup?invite=${encodeURIComponent(existingInvite.token)}`,
        expiresAt: existingInvite.expires_at,
        metadata: safeInviteMetadata(existingInvite.metadata),
      };
    }

    const token = randomBytes(24).toString('hex');
    const inserted = await pgQuery<{ expires_at: string }>(
      `INSERT INTO invite_tokens (token, role, metadata)
       VALUES ($1, 'ecommerce_client', $2::jsonb)
       RETURNING expires_at`,
      [token, JSON.stringify(metadata)],
    );

    return reply.code(201).send({
      status: 'pending',
      token,
      inviteLink: `${config.frontendOrigin}/signup?invite=${encodeURIComponent(token)}`,
      expiresAt: inserted?.rows[0]?.expires_at,
      metadata: safeInviteMetadata(metadata),
    });
  });

  app.post('/internal/wms/integration-credentials/register', async (req: any, reply) => {
    const userId = await requireInternalOrUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!body.warehouseCode || !body.clientId || !body.passkey) {
      return reply.code(400).send({ error: 'warehouseCode, clientId, and passkey are required' });
    }
    const credential = await registerWmsCredential({
      userId,
      warehouseCode: String(body.warehouseCode).trim(),
      clientId: String(body.clientId).trim(),
      passkey: String(body.passkey),
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      metadata: body.metadata || {},
    });
    return reply.code(201).send({
      credential: credential
        ? {
            id: credential.id,
            userId: credential.user_id,
            warehouseCode: credential.warehouse_code,
            clientId: credential.client_id,
            passkeyPrefix: credential.passkey_prefix,
            scopes: credential.scopes,
            status: credential.status,
            expiresAt: credential.expires_at,
          }
        : null,
      warning: 'Passkey was encrypted for outbound WMS calls and stored as a hash for callback verification.',
    });
  });

  app.post('/internal/wms/events', async (req, reply) => acceptWmsEvent(req, reply, 'wms_event'));
  app.post('/internal/wms/support-tickets', async (req, reply) => acceptWmsEvent(req, reply, 'entity_upsert'));
  app.post('/internal/wms/support-tickets/:externalReference/messages', async (req, reply) => {
    const body = {
      ...(req.body || {}),
      externalReference: (req.params as any)?.externalReference,
      entityType: 'support_ticket_message',
      eventType: 'entity_upsert',
    };
    (req as any).body = body;
    return acceptWmsEvent(req, reply, 'entity_upsert');
  });
  app.post('/internal/wms/order-status', async (req, reply) => acceptWmsEvent(req, reply, 'order_status'));
  app.post('/internal/wms/inventory-snapshot', async (req, reply) => acceptWmsEvent(req, reply, 'inventory_snapshot'));
  app.post('/internal/wms/asn-status', async (req, reply) => acceptWmsEvent(req, reply, 'asn_status'));
  app.post('/internal/wms/billing-event', async (req, reply) => acceptWmsEvent(req, reply, 'billing_event'));
  app.post('/internal/wms/dispute-event', async (req, reply) => acceptWmsEvent(req, reply, 'dispute_event'));
}
