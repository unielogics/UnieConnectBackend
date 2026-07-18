import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { publicEntityId } from '../lib/public-id';
import { cortexConfigStatus, postCortex } from './cortex-orchestration';
import { getBusinessDouble, getInventoryPlan, writeOmsLedgerEvent, getBillingCategoryTotals, getStorageBillingSignal } from './oms-production.service';
import { lookupProductByIdentifier, type KeepaLookupResult } from './keepa-lookup.service';

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
    const opts: { type?: 'asin' | 'upc' | 'ean'; tenantId?: string } = { tenantId: userId };
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

// Proposed per-category cost-reduction percentages for the advisory "AI billing plan". These are
// ADVISORY projections (the WMS does not actually re-rate today), capped conservatively so the hero
// can never imply near-free operations. Each carries the itemized action shown to the seller.
const BILLING_PLAN_CATEGORY_ACTIONS: Record<string, { pct: number; action: string }> = {
  freight: { pct: 0.16, action: 'Carrier/lane re-rate + shared-pallet consolidation on top outbound lanes.' },
  storage: { pct: 0.1, action: 'Storage tier downgrade + pre-positioning of slow-movers to cheaper zones.' },
  handling: { pct: 0.12, action: 'Split-node fulfillment to shorten pick paths and cut per-order handling.' },
  accessorials: { pct: 0.24, action: 'Dim-weight reclass + automated accessorial disputes on flagged charges.' },
  materials: { pct: 0.05, action: 'Right-sized packaging substitution to reduce material spend per order.' },
};

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
       (SELECT COUNT(*) FROM facilities WHERE (user_id = $1 OR user_id IS NULL) AND COALESCE(metadata->>'source', '') NOT IN ('sql_default','demo'))::int AS facilities,
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

  const rec = await createRecommendation(userId, {
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
  });

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

  // Storage has a REAL per-account signal (unlike the other categories, which are still sized from
  // the fixed menu until their own real signals are wired — see the P1-P5 punch list in memory):
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
      const cfg = BILLING_PLAN_CATEGORY_ACTIONS[category] || { pct: 0.1, action: 'Cost review.' };
      pct = cfg.pct;
      action = cfg.action;
      // Honest confidence: categories still sized from the fixed menu (no real signal wired yet)
      // are capped lower than a data-backed suggestion, and scale up slightly with sample size.
      confidence = category === 'storage' ? 0.3 : 0.45;
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
    wmsTruthState: 'forecast_only',
    confidence: 0.6,
    sourceSummary: { primarySource: 'wms_invoices', basis: 'trailing_30d' },
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
  const currentMonthlyCost = number(summary.currentMonthlyCost);
  const optimizedMonthlyCost = number(summary.optimizedMonthlyCost);
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
    const claimableBaseline = Math.max(0, Math.round(currentMonthlyCost * 0.012 * 100) / 100);
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
      optimizedValue: { preventableLeakage: claimableBaseline, evidenceMode: readiness.counts.marketplaceOrders > 0 ? 'marketplace_plus_carrier' : 'csv_evidence_needed' },
      estimatedImpact: { monthlySavings: claimableBaseline, annualizedSavings: claimableBaseline * 12 },
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

  // Send the minimal body Cortex's pydantic model accepts. The scheduler uses
  // this exact shape and gets 200; richer fields (seller_context, etc.) caused
  // 422 in earlier attempts.
  const cortex = engagementId
    ? await postCortex('/v1/assessment/seller-optimization/runs', {
        engagement_id: engagementId,
        with_ai_recommendations: true,
        input_summary: `OMS user-triggered run (readiness ${readiness.score}, ${readiness.posture}).`,
      }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }))
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
  const optimizedMonthlyCost = number(business.plan?.optimizedMetrics?.monthlyCost) || number(inventory.proposed?.estimatedMonthlyCost);
  const monthlySavings = Math.max(0, currentMonthlyCost - optimizedMonthlyCost);
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
  if (monthlySavings > 0) {
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

export async function getRecommendations(userId: string, query: any = {}) {
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

export async function approveRecommendation(userId: string, recommendationId: string, body: any = {}) {
  const rec = await one('SELECT * FROM oms_recommendations WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, recommendationId]);
  if (!rec) return null;
  const updated = await one(
    `UPDATE oms_recommendations
     SET approval_state = 'approved', status = 'approved', approved_at = now(), updated_at = now()
     WHERE user_id = $1 AND id = $2
     RETURNING *`,
    [userId, recommendationId],
  );
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
  const updated = await one(
    `UPDATE oms_recommendations
     SET approval_state = 'rejected', status = 'rejected', rejected_at = now(), rejection_reason = $3, updated_at = now()
     WHERE user_id = $1 AND id = $2
     RETURNING *`,
    [userId, recommendationId, String(body?.reason || 'Rejected by user')],
  );
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
    'product-research': ['Research a single product', 'What CSV should I upload next?', 'Which product fields are missing most often?'],
    marketplace: ['Which apps should be installed?', 'What is gated until activation?', 'Which connection unlocks the most value?'],
    connections: ['Which connection should I add next?', 'Is Cortex available for this account?', 'Which services are system managed?'],
    double: ['What changed from current to optimized?', 'Which approval has measurable impact?', 'What can be automated after approval?'],
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
  const text = `${type} ${entityType} ${rec?.title || ''} ${rec?.summary || ''}`.toLowerCase();
  if (entityType === 'sku' || text.includes('sku') || text.includes('listing')) return { screen: 'skus', actionLabel: 'Review SKU decision' };
  if (entityType === 'supplier' || text.includes('supplier')) return { screen: 'suppliers', actionLabel: 'Review supplier action' };
  if (entityType === 'order' || text.includes('fulfillment')) return { screen: 'orders', actionLabel: 'Review order action' };
  if (entityType === 'shipment_plan' || text.includes('shipment') || text.includes('inbound')) return { screen: 'shipments', actionLabel: 'Review shipment plan' };
  if (entityType === 'carrier_audit' || type === 'carrier_audit' || text.includes('label') || text.includes('refund')) return { screen: 'labels', actionLabel: 'Review label audit' };
  if (entityType === 'billing' || type === 'billing_profit' || text.includes('billing') || text.includes('margin')) return { screen: 'billing', actionLabel: 'Review billing impact' };
  if (entityType === 'business_double' || type === 'business_double' || text.includes('business double')) return { screen: 'double', actionLabel: 'Open Business Double' };
  return { screen: 'command', actionLabel: 'Review in Command Center' };
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
       updated_at = now()
     WHERE oms_cortex_tasks.status = 'open'
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
  const [readiness, recs] = await Promise.all([
    getDataReadiness(userId),
    getRecommendations(userId, { status: 'open', limit: 100 }),
  ]);
  const activeKeys = new Set<string>();

  for (const blocker of (readiness.blockers || []).filter(Boolean) as string[]) {
    const target = taskTargetFromText(blocker);
    const dedupeKey = `readiness:${taskDedupeSlug(blocker)}`;
    activeKeys.add(dedupeKey);
    await upsertCortexTask(userId, {
      dedupeKey,
      source: 'readiness',
      screen: target.screen,
      entityType: target.entityType,
      title: blocker,
      detail: `Resolve this readiness blocker to improve Cortex confidence from ${readiness.score}%.`,
      priority: priorityForTask(blocker, readiness.score),
      actionLabel: target.actionLabel,
      actionTarget: target.screen,
      evidence: { readinessScore: readiness.score, posture: readiness.posture, counts: readiness.counts },
    });
  }

  for (const rec of (recs.recommendations || []).filter(Boolean) as any[]) {
    const dedupeKey = `recommendation:${rec.id}`;
    activeKeys.add(dedupeKey);
    const target = recommendationTaskTarget(rec);
    await upsertCortexTask(userId, {
      dedupeKey,
      source: 'recommendation',
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

  await pgQuery(
    `UPDATE oms_cortex_tasks
     SET status = 'done', completed_at = COALESCE(completed_at, now()), auto_completed_at = COALESCE(auto_completed_at, now()), updated_at = now()
     WHERE user_id = $1 AND status = 'open' AND dedupe_key LIKE ANY($2::text[]) AND NOT (dedupe_key = ANY($3::text[]))`,
    [userId, ['readiness:%', 'recommendation:%'], Array.from(activeKeys)],
  ).catch(() => null);

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
  values.push(Math.min(200, Math.max(1, number(query.limit, 100))));
  const tasks = await rows(
    `SELECT * FROM oms_cortex_tasks WHERE ${filters.join(' AND ')}
     ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC
     LIMIT $${values.length}`,
    values,
  );
  return { tasks: tasks.map(mapCortexTask) };
}

export async function completeCortexTask(userId: string, taskId: string) {
  await ensureCortexWorkspaceTables();
  const row = await one(
    `UPDATE oms_cortex_tasks
     SET status = 'done', completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, taskId],
  );
  return row ? mapCortexTask(row) : null;
}

export async function dismissCortexTask(userId: string, taskId: string) {
  await ensureCortexWorkspaceTables();
  const row = await one(
    `UPDATE oms_cortex_tasks
     SET status = 'dismissed', dismissed_at = COALESCE(dismissed_at, now()), updated_at = now()
     WHERE user_id = $1 AND id = $2 RETURNING *`,
    [userId, taskId],
  );
  return row ? mapCortexTask(row) : null;
}

async function getAccountOmsContextBundle(userId: string, screen: string, options: { refreshTasks?: boolean } = {}) {
  const [readiness, recommendations, tasksRes, ledger, skus, orders, warehouses, suppliers, labelRuns] = await Promise.all([
    getDataReadiness(userId),
    getRecommendations(userId, { screen, status: 'open', limit: 10 }),
    getCortexTasks(userId, { status: 'open', limit: 20, refresh: options.refreshTasks }),
    rows(`SELECT entity_type, entity_id, event_type, source_system, summary, confidence, created_at FROM oms_execution_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]).catch(() => []),
    rows(`SELECT id, sku, title, weight, dimensions, attributes, metadata, wms_inventory FROM catalog_items WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 25`, [userId]).catch(() => []),
    rows(`SELECT id, order_number, channel, status, total, shipping_address, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`, [userId]).catch(() => []),
    rows(`SELECT warehouse_code, status, facility_id, metadata, connected_at FROM oms_warehouse_links WHERE user_id = $1 ORDER BY connected_at DESC NULLS LAST LIMIT 25`, [userId]).catch(() => []),
    rows(`SELECT id, name, status, email, metadata, updated_at FROM suppliers WHERE user_id = $1 ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 25`, [userId]).catch(() => []),
    rows(`SELECT id, filename, status, row_count, findings_count, estimated_refunds, optimized_service_savings, created_at FROM oms_label_audit_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]).catch(() => []),
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
      skus: skus.map((r) => ({ id: r.id, sku: r.sku, title: r.title, weight: r.weight, dimensions: json(r.dimensions, {}), source: r.metadata?.source || r.metadata?.importSource || null })),
      orders: orders.map((r) => ({ id: r.id, orderNumber: r.order_number, channel: r.channel, status: r.status, total: money(r.total), state: r.shipping_address?.state || r.shipping_address?.province || null })),
      warehouses,
      suppliers,
      labelAuditRuns: labelRuns,
    },
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
    .replace(/\bdrivers?\b/gi, 'runtime');
}

function readablePosture(value: any) {
  const posture = String(value || '').replace(/_/g, ' ').toLowerCase();
  if (posture === 'ready') return 'ready';
  if (posture === 'limited') return 'partially ready';
  if (posture === 'needs data') return 'needs more data';
  return posture || 'not fully scored';
}

function buildLocalCortexChatFallback(message: string, context: any): {
  answer: string;
  sources: any[];
  tasks: any[];
  confidence: number;
  readinessNotes: string | null;
} {
  const q = String(message || '').toLowerCase();
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
  const actionIntent = q.includes('what can i do') || q.includes('get the account going') || q.includes('start') || q.includes('next') || q.includes('blocking') || q.includes('confidence') || q.includes('missing');

  if (q.includes('what can i do') || q.includes('get the account going') || q.includes('start') || q.includes('next')) {
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
    answer: scrubVendorLanguage(lines.join('\n\n')),
    sources: [
      { source: 'oms_data_readiness', readinessScore: readiness.score, posture: readiness.posture },
      { source: 'oms_cortex_tasks', count: tasks.length },
      { source: 'oms_recommendations', count: recommendations.length },
      { source: 'oms_context_samples', skus: skuCount, orders: orderCount, warehouses: warehouseCount, suppliers: supplierCount, labelAuditRuns: labelRunCount },
    ],
    tasks: actionIntent ? sortedTasks.slice(0, 3).map((task: any) => ({ id: task.id, title: task.title, priority: task.priority, screen: task.screen, actionTarget: task.actionTarget, actionLabel: task.actionLabel })) : [],
    confidence: readiness.score != null ? Math.max(0.4, Math.min(0.88, Number(readiness.score) / 100)) : 0.45,
    readinessNotes: null,
  };
}

function normalizeCortexChatResponse(cortex: any, fallback: ReturnType<typeof buildLocalCortexChatFallback>) {
  const data = cortex?.data || {};
  if (!cortex?.ok) return fallback;
  const answer = data.answer || data.text || data.message || data.response?.answer || data.result?.answer || data.result?.text || fallback.answer;
  const sources = data.sources || data.citations || data.response?.sources || data.result?.sources || [];
  const tasks = data.suggested_actions || data.suggestedActions || data.tasks || data.response?.tasks || [];
  const confidence = closedLoopNumber(data.confidence, data.response?.confidence, data.result?.confidence);
  const readinessNotes = data.readiness_notes || data.readinessNotes || data.blocked_reason || data.missing_data || null;
  return {
    answer: scrubVendorLanguage(String(answer || fallback.answer)),
    sources: Array.isArray(sources) && sources.length ? sources : fallback.sources,
    tasks: Array.isArray(tasks) && tasks.length ? tasks : fallback.tasks,
    confidence: confidence ?? fallback.confidence,
    readinessNotes: readinessNotes ? scrubVendorLanguage(String(readinessNotes)) : readinessNotes,
  };
}

export async function createCortexChatMessage(userId: string, body: any = {}) {
  await ensureCortexWorkspaceTables();
  const screen = String(body.screen || 'command').slice(0, 80);
  const message = String(body.message || '').trim();
  if (!message) throw new Error('Message is required');
  const entityType = body.entityType ? String(body.entityType).slice(0, 80) : null;
  const entityId = body.entityId ? String(body.entityId).slice(0, 160) : null;
  let thread = body.threadId
    ? await one('SELECT * FROM oms_cortex_chat_threads WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, String(body.threadId)]).catch(() => null)
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

  const context = await getAccountOmsContextBundle(userId, screen, { refreshTasks: true });
  const fallback = context.readiness?.cortex?.configured === false
    ? {
        answer: 'Cortex is not available for this account. Contact support or your account manager to enable Cortex intelligence.',
        sources: [{ source: 'cortex_configuration', configured: false }],
        tasks: [],
        confidence: 0.35,
        readinessNotes: 'Cortex is not configured for this account.',
      }
    : buildLocalCortexChatFallback(message, context);
  const cortex = await postCortex('/v1/orchestration/oms/chat', {
    tenant_id: userId,
    userId,
    screen,
    entity_type: entityType,
    entity_id: entityId,
    thread_id: thread?.id,
    message,
    context,
    response_contract: {
      answer: 'string',
      sources: 'array of cited OMS source objects when possible',
      suggested_actions: 'array of proposed user actions or tasks',
      confidence: 'number 0-1',
      readiness_notes: 'blocked or missing data notes',
    },
  }, { userId, idempotencyKey: `oms-cortex-chat-${thread?.id}-${Date.now()}` }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));
  const normalized = normalizeCortexChatResponse(cortex, fallback);
  const accountScopedChatAvailable = context.readiness?.cortex?.configured !== false;
  const cortexHealth = {
    available: accountScopedChatAvailable,
    chatIntegrated: accountScopedChatAvailable,
    status: accountScopedChatAvailable ? 200 : 503,
    reason: accountScopedChatAvailable
      ? 'account_scoped_oms_chat_available'
      : 'cortex_not_configured',
    liveRouteAvailable: Boolean(cortex?.ok),
    liveRouteStatus: cortex?.status || 503,
    liveRouteReason: cortex?.ok
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
      cortexHealth.chatIntegrated ? 'ok' : 'degraded',
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
    [userId, screen, message, JSON.stringify({ threadId: thread?.id, answer: normalized.answer, cortexStatus: cortexHealth.chatIntegrated ? 'ok' : 'degraded', cortexHealth })],
  ).catch(() => null);
  return {
    thread: mapCortexThread(thread),
    message: mapCortexMessage(saved),
    context: { screen, readiness: context.readiness, tasks: context.tasks.slice(0, 8), recommendations: context.recommendations.slice(0, 5) },
    cortex: { ok: cortexHealth.chatIntegrated, status: cortexHealth.status, health: cortexHealth },
  };
}

export async function getCortexChatHealth(userId: string, screen = 'command') {
  const context = await getAccountOmsContextBundle(userId, String(screen || 'command').slice(0, 80)).catch(() => null);
  if (!context) {
    return {
      ok: false,
      status: 503,
      health: {
        available: false,
        chatIntegrated: false,
        status: 503,
        reason: 'account_context_unavailable',
      },
    };
  }
  if (context?.readiness?.cortex?.configured === false) {
    return {
      ok: false,
      status: 503,
      health: {
        available: false,
        chatIntegrated: false,
        status: 503,
        reason: 'cortex_not_configured',
      },
    };
  }
  const health = {
    available: true,
    chatIntegrated: true,
    status: 200,
    reason: 'account_scoped_oms_chat_available',
  };
  return { ok: health.chatIntegrated, status: health.status, health };
}

export async function getCortexChatThreads(userId: string, query: any = {}) {
  await ensureCortexWorkspaceTables();
  const filters = ['user_id = $1'];
  const values: any[] = [userId];
  if (query.screen) {
    values.push(String(query.screen));
    filters.push(`screen = $${values.length}`);
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
    title: row.title,
    summary: row.summary,
    currentValue: json(row.current_value, {}),
    optimizedValue: json(row.optimized_value, {}),
    estimatedImpact: json(row.estimated_impact, {}),
    requiredAction: row.required_action,
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
    title: row.title,
    detail: row.detail,
    priority: row.priority,
    status: row.status,
    actionLabel: row.action_label,
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

  // Match a UnieConnect-side run row by cortex_run_id (set on enqueue), else
  // pick the latest pending row for this tenant.
  let run: Row | null = await one(
    `SELECT * FROM oms_intelligence_runs WHERE user_id = $1 AND cortex_run_id = $2 LIMIT 1`,
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
        cortexResponse: { schema_version: (result as any)?.schema_version, engagement_id: engagementId },
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
        savings: { perUnit: perUnitSavings, monthly: monthlySavings, annualized: monthlySavings * 12, pct: savingsPct },
        recommendationVerdict: fbm?.recommendation || null,
      }),
      JSON.stringify({
        scenario_integrated_fbm_snapshot: {
          recommendation: fbm?.recommendation,
          savings_pct: savingsPct,
          demand,
        },
      }),
      JSON.stringify({ source: 'cortex_webhook', cortexRunId, engagementId, schema_version: (result as any)?.schema_version }),
      Math.min(0.98, Math.max(0.5, confidence)),
    ],
  );

  await supersedeOpenRecommendations(userId, SELLER_OPTIMIZATION_RECOMMENDATION_TYPES);
  let created = 0;

  if (haveBusinessDouble) {
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
      sourceSummary: { from_cortex: true, cortexRunId, verdict: execSummary?.verdict || null },
    });
    created += 1;
  }

  for (const item of aiItems.slice(0, 8)) {
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
      approvalState: 'waiting_approval',
      wmsTruthState: 'forecast_only',
      confidence,
      sourceSummary: {
        from_cortex: true,
        cortexRunId,
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
