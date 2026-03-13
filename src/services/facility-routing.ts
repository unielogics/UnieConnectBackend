import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { FastifyBaseLogger } from 'fastify';
import { Facility } from '../models/facility';
import { validateAddressWithGeoapify } from './address-validation.service';
import { getFacilityByWarehouseCode } from '../lib/warehouse-code';
import { config } from '../config/env';

// #region agent log
const DEBUG_LOG = path.resolve(process.cwd(), '..', '..', '.cursor', 'debug.log');
function _dlog(msg: string, data: Record<string, unknown>) {
  try {
    fs.appendFileSync(DEBUG_LOG, JSON.stringify({ location: 'facility-routing', message: msg, data, timestamp: Date.now() }) + '\n');
  } catch (_) {}
}
// #endregion

export interface AddressWithCoords {
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  city?: string;
  stateOrProvinceCode?: string;
  postalCode?: string;
  countryCode?: string;
  lat?: number;
  long?: number;
}

function buildAddressQuery(addr: AddressWithCoords): string {
  const parts = [
    addr.addressLine1,
    addr.city,
    addr.stateOrProvinceCode,
    addr.postalCode,
    addr.countryCode || 'US',
  ].filter(Boolean) as string[];
  return parts.join(', ');
}

/**
 * Haversine formula: distance in miles between two lat/long points
 */
