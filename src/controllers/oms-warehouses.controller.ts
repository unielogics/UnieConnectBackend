import { FastifyReply } from 'fastify';
import { Types } from 'mongoose';
import fetch from 'node-fetch';
import { config } from '../config/env';
import { OmsIntermediary } from '../models/oms-intermediary';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';
import { User } from '../models/user';

async function resolveOmsIntermediaryForUser(userId: string): Promise<Types.ObjectId | null> {
  const user = await User.findById(userId).select('email').lean().exec();
  if (!user?.email) return null;
  const oms = await OmsIntermediary.findOne({
    email: (user.email as string).toLowerCase(),
    status: 'active',
  })
    .select('_id')
    .lean()
    .exec();
  return oms?._id ? (oms._id as Types.ObjectId) : null;
}

// #region agent log
const _log = (loc: string, msg: string, data: Record<string, unknown>) => { fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location: loc, message: msg, data, timestamp: Date.now(), runId: 'warehouses' }) }).catch(() => {}); };
// #endregion

/**
 * List connected warehouses for JWT user. Resolves OmsIntermediary by email,
 * fetches OmsIntermediaryWarehouse links, enriches with warehouse metadata from UnieBackend.
 */
export async function listWarehouses(req: any, reply: FastifyReply) {
  const userId = req.user?.userId;
  // #region agent log
  _log('oms-warehouses.controller.ts:listWarehouses:entry', 'GET oms/warehouses entry', { userId: userId ?? null, hypothesisId: 'H1' });
  // #endregion
  if (!userId) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Please log in.' });
  }

  let omsId: Types.ObjectId | null = null;
  try {
    omsId = await resolveOmsIntermediaryForUser(userId);
  } catch (e) {
    // #region agent log
    _log('oms-warehouses.controller.ts:listWarehouses:resolveOmsErr', 'resolveOmsIntermediaryForUser threw', { err: (e as Error)?.message, hypothesisId: 'H1' });
    // #endregion
    throw e;
  }
  // #region agent log
  _log('oms-warehouses.controller.ts:listWarehouses:afterResolve', 'After resolveOmsIntermediaryForUser', { omsId: omsId ? String(omsId) : null, hypothesisId: 'H2' });
  // #endregion
  if (!omsId) {
    return reply.send({ warehouses: [] });
  }

  let links: any[];
  try {
    links = await OmsIntermediaryWarehouse.find({ omsIntermediaryId: omsId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  } catch (e) {
    // #region agent log
    _log('oms-warehouses.controller.ts:listWarehouses:findErr', 'OmsIntermediaryWarehouse.find threw', { err: (e as Error)?.message, hypothesisId: 'H2' });
    // #endregion
    throw e;
  }

  if (links.length === 0) {
    return reply.send({ warehouses: [] });
  }

  const codes = links.map((l) => l.warehouseCode);
  const codeToCreatedAt = new Map(links.map((l) => [l.warehouseCode, (l as any).createdAt]));

  if (!config.wmsApiUrl || !config.internalApiKey) {
    return reply.send({
      warehouses: codes.map((code) => ({
        warehouseCode: code,
        name: code,
        state: null,
        city: null,
        address: null,
        connectedAt: codeToCreatedAt.get(code),
      })),
    });
  }

  const url = `${config.wmsApiUrl}/api/v1/internal/oms/warehouses?codes=${codes.map(encodeURIComponent).join(',')}`;
  // #region agent log
  _log('oms-warehouses.controller.ts:listWarehouses:beforeFetch', 'Before fetch to UnieBackend', { url, wmsApiUrl: config.wmsApiUrl, hasApiKey: !!config.internalApiKey, hypothesisId: 'H3' });
  // #endregion
  let res: any;
  try {
    res = await fetch(url, { method: 'GET', headers: { 'X-Internal-Api-Key': config.internalApiKey } });
  } catch (e) {
    // #region agent log
    _log('oms-warehouses.controller.ts:listWarehouses:fetchErr', 'Fetch to UnieBackend failed', { err: (e as Error)?.message, hypothesisId: 'H3' });
    // #endregion
    throw e;
  }
  // #region agent log
  _log('oms-warehouses.controller.ts:listWarehouses:afterFetch', 'After fetch', { status: res?.status, ok: res?.ok, hypothesisId: 'H4' });
  // #endregion

  const data = (await res.json().catch((e: unknown) => {
    // #region agent log
    _log('oms-warehouses.controller.ts:listWarehouses:jsonErr', 'res.json() threw', { err: (e as Error)?.message, hypothesisId: 'H5' });
    // #endregion
    return {};
  })) as {
    warehouses?: Array<{ code: string; name?: string; state?: string; city?: string; address?: string }>;
  };
  const meta = new Map((data.warehouses || []).map((w) => [w.code, w]));

  return reply.send({
    warehouses: codes.map((code) => {
      const m = meta.get(code);
      return {
        warehouseCode: code,
        name: m?.name ?? code,
        state: m?.state ?? null,
        city: m?.city ?? null,
        address: m?.address ?? null,
        connectedAt: codeToCreatedAt.get(code),
      };
    }),
  });
}

/**
 * Remove warehouse connection. Requires JWT.
 */
export async function removeWarehouse(req: any, reply: FastifyReply) {
  const userId = req.user?.userId;
  if (!userId) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Please log in.' });
  }

  const { warehouseCode } = req.params as { warehouseCode: string };
  if (!warehouseCode?.trim()) {
    return reply.code(400).send({ error: 'warehouseCode is required' });
  }

  const omsId = await resolveOmsIntermediaryForUser(userId);
  if (!omsId) {
    return reply.code(404).send({ error: 'No OMS account found for this user' });
  }

  const result = await OmsIntermediaryWarehouse.deleteOne({
    omsIntermediaryId: omsId,
    warehouseCode: warehouseCode.trim(),
  }).exec();

  if (result.deletedCount === 0) {
    return reply.code(404).send({ error: 'Warehouse connection not found' });
  }

  return reply.send({ message: 'Connection removed' });
}

/**
 * Test warehouse connection. Verifies link exists; optionally can ping UnieBackend.
 */
export async function testWarehouse(req: any, reply: FastifyReply) {
  const userId = req.user?.userId;
  if (!userId) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Please log in.' });
  }

  const { warehouseCode } = req.params as { warehouseCode: string };
  if (!warehouseCode?.trim()) {
    return reply.code(400).send({ error: 'warehouseCode is required' });
  }

  const omsId = await resolveOmsIntermediaryForUser(userId);
  if (!omsId) {
    return reply.send({ ok: false, message: 'No OMS account found' });
  }

  const link = await OmsIntermediaryWarehouse.findOne({
    omsIntermediaryId: omsId,
    warehouseCode: warehouseCode.trim(),
  })
    .lean()
    .exec();

  if (!link) {
    return reply.send({ ok: false, message: 'Connection not found' });
  }

  return reply.send({ ok: true, message: 'Connection verified' });
}
