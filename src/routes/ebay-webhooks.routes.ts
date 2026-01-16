import { FastifyInstance } from 'fastify';
import { handleEbayAccountDeletion } from '../services/ebay-deletion';

export async function ebayWebhookRoutes(fastify: FastifyInstance) {
  fastify.post('/webhooks/ebay/account-deletion', async (req: any, reply) => {
    const notification = req.body?.notification;
    const type = notification?.notificationType;
    const userId = notification?.userId;

    if (type !== 'ACCOUNT_DELETION' || !userId) {
      return reply.code(400).send({ error: 'Invalid payload' });
    }

    try {
      const result = await handleEbayAccountDeletion(String(userId), req.log);
      return reply.code(200).send({ status: 'received', result });
    } catch (err: any) {
      req.log.error({ err }, 'eBay account deletion webhook failed');
      return reply.code(500).send({ error: 'failed' });
    }
  });
}


