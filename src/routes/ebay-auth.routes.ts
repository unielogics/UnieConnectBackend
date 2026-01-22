import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { buildEbayAuthUrl, exchangeEbayCodeForToken } from '../services/ebay';
import { User } from '../models/user';
import { ChannelAccount } from '../models/channel-account';
import { runRefresh } from '../services/shopify-cron';
import { OAuthState } from '../models/oauth-state';

export async function ebayAuthRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/ebay/start', async (request, reply) => {
    const userId = (request as any).user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const tenantId = String((request.query as any)?.tenantId || '');
    const sellerId = (request.query as any)?.sellerId ? String((request.query as any).sellerId) : undefined;
    const state = crypto.randomBytes(16).toString('hex');
    await OAuthState.create({
      provider: 'ebay',
      state,
      userId,
      tenantId,
      sellerId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = buildEbayAuthUrl(state);
    const wantsJson =
      String(request.headers.accept || '').includes('application/json') ||
      String((request.query as any)?.format || '').toLowerCase() === 'json';
    if (wantsJson) {
      return reply.send({ url });
    }
    return reply.redirect(url);
  });

  fastify.get('/auth/ebay/callback', async (request, reply) => {
    const { code, state } = request.query as any;
    if (!code || !state) return reply.code(400).send({ error: 'code and state required' });
    const stateEntry = await OAuthState.findOneAndDelete({ provider: 'ebay', state: String(state) }).exec();
    if (!stateEntry) {
      fastify.log.warn({ state }, 'eBay auth callback with missing/expired state');
      return reply.code(400).send({ error: 'Invalid or expired state' });
    }

    const userDoc = await User.findById(stateEntry.userId).exec();
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






