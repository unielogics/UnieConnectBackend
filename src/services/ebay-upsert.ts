import { Item } from '../models/item';
import { ItemExternal } from '../models/item-external';
import { InventoryLevel } from '../models/inventory-level';
import { Customer } from '../models/customer';
import { CustomerExternal } from '../models/customer-external';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';
import { upsertAuditFromEbay } from './audit-ingest';

export type UpsertContext = {
  channelAccountId: string;
  userId: string;
  log?: any;
  channel?: string;
  marketplaceId?: string;
  source?: string;
};

export async function upsertEbayInventoryItem(body: any, ctx: UpsertContext) {
  const { channelAccountId, userId, log } = ctx;
  const sku = (body?.sku || '').trim();
  if (!sku) return;

  const title = body?.product?.title || body?.title || sku;
  const quantity = num(body?.availability?.shipToLocationAvailability?.quantity);

  const item = await Item.findOneAndUpdate(
    { userId, sku },
    { userId, sku, title },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  await ItemExternal.findOneAndUpdate(
    { channelAccountId, channel: 'ebay', channelItemId: sku },
    {
      itemId: item._id,
      channelAccountId,
      channel: 'ebay',
      channelItemId: sku,
      sku,
      status: 'active',
      raw: body,
      syncedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  if (typeof quantity === 'number') {
    await InventoryLevel.findOneAndUpdate(
      { itemId: item._id, channelAccountId },
      { itemId: item._id, channelAccountId, available: quantity },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log?.info?.({ sku }, 'eBay inventory item upserted');
}

export async function upsertEbayOrder(body: any, ctx: UpsertContext) {
  const { channelAccountId, userId, log, marketplaceId, source, channel } = ctx;
  if (!body) return;
  const externalOrderId = String(body.orderId || body.legacyOrderId || body.purchaseOrderId || '');
  if (!externalOrderId) return;

  const pricing = body.pricingSummary || {};
  const currency =
    pricing?.total?.currency ||
    pricing?.priceSubtotal?.currency ||
    pricing?.deliveryCost?.shippingCost?.currency ||
    pricing?.subtotal?.currency;

  const totals = {
    subtotal: num(pricing?.subtotal?.value) ?? num(pricing?.priceSubtotal?.value),
    tax: num(pricing?.totalTax?.value),
    shipping: num(pricing?.deliveryCost?.shippingCost?.value),
    discounts: num(pricing?.discount?.value),
    total: num(pricing?.total?.value),
  };

  const customerId = await ensureCustomer(body, ctx);

  const order = await Order.findOneAndUpdate(
    { channelAccountId, externalOrderId },
    {
      userId,
      channelAccountId,
      channel: channel || 'ebay',
      marketplaceId,
      fulfillmentChannel: 'ebay',
      source: source || 'poll',
      externalOrderId,
      status: body.orderFulfillmentStatus || body.orderPaymentStatus || body.orderStatus || 'open',
      currency,
      totals,
      customerId: customerId || undefined,
      placedAt: body.creationDate ? new Date(body.creationDate) : undefined,
      closedAt: body.cancelledDate ? new Date(body.cancelledDate) : undefined,
      raw: body,
      syncedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  const lines = Array.isArray(body.lineItems) ? body.lineItems : [];
  for (const line of lines) {
    const lineItemId = line.lineItemId ? String(line.lineItemId) : undefined;
    const sku = (line.sku || line.legacySku || '').trim() || undefined;
    const title = line.title || line.itemTitle || sku || 'eBay item';
    const itemId = sku ? await ensureItemForSku(sku, title, ctx, lineItemId || line.itemId) : undefined;
    await OrderLine.findOneAndUpdate(
      { orderId: order._id, externalLineId: lineItemId },
      {
        orderId: order._id,
        itemId,
        sku,
        externalLineId: lineItemId,
        quantity: num(line.quantity) || 0,
        price:
          num(line.lineItemCost?.value) ??
          num(line.netPrice?.value) ??
          num(line.estimatedDeliveryCost?.value) ??
          num(line.originalPrice?.value),
        tax: num(line.totalTax?.value),
        discounts: num(line.discountAmount?.value),
        fulfillmentStatus: line.lineItemFulfillmentStatus || line.lineItemStatus,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  await upsertAuditFromEbay({
    userId,
    channelAccountId,
    log,
    orderDoc: order,
    rawOrder: body,
  });

  log?.info?.({ externalOrderId, lines: lines.length }, 'eBay order upserted');
}

async function ensureItemForSku(
  sku: string,
  title: string | undefined,
  ctx: UpsertContext,
  channelItemId?: string,
) {
  const { userId, channelAccountId } = ctx;
  const item = await Item.findOneAndUpdate(
    { userId, sku },
    { userId, sku, title: title || sku },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  await ItemExternal.findOneAndUpdate(
    { channelAccountId, channel: 'ebay', channelItemId: channelItemId || sku },
    {
      itemId: item._id,
      channelAccountId,
      channel: 'ebay',
      channelItemId: channelItemId || sku,
      sku,
      status: 'active',
      syncedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  return item._id;
}

async function ensureCustomer(body: any, ctx: UpsertContext) {
  const { channelAccountId, userId, log } = ctx;
  const buyer = body?.buyer || {};
  const email = buyer.email ? String(buyer.email).toLowerCase() : undefined;
  const phone = buyer?.taxAddress?.phoneNumber ? String(buyer.taxAddress.phoneNumber) : undefined;
  const externalId = buyer?.username ? String(buyer.username) : undefined;
  const nameFirst = buyer?.taxAddress?.firstName || buyer?.name?.firstName;
  const nameLast = buyer?.taxAddress?.lastName || buyer?.name?.lastName;
  const address = buyer?.taxAddress || buyer?.registrationAddress || body?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;

  const findConditions = [];
  if (email) findConditions.push({ email });
  if (phone) findConditions.push({ phone });

  let customer = findConditions.length
    ? await Customer.findOne({ userId, $or: findConditions }).exec()
    : null;

  if (!customer) {
    customer = await Customer.create({
      userId,
      email,
      phone,
      name: { first: nameFirst, last: nameLast || externalId },
      addresses: address
        ? [
            {
              line1: address.addressLine1,
              line2: address.addressLine2,
              city: address.city,
              region: address.stateOrProvince || address.county || address.region,
              postalCode: address.postalCode,
              country: address.countryCode,
            },
          ]
        : undefined,
    });
  }

  if (externalId) {
    await CustomerExternal.findOneAndUpdate(
      { channelAccountId, externalId },
      {
        customerId: customer._id,
        channel: 'ebay',
        raw: buyer,
        syncedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log?.info?.({ externalId }, 'eBay customer upserted');
  return customer?._id;
}

function num(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}


