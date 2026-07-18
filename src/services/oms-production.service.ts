import { getKeepaSnapshotForIdentifiers } from "./keepa";
import { randomUUID } from 'crypto';
import { FastifyBaseLogger } from 'fastify';
import fetch from 'node-fetch';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import nodemailer from 'nodemailer';
import { config } from '../config/env';
import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { publicEntityId } from '../lib/public-id';
import { LabelAuditFinding, LabelAuditRun } from './oms-production.types';
import { postCortex, cortexConfigStatus } from './cortex-orchestration';

type RangeKey = 'today' | '7d' | '30d' | '90d' | 'mtd';
type Row = Record<string, any>;
type MarketplaceFilter = {
  channel?: string;
  channelAccountId?: string;
};
type VendorEmailStatus = 'sent' | 'queued' | 'failed' | 'not_configured';

const number = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const money = (value: unknown) => {
  const cleaned = typeof value === 'string' ? value.replace(/[$,\s]/g, '') : value;
  return Math.round(number(cleaned) * 100) / 100;
};
const json = (value: unknown, fallback: any) => (value == null ? fallback : value);
const iso = (value: unknown) => (value ? new Date(value as any).toISOString() : undefined);

const addressLine = (address: any = {}) => {
  const line1 = address.addressLine1 || address.line1 || address.street1 || address.street || '';
  const line2 = address.addressLine2 || address.line2 || address.street2 || '';
  const city = address.city || '';
  const state = address.stateOrProvinceCode || address.state || '';
  const postal = address.postalCode || address.postal || address.zip || address.zipCode || '';
  const country = address.countryCode || address.country || '';
  return [line1, line2, [city, state, postal].filter(Boolean).join(', '), country].filter(Boolean).join(' · ');
};

function sumSelectedQuantity(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item: any) => sum + number(item?.quantity ?? item?.qty ?? item?.units, 0), 0);
}

function extractPlanArray(plan: any, ...keys: string[]) {
  for (const key of keys) {
    const value = plan?.[key] ?? plan?.planning?.[key] ?? plan?.monthly_replenishment_plan_v1?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function buildOmsDecisionContext(plan: any) {
  return {
    expectedQuantities: {
      forecast_horizon_months: plan?.forecastHorizonMonths ?? plan?.forecast_horizon_months ?? null,
      planned_sku_count: Array.isArray(plan?.skuRecommendations) ? plan.skuRecommendations.length : null,
      planned_lane_count: extractPlanArray(plan, 'warehouse_transfer_plan', 'transfer_lanes', 'lanes').length,
    },
    expectedSavings: plan?.savings || plan?.optimizedMetrics?.savings || {},
    expectedServiceImpact: {
      current: plan?.currentMetrics?.service || plan?.currentMetrics?.delivery || null,
      optimized: plan?.optimizedMetrics?.service || plan?.optimizedMetrics?.delivery || null,
      impact: plan?.serviceImpact || plan?.optimizedMetrics?.serviceImpact || null,
    },
    warehousePlan: plan?.warehousePlan || plan?.inventoryPlan || plan?.regionalPlan || extractPlanArray(plan, 'warehouse_transfer_plan', 'transfer_lanes', 'lanes'),
    skuPlan: plan?.skuPlan || plan?.skuRecommendations || [],
    lanePlan: extractPlanArray(plan, 'warehouse_transfer_plan', 'transfer_lanes', 'lanes'),
  };
}

function supplierPickupProfile(row: Row) {
  const metadata = json(row.metadata, {});
  const address = json(row.address, {});
  const pickup = metadata.pickupProfile || metadata.pickup || {};
  return {
    loadingDock: pickup.loadingDock ?? metadata.loadingDock ?? null,
    maxVehicleSize: pickup.maxVehicleSize || metadata.maxVehicleSize || null,
    hoursOfOperation: pickup.hoursOfOperation || metadata.hoursOfOperation || row.hours_of_operation || '',
    equipmentRequired: Array.isArray(pickup.equipmentRequired)
      ? pickup.equipmentRequired
      : Array.isArray(metadata.equipmentRequired)
        ? metadata.equipmentRequired
        : [],
    appointmentRequired: Boolean(pickup.appointmentRequired ?? metadata.appointmentRequired ?? false),
    dockAppointmentLeadTimeHours: pickup.dockAppointmentLeadTimeHours ?? metadata.dockAppointmentLeadTimeHours ?? null,
    liftgateRequired: Boolean(pickup.liftgateRequired ?? metadata.liftgateRequired ?? false),
    insidePickup: Boolean(pickup.insidePickup ?? metadata.insidePickup ?? false),
    palletExchange: Boolean(pickup.palletExchange ?? metadata.palletExchange ?? false),
    pickupInstructions: pickup.pickupInstructions || metadata.pickupInstructions || '',
    contactName: pickup.contactName || metadata.contactName || metadata.primaryContact || '',
    address,
  };
}

async function callWmsInternal<T = Row>(path: string, body: Row): Promise<T> {
  if (!config.wmsApiUrl || !config.internalApiKey) {
    throw new Error('WMS internal API is not configured');
  }
  const res = await fetch(`${config.wmsApiUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': config.internalApiKey,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) {
    const err = new Error(String(data.message || data.error || `WMS request failed with ${res.status}`));
    (err as any).status = res.status;
    (err as any).payload = data;
    throw err;
  }
  return data as T;
}

function shipmentLineQuantity(line: any) {
  return number(
    line?.quantity ??
      line?.qty ??
      line?.units ??
      (number(line?.cartons, 0) > 0 && number(line?.unitsPerCarton, 0) > 0
        ? number(line.cartons) * number(line.unitsPerCarton)
        : undefined),
    0,
  );
}

async function findWmsLinkForFacility(userId: string, facility: Row | null) {
  if (!facility) return null;
  if (facility.id) {
    const byFacility = await one(
      'SELECT * FROM oms_warehouse_links WHERE user_id = $1 AND facility_id = $2 AND status = $3 ORDER BY connected_at DESC NULLS LAST FETCH FIRST 1 ROWS ONLY',
      [userId, facility.id, 'connected'],
    );
    if (byFacility) return byFacility;
  }
  if (facility.code) {
    return one(
      'SELECT * FROM oms_warehouse_links WHERE user_id = $1 AND warehouse_code = $2 AND status = $3 ORDER BY connected_at DESC NULLS LAST FETCH FIRST 1 ROWS ONLY',
      [userId, facility.code, 'connected'],
    );
  }
  return null;
}

async function createWmsAsnForShipment(params: {
  userId: string;
  draftId: string;
  supplier: Row | null;
  facility: Row | null;
  selectedItems: any[];
  plan: Row | null;
  asn: Row | null;
  estimatedArrivalDate?: unknown;
  shipFromAddress?: any;
  log?: FastifyBaseLogger;
}) {
  const link = await findWmsLinkForFacility(params.userId, params.facility);
  const warehouseCode = link?.warehouse_code || params.facility?.code;
  const wmsIntermediaryId = link?.metadata?.wmsIntermediaryId;
  if (!warehouseCode || !wmsIntermediaryId) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_wms_link',
      message: 'No connected WMS intermediary was found for the selected facility.',
    };
  }

  const skus = params.selectedItems.map((item) => String(item?.sku || '').trim()).filter(Boolean);
  const catalogRows = skus.length
    ? await rows(
        `SELECT id, sku, title, description, supplier_id, image, images, upc, ean, asin,
                category, sub_category, weight, dimensions, archived, metadata
         FROM catalog_items
         WHERE user_id = $1
         ORDER BY updated_at DESC NULLS LAST, created_at DESC
         FETCH FIRST 5000 ROWS ONLY`,
        [params.userId],
      )
    : [];
  const catalogBySku = new Map(catalogRows.map((row) => [String(row.sku || ''), row]));
  const selectedCatalogRows = skus
    .map((sku) => catalogBySku.get(sku))
    .filter((item): item is Row => Boolean(item));

  if (params.supplier || selectedCatalogRows.length) {
    await callWmsInternal('/internal/oms/catalog/sync', {
      warehouseCode,
      wmsIntermediaryId,
      suppliers: params.supplier
        ? [{
            id: params.supplier.id,
            name: params.supplier.name,
            email: params.supplier.email,
            phone: params.supplier.phone,
            status: params.supplier.status,
            address: json(params.supplier.address, {}),
            metadata: json(params.supplier.metadata, {}),
          }]
        : [],
      items: selectedCatalogRows.map((item) => ({
        id: item.id,
        sku: item.sku,
        title: item.title,
        description: item.description,
        supplierId: item.supplier_id,
        image: item.image,
        images: json(item.images, []),
        upc: item.upc,
        ean: item.ean,
        asin: item.asin,
        category: item.category,
        subCategory: item.sub_category,
        weight: item.weight,
        dimensions: json(item.dimensions, null),
        archived: Boolean(item.archived),
        metadata: json(item.metadata, {}),
      })),
    });
  }

  const supplierAddress = json(params.supplier?.address, {});
  const shipFromAddress = params.shipFromAddress || supplierAddress || {};
  const wmsAsn = await callWmsInternal('/internal/oms/asn/create', {
    warehouseCode,
    wmsIntermediaryId,
    omsIntermediaryId: link?.metadata?.wmsOmsIntermediaryId,
    omsSupplierId: params.supplier?.id || null,
    poNumber: params.asn?.asn_number || params.plan?.internal_shipment_id || `OMS-${Date.now()}`,
    shipFromAddress: {
      name: params.supplier?.name || shipFromAddress.name || 'UnieConnect Supplier',
      addressLine1: shipFromAddress.addressLine1 || shipFromAddress.line1 || shipFromAddress.street || '',
      city: shipFromAddress.city || '',
      stateOrProvinceCode: shipFromAddress.state || shipFromAddress.stateOrProvinceCode || '',
      postalCode: shipFromAddress.zipCode || shipFromAddress.postalCode || '',
      countryCode: shipFromAddress.countryCode || shipFromAddress.country || 'US',
    },
    lineItems: params.selectedItems.map((line) => {
      const catalog = catalogBySku.get(String(line?.sku || '')) || {};
      const cartons = number(line?.cartons ?? line?.containersCount, 1);
      const unitsPerCarton = number(line?.unitsPerCarton ?? line?.unitsPerContainer, shipmentLineQuantity(line) || 1);
      return {
        sku: line?.sku,
        itemName: line?.itemName || line?.title || catalog.title || line?.sku,
        quantity: shipmentLineQuantity(line) || cartons * unitsPerCarton,
        unitsPerContainer: unitsPerCarton,
        containersCount: cartons,
        image: catalog.image || line?.image,
        images: json(catalog.images, line?.images || []),
      };
    }),
    eta: params.estimatedArrivalDate || null,
  });

  return {
    ok: true,
    warehouseCode,
    wmsIntermediaryId,
    ...wmsAsn,
  };
}

function mapOmsSupplier(row: Row, skuCount = 0) {
  const metadata = json(row.metadata, {});
  const address = json(row.address, {});
  const pickupProfile = supplierPickupProfile(row);
  return {
    id: String(row.id),
    publicId: publicEntityId('SU', row.id),
    displayId: publicEntityId('SU', row.id),
    name: row.name,
    email: row.email || null,
    phone: row.phone || null,
    status: row.status || 'active',
    website: metadata.website || null,
    notes: metadata.notes || null,
    country: address.countryCode || address.country || metadata.country || null,
    region: address.stateOrProvinceCode || address.state || address.city || metadata.region || null,
    leadTime: metadata.leadTimeDays ?? metadata.leadTime,
    onTime: metadata.onTimeRate ?? metadata.onTime,
    qualityPass: metadata.qualityPassRate ?? metadata.qualityPass,
    paymentTerms: metadata.paymentTerms,
    relationship: metadata.relationship,
    spend90d: metadata.spend90d,
    spendYTD: metadata.spendYTD,
    skuCount,
    rating: metadata.rating,
    contact: pickupProfile.contactName || row.email || row.phone || '',
    skus: Array.isArray(metadata.skus) ? metadata.skus : [],
    pickupProfile,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    metadata,
  };
}

function itemLines(value: unknown): any[] {
  const lines = json(value, []);
  return Array.isArray(lines) ? lines : [];
}

function lineQuantity(line: any) {
  return number(line?.quantity ?? line?.qty ?? line?.units ?? line?.availableQuantity);
}

function sumItemUnits(lines: any[]) {
  return lines.reduce((sum, line) => sum + lineQuantity(line), 0);
}

function requiresPlanDocument(plan: Row, key: 'requiresBol' | 'requiresLabels') {
  const metadata = json(plan.metadata, {});
  return Boolean(metadata[key] ?? metadata[key === 'requiresBol' ? 'requires_bol' : 'requires_labels']);
}

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

async function barcodePng(text: string) {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: text || 'UNKNOWN',
    scale: 2,
    height: 8,
    includetext: false,
    paddingwidth: 2,
    paddingheight: 2,
  });
}

async function shipmentDocumentContext(userId: string, draftId: string) {
  const draft = await one('SELECT * FROM oms_shipment_wizard_drafts WHERE id = $1 AND user_id = $2 LIMIT 1', [draftId, userId]);
  if (!draft) return null;
  const plan = draft.shipment_plan_id
    ? await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2 LIMIT 1', [draft.shipment_plan_id, userId])
    : null;
  const asn = draft.asn_id
    ? await one('SELECT * FROM asns WHERE id = $1 AND user_id = $2 LIMIT 1', [draft.asn_id, userId])
    : null;
  const supplierId = draft.supplier_id || plan?.supplier_id || null;
  const supplier = supplierId ? await one('SELECT * FROM suppliers WHERE id = $1 AND user_id = $2 LIMIT 1', [supplierId, userId]) : null;
  const facility = plan?.facility_id ? await one('SELECT * FROM facilities WHERE id = $1 LIMIT 1', [plan.facility_id]) : null;
  return { draft, plan, asn, supplier, facility };
}

function labelFilename(ctx: NonNullable<Awaited<ReturnType<typeof shipmentDocumentContext>>>) {
  const asnNo = String(ctx.asn?.asn_number || ctx.plan?.internal_shipment_id || ctx.draft.id || 'shipment').replace(/[^a-z0-9_-]/gi, '-');
  return `${asnNo}-pallet-labels.pdf`;
}

function selectedLinesForLabels(ctx: NonNullable<Awaited<ReturnType<typeof shipmentDocumentContext>>>) {
  const raw = itemLines(ctx.draft.selected_items || ctx.plan?.items || []);
  return raw.map((line) => {
    const cartons = Math.max(1, number(line?.cartons ?? line?.containersCount, 1));
    const unitsPerCarton = Math.max(1, number(line?.unitsPerCarton ?? line?.unitsPerContainer, 1));
    const units = shipmentLineQuantity(line) || cartons * unitsPerCarton;
    return {
      sku: String(line?.sku || line?.itemName || 'SKU'),
      title: String(line?.title || line?.itemName || line?.name || line?.sku || 'Item'),
      cartons,
      units,
    };
  });
}

export async function generateShipmentPalletLabelsPdf(userId: string, draftId: string) {
  const ctx = await shipmentDocumentContext(userId, draftId);
  if (!ctx) return null;
  const packagePlan = json(ctx.draft.package_plan || ctx.plan?.metadata?.packagePlan, {});
  const lines = selectedLinesForLabels(ctx);
  const totalCartons = Math.max(1, number(packagePlan.totalCartons ?? lines.reduce((sum, line) => sum + line.cartons, 0), 1));
  const totalUnits = Math.max(1, number(packagePlan.totalUnits ?? lines.reduce((sum, line) => sum + line.units, 0), 1));
  const palletCount = Math.max(1, number(packagePlan.pallets, 1));
  const asnNumber = String(ctx.asn?.asn_number || ctx.plan?.internal_shipment_id || `ASN-${draftId.slice(0, 8)}`);
  const planId = String(ctx.plan?.internal_shipment_id || ctx.plan?.id || draftId);
  const supplierAddress = addressLine(json(ctx.supplier?.address, {}));
  const facilityAddress = addressLine(json(ctx.facility?.address, {}));
  const facilityName = String(ctx.facility?.name || ctx.facility?.code || 'Receiving warehouse');
  const doc = new PDFDocument({ size: [288, 432], margin: 18, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const asnBarcode = await barcodePng(asnNumber);

  for (let i = 1; i <= palletCount; i += 1) {
    const palletId = `${asnNumber}-PALLET-${String(i).padStart(2, '0')}`;
    const palletBarcode = await barcodePng(palletId);
    doc.addPage();
    doc.fontSize(14).font('Helvetica-Bold').text('UnieConnect ASN Pallet Label', { align: 'center' });
    doc.moveDown(0.35);
    doc.fontSize(9).font('Helvetica').text('Vendor: place this label on the pallet before pickup.', { align: 'center' });
    doc.moveDown(0.6);
    doc.fontSize(10).font('Helvetica-Bold').text(`ASN: ${asnNumber}`);
    doc.fontSize(9).font('Helvetica').text(`Shipment plan: ${planId}`);
    doc.text(`Pallet: ${i} of ${palletCount}`);
    doc.text(`Cartons / units: ${totalCartons.toLocaleString()} / ${totalUnits.toLocaleString()}`);
    doc.moveDown(0.45);
    doc.font('Helvetica-Bold').text('Supplier');
    doc.font('Helvetica').text(String(ctx.supplier?.name || 'Supplier not assigned'));
    if (supplierAddress) doc.text(supplierAddress, { width: 252 });
    doc.moveDown(0.45);
    doc.font('Helvetica-Bold').text('Receiving warehouse');
    doc.font('Helvetica').text(facilityName);
    if (facilityAddress) doc.text(facilityAddress, { width: 252 });
    doc.moveDown(0.45);
    doc.font('Helvetica-Bold').text('SKU summary');
    doc.font('Helvetica').fontSize(8);
    lines.slice(0, 5).forEach((line) => {
      doc.text(`${line.sku} · ${line.cartons} ctn · ${line.units} u`, { width: 252 });
    });
    if (lines.length > 5) doc.text(`+ ${lines.length - 5} more SKU lines`);
    doc.moveDown(0.45);
    doc.image(asnBarcode, 34, 292, { width: 220, height: 42 });
    doc.fontSize(7).text(asnNumber, 18, 334, { align: 'center', width: 252 });
    doc.image(palletBarcode, 34, 352, { width: 220, height: 42 });
    doc.fontSize(7).text(palletId, 18, 394, { align: 'center', width: 252 });
  }
  doc.end();
  return {
    buffer: await done,
    filename: labelFilename(ctx),
    pageCount: palletCount,
    context: ctx,
  };
}

async function mergeShipmentDocumentMetadata(params: {
  userId: string;
  draftId: string;
  documents: Row;
}) {
  const ctx = await shipmentDocumentContext(params.userId, params.draftId);
  if (!ctx) return;
  const patch = JSON.stringify({ documents: params.documents });
  if (ctx.plan?.id) {
    await pgQuery(
      `UPDATE shipment_plans
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [ctx.plan.id, params.userId, patch],
    ).catch(() => null);
  }
  if (ctx.asn?.id) {
    await pgQuery(
      `UPDATE asns
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [ctx.asn.id, params.userId, patch],
    ).catch(() => null);
  }
}

export async function attemptShipmentVendorEmail(userId: string, draftId: string, log?: FastifyBaseLogger) {
  const pdf = await generateShipmentPalletLabelsPdf(userId, draftId);
  if (!pdf) return { status: 'failed' as VendorEmailStatus, reason: 'shipment_not_found', recipient: null };
  const recipient = String(pdf.context.supplier?.email || '').trim();
  if (!recipient) return { status: 'failed' as VendorEmailStatus, reason: 'supplier_email_missing', recipient: null };
  if (!config.email.smtpHost || !config.email.from) {
    return { status: 'not_configured' as VendorEmailStatus, reason: 'email_provider_not_configured', recipient };
  }
  if (config.email.queueOnly) {
    return { status: 'queued' as VendorEmailStatus, recipient };
  }
  try {
    const transport = nodemailer.createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      secure: config.email.smtpSecure,
      auth: config.email.smtpUser ? { user: config.email.smtpUser, pass: config.email.smtpPass } : undefined,
    });
    await transport.sendMail({
      from: config.email.from,
      to: recipient,
      subject: `Required pallet labels for ${pdf.context.asn?.asn_number || 'your UnieConnect shipment'}`,
      text: [
        'Attached are the required UnieConnect ASN pallet labels.',
        'Please print the PDF and place one label on each pallet before pickup.',
        'The shipment ASN has already been created in UnieConnect.',
      ].join('\n\n'),
      attachments: [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }],
    });
    return { status: 'sent' as VendorEmailStatus, recipient };
  } catch (err: any) {
    log?.warn({ err, draftId, recipient }, 'shipment vendor email failed');
    return { status: 'failed' as VendorEmailStatus, reason: err?.message || 'email_send_failed', recipient };
  }
}

export async function retryShipmentVendorEmail(userId: string, draftId: string, log?: FastifyBaseLogger) {
  const vendorEmail = await attemptShipmentVendorEmail(userId, draftId, log);
  const documents = {
    vendorEmail: { ...vendorEmail, attemptedAt: new Date().toISOString() },
  };
  await mergeShipmentDocumentMetadata({ userId, draftId, documents });
  await writeOmsLedgerEvent({
    userId,
    entityType: 'shipment_wizard',
    entityId: draftId,
    eventType: 'vendor_pallet_label_email_retry',
    sourceSystem: 'oms',
    summary: `Vendor pallet label email ${vendorEmail.status}.`,
    payload: documents,
    confidence: vendorEmail.status === 'sent' || vendorEmail.status === 'queued' ? 0.9 : 0.5,
  });
  return vendorEmail;
}

function rangeStart(range: RangeKey): Date {
  const d = new Date();
  if (range === 'today') {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (range === 'mtd') {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  d.setDate(d.getDate() - days);
  return d;
}

function previousRangeStart(range: RangeKey, currentStart: Date): Date {
  const d = new Date(currentStart);
  if (range === 'today') {
    d.setDate(d.getDate() - 1);
    return d;
  }
  if (range === 'mtd') {
    // Same-length window immediately preceding the start of this month.
    d.setMonth(d.getMonth() - 1);
    return d;
  }
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  d.setDate(d.getDate() - days);
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

function marketplaceFilterWhere(alias: string, filter: MarketplaceFilter, values: unknown[]) {
  const clauses: string[] = [];
  if (filter.channelAccountId) {
    values.push(filter.channelAccountId);
    clauses.push(`EXISTS (
      SELECT 1 FROM item_channel_mappings m
      WHERE m.user_id = ${alias}.user_id
        AND m.item_id = ${alias}.id
        AND m.channel_connection_id = $${values.length}
    )`);
  } else if (filter.channel === 'unmapped') {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM item_channel_mappings m
      WHERE m.user_id = ${alias}.user_id
        AND m.item_id = ${alias}.id
    )`);
  } else if (filter.channel) {
    values.push(filter.channel);
    clauses.push(`EXISTS (
      SELECT 1 FROM item_channel_mappings m
      WHERE m.user_id = ${alias}.user_id
        AND m.item_id = ${alias}.id
        AND m.channel = $${values.length}
    )`);
  }
  return clauses;
}

async function getItems(userId: string, limit = 200, filter: MarketplaceFilter = {}) {
  const values: unknown[] = [userId, limit];
  const clauses = ['i.user_id = $1', ...marketplaceFilterWhere('i', filter, values)];
  const data = await rows(
    `SELECT i.* FROM catalog_items i WHERE ${clauses.join(' AND ')} ORDER BY i.updated_at DESC LIMIT $2`,
    values,
  );
  return data;
}

async function getFacilities(userId: string) {
  const data = await rows(
    `SELECT * FROM facilities
     WHERE (user_id = $1 OR user_id IS NULL)
       AND COALESCE(metadata->>'source', '') NOT IN ('sql_default','demo')
     ORDER BY code ASC LIMIT 200`,
    [userId],
  );
  return data;
}

async function tableExists(tableName: string) {
  const found = await one<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [tableName],
  ).catch(() => null);
  return Boolean(found?.exists);
}

