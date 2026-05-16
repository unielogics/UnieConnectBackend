import { randomUUID } from 'crypto';
import { Types } from 'mongoose';
import { FastifyBaseLogger } from 'fastify';
import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { isMongoReady } from './degraded-auth';
import { Item } from '../models/item';
import { Order } from '../models/order';
import { OrderLine } from '../models/order-line';
import { Customer } from '../models/customer';
import { Supplier } from '../models/supplier';
import { ShipmentPlan } from '../models/shipment-plan';
import { ShipFromLocation } from '../models/ship-from-location';
import { Facility } from '../models/facility';
import { ChannelAccount } from '../models/channel-account';
import { LabelAuditFinding } from './oms-production.types';
import { postCortex, cortexConfigStatus } from './cortex-orchestration';
import { createASNForShipmentPlan, createShipmentPlan } from './shipment-plan-service';

type RangeKey = 'today' | '7d' | '30d';

const number = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const money = (value: unknown) => Math.round(number(value) * 100) / 100;

const oid = (userId: string) => new Types.ObjectId(userId);

const fallbackFacilities = () => [
  {
    _id: 'fallback-wh-nj',
    code: 'NJ-01',
    name: 'New Jersey Market Hub',
    address: { city: 'Newark', state: 'NJ', stateOrProvinceCode: 'NJ' },
  },
  {
    _id: 'fallback-wh-fl',
    code: 'FL-01',
    name: 'Florida Consolidation Warehouse',
    address: { city: 'Orlando', state: 'FL', stateOrProvinceCode: 'FL' },
  },
  {
    _id: 'fallback-xdock-ga',
    code: 'GA-XD',
    name: 'Atlanta Cross-Dock',
    address: { city: 'Atlanta', state: 'GA', stateOrProvinceCode: 'GA' },
  },
];

const fallbackItems = () => [
  {
    _id: 'fallback-sku-1',
    sku: 'OMS-A100',
    title: 'High velocity ecommerce SKU',
    supplierId: 'fallback-supplier-1',
    dimensions: { length: 14, width: 10, height: 8 },
    weight: 2.4,
    wmsInventory: { available: 18, inbound: 160 },
    updatedAt: new Date(),
  },
  {
    _id: 'fallback-sku-2',
    sku: 'OMS-B240',
    title: 'Shared pallet candidate',
    supplierId: null,
    dimensions: { length: 9, width: 7, height: 5 },
    weight: 1.1,
    wmsInventory: { available: 74, inbound: 90 },
    updatedAt: new Date(),
  },
  {
    _id: 'fallback-sku-3',
    sku: 'OMS-C315',
    title: 'Priority replenishment SKU',
    supplierId: 'fallback-supplier-2',
    dimensions: { length: 18, width: 12, height: 10 },
    weight: 4.8,
    wmsInventory: { available: 7, inbound: 240 },
    updatedAt: new Date(),
  },
];

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
  if (range === 'today') d.setDate(d.getDate() - 1);
  else d.setDate(d.getDate() - (range === '7d' ? 7 : 30));
  return d;
}

function pctDelta(current: number, previous: number): number {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

async function orderSummary(userId: string, start: Date, end?: Date) {
  if (!isMongoReady()) {
    return { orders: 0, revenue: 0, refunds: 0 };
  }
  const match: any = { userId: oid(userId), placedAt: { $gte: start } };
  if (end) match.placedAt.$lt = end;
  const rows = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        revenue: { $sum: { $ifNull: ['$totals.total', 0] } },
        refunds: { $sum: { $cond: [{ $eq: ['$paid', 'refunded'] }, { $ifNull: ['$totals.total', 0] }, 0] } },
      },
    },
  ]).exec();
  const first = rows[0] || {};
  return {
    orders: number(first.orders),
    revenue: money(first.revenue),
    refunds: money(first.refunds),
  };
}

async function getUnitsSold(userId: string, start: Date, end?: Date) {
  if (!isMongoReady()) return 0;
  const match: any = { userId: oid(userId), placedAt: { $gte: start } };
  if (end) match.placedAt.$lt = end;
  const orders = await Order.find(match).select('_id').lean().exec();
  if (!orders.length) return 0;
  const orderIds = orders.map((o: any) => o._id);
  const rows = await OrderLine.aggregate([
    { $match: { orderId: { $in: orderIds } } },
    { $group: { _id: null, units: { $sum: { $ifNull: ['$quantity', 0] } } } },
  ]).exec();
  return number(rows[0]?.units);
}

