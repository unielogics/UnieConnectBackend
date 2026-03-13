import { FastifyInstance } from 'fastify';
import { ShipmentActivityLog } from '../models/shipment-activity-log';
import {
  createShipmentPlan,
  updateShipmentPlan,
  cancelShipmentPlan,
  submitShipmentPlan,
  createASNForShipmentPlan,
  listShipmentPlans,
  getShipmentPlan,
  getClosestFacilityForPlan,
  getClosestFacilityByShipFromLocation,
  computeEstimatedCost,
  rateShopToWarehouse,
} from '../services/shipment-plan-service';
import { estimateServiceFees } from '../services/estimate-service-fees.service';

export async function shipmentPlanRoutes(fastify: FastifyInstance) {
  // Shipment activity (must be before :id to avoid matching "activity" as id)
  fastify.get('/shipment-plans/activity', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { limit = 50, offset = 0, shipmentPlanId, action, from, to } = req.query as any;
    const query: Record<string, unknown> = { userId };
    if (shipmentPlanId) query.shipmentPlanId = shipmentPlanId;
    if (action) query.action = action;
    if (from || to) {
      query.createdAt = {};
      if (from) (query.createdAt as any).$gte = new Date(from);
      if (to) (query.createdAt as any).$lte = new Date(to);
    }

    const total = await ShipmentActivityLog.countDocuments(query);
    const events = await ShipmentActivityLog.find(query)
      .sort({ createdAt: -1 })
      .skip(Math.max(0, Number(offset)))
      .limit(Math.min(100, Number(limit) || 50))
      .lean()
      .exec();

    return { events, total };
  });

  // Estimate service fees (pre-plan, dynamic) - must be before :id
  fastify.post('/shipment-plans/estimate-service-fees', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = req.body || {};
    const shipFromLocationId = body.shipFromLocationId;
    if (!shipFromLocationId) return reply.code(400).send({ error: 'shipFromLocationId required' });

    const items = Array.isArray(body.items) ? body.items : [];
    const prepServicesOnly = Boolean(body.prepServicesOnly);
    const marketplaceType = body.marketplaceType === 'FBW' ? 'FBW' : 'FBA';

    try {
      const params: Parameters<typeof estimateServiceFees>[0] = {
        userId: String(userId),
        shipFromLocationId,
        items,
        prepServicesOnly,
        log: req.log,
      };
      if (prepServicesOnly) params.marketplaceType = marketplaceType;
      const result = await estimateServiceFees(params);
      return result;
    } catch (err: any) {
      req.log?.warn?.({ err }, 'estimate service fees failed');
      return reply.code(400).send({ error: err?.message || 'Failed to estimate fees' });
    }
  });

  // Closest facility preview (before plan exists) - must be before :id
  fastify.get('/shipment-plans/closest-facility-preview', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { shipFromLocationId } = req.query as any;
    if (!shipFromLocationId) return reply.code(400).send({ error: 'shipFromLocationId required' });

    try {
      const closest = await getClosestFacilityByShipFromLocation({
        userId: String(userId),
        shipFromLocationId,
        log: req.log,
      });
      return closest ?? { facilityId: null, facility: null, distanceMiles: null, shipFromAddress: undefined };
    } catch (err: any) {
      req.log?.warn({ err }, 'closest facility preview failed');
      return reply.code(400).send({ error: err?.message || 'Failed to get closest facility' });
    }
  });

  // List shipment plans (with pagination and filtering)
  fastify.get('/shipment-plans', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { limit, offset, status } = req.query as any;
    const result = await listShipmentPlans({
      userId: String(userId),
      limit: limit != null ? Math.min(Number(limit), 100) : 50,
      offset: offset != null ? Math.max(0, Number(offset)) : 0,
      status,
    });
    return result;
  });

  // Create shipment plan
  fastify.post('/shipment-plans', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const body = req.body || {};
    const createPayload: Parameters<typeof createShipmentPlan>[0] = {
      userId: String(userId),
      supplierId: body.supplierId,
      shipFromLocationId: body.shipFromLocationId,
      prepServicesOnly: Boolean(body.prepServicesOnly),
      marketplaceId: body.marketplaceId,
      marketplaceType: body.marketplaceType,
      items: Array.isArray(body.items) ? body.items : [],
    };
    if (body.orderNo) createPayload.orderNo = body.orderNo;
    if (body.receiptNo) createPayload.receiptNo = body.receiptNo;
    if (body.orderDate) createPayload.orderDate = new Date(body.orderDate);
    if (body.estimatedArrivalDate) createPayload.estimatedArrivalDate = new Date(body.estimatedArrivalDate);
    if (body.shipmentTitle) createPayload.shipmentTitle = body.shipmentTitle;
    if (req.log) createPayload.log = req.log;
    try {
      const plan = await createShipmentPlan(createPayload);
      return plan;
    } catch (err: any) {
      req.log.error({ err }, 'create shipment plan failed');
      return reply.code(400).send({ error: err?.message || 'Failed to create shipment plan' });
    }
  });

  // Get single shipment plan
  fastify.get('/shipment-plans/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    const plan = await getShipmentPlan({ userId: String(userId), id });
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    return plan;
  });

  // Update shipment plan (draft only)
  fastify.put('/shipment-plans/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    const body = req.body || {};
    const updatePayload: Parameters<typeof updateShipmentPlan>[0] = { userId: String(userId), id };
    if (body.items !== undefined) updatePayload.items = body.items;
    if (body.orderNo !== undefined) updatePayload.orderNo = body.orderNo;
    if (body.receiptNo !== undefined) updatePayload.receiptNo = body.receiptNo;
    if (body.orderDate) updatePayload.orderDate = new Date(body.orderDate);
    if (body.estimatedArrivalDate) updatePayload.estimatedArrivalDate = new Date(body.estimatedArrivalDate);
    if (body.shipmentTitle !== undefined) updatePayload.shipmentTitle = body.shipmentTitle;
    if (body.status) updatePayload.status = body.status;
    if (req.log) updatePayload.log = req.log;
    try {
      const plan = await updateShipmentPlan(updatePayload);
      return plan;
    } catch (err: any) {
      req.log.error({ err }, 'update shipment plan failed');
      return reply.code(400).send({ error: err?.message || 'Failed to update shipment plan' });
    }
  });

  // Submit draft
  fastify.post('/shipment-plans/:id/submit', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    try {
      const plan = await submitShipmentPlan({ userId: String(userId), id, log: req.log });
      return plan;
    } catch (err: any) {
      req.log.error({ err }, 'submit shipment plan failed');
      return reply.code(400).send({ error: err?.message || 'Failed to submit' });
    }
  });

  // Cancel shipment plan
  fastify.post('/shipment-plans/:id/cancel', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    try {
      const plan = await cancelShipmentPlan({ userId: String(userId), id, log: req.log });
      return plan;
    } catch (err: any) {
      req.log.error({ err }, 'cancel shipment plan failed');
      return reply.code(400).send({ error: err?.message || 'Failed to cancel' });
    }
  });

  // Get closest facility for a plan (preview)
  fastify.get('/shipment-plans/:id/closest-facility', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    try {
      const closest = await getClosestFacilityForPlan({ userId: String(userId), shipmentPlanId: id, log: req.log });
      return closest || { facilityId: null, facility: null, distanceMiles: null };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'Failed to get closest facility' });
    }
  });

  // Create ASN for plan
  fastify.post('/shipment-plans/:id/create-asn', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    try {
      const result = await createASNForShipmentPlan({ userId: String(userId), shipmentPlanId: id, log: req.log });
      return result;
    } catch (err: any) {
      req.log.error({ err }, 'create ASN failed');
      return reply.code(400).send({ error: err?.message || 'Failed to create ASN' });
    }
  });

  // Rate shop to warehouse (step 5)
  fastify.post('/shipment-plans/:id/rate-shop-to-warehouse', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params as any;
    try {
      const result = await rateShopToWarehouse({ userId: String(userId), shipmentPlanId: id, log: req.log });
      return result;
    } catch (err: any) {
      req.log.error({ err }, 'rate shop to warehouse failed');
      return reply.code(400).send({ error: err?.message || 'Rate shop failed' });
    }
  });

  // Estimated cost (for review step)
  fastify.get('/shipment-plans/:id/estimated-cost', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    const plan = await getShipmentPlan({ userId: String(userId), id });
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    if (!plan.facilityId) return reply.code(400).send({ error: 'No facility assigned yet' });

    const cost = await computeEstimatedCost({
      facilityId: plan.facilityId,
      userId: String(userId),
      items: plan.items || [],
    });
    return cost;
  });

}
