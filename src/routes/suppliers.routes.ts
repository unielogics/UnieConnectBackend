import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Supplier } from '../models/supplier';
import { ShipFromLocation } from '../models/ship-from-location';
import { Item } from '../models/item';
import { ShipmentPlan } from '../models/shipment-plan';
import { InboundShipment } from '../models/inbound-shipment';

function serializeSupplier(supplier: any) {
  return {
    ...supplier,
    id: String(supplier._id),
    onlineSupplier: Boolean(supplier.onlineSupplier),
  };
}

export async function supplierRoutes(fastify: FastifyInstance) {
  fastify.get('/suppliers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const suppliers = await Supplier.find({ userId }).sort({ updatedAt: -1, createdAt: -1 }).lean().exec();
    return suppliers.map((supplier: any) => serializeSupplier(supplier));
  });

  fastify.post('/suppliers', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { name, onlineSupplier, email, phone, hoursOfOperation, website, notes } = req.body || {};
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const supplier = await Supplier.create({
      userId,
      name: String(name).trim(),
      onlineSupplier: Boolean(onlineSupplier),
      email,
      phone,
      hoursOfOperation,
      website,
      notes,
    });

    return serializeSupplier(supplier.toObject());
  });

  fastify.get('/suppliers/:id/products', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id: supplierId } = req.params || {};
    const supplier = await Supplier.findOne({ _id: supplierId, userId }).lean().exec();
    if (!supplier) return reply.code(404).send({ error: 'Not found' });

    const objId = new Types.ObjectId(supplierId);

    const [directItems, plans, inboundShipments] = await Promise.all([
      Item.find({ userId, supplierId: objId }).sort({ sku: 1 }).lean().exec(),
      ShipmentPlan.find({ userId, supplierId: objId }).select('items updatedAt internalShipmentId').lean().exec(),
      InboundShipment.find({ userId, supplierId: objId }).select('items updatedAt workflowId').lean().exec(),
    ]);

    const direct = directItems.map((item: any) => ({
      id: String(item._id),
      sku: item.sku,
      title: item.title,
      source: 'item' as const,
    }));

    const historicalBySku = new Map<string, { sku: string; title?: string; asin?: string; source: 'plan' | 'inbound'; lastUsedAt: string; planId?: string; workflowId?: string }>();

    for (const plan of plans) {
      const p = plan as any;
      const updatedAt = p.updatedAt ? new Date(p.updatedAt).toISOString() : '';
      for (const it of p.items || []) {
        const sku = (it.sku || it.sellerSku || '').trim();
        if (!sku) continue;
        const existing = historicalBySku.get(sku);
        if (!existing || updatedAt > existing.lastUsedAt) {
          historicalBySku.set(sku, {
            sku,
            title: it.title,
            asin: it.asin,
            source: 'plan',
            lastUsedAt: updatedAt,
            planId: p.internalShipmentId,
          });
        }
      }
    }

    for (const inv of inboundShipments) {
      const i = inv as any;
      const updatedAt = i.updatedAt ? new Date(i.updatedAt).toISOString() : '';
      for (const it of i.items || []) {
        const sku = (it.sellerSku || it.sku || '').trim();
        if (!sku) continue;
        const existing = historicalBySku.get(sku);
        if (!existing || updatedAt > existing.lastUsedAt) {
          historicalBySku.set(sku, {
            sku,
            title: it.title,
            asin: it.asin,
            source: 'inbound',
            lastUsedAt: updatedAt,
            workflowId: i.workflowId,
          });
        }
      }
    }

    const historical = Array.from(historicalBySku.values()).sort(
      (a, b) => (b.lastUsedAt || '').localeCompare(a.lastUsedAt || ''),
    );

    return { direct, historical };
  });

  fastify.get('/suppliers/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params || {};
    const supplier = await Supplier.findOne({ _id: id, userId }).lean().exec();
    if (!supplier) return reply.code(404).send({ error: 'Not found' });

    const locations = await ShipFromLocation.find({ userId, supplierId: supplier._id }).sort({ isDefault: -1, updatedAt: -1 }).lean().exec();
    return {
      ...serializeSupplier(supplier),
      locations: locations.map((location: any) => ({
        ...location,
        id: String(location._id),
      })),
    };
  });

  fastify.patch('/suppliers/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params || {};
    const { name, onlineSupplier, email, phone, hoursOfOperation, website, notes } = req.body || {};

    const updated = await Supplier.findOneAndUpdate(
      { _id: id, userId },
      { name, onlineSupplier, email, phone, hoursOfOperation, website, notes },
      { new: true },
    )
      .lean()
      .exec();

    if (!updated) return reply.code(404).send({ error: 'Not found' });
    return serializeSupplier(updated);
  });

  fastify.delete('/suppliers/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params || {};
    const supplier = await Supplier.findOne({ _id: id, userId }).lean().exec();
    if (!supplier) return reply.code(404).send({ error: 'Not found' });

    await ShipFromLocation.deleteMany({ userId, supplierId: supplier._id }).exec();
    await Supplier.deleteOne({ _id: id, userId }).exec();
    return { success: true };
  });
}
