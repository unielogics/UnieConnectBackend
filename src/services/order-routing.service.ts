import fetch from 'node-fetch';
import { config } from '../config/env';
import { OmsIntermediary } from '../models/oms-intermediary';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';
import { User } from '../models/user';
import type { FastifyBaseLogger } from 'fastify';
import { geocodeAddressIfNeeded, AddressWithCoords } from './facility-routing';

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export interface RouteOrderInput {
  userId: string;
  shippingAddress: {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
    lat?: number;
    long?: number;
  };
  lineItems: Array<{ sku: string; quantity: number; itemName?: string }>;
  log?: { warn: (o: unknown, m: string) => void };
}

/**
 * Route order to closest warehouse with inventory.
 * 1. Resolve user's connected warehouses
 * 2. Geocode address if missing lat/lon
 * 3. Check inventory per warehouse
 * 4. Filter to warehouses with sufficient inventory
 * 5. Sort by distance, return closest
 */
export async function routeOrderToClosestWarehouse(
  params: RouteOrderInput
): Promise<{ warehouseCode: string; omsIntermediaryId: string } | null> {
  const { userId, shippingAddress, lineItems, log } = params;
  if (!config.wmsApiUrl || !config.internalApiKey || lineItems.length === 0) return null;

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

  const links = await OmsIntermediaryWarehouse.find({ omsIntermediaryId: oms._id, status: 'active' })
    .select('warehouseCode')
    .lean()
    .exec();
  if (links.length === 0) return null;

  const warehouseCodes = links.map((l) => (l as any).warehouseCode).filter(Boolean);
  if (warehouseCodes.length === 0) return null;

  let lat = shippingAddress.lat;
  let long = shippingAddress.long;
  if (lat == null || long == null || !Number.isFinite(lat) || !Number.isFinite(long)) {
    const addr: AddressWithCoords = {};
    if (shippingAddress.addressLine1 !== undefined) addr.addressLine1 = shippingAddress.addressLine1;
    if (shippingAddress.city !== undefined) addr.city = shippingAddress.city;
    if (shippingAddress.state !== undefined) addr.stateOrProvinceCode = shippingAddress.state;
    if (shippingAddress.zipCode !== undefined) addr.postalCode = shippingAddress.zipCode;
    addr.countryCode = shippingAddress.country || 'US';
    if (shippingAddress.lat !== undefined && Number.isFinite(shippingAddress.lat)) addr.lat = shippingAddress.lat;
    if (shippingAddress.long !== undefined && Number.isFinite(shippingAddress.long)) addr.long = shippingAddress.long;
    const geocoded = await geocodeAddressIfNeeded({
      address: addr,
      ...(log != null && { log: log as FastifyBaseLogger }),
    });
    lat = geocoded.lat;
    long = geocoded.long;
  }
  if (lat == null || long == null || !Number.isFinite(lat) || !Number.isFinite(long)) {
    log?.warn?.(null, 'Could not geocode address; cannot route by distance');
    return null;
  }

  const checkRes = await fetch(`${config.wmsApiUrl}/api/v1/internal/oms/inventory/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': config.internalApiKey,
    },
    body: JSON.stringify({
      warehouseCodes,
      lineItems: lineItems.map((li) => ({ sku: li.sku, quantity: li.quantity })),
    }),
  });
  const checkData = (await checkRes.json().catch(() => ({}))) as { results?: Array<{ warehouseCode: string; available: boolean }> };
  const available = (checkData.results || []).filter((r) => r.available);
  if (available.length === 0) return null;

  const warehousesRes = await fetch(
    `${config.wmsApiUrl}/api/v1/internal/oms/warehouses?codes=${warehouseCodes.map(encodeURIComponent).join(',')}`,
    { headers: { 'X-Internal-Api-Key': config.internalApiKey } }
  );
  const whData = (await warehousesRes.json().catch(() => ({}))) as {
    warehouses?: Array<{ code: string; latitude?: number; longitude?: number }>;
  };
  const whByCode = new Map((whData.warehouses || []).map((w) => [w.code, w]));

  const withDistance = available
    .map((r) => {
      const wh = whByCode.get(r.warehouseCode);
      const wLat = wh?.latitude;
      const wLon = wh?.longitude;
      if (wLat == null || wLon == null || !Number.isFinite(wLat) || !Number.isFinite(wLon)) {
        return { warehouseCode: r.warehouseCode, distanceMiles: Infinity };
      }
      return { warehouseCode: r.warehouseCode, distanceMiles: haversineMiles(lat!, long!, wLat, wLon) };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles);

  const closest = withDistance[0];
  if (!closest || closest.distanceMiles === Infinity) return null;

  return {
    warehouseCode: closest.warehouseCode,
    omsIntermediaryId: String(oms._id),
  };
}
