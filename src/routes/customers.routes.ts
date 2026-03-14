import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Customer } from '../models/customer';
import { CustomerExternal } from '../models/customer-external';
import { ChannelAccount } from '../models/channel-account';
import { Order } from '../models/order';
import { channelDisplayLabel } from '../lib/channel-display';
import { shipmentStatusForDisplay } from '../lib/shipment-status-display';

export async function customerRoutes(fastify: FastifyInstance) {
  fastify.get('/customers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { includeMappings, channel, search, sortBy = 'updatedAt', sortOrder = 'desc' } = (req.query as {
      includeMappings?: string; channel?: string; search?: string; sortBy?: string; sortOrder?: string;
    }) || {};
    let customerIdsForFilter: Types.ObjectId[] | null = null;
    if (channel && ['shopify', 'amazon', 'ebay', 'unmapped'].includes(channel)) {
      const accounts = await ChannelAccount.find({ userId: new Types.ObjectId(userId) }).select('_id channel').lean().exec();
      const accountIds = accounts.filter((a) => a.channel === channel).map((a) => a._id);
      if (channel === 'unmapped') {
        const mappedCustomerIds = await CustomerExternal.distinct('customerId', { channelAccountId: { $in: accounts.map((a) => a._id) } }).exec();
        customerIdsForFilter = mappedCustomerIds;
      } else {
        customerIdsForFilter = accountIds.length > 0
          ? await CustomerExternal.distinct('customerId', { channelAccountId: { $in: accountIds } }).exec()
          : [];
      }
    }
    const match: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (customerIdsForFilter !== null) {
      if (channel === 'unmapped') {
        match._id = { $nin: customerIdsForFilter };
      } else {
        match._id = { $in: customerIdsForFilter };
      }
    }
    if (search && String(search).trim()) {
      const q = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(q, 'i');
      match.$or = [
        { email: re },
        { phone: re },
        { 'name.first': re },
        { 'name.last': re },
      ];
    }
    const sortField = ['name', 'email', 'updatedAt', 'orderCount', 'lastOrderDate', 'totalItems'].includes(sortBy)
      ? sortBy
      : 'updatedAt';
    const sortDir = sortOrder === 'asc' ? 1 : -1;

    const pipeline: any[] = [
      { $match: match },
      {
        $lookup: {
          from: 'orders',
          let: { custId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$customerId', '$$custId'] }, userId: new Types.ObjectId(userId) } },
            { $project: { placedAt: 1, status: 1, wmsStatus: 1 } },
          ],
          as: '_orders',
        },
      },
      {
        $addFields: {
          orderCount: { $size: '$_orders' },
          lastOrderDate: { $max: '$_orders.placedAt' },
          orderStatuses: {
            $map: {
              input: '$_orders',
              as: 'o',
              in: { $ifNull: ['$$o.wmsStatus', '$$o.status'] },
            },
          },
        },
      },
      {
        $lookup: {
          from: 'orderlines',
          let: { orderIds: '$_orders._id' },
          pipeline: [
            { $match: { $expr: { $in: ['$orderId', '$$orderIds'] } } },
            { $group: { _id: null, total: { $sum: '$quantity' } } },
          ],
          as: '_itemsAgg',
        },
      },
      {
        $addFields: {
          totalItems: { $ifNull: [{ $arrayElemAt: ['$_itemsAgg.total', 0] }, 0] },
        },
      },
      { $project: { _orders: 0, _itemsAgg: 0 } },
      { $sort: sortField === 'name' ? { 'name.first': sortDir, 'name.last': sortDir } : { [sortField]: sortDir } },
      { $limit: 200 },
    ];

    const customers = await Customer.aggregate(pipeline).exec();

    if (!includeMappings || includeMappings === '1' || includeMappings === 'true') {
      const ids = customers.map((c) => c._id);
      const links = await CustomerExternal.find({ customerId: { $in: ids } })
        .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
        .lean()
        .exec();
      const byCustomer = links.reduce<Record<string, any[]>>((acc, l) => {
        const custId = String((l as any).customerId);
        if (!acc[custId]) acc[custId] = [];
        acc[custId].push(l);
        return acc;
      }, {});
      const channelsByCustomer = Object.fromEntries(
        Object.entries(byCustomer).map(([custId, lst]) => {
          // Dedupe by channelAccountId so we show one "Shopify (store.myshopify.com)" per store, not per external ID
          const byAccount = new Map<string, { channel: string; channelDisplay: string; channelAccountId: any }>();
          for (const l of lst) {
            const acc = (l as any).channelAccountId;
            const accountId = (acc?._id ?? (l as any).channelAccountId)?.toString?.() ?? String((l as any).channelAccountId);
            if (!byAccount.has(accountId)) {
              byAccount.set(accountId, {
                channel: (l as any).channel,
                channelDisplay: acc ? channelDisplayLabel(acc) : (l as any).channel,
                channelAccountId: acc?._id ?? (l as any).channelAccountId,
              });
            }
          }
          const mappings = Array.from(byAccount.values());
          const channels = [...new Set(mappings.map((m) => m.channel))];
          return [custId, { channels, mappings }];
        })
      );
      return customers.map((c) => {
        const custId = String(c._id);
        const { channels = [], mappings = [] } = channelsByCustomer[custId] || {};
        const orderStatuses = Array.isArray(c.orderStatuses) ? c.orderStatuses.map((s: string) => shipmentStatusForDisplay(s)) : [];
        return { ...c, channels, mappings, orderStatuses };
      });
    }
    return customers;
  });

  fastify.post('/customers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { email, phone, name, addresses, tags } = req.body || {};
    try {
      const created = await Customer.create({
        userId,
        email: email ? String(email).toLowerCase().trim() : undefined,
        phone: phone ? String(phone).trim() : undefined,
        name,
        addresses,
        tags,
      });
      return created;
    } catch (err: any) {
      req.log.error({ err }, 'failed to create customer');
      return reply.code(400).send({ error: 'Could not create customer', detail: err?.message });
    }
  });

  fastify.get('/customers/:id/orders', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const customer = await Customer.findOne({ _id: id, userId }).lean().exec();
    if (!customer) return reply.code(404).send({ error: 'Customer not found' });
    const orders = await Order.find({ userId: new Types.ObjectId(userId), customerId: new Types.ObjectId(id) })
      .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
      .sort({ placedAt: -1, createdAt: -1 })
      .limit(50)
      .lean()
      .exec();
    const channelDisplayLabelFn = channelDisplayLabel;
    const enriched = (orders as any[]).map((o) => {
      const acc = o.channelAccountId;
      const channelDisplay = acc ? channelDisplayLabelFn(acc) : undefined;
      const effectiveStatus = o.wmsStatus ?? o.status;
      return {
        _id: o._id,
        externalOrderId: o.externalOrderId,
        status: shipmentStatusForDisplay(effectiveStatus),
        channel: acc?.channel,
        channelDisplay,
        placedAt: o.placedAt,
        totals: o.totals,
        currency: o.currency,
      };
    });
    const totalValue = enriched.reduce((sum, o) => sum + (o.totals?.total ?? 0), 0);
    const ordersByStatus = enriched.reduce<Record<string, number>>((acc, o) => {
      const s = (o.status || 'unknown').toLowerCase();
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    return {
      orders: enriched,
      summary: {
        totalOrders: enriched.length,
        totalValue,
        ordersByStatus: Object.entries(ordersByStatus).map(([_id, count]) => ({ _id, count })),
      },
    };
  });

  fastify.get('/customers/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const customer = await Customer.findOne({ _id: id, userId }).lean().exec();
    if (!customer) return reply.code(404).send({ error: 'Not found' });
    const links = await CustomerExternal.find({ customerId: customer._id })
      .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
      .lean()
      .exec();
    // Dedupe by channelAccountId: one "Shopify (store.myshopify.com)" per store
    const byAccount = new Map<string, { channel: string; channelDisplay: string; channelAccountId: any }>();
    for (const l of links) {
      const acc = (l as any).channelAccountId;
      const accountId = (acc?._id ?? (l as any).channelAccountId)?.toString?.() ?? String((l as any).channelAccountId);
      if (!byAccount.has(accountId)) {
        byAccount.set(accountId, {
          channel: (l as any).channel,
          channelDisplay: acc ? channelDisplayLabel(acc) : (l as any).channel,
          channelAccountId: acc?._id ?? (l as any).channelAccountId,
        });
      }
    }
    const mappings = Array.from(byAccount.values());
    const channels = [...new Set(mappings.map((m) => m.channel))];
    return { ...customer, mappings, channels };
  });

  fastify.patch('/customers/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const { email, phone, name, addresses, tags, archived } = req.body || {};
    const updated = await Customer.findOneAndUpdate(
      { _id: id, userId },
      {
        email: email ? String(email).toLowerCase().trim() : undefined,
        phone: phone ? String(phone).trim() : undefined,
        name,
        addresses,
        tags,
        archived,
      },
      { new: true },
    )
      .lean()
      .exec();
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    return updated;
  });

  fastify.post('/customers/:id/map', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const { channelAccountId, externalId, status, raw } = req.body || {};
    if (!channelAccountId || !externalId) return reply.code(400).send({ error: 'channelAccountId and externalId required' });
    const customer = await Customer.findOne({ _id: id, userId }).exec();
    if (!customer) return reply.code(404).send({ error: 'Customer not found' });
    const channelAccount = await ChannelAccount.findById(channelAccountId).exec();
    if (!channelAccount) return reply.code(400).send({ error: 'Invalid channelAccountId' });

    const mapped = await CustomerExternal.findOneAndUpdate(
      { channelAccountId: channelAccount._id, externalId },
      {
        customerId: customer._id,
        channel: channelAccount.channel,
        raw,
        syncedAt: new Date(),
        status,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    return mapped;
  });

  fastify.get('/mappings/customers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const customers = await Customer.find({ userId }).select({ email: 1, phone: 1, name: 1 }).lean().exec();
    const ids = customers.map((c) => c._id);
    const links = await CustomerExternal.find({ customerId: { $in: ids } }).lean().exec();
    return { customers, mappings: links };
  });
}
















