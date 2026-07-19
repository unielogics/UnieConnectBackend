/**
 * Single-identifier Keepa lookup for the new-product prefill flow + product research.
 *
 * Resolves an ASIN / UPC / EAN via the existing cached Keepa client
 * (getKeepaSnapshotForIdentifiers, handles ASIN + code lookups with a 3-day cache), maps it
 * to a prefill-friendly shape, and — when an ASIN resolves — enriches it with Cortex's
 * normalized intelligence (sell-decision verdict + opportunity + chart-ready trend bundle) via
 * POST /v1/integrations/keepa/product. Cortex is the intelligence backbone; the OMS Keepa
 * client is the cache/fallback for the basic catalog fields (title/brand/dims/image).
 */
import { getKeepaSnapshotForIdentifiers } from './keepa';
import { postCortex } from './cortex-orchestration';

export type KeepaLookupResult = {
  found: boolean;
  source: 'keepa' | 'keepa+cortex' | 'none';
  asin?: string | null;
  upc?: string | null;
  ean?: string | null;
  title?: string | null;
  brand?: string | null;
  description?: string | null;
  image?: string | null;
  category?: string | null;
  salesRank?: number | null;
  buyBoxPrice?: number | null;
  rating?: number | null;
  reviewCount?: number | null;
  weight?: number | null;
  dimensions?: { length?: number | null; width?: number | null; height?: number | null };
  // Cortex intelligence (present when the ASIN resolved and Cortex was reachable)
  verdict?: any | null;
  opportunity?: any | null;
  charts?: any | null;
  // The FULL Cortex demand_extract (all 26 sub-objects) — powers the full-screen research view.
  extract?: any | null;
  message?: string;
};

const ASIN_RE = /^[A-Z0-9]{10}$/;

/** Classify a raw identifier as ASIN vs a numeric code (UPC/EAN/GTIN). */
function classify(identifier: string, hint?: string): { asin?: string; upc?: string; ean?: string } {
  const raw = String(identifier || '').trim();
  const upper = raw.toUpperCase();
  const digits = raw.replace(/[^0-9]/g, '');
  if (hint === 'asin' || (ASIN_RE.test(upper) && !/^\d{10}$/.test(upper))) return { asin: upper };
  if (hint === 'upc') return { upc: digits };
  if (hint === 'ean') return { ean: digits };
  // No hint: an all-A-Z-0-9 10-char that isn't purely 10 digits is an ASIN; else treat as a code.
  if (ASIN_RE.test(upper) && !/^\d{10}$/.test(upper)) return { asin: upper };
  if (digits.length >= 12) return { upc: digits };
  return { asin: upper };
}

export async function lookupProductByIdentifier(
  identifier: string,
  opts: { type?: 'asin' | 'upc' | 'ean'; tenantId?: string; refresh?: boolean } = {},
): Promise<KeepaLookupResult> {
  const ids = classify(identifier, opts.type);
  let snap: any = null;
  try {
    snap = await getKeepaSnapshotForIdentifiers(ids);
  } catch {
    snap = null;
  }

  if (!snap || !snap.ok) {
    return { found: false, source: 'none', message: 'No Keepa match for that identifier.' };
  }

  const payload = snap.payload || {};
  const result: KeepaLookupResult = {
    found: true,
    source: 'keepa',
    asin: snap.asin || null,
    upc: ids.upc || (typeof payload.upc === 'string' ? payload.upc : null),
    ean: ids.ean || (typeof payload.ean === 'string' ? payload.ean : null),
    title: snap.title || null,
    brand: snap.brand || null,
    description: snap.description || null,
    image: snap.image || null,
    category: snap.category || null,
    salesRank: snap.sales_rank ?? null,
    buyBoxPrice: snap.buybox_price_cents != null ? snap.buybox_price_cents / 100 : null,
    rating: snap.rating ?? null,
    reviewCount: snap.review_count ?? null,
    weight: snap.weight_lb ?? null,
    dimensions: { length: snap.length_in ?? null, width: snap.width_in ?? null, height: snap.height_in ?? null },
  };

  // Enrich with Cortex intelligence when we have an ASIN. Best-effort — never block prefill.
  const asin = result.asin && ASIN_RE.test(String(result.asin)) ? String(result.asin) : null;
  if (asin) {
    try {
      const cortexOpts: Record<string, unknown> = {};
      if (opts.tenantId) {
        cortexOpts.userId = opts.tenantId;
        cortexOpts.extraHeaders = { 'X-Unie-Tenant-Id': opts.tenantId };
      }
      // force_refresh pulls the RICH Keepa payload (offers[]/buy-box history) instead of the slim
      // shared-cache snapshot — this is what populates the buy-box/seller/offer panels.
      const cortex = await postCortex(
        '/v1/integrations/keepa/product',
        { asin, domain: 1, force_refresh: opts.refresh === true },
        cortexOpts as any,
      );
      const data = (cortex && (cortex as any).data) || cortex;
      const extract = data?.demand_extract || data?.data?.demand_extract;
      if (extract) {
        result.source = 'keepa+cortex';
        result.extract = extract;
        result.verdict = extract.sell_decision_hybrid ?? null;
        result.opportunity = extract.opportunity_summary_ux ?? null;
        result.charts = extract.keepa_trend_bundle?.chart ?? null;
        // Prefer Cortex listing_profile fields when the OMS snapshot lacked them.
        const lp = extract.listing_profile || {};
        result.title = result.title || lp.title || null;
        result.brand = result.brand || lp.manufacturer || lp.brand || null;
        result.description = result.description || lp.description || null;
        result.category = result.category || (Array.isArray(lp.category_labels_guess) ? lp.category_labels_guess[0] : null);
        result.upc = result.upc || lp.upc || null;
        result.ean = result.ean || lp.ean || null;
      }
    } catch {
      // Cortex unreachable — keep the Keepa-only result.
    }
  }

  return result;
}
