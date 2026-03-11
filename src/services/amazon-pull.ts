import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { Item } from '../models/item';
import { ItemExternal } from '../models/item-external';
import { InventoryLevel } from '../models/inventory-level';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';
import { Customer } from '../models/customer';
import { CustomerExternal } from '../models/customer-external';
import { spApiFetch } from './amazon-spapi';
import { setSyncStatus } from './channel-sync-status';
import { upsertAuditFromAmazon } from './audit-ingest';

type PullResult = { products?: number; orders?: number; inventory?: number };

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_3 = 90;

export async function pullAmazonAll(
  channelAccountId: string,
  log: FastifyBaseLogger,
  opts?: { initialSync?: boolean },
): Promise<PullResult> {
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) {
    log.warn({ channelAccountId }, 'amazon pull skipped: account not found');
    return {};
  }
  if (account.channel !== 'amazon') {
    log.info({ channelAccountId }, 'amazon pull skipped: non-amazon channel');
    return {};
  }

  const marketplaceIds = Array.isArray(account.marketplaceIds) ? account.marketplaceIds : [];
  if (marketplaceIds.length === 0) {
    log.warn({ channelAccountId }, 'amazon pull skipped: no marketplaceIds on account');
    return {};
  }

  const result: PullResult = {};
  const userId = account.userId.toString();
  const marketplaceId = marketplaceIds[0];
  const initialSync = opts?.initialSync === true;

  // Products + Inventory from FBA Inventory Summaries (paginated)
  await setSyncStatus(channelAccountId, 'products', 'syncing');
  let totalProducts = 0;
  let invNextToken: string | undefined;
  const startDateTime = new Date(Date.now() - 180 * MS_PER_DAY).toISOString(); // 180 days for FBA
  do {
    const invQuery: Record<string, string | number | boolean | string[] | undefined> = {
      granularityType: 'Marketplace',
      granularityId: marketplaceId,
      marketplaceIds: marketplaceId,
      details: true,
      startDateTime,
    };
    if (invNextToken) invQuery.nextToken = invNextToken;
    const invRes = await spApiFetch(account, {
      method: 'GET',
      path: '/fba/inventory/v1/summaries',
      query: invQuery,
    });
    const summaries = invRes?.payload?.inventorySummaries ?? invRes?.inventorySummaries ?? [];
    for (const s of Array.isArray(summaries) ? summaries : []) {
      const sku = String(s?.sellerSku ?? s?.sku ?? '').trim();
      if (!sku) continue;
      const asin = s?.asin ? String(s.asin) : sku;
      const qty = Number(s?.totalQuantity ?? s?.inventoryDetails?.fulfillableQuantity ?? s?.inventoryDetails?.availableQuantity ?? 0) || 0;
      const item = await Item.findOneAndUpdate(
        { userId: account.userId, sku },
        { userId: account.userId, sku, title: sku, asin: asin !== sku ? asin : undefined },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
      await ItemExternal.findOneAndUpdate(
        { channelAccountId, channel: 'amazon', channelItemId: asin, channelVariantId: sku },
        { itemId: item._id, channel: 'amazon', sku, status: 'active', raw: s, syncedAt: new Date() },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
      await InventoryLevel.findOneAndUpdate(
        { itemId: item._id, channelAccountId, locationId: marketplaceId },
        { itemId: item._id, channelAccountId, locationId: marketplaceId, available: qty },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
      totalProducts += 1;
    }
    invNextToken = invRes?.pagination?.nextToken ?? invRes?.nextToken;
  } while (invNextToken);
  result.products = totalProducts;
  await setSyncStatus(channelAccountId, 'products', 'synced', { count: totalProducts });
  result.inventory = totalProducts;
  await setSyncStatus(channelAccountId, 'inventory', 'synced', { count: totalProducts });

  // Orders - 3 months on initial sync, 2 days on subsequent
  const orderDays = initialSync ? DAYS_3 : 2;
  const createdAfter = new Date(Date.now() - orderDays * MS_PER_DAY).toISOString();

  await setSyncStatus(channelAccountId, 'orders', 'syncing');
  const orders: any[] = [];
  let nextToken: string | undefined;
  do {
    const ordersQuery: Record<string, string | number | boolean | Array<string | number> | undefined> | undefined = nextToken
      ? { NextToken: nextToken }
      : {
          MarketplaceIds: marketplaceIds,
          CreatedAfter: createdAfter,
          OrderStatuses: ['Unshipped', 'PartiallyShipped', 'Shipped', 'Unfulfillable'],
          FulfillmentChannels: ['MFN', 'AFN'],
        };

    const orderReq: any = {
      method: 'GET',
      path: '/orders/v0/orders',
    };
    if (ordersQuery) orderReq.query = ordersQuery;

    const ordersRes = await spApiFetch(account, orderReq);
    const pageOrders = ordersRes?.payload?.Orders || ordersRes?.Orders || [];
    orders.push(...pageOrders);
    nextToken = ordersRes?.payload?.NextToken || ordersRes?.NextToken || undefined;
  } while (nextToken);

  for (const order of orders) {
    const amazonOrderId = order.AmazonOrderId;
    if (!amazonOrderId) continue;

    const items: any[] = [];
    let itemsNext: string | undefined;
    do {
      const itemsQuery: Record<string, string | number | boolean | Array<string | number> | undefined> | undefined = itemsNext
        ? { NextToken: itemsNext }
        : undefined;

      const itemsReq: any = {
        method: 'GET',
        path: `/orders/v0/orders/${encodeURIComponent(amazonOrderId)}/orderItems`,
      };
      if (itemsQuery) itemsReq.query = itemsQuery;

      const itemsRes = await spApiFetch(account, itemsReq);
      const pageItems = itemsRes?.payload?.OrderItems || itemsRes?.OrderItems || [];
      items.push(...pageItems);
      itemsNext = itemsRes?.payload?.NextToken || itemsRes?.NextToken || undefined;
    } while (itemsNext);

    const upsertCtx: {
      channelAccountId: string;
      userId: string;
      log: FastifyBaseLogger;
      marketplaceId?: string;
    } = {
      channelAccountId,
      userId: account.userId.toString(),
      log,
    };
    if (marketplaceIds[0]) upsertCtx.marketplaceId = marketplaceIds[0];

    await upsertOrderWithItems(order, items, upsertCtx);
  }

  return { orders: orders.length };
}

async function upsertOrderWithItems(
  order: any,
  items: any[],
  ctx: { channelAccountId: string; userId: string; log: FastifyBaseLogger; marketplaceId?: string },
) {
  const { channelAccountId, userId, log, marketplaceId } = ctx;
  const externalOrderId = String(order.AmazonOrderId || '');
  if (!externalOrderId) return;

  const customerId = await ensureCustomer(order, { channelAccountId, userId, log });
  const currency = order?.OrderTotal?.CurrencyCode;
  const totals = {
    total: num(order?.OrderTotal?.Amount),
    shipping: num(order?.ShippingPrice?.Amount),
    tax: num(order?.Tax?.Amount),
    discounts: num(order?.PromotionDiscount?.Amount),
    subtotal: undefined as number | undefined,
  };

  const orderDoc = await Order.findOneAndUpdate(
    { channelAccountId, externalOrderId },
    {
      userId,
      channelAccountId,
      channel: 'amazon',
      marketplaceId,
      fulfillmentChannel: order?.FulfillmentChannel,
      source: 'poll',
      externalOrderId,
      status: order?.OrderStatus || 'Pending',
      currency,
      totals,
      placedAt: order?.PurchaseDate ? new Date(order.PurchaseDate) : undefined,
      closedAt: order?.LatestDeliveryDate ? new Date(order.LatestDeliveryDate) : undefined,
      raw: order,
      syncedAt: new Date(),
      customerId: customerId || undefined,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  for (const line of items) {
    const externalLineId = String(line?.OrderItemId || '');
    await OrderLine.findOneAndUpdate(
      { orderId: orderDoc._id, externalLineId },
      {
        orderId: orderDoc._id,
        externalLineId,
        sku: line?.SellerSKU,
        quantity: num(line?.QuantityOrdered) || 0,
        price: num(line?.ItemPrice?.Amount),
        tax: num(line?.ItemTax?.Amount),
        discounts: num(line?.PromotionDiscount?.Amount),
        fulfillmentStatus: line?.ShipmentStatus || order?.OrderStatus,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  // Audit ingest
  await upsertAuditFromAmazon({
    userId,
    channelAccountId,
    log,
    orderDoc,
    rawOrder: order,
    items,
  });

  log.info({ externalOrderId, lines: items.length }, 'amazon order upserted');
}

function num(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function ensureCustomer(order: any, ctx: { channelAccountId: string; userId: string; log: FastifyBaseLogger }) {
  const { channelAccountId, userId, log } = ctx;
  const buyerEmail = order?.BuyerInfo?.BuyerEmail;
  const buyerName = order?.BuyerInfo?.BuyerName;
  const shipTo = order?.ShippingAddress || {};

  const email = buyerEmail ? String(buyerEmail).toLowerCase() : undefined;
  const phone = shipTo?.Phone ? String(shipTo.Phone) : undefined;
  const externalId = order?.BuyerInfo?.BuyerId || order?.AmazonOrderId;

  let customer = await Customer.findOne({
    userId,
    $or: [{ email }, { phone }],
  }).exec();

  if (!customer) {
    customer = await Customer.create({
      userId,
      email,
      phone,
      name: buyerName
        ? {
            first: buyerName.split(' ')[0],
            last: buyerName.split(' ').slice(1).join(' ') || undefined,
          }
        : undefined,
      addresses: [
        {
          line1: shipTo?.AddressLine1,
          line2: shipTo?.AddressLine2,
          city: shipTo?.City,
          region: shipTo?.StateOrRegion,
          postalCode: shipTo?.PostalCode,
          country: shipTo?.CountryCode,
        },
      ].filter(
        (addr) =>
          addr.line1 ||
          addr.line2 ||
          addr.city ||
          addr.region ||
          addr.postalCode ||
          addr.country,
      ),
    });
  } else if (shipTo?.AddressLine1) {
    // Update addresses best-effort
    await Customer.updateOne(
      { _id: customer._id },
      {
        $setOnInsert: { addresses: [] },
        $push: {
          addresses: {
            line1: shipTo?.AddressLine1,
            line2: shipTo?.AddressLine2,
            city: shipTo?.City,
            region: shipTo?.StateOrRegion,
            postalCode: shipTo?.PostalCode,
            country: shipTo?.CountryCode,
          },
        },
      },
    ).exec();
  }

  if (externalId && customer?._id) {
    await CustomerExternal.findOneAndUpdate(
      { channelAccountId, externalId },
      {
        customerId: customer._id,
        channel: 'amazon',
        externalId,
        raw: order?.BuyerInfo,
        syncedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log.info({ externalId }, 'amazon customer upserted');
  return customer?._id;
}


