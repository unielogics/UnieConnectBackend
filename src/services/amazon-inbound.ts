import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { InboundShipment } from '../models/inbound-shipment';
import { spApiFetch } from './amazon-spapi';

type ShipFromAddress = {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  districtOrCounty?: string;
  phone?: string;
};

type InboundItem = {
  sellerSku: string;
  quantityShipped: number;
  quantityInCase?: number;
  prepDetailsList?: any[];
};

export async function createInboundPlan(params: {
  channelAccountId: string;
  shipFromAddress: ShipFromAddress;
  labelPrepPreference?: string;
  items: { sellerSku: string; quantity: number; asin?: string; condition?: string }[];
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, shipFromAddress, labelPrepPreference, items, log } = params;
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const body = {
    ShipFromAddress: shipFromAddress,
    LabelPrepPreference: labelPrepPreference || 'SELLER_LABEL',
    InboundShipmentPlanRequestItems: items.map((i) => ({
      SellerSKU: i.sellerSku,
      ASIN: i.asin,
      Condition: i.condition || 'NewItem',
      Quantity: i.quantity,
    })),
  };

  const res = await spApiFetch(account, {
    method: 'POST',
    path: '/fba/inbound/v0/plans',
    body,
  });

  log.info({ channelAccountId }, 'amazon inbound plan created');
  return res;
}

export async function createInboundShipment(params: {
  channelAccountId: string;
  userId: string;
  shipmentId: string;
  destinationFulfillmentCenterId: string;
  shipFromAddress: ShipFromAddress;
  labelPrepPreference?: string;
  shipmentName?: string;
  items: InboundItem[];
  log: FastifyBaseLogger;
}) {
  const {
    channelAccountId,
    userId,
    shipmentId,
    destinationFulfillmentCenterId,
    shipFromAddress,
    labelPrepPreference,
    shipmentName,
    items,
    log,
  } = params;

  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const body = {
    ShipmentId: shipmentId,
    InboundShipmentHeader: {
      ShipmentName: shipmentName || `Inbound ${shipmentId}`,
      ShipFromAddress: shipFromAddress,
      DestinationFulfillmentCenterId: destinationFulfillmentCenterId,
      LabelPrepPreference: labelPrepPreference || 'SELLER_LABEL',
      ShipmentStatus: 'WORKING',
    },
    InboundShipmentItems: items.map((i) => ({
      SellerSKU: i.sellerSku,
      QuantityShipped: i.quantityShipped,
      QuantityInCase: i.quantityInCase,
      PrepDetailsList: i.prepDetailsList,
    })),
  };

  const res = await spApiFetch(account, {
    method: 'POST',
    path: '/fba/inbound/v0/shipments',
    body,
  });

  await InboundShipment.findOneAndUpdate(
    { channelAccountId, shipmentId },
    {
      userId,
      channelAccountId,
      channel: 'amazon',
      marketplaceId: (account.marketplaceIds || [])[0],
      shipmentId,
      destinationFulfillmentCenterId,
      labelPrepPreference,
      shipmentName,
      items: items.map((i) => ({
        sellerSku: i.sellerSku,
        quantityShipped: i.quantityShipped,
        quantityInCase: i.quantityInCase,
        prepDetails: i.prepDetailsList,
      })),
      rawShipment: res,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  log.info({ channelAccountId, shipmentId }, 'amazon inbound shipment created');
  return res;
}

export async function getInboundLabels(params: {
  channelAccountId: string;
  shipmentId: string;
  pageType?: string;
  labelType?: string;
  numberOfPackages?: number;
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, shipmentId, pageType, labelType, numberOfPackages, log } = params;
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const res = await spApiFetch(account, {
    method: 'GET',
    path: `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/labels`,
    query: {
      PageType: pageType || 'PackageLabel_Letter',
      LabelType: labelType,
      NumberOfPackages: numberOfPackages,
    },
  });

  const labelUrl = res?.payload?.TransportDocument?.PdfDocument || res?.payload?.DownloadURL || res?.DownloadURL;

  await InboundShipment.updateOne(
    { channelAccountId, shipmentId },
    {
      labels: {
        url: labelUrl,
        pageType: pageType || 'PackageLabel_Letter',
        labelType,
        fetchedAt: new Date(),
      },
    },
  ).exec();

  log.info({ channelAccountId, shipmentId }, 'amazon inbound labels fetched');
  return res;
}


