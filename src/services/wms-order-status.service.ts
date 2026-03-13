import { OmsIntermediary } from '../models/oms-intermediary';
import { User } from '../models/user';
import { Order } from '../models/order';
import { createShopifyFulfillment } from './shopify-fulfillment';
import type { FastifyBaseLogger } from 'fastify';

export interface WmsOrderStatusInput {
  wmsOrderId: string;
  wmsOrderNumber: string;
  omsIntermediaryId: string;
  status: string;
  alternativeOrderNumber?: string;
  trackingNumber?: string;
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
  const { omsIntermediaryId, status, alternativeOrderNumber, trackingNumber } = input;

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

  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        status: status === 'shipped' || status === 'completed' ? 'fulfilled' : status,
        syncedAt: new Date(),
      },
    }
  );

  if ((status === 'shipped' || status === 'completed') && (order as any).channel === 'shopify') {
    try {
      const fulfillParams: Parameters<typeof createShopifyFulfillment>[0] = {
        channelAccountId: String((order as any).channelAccountId),
        externalOrderId: (order as any).externalOrderId,
        log,
      };
      if (trackingNumber) fulfillParams.trackingNumber = trackingNumber;
      await createShopifyFulfillment(fulfillParams);
      log.info(
        {
          externalOrderId: (order as any).externalOrderId,
          wmsOrderNumber: input.wmsOrderNumber,
          trackingNumber,
        },
        'Shopify fulfillment created from WMS status'
      );
    } catch (err: any) {
      log.warn(
        { err: err?.message, externalOrderId: (order as any).externalOrderId },
        'Shopify fulfillment from WMS status failed (order status still updated)'
      );
    }
  }

  return { updated: true };
}
