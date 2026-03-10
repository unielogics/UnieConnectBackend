import { FastifyReply } from 'fastify';
import crypto from 'crypto';
import { Types } from 'mongoose';
import { OmsIntermediary } from '../models/oms-intermediary';
import { ApiKey } from '../models/api-key';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';
import { Facility } from '../models/facility';
import { hashApiKey } from '../lib/api-key-auth';

function generateApiKey(): string {
  const randomBytes = crypto.randomBytes(32);
  return `uc_${randomBytes.toString('hex')}`;
}

async function nextOmsIntermediaryNumber(): Promise<string> {
  const count = await OmsIntermediary.countDocuments().exec();
  return `OMS-${String(count + 1).padStart(4, '0')}`;
}

/**
 * Create OMS account (management/super_admin)
 */
export async function createOmsAccount(req: any, reply: FastifyReply) {
  const { companyName, email } = req.body || {};
  if (!companyName?.trim() || !email?.trim()) {
    return reply.code(400).send({ error: 'companyName and email required' });
  }
  const normalizedEmail = String(email).toLowerCase().trim();
  const existing = await OmsIntermediary.findOne({ email: normalizedEmail }).lean().exec();
  if (existing) {
    return reply.code(409).send({ error: 'OMS account with this email already exists' });
  }
  const omsIntermediaryNumber = await nextOmsIntermediaryNumber();
  const account = await OmsIntermediary.create({
    companyName: String(companyName).trim(),
    email: normalizedEmail,
    status: 'active',
  });
  return {
    id: String(account._id),
    omsIntermediaryNumber,
    companyName: account.companyName,
    email: account.email,
    status: account.status,
    createdAt: (account as any).createdAt,
  };
}

/**
 * List OMS accounts (management/super_admin)
 */
export async function listOmsAccounts(req: any, reply: FastifyReply) {
  const accounts = await OmsIntermediary.find().sort({ createdAt: -1 }).lean().exec();
  return {
    accounts: accounts.map((a) => ({
      id: String(a._id),
      companyName: a.companyName,
      email: a.email,
      status: a.status,
      createdAt: (a as any).createdAt,
    })),
  };
}

/**
 * Get OMS account by ID (management/super_admin)
 */
export async function getOmsAccount(req: any, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const account = await OmsIntermediary.findById(id).lean().exec();
  if (!account) return reply.code(404).send({ error: 'OMS account not found' });
  const links = await OmsIntermediaryWarehouse.find({ omsIntermediaryId: new Types.ObjectId(id) })
    .lean()
    .exec();
  return {
    ...account,
    id: String(account._id),
    linkedWarehouses: links.map((l) => ({ warehouseCode: l.warehouseCode })),
  };
}

/**
 * Create API key for OMS account (management/super_admin)
 */
export async function createOmsApiKey(req: any, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const { name } = req.body || {};
  const omsIntermediaryId = new Types.ObjectId(id);
  const account = await OmsIntermediary.findById(omsIntermediaryId).lean().exec();
  if (!account) return reply.code(404).send({ error: 'OMS account not found' });
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  await ApiKey.create({
    keyHash,
    type: 'oms',
    omsIntermediaryId,
    name: name ? String(name).trim() : 'OMS API Key',
  });
  return {
    apiKey: rawKey,
    warning: 'Save this API key now. You will not be able to see it again.',
  };
}

/**
 * Link OMS account to warehouse (management path - no code)
 */
export async function linkOmsToWarehouse(req: any, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const { facilityId } = req.body || {};
  if (!facilityId) return reply.code(400).send({ error: 'facilityId required' });
  const facility = await Facility.findById(facilityId).lean().exec();
  if (!facility) return reply.code(404).send({ error: 'Facility not found' });
  const omsIntermediaryId = new Types.ObjectId(id);
  const account = await OmsIntermediary.findById(omsIntermediaryId).lean().exec();
  if (!account) return reply.code(404).send({ error: 'OMS account not found' });
  const existing = await OmsIntermediaryWarehouse.findOne({
    omsIntermediaryId,
    warehouseCode: facility.code,
  })
    .lean()
    .exec();
  if (existing) {
    return reply.code(409).send({ error: 'OMS account already linked to this warehouse' });
  }
  await OmsIntermediaryWarehouse.create({
    omsIntermediaryId,
    warehouseCode: facility.code,
    wmsIntermediaryId: facility.userId,
  });
  return {
    message: 'OMS account linked to warehouse',
    warehouseCode: facility.code,
  };
}

/**
 * List all facilities for OMS linking (management/super_admin)
 */
export async function listFacilitiesForOms(req: any, reply: FastifyReply) {
  const facilities = await Facility.find({ isActive: true })
    .select('name code userId address')
    .sort({ name: 1 })
    .lean()
    .exec();
  return {
    facilities: facilities.map((f) => ({
      id: String(f._id),
      name: f.name,
      code: f.code,
      userId: String(f.userId),
    })),
  };
}