async function recentLedger(userId: string, limit = 30) {
  return rows(
    'SELECT id, entity_type, entity_id, event_type, source_system, summary, payload, confidence, created_at FROM oms_execution_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit],
  );
}

async function latestSellerOptimizationSnapshot(userId: string) {
  if (!(await tableExists('oms_seller_optimization_runs'))) return null;
  const row = await one(
    `SELECT sor.*, r.cortex_run_id, r.cortex_status
     FROM oms_seller_optimization_runs sor
     LEFT JOIN oms_intelligence_runs r ON r.id = sor.run_id
     WHERE sor.user_id = $1
     ORDER BY sor.created_at DESC
     LIMIT 1`,
    [userId],
  ).catch(() => null);
  if (!row) return null;
  const sourceSummary = json(row.source_summary, {});
  const summary = json(row.summary, {});
  const source = sourceSummary?.source === 'cortex_webhook' || sourceSummary?.from_cortex || summary?.from_cortex
    ? 'cortex_seller_optimization'
    : 'oms_cached_seller_optimization';
  return {
    id: row.id,
    runId: row.run_id,
    cortexRunId: row.cortex_run_id || sourceSummary?.cortexRunId || null,
    status: row.status,
    summary,
    businessDouble: json(row.business_double, {}),
    inventoryPlan: json(row.inventory_plan, {}),
    sourceSummary,
    confidence: row.confidence == null ? null : Number(row.confidence),
    source,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function hasPlanPayload(value: any) {
  return value && typeof value === 'object' && Object.keys(value).length > 0;
}

function attachCortexSource<T extends Row>(payload: T, snapshot: Awaited<ReturnType<typeof latestSellerOptimizationSnapshot>> | null, fallbackSource: string): T {
  return {
    ...payload,
    source: {
      ...(payload as any).source,
      authority: snapshot?.source || fallbackSource,
      cortexRunId: snapshot?.cortexRunId || null,
      sellerOptimizationRunId: snapshot?.id || null,
      sellerOptimizationStatus: snapshot?.status || null,
      confidence: snapshot?.confidence ?? null,
      generatedAt: snapshot?.updatedAt || snapshot?.createdAt || (payload as any).generatedAt || new Date().toISOString(),
    },
  };
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

function itemInventory(item: Row, filter: MarketplaceFilter = {}) {
  const inv = json(item.wms_inventory, item.wmsInventory || {});
  const stores = inv.shopifyStores && typeof inv.shopifyStores === 'object' ? inv.shopifyStores : {};
  let marketplaceAvailable: number | null = null;
  if (filter.channelAccountId && stores[filter.channelAccountId]) {
    marketplaceAvailable = number(stores[filter.channelAccountId]?.available);
  } else if (filter.channel === 'shopify') {
    const values = Object.values(stores);
    marketplaceAvailable = values.length
      ? values.reduce((sum: number, row: any) => sum + number(row?.available), 0)
      : number(inv.shopify?.available, NaN);
  } else if (filter.channel === 'amazon') {
    marketplaceAvailable = number(inv.amazon?.available ?? inv.amazon?.availableFbaQty, NaN);
  } else if (filter.channel === 'ebay') {
    marketplaceAvailable = number(inv.ebay?.available, NaN);
  }
  const available = marketplaceAvailable != null && Number.isFinite(marketplaceAvailable)
    ? marketplaceAvailable
    : Number.isFinite(Number(inv.available))
      ? number(inv.available)
      : number(inv.shopify?.available ?? inv.ebay?.available ?? inv.amazon?.available ?? 0);
  return { ...inv, available };
}

// Non-warehouse keys in wms_inventory (marketplace channels + scalar fields). A per-warehouse
// entry is keyed by warehouseCode and carries available/onHand — same discrimination used by
// getOmsSkuDetail's skuWarehouses builder.
const WMS_INVENTORY_CHANNEL_KEYS = new Set([
  'shopify', 'shopifyStores', 'amazon', 'ebay', 'walmart', 'available', 'reserved', 'onHand', 'inbound',
]);

/**
 * True NETWORK on-hand for a SKU = sum of the real per-warehouse WMS snapshots stored in
 * catalog_items.wms_inventory (keyed by warehouseCode by applyInventorySnapshot). This is
 * distinct from itemInventory().available, which returns a marketplace-channel figure. Returns
 * { total, warehouseCount, hasWms }; hasWms=false when no warehouse snapshot exists yet.
 */
function wmsNetworkOnHand(item: Row): { total: number; warehouseCount: number; hasWms: boolean } {
  const inv = json(item.wms_inventory, item.wmsInventory || {}) as Record<string, any>;
  let total = 0;
  let warehouseCount = 0;
  for (const [key, val] of Object.entries(inv)) {
    if (!val || typeof val !== 'object' || WMS_INVENTORY_CHANNEL_KEYS.has(key)) continue;
    if (!((val as any).warehouseCode || (val as any).onHand != null || (val as any).available != null)) continue;
    total += number((val as any).available ?? (val as any).onHand);
    warehouseCount += 1;
  }
  return { total, warehouseCount, hasWms: warehouseCount > 0 };
}

function itemDimensions(item: Row) {
  return json(item.dimensions, {});
}

function mapSkuEconomics(row: Row) {
  const payload = json(row.pricing_payload, {});
  const payloadCosts = json(payload.costs, {});
  const costs = {
    ...payloadCosts,
    currentPerUnit: money(row.current_per_unit),
    optimizedPerUnit: money(row.optimized_per_unit),
    receivingPerUnit: money(row.receiving_per_unit),
    prepLabPerUnit: money(row.prep_lab_per_unit),
    pickPerUnit: money(row.pick_per_unit),
    packPerUnit: money(row.pack_per_unit),
    orderHandlingPerUnit: money(row.order_handling_per_unit),
    storagePerUnitMonth: money(row.storage_per_unit_month),
    domesticLabelPerUnit: money(row.domestic_label_per_unit),
    transferLtlPerUnit: money(row.transfer_ltl_per_unit),
    totalPerUnit: money(row.total_per_unit ?? row.current_per_unit),
  };
  return {
    id: row.id,
    itemId: row.item_id,
    sku: row.sku,
    workflowType: row.workflow_type,
    anchorWarehouseCode: row.anchor_warehouse_code,
    rateShopScope: row.rate_shop_scope,
    sourceQuality: row.source_quality,
    confidence: number(row.confidence),
    currency: row.currency || 'USD',
    costs,
    blockers: json(row.blockers, []),
    sourceLabels: json(row.source_labels, []),
    quantityRecommendation: json(row.quantity_recommendation, {}),
    runId: row.run_id,
    pricingPayload: payload,
    generatedAt: iso(row.generated_at),
    expiresAt: iso(row.expires_at),
  };
}

async function latestSkuFulfillmentEconomics(userId: string, itemId: string) {
  const exists = await tableExists('oms_sku_fulfillment_economics');
  if (!exists) return [];
  const data = await rows(
    `SELECT DISTINCT ON (workflow_type, COALESCE(anchor_warehouse_code, '')) *
     FROM oms_sku_fulfillment_economics
     WHERE user_id = $1 AND item_id = $2
     ORDER BY workflow_type, COALESCE(anchor_warehouse_code, ''), generated_at DESC`,
    [userId, itemId],
  ).catch(() => []);
  return data.map(mapSkuEconomics);
}

function mapAmazonProfile(row: Row | null) {
  if (!row) return null;
  const blockers = Array.isArray(row.blockers) ? row.blockers : [];
  const listingStatus = row.listing_status || 'needs_listing';
  const fulfillmentChannel = row.fulfillment_channel || 'UNKNOWN';
  const fbaEligible = ['listed', 'active'].includes(listingStatus)
    && ['AMAZON', 'FBA'].includes(fulfillmentChannel)
    && blockers.length === 0;
  const hasFbaInventorySignal =
    number(row.available_fba_qty) > 0 ||
    number(row.inbound_working_qty) > 0 ||
    number(row.inbound_shipped_qty) > 0 ||
    number(row.inbound_receiving_qty) > 0 ||
    number(row.reserved_qty) > 0 ||
    String(row.sync_status || '').includes('inventory');
  const identityState = fbaEligible
    ? 'FBA shipment eligible'
    : hasFbaInventorySignal
      ? 'Amazon FBA inventory synced'
      : row.asin
        ? 'Amazon listing mapped'
        : 'Needs Amazon listing setup';
  return {
    id: row.id,
    itemId: row.item_id,
    marketplaceId: row.marketplace_id || 'ATVPDKIKX0DER',
    sellerSku: row.seller_sku,
    asin: row.asin,
    title: row.title,
    listingStatus,
    fulfillmentChannel,
    availableFbaQty: number(row.available_fba_qty),
    inboundWorkingQty: number(row.inbound_working_qty),
    inboundShippedQty: number(row.inbound_shipped_qty),
    inboundReceivingQty: number(row.inbound_receiving_qty),
    reservedQty: number(row.reserved_qty),
    syncStatus: row.sync_status || 'manual',
    lastAmazonSyncAt: iso(row.last_amazon_sync_at),
    blockers,
    fbaEligible,
    identityState,
  };
}

async function getAmazonProfilesForItems(userId: string, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, ReturnType<typeof mapAmazonProfile>>();
  if (!(await tableExists('amazon_item_profiles'))) return new Map<string, ReturnType<typeof mapAmazonProfile>>();
  const profiles = await rows(
    `SELECT DISTINCT ON (item_id) *
     FROM amazon_item_profiles
     WHERE user_id = $1 AND item_id = ANY($2::text[])
     ORDER BY item_id, COALESCE(last_amazon_sync_at, updated_at, created_at) DESC`,
    [userId, itemIds],
  );
  return new Map(profiles.map((profile) => [String(profile.item_id), mapAmazonProfile(profile)]));
}

function mapSkuPlan(item: Row, index: number, velocityBySku: Map<string, number>, facilitiesCount: number, filter: MarketplaceFilter = {}) {
  const metadata = json(item.metadata, {});
  const inv = itemInventory(item, filter);
  const available = number(inv.available);
  const velocity = Math.max(0, number(velocityBySku.get(item.sku)));
  const daysOfCover = velocity > 0 ? Math.round((available / velocity) * 30) : 0;
  const proposedUnits = velocity > 0 ? Math.max(velocity * 2, Math.ceil(velocity * 1.4)) : 0;
  const dim = itemDimensions(item);
  const cube = (number(dim.length) * number(dim.width) * number(dim.height)) / 1728;
  const weight = number(item.weight);
  const risk = velocity === 0 ? 'needs_sales_data' : daysOfCover < 14 ? 'high' : daysOfCover < 30 ? 'medium' : 'low';

  // ---- Reorder-needed (external supply loop) ------------------------------------------------
  // Only for products where the client enabled auto-replenishment on the SKU page (cached into
  // metadata.replenishment by the profile POST). This is a SUGGESTION, isolated from the
  // internal warehouse forward-pick loop (different lead time entirely).
  //
  // UNITS/SOURCE (pinned): `velocity` is a 30-DAY total → per-day = velocity/30. The reorder
  // trigger keys off TRUE NETWORK on-hand summed from the WMS per-warehouse snapshots
  // (wmsNetworkOnHand), NOT the marketplace-channel `available` used for the display column —
  // because reordering from the supplier is about physical stock across the warehouse network.
  // Falls back to the channel `available` only when no WMS snapshot exists yet (un-synced SKU),
  // so nothing regresses before inventory flows.
  const REORDER_DEFAULT_LEAD_DAYS = 7;
  const REORDER_SAFETY_BUFFER_DAYS = 3;
  const REORDER_COVER_TARGET_DAYS = 30; // reorder up to ~30 days of cover
  const repl = json(metadata.replenishment, {});
  // Auto-replenishment reorder alerts default ON (opt-out): a SKU is enabled unless the seller
  // explicitly turned it off. Never-configured SKUs (no cached metadata.replenishment) → ON.
  const reorderEnabled = repl?.enabled !== false;
  const perDay = velocity / 30;
  const netOnHand = wmsNetworkOnHand(item);
  const reorderOnHand = netOnHand.hasWms ? netOnHand.total : available;
  const reorderDaysOfCover = perDay > 0 ? Math.round((reorderOnHand / perDay)) : 0;
  const supplierLeadTimeDays = Number.isFinite(Number(repl?.supplierLeadTimeDays)) && Number(repl?.supplierLeadTimeDays) > 0
    ? Number(repl.supplierLeadTimeDays)
    : REORDER_DEFAULT_LEAD_DAYS;
  const reorderThresholdDays = supplierLeadTimeDays + REORDER_SAFETY_BUFFER_DAYS;
  const reorderNeeded = reorderEnabled && perDay > 0 && reorderDaysOfCover <= reorderThresholdDays;
  const suggestedReorderQty = reorderNeeded
    ? Math.max(0, Math.ceil(perDay * (supplierLeadTimeDays + REORDER_COVER_TARGET_DAYS)) - reorderOnHand)
    : 0;
  const reorderReason = reorderNeeded
    ? `~${reorderDaysOfCover}d of network cover (${reorderOnHand} on hand${netOnHand.hasWms ? '' : ', channel est.'}) vs ${supplierLeadTimeDays}d supplier lead time — reorder ~${suggestedReorderQty} units`
    : '';

  const asin = String(item.asin || '').trim();
  const keepaEnrichmentState =
    metadata.keepaEnrichmentState ||
    metadata.keepa_enrichment_state ||
    (asin ? 'needs_retry' : 'missing_asin');
  const keepaMarker = keepaMarkerForState(keepaEnrichmentState);
  const keepaUnavailable = Boolean(keepaMarker);
  return {
    id: String(item.id),
    sku: item.sku,
    title: item.title,
    // Product image for the SKUs table thumbnail. Same source the detail-page hero uses
    // (catalog_items.image), with the images[] JSONB array as a fallback. Was previously
    // omitted here, so the list always fell through to the box-icon placeholder.
    image: item.image || (Array.isArray(item.images) ? item.images[0] : json(item.images, [])[0]) || null,
    supplierId: item.supplier_id || null,
    asin: asin || null,
    enrichmentState: keepaEnrichmentState,
    keepaUnavailable,
    enrichmentMarker: keepaMarker,
    available,
    inbound: number(inv.inbound),
    velocity30d: velocity,
    daysOfCover,
    risk,
    // Network on-hand summed from WMS per-warehouse snapshots (distinct from the channel
    // `available` column). Drives the reorder trigger; exposed for transparency.
    networkOnHand: netOnHand.hasWms ? netOnHand.total : null,
    reorderNeeded,
    reorderReason,
    suggestedReorderQty,
    reorderDaysOfCover: reorderEnabled && perDay > 0 ? reorderDaysOfCover : null,
    supplierLeadTimeDays: reorderEnabled ? supplierLeadTimeDays : null,
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

function keepaMarkerForState(state: unknown) {
  const normalized = String(state || '').toLowerCase();
  return normalized === 'keepa_unavailable' || normalized === 'missing_asin' ? '*' : '';
}

function itemHasCompleteDimensions(item: Row | null) {
  const dim = itemDimensions(item || {});
  return number(dim.length) > 0 && number(dim.width) > 0 && number(dim.height) > 0;
}

function itemPrice(item: Row | null) {
  const metadata = json(item?.metadata, {});
  const attributes = json(item?.attributes, {});
  return number(attributes.price ?? metadata.price ?? metadata.shopifyPrice ?? metadata.sellingPrice);
}

function itemCost(item: Row | null) {
  const metadata = json(item?.metadata, {});
  const attributes = json(item?.attributes, {});
  return number(attributes.cost ?? metadata.cost ?? metadata.unitCost);
}

function skuHistoryTimeline(item: Row, shipmentPlans: Row[], asns: Row[], activityLogs: Row[], ledgerRows: Row[]) {
  const records: Array<{ ts: string; type: string; actor: string; subject: string; impact?: number | null }> = [];

  shipmentPlans.forEach((plan) => {
    const lines = itemLines(plan.items);
    const units = sumItemUnits(lines.filter((line) => String(line.sku || line.wmsSku || '').toLowerCase() === String(item.sku).toLowerCase()));
    records.push({
      ts: iso(plan.created_at) || '',
      type: 'shipment',
      actor: plan.created_by || 'OMS shipment planner',
      subject: `${plan.internal_shipment_id || plan.shipment_title || 'Shipment plan'} created${units ? ` · ${units} units` : ''}`,
      impact: null,
    });
  });

  asns.forEach((asn) => {
    const payload = json(asn.payload, {});
    const lines = itemLines(payload.selectedItems || payload.items);
    const units = sumItemUnits(lines.filter((line) => String(line.sku || line.wmsSku || '').toLowerCase() === String(item.sku).toLowerCase()));
    const wms = payload.wmsExecution || {};
    records.push({
      ts: iso(asn.created_at) || '',
      type: 'shipment',
      actor: wms.warehouseCode ? `WMS ${wms.warehouseCode}` : 'OMS/WMS',
      subject: `${asn.asn_number || wms.asnNumber || 'ASN'} ${asn.status || 'created'}${units ? ` · ${units} units` : ''}`,
      impact: null,
    });
  });

  activityLogs.forEach((log) => {
    records.push({
      ts: iso(log.created_at) || '',
      type: 'shipment',
      actor: log.internal_shipment_id || log.shipment_title || 'Shipment activity',
      subject: log.summary || log.action || 'Shipment activity recorded',
      impact: null,
    });
  });

  ledgerRows.forEach((event) => {
    const type = String(event.entity_type || event.event_type || '').includes('shipment') || String(event.payload || '').includes('asn')
      ? 'shipment'
      : String(event.source_system || '').includes('cortex')
        ? 'ai'
        : 'ledger';
    records.push({
      ts: iso(event.created_at) || '',
      type,
      actor: event.source_system || 'OMS ledger',
      subject: event.summary || event.event_type || 'Ledger event',
      impact: null,
    });
  });

  return records
    .filter((record) => record.ts)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, 100);
}

export async function getCommandCenter(userId: string, range: RangeKey) {
  const start = rangeStart(range);
  const prevStart = previousRangeStart(range, start);
  const [current, previous, units, previousUnits, counts, items, plan] = await Promise.all([
    orderSummary(userId, start),
    orderSummary(userId, prevStart, start),
    getUnitsSold(userId, start),
    getUnitsSold(userId, prevStart, start),
    baseCounts(userId),
    getItems(userId),
    getInventoryPlan(userId).catch(() => ({ skus: [] as any[] })),
  ]);
  const aov = current.orders > 0 ? money(current.revenue / current.orders) : 0;
  const grossProfit = money(current.revenue * 0.36);
  const lowStock = items.filter((i) => number(itemInventory(i).available) <= 10).length;
  const unmapped = items.filter((i) => !i.supplier_id).length;
  // Reorder-needed rollup (external supply loop): count SKUs the client enabled auto-replenish
  // on that are projected to stock out within their supplier lead time (computed in mapSkuPlan).
  const reorderCount = ((plan as any)?.skus || []).filter((s: any) => s?.reorderNeeded === true).length;

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
      ...(reorderCount ? [{ severity: 'high', title: 'Reorder needed', detail: `${reorderCount} product${reorderCount === 1 ? '' : 's'} will stock out within supplier lead time — review reorder suggestions.` }] : []),
      ...(lowStock ? [{ severity: 'high', title: 'Inventory risk', detail: `${lowStock} SKUs are at or below 10 available units.` }] : []),
      ...(unmapped ? [{ severity: 'medium', title: 'Supplier mapping gap', detail: `${unmapped} SKUs are missing supplier assignment for shipment planning.` }] : []),
      ...(counts.channels === 0 ? [{ severity: 'high', title: 'No marketplace connection', detail: 'Connect Amazon, Shopify, or eBay to keep OMS forecasts live.' }] : []),
    ],
    autonomousActivity: [
      { system: 'OMS', action: 'Demand forecast refreshed', status: 'complete', confidence: 0.91, at: new Date().toISOString() },
      { system: 'WMS', action: 'Inventory truth projection checked', status: counts.facilities ? 'complete' : 'pending_connection', confidence: counts.facilities ? 0.86 : 0.42, at: new Date().toISOString() },
      { system: 'Cortex', action: 'Dispatch orchestration readiness scored', status: cortexConfigStatus().configured ? 'ready' : 'limited', confidence: cortexConfigStatus().configured ? 0.89 : 0.35, at: new Date().toISOString() },
    ],
    counts,
  };
}

export async function getBusinessDouble(userId: string) {
  const [counts, thirty, snapshot] = await Promise.all([
    baseCounts(userId),
    orderSummary(userId, rangeStart('30d')),
    latestSellerOptimizationSnapshot(userId),
  ]);
  const currentMonthlyCost = money(counts.items * 2.75 + counts.orders * 1.35 + counts.shipmentPlans * 42);
  const optimizedMonthlyCost = money(currentMonthlyCost * 0.82);
  const localPlan = {
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
  const cortexBusinessDouble = hasPlanPayload(snapshot?.businessDouble)
    ? {
        ...localPlan,
        ...snapshot?.businessDouble,
        id: snapshot?.businessDouble?.id || `cortex-${snapshot?.id}`,
        status: snapshot?.businessDouble?.status || 'draft',
        title: snapshot?.businessDouble?.title || localPlan.title,
        summary: snapshot?.businessDouble?.summary || localPlan.summary,
        forecastHorizonMonths: snapshot?.businessDouble?.forecastHorizonMonths || snapshot?.businessDouble?.forecast_horizon_months || localPlan.forecastHorizonMonths,
        currentMetrics: snapshot?.businessDouble?.currentMetrics || snapshot?.businessDouble?.current_metrics || localPlan.currentMetrics,
        optimizedMetrics: snapshot?.businessDouble?.optimizedMetrics || snapshot?.businessDouble?.optimized_metrics || localPlan.optimizedMetrics,
        savings: snapshot?.businessDouble?.savings || localPlan.savings,
      }
    : null;
  const plan = attachCortexSource(cortexBusinessDouble || localPlan, snapshot, cortexBusinessDouble ? 'cortex_seller_optimization' : 'local_fallback_business_double');

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

  const decisionContext = buildOmsDecisionContext(plan);
  const cortex = await postCortex('/v1/oms/business-double/approved', {
    userId,
    recommendationId: planId,
    planId: stored?.id || planId,
    plan,
    ...decisionContext,
    approvalActor: approvedBy || userId,
    decisionLifecycle: 'approved',
    approvedAt: new Date().toISOString(),
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));

  return { approved: true, planId: stored?.id || planId, stored, cortex };
}

export async function getInventoryPlan(userId: string, horizon = '6m', filter: MarketplaceFilter = {}) {
  const velocityValues: unknown[] = [userId, rangeStart('30d')];
  const velocityClauses = ['ol.user_id = $1', 'COALESCE(o.placed_at, o.created_at) >= $2'];
  if (filter.channelAccountId) {
    velocityValues.push(filter.channelAccountId);
    velocityClauses.push(`o.channel_connection_id = $${velocityValues.length}`);
  } else if (filter.channel && filter.channel !== 'unmapped') {
    velocityValues.push(filter.channel);
    velocityClauses.push(`COALESCE(o.channel, mc.channel) = $${velocityValues.length}`);
  } else if (filter.channel === 'unmapped') {
    velocityClauses.push('o.channel_connection_id IS NULL');
  }
  const [items, facilities, velocityRows, snapshot] = await Promise.all([
    getItems(userId, 200, filter),
    getFacilities(userId),
    rows<{ sku: string; units: string }>(
      `SELECT ol.sku, COALESCE(SUM(ol.quantity), 0)::text AS units
       FROM order_lines ol
       INNER JOIN orders o ON o.id = ol.order_id
       LEFT JOIN marketplace_connections mc ON mc.id = o.channel_connection_id
       WHERE ${velocityClauses.join(' AND ')}
       GROUP BY ol.sku`,
      velocityValues,
    ),
    latestSellerOptimizationSnapshot(userId),
  ]);
  const velocityBySku = new Map(velocityRows.map((row) => [String(row.sku || ''), number(row.units)]));
  const planSkus = items.map((item, index) => mapSkuPlan(item, index, velocityBySku, facilities.length, filter));
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

  const localPlan = {
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
  const cortexInventoryPlan = hasPlanPayload(snapshot?.inventoryPlan)
    ? {
        ...localPlan,
        ...snapshot?.inventoryPlan,
        horizon: snapshot?.inventoryPlan?.horizon || horizon,
        generatedAt: snapshot?.updatedAt || snapshot?.createdAt || localPlan.generatedAt,
        current: snapshot?.inventoryPlan?.current || localPlan.current,
        proposed: snapshot?.inventoryPlan?.proposed || localPlan.proposed,
        months: Array.isArray(snapshot?.inventoryPlan?.months) ? snapshot?.inventoryPlan?.months : localPlan.months,
        skus: Array.isArray(snapshot?.inventoryPlan?.skus) && snapshot?.inventoryPlan?.skus.length ? snapshot?.inventoryPlan?.skus : localPlan.skus,
        warehouses: Array.isArray(snapshot?.inventoryPlan?.warehouses) ? snapshot?.inventoryPlan?.warehouses : localPlan.warehouses,
      }
    : null;
  return attachCortexSource(cortexInventoryPlan || localPlan, snapshot, cortexInventoryPlan ? 'cortex_seller_optimization' : 'local_fallback_inventory_plan');
}

export async function getOmsSkus(userId: string, filter: MarketplaceFilter = {}) {
  const plan = await getInventoryPlan(userId, '6m', filter);
  const planSkus = Array.isArray((plan as any).skus) ? (plan as any).skus : [];
  const amazonProfiles = await getAmazonProfilesForItems(userId, planSkus.map((sku: any) => String(sku.id)).filter(Boolean));
  const skus = planSkus.map((sku: any) => ({
    ...sku,
    amazon: amazonProfiles.get(String(sku.id)) || null,
  }));
  return { skus, total: skus.length };
}

export async function getOmsSkuDetail(userId: string, skuOrId: string) {
  const item = (await one(
    'SELECT * FROM catalog_items WHERE user_id = $1 AND (id = $2 OR sku = $2) LIMIT 1',
    [userId, skuOrId],
  )) as Row | null;
  if (!item) return null;
  const plan = await getInventoryPlan(userId);
  const intelligence = (Array.isArray((plan as any).skus) ? (plan as any).skus : []).find((s: any) => s.sku === item.sku);
  const activityPlans = await rows(
    `SELECT * FROM shipment_plans
     WHERE user_id = $1 AND items::text ILIKE $2
     ORDER BY created_at DESC LIMIT 10`,
    [userId, `%${item.sku}%`],
  );
  const asnRows = await rows(
    `SELECT a.*, sp.internal_shipment_id, sp.shipment_title
     FROM asns a
     LEFT JOIN shipment_plans sp ON sp.id = a.shipment_plan_id AND sp.user_id = a.user_id
     WHERE a.user_id = $1
       AND (a.payload::text ILIKE $2 OR sp.items::text ILIKE $2)
     ORDER BY a.created_at DESC LIMIT 25`,
    [userId, `%${item.sku}%`],
  );
  const activityLogs = await rows(
    `SELECT sal.*, sp.internal_shipment_id, sp.shipment_title
     FROM shipment_activity_log sal
     LEFT JOIN shipment_plans sp ON sp.id = sal.shipment_plan_id AND sp.user_id = sal.user_id
     WHERE sal.user_id = $1
       AND (sal.payload::text ILIKE $2 OR sal.summary ILIKE $2 OR sp.items::text ILIKE $2)
     ORDER BY sal.created_at DESC LIMIT 25`,
    [userId, `%${item.sku}%`],
  );
  const ledgerRows = await rows(
    `SELECT id, entity_type, entity_id, event_type, source_system, summary, payload, confidence, created_at
     FROM oms_execution_ledger
     WHERE user_id = $1
       AND (
         entity_id = $2
         OR entity_id = $3
         OR payload::text ILIKE $4
         OR summary ILIKE $4
       )
     ORDER BY created_at DESC LIMIT 50`,
    [userId, item.id, item.sku, `%${item.sku}%`],
  );
  const facilities = await getFacilities(userId);

  // Build the REAL per-warehouse inventory for this SKU. The WMS pushes an inventory_snapshot
  // per warehouse into catalog_items.wms_inventory keyed by warehouseCode (applyInventorySnapshot
  // in wms-integration.routes). Non-warehouse keys are marketplace channels (shopify/amazon/
  // ebay/shopifyStores) — a warehouse entry is distinguished by carrying warehouseCode/onHand.
  // Only surface warehouses that actually have a WMS snapshot for THIS sku (not every facility),
  // so the count + numbers are truthful instead of placeholder zeros.
  const wmsInv = json(item.wms_inventory, {}) as Record<string, any>;
  const CHANNEL_KEYS = new Set(['shopify', 'shopifyStores', 'amazon', 'ebay', 'walmart', 'available', 'reserved', 'onHand', 'inbound']);
  const facilityByCode = new Map(
    facilities.map((f: any) => [String(f.code || '').toUpperCase(), f]),
  );
  const skuVelocityPerDay = number((intelligence as any)?.velocity30d ?? (intelligence as any)?.velocityPerDay, 0) || 0;
  const skuWarehouses = Object.entries(wmsInv)
    .filter(([key, val]) =>
      val && typeof val === 'object' && !CHANNEL_KEYS.has(key) &&
      ((val as any).warehouseCode || (val as any).onHand != null || (val as any).available != null),
    )
    .map(([key, val]) => {
      const code = String((val as any).warehouseCode || key).toUpperCase();
      const fac = facilityByCode.get(code);
      const available = number((val as any).available ?? (val as any).onHand, 0);
      const inbound = number((val as any).inbound, 0);
      const velocity = skuVelocityPerDay; // per-SKU network velocity (no per-wh split available yet)
      const daysOfCover = velocity > 0 ? Math.round((available / velocity) * 10) / 10 : (available > 0 ? 999 : 0);
      return {
        code,
        name: fac?.name || (val as any).name || code,
        region: fac?.region || (fac?.metadata as any)?.region || undefined,
        available,
        inbound,
        velocityPerDay: velocity,
        daysOfCover,
        storageCost: 0,
        status: available > 0 ? 'stocked' : 'empty',
        updatedAt: (val as any).updatedAt || null,
        hasWmsData: true,
      };
    })
    .sort((a, b) => b.available - a.available);

  const amazonProfile = (await tableExists('amazon_item_profiles'))
    ? await one(
        `SELECT *
         FROM amazon_item_profiles
         WHERE user_id = $1 AND item_id = $2
         ORDER BY COALESCE(last_amazon_sync_at, updated_at, created_at) DESC LIMIT 1`,
        [userId, item.id],
      )
    : null;
  // Keepa enrichment is best-effort and never fails the SKU response.
  const asin = (item.asin || '').trim().toUpperCase() || null;
  const metadata = json(item.metadata, {});
  const attributes = json(item.attributes, {});
  const upc = item.upc || metadata.upc || attributes.upc || null;
  const ean = item.ean || metadata.ean || attributes.ean || null;
  const hasKeepaIdentifier = Boolean(asin || upc || ean);
  const existingKeepaState = metadata.keepaEnrichmentState || metadata.keepa_enrichment_state;
  let keepaEnrichmentState = existingKeepaState === 'manual_override'
    ? 'manual_override'
    : hasKeepaIdentifier
      ? 'needs_retry'
      : 'missing_asin';
  let keepa: any = null;
  if (hasKeepaIdentifier) {
    try {
      const snap = await getKeepaSnapshotForIdentifiers({
        asin,
        upc,
        ean,
      });
      if (snap && snap.ok) {
        keepa = {
          asin: snap.asin,
          title: snap.title,
          brand: snap.brand,
          category: snap.category,
          buyboxPrice: snap.buybox_price_cents != null ? snap.buybox_price_cents / 100 : null,
          salesRank: snap.sales_rank,
          rating: snap.rating,
          reviewCount: snap.review_count,
          dimensions: {
            lengthIn: snap.length_in,
            widthIn: snap.width_in,
            heightIn: snap.height_in,
          },
          weightLb: snap.weight_lb,
          fetchedAt: snap.fetched_at,
          expiresAt: snap.expires_at,
        };
        if (keepaEnrichmentState !== 'manual_override') keepaEnrichmentState = 'keepa_enriched';
      } else if (keepaEnrichmentState !== 'manual_override') {
        keepaEnrichmentState = 'keepa_unavailable';
      }
    } catch {
      if (keepaEnrichmentState !== 'manual_override') keepaEnrichmentState = 'keepa_unavailable';
    }
  }
  const keepaMarker = keepaMarkerForState(keepaEnrichmentState);
  if (
    metadata.keepaEnrichmentState !== keepaEnrichmentState ||
    metadata.keepaEnrichmentMarker !== keepaMarker
  ) {
    metadata.keepaEnrichmentState = keepaEnrichmentState;
    metadata.keepaEnrichmentMarker = keepaMarker;
    metadata.keepaEnrichmentUpdatedAt = new Date().toISOString();
    await pgQuery(
      `UPDATE catalog_items
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
       WHERE id = $1 AND user_id = $2`,
      [
        item.id,
        userId,
        JSON.stringify({
          keepaEnrichmentState: metadata.keepaEnrichmentState,
          keepaEnrichmentMarker: metadata.keepaEnrichmentMarker,
          keepaEnrichmentUpdatedAt: metadata.keepaEnrichmentUpdatedAt,
        }),
      ],
    ).catch(() => null);
  }
  // Fallbacks for missing local dims/weight when Keepa has them
  const dimsLocal = itemDimensions(item);
  const dims = {
    length: dimsLocal?.length || keepa?.dimensions?.lengthIn || null,
    width: dimsLocal?.width || keepa?.dimensions?.widthIn || null,
    height: dimsLocal?.height || keepa?.dimensions?.heightIn || null,
  };
  const weight = (item.weight && Number(item.weight) > 0) ? Number(item.weight) : (keepa?.weightLb || null);
  const images = Array.isArray(item.images) ? item.images : Array.isArray(metadata.images) ? metadata.images : [];
  const fulfillmentEconomics = await latestSkuFulfillmentEconomics(userId, item.id);
  const description = item.description || metadata.description || attributes.description || keepa?.description || '';
  const brand = metadata.brand || metadata.manufacturer || attributes.brand || keepa?.brand || '';
  const subtitle = metadata.subtitle || metadata.subTitle || attributes.subtitle || item.sub_category || item.category || '';
  return {
    id: item.id,
    sku: item.sku,
    title: item.title,
    subtitle,
    description,
    asin,
    upc: item.upc || metadata.upc || attributes.upc || null,
    ean: item.ean || metadata.ean || attributes.ean || null,
    brand,
    category: item.category || metadata.category || keepa?.category || null,
    subCategory: item.sub_category || metadata.subCategory || metadata.sub_category || null,
    image: item.image || null,
    images: images.filter(Boolean),
    supplierId: item.supplier_id || null,
    enrichmentState: keepaEnrichmentState,
    keepaUnavailable: Boolean(keepaMarker),
    enrichmentMarker: keepaMarker,
    dimensions: dims,
    weight,
    price: itemPrice(item) || keepa?.buyboxPrice || null,
    cost: itemCost(item),
    margin: metadata.margin ?? attributes.margin ?? null,
    attributes,
    metadata,
    intelligence,
    fulfillmentEconomics,
    amazon: mapAmazonProfile(amazonProfile),
    keepa,
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
    // Real per-warehouse inventory for this SKU (from WMS snapshots). Empty until the WMS has
    // pushed an inventory_snapshot for this SKU — the UI shows an honest "no WMS inventory yet"
    // state rather than a row of placeholder zeros for every facility.
    warehouses: skuWarehouses,
    history: skuHistoryTimeline(item, activityPlans, asnRows, activityLogs, ledgerRows),
    billing: {
      currentMonthly: 120,
      optimizedMonthly: 98.4,
      drivers: ['storage', 'handling', 'freight allocation', 'label service'],
    },
  };
}

const cleanText = (value: unknown) => {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  return text || null;
};

const cleanNumber = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function updateOmsSkuEnrichment(userId: string, skuOrId: string, input: any) {
  const current = await one<Row>(
    'SELECT * FROM catalog_items WHERE user_id = $1 AND (id = $2 OR sku = $2) LIMIT 1',
    [userId, skuOrId],
  );
  if (!current) return null;

  const metadata = { ...json(current.metadata, {}) };
  const attributes = { ...json(current.attributes, {}) };
  const dimensions = { ...json(current.dimensions, {}) };

  const setMeta = (key: string, value: unknown) => {
    if (value !== undefined) metadata[key] = value;
  };
  const setAttr = (key: string, value: unknown) => {
    if (value !== undefined) attributes[key] = value;
  };

  const title = cleanText(input.title);
  const description = cleanText(input.description);
  const subtitle = cleanText(input.subtitle);
  const brand = cleanText(input.brand);
  const size = cleanText(input.size);
  const upc = cleanText(input.upc);
  const ean = cleanText(input.ean);
  const asinInput = cleanText(input.asin);
  const asin = asinInput ? asinInput.toUpperCase() : asinInput;
  const category = cleanText(input.category);
  const subCategory = cleanText(input.subCategory);
  const supplierId = cleanText(input.supplierId);
  const marketplaceSource = cleanText(input.marketplaceSource);
  const price = cleanNumber(input.price);
  const cost = cleanNumber(input.cost);
  const weight = cleanNumber(input.weight);

  setMeta('subtitle', subtitle);
  setMeta('brand', brand);
  setMeta('price', price);
  setMeta('cost', cost);
  setMeta('source', marketplaceSource);
  setAttr('size', size);

  if (asin !== undefined && metadata.keepaEnrichmentState !== 'manual_override') {
    const nextAsin = asin || null;
    metadata.keepaEnrichmentState = nextAsin ? 'needs_retry' : 'missing_asin';
    metadata.keepaEnrichmentMarker = '';
    metadata.keepaEnrichmentUpdatedAt = new Date().toISOString();
  }

  if (input.dimensions && typeof input.dimensions === 'object') {
    const length = cleanNumber(input.dimensions.length);
    const width = cleanNumber(input.dimensions.width);
    const height = cleanNumber(input.dimensions.height);
    if (length !== undefined) dimensions.length = length;
    if (width !== undefined) dimensions.width = width;
    if (height !== undefined) dimensions.height = height;
  }

  const images = input.images === undefined
    ? undefined
    : Array.isArray(input.images)
      ? input.images.map((url: unknown) => cleanText(url)).filter(Boolean)
      : [];
  if (images !== undefined) setMeta('images', images);

  const updated = await one<Row>(
    `UPDATE catalog_items
     SET title = COALESCE($3, title),
         description = $4,
         metadata = $5::jsonb,
         attributes = $6::jsonb,
         supplier_id = $7,
         images = COALESCE($8::jsonb, images),
         image = CASE WHEN $8::jsonb IS NULL THEN image ELSE $9 END,
         upc = $10,
         ean = $11,
         asin = $12,
         category = $13,
         sub_category = $14,
         weight = $15,
         dimensions = $16::jsonb,
         updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      current.id,
      userId,
      title === undefined ? null : title,
      description === undefined ? current.description : description,
      JSON.stringify(metadata),
      JSON.stringify(attributes),
      supplierId === undefined ? current.supplier_id : supplierId,
      images === undefined ? null : JSON.stringify(images),
      images?.[0] || null,
      upc === undefined ? current.upc : upc,
      ean === undefined ? current.ean : ean,
      asin === undefined ? current.asin : asin,
      category === undefined ? current.category : category,
      subCategory === undefined ? current.sub_category : subCategory,
      weight === undefined ? current.weight : weight,
      JSON.stringify(dimensions),
    ],
  );

  await writeOmsLedgerEvent({
    userId,
    entityType: 'sku',
    entityId: current.id,
    eventType: 'sku_enrichment_updated',
    sourceSystem: 'oms',
    summary: `SKU enrichment updated for ${current.sku}.`,
    payload: { sku: current.sku, fields: Object.keys(input || {}) },
    confidence: null,
  });

  return getOmsSkuDetail(userId, updated?.id || current.id);
}

export async function getOmsOrders(userId: string, filter: MarketplaceFilter = {}) {
  const values: unknown[] = [userId];
  const where = ['o.user_id = $1'];
  if (filter.channelAccountId) {
    values.push(filter.channelAccountId);
    where.push(`o.channel_connection_id = $${values.length}`);
  } else if (filter.channel && filter.channel !== 'unmapped') {
    values.push(filter.channel);
    where.push(`COALESCE(o.channel, mc.channel) = $${values.length}`);
  } else if (filter.channel === 'unmapped') {
    where.push('o.channel_connection_id IS NULL');
  }
  const orders = await rows(
    `SELECT o.*, c.email AS customer_email, c.name AS customer_name, mc.channel AS account_channel, mc.display_name, mc.shop_domain, mc.selling_partner_id
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN marketplace_connections mc ON mc.id = o.channel_connection_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(o.placed_at, o.created_at) DESC LIMIT 200`,
    values,
  );
  return {
    orders: orders.map((order) => {
      const totals = json(order.totals, {});
      return {
        ...order,
        id: order.id,
        publicId: publicEntityId('OR', order.id),
        displayId: publicEntityId('OR', order.id),
        customerDisplayId: order.customer_id ? publicEntityId('CU', order.customer_id) : null,
        customer: order.customer_name || order.customer_email || undefined,
        ch: order.channel || order.account_channel || 'manual',
        channelAccountId: order.channel_connection_id || null,
        channelDisplay: order.display_name || order.shop_domain || order.selling_partner_id || order.channel || order.account_channel || 'manual',
        total: money(totals.total || totals.subtotal || 0),
        placedAt: iso(order.placed_at),
        createdAt: iso(order.created_at),
        updatedAt: iso(order.updated_at),
      };
    }),
  };
}

export async function getOmsAsns(userId: string) {
  const asns = await rows(
    `SELECT a.*,
            sp.internal_shipment_id,
            sp.shipment_title,
            sp.status AS shipment_status,
            sp.supplier_id,
            sp.facility_id,
            sp.estimated_arrival_date,
            sp.items,
            s.name AS supplier_name,
            f.code AS facility_code,
            f.name AS facility_name
     FROM asns a
     LEFT JOIN shipment_plans sp ON sp.id = a.shipment_plan_id AND sp.user_id = a.user_id
     LEFT JOIN suppliers s ON s.id = sp.supplier_id AND s.user_id = a.user_id
     LEFT JOIN facilities f ON f.id = sp.facility_id
     WHERE a.user_id = $1
     ORDER BY COALESCE(a.updated_at, a.created_at) DESC
     LIMIT 200`,
    [userId],
  );
  return {
    asns: asns.map((asn) => {
      const items = json(asn.items, []);
      const units = Array.isArray(items)
        ? items.reduce((sum, item) => sum + number(item.quantity || item.units || 0), 0)
        : 0;
      return {
        id: asn.id,
        _id: asn.id,
        publicId: publicEntityId('AS', asn.id),
        displayId: publicEntityId('AS', asn.id),
        asnNumber: asn.asn_number,
        status: asn.status || 'created',
        shipmentPlanId: asn.shipment_plan_id,
        shipmentDisplayId: asn.shipment_plan_id ? publicEntityId('SH', asn.shipment_plan_id) : null,
        shipmentTitle: asn.shipment_title || asn.internal_shipment_id || 'Inbound shipment',
        shipmentStatus: asn.shipment_status || null,
        supplierId: asn.supplier_id || null,
        supplierDisplayId: asn.supplier_id ? publicEntityId('SU', asn.supplier_id) : null,
        supplierName: asn.supplier_name || null,
        facilityId: asn.facility_id || null,
        facilityCode: asn.facility_code || null,
        facilityName: asn.facility_name || null,
        estimatedArrivalDate: iso(asn.estimated_arrival_date),
        units,
        payload: json(asn.payload, {}),
        createdAt: iso(asn.created_at),
        updatedAt: iso(asn.updated_at),
      };
    }),
  };
}

export async function getOmsCustomers(userId: string) {
  const customers = await rows('SELECT * FROM customers WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [userId]);
  return {
    customers: customers.map((customer) => ({
      ...customer,
      id: customer.id,
      publicId: publicEntityId('CU', customer.id),
      displayId: publicEntityId('CU', customer.id),
      createdAt: iso(customer.created_at),
      updatedAt: iso(customer.updated_at),
    })),
  };
}

export async function getOmsSuppliers(userId: string) {
  const [suppliers, locations, skuCounts] = await Promise.all([
    rows('SELECT * FROM suppliers WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [userId]),
    rows('SELECT * FROM ship_from_locations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [userId]),
    rows<{ supplier_id: string; sku_count: string }>(
      'SELECT supplier_id, COUNT(*)::text AS sku_count FROM catalog_items WHERE user_id = $1 AND supplier_id IS NOT NULL GROUP BY supplier_id',
      [userId],
    ),
  ]);
  const countBySupplier = new Map(skuCounts.map((row) => [String(row.supplier_id), number(row.sku_count)]));
  return {
    suppliers: suppliers.map((supplier) => mapOmsSupplier(supplier, countBySupplier.get(String(supplier.id)) || 0)),
    locations,
  };
}

export async function getOmsSupplierActivity(userId: string, supplierId: string) {
  const supplier = await one('SELECT * FROM suppliers WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, supplierId]);
  if (!supplier) return null;

  const [skus, shipmentPlans, asns, orderRows, invoiceRows, activityLogs, ledgerRows] = await Promise.all([
    rows(
      `SELECT id, sku, title, wms_inventory, updated_at
       FROM catalog_items
       WHERE user_id = $1 AND supplier_id = $2
       ORDER BY updated_at DESC LIMIT 100`,
      [userId, supplierId],
    ),
    rows(
      `SELECT sp.*, f.code AS facility_code, f.name AS facility_name
       FROM shipment_plans sp
       LEFT JOIN facilities f ON f.id = sp.facility_id
       WHERE sp.user_id = $1 AND sp.supplier_id = $2
       ORDER BY sp.created_at DESC LIMIT 100`,
      [userId, supplierId],
    ),
    rows(
      `SELECT a.*, sp.internal_shipment_id, sp.shipment_title
       FROM asns a
       INNER JOIN shipment_plans sp ON sp.id = a.shipment_plan_id
       WHERE a.user_id = $1 AND sp.supplier_id = $2
       ORDER BY a.created_at DESC LIMIT 100`,
      [userId, supplierId],
    ),
    rows(
      `SELECT o.id, o.order_number, o.status, o.channel, o.placed_at, o.created_at,
              COALESCE(SUM(ol.quantity), 0)::text AS units,
              COALESCE(SUM(ol.total_price), 0)::text AS revenue
       FROM orders o
       INNER JOIN order_lines ol ON ol.order_id = o.id
       INNER JOIN catalog_items ci ON ci.id = ol.item_id
       WHERE o.user_id = $1 AND ci.supplier_id = $2
       GROUP BY o.id
       ORDER BY COALESCE(o.placed_at, o.created_at) DESC LIMIT 100`,
      [userId, supplierId],
    ),
    rows(
      `SELECT il.*, sp.internal_shipment_id, sp.shipment_title
       FROM invoice_lines il
       INNER JOIN shipment_plans sp ON sp.id = il.shipment_plan_id
       WHERE il.user_id = $1 AND sp.supplier_id = $2
       ORDER BY il.created_at DESC LIMIT 100`,
      [userId, supplierId],
    ),
    rows(
      `SELECT sal.*, sp.internal_shipment_id, sp.shipment_title
       FROM shipment_activity_log sal
       INNER JOIN shipment_plans sp ON sp.id = sal.shipment_plan_id
       WHERE sal.user_id = $1 AND sp.supplier_id = $2
       ORDER BY sal.created_at DESC LIMIT 100`,
      [userId, supplierId],
    ),
    rows(
      `SELECT id, entity_type, entity_id, event_type, source_system, summary, payload, confidence, created_at
       FROM oms_execution_ledger
       WHERE user_id = $1
         AND (
           (entity_type = 'supplier' AND entity_id = $2)
           OR payload::text ILIKE $3
         )
       ORDER BY created_at DESC LIMIT 50`,
      [userId, supplierId, `%${supplierId}%`],
    ),
  ]);

  const records: Array<Record<string, unknown>> = [];

  skus.forEach((sku) => {
    const inv = json(sku.wms_inventory, {});
    records.push({
      id: sku.id,
      type: 'sku',
      title: sku.title || sku.sku,
      subtitle: sku.sku,
      status: 'active',
      units: number(inv.available),
      date: iso(sku.updated_at),
      target: 'sku-detail',
      targetId: sku.id,
    });
  });

  shipmentPlans.forEach((plan) => {
    const lines = itemLines(plan.items);
    const units = sumItemUnits(lines);
    records.push({
      id: plan.id,
      type: 'shipment_plan',
      title: plan.shipment_title || plan.internal_shipment_id || 'Shipment plan',
      subtitle: plan.internal_shipment_id || 'OMS shipment',
      status: plan.status || 'draft',
      units,
      date: iso(plan.estimated_arrival_date || plan.order_date || plan.created_at),
      summary: `${lines.length} SKU lines · ${plan.facility_name || plan.facility_code || 'auto-routed warehouse'}`,
      target: 'shipments',
      targetId: plan.id,
    });
    if (requiresPlanDocument(plan, 'requiresBol')) {
      records.push({
        id: `${plan.id}:bol`,
        type: 'bol',
        title: `BOL for ${plan.internal_shipment_id || plan.shipment_title || 'shipment'}`,
        subtitle: 'Bill of lading requirement',
        status: plan.status || 'draft',
        units,
        date: iso(plan.created_at),
        summary: 'Required by shipment plan and visible to Cortex dispatch.',
        target: 'shipments',
        targetId: plan.id,
      });
    }
    if (requiresPlanDocument(plan, 'requiresLabels')) {
      records.push({
        id: `${plan.id}:labels`,
        type: 'label',
        title: `Labels for ${plan.internal_shipment_id || plan.shipment_title || 'shipment'}`,
        subtitle: 'Supplier label submission',
        status: plan.status || 'draft',
        units,
        date: iso(plan.created_at),
        summary: 'Label workflow requested for supplier pickup/receiving.',
        target: 'shipments',
        targetId: plan.id,
      });
    }
  });

  asns.forEach((asn) => {
    const payload = json(asn.payload, {});
    records.push({
      id: asn.id,
      type: 'asn',
      title: asn.asn_number || 'Projected ASN',
      subtitle: asn.shipment_title || asn.internal_shipment_id || 'Advance shipment notice',
      status: asn.status || 'created',
      units: sumItemUnits(itemLines(payload.selectedItems || payload.items)),
      date: iso(asn.created_at),
      summary: payload.requiresWmsTruth ? 'Projected until WMS confirms receiving truth.' : 'ASN created for WMS receiving.',
      target: 'shipments',
      targetId: asn.shipment_plan_id,
    });
  });

  orderRows.forEach((order) => {
    records.push({
      id: order.id,
      type: 'order',
      title: order.order_number || order.id,
      subtitle: order.channel || 'OMS order',
      status: order.status || 'open',
      units: number(order.units),
      amount: money(order.revenue),
      date: iso(order.placed_at || order.created_at),
      summary: 'Demand tied to SKUs supplied by this supplier.',
      target: 'orders',
      targetId: order.id,
    });
  });

  invoiceRows.forEach((line) => {
    records.push({
      id: line.id,
      type: 'invoice',
      title: line.description || 'Supplier-related invoice line',
      subtitle: line.invoice_id || line.internal_shipment_id || 'Billing',
      status: line.status || 'open',
      amount: money(line.amount),
      date: iso(line.created_at),
      summary: line.shipment_title || 'Cost tied to supplier shipment activity.',
      target: 'billing',
      targetId: line.id,
    });
  });

  activityLogs.forEach((log) => {
    records.push({
      id: log.id,
      type: 'activity',
      title: log.action || 'Shipment activity',
      subtitle: log.internal_shipment_id || log.shipment_title || 'Activity log',
      status: 'logged',
      date: iso(log.created_at),
      summary: log.summary || 'Supplier shipment activity recorded.',
      target: 'shipments',
      targetId: log.shipment_plan_id,
    });
  });

  ledgerRows.forEach((event) => {
    records.push({
      id: event.id,
      type: 'ledger',
      title: event.event_type || 'Ledger event',
      subtitle: event.source_system || 'OMS ledger',
      status: 'logged',
      date: iso(event.created_at),
      confidence: event.confidence == null ? null : number(event.confidence),
      summary: event.summary,
      target: 'ledger',
      targetId: event.id,
    });
  });

  records.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  const shipmentUnits = shipmentPlans.reduce((sum, plan) => sum + sumItemUnits(itemLines(plan.items)), 0);
  const orderUnits = orderRows.reduce((sum, order) => sum + number(order.units), 0);
  const documents = records.filter((record) => record.type === 'asn' || record.type === 'bol' || record.type === 'label').length;

  return {
    supplier: mapOmsSupplier(supplier, skus.length),
    summary: {
      skus: skus.length,
      shipmentPlans: shipmentPlans.length,
      asns: asns.length,
      documents,
      orderCount: orderRows.length,
      orderUnits,
      shipmentUnits,
      invoiceAmount: money(invoiceRows.reduce((sum, line) => sum + number(line.amount), 0)),
      lastActivityAt: records[0]?.date || iso(supplier.updated_at),
    },
    records,
  };
}

export async function createShipmentWizardDraft(userId: string, body: any) {
  const draft = {
    id: randomUUID(),
    userId,
    supplierId: body?.supplierId || null,
    status: 'draft',
    requiresBol: body?.requiresBol !== false,
    requiresLabels: true,
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

async function connectedShipmentFacility(userId: string, facilityId?: string | null) {
  if (facilityId) {
    const verified = await one(
      `SELECT f.*
       FROM oms_warehouse_links l
       JOIN facilities f ON f.id = l.facility_id
       WHERE l.user_id = $1
         AND l.status = 'connected'
         AND l.facility_id = $2
       ORDER BY l.connected_at DESC NULLS LAST
       LIMIT 1`,
      [userId, facilityId],
    );
    if (verified) return verified;
  }
  return one(
    `SELECT f.*
     FROM oms_warehouse_links l
     JOIN facilities f ON f.id = l.facility_id
     WHERE l.user_id = $1
       AND l.status = 'connected'
     ORDER BY l.connected_at DESC NULLS LAST
     LIMIT 1`,
    [userId],
  );
}

export async function confirmShipmentWizardDraft(userId: string, draftId: string, body: any, log?: FastifyBaseLogger) {
  const selectedItems = Array.isArray(body?.selectedItems) ? body.selectedItems : [];
  const supplierId = body?.supplierId || null;
  const assignSupplierToSkus = body?.assignSupplierToSkus === true;
  const requiresLabels = true;
  const shipFromLocationId = body?.shipFromLocationId || null;
  const requestedFacilityId = body?.facilityId || null;
  const warehouseRoutingMode = body?.warehouseRoutingMode || null;
  if (selectedItems.length === 0) {
    return {
      status: 'needs_input',
      message: 'Selected items are required before shipment confirmation.',
      requires: ['selectedItems'],
    };
  }

  const selectedItemIds = Array.from(
    new Set(selectedItems.map((item: any) => String(item?.itemId || '').trim()).filter(Boolean)),
  );
  if (selectedItemIds.length !== selectedItems.length) {
    return {
      status: 'needs_input',
      message: 'Every selected SKU must include a valid item id before shipment confirmation.',
      requires: ['selectedItems.itemId'],
    };
  }

  const ownedItems = await rows<{ id: string }>(
    'SELECT id::text AS id FROM catalog_items WHERE user_id = $1 AND id::text = ANY($2::text[])',
    [userId, selectedItemIds],
  );
  if (ownedItems.length !== selectedItemIds.length) {
    return {
      status: 'needs_input',
      message: 'One or more selected SKUs are not available for this account.',
      requires: ['valid_selected_items'],
    };
  }

  const connectedFacility = await connectedShipmentFacility(userId, requestedFacilityId);
  const facility = connectedFacility || (await defaultFacility(userId));
  if (!facility) {
    return {
      status: 'needs_setup',
      message: 'Connect at least one WMS warehouse before confirming an OMS shipment. The OMS can draft intent, but WMS truth is required before ASN execution.',
      requires: ['wms_facility_connection'],
    };
  }
  const shipFrom = shipFromLocationId ? await one('SELECT * FROM ship_from_locations WHERE id = $1 AND user_id = $2', [shipFromLocationId, userId]) : null;
  const supplier = supplierId ? await one('SELECT * FROM suppliers WHERE id = $1 AND user_id = $2', [supplierId, userId]) : null;
  if (supplierId && !supplier) {
    return {
      status: 'needs_input',
      message: 'Selected supplier is not available for this account.',
      requires: ['valid_supplier'],
    };
  }
  const supplierPickup = supplier ? supplierPickupProfile(supplier) : null;
  let supplierAssignment = {
    supplierId,
    updatedSkuCount: 0,
  };
  if (assignSupplierToSkus && supplierId && selectedItemIds.length) {
    const updated = await rows<{ id: string }>(
      `UPDATE catalog_items
       SET supplier_id = $3, updated_at = now()
       WHERE user_id = $1 AND id::text = ANY($2::text[])
       RETURNING id::text AS id`,
      [userId, selectedItemIds, supplierId],
    );
    supplierAssignment = {
      supplierId,
      updatedSkuCount: updated.length,
    };
  }
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
        warehouseRoutingMode: connectedFacility ? 'connected_warehouse' : warehouseRoutingMode || 'national_network',
        warehouseSelectionHiddenFromClient: !connectedFacility,
        requiresWmsTruth: true,
        requiresBol: body?.requiresBol !== false,
        requiresLabels,
        packagePlan: body?.packagePlan || {},
        supplierPickupProfile: supplierPickup,
        supplierAssignment,
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
      JSON.stringify({
        draftId,
        supplierId,
        supplierName: supplier?.name || null,
        supplierAssignment,
        warehouseRoutingMode: connectedFacility ? 'connected_warehouse' : warehouseRoutingMode || 'national_network',
        packagePlan: body?.packagePlan || {},
        selectedItems,
        requiresWmsTruth: true,
        requiresLabels,
        facilityId: facility?.id || null,
      }),
    ],
  );

  const wmsAsnInput: Parameters<typeof createWmsAsnForShipment>[0] = {
    userId,
    draftId,
    supplier,
    facility,
    selectedItems,
    plan,
    asn,
    estimatedArrivalDate: body?.estimatedArrivalDate || null,
    shipFromAddress: shipFrom?.address || body?.shipFromAddress || {},
  };
  if (log) wmsAsnInput.log = log;

  const wmsExecution = await createWmsAsnForShipment(wmsAsnInput).catch((err: any) => ({
    ok: false,
    status: err?.status || 502,
    error: err?.payload?.error || 'wms_asn_create_failed',
    message: String(err?.message || 'WMS ASN create failed'),
    details: err?.payload || null,
  }));

  if (asn?.id) {
    await pgQuery(
      `UPDATE asns
       SET status = $2,
           payload = payload || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $4`,
      [
        asn.id,
        (wmsExecution as any)?.ok ? 'wms_asn_created_waiting_for_receipt' : 'projected_waiting_for_wms_truth',
        JSON.stringify({ wmsExecution }),
        userId,
      ],
    ).catch((err) => log?.warn({ err, asnId: asn.id }, 'failed to update ASN with WMS execution result'));
  }

  await pgQuery(
    `UPDATE oms_shipment_wizard_drafts
     SET shipment_plan_id = $2, asn_id = $3, updated_at = now()
     WHERE id = $1 AND user_id = $4`,
    [draftId, plan?.id || null, asn?.id || null, userId],
  ).catch((err) => log?.warn({ err, draftId }, 'failed to link shipment wizard draft documents'));

  const cortex = await postCortex('/v1/oms/shipment/projected', {
    userId,
    draftId,
    shipmentPlanId: plan?.id || null,
    asnId: asn?.id || null,
    projectedPlan: plan,
    asn,
    selectedItems,
    expectedQuantities: {
      planned_quantity: sumSelectedQuantity(selectedItems),
      selected_item_count: Array.isArray(selectedItems) ? selectedItems.length : 0,
    },
    warehousePlan: {
      facility_id: facility?.id || null,
      facility_name: facility?.name || null,
      routing_mode: connectedFacility ? 'connected_warehouse' : warehouseRoutingMode || 'national_network',
      hidden_from_client: !connectedFacility,
      requires_wms_truth: true,
    },
    skuPlan: selectedItems,
    decisionLifecycle: 'waiting_for_wms_truth',
    requiresBol: body?.requiresBol !== false,
    requiresLabels,
    supplierPickupProfile: supplierPickup,
    supplierAssignment,
    wmsExecution,
  }).catch((err) => ({ ok: false, status: 503, data: { error: err?.message || 'Cortex call failed' } }));

  const labelPdf = await generateShipmentPalletLabelsPdf(userId, draftId);
  const vendorEmail = await attemptShipmentVendorEmail(userId, draftId, log);
  const documents = {
    palletLabels: {
      status: labelPdf ? 'ready' : 'failed',
      downloadUrl: `/api/v1/oms/shipment-wizard/drafts/${encodeURIComponent(draftId)}/pallet-labels.pdf`,
      filename: labelPdf?.filename || null,
      pageCount: labelPdf?.pageCount || 0,
      generatedAt: new Date().toISOString(),
    },
    vendorEmail: {
      ...vendorEmail,
      attemptedAt: new Date().toISOString(),
    },
  };
  await mergeShipmentDocumentMetadata({ userId, draftId, documents });

  if (supplierAssignment.updatedSkuCount > 0) {
    await writeOmsLedgerEvent({
      userId,
      entityType: 'supplier',
      entityId: supplierId,
      eventType: 'sku_supplier_assignment',
      sourceSystem: 'oms',
      summary: `Assigned ${supplierAssignment.updatedSkuCount} SKU${supplierAssignment.updatedSkuCount === 1 ? '' : 's'} to ${supplier?.name || 'the selected supplier'} from shipment planning.`,
      payload: { draftId, shipmentPlanId: plan?.id || null, asnId: asn?.id || null, itemIds: selectedItemIds, supplierAssignment },
      confidence: 0.94,
    });
  }

  await writeOmsLedgerEvent({
    userId,
    entityType: 'shipment_wizard',
    entityId: draftId,
    eventType: 'projected_waiting_for_wms_truth',
    sourceSystem: 'oms',
    summary: (wmsExecution as any)?.ok
      ? 'Shipment wizard created an OMS plan and WMS ASN; receipt still requires WMS truth.'
      : 'Shipment wizard created an OMS projected ASN; final execution waits for WMS truth.',
    payload: { draftId, shipmentPlanId: plan?.id || null, asnId: asn?.id || null, cortex, wmsExecution, supplierAssignment, documents },
    confidence: (wmsExecution as any)?.ok ? 0.82 : 0.74,
  });

  await writeOmsLedgerEvent({
    userId,
    entityType: 'shipment_wizard',
    entityId: draftId,
    eventType: 'pallet_labels_generated',
    sourceSystem: 'oms',
    summary: labelPdf
      ? `Generated ${labelPdf.pageCount} required pallet label page${labelPdf.pageCount === 1 ? '' : 's'} for vendor printing.`
      : 'Required pallet label PDF generation failed.',
    payload: { documents },
    confidence: labelPdf ? 0.95 : 0.4,
  });

  await pgQuery(
    `UPDATE oms_shipment_wizard_drafts
     SET status = 'projected_waiting_for_wms_truth', shipment_plan_id = $2, asn_id = $3, updated_at = now()
     WHERE id = $1 AND user_id = $4`,
    [draftId, plan?.id || null, asn?.id || null, userId],
  ).catch((err) => log?.warn({ err, draftId }, 'failed to update shipment wizard draft'));

  return {
    status: (wmsExecution as any)?.ok ? 'wms_asn_created_waiting_for_receipt' : 'projected_waiting_for_wms_truth',
    plan,
    asn: { asn, wmsExecution },
    cortex,
    supplierAssignment,
    documents,
    degraded: !(wmsExecution as any)?.ok,
  };
}

export async function getHeatmap(userId: string) {
  const [facilities, plan, stateRows, itemStateRows] = await Promise.all([
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
    rows<{ item_id: string; sku: string; title: string; state: string; orders: string; units: string; revenue: string }>(
      `SELECT
         COALESCE(ol.item_id, '') AS item_id,
         COALESCE(ci.sku, ol.sku, 'unmapped') AS sku,
         COALESCE(ci.title, ol.title, COALESCE(ci.sku, ol.sku, 'Unmapped item')) AS title,
         UPPER(COALESCE(
           NULLIF(o.shipping_address->>'stateOrProvinceCode', ''),
           NULLIF(o.shipping_address->>'state', ''),
           NULLIF(o.shipping_address->>'province', '')
         )) AS state,
         COUNT(DISTINCT o.id)::text AS orders,
         COALESCE(SUM(COALESCE(ol.quantity, 0)), 0)::text AS units,
         COALESCE(SUM(COALESCE(ol.total_price, ol.unit_price * ol.quantity, 0)), 0)::text AS revenue
       FROM order_lines ol
       INNER JOIN orders o ON o.id = ol.order_id AND o.user_id = ol.user_id
       LEFT JOIN catalog_items ci ON ci.id = ol.item_id AND ci.user_id = ol.user_id
       WHERE ol.user_id = $1
       GROUP BY item_id, sku, title, state
       HAVING UPPER(COALESCE(
         NULLIF(o.shipping_address->>'stateOrProvinceCode', ''),
         NULLIF(o.shipping_address->>'state', ''),
         NULLIF(o.shipping_address->>'province', '')
       )) IS NOT NULL
       ORDER BY COUNT(DISTINCT o.id) DESC, COALESCE(SUM(COALESCE(ol.quantity, 0)), 0) DESC
       LIMIT 1000`,
      [userId],
    ),
  ]);
  const planSkus = Array.isArray((plan as any).skus) ? (plan as any).skus : [];
  const totalInventory = planSkus.reduce((sum: number, sku: any) => sum + number(sku.available), 0);
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
      city: f.address?.city || null,
      latitude: f.latitude == null ? null : number(f.latitude),
      longitude: f.longitude == null ? null : number(f.longitude),
      inventoryUnits: inventoryPerFacility,
      activeSkus: plan.skus.length ? Math.max(1, Math.floor(plan.skus.length / Math.max(1, facilities.length || 1))) : 0,
      capacity: facilities.length ? Math.min(0.95, Math.max(0.15, inventoryPerFacility / Math.max(1, totalInventory || inventoryPerFacility || 1))) : 0,
      region: f.address?.region || f.address?.stateOrProvinceCode || f.address?.state || null,
      status: f.status || 'active',
    })),
    itemStates: itemStateRows.map((row) => ({
      itemId: row.item_id || null,
      sku: row.sku,
      title: row.title,
      state: row.state,
      orders: number(row.orders),
      units: number(row.units),
      revenue: money(row.revenue),
    })),
  };
}

function mapWarehouseLink(row: Row) {
  const address = json(row.address, {});
  const metadata = json(row.metadata, {});
  const addressLine1 = address.addressLine1 || address.line1 || address.street1 || address.street || null;
  const addressLine2 = address.addressLine2 || address.line2 || address.street2 || null;
  const city = address.city || null;
  const state = address.stateOrProvinceCode || address.state || null;
  const postalCode = address.postalCode || address.postal || address.zip || null;
  const countryCode = address.countryCode || address.country || null;
  return {
    id: String(row.id),
    warehouseCode: String(row.warehouse_code || row.code || ''),
    code: String(row.warehouse_code || row.code || ''),
    name: row.name || row.warehouse_code,
    status: row.status || 'connected',
    connectionCode: row.connection_code || null,
    facilityId: row.facility_id || null,
    facilityCode: row.facility_code || row.code || null,
    facilityName: row.facility_name || row.name || null,
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
    countryCode,
    address,
    region: state || city || null,
    connectedAt: iso(row.connected_at),
    metadata,
  };
}

async function warehouseLinks(userId: string) {
  return rows(
    `SELECT l.*, f.code AS facility_code, f.name AS facility_name, f.name, f.address
     FROM oms_warehouse_links l
     LEFT JOIN facilities f ON f.id = l.facility_id
     WHERE l.user_id = $1
       AND l.status = 'connected'
       AND COALESCE(l.metadata->>'source', '') <> 'demo'
       AND COALESCE(f.metadata->>'source', '') NOT IN ('sql_default','demo')
     ORDER BY l.connected_at DESC`,
    [userId],
  );
}

function snapshotForWarehouse(item: Row, warehouseCode: string) {
  const inv = json(item.wms_inventory, {});
  const snap = inv?.[warehouseCode] || inv?.[warehouseCode.toUpperCase()] || inv?.[warehouseCode.toLowerCase()] || null;
  return snap && typeof snap === 'object' ? snap : null;
}

export async function getWarehouseOverview(userId: string) {
  const links = await warehouseLinks(userId);
  const warehouses = await Promise.all(
    links.map(async (link) => {
      const warehouseCode = String(link.warehouse_code || '');
      const [inventoryRows, orderRows, asnRows, eventRows, ledgerRows] = await Promise.all([
        rows(
          `SELECT id, sku, title, wms_inventory, updated_at
           FROM catalog_items
           WHERE user_id = $1 AND wms_inventory ? $2
           ORDER BY updated_at DESC LIMIT 500`,
          [userId, warehouseCode],
        ),
        rows<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM orders
           WHERE user_id = $1
             AND (metadata::text ILIKE $2 OR id IN (
               SELECT entity_id FROM oms_wms_events
               WHERE user_id = $1 AND warehouse_code = $3 AND entity_type IN ('order','orders')
             ))`,
          [userId, `%${warehouseCode}%`, warehouseCode],
        ),
        rows<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM asns a
           LEFT JOIN shipment_plans sp ON sp.id = a.shipment_plan_id AND sp.user_id = a.user_id
           WHERE a.user_id = $1 AND (sp.facility_id = $2 OR sp.metadata::text ILIKE $3 OR sp.items::text ILIKE $3)`,
          [userId, link.facility_id || null, `%${warehouseCode}%`],
        ),
        rows(
          `SELECT * FROM oms_wms_events
           WHERE user_id = $1 AND warehouse_code = $2
           ORDER BY received_at DESC LIMIT 1`,
          [userId, warehouseCode],
        ),
        rows<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM oms_execution_ledger
           WHERE user_id = $1 AND (entity_id = $2 OR payload::text ILIKE $3)`,
          [userId, warehouseCode, `%${warehouseCode}%`],
        ),
      ]);
      const inventoryUnits = inventoryRows.reduce((sum, item) => {
        const snap = snapshotForWarehouse(item, warehouseCode);
        return sum + number(snap?.available ?? snap?.onHand ?? snap?.quantity);
      }, 0);
      return {
        ...mapWarehouseLink(link),
        inventoryUnits,
        activeSkus: inventoryRows.length,
        orders: number(orderRows[0]?.count),
        asns: number(asnRows[0]?.count),
        activityCount: number(ledgerRows[0]?.count),
        lastWmsEventAt: iso(eventRows[0]?.received_at),
        lastWmsEventType: eventRows[0]?.event_type || null,
      };
    }),
  );
  return { warehouses, total: warehouses.length };
}

