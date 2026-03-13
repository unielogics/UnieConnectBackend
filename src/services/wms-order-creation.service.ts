import fetch from 'node-fetch';
import { config } from '../config/env';
import { routeOrderToClosestWarehouse } from './order-routing.service';

export interface CreateWmsOrderInput {
  userId: string;
  shippingAddress: {
    firstName?: string;
    lastName?: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
    phone?: string;
    email?: string;
  };
  lineItems: Array<{ sku: string; quantity: number; itemName?: string; unitPrice?: number }>;
  alternativeOrderNumber?: string;
  log?: { warn: (o: unknown, m: string) => void; info?: (o: unknown, m: string) => void };
}

/**
 * Route order to closest warehouse with inventory and create it in WMS.
 * Returns { orderId, orderNumber, warehouseCode } or null if routing/creation failed.
 */
export async function createOrderInWms(params: CreateWmsOrderInput): Promise<{
  orderId: string;
  orderNumber: string;
  warehouseCode: string;
} | null> {
  const { userId, shippingAddress, lineItems, alternativeOrderNumber, log } = params;
  if (!config.wmsApiUrl || !config.internalApiKey) return null;

  const shWithCoords = shippingAddress as typeof shippingAddress & { lat?: number; long?: number };
  const routeParams: Parameters<typeof routeOrderToClosestWarehouse>[0] = {
    userId,
    shippingAddress: (() => {
      const addr: Parameters<typeof routeOrderToClosestWarehouse>[0]['shippingAddress'] = {};
      if (shippingAddress.addressLine1 !== undefined) addr.addressLine1 = shippingAddress.addressLine1;
      if (shippingAddress.addressLine2 !== undefined) addr.addressLine2 = shippingAddress.addressLine2;
      if (shippingAddress.city !== undefined) addr.city = shippingAddress.city;
      if (shippingAddress.state !== undefined) addr.state = shippingAddress.state;
      if (shippingAddress.zipCode !== undefined) addr.zipCode = shippingAddress.zipCode;
      if (shippingAddress.country !== undefined) addr.country = shippingAddress.country;
      if (shWithCoords.lat !== undefined && Number.isFinite(shWithCoords.lat)) addr.lat = shWithCoords.lat;
      if (shWithCoords.long !== undefined && Number.isFinite(shWithCoords.long)) addr.long = shWithCoords.long;
      return addr;
    })(),
    lineItems,
    ...(log != null && { log: { warn: log.warn } }),
  };
  const routed = await routeOrderToClosestWarehouse(routeParams);
  if (!routed) return null;

  const customer = {
    firstName: shippingAddress.firstName || 'Customer',
    lastName: shippingAddress.lastName || '',
    email: shippingAddress.email,
    phone: shippingAddress.phone,
    addressLine1: shippingAddress.addressLine1,
    addressLine2: shippingAddress.addressLine2,
    city: shippingAddress.city,
    state: shippingAddress.state,
    zipCode: shippingAddress.zipCode,
    country: shippingAddress.country || 'USA',
  };

  try {
    const res = await fetch(`${config.wmsApiUrl}/api/v1/internal/oms/order/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': config.internalApiKey,
      },
      body: JSON.stringify({
        warehouseCode: routed.warehouseCode,
        omsIntermediaryId: routed.omsIntermediaryId,
        customer,
        lineItems,
        alternativeOrderNumber,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { orderId?: string; orderNumber?: string; error?: string };
    if (!res.ok) {
      log?.warn?.({ status: res.status, data }, 'WMS order create failed');
      return null;
    }
    if (!data.orderId || !data.orderNumber) return null;
    log?.info?.({ orderId: data.orderId, warehouseCode: routed.warehouseCode }, 'Order created in WMS');
    return {
      orderId: data.orderId,
      orderNumber: data.orderNumber,
      warehouseCode: routed.warehouseCode,
    };
  } catch (err) {
    log?.warn?.(err, 'WMS order create request failed');
    return null;
  }
}
