import { FastifyInstance } from 'fastify';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';

export async function orderRoutes(fastify: FastifyInstance) {
  fastify.get('/orders', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const orders = await Order.find({ userId }).sort({ placedAt: -1, createdAt: -1 }).limit(200).lean().exec();
    return orders;
  });

  fastify.get('/orders/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const order = await Order.findOne({ _id: id, userId }).lean().exec();
    if (!order) return reply.code(404).send({ error: 'Not found' });
    const lines = await OrderLine.find({ orderId: order._id }).lean().exec();
    return { ...order, lines };
  });
}
















