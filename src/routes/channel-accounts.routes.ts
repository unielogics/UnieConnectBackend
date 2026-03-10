import { FastifyInstance } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { runRefresh } from '../services/shopify-cron';
import { runAmazonRefresh } from '../services/amazon-cron';
import { getSyncStatus } from '../services/channel-sync-status';

export async function channelAccountRoutes(fastify: FastifyInstance) {
  fastify.get('/channel-accounts', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const accounts = await ChannelAccount.find({ userId }).lean().exec();
    return accounts.map((a: any) => ({
      id: String(a._id),
      channel: a.channel,
      shopDomain: a.shopDomain,
      sellingPartnerId: a.sellingPartnerId,
      marketplaceIds: a.marketplaceIds,
      region: a.region,
      status: a.status,
      flags: a.flags,
      lastCronAt: a.lastCronAt,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
  });

  fastify.delete('/channel-accounts/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const existing = await ChannelAccount.findOne({ _id: id, userId }).lean().exec();
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    // NOTE: This is a hard disconnect (removes the credential record).
    // TODO: consider revoking tokens at the source (Shopify/Amazon/eBay) and/or cascading deletes.
    await ChannelAccount.deleteOne({ _id: id, userId }).exec();
    return { success: true };
  });

  fastify.get('/channel-accounts/:id/sync-status', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const account = await ChannelAccount.findOne({ _id: id, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Not found' });
    if (account.channel !== 'shopify') {
      return reply.code(400).send({ error: 'Sync status only supported for Shopify' });
    }
    const status = await getSyncStatus(String(account._id));
    return status;
  });

  fastify.post('/channel-accounts/:id/refresh', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const account = await ChannelAccount.findOne({ _id: id, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Not found' });
    let syncResult: Record<string, number> | undefined;
    if (account.channel === 'shopify') {
      const res = await runRefresh(String(account._id), fastify.log);
      syncResult = res as Record<string, number>;
    } else if (account.channel === 'amazon') {
      await runAmazonRefresh(String(account._id), fastify.log);
    }
    await ChannelAccount.updateOne({ _id: account._id }, { lastCronAt: new Date() }).exec();
    return { success: true, syncResult };
  });
}

