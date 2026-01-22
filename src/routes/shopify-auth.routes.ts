import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { config } from '../config/env';
import { URLSearchParams } from 'url';
import { exchangeCodeForToken, registerWebhooks } from '../services/shopify';
import { User } from '../models/user';
import { ChannelAccount } from '../models/channel-account';
import { runRefresh } from '../services/shopify-cron';
import { OAuthState } from '../models/oauth-state';

function buildInstallUrl(shop: string, state: string) {
  const params = new URLSearchParams({
    client_id: config.shopify.clientId,
    scope: 'read_orders,write_orders,read_inventory,write_inventory,read_fulfillments,write_fulfillments',
    redirect_uri: `${config.shopify.appBaseUrl}/api/v1/auth/shopify/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

export async function shopifyAuthRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/shopify/start', async (request, reply) => {
    const userId = (request as any).user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const shop = String((request.query as any)?.shop || '');
    const tenantId = String((request.query as any)?.tenantId || '');
    if (!shop || !tenantId) return reply.code(400).send({ error: 'shop and tenantId required' });
    const state = crypto.randomBytes(16).toString('hex');
    await OAuthState.create({
      provider: 'shopify',
      state,
      userId,
      tenantId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = buildInstallUrl(shop, state);
    const wantsJson =
      String(request.headers.accept || '').includes('application/json') ||
      String((request.query as any)?.format || '').toLowerCase() === 'json';
    if (wantsJson) {
      return reply.send({ url });
    }
    return reply.redirect(url);
  });

  fastify.get('/auth/shopify/callback', async (request, reply) => {
    const { shop, code, state } = request.query as any;
    if (!shop || !code || !state) return reply.code(400).send({ error: 'shop, code, and state required' });
    const stateDoc = await OAuthState.findOneAndDelete({ provider: 'shopify', state: String(state) }).exec();
    if (!stateDoc) return reply.code(400).send({ error: 'Invalid or expired state' });

    try {
      const token = await exchangeCodeForToken(shop, code);

      // Register webhooks for this shop using the new token
      const address = `${config.shopify.appBaseUrl}/api/v1/webhooks/shopify`;
      // NOTE: orders/* topics are protected customer data; omitted until PCD access is approved.
      // Use valid fulfillment_orders topics to avoid 422.
      const topics = [
        'fulfillment_orders/fulfillment_request_submitted',
        'fulfillment_orders/fulfillment_request_accepted',
        'fulfillment_orders/fulfillment_request_rejected',
        'fulfillment_orders/cancellation_request_submitted',
        'fulfillment_orders/cancellation_request_accepted',
        'fulfillment_orders/cancellation_request_rejected',
        'fulfillment_orders/moved',
        'fulfillment_orders/hold_released',
        'fulfillment_orders/order_routing_complete',
        'inventory_levels/update',
        'products/update',
      ];
      await registerWebhooks({ shop, accessToken: token, address, topics });

      const userDoc = await User.findById(stateDoc.userId).exec();
      if (userDoc) {
        const account = await ChannelAccount.findOneAndUpdate(
          { userId: userDoc._id, channel: 'shopify', shopDomain: shop },
          {
            accessToken: token,
            status: 'active',
            lastCronAt: new Date(0),
          },
          { upsert: true, new: true },
        ).exec();
        if (account?._id) {
          void runRefresh(String(account._id), fastify.log);
        }
      }

      return reply.send({ success: true, shop });
    } catch (err: any) {
      fastify.log.error({ err, shop }, 'Shopify auth failed');
      return reply.code(500).send({ error: 'Shopify auth failed', detail: err?.message });
    }
  });
}

