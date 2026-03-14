import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';
import { spApiFetch } from './amazon-spapi';

type FulfillmentItem = {
  sellerSku: string;
  quantity: number;
  sellerFulfillmentOrderItemId?: string;
  declaredValue?: { value: number; currencyCode: string };
};

type DestinationAddress = {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  stateOrRegion: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
};

export async function createFulfillmentOrder(params: {
  channelAccountId: string;
  displayableOrderId: string;
  displayableOrderDateTime?: string;
  displayableOrderComment?: string;
  shippingSpeedCategory: 'Standard' | 'Expedited' | 'Priority';
  destinationAddress: DestinationAddress;
  items: FulfillmentItem[];
  marketplaceId?: string;
  log: FastifyBaseLogger;
}) {
  const {
    channelAccountId,
    displayableOrderId,
    displayableOrderDateTime,
    displayableOrderComment,
    shippingSpeedCategory,
    destinationAddress,
    items,
    marketplaceId,
    log,
  } = params;

  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const body = {
    marketplaceId: marketplaceId || (account.marketplaceIds || [])[0],
    displayableOrderId,
    displayableOrderDateTime: displayableOrderDateTime || new Date().toISOString(),
    displayableOrderComment: displayableOrderComment || 'Order created via UnieConnect',
    shippingSpeedCategory,
    destinationAddress,
    items: items.map((item) => ({
      sellerSku: item.sellerSku,
      sellerFulfillmentOrderItemId: item.sellerFulfillmentOrderItemId || `${displayableOrderId}-${item.sellerSku}`,
      quantity: item.quantity,
      perUnitDeclaredValue: item.declaredValue,
    })),
  };

  const res = await spApiFetch(account, {
    method: 'POST',
    path: '/fba/outbound/2020-07-01/fulfillmentOrders',
    body,
  });

  log.info({ channelAccountId, displayableOrderId }, 'amazon fulfillment order created');
  return res;
}

/** Map carrier name to Amazon SP-API carrier code */
function carrierNameToCode(name?: string): string {
  const s = (name || '').toLowerCase();
  if (s.includes('ups')) return 'UPS';
  if (s.includes('fedex') || s.includes('fed ex')) return 'FedEx';
  if (s.includes('usps') || s.includes('us postal')) return 'USPS';
  if (s.includes('dhl')) return 'DHL';
  if (s.includes('ontrac')) return 'OnTrac';
  return 'Other';
}

/**
 * Confirm shipment for an MFN (Merchant Fulfilled Network) Amazon order.
 * Updates the order with tracking and marks it as shipped.
 */
export async function confirmAmazonShipment(params: {
  channelAccountId: string;
  orderId: string;
  trackingNumber?: string;
  trackingCompany?: string;
  shippedAt?: Date;
  orderDocId?: string;
  log: FastifyBaseLogger;
}): Promise<void> {
  const {
    channelAccountId,
    orderId,
    trackingNumber,
    trackingCompany,
    shippedAt = new Date(),
    log,
  } = params;

  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const marketplaceId = (account.marketplaceIds || [])[0];
  if (!marketplaceId) throw new Error('No marketplaceId for Amazon account');

  const orderDoc = await Order
    .findOne({ channelAccountId, externalOrderId: orderId })
    .select('_id')
    .lean()
    .exec();
  if (!orderDoc) throw new Error(`Order not found: ${orderId}`);

  const lines = await OrderLine.find({ orderId: orderDoc._id })
    .select('externalLineId quantity')
    .lean()
    .exec();

  const orderItems = lines
    .filter((l) => l.externalLineId && l.quantity > 0)
    .map((l) => ({
      orderItemId: l.externalLineId!,
      quantity: Math.floor(l.quantity) || 1,
    }));

  if (orderItems.length === 0) {
    throw new Error(`No order items found for order ${orderId}`);
  }

  const carrierCode = carrierNameToCode(trackingCompany);
  const body: Record<string, unknown> = {
    marketplaceId,
    packageDetail: {
      carrierCode,
      carrierName: trackingCompany || carrierCode,
      trackingNumber: trackingNumber || undefined,
      shipDate: shippedAt.toISOString(),
      orderItems,
    },
  };

  await spApiFetch(account, {
    method: 'POST',
    path: `/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`,
    body,
  });

  log.info({ channelAccountId, orderId, trackingNumber }, 'amazon shipment confirmed');
}
















