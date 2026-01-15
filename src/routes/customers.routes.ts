import { FastifyInstance } from 'fastify';
import { Customer } from '../models/customer';
import { CustomerExternal } from '../models/customer-external';
import { ChannelAccount } from '../models/channel-account';

export async function customerRoutes(fastify: FastifyInstance) {
  fastify.get('/customers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const customers = await Customer.find({ userId }).sort({ updatedAt: -1 }).limit(200).lean().exec();
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
    const links = await CustomerExternal.find({ customerId: customer._id }).lean().exec();
    return { ...customer, mappings: links };
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


