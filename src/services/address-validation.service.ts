import fetch from 'node-fetch';
import { config } from '../config/env';

export interface ValidatedAddress {
  formatted: string;
  houseNumber?: string;
  street?: string;
  city?: string;
  state?: string;
  stateCode?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  provider?: string;
  quality?: number;
}

function getApiKey(): string {
  return config.geoapify?.apiKey || process.env.GEOAPIFY_API_KEY || '';
}

/**
 * Call Geoapify Geocoding API to validate/standardize an address.
 * Returns normalized fields + coordinates, or null if not found.
 */
export async function validateAddressWithGeoapify(query: string): Promise<ValidatedAddress | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Geoapify API key not configured (GEOAPIFY_API_KEY)');
  }

  const url = new URL('https://api.geoapify.com/v1/geocode/search');
  url.searchParams.set('text', query);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('limit', '1');

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(`Geoapify request failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as any;
  const feature = data?.features?.[0];
  if (!feature?.properties) {
    return null;
  }

  const p = feature.properties;
  return {
    formatted: p.formatted || query,
    houseNumber: p.housenumber,
    street: p.street || p.address_line1,
    city: p.city || p.town || p.village,
    state: p.state,
    stateCode: p.state_code,
    postalCode: p.postcode,
    country: p.country,
    latitude: feature.geometry?.coordinates?.[1],
    longitude: feature.geometry?.coordinates?.[0],
    provider: 'geoapify',
    quality: typeof p.rank?.confidence === 'number' ? p.rank.confidence : undefined,
  };
}

export async function suggestAddressesWithGeoapify(query: string): Promise<ValidatedAddress[]> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Geoapify API key not configured (GEOAPIFY_API_KEY)');
  }

  const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  url.searchParams.set('text', query);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('limit', '5');

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(`Geoapify autocomplete failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as any;
  const features = data?.features || [];
  return features
    .map((f: any) => {
      const p = f?.properties;
      if (!p) return null;
      return {
        formatted: p.formatted || query,
        houseNumber: p.housenumber,
        street: p.street || p.address_line1,
        city: p.city || p.town || p.village,
        state: p.state,
        stateCode: p.state_code,
        postalCode: p.postcode,
        country: p.country,
        latitude: f.geometry?.coordinates?.[1],
        longitude: f.geometry?.coordinates?.[0],
        provider: 'geoapify',
        quality: typeof p.rank?.confidence === 'number' ? p.rank.confidence : undefined,
      } as ValidatedAddress;
    })
    .filter(Boolean);
}
