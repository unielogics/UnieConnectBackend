import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { PipelineStage } from 'mongoose';
import { AuditOrderLine } from '../models/audit-order-line';
import { getOrCreateQuote, findCachedQuote } from '../services/rate-shopping';
import { shippoRateQuote } from '../services/shippo-rate-shopping';

export async function auditRoutes(fastify: FastifyInstance) {
  fastify.get('/audit/heatmap', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const match = { userId: new Types.ObjectId(userId), dataQualityStatus: 'valid' as const };
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: '$shipTo.state',
          orders: { $sum: 1 },
          totalOriginal: { $sum: { $ifNull: ['$originalCostTotal', 0] } },
          totalOptimized: { $sum: { $ifNull: ['$optimizedCostTotal', '$originalCostTotal', 0] } },
        },
      },
      {
        $project: {
          state: '$_id',
          orders: 1,
          totalOriginal: 1,
          totalOptimized: 1,
          savings: { $subtract: ['$totalOriginal', '$totalOptimized'] },
          savingsPct: {
            $cond: [
              { $gt: ['$totalOriginal', 0] },
              { $multiply: [{ $divide: [{ $subtract: ['$totalOriginal', '$totalOptimized'] }, '$totalOriginal'] }, 100] },
              0,
            ],
          },
        },
      },
      { $sort: { orders: -1 as 1 | -1 } },
    ];

    const heatmap = await AuditOrderLine.aggregate(pipeline).exec();
    return { heatmap };
  });

  fastify.get('/audit/summary', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const match = { userId: new Types.ObjectId(userId), dataQualityStatus: 'valid' as const };
    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $addFields: {
          year: { $year: '$orderDate' },
          quarter: { $ceil: { $divide: [{ $month: '$orderDate' }, 3] } },
        },
      },
      {
        $group: {
          _id: { year: '$year', quarter: '$quarter' },
          orders: { $sum: 1 },
          totalOriginal: { $sum: { $ifNull: ['$originalCostTotal', 0] } },
          totalOptimized: { $sum: { $ifNull: ['$optimizedCostTotal', '$originalCostTotal', 0] } },
        },
      },
      {
        $project: {
          year: '$_id.year',
          quarter: '$_id.quarter',
          orders: 1,
          totalOriginal: 1,
          totalOptimized: 1,
          savings: { $subtract: ['$totalOriginal', '$totalOptimized'] },
          savingsPct: {
            $cond: [
              { $gt: ['$totalOriginal', 0] },
              { $multiply: [{ $divide: [{ $subtract: ['$totalOriginal', '$totalOptimized'] }, '$totalOriginal'] }, 100] },
              0,
            ],
          },
        },
      },
      { $sort: { year: -1 as 1 | -1, quarter: -1 as 1 | -1 } },
    ];

    const summary = await AuditOrderLine.aggregate(pipeline).exec();
    return { summary };
  });

  fastify.post('/audit/lines', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const body = req.body || {};
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (lines.length === 0) return reply.code(400).send({ error: 'No lines provided' });

    let upserted = 0;
    for (const line of lines) {
      const {
        channelAccountId,
        channel,
        marketplaceId,
        fulfillmentChannel,
        source,
        orderId,
        orderExternalId,
        orderDate,
        sku,
        itemName,
        quantity,
        weightLbs,
        itemCount,
        shipTo,
        costs,
        prepFeeRequired = true,
        originalCostTotal,
        optimizedCostTotal,
        savingsPct,
        savingsEnabled = true,
        rateShoppingQuoteRef,
        chosenWarehouseId,
        shipZone,
        hotStateRank,
        zoneClusterId,
        demandScore,
        coverageFlags,
        shippingLabelPresent,
      } = line || {};

      const reasons: string[] = [];
      const city = shipTo?.city;
      const state = shipTo?.state;
      const postalCode = shipTo?.postalCode;
      if (!city || !state || !postalCode) reasons.push('missing_address');
      if (!shippingLabelPresent) reasons.push('missing_label');
      const dataQualityStatus = reasons.length ? 'excluded' : 'valid';

      await AuditOrderLine.findOneAndUpdate(
        {
          userId,
          orderExternalId: orderExternalId || undefined,
          sku: sku || undefined,
        },
        {
          userId,
          channelAccountId,
          channel,
          marketplaceId,
          fulfillmentChannel,
          source,
          orderId,
          orderExternalId,
          orderDate: orderDate ? new Date(orderDate) : undefined,
          sku,
          itemName,
          quantity,
          weightLbs,
          itemCount,
          shipTo,
          costs,
          prepFeeRequired,
          dataQualityStatus,
          dataQualityReasons: reasons,
          originalCostTotal,
          optimizedCostTotal,
          savingsPct,
          savingsEnabled,
          rateShoppingQuoteRef,
          chosenWarehouseId,
          shipZone,
          hotStateRank,
          zoneClusterId,
          demandScore,
          coverageFlags,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
      upserted += 1;
    }

    return { upserted };
  });

  fastify.post('/audit/rate-shop', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { city, state, postalCode, weightLbs, itemCount, currency, cacheOnly, ttlMs, quoteOverride } = req.body || {};
    if (!city || !state || !Number.isFinite(weightLbs) || !Number.isFinite(itemCount)) {
      return reply.code(400).send({ error: 'city, state, weightLbs, and itemCount are required' });
    }

    try {
      const fetchQuote =
        cacheOnly === true
          ? undefined
          : async () => {
              if (Number.isFinite(quoteOverride)) {
                return { amount: Number(quoteOverride), currency };
              }
              return shippoRateQuote({ toCity: city, toState: state, toZip: postalCode, weightLbs, itemCount });
            };

      const quote = await getOrCreateQuote({
        city,
        state,
        weightLbs,
        itemCount,
        currency,
        ttlMs,
        ...(fetchQuote ? { fetchQuote } : {}),
      });
      return { quote };
    } catch (err: any) {
      req.log.error({ err }, 'rate shop failed');
      return reply.code(502).send({ error: err?.message || 'rate shop failed' });
    }
  });

  fastify.get('/audit/rate-shop/cache', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { city, state, weightLbs, itemCount } = req.query || {};
    if (!city || !state || !Number.isFinite(Number(weightLbs)) || !Number.isFinite(Number(itemCount))) {
      return reply.code(400).send({ error: 'city, state, weightLbs, and itemCount are required' });
    }

    const cached = await findCachedQuote({
      city,
      state,
      weightLbs: Number(weightLbs),
      itemCount: Number(itemCount),
    });
    if (!cached) return reply.code(404).send({ error: 'No cached quote' });
    return { quote: cached };
  });
}


