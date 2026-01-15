import { FastifyInstance } from 'fastify';

/**
 * Shopify does not expose a public API to purchase Shopify Shipping labels for
 * custom apps. Label purchase is only available to select partners and
 * storefront flows. These endpoints are placeholders to make the surface area
 * explicit; they currently return 501 so callers fail fast instead of hanging.
 */
export async function shopifyFulfillmentRoutes(fastify: FastifyInstance) {
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


