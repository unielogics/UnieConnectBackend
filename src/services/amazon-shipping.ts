import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { ShippingLabel } from '../models/shipping-label';
import { spApiFetch } from './amazon-spapi';

type Address = {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  stateOrRegion: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
  email?: string;
};

type Package = {
  weight: { value: number; unit: 'g' | 'kg' | 'oz' | 'lb' };
  dimensions?: { length: number; width: number; height: number; unit: 'in' | 'cm' };
  declaredValue?: { value: number; unit: string; currencyCode?: string };
};

export async function getShippingRates(params: {
  channelAccountId: string;
  shipFrom: Address;
  shipTo: Address;
  packages: Package[];
  serviceTypes?: string[];
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, shipFrom, shipTo, packages, serviceTypes, log } = params;
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const body: any = {
    shipTo,
    shipFrom,
    packages,
  };
  if (serviceTypes && serviceTypes.length > 0) body.serviceTypes = serviceTypes;

  const res = await spApiFetch(account, {
    method: 'POST',
    path: '/shipping/v2/rates',
    body,
  });

  log.info({ channelAccountId, count: res?.payload?.rateOptions?.length || res?.rateOptions?.length || 0 }, 'amazon shipping rates fetched');
  return res;
}

export async function createShippingShipment(params: {
  channelAccountId: string;
  userId: string;
  orderId?: string;
  clientReferenceId: string;
  shipFrom: Address;
  shipTo: Address;
  packages: Package[];
  rateId: string;
  labelFormat?: 'PDF' | 'ZPL';
  labelSize?: string; // e.g., 4x6
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, userId, orderId, clientReferenceId, shipFrom, shipTo, packages, rateId, labelFormat, labelSize, log } = params;
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const body: any = {
    clientReferenceId,
    shipTo,
    shipFrom,
    packages,
    rateId,
  };

  body.requestedDocumentSpecification = {
    format: labelFormat || 'PDF',
  };
  if (labelSize) {
    body.requestedDocumentSpecification.size = labelSize;
  }

  const res = await spApiFetch(account, {
    method: 'POST',
    path: '/shipping/v2/shipments',
    body,
  });

  const shipmentId = res?.payload?.shipmentId || res?.shipmentId;
  const doc = res?.payload?.documents?.[0] || res?.documents?.[0];
  const downloadUrl = doc?.downloadUrl || doc?.downloadURL;
  const docFormat = doc?.format || doc?.pageSize || labelFormat;
  const expiresAt = doc?.expiresAt ? new Date(doc.expiresAt) : undefined;
  const docData = doc?.contents?.data;
  const mimeType = doc?.contents?.contentType;

  if (shipmentId) {
    await ShippingLabel.findOneAndUpdate(
      { channelAccountId, shipmentId },
      {
        userId,
        channelAccountId,
        channel: 'amazon',
        marketplaceId: (account.marketplaceIds || [])[0],
        orderId,
        shipmentId,
        labelFormat: docFormat,
        downloadUrl,
        document: docData,
        mimeType,
        expiresAt,
        raw: res,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  }

  log.info({ channelAccountId, shipmentId, rateId }, 'amazon shipping shipment created');
  return res;
}

export async function fetchShippingLabel(params: {
  channelAccountId: string;
  userId: string;
  shipmentId: string;
  orderId?: string;
  format?: string; // e.g., ZPL, PDF
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, userId, shipmentId, orderId, format, log } = params;
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');

  const res = await spApiFetch(account, {
    method: 'GET',
    path: `/shipping/v2/shipments/${encodeURIComponent(shipmentId)}/documents`,
    query: {
      documentType: 'LABEL',
      pageSize: format || 'PDF',
    },
  });

  const doc = res?.payload?.documents?.[0] || res?.documents?.[0];
  const downloadUrl = doc?.downloadUrl || doc?.downloadURL;
  const docFormat = doc?.format || doc?.pageSize || format;
  const expiresAt = doc?.expiresAt ? new Date(doc.expiresAt) : undefined;
  const docData = doc?.contents?.data;
  const mimeType = doc?.contents?.contentType;

  await ShippingLabel.findOneAndUpdate(
    { channelAccountId, shipmentId },
    {
      userId,
      channelAccountId,
      channel: 'amazon',
      marketplaceId: (account.marketplaceIds || [])[0],
      orderId,
      shipmentId,
      labelFormat: docFormat,
      downloadUrl,
      document: docData,
      mimeType,
      expiresAt,
      raw: res,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  log.info({ channelAccountId, shipmentId }, 'amazon shipping label fetched');
  return res;
}


