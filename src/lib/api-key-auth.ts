import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ApiKey } from '../models/api-key';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';
import { Types } from 'mongoose';
import { WAREHOUSE_CODE_REGEX } from './warehouse-code';

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/**
 * Attempt to resolve OMS ApiKey + X-Warehouse-ID to req.user.
 * Returns true if user was set, false if not applicable (not OMS key / no token).
 * Sends error reply and returns reply for invalid OMS key (caller should return it).
 */
export async function resolveOmsApiKeyAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  bearerToken: string,
): Promise<boolean | typeof reply> {
  const keyHash = hashApiKey(bearerToken);
  const apiKey = await ApiKey.findOne({ keyHash, type: 'oms' }).lean().exec();
  if (!apiKey) return false;

  const warehouseCode = (req.headers['x-warehouse-id'] as string)?.trim();
  if (!warehouseCode) {
    return reply.code(400).send({
      error: 'X-Warehouse-ID required',
      message: 'OMS API keys require the X-Warehouse-ID header.',
    }) as any;
  }

  if (!WAREHOUSE_CODE_REGEX.test(warehouseCode)) {
    return reply.code(400).send({
      error: 'Invalid X-Warehouse-ID',
      message: 'X-Warehouse-ID must be alphanumeric with underscores or hyphens, 1-64 characters.',
    }) as any;
  }

  const omsIntermediaryId = apiKey.omsIntermediaryId;
  if (!omsIntermediaryId) {
    return reply.code(403).send({
      error: 'Invalid API key',
      message: 'API key has no OMS intermediary association.',
    }) as any;
  }

  const link = await OmsIntermediaryWarehouse.findOne({
    omsIntermediaryId: new Types.ObjectId(omsIntermediaryId),
    warehouseCode,
  })
    .lean()
    .exec();

  if (!link) {
    return reply.code(403).send({
      error: 'Warehouse not linked',
      message: 'This OMS intermediary is not linked to the specified warehouse.',
    }) as any;
  }

  (req as any).user = { userId: String(link.wmsIntermediaryId) };
  return true;
}

/**
 * Resolve OMS API key for connect flow (no X-Warehouse-ID or link required).
 * Returns omsIntermediaryId if valid, null otherwise.
 */
export async function resolveOmsApiKeyForConnect(bearerToken: string): Promise<Types.ObjectId | null> {
  const keyHash = hashApiKey(bearerToken);
  const apiKey = await ApiKey.findOne({ keyHash, type: 'oms' }).select('omsIntermediaryId').lean().exec();
  return apiKey?.omsIntermediaryId ? (apiKey.omsIntermediaryId as Types.ObjectId) : null;
}

/**
 * Attempt to resolve WMS ApiKey to req.user.
 * WMS keys use intermediaryId (User ID) directly.
 */
export async function resolveWmsApiKeyAuth(
  req: FastifyRequest,
  bearerToken: string,
): Promise<boolean> {
  const keyHash = hashApiKey(bearerToken);
  const apiKey = await ApiKey.findOne({ keyHash, type: 'wms' }).lean().exec();
  if (!apiKey) return false;

  const intermediaryId = apiKey.intermediaryId;
  if (!intermediaryId) {
    return false; // WMS key without intermediaryId - cannot resolve
  }

  (req as any).user = { userId: String(intermediaryId) };
  return true;
}
