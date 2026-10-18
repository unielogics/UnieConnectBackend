import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { config } from '../config/env';
import { publicEntityId } from '../lib/public-id';
import { cortexConfigStatus, postCortex } from './cortex-orchestration';
import { getCortexCredentialHeaders } from './cortex-credentials.service';
import { getBusinessDouble, getInventoryPlan, getWarehouseOverview, writeOmsLedgerEvent, getBillingCategoryTotals, getStorageBillingSignal } from './oms-production.service';
import { lookupProductByIdentifier, type KeepaLookupResult } from './keepa-lookup.service';
import fetch from 'node-fetch';

import { createHmac, timingSafeEqual } from "crypto";
type Row = Record<string, any>;

/**
 * Resolve a product-research input to a Keepa+Cortex intelligence bundle. Picks the best
 * identifier (asin > upc > ean, else the catalog item's), looks it up (cached), returns null
 * when no identifier is available or nothing is found. Best-effort — never throws.
 */
async function researchKeepaForInput(userId: string, input: any, item: Row | null): Promise<KeepaLookupResult | null> {
  const identifier = String(
    input?.asin || input?.upc || input?.ean || input?.identifier ||
    item?.asin || item?.upc || item?.ean || '',
  ).trim();
  if (!identifier) return null;
  const type: 'asin' | 'upc' | 'ean' | undefined =
    input?.asin || item?.asin ? 'asin' : input?.upc || item?.upc ? 'upc' : input?.ean || item?.ean ? 'ean' : undefined;
  try {
    // Research is an explicit user action → request the RICH Keepa pull (offers/buy-box) so the
    // full-screen view's competition/seller/offer panels populate. Cached after first fetch.
    const opts: { type?: 'asin' | 'upc' | 'ean'; tenantId?: string; refresh?: boolean } = { tenantId: userId, refresh: true };
    if (type) opts.type = type;
    const r = await lookupProductByIdentifier(identifier, opts);
    return r?.found ? r : null;
  } catch {
    return null;
  }
}

/** Merge Cortex/Keepa intelligence into a product-research result so the UI can render it. */
function attachKeepaIntelligence(result: any, keepa: KeepaLookupResult | null): void {
  if (!result || !keepa || !keepa.found) return;
  result.keepa = {
    source: keepa.source,
    asin: keepa.asin,
    title: keepa.title,
    brand: keepa.brand,
    image: keepa.image,
    category: keepa.category,
    salesRank: keepa.salesRank,
    buyBoxPrice: keepa.buyBoxPrice,
    rating: keepa.rating,
    reviewCount: keepa.reviewCount,
    verdict: keepa.verdict || null,
    opportunity: keepa.opportunity || null,
    charts: keepa.charts || null,
    // Full Cortex demand_extract → powers the full-screen research view + re-opened recents.
    extract: keepa.extract || null,
  };
  // Surface the Cortex sellability verdict as a headline signal on the result.
  const v = keepa.verdict || {};
  if (v.final_verdict) result.keepaVerdict = v.final_verdict; // favorable | neutral | cautious
  if (v.recommended_to_sell_label) result.keepaRecommendedToSell = v.recommended_to_sell_label;
}

const money = (value: unknown) => {
  const n = typeof value === 'string' ? Number.parseFloat(value) : Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const number = (value: unknown, fallback = 0) => {
  const n = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const json = (value: unknown, fallback: any = {}) => (value == null ? fallback : value);
const iso = (value: unknown) => (value ? new Date(value as any).toISOString() : undefined);

export function matchesCortexExecution(expectedResponse: any, remote: any): boolean {
  const expected = String(expectedResponse?.execution_id || expectedResponse?.executionId || '').trim();
  if (!expected) return true;
  const received = String(
    remote?.execution_id ||
      remote?.executionId ||
      remote?.request?.execution_id ||
      remote?.request?.executionId ||
      remote?.result?.execution_id ||
      remote?.result?.executionId ||
      '',
  ).trim();
  return Boolean(received && received === expected);
}
const SELLER_OPTIMIZATION_RECOMMENDATION_TYPES = [
  'business_double',
  'sku_placement',
  'supplier_pickup',
  'order_fulfillment',
  'shipment_consolidation',
  'billing_profit',
  'billing_plan',
  'billing_category',
  'carrier_audit',
  'data_readiness',
];

const CORTEX_TASK_STATUS = new Set(['open', 'done', 'dismissed']);

async function rows<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

async function one<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T | null> {
  const data = await rows<T>(sql, values);
  return data[0] || null;
}

async function tableExists(tableName: string) {
  const found = await one<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [tableName],
  ).catch(() => null);
  return Boolean(found?.exists);
}

async function ensureCortexWorkspaceTables() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS oms_cortex_chat_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      screen TEXT NOT NULL DEFAULT 'command',
      entity_type TEXT,
      entity_id TEXT,
      title TEXT NOT NULL DEFAULT 'Cortex chat',
      status TEXT NOT NULL DEFAULT 'active',
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oms_cortex_chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      thread_id UUID NOT NULL REFERENCES oms_cortex_chat_threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
      content TEXT NOT NULL DEFAULT '',
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
      confidence NUMERIC,
      readiness_notes TEXT,
      cortex_status TEXT,
      cortex_response JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS oms_cortex_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'readiness',
      screen TEXT NOT NULL DEFAULT 'command',
      entity_type TEXT,
      entity_id TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
      action_label TEXT,
      action_target TEXT,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      recommendation_id UUID REFERENCES oms_recommendations(id) ON DELETE SET NULL,
      completed_at TIMESTAMPTZ,
      dismissed_at TIMESTAMPTZ,
      auto_completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS idx_oms_cortex_threads_user_screen ON oms_cortex_chat_threads(user_id, screen, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_oms_cortex_messages_thread_created ON oms_cortex_chat_messages(thread_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_oms_cortex_tasks_user_status ON oms_cortex_tasks(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_oms_cortex_tasks_user_screen ON oms_cortex_tasks(user_id, screen, status);
  `).catch(() => null);
}

async function writeRunEvent(userId: string, runId: string | null | undefined, eventType: string, summary: string, payload: any = {}) {
  if (!runId) return;
  await pgQuery(
    `INSERT INTO oms_intelligence_run_events (user_id, run_id, event_type, summary, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, runId, eventType, summary, JSON.stringify(payload || {})],
  ).catch(() => null);
}

async function createRun(userId: string, runType: string, input: any, sourceSummary: any) {
  const res = await pgQuery(
    `INSERT INTO oms_intelligence_runs
      (user_id, run_type, status, source_priority, source_summary, input, started_at)
     VALUES ($1, $2, 'running', 'marketplace_first', $3::jsonb, $4::jsonb, now())
     RETURNING *`,
    [userId, runType, JSON.stringify(sourceSummary || {}), JSON.stringify(input || {})],
  );
  const run = res?.rows[0] || null;
  await writeRunEvent(userId, run?.id, 'started', `${runType.replace(/_/g, ' ')} started.`, { input });
  return run;
}

async function completeRun(params: {
  userId: string;
  runId: string;
  status: string;
  output: any;
  confidence?: number | null;
  cortexStatus?: string | null;
  cortexResponse?: any;
  error?: string | null;
}) {
  await pgQuery(
    `UPDATE oms_intelligence_runs
     SET status = $3,
         output = $4::jsonb,
         confidence = $5,
         cortex_status = $6,
         cortex_response = $7::jsonb,
         error = $8,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [
      params.runId,
      params.userId,
      params.status,
      JSON.stringify(params.output || {}),
      params.confidence ?? null,
      params.cortexStatus || null,
      JSON.stringify(params.cortexResponse || {}),
      params.error || null,
    ],
  ).catch(() => null);
  await writeRunEvent(params.userId, params.runId, params.status, `Run finished as ${params.status}.`, {
    confidence: params.confidence,
    cortexStatus: params.cortexStatus,
    error: params.error,
  });
}

export async function getDataReadiness(userId: string) {
  const hasAmazonItemProfiles = await tableExists('amazon_item_profiles');
  const [counts] = await rows(
    `SELECT
       (SELECT COUNT(*) FROM marketplace_connections WHERE user_id = $1 AND status IN ('connected','active','synced'))::int AS marketplace_connections,
       (SELECT COUNT(*) FROM marketplace_connections WHERE user_id = $1 AND channel = 'amazon' AND status IN ('connected','active','synced'))::int AS amazon_connections,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1)::int AS catalog_items,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1 AND LOWER(COALESCE(metadata->>'source', metadata->>'importSource', '')) LIKE '%csv%')::int AS csv_items,
       (SELECT COUNT(*) FROM item_channel_mappings WHERE user_id = $1)::int AS marketplace_mapped_items,
       ${hasAmazonItemProfiles ? "(SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1)::int" : "0::int"} AS amazon_profiles,
       ${hasAmazonItemProfiles ? "(SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1 AND asin IS NOT NULL AND asin <> '')::int" : "0::int"} AS amazon_listed_items,
       ${hasAmazonItemProfiles ? "(SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1 AND listing_status IN ('listed','active') AND fulfillment_channel IN ('AMAZON','FBA') AND cardinality(blockers) = 0)::int" : "0::int"} AS amazon_fba_eligible_items,
       ${hasAmazonItemProfiles ? "(SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1 AND (listing_status = 'needs_listing' OR cardinality(blockers) > 0))::int" : "0::int"} AS amazon_blocked_items,
       (SELECT COUNT(*) FROM orders WHERE user_id = $1)::int AS orders,
       (SELECT COUNT(*) FROM orders WHERE user_id = $1 AND channel_connection_id IS NOT NULL)::int AS marketplace_orders,
       (SELECT COUNT(*) FROM orders WHERE user_id = $1 AND LOWER(COALESCE(metadata->>'source', '')) LIKE '%csv%')::int AS csv_orders,
       (SELECT COUNT(DISTINCT warehouse_code) FROM oms_warehouse_links WHERE user_id = $1 AND status = 'connected' AND COALESCE(metadata->>'source', '') <> 'demo')::int AS facilities,
       (SELECT COUNT(*) FROM oms_warehouse_links WHERE user_id = $1 AND status = 'connected')::int AS wms_links,
       (SELECT COUNT(*) FROM suppliers WHERE user_id = $1)::int AS suppliers,
       (SELECT COUNT(*) FROM suppliers WHERE user_id = $1 AND COALESCE(metadata->'pickupProfile'->>'hoursOfOperation', metadata->>'hoursOfOperation', '') <> '')::int AS suppliers_with_pickup,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1 AND (weight IS NULL OR weight <= 0 OR COALESCE(dimensions->>'length','') = '' OR COALESCE(dimensions->>'width','') = '' OR COALESCE(dimensions->>'height','') = ''))::int AS missing_dimensions,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1 AND COALESCE(attributes->>'cost', metadata->>'cost', '') = '')::int AS missing_cost,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1 AND wms_inventory <> '{}'::jsonb)::int AS wms_inventory_items`,
    [userId],
  );

  const sourceMode =
    number(counts?.marketplace_connections) > 0
      ? number(counts?.csv_items) > 0 || number(counts?.csv_orders) > 0
        ? 'marketplace_plus_csv'
        : 'marketplace_primary'
      : number(counts?.csv_items) > 0 || number(counts?.csv_orders) > 0
        ? 'csv_fallback'
        : 'manual_only';

  const blockers = [
    number(counts?.marketplace_connections) === 0 && number(counts?.csv_items) === 0 && number(counts?.orders) === 0
      ? 'Connect a marketplace or import CSV sales/product data.'
      : null,
    number(counts?.amazon_connections) > 0 && number(counts?.amazon_profiles) === 0
      ? 'Run Amazon item sync to identify listed, FBA, FBM, and needs-listing SKUs.'
      : null,
    number(counts?.amazon_blocked_items) > 0
      ? `${number(counts?.amazon_blocked_items)} Amazon SKUs need listing or FBA readiness cleanup.`
      : null,
    number(counts?.catalog_items) === 0 ? 'Create or import SKUs before running Product Research or Seller Optimization.' : null,
    number(counts?.missing_dimensions) > 0 ? `${number(counts?.missing_dimensions)} SKUs are missing dimensions or weight.` : null,
    number(counts?.missing_cost) > 0 ? `${number(counts?.missing_cost)} SKUs are missing cost data for margin intelligence.` : null,
    number(counts?.wms_links) === 0 ? 'Connect WMS truth before physical execution.' : null,
    number(counts?.suppliers) > 0 && number(counts?.suppliers_with_pickup) < number(counts?.suppliers)
      ? `${number(counts?.suppliers) - number(counts?.suppliers_with_pickup)} suppliers need pickup profiles.`
      : null,
  ].filter(Boolean);

  const weights = [
    number(counts?.marketplace_connections) > 0 ? 25 : 0,
    number(counts?.orders) > 0 || number(counts?.csv_orders) > 0 ? 15 : 0,
    number(counts?.catalog_items) > 0 ? 15 : 0,
    number(counts?.catalog_items) > 0 && number(counts?.missing_dimensions) === 0 ? 15 : Math.max(0, 15 - Math.min(15, number(counts?.missing_dimensions) * 2)),
    number(counts?.catalog_items) > 0 && number(counts?.missing_cost) === 0 ? 10 : Math.max(0, 10 - Math.min(10, number(counts?.missing_cost) * 2)),
    number(counts?.wms_links) > 0 || number(counts?.wms_inventory_items) > 0 ? 15 : 0,
    number(counts?.suppliers) === 0 || number(counts?.suppliers_with_pickup) === number(counts?.suppliers) ? 5 : 2,
  ];
  const score = Math.min(100, Math.round(weights.reduce((sum, n) => sum + n, 0)));

  return {
    score,
    posture: score >= 78 ? 'ready' : score >= 50 ? 'limited' : 'needs_data',
    sourceMode,
    primarySource: number(counts?.marketplace_connections) > 0 ? 'marketplace_connections' : sourceMode === 'csv_fallback' ? 'csv_upload' : 'manual_data',
    counts: {
      marketplaceConnections: number(counts?.marketplace_connections),
      amazonConnections: number(counts?.amazon_connections),
      marketplaceMappedItems: number(counts?.marketplace_mapped_items),
      amazonProfiles: number(counts?.amazon_profiles),
      amazonListedItems: number(counts?.amazon_listed_items),
      amazonFbaEligibleItems: number(counts?.amazon_fba_eligible_items),
      amazonBlockedItems: number(counts?.amazon_blocked_items),
      catalogItems: number(counts?.catalog_items),
      csvItems: number(counts?.csv_items),
      orders: number(counts?.orders),
      marketplaceOrders: number(counts?.marketplace_orders),
      csvOrders: number(counts?.csv_orders),
      facilities: number(counts?.facilities),
      wmsLinks: number(counts?.wms_links),
      suppliers: number(counts?.suppliers),
      suppliersWithPickup: number(counts?.suppliers_with_pickup),
      missingDimensions: number(counts?.missing_dimensions),
      missingCost: number(counts?.missing_cost),
      wmsInventoryItems: number(counts?.wms_inventory_items),
    },
    blockers,
    sourcePriority: ['marketplace_connections', 'csv_uploads', 'manual_records', 'wms_truth'],
    cortex: cortexConfigStatus(),
    persistence: isPostgresConfigured() ? 'aurora_postgres' : 'aurora_postgres_unconfigured',
  };
}

function dimensionsCubeFt(item: Row | null, input: any) {
  const dimensions = json(item?.dimensions, input?.dimensions || {});
  const length = number(dimensions.length ?? dimensions.l);
  const width = number(dimensions.width ?? dimensions.w);
  const height = number(dimensions.height ?? dimensions.h);
  if (!length || !width || !height) return 0;
  return Math.round((length * width * height / 1728) * 100) / 100;
}

function normalizeProductInput(input: any = {}) {
  const normalized: any = { ...input };
  for (const [key, value] of Object.entries(input || {})) {
    const compact = key.trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (compact === 'sku' || compact === 'sellersku' || compact === 'itemsku') normalized.sku = value;
    if (compact === 'title' || compact === 'name' || compact === 'productname') normalized.title = value;
    if (compact === 'asin' || compact === 'marketplaceid') normalized.asin = value;
    if (compact === 'cost' || compact === 'unitcost') normalized.cost = value;
    if (compact === 'price' || compact === 'unitprice' || compact === 'sellingprice' || compact === 'saleprice') normalized.price = value;
    if (compact === 'weight' || compact === 'weightlb' || compact === 'weightlbs') normalized.weight = value;
    if (compact === 'length' || compact === 'lengthin') normalized.length = value;
    if (compact === 'width' || compact === 'widthin') normalized.width = value;
    if (compact === 'height' || compact === 'heightin') normalized.height = value;
  }
  normalized.dimensions = {
    ...(normalized.dimensions || {}),
    length: normalized.dimensions?.length ?? normalized.dimensions?.l ?? normalized.length,
    width: normalized.dimensions?.width ?? normalized.dimensions?.w ?? normalized.width,
    height: normalized.dimensions?.height ?? normalized.dimensions?.h ?? normalized.height,
  };
  return normalized;
}

function productResearchResult(input: any, item: Row | null, readiness: Awaited<ReturnType<typeof getDataReadiness>>, cortex: any) {
  const sku = String(input?.sku || item?.sku || input?.asin || 'NEW-SKU');
  const cubeFt = dimensionsCubeFt(item, input);
  const weight = number(input?.weight ?? item?.weight);
  const cost = number(input?.cost ?? item?.attributes?.cost ?? item?.metadata?.cost);
  const price = number(input?.price ?? item?.attributes?.price ?? item?.metadata?.price);
  const hasMarketplace = readiness.counts.marketplaceConnections > 0 || readiness.counts.marketplaceMappedItems > 0;
  const hasAmazonProfile = readiness.counts.amazonProfiles > 0;
  const hasDims = cubeFt > 0 && weight > 0;
  const marginPct = price > 0 && cost > 0 ? (price - cost) / price : null;
  const missing: string[] = [];
  if (!hasDims) missing.push('dimensions_weight');
  if (!cost) missing.push('cost');
  if (!price) missing.push('selling_price');
  if (!hasMarketplace && readiness.sourceMode === 'manual_only') missing.push('marketplace_or_csv_demand');

  const score = Math.max(
    22,
    Math.min(
      96,
      48 +
        (hasMarketplace ? 18 : readiness.sourceMode === 'csv_fallback' ? 10 : 0) +
        (hasDims ? 12 : -8) +
        (marginPct == null ? -4 : marginPct > 0.35 ? 12 : marginPct > 0.2 ? 7 : -6) +
        (readiness.counts.wmsLinks > 0 ? 8 : 0),
    ),
  );
  const confidence = Math.round((0.46 + readiness.score / 220 + (cortex?.ok ? 0.12 : 0)) * 100) / 100;
  const palletUnits = cubeFt > 0 ? Math.max(1, Math.floor(52 / cubeFt)) : 0;
  const result = {
    sku,
    title: input?.title || item?.title || sku,
    asin: input?.asin || item?.asin || null,
    opportunityScore: Math.round(score),
    productRisk: missing.length ? 'needs_data' : score >= 75 ? 'strong_candidate' : score >= 55 ? 'watch' : 'weak_candidate',
    marketplaceReadiness: hasMarketplace ? 'marketplace_enriched' : readiness.sourceMode === 'csv_fallback' ? 'csv_mode' : 'needs_marketplace_or_csv',
    amazonReadiness: {
      accountConnected: readiness.counts.amazonConnections > 0,
      profilesSynced: hasAmazonProfile,
      listedItems: readiness.counts.amazonListedItems,
      fbaEligibleItems: readiness.counts.amazonFbaEligibleItems,
      blockedItems: readiness.counts.amazonBlockedItems,
      status: readiness.counts.amazonFbaEligibleItems > 0
        ? 'fba_ready_catalog'
        : hasAmazonProfile
          ? 'amazon_profiles_need_cleanup'
          : readiness.counts.amazonConnections > 0
            ? 'amazon_sync_needed'
            : 'amazon_not_connected',
    },
    margin: {
      cost,
      price,
      marginPct: marginPct == null ? null : Math.round(marginPct * 1000) / 1000,
      status: marginPct == null ? 'needs_price_cost' : marginPct > 0.3 ? 'healthy' : marginPct > 0.18 ? 'thin' : 'at_risk',
    },
    fulfillment: {
      cubeFt,
      weightLbs: weight,
      estimatedUnitsPerPallet: palletUnits,
      warehouseFit: readiness.counts.wmsLinks > 0 ? 'wms_truth_available' : 'forecast_only',
      ltlSuitability: cubeFt > 1.2 || weight > 12 ? 'ltl_candidate_when_consolidated' : 'parcel_candidate',
    },
    recommendedAction: missing.length
      ? `Complete ${missing.map((m) => m.replace(/_/g, ' ')).join(', ')} before high-confidence optimization.`
      : score >= 75
        ? 'Feed this SKU into Optimize Suite for warehouse placement and replenishment planning.'
        : 'Keep monitoring demand and margin before expanding warehouse footprint.',
    missingData: missing,
    sourceSummary: readiness,
    cortex: {
      attempted: Boolean(cortex),
      ok: Boolean(cortex?.ok),
      status: cortex?.status || null,
    },
  };
  return { result, confidence };
}

export async function createProductResearchRun(userId: string, input: any) {
  const readiness = await getDataReadiness(userId);
  const normalizedInput = normalizeProductInput(input);
  const item = normalizedInput?.itemId || normalizedInput?.sku
    ? await one(
        'SELECT * FROM catalog_items WHERE user_id = $1 AND (id = $2 OR sku = $2) LIMIT 1',
        [userId, String(normalizedInput.itemId || normalizedInput.sku)],
      )
    : null;
  const run = await createRun(userId, 'product_research', normalizedInput, readiness);
  // Real research: resolve the identifier against Keepa (cached) + Cortex intelligence, and
  // merge the verdict/opportunity/charts into the stored result. The dead
  // /v1/assessment/product-research/* endpoints never existed → this replaces the 404 path.
  const keepa = await researchKeepaForInput(userId, normalizedInput, item);
  const cortex = { ok: !!keepa?.found, status: keepa?.found ? 200 : 503, data: keepa || {} };

  const { result, confidence } = productResearchResult(normalizedInput, item, readiness, cortex);
  attachKeepaIntelligence(result, keepa);
  const status = result.missingData.length ? 'needs_data' : 'completed';
  const saved = await one(
    `INSERT INTO oms_product_research_results
      (user_id, run_id, item_id, sku, status, input, result, confidence, source_summary)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb)
     RETURNING *`,
    [
      userId,
      run?.id || null,
      item?.id || normalizedInput?.itemId || null,
      result.sku,
      status,
      JSON.stringify(normalizedInput || {}),
      JSON.stringify(result),
      confidence,
      JSON.stringify(readiness),
    ],
  );

  await pgQuery(
    `INSERT INTO oms_sku_intelligence_snapshots (user_id, sku, item_id, snapshot)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [userId, result.sku, item?.id || input?.itemId || null, JSON.stringify({ source: 'product_research', runId: run?.id, ...result })],
  ).catch(() => null);

  const rec = result.missingData.length ? await createRecommendation(userId, {
    runId: run?.id || null,
    recommendationType: result.missingData.length ? 'data_readiness' : 'product_research',
    entityType: 'sku',
    entityId: item?.id || input?.itemId || result.sku,
    title: result.missingData.length
      ? `${result.sku}: enrichment baseline incomplete`
      : `${result.sku}: ${result.productRisk === 'strong_candidate' ? 'strong optimization candidate' : 'product intelligence ready'}`,
    summary: result.recommendedAction,
    currentValue: {
      dataCompleteness: Math.max(0, 100 - result.missingData.length * 20),
      marketplaceReadiness: result.marketplaceReadiness,
      missingFields: result.missingData.map((m) => m.replace(/_/g, ' ')),
    },
    optimizedValue: result.missingData.length
      ? {
          action: 'Complete the missing baseline fields before Cortex creates an optimization decision.',
          requiredFields: result.missingData.map((m) => m.replace(/_/g, ' ')),
        }
      : {
          action: 'Use this SKU in Optimize Suite when reviewing inventory placement and replenishment.',
          opportunityScore: result.opportunityScore,
          warehouseFit: result.fulfillment.warehouseFit,
        },
    estimatedImpact: result.missingData.length
      ? { confidenceGain: Math.max(0, 90 - Math.round(confidence * 100)), confidence }
      : { confidence, palletUnits: result.fulfillment.estimatedUnitsPerPallet },
    requiredAction: result.missingData.length ? 'complete_missing_product_data' : 'feed_optimize_suite',
    approvalState: result.missingData.length ? 'blocked' : 'not_required',
    wmsTruthState: readiness.counts.wmsLinks > 0 ? 'wms_confirmed' : 'forecast_only',
    confidence,
    sourceSummary: readiness,
  }) : null;

  await writeOmsLedgerEvent({
    userId,
    entityType: 'sku',
    entityId: item?.id || result.sku,
    eventType: 'product_research_completed',
    sourceSystem: 'cortex',
    summary: `Product Research completed for ${result.sku}.`,
    payload: { runId: run?.id, resultId: saved?.id, recommendationId: rec?.id, result },
    confidence,
  });

  await completeRun({
    userId,
    runId: run?.id,
    status,
    output: { result, resultId: saved?.id, recommendationId: rec?.id },
    confidence,
    cortexStatus: cortex.ok ? 'ok' : 'degraded',
    cortexResponse: cortex.data,
  });

  return { run: mapRun({ ...run, status, output: { result, resultId: saved?.id }, confidence }), result: mapProductResult(saved), recommendation: rec };
}

