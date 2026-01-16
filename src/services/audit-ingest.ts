import { FastifyBaseLogger } from 'fastify';
import { AuditOrderLine } from '../models/audit-order-line';
import { ShippingLabel } from '../models/shipping-label';

type ShipTo = { city?: string; state?: string; postalCode?: string; country?: string };

function hasAddress(shipTo?: ShipTo) {
  return Boolean(shipTo?.city && shipTo?.state && shipTo?.postalCode);
}

function dataQuality(shipTo: ShipTo | undefined, shippingLabelPresent?: boolean) {
  const reasons: string[] = [];
  if (!hasAddress(shipTo)) reasons.push('missing_address');
  if (!shippingLabelPresent) reasons.push('missing_label');
  return { status: reasons.length ? 'excluded' : 'valid', reasons };
}

function sumCosts(costs?: { fulfillment?: number; label?: number; prep?: number; thirdParty?: number }) {
  if (!costs) return undefined;
  const total = ['fulfillment', 'label', 'prep', 'thirdParty']
    .map((k) => (costs as any)[k])
    .filter((v) => Number.isFinite(v))
    .reduce((a, b) => a + Number(b), 0);
  return Number.isFinite(total) ? total : undefined;
}

const MIN_PREP_FEE = 0; // configure if you need >0 default

function prepValue(prep?: number) {
  if (Number.isFinite(prep)) return Number(prep);
  return MIN_PREP_FEE;
}

