import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';
import { ChannelAccount } from '../models/channel-account';
import { Customer } from '../models/customer';
import { channelDisplayLabel } from '../lib/channel-display';

export async function orderRoutes(fastify: FastifyInstance) {
  fastify.get('/orders', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { channel } = (req.query as { channel?: string }) || {};
    const match: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (channel && ['shopify', 'amazon', 'ebay'].includes(channel)) {
      const accounts = await ChannelAccount.find({ userId: new Types.ObjectId(userId), channel }).select('_id').lean().exec();
      const accountIds = accounts.map((a) => a._id);
      if (accountIds.length > 0) {
        match.channelAccountId = { $in: accountIds };
      } else {
        match.channelAccountId = { $in: [] };
      }
    }
    const orders = await Order.find(match)
      .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
      .populate('customerId', 'email name')
      .sort({ placedAt: -1, createdAt: -1 })
      .limit(200)
      .lean()
      .exec();
    const enriched = (orders as any[]).map((o) => {
      const acc = o.channelAccountId;
      const channelDisplay = acc ? channelDisplayLabel(acc) : undefined;
      const { channelAccountId, customerId, wmsStatus, wmsTrackingNumber, wmsShippedAt, ...rest } = o;
      const effectiveStatus = wmsStatus ?? rest.status;
      return {
        ...rest,
        status: effectiveStatus,
        trackingNumber: wmsTrackingNumber ?? null,
        shippedAt: wmsShippedAt ?? null,
        channelAccountId: channelAccountId?._id ?? channelAccountId,
        channelDisplay,
        channel: acc?.channel,
        shopDomain: acc?.shopDomain,
        customer: customerId ? { id: customerId._id, email: customerId.email, name: customerId.name } : null,
      };
    });
    return enriched;
  });

  fastify.get('/orders/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const order = await Order.findOne({ _id: id, userId })
      .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
      .populate('customerId', 'email phone name addresses')
      .lean()
      .exec();
    if (!order) return reply.code(404).send({ error: 'Not found' });
    const lines = await OrderLine.find({ orderId: order._id }).populate('itemId', 'title image sku').lean().exec();
    const acc = (order as any).channelAccountId;
    const channelDisplay = acc ? channelDisplayLabel(acc) : undefined;
    const { channelAccountId, customerId, wmsStatus, wmsTrackingNumber, wmsShippedAt, ...rest } = order as any;
    const effectiveStatus = wmsStatus ?? rest.status;
    return {
      ...rest,
      status: effectiveStatus,
      trackingNumber: wmsTrackingNumber ?? null,
      shippedAt: wmsShippedAt ?? null,
      channelAccountId: channelAccountId?._id ?? channelAccountId,
      channelDisplay,
      channel: acc?.channel,
      shopDomain: acc?.shopDomain,
      customer: customerId || null,
      lines,
    };
  });
}
















