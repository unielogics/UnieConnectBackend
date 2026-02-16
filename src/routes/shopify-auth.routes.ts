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
  const scope =
    'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_inventory,write_inventory,read_fulfillments,write_fulfillments';
  const params = new URLSearchParams({
    client_id: config.shopify.clientId,
    scope,
    redirect_uri: `${config.shopify.appBaseUrl}/api/v1/auth/shopify/callback`,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

/** Verify Shopify HMAC on OAuth callback (req.query must match Shopify's signed params) */
function verifyShopifyHmac(query: Record<string, string | string[] | undefined>, secret: string): boolean {
  const hmac = query.hmac;
  if (!hmac || typeof hmac !== 'string') return false;
  const sorted = Object.keys(query)
    .filter((k) => k !== 'hmac')
    .sort()
    .map((k) => {
      const v = query[k];
      const str = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
      return `${k}=${str}`;
    })
    .join('&');
  const computed = crypto.createHmac('sha256', secret).update(sorted).digest('hex');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(String(hmac), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function shopifyAuthRoutes(fastify: FastifyInstance) {
  fastify.get('/auth/shopify/start', async (request, reply) => {
    const userId = (request as any).user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const q = request.query as any;
    const shop = String(q?.shop || '');
    const tenantId = String(q?.tenantId || '');
    const redirectTo = String(q?.redirectTo || '').trim() || undefined;
    if (!shop || !tenantId) return reply.code(400).send({ error: 'shop and tenantId required' });
    const state = crypto.randomBytes(16).toString('hex');
    await OAuthState.create({
      provider: 'shopify',
      state,
      userId,
      tenantId,
      redirectTo,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = buildInstallUrl(shop, state);
    const wantsJson =
      String(request.headers.accept || '').includes('application/json') ||
      String((request.query as any)?.format || '').toLowerCase() === 'json' ||
      Boolean(request.headers.authorization);
    if (wantsJson) {
      return reply.send({ url });
    }
    return reply.redirect(url);
  });

  fastify.get('/auth/shopify/callback', async (request, reply) => {
    const query = request.query as Record<string, string | string[] | undefined>;
    const shop = String(query.shop || '');
    const code = String(query.code || '');
    const state = String(query.state || '');
    const hmac = query.hmac;

    if (!shop || !code || !state) {
      return reply.redirect(
        `${config.frontendOrigin}/?error=shopify&message=${encodeURIComponent('shop, code, and state required')}`,
      );
    }

    // Verify HMAC (Shopify signs the callback)
    const secret = config.shopify.clientSecret;
    if (secret && hmac && !verifyShopifyHmac(query, secret)) {
      fastify.log.warn({ shop }, 'Shopify callback HMAC validation failed');
      return reply.redirect(
        `${config.frontendOrigin}/?error=shopify&message=${encodeURIComponent('HMAC validation failed')}`,
      );
    }

    const stateDoc = await OAuthState.findOneAndDelete({ provider: 'shopify', state }).exec();
    if (!stateDoc) {
      return reply.redirect(
        `${config.frontendOrigin}/?error=shopify&message=${encodeURIComponent('Invalid or expired state')}`,
      );
    }

    const redirectBase = (stateDoc as any).redirectTo || config.frontendOrigin;
    const successUrl = `${redirectBase.replace(/\/+$/, '')}/?success=shopify&shop=${encodeURIComponent(shop)}`;

    try {
      const token = await exchangeCodeForToken(shop, code);

      const address = `${config.shopify.appBaseUrl}/api/v1/webhooks/shopify`;
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

      return reply.redirect(successUrl);
    } catch (err: any) {
      fastify.log.error({ err, shop }, 'Shopify auth failed');
      return reply.redirect(
        `${config.frontendOrigin}/?error=shopify&message=${encodeURIComponent(err?.message || 'Shopify auth failed')}`,
      );
    }
  });
}

