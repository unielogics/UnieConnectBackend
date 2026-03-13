import { FastifyInstance } from 'fastify';
import { ShipmentPlanInvoiceLine } from '../models/shipment-plan-invoice-line';

/**
 * Invoices routes. Shipment-plan-linked invoice lines for Logistics Billing.
 */
export async function invoicesRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { shipmentPlanId?: string }; Reply: { lines: any[] } | { error: string } }>(
    '/invoices',
    async (req, reply) => {
      const userId = (req as any).user?.userId;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const { shipmentPlanId } = req.query;
      const query: Record<string, any> = { userId };

      if (shipmentPlanId) {
        query.shipmentPlanId = shipmentPlanId;
      }

      const lines = await ShipmentPlanInvoiceLine.find(query)
        .sort({ linkedAt: -1 })
        .limit(100)
        .lean()
        .exec();

      return reply.send({ lines });
    }
  );
}
