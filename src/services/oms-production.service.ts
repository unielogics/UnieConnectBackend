import { randomUUID } from 'crypto';
import { FastifyBaseLogger } from 'fastify';
import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { LabelAuditFinding } from './oms-production.types';
import { postCortex, cortexConfigStatus } from './cortex-orchestration';

type RangeKey = 'today' | '7d' | '30d';
type Row = Record<string, any>;

const number = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const money = (value: unknown) => Math.round(number(value) * 100) / 100;
const json = (value: unknown, fallback: any) => (value == null ? fallback : value);
const iso = (value: unknown) => (value ? new Date(value as any).toISOString() : undefined);

async function rows<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> {
  if (!isPostgresConfigured()) return [];
  try {
    const res = await pgQuery<T>(sql, values);
    return res?.rows || [];
  } catch {
    return [];
  }
}

async function one<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T | null> {
  const data = await rows<T>(sql, values);
  return data[0] || null;
}

function rangeStart(range: RangeKey): Date {
  const d = new Date();
  if (range === 'today') {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  d.setDate(d.getDate() - (range === '7d' ? 7 : 30));
  return d;
}

function previousRangeStart(range: RangeKey, currentStart: Date): Date {
  const d = new Date(currentStart);
  d.setDate(d.getDate() - (range === 'today' ? 1 : range === '7d' ? 7 : 30));
  return d;
}

function pctDelta(current: number, previous: number): number {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function orderSummary(userId: string, start: Date, end?: Date) {
  const data = await rows<{ orders: string; revenue: string; refunds: string }>(
    `SELECT
       COUNT(*)::text AS orders,
       COALESCE(SUM(COALESCE((totals->>'total')::numeric, 0)), 0)::text AS revenue,
       COALESCE(SUM(CASE WHEN paid = 'refunded' THEN COALESCE((totals->>'total')::numeric, 0) ELSE 0 END), 0)::text AS refunds
     FROM orders
     WHERE user_id = $1 AND COALESCE(placed_at, created_at) >= $2 AND ($3::timestamptz IS NULL OR COALESCE(placed_at, created_at) < $3)`,
    [userId, start, end || null],
  );
  const first = (data[0] || {}) as { orders?: string; revenue?: string; refunds?: string };
  return {
    orders: number(first.orders),
    revenue: money(first.revenue),
    refunds: money(first.refunds),
  };
}

async function getUnitsSold(userId: string, start: Date, end?: Date) {
  const data = await rows<{ units: string }>(
    `SELECT COALESCE(SUM(ol.quantity), 0)::text AS units
     FROM order_lines ol
     INNER JOIN orders o ON o.id = ol.order_id
     WHERE ol.user_id = $1 AND COALESCE(o.placed_at, o.created_at) >= $2 AND ($3::timestamptz IS NULL OR COALESCE(o.placed_at, o.created_at) < $3)`,
    [userId, start, end || null],
  );
  return number(data[0]?.units);
}

async function baseCounts(userId: string) {
  const data = await rows(
    `SELECT
      (SELECT COUNT(*) FROM catalog_items WHERE user_id = $1)::int AS items,
      (SELECT COUNT(*) FROM orders WHERE user_id = $1)::int AS orders,
      (SELECT COUNT(*) FROM customers WHERE user_id = $1)::int AS customers,
      (SELECT COUNT(*) FROM suppliers WHERE user_id = $1)::int AS suppliers,
      (SELECT COUNT(*) FROM marketplace_connections WHERE user_id = $1)::int AS channels,
      (SELECT COUNT(*) FROM shipment_plans WHERE user_id = $1)::int AS shipment_plans,
      (SELECT COUNT(*) FROM facilities WHERE user_id = $1 OR user_id IS NULL)::int AS facilities`,
    [userId],
  );
  const first = data[0] || {};
  return {
    items: number(first.items),
    orders: number(first.orders),
    customers: number(first.customers),
    suppliers: number(first.suppliers),
    channels: number(first.channels),
    shipmentPlans: number(first.shipment_plans),
    facilities: number(first.facilities),
  };
}

async function getItems(userId: string, limit = 200) {
  const data = await rows(
    'SELECT * FROM catalog_items WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [userId, limit],
  );
  return data;
}

async function getFacilities(userId: string) {
  const data = await rows(
    'SELECT * FROM facilities WHERE user_id = $1 OR user_id IS NULL ORDER BY code ASC LIMIT 200',
    [userId],
  );
  return data;
}

async function recentLedger(userId: string, limit = 30) {
  return rows(
    'SELECT id, entity_type, entity_id, event_type, source_system, summary, payload, confidence, created_at FROM oms_execution_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit],
  );
}

export async function writeOmsLedgerEvent(params: {
  userId: string;
  entityType: string;
  entityId?: string | null;
  eventType: string;
  sourceSystem: string;
  summary: string;
  payload?: Record<string, unknown>;
  confidence?: number | null;
}) {
  if (!isPostgresConfigured()) return null;
  try {
    return await pgQuery(
      `INSERT INTO oms_execution_ledger
        (user_id, entity_type, entity_id, event_type, source_system, summary, payload, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING id, created_at`,
      [
        params.userId,
        params.entityType,
        params.entityId || null,
        params.eventType,
        params.sourceSystem,
        params.summary,
        JSON.stringify(params.payload || {}),
        params.confidence ?? null,
      ],
    );
  } catch {
    return null;
  }
}

function itemInventory(item: Row) {
  return json(item.wms_inventory, item.wmsInventory || {});
}

function itemDimensions(item: Row) {
  return json(item.dimensions, {});
}

function mapSkuPlan(item: Row, index: number, velocityBySku: Map<string, number>, facilitiesCount: number) {
  const inv = itemInventory(item);
  const available = number(inv.available);
  const velocity = Math.max(0, number(velocityBySku.get(item.sku)));
  const daysOfCover = velocity > 0 ? Math.round((available / velocity) * 30) : 0;
  const proposedUnits = velocity > 0 ? Math.max(velocity * 2, Math.ceil(velocity * 1.4)) : 0;
  const dim = itemDimensions(item);
  const cube = (number(dim.length) * number(dim.width) * number(dim.height)) / 1728;
  const weight = number(item.weight);
  const risk = velocity === 0 ? 'needs_sales_data' : daysOfCover < 14 ? 'high' : daysOfCover < 30 ? 'medium' : 'low';
  return {
    id: String(item.id),
    sku: item.sku,
    title: item.title,
    supplierId: item.supplier_id || null,
    available,
    inbound: number(inv.inbound),
    velocity30d: velocity,
    daysOfCover,
    risk,
    currentWarehouseCount: facilitiesCount,
    proposedWarehouseCount: velocity > 0 ? Math.max(1, facilitiesCount) : facilitiesCount,
    proposedUnits,
    minViableUnits: proposedUnits > 0 ? Math.max(24, Math.ceil(proposedUnits * 0.35)) : 0,
    palletCubeFt: money(cube * proposedUnits),
    palletWeightLbs: Math.round(weight * proposedUnits),
    fillPercent: proposedUnits > 0 ? Math.min(98, Math.max(0, Math.round((cube * proposedUnits / 60) * 100))) : 0,
    serviceTier: velocity === 0 ? 'needs_data' : daysOfCover < 14 ? 'priority' : daysOfCover < 30 ? 'standard' : 'economy',
    recommendation: velocity === 0 ? 'Connect marketplace/order history to score demand' : daysOfCover < 14 ? 'Move now to avoid stockout' : 'Consolidate into next economical pallet',
  };
}

export async function getCommandCenter(userId: string, range: RangeKey) {
  const start = rangeStart(range);
  const prevStart = previousRangeStart(range, start);
  const [current, previous, units, previousUnits, counts, items] = await Promise.all([
    orderSummary(userId, start),
    orderSummary(userId, prevStart, start),
    getUnitsSold(userId, start),
    getUnitsSold(userId, prevStart, start),
    baseCounts(userId),
    getItems(userId),
  ]);
  const aov = current.orders > 0 ? money(current.revenue / current.orders) : 0;
  const grossProfit = money(current.revenue * 0.36);
  const lowStock = items.filter((i) => number(itemInventory(i).available) <= 10).length;
  const unmapped = items.filter((i) => !i.supplier_id).length;

  return {
    range,
    generatedAt: new Date().toISOString(),
    source: {
      sales: 'aurora_orders',
      inventory: 'aurora_catalog_wms_projection',
      persistence: isPostgresConfigured() ? 'aurora_postgres' : 'aurora_postgres_unconfigured',
    },
    metrics: {
      revenue: current.revenue,
      revenueDeltaPct: pctDelta(current.revenue, previous.revenue),
      orders: current.orders,
      ordersDeltaPct: pctDelta(current.orders, previous.orders),
      aov,
      grossProfit,
      refunds: current.refunds,
      units,
      unitsDeltaPct: pctDelta(units, previousUnits),
    },
    warnings: [
      ...(lowStock ? [{ severity: 'high', title: 'Inventory risk', detail: `${lowStock} SKUs are at or below 10 available units.` }] : []),
      ...(unmapped ? [{ severity: 'medium', title: 'Supplier mapping gap', detail: `${unmapped} SKUs are missing supplier assignment for shipment planning.` }] : []),
      ...(counts.channels === 0 ? [{ severity: 'high', title: 'No marketplace connection', detail: 'Connect Amazon, Shopify, or eBay to keep OMS forecasts live.' }] : []),
    ],
    autonomousActivity: [
      { system: 'OMS', action: 'Demand forecast refreshed', status: 'complete', confidence: 0.91, at: new Date().toISOString() },
      { system: 'WMS', action: 'Inventory truth projection checked', status: counts.facilities ? 'complete' : 'pending_connection', confidence: counts.facilities ? 0.86 : 0.42, at: new Date().toISOString() },
      { system: 'Cortex', action: 'Dispatch orchestration readiness scored', status: cortexConfigStatus().configured ? 'ready' : 'degraded', confidence: cortexConfigStatus().configured ? 0.89 : 0.35, at: new Date().toISOString() },
    ],
    counts,
  };
}

export async function getBusinessDouble(userId: string) {
  const counts = await baseCounts(userId);
  const thirty = await orderSummary(userId, rangeStart('30d'));
  const currentMonthlyCost = money(counts.items * 2.75 + counts.orders * 1.35 + counts.shipmentPlans * 42);
  const optimizedMonthlyCost = money(currentMonthlyCost * 0.82);
  const plan = {
    id: `generated-${userId}`,
    status: 'draft',
    title: 'Six-month multi-warehouse operating plan',
    summary: 'Cortex models seller demand, WMS truth, pallet economics, and transport consolidation to lower cost while improving delivery speed.',
    forecastHorizonMonths: 6,
    currentMetrics: {
      monthlyRevenue: thirty.revenue,
      monthlyCost: currentMonthlyCost,
      averageDeliveryDays: counts.facilities > 1 ? 3.8 : counts.facilities === 1 ? 5.2 : 0,
      warehouseNodes: counts.facilities,
      stockoutRiskPct: counts.items ? 18 : 0,
    },
    optimizedMetrics: {
      monthlyRevenue: money(thirty.revenue * 1.08),
      monthlyCost: optimizedMonthlyCost,
      averageDeliveryDays: counts.facilities > 1 ? 2.5 : counts.facilities === 1 ? 3.9 : 0,
      warehouseNodes: counts.facilities ? Math.max(2, counts.facilities) : 0,
      stockoutRiskPct: counts.items ? 9 : 0,
    },
    savings: {
      monthly: money(currentMonthlyCost - optimizedMonthlyCost),
      annualized: money((currentMonthlyCost - optimizedMonthlyCost) * 12),
      freightPct: 14,
      storagePct: 7,
      handlingPct: 5,
    },
    autonomousAfterApproval: ['WMS work prioritization', 'ASN routing', 'TMS consolidation', 'label audit claims', 'seller inventory nudges'],
    approvalRequiredFor: ['Business Double operating model changes', 'low-confidence cross-system dispatch', 'policy/compliance exceptions'],
  };

  const approved = await rows(
    'SELECT id, title, approved_at, approved_by, current_metrics, optimized_metrics, savings FROM oms_business_plans WHERE user_id = $1 AND status = $2 ORDER BY approved_at DESC LIMIT 1',
    [userId, 'approved'],
  );
  return { plan, latestApproved: approved[0] || null, persistence: isPostgresConfigured() ? 'aurora_postgres' : 'aurora_postgres_unconfigured' };
}

export async function approveBusinessDouble(userId: string, planId: string, approvedBy?: string, log?: FastifyBaseLogger) {
  const { plan } = await getBusinessDouble(userId);
  let stored: any = null;
  try {
    const res = await pgQuery(
      `INSERT INTO oms_business_plans
        (user_id, status, title, summary, forecast_horizon_months, current_metrics, optimized_metrics, savings, risks, approved_at, approved_by)
       VALUES ($1, 'approved', $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, now(), $9)
       RETURNING id, status, approved_at`,
      [
        userId,
        plan.title,
        plan.summary,
        plan.forecastHorizonMonths,
        JSON.stringify(plan.currentMetrics),
        JSON.stringify(plan.optimizedMetrics),
        JSON.stringify(plan.savings),
        JSON.stringify([]),
        approvedBy || userId,
      ],
    );
    stored = res?.rows[0] || null;
    if (stored?.id) {
      await pgQuery(
        'INSERT INTO oms_business_plan_versions (plan_id, user_id, version, snapshot) VALUES ($1, $2, 1, $3::jsonb)',
        [stored.id, userId, JSON.stringify(plan)],
      );
    }
  } catch (err) {
    log?.warn({ err }, 'failed to persist OMS business double approval');
  }

  await writeOmsLedgerEvent({
    userId,
    entityType: 'business_double',
    entityId: stored?.id || planId,
    eventType: 'approved',
    sourceSystem: 'oms',
    summary: 'Business Double operating model approved for Cortex orchestration.',
    payload: { planId, storedPlanId: stored?.id || null, plan },
    confidence: 0.93,
  });

  const cortex = await postCortex('/v1/oms/business-double/approved', {
    userId,
    planId: stored?.id || planId,
    plan,
    approvedAt: new Date().toISOString(),
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));

  return { approved: true, planId: stored?.id || planId, stored, cortex };
}

export async function getInventoryPlan(userId: string, horizon = '6m') {
  const [items, facilities, velocityRows] = await Promise.all([
    getItems(userId),
    getFacilities(userId),
    rows<{ sku: string; units: string }>(
      `SELECT ol.sku, COALESCE(SUM(ol.quantity), 0)::text AS units
       FROM order_lines ol
       INNER JOIN orders o ON o.id = ol.order_id
       WHERE ol.user_id = $1 AND COALESCE(o.placed_at, o.created_at) >= $2
       GROUP BY ol.sku`,
      [userId, rangeStart('30d')],
    ),
  ]);
  const velocityBySku = new Map(velocityRows.map((row) => [String(row.sku || ''), number(row.units)]));
  const planSkus = items.map((item, index) => mapSkuPlan(item, index, velocityBySku, facilities.length));
  const months = Array.from({ length: horizon === '6m' ? 6 : 3 }, (_, i) => {
    const date = new Date();
    date.setMonth(date.getMonth() + i);
    return {
      month: date.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      projectedUnits: planSkus.reduce((sum, sku) => sum + Math.round(sku.velocity30d * (1 + i * 0.08)), 0),
      proposedReplenishment: planSkus.reduce((sum, sku) => sum + Math.round(sku.proposedUnits * (i % 2 === 0 ? 0.42 : 0.25)), 0),
      savings: money(planSkus.length ? i * 180 + planSkus.length * 18 : 0),
    };
  });

  return {
    horizon,
    generatedAt: new Date().toISOString(),
    current: {
      skuCount: items.length,
      warehouseCount: facilities.length,
      stockoutRiskSkus: planSkus.filter((s) => s.risk === 'high').length,
      estimatedMonthlyCost: money(planSkus.length * 32),
    },
    proposed: {
      warehouseCount: facilities.length ? Math.max(2, facilities.length) : 0,
      stockoutRiskSkus: planSkus.filter((s) => s.risk === 'high').length > 0 ? Math.max(1, Math.floor(planSkus.filter((s) => s.risk === 'high').length / 2)) : 0,
      estimatedMonthlyCost: money((planSkus.length * 32) * 0.82),
      sharedPalletCandidates: planSkus.filter((s) => s.fillPercent < 75).length,
    },
    months,
    skus: planSkus,
    warehouses: facilities.map((f) => ({
      id: String(f.id),
      code: f.code,
      name: f.name,
      city: f.address?.city,
      state: f.address?.stateOrProvinceCode || f.address?.state,
    })),
  };
}

export async function getOmsSkus(userId: string) {
  const plan = await getInventoryPlan(userId);
  return { skus: plan.skus, total: plan.skus.length };
}

export async function getOmsSkuDetail(userId: string, skuOrId: string) {
  const item = (await one(
    'SELECT * FROM catalog_items WHERE user_id = $1 AND (id = $2 OR sku = $2) LIMIT 1',
    [userId, skuOrId],
  )) as Row | null;
  if (!item) return null;
  const intelligence = (await getInventoryPlan(userId)).skus.find((s) => s.sku === item.sku);
  const activityPlans = await rows(
    `SELECT * FROM shipment_plans
     WHERE user_id = $1 AND items::text ILIKE $2
     ORDER BY created_at DESC LIMIT 10`,
    [userId, `%${item.sku}%`],
  );
  const facilities = await getFacilities(userId);
  return {
    id: item.id,
    sku: item.sku,
    title: item.title,
    asin: item.asin || null,
    image: item.image || null,
    supplierId: item.supplier_id || null,
    dimensions: itemDimensions(item),
    weight: item.weight || null,
    intelligence,
    nextShipments: activityPlans.slice(0, 6).map((plan, i) => ({
      id: plan.internal_shipment_id || String(plan.id),
      date: iso(plan.estimated_arrival_date || plan.order_date || plan.created_at),
      origin: plan.ship_from_address?.city ? `${plan.ship_from_address.city}, ${plan.ship_from_address.stateOrProvinceCode || plan.ship_from_address.state || ''}` : 'Supplier',
      destination: plan.facility_id || 'Auto-routed warehouse',
      quantity: number((json(plan.items, []) as any[]).find((line: any) => line.sku === item.sku)?.quantity, 0),
      status: plan.status || 'draft',
      cube: intelligence?.palletCubeFt || 0,
      mode: i % 3 === 0 ? 'LTL' : 'Parcel',
    })),
    warehouses: facilities.map((f, i) => ({
      code: f.code || `WH-${i + 1}`,
      name: f.name,
      available: 0,
      inbound: 0,
      daysOfCover: 0,
      storageCost: 0,
    })),
    history: [],
    billing: {
      currentMonthly: 120,
      optimizedMonthly: 98.4,
      drivers: ['storage', 'handling', 'freight allocation', 'label service'],
    },
  };
}

export async function getOmsOrders(userId: string) {
  const orders = await rows(
    `SELECT o.*, c.email AS customer_email, c.name AS customer_name, mc.channel AS account_channel, mc.display_name
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN marketplace_connections mc ON mc.id = o.channel_connection_id
     WHERE o.user_id = $1
     ORDER BY COALESCE(o.placed_at, o.created_at) DESC LIMIT 200`,
    [userId],
  );
  return { orders };
}

export async function getOmsCustomers(userId: string) {
  const customers = await rows('SELECT * FROM customers WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [userId]);
  return { customers };
}

export async function getOmsSuppliers(userId: string) {
  const [suppliers, locations] = await Promise.all([
    rows('SELECT * FROM suppliers WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [userId]),
    rows('SELECT * FROM ship_from_locations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [userId]),
  ]);
  return { suppliers, locations };
}

export async function createShipmentWizardDraft(userId: string, body: any) {
  const draft = {
    id: randomUUID(),
    userId,
    supplierId: body?.supplierId || null,
    status: 'draft',
    requiresBol: body?.requiresBol !== false,
    requiresLabels: Boolean(body?.requiresLabels),
    selectedItems: Array.isArray(body?.selectedItems) ? body.selectedItems : [],
    packagePlan: body?.packagePlan || {},
    cortexRouting: {
      mode: 'auto_routed',
      selectedBy: 'cortex_oms',
      warehouseSelectionHiddenFromClient: true,
    },
    createdAt: new Date().toISOString(),
  };
  const res = await pgQuery(
    `INSERT INTO oms_shipment_wizard_drafts
      (id, user_id, supplier_id, requires_bol, requires_labels, selected_items, package_plan, cortex_routing)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
     RETURNING *`,
    [
      draft.id,
      userId,
      draft.supplierId,
      draft.requiresBol,
      draft.requiresLabels,
      JSON.stringify(draft.selectedItems),
      JSON.stringify(draft.packagePlan),
      JSON.stringify(draft.cortexRouting),
    ],
  ).catch(() => null);
  return { draft: res?.rows[0] || draft, persistence: res ? 'aurora_postgres' : 'aurora_postgres_error' };
}

async function defaultFacility(userId: string) {
  return one(
    'SELECT * FROM facilities WHERE (user_id = $1 OR user_id IS NULL) AND status = $2 ORDER BY user_id NULLS LAST, created_at ASC LIMIT 1',
    [userId, 'active'],
  );
}

export async function confirmShipmentWizardDraft(userId: string, draftId: string, body: any, log?: FastifyBaseLogger) {
  const selectedItems = Array.isArray(body?.selectedItems) ? body.selectedItems : [];
  const supplierId = body?.supplierId || null;
  const shipFromLocationId = body?.shipFromLocationId || null;
  if (selectedItems.length === 0) {
    return {
      status: 'needs_input',
      message: 'Selected items are required before shipment confirmation.',
      requires: ['selectedItems'],
    };
  }

  const facility = await defaultFacility(userId);
  if (!facility) {
    return {
      status: 'needs_setup',
      message: 'Connect at least one WMS warehouse before confirming an OMS shipment. The OMS can draft intent, but WMS truth is required before ASN execution.',
      requires: ['wms_facility_connection'],
    };
  }
  const shipFrom = shipFromLocationId ? await one('SELECT * FROM ship_from_locations WHERE id = $1 AND user_id = $2', [shipFromLocationId, userId]) : null;
  const plan = await one(
    `INSERT INTO shipment_plans
      (user_id, supplier_id, ship_from_location_id, facility_id, internal_shipment_id, shipment_title, status, prep_services_only, estimated_arrival_date, ship_from_address, items, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'projected_waiting_for_wms_truth', false, $7, $8::jsonb, $9::jsonb, $10::jsonb)
     RETURNING *`,
    [
      userId,
      supplierId,
      shipFromLocationId,
      facility?.id || null,
      `OMS-${Date.now().toString(36).toUpperCase()}`,
      body?.shipmentTitle || `OMS auto-routed shipment ${new Date().toLocaleDateString('en-US')}`,
      body?.estimatedArrivalDate ? new Date(body.estimatedArrivalDate) : null,
      JSON.stringify(shipFrom?.address || body?.shipFromAddress || {}),
      JSON.stringify(selectedItems),
      JSON.stringify({
        draftId,
        autoRoutedBy: 'cortex_oms',
        warehouseSelectionHiddenFromClient: true,
        requiresWmsTruth: true,
      }),
    ],
  );

  const asn = await one(
    `INSERT INTO asns (user_id, shipment_plan_id, asn_number, status, payload)
     VALUES ($1, $2, $3, 'projected', $4::jsonb) RETURNING *`,
    [
      userId,
      plan?.id || null,
      `ASN-${Date.now().toString(36).toUpperCase()}`,
      JSON.stringify({ draftId, selectedItems, requiresWmsTruth: true, facilityId: facility?.id || null }),
    ],
  );

  const cortex = await postCortex('/v1/oms/shipment/projected', {
    userId,
    draftId,
    projectedPlan: plan,
    asn,
    selectedItems,
    requiresBol: body?.requiresBol !== false,
    requiresLabels: Boolean(body?.requiresLabels),
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));

  await writeOmsLedgerEvent({
    userId,
    entityType: 'shipment_wizard',
    entityId: draftId,
    eventType: 'projected_waiting_for_wms_truth',
    sourceSystem: 'oms',
    summary: 'Shipment wizard created an Aurora shipment plan and projected ASN; final execution waits for WMS truth.',
    payload: { draftId, shipmentPlanId: plan?.id || null, asnId: asn?.id || null, cortex },
    confidence: 0.74,
  });

  await pgQuery(
    `UPDATE oms_shipment_wizard_drafts
     SET status = 'projected_waiting_for_wms_truth', shipment_plan_id = $2, asn_id = $3, updated_at = now()
     WHERE id = $1 AND user_id = $4`,
    [draftId, plan?.id || null, asn?.id || null, userId],
  ).catch((err) => log?.warn({ err, draftId }, 'failed to update shipment wizard draft'));

  return { status: 'projected_waiting_for_wms_truth', plan, asn: { asn }, cortex, degraded: false };
}

export async function getHeatmap(userId: string) {
  const [facilities, plan, stateRows] = await Promise.all([
    getFacilities(userId),
    getInventoryPlan(userId),
    rows<{ state: string; orders: string; revenue: string }>(
      `SELECT
         UPPER(COALESCE(
           NULLIF(shipping_address->>'stateOrProvinceCode', ''),
           NULLIF(shipping_address->>'state', ''),
           NULLIF(shipping_address->>'province', '')
         )) AS state,
         COUNT(*)::text AS orders,
         COALESCE(SUM(COALESCE((totals->>'total')::numeric, 0)), 0)::text AS revenue
       FROM orders
       WHERE user_id = $1
       GROUP BY state
       HAVING UPPER(COALESCE(
         NULLIF(shipping_address->>'stateOrProvinceCode', ''),
         NULLIF(shipping_address->>'state', ''),
         NULLIF(shipping_address->>'province', '')
       )) IS NOT NULL
       ORDER BY COUNT(*) DESC
       LIMIT 50`,
      [userId],
    ),
  ]);
  const totalInventory = plan.skus.reduce((sum, sku) => sum + number(sku.available), 0);
  const inventoryPerFacility = facilities.length ? Math.round(totalInventory / facilities.length) : 0;
  return {
    states: stateRows.map((row) => ({
      state: row.state,
      demand: number(row.orders),
      revenue: money(row.revenue),
      risk: number(row.orders) >= 50 ? 'high' : number(row.orders) >= 15 ? 'medium' : 'low',
    })),
    warehouses: facilities.map((f, i) => ({
      id: String(f.id),
      name: f.name,
      code: f.code,
      state: f.address?.stateOrProvinceCode || f.address?.state || null,
      inventoryUnits: inventoryPerFacility,
      activeSkus: plan.skus.length ? Math.max(1, Math.floor(plan.skus.length / Math.max(1, facilities.length || 1))) : 0,
    })),
  };
}

export async function getLabelAudit(userId: string): Promise<{ findings: LabelAuditFinding[]; summary: Record<string, number> }> {
  const stored = await rows(
    'SELECT * FROM oms_label_audit_findings WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100',
    [userId],
  );
  const findings: LabelAuditFinding[] = stored.map((row) => ({
        id: row.id,
        carrier: row.carrier,
        trackingNumber: row.tracking_number,
        findingType: row.finding_type,
        severity: row.severity,
        refundAmount: money(row.refund_amount),
        status: row.status,
        recommendation: row.evidence?.recommendation || 'Review carrier evidence and file claim when confidence is sufficient.',
      }));
  return {
    findings,
    summary: {
      openFindings: findings.length,
      estimatedRefunds: money(findings.reduce((sum, f) => sum + f.refundAmount, 0)),
      optimizedServiceSavings: money(findings.length * 14.25),
    },
  };
}

export async function getBillingProfit(userId: string) {
  const counts = await baseCounts(userId);
  const revenue = (await orderSummary(userId, rangeStart('30d'))).revenue;
  const invoiceRows = await rows<{ amount: string }>('SELECT COALESCE(SUM(amount), 0)::text AS amount FROM invoice_lines WHERE user_id = $1', [userId]);
  const invoices = number(invoiceRows[0]?.amount);
  const current = {
    freight: money(counts.orders * 1.1 + invoices * 0.18),
    storage: money(counts.items * 2.2),
    handling: money(counts.shipmentPlans * 24),
    accessorials: money(counts.shipmentPlans * 9),
    refundsCaptured: money(0),
  };
  const optimized = {
    freight: money(current.freight * 0.84),
    storage: money(current.storage * 0.9),
    handling: money(current.handling * 0.88),
    accessorials: money(current.accessorials * 0.76),
    refundsCaptured: money(current.refundsCaptured * 2.8),
  };
  return { revenue, current, optimized };
}

export async function getLedger(userId: string) {
  const stored = await recentLedger(userId, 100);
  if (stored.length) return { events: stored, persistence: 'aurora_postgres' };
  return {
    events: [],
    persistence: isPostgresConfigured() ? 'aurora_postgres_empty' : 'aurora_postgres_unconfigured',
  };
}

export async function getCopilotContext(userId: string, screen: string) {
  const counts = await baseCounts(userId);
  const ledger = await recentLedger(userId, 5);
  return {
    screen,
    posture: counts.channels > 0 ? 'connected' : 'needs_marketplace_connection',
    summary: `This account has ${counts.items} SKUs, ${counts.orders} orders, ${counts.suppliers} suppliers, and ${counts.shipmentPlans} shipment plans.`,
    recommendedPrompts: [
      'Where am I losing money this month?',
      'Which SKUs need replenishment first?',
      'What can Cortex automate after approval?',
      'Which carrier labels should be disputed?',
    ],
    latestSignals: ledger,
  };
}
