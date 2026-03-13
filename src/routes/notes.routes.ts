import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Note } from '../models/note';

export async function notesRoutes(fastify: FastifyInstance) {
  fastify.get('/notes', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { entityType, entityId, limit = 200 } = (req.query as { entityType?: string; entityId?: string; limit?: string }) || {};
    if (!entityType || !entityId) {
      return reply.code(400).send({ error: 'entityType and entityId are required' });
    }
    const notes = await Note.find({
      userId: new Types.ObjectId(userId),
      entityType,
      entityId,
    })
      .sort({ createdAt: -1 })
      .limit(Number(limit) || 200)
      .lean()
      .exec();
    return {
      data: notes.map((n: any) => ({
        id: n._id?.toString(),
        entityType: n.entityType,
        entityId: n.entityId,
        body: n.body,
        createdByName: n.createdByName,
        createdAt: n.createdAt,
      })),
    };
  });

  fastify.post('/notes', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { entityType, entityId, body } = (req.body as { entityType?: string; entityId?: string; body?: string }) || {};
    if (!entityType || !entityId) {
      return reply.code(400).send({ error: 'entityType and entityId are required' });
    }
    if (!body || typeof body !== 'string') {
      return reply.code(400).send({ error: 'body is required' });
    }
    const user = req.user as { userId?: string; email?: string };
    const createdByName = user?.email || 'User';
    const note = await Note.create({
      userId: new Types.ObjectId(userId),
      entityType,
      entityId,
      body: String(body).trim(),
      createdByName: createdByName || undefined,
    });
    return reply.code(201).send({
      data: {
        id: note._id?.toString(),
        entityType: note.entityType,
        entityId: note.entityId,
        body: note.body,
        createdByName: note.createdByName,
        createdAt: note.createdAt,
      },
    });
  });
}
