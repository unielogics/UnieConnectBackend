import fetch from 'node-fetch';
import { config } from '../config/env';

export interface WmsInventoryBySku {
  inbound: number;
  received: number;
  available: number;
  orders: number;
  shippedToday: number;
}

/**
 * Fetch WMS inventory stats for given SKUs from UnieBackend internal API.
 * Returns a map of sku -> { inbound, received, available, orders, shippedToday }.
 */
export async function fetchWmsInventoryBySkus(params: {
  warehouseCode: string;
  skus: string[];
  log?: { warn: (obj: unknown, msg: string) => void };
}): Promise<Record<string, WmsInventoryBySku>> {
  const { warehouseCode, skus, log } = params;
  if (!config.wmsApiUrl || !config.internalApiKey || !warehouseCode?.trim() || !skus?.length) {
    return {};
  }
  const uniqueSkus = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
  if (uniqueSkus.length === 0) return {};
  try {
    const url = `${config.wmsApiUrl}/api/v1/internal/oms/items/inventory`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': config.internalApiKey,
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
