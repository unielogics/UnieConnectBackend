import { FastifyInstance } from 'fastify';
import { ShipFromLocation } from '../models/ship-from-location';
import { Supplier } from '../models/supplier';

async function enrichLocations(userId: string, locations: any[]) {
  const supplierIds = Array.from(new Set(locations.map((location) => String(location.supplierId)).filter(Boolean)));
  const suppliers = await Supplier.find({ _id: { $in: supplierIds }, userId }).lean().exec();
  const supplierById = new Map(suppliers.map((supplier: any) => [String(supplier._id), supplier]));
  return locations.map((location: any) => ({
    ...location,
    id: String(location._id),
    supplierId: String(location.supplierId),
    supplier: supplierById.get(String(location.supplierId))
      ? {
          id: String(supplierById.get(String(location.supplierId))._id),
          name: supplierById.get(String(location.supplierId)).name,
          onlineSupplier: Boolean(supplierById.get(String(location.supplierId)).onlineSupplier),
          email: supplierById.get(String(location.supplierId)).email,
          phone: supplierById.get(String(location.supplierId)).phone,
          hoursOfOperation: supplierById.get(String(location.supplierId)).hoursOfOperation,
          website: supplierById.get(String(location.supplierId)).website,
        }
      : undefined,
  }));
}

export async function shipFromLocationRoutes(fastify: FastifyInstance) {
  fastify.get('/ship-from-locations', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { supplierId } = req.query as any;
    const query: Record<string, unknown> = { userId };
    if (supplierId) query.supplierId = supplierId;

    const locations = await ShipFromLocation.find(query).sort({ isDefault: -1, updatedAt: -1, createdAt: -1 }).lean().exec();
    return enrichLocations(String(userId), locations);
  });

  fastify.post('/ship-from-locations', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { supplierId, label, contactName, email, phone, hoursOfOperation, website, address, isDefault } = req.body || {};
    if (!supplierId || !label || !address?.addressLine1 || !address?.city || !address?.stateOrProvinceCode || !address?.postalCode || !address?.countryCode) {
      return reply.code(400).send({ error: 'supplierId, label, and a full address are required' });
    }

    const supplier = await Supplier.findOne({ _id: supplierId, userId }).lean().exec();
    if (!supplier) return reply.code(400).send({ error: 'Invalid supplierId' });

    if (isDefault) {
      await ShipFromLocation.updateMany({ userId, supplierId }, { isDefault: false }).exec();
    }

    const created = await ShipFromLocation.create({
      userId,
      supplierId,
      label,
      contactName,
      email,
      phone,
      hoursOfOperation,
      website,
      address,
      isDefault: Boolean(isDefault),
    });

    const [enriched] = await enrichLocations(String(userId), [created.toObject()]);
    return enriched;
  });

  fastify.get('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};

    const location = await ShipFromLocation.findOne({ _id: id, userId }).lean().exec();
    if (!location) return reply.code(404).send({ error: 'Not found' });

    const [enriched] = await enrichLocations(String(userId), [location]);
    return enriched;
  });

  fastify.patch('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const { supplierId, label, contactName, email, phone, hoursOfOperation, website, address, isDefault } = req.body || {};

    const existing = await ShipFromLocation.findOne({ _id: id, userId }).lean().exec();
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    const nextSupplierId = supplierId || String(existing.supplierId);
    const supplier = await Supplier.findOne({ _id: nextSupplierId, userId }).lean().exec();
    if (!supplier) return reply.code(400).send({ error: 'Invalid supplierId' });

    if (isDefault) {
      await ShipFromLocation.updateMany({ userId, supplierId: nextSupplierId }, { isDefault: false }).exec();
    }

    const updated = await ShipFromLocation.findOneAndUpdate(
      { _id: id, userId },
      {
        supplierId: nextSupplierId,
        label,
        contactName,
        email,
        phone,
        hoursOfOperation,
        website,
        address,
        isDefault,
      },
      { new: true },
    )
      .lean()
      .exec();

    if (!updated) return reply.code(404).send({ error: 'Not found' });
    const [enriched] = await enrichLocations(String(userId), [updated]);
    return enriched;
  });

  fastify.delete('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};

    const existing = await ShipFromLocation.findOne({ _id: id, userId }).lean().exec();
    if (!existing) return reply.code(404).send({ error: 'Not found' });

    await ShipFromLocation.deleteOne({ _id: id, userId }).exec();
    return { success: true };
  });
}