function haversineMiles(
  lat1: number,
  long1: number,
  lat2: number,
  long2: number
): number {
  const R = 3959; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLong = ((long2 - long1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLong / 2) *
      Math.sin(dLong / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Geocode address if missing lat/long. Uses Geoapify when configured.
 */
export async function geocodeAddressIfNeeded(params: {
  address: AddressWithCoords;
  log?: FastifyBaseLogger;
}): Promise<AddressWithCoords> {
  const { address, log } = params;
  if (address.lat != null && address.long != null && Number.isFinite(address.lat) && Number.isFinite(address.long)) {
    return address;
  }
  try {
    const query = buildAddressQuery(address);
    if (!query || query.trim().length < 5) return address;
    const result = await validateAddressWithGeoapify(query);
    if (result?.latitude != null && result?.longitude != null) {
      return { ...address, lat: result.latitude, long: result.longitude };
    }
  } catch (err) {
    log?.warn({ err, address }, 'Geocoding failed; address will need lat/long for routing');
  }
  return address;
}

/**
 * Fetch warehouse metadata from WMS (UnieBackend) internal API.
 * Used when Facility is not in UnieConnectBackend (warehouses live in WMS).
 */
async function fetchWarehouseFromWms(
  warehouseCode: string,
  log?: FastifyBaseLogger
): Promise<{ code: string; name?: string; city?: string; state?: string; street?: string; zipCode?: string; country?: string; latitude?: number; longitude?: number } | null> {
  if (!config.wmsApiUrl || !config.internalApiKey || !warehouseCode?.trim()) return null;
  try {
    const url = `${config.wmsApiUrl}/api/v1/internal/oms/warehouses?codes=${encodeURIComponent(warehouseCode.trim())}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Internal-Api-Key': config.internalApiKey },
    });
    const data = (await res.json().catch(() => ({}))) as { warehouses?: Array<{ code: string; name?: string; city?: string; state?: string; street?: string; zipCode?: string; country?: string; latitude?: number; longitude?: number }> };
    const wh = (data.warehouses || []).find((w) => w.code === warehouseCode);
    return wh || null;
  } catch (err) {
    log?.warn?.({ err, warehouseCode }, 'Failed to fetch warehouse from WMS');
    return null;
  }
}

/**
 * Get all facilities available to a user: direct (userId) + 3PL-linked (OmsIntermediaryWarehouse).
 * For 3PL links, tries Facility first, then WMS API when Facility is missing.
 */
async function getFacilitiesForUser(params: {
  userId: string;
  log?: FastifyBaseLogger;
}): Promise<any[]> {
  const { userId, log } = params;
  const seen = new Set<string>();

  // 1. Direct facilities (user owns warehouse) + synthetic 3PL facilities from WMS
  const direct: any[] = await Facility.find({ userId, isActive: true }).lean().exec();
  _dlog('Direct facilities', { userId, count: direct.length, ids: direct.map((f: any) => String(f._id)) });
  for (const f of direct) {
    seen.add(String(f._id));
  }

  // 2. 3PL-linked facilities (user is OMS; warehouses linked via OmsIntermediaryWarehouse)
  const { User } = await import('../models/user');
  const { OmsIntermediary } = await import('../models/oms-intermediary');
  const { OmsIntermediaryWarehouse } = await import('../models/oms-intermediary-warehouse');
  const user = await User.findById(userId).select('email').lean().exec();
  if (user?.email) {
    const oms = await OmsIntermediary.findOne({
      email: (user.email as string).toLowerCase(),
      status: 'active',
    })
      .select('_id')
      .lean()
      .exec();
    if (oms?._id) {
      const links = await OmsIntermediaryWarehouse.find({ omsIntermediaryId: oms._id })
        .lean()
        .exec();
      _dlog('3PL links found', { userId, omsId: String(oms._id), linksCount: links.length, links: links.map((l: any) => ({ wc: l.warehouseCode, wmsId: String(l.wmsIntermediaryId) })) });
      for (const link of links) {
        const fac = await getFacilityByWarehouseCode(
          (link as any).wmsIntermediaryId,
          (link as any).warehouseCode
        );
        if (fac && !seen.has(String(fac._id))) {
          seen.add(String(fac._id));
          direct.push(fac);
          _dlog('3PL facility resolved', { warehouseCode: (link as any).warehouseCode, facilityId: String((fac as any)._id), name: (fac as any).name });
        } else if (!fac) {
          const wc = (link as any).warehouseCode;
          const wmsId = (link as any).wmsIntermediaryId;
          const wmsMeta = await fetchWarehouseFromWms(wc, log);
          if (wmsMeta) {
            // Upsert Facility so we have a valid ObjectId for ShipmentPlan/ASN
            const upserted = await Facility.findOneAndUpdate(
              { userId: wmsId, code: wc },
              {
                $set: {
                  name: wmsMeta.name || wc,
                  address: {
                    addressLine1: wmsMeta.street || '—',
                    city: wmsMeta.city || '—',
                    stateOrProvinceCode: wmsMeta.state || '—',
                    postalCode: wmsMeta.zipCode || '—',
                    countryCode: wmsMeta.country || 'US',
                    lat: wmsMeta.latitude ?? undefined,
                    long: wmsMeta.longitude ?? undefined,
                  },
                  isActive: true,
                  status: 'active',
                },
              },
              { upsert: true, new: true }
            )
              .lean()
              .exec();
            if (upserted && !seen.has(String(upserted._id))) {
              seen.add(String(upserted._id));
              direct.push(upserted);
              _dlog('3PL facility from WMS API (upserted)', { warehouseCode: wc, facilityId: String(upserted._id), name: (upserted as any).name });
            }
          } else {
            const facilitiesForWms = await Facility.find({ userId: (link as any).wmsIntermediaryId }).select('code name isActive').lean().exec();
            _dlog('3PL facility NOT resolved', {
              warehouseCode: wc,
              wmsId: String((link as any).wmsIntermediaryId),
              facilitiesForWmsCount: facilitiesForWms.length,
            });
          }
        }
      }
    }
  }

  return direct;
}

/**
 * Get closest facility to a given address (supplier/ship-from).
 * Uses direct facilities + 3PL-linked facilities when user is an OMS.
 * If address lacks lat/long, attempts geocoding via Geoapify when configured.
 */
export async function getClosestFacility(params: {
  userId: string;
  address: AddressWithCoords;
  geocodeIfMissing?: boolean;
  log?: FastifyBaseLogger;
}): Promise<{ facilityId: string; facility: any; distanceMiles: number } | null> {
  const { userId, address, geocodeIfMissing = true, log } = params;
  let addr = address;
  if ((addr.lat == null || addr.long == null) && geocodeIfMissing) {
    addr = await geocodeAddressIfNeeded({ address: addr, ...(log != null && { log }) });
  }
  const lat = addr.lat;
  const long = addr.long;

  if (lat == null || long == null || !Number.isFinite(lat) || !Number.isFinite(long)) {
    log?.warn('Address missing lat/long after geocode attempt; cannot compute closest facility');
    return null;
  }

  const facilities = await getFacilitiesForUser({ userId, ...(log != null && { log }) });
  _dlog('Total facilities for closest', { userId, facilityCount: facilities.length, facilityNames: facilities.map((f: any) => f.name) });

  let closest: { facilityId: string; facility: any; distanceMiles: number } | null = null;

  for (const f of facilities) {
    let fl = f.address?.lat;
    let fg = f.address?.long;
    if (fl == null || fg == null || !Number.isFinite(fl) || !Number.isFinite(fg)) {
      const geocoded = await geocodeAddressIfNeeded({
        address: f.address as AddressWithCoords,
        ...(log != null && { log }),
      });
      fl = geocoded?.lat;
      fg = geocoded?.long;
    }
    if (fl == null || fg == null || !Number.isFinite(fl) || !Number.isFinite(fg)) continue;

    const dist = haversineMiles(lat, long, fl, fg);
    const facilityWithCoords = { ...f, address: { ...f.address, lat: fl, long: fg } };
    if (closest == null || dist < closest.distanceMiles) {
      closest = {
        facilityId: String(f._id),
        facility: facilityWithCoords,
        distanceMiles: dist,
      };
    }
  }

  return closest;
}