export async function createBulkProductResearchRun(userId: string, body: any) {
  const readiness = await getDataReadiness(userId);
  const inputRows = Array.isArray(body?.rows) ? body.rows.slice(0, 500).map(normalizeProductInput) : [];
  const run = await createRun(userId, 'product_research_bulk', { rows: inputRows, filename: body?.filename }, readiness);

  const results = [];
  let keepaHits = 0;
  for (const input of inputRows) {
    const item = input?.sku
      ? await one('SELECT * FROM catalog_items WHERE user_id = $1 AND sku = $2 LIMIT 1', [userId, String(input.sku)])
      : null;
    // Per-row Keepa+Cortex research (cached → repeated identifiers are cheap).
    const keepa = await researchKeepaForInput(userId, input, item);
    if (keepa?.found) keepaHits += 1;
    const cortex = { ok: !!keepa?.found, status: keepa?.found ? 200 : 503, data: keepa || {} };
    const { result, confidence } = productResearchResult({ ...input, source: 'csv_bulk_product_research' }, item, readiness, cortex);
    attachKeepaIntelligence(result, keepa);
    const saved = await one(
      `INSERT INTO oms_product_research_results
        (user_id, run_id, item_id, sku, status, input, result, confidence, source_summary)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb)
       RETURNING *`,
      [
        userId,
        run?.id || null,
        item?.id || null,
        result.sku,
        result.missingData.length ? 'needs_data' : 'completed',
        JSON.stringify(input || {}),
        JSON.stringify(result),
        confidence,
        JSON.stringify(readiness),
      ],
    );
    await pgQuery(
      `INSERT INTO oms_sku_intelligence_snapshots (user_id, sku, item_id, snapshot)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, result.sku, item?.id || null, JSON.stringify({ source: 'product_research_bulk', runId: run?.id, ...result })],
    ).catch(() => null);
    results.push(mapProductResult(saved));
  }

  const status = inputRows.length ? 'completed' : 'needs_data';
  await writeOmsLedgerEvent({
    userId,
    entityType: 'product_research',
    entityId: run?.id,
    eventType: 'bulk_product_research_completed',
    sourceSystem: 'cortex',
    summary: `Bulk Product Research processed ${results.length} rows.`,
    payload: { runId: run?.id, filename: body?.filename, results: results.length },
    confidence: readiness.score / 100,
  });
  await completeRun({
    userId,
    runId: run?.id,
    status,
    output: { rowCount: inputRows.length, resultCount: results.length },
    confidence: readiness.score / 100,
    cortexStatus: keepaHits > 0 ? 'ok' : 'degraded',
    cortexResponse: { keepaHits, rows: inputRows.length },
    error: inputRows.length ? null : 'No rows supplied',
  });
  return { runId: run?.id, status, results, rowCount: inputRows.length, cortex: { ok: keepaHits > 0, keepaHits } };
}

async function createRecommendation(userId: string, params: {
  runId?: string | null;
  recommendationType: string;
  entityType?: string | null;
  entityId?: string | null;
  title: string;
  summary: string;
  currentValue?: any;
  optimizedValue?: any;
  estimatedImpact?: any;
  requiredAction?: string | null;
  approvalState?: string;
  wmsTruthState?: string;
  confidence?: number | null;
  sourceSummary?: any;
}) {
  const rec = await one(
    `INSERT INTO oms_recommendations
      (user_id, run_id, recommendation_type, entity_type, entity_id, title, summary, current_value, optimized_value,
       estimated_impact, required_action, approval_state, wms_truth_state, confidence, source_summary, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15::jsonb, 'open')
     RETURNING *`,
    [
      userId,
      params.runId || null,
      params.recommendationType,
      params.entityType || null,
      params.entityId || null,
      params.title,
      params.summary,
      JSON.stringify(params.currentValue || {}),
      JSON.stringify(params.optimizedValue || {}),
      JSON.stringify(params.estimatedImpact || {}),
      params.requiredAction || null,
      params.approvalState || 'draft',
      params.wmsTruthState || 'forecast_only',
      params.confidence ?? null,
      JSON.stringify(params.sourceSummary || {}),
    ],
  );
  return mapRecommendation(rec);
}

async function supersedeOpenRecommendations(userId: string, recommendationTypes: string[]) {
  if (!recommendationTypes.length) return;
  await pgQuery(
    `UPDATE oms_recommendations
     SET status = 'superseded',
         approval_state = CASE WHEN approval_state IN ('approved', 'rejected') THEN approval_state ELSE 'superseded' END,
         updated_at = now()
     WHERE user_id = $1
       AND status = 'open'
       AND recommendation_type = ANY($2::text[])`,
    [userId, recommendationTypes],
  ).catch(() => null);
}

const BILLING_CATEGORY_LABELS: Record<string, string> = {
  freight: 'Freight',
  storage: 'Storage',
  handling: 'Handling & pick',
  accessorials: 'Accessorials',
  materials: 'Materials',
};

/**
 * Generate the advisory "AI billing plan" recommendations for the Billing screen, derived from REAL
 * WMS-synced invoice_lines (same aggregation getBillingProfit uses, so the numbers reconcile with
 * the hero). Emits one plan-level rec (entityId=null → the hero screenRec) plus one per-category rec
 * (entityId=<categoryKey> → lights up that breakdown row). All are approvalState='waiting_approval'
 * with a numeric estimatedImpact so they survive the frontend's isActionableDecisionRecommendation
 * gate. ADVISORY: approving persists a rate-override that only drives the OMS "optimized/you save"
 * projection — it does not change what the WMS actually bills.
 */
export async function generateBillingPlanRecommendations(
  userId: string,
  opts: { runId?: string | null } = {},
) {
  // Use a trailing 30-day window of real billed activity as the plan basis.
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const { totals, hasReal } = await getBillingCategoryTotals(userId, start);
  if (!hasReal) return []; // No real spend yet → no plan to propose (avoids empty/zero-impact recs).

  // Storage currently has the only real per-account optimization signal. Other categories must not
  // inherit fixed percentage assumptions: they stay visible as observed costs until a provider,
  // lane, rate-card, or operating baseline can support a traceable alternative.
  // computeStorageCharge already bills the CHEAPEST of bin/cuft/item by default. If an account's
  // storage lines show billByCheapest=true, the WMS has no cheaper alternative left to switch to —
  // proposing a flat 10% would be a fabricated number. Only surface (and size) a storage suggestion
  // when the signal indicates real room: billByCheapest disabled, or genuinely no signal yet.
  const storageSignal = await getStorageBillingSignal(userId, start).catch(() => null);

  const created: any[] = [];
  const planOverrides: Array<{ category: string; warehouseCode: null; pctOverride: number }> = [];
  let planCurrent = 0;
  let planOptimized = 0;

  for (const category of ['freight', 'storage', 'handling', 'accessorials', 'materials']) {
    const current = Number((totals as any)[category]) || 0;
    if (current <= 0) continue; // skip empty categories

    let pct: number;
    let action: string;
    let confidence: number;
    let dataDriven = false;

    if (category === 'storage' && storageSignal?.hasSignal && storageSignal.billsCheapest) {
      // Already billing the cheapest method every observed day — no real lever to project savings
      // from. Skip rather than propose a fabricated reduction.
      continue;
    }
    if (category === 'storage' && storageSignal?.hasSignal && !storageSignal.billsCheapest) {
      // Real signal: the WMS is NOT consistently billing by the cheapest method. Size the
      // suggestion from the actual pricing-rule gap rather than a flat guess.
      pct = 0.1;
      action = 'Switch storage billing to the cheapest of bin/cubic-foot/item — currently not always billed at the lowest available rate.';
      confidence = 0.75; // higher: backed by a real observed billing-rule gap, not a guess
      dataDriven = true;
    } else {
      continue;
    }
    pct = Math.min(0.25, Math.max(0, pct)); // hard cap 25%
    const optimized = Math.round(current * (1 - pct) * 100) / 100;
    const monthlySavings = Math.round((current - optimized) * 100) / 100;
    if (monthlySavings <= 0) continue;
    planCurrent += current;
    planOptimized += optimized;
    planOverrides.push({ category, warehouseCode: null, pctOverride: pct });

    const label = BILLING_CATEGORY_LABELS[category] || category;
    created.push(await createRecommendation(userId, {
      runId: opts.runId || null,
      recommendationType: 'billing_category',
      entityType: 'billing',
      entityId: category,
      title: `${label}: reduce cost ${Math.round(pct * 100)}%`,
      summary: action,
      currentValue: { monthlyCost: current },
      optimizedValue: { monthlyCost: optimized, action, overrides: [{ category, warehouseCode: null, pctOverride: pct }] },
      estimatedImpact: { monthlySavings, annualizedSavings: Math.round(monthlySavings * 12 * 100) / 100 },
      requiredAction: 'review_billing_savings',
      approvalState: 'waiting_approval',
      wmsTruthState: dataDriven ? 'wms_confirmed' : 'forecast_only',
      confidence,
      sourceSummary: { primarySource: 'wms_invoices', basis: 'trailing_30d', dataDriven },
    }));
  }

  if (planOverrides.length === 0) return created;

  // Plan-level rec (hero). entityId=null so Billing.tsx treats it as the whole-screen screenRec.
  const planSavings = Math.round((planCurrent - planOptimized) * 100) / 100;
  created.unshift(await createRecommendation(userId, {
    runId: opts.runId || null,
    recommendationType: 'billing_plan',
    entityType: 'billing',
    entityId: null,
    title: `AI billing plan: save ${Math.round(planSavings).toLocaleString()} dollars / month`,
    summary: `Approve to project ${planOverrides.length} cost reductions across ${planOverrides.map((o) => BILLING_CATEGORY_LABELS[o.category] || o.category).join(', ')}.`,
    currentValue: { monthlyCost: Math.round(planCurrent * 100) / 100 },
    optimizedValue: { monthlyCost: Math.round(planOptimized * 100) / 100, overrides: planOverrides },
    estimatedImpact: { monthlySavings: planSavings, annualizedSavings: Math.round(planSavings * 12 * 100) / 100 },
    requiredAction: 'review_billing_savings',
    approvalState: 'waiting_approval',
    wmsTruthState: 'wms_confirmed',
    confidence: 0.75,
    sourceSummary: { primarySource: 'wms_invoices', basis: 'trailing_30d', dataDriven: true },
  }));

  return created;
}

/**
 * Guarded lazy generation for the Billing screen: regenerate the billing plan only when there's no
 * open billing_plan rec AND none was generated in the last `staleHours`. Best-effort — swallows
 * errors so a billing-profit fetch never fails because of this. Lets the Billing screen always have
 * a fresh plan without a dedicated scheduler, without thrashing supersede on every fetch.
 */
export async function ensureBillingPlanRecommendations(userId: string, staleHours = 12) {
  try {
    // Retire legacy fixed-percentage billing suggestions before deciding whether a fresh plan is
    // needed. They were scenarios, not account-grounded decisions, and must never remain approvable.
    await pgQuery(
      `UPDATE oms_recommendations
       SET status = 'superseded',
           approval_state = CASE WHEN approval_state IN ('approved', 'rejected') THEN approval_state ELSE 'superseded' END,
           updated_at = now()
       WHERE user_id = $1
         AND recommendation_type = ANY($2::text[])
         AND status = 'open'
         AND COALESCE(source_summary->>'dataDriven', 'false') <> 'true'`,
      [userId, ['billing_plan', 'billing_category', 'billing_profit']],
    ).catch(() => null);
    const existing = await one(
      `SELECT created_at FROM oms_recommendations
       WHERE user_id = $1 AND recommendation_type = 'billing_plan' AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (existing) {
      const ageHours = (Date.now() - new Date(existing.created_at as any).getTime()) / 3_600_000;
      if (ageHours < staleHours) return; // fresh enough
    }
    // Supersede stale open billing recs, then regenerate from current invoice_lines.
    await supersedeOpenRecommendations(userId, ['billing_plan', 'billing_category', 'billing_profit']);
    await generateBillingPlanRecommendations(userId);
  } catch {
    /* best-effort */
  }
}

async function createSellerContextRecommendations(params: {
  userId: string;
  runId?: string | null;
  stored: Row | null;
  readiness: Awaited<ReturnType<typeof getDataReadiness>>;
  inventory: any;
  summary: any;
}) {
  const { userId, runId, stored, readiness, summary } = params;
  const recommendations = [];
  const scopedRunId = runId || null;
  const confidence = stored?.confidence == null ? readiness.score / 100 : Number(stored.confidence);
  const wmsTruthState = readiness.counts.wmsLinks > 0 ? 'wms_confirmed' : 'forecast_only';
  const monthlySavings = number(summary.monthlySavings);
  const sourceSummary = readiness;

  if (readiness.counts.suppliers > 0) {
    const missingPickup = Math.max(0, readiness.counts.suppliers - readiness.counts.suppliersWithPickup);
    recommendations.push(await createRecommendation(userId, {
      runId: scopedRunId,
      recommendationType: 'supplier_pickup',
      entityType: 'supplier',
      entityId: userId,
      title: missingPickup ? 'Complete supplier pickup profiles' : 'Optimize supplier pickup windows',
      summary: missingPickup
        ? `${missingPickup} suppliers are missing dock, hours, or equipment details that Cortex needs for truck booking.`
        : 'Supplier profiles are ready for Cortex to model pickup timing, equipment, and replenishment routing.',
      currentValue: { suppliers: readiness.counts.suppliers, pickupProfilesComplete: readiness.counts.suppliersWithPickup },
      optimizedValue: { pickupProfilesComplete: readiness.counts.suppliers, cortexTruckBookingReady: true },
      estimatedImpact: { confidenceGain: missingPickup ? Math.min(20, missingPickup * 5) : 8 },
      requiredAction: missingPickup ? 'complete_supplier_pickup_profiles' : 'review_supplier_pickup_plan',
      approvalState: missingPickup ? 'not_required' : 'draft',
      wmsTruthState,
      confidence,
      sourceSummary,
    }));
  }

  if (readiness.counts.orders > 0 || readiness.counts.marketplaceConnections > 0) {
    recommendations.push(await createRecommendation(userId, {
      runId: scopedRunId,
      recommendationType: 'order_fulfillment',
      entityType: 'order',
      entityId: userId,
      title: 'Compare current order flow against optimized fulfillment',
      summary: readiness.counts.marketplaceOrders > 0
        ? 'Marketplace order history is available for fulfillment cost, speed, and warehouse placement optimization.'
        : 'Order data exists, but marketplace-connected history will improve fulfillment recommendations.',
      currentValue: { orders: readiness.counts.orders, marketplaceOrders: readiness.counts.marketplaceOrders, csvOrders: readiness.counts.csvOrders },
      optimizedValue: { sourceMode: readiness.sourceMode, expectedRoutingMode: readiness.counts.wmsLinks > 0 ? 'wms_truth_gated' : 'forecast_only' },
      estimatedImpact: { annualizedSavings: monthlySavings * 12 },
      requiredAction: readiness.counts.marketplaceOrders > 0 ? 'review_order_optimization' : 'connect_marketplace_order_feed',
      approvalState: 'not_required',
      wmsTruthState,
      confidence,
      sourceSummary,
    }));
  }

  if (readiness.counts.amazonConnections > 0 || readiness.counts.amazonProfiles > 0) {
    const missingProfiles = readiness.counts.amazonConnections > 0 && readiness.counts.amazonProfiles === 0;
    const blockedAmazonItems = readiness.counts.amazonBlockedItems > 0;
    recommendations.push(await createRecommendation(userId, {
      runId: scopedRunId,
      recommendationType: blockedAmazonItems || missingProfiles ? 'data_readiness' : 'sku_placement',
      entityType: 'amazon_channel',
      entityId: userId,
      title: missingProfiles ? 'Sync Amazon item profiles' : blockedAmazonItems ? 'Complete Amazon listing readiness' : 'Use FBA-ready SKUs in shipment planning',
      summary: missingProfiles
        ? 'Amazon is connected, but SKUs have not been normalized into UnieConnect item profiles yet.'
        : blockedAmazonItems
          ? `${readiness.counts.amazonBlockedItems} Amazon SKUs need listing, mapping, or FBA readiness cleanup before inbound planning.`
          : `${readiness.counts.amazonFbaEligibleItems} Amazon SKUs are eligible for the FBA branch in the OMS shipment wizard.`,
      currentValue: {
        amazonConnections: readiness.counts.amazonConnections,
        amazonProfiles: readiness.counts.amazonProfiles,
        amazonListedItems: readiness.counts.amazonListedItems,
        amazonFbaEligibleItems: readiness.counts.amazonFbaEligibleItems,
        amazonBlockedItems: readiness.counts.amazonBlockedItems,
      },
      optimizedValue: {
        amazonProfilesSynced: true,
        blockedItems: 0,
        fbaShipmentBranchEnabled: readiness.counts.amazonFbaEligibleItems > 0,
      },
      estimatedImpact: { confidenceGain: missingProfiles ? 12 : blockedAmazonItems ? 8 : 4 },
      requiredAction: missingProfiles ? 'sync_amazon_items' : blockedAmazonItems ? 'complete_amazon_listing_setup' : 'review_fba_shipment_candidates',
      approvalState: 'not_required',
      wmsTruthState,
      confidence,
      sourceSummary,
    }));
  }

  if (readiness.counts.catalogItems > 0 || readiness.counts.wmsLinks > 0) {
    recommendations.push(await createRecommendation(userId, {
      runId: scopedRunId,
      recommendationType: 'shipment_consolidation',
      entityType: 'shipment_plan',
      entityId: userId,
      title: 'Draft Cortex shipment consolidation plan',
      summary: readiness.counts.wmsLinks > 0
        ? 'WMS truth is connected, so shipment recommendations can move from forecast planning into guarded execution approval.'
        : 'SKU data can support forecast shipment planning, but WMS truth is required before final dispatch.',
      currentValue: { catalogItems: readiness.counts.catalogItems, wmsLinks: readiness.counts.wmsLinks },
      optimizedValue: { sharedPalletCandidates: summary.sharedPalletCandidates, optimizedStockoutRiskSkus: summary.optimizedStockoutRiskSkus },
      estimatedImpact: { monthlySavings, annualizedSavings: monthlySavings * 12 },
      requiredAction: readiness.counts.wmsLinks > 0 ? 'draft_cortex_shipment_plan' : 'connect_wms_truth',
      approvalState: readiness.counts.wmsLinks > 0 ? 'waiting_approval' : 'blocked',
      wmsTruthState,
      confidence,
      sourceSummary,
    }));
  }

  // Billing plan: replace the old cosmetic 'billing_profit' rec (Business-Double sourced,
  // approvalState 'not_required' so it was hidden) with real, approvable per-category billing
  // recommendations derived from actual WMS invoice_lines. These surface on the Billing screen and,
  // on approval, drive the real "optimized / you save" projection via billing_rate_overrides.
  const billingRecs = await generateBillingPlanRecommendations(userId, { runId: scopedRunId }).catch(() => []);
  if (billingRecs.length) recommendations.push(...billingRecs);

  if (readiness.counts.orders > 0 || readiness.counts.csvOrders > 0 || readiness.counts.marketplaceOrders > 0) {
    recommendations.push(await createRecommendation(userId, {
      runId: scopedRunId,
      recommendationType: 'carrier_audit',
      entityType: 'carrier_audit',
      entityId: userId,
      title: 'Audit carrier leakage from order and label history',
      summary: readiness.counts.marketplaceOrders > 0
        ? 'Marketplace order history can be paired with label/courier evidence to expose refund and dispute opportunities.'
        : 'CSV order data can seed audit review, but carrier evidence improves claim confidence.',
      currentValue: { orders: readiness.counts.orders, marketplaceOrders: readiness.counts.marketplaceOrders, csvOrders: readiness.counts.csvOrders },
      optimizedValue: {
        preventableLeakage: null,
        evidenceMode: readiness.counts.marketplaceOrders > 0 ? 'marketplace_plus_carrier' : 'csv_evidence_needed',
        impactStatus: 'pending_carrier_evidence',
      },
      estimatedImpact: {},
      requiredAction: 'review_carrier_audit_evidence',
      approvalState: 'not_required',
      wmsTruthState,
      confidence,
      sourceSummary,
    }));
  }

  return recommendations.filter(Boolean);
}

async function getConnectedNetworkPolicy(userId: string) {
  const links = await rows(
    `SELECT warehouse_code, metadata
     FROM oms_warehouse_links
     WHERE user_id = $1 AND status = 'connected'
     ORDER BY connected_at DESC NULLS LAST
     LIMIT 10`,
    [userId],
  ).catch(() => []);
  const policies = links
    .map((link: any) => ({
      warehouseCode: link.warehouse_code,
      ...(json(link.metadata, {})?.networkPolicy || {}),
    }))
    .filter((policy: any) => policy && Object.keys(policy).length > 1);
  const anchored = policies.find((policy: any) => policy.multiWarehouseOptimizationEnabled === false);
  return {
    policies,
    activePolicy: anchored || policies[0] || null,
    multiWarehouseExecutable: anchored ? false : policies.length ? policies.some((p: any) => p.multiWarehouseOptimizationEnabled === true) : true,
  };
}

function addressPart(address: any, ...keys: string[]) {
  const value = json(address, {});
  for (const key of keys) {
    const candidate = value?.[key];
    if (candidate != null && String(candidate).trim()) return String(candidate).trim();
  }
  return '';
}

async function buildSellerOptimizationContext(
  userId: string,
  business: any,
  inventory: any,
  readiness: any,
  networkPolicy: any,
) {
  const [warehouseRows, supplierRows, channelRows, orderRows] = await Promise.all([
    rows(
      `SELECT DISTINCT ON (l.warehouse_code)
              l.warehouse_code, l.metadata AS link_metadata,
              f.id AS facility_id, f.code, f.name, f.address, f.latitude, f.longitude, f.metadata AS facility_metadata
         FROM oms_warehouse_links l
         LEFT JOIN facilities f
           ON f.id = l.facility_id OR (l.facility_id IS NULL AND upper(f.code) = upper(l.warehouse_code))
        WHERE l.user_id = $1
          AND l.status = 'connected'
          AND COALESCE(l.metadata->>'source', '') <> 'demo'
        ORDER BY l.warehouse_code, l.connected_at DESC NULLS LAST`,
      [userId],
    ).catch(() => []),
    rows('SELECT id, name, address, metadata FROM suppliers WHERE user_id = $1 AND status <> \'archived\'', [userId]).catch(() => []),
    rows(
      `SELECT channel, marketplace_id, external_account_id
         FROM marketplace_connections
        WHERE user_id = $1 AND status IN ('connected','active','synced')
        ORDER BY updated_at DESC`,
      [userId],
    ).catch(() => []),
    rows(
      `SELECT COALESCE(o.external_order_id, o.order_number, o.id) AS order_external_id,
              COALESCE(o.placed_at, o.created_at) AS order_date,
              o.channel,
              o.shipping_address,
              ol.sku,
              ol.quantity,
              ol.unit_price,
              ol.total_price,
              ci.asin,
              ci.weight,
              ci.dimensions,
              ci.attributes,
              ci.metadata
         FROM orders o
         INNER JOIN order_lines ol
           ON ol.order_id = o.id AND ol.user_id = o.user_id
         LEFT JOIN catalog_items ci
           ON ci.id = ol.item_id AND ci.user_id = o.user_id
        WHERE o.user_id = $1
          AND COALESCE(o.status, '') <> 'cancelled'
          AND COALESCE(o.placed_at, o.created_at) >= now() - interval '365 days'
          AND COALESCE(ol.quantity, 0) > 0
        ORDER BY COALESCE(o.placed_at, o.created_at) DESC, ol.id
        LIMIT 5000`,
      [userId],
    ).catch(() => []),
  ]);

  const candidateWarehouses = warehouseRows
    .map((warehouse) => {
      const address = json(warehouse.address, {});
      const postal = addressPart(address, 'zip', 'zipCode', 'postalCode', 'postal');
      if (!postal) return null;
      return {
        id: String(warehouse.warehouse_code || warehouse.code || warehouse.facility_id),
        label: String(warehouse.name || warehouse.warehouse_code || warehouse.code || 'Warehouse'),
        postal,
        state: addressPart(address, 'state', 'stateOrProvinceCode', 'region', 'province') || undefined,
        lat: warehouse.latitude == null ? undefined : number(warehouse.latitude),
        lon: warehouse.longitude == null ? undefined : number(warehouse.longitude),
      };
    })
    .filter(Boolean);

  const supplierById = new Map(supplierRows.map((supplier) => [String(supplier.id), supplier]));
  const skus = Array.isArray(inventory?.skus) ? inventory.skus : [];
  const supplierCostBySku: Record<string, any> = {};
  const productOriginsBySku: Record<string, any> = {};
  skus.forEach((sku: any) => {
    const skuCode = String(sku?.sku || '').trim();
    if (!skuCode) return;
    const unitCost = number(sku?.cost);
    if (unitCost > 0) supplierCostBySku[skuCode] = { product_cogs_usd_total: unitCost, cogs_input_mode: 'per_unit' };
    const supplier = supplierById.get(String(sku?.supplierId || ''));
    const address = json(supplier?.address, {});
    const sourcePostal = addressPart(address, 'zip', 'zipCode', 'postalCode', 'postal');
    if (sourcePostal) {
      productOriginsBySku[skuCode] = {
        source_postal: sourcePostal,
        source_city: addressPart(address, 'city') || undefined,
        source_region: addressPart(address, 'state', 'stateOrProvinceCode', 'region', 'province') || undefined,
      };
    }
  });

  const primaryChannel = String(channelRows[0]?.channel || '').toLowerCase();
  const marketplaceCode = primaryChannel ? `${primaryChannel}_us` : undefined;
  const omsOrderFinancialRows = orderRows.map((order: any) => {
    const quantity = Math.max(0, number(order.quantity));
    const dimensions = json(order.dimensions, {});
    const attributes = json(order.attributes, {});
    const metadata = json(order.metadata, {});
    const shippingAddress = json(order.shipping_address, {});
    const unitCost = number(attributes.cost ?? metadata.cost ?? metadata.unitCost);
    const lineRevenue = Math.max(0, number(order.total_price) || (number(order.unit_price) * quantity));
    const row: Record<string, any> = {
      order_external_id: String(order.order_external_id || '').slice(0, 160),
      order_date_iso: iso(order.order_date),
      sku: String(order.sku || '').slice(0, 160) || undefined,
      asin: String(order.asin || '').trim().toUpperCase().slice(0, 16) || undefined,
      quantity,
      revenue_usd: lineRevenue,
      product_cogs_usd: unitCost > 0 ? Math.round(unitCost * quantity * 100) / 100 : undefined,
      ship_to_postal: addressPart(shippingAddress, 'zip', 'zipCode', 'postalCode', 'postal_code', 'postal').slice(0, 20) || undefined,
      package_weight_lb: number(order.weight) > 0 ? number(order.weight) : undefined,
      package_length_in: number(dimensions.length ?? dimensions.l) > 0 ? number(dimensions.length ?? dimensions.l) : undefined,
      package_width_in: number(dimensions.width ?? dimensions.w) > 0 ? number(dimensions.width ?? dimensions.w) : undefined,
      package_height_in: number(dimensions.height ?? dimensions.h) > 0 ? number(dimensions.height ?? dimensions.h) : undefined,
    };
    return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  });
  const topSkus = [...skus]
    .sort((left: any, right: any) => number(right?.velocity30d) - number(left?.velocity30d))
    .slice(0, 50)
    .map((sku: any) => ({
      id: sku?.id,
      sku: sku?.sku,
      title: sku?.title,
      available: number(sku?.available),
      networkOnHand: sku?.networkOnHand == null ? null : number(sku.networkOnHand),
      inbound: number(sku?.inbound),
      velocity30d: number(sku?.velocity30d),
      daysOfCover: number(sku?.daysOfCover),
      unitCost: sku?.cost == null ? null : number(sku.cost),
      sellingPrice: sku?.price == null ? null : number(sku.price),
      weightLb: sku?.weight == null ? null : number(sku.weight),
      dimensions: sku?.dimensions || {},
      supplierId: sku?.supplierId || null,
      risk: sku?.risk || 'unknown',
      enrichmentPercent: number(sku?.enrichmentPercent),
    }));

  const networkContextPatch: Record<string, any> = {};
  if (candidateWarehouses.length) networkContextPatch.candidate_warehouses = candidateWarehouses;
  if (Object.keys(productOriginsBySku).length) networkContextPatch.product_origins_by_sku = productOriginsBySku;
  if (Object.keys(supplierCostBySku).length) networkContextPatch.supplier_cost_by_sku = supplierCostBySku;
  if (marketplaceCode) networkContextPatch.marketplace_code = marketplaceCode;

  const anchorWarehouseCode = String(networkPolicy?.activePolicy?.anchorWarehouseCode || '').trim();
  const planningBody: Record<string, any> = {
    fulfillment_modes: ['fbm'],
    oms_order_financial_rows: omsOrderFinancialRows,
  };
  if (anchorWarehouseCode) {
    planningBody.primary_warehouse_id = anchorWarehouseCode;
    planningBody.must_include_primary_warehouse = networkPolicy?.multiWarehouseExecutable === false;
  }

  return {
    marketplaceCode,
    networkContextPatch,
    planningBody,
    sellerContext: {
      schemaVersion: 'unieconnect_oms_v1',
      source: 'unieconnect_oms',
      generatedAt: new Date().toISOString(),
      accountScope: { userId, tenantIsolated: true },
      readiness: {
        score: readiness?.score,
        posture: readiness?.posture,
        blockers: readiness?.blockers || [],
        counts: readiness?.counts || {},
      },
      currentBusiness: business?.plan?.currentMetrics || {},
      currentInventory: inventory?.current || {},
      warehouses: candidateWarehouses,
      connectedChannels: channelRows.map((channel) => ({ channel: channel.channel, marketplaceId: channel.marketplace_id || null })),
      suppliers: supplierRows.map((supplier) => ({ id: supplier.id, name: supplier.name })),
      topSkus,
      networkPolicy: networkPolicy?.activePolicy || null,
    },
    evidence: {
      warehouseCount: candidateWarehouses.length,
      channelCount: channelRows.length,
      supplierCount: supplierRows.length,
      skuCount: skus.length,
      skuCostCount: Object.keys(supplierCostBySku).length,
      supplierOriginCount: Object.keys(productOriginsBySku).length,
      orderFinancialRowCount: omsOrderFinancialRows.length,
      orderFinancialFirstAt: omsOrderFinancialRows.length
        ? omsOrderFinancialRows[omsOrderFinancialRows.length - 1]?.order_date_iso || null
        : null,
      orderFinancialLastAt: omsOrderFinancialRows[0]?.order_date_iso || null,
    },
  };
}

export async function createSellerOptimizationRun(userId: string, input: any = {}) {
  const readiness = await getDataReadiness(userId);
  const [business, inventory, networkPolicy] = await Promise.all([
    getBusinessDouble(userId),
    getInventoryPlan(userId, input?.horizon || '6m'),
    getConnectedNetworkPolicy(userId),
  ]);
  const run = await createRun(userId, 'seller_optimization', input, readiness);
  await supersedeOpenRecommendations(userId, SELLER_OPTIMIZATION_RECOMMENDATION_TYPES);

  // Resolve the Cortex engagement bound to this user. Without it the seller
  // optimization endpoint 422s on the missing engagement_id field.
  const credRow = await one(
    `SELECT cortex_engagement_id FROM oms_cortex_credentials WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const engagementId = (credRow as any)?.cortex_engagement_id || null;

  const cortexContext = await buildSellerOptimizationContext(userId, business, inventory, readiness, networkPolicy);

  // Cortex accepts a bounded account snapshot alongside the engagement id. This keeps
  // optimization tenant-scoped and gives planning traceable OMS evidence instead of a
  // generic readiness sentence.
  const cortex = engagementId
    ? await postCortex('/v1/assessment/seller-optimization/runs', {
        engagement_id: engagementId,
        with_ai_recommendations: true,
        input_summary: `UnieConnect OMS run: readiness ${readiness.score}% (${readiness.posture}); ${readiness.counts.catalogItems} SKUs; ${readiness.counts.orders} orders; ${cortexContext.evidence.warehouseCount} connected warehouses.`,
        marketplace_code: cortexContext.marketplaceCode,
        network_context_patch: cortexContext.networkContextPatch,
        planning_body: cortexContext.planningBody,
        seller_context: cortexContext.sellerContext,
      }, { userId }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }))
    : ({ ok: false, status: 412, data: { error: 'Cortex engagement not yet provisioned for this user' } } as const);

  // Persist Cortex's run_id on the local run row so the webhook can match the
  // async result back to this row.
  const cortexRunId = (cortex.ok && (cortex.data as any)?.id) || null;
  if (run?.id && cortexRunId) {
    await pgQuery(
      `UPDATE oms_intelligence_runs SET cortex_run_id = $2, status = 'pending_cortex', updated_at = now() WHERE id = $1`,
      [run.id, cortexRunId],
    ).catch(() => null);
  }

  const currentMonthlyCost = number(business.plan?.currentMetrics?.monthlyCost) || number(inventory.current?.estimatedMonthlyCost);
  const optimizationDecisionReady = business.plan?.decisionReady === true;
  const optimizedMonthlyCost = optimizationDecisionReady
    ? number(business.plan?.optimizedMetrics?.monthlyCost) || number(inventory.proposed?.estimatedMonthlyCost)
    : 0;
  const monthlySavings = optimizationDecisionReady ? Math.max(0, currentMonthlyCost - optimizedMonthlyCost) : 0;
  const summary = {
    title: 'Marketplace-first Seller Optimization',
    sourceMode: readiness.sourceMode,
    readinessScore: readiness.score,
    posture: readiness.posture,
    marketplacePrimary: readiness.counts.marketplaceConnections > 0,
    csvFallbackActive: readiness.counts.csvItems > 0 || readiness.counts.csvOrders > 0,
    currentMonthlyCost,
    optimizedMonthlyCost,
    monthlySavings,
    annualizedSavings: monthlySavings * 12,
    stockoutRiskSkus: inventory.current?.stockoutRiskSkus || 0,
    optimizedStockoutRiskSkus: inventory.proposed?.stockoutRiskSkus || 0,
    sharedPalletCandidates: inventory.proposed?.sharedPalletCandidates || 0,
    blockers: readiness.blockers,
    networkPolicy,
    decisionReady: optimizationDecisionReady,
    impactStatus: optimizationDecisionReady ? 'traceable' : business.plan?.impactStatus || 'needs_model',
    grounding: business.plan?.grounding || null,
    cortexContextEvidence: cortexContext.evidence,
  };

  const stored = await one(
    `INSERT INTO oms_seller_optimization_runs
      (user_id, run_id, status, summary, business_double, inventory_plan, source_summary, confidence)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8)
     RETURNING *`,
    [
      userId,
      run?.id || null,
      readiness.posture === 'needs_data' ? 'needs_data' : 'completed',
      JSON.stringify(summary),
      JSON.stringify(business.plan || {}),
      JSON.stringify(inventory || {}),
      JSON.stringify({ ...readiness, networkPolicy }),
      Math.min(0.96, Math.max(0.35, readiness.score / 100 + (cortex.ok ? 0.08 : 0))),
    ],
  );

  const recommendations = [];
  if (optimizationDecisionReady && monthlySavings > 0) {
    recommendations.push(await createRecommendation(userId, {
      runId: run?.id || null,
      recommendationType: 'business_double',
      entityType: 'business_double',
      entityId: stored?.id,
      title: 'Approve optimized operating model',
      summary: networkPolicy.multiWarehouseExecutable
        ? `Projected monthly savings of $${Math.round(monthlySavings).toLocaleString()} from placement, fulfillment, and consolidation improvements.`
        : `Modeled monthly savings of $${Math.round(monthlySavings).toLocaleString()} require warehouse owner approval for multi-warehouse optimization. Executable plans stay anchored to ${networkPolicy.activePolicy?.anchorWarehouseCode || 'the connected warehouse'}.`,
      currentValue: { monthlyCost: currentMonthlyCost, warehouseCount: business.plan?.currentMetrics?.warehouseNodes },
      optimizedValue: {
        monthlyCost: optimizedMonthlyCost,
        warehouseCount: business.plan?.optimizedMetrics?.warehouseNodes,
        executable: networkPolicy.multiWarehouseExecutable,
        anchorWarehouseCode: networkPolicy.activePolicy?.anchorWarehouseCode || null,
      },
      estimatedImpact: { monthlySavings, annualizedSavings: monthlySavings * 12 },
      requiredAction: networkPolicy.multiWarehouseExecutable ? 'approve_business_double' : 'review_network_policy',
      approvalState: networkPolicy.multiWarehouseExecutable ? 'waiting_approval' : 'blocked_by_network_policy',
      wmsTruthState: readiness.counts.wmsLinks > 0 ? 'wms_confirmed' : 'forecast_only',
      confidence: stored?.confidence,
      sourceSummary: { ...readiness, networkPolicy },
    }));
  }
  const highRiskSkus = (inventory.skus || []).filter((sku: any) => sku.risk === 'high' || number(sku.daysOfCover) < 14).slice(0, 5);
  for (const sku of highRiskSkus) {
    recommendations.push(await createRecommendation(userId, {
      runId: run?.id || null,
      recommendationType: 'sku_placement',
      entityType: 'sku',
      entityId: sku.id || sku.sku,
      title: `${sku.sku}: replenish and place closer to demand`,
      summary: sku.recommendation || 'Increase coverage and review optimized warehouse placement.',
      currentValue: { daysOfCover: sku.daysOfCover, warehouseCount: sku.currentWarehouseCount, available: sku.available },
      optimizedValue: { proposedUnits: sku.proposedUnits, warehouseCount: sku.proposedWarehouseCount, serviceTier: sku.serviceTier },
      estimatedImpact: { palletCubeFt: sku.palletCubeFt, fillPercent: sku.fillPercent },
      requiredAction: readiness.counts.wmsLinks > 0 ? 'draft_inventory_plan' : 'connect_wms_truth',
      approvalState: readiness.counts.wmsLinks > 0 ? 'draft' : 'blocked',
      wmsTruthState: readiness.counts.wmsLinks > 0 ? 'wms_confirmed' : 'forecast_only',
      confidence: stored?.confidence,
      sourceSummary: readiness,
    }));
  }

  // Reorder-needed (external supply loop): actionable per-SKU alert for products the client
  // has auto-replenishment enabled on, projected to stock out within their supplier lead time.
  // Surfaces in the Cortex task inbox via refreshCortexTasks. Suggestion only (no auto-PO).
  const reorderSkus = (inventory.skus || []).filter((sku: any) => sku.reorderNeeded === true).slice(0, 10);
  for (const sku of reorderSkus) {
    recommendations.push(await createRecommendation(userId, {
      runId: run?.id || null,
      recommendationType: 'reorder_needed',
      entityType: 'sku',
      entityId: sku.id || sku.sku,
      title: `${sku.sku}: reorder from supplier`,
      summary: sku.reorderReason || 'Projected to stock out within supplier lead time — place a reorder.',
      currentValue: { networkOnHand: sku.networkOnHand ?? sku.available, daysOfCover: sku.reorderDaysOfCover ?? sku.daysOfCover, velocity30d: sku.velocity30d },
      optimizedValue: { suggestedReorderQty: sku.suggestedReorderQty, supplierLeadTimeDays: sku.supplierLeadTimeDays },
      requiredAction: 'place_reorder',
      approvalState: 'draft',
      wmsTruthState: readiness.counts.wmsLinks > 0 ? 'wms_confirmed' : 'forecast_only',
      confidence: stored?.confidence,
      sourceSummary: readiness,
    }));
  }

  if (readiness.blockers.length) {
    recommendations.push(await createRecommendation(userId, {
      runId: run?.id || null,
      recommendationType: 'data_readiness',
      entityType: 'account',
      entityId: userId,
      title: 'Complete data readiness blockers',
      summary: readiness.blockers[0] || 'Complete required setup before high-confidence optimization.',
      currentValue: { readinessScore: readiness.score },
      optimizedValue: { readinessScore: 90 },
      estimatedImpact: { confidenceGain: Math.max(0, 90 - readiness.score) },
      requiredAction: 'complete_data_readiness',
      approvalState: 'not_required',
      wmsTruthState: 'forecast_only',
      confidence: readiness.score / 100,
      sourceSummary: readiness,
    }));
  }
  recommendations.push(...await createSellerContextRecommendations({
    userId,
    runId: run?.id || null,
    stored,
    readiness,
    inventory,
    summary,
  }));

  await writeOmsLedgerEvent({
    userId,
    entityType: 'seller_optimization',
    entityId: stored?.id || run?.id,
    eventType: 'seller_optimization_completed',
    sourceSystem: 'cortex',
    summary: `Seller Optimization completed using ${readiness.primarySource.replace(/_/g, ' ')} as the primary feed.`,
    payload: { runId: run?.id, sellerOptimizationId: stored?.id, summary, recommendations: recommendations.length },
    confidence: stored?.confidence,
  });
  await completeRun({
    userId,
    runId: run?.id,
    status: readiness.posture === 'needs_data' ? 'needs_data' : 'completed',
    output: { summary, sellerOptimizationId: stored?.id, recommendationCount: recommendations.length },
    confidence: stored?.confidence,
    cortexStatus: cortex.ok ? 'ok' : 'degraded',
    cortexResponse: cortex.data,
  });

  return {
    run: mapRun({ ...run, status: stored?.status, output: { summary }, confidence: stored?.confidence }),
    optimization: mapSellerOptimization(stored),
    recommendations,
    readiness,
    cortex: { ok: cortex.ok, status: cortex.status },
  };
}

export async function getLatestOptimization(userId: string) {
  await reconcileLatestCortexOptimization(userId).catch(() => null);
  const latest = await one(
    `SELECT * FROM oms_seller_optimization_runs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );
  const readiness = await getDataReadiness(userId);
  const recs = await getRecommendations(userId, { limit: 8, status: 'open' });
  return {
    latest: mapSellerOptimization(latest),
    readiness,
    recommendations: recs.recommendations,
  };
}

