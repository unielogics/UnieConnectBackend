import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { ChannelAccount } from '../models/channel-account';
import { ChannelSyncStatus } from '../models/channel-sync-status';
import { Order } from '../models/order';
import { Item } from '../models/item';
import { Customer } from '../models/customer';
import { runRefresh } from '../services/shopify-cron';
import { runAmazonRefresh } from '../services/amazon-cron';
import { getSyncStatus } from '../services/channel-sync-status';
import { config } from '../config/env';

export async function channelAccountRoutes(fastify: FastifyInstance) {
  fastify.get('/channel-accounts', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const userIdObj = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const accounts = await ChannelAccount.find({ userId: userIdObj }).lean().exec();
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
    const userIdObj = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const existing = await ChannelAccount.findOne({ _id: id, userId: userIdObj }).lean().exec();
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    // NOTE: This is a hard disconnect (removes the credential record).
    // TODO: consider revoking tokens at the source (Shopify/Amazon/eBay) and/or cascading deletes.
    await ChannelAccount.deleteOne({ _id: id, userId }).exec();
    return { success: true };
  });

  fastify.get('/channel-accounts/:id/debug', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const userIdObj = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const account = await ChannelAccount.findOne({ _id: id, userId: userIdObj }).lean().exec();
    if (!account) return reply.code(404).send({ error: 'Not found' });
    if (account.channel !== 'shopify') {
      return reply.code(400).send({ error: 'Debug only for Shopify' });
    }
    const accountIdObj = new Types.ObjectId(id);
    const [orderCountByUser, orderCountByAccount, itemCount, customerCount, syncStatus] = await Promise.all([
      Order.countDocuments({ userId: userIdObj }),
      Order.countDocuments({ channelAccountId: accountIdObj }),
      Item.countDocuments({ userId: userIdObj }),
      Customer.countDocuments({ userId: userIdObj }),
      getSyncStatus(String(account._id)),
    ]);
    const webhookAddress = config.shopify.appBaseUrl
      ? `${config.shopify.appBaseUrl.replace(/\/+$/, '')}/api/v1/webhooks/shopify`
      : null;
    return {
      userIdType: typeof userId,
      accountId: id,
      shopDomain: account.shopDomain,
      orderCountByUserId: orderCountByUser,
      orderCountByChannelAccountId: orderCountByAccount,
      itemCount,
      customerCount,
      syncStatus,
      shopifyConfig: {
        appBaseUrl: config.shopify.appBaseUrl || '(not set)',
        webhookAddress,
        apiVersion: config.shopify.apiVersion,
        hasWebhookSecret: !!config.shopify.webhookSecret,
        redirectUri: `${config.shopify.appBaseUrl || ''}/api/v1/auth/shopify/callback`,
      },
    };
  });

  fastify.get('/channel-accounts/:id/sync-status', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const userIdObj = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const account = await ChannelAccount.findOne({ _id: id, userId: userIdObj }).exec();
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
    const userIdObj = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const account = await ChannelAccount.findOne({ _id: id, userId: userIdObj }).exec();
    if (!account) return reply.code(404).send({ error: 'Not found' });
    let syncResult: Record<string, number> | undefined;
    if (account.channel === 'shopify') {
      const hadOrdersSync = await ChannelSyncStatus.findOne({
        channelAccountId: new Types.ObjectId(account._id),
        entityType: 'orders',
        lastSyncedAt: { $exists: true, $ne: null },
      }).exec();
      const res = await runRefresh(String(account._id), fastify.log, {
        initialSync: !hadOrdersSync,
      });
      syncResult = res as Record<string, number>;
    } else if (account.channel === 'amazon') {
      await runAmazonRefresh(String(account._id), fastify.log);
    }
    await ChannelAccount.updateOne({ _id: account._id }, { lastCronAt: new Date() }).exec();
    return { success: true, syncResult };
  });
}

