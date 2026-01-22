import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { buildEbayAuthUrl, exchangeEbayCodeForToken } from '../services/ebay';
import { User } from '../models/user';
import { ChannelAccount } from '../models/channel-account';
import { runRefresh } from '../services/shopify-cron';
import { OAuthState } from '../models/oauth-state';
import { config } from '../config/env';

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
      String((request.query as any)?.format || '').toLowerCase() === 'json' ||
      Boolean(request.headers.authorization);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'oauth-start-pre',hypothesisId:'H6',location:'src/routes/ebay-auth.routes.ts:25',message:'ebay start config snapshot',data:{clientIdPresent:Boolean(config.ebay.clientId),ruNamePresent:Boolean(config.ebay.ruName),authBaseUrlPresent:Boolean(config.ebay.authBaseUrl),scopeLength:config.ebay.scope.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'oauth-start-pre',hypothesisId:'H3',location:'src/routes/ebay-auth.routes.ts:25',message:'ebay start wantsJson decision',data:{accept:request.headers.accept,format:(request.query as any)?.format,wantsJson,hasAuth:Boolean(userId)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
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






