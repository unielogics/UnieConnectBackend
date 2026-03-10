import { FastifyInstance } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { pushAmazonInventory } from '../services/amazon-inventory';
import { createFulfillmentOrder } from '../services/amazon-fulfillment';
import {
  createInboundPlan,
  createInboundShipment,
  fetchInboundSkuLabels,
  getInboundLabels,
  getInboundShipmentDetail,
  listInboundShipmentHistory,
  saveInboundWorkflowDraft,
} from '../services/amazon-inbound';
import { fetchShippingLabel, getShippingRates, createShippingShipment } from '../services/amazon-shipping';
import { searchAmazonCatalogItems } from '../services/amazon-catalog';
import {
  confirmSendToAmazonPlacement,
  fetchSendToAmazonShipmentLabels,
  generateSendToAmazonPlacementPreview,
  getSendToAmazonWorkflow,
  listSendToAmazonWorkflows,
  saveSendToAmazonWorkflowDraft,
} from '../services/amazon-send-to-amazon';

async function getAmazonAccountForUser(accountId: string, userId: string) {
  return ChannelAccount.findOne({ _id: accountId, userId, channel: 'amazon' }).exec();
}

export async function amazonRoutes(fastify: FastifyInstance) {
  fastify.get('/amazon/send-to-amazon/workflows', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, limit } = req.query as any;
    if (!accountId) return reply.code(400).send({ error: 'accountId is required' });
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    return listSendToAmazonWorkflows({
      channelAccountId: String(account._id),
      userId: String(userId),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
    });
  });

  fastify.post('/amazon/send-to-amazon/workflows', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, workflowId, workflowName, marketplaceId, shipFromLocationId, shipFromAddress, items } = req.body || {};
    if (!accountId || !Array.isArray(items)) {
      return reply.code(400).send({ error: 'accountId and items are required' });
    }
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    return saveSendToAmazonWorkflowDraft({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId,
      workflowName,
      marketplaceId,
      shipFromLocationId,
      shipFromAddress,
      items,
      log: fastify.log,
    });
  });

  fastify.get('/amazon/send-to-amazon/workflows/:workflowId', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId } = req.query as any;
    const { workflowId } = req.params || {};
    if (!accountId || !workflowId) return reply.code(400).send({ error: 'accountId and workflowId are required' });
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const workflow = await getSendToAmazonWorkflow({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId: String(workflowId),
    });
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
    return workflow;
  });

  fastify.post('/amazon/send-to-amazon/workflows/:workflowId/placement-preview', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId } = req.body || {};
    const { workflowId } = req.params || {};
    if (!accountId || !workflowId) return reply.code(400).send({ error: 'accountId and workflowId are required' });
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    return generateSendToAmazonPlacementPreview({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId: String(workflowId),
      log: fastify.log,
    });
  });

  fastify.post('/amazon/send-to-amazon/workflows/:workflowId/confirm-placement', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, placementOptionId } = req.body || {};
    const { workflowId } = req.params || {};
    if (!accountId || !workflowId) return reply.code(400).send({ error: 'accountId and workflowId are required' });
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    return confirmSendToAmazonPlacement({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId: String(workflowId),
      placementOptionId,
      log: fastify.log,
    });
  });

  fastify.post('/amazon/send-to-amazon/workflows/:workflowId/shipments/:shipmentId/labels', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId } = req.body || {};
    const { workflowId, shipmentId } = req.params || {};
    if (!accountId || !workflowId || !shipmentId) {
      return reply.code(400).send({ error: 'accountId, workflowId, and shipmentId are required' });
    }
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    return fetchSendToAmazonShipmentLabels({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId: String(workflowId),
      shipmentId: String(shipmentId),
      log: fastify.log,
    });
  });

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
    const { accountId, workflowId, packingMode, supplierId, shipFromLocationId, shipFromAddress, labelPrepPreference, items } = req.body || {};
    if (!accountId || (!shipFromLocationId && !shipFromAddress) || !Array.isArray(items)) {
      return reply.code(400).send({ error: 'accountId, shipFromLocationId or shipFromAddress, and items are required' });
    }
    const account = await getAmazonAccountForUser(accountId, userId);
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const res = await createInboundPlan({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId,
      packingMode,
      supplierId,
      shipFromLocationId,
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
      workflowId,
      shipmentId,
      destinationFulfillmentCenterId,
      supplierId,
      shipFromLocationId,
      shipFromAddress,
      packingMode,
      labelPrepPreference,
      shipmentName,
      items,
    } = req.body || {};
    if (!accountId || !shipmentId || !destinationFulfillmentCenterId || (!shipFromLocationId && !shipFromAddress) || !Array.isArray(items)) {
      return reply
        .code(400)
        .send({ error: 'accountId, shipmentId, destinationFulfillmentCenterId, shipFromLocationId or shipFromAddress, and items are required' });
    }
    const account = await getAmazonAccountForUser(accountId, userId);
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const res = await createInboundShipment({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId,
      shipmentId,
      destinationFulfillmentCenterId,
      supplierId,
      shipFromLocationId,
      shipFromAddress,
      packingMode,
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
    const account = await getAmazonAccountForUser(accountId, userId);
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

  fastify.post('/amazon/inbound/workflows/draft', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, workflowId, supplierId, shipFromLocationId, shipFromAddress, labelPrepPreference, packingMode, items } = req.body || {};
    if (!accountId) return reply.code(400).send({ error: 'accountId is required' });
    const account = await getAmazonAccountForUser(accountId, userId);
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const draft = await saveInboundWorkflowDraft({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId,
      supplierId,
      shipFromLocationId,
      shipFromAddress,
      labelPrepPreference,
      packingMode,
      items,
      log: fastify.log,
    });

    return draft;
  });

  fastify.post('/amazon/inbound/workflows/sku-labels', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, workflowId, supplierId, shipFromLocationId, shipFromAddress, labelPrepPreference, packingMode, items } = req.body || {};
    if (!accountId || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: 'accountId and items are required' });
    }
    const account = await getAmazonAccountForUser(accountId, userId);
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    return fetchInboundSkuLabels({
      channelAccountId: String(account._id),
      userId: String(userId),
      workflowId,
      supplierId,
      shipFromLocationId,
      shipFromAddress,
      labelPrepPreference,
      packingMode,
      items,
      log: fastify.log,
    });
  });

  fastify.get('/amazon/inbound/history', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, workflowStatus, limit } = req.query as any;
    if (!accountId) return reply.code(400).send({ error: 'accountId is required' });
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const historyParams: {
      channelAccountId: string;
      userId: string;
      workflowStatus?: string;
      limit?: number;
    } = {
      channelAccountId: String(account._id),
      userId: String(userId),
    };
    if (workflowStatus) historyParams.workflowStatus = String(workflowStatus);
    if (limit !== undefined) historyParams.limit = Number(limit);
    return listInboundShipmentHistory(historyParams);
  });

  fastify.get('/amazon/inbound/history/:workflowOrShipmentId', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, mode } = req.query as any;
    const { workflowOrShipmentId } = req.params || {};
    if (!accountId || !workflowOrShipmentId) {
      return reply.code(400).send({ error: 'accountId and workflowOrShipmentId are required' });
    }
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const detailParams: {
      channelAccountId: string;
      userId: string;
      shipmentId?: string;
      workflowId?: string;
    } = {
      channelAccountId: String(account._id),
      userId: String(userId),
    };
    if (mode === 'workflow') detailParams.workflowId = String(workflowOrShipmentId);
    else detailParams.shipmentId = String(workflowOrShipmentId);

    const detail = await getInboundShipmentDetail(detailParams);
    if (!detail) return reply.code(404).send({ error: 'Not found' });
    return detail;
  });

  fastify.get('/amazon/catalog/items', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { accountId, marketplaceId, q, nextToken, pageSize } = req.query as any;
    if (!accountId) return reply.code(400).send({ error: 'accountId is required' });
    const account = await getAmazonAccountForUser(String(accountId), String(userId));
    if (!account) return reply.code(404).send({ error: 'Account not found' });

    const catalogParams: {
      channelAccountId: string;
      marketplaceId?: string;
      query?: string;
      nextToken?: string;
      pageSize?: number;
      log: typeof fastify.log;
    } = {
      channelAccountId: String(account._id),
      log: fastify.log,
    };
    if (marketplaceId) catalogParams.marketplaceId = String(marketplaceId);
    if (q) catalogParams.query = String(q);
    if (nextToken) catalogParams.nextToken = String(nextToken);
    if (pageSize !== undefined) catalogParams.pageSize = Number(pageSize);
    return searchAmazonCatalogItems(catalogParams);
  });

  fastify.get('/amazon/shipping/labels/:shipmentId', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { shipmentId } = req.params || {};
    const { accountId, orderId, format } = req.query as any;
    if (!accountId || !shipmentId) return reply.code(400).send({ error: 'accountId and shipmentId are required' });
    const account = await getAmazonAccountForUser(accountId, userId);
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
    const account = await getAmazonAccountForUser(accountId, userId);
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