async function reconcileRecommendationIntegrity(userId: string) {
  await pgQuery(
    `UPDATE oms_recommendations
        SET status = 'superseded',
            approval_state = CASE
              WHEN approval_state IN ('approved', 'rejected') THEN approval_state
              ELSE 'superseded'
            END,
            updated_at = now()
      WHERE user_id = $1
        AND status = 'open'
        AND recommendation_type = 'carrier_audit'
        AND required_action = 'review_carrier_audit_evidence'
        AND COALESCE(optimized_value->>'impactStatus', '') = ''
        AND COALESCE(
          CASE
            WHEN estimated_impact->>'monthlySavings' ~ '^-?[0-9]+(\\.[0-9]+)?$'
              THEN (estimated_impact->>'monthlySavings')::numeric
          END,
          0
        ) > 0`,
    [userId],
  ).catch(() => null);

  await pgQuery(
    `UPDATE oms_recommendations
        SET status = 'superseded', approval_state = 'superseded', updated_at = now()
      WHERE user_id = $1
        AND status = 'open'
        AND recommendation_type = 'product_research'
        AND approval_state = 'not_required'
        AND required_action = 'feed_optimize_suite'`,
    [userId],
  ).catch(() => null);

  const openBusinessDecision = await one(
    `SELECT id
       FROM oms_recommendations
      WHERE user_id = $1
        AND status = 'open'
        AND recommendation_type = 'business_double'
        AND approval_state IN ('waiting_approval', 'draft')
      LIMIT 1`,
    [userId],
  ).catch(() => null);
  if (!openBusinessDecision) return;

  const business = await getBusinessDouble(userId).catch(() => null);
  if (business?.plan?.decisionReady === true) return;
  await pgQuery(
    `UPDATE oms_recommendations
        SET status = 'superseded', approval_state = 'superseded', updated_at = now()
      WHERE user_id = $1
        AND status = 'open'
        AND recommendation_type = 'business_double'
        AND approval_state IN ('waiting_approval', 'draft')`,
    [userId],
  ).catch(() => null);
}

export async function getRecommendations(userId: string, query: any = {}) {
  await reconcileRecommendationIntegrity(userId);
  const values: unknown[] = [userId];
  const filters = ['user_id = $1'];
  if (query.status) {
    values.push(String(query.status));
    filters.push(`status = $${values.length}`);
  }
  if (query.entityType) {
    values.push(String(query.entityType));
    filters.push(`entity_type = $${values.length}`);
  }
  if (query.screen) {
    const screenType = screenEntityType(String(query.screen));
    if (screenType) {
      values.push(screenType);
      filters.push(`(entity_type = $${values.length} OR recommendation_type = $${values.length})`);
    }
  }
  const limit = Math.min(100, Math.max(1, number(query.limit, 50)));
  values.push(limit);
  const data = await rows(
    `SELECT * FROM oms_recommendations
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values,
  );
  const seen = new Set<string>();
  const mapped = await Promise.all(data.map((row) => reconcileRecommendationWithCurrentItem(userId, mapRecommendation(row))));
  const recommendations = mapped
    .filter(Boolean)
    .filter((rec: any) => {
      const missingFields = [
        ...(Array.isArray(rec.currentValue?.missingFields) ? rec.currentValue.missingFields : []),
        ...(Array.isArray(rec.optimizedValue?.requiredFields) ? rec.optimizedValue.requiredFields : []),
      ]
        .map((field) => String(field || '').trim().toLowerCase())
        .filter(Boolean)
        .sort();
      const isSkuBaselineBlocker =
        String(rec.entityType || '').toLowerCase() === 'sku' &&
        String(rec.requiredAction || '').toLowerCase() === 'complete_missing_product_data';
      const key = [
        isSkuBaselineBlocker ? 'sku_baseline_blocker' : rec.recommendationType || '',
        rec.entityType || '',
        rec.entityId || '',
        rec.requiredAction || '',
        rec.approvalState || '',
        rec.status || '',
        missingFields.join(','),
      ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { recommendations };
}

async function reconcileRecommendationWithCurrentItem(userId: string, rec: any) {
  if (!rec || String(rec.entityType || '').toLowerCase() !== 'sku') return rec;
  const recType = String(rec.recommendationType || '').toLowerCase();
  const action = String(rec.requiredAction || '').toLowerCase();
  if (!recType.includes('data_readiness') && !recType.includes('product_research') && !action.includes('missing')) return rec;

  const item = await one('SELECT * FROM catalog_items WHERE user_id = $1 AND (id = $2 OR sku = $2) LIMIT 1', [userId, rec.entityId]);
  if (!item) return rec;

  const metadata = json(item.metadata, {});
  const attributes = json(item.attributes, {});
  const hasDimsWeight = dimensionsCubeFt(item, {}) > 0 && number(item.weight) > 0;
  const hasPrice = number(attributes.price ?? metadata.price ?? metadata.shopifyPrice ?? metadata.sellingPrice) > 0;
  const hasCost = number(attributes.cost ?? metadata.cost ?? metadata.unitCost) > 0;
  const missing: string[] = [];
  if (!hasDimsWeight) missing.push('dimensions weight');
  if (!hasCost) missing.push('cost');
  if (!hasPrice) missing.push('selling price');

  if (!missing.length && (recType.includes('data_readiness') || action.includes('missing'))) {
    await pgQuery(
      `UPDATE oms_recommendations
          SET status = 'completed', approval_state = 'not_required', updated_at = now()
        WHERE user_id = $1 AND id = $2 AND status = 'open'`,
      [userId, rec.id],
    ).catch(() => null);
    return null;
  }

  const dataCompleteness = Math.max(0, 100 - missing.length * 20);
  const marketplaceReadiness = (rec.currentValue || {}).marketplaceReadiness || (rec as any).marketplaceReadiness || 'marketplace enriched';
  const summary = missing.length
    ? `Complete ${missing.join(', ')} before high-confidence optimization.`
    : 'SKU baseline is ready for Cortex optimization.';

  return {
    ...rec,
    entityId: item.id,
    title: missing.length ? `${item.sku}: ${missing.join(', ')} needed for Cortex optimization` : `${item.sku}: Cortex baseline ready`,
    summary,
    currentValue: {
      ...(rec.currentValue || {}),
      dataCompleteness,
      marketplaceReadiness,
      missingFields: missing,
    },
    optimizedValue: missing.length
      ? {
          action: 'Complete the missing baseline fields before Cortex creates an optimization decision.',
          requiredFields: missing,
        }
      : {
          action: 'Use this SKU in Optimize Suite when reviewing inventory placement and replenishment.',
          requiredFields: [],
        },
    estimatedImpact: missing.length
      ? { ...(rec.estimatedImpact || {}), confidenceGain: Math.max(0, 90 - dataCompleteness) }
      : { ...(rec.estimatedImpact || {}), confidence: rec.confidence || 0.8 },
    requiredAction: missing.length ? 'complete_missing_product_data' : 'feed_optimize_suite',
    approvalState: missing.length ? 'blocked' : 'not_required',
  };
}

function closedLoopNumber(...values: any[]): number | null {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function buildRecommendationExecutionTruth(rec: Row) {
  const current = rec.current_value || {};
  const optimized = rec.optimized_value || {};
  const impact = rec.estimated_impact || {};
  const planned = closedLoopNumber(
    optimized.planned_quantity,
    optimized.quantity,
    optimized.recommended_quantity,
    current.planned_quantity,
    current.quantity,
    impact.quantity,
  );
  return {
    planned_quantity: planned,
    approved_quantity: planned,
    service_tier: optimized.service_tier || current.service_tier || impact.service_tier || null,
    expected_savings: closedLoopNumber(impact.expected_savings, impact.savings, impact.savingsUsd, impact.monthlySavings, impact.annualSavings),
    expected_service_impact: impact.serviceImpact || impact.service_impact || optimized.serviceImpact || null,
    confidence_before: closedLoopNumber(rec.confidence),
  };
}

function screenEntityType(screen: string) {
  const key = screen.toLowerCase();
  if (key.includes('sku') || key.includes('inventory')) return 'sku';
  if (key.includes('supplier')) return 'supplier';
  if (key.includes('order')) return 'order';
  if (key.includes('shipment')) return 'shipment_plan';
  if (key.includes('billing')) return 'billing';
  if (key.includes('audit') || key.includes('label')) return 'carrier_audit';
  if (key.includes('double')) return 'business_double';
  return '';
}

/**
 * Side-effect of approving a billing recommendation: persist the proposed per-category reductions
 * as active billing_rate_overrides (stored as PCT). Supersedes any prior active override for the
 * same (user, category, warehouse) first, so approving the plan-level rec and a per-category child
 * in any order is idempotent (the unique partial index guarantees one active row per key). These
 * overrides drive getBillingProfit's advisory "optimized / you save" projection — they do NOT
 * change what the WMS actually bills.
 */
async function applyBillingPlanApproval(userId: string, rec: any, sourceActionId?: string | null) {
  const type = String(rec?.recommendation_type || '');
  if (type !== 'billing_plan' && type !== 'billing_category') return;
  const optimized = json(rec?.optimized_value, {}) as any;
  const overrides: Array<{ category: string; warehouseCode: string | null; pctOverride: number }> =
    Array.isArray(optimized?.overrides) ? optimized.overrides : [];
  for (const o of overrides) {
    const category = String(o?.category || '').trim();
    const pct = Number(o?.pctOverride);
    if (!category || !Number.isFinite(pct) || pct <= 0) continue;
    const warehouseCode = o?.warehouseCode ? String(o.warehouseCode) : null;
    // Supersede the prior active override for this key, then insert the new active one.
    await pgQuery(
      `UPDATE billing_rate_overrides SET status = 'superseded', updated_at = now()
       WHERE user_id = $1 AND category = $2 AND COALESCE(warehouse_code,'') = COALESCE($3,'') AND status = 'active'`,
      [userId, category, warehouseCode],
    ).catch(() => null);
    await pgQuery(
      `INSERT INTO billing_rate_overrides
        (user_id, category, warehouse_code, pct_override, status, source_recommendation_id, source_action_id, metadata)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7::jsonb)`,
      [userId, category, warehouseCode, pct, rec.id, sourceActionId || null, JSON.stringify({ action: optimized?.action || null })],
    ).catch(() => null);
  }
}

export function recommendationDecisionBlockReason(rec: any): string | null {
  const mapped = rec?.recommendationType ? rec : mapRecommendation(rec);
  const state = String(mapped?.approvalState || '').toLowerCase();
  if (state === 'approved') return 'This Cortex decision has already been approved.';
  if (['rejected', 'denied', 'declined'].includes(state)) return 'This Cortex decision has already been denied.';
  if (!['waiting_approval', 'draft'].includes(state)) {
    return 'This item is readiness work, not an approval decision. Complete it from the Cortex task inbox.';
  }
  if (!chatRecommendationIsDecision(mapped)) {
    return 'This item does not contain a concrete, measurable current-versus-suggested change to approve.';
  }
  return null;
}

function recommendationDecisionConflict(rec: any, reason: string) {
  return {
    conflict: true,
    error: reason,
    recommendation: mapRecommendation(rec),
  };
}

export async function approveRecommendation(userId: string, recommendationId: string, body: any = {}) {
  const rec = await one('SELECT * FROM oms_recommendations WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, recommendationId]);
  if (!rec) return null;
  const blocked = recommendationDecisionBlockReason(rec);
  if (blocked) return recommendationDecisionConflict(rec, blocked);
  const updated = await one(
    `UPDATE oms_recommendations
     SET approval_state = 'approved', status = 'approved', approved_at = now(), updated_at = now()
     WHERE user_id = $1 AND id = $2 AND approval_state IN ('waiting_approval', 'draft')
     RETURNING *`,
    [userId, recommendationId],
  );
  if (!updated) {
    const current = await one('SELECT * FROM oms_recommendations WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, recommendationId]);
    return recommendationDecisionConflict(current || rec, recommendationDecisionBlockReason(current || rec) || 'This Cortex decision changed before approval. Refresh and review its current state.');
  }
  // Billing approvals persist rate overrides that drive the advisory savings projection.
  await applyBillingPlanApproval(userId, updated || rec).catch(() => null);
  await pgQuery(
    `INSERT INTO oms_recommendation_actions
      (user_id, recommendation_id, action_type, status, payload, requires_approval)
     VALUES ($1, $2, $3, 'approved', $4::jsonb, true)`,
    [userId, recommendationId, rec.required_action || 'approved_recommendation', JSON.stringify(body || {})],
  ).catch(() => null);
  const cortexDecisionId = `oms-rec-${recommendationId}`;
  const cortex = await postCortex(`/v1/orchestration/oms/recommendations/${recommendationId}/decision`, {
    userId,
    tenant_id: userId,
    decision_id: cortexDecisionId,
    lifecycle_state: 'approved',
    recommendation: mapRecommendation(updated || rec),
    approval: body,
    execution_truth: buildRecommendationExecutionTruth(updated || rec),
    source_quality: rec.source_summary?.primarySource || rec.source_summary?.quality || 'oms',
  }, { userId, idempotencyKey: `oms-rec-approve-${recommendationId}` }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));
  await writeOmsLedgerEvent({
    userId,
    entityType: rec.entity_type || rec.recommendation_type,
    entityId: rec.entity_id || rec.id,
    eventType: 'recommendation_approved',
    sourceSystem: 'oms',
    summary: `Approved recommendation: ${rec.title}`,
    payload: { recommendationId, cortexDecisionId: `oms-rec-${recommendationId}`, cortex, lifecycleState: cortex?.data?.lifecycle_state || 'approved' },
    confidence: rec.confidence,
  });
  return { recommendation: mapRecommendation(updated), cortex };
}

export async function rejectRecommendation(userId: string, recommendationId: string, body: any = {}) {
  const rec = await one('SELECT * FROM oms_recommendations WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, recommendationId]);
  if (!rec) return null;
  const blocked = recommendationDecisionBlockReason(rec);
  if (blocked) return recommendationDecisionConflict(rec, blocked);
  const updated = await one(
    `UPDATE oms_recommendations
     SET approval_state = 'rejected', status = 'rejected', rejected_at = now(), rejection_reason = $3, updated_at = now()
     WHERE user_id = $1 AND id = $2 AND approval_state IN ('waiting_approval', 'draft')
     RETURNING *`,
    [userId, recommendationId, String(body?.reason || 'Rejected by user')],
  );
  if (!updated) {
    const current = await one('SELECT * FROM oms_recommendations WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, recommendationId]);
    return recommendationDecisionConflict(current || rec, recommendationDecisionBlockReason(current || rec) || 'This Cortex decision changed before denial. Refresh and review its current state.');
  }
  await writeOmsLedgerEvent({
    userId,
    entityType: rec.entity_type || rec.recommendation_type,
    entityId: rec.entity_id || rec.id,
    eventType: 'recommendation_rejected',
    sourceSystem: 'oms',
    summary: `Rejected recommendation: ${rec.title}`,
    payload: { recommendationId, reason: body?.reason || null },
    confidence: rec.confidence,
  });
  return { recommendation: mapRecommendation(updated) };
}

export async function getProductResearchRuns(userId: string, limit = 50) {
  const data = await rows(
    `SELECT * FROM oms_intelligence_runs
     WHERE user_id = $1 AND run_type IN ('product_research', 'product_research_bulk')
     ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(100, Math.max(1, limit))],
  );
  return { runs: data.map(mapRun) };
}

