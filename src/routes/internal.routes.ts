import { FastifyInstance } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { OmsIntermediary } from '../models/oms-intermediary';
import { User } from '../models/user';
import { config } from '../config/env';
import { getShippingRates, createShippingShipment } from '../services/amazon-shipping';
import { processWmsOrderStatus } from '../services/wms-order-status.service';

/**
 * Internal API for WMS/UnieBackend to resolve channel accounts and call Amazon shipping.
 * Auth: X-Internal-Api-Key header must match UNIECONNECT_INTERNAL_API_KEY.
 */
async function requireInternalAuth(req: any, reply: any) {
  const apiKey = config.internalApiKey;
  if (!apiKey) {
    return reply.code(503).send({ error: 'Internal API not configured' });
  }
  const provided =
    (req.headers['x-internal-api-key'] as string) ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
  if (provided !== apiKey) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

export async function internalRoutes(app: FastifyInstance) {
  // Encapsulate: requireInternalAuth only for /internal/* routes
  await app.register(async (internalApp) => {
    internalApp.addHook('preHandler', requireInternalAuth);

    /**
     * GET /channel-accounts?omsIntermediaryId=...&channel=amazon
   * Returns Amazon ChannelAccounts for the given OMS intermediary.
   * Used by WMS to resolve order's client → channel account for rate shopping and label purchase.
     */
    internalApp.get('/channel-accounts', async (req: any, reply) => {
    const { omsIntermediaryId, channel } = req.query as { omsIntermediaryId?: string; channel?: string };
    if (!omsIntermediaryId) {
      return reply.code(400).send({ error: 'omsIntermediaryId is required' });
    }
    const targetChannel = (channel || 'amazon').toLowerCase();
    if (targetChannel !== 'amazon') {
      return reply.code(400).send({ error: 'Only channel=amazon is supported for internal use' });
    }

    const oms = await OmsIntermediary.findById(omsIntermediaryId).lean().exec();
    if (!oms) {
      return reply.code(404).send({ error: 'OMS intermediary not found' });
    }
    const email = (oms as any).email;
    if (!email) {
      return reply.code(404).send({ error: 'OMS intermediary has no email' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).lean().exec();
    if (!user) {
      return { channelAccounts: [] };
    }

    const accounts = await ChannelAccount.find({
      userId: user._id,
      channel: targetChannel,
      status: 'active',
    })
      .select('_id channel status sellingPartnerId marketplaceIds region')
      .lean()
      .exec();

      return {
        channelAccounts: accounts.map((a: any) => ({
          id: String(a._id),
          channel: a.channel,
          status: a.status,
          sellingPartnerId: a.sellingPartnerId,
          marketplaceIds: a.marketplaceIds,
          region: a.region,
        })),
      };
    });

    /**
     * POST /amazon/shipping/rates
   * Get Amazon Shipping rates for a channel account. Used by WMS for client-scoped rate shopping.
     */
    internalApp.post('/amazon/shipping/rates', async (req: any, reply) => {
    const { channelAccountId, shipFrom, shipTo, packages, serviceTypes } = req.body || {};
    if (!channelAccountId || !shipFrom || !shipTo || !Array.isArray(packages) || packages.length === 0) {
      return reply.code(400).send({ error: 'channelAccountId, shipFrom, shipTo, and packages are required' });
    }
    try {
      const res = await getShippingRates({
        channelAccountId: String(channelAccountId),
        shipFrom,
        shipTo,
        packages,
        ...(Array.isArray(serviceTypes) && serviceTypes.length > 0 ? { serviceTypes } : {}),
        log: internalApp.log,
      });
      return res;
    } catch (err: any) {
      internalApp.log.warn({ err, channelAccountId }, 'Internal Amazon shipping rates failed');
      return reply.code(500).send({ error: err?.message || 'Failed to fetch Amazon shipping rates' });
    }
  });

    /**
     * POST /amazon/shipping/shipments
   * Create Amazon Shipping shipment and get label. Used by WMS for client-scoped label purchase.
     */
    internalApp.post('/amazon/shipping/shipments', async (req: any, reply) => {
    const { channelAccountId, orderId, shipFrom, shipTo, packages, rateId, labelFormat, labelSize, clientReferenceId } = req.body || {};
    if (!channelAccountId || !shipFrom || !shipTo || !Array.isArray(packages) || packages.length === 0 || !rateId) {
      return reply.code(400).send({ error: 'channelAccountId, shipFrom, shipTo, packages, and rateId are required' });
    }
    const account = await ChannelAccount.findById(channelAccountId).lean().exec();
    if (!account || (account as any).channel !== 'amazon') {
      return reply.code(404).send({ error: 'Amazon channel account not found' });
    }
    const userId = String((account as any).userId);
    try {
      const res = await createShippingShipment({
        channelAccountId: String(channelAccountId),
        userId,
        ...(orderId ? { orderId: String(orderId) } : {}),
        clientReferenceId: clientReferenceId || `wms-order-${orderId || Date.now()}`,
        shipFrom,
        shipTo,
        packages,
        rateId: String(rateId),
        labelFormat: (labelFormat || 'PDF') as 'PDF' | 'ZPL',
        ...(labelSize ? { labelSize } : {}),
        log: internalApp.log,
      });
      const shipmentId = res?.payload?.shipmentId || res?.shipmentId;
      const labelDoc = res?.payload?.documents?.[0] || res?.documents?.[0];
      return {
        shipmentId,
        rateId,
        label: labelDoc,
        raw: res,
      };
    } catch (err: any) {
      internalApp.log.warn({ err, channelAccountId }, 'Internal Amazon shipping shipment failed');
      return reply.code(500).send({ error: err?.message || 'Failed to create Amazon shipping shipment' });
    }
  });

    /**
     * POST /wms/order-status
     * Receive WMS order status updates (shipped, completed, cancelled).
     * Updates OMS order and optionally pushes fulfillment to Shopify/Amazon.
     */
    internalApp.post('/wms/order-status', async (req: any, reply) => {
      const body = req.body || {};
      const {
        wmsOrderId,
        wmsOrderNumber,
        omsIntermediaryId,
        status,
        alternativeOrderNumber,
        trackingNumber,
        trackingCompany,
        trackingUrl,
        shippedAt,
      } = body;
      if (!omsIntermediaryId || !status) {
        return reply.code(400).send({ error: 'omsIntermediaryId and status are required' });
      }
      const payload: Parameters<typeof processWmsOrderStatus>[0] = {
        wmsOrderId: String(wmsOrderId || ''),
        wmsOrderNumber: String(wmsOrderNumber || ''),
        omsIntermediaryId: String(omsIntermediaryId),
        status: String(status),
      };
      if (alternativeOrderNumber) payload.alternativeOrderNumber = String(alternativeOrderNumber);
      if (trackingNumber) payload.trackingNumber = String(trackingNumber);
      if (trackingCompany) payload.trackingCompany = String(trackingCompany);
      if (trackingUrl) payload.trackingUrl = String(trackingUrl);
      if (shippedAt) payload.shippedAt = new Date(shippedAt);
      const result = await processWmsOrderStatus(payload, internalApp.log);
      if (!result.updated && result.error) {
        return reply.code(404).send({ error: result.error });
      }
      return { success: true };
    });
  }, { prefix: '/internal' });
}
