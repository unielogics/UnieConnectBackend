import { Item } from '../models/item';
import { ItemExternal } from '../models/item-external';
import { InventoryLevel } from '../models/inventory-level';
import { Customer } from '../models/customer';
import { CustomerExternal } from '../models/customer-external';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';

export type UpsertContext = {
  channelAccountId: string;
  userId: string;
  log?: any;
  channel?: string;
  marketplaceId?: string;
  source?: string;
};

export async function upsertProduct(body: any, ctx: UpsertContext) {
  if (!body || !body.variants) return;
  const { channelAccountId, userId, log } = ctx;
  const variants = Array.isArray(body.variants) ? body.variants : [];
  const productId = String(body.id || '');
  const title = String(body.title || '');

  for (const variant of variants) {
    const variantId = String(variant.id || '');
    const sku = (variant.sku || '').trim();
    if (!sku) {
      log?.warn?.({ variantId, productId }, 'Shopify product variant missing SKU, skipping');
      continue;
    }

    const item = await Item.findOneAndUpdate(
      { userId, sku },
      {
        userId,
        sku,
        title: variant.title ? `${title} - ${variant.title}` : title || sku,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();

    await ItemExternal.findOneAndUpdate(
      {
        channelAccountId,
        channelItemId: productId,
        channelVariantId: variantId,
      },
      {
        itemId: item._id,
        channel: 'shopify',
        sku,
        status: body.status === 'active' ? 'active' : 'inactive',
        raw: variant,
        syncedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log?.info?.({ productId, variants: variants.length }, 'Shopify product upserted');
}

export async function upsertInventory(body: any, ctx: UpsertContext) {
  const { channelAccountId, log } = ctx;
  const { inventory_item_id, available, location_id } = body || {};
  if (!inventory_item_id) return;
  const mapping = await ItemExternal.findOne({
    channelAccountId,
    channel: 'shopify',
    channelVariantId: String(inventory_item_id),
  }).exec();
  if (!mapping) {
    log?.warn?.({ inventory_item_id }, 'Inventory update skipped: variant mapping not found');
    return;
  }

  await InventoryLevel.findOneAndUpdate(
    {
      itemId: mapping.itemId,
      channelAccountId,
      locationId: location_id ? String(location_id) : undefined,
    },
    {
      itemId: mapping.itemId,
      channelAccountId,
      locationId: location_id ? String(location_id) : undefined,
      available: typeof available === 'number' ? available : 0,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  await ItemExternal.updateOne({ _id: mapping._id }, { syncedAt: new Date() }).exec();

  log?.info?.({ inventory_item_id, location_id }, 'Shopify inventory updated');
}

export async function upsertOrder(body: any, ctx: UpsertContext) {
  const { channelAccountId, userId, log, marketplaceId, source, channel } = ctx;
  if (!body || !body.id) return;
  const externalOrderId = String(body.id);
  const currency = body.currency;
  const totals = {
    subtotal: num(body.subtotal_price),
    tax: num(body.total_tax),
    shipping: shippingTotal(body),
    discounts: discountTotal(body),
    total: num(body.total_price),
  };

  const customerId = await ensureCustomer(body.customer, ctx);

  const order = await Order.findOneAndUpdate(
    { channelAccountId, externalOrderId },
    {
      userId,
      channelAccountId,
      channel: channel || 'shopify',
      marketplaceId,
      fulfillmentChannel: 'shopify',
      source: source || 'poll',
      externalOrderId,
      status: body.financial_status || 'open',
      currency,
      totals,
      customerId: customerId || undefined,
      placedAt: body.created_at ? new Date(body.created_at) : undefined,
      closedAt: body.closed_at ? new Date(body.closed_at) : undefined,
      raw: body,
      syncedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  const lines = Array.isArray(body.line_items) ? body.line_items : [];
  for (const line of lines) {
    const variantId = line.variant_id ? String(line.variant_id) : undefined;
    let itemId;
    if (variantId) {
      const map = await ItemExternal.findOne({
        channelAccountId,
        channel: 'shopify',
        channelVariantId: variantId,
      }).exec();
      if (map) itemId = map.itemId;
    }

    await OrderLine.findOneAndUpdate(
      { orderId: order._id, externalLineId: line.id ? String(line.id) : undefined },
      {
        orderId: order._id,
        itemId,
        sku: line.sku || undefined,
        externalLineId: line.id ? String(line.id) : undefined,
        quantity: num(line.quantity) || 0,
        price: num(line.price),
        tax: num(line.total_tax),
        discounts: line.total_discount ? num(line.total_discount) : undefined,
        fulfillmentStatus: line.fulfillment_status || undefined,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log?.info?.({ externalOrderId, lines: lines.length }, 'Shopify order upserted');
}

async function ensureCustomer(rawCustomer: any, ctx: UpsertContext) {
  if (!rawCustomer) return null;
  const { channelAccountId, userId, log } = ctx;
  const email = rawCustomer.email ? String(rawCustomer.email).toLowerCase() : undefined;
  const phone = rawCustomer.phone ? String(rawCustomer.phone) : undefined;
  const externalId = rawCustomer.id ? String(rawCustomer.id) : undefined;

  let customer = await Customer.findOne({
    userId,
    $or: [{ email }, { phone }],
  }).exec();

  if (!customer) {
    customer = await Customer.create({
      userId,
      email,
      phone,
      name: { first: rawCustomer.first_name, last: rawCustomer.last_name },
    });
  }

  if (externalId) {
    await CustomerExternal.findOneAndUpdate(
      { channelAccountId, externalId },
      {
        customerId: customer._id,
        channel: 'shopify',
        raw: rawCustomer,
        syncedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log?.info?.({ externalId }, 'Shopify customer upserted');
  return customer._id;
}

function num(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function shippingTotal(body: any): number | undefined {
  const shippingLines = Array.isArray(body?.shipping_lines) ? body.shipping_lines : [];
  const total = shippingLines.reduce((sum: number, s: any) => sum + (Number(s.price) || 0), 0);
  return Number.isFinite(total) ? total : undefined;
}

function discountTotal(body: any): number | undefined {
  const discounts = Array.isArray(body?.discount_applications) ? body.discount_applications : [];
  const total = discounts.reduce((sum: number, d: any) => sum + (Number(d.value) || 0), 0);
  return Number.isFinite(total) ? total : undefined;
}


