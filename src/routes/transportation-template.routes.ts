import { FastifyInstance } from 'fastify';
import {
  listTransportationTemplates,
  getTransportationTemplate,
  createTransportationTemplate,
  updateTransportationTemplate,
  deleteTransportationTemplate,
} from '../services/transportation-template.service';

export async function transportationTemplateRoutes(fastify: FastifyInstance) {
  fastify.get('/transportation-templates', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { supplierId } = req.query as any;
    const templates = await listTransportationTemplates({
      userId: String(userId),
      supplierId: supplierId || undefined,
    });
    return { templates };
  });

  fastify.get('/transportation-templates/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params as any;
    const template = await getTransportationTemplate({ userId: String(userId), id });
    if (!template) return reply.code(404).send({ error: 'Not found' });
    return template;
  });

  fastify.post('/transportation-templates', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const body = req.body as any;
    if (!body.name || typeof body.unitsPerBox !== 'number' || typeof body.weightPerBox !== 'number') {
      return reply.code(400).send({ error: 'name, unitsPerBox, and weightPerBox are required' });
    }
    try {
      const template = await createTransportationTemplate({
        userId: String(userId),
        name: body.name,
        supplierId: body.supplierId,
        unitsPerBox: body.unitsPerBox,
        weightPerBox: body.weightPerBox,
        weightPerUnit: body.weightPerUnit,
        dimensions: body.dimensions,
      });
      return template;
    } catch (err: any) {
      req.log.error({ err }, 'create transportation template failed');
      return reply.code(400).send({ error: err?.message || 'Failed to create template' });
    }
  });

  fastify.put('/transportation-templates/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params as any;
    const body = req.body as any;
    try {
      const template = await updateTransportationTemplate({
        userId: String(userId),
        id,
        name: body.name,
        supplierId: body.supplierId,
        unitsPerBox: body.unitsPerBox,
        weightPerBox: body.weightPerBox,
        weightPerUnit: body.weightPerUnit,
        dimensions: body.dimensions,
      });
      if (!template) return reply.code(404).send({ error: 'Not found' });
      return template;
    } catch (err: any) {
      req.log.error({ err }, 'update transportation template failed');
      return reply.code(400).send({ error: err?.message || 'Failed to update template' });
    }
  });

  fastify.delete('/transportation-templates/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params as any;
    const deleted = await deleteTransportationTemplate({ userId: String(userId), id });
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });
}
