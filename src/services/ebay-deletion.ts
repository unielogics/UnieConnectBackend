import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';
import { ShippingLabel } from '../models/shipping-label';
import { InventoryLevel } from '../models/inventory-level';
import { ItemExternal } from '../models/item-external';
import { CustomerExternal } from '../models/customer-external';
import { AuditOrderLine } from '../models/audit-order-line';
import { DeletionRequest } from '../models/deletion-request';

export async function handleEbayAccountDeletion(externalUserId: string, log: FastifyBaseLogger) {
  const request = await DeletionRequest.create({
    provider: 'ebay',
    externalUserId,
    status: 'pending',
  });

  const accounts = await ChannelAccount.find({ channel: 'ebay', externalSellerId: externalUserId }).lean();
  if (!accounts.length) {
    await DeletionRequest.updateOne(
      { _id: request._id },
      { status: 'no_match', detail: 'No channel accounts found for externalUserId' },
    ).exec();
    log.warn({ externalUserId }, 'eBay deletion request logged; no matching channel account');
    return { deleted: false, reason: 'no_match' };
  }

  const counts: Record<string, number> = {};

  for (const acc of accounts) {
    const orderIds = (
      await Order.find({ channelAccountId: acc._id }, { _id: 1 }).lean()
    ).map((o) => o._id);

    counts.orders = (counts.orders || 0) + (await Order.deleteMany({ channelAccountId: acc._id }).then((r) => r.deletedCount || 0));
    if (orderIds.length) {
      counts.orderLines =
        (counts.orderLines || 0) +
        (await OrderLine.deleteMany({ orderId: { $in: orderIds } }).then((r) => r.deletedCount || 0));
      counts.labels =
        (counts.labels || 0) +
        (await ShippingLabel.deleteMany({ orderId: { $in: orderIds } }).then((r) => r.deletedCount || 0));
    }

    counts.audit =
      (counts.audit || 0) +
      (await AuditOrderLine.deleteMany({ channelAccountId: acc._id }).then((r) => r.deletedCount || 0));
    counts.inventory =
      (counts.inventory || 0) +
      (await InventoryLevel.deleteMany({ channelAccountId: acc._id }).then((r) => r.deletedCount || 0));
    counts.items =
      (counts.items || 0) +
      (await ItemExternal.deleteMany({ channelAccountId: acc._id, channel: 'ebay' }).then((r) => r.deletedCount || 0));
    counts.customers =
      (counts.customers || 0) +
      (await CustomerExternal.deleteMany({ channelAccountId: acc._id, channel: 'ebay' }).then((r) => r.deletedCount || 0));

    counts.channelAccounts =
      (counts.channelAccounts || 0) + (await ChannelAccount.deleteOne({ _id: acc._id }).then((r) => r.deletedCount || 0));
  }

  await DeletionRequest.updateOne(
    { _id: request._id },
    { status: 'completed', counts, completedAt: new Date() },
  ).exec();

  log.info({ externalUserId, counts }, 'eBay deletion completed');
  return { deleted: true, counts };
}


