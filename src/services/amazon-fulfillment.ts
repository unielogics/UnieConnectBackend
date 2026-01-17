import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
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







