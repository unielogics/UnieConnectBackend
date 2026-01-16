import fetch from 'node-fetch';
import { config } from '../config/env';

type ShippoAddress = {
  city: string;
  state: string;
  zip?: string;
  country?: string;
  street1?: string;
};

type ShippoParcel = {
  weight: number;
  mass_unit: 'lb' | 'oz' | 'g' | 'kg';
};

type ShippoRate = {
  amount: string;
  currency: string;
  provider: string;
};

const SHIPPO_API_BASE = 'https://api.goshippo.com';

function buildAddress(city: string, state: string, zip?: string, country?: string): ShippoAddress {
  const addr: ShippoAddress = {
    city,
    state,
    country: country || 'US',
    street1: 'Approximate address', // Shippo requires a street; we use a placeholder to get a quote
  };
  if (zip) addr.zip = zip;
  return addr;
}

export async function shippoRateQuote(params: {
  toCity: string;
  toState: string;
  toZip?: string;
  weightLbs: number;
  itemCount: number;
}): Promise<{ amount: number; currency: string; provider?: string; raw?: any }> {
  const { toCity, toState, toZip, weightLbs, itemCount } = params;
  const apiKey = config.shippo.apiKey;

  if (!apiKey) {
    throw new Error('Shippo API key is not configured');
  }

  // Mock mode: deterministic synthetic rate
  if (config.shippo.mockMode) {
    const base = 5;
    const perLb = 0.5;
    const perItem = 0.2;
    const amount = base + perLb * Math.max(weightLbs, 0) + perItem * Math.max(itemCount, 1);
    return { amount, currency: 'USD', provider: 'mock-shippo', raw: { mock: true } };
  }

  const from = buildAddress(
    config.shippo.defaultFrom.city,
    config.shippo.defaultFrom.state,
    config.shippo.defaultFrom.postalCode,
    config.shippo.defaultFrom.country,
  );
  const to = buildAddress(toCity, toState, toZip);
  const parcel: ShippoParcel = { weight: Math.max(weightLbs, 0.1), mass_unit: 'lb' };

  const res = await fetch(`${SHIPPO_API_BASE}/shipments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `ShippoToken ${apiKey}`,
    },
    body: JSON.stringify({
      address_from: from,
      address_to: to,
      parcels: [parcel],
      async: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shippo rate request failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  const rates: ShippoRate[] = Array.isArray(json?.rates) ? json.rates : [];
  if (!rates.length) {
    throw new Error('Shippo did not return rates');
  }
  const best = rates.reduce((min, r) => {
    const amount = Number(r.amount);
    if (!Number.isFinite(amount)) return min;
    if (!min) return r;
    return amount < Number(min.amount) ? r : min;
  }, null as ShippoRate | null);

  if (!best || !Number.isFinite(Number(best.amount))) {
    throw new Error('Shippo returned no valid rate amounts');
  }

  return {
    amount: Number(best.amount),
    currency: best.currency || 'USD',
    provider: best.provider,
    raw: json,
  };
}


