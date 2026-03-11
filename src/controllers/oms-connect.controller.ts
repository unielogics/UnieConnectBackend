import { FastifyReply } from 'fastify';
import { Types } from 'mongoose';
import fetch from 'node-fetch';
import { config } from '../config/env';
import { resolveOmsApiKeyForConnect } from '../lib/api-key-auth';

/**
 * Redeem connection code. Auth: JWT (User email matches OmsIntermediary) or OMS API key.
 * Proxies to UnieBackend internal /internal/oms/connect; connection codes live in WMS DB.
 */
export async function redeemConnectionCode(req: any, reply: FastifyReply) {
  const { connectionCode } = req.body || {};
  if (!connectionCode?.trim()) {
    return reply.code(400).send({ error: 'connectionCode required' });
  }

  let omsIntermediaryId: Types.ObjectId | null = null;
  let omsCompanyName: string | null = null;
  let omsFirstName: string | null = null;
  let omsLastName: string | null = null;
  let omsPhone: string | null = null;

  const auth = (req.headers.authorization || '').trim();
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const hasJwtFormat = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

  const { OmsIntermediary } = await import('../models/oms-intermediary');
  const { User } = await import('../models/user');

  // Try OMS API key (for connect, no X-Warehouse-ID required)
  if (token && !hasJwtFormat) {
    const omsId = await resolveOmsApiKeyForConnect(token);
    if (omsId) {
      omsIntermediaryId = omsId;
      const oms = await OmsIntermediary.findById(omsId).select('companyName').lean().exec();
      if (oms) omsCompanyName = oms.companyName || null;
    }
  }

  // Fallback: JWT user -> OmsIntermediary (internal OMS link by email; WMS never sees email)
  if (!omsIntermediaryId) {
    const userId = req.user?.userId;
    if (!userId) {
      req.log?.warn?.({ hasAuth: !!auth, hasJwtFormat: !!token && hasJwtFormat }, 'oms/connect: no userId (JWT invalid or expired)');
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired session. Please log in again.',
      });
    }
    const user = await User.findById(userId).select('email firstName lastName phone').lean().exec();
    if (!user?.email) return reply.code(403).send({ error: 'No OMS account associated with your user' });
    const oms = await OmsIntermediary.findOne({ email: user.email.toLowerCase(), status: 'active' }).lean().exec();
    if (oms) {
      omsIntermediaryId = oms._id as Types.ObjectId;
      omsCompanyName = oms.companyName || null;
    } else {
      const count = await OmsIntermediary.countDocuments().exec();
      const omsNumber = `OMS-${String(count + 1).padStart(4, '0')}`;
      omsCompanyName = `Account (${omsNumber})`;
      const newOms = await OmsIntermediary.create({
        companyName: omsCompanyName,
        email: user.email.toLowerCase(),
        status: 'active',
      });
      omsIntermediaryId = newOms._id as Types.ObjectId;
    }
    omsFirstName = user.firstName || null;
    omsLastName = user.lastName || null;
    omsPhone = user.phone || null;
  }

  if (!omsIntermediaryId) {
    return reply.code(401).send({ error: 'Valid OMS API key or logged-in user with OMS account required' });
  }

  if (!config.wmsApiUrl || !config.internalApiKey) {
    return reply.code(503).send({
      error: 'Warehouse connection service not configured',
      message: 'WMS_API_URL and UNIECONNECT_INTERNAL_API_KEY must be set.',
    });
  }

  const url = `${config.wmsApiUrl}/api/v1/internal/oms/connect`;
  const body: Record<string, string> = {
    connectionCode: connectionCode.trim(),
    omsIntermediaryId: String(omsIntermediaryId),
    omsCompanyName: omsCompanyName || `OMS Account`,
  };
  if (omsFirstName) body.omsFirstName = omsFirstName;
  if (omsLastName) body.omsLastName = omsLastName;
  if (omsPhone) body.omsPhone = omsPhone;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': config.internalApiKey,
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
    warehouseCode?: string;
    wmsIntermediaryId?: string;
  };
  if (!res.ok) {
    return reply.code(res.status).send({
      error: data.error || `Connection failed (HTTP ${res.status})`,
      message: data.message,
    });
  }

  const warehouseCode = data.warehouseCode;
  const wmsIntermediaryId = data.wmsIntermediaryId;

  if (warehouseCode && wmsIntermediaryId) {
    const { OmsIntermediaryWarehouse } = await import('../models/oms-intermediary-warehouse');
    const existing = await OmsIntermediaryWarehouse.findOne({
      omsIntermediaryId,
      warehouseCode,
    }).lean().exec();
    if (!existing) {
      await OmsIntermediaryWarehouse.create({
        omsIntermediaryId,
        warehouseCode,
        wmsIntermediaryId: new Types.ObjectId(wmsIntermediaryId),
      });
    }
  }

  return {
    message: data.message || 'Successfully connected to warehouse',
    warehouseCode,
  };
}
