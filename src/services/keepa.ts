import fetch from 'node-fetch';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * Shared Keepa cache backed by DynamoDB (table = process.env.KEEPA_TABLE).
 *
 * Read path:  any consumer (UnieConnect catalog import, SkuDetail, Cortex)
 *             calls getKeepaSnapshot(asin) which checks the table first.
 * Miss path:  UnieConnect calls Keepa directly, denormalizes the hot fields,
 *             writes the full payload back to the table with a 3-day TTL.
 *             "Not found" responses are negative-cached for 24h.
 */

const TABLE = process.env.KEEPA_TABLE || 'unie-keepa-snapshots';
const REGION = process.env.AWS_REGION || 'us-east-1';
const KEEPA_API_BASE = 'https://api.keepa.com';
const FRESH_TTL_SEC = 3 * 24 * 60 * 60;
const NEG_TTL_SEC = 24 * 60 * 60;

let _ddb: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
    });
  }
  return _ddb;
}

export type KeepaSnapshot = {
  asin: string;
  domain: number;
  ok: boolean;
  title?: string | null;
  brand?: string | null;
  category?: string | null;
  buybox_price_cents?: number | null;
  sales_rank?: number | null;
  rating?: number | null;
  review_count?: number | null;
  weight_lb?: number | null;
  length_in?: number | null;
  width_in?: number | null;
  height_in?: number | null;
  payload: Record<string, unknown>;
  fetched_by: string;
  fetched_at: number;
  expires_at: number;
  read_count?: number;
  last_read_at?: number;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function mmToIn(mm: unknown): number | null {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n / 25.4).toFixed(2));
}

function gToLb(g: unknown): number | null {
  const n = Number(g);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number((n / 453.59237).toFixed(3));
}

function keepaStatCurrent(product: any, idx: number): number | null {
  const cur = product?.stats?.current;
  if (!Array.isArray(cur)) return null;
  const v = Number(cur[idx]);
  if (!Number.isFinite(v) || v === -1) return null;
  return v;
}

function firstCategoryTreeName(product: any): string | null {
  const tree = product?.categoryTree;
  if (Array.isArray(tree) && tree.length) {
    return String(tree[tree.length - 1]?.name || tree[0]?.name || '') || null;
  }
  return null;
}

/** Denormalize the Keepa product into the cache columns. Defensive — every field is best-effort. */
function denormalize(product: any): Partial<KeepaSnapshot> {
  if (!product) return {};
  const buyboxCents = keepaStatCurrent(product, 18); // BUY_BOX_SHIPPING (cents)
  const salesRank = keepaStatCurrent(product, 3); // SALES
  const ratingRaw = keepaStatCurrent(product, 16); // RATING (0..50, scaled)
  const reviewCount = keepaStatCurrent(product, 17); // COUNT_REVIEWS
  return {
    title: product.title || null,
    brand: product.brand || product.manufacturer || null,
    category: firstCategoryTreeName(product),
    buybox_price_cents: buyboxCents != null ? buyboxCents : null,
    sales_rank: salesRank != null ? salesRank : null,
    rating: ratingRaw != null ? Number((ratingRaw / 10).toFixed(2)) : null,
    review_count: reviewCount != null ? reviewCount : null,
    weight_lb: gToLb(product.packageWeight ?? product.itemWeight),
    length_in: mmToIn(product.packageLength ?? product.itemLength),
    width_in: mmToIn(product.packageWidth ?? product.itemWidth),
    height_in: mmToIn(product.packageHeight ?? product.itemHeight),
  };
}

async function getCached(asin: string, domain: number): Promise<KeepaSnapshot | null> {
  try {
    const res = await ddb().send(new GetCommand({ TableName: TABLE, Key: { asin, domain } }));
    return (res.Item as KeepaSnapshot) || null;
  } catch (err) {
    return null;
  }
}

async function bumpReadCount(asin: string, domain: number): Promise<void> {
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { asin, domain },
        UpdateExpression: 'SET read_count = if_not_exists(read_count, :z) + :one, last_read_at = :now',
        ExpressionAttributeValues: { ':z': 0, ':one': 1, ':now': nowSec() },
      }),
    );
  } catch {
    // best-effort, don't fail the read
  }
}

async function writeSnapshot(snapshot: KeepaSnapshot): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: snapshot,
    }),
  );
}

async function callKeepa(asin: string, domain: number): Promise<{ ok: boolean; product: any | null; raw: any }> {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new Error('KEEPA_API_KEY is not configured');
  const url = `${KEEPA_API_BASE}/product?key=${encodeURIComponent(key)}&domain=${domain}&asin=${encodeURIComponent(asin)}&stats=30`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Keepa HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw: any = await res.json();
  const product = Array.isArray(raw?.products) ? raw.products[0] : null;
  // Keepa returns products: [] when ASIN not found; treat as negative result.
  const ok = !!(product && product.asin);
  return { ok, product, raw };
}

export type GetOpts = { domain?: number; force?: boolean };

/**
 * Returns a Keepa snapshot for the ASIN. Lazy refresh: any expired row triggers
 * a Keepa call. `force=true` always re-fetches.
 *
 * Always returns an object — even on negative cache (ok=false). Callers should
 * check the `ok` field before reading denormalized fields.
 */
export async function getKeepaSnapshot(asin: string, opts: GetOpts = {}): Promise<KeepaSnapshot | null> {
  const cleanAsin = String(asin || '').trim().toUpperCase();
  if (!cleanAsin) return null;
  const domain = opts.domain ?? 1;
  const now = nowSec();

  if (!opts.force) {
    const cached = await getCached(cleanAsin, domain);
    if (cached && cached.expires_at > now) {
      // best-effort read counter
      void bumpReadCount(cleanAsin, domain);
      return cached;
    }
  }

  // Cache miss / stale / forced
  let snapshot: KeepaSnapshot;
  try {
    const { ok, product, raw } = await callKeepa(cleanAsin, domain);
    const denorm = ok ? denormalize(product) : {};
    snapshot = {
      asin: cleanAsin,
      domain,
      ok,
      payload: ok ? (product as Record<string, unknown>) : { not_found: true, raw_tokens_left: raw?.tokensLeft ?? null },
      fetched_by: 'unieconnect',
      fetched_at: now,
      expires_at: now + (ok ? FRESH_TTL_SEC : NEG_TTL_SEC),
      read_count: 1,
      last_read_at: now,
      ...denorm,
    };
  } catch (err: any) {
    // On hard failure, return the stale row if we have one rather than nothing.
    const stale = await getCached(cleanAsin, domain);
    if (stale) {
      void bumpReadCount(cleanAsin, domain);
      return stale;
    }
    throw err;
  }

  await writeSnapshot(snapshot);
  return snapshot;
}

/** Batch helper for SKU enrichment paths. Sequential to respect Keepa rate limit. */
export async function getKeepaSnapshotsForAsins(
  asins: string[],
  opts: GetOpts = {},
): Promise<Record<string, KeepaSnapshot | null>> {
  const out: Record<string, KeepaSnapshot | null> = {};
  for (const a of asins) {
    try {
      out[a] = await getKeepaSnapshot(a, opts);
    } catch (err) {
      out[a] = null;
    }
  }
  return out;
}

/** Read-only helper used by warm-up + admin debug. */
export async function peekKeepaSnapshot(asin: string, domain = 1): Promise<KeepaSnapshot | null> {
  return getCached(String(asin || '').trim().toUpperCase(), domain);
}
