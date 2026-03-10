import { FastifyBaseLogger } from 'fastify';
import { Facility } from '../models/facility';
import { validateAddressWithGeoapify } from './address-validation.service';

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
 * Get closest facility to a given address (supplier/ship-from).
 * If address lacks lat/long, attempts geocoding via Geoapify when configured.
 * Facilities must have lat/long. Returns the facility with smallest haversine distance.
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

  const facilities = await Facility.find({ userId, isActive: true })
    .lean()
    .exec();

  let closest: { facilityId: string; facility: any; distanceMiles: number } | null = null;

  for (const f of facilities) {
    const fl = f.address?.lat;
    const fg = f.address?.long;
    if (fl == null || fg == null || !Number.isFinite(fl) || !Number.isFinite(fg)) continue;

    const dist = haversineMiles(lat, long, fl, fg);
    if (closest == null || dist < closest.distanceMiles) {
      closest = {
        facilityId: String(f._id),
        facility: f,
        distanceMiles: dist,
      };
    }
  }

  return closest;
}
