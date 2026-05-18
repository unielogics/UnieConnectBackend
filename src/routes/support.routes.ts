import { FastifyInstance } from 'fastify';
import { addTicketMessage, createTicket, getTicketDetail, listTickets, updateTicketStatus } from '../services/support.service';

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

export async function supportRoutes(fastify: FastifyInstance) {
  fastify.get('/support/tickets', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return listTickets(userId);
  });

  fastify.post('/support/tickets', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    try {
      return await createTicket(userId, req.body || {});
    } catch (err: any) {
      reply.code(err?.statusCode || 500).send({ error: err?.message || 'Failed to create ticket' });
    }
  });

  fastify.get('/support/tickets/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    try {
      return await getTicketDetail(userId, String(req.params.id));
    } catch (err: any) {
      reply.code(err?.statusCode || 500).send({ error: err?.message || 'Failed to load ticket' });
    }
  });

  fastify.patch('/support/tickets/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const status = String(req.body?.status || '').trim();
    if (!status) {
      reply.code(400).send({ error: 'status is required' });
      return;
    }
    try {
      return await updateTicketStatus(userId, String(req.params.id), status);
    } catch (err: any) {
      reply.code(err?.statusCode || 500).send({ error: err?.message || 'Failed to update ticket' });
    }
  });

  fastify.post('/support/tickets/:id/messages', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    try {
      return await addTicketMessage(userId, String(req.params.id), req.body || {});
    } catch (err: any) {
      reply.code(err?.statusCode || 500).send({ error: err?.message || 'Failed to add ticket response' });
    }
  });
}
