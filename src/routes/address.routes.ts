import { FastifyInstance } from 'fastify';
import { validateAddressWithGeoapify, suggestAddressesWithGeoapify } from '../services/address-validation.service';

export async function addressRoutes(app: FastifyInstance) {
  app.post('/address/validate', async (req: any, reply) => {
    try {
      const body = req.body as { address?: string };
      const address = (body?.address || '').trim();
      if (!address) {
        return reply.code(400).send({ error: 'address is required' });
      }

      const result = await validateAddressWithGeoapify(address);

      if (!result) {
        return reply.code(200).send({
          found: false,
          warning: 'Address not found via geocoding. Please verify manually.',
        });
      }

      return reply.code(200).send({
        found: true,
        address: {
          formatted: result.formatted,
          street: result.street,
          city: result.city,
          state: result.state,
          stateCode: result.stateCode,
          postalCode: result.postalCode,
          country: result.country,
          latitude: result.latitude,
          longitude: result.longitude,
        },
      });
    } catch (err: any) {
      req.log?.error?.(err);
      return reply.code(500).send({ error: err.message || 'Failed to validate address' });
    }
  });

  app.get('/address/suggest', async (req: any, reply) => {
    try {
      const query = (req.query as any)?.q || '';
      const text = String(query || '').trim();
      if (!text) {
        return reply.code(400).send({ error: 'q is required' });
      }
      const suggestions = await suggestAddressesWithGeoapify(text);
      return reply.code(200).send({
        suggestions: suggestions.map((s) => ({
          formatted: s.formatted,
          street: s.street,
          city: s.city,
          state: s.state,
          stateCode: s.stateCode,
          postalCode: s.postalCode,
          country: s.country,
          latitude: s.latitude,
          longitude: s.longitude,
        })),
      });
    } catch (err: any) {
      req.log?.error?.(err);
      return reply.code(500).send({ error: err.message || 'Failed to suggest addresses' });
    }
  });
}
