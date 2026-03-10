import { FastifyReply } from 'fastify';
import { Types } from 'mongoose';
import { OmsWarehouseConnectionCode } from '../models/oms-warehouse-connection-code';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';
import { resolveOmsApiKeyForConnect } from '../lib/api-key-auth';

/**
 * Redeem connection code. Auth: JWT (User email matches OmsIntermediary) or OMS API key.
 */
export async function redeemConnectionCode(req: any, reply: FastifyReply) {
  const { connectionCode } = req.body || {};
  if (!connectionCode?.trim()) {
    return reply.code(400).send({ error: 'connectionCode required' });
  }

  let omsIntermediaryId: Types.ObjectId | null = null;

  // Try OMS API key (for connect, no X-Warehouse-ID required)
  const auth = (req.headers.authorization || '').trim();
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token && !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    const omsId = await resolveOmsApiKeyForConnect(token);
    if (omsId) omsIntermediaryId = omsId;
  }

  // Fallback: JWT user -> OmsIntermediary by email
  if (!omsIntermediaryId) {
    const userId = req.user?.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    // JWT flow: find OmsIntermediary by User email
    const { User } = await import('../models/user');
    const user = await User.findById(userId).select('email').lean().exec();
    if (!user?.email) return reply.code(403).send({ error: 'No OMS account associated with your user' });
    const { OmsIntermediary } = await import('../models/oms-intermediary');
    const oms = await OmsIntermediary.findOne({ email: user.email.toLowerCase(), status: 'active' })
      .lean()
      .exec();
    if (!oms) {
      return reply.code(403).send({
        error: 'No OMS account',
        message: 'Your user email is not associated with an OMS account. Contact your administrator.',
      });
    }
    omsIntermediaryId = oms._id as Types.ObjectId;
  }

  if (!omsIntermediaryId) {
    return reply.code(401).send({ error: 'Valid OMS API key or logged-in user with OMS account required' });
  }

  const codeRecord = await OmsWarehouseConnectionCode.findOne({
    code: String(connectionCode).trim(),
    status: 'pending',
    expiresAt: { $gt: new Date() },
  })
    .lean()
    .exec();

  if (!codeRecord) {
    return reply.code(404).send({
      error: 'Connection code not found, already redeemed, or expired',
    });
  }

  if (codeRecord.omsIntermediaryId && !codeRecord.omsIntermediaryId.equals(omsIntermediaryId)) {
    return reply.code(403).send({ error: 'Connection code belongs to another OMS account' });
  }

  const wmsIntermediaryId = codeRecord.wmsIntermediaryId;

  if (!wmsIntermediaryId) {
    return reply.code(500).send({ error: 'Warehouse configuration error' });
  }

  const existing = await OmsIntermediaryWarehouse.findOne({
    omsIntermediaryId,
    warehouseCode: codeRecord.warehouseCode,
  })
    .lean()
    .exec();

  if (!existing) {
    await OmsIntermediaryWarehouse.create({
      omsIntermediaryId,
      warehouseCode: codeRecord.warehouseCode,
      wmsIntermediaryId,
    });
  }

  await OmsWarehouseConnectionCode.findByIdAndUpdate(codeRecord._id, {
    omsIntermediaryId,
    redeemedAt: new Date(),
    status: 'redeemed',
  });

  return {
    message: 'Successfully connected to warehouse',
    warehouseCode: codeRecord.warehouseCode,
  };
}
