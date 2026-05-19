import { FastifyInstance } from 'fastify';
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
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

  return reply.code(202).send({ accepted: true, event: event?.rows[0] || null, inventoryApplied });
}

export async function wmsIntegrationRoutes(app: FastifyInstance) {
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
  app.post('/internal/wms/order-status', async (req, reply) => acceptWmsEvent(req, reply, 'order_status'));
  app.post('/internal/wms/inventory-snapshot', async (req, reply) => acceptWmsEvent(req, reply, 'inventory_snapshot'));
  app.post('/internal/wms/asn-status', async (req, reply) => acceptWmsEvent(req, reply, 'asn_status'));
  app.post('/internal/wms/billing-event', async (req, reply) => acceptWmsEvent(req, reply, 'billing_event'));
  app.post('/internal/wms/dispute-event', async (req, reply) => acceptWmsEvent(req, reply, 'dispute_event'));
}
