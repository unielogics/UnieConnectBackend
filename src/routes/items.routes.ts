import { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { Item } from '../models/item';
import { ItemActivityLog } from '../models/item-activity-log';
import { ItemExternal } from '../models/item-external';
import { ChannelAccount } from '../models/channel-account';
import { channelDisplayLabel } from '../lib/channel-display';
import { OmsIntermediary } from '../models/oms-intermediary';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';
import { User } from '../models/user';
import { fetchWmsInventoryBySkus } from '../services/wms-inventory.service';
import { fetchWmsItemActivities } from '../services/wms-activities.service';

export async function itemRoutes(fastify: FastifyInstance) {
  // List items for current user
  fastify.get('/items', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { includeMappings, channel } = (req.query as { includeMappings?: string; channel?: string }) || {};
    const match: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    let itemIdsForFilter: Types.ObjectId[] | null = null;
    if (channel && ['shopify', 'amazon', 'ebay', 'unmapped'].includes(channel)) {
      const accounts = await ChannelAccount.find({ userId: new Types.ObjectId(userId) }).select('_id channel').lean().exec();
      const accountIds = accounts.filter((a) => a.channel === channel).map((a) => a._id);
      if (channel === 'unmapped') {
        const mappedItemIds = await ItemExternal.distinct('itemId', { channelAccountId: { $in: accounts.map((a) => a._id) } }).exec();
        match._id = { $nin: mappedItemIds };
      } else if (accountIds.length > 0) {
        itemIdsForFilter = await ItemExternal.distinct('itemId', { channelAccountId: { $in: accountIds } }).exec();
        match._id = { $in: itemIdsForFilter };
      } else {
        match._id = { $in: [] };
      }
    }
    const items = await Item.find(match).sort({ updatedAt: -1 }).limit(200).lean().exec();

    // Resolve WMS inventory when user has warehouse connection
    let wmsInventory: Record<string, { inbound: number; received: number; available: number; orders: number; shippedToday: number }> = {};
    const user = await User.findById(userId).select('email').lean().exec();
    if (user?.email) {
      const oms = await OmsIntermediary.findOne({
        email: (user.email as string).toLowerCase(),
        status: 'active',
      })
        .select('_id')
        .lean()
        .exec();
      if (oms?._id) {
        const link = await OmsIntermediaryWarehouse.findOne({ omsIntermediaryId: oms._id }).lean().exec();
        if (link?.warehouseCode && items.length > 0) {
          const skus = items.map((i) => (i as any).sku).filter(Boolean);
          wmsInventory = await fetchWmsInventoryBySkus({
            warehouseCode: link.warehouseCode,
            skus,
            log: req.log,
          });
        }
      }
    }

    if (!includeMappings || includeMappings === '1' || includeMappings === 'true') {
      const ids = items.map((i) => i._id);
      const links = await ItemExternal.find({ itemId: { $in: ids } })
        .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
        .lean()
        .exec();
      const byItem = links.reduce<Record<string, any[]>>((acc, l) => {
        const itemId = String((l as any).itemId);
        if (!acc[itemId]) acc[itemId] = [];
        acc[itemId].push(l);
        return acc;
      }, {});
      const channelsByItem = Object.fromEntries(
        Object.entries(byItem).map(([itemId, lst]) => {
          const channels = [...new Set(lst.map((l) => (l as any).channel))];
          const mappings = lst.map((l) => {
            const acc = (l as any).channelAccountId;
            return {
              channel: (l as any).channel,
              channelDisplay: acc ? channelDisplayLabel(acc) : (l as any).channel,
              channelAccountId: (l as any).channelAccountId?._id ?? (l as any).channelAccountId,
            };
          });
          return [itemId, { channels, mappings }];
        })
      );
      const result = items.map((item) => {
        const itemId = String(item._id);
        const { channels = [], mappings = [] } = channelsByItem[itemId] || {};
        const sku = (item as any).sku;
        const inventory = sku && wmsInventory[sku] ? wmsInventory[sku] : undefined;
        return { ...item, channels, mappings, ...(inventory && { wmsInventory: inventory }) };
      });
      return result;
    }
    const result = items.map((item) => {
      const sku = (item as any).sku;
      const inventory = sku && wmsInventory[sku] ? wmsInventory[sku] : undefined;
      return inventory ? { ...item, wmsInventory: inventory } : item;
    });
    return result;
  });

  // Create item
  fastify.post('/items', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const {
      sku,
      title,
      description,
      attributes,
      defaultUom,
      tags,
      supplierId,
      image,
      images,
      upc,
      ean,
      asin,
      category,
      subCategory,
      lob,
      weight,
      dimensions,
    } = req.body || {};
    if (!sku || !title) return reply.code(400).send({ error: 'sku and title required' });
    try {
      const created = await Item.create({
        userId,
        sku: String(sku).trim(),
        title: String(title).trim(),
        description,
        attributes,
        defaultUom,
        tags,
        supplierId: supplierId || undefined,
        image: image || undefined,
        images: Array.isArray(images) ? images : undefined,
        upc: upc || undefined,
        ean: ean || undefined,
        asin: asin || undefined,
        category: category || undefined,
        subCategory: subCategory || undefined,
        lob: lob || undefined,
        weight: weight != null && weight !== '' ? Number(weight) : undefined,
        dimensions:
          dimensions && (dimensions.length || dimensions.width || dimensions.height)
            ? {
                length: dimensions.length != null ? Number(dimensions.length) : undefined,
                width: dimensions.width != null ? Number(dimensions.width) : undefined,
                height: dimensions.height != null ? Number(dimensions.height) : undefined,
              }
            : undefined,
      });
      return created;
    } catch (err: any) {
      req.log.error({ err }, 'failed to create item');
      return reply.code(400).send({ error: 'Could not create item', detail: err?.message });
    }
  });

  // Get WMS warehouse activities for item (when user has warehouse connection)
  fastify.get('/items/:id/wms-activities', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params as { id: string };
    const item = await Item.findOne({ _id: id, userId }).select('sku').lean().exec();
    if (!item?.sku) return reply.code(404).send({ error: 'Item not found' });
    const sku = (item as any).sku;
    const user = await User.findById(userId).select('email').lean().exec();
    let activities: Record<string, unknown> | null = null;
    const inventoryByWarehouse: Array<{ warehouseCode: string; warehouseName?: string; inventory: Record<string, unknown> }> = [];
    let links: Array<{ warehouseCode: string }> = [];
    if (user?.email) {
      const oms = await OmsIntermediary.findOne({
        email: (user.email as string).toLowerCase(),
        status: 'active',
      })
        .select('_id')
        .lean()
        .exec();
      if (oms?._id) {
        links = await OmsIntermediaryWarehouse.find({ omsIntermediaryId: oms._id })
          .select('warehouseCode')
          .lean()
          .exec();
      }
    }
    const firstWarehouseCode = links[0]?.warehouseCode;
    if (firstWarehouseCode) {
      activities = (await fetchWmsItemActivities({
        userId,
        sku,
        log: req.log,
      })) as Record<string, unknown> | null;
      for (const link of links) {
        const wc = (link as any).warehouseCode;
        if (!wc) continue;
        const inv = await fetchWmsInventoryBySkus({
          warehouseCode: wc,
          skus: [sku],
          log: req.log,
        });
        const invData = inv[sku] as Record<string, unknown> | undefined;
        if (invData) {
          inventoryByWarehouse.push({
            warehouseCode: wc,
            warehouseName: wc,
            inventory: invData,
          });
        }
      }
    }
    const wmsInventory = inventoryByWarehouse[0]?.inventory as Record<string, unknown> | undefined;
    return {
      ...(activities || {}),
      wmsInventory,
      inventoryByWarehouse: inventoryByWarehouse.length > 0 ? inventoryByWarehouse : undefined,
    };
  });

  // Get item shipment activity (product logs)
  fastify.get('/items/:id/shipment-activity', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { id } = req.params as any;
    const { limit = 50, offset = 0 } = req.query as any;
    const item = await Item.findOne({ _id: id, userId }).lean().exec();
    if (!item) return reply.code(404).send({ error: 'Not found' });

    const sku = (item as any).sku;
    const query = { userId, $or: [{ itemId: id }, { sku }] };
    const total = await ItemActivityLog.countDocuments(query);
    const events = await ItemActivityLog.find(query)
      .sort({ createdAt: -1 })
      .skip(Math.max(0, Number(offset)))
      .limit(Math.min(100, Number(limit) || 50))
      .lean()
      .exec();

    return { events, total };
  });

  // Get item by id
  fastify.get('/items/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const item = await Item.findOne({ _id: id, userId }).lean().exec();
    if (!item) return reply.code(404).send({ error: 'Not found' });
    const links = await ItemExternal.find({ itemId: item._id })
      .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
      .lean()
      .exec();
    const mappings = links.map((l) => {
      const acc = (l as any).channelAccountId;
      return {
        ...l,
        channelDisplay: acc ? channelDisplayLabel(acc) : (l as any).channel,
      };
    });
    const channels = [...new Set(links.map((l) => (l as any).channel))];
    return { ...item, mappings, channels };
  });

  // Update item
  fastify.patch('/items/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const {
      title,
      description,
      attributes,
      defaultUom,
      tags,
      archived,
      supplierId,
      image,
      images,
      upc,
      ean,
      asin,
      category,
      subCategory,
      lob,
      weight,
      dimensions,
    } = req.body || {};
    const update: Record<string, unknown> = { title, description, attributes, defaultUom, tags, archived };
    if (supplierId !== undefined) update.supplierId = supplierId || null;
    if (image !== undefined) update.image = image || null;
    if (images !== undefined) update.images = Array.isArray(images) ? images : null;
    if (upc !== undefined) update.upc = upc || null;
    if (ean !== undefined) update.ean = ean || null;
    if (asin !== undefined) update.asin = asin || null;
    if (category !== undefined) update.category = category || null;
    if (subCategory !== undefined) update.subCategory = subCategory || null;
    if (lob !== undefined) update.lob = lob || null;
    if (weight !== undefined) update.weight = weight != null && weight !== '' ? Number(weight) : null;
    if (dimensions !== undefined) {
      update.dimensions =
        dimensions && (dimensions.length || dimensions.width || dimensions.height)
          ? {
              length: dimensions.length != null ? Number(dimensions.length) : undefined,
              width: dimensions.width != null ? Number(dimensions.width) : undefined,
              height: dimensions.height != null ? Number(dimensions.height) : undefined,
            }
          : null;
    }
    const updated = await Item.findOneAndUpdate(
      { _id: id, userId },
      update,
      { new: true },
    )
      .lean()
      .exec();
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    return updated;
  });

  // Map item to a channel listing
  fastify.post('/items/:id/map', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const { channelAccountId, channelItemId, channelVariantId, sku, status } = req.body || {};
    if (!channelAccountId || !channelItemId) return reply.code(400).send({ error: 'channelAccountId and channelItemId required' });
    const item = await Item.findOne({ _id: id, userId }).exec();
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    const channelAccount = await ChannelAccount.findById(channelAccountId).exec();
    if (!channelAccount) return reply.code(400).send({ error: 'Invalid channelAccountId' });

    const mapped = await ItemExternal.findOneAndUpdate(
      {
        channelAccountId: channelAccount._id,
        channelItemId,
        channelVariantId: channelVariantId || null,
      },
      {
        itemId: item._id,
        channel: channelAccount.channel,
        sku: sku || item.sku,
        status: status || 'active',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    return mapped;
  });

  // List mappings across items
  fastify.get('/mappings/items', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const items = await Item.find({ userId }).select({ sku: 1, title: 1 }).lean().exec();
    const itemIds = items.map((i) => i._id);
    const links = await ItemExternal.find({ itemId: { $in: itemIds } }).lean().exec();
    return { items, mappings: links };
  });
}
















