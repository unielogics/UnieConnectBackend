import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { publicEntityId } from '../lib/public-id';
import { cortexConfigStatus, postCortex } from './cortex-orchestration';
import { getBusinessDouble, getInventoryPlan, writeOmsLedgerEvent } from './oms-production.service';

import { createHmac, timingSafeEqual } from "crypto";
type Row = Record<string, any>;

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
  'carrier_audit',
  'data_readiness',
];

async function rows<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

async function one<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T | null> {
  const data = await rows<T>(sql, values);
  return data[0] || null;
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
  const [counts] = await rows(
    `SELECT
       (SELECT COUNT(*) FROM marketplace_connections WHERE user_id = $1 AND status IN ('connected','active','synced'))::int AS marketplace_connections,
       (SELECT COUNT(*) FROM marketplace_connections WHERE user_id = $1 AND channel = 'amazon' AND status IN ('connected','active','synced'))::int AS amazon_connections,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1)::int AS catalog_items,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1 AND LOWER(COALESCE(metadata->>'source', metadata->>'importSource', '')) LIKE '%csv%')::int AS csv_items,
       (SELECT COUNT(*) FROM item_channel_mappings WHERE user_id = $1)::int AS marketplace_mapped_items,
       (SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1)::int AS amazon_profiles,
       (SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1 AND asin IS NOT NULL AND asin <> '')::int AS amazon_listed_items,
       (SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1 AND listing_status IN ('listed','active') AND fulfillment_channel IN ('AMAZON','FBA') AND cardinality(blockers) = 0)::int AS amazon_fba_eligible_items,
       (SELECT COUNT(*) FROM amazon_item_profiles WHERE user_id = $1 AND (listing_status = 'needs_listing' OR cardinality(blockers) > 0))::int AS amazon_blocked_items,
       (SELECT COUNT(*) FROM orders WHERE user_id = $1)::int AS orders,
       (SELECT COUNT(*) FROM orders WHERE user_id = $1 AND channel_connection_id IS NOT NULL)::int AS marketplace_orders,
       (SELECT COUNT(*) FROM orders WHERE user_id = $1 AND LOWER(COALESCE(metadata->>'source', '')) LIKE '%csv%')::int AS csv_orders,
       (SELECT COUNT(*) FROM facilities WHERE user_id = $1 OR user_id IS NULL)::int AS facilities,
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
  const cortex = await postCortex('/v1/assessment/product-research/runs', {
    userId,
    tenant_id: userId,
    source_priority: readiness.sourcePriority,
    readiness,
    item: item || normalizedInput,
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));

  const { result, confidence } = productResearchResult(normalizedInput, item, readiness, cortex);
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
    recommendationType: 'product_research',
    entityType: 'sku',
    entityId: item?.id || input?.itemId || result.sku,
    title: `${result.sku}: ${result.productRisk === 'strong_candidate' ? 'strong optimization candidate' : 'product intelligence ready'}`,
    summary: result.recommendedAction,
    currentValue: { dataCompleteness: 100 - result.missingData.length * 20, marketplaceReadiness: result.marketplaceReadiness },
    optimizedValue: { opportunityScore: result.opportunityScore, warehouseFit: result.fulfillment.warehouseFit },
    estimatedImpact: { confidence, palletUnits: result.fulfillment.estimatedUnitsPerPallet },
    requiredAction: result.missingData.length ? 'complete_missing_product_data' : 'feed_optimize_suite',
    approvalState: 'not_required',
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
  const cortex = await postCortex('/v1/assessment/product-research/bulk', {
    userId,
    tenant_id: userId,
    source_priority: readiness.sourcePriority,
    readiness,
    rows: inputRows,
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));

  const results = [];
  for (const input of inputRows) {
    const item = input?.sku
      ? await one('SELECT * FROM catalog_items WHERE user_id = $1 AND sku = $2 LIMIT 1', [userId, String(input.sku)])
      : null;
    const { result, confidence } = productResearchResult({ ...input, source: 'csv_bulk_product_research' }, item, readiness, cortex);
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
    cortexStatus: cortex.ok ? 'ok' : 'degraded',
    cortexResponse: cortex.data,
    error: inputRows.length ? null : 'No rows supplied',
  });
  return { runId: run?.id, status, results, rowCount: inputRows.length, cortex: { ok: cortex.ok, status: cortex.status } };
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

  if (currentMonthlyCost > 0 || optimizedMonthlyCost > 0 || monthlySavings > 0) {
    recommendations.push(await createRecommendation(userId, {
      runId: scopedRunId,
      recommendationType: 'billing_profit',
      entityType: 'billing',
      entityId: stored?.id || userId,
      title: 'Track optimized cost basis against current spend',
      summary: monthlySavings > 0
        ? `Optimize Suite modeled ${Math.round(monthlySavings).toLocaleString()} dollars in monthly cost improvement.`
        : 'Cost basis is available, but more marketplace/WMS data is needed to prove savings.',
      currentValue: { monthlyCost: currentMonthlyCost },
      optimizedValue: { monthlyCost: optimizedMonthlyCost },
      estimatedImpact: { monthlySavings, annualizedSavings: monthlySavings * 12 },
      requiredAction: monthlySavings > 0 ? 'review_cost_savings' : 'improve_cost_inputs',
      approvalState: 'not_required',
      wmsTruthState,
      confidence,
      sourceSummary,
    }));
  }

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

export async function createSellerOptimizationRun(userId: string, input: any = {}) {
  const readiness = await getDataReadiness(userId);
  const [business, inventory] = await Promise.all([getBusinessDouble(userId), getInventoryPlan(userId, input?.horizon || '6m')]);
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
      JSON.stringify(readiness),
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
      summary: `Projected monthly savings of $${Math.round(monthlySavings).toLocaleString()} from placement, fulfillment, and consolidation improvements.`,
      currentValue: { monthlyCost: currentMonthlyCost, warehouseCount: business.plan?.currentMetrics?.warehouseNodes },
      optimizedValue: { monthlyCost: optimizedMonthlyCost, warehouseCount: business.plan?.optimizedMetrics?.warehouseNodes },
      estimatedImpact: { monthlySavings, annualizedSavings: monthlySavings * 12 },
      requiredAction: 'approve_business_double',
      approvalState: 'waiting_approval',
      wmsTruthState: readiness.counts.wmsLinks > 0 ? 'wms_confirmed' : 'forecast_only',
      confidence: stored?.confidence,
      sourceSummary: readiness,
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
  return { recommendations: data.map(mapRecommendation).filter(Boolean) };
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
  const item = await one('SELECT id, sku FROM catalog_items WHERE user_id = $1 AND (id = $2 OR sku = $2) LIMIT 1', [userId, skuId]);
  const sku = item?.sku || skuId;
  const result = await one(
    `SELECT * FROM oms_product_research_results
     WHERE user_id = $1 AND (sku = $2 OR item_id = $3)
     ORDER BY created_at DESC LIMIT 1`,
    [userId, sku, item?.id || skuId],
  );
  return result ? mapProductResult(result) : null;
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
  return {
    screen,
    posture: readiness.posture,
    readiness,
    summary: top
      ? `${top.title}: ${top.summary}`
      : latest.latest
        ? `Latest Seller Optimization is available with ${readiness.primarySource.replace(/_/g, ' ')} as the primary source.`
        : 'Run Seller Optimization to generate current-vs-optimized intelligence for this screen.',
    latestOptimization: latest.latest,
    recommendations: recommendations.recommendations,
    recommendedPrompts: [
      'What is the biggest current vs optimized opportunity?',
      'Which data is blocking higher confidence?',
      'What action can be safely automated?',
    ],
  };
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
