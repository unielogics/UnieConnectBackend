import fetch from 'node-fetch';
import { config } from '../config/env';
import { getWmsCredentialHeaders } from './oms-wms-credentials.service';

export interface WmsInventoryBySku {
  inbound: number;
  received: number;
  available: number;
  orders: number;
  shippedToday: number;
  openAsnsCount?: number;
  receiving?: number;
}

/**
 * Fetch WMS inventory stats for given SKUs from UnieBackend internal API.
 * Returns a map of sku -> { inbound, received, available, orders, shippedToday, openAsnsCount, receiving }.
 */
export async function fetchWmsInventoryBySkus(params: {
  userId?: string;
  warehouseCode: string;
  skus: string[];
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<Record<string, WmsInventoryBySku>> {
  const { userId, warehouseCode, skus, log } = params;
  if (!config.wmsApiUrl || !warehouseCode?.trim() || !skus?.length) {
    return {};
  }
  const uniqueSkus = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
  if (uniqueSkus.length === 0) return {};
  try {
    const url = `${config.wmsApiUrl}/api/v1/internal/oms/items/inventory`;
    const credentialHeaders = userId
      ? await getWmsCredentialHeaders({ userId, warehouseCode: warehouseCode.trim() })
      : null;
    if (!credentialHeaders) return {};
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...credentialHeaders,
      },
      body: JSON.stringify({ warehouseCode: warehouseCode.trim(), skus: uniqueSkus }),
    });
    const data = (await res.json().catch(() => ({}))) as { inventory?: Record<string, WmsInventoryBySku> };
    return data.inventory || {};
  } catch (err) {
    log?.warn?.({ err, warehouseCode, skuCount: uniqueSkus.length }, 'Failed to fetch WMS inventory');
    return {};
  }
}
