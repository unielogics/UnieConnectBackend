import { FastifyInstance } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { pushShopifyInventory } from '../services/shopify-inventory';

async function getShopifyAccountForUser(accountId: string, userId: string) {
  return ChannelAccount.findOne({ _id: accountId, userId, channel: 'shopify' }).exec();
}

export async function shopifyRoutes(fastify: FastifyInstance) {
  fastify.post('/shopify/inventory', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, updates } = req.body || {};
    if (!accountId) return reply.code(400).send({ error: 'accountId is required' });
    if (!Array.isArray(updates)) return reply.code(400).send({ error: 'updates must be an array' });

    const account = await getShopifyAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    await pushShopifyInventory(String(account._id), updates, fastify.log);
    return { success: true };
  });
}