export async function getIntelligenceRun(userId: string, runId: string) {
  const run = await one('SELECT * FROM oms_intelligence_runs WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, runId]);
  if (!run) return null;
  const events = await rows('SELECT * FROM oms_intelligence_run_events WHERE user_id = $1 AND run_id = $2 ORDER BY created_at ASC', [userId, runId]);
  const results = await rows('SELECT * FROM oms_product_research_results WHERE user_id = $1 AND run_id = $2 ORDER BY created_at ASC LIMIT 500', [userId, runId]);
  return { run: mapRun(run), events: events.map(mapRunEvent), productResearchResults: results.map(mapProductResult) };
}

export async function getProductResearchResultForSku(userId: string, skuId: string) {
  const item = await one('SELECT * FROM catalog_items WHERE user_id = $1 AND (id = $2 OR sku = $2) LIMIT 1', [userId, skuId]);
  const sku = item?.sku || skuId;
  const result = await one(
    `SELECT * FROM oms_product_research_results
     WHERE user_id = $1 AND (sku = $2 OR item_id = $3)
     ORDER BY created_at DESC LIMIT 1`,
    [userId, sku, item?.id || skuId],
  );
  return result ? reconcileProductResultWithCurrentItem(mapProductResult(result), item) : null;
}

export async function getSellerOptimizationRuns(userId: string, limit = 20) {
  const data = await rows(
    `SELECT sor.*, r.status AS run_status, r.cortex_status
     FROM oms_seller_optimization_runs sor
     LEFT JOIN oms_intelligence_runs r ON r.id = sor.run_id
     WHERE sor.user_id = $1
     ORDER BY sor.created_at DESC LIMIT $2`,
    [userId, Math.min(50, Math.max(1, limit))],
  );
  return { runs: data.map(mapSellerOptimization) };
}

export async function getSellerOptimizationRun(userId: string, id: string) {
  const row = await one('SELECT * FROM oms_seller_optimization_runs WHERE user_id = $1 AND (id = $2 OR run_id::text = $2) LIMIT 1', [userId, id]);
  if (!row) return null;
  const recs = await rows('SELECT * FROM oms_recommendations WHERE user_id = $1 AND run_id = $2 ORDER BY created_at DESC', [userId, row.run_id]);
  return { optimization: mapSellerOptimization(row), recommendations: recs.map(mapRecommendation).filter(Boolean) };
}

export async function getScreenIntelligenceContext(userId: string, screen: string) {
  const [latest, readiness, recommendations] = await Promise.all([
    getLatestOptimization(userId),
    getDataReadiness(userId),
    getRecommendations(userId, { screen, limit: 5, status: 'open' }),
  ]);
  const top = recommendations.recommendations[0];
  const counts = readiness.counts || {};
  const screenLabel = String(screen || 'command').replace(/-/g, ' ');
  const defaultPrompts = [
    'What should I work on next?',
    'Which data is blocking higher confidence?',
    'What current vs optimized decision is ready?',
  ];
  const promptMap: Record<string, string[]> = {
    command: ['Summarize what is happening in my account', 'What should I work on next?', 'What current vs optimized decision is ready?'],
    skus: ['Which SKUs need enrichment first?', 'What product data is blocking Cortex confidence?', 'Which SKUs have listing or warehouse-fit opportunities?'],
    'sku-detail': ['What is missing from this SKU?', 'What can improve this SKU margin or fulfillment?', 'Is this SKU ready for Amazon listing?'],
    orders: ['Which orders need fulfillment attention?', 'What can improve service speed?', 'Are there order issues Cortex can safely route?'],
    shipments: ['What is blocking shipment planning?', 'Which supplier or WMS data is missing?', 'What inbound plan can be optimized?'],
    warehouses: ['Which warehouse needs attention?', 'What inventory or WMS truth is missing?', 'How should warehouse coverage improve?'],
    labels: ['Which labels should be audited first?', 'What refund evidence is missing?', 'Where are carrier costs leaking?'],
    billing: ['Where am I losing margin?', 'Which costs need invoice evidence?', 'What billing decision is ready to approve?'],
    suppliers: ['Which suppliers need pickup profiles?', 'What supplier data blocks execution?', 'Which supplier should I work on next?'],
    customers: ['Which customers need attention?', 'Who are my highest-value customers?', 'Which customer orders have service risk?'],
    returns: ['Which returns need attention?', 'What return reasons are increasing?', 'Which RMAs are blocked?'],
    heatmap: ['Where is demand concentrated?', 'Which states have the most orders?', 'How well do my warehouses cover demand?'],
    'product-research': ['Research a single product', 'What CSV should I upload next?', 'Which product fields are missing most often?'],
    marketplace: ['Which apps should be installed?', 'What is gated until activation?', 'Which connection unlocks the most value?'],
    connections: ['Which connection should I add next?', 'Is Cortex available for this account?', 'Which services are system managed?'],
    double: ['What changed from current to optimized?', 'Which approval has measurable impact?', 'What can be automated after approval?'],
    plan: ['What should the inventory plan prioritize?', 'Which SKUs are at risk?', 'What plan inputs are still missing?'],
    audits: ['Which audit findings need attention?', 'Where are refunds recoverable?', 'What evidence is missing for claims?'],
    ledger: ['What did Cortex change recently?', 'Which actions are waiting for approval?', 'Show the latest execution outcomes'],
    support: ['Which support tickets need attention?', 'What issues are tied to active operations?', 'Which tickets are high priority?'],
    profile: ['Is my account configuration complete?', 'Which account settings block operations?', 'What should an administrator review?'],
  };
  const baseSummary = `On ${screenLabel}, Cortex sees ${readiness.score}% readiness with ${number(counts.catalogItems)} SKUs, ${number(counts.orders)} orders, ${number(counts.wmsLinks)} warehouse links, and ${number(counts.marketplaceConnections)} marketplace connections.`;
  return {
    screen,
    posture: readiness.posture,
    readiness,
    summary: top
      ? `${baseSummary} Current signal: ${top.title}. ${top.summary}`
      : latest.latest
        ? `${baseSummary} Latest Seller Optimization is available with ${readiness.primarySource.replace(/_/g, ' ')} as the primary source.`
        : `${baseSummary} Run Seller Optimization to generate current-vs-optimized intelligence for this screen.`,
    latestOptimization: latest.latest,
    recommendations: recommendations.recommendations,
    recommendedPrompts: promptMap[String(screen || 'command')] || defaultPrompts,
  };
}

function taskTargetFromText(text: string) {
  const value = text.toLowerCase();
  if (value.includes('label') || value.includes('carrier') || value.includes('refund')) return { screen: 'labels', entityType: 'label_audit', actionLabel: 'Open label audit' };
  if (value.includes('billing') || value.includes('invoice') || value.includes('fee') || value.includes('margin')) return { screen: 'billing', entityType: 'billing', actionLabel: 'Open billing' };
  if (value.includes('supplier')) return { screen: 'suppliers', entityType: 'supplier', actionLabel: 'Open suppliers' };
  if (value.includes('wms') || value.includes('warehouse') || value.includes('facility')) return { screen: 'warehouses', entityType: 'warehouse', actionLabel: 'Connect warehouse' };
  if (value.includes('amazon') || value.includes('listing') || value.includes('asin') || value.includes('fba') || value.includes('fbm')) return { screen: 'skus', entityType: 'sku', actionLabel: 'Open listings' };
  if (value.includes('dimension') || value.includes('weight') || value.includes('cost') || value.includes('sku') || value.includes('title') || value.includes('description')) return { screen: 'skus', entityType: 'sku', actionLabel: 'Enrich SKUs' };
  if (value.includes('csv') || value.includes('upload')) return { screen: 'product-research', entityType: 'csv', actionLabel: 'Upload CSV' };
  if (value.includes('marketplace') || value.includes('connect') || value.includes('feed')) return { screen: 'connections', entityType: 'connection', actionLabel: 'Open connections' };
  return { screen: 'command', entityType: 'account', actionLabel: 'Open Command Center' };
}

function recommendationTaskTarget(rec: any) {
  const type = String(rec?.recommendationType || '').toLowerCase();
  const entityType = String(rec?.entityType || '').toLowerCase();
  const title = String(rec?.title || '').toLowerCase();
  const text = `${type} ${entityType} ${rec?.title || ''} ${rec?.summary || ''}`.toLowerCase();
  if (type.includes('data_enrichment') || type.includes('data_readiness')) {
    if (title.includes('feed completeness') || title.includes('data completeness')) {
      return { screen: 'connections', actionLabel: 'Improve data sources' };
    }
    const target = taskTargetFromText(`${text} ${rec?.requiredAction || ''}`);
    return { screen: target.screen, actionLabel: target.actionLabel };
  }
  if (entityType === 'sku' || text.includes('sku') || text.includes('listing')) {
    return rec?.entityId
      ? { screen: 'sku-detail', actionLabel: 'Open SKU details' }
      : { screen: 'skus', actionLabel: 'Review SKUs' };
  }
  if (entityType === 'supplier' || text.includes('supplier')) return { screen: 'suppliers', actionLabel: 'Review supplier action' };
  if (entityType === 'order' || text.includes('fulfillment')) return { screen: 'orders', actionLabel: 'Review order action' };
  if (entityType === 'shipment_plan' || text.includes('shipment') || text.includes('inbound')) return { screen: 'shipments', actionLabel: 'Review shipment plan' };
  if (entityType === 'carrier_audit' || type === 'carrier_audit' || text.includes('label') || text.includes('refund')) return { screen: 'labels', actionLabel: 'Review label audit' };
  if (entityType === 'billing' || type === 'billing_profit' || text.includes('billing') || text.includes('margin')) return { screen: 'billing', actionLabel: 'Review billing impact' };
  if (entityType === 'business_double' || type === 'business_double' || text.includes('business double')) return { screen: 'double', actionLabel: 'Open Business Double' };
  return { screen: 'command', actionLabel: 'Review in Command Center' };
}

function recommendationBelongsInTaskInbox(rec: any) {
  const state = String(rec?.approvalState || '').toLowerCase();

  const text = [
    rec?.recommendationType,
    rec?.title,
    rec?.summary,
    rec?.requiredAction,
  ].filter(Boolean).join(' ').toLowerCase();

  const isReadySignal = /\bready\b/.test(text)
    && !/(not ready|incomplete|missing|blocked|requires? action|needs? (?:data|work|attention|cleanup))/.test(text);
  if (isReadySignal) return false;

  // The task inbox is for prerequisite work. Concrete current-vs-suggested
  // decisions remain in the decision surface where approve/deny has meaning.
  const isPrerequisiteWork = state.includes('blocked') ||
    /(upload|connect|configure|complete|missing|readiness|evidence|feed|enrich|baseline|required data|data source)/.test(text);
  if (isPrerequisiteWork && !['approved', 'rejected'].includes(state)) return true;
  if (['waiting_approval', 'approved', 'rejected'].includes(state)) return false;
  return false;
}

function priorityForTask(text: string, score?: number) {
  const value = text.toLowerCase();
  if (value.includes('connect') || value.includes('missing') || value.includes('blocked') || (score != null && score < 50)) return 'high';
  if (value.includes('cleanup') || value.includes('need')) return 'normal';
  return 'low';
}

function taskDedupeSlug(text: string) {
  return String(text || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'task';
}

function readinessTaskDefinition(blocker: string) {
  const value = String(blocker || '').toLowerCase();
  if (value.includes('missing dimensions') || value.includes('dimensions or weight')) {
    return {
      key: 'sku-dimensions-weight',
      screen: 'skus',
      entityType: 'sku',
      actionLabel: 'Enrich SKUs',
      detail: 'Add package weight plus length, width, and height in SKU item details. Cortex will detect the completed fields automatically.',
    };
  }
  if (value.includes('missing cost')) {
    return {
      key: 'sku-unit-cost',
      screen: 'skus',
      entityType: 'sku',
      actionLabel: 'Add SKU costs',
      detail: 'Add unit cost in SKU item details so margin and fulfillment comparisons use account evidence instead of assumptions.',
    };
  }
  if (value.includes('wms') || value.includes('warehouse')) {
    return {
      key: 'warehouse-wms-truth',
      screen: 'warehouses',
      entityType: 'warehouse',
      actionLabel: 'Connect warehouse',
      detail: 'Connect at least one working warehouse or WMS feed so inventory and physical execution can be verified.',
    };
  }
  if (value.includes('supplier') && value.includes('pickup')) {
    return {
      key: 'supplier-pickup-profiles',
      screen: 'suppliers',
      entityType: 'supplier',
      actionLabel: 'Complete supplier profiles',
      detail: 'Add pickup hours and origin details to incomplete supplier profiles so shipment routing has a valid starting point.',
    };
  }
  if (value.includes('amazon') && value.includes('item sync')) {
    return {
      key: 'amazon-item-sync',
      screen: 'connections',
      entityType: 'marketplace_connection',
      actionLabel: 'Sync Amazon catalog',
      detail: 'Run Amazon item synchronization to identify listed, FBA, FBM, and incomplete marketplace SKUs.',
    };
  }
  if (value.includes('amazon') && (value.includes('listing') || value.includes('fba'))) {
    return {
      key: 'amazon-listing-readiness',
      screen: 'skus',
      entityType: 'sku',
      actionLabel: 'Review Amazon SKUs',
      detail: 'Open the affected SKUs and complete the listing or FBA requirements shown in their Amazon action drawer.',
    };
  }
  if (value.includes('create or import skus')) {
    return {
      key: 'catalog-baseline',
      screen: 'skus',
      entityType: 'sku',
      actionLabel: 'Add SKUs',
      detail: 'Create a product or import the catalog before running product or seller intelligence.',
    };
  }
  if (value.includes('connect a marketplace') || value.includes('sales/product data')) {
    return {
      key: 'commerce-data-source',
      screen: 'connections',
      entityType: 'connection',
      actionLabel: 'Connect marketplace',
      detail: 'Connect a marketplace feed or import product and sales CSV data so Cortex has demand evidence to analyze.',
    };
  }
  const target = taskTargetFromText(blocker);
  return {
    key: taskDedupeSlug(value.replace(/\b\d+(?:\.\d+)?\b/g, 'count')),
    screen: target.screen,
    entityType: target.entityType,
    actionLabel: target.actionLabel,
    detail: 'Open the related work area and complete the missing account evidence. Cortex will verify the result automatically.',
  };
}

async function upsertCortexTask(userId: string, task: any) {
  await ensureCortexWorkspaceTables();
  const row = await one(
    `INSERT INTO oms_cortex_tasks
      (user_id, dedupe_key, source, screen, entity_type, entity_id, title, detail, priority, action_label, action_target, evidence, recommendation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
     ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
       source = EXCLUDED.source,
       screen = EXCLUDED.screen,
       entity_type = EXCLUDED.entity_type,
       entity_id = EXCLUDED.entity_id,
       title = EXCLUDED.title,
       detail = EXCLUDED.detail,
       priority = EXCLUDED.priority,
       action_label = EXCLUDED.action_label,
       action_target = EXCLUDED.action_target,
       evidence = EXCLUDED.evidence,
       recommendation_id = EXCLUDED.recommendation_id,
       status = 'open',
       completed_at = NULL,
       auto_completed_at = NULL,
       updated_at = now()
     WHERE oms_cortex_tasks.status <> 'dismissed'
     RETURNING *`,
    [
      userId,
      task.dedupeKey,
      task.source || 'readiness',
      task.screen || 'command',
      task.entityType || null,
      task.entityId || null,
      task.title,
      task.detail || '',
      task.priority || 'normal',
      task.actionLabel || null,
      task.actionTarget || task.screen || null,
      JSON.stringify(task.evidence || {}),
      task.recommendationId || null,
    ],
  ).catch(() => null);
  return row ? mapCortexTask(row) : null;
}

export async function refreshCortexTasks(userId: string) {
  await ensureCortexWorkspaceTables();
  // Data-enrichment/readiness recommendations are prerequisite work, not
  // approve/deny decisions. Normalize historical rows created before this
  // distinction so every surface presents the same lifecycle.
  await pgQuery(
    `UPDATE oms_recommendations
        SET approval_state = 'not_required', updated_at = now()
      WHERE user_id = $1
        AND status = 'open'
        AND approval_state = 'waiting_approval'
        AND recommendation_type IN ('data_enrichment', 'data_readiness')`,
    [userId],
  ).catch(() => null);
  const [readiness, recs, marketplaceConnections] = await Promise.all([
    getDataReadiness(userId),
    getRecommendations(userId, { status: 'open', limit: 100 }),
    rows(
      `SELECT m.id, m.channel, m.status, m.display_name, m.shop_domain, m.scopes,
              COALESCE((
                SELECT jsonb_object_agg(s.entity_type, jsonb_build_object(
                  'status', s.status, 'count', s.count, 'error', s.error,
                  'metadata', s.metadata, 'lastSyncedAt', s.last_synced_at
                ))
                  FROM channel_sync_status s
                 WHERE s.channel_account_id = m.id
              ), '{}'::jsonb) AS sync
         FROM marketplace_connections m
        WHERE m.user_id = $1 AND COALESCE(m.metadata->>'source', '') <> 'demo'`,
      [userId],
    ).catch(() => []),
  ]);
  const activeKeys = new Set<string>();

  for (const blocker of (readiness.blockers || []).filter(Boolean) as string[]) {
    const definition = readinessTaskDefinition(blocker);
    const dedupeKey = `readiness:${definition.key}`;
    activeKeys.add(dedupeKey);
    await upsertCortexTask(userId, {
      dedupeKey,
      source: 'readiness',
      screen: definition.screen,
      entityType: definition.entityType,
      title: blocker,
      detail: definition.detail,
      priority: priorityForTask(blocker, readiness.score),
      actionLabel: definition.actionLabel,
      actionTarget: definition.screen,
      evidence: { readinessScore: readiness.score, posture: readiness.posture, counts: readiness.counts },
    });
  }

  for (const rec of (recs.recommendations || []).filter(recommendationBelongsInTaskInbox) as any[]) {
    const dedupeKey = `work:${taskDedupeSlug(`${rec.entityType || rec.recommendationType}:${rec.entityId || ''}:${rec.title}`)}`;
    activeKeys.add(dedupeKey);
    const target = recommendationTaskTarget(rec);
    await upsertCortexTask(userId, {
      dedupeKey,
      // Only prerequisite recommendations reach this loop. Present and verify
      // them as readiness work; approve/deny decisions stay in decision views.
      source: 'readiness',
      screen: target.screen,
      entityType: rec.entityType || rec.recommendationType,
      entityId: rec.entityId || rec.id,
      title: rec.title,
      detail: rec.summary,
      priority: Number(rec.confidence || 0) >= 0.8 ? 'normal' : 'low',
      actionLabel: target.actionLabel,
      actionTarget: target.screen,
      recommendationId: rec.id,
      evidence: {
        currentValue: rec.currentValue,
        optimizedValue: rec.optimizedValue,
        estimatedImpact: rec.estimatedImpact,
        confidence: rec.confidence,
        recommendationType: rec.recommendationType,
        approvalState: rec.approvalState,
      },
    });
  }

  for (const connection of marketplaceConnections as any[]) {
    const channel = String(connection.channel || 'marketplace').toLowerCase();
    const displayName = String(connection.display_name || connection.shop_domain || channel);
    const scopes = Array.isArray(connection.scopes) ? connection.scopes.map(String) : [];
    const sync = json(connection.sync, {});
    const syncEntries = Object.entries(sync) as Array<[string, any]>;
    const degradedEntries = syncEntries.filter(([, state]) => Boolean(
      state?.error || state?.metadata?.degraded || state?.status === 'error',
    ));
    const missingShopifyLocations = channel === 'shopify'
      && !scopes.some((scope: string) => scope === 'read_locations' || scope === 'write_locations');
    const disconnected = !['connected', 'active', 'synced'].includes(String(connection.status || '').toLowerCase());
    if (!missingShopifyLocations && !degradedEntries.length && !disconnected) continue;

    const issueKind = missingShopifyLocations ? 'location-inventory-access' : disconnected ? 'authorization' : 'sync-health';
    const dedupeKey = `connection:${channel}:${issueKind}`;
    const connectionState = String(connection.status || 'not connected').replace(/_/g, ' ');
    activeKeys.add(dedupeKey);
    const degradedNames = degradedEntries.map(([entity]) => entity.replace(/_/g, ' '));
    await upsertCortexTask(userId, {
      dedupeKey,
      source: 'connection_health',
      screen: 'connections',
      entityType: 'marketplace_connection',
      entityId: connection.id,
      title: missingShopifyLocations
        ? `Reconnect ${displayName} for warehouse-level inventory`
        : disconnected
          ? `Authorize ${channel.charAt(0).toUpperCase()}${channel.slice(1)} marketplace connection`
          : `Repair ${displayName} ${degradedNames.join(' and ')} sync`,
      detail: missingShopifyLocations
        ? 'Shopify products and orders are connected, but warehouse-level inventory is using fallback quantities because Shopify location inventory access has not been approved.'
        : disconnected
          ? `The ${channel} connection is ${connectionState === 'needs authorization' ? 'waiting for authorization' : connectionState}.`
          : `${degradedNames.join(', ')} data is degraded or reporting an error. Open Connections to review the provider evidence and repair the feed.`,
      priority: 'high',
      actionLabel: missingShopifyLocations ? 'Repair Shopify access' : 'Open Connections',
      actionTarget: 'connections',
      evidence: {
        channel,
        connectionStatus: connection.status,
        missingScopes: missingShopifyLocations ? ['read_locations'] : [],
        degradedEntities: degradedEntries.map(([entity, state]) => ({
          entity,
          status: state?.status,
          error: state?.error || state?.metadata?.warning || null,
        })),
      },
    });
  }

  const autoCompleted = await pgQuery(
    `UPDATE oms_cortex_tasks
     SET status = 'done', completed_at = COALESCE(completed_at, now()), auto_completed_at = COALESCE(auto_completed_at, now()), updated_at = now()
     WHERE user_id = $1 AND status = 'open' AND dedupe_key LIKE ANY($2::text[]) AND NOT (dedupe_key = ANY($3::text[]))
     RETURNING id, entity_type, entity_id, title, source, dedupe_key`,
    [userId, ['readiness:%', 'recommendation:%', 'work:%', 'connection:%'], Array.from(activeKeys)],
  ).catch(() => null);
  for (const task of autoCompleted?.rows || []) {
    await writeOmsLedgerEvent({
      userId,
      entityType: task.entity_type || 'cortex_task',
      entityId: task.entity_id || task.id,
      eventType: 'cortex_task_auto_completed',
      sourceSystem: 'cortex',
      summary: `Cortex verified task completion: ${humanizeInternalLanguage(task.title)}`,
      payload: { taskId: task.id, dedupeKey: task.dedupe_key, taskSource: task.source, completionMode: 'account_evidence' },
    }).catch(() => null);
  }

  const tasks = await rows(
    `SELECT * FROM oms_cortex_tasks WHERE user_id = $1 ORDER BY
       CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       updated_at DESC LIMIT 200`,
    [userId],
  );
  return { tasks: tasks.map(mapCortexTask), readiness };
}

export async function getCortexTasks(userId: string, query: any = {}) {
  await ensureCortexWorkspaceTables();
  if (query.refresh === 'true' || query.refresh === true) await refreshCortexTasks(userId);
  const filters = ['user_id = $1'];
  const values: any[] = [userId];
  const status = String(query.status || 'open');
  if (CORTEX_TASK_STATUS.has(status)) {
    values.push(status);
    filters.push(`status = $${values.length}`);
  }
  if (query.screen) {
    values.push(String(query.screen));
    filters.push(`screen = $${values.length}`);
  }
  const countValues = [...values];
  values.push(Math.min(200, Math.max(1, number(query.limit, 100))));
  const [tasks, countRows] = await Promise.all([
    rows(
      `SELECT * FROM oms_cortex_tasks WHERE ${filters.join(' AND ')}
       ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC
       LIMIT $${values.length}`,
      values,
    ),
    rows(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE priority = 'high')::int AS high_priority,
              COALESCE(array_agg(DISTINCT COALESCE(action_target, screen))
                FILTER (WHERE COALESCE(action_target, screen) IS NOT NULL), ARRAY[]::text[]) AS work_areas,
              COALESCE(array_agg(DISTINCT source)
                FILTER (WHERE source IS NOT NULL), ARRAY[]::text[]) AS sources
         FROM oms_cortex_tasks WHERE ${filters.join(' AND ')}`,
      countValues,
    ),
  ]);
  const summary = countRows[0] || {};
  return {
    tasks: tasks.map(mapCortexTask),
    total: number(summary.total, 0),
    summary: {
      highPriority: number(summary.high_priority, 0),
      workAreas: Array.isArray(summary.work_areas) ? summary.work_areas : [],
      sources: Array.isArray(summary.sources) ? summary.sources : [],
    },
  };
}

export async function completeCortexTask(userId: string, taskId: string) {
  await ensureCortexWorkspaceTables();
  const existing = await one(
    'SELECT * FROM oms_cortex_tasks WHERE user_id = $1 AND id = $2 LIMIT 1',
    [userId, taskId],
  );
  if (!existing) return null;

  if (existing.source === 'readiness' || existing.source === 'connection_health') {
    await refreshCortexTasks(userId);
    const verified = await one(
      'SELECT * FROM oms_cortex_tasks WHERE user_id = $1 AND id = $2 LIMIT 1',
      [userId, taskId],
    );
    const complete = verified?.status === 'done';
    if (!complete) {
      await writeOmsLedgerEvent({
        userId,
        entityType: existing.entity_type || 'cortex_task',
        entityId: existing.entity_id || existing.id,
        eventType: 'cortex_task_verification_pending',
        sourceSystem: 'cortex',
        summary: `Cortex checked the task and still found the blocker: ${humanizeInternalLanguage(existing.title)}`,
        payload: { taskId: existing.id, dedupeKey: existing.dedupe_key, verified: false },
      }).catch(() => null);
    }
    return {
      task: verified ? mapCortexTask(verified) : mapCortexTask(existing),
      verified: complete,
      message: complete
        ? 'Cortex verified the account evidence and completed this task.'
        : `Cortex still detects this blocker: ${existing.title}`,
    };
  }

  const row = await one(
    `UPDATE oms_cortex_tasks
     SET status = 'done', completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, taskId],
  );
  if (row) {
    await writeOmsLedgerEvent({
      userId,
      entityType: row.entity_type || 'cortex_task',
      entityId: row.entity_id || row.id,
      eventType: 'cortex_task_completed',
      sourceSystem: 'oms',
      summary: `Completed Cortex task: ${humanizeInternalLanguage(row.title)}`,
      payload: { taskId: row.id, dedupeKey: row.dedupe_key, completionMode: 'manual' },
    }).catch(() => null);
  }
  return row ? {
    task: mapCortexTask(row),
    verified: true,
    message: 'Task completed.',
  } : null;
}

export async function dismissCortexTask(userId: string, taskId: string) {
  await ensureCortexWorkspaceTables();
  const row = await one(
    `UPDATE oms_cortex_tasks
     SET status = 'dismissed', dismissed_at = COALESCE(dismissed_at, now()), updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, taskId],
  );
  if (row) {
    await writeOmsLedgerEvent({
      userId,
      entityType: row.entity_type || 'cortex_task',
      entityId: row.entity_id || row.id,
      eventType: 'cortex_task_dismissed',
      sourceSystem: 'oms',
      summary: `Dismissed Cortex task: ${humanizeInternalLanguage(row.title)}`,
      payload: { taskId: row.id, dedupeKey: row.dedupe_key },
    }).catch(() => null);
  }
  return row ? mapCortexTask(row) : null;
}

async function getAccountOmsContextBundle(userId: string, screen: string, options: { refreshTasks?: boolean } = {}) {
  const [
    readiness,
    recommendations,
    tasksRes,
    ledger,
    skus,
    orders,
    warehouses,
    suppliers,
    customers,
    returns,
    supportTickets,
    labelRuns,
    labelFindings,
    marketplaces,
    marketplaceApps,
    shipmentPlans,
    asns,
    billing,
  ] = await Promise.all([
    getDataReadiness(userId),
    getRecommendations(userId, { screen, status: 'open', limit: 10 }),
    getCortexTasks(userId, { status: 'open', limit: 20, refresh: options.refreshTasks }),
    rows(`SELECT entity_type, entity_id, event_type, source_system, summary, confidence, created_at FROM oms_execution_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]).catch(() => []),
    rows(
      `SELECT ci.id, ci.sku, ci.title,
              COALESCE(ci.metadata->>'subtitle', ci.metadata->>'subTitle', ci.attributes->>'subtitle', ci.sub_category) AS subtitle,
              COALESCE(ci.metadata->>'brand', ci.attributes->>'brand') AS brand,
              ci.description,
              COALESCE(ci.metadata->>'size', ci.attributes->>'size') AS size,
              ci.weight, ci.dimensions, ci.upc, ci.ean, ci.asin, ci.image, ci.images,
              ci.attributes, ci.metadata, ci.wms_inventory, ci.supplier_id,
              s.name AS supplier_name,
              CASE
                WHEN COALESCE(NULLIF(ci.attributes->>'cost', ''), NULLIF(ci.metadata->>'cost', ''), '') ~ '^-?[0-9]+(?:\.[0-9]+)?$'
                  THEN COALESCE(NULLIF(ci.attributes->>'cost', ''), NULLIF(ci.metadata->>'cost', ''))::numeric
                ELSE NULL
              END AS unit_cost,
              CASE
                WHEN COALESCE(
                  NULLIF(ci.attributes->>'price', ''), NULLIF(ci.metadata->>'price', ''),
                  NULLIF(ci.metadata->>'sellingPrice', ''), NULLIF(ci.metadata->>'shopifyPrice', ''), ''
                ) ~ '^-?[0-9]+(?:\.[0-9]+)?$'
                  THEN COALESCE(
                    NULLIF(ci.attributes->>'price', ''), NULLIF(ci.metadata->>'price', ''),
                    NULLIF(ci.metadata->>'sellingPrice', ''), NULLIF(ci.metadata->>'shopifyPrice', '')
                  )::numeric
                ELSE NULL
              END AS selling_price,
              COALESCE(oa.units_sold, 0)::numeric AS units_sold,
              COALESCE(oa.revenue, 0)::numeric AS sales_revenue,
              COALESCE(oa.order_line_count, 0)::int AS order_line_count
         FROM catalog_items ci
         LEFT JOIN suppliers s ON s.id = ci.supplier_id AND s.user_id = ci.user_id
         LEFT JOIN (
           SELECT user_id, sku,
                  COALESCE(sum(quantity), 0) AS units_sold,
                  COALESCE(sum(COALESCE(total_price, unit_price * quantity, 0)), 0) AS revenue,
                  count(*)::int AS order_line_count
             FROM order_lines
            WHERE user_id = $1
            GROUP BY user_id, sku
         ) oa ON oa.user_id = ci.user_id AND oa.sku = ci.sku
        WHERE ci.user_id = $1 AND COALESCE(ci.archived, false) = false
        ORDER BY ci.updated_at DESC NULLS LAST, ci.created_at DESC
        LIMIT 250`,
      [userId],
    ).catch(() => []),
    rows(
      `SELECT id, order_number, external_order_id, channel, status, paid, totals,
              shipping_address, tracking_number, service_level, ship_by_date,
              metadata, placed_at, created_at, updated_at
         FROM orders
        WHERE user_id = $1
        ORDER BY COALESCE(placed_at, created_at) DESC NULLS LAST
        LIMIT 250`,
      [userId],
    ).catch(() => []),
    getWarehouseOverview(userId).then((result) => result.warehouses).catch(() => []),
    rows(`SELECT id, name, status, email, metadata, updated_at FROM suppliers WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 25`, [userId]).catch(() => []),
    rows(
      `SELECT c.id, c.name, c.company, c.channel, c.updated_at,
              count(o.id)::int AS order_count,
              COALESCE(sum(CASE
                WHEN COALESCE(o.totals->>'total', o.totals->>'grandTotal', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$'
                  THEN COALESCE(o.totals->>'total', o.totals->>'grandTotal')::numeric
                ELSE 0
              END), 0)::numeric AS lifetime_value,
              max(COALESCE(o.placed_at, o.created_at)) AS last_order_at
         FROM customers c
         LEFT JOIN orders o ON o.user_id = c.user_id AND o.customer_id = c.id
        WHERE c.user_id = $1
        GROUP BY c.id
        ORDER BY c.updated_at DESC NULLS LAST
        LIMIT 25`,
      [userId],
    ).catch(() => []),
    rows(`SELECT id, rma_number, status, payload, updated_at FROM returns WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 25`, [userId]).catch(() => []),
    rows(
      `SELECT id, subject, entity_type, entity_id, priority, status, owner, updated_at
         FROM support_tickets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 25`,
      [userId],
    ).catch(() => []),
    rows(`SELECT id, filename, status, row_count, findings_count, estimated_refunds, optimized_service_savings, created_at FROM oms_label_audit_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]).catch(() => []),
    rows(
      `SELECT id, carrier, tracking_number, finding_type, severity, refund_amount, status, evidence, updated_at
         FROM oms_label_audit_findings WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 25`,
      [userId],
    ).catch(() => []),
    rows(
      `SELECT m.id, m.channel, m.status, m.display_name, m.shop_domain, m.marketplace_id,
              m.scopes, m.last_sync_at,
              COALESCE((
                SELECT jsonb_object_agg(s.entity_type, jsonb_build_object(
                  'status', s.status, 'count', s.count, 'error', s.error,
                  'metadata', s.metadata, 'lastSyncedAt', s.last_synced_at
                ))
                FROM channel_sync_status s WHERE s.channel_account_id = m.id
              ), '{}'::jsonb) AS sync
         FROM marketplace_connections m
        WHERE m.user_id = $1 AND COALESCE(m.metadata->>'source', '') <> 'demo'
        ORDER BY m.updated_at DESC LIMIT 25`,
      [userId],
    ).catch(() => []),
    rows(
      `SELECT f.id, f.name, f.description, f.category, f.status, f.price, f.payload,
              uf.status AS user_status, uf.enabled_at,
              (COALESCE((f.payload->>'isCore')::boolean, false)
                OR COALESCE((f.payload->>'isStandard')::boolean, false)
                OR uf.status = 'enabled') AS is_enabled
         FROM features f
         LEFT JOIN user_features uf ON uf.feature_id = f.id AND uf.user_id = $1
        WHERE f.status = 'active'
          AND COALESCE(
            (f.payload->>'isMarketplaceApp')::boolean,
            f.category IN ('marketplace', 'optimization', 'finance', 'audit', 'analytics')
          )
        ORDER BY COALESCE((f.payload->>'marketplaceOrder')::int, 999), f.name
        LIMIT 100`,
      [userId],
    ).catch(() => []),
    rows(
      `SELECT sp.id, sp.shipment_title, sp.status, sp.marketplace_type, sp.estimated_arrival_date,
              jsonb_array_length(sp.items) AS item_count,
              s.name AS supplier_name, f.code AS facility_code, f.name AS facility_name
         FROM shipment_plans sp
         LEFT JOIN suppliers s ON s.id = sp.supplier_id AND s.user_id = sp.user_id
         LEFT JOIN facilities f ON f.id = sp.facility_id
        WHERE sp.user_id = $1 ORDER BY sp.updated_at DESC LIMIT 20`,
      [userId],
    ).catch(() => []),
    rows(
      `SELECT a.id, a.asn_number, a.status, a.shipment_plan_id, a.created_at, a.updated_at
         FROM asns a WHERE a.user_id = $1 ORDER BY a.updated_at DESC LIMIT 20`,
      [userId],
    ).catch(() => []),
    one(
      `SELECT count(*)::int AS line_count,
              count(*) FILTER (WHERE status = 'open')::int AS open_count,
              COALESCE(sum(amount), 0)::numeric AS total_amount,
              COALESCE(sum(amount) FILTER (WHERE status = 'open'), 0)::numeric AS open_amount
         FROM invoice_lines WHERE user_id = $1`,
      [userId],
    ).catch(() => null),
  ]);
  return {
    tenant: { userId, accountScope: 'authenticated_oms_account' },
    screen,
    generatedAt: new Date().toISOString(),
    readiness,
    recommendations: recommendations.recommendations,
    tasks: tasksRes.tasks,
    ledger,
    samples: {
      skus: skus.map((r) => ({
        id: r.id,
        sku: r.sku,
        title: r.title,
        subtitle: r.subtitle,
        brand: r.brand,
        description: r.description,
        size: r.size,
        weight: r.weight == null ? null : number(r.weight),
        dimensions: json(r.dimensions, {}),
        identifiers: { upc: r.upc, ean: r.ean, asin: r.asin },
        imageCount: Array.isArray(r.images) ? r.images.length : r.image ? 1 : 0,
        supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name } : null,
        cost: r.unit_cost == null ? null : money(r.unit_cost),
        price: r.selling_price == null ? null : money(r.selling_price),
        unitsSold: number(r.units_sold),
        salesRevenue: money(r.sales_revenue),
        orderLineCount: number(r.order_line_count),
        source: r.metadata?.source || r.metadata?.importSource || null,
      })),
      orders: orders.map((r) => ({
        id: r.id,
        orderNumber: r.order_number,
        externalOrderId: r.external_order_id,
        channel: r.channel,
        status: r.status,
        paymentStatus: r.paid,
        total: money(r.totals?.total ?? r.totals?.grandTotal ?? r.totals?.price ?? r.totals?.amount),
        currency: r.totals?.currency || r.totals?.currencyCode || 'USD',
        state: r.shipping_address?.state || r.shipping_address?.province || null,
        trackingNumber: r.tracking_number,
        serviceLevel: r.service_level,
        shipByDate: iso(r.ship_by_date),
        placedAt: iso(r.placed_at),
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        metadata: json(r.metadata, {}),
      })),
      warehouses,
      suppliers,
      customers: customers.map((row: any) => ({
        id: row.id,
        name: row.name,
        company: row.company,
        channel: row.channel,
        orderCount: number(row.order_count),
        lifetimeValue: money(row.lifetime_value),
        lastOrderAt: iso(row.last_order_at),
        updatedAt: iso(row.updated_at),
      })),
      returns: returns.map((row: any) => ({
        id: row.id,
        rmaNumber: row.rma_number,
        status: row.status,
        reason: row.payload?.reason || row.payload?.returnReason || null,
        orderId: row.payload?.orderId || row.payload?.order_id || null,
        updatedAt: iso(row.updated_at),
      })),
      supportTickets: supportTickets.map((row: any) => ({
        id: row.id,
        subject: row.subject,
        entityType: row.entity_type,
        entityId: row.entity_id,
        priority: row.priority,
        status: row.status,
        owner: row.owner,
        updatedAt: iso(row.updated_at),
      })),
      labelAuditRuns: labelRuns,
      labelAuditFindings: labelFindings.map((row: any) => ({
        id: row.id,
        carrier: row.carrier,
        trackingNumber: row.tracking_number,
        findingType: row.finding_type,
        severity: row.severity,
        refundAmount: money(row.refund_amount),
        status: row.status,
        orderId: row.evidence?.orderId || row.evidence?.order_id || null,
        runId: row.evidence?.runId || null,
        updatedAt: iso(row.updated_at),
      })),
      marketplaceConnections: marketplaces,
      marketplaceApps: marketplaceApps.map((row: any) => {
        const payload = json(row.payload, {});
        const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
        const isStandard = Boolean(payload.isCore || payload.isStandard);
        const userStatus = row.user_status || (isStandard ? 'enabled' : 'available');
        return {
          id: row.id,
          name: row.name,
          slug: payload.slug || row.id,
          description: row.description,
          category: row.category,
          status: row.status,
          price: money(row.price),
          pricing: payload.pricing || {
            type: money(row.price) > 0 ? 'subscription' : 'free',
            amount: money(row.price),
            currency: 'USD',
          },
          isStandard,
          systemManaged: Boolean(payload.systemManaged || metadata.systemManaged || isStandard),
          isEnabled: Boolean(isStandard || row.is_enabled || userStatus === 'enabled'),
          userStatus,
          enabledAt: iso(row.enabled_at),
          tags: Array.isArray(payload.tags) ? payload.tags : [],
          unlockedScreens: payload.unlockedScreens || metadata.unlockedScreens || [],
          requiredConnections: payload.requiredConnections || metadata.requiredConnections || [],
          setupSteps: payload.setupSteps || metadata.setupSteps || [],
        };
      }),
      shipmentPlans: shipmentPlans.map((row: any) => ({
        ...row,
        item_count: number(row.item_count),
      })),
      asns,
      billing: billing ? {
        lineCount: number(billing.line_count),
        openCount: number(billing.open_count),
        totalAmount: money(billing.total_amount),
        openAmount: money(billing.open_amount),
      } : { lineCount: 0, openCount: 0, totalAmount: 0, openAmount: 0 },
    },
    sourceCatalog: [
      { source: 'oms_data_readiness', screen: 'command', label: 'Account readiness' },
      { source: 'oms_cortex_tasks', screen: 'command', label: 'Cortex tasks' },
      { source: 'oms_recommendations', screen: 'double', label: 'Cortex guidance' },
      { source: 'oms_business_double', screen: 'double', label: 'Business Double plan' },
      { source: 'oms_inventory_plan', screen: 'plan', label: 'Inventory plan' },
      { source: 'oms_skus', screen: 'skus', label: 'SKU catalog' },
      { source: 'oms_orders', screen: 'orders', label: 'Orders' },
      { source: 'oms_customers', screen: 'customers', label: 'Customers' },
      { source: 'oms_returns', screen: 'returns', label: 'Returns' },
      { source: 'oms_warehouses', screen: 'warehouses', label: 'Warehouses' },
      { source: 'oms_suppliers', screen: 'suppliers', label: 'Suppliers' },
      { source: 'oms_marketplace_connections', screen: 'connections', label: 'Marketplace connections' },
      { source: 'oms_marketplace_apps', screen: 'marketplace', label: 'Marketplace apps' },
      { source: 'oms_shipment_plans', screen: 'shipments', label: 'Shipment plans' },
      { source: 'oms_asns', screen: 'shipments', label: 'ASNs' },
      { source: 'oms_label_audits', screen: 'labels', label: 'Label audits' },
      { source: 'oms_billing', screen: 'billing', label: 'Billing' },
      { source: 'oms_execution_ledger', screen: 'ledger', label: 'Execution ledger' },
      { source: 'oms_support_tickets', screen: 'support', label: 'Support tickets' },
      { source: 'oms_demand_heatmap', screen: 'heatmap', label: 'Demand heatmap' },
    ],
  };
}

function chatCount(value: any) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function chatPlural(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function compactTaskLine(task: any, index: number) {
  const title = String(task?.title || 'Review Cortex task').replace(/\.$/, '');
  const action = task?.actionLabel ? `Open: ${task.actionLabel}` : 'Open the related screen';
  return `${index}. ${title}. ${action}.`;
}

function scrubVendorLanguage(text: string) {
  return String(text || '')
    .replace(/\bNVIDIA\s*NIM\b/gi, 'Cortex')
    .replace(/\bNIM\b/g, 'Cortex')
    .replace(/\bNVIDIA\b/gi, 'Cortex')
    .replace(/\blive Cortex\b/gi, 'Cortex')
    .replace(/\bCortex\/Cortex\b/gi, 'Cortex')
    .replace(/\bdrivers?\b/gi, 'runtime');
}

function humanizeInternalLanguage(text: unknown) {
  return scrubVendorLanguage(String(text || ''))
    .replace(/\bnetwork[-_ ]context\s+facility[-_ ]profile\b/gi, 'warehouse profile')
    .replace(/\bfacility[_ ]sqft\b/gi, 'warehouse square footage')
    .replace(/\bheadcount[_ ]reported\b/gi, 'team size')
    .replace(/\bemployee roster\b/gi, 'staff roster')
    .replace(/\bmissing datasets?\b/gi, 'missing account data')
    .replace(/\bmissing backbone feeds?\b/gi, 'missing source data')
    .replace(/\bbackbone feeds?\b/gi, 'source data')
    .replace(/\breconciling key fields\s*\(SKU, order id, timestamps, fee code\)/gi, 'matching SKU, order, timing, and charge details across connected sources')
    .replace(/\breconcile key fields\b/gi, 'match SKU, order, timing, and charge details across connected sources')
    .replace(/\bfee codes?\b/gi, 'charge details')
    .replace(/\bfeed completeness\b/gi, 'data completeness')
    .replace(/\breadiness score(?: of)?\s+(\d{1,3})\b(?!\s*%)/gi, 'readiness score of $1%')
    .replace(/\b(?:low|limited) readiness score of (\d{1,3})%/gi, (value, score) => Number(score) >= 70 ? `readiness score of ${score}%` : value)
    .replace(/\bmay carry assumptions from sparse source fields\b/gi, 'some guidance may be less reliable until the missing data is added')
    .replace(/\bstronger cost\s*\/\s*tax\s*\/\s*operations inference\b/gi, 'more reliable cost, tax, and operations analysis')
    .replace(/\bupload billing\s*\/\s*invoice line CSV\b/gi, 'upload a billing or invoice-line CSV')
    .replace(/\bset warehouse square footage in (?:the )?warehouse profile\b/gi, 'add warehouse square footage to the warehouse profile')
    .replace(/\bprovide team size or staff roster\b/gi, 'add your team size or upload a staff roster')
    .replace(/\breconnect Shopify with (?:read[_ ]locations scope|Shopify location inventory permission)\b/gi, 'Reconnect Shopify and approve location inventory access')
    .replace(/\bread[_ ]locations scope\b/gi, 'Shopify location inventory permission')
    .replace(/\bprioritize:\s*/gi, 'Start with: ')
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi, (value) => value.replace(/_/g, ' '));
}

function humanizeCortexTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(parsed)} UTC`;
}

function polishCortexChatText(text: string) {
  const proseOnly = String(text || '').split(/\n{1,2}(?:Sources|Suggested actions|Readiness notes|Confidence|The readiness notes are|The confidence(?: in [^\n]+)? is):?/i, 1)[0] || '';
  return humanizeInternalLanguage(proseOnly)
    .replace(/(?:Note:\s*)?Cortex did not respond, so this answer was generated from this account'?s scoped OMS data only\.?/gi, 'Answer generated from this account\u2019s scoped OMS data.')
    .replace(/Cortex response unavailable; used scoped OMS fallback\.?/gi, 'Answer generated from this account\u2019s scoped OMS data.')
    .replace(/\bread_locations\s+scope\b/gi, 'Shopify location inventory permission')
    .replace(/\bproduct-variant fallback quantities\b/gi, 'store-level inventory totals')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, humanizeCortexTimestamp)
    .replace(/\b(confidence(?: score| level)?\s*(?:is|:)?\s*)(0(?:\.\d+))\b/gi, (_match, prefix, value) => `${prefix}${Math.round(Number(value) * 100)}%`)
    .replace(/[ \t]+([,.;!?])/g, '$1')
    .replace(/([.!?])(?:\s*\1)+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CORTEX_CHAT_SOURCES: Record<string, { screen: string; label: string }> = {
  oms_data_readiness: { screen: 'command', label: 'Account readiness' },
  oms_cortex_tasks: { screen: 'command', label: 'Cortex tasks' },
  oms_recommendations: { screen: 'double', label: 'Cortex guidance' },
  oms_business_double: { screen: 'double', label: 'Business Double plan' },
  oms_inventory_plan: { screen: 'plan', label: 'Inventory plan' },
  oms_context_samples: { screen: 'command', label: 'OMS account context' },
  oms_skus: { screen: 'skus', label: 'SKU catalog' },
  oms_orders: { screen: 'orders', label: 'Orders' },
  oms_customers: { screen: 'customers', label: 'Customers' },
  oms_returns: { screen: 'returns', label: 'Returns' },
  oms_warehouses: { screen: 'warehouses', label: 'Warehouses' },
  oms_suppliers: { screen: 'suppliers', label: 'Suppliers' },
  oms_marketplace_connections: { screen: 'connections', label: 'Marketplace connections' },
  oms_marketplace_apps: { screen: 'marketplace', label: 'Marketplace apps' },
  oms_shipment_plans: { screen: 'shipments', label: 'Shipment plans' },
  oms_asns: { screen: 'shipments', label: 'ASNs' },
  oms_label_audits: { screen: 'labels', label: 'Label audits' },
  oms_billing: { screen: 'billing', label: 'Billing' },
  oms_execution_ledger: { screen: 'ledger', label: 'Execution ledger' },
  oms_support_tickets: { screen: 'support', label: 'Support tickets' },
  oms_demand_heatmap: { screen: 'heatmap', label: 'Demand heatmap' },
};

const CORTEX_CHAT_SCREENS = new Set([
  'command', 'double', 'plan', 'product-research', 'skus', 'warehouses', 'sku-detail',
  'orders', 'returns', 'customers', 'suppliers', 'shipments', 'heatmap', 'labels',
  'billing', 'audits', 'marketplace', 'support', 'inbox', 'connections', 'ledger', 'profile',
]);

function normalizeChatSource(value: any) {
  const raw = typeof value === 'string' ? { source: value } : value && typeof value === 'object' ? value : {};
  const source = String(raw.source || raw.name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const canonical = CORTEX_CHAT_SOURCES[source];
  if (!canonical) return null;
  return {
    ...raw,
    source,
    label: canonical.label,
    screen: canonical.screen,
  };
}

function normalizeChatAction(value: any) {
  if (!value || typeof value !== 'object') return null;
  const title = humanizeInternalLanguage(value.title || value.actionLabel || value.label || '').trim().slice(0, 180);
  if (!title) return null;
  const requestedTarget = String(value.actionTarget || value.screen || '').trim();
  const inferred = taskTargetFromText(`${title} ${value.detail || value.summary || ''}`);
  const actionTarget = CORTEX_CHAT_SCREENS.has(requestedTarget) ? requestedTarget : inferred.screen;
  return {
    id: value.id ? String(value.id).slice(0, 160) : undefined,
    title,
    priority: ['high', 'normal', 'low'].includes(String(value.priority || '').toLowerCase())
      ? String(value.priority).toLowerCase()
      : 'normal',
    screen: actionTarget,
    actionTarget,
    actionLabel: humanizeInternalLanguage(value.actionLabel || value.label || title).trim().slice(0, 120),
    entityId: value.entityId ? String(value.entityId).slice(0, 160) : undefined,
  };
}

function chatRequestsPriority(message: string) {
  return /\b(most important|highest priority|top priority|prioriti[sz]e|biggest (?:issue|blocker|risk)|first (?:thing|action|step)|next action|where (?:should|do|can) i start|what (?:should|do) i do first|focus on)\b/i.test(message);
}

function chatRequestsAccountSnapshot(message: string) {
  return /\b(summarize|account (?:status|snapshot|overview)|what(?:'s| is) happening in (?:my|the) account)\b/i.test(message);
}

function chatRequestsActions(message: string) {
  return chatRequestsPriority(message)
    || /(what (?:should|can)(?: i)?|what i (?:should|can)|how (?:do|can|should)|next step|what to do|action|recommend|help me|fix|repair|improve|resolve|\bstep\b|set up|get started)/i.test(message);
}

function chatRequestsMarketplaceApps(message: string, screen?: string) {
  if (screen === 'marketplace') return true;
  const q = String(message || '').toLowerCase();
  if (/\b(marketplace apps?|which apps?|installed apps?|available apps?)\b/.test(q)) return true;
  const appSubject = /\b(app|apps|feature|features|suite|marketplace|entitlement|subscription)\b/.test(q);
  const appLifecycle = /\b(install|uninstall|activat(?:e|ed|ion)|gated|unlock|unlocks|unlocked|entitlement|subscription)\b/.test(q);
  return appSubject && appLifecycle;
}

function conversationAwareChatQuery(message: string, history: Array<{ role?: string; content?: string }>) {
  const current = String(message || '').trim();
  if (!current) return current;
  const words = current.split(/\s+/).filter(Boolean);
  const standaloneTopic = /\b(shopify|amazon|ebay|marketplace|connection|sync|inventory|sku|product|listing|order|shipment|asn|warehouse|wms|supplier|billing|invoice|cost|margin|profit|label|audit|return|customer|task|readiness|decision|optimization|plan)\b/i.test(current);
  const contextualFollowup = words.length <= 16 && (
    /^(why|how|what about|what exactly|and what|then what|what next|what (?:should|can|do) (?:i|we)|should (?:i|we)|where|when|which one|can you explain|explain that|tell me more)\b/i.test(current)
    || /\b(this|that|it|those|these|them|they|same issue|about that|about it)\b/i.test(current)
  );
  if (standaloneTopic || !contextualFollowup) return current;

  const prior = [...history].reverse();
  const domainPattern = /\b(shopify|amazon|ebay|marketplace|connection|sync|inventory|sku|product|listing|order|shipment|asn|warehouse|wms|supplier|billing|invoice|cost|margin|profit|label|audit|return|customer|task|readiness|decision|optimization|plan)\b/i;
  const topicAnchor = prior.find((entry) => entry?.role === 'user' && domainPattern.test(String(entry?.content || '')))
    || prior.find((entry) => entry?.role === 'user' && String(entry?.content || '').trim());
  if (!topicAnchor) return current;
  const previousAnswer = prior.find((entry) => entry?.role === 'assistant' && String(entry?.content || '').trim());
  return [
    String(topicAnchor.content).trim(),
    previousAnswer ? `Previous answer: ${String(previousAnswer.content).trim().slice(0, 2400)}` : null,
    `Follow-up: ${current}`,
  ].filter(Boolean).join('\n');
}

function chatRequestsDecision(message: string) {
  return /\b(current\s+(?:vs\.?|versus)\s+(?:suggested|optimized)|decision|approval|approve|accept|deny|decline)\b/i.test(message);
}

function chatRecommendationIsDecision(rec: any) {
  const state = String(rec?.approvalState || '').toLowerCase();
  const type = String(rec?.recommendationType || '').toLowerCase();
  const action = String(rec?.requiredAction || '').toLowerCase();
  const title = String(rec?.title || '').toLowerCase();
  const summary = String(rec?.summary || '').toLowerCase();
  const current = rec?.currentValue || {};
  const suggested = rec?.optimizedValue || {};
  const impact = rec?.estimatedImpact || {};

  if (['blocked', 'not_required', 'not required'].includes(state) || type.includes('data_readiness')) return false;
  const text = `${type} ${action} ${title} ${summary}`;
  if (/(upload|connect|complete|missing|readiness|evidence|feed completeness|data source|baseline incomplete|enrichment baseline)/.test(text)) return false;
  if (!Object.keys(current).length || !Object.keys(suggested).length) return false;
  const meaningfulImpact = Object.entries(impact).some(([key, value]) => {
    const normalized = key.toLowerCase();
    if (/^(confidence|palletunits|priority|severity)$/.test(normalized)) return false;
    if (value == null || value === '') return false;
    if (typeof value === 'number') return value !== 0;
    return true;
  });
  const concreteDomain = /(cost|saving|margin|refund|carrier|label|shipment|supplier|inventory|order|warehouse|routing|placement|price|revenue|billing|fulfillment|business_double)/.test(text);
  return concreteDomain && meaningfulImpact;
}

function chatDecisionImpact(impact: Record<string, any>) {
  const moneyValue = (value: any) => `$${number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (number(impact.monthlySavings)) return `${moneyValue(impact.monthlySavings)} estimated monthly savings`;
  if (number(impact.annualizedSavings)) return `${moneyValue(impact.annualizedSavings)} estimated annual savings`;
  if (number(impact.revenueUpside)) return `${moneyValue(impact.revenueUpside)} estimated revenue upside`;
  if (number(impact.refundAmount)) return `${moneyValue(impact.refundAmount)} estimated refund`;
  if (number(impact.fillPercent)) return `${Math.round(number(impact.fillPercent))}% projected pallet fill`;
  return 'a measurable operational improvement recorded in the decision';
}

function chatEntityLookupTerms(message: string) {
  const quoted = Array.from(String(message || '').matchAll(/["'`]([^"'`]{2,80})["'`]/g))
    .map((match) => match[1]);
  const tokens = String(message || '').match(/[A-Za-z0-9][A-Za-z0-9._:/#-]{3,79}/g) || [];
  return Array.from(new Set([...quoted, ...tokens]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => value.length >= 4 && (/\d/.test(value) || /[-_/#]/.test(value)))))
    .slice(0, 8);
}

async function resolveChatEntities(userId: string, message: string) {
  const terms = chatEntityLookupTerms(message);
  if (!terms.length) return { terms: [], skus: [], orders: [], asns: [], customers: [], returns: [], suppliers: [], warehouses: [], supportTickets: [] };

  const [skus, orders, asns, customers, returns, suppliers, warehouses, supportTickets] = await Promise.all([
    rows(
      `SELECT ci.id, ci.sku, ci.title,
              COALESCE(ci.metadata->>'subtitle', ci.metadata->>'subTitle', ci.attributes->>'subtitle', ci.sub_category) AS subtitle,
              COALESCE(ci.metadata->>'brand', ci.attributes->>'brand') AS brand,
              ci.description,
              COALESCE(ci.metadata->>'size', ci.attributes->>'size') AS size,
              ci.weight, ci.dimensions, ci.upc, ci.ean, ci.asin, ci.image, ci.images,
              ci.attributes, ci.metadata, ci.wms_inventory, ci.supplier_id,
              s.name AS supplier_name
         FROM catalog_items ci
         LEFT JOIN suppliers s ON s.id = ci.supplier_id AND s.user_id = ci.user_id
        WHERE ci.user_id = $1
          AND COALESCE(ci.archived, false) = false
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(ci.id) = term
                OR lower(ci.sku) = term
                OR lower(COALESCE(ci.asin, '')) = term
                OR lower(COALESCE(ci.upc, '')) = term
                OR lower(COALESCE(ci.ean, '')) = term
                OR lower(ci.sku) LIKE '%' || term || '%'
          )
        ORDER BY ci.updated_at DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
    rows(
      `SELECT o.id, o.order_number, o.external_order_id, o.channel, o.status, o.totals,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', ol.id, 'sku', ol.sku, 'title', ol.title,
                  'quantity', ol.quantity, 'unitPrice', ol.unit_price,
                  'totalPrice', ol.total_price
                ) ORDER BY ol.created_at)
                FROM order_lines ol
                WHERE ol.user_id = o.user_id AND ol.order_id = o.id
              ), '[]'::jsonb) AS line_items,
              o.shipping_address, o.tracking_number, o.placed_at, o.updated_at
         FROM orders o
        WHERE o.user_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(o.id) = term
                OR lower(COALESCE(o.order_number, '')) = term
                OR lower(COALESCE(o.external_order_id, '')) = term
                OR lower(COALESCE(o.tracking_number, '')) = term
                OR lower(COALESCE(o.order_number, '')) LIKE '%' || term || '%'
          )
        ORDER BY COALESCE(o.placed_at, o.updated_at) DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
    rows(
      `SELECT id, asn_number, status, shipment_plan_id, payload, created_at, updated_at
         FROM asns
        WHERE user_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(id) = term
                OR lower(COALESCE(asn_number, '')) = term
                OR lower(COALESCE(asn_number, '')) LIKE '%' || term || '%'
          )
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
    rows(
      `SELECT c.id, c.name, c.company, c.channel, c.updated_at,
              count(o.id)::int AS order_count,
              COALESCE(sum(CASE
                WHEN COALESCE(o.totals->>'total', o.totals->>'grandTotal', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$'
                  THEN COALESCE(o.totals->>'total', o.totals->>'grandTotal')::numeric
                ELSE 0
              END), 0)::numeric AS lifetime_value,
              max(COALESCE(o.placed_at, o.created_at)) AS last_order_at
         FROM customers c
         LEFT JOIN orders o ON o.user_id = c.user_id AND o.customer_id = c.id
        WHERE c.user_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(c.id) = term
                OR lower(COALESCE(c.external_customer_id, '')) = term
          )
        GROUP BY c.id
        ORDER BY c.updated_at DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
    rows(
      `SELECT id, rma_number, status, payload, created_at, updated_at
         FROM returns
        WHERE user_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(id) = term
                OR lower(COALESCE(rma_number, '')) = term
                OR lower(COALESCE(rma_number, '')) LIKE '%' || term || '%'
          )
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
    rows(
      `SELECT id, name, status, email, metadata, updated_at
         FROM suppliers
        WHERE user_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(id) = term
                OR lower(COALESCE(metadata->>'supplierCode', '')) = term
          )
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
    rows(
      `SELECT warehouse_code, status, facility_id, metadata, connected_at
         FROM oms_warehouse_links
        WHERE user_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(warehouse_code) = term
                OR lower(COALESCE(facility_id, '')) = term
          )
        ORDER BY connected_at DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
    rows(
      `SELECT id, subject, entity_type, entity_id, priority, status, owner, updated_at
         FROM support_tickets
        WHERE user_id = $1
          AND EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS term
             WHERE lower(id) = term
                OR lower(COALESCE(entity_id, '')) = term
          )
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 10`,
      [userId, terms],
    ).catch(() => []),
  ]);

  return {
    terms,
    skus: skus.map((item: any) => ({
      id: item.id,
      sku: item.sku,
      title: item.title,
      subtitle: item.subtitle,
      brand: item.brand,
      description: item.description,
      size: item.size,
      weight: item.weight,
      dimensions: json(item.dimensions, {}),
      identifiers: { upc: item.upc, ean: item.ean, asin: item.asin },
      imageCount: Array.isArray(item.images) ? item.images.length : item.image ? 1 : 0,
      supplier: item.supplier_id ? { id: item.supplier_id, name: item.supplier_name } : null,
      attributes: json(item.attributes, {}),
      metadata: json(item.metadata, {}),
      wmsInventory: json(item.wms_inventory, {}),
    })),
    orders: orders.map((order: any) => ({
      id: order.id,
      orderNumber: order.order_number,
      externalOrderId: order.external_order_id,
      channel: order.channel,
      status: order.status,
      total: money(order.totals?.total ?? order.totals?.grandTotal ?? order.totals?.price ?? order.totals?.amount),
      currency: order.totals?.currency || order.totals?.currencyCode || 'USD',
      lineItems: json(order.line_items, []),
      shippingAddress: json(order.shipping_address, {}),
      trackingNumber: order.tracking_number,
      placedAt: iso(order.placed_at),
      updatedAt: iso(order.updated_at),
    })),
    asns: asns.map((asn: any) => ({
      id: asn.id,
      asnNumber: asn.asn_number,
      status: asn.status,
      shipmentPlanId: asn.shipment_plan_id,
      payload: json(asn.payload, {}),
      createdAt: iso(asn.created_at),
      updatedAt: iso(asn.updated_at),
    })),
    customers: customers.map((customer: any) => ({
      id: customer.id,
      name: customer.name,
      company: customer.company,
      channel: customer.channel,
      orderCount: number(customer.order_count),
      lifetimeValue: money(customer.lifetime_value),
      lastOrderAt: iso(customer.last_order_at),
      updatedAt: iso(customer.updated_at),
    })),
    returns: returns.map((item: any) => ({
      id: item.id,
      rmaNumber: item.rma_number,
      status: item.status,
      reason: item.payload?.reason || item.payload?.returnReason || null,
      orderId: item.payload?.orderId || item.payload?.order_id || null,
      payload: json(item.payload, {}),
      createdAt: iso(item.created_at),
      updatedAt: iso(item.updated_at),
    })),
    suppliers: suppliers.map((supplier: any) => ({
      id: supplier.id,
      name: supplier.name,
      status: supplier.status,
      email: supplier.email,
      metadata: json(supplier.metadata, {}),
      updatedAt: iso(supplier.updated_at),
    })),
    warehouses: warehouses.map((warehouse: any) => ({
      warehouseCode: warehouse.warehouse_code,
      status: warehouse.status,
      facilityId: warehouse.facility_id,
      metadata: json(warehouse.metadata, {}),
      connectedAt: iso(warehouse.connected_at),
    })),
    supportTickets: supportTickets.map((ticket: any) => ({
      id: ticket.id,
      subject: ticket.subject,
      entityType: ticket.entity_type,
      entityId: ticket.entity_id,
      priority: ticket.priority,
      status: ticket.status,
      owner: ticket.owner,
      updatedAt: iso(ticket.updated_at),
    })),
  };
}

async function buildChatFocusContext(
  userId: string,
  message: string,
  screen: string,
  context: any,
  entityType?: string | null,
  entityId?: string | null,
) {
  const q = String(message || '').toLowerCase();
  const samples = context?.samples || {};
  const resolvedEntities = await resolveChatEntities(userId, [message, entityId].filter(Boolean).join(' '));
  if (screen === 'double' || /\b(business double|six[- ]month (?:operating )?plan|optimized business plan)\b/.test(q)) {
    const businessDouble = await getBusinessDouble(userId).catch(() => null);
    return {
      topic: 'business_double',
      instruction: 'Answer from the current Business Double plan first. Clearly separate observed current metrics, modeled optimized metrics, traceable impact, grounding blockers, and approval state. Never present scenario-only values as executable savings.',
      businessDouble,
      requiredSource: 'oms_business_double',
    };
  }
  if (screen === 'plan' || /\b(inventory plan|replenishment plan|stockout plan)\b/.test(q)) {
    const inventoryPlan: any = await getInventoryPlan(userId, '6m').catch(() => null);
    return {
      topic: 'inventory_plan',
      instruction: 'Answer from the current six-month inventory plan first. Clearly separate observed demand and inventory from proposed replenishment or placement, and state every grounding blocker before suggesting execution.',
      inventoryPlan: inventoryPlan ? {
        horizon: inventoryPlan.horizon,
        modelStatus: inventoryPlan.modelStatus,
        decisionReady: inventoryPlan.decisionReady,
        impactStatus: inventoryPlan.impactStatus,
        generatedAt: inventoryPlan.generatedAt,
        current: inventoryPlan.current,
        proposed: inventoryPlan.proposed,
        months: Array.isArray(inventoryPlan.months) ? inventoryPlan.months.slice(0, 6) : [],
        skus: Array.isArray(inventoryPlan.skus) ? inventoryPlan.skus.slice(0, 25) : [],
        warehouses: Array.isArray(inventoryPlan.warehouses) ? inventoryPlan.warehouses.slice(0, 25) : [],
        grounding: inventoryPlan.grounding,
        source: inventoryPlan.source,
      } : null,
      requiredSource: 'oms_inventory_plan',
    };
  }
  if (chatRequestsDecision(message)) {
    const decisions = (Array.isArray(context?.recommendations) ? context.recommendations : [])
      .filter(chatRecommendationIsDecision);
    return {
      topic: 'current_decisions',
      instruction: 'Answer only from measurable current-versus-suggested decisions. Readiness gaps and connection repairs are tasks, never approvals. Ignore the prior thread topic when it conflicts with this decision question.',
      requiredSource: 'oms_recommendations',
      decisions,
    };
  }
  const requestedMarketplaceChannel = ['shopify', 'amazon', 'ebay'].find((channel) => q.includes(channel));
  const marketplaceAppIntent = chatRequestsMarketplaceApps(message, screen);
  const providerHealthIntent = Boolean(requestedMarketplaceChannel)
    && /\b(work(?:ing)?|down|health|status|sync|connect|permission|inventory|orders?|products?|webhook|repair|reconnect)\b/.test(q);
  const marketplaceConnectionIntent = screen === 'connections'
    || /\b(shopify|amazon|ebay|connection|sync|webhook|authorization|permission|reconnect)\b/.test(q);
  if (marketplaceConnectionIntent && (!marketplaceAppIntent || providerHealthIntent)) {
    const connections = (samples.marketplaceConnections || [])
      .filter((connection: any) => !requestedMarketplaceChannel || String(connection.channel).toLowerCase() === requestedMarketplaceChannel)
      .map((connection: any) => ({
        id: connection.id,
        channel: connection.channel,
        status: connection.status,
        displayName: connection.display_name,
        shopDomain: connection.shop_domain,
        marketplaceId: connection.marketplace_id,
        scopes: connection.scopes,
        lastSyncAt: connection.last_sync_at,
        sync: connection.sync,
      }));
    return {
      topic: requestedMarketplaceChannel ? `${requestedMarketplaceChannel}_connection_health` : 'marketplace_connection_health',
      instruction: 'Answer the marketplace connection and sync-health question directly from these records before discussing unrelated readiness gaps. State connection status, last sync time, entity counts, every degraded or error state present in sync metadata, and the concrete next repair step when action is required.',
      requiredSource: 'oms_marketplace_connections',
      connections,
    };
  }
  if (marketplaceAppIntent) {
    return {
      topic: 'marketplace_apps',
      instruction: 'Answer from this account\'s Marketplace app catalog and entitlement state first. Clearly distinguish installed, available, gated, system-managed, and connection-dependent apps. isEnabled is authoritative: never recommend installing or activating an app when isEnabled is true. A connected provider remains connected even when one data area is degraded. If every app is enabled, say that no app activation is needed and recommend the most relevant repair or workflow instead. Explain required connections and unlocked screens in plain language, and recommend activation only when isEnabled is false and the account has the prerequisite connection or a concrete workflow need.',
      requiredSource: 'oms_marketplace_apps',
      apps: samples.marketplaceApps || [],
      connections: samples.marketplaceConnections || [],
    };
  }
  if (screen === 'labels' || screen === 'audits' || /\b(carrier|label|refund|claim|late delivery|delivery audit)\b/.test(q)) {
    return {
      topic: 'carrier_label_audits',
      instruction: 'Answer from carrier label audit runs and findings first. Separate observed refunds and service failures from suggested actions, and state when claim evidence is missing.',
      runs: samples.labelAuditRuns || [],
      findings: samples.labelAuditFindings || [],
      requiredSource: 'oms_label_audits',
    };
  }
  if (screen === 'suppliers' || /\b(supplier|vendor|pickup profile)\b/.test(q)) {
    return {
      topic: 'suppliers',
      instruction: resolvedEntities.suppliers.length
        ? 'Answer from the exact account-scoped supplier match first. Do not substitute another supplier.'
        : 'Answer from the account supplier records first. Distinguish missing supplier setup from an actual supplier performance issue.',
      suppliers: resolvedEntities.suppliers.length ? resolvedEntities.suppliers : samples.suppliers || [],
      resolvedEntities,
      requiredSource: 'oms_suppliers',
    };
  }
  if (screen === 'returns' || /\b(return|returns|rma|restock)\b/.test(q)) {
    return {
      topic: 'returns',
      instruction: resolvedEntities.returns.length
        ? 'Answer from the exact account-scoped return or RMA match first. Do not substitute another return.'
        : 'Answer from account return and RMA records first. State the status, reason, linked order when available, and the next operational action.',
      returns: resolvedEntities.returns.length ? resolvedEntities.returns : samples.returns || [],
      resolvedEntities,
      requiredSource: 'oms_returns',
    };
  }
  if (screen === 'customers' || /\b(customer|customers|buyer|lifetime value|ltv)\b/.test(q)) {
    return {
      topic: 'customers',
      instruction: resolvedEntities.customers.length
        ? 'Answer from the exact account-scoped customer match first. Do not substitute another customer.'
        : 'Answer from account customer and order-history summaries first. Do not infer customer value or service risk when the supporting orders are absent.',
      customers: resolvedEntities.customers.length ? resolvedEntities.customers : samples.customers || [],
      resolvedEntities,
      requiredSource: 'oms_customers',
    };
  }
  if (screen === 'support' || /\b(support ticket|support tickets|ticket|tickets)\b/.test(q)) {
    return {
      topic: 'support_tickets',
      instruction: resolvedEntities.supportTickets.length
        ? 'Answer from the exact account-scoped support ticket match first. Do not substitute another ticket.'
        : 'Answer from account support tickets first. Prioritize open high-priority tickets and preserve the linked operational entity when available.',
      tickets: resolvedEntities.supportTickets.length ? resolvedEntities.supportTickets : samples.supportTickets || [],
      resolvedEntities,
      requiredSource: 'oms_support_tickets',
    };
  }
  if (screen === 'ledger' || /\b(ledger|execution history|what changed|recent actions?)\b/.test(q)) {
    return {
      topic: 'execution_ledger',
      instruction: 'Answer from the account execution ledger first. Clearly distinguish proposed, approved, executed, failed, and observed events.',
      events: context?.ledger || [],
      requiredSource: 'oms_execution_ledger',
    };
  }
  if (screen === 'heatmap' || /\b(heatmap|demand by state|demand concentration|warehouse coverage)\b/.test(q)) {
    return {
      topic: 'demand_heatmap',
      instruction: 'Answer from order destination states and connected warehouse records first. Do not claim geographic coverage when order or warehouse coordinates are unavailable.',
      orders: samples.orders || [],
      warehouses: samples.warehouses || [],
      requiredSource: 'oms_demand_heatmap',
    };
  }
  if (entityType === 'asn' || screen === 'shipments' || /(shipment|asn|inbound)/.test(q)) {
    return {
      topic: 'shipments_and_asns',
      instruction: 'Answer from shipment plans and ASNs first.',
      shipmentPlans: samples.shipmentPlans || [],
      asns: resolvedEntities.asns.length ? resolvedEntities.asns : samples.asns || [],
      resolvedEntities,
    };
  }
  if (screen === 'billing' || /(billing|invoice|cost|margin|profit)/.test(q)) {
    return {
      topic: 'billing',
      instruction: 'Answer from billing evidence first and state when cost evidence is incomplete.',
      billing: samples.billing || {},
    };
  }
  if (entityType === 'order' || screen === 'orders' || /\border(s)?\b/.test(q)) {
    return {
      topic: 'orders',
      instruction: resolvedEntities.orders.length
        ? 'Answer from the exact account-scoped order matches first. Do not substitute another order.'
        : 'Answer from the account order sample and readiness counts first.',
      orders: resolvedEntities.orders.length ? resolvedEntities.orders : samples.orders || [],
      resolvedEntities,
      requiredSource: 'oms_orders',
    };
  }
  if (entityType === 'sku' || screen === 'skus' || screen === 'sku-detail' || /\b(sku|product|listing|inventory)\b/.test(q)) {
    return {
      topic: 'catalog',
      instruction: resolvedEntities.skus.length
        ? 'Answer from the exact account-scoped SKU or product matches first. Do not substitute another item.'
        : 'Answer from the SKU and inventory evidence first.',
      skus: resolvedEntities.skus.length ? resolvedEntities.skus : samples.skus || [],
      resolvedEntities,
      requiredSource: 'oms_skus',
    };
  }
  if (screen === 'warehouses' || /\b(warehouse|wms|facility)\b/.test(q)) {
    return {
      topic: 'warehouses',
      instruction: resolvedEntities.warehouses.length
        ? 'Answer from the exact account-scoped warehouse match first. Do not substitute another warehouse or a suggested network node.'
        : 'Answer from connected warehouse evidence first. Distinguish actual connected facilities from suggested network nodes.',
      warehouses: resolvedEntities.warehouses.length ? resolvedEntities.warehouses : samples.warehouses || [],
      resolvedEntities,
      requiredSource: 'oms_warehouses',
    };
  }
  return {
    topic: 'account_summary',
    instruction: 'Answer the user question directly; use readiness tasks only when they are relevant to the question.',
    readiness: context?.readiness,
  };
}

function readablePosture(value: any) {
  const posture = String(value || '').replace(/_/g, ' ').toLowerCase();
  if (posture === 'ready') return 'ready';
  if (posture === 'limited') return 'partially ready';
  if (posture === 'needs data') return 'needs more data';
  return posture || 'not fully scored';
}

function chatRequestsSkuOpportunityRanking(message: string) {
  const q = String(message || '').toLowerCase();
  const namesCatalogItem = /\b(sku|skus|product|products|item|items)\b/.test(q);
  const asksForRanking = /\b(strongest|biggest|best|top|first|highest|most|which|identify|rank|prioriti[sz]e)\b/.test(q);
  const asksForImprovement = /\b(opportunity|improve|improvement|optimi[sz](?:e|ation)|work on|fix|enrich)\b/.test(q);
  return namesCatalogItem && asksForRanking && asksForImprovement;
}

function skuDimensionsComplete(sku: any) {
  const dimensions = json(sku?.dimensions, {});
  return number(dimensions?.length ?? dimensions?.l) > 0
    && number(dimensions?.width ?? dimensions?.w) > 0
    && number(dimensions?.height ?? dimensions?.h) > 0;
}

function skuOpportunityMissingFields(sku: any) {
  const identifiers = json(sku?.identifiers, {});
  return [
    !String(sku?.title || '').trim() ? 'title' : null,
    !String(sku?.description || '').trim() ? 'description' : null,
    !String(sku?.brand || '').trim() ? 'brand' : null,
    !String(sku?.size || '').trim() ? 'size' : null,
    number(sku?.weight) <= 0 ? 'weight' : null,
    !skuDimensionsComplete(sku) ? 'dimensions' : null,
    number(sku?.cost) <= 0 ? 'unit cost' : null,
    number(sku?.price) <= 0 ? 'selling price' : null,
    number(sku?.imageCount) <= 0 ? 'images' : null,
    !String(identifiers?.upc || identifiers?.ean || identifiers?.asin || '').trim() ? 'UPC, EAN, or ASIN' : null,
    !sku?.supplier?.id ? 'supplier' : null,
  ].filter(Boolean) as string[];
}

function rankedSkuOpportunityCandidates(context: any, focusContext?: any) {
  const candidates = Array.isArray(focusContext?.skus) && focusContext.skus.length
    ? focusContext.skus
    : Array.isArray(context?.samples?.skus) ? context.samples.skus : [];
  return candidates
    .filter((sku: any) => String(sku?.sku || '').trim())
    .map((sku: any, index: number) => {
      const missing = skuOpportunityMissingFields(sku);
      const dimensionsMissing = missing.includes('dimensions');
      const weightMissing = missing.includes('weight');
      const costMissing = missing.includes('unit cost');
      const priceMissing = missing.includes('selling price');
      const operationalGapScore = (costMissing ? 24 : 0)
        + (priceMissing ? 20 : 0)
        + (dimensionsMissing ? 18 : 0)
        + (weightMissing ? 16 : 0)
        + (missing.includes('description') ? 8 : 0)
        + (missing.includes('images') ? 8 : 0)
        + (missing.includes('supplier') ? 7 : 0)
        + (missing.includes('UPC, EAN, or ASIN') ? 6 : 0)
        + (missing.includes('brand') ? 4 : 0)
        + (missing.includes('size') ? 3 : 0);
      const demandEvidenceScore = Math.min(24, Math.log2(Math.max(1, number(sku?.unitsSold) + 1)) * 6);
      return { sku, missing, score: operationalGapScore + demandEvidenceScore, index };
    })
    .sort((a: any, b: any) => b.score - a.score
      || number(b.sku?.unitsSold) - number(a.sku?.unitsSold)
      || number(b.sku?.salesRevenue) - number(a.sku?.salesRevenue)
      || a.index - b.index);
}

function buildGroundedSkuOpportunityResponse(message: string, context: any, focusContext?: any) {
  const ranked = rankedSkuOpportunityCandidates(context, focusContext);
  const selected = ranked[0];
  if (!selected) {
    return {
      answer: 'I cannot rank a SKU opportunity because this account does not contain a catalog item with usable SKU evidence yet.',
      sources: [{ source: 'oms_skus', count: 0 }],
      tasks: [],
      confidence: 0.95,
      readinessNotes: 'Add or import at least one SKU before asking Cortex to rank product opportunities.',
      selectedSku: null,
    };
  }

  const sku = selected.sku;
  const skuCode = String(sku.sku);
  const missing = selected.missing;
  const unitsSold = number(sku.unitsSold);
  const salesRevenue = money(sku.salesRevenue);
  const cost = money(sku.cost);
  const price = money(sku.price);
  const hasMargin = cost > 0 && price > 0;
  const marginDollars = hasMargin ? Math.round((price - cost) * 100) / 100 : null;
  const marginPercent = hasMargin && price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null;
  const reasons: string[] = [];
  if (unitsSold > 0) {
    reasons.push(`${unitsSold} sold unit${unitsSold === 1 ? '' : 's'}${salesRevenue > 0 ? ` and $${salesRevenue.toFixed(2)} in recorded sales` : ''} give this item real demand evidence`);
  }
  if (missing.includes('unit cost') || missing.includes('selling price')) {
    reasons.push('its margin cannot be measured completely until cost and selling-price evidence are present');
  }
  if (missing.includes('dimensions') || missing.includes('weight')) {
    reasons.push('its fulfillment economics cannot be measured completely until dimensions and weight are complete');
  }
  if (!reasons.length && hasMargin) {
    reasons.push(`its recorded unit margin is $${marginDollars!.toFixed(2)} (${marginPercent!.toFixed(1)}%), giving Cortex a concrete financial baseline to compare`);
  }
  if (!reasons.length) reasons.push('it has the largest traceable enrichment gap in the available catalog evidence');

  const outcomes: string[] = [];
  if (missing.includes('unit cost') || missing.includes('selling price')) {
    outcomes.push('gross margin dollars and margin percentage');
  } else if (hasMargin) {
    outcomes.push(`unit margin from the current $${cost.toFixed(2)} cost and $${price.toFixed(2)} selling price`);
  }
  if (missing.includes('dimensions') || missing.includes('weight')) {
    outcomes.push('dimensional weight, warehouse fit, pallet fill, and freight cost');
  }
  if (unitsSold > 0) outcomes.push('demand, replenishment, and stockout exposure');
  if (!outcomes.length) outcomes.push('listing completeness and marketplace readiness');

  const cannotQuantify = missing.includes('unit cost')
    || missing.includes('selling price')
    || missing.includes('dimensions')
    || missing.includes('weight');
  const lines = [
    `${skuCode} is the strongest evidence-backed SKU to improve first among ${ranked.length} catalog item${ranked.length === 1 ? '' : 's'} evaluated.`,
    `Why it ranks first: ${reasons.join('; ')}.`,
    `What becomes measurable: ${outcomes.join('; ')}.`,
    missing.length ? `Missing inputs: ${missing.join(', ')}.` : 'Missing inputs: none in the core product baseline.',
    cannotQuantify
      ? 'No savings or revenue-upside figure is shown yet because the inputs needed to calculate it are incomplete.'
      : 'Cortex has a usable baseline, but it still needs a compared operating scenario before claiming an improvement.',
    `Next step: open ${skuCode}, complete the missing fields, and rerun the SKU optimization so the result can show a traceable current-versus-suggested impact.`,
  ];
  const actionIntent = chatRequestsActions(message) || /\b(first|improve|work on|fix|enrich)\b/i.test(message);
  return {
    answer: polishCortexChatText(lines.join('\n\n')),
    sources: [
      { source: 'oms_skus', count: ranked.length, selectedSku: skuCode },
      ...(unitsSold > 0 ? [{ source: 'oms_orders', sku: skuCode, unitsSold, salesRevenue }] : []),
    ],
    tasks: actionIntent ? [{
      title: `Improve ${skuCode}`,
      priority: 'normal',
      screen: 'sku-detail',
      actionTarget: 'sku-detail',
      actionLabel: 'Open SKU details',
      entityId: sku.id || skuCode,
    }] : [],
    confidence: 0.96,
    readinessNotes: cannotQuantify ? 'The ranking is supported by account data, but financial impact remains unquantified until the listed inputs are complete.' : null,
    selectedSku: sku,
  };
}

function skuOpportunityAnswerPassesQuality(answer: string, grounded: ReturnType<typeof buildGroundedSkuOpportunityResponse>) {
  const text = String(answer || '');
  const selectedCode = String(grounded.selectedSku?.sku || '').toLowerCase();
  if (!selectedCode || !text.toLowerCase().includes(selectedCode)) return false;
  if (/because (?:it|the (?:sku|product)) has a weight of\b/i.test(text)) return false;
  const explainsReason = /\b(because|why|ranks|priority|evidence)\b/i.test(text);
  const namesOutcome = /\b(margin|profit|revenue|cost|dimensional|freight|pallet|warehouse fit|demand|replenishment|stockout|marketplace readiness)\b/i.test(text);
  const statesEvidenceLimit = /\b(missing|incomplete|cannot|not enough|requires?|need(?:s|ed)?|no savings|unquantified)\b/i.test(text);
  return explainsReason && namesOutcome && statesEvidenceLimit;
}

function buildGroundedSkuOpportunityFollowup(message: string, context: any, focusContext?: any) {
  const ranked = rankedSkuOpportunityCandidates(context, focusContext);
  const selected = ranked[0];
  if (!selected) return buildGroundedSkuOpportunityResponse(message, context, focusContext);
  const sku = selected.sku;
  const skuCode = String(sku.sku);
  const missing = selected.missing;
  const unitsSold = number(sku.unitsSold);
  const lines: string[] = [];
  if (/^\s*why\b/i.test(message)) {
    lines.push(`${skuCode} ranks first because it has the largest combination of traceable operating gaps${unitsSold > 0 ? ` and ${unitsSold} sold unit${unitsSold === 1 ? '' : 's'} of real demand evidence` : ''}.`);
    if (missing.includes('unit cost') || missing.includes('selling price')) {
      lines.push('Cost and selling price are incomplete, so margin dollars and margin percentage cannot be calculated yet.');
    }
    if (missing.includes('dimensions') || missing.includes('weight')) {
      lines.push('Dimensions and weight are incomplete, so dimensional weight, warehouse fit, pallet fill, and freight cost cannot be compared yet.');
    }
    lines.push('That makes this a high-value enrichment target, not a claim that savings have already been proven.');
  } else {
    const firstFields = ['unit cost', 'selling price'].filter((field) => missing.includes(field));
    const fulfillmentFields = ['dimensions', 'weight'].filter((field) => missing.includes(field));
    const listingFields = missing.filter((field: string) => !firstFields.includes(field) && !fulfillmentFields.includes(field));
    if (firstFields.length) {
      lines.push(`Start with ${firstFields.join(' and ')} for ${skuCode}. Those fields unlock gross margin dollars and margin percentage, which are the clearest financial baseline.`);
    } else if (fulfillmentFields.length) {
      lines.push(`Start with ${fulfillmentFields.join(' and ')} for ${skuCode}. Those fields unlock dimensional-weight, warehouse-fit, pallet-fill, and freight-cost comparisons.`);
    } else if (listingFields.length) {
      lines.push(`Start with ${listingFields.slice(0, 2).join(' and ')} for ${skuCode}. Those are the first remaining product-baseline gaps.`);
    } else {
      lines.push(`${skuCode} already has the core enrichment baseline. The next step is to rerun SKU optimization and compare a concrete operating scenario.`);
    }
    const remaining = [...fulfillmentFields, ...listingFields].filter((field: string) => !firstFields.includes(field));
    if (firstFields.length && remaining.length) lines.push(`After that, complete ${remaining.slice(0, 4).join(', ')}.`);
    lines.push('Cortex will not show a savings estimate until the required cost or fulfillment inputs support the calculation.');
  }
  return {
    answer: polishCortexChatText(lines.join('\n\n')),
    sources: [{ source: 'oms_skus', count: ranked.length, selectedSku: skuCode }],
    tasks: [{
      title: `Improve ${skuCode}`,
      priority: 'normal',
      screen: 'sku-detail',
      actionTarget: 'sku-detail',
      actionLabel: 'Open SKU details',
      entityId: sku.id || skuCode,
    }],
    confidence: 0.96,
    readinessNotes: null,
    selectedSku: sku,
  };
}

function chatRequestsOrderPriority(message: string) {
  const q = String(message || '').toLowerCase();
  return /\border(?:s)?\b/.test(q)
    && /\b(attention|priority|prioriti[sz]e|first|risk|urgent|problem|exception|blocked|stuck)\b/.test(q);
}

function chatRequestsWarehouseRisk(message: string) {
  const q = String(message || '').toLowerCase();
  return /\b(warehouse|warehouses|facility|facilities)\b/.test(q)
    && /\b(highest|biggest|most|first|risk|attention|problem|issue|blocked|stuck)\b/.test(q);
}

function ageInDays(value: any) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function rankedOrderAttentionCandidates(context: any, focusContext?: any) {
  const orders = Array.isArray(focusContext?.orders) && focusContext.orders.length
    ? focusContext.orders
    : Array.isArray(context?.samples?.orders) ? context.samples.orders : [];
  return orders.map((order: any, index: number) => {
    const status = String(order?.status || 'unknown').toLowerCase().replace(/[\s-]+/g, '_');
    const paymentStatus = String(order?.paymentStatus || order?.paid || '').toLowerCase();
    const metadata = json(order?.metadata, {});
    const raw = json(metadata?.raw, {});
    const explicitlyHeld = Boolean(metadata?.wmsHold?.held || raw?.held || status === 'hold' || status === 'on_hold');
    const terminal = ['delivered', 'completed', 'complete', 'shipped', 'fulfilled', 'cancelled', 'canceled', 'refunded', 'closed'].includes(status)
      || ['refunded', 'voided'].includes(paymentStatus)
      || Boolean(raw?.cancelled_at || raw?.closed_at);
    const exception = /failed|exception|backorder|blocked/.test(status);
    const open = /pending|open|new|packing|picking|processing|unfulfilled|partial/.test(status);
    const shipBy = order?.shipByDate ? new Date(order.shipByDate).getTime() : Number.NaN;
    const overdue = !terminal && Number.isFinite(shipBy) && shipBy < Date.now();
    const staleDays = ageInDays(order?.updatedAt || order?.placedAt || order?.createdAt);
    const missingTrackingAfterShipment = ['shipped', 'fulfilled'].includes(status) && !order?.trackingNumber;
    const score = (explicitlyHeld ? 140 : 0)
      + (exception ? 120 : 0)
      + (overdue ? 100 : 0)
      + (open && !terminal ? 45 : 0)
      + (missingTrackingAfterShipment ? 70 : 0)
      + (!terminal && staleDays != null ? Math.min(60, staleDays) : 0)
      + (!terminal ? Math.min(12, Math.log10(Math.max(1, number(order?.total))) * 3) : 0);
    return { order, status, paymentStatus, explicitlyHeld, terminal, exception, open, overdue, staleDays, missingTrackingAfterShipment, score, index };
  }).sort((a: any, b: any) => b.score - a.score || a.index - b.index);
}

function buildGroundedOrderPriorityResponse(message: string, context: any, focusContext?: any) {
  const ranked = rankedOrderAttentionCandidates(context, focusContext);
  const selected = ranked.find((candidate: any) => candidate.score > 0 && !candidate.terminal);
  if (!selected) {
    return {
      answer: 'I do not see an open order with enough exception, hold, deadline, or stale-status evidence to rank as needing attention first.',
      sources: [{ source: 'oms_orders', count: ranked.length }],
      tasks: [],
      confidence: 0.92,
      readinessNotes: 'Order value alone is not treated as evidence that an order needs attention.',
    };
  }
  const order = selected.order;
  const label = String(order?.orderNumber || order?.externalOrderId || publicEntityId('OR', order?.id || 'order'));
  const reasons: string[] = [];
  if (selected.explicitlyHeld) reasons.push('the WMS evidence marks it as held');
  if (selected.exception) reasons.push(`its current status is ${selected.status.replace(/_/g, ' ')}`);
  else if (selected.open) reasons.push(`it remains ${selected.status.replace(/_/g, ' ')}`);
  if (selected.overdue) reasons.push(`its ship-by date of ${humanizeCortexTimestamp(order.shipByDate)} has passed`);
  if (selected.staleDays != null && selected.staleDays > 1) reasons.push(`it has not changed for ${selected.staleDays} days`);
  if (selected.missingTrackingAfterShipment) reasons.push('shipment status is present but tracking evidence is missing');
  const missingEvidence = [
    !order?.shipByDate ? 'ship-by date' : null,
    !order?.serviceLevel ? 'service level' : null,
    !order?.trackingNumber ? 'tracking number' : null,
  ].filter(Boolean);
  const lines = [
    `${label} needs attention first because ${reasons.join('; ')}.`,
    `Current evidence: ${String(order?.channel || 'unknown')} channel, ${selected.status.replace(/_/g, ' ')} status${number(order?.total) > 0 ? `, $${money(order.total).toFixed(2)} recorded order value` : ', no reliable order value recorded'}.`,
    'What can improve: release time, backlog age, and fulfillment SLA can be measured once the hold or exception is resolved.',
    missingEvidence.length
      ? `Missing evidence: ${missingEvidence.join(', ')}.`
      : 'The core timing and tracking evidence is present.',
  ];
  return {
    answer: polishCortexChatText(lines.join('\n\n')),
    sources: [{ source: 'oms_orders', count: ranked.length, selectedOrder: label }],
    tasks: chatRequestsActions(message) ? [{
      title: `Review ${label}`,
      priority: 'high',
      screen: 'orders',
      actionTarget: 'orders',
      actionLabel: 'Open order',
      entityId: order.id,
    }] : [],
    confidence: 0.96,
    readinessNotes: null,
  };
}

function rankedWarehouseRiskCandidates(context: any, focusContext?: any) {
  const warehouses = Array.isArray(focusContext?.warehouses) && focusContext.warehouses.length
    ? focusContext.warehouses
    : Array.isArray(context?.samples?.warehouses) ? context.samples.warehouses : [];
  return warehouses.map((warehouse: any, index: number) => {
    const status = String(warehouse?.status || 'unknown').toLowerCase().replace(/[\s-]+/g, '_');
    const inventoryUnits = number(warehouse?.inventoryUnits);
    const activeSkus = number(warehouse?.activeSkus);
    const orders = number(warehouse?.orders);
    const asns = number(warehouse?.asns);
    const lastEvent = warehouse?.lastWmsEventAt || warehouse?.lastWmsEvent;
    const disconnected = !['connected', 'active', 'healthy'].includes(status);
    const inboundWithoutInventoryTruth = asns > 0 && inventoryUnits <= 0 && activeSkus <= 0;
    const score = (disconnected ? 120 : 0)
      + (!lastEvent ? 45 : Math.min(30, ageInDays(lastEvent) || 0))
      + (inboundWithoutInventoryTruth ? 80 : 0)
      + (inventoryUnits <= 0 ? 15 : 0)
      + (activeSkus <= 0 ? 10 : 0)
      + (orders <= 0 && asns > 0 ? 8 : 0);
    return { warehouse, status, inventoryUnits, activeSkus, orders, asns, lastEvent, disconnected, inboundWithoutInventoryTruth, score, index };
  }).sort((a: any, b: any) => b.score - a.score || a.index - b.index);
}

function buildGroundedWarehouseRiskResponse(message: string, context: any, focusContext?: any) {
  const ranked = rankedWarehouseRiskCandidates(context, focusContext);
  const selected = ranked[0];
  if (!selected) {
    return {
      answer: 'I cannot rank warehouse risk because this account has no connected warehouse evidence.',
      sources: [{ source: 'oms_warehouses', count: 0 }],
      tasks: [],
      confidence: 0.95,
      readinessNotes: 'Connect a warehouse before asking Cortex to compare warehouse operations.',
    };
  }
  const warehouse = selected.warehouse;
  const code = String(warehouse?.warehouseCode || warehouse?.warehouse_code || warehouse?.code || 'Warehouse');
  const name = String(warehouse?.name || warehouse?.facilityName || '').trim();
  const reasons: string[] = [];
  if (selected.disconnected) reasons.push(`its connection state is ${selected.status.replace(/_/g, ' ')}`);
  if (!selected.lastEvent) reasons.push('no WMS event timestamp is available');
  if (selected.inboundWithoutInventoryTruth) reasons.push(`${selected.asns} ASN${selected.asns === 1 ? '' : 's'} are associated with it while inventory and active SKU counts are both zero`);
  else {
    if (selected.inventoryUnits <= 0) reasons.push('no inventory units are reported');
    if (selected.activeSkus <= 0) reasons.push('no active SKUs are reported');
  }
  if (!reasons.length) reasons.push('it has the weakest recency and activity evidence among the connected warehouses');
  const lines = [
    `${code}${name ? ` (${name})` : ''} has the highest evidence-backed monitoring risk among ${ranked.length} connected warehouse${ranked.length === 1 ? '' : 's'}.`,
    `Why: ${reasons.join('; ')}.`,
    `Current evidence: ${selected.inventoryUnits} inventory units, ${selected.activeSkus} active SKUs, ${selected.orders} related orders, and ${selected.asns} ASN${selected.asns === 1 ? '' : 's'}.`,
    'This is a reconciliation warning, not proof that the warehouse is offline. Confirm the latest WMS event and inbound receipt state before changing routing or inventory placement.',
  ];
  return {
    answer: polishCortexChatText(lines.join('\n\n')),
    sources: [{ source: 'oms_warehouses', count: ranked.length, selectedWarehouse: code }],
    tasks: chatRequestsActions(message) ? [{
      title: `Review ${code}`,
      priority: selected.disconnected ? 'high' : 'normal',
      screen: 'warehouses',
      actionTarget: 'warehouses',
      actionLabel: 'Open warehouse',
      entityId: code,
    }] : [],
    confidence: 0.96,
    readinessNotes: null,
  };
}

function buildLocalCortexChatFallback(message: string, context: any, focusContext?: any, intentMessage = message): {
  answer: string;
  sources: any[];
  tasks: any[];
  confidence: number;
  readinessNotes: string | null;
} {
  const q = String(message || '').toLowerCase();
  if (chatRequestsSkuOpportunityRanking(message)) {
    return buildGroundedSkuOpportunityResponse(message, context, focusContext);
  }
  if (chatRequestsOrderPriority(message)) {
    return buildGroundedOrderPriorityResponse(intentMessage, context, focusContext);
  }
  if (chatRequestsWarehouseRisk(message)) {
    return buildGroundedWarehouseRiskResponse(intentMessage, context, focusContext);
  }
  const readiness = context?.readiness || {};
  const counts = readiness.counts || {};
  const tasks = Array.isArray(context?.tasks) ? context.tasks : [];
  const recommendations = Array.isArray(context?.recommendations) ? context.recommendations : [];
  const samples = context?.samples || {};
  const skuCount = chatCount(counts.catalogItems);
  const orderCount = chatCount(counts.orders);
  const warehouseCount = chatCount(counts.wmsLinks);
  const supplierCount = chatCount(counts.suppliers);
  const labelRunCount = Array.isArray(samples.labelAuditRuns) ? samples.labelAuditRuns.length : 0;
  const sortedTasks = [...tasks].sort((a: any, b: any) => {
    const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
    return (rank[String(a?.priority || '').toLowerCase()] ?? 3) - (rank[String(b?.priority || '').toLowerCase()] ?? 3);
  });
  const highTasks = sortedTasks.filter((task: any) => String(task?.priority || '').toLowerCase() === 'high');
  const missingSkuTask = tasks.find((task: any) => String(task?.title || '').toLowerCase().includes('missing dimensions') || String(task?.title || '').toLowerCase().includes('missing cost'));
  const wmsTask = tasks.find((task: any) => String(task?.title || '').toLowerCase().includes('wms'));
  const decisionRecommendations = recommendations.filter(chatRecommendationIsDecision);
  const topRecommendation = recommendations[0];
  const lines: string[] = [];
  const readinessLine = `Readiness: ${readiness.score || 0}% (${readablePosture(readiness.posture)}).`;
  const dataLine = `Connected data: ${chatPlural(skuCount, 'SKU')}, ${chatPlural(orderCount, 'order')}, ${chatPlural(chatCount(counts.marketplaceConnections), 'marketplace connection')}, ${chatPlural(warehouseCount, 'warehouse link')}, ${chatPlural(supplierCount, 'supplier')}, and ${chatPlural(labelRunCount, 'label audit run')}.`;
  const gaps = [
    chatCount(counts.missingDimensions) ? `${chatPlural(chatCount(counts.missingDimensions), 'SKU')} missing dimensions or weight` : null,
    chatCount(counts.missingCost) ? `${chatPlural(chatCount(counts.missingCost), 'SKU')} missing cost data` : null,
    !warehouseCount ? 'no connected warehouse or WMS truth' : null,
    chatCount(counts.amazonBlockedItems) ? `${chatPlural(chatCount(counts.amazonBlockedItems), 'Amazon SKU')} blocked for listing/FBA readiness` : null,
  ].filter(Boolean);
  const gapLine = gaps.length ? `What is holding it back: ${gaps.join('; ')}.` : 'Nothing major is blocking the core intelligence path right now.';
  const nextSteps = sortedTasks.slice(0, 3).map((task: any, idx: number) => compactTaskLine(task, idx + 1));
  const intentQuery = String(intentMessage || '').toLowerCase();
  const priorityIntent = chatRequestsPriority(intentMessage);
  const actionIntent = chatRequestsActions(intentMessage) || intentQuery.includes('get the account going') || intentQuery.includes('start') || intentQuery.includes('blocking') || intentQuery.includes('confidence') || intentQuery.includes('missing');
  const requestedMarketplaceChannel = ['shopify', 'amazon', 'ebay'].find((channel) => q.includes(channel));
  const marketplaceAppIntent = chatRequestsMarketplaceApps(message, context?.screen);
  const providerHealthIntent = Boolean(requestedMarketplaceChannel)
    && /\b(work(?:ing)?|down|health|status|sync|connect|permission|inventory|orders?|products?|webhook|repair|reconnect)\b/.test(q);
  const marketplaceConnectionIntent = (context?.screen === 'connections'
    || /\b(shopify|amazon|ebay|connection|sync|webhook|authorization|permission|reconnect)\b/.test(q))
    && (!marketplaceAppIntent || providerHealthIntent);
  const marketplaceTasks = marketplaceConnectionIntent
    ? sortedTasks.filter((task: any) => {
        const text = `${task?.stableKey || ''} ${task?.title || ''} ${task?.detail || ''}`.toLowerCase();
        return String(task?.source || '') === 'connection_health'
          && (!requestedMarketplaceChannel || text.includes(requestedMarketplaceChannel));
      })
    : [];
  const responseTasks = marketplaceConnectionIntent ? marketplaceTasks : sortedTasks;
  const includeMarketplaceRepair = marketplaceConnectionIntent && marketplaceTasks.length > 0;

  if (chatRequestsDecision(intentMessage)) {
    const decision = decisionRecommendations[0];
    if (!decision) {
      lines.push('There is no measurable current-versus-suggested decision ready for approval right now.');
      lines.push('The open items are readiness tasks, not approvals. Complete the task-inbox work and run optimization again before accepting or denying a change.');
    } else {
      lines.push(`${decision.title} is ready for review.`);
      if (decision.summary) lines.push(String(decision.summary));
      lines.push(`Expected impact: ${chatDecisionImpact(decision.estimatedImpact || {})}.`);
      lines.push('Open Current vs Suggested Decisions to compare the recorded current state, proposed change, and impact before accepting or denying it.');
    }
  } else if (marketplaceAppIntent && !marketplaceConnectionIntent) {
    const apps = Array.isArray(samples.marketplaceApps) ? samples.marketplaceApps : [];
    const installed = apps.filter((app: any) => Boolean(app?.isEnabled));
    const available = apps.filter((app: any) => !app?.isEnabled);
    lines.push(`Marketplace status: ${chatPlural(installed.length, 'app')} installed and ${chatPlural(available.length, 'app')} available.`);
    if (installed.length) {
      lines.push(`Installed: ${installed.slice(0, 12).map((app: any) => `${app.name}${app.systemManaged ? ' (managed)' : ''}`).join(', ')}.`);
    }
    if (available.length) {
      lines.push(`Available: ${available.slice(0, 12).map((app: any) => {
        const required = Array.isArray(app.requiredConnections) ? app.requiredConnections.map((item: any) => String(item)) : [];
        return `${app.name}${required.length ? ` (needs ${required.join('; ')})` : ''}`;
      }).join(', ')}.`);
    }
    const gated = available.filter((app: any) => Array.isArray(app.unlockedScreens) && app.unlockedScreens.length > 0);
    if (gated.length) {
      lines.push(`Gated until activation: ${gated.slice(0, 12).map((app: any) => `${app.name} unlocks ${app.unlockedScreens.join(', ')}`).join('; ')}.`);
    }
    lines.push('Only apps marked installed are active for this account. Managed apps remain available as built-in services and cannot be disabled by a normal user.');
  } else if (marketplaceConnectionIntent) {
    const requestedChannel = requestedMarketplaceChannel;
    const connections = (Array.isArray(samples.marketplaceConnections) ? samples.marketplaceConnections : [])
      .filter((connection: any) => !requestedChannel || String(connection?.channel || '').toLowerCase() === requestedChannel);
    if (!connections.length) {
      lines.push(requestedChannel
        ? `There is no ${requestedChannel.charAt(0).toUpperCase()}${requestedChannel.slice(1)} connection on this account.`
        : 'There are no marketplace connections on this account.');
      lines.push('Open Connections to authorize the marketplace before expecting products, orders, or inventory to synchronize.');
    } else {
      for (const connection of connections.slice(0, 4)) {
        const channel = String(connection.channel || 'marketplace');
        const label = channel === 'shopify' && connection.shop_domain
          ? `Shopify store ${connection.shop_domain}`
          : String(connection.display_name || channel.charAt(0).toUpperCase() + channel.slice(1));
        const syncEntries = Object.entries(connection.sync || {}) as Array<[string, any]>;
        const degraded = syncEntries.some(([, state]) => Boolean(state?.error || state?.metadata?.degraded));
        const state = String(connection.status || 'unknown').replace(/_/g, ' ');
        lines.push(`${label} is ${degraded && state === 'connected' ? 'connected, with a degraded data area' : state}.`);
        if (connection.last_sync_at) lines.push(`Last synchronization: ${new Date(connection.last_sync_at).toISOString()}.`);
        if (syncEntries.length) {
          lines.push(`Synchronized data: ${syncEntries.map(([entity, item]) => {
            const count = chatCount(item?.count);
            return `${entity.replace(/_/g, ' ')} ${count} (${String(item?.status || 'unknown').replace(/_/g, ' ')})`;
          }).join('; ')}.`);
        }
        const issues = syncEntries
          .map(([entity, item]) => item?.error || item?.metadata?.warning
            ? `${entity.replace(/_/g, ' ')}: ${item.error || item.metadata.warning}`
            : null)
          .filter(Boolean);
        if (issues.length) lines.push(`Attention required: ${issues.join('; ').replace(/[.\s]+$/, '')}.`);
        const scopes = Array.isArray(connection.scopes) ? connection.scopes.map((scope: any) => String(scope)) : [];
        if (channel === 'shopify' && !scopes.some((scope: string) => scope === 'read_locations' || scope === 'write_locations')) {
          lines.push('Next step: open Connections, select Repair Shopify access, and approve location inventory access. This enables inventory by warehouse instead of store-level totals.');
        }
      }
    }
  } else if (priorityIntent) {
    const first = sortedTasks[0];
    lines.push(`Account snapshot: ${dataLine} ${readinessLine}`);
    if (first) {
      const title = humanizeInternalLanguage(String(first.title || 'Review the Cortex task inbox')).replace(/[.!]+$/, '');
      const detail = humanizeInternalLanguage(String(first.detail || '')).replace(/[.!]+$/, '');
      const action = humanizeInternalLanguage(String(first.actionLabel || 'Open the related screen')).replace(/[.!]+$/, '');
      lines.push(`First priority: ${title}.`);
      if (detail && detail.toLowerCase() !== title.toLowerCase()) lines.push(`Why: ${detail}.`);
      lines.push(`Action: ${action}.`);
    } else {
      lines.push('First priority: connect an operating data source or enrich the missing SKU fields so Cortex has enough evidence to rank an operational change.');
    }
    lines.push(gapLine);
  } else if (q.includes('what can i do') || q.includes('get the account going') || q.includes('start') || q.includes('next')) {
    lines.push('The fastest path is to improve the data that controls execution quality, then run optimization again.');
    if (nextSteps.length) lines.push(`Do these next:\n${nextSteps.join('\n')}`);
    else lines.push('Do this next:\n1. Connect a marketplace or upload product/order CSV data.\n2. Enrich SKU weight, dimensions, cost, and selling price.\n3. Connect warehouse/WMS truth before physical execution.');
    lines.push(`${readinessLine} ${gapLine}`);
    if (chatCount(counts.marketplaceConnections) > 0) lines.push('The marketplace feed is present, so the next lift is SKU enrichment, warehouse truth, and cost evidence.');
    if (topRecommendation) lines.push(`Most relevant Cortex signal: ${topRecommendation.title}.`);
  } else if (q.includes('blocking') || q.includes('confidence') || q.includes('missing')) {
    lines.push(gapLine);
    lines.push(`${readinessLine} The biggest blockers are ${highTasks.length || sortedTasks.length} open ${highTasks.length ? 'high-priority' : 'readiness'} item${(highTasks.length || sortedTasks.length) === 1 ? '' : 's'}.`);
    if (nextSteps.length) lines.push(`Work queue:\n${nextSteps.join('\n')}`);
    lines.push('Why it matters: Cortex should only approve or automate concrete changes when the recommendation is traceable to real inventory, cost, demand, warehouse, and service data.');
  } else if (q.includes('opportunity') || q.includes('optimized') || q.includes('optimization')) {
    if (topRecommendation) {
      lines.push(`The clearest current Cortex opportunity is ${topRecommendation.title}.`);
      if (topRecommendation.summary) lines.push(topRecommendation.summary);
      lines.push(`${readinessLine} Accept/Deny belongs only on measurable inventory, cost, revenue, service, or fulfillment changes. Readiness gaps should remain tasks, not approval decisions.`);
    } else {
      lines.push(`I do not see a concrete current-vs-optimized decision yet. ${readinessLine} Finish the readiness blockers first so Cortex can produce traceable financial or inventory impact.`);
    }
  } else if (q.includes('summarize') || q.includes('happening') || q.includes('account') || q.includes('status')) {
    lines.push(`Here is the account snapshot.\n\n${dataLine}\n${readinessLine} ${gapLine}`);
    if (nextSteps.length) lines.push(`Next best actions are available in the task inbox. The top one is: ${sortedTasks[0]?.title || 'review Cortex tasks'}.`);
    if (recommendations[0]) lines.push(`Latest Cortex signal: ${recommendations[0].title}.`);
    if (!warehouseCount && wmsTask) lines.push('The main operational layer still missing is warehouse/WMS truth, so physical execution should stay gated until that is connected.');
  } else {
    lines.push(`${dataLine}\n${readinessLine} ${gapLine}`);
    if (actionIntent && nextSteps.length) lines.push(`Suggested next actions:\n${nextSteps.join('\n')}`);
    if (recommendations[0]) lines.push(`Latest Cortex signal: ${recommendations[0].title}.`);
  }

  return {
    answer: polishCortexChatText(lines.join('\n\n')),
    sources: [
      { source: 'oms_data_readiness', readinessScore: readiness.score, posture: readiness.posture },
      { source: 'oms_cortex_tasks', count: tasks.length },
      { source: 'oms_recommendations', count: recommendations.length },
      { source: 'oms_context_samples', skus: skuCount, orders: orderCount, warehouses: warehouseCount, suppliers: supplierCount, labelAuditRuns: labelRunCount },
      ...(marketplaceAppIntent ? [{ source: 'oms_marketplace_apps', count: Array.isArray(samples.marketplaceApps) ? samples.marketplaceApps.length : 0 }] : []),
      ...(marketplaceConnectionIntent ? [{ source: 'oms_marketplace_connections', count: Array.isArray(samples.marketplaceConnections) ? samples.marketplaceConnections.length : 0 }] : []),
    ],
    tasks: actionIntent || includeMarketplaceRepair
      ? responseTasks.slice(0, marketplaceConnectionIntent || priorityIntent ? 1 : 3).map((task: any) => ({
          id: task.id,
          title: task.title,
          priority: task.priority,
          screen: task.screen,
          actionTarget: task.actionTarget,
          actionLabel: task.actionLabel,
          entityId: task.entityId,
        }))
      : [],
    confidence: readiness.score != null ? Math.max(0.4, Math.min(0.88, Number(readiness.score) / 100)) : 0.45,
    readinessNotes: null,
  };
}

function normalizeCortexChatResponse(cortex: any, fallback: ReturnType<typeof buildLocalCortexChatFallback>, allowActions: boolean) {
  const data = cortex?.data || {};
  if (!cortex?.ok) return fallback;
  const answer = data.answer || data.text || data.message || data.response?.answer || data.result?.answer || data.result?.text || fallback.answer;
  const rawSources = data.sources || data.citations || data.response?.sources || data.result?.sources || [];
  const rawTasks = data.suggested_actions || data.suggestedActions || data.tasks || data.response?.tasks || [];
  const sources = (Array.isArray(rawSources) ? rawSources : []).map(normalizeChatSource).filter(Boolean);
  const tasks = allowActions
    ? (Array.isArray(rawTasks) ? rawTasks : []).map(normalizeChatAction).filter(Boolean)
    : [];
  const confidence = closedLoopNumber(data.confidence, data.response?.confidence, data.result?.confidence);
  const readinessNotes = data.readiness_notes || data.readinessNotes || data.blocked_reason || data.missing_data || null;
  return {
    answer: polishCortexChatText(String(answer || fallback.answer)),
    sources: sources.length ? sources : fallback.sources.map(normalizeChatSource).filter(Boolean),
    tasks: allowActions && tasks.length ? tasks : allowActions ? fallback.tasks.map(normalizeChatAction).filter(Boolean) : [],
    confidence: confidence ?? fallback.confidence,
    readinessNotes: readinessNotes ? polishCortexChatText(String(readinessNotes)) : readinessNotes,
  };
}

function buildCortexModelContext(context: any, focusContext: any) {
  const readiness = context?.readiness || {};
  const tasks = Array.isArray(context?.tasks) ? context.tasks : [];
  const recommendations = Array.isArray(context?.recommendations) ? context.recommendations : [];
  return {
    tenant: context?.tenant,
    screen: context?.screen,
    generatedAt: context?.generatedAt,
    readiness: {
      score: readiness.score,
      posture: readiness.posture,
      primarySource: readiness.primarySource,
      counts: readiness.counts,
      blockers: readiness.blockers || readiness.gaps || readiness.missing || [],
    },
    tasks: tasks.slice(0, 10).map((task: any) => ({
      id: task.id,
      title: task.title,
      detail: task.detail,
      priority: task.priority,
      status: task.status,
      source: task.source,
      screen: task.screen,
      actionTarget: task.actionTarget,
      actionLabel: task.actionLabel,
      entityType: task.entityType,
      entityId: task.entityId,
    })),
    recommendations: recommendations.slice(0, 8).map((recommendation: any) => ({
      id: recommendation.id,
      title: recommendation.title,
      summary: recommendation.summary,
      status: recommendation.status,
      scope: recommendation.scope,
      currentState: recommendation.currentState,
      suggestedState: recommendation.suggestedState,
      estimatedImpact: recommendation.estimatedImpact,
      confidence: recommendation.confidence,
    })),
    sourceCatalog: Array.isArray(context?.sourceCatalog) ? context.sourceCatalog : [],
    focus: {
      topic: focusContext?.topic,
      requiredSource: focusContext?.requiredSource,
    },
  };
}

const CORTEX_FOCUS_ARRAY_LIMITS: Record<string, number> = {
  apps: 50,
  asns: 25,
  connections: 25,
  customers: 40,
  decisions: 20,
  events: 30,
  findings: 30,
  orders: 60,
  returns: 30,
  runs: 20,
  shipmentPlans: 25,
  skus: 60,
  suppliers: 30,
  tickets: 30,
  warehouses: 50,
};

function compactCortexFocusRecord(collection: string, record: any) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  if (collection !== 'orders') return record;
  // Raw marketplace order payloads can be very large and are not needed by the
  // model after the OMS has normalized status, value, timing, and shipment fields.
  const { metadata: _metadata, ...normalized } = record;
  return normalized;
}

function buildCortexRequestFocusContext(focusContext: any) {
  if (!focusContext || typeof focusContext !== 'object') return {};
  const compact: Record<string, any> = {};
  const coverage: Record<string, { provided: number; available: number }> = {};
  for (const [key, value] of Object.entries(focusContext)) {
    if (!Array.isArray(value)) {
      compact[key] = value;
      continue;
    }
    const limit = CORTEX_FOCUS_ARRAY_LIMITS[key] || 25;
    compact[key] = value.slice(0, limit).map((record) => compactCortexFocusRecord(key, record));
    if (value.length > limit) coverage[key] = { provided: limit, available: value.length };
  }
  if (Object.keys(coverage).length) compact.sampleCoverage = coverage;
  return compact;
}

export async function createCortexChatMessage(userId: string, body: any = {}) {
  await ensureCortexWorkspaceTables();
  const screen = String(body.screen || 'command').slice(0, 80);
  const message = String(body.message || '').trim();
  if (!message) throw new Error('Message is required');
  const entityType = body.entityType ? String(body.entityType).slice(0, 80) : null;
  const entityId = body.entityId ? String(body.entityId).slice(0, 160) : null;
  let thread = body.threadId
    ? await one(
        `SELECT * FROM oms_cortex_chat_threads
          WHERE user_id = $1 AND id = $2 AND screen = $3
            AND entity_type IS NOT DISTINCT FROM $4
            AND entity_id IS NOT DISTINCT FROM $5
          LIMIT 1`,
        [userId, String(body.threadId), screen, entityType, entityId],
      ).catch(() => null)
    : null;
  if (!thread) {
    thread = await one(
      `INSERT INTO oms_cortex_chat_threads (user_id, screen, entity_type, entity_id, title, last_message_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [userId, screen, entityType, entityId, message.slice(0, 64) || 'Cortex chat'],
    );
  }

  await pgQuery(
    `INSERT INTO oms_cortex_chat_messages (user_id, thread_id, role, content)
     VALUES ($1, $2, 'user', $3)`,
    [userId, thread?.id, message],
  );

  const threadHistoryRows = (await rows(
    `SELECT role, content
       FROM oms_cortex_chat_messages
      WHERE user_id = $1 AND thread_id = $2 AND role IN ('user', 'assistant')
      ORDER BY created_at DESC
      LIMIT 12`,
    [userId, thread?.id],
  ).catch(() => [])).reverse();
  const lastHistoryItem = threadHistoryRows[threadHistoryRows.length - 1];
  if (lastHistoryItem?.role === 'user' && String(lastHistoryItem.content || '') === message) {
    threadHistoryRows.pop();
  }
  const threadHistory = threadHistoryRows
    .map((item: any) => ({ role: item.role, content: String(item.content || '').slice(0, 8000) }));

  // The shell refreshes readiness tasks on load and after mutations. Chat reads
  // that account state without regenerating every task for every user message.
  const context = await getAccountOmsContextBundle(userId, screen, { refreshTasks: false });
  const focusQuery = conversationAwareChatQuery(message, threadHistory);
  const focusContext = await buildChatFocusContext(userId, focusQuery, screen, context, entityType, entityId);
  const modelContext = buildCortexModelContext(context, focusContext);
  const cortexFocusContext = buildCortexRequestFocusContext(focusContext);
  const fallback = context.readiness?.cortex?.configured === false
    ? {
        answer: 'Cortex is not available for this account. Contact support or your account manager to enable Cortex intelligence.',
        sources: [{ source: 'cortex_configuration', configured: false }],
        tasks: [],
        confidence: 0.35,
        readinessNotes: 'Cortex is not configured for this account.',
      }
    : buildLocalCortexChatFallback(focusQuery, context, focusContext, message);
  const marketplaceHealthFocus = String(focusContext?.topic || '').endsWith('_connection_health')
    || String(focusContext?.requiredSource || '') === 'oms_marketplace_connections';
  const marketplaceHealthQuestion = marketplaceHealthFocus
    && (/(working|healthy|health|down|degraded|status|happening|exactly)/i.test(message) || focusQuery !== message);
  const marketplaceAppStateQuestion = String(focusContext?.topic || '') === 'marketplace_apps'
    && /(installed|available|gated|active|activated|activation|status|what (?:does|is)|which apps? (?:are|is))/i.test(message)
    && !/(should|recommend|best|most value|worth|priority|prioritize)/i.test(message);
  const marketplaceApps = Array.isArray(focusContext?.apps) ? focusContext.apps : [];
  const marketplaceAllAppsEnabled = marketplaceApps.length > 0
    && marketplaceApps.every((app: any) => Boolean(app?.isEnabled));
  const marketplaceInstalledRecommendation = String(focusContext?.topic || '') === 'marketplace_apps'
    && marketplaceAllAppsEnabled
    && /(should|recommend|prioriti[sz]e|next|best|most value|worth)/i.test(message);
  const priorityIntent = chatRequestsPriority(message);
  const accountSnapshotQuestion = chatRequestsAccountSnapshot(message);
  const accountPriorityQuestion = priorityIntent && /\b(account|operational|issue|blocker|risk)\b/i.test(message);
  const connectionScreenHealthQuestion = screen === 'connections'
    && ['shopify', 'amazon', 'ebay'].some((channel) => focusQuery.toLowerCase().includes(channel))
    && /(working|works?|healthy|health|down|degraded|status|happening|exactly|what does not)/i.test(message);
  // Connection health and account snapshots are already authoritative in the tenant-scoped OMS
  // context. Answer them locally for consistent, fast guidance; open-ended analysis still flows
  // through Cortex orchestration below.
  const accountGroundedFastPath = marketplaceHealthQuestion
    || connectionScreenHealthQuestion
    || marketplaceAppStateQuestion
    || marketplaceInstalledRecommendation
    || accountSnapshotQuestion
    || accountPriorityQuestion;
  const cortex = accountGroundedFastPath ? {
    ok: false,
    status: 200,
    data: { reason: 'account_grounded_answer' },
  } : await postCortex('/v1/orchestration/oms/chat', {
    tenant_id: userId,
    userId,
    screen,
    entity_type: entityType,
    entity_id: entityId,
    thread_id: thread?.id,
    message,
    history: threadHistory,
    focus_context: cortexFocusContext,
    context: modelContext,
    response_contract: {
      answer: 'string',
      sources: 'array of cited OMS source objects when possible',
      suggested_actions: 'array of proposed user actions or tasks',
      confidence: 'number 0-1',
      readiness_notes: 'blocked or missing data notes',
    },
    answer_policy: {
      lead_with_direct_answer: true,
      use_plain_business_language: true,
      humanize_dates_and_percentages: true,
      distinguish_observed_fact_from_suggestion: true,
      use_readiness_tasks_only_when_relevant: true,
      maximum_next_actions: 3,
      never_name_model_vendor_or_runtime: true,
      never_expose_internal_field_names: true,
      current_vs_suggested_requires_measurable_impact: true,
      sku_opportunity_requires_business_outcome_and_missing_inputs: true,
      unsupported_claim_behavior: 'state what evidence is missing instead of estimating',
    },
  }, {
    userId,
    idempotencyKey: `oms-cortex-chat-${thread?.id}-${Date.now()}`,
    timeoutMs: 35_000,
    maxAttempts: 1,
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));
  const actionIntent = chatRequestsActions(message);
  const normalized = accountGroundedFastPath
    ? fallback
    : normalizeCortexChatResponse(cortex, fallback, actionIntent);
  if (chatRequestsSkuOpportunityRanking(focusQuery)) {
    const directSkuRankingQuestion = chatRequestsSkuOpportunityRanking(message);
    const groundedSkuOpportunity = directSkuRankingQuestion
      ? buildGroundedSkuOpportunityResponse(focusQuery, context, focusContext)
      : buildGroundedSkuOpportunityFollowup(message, context, focusContext);
    if (!directSkuRankingQuestion || !skuOpportunityAnswerPassesQuality(normalized.answer, groundedSkuOpportunity)) {
      normalized.answer = groundedSkuOpportunity.answer;
      normalized.sources = groundedSkuOpportunity.sources.map(normalizeChatSource).filter(Boolean);
      normalized.tasks = actionIntent
        ? groundedSkuOpportunity.tasks.map(normalizeChatAction).filter(Boolean)
        : [];
      normalized.confidence = groundedSkuOpportunity.confidence;
      normalized.readinessNotes = groundedSkuOpportunity.readinessNotes;
    }
  }
  if (chatRequestsOrderPriority(focusQuery)) {
    const groundedOrderPriority = buildGroundedOrderPriorityResponse(message, context, focusContext);
    normalized.answer = groundedOrderPriority.answer;
    normalized.sources = groundedOrderPriority.sources.map(normalizeChatSource).filter(Boolean);
    normalized.tasks = groundedOrderPriority.tasks.map(normalizeChatAction).filter(Boolean);
    normalized.confidence = groundedOrderPriority.confidence;
    normalized.readinessNotes = groundedOrderPriority.readinessNotes;
  }
  if (chatRequestsWarehouseRisk(focusQuery)) {
    const groundedWarehouseRisk = buildGroundedWarehouseRiskResponse(message, context, focusContext);
    normalized.answer = groundedWarehouseRisk.answer;
    normalized.sources = groundedWarehouseRisk.sources.map(normalizeChatSource).filter(Boolean);
    normalized.tasks = groundedWarehouseRisk.tasks.map(normalizeChatAction).filter(Boolean);
    normalized.confidence = groundedWarehouseRisk.confidence;
    normalized.readinessNotes = groundedWarehouseRisk.readinessNotes;
  }
  if (String(focusContext?.topic || '') === 'marketplace_apps') {
    const apps = Array.isArray(focusContext?.apps) ? focusContext.apps : [];
    const enabledApps = apps.filter((app: any) => Boolean(app?.isEnabled));
    const allAppsEnabled = apps.length > 0 && enabledApps.length === apps.length;
    const recommendationIntent = /(should|recommend|prioriti[sz]e|next|best|most value|worth)/i.test(message);
    const contradictsEntitlements = allAppsEnabled
      && /(activat(?:e|ion)|install|not enabled|establish a connection|connect to at least one)/i.test(normalized.answer);
    if (allAppsEnabled && (recommendationIntent || contradictsEntitlements)) {
      const connectionRepair = (Array.isArray(context?.tasks) ? context.tasks : []).find((task: any) => {
        const text = `${task?.title || ''} ${task?.detail || ''}`.toLowerCase();
        return String(task?.source || '') === 'connection_health' && /(shopify|amazon|ebay|marketplace)/.test(text);
      });
      const installedNames = enabledApps.map((app: any) => app.name).filter(Boolean).join(', ');
      const lines = [
        `No Marketplace app needs installation or activation. All ${enabledApps.length} apps are already active: ${installedNames}.`,
      ];
      if (connectionRepair) {
        lines.push(`The next priority is connection quality, not another app: ${humanizeInternalLanguage(connectionRepair.title)}.`);
        if (connectionRepair.detail) lines.push(humanizeInternalLanguage(connectionRepair.detail));
        if (connectionRepair.actionLabel) lines.push(`Next action: ${humanizeInternalLanguage(connectionRepair.actionLabel)}.`);
      } else {
        lines.push('Choose the installed app that matches the workflow you want to run; activation is not blocking any Marketplace screen on this account.');
      }
      normalized.answer = polishCortexChatText(lines.join('\n\n'));
      normalized.sources = [normalizeChatSource({ source: 'oms_marketplace_apps' })].filter(Boolean);
      normalized.tasks = connectionRepair && actionIntent
        ? [normalizeChatAction({
            id: connectionRepair.id,
            title: connectionRepair.title,
            priority: connectionRepair.priority,
            screen: connectionRepair.screen,
            actionTarget: connectionRepair.actionTarget || connectionRepair.screen,
            actionLabel: connectionRepair.actionLabel,
            entityId: connectionRepair.entityId,
          })].filter(Boolean)
        : [];
      normalized.confidence = 1;
      normalized.readinessNotes = null;
    }
  }
  const decisionIntent = chatRequestsDecision(message);
  if (decisionIntent) {
    normalized.answer = fallback.answer;
    normalized.sources = fallback.sources.map(normalizeChatSource).filter(Boolean);
    normalized.tasks = [];
    normalized.confidence = fallback.confidence;
    normalized.readinessNotes = null;
  }
  if (normalized.tasks.length) {
    const contextTasks = Array.isArray(context?.tasks) ? context.tasks : [];
    const requestedChannel = ['shopify', 'amazon', 'ebay'].find((channel) => message.toLowerCase().includes(channel));
    if (requestedChannel) {
      normalized.tasks = contextTasks
        .filter((task: any) => {
          const text = `${task.dedupeKey || ''} ${task.title || ''} ${task.detail || ''}`.toLowerCase();
          return String(task.source || '') === 'connection_health' && text.includes(requestedChannel);
        })
        .slice(0, 3)
        .map((task: any) => normalizeChatAction({
          id: task.id,
          title: task.title,
          priority: task.priority,
          screen: task.screen,
          actionTarget: task.actionTarget,
          actionLabel: task.actionLabel,
          entityId: task.entityId,
        }))
        .filter(Boolean);
    }
    normalized.tasks = normalized.tasks.map((action: any) => {
      const actionTarget = String(action.actionTarget || action.screen || '');
      if (action.entityId && ['sku-detail', 'orders', 'warehouses'].includes(actionTarget)) return action;
      const matchingTask = contextTasks.find((task: any) => String(task.id || '') === String(action.id || ''))
        || (() => {
          const actionTokens = new Set(`${action.title || ''} ${action.actionLabel || ''}`
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length > 3 && !['open', 'review', 'complete', 'related', 'screen'].includes(token)));
          const candidates = contextTasks
            .filter((task: any) => {
              const taskTarget = String(task.actionTarget || task.screen || '');
              if (actionTarget && taskTarget && taskTarget !== actionTarget) return false;
              if (actionTarget !== 'connections' || !requestedChannel) return true;
              const text = `${task.dedupeKey || ''} ${task.title || ''} ${task.detail || ''}`.toLowerCase();
              return String(task.source || '') === 'connection_health' && text.includes(requestedChannel);
            })
            .map((task: any) => {
              const text = `${task.title || ''} ${task.actionLabel || ''} ${task.detail || ''}`.toLowerCase();
              const tokenScore = Array.from(actionTokens).filter((token) => text.includes(token)).length;
              const targetScore = String(task.actionTarget || task.screen || '') === actionTarget ? 1 : 0;
              const score = tokenScore + targetScore;
              return { task, score };
            })
            .sort((a: any, b: any) => b.score - a.score);
          const best = candidates[0];
          return best && best.score >= 2 ? best.task : null;
        })();
      return matchingTask
        ? normalizeChatAction({
            id: matchingTask.id,
            title: matchingTask.title,
            priority: matchingTask.priority,
            screen: matchingTask.screen,
            actionTarget: matchingTask.actionTarget || matchingTask.screen,
            actionLabel: matchingTask.actionLabel,
            entityId: matchingTask.entityId,
          })
        : action;
    }).filter(Boolean);
    const seenActions = new Set<string>();
    normalized.tasks = normalized.tasks.filter((action: any) => {
      const key = action.id || `${String(action.title || '').toLowerCase()}|${action.actionTarget || action.screen || ''}`;
      if (seenActions.has(key)) return false;
      seenActions.add(key);
      return true;
    }).slice(0, priorityIntent ? 1 : 3);
  }
  if (actionIntent && normalized.tasks.length) {
    const alreadyActionable = /\b(first action|next step|start by|open|upload|add|connect|reconnect|review|complete)\b/i.test(normalized.answer);
    if (!alreadyActionable) {
      const first = normalized.tasks[0];
      const actionLabel = String(first.actionLabel || 'Open the related screen').replace(/[.!]+$/, '');
      const taskTitle = String(first.title || '').replace(/[.!]+$/, '');
      const sameLabel = actionLabel.localeCompare(taskTitle, undefined, { sensitivity: 'base' }) === 0;
      normalized.answer = polishCortexChatText(`${normalized.answer}\n\nFirst action: ${actionLabel}${taskTitle && !sameLabel ? ` to complete “${taskTitle}.”` : '.'}`);
    }
  }
  const marketplaceAnswerHasCoverage = /(products?|orders?)/i.test(normalized.answer)
    && /inventory/i.test(normalized.answer)
    && /(next|repair|reconnect|authoriz)/i.test(normalized.answer);
  if (marketplaceHealthQuestion && !marketplaceAnswerHasCoverage) {
    normalized.answer = fallback.answer;
  }
  const requiredFocusSource = normalizeChatSource({ source: focusContext?.requiredSource });
  if (requiredFocusSource) {
    const focusedSources = normalized.sources.filter((source: any) => source?.source === requiredFocusSource.source);
    normalized.sources = focusedSources.length ? focusedSources : [requiredFocusSource];
  }
  normalized.sources = normalized.sources.slice(0, 5);
  normalized.answer = polishCortexChatText(normalized.answer);
  if (normalized.readinessNotes) normalized.readinessNotes = polishCortexChatText(normalized.readinessNotes);
  const liveRouteAvailable = !accountGroundedFastPath && Boolean(cortex?.ok);
  // A tenant credential can remain valid even when the global bootstrap key is
  // absent. A successful tenant route is authoritative for chat availability.
  const accountScopedChatAvailable = liveRouteAvailable || context.readiness?.cortex?.configured !== false;
  const cortexHealth = {
    available: accountScopedChatAvailable,
    chatIntegrated: accountScopedChatAvailable,
    status: accountScopedChatAvailable ? 200 : 503,
    reason: accountGroundedFastPath
      ? 'account_grounded_answer'
      : liveRouteAvailable ? 'live_chat_available' : accountScopedChatAvailable ? 'account_chat_available' : 'cortex_not_configured',
    mode: liveRouteAvailable ? 'live' : accountScopedChatAvailable ? 'account_scoped' : 'unavailable',
    liveRouteAvailable,
    liveRouteStatus: cortex?.status || 503,
    liveRouteReason: accountGroundedFastPath
      ? 'not_required_for_account_fact'
      : cortex?.ok
      ? 'live_chat_available'
      : cortex?.status === 404
        ? 'cortex_chat_route_not_available'
        : cortex?.data?.error || 'cortex_chat_unavailable',
  };
  const saved = await one(
    `INSERT INTO oms_cortex_chat_messages
       (user_id, thread_id, role, content, sources, tasks, confidence, readiness_notes, cortex_status, cortex_response)
     VALUES ($1, $2, 'assistant', $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb)
     RETURNING *`,
    [
      userId,
      thread?.id,
      normalized.answer,
      JSON.stringify(normalized.sources),
      JSON.stringify(normalized.tasks),
      normalized.confidence,
      normalized.readinessNotes,
      liveRouteAvailable ? 'live' : accountScopedChatAvailable ? 'account_scoped' : 'unavailable',
      JSON.stringify(cortex || {}),
    ],
  );
  await pgQuery(
    `UPDATE oms_cortex_chat_threads SET last_message_at = now(), updated_at = now() WHERE user_id = $1 AND id = $2`,
    [userId, thread?.id],
  ).catch(() => null);
  await pgQuery(
    `INSERT INTO oms_copilot_events (user_id, screen, prompt, response)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [userId, screen, message, JSON.stringify({ threadId: thread?.id, answer: normalized.answer, cortexStatus: liveRouteAvailable ? 'live' : accountScopedChatAvailable ? 'account_scoped' : 'unavailable', cortexHealth })],
  ).catch(() => null);
  return {
    thread: mapCortexThread(thread),
    message: mapCortexMessage(saved),
    context: { screen, readiness: context.readiness, tasks: context.tasks.slice(0, 8), recommendations: context.recommendations.slice(0, 5) },
    cortex: { ok: accountScopedChatAvailable, status: cortexHealth.status, health: cortexHealth },
  };
}

export async function getCortexChatHealth(userId: string, screen = 'command') {
  // Health polling runs continuously in the top bar and drawer. It must not
  // build the full OMS context bundle (orders, SKUs, tasks, warehouses) every
  // minute; the real chat request performs that grounding when the user asks.
  const configured = cortexConfigStatus().configured;
  const live = await postCortex('/v1/orchestration/oms/chat/health', {
    tenant_id: userId,
    userId,
  }, {
    userId,
    idempotencyKey: `oms-cortex-chat-health-${userId}-${Math.floor(Date.now() / 60_000)}`,
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex health check failed' } }));
  const liveRouteAvailable = Boolean(live?.ok && live?.data?.available !== false);
  const accountScopedChatAvailable = configured || liveRouteAvailable;
  if (!accountScopedChatAvailable) {
    return {
      ok: false,
      status: 503,
      health: {
        available: false,
        chatIntegrated: false,
        status: 503,
        reason: 'cortex_not_configured',
        mode: 'unavailable',
        liveRouteAvailable: false,
        liveRouteStatus: Number(live?.status || 503),
        liveRouteReason: live?.data?.error || live?.data?.detail || 'cortex_chat_unavailable',
      },
    };
  }
  const health = {
    available: true,
    chatIntegrated: true,
    status: 200,
    reason: liveRouteAvailable
      ? 'live_chat_available'
      : 'account_chat_available',
    mode: liveRouteAvailable ? 'live' : 'account_scoped',
    liveRouteAvailable,
    liveRouteStatus: Number(live?.status || 503),
    liveRouteReason: liveRouteAvailable
      ? 'live_chat_available'
      : live?.status === 404
        ? 'cortex_chat_route_not_available'
        : live?.data?.error || live?.data?.detail || 'cortex_chat_unavailable',
  };
  return { ok: true, status: health.status, health };
}

export async function getCortexChatThreads(userId: string, query: any = {}) {
  await ensureCortexWorkspaceTables();
  const filters = ['user_id = $1'];
  const values: any[] = [userId];
  if (query.screen) {
    values.push(String(query.screen));
    filters.push(`screen = $${values.length}`);
  }
  if (query.entityType) {
    values.push(String(query.entityType));
    filters.push(`entity_type = $${values.length}`);
  }
  if (query.entityId) {
    values.push(String(query.entityId));
    filters.push(`entity_id = $${values.length}`);
  }
  values.push(Math.min(50, Math.max(1, number(query.limit, 20))));
  const data = await rows(
    `SELECT * FROM oms_cortex_chat_threads WHERE ${filters.join(' AND ')}
     ORDER BY COALESCE(last_message_at, updated_at, created_at) DESC LIMIT $${values.length}`,
    values,
  );
  return { threads: data.map(mapCortexThread) };
}

export async function getCortexChatThread(userId: string, threadId: string) {
  await ensureCortexWorkspaceTables();
  const thread = await one('SELECT * FROM oms_cortex_chat_threads WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, threadId]);
  if (!thread) return null;
  const messages = await rows('SELECT * FROM oms_cortex_chat_messages WHERE user_id = $1 AND thread_id = $2 ORDER BY created_at ASC LIMIT 200', [userId, threadId]);
  return { thread: mapCortexThread(thread), messages: messages.map(mapCortexMessage) };
}

function mapRun(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: publicEntityId('IR', row.id),
    runType: row.run_type || row.runType,
    status: row.status,
    sourcePriority: row.source_priority,
    sourceSummary: json(row.source_summary, {}),
    input: json(row.input, {}),
    output: json(row.output, {}),
    confidence: row.confidence == null ? null : Number(row.confidence),
    cortexStatus: row.cortex_status,
    cortexResponse: json(row.cortex_response, {}),
    error: row.error,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapProductResult(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: publicEntityId('PR', row.id),
    runId: row.run_id,
    itemId: row.item_id,
    sku: row.sku,
    status: row.status,
    input: json(row.input, {}),
    result: json(row.result, {}),
    confidence: row.confidence == null ? null : Number(row.confidence),
    sourceSummary: json(row.source_summary, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function reconcileProductResultWithCurrentItem(mapped: any, item: Row | null) {
  if (!mapped || !item) return mapped;
  const result = { ...(mapped.result || {}) };
  const missing = new Set(Array.isArray(result.missingData) ? result.missingData : []);
  const metadata = json(item.metadata, {});
  const attributes = json(item.attributes, {});
  const price = number(attributes.price ?? metadata.price ?? metadata.shopifyPrice ?? metadata.sellingPrice);
  const cost = number(attributes.cost ?? metadata.cost ?? metadata.unitCost);
  const cubeFt = dimensionsCubeFt(item, {});
  const weight = number(item.weight);

  if (cubeFt > 0 && weight > 0) missing.delete('dimensions_weight');
  if (price > 0) missing.delete('selling_price');
  if (cost > 0) missing.delete('cost');

  result.missingData = Array.from(missing);
  result.fulfillment = {
    ...(result.fulfillment || {}),
    cubeFt: cubeFt || result.fulfillment?.cubeFt || 0,
    weightLbs: weight || result.fulfillment?.weightLbs || 0,
    estimatedUnitsPerPallet: cubeFt > 0 ? Math.max(1, Math.floor(52 / cubeFt)) : (result.fulfillment?.estimatedUnitsPerPallet || 0),
  };
  result.margin = {
    ...(result.margin || {}),
    price: price || result.margin?.price || 0,
    cost: cost || result.margin?.cost || 0,
  };
  if (result.margin.price > 0 && result.margin.cost > 0) {
    result.margin.marginPct = Math.round(((result.margin.price - result.margin.cost) / result.margin.price) * 1000) / 1000;
    result.margin.status = result.margin.marginPct > 0.3 ? 'healthy' : result.margin.marginPct > 0.18 ? 'thin' : 'at_risk';
  } else {
    result.margin.status = 'needs_price_cost';
  }
  result.recommendedAction = result.missingData.length
    ? `Complete ${result.missingData.map((m: string) => m.replace(/_/g, ' ')).join(', ')} before high-confidence optimization.`
    : 'Feed this SKU into Optimize Suite for warehouse placement and replenishment planning.';

  return {
    ...mapped,
    status: result.missingData.length ? mapped.status : 'completed',
    result,
  };
}

function mapSellerOptimization(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: publicEntityId('SO', row.id),
    runId: row.run_id,
    status: row.status,
    summary: json(row.summary, {}),
    businessDouble: json(row.business_double, {}),
    inventoryPlan: json(row.inventory_plan, {}),
    sourceSummary: json(row.source_summary, {}),
    confidence: row.confidence == null ? null : Number(row.confidence),
    cortexStatus: row.cortex_status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapRecommendation(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: publicEntityId('RC', row.id),
    runId: row.run_id,
    recommendationType: row.recommendation_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: humanizeInternalLanguage(row.title),
    summary: humanizeInternalLanguage(row.summary),
    currentValue: json(row.current_value, {}),
    optimizedValue: json(row.optimized_value, {}),
    estimatedImpact: json(row.estimated_impact, {}),
    requiredAction: humanizeInternalLanguage(row.required_action),
    approvalState: row.approval_state,
    wmsTruthState: row.wms_truth_state,
    confidence: row.confidence == null ? null : Number(row.confidence),
    sourceSummary: json(row.source_summary, {}),
    status: row.status,
    rejectionReason: row.rejection_reason,
    approvedAt: iso(row.approved_at),
    rejectedAt: iso(row.rejected_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCortexTask(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: publicEntityId('CT', row.id),
    dedupeKey: row.dedupe_key,
    source: row.source,
    screen: row.screen,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: humanizeInternalLanguage(row.title),
    detail: humanizeInternalLanguage(row.detail),
    priority: row.priority,
    status: row.status,
    actionLabel: humanizeInternalLanguage(row.action_label),
    actionTarget: row.action_target,
    evidence: json(row.evidence, {}),
    recommendationId: row.recommendation_id,
    completedAt: iso(row.completed_at),
    dismissedAt: iso(row.dismissed_at),
    autoCompletedAt: iso(row.auto_completed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCortexThread(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: publicEntityId('CH', row.id),
    screen: row.screen,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    status: row.status,
    lastMessageAt: iso(row.last_message_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCortexMessage(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    sources: json(row.sources, []),
    tasks: json(row.tasks, []),
    confidence: row.confidence == null ? null : Number(row.confidence),
    readinessNotes: row.readiness_notes,
    cortexStatus: row.cortex_status,
    cortexResponse: json(row.cortex_response, {}),
    createdAt: iso(row.created_at),
  };
}

function mapRunEvent(row: any) {
  return {
    id: row.id,
    runId: row.run_id,
    eventType: row.event_type,
    summary: row.summary,
    payload: json(row.payload, {}),
    createdAt: iso(row.created_at),
  };
}

type CortexRecommendation = {
  recommendation_type?: string;
  recommendationType?: string;
  entity_type?: string;
  entityType?: string;
  entity_id?: string;
  entityId?: string;
  title?: string;
  summary?: string;
  current_value?: Record<string, unknown>;
  currentValue?: Record<string, unknown>;
  optimized_value?: Record<string, unknown>;
  optimizedValue?: Record<string, unknown>;
  estimated_impact?: Record<string, unknown>;
  estimatedImpact?: Record<string, unknown>;
  required_action?: string;
  requiredAction?: string;
  confidence?: number;
};

export type CortexCallbackBody = {
  tenant_id: string;
  run_id: string;
  engagement_id: string;
  status: string;
  result: {
    business_double?: Record<string, any>;
    summary?: Record<string, any>;
    planning?: Record<string, any>;
    recommendations?: CortexRecommendation[];
    [k: string]: unknown;
  };
};

function pick<T>(...args: (T | undefined)[]): T | undefined {
  for (const v of args) if (v !== undefined) return v;
  return undefined;
}

export function verifyCortexWebhookSignature(rawBody: Buffer, headerValue: string | undefined): boolean {
  const secret = process.env.CORTEX_WEBHOOK_SECRET || '';
  if (!secret || !headerValue) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = headerValue.startsWith('sha256=') ? headerValue.slice(7) : headerValue;
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

export async function ingestCortexResult(body: CortexCallbackBody) {
  const { tenant_id: userId, run_id: cortexRunId, engagement_id: engagementId, result } = body;
  if (!userId || !cortexRunId) return { ok: false, reason: 'missing tenant or run id' };

  // Cortex resets and reuses one remote run resource for repeated executions of
  // the same engagement. Match the newest local execution deterministically;
  // cortex_run_id alone is therefore not a unique execution identifier.
  let run: Row | null = await one(
    `SELECT *
       FROM oms_intelligence_runs
      WHERE user_id = $1 AND cortex_run_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, cortexRunId],
  );
  if (!run) {
    run = await one(
      `SELECT * FROM oms_intelligence_runs
       WHERE user_id = $1 AND run_type = 'seller_optimization'
         AND status IN ('pending_cortex','running')
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
  }

  if (run && !matchesCortexExecution(json(run.cortex_response, {}), result)) {
    return {
      ok: true,
      ignored: true,
      reason: 'stale_execution',
      runId: run.id,
      cortexRunId,
    };
  }

  const existingSnapshot = run?.id
    ? await one(
        `SELECT id
           FROM oms_seller_optimization_runs
          WHERE user_id = $1 AND run_id = $2
            AND source_summary->>'cortexRunId' = $3
          ORDER BY created_at DESC LIMIT 1`,
        [userId, run.id, cortexRunId],
      )
    : await one(
        `SELECT id
           FROM oms_seller_optimization_runs
          WHERE user_id = $1 AND run_id IS NULL
            AND source_summary->>'cortexRunId' = $2
          ORDER BY created_at DESC LIMIT 1`,
        [userId, cortexRunId],
      );
  if (existingSnapshot) {
    return { ok: true, duplicate: true, runId: existingSnapshot.id, cortexRunId };
  }

  // Cortex bundle shape:
  //   result.synthesis.ai_recommendations.items[]
  //   result.synthesis.ai_recommendations.executive_summary{verdict, top_findings, immediate_actions}
  //   result.planning.scenario_integrated_fbm.network_fulfillment_economics
  //   result.planning.scenario_integrated_fbm.warehouse_network.order_velocity_enrichment.estimated_monthly_demand_units_for_planning
  const synthesis = (result as any)?.synthesis || {};
  const aiRecs = synthesis?.ai_recommendations || {};
  const aiItems: any[] = Array.isArray(aiRecs?.items) ? aiRecs.items : [];
  const execSummary = aiRecs?.executive_summary || {};

  const planning = (result as any)?.planning || {};
  const fbm = planning?.scenario_integrated_fbm || {};
  const econ = fbm?.network_fulfillment_economics || {};
  const demand = number(
    fbm?.warehouse_network?.order_velocity_enrichment?.estimated_monthly_demand_units_for_planning ||
      fbm?.warehouse_network?.monthly_total_demand_units ||
      0,
  );
  const singleCostPU = number(econ?.single_warehouse_fulfillment_cost_usd_per_unit);
  const multiCostPU = number(econ?.multi_warehouse_fulfillment_cost_usd_per_unit);
  const perUnitSavings = Math.max(0, singleCostPU - multiCostPU);
  const monthlyCurrentCost = singleCostPU * demand;
  const monthlyOptimizedCost = multiCostPU * demand;
  const monthlySavings = perUnitSavings * demand;
  const savingsPct = number(econ?.savings_pct_multi_warehouse_vs_single_warehouse);
  const confidence = number(
    synthesis?.competitive_kpis?.confidence ?? execSummary?.confidence ?? 0.85,
    0.85,
  );

  const haveBusinessDouble = monthlySavings > 0 && demand > 0;
  const haveAIRecs = aiItems.length > 0;

  if (!haveBusinessDouble && !haveAIRecs) {
    // Nothing actionable in this bundle; leave existing recs in place so the UI
    // does not appear to regress between cycles.
    if (run?.id) {
      await completeRun({
        userId,
        runId: run.id,
        status: 'completed',
        output: {
          from_cortex: true,
          cortexRunId,
          monthlySavings: 0,
          note: 'No extractable recs or economics in Cortex bundle',
        },
        confidence,
        cortexStatus: 'ok',
        cortexResponse: {
          schema_version: (result as any)?.schema_version,
          engagement_id: engagementId,
          execution_id: (result as any)?.execution_id || null,
        },
      });
    }
    return { ok: true, runId: run?.id || null, cortexRunId, recommendationCount: 0, skipped: 'empty_bundle' };
  }

  const stored = await one(
    `INSERT INTO oms_seller_optimization_runs
       (user_id, run_id, status, summary, business_double, inventory_plan, source_summary, confidence)
     VALUES ($1, $2, 'completed', $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7)
     RETURNING *`,
    [
      userId,
      run?.id || null,
      JSON.stringify({
        title: 'Cortex Seller Optimization',
        from_cortex: true,
        cortexRunId,
        engagementId,
        monthlySavings,
        annualizedSavings: monthlySavings * 12,
        currentMonthlyCost: monthlyCurrentCost,
        optimizedMonthlyCost: monthlyOptimizedCost,
        demandUnitsMonthly: demand,
        savingsPct,
        verdict: execSummary?.verdict || null,
      }),
      JSON.stringify({
        currentMetrics: { monthlyCost: monthlyCurrentCost, costPerUnit: singleCostPU, warehouseNodes: 1 },
        optimizedMetrics: {
          monthlyCost: monthlyOptimizedCost,
          costPerUnit: multiCostPU,
          warehouseNodes:
            number(fbm?.warehouse_network?.network_selection_meta?.selected_warehouse_count) || 2,
        },
        savings: {
          perUnit: perUnitSavings,
          monthly: monthlySavings,
          total: monthlySavings,
          annualized: monthlySavings * 12,
          pct: savingsPct,
          costReductionPct: savingsPct,
        },
        recommendationVerdict: fbm?.recommendation || null,
      }),
      JSON.stringify({
        scenario_integrated_fbm_snapshot: {
          recommendation: fbm?.recommendation,
          savings_pct: savingsPct,
          demand,
        },
      }),
      JSON.stringify({
        source: 'cortex_webhook',
        cortexRunId,
        localRunId: run?.id || null,
        engagementId,
        schema_version: (result as any)?.schema_version,
      }),
      Math.min(0.98, Math.max(0.5, confidence)),
    ],
  );

  const validatedBusiness = haveBusinessDouble
    ? await getBusinessDouble(userId).catch(() => null)
    : null;
  const businessDecisionReady = validatedBusiness?.plan?.decisionReady === true;

  await supersedeOpenRecommendations(userId, SELLER_OPTIMIZATION_RECOMMENDATION_TYPES);
  let created = 0;

  if (haveBusinessDouble && businessDecisionReady) {
    await createRecommendation(userId, {
      runId: run?.id || null,
      recommendationType: 'business_double',
      entityType: 'business_double',
      entityId: stored?.id,
      title: 'Approve Cortex-optimized multi-warehouse plan',
      summary: `Cortex AI projects $${Math.round(monthlySavings).toLocaleString()}/mo savings (~${Math.round(savingsPct)}%) by moving from a single warehouse to the recommended multi-node layout. Monthly demand: ${Math.round(demand).toLocaleString()} units.`,
      currentValue: { monthlyCost: monthlyCurrentCost, costPerUnit: singleCostPU, warehouseNodes: 1 },
      optimizedValue: {
        monthlyCost: monthlyOptimizedCost,
        costPerUnit: multiCostPU,
        warehouseNodes:
          number(fbm?.warehouse_network?.network_selection_meta?.selected_warehouse_count) || 2,
      },
      estimatedImpact: { monthlySavings, annualizedSavings: monthlySavings * 12, savingsPct },
      requiredAction: 'approve_business_double',
      approvalState: 'waiting_approval',
      wmsTruthState: 'forecast_only',
      confidence,
      sourceSummary: { from_cortex: true, cortexRunId, localRunId: run?.id || null, verdict: execSummary?.verdict || null },
    });
    created += 1;
  }

  for (const item of aiItems.slice(0, 8)) {
    const recommendationText = [item?.category, item?.title, item?.why, item?.action]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const isPrerequisiteWork = /(data|readiness|enrich|feed|upload|evidence|missing|connect|configure|complete)/.test(recommendationText);
    await createRecommendation(userId, {
      runId: run?.id || null,
      recommendationType: String(item?.category || 'data_readiness'),
      entityType: 'account',
      entityId: userId,
      title: String(item?.title || 'Cortex AI recommendation'),
      summary: String(item?.why || item?.action || ''),
      currentValue: { evidencePath: item?.evidence_path || null },
      optimizedValue: { action: item?.action || null },
      estimatedImpact: { priority: String(item?.priority || 'medium') },
      requiredAction: String(item?.action || 'review'),
      approvalState: isPrerequisiteWork ? 'not_required' : 'waiting_approval',
      wmsTruthState: 'forecast_only',
      confidence,
      sourceSummary: {
        from_cortex: true,
        cortexRunId,
        localRunId: run?.id || null,
        item_id: item?.id || null,
        priority: item?.priority || null,
        category: item?.category || null,
      },
    });
    created += 1;
  }

  if (run?.id) {
    await completeRun({
      userId,
      runId: run.id,
      status: 'completed',
      output: {
        from_cortex: true,
        cortexRunId,
        monthlySavings,
        recommendationCount: created,
        verdict: execSummary?.verdict || null,
      },
      confidence,
      cortexStatus: 'ok',
      cortexResponse: {
        schema_version: (result as any)?.schema_version,
        engagement_id: engagementId,
        execution_id: (result as any)?.execution_id || null,
        recommendation_count: created,
      },
    });
  }

  await writeOmsLedgerEvent({
    userId,
    entityType: 'seller_optimization',
    entityId: stored?.id || run?.id || null,
    eventType: 'cortex_callback_ingested',
    sourceSystem: 'cortex',
    summary: `Cortex completed seller-optimization. ${created} recommendations ingested. Monthly savings: $${Math.round(monthlySavings).toLocaleString()}.`,
    payload: { cortexRunId, engagementId, recommendationCount: created, monthlySavings, verdict: execSummary?.verdict || null },
    confidence,
  });

  // Advance next_intelligence_run_at on the credential row so the UI shows
  // when the next refresh is expected (best-effort, swallow errors).
  await pgQuery(
    `UPDATE oms_cortex_credentials
       SET last_intelligence_run_at = now(),
           next_intelligence_run_at = now() + (
             CASE intelligence_tier
               WHEN 'demo' THEN INTERVAL '5 minutes'
               WHEN 'fast' THEN INTERVAL '1 hour'
               WHEN 'slow' THEN INTERVAL '24 hours'
               ELSE INTERVAL '6 hours'
             END
           ),
           updated_at = now()
     WHERE user_id = $1`,
    [userId],
  ).catch(() => null);

  return { ok: true, runId: run?.id || null, cortexRunId, recommendationCount: created };
}

async function reconcileLatestCortexOptimization(userId: string) {
  const localRun = await one(
    `SELECT id, cortex_run_id, output, cortex_response
       FROM oms_intelligence_runs
      WHERE user_id = $1
        AND run_type = 'seller_optimization'
        AND cortex_run_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  const cortexRunId = String(localRun?.cortex_run_id || '').trim();
  if (!localRun || !cortexRunId || json(localRun.output, {})?.from_cortex === true) return null;

  const existing = await one(
    `SELECT id
       FROM oms_seller_optimization_runs
      WHERE user_id = $1 AND run_id = $2
        AND source_summary->>'cortexRunId' = $3
      LIMIT 1`,
    [userId, localRun.id, cortexRunId],
  );
  if (existing) return { ok: true, duplicate: true, runId: existing.id, cortexRunId };

  const headers = await getCortexCredentialHeaders(userId).catch(() => null);
  if (!headers) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      `${config.cortex.apiUrl}/v1/assessment/seller-optimization/runs/${encodeURIComponent(cortexRunId)}`,
      { headers, signal: controller.signal as any },
    );
    if (!response.ok) return null;
    const remote: any = await response.json().catch(() => ({}));
    if (!['complete', 'completed'].includes(String(remote?.status || '').toLowerCase()) || !remote?.result) return null;
    if (!matchesCortexExecution(json(localRun.cortex_response, {}), remote)) return null;
    return ingestCortexResult({
      tenant_id: userId,
      run_id: cortexRunId,
      engagement_id: String(remote?.engagement_id || remote?.result?.engagement_id || ''),
      status: 'completed',
      result: remote.result,
    });
  } finally {
    clearTimeout(timeout);
  }
}
