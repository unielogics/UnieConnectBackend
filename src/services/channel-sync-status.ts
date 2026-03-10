import { Types } from 'mongoose';
import { ChannelSyncStatus, SyncEntityType, SyncEntityStatus } from '../models/channel-sync-status';
import { CustomerExternal } from '../models/customer-external';

export async function setSyncStatus(
  channelAccountId: string,
  entityType: SyncEntityType,
  status: SyncEntityStatus,
  opts?: { count?: number; error?: string }
) {
  const update: Record<string, unknown> = { status };
  if (status === 'synced' || status === 'error') {
    update.lastSyncedAt = new Date();
  }
  if (opts?.count !== undefined) update.count = opts.count;
  if (opts?.error !== undefined) update.error = opts.error;

  await ChannelSyncStatus.findOneAndUpdate(
    { channelAccountId: new Types.ObjectId(channelAccountId), entityType },
    { $set: update },
    { upsert: true, new: true },
  ).exec();
}

export async function getSyncStatus(channelAccountId: string) {
  const docs = await ChannelSyncStatus.find({ channelAccountId: new Types.ObjectId(channelAccountId) })
    .lean()
    .exec();

  const entities: Record<string, { status: string; lastSyncedAt?: string; count?: number; error?: string }> = {};
  for (const t of ['products', 'orders', 'inventory', 'customers'] as SyncEntityType[]) {
    const doc = docs.find((d) => d.entityType === t);
    const ent: { status: string; lastSyncedAt?: string; count?: number; error?: string } = { status: doc?.status || 'idle' };
    if (doc?.lastSyncedAt) ent.lastSyncedAt = doc.lastSyncedAt.toISOString();
    if (doc?.count !== undefined) ent.count = doc.count;
    if (doc?.error) ent.error = doc.error;
    entities[t] = ent;
  }

  // Customers count: derive from CustomerExternal
  const customerCount = await CustomerExternal.countDocuments({
    channelAccountId: new Types.ObjectId(channelAccountId),
    channel: 'shopify',
  }).exec();
  if (entities.customers) {
    entities.customers.count = customerCount;
  }

  const allSynced =
    entities.products?.status === 'synced' &&
    entities.orders?.status === 'synced' &&
    entities.inventory?.status === 'synced';
  const anySyncing =
    entities.products?.status === 'syncing' ||
    entities.orders?.status === 'syncing' ||
    entities.inventory?.status === 'syncing';

  return {
    channelAccountId,
    entities,
    fullSync: allSynced && !anySyncing,
  };
}
