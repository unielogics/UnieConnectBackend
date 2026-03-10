import { FastifyInstance } from 'fastify';
import { Facility } from '../models/facility';

export async function facilitiesRoutes(fastify: FastifyInstance) {
  fastify.get('/facilities', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const facilities = await Facility.find({ userId, isActive: true })
      .sort({ name: 1 })
      .lean()
      .exec();

    return facilities.map((f: any) => ({
      id: String(f._id),
      name: f.name,
      code: f.code,
      address: f.address,
      status: f.status,
      isActive: f.isActive,
    }));
  });

  fastify.post('/facilities', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { name, code, address } = req.body || {};
    if (!name || !code || !address?.addressLine1 || !address?.city || !address?.stateOrProvinceCode || !address?.postalCode || !address?.countryCode) {
      return reply.code(400).send({ error: 'name, code, and full address required' });
    }

    const facility = await Facility.create({
      userId,
      name: String(name).trim(),
      code: String(code).trim(),
      address: {
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2,
        addressLine3: address.addressLine3,
        city: address.city,
        stateOrProvinceCode: address.stateOrProvinceCode,
        postalCode: address.postalCode,
        countryCode: address.countryCode,
        districtOrCounty: address.districtOrCounty,
        lat: address.lat,
        long: address.long,
      },
    });

    return {
      id: String(facility._id),
      name: facility.name,
      code: facility.code,
      address: facility.address,
    };
  });
}