export async function upsertAuditFromAmazon(params: {
  userId: string;
  channelAccountId: string;
  log: FastifyBaseLogger;
  orderDoc: any;
  rawOrder: any;
  items: any[];
}) {
  const { userId, channelAccountId, log, orderDoc, rawOrder, items } = params;
  const shipTo: ShipTo = {
    city: rawOrder?.ShippingAddress?.City,
    state: rawOrder?.ShippingAddress?.StateOrRegion,
    postalCode: rawOrder?.ShippingAddress?.PostalCode,
    country: rawOrder?.ShippingAddress?.CountryCode,
  };
  const shippingLabelPresent = Boolean(
    await ShippingLabel.exists({ orderId: orderDoc._id }).lean().exec(),
  );

  for (const line of items) {
    const sku = line?.SellerSKU || undefined;
    const quantity = Number(line?.QuantityOrdered) || 0;
    const weightLbs = line?.PackageWeight?.Value && line?.PackageWeight?.Unit === 'LB'
      ? Number(line.PackageWeight.Value)
      : undefined;

    const costs = {
      fulfillment: Number(rawOrder?.ShippingPrice?.Amount) || undefined,
      label: undefined,
      prep: prepValue(undefined),
      thirdParty: undefined,
    };
    const originalCostTotal = sumCosts(costs);

    const dq = dataQuality(shipTo, shippingLabelPresent);

    await AuditOrderLine.findOneAndUpdate(
      { userId, orderExternalId: String(rawOrder?.AmazonOrderId || ''), sku },
      {
        userId,
        channelAccountId,
        channel: 'amazon',
        marketplaceId: rawOrder?.MarketplaceId,
        fulfillmentChannel: rawOrder?.FulfillmentChannel,
        source: 'poll',
        orderId: orderDoc?._id,
        orderExternalId: String(rawOrder?.AmazonOrderId || ''),
        orderDate: rawOrder?.PurchaseDate ? new Date(rawOrder.PurchaseDate) : undefined,
        sku,
        itemName: line?.Title,
        quantity,
        weightLbs,
        itemCount: quantity || 1,
        shipTo,
        costs,
        prepFeeRequired: true,
        dataQualityStatus: dq.status,
        dataQualityReasons: dq.reasons,
        originalCostTotal,
        optimizedCostTotal: undefined,
        savingsPct: undefined,
        savingsEnabled: true,
        rateShoppingQuoteRef: undefined,
        chosenWarehouseId: undefined,
        shipZone: undefined,
        hotStateRank: undefined,
        zoneClusterId: undefined,
        demandScore: undefined,
        coverageFlags: {},
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log.info({ orderId: rawOrder?.AmazonOrderId, lines: items.length }, 'audit lines upserted (amazon)');
}

export async function upsertAuditFromShopify(params: {
  userId: string;
  channelAccountId: string;
  log: FastifyBaseLogger;
  orderDoc: any;
  rawOrder: any;
}) {
  const { userId, channelAccountId, log, orderDoc, rawOrder } = params;
  const shipAddr = rawOrder?.shipping_address || {};
  const shipTo: ShipTo = {
    city: shipAddr?.city,
    state: shipAddr?.province || shipAddr?.province_code,
    postalCode: shipAddr?.zip,
    country: shipAddr?.country_code || shipAddr?.country,
  };
  const shippingLines = Array.isArray(rawOrder?.shipping_lines) ? rawOrder.shipping_lines : [];
  const shippingLabelPresent =
    Boolean(await ShippingLabel.exists({ orderId: orderDoc._id }).lean().exec()) ||
    shippingLines.length > 0;

  const lines = Array.isArray(rawOrder?.line_items) ? rawOrder.line_items : [];
  for (const line of lines) {
    const sku = line?.sku || undefined;
    const quantity = Number(line?.quantity) || 0;
    const grams = Number(line?.grams);
    const weightLbs = Number.isFinite(grams) ? grams / 453.592 : undefined;

    const costs = {
      fulfillment: Number(rawOrder?.total_shipping_price_set?.shop_money?.amount) ||
        shippingLines.reduce((sum: number, s: any) => sum + (Number(s.price) || 0), 0) ||
        undefined,
      label: undefined,
      prep: prepValue(undefined),
      thirdParty: undefined,
    };
    const originalCostTotal = sumCosts(costs);
    const dq = dataQuality(shipTo, shippingLabelPresent);

    await AuditOrderLine.findOneAndUpdate(
      { userId, orderExternalId: String(rawOrder?.id || ''), sku },
      {
        userId,
        channelAccountId,
        channel: 'shopify',
        marketplaceId: undefined,
        fulfillmentChannel: 'shopify',
        source: 'poll',
        orderId: orderDoc?._id,
        orderExternalId: String(rawOrder?.id || ''),
        orderDate: rawOrder?.created_at ? new Date(rawOrder.created_at) : undefined,
        sku,
        itemName: line?.name,
        quantity,
        weightLbs,
        itemCount: quantity || 1,
        shipTo,
        costs,
        prepFeeRequired: true,
        dataQualityStatus: dq.status,
        dataQualityReasons: dq.reasons,
        originalCostTotal,
        optimizedCostTotal: undefined,
        savingsPct: undefined,
        savingsEnabled: true,
        rateShoppingQuoteRef: undefined,
        chosenWarehouseId: undefined,
        shipZone: undefined,
        hotStateRank: undefined,
        zoneClusterId: undefined,
        demandScore: undefined,
        coverageFlags: {},
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log?.info?.({ orderId: rawOrder?.id, lines: lines.length }, 'audit lines upserted (shopify)');
}

export async function upsertAuditFromEbay(params: {
  userId: string;
  channelAccountId: string;
  log: FastifyBaseLogger;
  orderDoc: any;
  rawOrder: any;
}) {
  const { userId, channelAccountId, log, orderDoc, rawOrder } = params;
  const shipToRaw =
    rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo ||
    rawOrder?.fulfillmentStartInstructions?.[0]?.shippingStep?.shippingTo ||
    rawOrder?.buyer?.taxAddress ||
    rawOrder?.buyer?.registrationAddress ||
    {};
  const shipTo: ShipTo = {
    city: shipToRaw?.city,
    state: shipToRaw?.stateOrProvince || shipToRaw?.region,
    postalCode: shipToRaw?.postalCode,
    country: shipToRaw?.countryCode,
  };

  const shippingLabelPresent = Boolean(await ShippingLabel.exists({ orderId: orderDoc._id }).lean().exec());

  const lines = Array.isArray(rawOrder?.lineItems) ? rawOrder.lineItems : [];
  for (const line of lines) {
    const sku = (line?.sku || line?.legacySku || '').trim() || undefined;
    const quantity = Number(line?.quantity) || 0;
    const weightLbs = undefined; // eBay line items typically lack weight; can be enriched later

    const costs = {
      fulfillment:
        Number(rawOrder?.pricingSummary?.deliveryCost?.shippingCost?.value) ||
        Number(line?.estimatedDeliveryCost?.value) ||
        undefined,
      label: undefined,
      prep: prepValue(undefined),
      thirdParty: undefined,
    };
    const originalCostTotal = sumCosts(costs);
    const dq = dataQuality(shipTo, shippingLabelPresent);

    await AuditOrderLine.findOneAndUpdate(
      { userId, orderExternalId: String(rawOrder?.orderId || rawOrder?.legacyOrderId || ''), sku },
      {
        userId,
        channelAccountId,
        channel: 'ebay',
        marketplaceId: rawOrder?.marketplaceId,
        fulfillmentChannel: 'ebay',
        source: 'poll',
        orderId: orderDoc?._id,
        orderExternalId: String(rawOrder?.orderId || rawOrder?.legacyOrderId || ''),
        orderDate: rawOrder?.creationDate ? new Date(rawOrder.creationDate) : undefined,
        sku,
        itemName: line?.title || line?.itemTitle,
        quantity,
        weightLbs,
        itemCount: quantity || 1,
        shipTo,
        costs,
        prepFeeRequired: true,
        dataQualityStatus: dq.status,
        dataQualityReasons: dq.reasons,
        originalCostTotal,
        optimizedCostTotal: undefined,
        savingsPct: undefined,
        savingsEnabled: true,
        rateShoppingQuoteRef: undefined,
        chosenWarehouseId: undefined,
        shipZone: undefined,
        hotStateRank: undefined,
        zoneClusterId: undefined,
        demandScore: undefined,
        coverageFlags: {},
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log?.info?.({ orderId: rawOrder?.orderId, lines: lines.length }, 'audit lines upserted (ebay)');
}


