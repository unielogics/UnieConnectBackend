import { FastifyInstance } from 'fastify';
import { listInboxMessages, markInboxMessageRead } from '../services/inbox.service';

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

export async function inboxRoutes(fastify: FastifyInstance) {
  fastify.get('/inbox', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const q = req.query || {};
    const opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {
      unreadOnly: q.unreadOnly === 'true',
    };
    if (Number(q.limit)) opts.limit = Number(q.limit);
    if (Number(q.offset)) opts.offset = Number(q.offset);
    return listInboxMessages(userId, opts);
  });

  fastify.patch('/inbox/:id/read', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    try {
      return await markInboxMessageRead(userId, String(req.params.id));
    } catch (err: any) {
      reply.code(err?.statusCode || 500).send({ error: err?.message || 'Failed to mark message read' });
    }
  });
}
