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

/**
 * List connected warehouses for JWT user. Resolves OmsIntermediary by email,
 * fetches OmsIntermediaryWarehouse links, enriches with warehouse metadata from UnieBackend.
 */
export async function listWarehouses(req: any, reply: FastifyReply) {
  const userId = req.user?.userId;
  if (!userId) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'Please log in.' });
  }

  const omsId = await resolveOmsIntermediaryForUser(userId);
  if (!omsId) {
    return reply.send({ warehouses: [] });
  }

  const links = await OmsIntermediaryWarehouse.find({ omsIntermediaryId: omsId })
    .sort({ createdAt: -1 })
    .lean()
    .exec();

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
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Internal-Api-Key': config.internalApiKey },
  });

  const data = (await res.json().catch(() => ({}))) as {
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
