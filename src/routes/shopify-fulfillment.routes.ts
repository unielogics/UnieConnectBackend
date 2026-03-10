import { FastifyInstance } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { createShopifyFulfillment } from '../services/shopify-fulfillment';

/**
 * Shopify does not expose a public API to purchase Shopify Shipping labels for
 * custom apps. Label purchase is only available to select partners and
 * storefront flows. These endpoints are placeholders to make the surface area
 * explicit; they currently return 501 so callers fail fast instead of hanging.
 */
export async function shopifyFulfillmentRoutes(fastify: FastifyInstance) {
  fastify.post('/shopify/fulfillment', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, externalOrderId, lineItems, trackingNumber, trackingCompany, trackingUrl, notifyCustomer } = req.body || {};
    if (!accountId) return reply.code(400).send({ error: 'accountId is required' });
    if (!externalOrderId) return reply.code(400).send({ error: 'externalOrderId is required' });

    const account = await ChannelAccount.findOne({ _id: accountId, userId, channel: 'shopify' }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    await createShopifyFulfillment({
      channelAccountId: String(account._id),
      externalOrderId: String(externalOrderId),
      ...(Array.isArray(lineItems) ? { lineItems } : {}),
      ...(trackingNumber != null ? { trackingNumber } : {}),
      ...(trackingCompany != null ? { trackingCompany } : {}),
      ...(trackingUrl != null ? { trackingUrl } : {}),
      ...(notifyCustomer != null ? { notifyCustomer } : {}),
      log: fastify.log,
    });
    return { success: true };
  });

  fastify.post('/shopify/:channelAccountId/labels/quote', async (_req, reply) => {
    return reply.code(501).send({
      error: 'Shopify Shipping label quote is not available via Admin API for this app. Use a supported carrier/label provider.',
    });
  });

  fastify.post('/shopify/:channelAccountId/labels/purchase', async (_req, reply) => {
    return reply.code(501).send({
      error: 'Shopify Shipping label purchase is not available via Admin API for this app. Use a supported carrier/label provider.',
    });
  });
}
