export async function getWarehouseDetail(userId: string, warehouseCode: string) {
  const code = String(warehouseCode || '').trim();
  if (!code) return null;
  const link = (await warehouseLinks(userId)).find((row) => String(row.warehouse_code || '').toLowerCase() === code.toLowerCase());
  if (!link) return null;
  const [inventoryRows, orders, asns, shipmentPlans, events, ledger] = await Promise.all([
    rows(
      `SELECT id, sku, title, image, weight, dimensions, wms_inventory, metadata, updated_at
       FROM catalog_items
       WHERE user_id = $1 AND wms_inventory ? $2
       ORDER BY updated_at DESC LIMIT 500`,
      [userId, String(link.warehouse_code)],
    ),
    rows(
      `SELECT o.*, c.email AS customer_email, c.name AS customer_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.user_id = $1
         AND (o.metadata::text ILIKE $2 OR o.id IN (
           SELECT entity_id FROM oms_wms_events
           WHERE user_id = $1 AND warehouse_code = $3 AND entity_type IN ('order','orders')
         ))
       ORDER BY COALESCE(o.placed_at, o.created_at) DESC LIMIT 100`,
      [userId, `%${link.warehouse_code}%`, link.warehouse_code],
    ),
    rows(
      `SELECT a.*, sp.internal_shipment_id, sp.shipment_title, sp.facility_id, sp.items
       FROM asns a
       LEFT JOIN shipment_plans sp ON sp.id = a.shipment_plan_id AND sp.user_id = a.user_id
       WHERE a.user_id = $1 AND (sp.facility_id = $2 OR sp.metadata::text ILIKE $3 OR sp.items::text ILIKE $3)
       ORDER BY COALESCE(a.updated_at, a.created_at) DESC LIMIT 100`,
      [userId, link.facility_id || null, `%${link.warehouse_code}%`],
    ),
    rows(
      `SELECT * FROM shipment_plans
       WHERE user_id = $1 AND (facility_id = $2 OR metadata::text ILIKE $3 OR items::text ILIKE $3)
       ORDER BY updated_at DESC LIMIT 100`,
      [userId, link.facility_id || null, `%${link.warehouse_code}%`],
    ),
    rows(
      `SELECT * FROM oms_wms_events
       WHERE user_id = $1 AND warehouse_code = $2
       ORDER BY received_at DESC LIMIT 100`,
      [userId, link.warehouse_code],
    ),
    rows(
      `SELECT id, entity_type, entity_id, event_type, source_system, summary, payload, confidence, created_at
       FROM oms_execution_ledger
       WHERE user_id = $1 AND (entity_id = $2 OR payload::text ILIKE $3)
       ORDER BY created_at DESC LIMIT 100`,
      [userId, link.warehouse_code, `%${link.warehouse_code}%`],
    ),
  ]);
  const inventory = inventoryRows.map((item) => {
    const snap = snapshotForWarehouse(item, String(link.warehouse_code)) || {};
    const available = number(snap.available ?? snap.onHand ?? snap.quantity);
    // Reorder flag (external supply loop): only for SKUs the client enabled auto-replenishment
    // on. This per-warehouse view lacks the network sales velocity, so we use a conservative
    // low-stock signal against the item's cached reorder intent; the SKUs table + dashboard
    // carry the full velocity-aware truth.
    const repl = json(json(item.metadata, {}).replenishment, {});
    const reorderEnabled = repl?.enabled !== false; // default ON (opt-out)
    const REORDER_WH_LOW_UNITS = 10;
    const reorderNeeded = reorderEnabled && available <= REORDER_WH_LOW_UNITS;
    return {
      id: item.id,
      sku: item.sku,
      title: item.title,
      image: item.image || null,
      available,
      inbound: number(snap.inbound),
      received: number(snap.received),
      orders: number(snap.orders ?? snap.allocated),
      shippedToday: number(snap.shippedToday ?? snap.shipped_today),
      openAsnsCount: number(snap.openAsnsCount ?? snap.open_asns_count),
      receiving: number(snap.receiving),
      reorderNeeded,
      updatedAt: snap.updatedAt || iso(item.updated_at),
    };
  });
  const inventoryUnits = inventory.reduce((sum, item) => sum + item.available, 0);
  const orderRows = orders.map((order) => {
    const totals = json(order.totals, {});
    return {
      id: order.id,
      publicId: publicEntityId('OR', order.id),
      orderNumber: order.order_number,
      customer: order.customer_name || order.customer_email || null,
      channel: order.channel || 'manual',
      status: order.status,
      total: money(totals.total || totals.subtotal || 0),
      placedAt: iso(order.placed_at),
      createdAt: iso(order.created_at),
    };
  });
  const asnRows = asns.map((asn) => ({
    id: asn.id,
    publicId: publicEntityId('AS', asn.id),
    asnNumber: asn.asn_number,
    status: asn.status,
    shipmentPlanId: asn.shipment_plan_id,
    shipmentTitle: asn.shipment_title || asn.internal_shipment_id || 'Inbound shipment',
    units: itemLines(asn.items).reduce((sum, item) => sum + lineQuantity(item), 0),
    createdAt: iso(asn.created_at),
    updatedAt: iso(asn.updated_at),
  }));
  const shipmentRows = shipmentPlans.map((plan) => ({
    id: plan.id,
    publicId: publicEntityId('SH', plan.id),
    title: plan.shipment_title || plan.internal_shipment_id || 'Shipment plan',
    status: plan.status,
    units: itemLines(plan.items).reduce((sum, item) => sum + lineQuantity(item), 0),
    estimatedArrivalDate: iso(plan.estimated_arrival_date),
    updatedAt: iso(plan.updated_at),
  }));
  return {
    warehouse: {
      ...mapWarehouseLink(link),
      inventoryUnits,
      activeSkus: inventory.length,
      orders: orderRows.length,
      asns: asnRows.length,
      activityCount: ledger.length,
      lastWmsEventAt: iso(events[0]?.received_at),
      lastWmsEventType: events[0]?.event_type || null,
    },
    inventory,
    orders: orderRows,
    asns: asnRows,
    shipmentPlans: shipmentRows,
    wmsEvents: events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      entityType: event.entity_type,
      entityId: event.entity_id,
      status: event.status,
      payload: json(event.payload, {}),
      receivedAt: iso(event.received_at),
    })),
    ledger: ledger.map((event) => ({ ...event, payload: json(event.payload, {}), createdAt: iso(event.created_at) })),
    cortex: {
      readiness: inventory.length > 0 ? 'wms_truth_available' : 'waiting_for_inventory_snapshot',
      signals: [
        inventory.length ? `${inventory.length} SKUs have warehouse inventory snapshots.` : 'No inventory snapshots received for this warehouse yet.',
        events.length ? `${events.length} WMS events available for operational traceability.` : 'No WMS events received yet.',
        asnRows.length ? `${asnRows.length} ASNs or inbound records are tied to this warehouse.` : 'No inbound ASNs tied to this warehouse yet.',
      ],
      recommendations: [
        inventory.length ? 'Review slow-moving and allocated units before the next replenishment plan.' : 'Send an inventory_snapshot event from WMS to unlock warehouse-level intelligence.',
        'Use Cortex plan approval before changing WMS execution work.',
      ],
    },
  };
}

