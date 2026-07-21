/**
 * Nightly OMS → WMS demand-push scheduler (the "velocity currency" for replenishment).
 *
 * OMS is the source of sell-through velocity. This job computes per-SKU units/day from each
 * connected seller's order history (excluding cancelled) and pushes it to every connected
 * warehouse's WMS, which blends it (0.6 OMS + 0.4 WMS throughput) into the forward-pick brain.
 *
 * This is the first scheduled job in OMS (cadence is otherwise Cortex-owned). Single-flight,
 * per-user try/catch, idempotent (re-push overwrites replenishmentProfile.external.unitsPerDay).
 * Off the :00/:30 marks. Started from server.ts after app.listen.
 */
import fetch from 'node-fetch';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';
import { peekKeepaSnapshot } from './keepa';

const WINDOW_DAYS = 30;
// Keepa sales-rank → estimated monthly units (mirrors Cortex keepa_demand._rank_to_monthly_units_band:
// mid ≈ 960000 / rank^0.87). This is a BASELINE only — used for SKUs with no real sell-through yet;
// once a product is in rotation, real OMS/WMS sales velocity dominates (see the gate below and the
// WMS blend which down-weights source='keepa_baseline').
function keepaRankToUnitsPerDay(rank: number | null | undefined): number {
  const r = Number(rank);
  if (!Number.isFinite(r) || r <= 0) return 0;
  const monthly = 960000 / Math.pow(r, 0.87);
  const perDay = monthly / 30;
  if (!Number.isFinite(perDay) || perDay <= 0) return 0;
  // Clamp to a sane baseline range so a freak rank can't produce an absurd velocity.
  return Math.min(Math.max(Math.round(perDay * 100) / 100, 0), 500);
}
const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const FIRST_RUN_DELAY_MS = 3 * 60 * 1000; // 3 min after boot
let timer: NodeJS.Timeout | null = null;
let running = false;

async function callWms(path: string, body: any): Promise<any> {
  if (!config.wmsApiUrl || !config.internalApiKey) {
    throw new Error('WMS_API_URL / UNIECONNECT_INTERNAL_API_KEY not configured');
  }
  const res = await fetch(`${config.wmsApiUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Api-Key': config.internalApiKey },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(String(data?.message || data?.error || `WMS ${res.status}`));
  return data;
}

async function pushDemandForUser(userId: string, warehouseCodes: string[]): Promise<{ skus: number; warehouses: number }> {
  const demand = await pgQuery<{ sku: string; units: string }>(
    `SELECT ol.sku AS sku, COALESCE(SUM(ol.quantity), 0)::text AS units
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id
      WHERE ol.user_id = $1
        AND ol.sku IS NOT NULL AND ol.sku <> ''
        AND COALESCE(o.placed_at, o.created_at) >= now() - ($2::int || ' days')::interval
        AND o.status <> 'cancelled'
      GROUP BY ol.sku`,
    [userId, WINDOW_DAYS],
  );
  const items = (demand?.rows ?? [])
    .map((r) => ({ sku: String(r.sku), unitsPerDay: Number(r.units) / WINDOW_DAYS, windowDays: WINDOW_DAYS }))
    .filter((r) => r.sku && Number.isFinite(r.unitsPerDay) && r.unitsPerDay > 0);

  // KEEPA BASELINE: for catalog SKUs with an ASIN but NO real sell-through yet (not in the sales
  // set above, or zero), seed a baseline velocity from the cached Keepa sales rank so a
  // never-sold ASIN isn't auto-classified slow-mover (all-to-storage) on its first ASN. Real
  // OMS/WMS sales always win once the product is in rotation: (1) we only emit baseline for SKUs
  // with no real sales here, and (2) the WMS blend can down-weight source='keepa_baseline'.
  // Cache-only peek (peekKeepaSnapshot) — never spends Keepa API tokens in this nightly job.
  const soldSkus = new Set(items.map((i) => i.sku.toUpperCase()));
  const keepaItems: Array<{ sku: string; unitsPerDay: number; windowDays: number }> = [];
  try {
    const catalog = await pgQuery<{ sku: string; asin: string }>(
      `SELECT sku, asin FROM catalog_items
        WHERE user_id = $1 AND archived = false AND asin IS NOT NULL AND asin <> ''`,
      [userId],
    );
    for (const row of catalog?.rows ?? []) {
      const sku = String(row.sku || '');
      if (!sku || soldSkus.has(sku.toUpperCase())) continue; // real sales win
      const snap = await peekKeepaSnapshot(String(row.asin));
      const upd = keepaRankToUnitsPerDay(snap?.sales_rank);
      if (upd > 0) keepaItems.push({ sku, unitsPerDay: upd, windowDays: WINDOW_DAYS });
    }
  } catch (err: any) {
    console.warn('[demand-push] keepa-baseline lookup failed', { userId, error: err?.message || String(err) });
  }

  if (items.length === 0 && keepaItems.length === 0) return { skus: 0, warehouses: warehouseCodes.length };

  let ok = 0;
  for (const code of warehouseCodes) {
    try {
      if (items.length > 0) {
        await callWms('/internal/oms/sku-demand', { warehouseCode: code, source: 'oms_sales', items });
      }
      // Push baseline separately with its own source tag so the WMS can weight it below real sales.
      if (keepaItems.length > 0) {
        await callWms('/internal/oms/sku-demand', { warehouseCode: code, source: 'keepa_baseline', items: keepaItems });
      }
      ok++;
    } catch (err: any) {
      console.error('[demand-push] push failed', { userId, warehouseCode: code, error: err?.message || String(err) });
    }
  }
  return { skus: items.length + keepaItems.length, warehouses: ok };
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    // Every (connected user, warehouse) pair; group warehouses per user.
    const links = await pgQuery<{ user_id: string; warehouse_code: string }>(
      `SELECT DISTINCT user_id, UPPER(warehouse_code) AS warehouse_code
         FROM oms_warehouse_links
        WHERE status = 'connected' AND warehouse_code IS NOT NULL AND warehouse_code <> ''`,
    );
    const byUser = new Map<string, string[]>();
    for (const l of links?.rows ?? []) {
      const u = String(l.user_id);
      if (!byUser.has(u)) byUser.set(u, []);
      byUser.get(u)!.push(String(l.warehouse_code));
    }
    let users = 0, skus = 0;
    for (const [userId, codes] of byUser) {
      try {
        const r = await pushDemandForUser(userId, Array.from(new Set(codes)));
        users++; skus += r.skus;
      } catch (err: any) {
        console.error('[demand-push] user failed', { userId, error: err?.message || String(err) });
      }
    }
    console.log('[demand-push] run complete', { users, skus, ms: Date.now() - started });
  } catch (err: any) {
    console.error('[demand-push] run failed', err?.message || String(err));
  } finally {
    running = false;
  }
}

export function startDemandPushScheduler(): void {
  if (timer) return;
  setTimeout(() => { void runOnce(); }, FIRST_RUN_DELAY_MS);
  timer = setInterval(() => { void runOnce(); }, INTERVAL_MS);
  console.log('[demand-push] scheduler started (daily; first run in 3m)');
}

export function stopDemandPushScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// Exported for a manual/on-demand trigger if needed.
export { runOnce as runDemandPushNow };