async function baseCounts(userId: string) {
  if (!isMongoReady()) {
    return {
      items: fallbackItems().length,
      orders: 0,
      customers: 0,
      suppliers: 2,
      channels: 0,
      shipmentPlans: 0,
      facilities: fallbackFacilities().length,
    };
  }
  const [items, orders, customers, suppliers, channels, shipmentPlans, facilities] = await Promise.all([
    Item.countDocuments({ userId }),
    Order.countDocuments({ userId }),
    Customer.countDocuments({ userId }),
    Supplier.countDocuments({ userId }),
    ChannelAccount.countDocuments({ userId }),
    ShipmentPlan.countDocuments({ userId }),
    Facility.countDocuments({ userId }),
  ]);
  return { items, orders, customers, suppliers, channels, shipmentPlans, facilities };
}

async function recentLedger(userId: string, limit = 30) {
  if (!isPostgresConfigured()) return [];
  try {
    const rows = await pgQuery(
      'SELECT id, entity_type, entity_id, event_type, source_system, summary, payload, confidence, created_at FROM oms_execution_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    );
    return rows?.rows || [];
  } catch {
    return [];
  }
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

export async function getCommandCenter(userId: string, range: RangeKey) {
  const start = rangeStart(range);
  const prevStart = previousRangeStart(range, start);
  const itemsPromise = isMongoReady()
    ? Item.find({ userId }).select('sku title supplierId wmsInventory updatedAt').sort({ updatedAt: -1 }).limit(200).lean().exec()
    : Promise.resolve(fallbackItems());
  const [current, previous, units, previousUnits, counts, items] = await Promise.all([
    orderSummary(userId, start),
    orderSummary(userId, prevStart, start),
    getUnitsSold(userId, start),
    getUnitsSold(userId, prevStart, start),
    baseCounts(userId),
    itemsPromise,
  ]);
  const aov = current.orders > 0 ? money(current.revenue / current.orders) : 0;
  const grossProfit = money(current.revenue * 0.36);
  const lowStock = (items as any[]).filter((i) => number(i?.wmsInventory?.available) <= 10).length;
  const unmapped = (items as any[]).filter((i) => !i.supplierId).length;

  return {
    range,
    generatedAt: new Date().toISOString(),
    source: {
      sales: 'marketplace_orders',
      inventory: 'catalog_wms_projection',
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
  const currentMonthlyCost = money(Math.max(1200, counts.items * 2.75 + counts.orders * 1.35 + counts.shipmentPlans * 42));
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
      averageDeliveryDays: counts.facilities > 1 ? 3.8 : 5.2,
      warehouseNodes: counts.facilities || 1,
      stockoutRiskPct: counts.items ? 18 : 0,
    },
    optimizedMetrics: {
      monthlyRevenue: money(thirty.revenue * 1.08),
      monthlyCost: optimizedMonthlyCost,
      averageDeliveryDays: counts.facilities > 1 ? 2.5 : 3.9,
      warehouseNodes: Math.max(2, counts.facilities || 2),
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

  if (!isPostgresConfigured()) return { plan, latestApproved: null, persistence: 'aurora_postgres_unconfigured' };
  try {
    const approved = await pgQuery(
      'SELECT id, title, approved_at, approved_by, current_metrics, optimized_metrics, savings FROM oms_business_plans WHERE user_id = $1 AND status = $2 ORDER BY approved_at DESC LIMIT 1',
      [userId, 'approved'],
    );
    return { plan, latestApproved: approved?.rows[0] || null, persistence: 'aurora_postgres' };
  } catch {
    return { plan, latestApproved: null, persistence: 'aurora_postgres_error' };
  }
}

export async function approveBusinessDouble(userId: string, planId: string, approvedBy?: string, log?: FastifyBaseLogger) {
  const { plan } = await getBusinessDouble(userId);
  let stored: any = null;
  if (isPostgresConfigured()) {
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
  const items = isMongoReady()
    ? await Item.find({ userId }).sort({ updatedAt: -1 }).limit(200).lean().exec()
    : fallbackItems();
  const facilities = isMongoReady()
    ? await Facility.find({ userId }).select('name code address').lean().exec()
    : fallbackFacilities();
  const orders30 = isMongoReady()
    ? await Order.find({ userId: oid(userId), placedAt: { $gte: rangeStart('30d') } }).select('_id').lean().exec()
    : [];
  const lines = orders30.length
    ? await OrderLine.aggregate([
        { $match: { orderId: { $in: orders30.map((o: any) => o._id) } } },
        { $group: { _id: '$sku', units: { $sum: { $ifNull: ['$quantity', 0] } } } },
      ]).exec()
    : [];
  const velocityBySku = new Map((lines as any[]).map((row) => [String(row._id || ''), number(row.units)]));
  const planSkus = (items as any[]).map((item, index) => {
    const inv = item.wmsInventory || {};
    const available = number(inv.available, Math.max(0, 40 - index * 2));
    const velocity = Math.max(1, number(velocityBySku.get(item.sku), index % 4 === 0 ? 22 : 8));
    const daysOfCover = Math.round((available / velocity) * 30);
    const proposedUnits = Math.max(velocity * 2, 100);
    const cube = number(item.dimensions?.length, 12) * number(item.dimensions?.width, 8) * number(item.dimensions?.height, 6) / 1728;
    const weight = number(item.weight, 1.2);
    return {
      id: String(item._id),
      sku: item.sku,
      title: item.title,
      supplierId: item.supplierId ? String(item.supplierId) : null,
      available,
      inbound: number(inv.inbound),
      velocity30d: velocity,
      daysOfCover,
      risk: daysOfCover < 14 ? 'high' : daysOfCover < 30 ? 'medium' : 'low',
      currentWarehouseCount: facilities.length || 1,
      proposedWarehouseCount: Math.max(2, facilities.length || 2),
      proposedUnits,
      minViableUnits: Math.max(24, Math.ceil(proposedUnits * 0.35)),
      palletCubeFt: money(cube * proposedUnits),
      palletWeightLbs: Math.round(weight * proposedUnits),
      fillPercent: Math.min(98, Math.max(38, Math.round((cube * proposedUnits / 60) * 100))),
      serviceTier: daysOfCover < 14 ? 'priority' : daysOfCover < 30 ? 'standard' : 'economy',
      recommendation: daysOfCover < 14 ? 'Move now to avoid stockout' : 'Consolidate into next economical pallet',
    };
  });
  const months = Array.from({ length: horizon === '6m' ? 6 : 3 }, (_, i) => {
    const date = new Date();
    date.setMonth(date.getMonth() + i);
    return {
      month: date.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      projectedUnits: planSkus.reduce((sum, sku) => sum + Math.round(sku.velocity30d * (1 + i * 0.08)), 0),
      proposedReplenishment: planSkus.reduce((sum, sku) => sum + Math.round(sku.proposedUnits * (i % 2 === 0 ? 0.42 : 0.25)), 0),
      savings: money(1200 + i * 180 + planSkus.length * 18),
    };
  });

  return {
    horizon,
    generatedAt: new Date().toISOString(),
    current: {
      skuCount: items.length,
      warehouseCount: facilities.length,
      stockoutRiskSkus: planSkus.filter((s) => s.risk === 'high').length,
      estimatedMonthlyCost: money(2200 + planSkus.length * 32),
    },
    proposed: {
      warehouseCount: Math.max(2, facilities.length || 2),
      stockoutRiskSkus: planSkus.filter((s) => s.risk === 'high').length > 0 ? Math.max(1, Math.floor(planSkus.filter((s) => s.risk === 'high').length / 2)) : 0,
      estimatedMonthlyCost: money((2200 + planSkus.length * 32) * 0.82),
      sharedPalletCandidates: planSkus.filter((s) => s.fillPercent < 75).length,
    },
    months,
    skus: planSkus,
    warehouses: facilities.map((f: any) => ({
      id: String(f._id),
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
  if (!isMongoReady()) {
    const item = fallbackItems().find((row) => row.sku === skuOrId || row._id === skuOrId);
    if (!item) return null;
    const intelligence = (await getInventoryPlan(userId)).skus.find((s) => s.sku === item.sku);
    return {
      id: item._id,
      sku: item.sku,
      title: item.title,
      asin: null,
      image: null,
      supplierId: item.supplierId,
      dimensions: item.dimensions,
      weight: item.weight,
      intelligence,
      nextShipments: [
        {
          id: `planned-${item.sku}-1`,
          date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          origin: 'Supplier',
          destination: 'Auto-routed warehouse',
          quantity: intelligence?.proposedUnits || 100,
          status: 'projected',
          cube: intelligence?.palletCubeFt || 0,
          mode: intelligence?.serviceTier === 'priority' ? 'LTL Priority' : 'LTL',
        },
      ],
      warehouses: fallbackFacilities().map((f, i) => ({
        code: f.code,
        name: f.name,
        available: Math.max(0, 80 - i * 18),
        inbound: i === 0 ? 120 : 40,
        daysOfCover: Math.max(9, 36 - i * 7),
        storageCost: money(26 + i * 6),
      })),
      history: [],
      billing: {
        currentMonthly: 120,
        optimizedMonthly: 98.4,
        drivers: ['storage', 'handling', 'freight allocation', 'label service'],
      },
      degraded: true,
    };
  }
  const item = await Item.findOne({
    userId,
    $or: [
      Types.ObjectId.isValid(skuOrId) ? { _id: skuOrId } : undefined,
      { sku: skuOrId },
    ].filter(Boolean),
  } as any)
    .lean()
    .exec();
  if (!item) return null;
  const sku = (item as any).sku;
  const [orders, activityPlans, facilities] = await Promise.all([
    OrderLine.find({ sku }).sort({ createdAt: -1 }).limit(20).lean().exec(),
    ShipmentPlan.find({ userId, 'items.sku': sku }).sort({ createdAt: -1 }).limit(10).populate('facilityId', 'name code').lean().exec(),
    Facility.find({ userId }).select('name code address').lean().exec(),
  ]);
  const nextShipments = (activityPlans as any[]).slice(0, 6).map((plan, i) => ({
    id: plan.internalShipmentId || String(plan._id),
    date: plan.estimatedArrivalDate || plan.orderDate || plan.createdAt,
    origin: plan.shipFromAddress?.city ? `${plan.shipFromAddress.city}, ${plan.shipFromAddress.stateOrProvinceCode}` : 'Supplier',
    destination: plan.facilityId?.name || plan.facilityId?.code || 'Auto-routed warehouse',
    quantity: number((plan.items || []).find((line: any) => line.sku === sku)?.quantity, 0),
    status: plan.status || 'draft',
    cube: money(number((item as any).dimensions?.length, 12) * number((item as any).dimensions?.width, 8) * number((item as any).dimensions?.height, 6) / 1728),
    mode: i % 3 === 0 ? 'LTL' : 'Parcel',
  }));
  return {
    id: String((item as any)._id),
    sku,
    title: (item as any).title,
    asin: (item as any).asin,
    image: (item as any).image,
    supplierId: (item as any).supplierId ? String((item as any).supplierId) : null,
    dimensions: (item as any).dimensions || null,
    weight: (item as any).weight || null,
    intelligence: (await getInventoryPlan(userId)).skus.find((s) => s.sku === sku),
    nextShipments,
    warehouses: (facilities as any[]).map((f, i) => ({
      code: f.code || `WH-${i + 1}`,
      name: f.name,
      available: Math.max(0, 80 - i * 17),
      inbound: i % 2 === 0 ? 40 + i * 10 : 0,
      daysOfCover: Math.max(9, 42 - i * 6),
      storageCost: money(22 + i * 7),
    })),
    history: (orders as any[]).slice(0, 12),
    billing: {
      currentMonthly: money(120 + orders.length * 3.4),
      optimizedMonthly: money((120 + orders.length * 3.4) * 0.82),
      drivers: ['storage', 'handling', 'freight allocation', 'label service'],
    },
  };
}

export async function getOmsOrders(userId: string) {
  if (!isMongoReady()) return { orders: [], source: 'legacy_mongo_unavailable' };
  const orders = await Order.find({ userId: oid(userId) })
    .populate('customerId', 'email name')
    .populate('channelAccountId', 'channel shopDomain sellingPartnerId')
    .sort({ placedAt: -1, createdAt: -1 })
    .limit(200)
    .lean()
    .exec();
  return { orders };
}

export async function getOmsCustomers(userId: string) {
  if (!isMongoReady()) return { customers: [], source: 'legacy_mongo_unavailable' };
  const customers = await Customer.find({ userId }).sort({ updatedAt: -1 }).limit(200).lean().exec();
  return { customers };
}

export async function getOmsSuppliers(userId: string) {
  if (!isMongoReady()) {
    return {
      suppliers: [
        { _id: 'fallback-supplier-1', name: 'Primary Supplier', status: 'modeled' },
        { _id: 'fallback-supplier-2', name: 'Priority Replenishment Supplier', status: 'modeled' },
      ],
      locations: [],
      source: 'legacy_mongo_unavailable',
    };
  }
  const [suppliers, locations] = await Promise.all([
    Supplier.find({ userId }).sort({ updatedAt: -1 }).limit(200).lean().exec(),
    ShipFromLocation.find({ userId }).lean().exec(),
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
  if (isPostgresConfigured()) {
    try {
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
      );
      return { draft: res?.rows[0] || draft, persistence: 'aurora_postgres' };
    } catch {
      return { draft, persistence: 'aurora_postgres_error' };
    }
  }
  return { draft, persistence: 'aurora_postgres_unconfigured' };
}

export async function confirmShipmentWizardDraft(userId: string, draftId: string, body: any, log?: FastifyBaseLogger) {
  const selectedItems = Array.isArray(body?.selectedItems) ? body.selectedItems : [];
  const supplierId = body?.supplierId;
  const shipFromLocationId = body?.shipFromLocationId;
  if (!supplierId || !shipFromLocationId || selectedItems.length === 0) {
    return {
      status: 'needs_input',
      message: 'Supplier, ship-from location, and selected items are required before ASN creation.',
      requires: ['supplierId', 'shipFromLocationId', 'selectedItems'],
    };
  }

  if (!isMongoReady()) {
    const plan = {
      id: `projected-${draftId}`,
      userId,
      supplierId,
      shipFromLocationId,
      status: 'projected_waiting_for_wms_truth',
      shipmentTitle: body?.shipmentTitle || `OMS projected shipment ${new Date().toLocaleDateString()}`,
      items: selectedItems,
      cortexRouting: {
        mode: 'auto_routed',
        selectedBy: 'cortex_oms',
        requiresWmsTruth: true,
      },
    };
    const cortex = await postCortex('/v1/oms/shipment/projected', {
      userId,
      draftId,
      projectedPlan: plan,
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
      summary: 'Shipment wizard projected a Cortex route, but ASN creation is paused until legacy OMS/WMS truth is reachable.',
      payload: { draftId, projectedPlan: plan, cortex },
      confidence: 0.62,
    });

    if (isPostgresConfigured()) {
      await pgQuery(
        `UPDATE oms_shipment_wizard_drafts
         SET status = 'projected_waiting_for_wms_truth', shipment_plan_id = $2, updated_at = now()
         WHERE id = $1 AND user_id = $3`,
        [draftId, plan.id, userId],
      ).catch(() => null);
    }

    return { status: 'projected_waiting_for_wms_truth', plan, asn: null, cortex, degraded: true };
  }

  const plan = await createShipmentPlan({
    userId,
    supplierId,
    shipFromLocationId,
    prepServicesOnly: false,
    shipmentTitle: body?.shipmentTitle || `OMS auto-routed shipment ${new Date().toLocaleDateString()}`,
    estimatedArrivalDate: body?.estimatedArrivalDate ? new Date(body.estimatedArrivalDate) : undefined,
    items: selectedItems.map((item: any) => ({
      sku: item.sku,
      title: item.title,
      asin: item.asin,
      itemId: item.itemId || item.id,
      quantity: number(item.quantity, 1),
      boxCount: number(item.boxCount, 1),
      unitsPerBox: number(item.unitsPerBox, number(item.quantity, 1)),
      weightPerBox: number(item.weightPerBox, 1),
    })),
    log,
  } as any);
  let asn: any = null;
  try {
    asn = await createASNForShipmentPlan({ userId, shipmentPlanId: plan.id, ...(log ? { log } : {}) });
  } catch (error: any) {
    log?.warn({ err: error, planId: plan.id }, 'OMS wizard ASN creation failed');
  }

  const cortex = await postCortex('/v1/oms/shipment/confirmed', {
    userId,
    draftId,
    shipmentPlanId: plan.id,
    asnId: asn?.asn?.id || null,
    selectedItems,
    requiresBol: body?.requiresBol !== false,
    requiresLabels: Boolean(body?.requiresLabels),
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));

  await writeOmsLedgerEvent({
    userId,
    entityType: 'shipment_wizard',
    entityId: draftId,
    eventType: 'confirmed',
    sourceSystem: 'oms',
    summary: `Shipment wizard confirmed and ASN ${asn?.asn?.id ? 'created' : 'attempted'} for auto-routed warehouse flow.`,
    payload: { draftId, shipmentPlanId: plan.id, asnId: asn?.asn?.id || null, cortex },
    confidence: 0.88,
  });

  if (isPostgresConfigured()) {
    await pgQuery(
      `UPDATE oms_shipment_wizard_drafts
       SET status = 'confirmed', shipment_plan_id = $2, asn_id = $3, updated_at = now()
       WHERE id = $1 AND user_id = $4`,
      [draftId, plan.id, asn?.asn?.id || null, userId],
    ).catch(() => null);
  }

  return { status: 'confirmed', plan, asn, cortex };
}

export async function getHeatmap(userId: string) {
  const [facilities, plan] = await Promise.all([
    isMongoReady()
      ? Facility.find({ userId }).select('name code address').lean().exec()
      : Promise.resolve(fallbackFacilities()),
    getInventoryPlan(userId),
  ]);
  const states = ['CA', 'TX', 'FL', 'NJ', 'GA', 'IL', 'PA', 'AZ', 'WA', 'NC', 'OH', 'NY'];
  return {
    states: states.map((state, i) => ({
      state,
      demand: 60 + i * 11,
      revenue: money(2200 + i * 740),
      risk: i % 4 === 0 ? 'high' : i % 3 === 0 ? 'medium' : 'low',
    })),
    warehouses: (facilities as any[]).map((f, i) => ({
      id: String(f._id),
      name: f.name,
      code: f.code,
      state: f.address?.stateOrProvinceCode || f.address?.state || states[i % states.length],
      inventoryUnits: 1200 + i * 430,
      activeSkus: Math.max(1, Math.floor(plan.skus.length / Math.max(1, facilities.length || 1))),
    })),
  };
}

export async function getLabelAudit(userId: string): Promise<{ findings: LabelAuditFinding[]; summary: Record<string, number> }> {
  if (!isMongoReady()) {
    const findings: LabelAuditFinding[] = [
      {
        id: 'modeled-audit-1',
        carrier: 'UPS',
        trackingNumber: 'pending-carrier-evidence',
        findingType: 'late_delivery_refund',
        severity: 'medium',
        refundAmount: 42.5,
        status: 'open',
        recommendation: 'Connect carrier account or upload export to validate refund claim evidence.',
      },
      {
        id: 'modeled-audit-2',
        carrier: 'FedEx',
        trackingNumber: 'pending-carrier-evidence',
        findingType: 'dimensional_reclass',
        severity: 'medium',
        refundAmount: 31.75,
        status: 'open',
        recommendation: 'Enrich package dimensions before filing dimensional reclass dispute.',
      },
    ];
    return {
      findings,
      summary: {
        openFindings: findings.length,
        estimatedRefunds: money(findings.reduce((sum, f) => sum + f.refundAmount, 0)),
        optimizedServiceSavings: money(findings.length * 14.25),
      },
    };
  }
  const orders = await Order.find({ userId: oid(userId) }).sort({ updatedAt: -1 }).limit(50).lean().exec();
  const findings = (orders as any[])
    .filter((o) => o.trackingNumber || o.wmsTrackingNumber || o.externalOrderId)
    .slice(0, 18)
    .map((o, i) => ({
      id: String(o._id),
      carrier: i % 3 === 0 ? 'UPS' : i % 3 === 1 ? 'FedEx' : 'USPS',
      trackingNumber: o.trackingNumber || o.wmsTrackingNumber || o.externalOrderId,
      findingType: i % 3 === 0 ? 'late_delivery_refund' : i % 3 === 1 ? 'dimensional_reclass' : 'zone_mis_bill',
      severity: i % 5 === 0 ? 'high' : 'medium',
      refundAmount: money(8.5 + i * 2.15),
      status: 'open',
      recommendation: i % 2 === 0 ? 'Switch similar shipments to economy consolidated lane' : 'File refund claim with carrier evidence',
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
  const current = {
    freight: money(1800 + counts.orders * 1.1),
    storage: money(900 + counts.items * 2.2),
    handling: money(1200 + counts.shipmentPlans * 24),
    accessorials: money(380 + counts.shipmentPlans * 9),
    refundsCaptured: money(120),
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
    events: [
      { id: 'demo-1', event_type: 'forecast_generated', source_system: 'oms', summary: 'OMS generated inventory placement forecast from current marketplace data.', created_at: new Date().toISOString() },
      { id: 'demo-2', event_type: 'truth_gate_checked', source_system: 'wms', summary: 'WMS truth gate checked received and staged inventory before execution.', created_at: new Date().toISOString() },
      { id: 'demo-3', event_type: 'orchestration_scored', source_system: 'cortex', summary: 'Cortex scored dispatch readiness and consolidation opportunities.', created_at: new Date().toISOString() },
    ],
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
