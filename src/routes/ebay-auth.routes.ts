import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { buildEbayAuthUrl, exchangeEbayCodeForToken } from '../services/ebay';
import { User } from '../models/user';
import { ChannelAccount } from '../models/channel-account';
import { runRefresh } from '../services/shopify-cron';

// In-memory state store; replace with persistent nonce table if needed.
const states = new Map<string, { tenantId?: string; sellerId?: string | undefined; createdAt: number }>();

export async function ebayAuthRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/ebay/start', async (request, reply) => {
    const tenantId = String((request.query as any)?.tenantId || '');
    const sellerId = (request.query as any)?.sellerId ? String((request.query as any).sellerId) : undefined;
    const state = crypto.randomBytes(16).toString('hex');
    states.set(state, { tenantId, sellerId, createdAt: Date.now() });
    const url = buildEbayAuthUrl(state);
    return reply.redirect(url);
  });

  fastify.get('/auth/ebay/callback', async (request, reply) => {
    const { code, state } = request.query as any;
    if (!code) return reply.code(400).send({ error: 'code required' });
    const stateEntry = state ? states.get(state) : undefined;
    if (!state || !stateEntry) {
      fastify.log.warn({ state }, 'eBay auth callback with missing/expired state');
    }

    const userId = (request as any).user?.userId;
    if (!userId) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const userDoc = await User.findById(userId).exec();
    if (!userDoc) return reply.code(404).send({ error: 'User not found' });

    try {
      const token = await exchangeEbayCodeForToken(code);

      const account = await ChannelAccount.findOneAndUpdate(
        { userId: userDoc._id, channel: 'ebay' },
        {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          status: 'active',
          lastCronAt: new Date(0),
          ...(stateEntry?.sellerId ? { externalSellerId: stateEntry.sellerId } : {}),
        },
        { upsert: true, new: true },
      ).exec();

      if (account?._id) {
        void runRefresh(String(account._id), fastify.log);
      }

      return reply.send({ success: true, channel: 'ebay', accountId: account?._id, expiresAt: token.expiresAt });
    } catch (err: any) {
      fastify.log.error({ err }, 'eBay auth failed');
      return reply.code(500).send({ error: 'eBay auth failed', detail: err?.message });
    }
  });
}






