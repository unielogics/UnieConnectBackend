import { OmsIntermediary } from '../models/oms-intermediary';
import { User } from '../models/user';
import { Order } from '../models/order';
import { normalizeWmsStatus } from '../lib/order-status-converter';
import { createShopifyFulfillment } from './shopify-fulfillment';
import { confirmAmazonShipment } from './amazon-fulfillment';
import type { FastifyBaseLogger } from 'fastify';

export interface WmsOrderStatusInput {
  wmsOrderId: string;
  wmsOrderNumber: string;
  omsIntermediaryId: string;
  status: string;
  alternativeOrderNumber?: string;
  trackingNumber?: string;
  trackingCompany?: string;
  trackingUrl?: string;
  shippedAt?: string | Date;
}

/**
 * Process WMS order status update. Updates OMS order and optionally pushes
 * fulfillment (Shopify/Amazon) when status is shipped.
 */
export async function processWmsOrderStatus(
  input: WmsOrderStatusInput,
  log: FastifyBaseLogger
): Promise<{ updated: boolean; error?: string }> {
  const { omsIntermediaryId, status, alternativeOrderNumber, trackingNumber, trackingCompany, trackingUrl, shippedAt } = input;

  const oms = await OmsIntermediary.findById(omsIntermediaryId).lean().exec();
  if (!oms) {
    return { updated: false, error: 'OMS intermediary not found' };
  }

  const user = await User.findOne({ email: (oms as any).email?.toLowerCase() }).lean().exec();
  if (!user) {
    return { updated: false, error: 'User not found for OMS intermediary' };
  }

  if (!alternativeOrderNumber?.trim()) {
    return { updated: false, error: 'alternativeOrderNumber required to match OMS order' };
  }

  const order = await Order.findOne({
    userId: user._id,
    externalOrderId: alternativeOrderNumber.trim(),
  })
    .lean()
    .exec();

  if (!order) {
    return { updated: false, error: `Order not found: externalOrderId=${alternativeOrderNumber}` };
  }

  const normalizedStatus = normalizeWmsStatus(status);
  const update: Record<string, unknown> = {
    wmsStatus: normalizedStatus,
    status: normalizedStatus,
    syncedAt: new Date(),
  };
  if (trackingNumber) update.wmsTrackingNumber = trackingNumber;
  if (shippedAt) update.wmsShippedAt = new Date(shippedAt);
  await Order.updateOne({ _id: order._id }, { $set: update });

  if (normalizedStatus === 'shipped' || normalizedStatus === 'completed') {
    const channel = (order as any).channel;
    const channelAccountId = String((order as any).channelAccountId);
    const externalOrderId = (order as any).externalOrderId;

    if (channel === 'shopify') {
      try {
        const fulfillParams: Parameters<typeof createShopifyFulfillment>[0] = {
          channelAccountId,
          externalOrderId,
          log,
        };
        if (trackingNumber) fulfillParams.trackingNumber = trackingNumber;
        if (trackingCompany) fulfillParams.trackingCompany = trackingCompany;
        if (trackingUrl) fulfillParams.trackingUrl = trackingUrl;
        await createShopifyFulfillment(fulfillParams);
        log.info(
          { externalOrderId, wmsOrderNumber: input.wmsOrderNumber, trackingNumber },
          'Shopify fulfillment created from WMS status'
        );
      } catch (err: any) {
        log.warn(
          { err: err?.message, externalOrderId },
          'Shopify fulfillment from WMS status failed (order status still updated)'
        );
      }
    } else if (channel === 'amazon') {
      try {
        const amazonParams: Parameters<typeof confirmAmazonShipment>[0] = {
          channelAccountId,
          orderId: externalOrderId,
          shippedAt: shippedAt ? new Date(shippedAt) : new Date(),
          log,
        };
        if (trackingNumber) amazonParams.trackingNumber = trackingNumber;
        if (trackingCompany) amazonParams.trackingCompany = trackingCompany;
        await confirmAmazonShipment(amazonParams);
        log.info(
          { externalOrderId, wmsOrderNumber: input.wmsOrderNumber, trackingNumber },
          'Amazon shipment confirmed from WMS status'
        );
      } catch (err: any) {
        log.warn(
          { err: err?.message, externalOrderId },
          'Amazon shipment confirmation failed (order status still updated)'
        );
      }
    }
  }

  return { updated: true };
}
