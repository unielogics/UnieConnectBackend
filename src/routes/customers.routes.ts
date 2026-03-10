import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Customer } from '../models/customer';
import { CustomerExternal } from '../models/customer-external';
import { ChannelAccount } from '../models/channel-account';
import { channelDisplayLabel } from '../lib/channel-display';

export async function customerRoutes(fastify: FastifyInstance) {
  fastify.get('/customers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { includeMappings, channel } = (req.query as { includeMappings?: string; channel?: string }) || {};
    let customerIdsForFilter: Types.ObjectId[] | null = null;
    if (channel && ['shopify', 'amazon', 'ebay', 'unmapped'].includes(channel)) {
      const accounts = await ChannelAccount.find({ userId: new Types.ObjectId(userId) }).select('_id channel').lean().exec();
      const accountIds = accounts.filter((a) => a.channel === channel).map((a) => a._id);
      if (channel === 'unmapped') {
        const mappedCustomerIds = await CustomerExternal.distinct('customerId', { channelAccountId: { $in: accounts.map((a) => a._id) } }).exec();
        customerIdsForFilter = mappedCustomerIds;
      } else {
        customerIdsForFilter = accountIds.length > 0
          ? await CustomerExternal.distinct('customerId', { channelAccountId: { $in: accountIds } }).exec()
          : [];
      }
    }
    const match: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (customerIdsForFilter !== null) {
      if (channel === 'unmapped') {
        match._id = { $nin: customerIdsForFilter };
      } else {
        match._id = { $in: customerIdsForFilter };
      }
    }
    const customers = await Customer.find(match).sort({ updatedAt: -1 }).limit(200).lean().exec();
    if (!includeMappings || includeMappings === '1' || includeMappings === 'true') {
      const ids = customers.map((c) => c._id);
      const links = await CustomerExternal.find({ customerId: { $in: ids } })
        .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
        .lean()
        .exec();
      const byCustomer = links.reduce<Record<string, any[]>>((acc, l) => {
        const custId = String((l as any).customerId);
        if (!acc[custId]) acc[custId] = [];
        acc[custId].push(l);
        return acc;
      }, {});
      const channelsByCustomer = Object.fromEntries(
        Object.entries(byCustomer).map(([custId, lst]) => {
          const channels = [...new Set(lst.map((l) => (l as any).channel))];
          const mappings = lst.map((l) => {
            const acc = (l as any).channelAccountId;
            return {
              channel: (l as any).channel,
              channelDisplay: acc ? channelDisplayLabel(acc) : (l as any).channel,
              channelAccountId: (l as any).channelAccountId?._id ?? (l as any).channelAccountId,
            };
          });
          return [custId, { channels, mappings }];
        })
      );
      return customers.map((c) => {
        const custId = String(c._id);
        const { channels = [], mappings = [] } = channelsByCustomer[custId] || {};
        return { ...c, channels, mappings };
      });
    }
    return customers;
  });

  fastify.post('/customers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { email, phone, name, addresses, tags } = req.body || {};
    try {
      const created = await Customer.create({
        userId,
        email: email ? String(email).toLowerCase().trim() : undefined,
        phone: phone ? String(phone).trim() : undefined,
        name,
        addresses,
        tags,
      });
      return created;
    } catch (err: any) {
      req.log.error({ err }, 'failed to create customer');
      return reply.code(400).send({ error: 'Could not create customer', detail: err?.message });
    }
  });

  fastify.get('/customers/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const customer = await Customer.findOne({ _id: id, userId }).lean().exec();
    if (!customer) return reply.code(404).send({ error: 'Not found' });
    const links = await CustomerExternal.find({ customerId: customer._id })
      .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
      .lean()
      .exec();
    const mappings = links.map((l) => {
      const acc = (l as any).channelAccountId;
      return {
        ...l,
        channelDisplay: acc ? channelDisplayLabel(acc) : (l as any).channel,
      };
    });
    const channels = [...new Set(links.map((l) => (l as any).channel))];
    return { ...customer, mappings, channels };
  });

  fastify.patch('/customers/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const { email, phone, name, addresses, tags, archived } = req.body || {};
    const updated = await Customer.findOneAndUpdate(
      { _id: id, userId },
      {
        email: email ? String(email).toLowerCase().trim() : undefined,
        phone: phone ? String(phone).trim() : undefined,
        name,
        addresses,
        tags,
        archived,
      },
      { new: true },
    )
      .lean()
      .exec();
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    return updated;
  });

  fastify.post('/customers/:id/map', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const { channelAccountId, externalId, status, raw } = req.body || {};
    if (!channelAccountId || !externalId) return reply.code(400).send({ error: 'channelAccountId and externalId required' });
    const customer = await Customer.findOne({ _id: id, userId }).exec();
    if (!customer) return reply.code(404).send({ error: 'Customer not found' });
    const channelAccount = await ChannelAccount.findById(channelAccountId).exec();
    if (!channelAccount) return reply.code(400).send({ error: 'Invalid channelAccountId' });

    const mapped = await CustomerExternal.findOneAndUpdate(
      { channelAccountId: channelAccount._id, externalId },
      {
        customerId: customer._id,
        channel: channelAccount.channel,
        raw,
        syncedAt: new Date(),
        status,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return mapped;
  });

  fastify.get('/mappings/customers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const customers = await Customer.find({ userId }).select({ email: 1, phone: 1, name: 1 }).lean().exec();
    const ids = customers.map((c) => c._id);
    const links = await CustomerExternal.find({ customerId: { $in: ids } }).lean().exec();
    return { customers, mappings: links };
  });
}
















