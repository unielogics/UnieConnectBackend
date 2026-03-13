import fetch from 'node-fetch';
import { config } from '../config/env';
import { OmsIntermediary } from '../models/oms-intermediary';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';
import { User } from '../models/user';

export interface WmsItemActivities {
  summary?: {
    inbound: number;
    active: number;
    processing: number;
    shipped: number;
    ordersToday: number;
    ordersLast7Days: number;
  };
  activityLogs?: Array<{
    id: string;
    timestamp: string;
    action: string;
    userName: string;
    details?: unknown;
    entityType?: string;
    entityNumber?: string;
  }>;
  asns?: Array<{
    id: string;
    asnNumber: string;
    status: string;
    receivedQuantity?: number;
    createdAt?: string;
  }>;
  orders?: Array<{
    id: string;
    orderNumber: string;
    status: string;
    createdAt?: string;
    actualShipDate?: string;
    quantity: number;
    quantityShipped: number;
  }>;
  tasks?: Array<{
    id: string;
    type: string;
    status: string;
    priority?: string;
    createdAt?: string;
    completedAt?: string;
  }>;
}

/**
 * Fetch WMS item activities for an OMS item (by SKU) when user has warehouse connection.
 */
export async function fetchWmsItemActivities(params: {
  userId: string;
  sku: string;
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<WmsItemActivities | null> {
  const { userId, sku, log } = params;
  if (!config.wmsApiUrl || !config.internalApiKey || !sku?.trim()) return null;

  const user = await User.findById(userId).select('email').lean().exec();
  if (!user?.email) return null;

  const oms = await OmsIntermediary.findOne({
    email: (user.email as string).toLowerCase(),
    status: 'active',
  })
    .select('_id')
    .lean()
    .exec();
  if (!oms?._id) return null;

  const link = await OmsIntermediaryWarehouse.findOne({ omsIntermediaryId: oms._id }).lean().exec();
  if (!link?.warehouseCode) return null;

  try {
    const url = `${config.wmsApiUrl}/api/v1/internal/oms/items/activities`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': config.internalApiKey,
      },
      body: JSON.stringify({ warehouseCode: link.warehouseCode, sku: sku.trim() }),
    });
    if (!res.ok) return null;
    return (await res.json()) as WmsItemActivities;
  } catch (err) {
    log?.warn?.({ err, sku, warehouseCode: link.warehouseCode }, 'Failed to fetch WMS item activities');
    return null;
  }
}
