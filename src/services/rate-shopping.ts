import fetch from 'node-fetch';
import { RateShoppingQuote, IRateShoppingQuote } from '../models/rate-shopping-quote';
import { config } from '../config/env';

const WEIGHT_STEP_LBS = 0.25;
const WEIGHT_TOLERANCE_LBS = 0.25;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function bandWeight(weightLbs: number): number {
  if (!Number.isFinite(weightLbs)) return 0;
  return Math.round(weightLbs / WEIGHT_STEP_LBS) * WEIGHT_STEP_LBS;
}

export async function findCachedQuote(params: {
  city: string;
  state: string;
  weightLbs: number;
  itemCount: number;
}): Promise<IRateShoppingQuote | null> {
  const { city, state, weightLbs, itemCount } = params;
  const cityLower = city.trim().toLowerCase();
  const stateLower = state.trim().toLowerCase();
  const weightBand = bandWeight(weightLbs);
  const now = new Date();

  return RateShoppingQuote.findOne({
    cityLower,
    stateLower,
    itemCount,
    weightBand: { $gte: weightBand - WEIGHT_TOLERANCE_LBS, $lte: weightBand + WEIGHT_TOLERANCE_LBS },
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
  })
    .sort({ updatedAt: -1 })
    .lean()
    .exec();
}

export async function getOrCreateQuote(params: {
  city: string;
  state: string;
  weightLbs: number;
  itemCount: number;
  currency?: string;
  ttlMs?: number;
  fetchQuote?: () => Promise<{ amount: number; currency?: string; provider?: string; raw?: any }>;
}): Promise<IRateShoppingQuote> {
  const { city, state, weightLbs, itemCount, currency = 'USD', ttlMs = DEFAULT_TTL_MS, fetchQuote } = params;
  const cityLower = city.trim().toLowerCase();
  const stateLower = state.trim().toLowerCase();
  const weightBand = bandWeight(weightLbs);
  const now = new Date();

  const cached = await findCachedQuote({ city, state, weightLbs, itemCount });
  if (cached) return cached;

  if (!fetchQuote) {
    throw new Error('Rate shopping fetchQuote is required when cache is cold');
  }

  const fetched = await fetchQuote();
  const amount = Number(fetched.amount);
  if (!Number.isFinite(amount)) {
    throw new Error('Invalid rate shopping amount');
  }

  const quote = await RateShoppingQuote.findOneAndUpdate(
    { cityLower, stateLower, weightBand, itemCount },
    {
      cityLower,
      stateLower,
      weightBand,
      itemCount,
      amount,
      currency: fetched.currency || currency,
      provider: fetched.provider,
      raw: fetched.raw,
      expiresAt: ttlMs ? new Date(Date.now() + ttlMs) : undefined,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return quote as IRateShoppingQuote;
}

export async function callRateShoppingApi(input: {
  city: string;
  state: string;
  weightLbs: number;
  itemCount: number;
  currency?: string;
}): Promise<{ amount: number; currency?: string; provider?: string; raw?: any }> {
  const { city, state, weightLbs, itemCount, currency = 'USD' } = input;
  const apiUrl = config.rateShopping?.apiUrl;
  const apiKey = config.rateShopping?.apiKey;

  if (!apiUrl) {
    throw new Error('Rate shopping API URL is not configured');
  }

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ city, state, weightLbs, itemCount, currency }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Rate shopping API failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  const amount = Number(json?.amount ?? json?.rate);
  if (!Number.isFinite(amount)) {
    throw new Error('Rate shopping API response missing amount');
  }

  return {
    amount,
    currency: json?.currency || currency,
    provider: json?.provider,
    raw: json,
  };
}

export function weightBandFor(weightLbs: number): number {
  return bandWeight(weightLbs);
}

export const weightToleranceLbs = WEIGHT_TOLERANCE_LBS;


