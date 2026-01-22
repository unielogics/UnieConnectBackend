import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { config } from '../config/env';
import { ChannelAccount } from '../models/channel-account';
import { upsertInventory, upsertOrder, upsertProduct } from '../services/shopify-upsert';

type ShopifyWebhookHeaders = {
  'x-shopify-hmac-sha256'?: string;
  'x-shopify-topic'?: string;
  'x-shopify-shop-domain'?: string;
};

export async function shopifyWebhookRoutes(fastify: FastifyInstance) {
  // raw body parser scoped to this route
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      try {
        const raw = String(body || '');
        (request as any).rawBody = raw;
        const parsed = raw ? JSON.parse(raw) : {};
        done(null, parsed);
      } catch (err: any) {
        done(err);
      }
    },
  );

  fastify.post('/webhooks/shopify', async (request: FastifyRequest, reply) => {
    const headers = request.headers as ShopifyWebhookHeaders;
    const receivedHmac = headers['x-shopify-hmac-sha256'] || '';
    const topic = headers['x-shopify-topic'] || 'unknown';
    const shopDomain = headers['x-shopify-shop-domain'] || 'unknown';

    const secret = config.shopify.webhookSecret;
    if (!secret) return reply.code(500).send({ error: 'SHOPIFY_WEBHOOK_SECRET not set' });

    const rawBody = (request as any).rawBody || JSON.stringify(request.body || {});
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    const valid =
      receivedHmac &&
      Buffer.byteLength(receivedHmac) === Buffer.byteLength(digest) &&
      crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(receivedHmac));

    if (!valid) {
      fastify.log.warn({ topic, shopDomain }, 'Invalid Shopify webhook signature');
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    const account = await ChannelAccount.findOne({ shopDomain }).exec();
    if (!account) {
      fastify.log.warn({ topic, shopDomain }, 'Shopify webhook skipped: account not found');
      return reply.code(200).send({ success: true, skipped: true });
    }

    try {
      await handleWebhook({
        topic,
        shopDomain,
        body: request.body as any,
        accountId: account._id.toString(),
        userId: account.userId.toString(),
        log: fastify.log,
      });
    } catch (err: any) {
      fastify.log.error({ err, topic, shopDomain }, 'Shopify webhook handling failed');
      return reply.code(500).send({ error: 'processing failed' });
    }

    return reply.code(200).send({ success: true });
  });
}

async function handleWebhook(params: {
  topic: string;
  shopDomain: string;
  body: any;
  accountId: string;
  userId: string;
  log: FastifyInstance['log'];
}) {
  const { topic, body, accountId, userId, log } = params;
  switch (topic) {
    case 'products/create':
    case 'products/update':
      await upsertProduct(body, { channelAccountId: accountId, userId, log });
      break;
    case 'inventory_levels/update':
      await upsertInventory(body, { channelAccountId: accountId, userId, log });
      break;
    case 'orders/create':
    case 'orders/updated':
      await upsertOrder(body, { channelAccountId: accountId, userId, log });
      break;
    default:
      log.info({ topic }, 'Shopify webhook ignored (topic not handled)');
  }
}