function mapLabelRun(row: Row | null): LabelAuditRun | null {
  if (!row) return null;
  return {
    id: String(row.id),
    publicId: publicEntityId('LA', row.id),
    filename: row.filename || null,
    status: row.status || 'completed',
    rowCount: number(row.row_count),
    findingsCount: number(row.findings_count),
    estimatedRefunds: money(row.estimated_refunds),
    optimizedServiceSavings: money(row.optimized_service_savings),
    missingEvidenceCount: number(row.missing_evidence_count),
    inputSummary: json(row.input_summary, {}),
    resultSummary: json(row.result_summary, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function valueFrom(row: Row, keys: string[]) {
  for (const key of keys) {
    const direct = row[key];
    if (direct != null && String(direct).trim() !== '') return String(direct).trim();
    const foundKey = Object.keys(row).find((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === key.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (foundKey && row[foundKey] != null && String(row[foundKey]).trim() !== '') return String(row[foundKey]).trim();
  }
  return '';
}

const normalizedKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function valueLike(row: Row, patterns: RegExp[]) {
  const key = Object.keys(row).find((k) => {
    const normalized = normalizedKey(k);
    return patterns.some((pattern) => pattern.test(normalized));
  });
  if (!key) return '';
  const value = row[key];
  return value == null ? '' : String(value).trim();
}

function inferCarrier(row: Row, trackingNumber: string, service: string) {
  const explicit = valueFrom(row, [
    'carrier',
    'carrierName',
    'carrier_name',
    'shippingCarrier',
    'shipping_carrier',
    'shipCarrier',
    'ship_carrier',
    'shipVia',
    'ship_via',
    'provider',
    'providerName',
    'scac',
  ]);
  if (explicit) return explicit;
  const haystack = `${trackingNumber} ${service}`.toLowerCase();
  if (/\b1z[0-9a-z]+/i.test(trackingNumber) || haystack.includes('ups')) return 'UPS';
  if (/^(94|92|93|95)\d{18,}/.test(trackingNumber) || haystack.includes('usps') || haystack.includes('postal')) return 'USPS';
  if (/^(\d{12}|\d{15}|\d{20,22})$/.test(trackingNumber.replace(/\D/g, '')) || haystack.includes('fedex')) return 'FedEx';
  if (haystack.includes('dhl')) return 'DHL';
  return 'Unknown carrier';
}

function dimensionValue(row: Row) {
  const explicit = valueFrom(row, ['dim', 'dims', 'dimensions', 'packageDimensions', 'parcelDimensions']);
  if (explicit) return explicit;
  const length = valueFrom(row, ['length', 'packageLength', 'dimLength', 'l']);
  const width = valueFrom(row, ['width', 'packageWidth', 'dimWidth', 'w']);
  const height = valueFrom(row, ['height', 'packageHeight', 'dimHeight', 'h']);
  return length || width || height ? [length || '?', width || '?', height || '?'].join('x') : '';
}

async function getLabelAuditCortexGate(userId: string) {
  const feature = await one(
    `SELECT f.id, f.name, f.status, uf.status AS user_status
       FROM features f
       LEFT JOIN user_features uf ON uf.feature_id = f.id AND uf.user_id = $1
      WHERE f.id IN ('label-audit','carrier-label-audit')
         OR f.payload->>'slug' IN ('label-audit','carrier-label-audit')
      LIMIT 1`,
    [userId],
  );
  const featureEnabled =
    !feature ||
    (String(feature.status || '').toLowerCase() === 'active' &&
      !['disabled', 'removed', 'uninstalled'].includes(String(feature.user_status || 'enabled').toLowerCase()));
  const credential = await one(
    `SELECT status, cortex_credential_id, cortex_tenant_key, secret_enc, provisioning_error
       FROM oms_cortex_credentials
      WHERE user_id = $1
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1`,
    [userId],
  );
  const credentialActive =
    Boolean(credential) &&
    ['active', 'enabled', 'provisioned'].includes(String(credential?.status || '').toLowerCase()) &&
    Boolean(credential?.secret_enc || credential?.cortex_credential_id || credential?.cortex_tenant_key);
  const configured = Boolean(cortexConfigStatus().configured);
  return {
    ok: featureEnabled && credentialActive && configured,
    featureEnabled,
    credentialActive,
    configured,
    status: credential?.status || 'missing',
    error: credential?.provisioning_error || null,
  };
}

function parseDateValue(value: string) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeLabelCsvRow(raw: Row, index: number) {
  const order =
    valueFrom(raw, ['order', 'orderId', 'orderNumber', 'order_no', 'orderNo', 'orderNum', 'orderReference', 'orderRef', 'reference', 'referenceNumber']) ||
    valueLike(raw, [/^order/, /ordernumber/, /orderid/, /orderref/, /reference/]);
  const trackingNumber =
    valueFrom(raw, ['trackingNumber', 'tracking', 'tracking_no', 'trackingNo', 'trackingId', 'trackingCode', 'tracking #', 'tracking number']) ||
    valueLike(raw, [/tracking/, /waybill/, /airbill/, /labelid/, /shipmentid/]);
  const service =
    valueFrom(raw, ['service', 'serviceLevel', 'shippingService', 'shipping_service', 'carrierService', 'mailClass', 'serviceType', 'shipMethod', 'shipmentMethod']) ||
    valueLike(raw, [/service/, /shipmethod/, /mailclass/, /method/]);
  const carrier = inferCarrier(raw, trackingNumber, service);
  const shipped = valueFrom(raw, ['shipped', 'shippedDate', 'shipDate', 'shipmentDate', 'labelDate', 'createdDate', 'dateShipped']) || valueLike(raw, [/ship.*date/, /label.*date/]);
  const delivered = valueFrom(raw, ['delivered', 'deliveredDate', 'deliveryDate', 'actualDeliveryDate', 'dateDelivered']) || valueLike(raw, [/deliver.*date/, /actualdelivery/]);
  const promised =
    valueFrom(raw, ['promised', 'promisedDate', 'promiseDate', 'estimatedDeliveryDate', 'expectedDeliveryDate', 'commitmentDate', 'guaranteedDeliveryDate']) ||
    valueLike(raw, [/promise/, /estimateddelivery/, /expecteddelivery/, /commitment/, /guarantee/]);
  const cost = money(valueFrom(raw, ['cost', 'labelCost', 'shippingCost', 'postage', 'charge', 'amount', 'netCharge', 'totalCharge', 'transportationCharge', 'shipmentCost']) || valueLike(raw, [/cost/, /charge/, /postage/, /amount/]));
  const zone = number(valueFrom(raw, ['zone', 'shippingZone', 'destinationZone', 'carrierZone']) || valueLike(raw, [/zone/]), NaN);
  const weight = number(valueFrom(raw, ['weight', 'weightLb', 'weightLbs', 'actualWeight', 'billableWeight', 'packageWeight']) || valueLike(raw, [/weight/]), NaN);
  const dim = dimensionValue(raw);
  const state = valueFrom(raw, ['state', 'shipToState', 'ship_state', 'recipientState', 'destinationState']) || valueLike(raw, [/shipto.*state/, /recipient.*state/, /destination.*state/]);
  const zip = valueFrom(raw, ['zip', 'shipToZip', 'postalCode', 'postcode', 'recipientZip', 'destinationZip']) || valueLike(raw, [/zip/, /postal/, /postcode/]);
  const errors: string[] = [];
  return {
    rowNumber: index + 1,
    order,
    trackingNumber,
    carrier,
    service,
    shipped,
    delivered,
    promised,
    cost,
    zone: Number.isFinite(zone) ? zone : null,
    weight: Number.isFinite(weight) ? weight : null,
    dim,
    state,
    zip,
    errors,
    raw,
  };
}

function labelFindingsForRow(row: ReturnType<typeof normalizeLabelCsvRow>, runId: string) {
  const deliveredAt = parseDateValue(row.delivered);
  const promisedAt = parseDateValue(row.promised);
  const shippedAt = parseDateValue(row.shipped);
  const daysInTransit = deliveredAt && shippedAt ? Math.max(0, Math.round((deliveredAt.getTime() - shippedAt.getTime()) / 86400000)) : null;
  const late = Boolean(deliveredAt && promisedAt && deliveredAt.getTime() > promisedAt.getTime());
  const highCost = row.cost >= 18 || (row.zone != null && row.zone >= 6 && row.cost >= 12);
  const heavyParcel = row.weight != null && row.weight >= 12 && /ground|priority|advantage|parcel/i.test(row.service || '');
  const missingEvidence = !row.trackingNumber || !row.carrier || row.carrier === 'Unknown carrier' || !row.delivered || !row.promised || !row.cost;
  type GeneratedLabelFinding = { type: string; severity: string; refund: number; recommendation: string; optimizedCarrier?: string | undefined; optimizedCost?: number | undefined; auditStatus: string };
  const findings: GeneratedLabelFinding[] = [];
  if (late) {
    findings.push({
      type: 'late_delivery_refund',
      severity: 'high',
      refund: money(Math.min(Math.max(row.cost * 0.8, 4), 35)),
      recommendation: 'Cortex found a late-delivery refund candidate. Attach carrier tracking proof before filing.',
      optimizedCarrier: row.carrier,
      optimizedCost: row.cost,
      auditStatus: 'claim_ready',
    });
  }
  if (highCost) {
    findings.push({
      type: 'optimized_service_swap',
      severity: 'medium',
      refund: 0,
      recommendation: 'Cortex recommends reviewing carrier/service selection for this zone and shipment profile.',
      optimizedCarrier: /ups/i.test(row.carrier) ? 'USPS Ground Advantage' : 'UPS Ground',
      optimizedCost: money(row.cost * 0.82),
      auditStatus: 'optimization',
    });
  }
  if (heavyParcel) {
    findings.push({
      type: 'dim_weight_or_ltl_review',
      severity: 'medium',
      refund: 0,
      recommendation: 'Cortex flagged this parcel for dim-weight or LTL consolidation review.',
      optimizedCarrier: 'Cortex LTL / consolidated parcel',
      optimizedCost: money(row.cost * 0.76),
      auditStatus: 'review',
    });
  }
  if (missingEvidence) {
    findings.push({
      type: 'missing_carrier_evidence',
      severity: 'low',
      refund: 0,
      recommendation: 'Upload delivered/promised dates and label cost to raise claim confidence.',
      optimizedCost: row.cost || 0,
      auditStatus: 'needs_evidence',
    });
  }
  if (!findings.length) {
    findings.push({
      type: 'on_time_benchmark',
      severity: 'low',
      refund: 0,
      recommendation: 'No refund issue found. Keep this label as a benchmark for carrier/service performance.',
      optimizedCarrier: row.carrier,
      optimizedCost: row.cost,
      auditStatus: 'no_claim',
    });
  }
  return findings.map((finding) => ({
    id: randomUUID(),
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    findingType: finding.type,
    severity: finding.severity,
    refundAmount: finding.refund,
    status: finding.auditStatus === 'claim_ready' ? 'open' : 'reviewed',
    recommendation: finding.recommendation,
    evidence: {
      runId,
      source: 'csv_upload',
      order: row.order,
      service: row.service,
      shipped: row.shipped,
      delivered: row.delivered,
      promised: row.promised,
      cost: row.cost,
      zone: row.zone,
      weight: row.weight,
      dim: row.dim,
      state: row.state,
      zip: row.zip,
      daysInTransit,
      optimizedCarrier: finding.optimizedCarrier,
      optimizedCost: finding.optimizedCost,
      auditStatus: finding.auditStatus,
      raw: row.raw,
    },
  }));
}

export async function getLabelAudit(userId: string): Promise<{ findings: LabelAuditFinding[]; summary: Record<string, number>; cortex: Record<string, unknown> }> {
  const cortex = await getLabelAuditCortexGate(userId);
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
        source: row.evidence?.source,
        runId: row.evidence?.runId,
        order: row.evidence?.order,
        service: row.evidence?.service,
        cost: money(row.evidence?.cost),
        optimizedCarrier: row.evidence?.optimizedCarrier,
        optimizedCost: row.evidence?.optimizedCost == null ? undefined : money(row.evidence?.optimizedCost),
        shipped: row.evidence?.shipped,
        delivered: row.evidence?.delivered,
        promised: row.evidence?.promised,
        zone: row.evidence?.zone == null ? undefined : number(row.evidence?.zone),
        weight: row.evidence?.weight,
        dim: row.evidence?.dim,
        auditStatus: row.evidence?.auditStatus || row.status,
      }));
  return {
    findings,
    summary: {
      openFindings: findings.length,
      estimatedRefunds: money(findings.reduce((sum, f) => sum + f.refundAmount, 0)),
      optimizedServiceSavings: money(findings.length * 14.25),
    },
    cortex: {
      available: cortex.ok,
      status: cortex.status,
      featureEnabled: cortex.featureEnabled,
      credentialActive: cortex.credentialActive,
      configured: cortex.configured,
      message: cortex.ok ? 'Cortex shipment label audit is available.' : 'Cortex Intelligence is not available for this account. Contact support or your account manager to enable Cortex shipment label audit.',
    },
  };
}

export async function createLabelAuditRun(userId: string, body: any) {
  const gate = await getLabelAuditCortexGate(userId);
  if (!gate.ok) {
    const err: any = new Error('Cortex Intelligence is not available for this account. Contact support or your account manager to enable Cortex shipment label audit.');
    err.statusCode = 403;
    err.details = { cortex: gate };
    throw err;
  }
  const rowsInput: Row[] = Array.isArray(body?.rows)
    ? body.rows.filter((row: Row) => Object.values(row || {}).some((value) => value != null && String(value).trim() !== ''))
    : [];
  const filename = String(body?.filename || 'label-audit.csv').slice(0, 240);
  if (!rowsInput.length) {
    const err: any = new Error('CSV must include at least one row.');
    err.statusCode = 400;
    throw err;
  }
  if (rowsInput.length > 5000) {
    const err: any = new Error('CSV upload is limited to 5,000 rows per run.');
    err.statusCode = 400;
    throw err;
  }
  const normalized: Array<ReturnType<typeof normalizeLabelCsvRow>> = rowsInput.map((row: Row, index: number) => normalizeLabelCsvRow(row, index));
  const errors = normalized.flatMap((row) => row.errors);
  if (errors.length) {
    const err: any = new Error(`CSV mapping failed: ${errors.slice(0, 8).join(' ')}`);
    err.statusCode = 400;
    err.details = { errors };
    throw err;
  }
  const runId = randomUUID();
  const generated = normalized.flatMap((row) => labelFindingsForRow(row, runId));
  const estimatedRefunds = money(generated.reduce((sum, finding) => sum + finding.refundAmount, 0));
  const optimizedServiceSavings = money(
    generated.reduce((sum, finding) => sum + Math.max(0, number(finding.evidence.cost) - number(finding.evidence.optimizedCost)), 0),
  );
  const missingEvidenceCount = generated.filter((finding) => finding.findingType === 'missing_carrier_evidence').length;
  const run = await one(
    `INSERT INTO oms_label_audit_runs
      (id, user_id, filename, status, row_count, findings_count, estimated_refunds, optimized_service_savings, missing_evidence_count, input_summary, result_summary)
     VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
     RETURNING *`,
    [
      runId,
      userId,
      filename,
      normalized.length,
      generated.length,
      estimatedRefunds,
      optimizedServiceSavings,
      missingEvidenceCount,
      JSON.stringify({ filename, acceptedColumns: Object.keys(rowsInput[0] || {}) }),
      JSON.stringify({
        cortexTool: 'shipment_label_audit_simulation',
        refunds: estimatedRefunds,
        optimizedServiceSavings,
        missingEvidenceCount,
      }),
    ],
  );
  for (const finding of generated) {
    await pgQuery(
      `INSERT INTO oms_label_audit_findings
        (id, user_id, carrier, tracking_number, finding_type, severity, refund_amount, evidence, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        finding.id,
        userId,
        finding.carrier,
        finding.trackingNumber || null,
        finding.findingType,
        finding.severity,
        finding.refundAmount,
        JSON.stringify({ ...finding.evidence, recommendation: finding.recommendation }),
        finding.status,
      ],
    );
  }
  await writeOmsLedgerEvent({
    userId,
    entityType: 'carrier_audit',
    entityId: runId,
    eventType: 'label_audit_csv_uploaded',
    sourceSystem: 'cortex',
    summary: `Carrier Label Audit CSV run completed for ${filename}: ${generated.length} findings from ${normalized.length} rows.`,
    payload: { runId, filename, rowCount: normalized.length, findingsCount: generated.length, estimatedRefunds, optimizedServiceSavings },
    confidence: missingEvidenceCount ? 0.66 : 0.84,
  });
  return {
    run: mapLabelRun(run),
    findings: generated.map((finding) => ({
      id: finding.id,
      carrier: finding.carrier,
      trackingNumber: finding.trackingNumber,
      findingType: finding.findingType,
      severity: finding.severity,
      refundAmount: finding.refundAmount,
      status: finding.status,
      recommendation: finding.recommendation,
      source: finding.evidence.source,
      runId: finding.evidence.runId,
      order: finding.evidence.order,
      service: finding.evidence.service,
      cost: finding.evidence.cost,
      optimizedCarrier: finding.evidence.optimizedCarrier,
      optimizedCost: finding.evidence.optimizedCost,
      shipped: finding.evidence.shipped,
      delivered: finding.evidence.delivered,
      promised: finding.evidence.promised,
      zone: finding.evidence.zone,
      weight: finding.evidence.weight,
      dim: finding.evidence.dim,
      auditStatus: finding.evidence.auditStatus,
    })),
  };
}

export async function getLabelAuditRuns(userId: string) {
  const data = await rows('SELECT * FROM oms_label_audit_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
  return { runs: data.map(mapLabelRun).filter(Boolean) };
}

export async function getLabelAuditRun(userId: string, runId: string) {
  const run = await one('SELECT * FROM oms_label_audit_runs WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, runId]);
  if (!run) return null;
  const findings = await rows('SELECT * FROM oms_label_audit_findings WHERE user_id = $1 AND evidence->>\'runId\' = $2 ORDER BY created_at DESC', [userId, runId]);
  return {
    run: mapLabelRun(run),
    findings: findings.map((row) => ({
      id: row.id,
      carrier: row.carrier,
      trackingNumber: row.tracking_number,
      findingType: row.finding_type,
      severity: row.severity,
      refundAmount: money(row.refund_amount),
      status: row.status,
      recommendation: row.evidence?.recommendation || 'Review carrier evidence and file claim when confidence is sufficient.',
      source: row.evidence?.source,
      runId: row.evidence?.runId,
      order: row.evidence?.order,
      service: row.evidence?.service,
      cost: money(row.evidence?.cost),
      optimizedCarrier: row.evidence?.optimizedCarrier,
      optimizedCost: row.evidence?.optimizedCost == null ? undefined : money(row.evidence?.optimizedCost),
      shipped: row.evidence?.shipped,
      delivered: row.evidence?.delivered,
      promised: row.evidence?.promised,
      zone: row.evidence?.zone == null ? undefined : number(row.evidence?.zone),
      weight: row.evidence?.weight,
      dim: row.evidence?.dim,
      auditStatus: row.evidence?.auditStatus || row.status,
    })),
  };
}

type BillingCategoryTotals = {
  freight: number;
  storage: number;
  handling: number;
  accessorials: number;
  refundsCaptured: number;
  materials: number;
};
const BILLING_CATEGORY_KEYS = ['freight', 'storage', 'handling', 'accessorials', 'materials'];
const emptyBillingCategoryTotals = (): BillingCategoryTotals => ({
  freight: 0,
  storage: 0,
  handling: 0,
  accessorials: 0,
  refundsCaptured: 0,
  materials: 0,
});
// The true billed-activity day (WMS invoice period), falling back to OMS ingest time for rows
// that predate periodStart being carried through, or for the estimate/status-only fallback rows.
const BILLING_ACTIVITY_AT = `COALESCE((payload->>'periodStart')::timestamptz, created_at)`;

export async function getBillingProfit(
  userId: string,
  opts: { range?: RangeKey; from?: string; to?: string } = {},
) {
  const range: RangeKey = opts.range || '30d';
  const customFrom = opts.from ? new Date(opts.from) : null;
  const customTo = opts.to ? new Date(opts.to) : null;
  const hasCustomFrom = !!(customFrom && !Number.isNaN(customFrom.getTime()));
  const hasCustomTo = !!(customTo && !Number.isNaN(customTo.getTime()));

  const start = hasCustomFrom ? (customFrom as Date) : rangeStart(range);
  const end = hasCustomTo ? (customTo as Date) : undefined;
  const spanMs = (end ? end.getTime() : Date.now()) - start.getTime();
  const prevStart = hasCustomFrom ? new Date(start.getTime() - Math.max(spanMs, 0)) : previousRangeStart(range, start);
  const prevEnd = start;

  const revenue = (await orderSummary(userId, start, end)).revenue;
  const counts = await baseCounts(userId);

  // REAL warehouse charges from the WMS invoices already synced into invoice_lines (each row
  // carries payload.category + payload.warehouseCode from upsertWmsInvoice). Aggregate by
  // category and by warehouse, windowed to the requested date range. This replaces the previous
  // all-time, fabricated row-count×constant model.
  const catRowsFor = (windowStart: Date, windowEnd?: Date) =>
    rows<{ category: string; total: string }>(
      `SELECT COALESCE(payload->>'category','accessorials') AS category, COALESCE(SUM(amount),0)::text AS total
       FROM invoice_lines
       WHERE user_id = $1 AND ${BILLING_ACTIVITY_AT} >= $2 AND ($3::timestamptz IS NULL OR ${BILLING_ACTIVITY_AT} < $3)
       GROUP BY 1`,
      [userId, windowStart, windowEnd || null],
    );
  const whRowsFor = (windowStart: Date, windowEnd?: Date) =>
    rows<{ code: string; total: string }>(
      `SELECT COALESCE(payload->>'warehouseCode','') AS code, COALESCE(SUM(amount),0)::text AS total
       FROM invoice_lines
       WHERE user_id = $1 AND ${BILLING_ACTIVITY_AT} >= $2 AND ($3::timestamptz IS NULL OR ${BILLING_ACTIVITY_AT} < $3)
       GROUP BY 1`,
      [userId, windowStart, windowEnd || null],
    );
  const seriesRowsFor = (windowStart: Date, windowEnd?: Date) =>
    rows<{ day: string; category: string; total: string; line_count: string }>(
      `SELECT to_char(date_trunc('day', ${BILLING_ACTIVITY_AT}), 'YYYY-MM-DD') AS day,
              COALESCE(payload->>'category','accessorials') AS category,
              COALESCE(SUM(amount),0)::text AS total,
              COUNT(*)::text AS line_count
       FROM invoice_lines
       WHERE user_id = $1 AND ${BILLING_ACTIVITY_AT} >= $2 AND ($3::timestamptz IS NULL OR ${BILLING_ACTIVITY_AT} < $3)
       GROUP BY 1, 2
       ORDER BY 1`,
      [userId, windowStart, windowEnd || null],
    );

  const [catRows, whRows, seriesRows, prevCatRows] = await Promise.all([
    catRowsFor(start, end),
    whRowsFor(start, end),
    seriesRowsFor(start, end),
    catRowsFor(prevStart, prevEnd),
  ]);
  const hasRealInvoices = catRows.some((r) => number(r.total) > 0);

  const current = emptyBillingCategoryTotals();
  if (hasRealInvoices) {
    for (const r of catRows) {
      const key = (BILLING_CATEGORY_KEYS.includes(r.category) ? r.category : 'accessorials') as keyof BillingCategoryTotals;
      current[key] = money(current[key] + number(r.total));
    }
  } else {
    // Fallback (no WMS invoices synced yet in this window): keep a lightweight estimate so the
    // screen isn't empty, clearly derived from all-time counts — not fabricated warehouse truth,
    // and not date-scoped since it isn't derived from real dated activity.
    current.freight = money(counts.orders * 1.1);
    current.storage = money(counts.items * 2.2);
    current.handling = money(counts.shipmentPlans * 24);
    current.accessorials = money(counts.shipmentPlans * 9);
  }

  const previous = emptyBillingCategoryTotals();
  for (const r of prevCatRows) {
    const key = (BILLING_CATEGORY_KEYS.includes(r.category) ? r.category : 'accessorials') as keyof BillingCategoryTotals;
    previous[key] = money(previous[key] + number(r.total));
  }

  // Optimized stays a Cortex-style advisory projection, now based off the REAL windowed current cost.
  const optimized = {
    freight: money(current.freight * 0.84),
    storage: money(current.storage * 0.9),
    handling: money(current.handling * 0.88),
    accessorials: money(current.accessorials * 0.76),
    refundsCaptured: money(current.refundsCaptured * 2.8),
    materials: money(current.materials * 0.95),
  };

  const sumTotals = (t: BillingCategoryTotals) =>
    money(Object.entries(t).reduce((sum, [key, val]) => sum + (key === 'refundsCaptured' ? -Math.abs(val) : val), 0));
  const currentTotal = sumTotals(current);
  const previousTotal = sumTotals(previous);
  const optimizedTotal = sumTotals(optimized);
  const savings = money(currentTotal - optimizedTotal);

  const deltaPct: Record<string, number> = { total: pctDelta(currentTotal, previousTotal) };
  for (const key of [...BILLING_CATEGORY_KEYS, 'refundsCaptured'] as (keyof BillingCategoryTotals)[]) {
    deltaPct[key] = pctDelta(current[key], previous[key]);
  }

  // Daily buckets for the trend chart — merge per-category rows into one entry per day.
  const seriesMap = new Map<string, { date: string; total: number; lineCount: number; byCategory: Record<string, number> }>();
  for (const r of seriesRows) {
    if (!seriesMap.has(r.day)) seriesMap.set(r.day, { date: r.day, total: 0, lineCount: 0, byCategory: {} });
    const bucket = seriesMap.get(r.day) as { date: string; total: number; lineCount: number; byCategory: Record<string, number> };
    const amt = money(number(r.total));
    bucket.total = money(bucket.total + amt);
    bucket.lineCount += number(r.line_count);
    bucket.byCategory[r.category] = money((bucket.byCategory[r.category] || 0) + amt);
  }
  const series = Array.from(seriesMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const perWarehouse = whRows
    .filter((r) => r.code && number(r.total) > 0)
    .map((r) => {
      const cur = money(number(r.total));
      return { code: r.code, current: cur, optimized: money(cur * 0.87) };
    })
    .sort((a, b) => b.current - a.current);

  return {
    range,
    from: start.toISOString(),
    to: end ? end.toISOString() : null,
    revenue,
    current,
    optimized,
    previous,
    deltaPct,
    series,
    perWarehouse,
    totals: {
      current: currentTotal,
      optimized: optimizedTotal,
      savings,
      savingsPct: currentTotal ? Math.round((savings / currentTotal) * 1000) / 10 : 0,
    },
    source: hasRealInvoices ? 'wms_invoices' : 'estimate',
  };
}

type BillingInvoicesOpts = {
  range?: RangeKey;
  from?: string;
  to?: string;
  category?: string;
  warehouseCode?: string;
  status?: string;
  search?: string;
  invoiceNumber?: string;
  limit?: number;
  offset?: number;
};

// Batch-resolve WMS source.orderId/asnId -> OMS orders/asns via the wmsEntityId stamped at
// order/ASN ingest time (upsertWmsOrder / upsertWmsAsn). Resolved at READ time (not ingest time)
// so an order/ASN that syncs *after* its invoice still links up on the next ledger fetch.
async function resolveBillingInvoiceLinks(userId: string, invoiceRows: Row[]) {
  const orderWmsIds = Array.from(
    new Set(invoiceRows.map((r) => json(r.payload, {})?.sourceOrderId).filter(Boolean)),
  ) as string[];
  const asnWmsIds = Array.from(
    new Set(invoiceRows.map((r) => json(r.payload, {})?.sourceAsnId).filter(Boolean)),
  ) as string[];

  const [orderRows, asnRows] = await Promise.all([
    orderWmsIds.length
      ? rows<{ id: string; order_number: string; external_order_id: string; wid: string }>(
          `SELECT id, order_number, external_order_id, metadata->>'wmsEntityId' AS wid
           FROM orders WHERE user_id = $1 AND metadata->>'wmsEntityId' = ANY($2::text[])`,
          [userId, orderWmsIds],
        )
      : Promise.resolve([]),
    asnWmsIds.length
      ? rows<{ id: string; asn_number: string; wid: string }>(
          `SELECT id, asn_number, payload->>'wmsEntityId' AS wid
           FROM asns WHERE user_id = $1 AND payload->>'wmsEntityId' = ANY($2::text[])`,
          [userId, asnWmsIds],
        )
      : Promise.resolve([]),
  ]);

  const orderByWid = new Map(
    orderRows.map((o) => [o.wid, { omsId: o.id, number: o.order_number || o.external_order_id || o.id, publicId: publicEntityId('OR', o.id) }]),
  );
  const asnByWid = new Map(
    asnRows.map((a) => [a.wid, { omsId: a.id, number: a.asn_number || a.id, publicId: publicEntityId('AS', a.id) }]),
  );
  return { orderByWid, asnByWid };
}

function mapBillingInvoiceRow(
  row: Row,
  orderByWid: Map<string, { omsId: string; number: string; publicId: string }>,
  asnByWid: Map<string, { omsId: string; number: string; publicId: string }>,
) {
  const payload = json(row.payload, {}) as Row;
  return {
    id: row.id,
    date: iso(payload.periodStart) || iso(row.created_at),
    invoiceNumber: row.invoice_id,
    warehouse: payload.warehouseCode || null,
    category: payload.category || 'accessorials',
    code: payload.code || null,
    description: row.description,
    qty: number(payload.quantity),
    unitPrice: money(payload.unitPrice),
    amount: money(row.amount),
    currency: row.currency || 'USD',
    status: row.status || 'open',
    linkedOrder: payload.sourceOrderId ? orderByWid.get(String(payload.sourceOrderId)) || null : null,
    linkedAsn: payload.sourceAsnId ? asnByWid.get(String(payload.sourceAsnId)) || null : null,
  };
}

export async function getBillingInvoices(userId: string, opts: BillingInvoicesOpts = {}) {
  const range: RangeKey = opts.range || '30d';
  const customFrom = opts.from ? new Date(opts.from) : null;
  const customTo = opts.to ? new Date(opts.to) : null;
  const start = customFrom && !Number.isNaN(customFrom.getTime()) ? customFrom : rangeStart(range);
  const end = customTo && !Number.isNaN(customTo.getTime()) ? customTo : undefined;
  const limit = Math.min(200, Math.max(1, opts.limit || 50));
  const offset = Math.max(0, opts.offset || 0);

  const values: unknown[] = [userId, start, end || null];
  const where = [`user_id = $1`, `${BILLING_ACTIVITY_AT} >= $2`, `($3::timestamptz IS NULL OR ${BILLING_ACTIVITY_AT} < $3)`];
  if (opts.category) {
    values.push(opts.category);
    where.push(`payload->>'category' = $${values.length}`);
  }
  if (opts.warehouseCode) {
    values.push(opts.warehouseCode);
    where.push(`payload->>'warehouseCode' = $${values.length}`);
  }
  if (opts.status) {
    values.push(opts.status);
    where.push(`status = $${values.length}`);
  }
  if (opts.invoiceNumber) {
    values.push(opts.invoiceNumber);
    where.push(`invoice_id = $${values.length}`);
  }
  if (opts.search) {
    values.push(`%${opts.search}%`);
    const idx = values.length;
    where.push(`(description ILIKE $${idx} OR invoice_id ILIKE $${idx} OR payload->>'code' ILIKE $${idx})`);
  }
  values.push(limit);
  const limitIdx = values.length;
  values.push(offset);
  const offsetIdx = values.length;

  const data = await rows<Row & { total_count: string }>(
    `SELECT *, COUNT(*) OVER() AS total_count
     FROM invoice_lines
     WHERE ${where.join(' AND ')}
     ORDER BY ${BILLING_ACTIVITY_AT} DESC, invoice_id
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values,
  );

  const { orderByWid, asnByWid } = await resolveBillingInvoiceLinks(userId, data);
  const invoiceRows = data.map((row) => mapBillingInvoiceRow(row, orderByWid, asnByWid));
  const total = data.length ? number(data[0]?.total_count) : 0;

  return { rows: invoiceRows, total, limit, offset };
}

function drawPdfDivider(doc: PDFKit.PDFDocument) {
  doc.moveDown(0.3);
  doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#d0d5dd').stroke();
  doc.moveDown(0.3);
}

function drawBillingLedgerTable(doc: PDFKit.PDFDocument, invoiceRows: ReturnType<typeof mapBillingInvoiceRow>[]) {
  doc.fontSize(9).font('Helvetica-Bold');
  const cols = [70, 70, 55, 70, 130, 40, 60, 55];
  const headers = ['Date', 'Invoice #', 'Warehouse', 'Category', 'Description', 'Qty', 'Unit', 'Amount'];
  let x = doc.page.margins.left;
  const headerY = doc.y;
  headers.forEach((h, i) => {
    doc.text(h, x, headerY, { width: cols[i] || 60 });
    x += cols[i] || 60;
  });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(8);
  for (const row of invoiceRows) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
    }
    x = doc.page.margins.left;
    const rowY = doc.y;
    const cells = [
      (row.date || '').slice(0, 10),
      row.invoiceNumber || '—',
      row.warehouse || '—',
      row.category,
      row.description || row.code || '—',
      String(row.qty || ''),
      row.unitPrice ? `$${row.unitPrice.toFixed(2)}` : '—',
      `$${row.amount.toFixed(2)}`,
    ];
    cells.forEach((c, i) => {
      doc.text(c, x, rowY, { width: cols[i] || 60 });
      x += cols[i] || 60;
    });
    doc.moveDown(0.35);
  }
}

export async function generateBillingStatementPdf(
  userId: string,
  opts: Omit<BillingInvoicesOpts, 'limit' | 'offset'> = {},
) {
  const [summary, ledger] = await Promise.all([
    getBillingProfit(userId, opts),
    getBillingInvoices(userId, { ...opts, limit: 2000, offset: 0 }),
  ]);

  const doc = new PDFDocument({ size: 'LETTER', margin: 40, autoFirstPage: true, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.fontSize(16).font('Helvetica-Bold').text('UnieConnect Billing Statement');
  doc.fontSize(9).font('Helvetica').fillColor('#555').text(
    `Period: ${(summary.from || '').slice(0, 10)} to ${summary.to ? summary.to.slice(0, 10) : 'now'} · Range: ${summary.range}`,
  );
  doc.fillColor('#000');
  drawPdfDivider(doc);

  doc.fontSize(11).font('Helvetica-Bold').text('Summary');
  doc.fontSize(9).font('Helvetica');
  doc.text(`Current cost: $${summary.totals.current.toFixed(2)}`);
  doc.text(`With AI plan applied: $${summary.totals.optimized.toFixed(2)}`);
  doc.text(`Savings: $${summary.totals.savings.toFixed(2)} (${summary.totals.savingsPct}%)`);
  drawPdfDivider(doc);

  doc.fontSize(11).font('Helvetica-Bold').text(`Invoice activity (${ledger.total} line items)`);
  doc.moveDown(0.3);
  drawBillingLedgerTable(doc, ledger.rows);

  doc.end();
  const buffer = await done;
  const fromLabel = (summary.from || '').slice(0, 10);
  const toLabel = summary.to ? summary.to.slice(0, 10) : 'present';
  return { buffer, filename: `billing-statement-${fromLabel}_${toLabel}.pdf`, pageCount: doc.bufferedPageRange().count };
}

export async function generateInvoicePdf(userId: string, invoiceNumber: string) {
  if (!invoiceNumber) return null;
  const ledger = await getBillingInvoices(userId, { invoiceNumber, limit: 500 });
  if (!ledger.rows.length) return null;

  const doc = new PDFDocument({ size: 'LETTER', margin: 40, autoFirstPage: true, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const first = ledger.rows[0]!;
  const total = ledger.rows.reduce((sum, r) => sum + r.amount, 0);
  doc.fontSize(16).font('Helvetica-Bold').text(`Invoice ${invoiceNumber}`);
  doc.fontSize(9).font('Helvetica').fillColor('#555').text(
    `Warehouse: ${first.warehouse || '—'} · Status: ${first.status} · Billed for: ${(first.date || '').slice(0, 10)}`,
  );
  doc.fillColor('#000');
  drawPdfDivider(doc);
  drawBillingLedgerTable(doc, ledger.rows);
  drawPdfDivider(doc);
  doc.fontSize(11).font('Helvetica-Bold').text(`Total: $${total.toFixed(2)}`, { align: 'right' });

  doc.end();
  const buffer = await done;
  return { buffer, filename: `invoice-${invoiceNumber}.pdf`, pageCount: doc.bufferedPageRange().count };
}

export async function getOmsOrder(userId: string, orderId: string) {
  if (!orderId) return null;
  const order = await one(
    `SELECT o.*, c.email AS customer_email, c.name AS customer_name, mc.channel AS account_channel, mc.display_name, mc.shop_domain, mc.selling_partner_id
     FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN marketplace_connections mc ON mc.id = o.channel_connection_id
     WHERE o.user_id = $1 AND o.id = $2
     LIMIT 1`,
    [userId, orderId],
  );
  if (!order) return null;
  const totals = json(order.totals, {});
  return {
    ...order,
    id: order.id,
    publicId: publicEntityId('OR', order.id),
    displayId: publicEntityId('OR', order.id),
    customerDisplayId: order.customer_id ? publicEntityId('CU', order.customer_id) : null,
    customer: order.customer_name || order.customer_email || undefined,
    ch: order.channel || order.account_channel || 'manual',
    channelAccountId: order.channel_connection_id || null,
    channelDisplay: order.display_name || order.shop_domain || order.selling_partner_id || order.channel || order.account_channel || 'manual',
    total: money(totals.total || totals.subtotal || 0),
    placedAt: iso(order.placed_at),
    createdAt: iso(order.created_at),
    updatedAt: iso(order.updated_at),
  };
}

export async function getOmsAsn(userId: string, asnId: string) {
  if (!asnId) return null;
  const asn = await one(
    `SELECT a.*,
            sp.internal_shipment_id,
            sp.shipment_title,
            sp.status AS shipment_status,
            sp.supplier_id,
            sp.facility_id,
            sp.estimated_arrival_date,
            sp.items,
            s.name AS supplier_name,
            f.code AS facility_code,
            f.name AS facility_name
     FROM asns a
     LEFT JOIN shipment_plans sp ON sp.id = a.shipment_plan_id AND sp.user_id = a.user_id
     LEFT JOIN suppliers s ON s.id = sp.supplier_id AND s.user_id = a.user_id
     LEFT JOIN facilities f ON f.id = sp.facility_id
     WHERE a.user_id = $1 AND a.id = $2
     LIMIT 1`,
    [userId, asnId],
  );
  if (!asn) return null;
  const items = json(asn.items, []);
  const units = Array.isArray(items) ? items.reduce((sum, item) => sum + number(item.quantity || item.units || 0), 0) : 0;
  return {
    id: asn.id,
    _id: asn.id,
    publicId: publicEntityId('AS', asn.id),
    displayId: publicEntityId('AS', asn.id),
    asnNumber: asn.asn_number,
    status: asn.status || 'created',
    shipmentPlanId: asn.shipment_plan_id,
    shipmentDisplayId: asn.shipment_plan_id ? publicEntityId('SH', asn.shipment_plan_id) : null,
    shipmentTitle: asn.shipment_title || asn.internal_shipment_id || 'Inbound shipment',
    shipmentStatus: asn.shipment_status || null,
    supplierId: asn.supplier_id || null,
    supplierDisplayId: asn.supplier_id ? publicEntityId('SU', asn.supplier_id) : null,
    supplierName: asn.supplier_name || null,
    facilityId: asn.facility_id || null,
    facilityCode: asn.facility_code || null,
    facilityName: asn.facility_name || null,
    estimatedArrivalDate: iso(asn.estimated_arrival_date),
    units,
    items,
    payload: json(asn.payload, {}),
    createdAt: iso(asn.created_at),
    updatedAt: iso(asn.updated_at),
  };
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
