import { FastifyInstance } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { pushAmazonInventory } from '../services/amazon-inventory';
import { createFulfillmentOrder } from '../services/amazon-fulfillment';
import { createInboundPlan, createInboundShipment, getInboundLabels } from '../services/amazon-inbound';
import { fetchShippingLabel, getShippingRates, createShippingShipment } from '../services/amazon-shipping';

export async function amazonRoutes(fastify: FastifyInstance) {
  fastify.post('/amazon/inventory', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, updates } = req.body || {};
    if (!accountId || !Array.isArray(updates)) return reply.code(400).send({ error: 'accountId and updates are required' });

    const account = await ChannelAccount.findOne({ _id: accountId, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    await pushAmazonInventory(String(account._id), updates, fastify.log);
    return { success: true };
  });

  fastify.post('/amazon/fulfillment', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, displayableOrderId, displayableOrderDateTime, displayableOrderComment, shippingSpeedCategory, destinationAddress, items, marketplaceId } =
      req.body || {};
    if (!accountId || !displayableOrderId || !shippingSpeedCategory || !destinationAddress || !Array.isArray(items)) {
      return reply.code(400).send({ error: 'accountId, displayableOrderId, shippingSpeedCategory, destinationAddress, and items are required' });
    }
    const account = await ChannelAccount.findOne({ _id: accountId, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const res = await createFulfillmentOrder({
      channelAccountId: String(account._id),
      displayableOrderId,
      displayableOrderDateTime,
      displayableOrderComment,
      shippingSpeedCategory,
      destinationAddress,
      items,
      marketplaceId,
      log: fastify.log,
    });

    return res;
  });

  fastify.post('/amazon/inbound/plan', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, shipFromAddress, labelPrepPreference, items } = req.body || {};
    if (!accountId || !shipFromAddress || !Array.isArray(items)) {
      return reply.code(400).send({ error: 'accountId, shipFromAddress, and items are required' });
    }
    const account = await ChannelAccount.findOne({ _id: accountId, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const res = await createInboundPlan({
      channelAccountId: String(account._id),
      shipFromAddress,
      labelPrepPreference,
      items,
      log: fastify.log,
    });

    return res;
  });

  fastify.post('/amazon/inbound/shipment', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const {
      accountId,
      shipmentId,
      destinationFulfillmentCenterId,
      shipFromAddress,
      labelPrepPreference,
      shipmentName,
      items,
    } = req.body || {};
    if (!accountId || !shipmentId || !destinationFulfillmentCenterId || !shipFromAddress || !Array.isArray(items)) {
      return reply
        .code(400)
        .send({ error: 'accountId, shipmentId, destinationFulfillmentCenterId, shipFromAddress, and items are required' });
    }
    const account = await ChannelAccount.findOne({ _id: accountId, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const res = await createInboundShipment({
      channelAccountId: String(account._id),
      userId: String(userId),
      shipmentId,
      destinationFulfillmentCenterId,
      shipFromAddress,
      labelPrepPreference,
      shipmentName,
      items,
      log: fastify.log,
    });

    return res;
  });

  fastify.get('/amazon/inbound/:shipmentId/labels', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, pageType, labelType, numberOfPackages } = req.query as any;
    const { shipmentId } = req.params || {};
    if (!accountId || !shipmentId) return reply.code(400).send({ error: 'accountId and shipmentId are required' });
    const account = await ChannelAccount.findOne({ _id: accountId, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const labelParams: {
      channelAccountId: string;
      shipmentId: string;
      pageType?: string;
      labelType?: string;
      numberOfPackages?: number;
      log: typeof fastify.log;
    } = {
      channelAccountId: String(account._id),
      shipmentId: String(shipmentId),
      log: fastify.log,
    };
    if (pageType) labelParams.pageType = String(pageType);
    if (labelType) labelParams.labelType = String(labelType);
    if (numberOfPackages !== undefined) labelParams.numberOfPackages = Number(numberOfPackages);

    const res = await getInboundLabels(labelParams);

    return res;
  });

  fastify.get('/amazon/shipping/labels/:shipmentId', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { shipmentId } = req.params || {};
    const { accountId, orderId, format } = req.query as any;
    if (!accountId || !shipmentId) return reply.code(400).send({ error: 'accountId and shipmentId are required' });
    const account = await ChannelAccount.findOne({ _id: accountId, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const labelReq: {
      channelAccountId: string;
      userId: string;
      shipmentId: string;
      orderId?: string;
      format?: string;
      log: typeof fastify.log;
    } = {
      channelAccountId: String(account._id),
      userId: String(userId),
      shipmentId: String(shipmentId),
      log: fastify.log,
    };
    if (orderId) labelReq.orderId = String(orderId);
    if (format) labelReq.format = String(format);

    const res = await fetchShippingLabel(labelReq);

    return res;
  });

  fastify.post('/amazon/shipping/shipments', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, orderId, shipFrom, shipTo, packages, serviceTypes, rateId, labelFormat, labelSize, clientReferenceId } = req.body || {};
    if (!accountId || !shipFrom || !shipTo || !Array.isArray(packages) || packages.length === 0) {
      return reply.code(400).send({ error: 'accountId, shipFrom, shipTo, and packages are required' });
    }
    const account = await ChannelAccount.findOne({ _id: accountId, userId }).exec();
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    let chosenRateId = rateId as string | undefined;
    let ratesResponse: any = undefined;

    if (!chosenRateId) {
      const rateParams: {
        channelAccountId: string;
        shipFrom: any;
        shipTo: any;
        packages: any[];
        serviceTypes?: string[];
        log: typeof fastify.log;
      } = {
        channelAccountId: String(account._id),
        shipFrom,
        shipTo,
        packages,
        log: fastify.log,
      };
      if (Array.isArray(serviceTypes)) rateParams.serviceTypes = serviceTypes as string[];

      ratesResponse = await getShippingRates(rateParams as any);
      const rateOptions = ratesResponse?.payload?.rateOptions || ratesResponse?.rateOptions || [];
      if (!rateOptions.length) {
        return reply.code(400).send({ error: 'No rate options returned from Amazon Shipping' });
      }
      // Choose cheapest by totalCharge if available
      rateOptions.sort((a: any, b: any) => {
        const aTotal = Number(a?.totalCharge?.value) || Number.MAX_SAFE_INTEGER;
        const bTotal = Number(b?.totalCharge?.value) || Number.MAX_SAFE_INTEGER;
        return aTotal - bTotal;
      });
      chosenRateId = rateOptions[0]?.rateId;
    }

    const shipmentParams: {
      channelAccountId: string;
      userId: string;
      orderId?: string;
      clientReferenceId: string;
      shipFrom: any;
      shipTo: any;
      packages: any[];
      rateId: string;
      labelFormat?: 'PDF' | 'ZPL';
      labelSize?: string;
      log: typeof fastify.log;
    } = {
      channelAccountId: String(account._id),
      userId: String(userId),
      clientReferenceId: clientReferenceId || `order-${orderId || Date.now()}`,
      shipFrom,
      shipTo,
      packages,
      rateId: String(chosenRateId),
      log: fastify.log,
    };
    if (orderId) shipmentParams.orderId = String(orderId);
    if (labelFormat) shipmentParams.labelFormat = labelFormat as 'PDF' | 'ZPL';
    if (labelSize) shipmentParams.labelSize = labelSize as string;

    const shipmentRes = await createShippingShipment(shipmentParams as any);

    const shipmentId = shipmentRes?.payload?.shipmentId || shipmentRes?.shipmentId;
    const labelDoc = shipmentRes?.payload?.documents?.[0] || shipmentRes?.documents?.[0];

    return {
      shipmentId,
      rateId: chosenRateId,
      rates: ratesResponse?.payload?.rateOptions || ratesResponse?.rateOptions,
      label: labelDoc,
      raw: shipmentRes,
    };
  });
}


