import { FastifyInstance } from 'fastify';
import { Item } from '../models/item';
import { ItemExternal } from '../models/item-external';
import { ChannelAccount } from '../models/channel-account';

export async function itemRoutes(fastify: FastifyInstance) {
  // List items for current user
  fastify.get('/items', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const items = await Item.find({ userId }).sort({ updatedAt: -1 }).limit(200).lean().exec();
    return items;
  });

  // Create item
  fastify.post('/items', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { sku, title, description, attributes, defaultUom, tags } = req.body || {};
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
      });
      return created;
    } catch (err: any) {
      req.log.error({ err }, 'failed to create item');
      return reply.code(400).send({ error: 'Could not create item', detail: err?.message });
    }
  });

  // Get item by id
  fastify.get('/items/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const item = await Item.findOne({ _id: id, userId }).lean().exec();
    if (!item) return reply.code(404).send({ error: 'Not found' });
    const links = await ItemExternal.find({ itemId: item._id }).lean().exec();
    return { ...item, mappings: links };
  });

  // Update item
  fastify.patch('/items/:id', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const { id } = req.params || {};
    const { title, description, attributes, defaultUom, tags, archived } = req.body || {};
    const updated = await Item.findOneAndUpdate(
      { _id: id, userId },
      { title, description, attributes, defaultUom, tags, archived },
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








