import fetch from 'node-fetch';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config/env';
import { getClosestFacilityByShipFromLocation } from './shipment-plan-service';
import type { IShipmentPlanItem } from '../models/shipment-plan';

export type EstimateLineItem = {
  code: string;
  label: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
};

export type EstimateServiceFeesResult = {
  total: number;
  perUnit: number;
  lineItems: EstimateLineItem[];
  warehouseCode?: string;
};

const VOLUME_THRESHOLD = 500;

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

async function fetchPricingProfile(warehouseCode: string): Promise<{
  receivingRates: { perAsn?: number; perUnit?: number };
  labRates: { labelingFeePerUnit?: number; reboxingFeePerUnit?: number };
  labRatesByServiceType: Record<string, number>;
}> {
  if (!config.wmsApiUrl || !config.internalApiKey) {
    return {
      receivingRates: {},
      labRates: {},
      labRatesByServiceType: {},
    };
  }
  const url = `${config.wmsApiUrl}/api/v1/internal/oms/pricing-profile?warehouseCode=${encodeURIComponent(warehouseCode)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Internal-Api-Key': config.internalApiKey },
  });
  const data = (await res.json().catch(() => ({}))) as {
    receivingRates?: { perAsn?: number; perUnit?: number };
    labRates?: { labelingFeePerUnit?: number; reboxingFeePerUnit?: number };
    labRatesByServiceType?: Record<string, number>;
  };
  return {
    receivingRates: data.receivingRates || {},
    labRates: data.labRates || {},
    labRatesByServiceType: data.labRatesByServiceType || {},
  };
}

function getLabFeeForServiceType(
  serviceType: string,
  labRates: { labelingFeePerUnit?: number; reboxingFeePerUnit?: number },
  labRatesByServiceType: Record<string, number>
): number {
  const normalized = String(serviceType).toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-');
  const fromMap = Number(labRatesByServiceType[normalized]);
  if (Number.isFinite(fromMap) && fromMap > 0) return fromMap;
  if (normalized.includes('label') || normalized.includes('relabel')) return Number(labRates.labelingFeePerUnit) || 0;
  if (normalized.includes('rebox')) return Number(labRates.reboxingFeePerUnit) || 0;
  return 0;
}

export async function estimateServiceFees(params: {
  userId: string;
  shipFromLocationId: string;
  items: Array<{
    sku: string;
    quantity?: number;
    boxCount?: number;
    labRequirements?: { services?: Array<{ type: string; bundleQuantity?: number }> };
  }>;
  prepServicesOnly: boolean;
  marketplaceType?: 'FBA' | 'FBW';
  log?: FastifyBaseLogger;
}): Promise<EstimateServiceFeesResult> {
  const { userId, shipFromLocationId, items, prepServicesOnly } = params;
  const lineItems: EstimateLineItem[] = [];
  let total = 0;

  const closest = await getClosestFacilityByShipFromLocation({
    userId,
    shipFromLocationId,
    ...(params.log != null ? { log: params.log } : {}),
  });

  const warehouseCode = closest?.facility?.code;
  if (!warehouseCode) {
    return { total: 0, perUnit: 0, lineItems: [] };
  }

  const profile = await fetchPricingProfile(warehouseCode);
  const { receivingRates, labRates, labRatesByServiceType } = profile;

  const validItems = items.filter((i) => (Number(i.quantity) || 0) > 0);
  const totalUnits = validItems.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const skuCount = validItems.length;

  // Receiving: per ASN OR per unit (one or the other, volume-based)
  // Over 500 units: use whichever gives LOWER total
  // Under 500 units: use whichever gives HIGHER total
  const perAsn = Number(receivingRates.perAsn) || 0;
  const perUnit = Number(receivingRates.perUnit) || 0;
  const costPerAsn = perAsn;
  const costPerUnit = totalUnits > 0 ? roundMoney(totalUnits * perUnit) : 0;
  const receivingAmount =
    totalUnits >= VOLUME_THRESHOLD
      ? Math.min(costPerAsn, costPerUnit)
      : Math.max(costPerAsn, costPerUnit);

  if (receivingAmount > 0) {
    const usePerAsn = totalUnits >= VOLUME_THRESHOLD ? costPerAsn <= costPerUnit : costPerAsn >= costPerUnit;
    lineItems.push({
      code: usePerAsn ? 'RECEIVING_ASN' : 'RECEIVING_UNIT',
      label: usePerAsn ? 'Receiving (per ASN)' : 'Receiving (per unit)',
      quantity: usePerAsn ? 1 : totalUnits,
      unit: usePerAsn ? 'asn' : 'unit',
      unitPrice: usePerAsn ? perAsn : perUnit,
      amount: roundMoney(receivingAmount),
    });
    total += roundMoney(receivingAmount);
  }

  // LAB fees: FBA/FBW gets relabeling + assembly (bundling, kitting) based on labRequirements
  let labRelabelTotal = 0;
  const labOtherByType: Record<string, { qty: number; amount: number }> = {};

  for (const item of validItems) {
    const qty = Number(item.quantity) || 0;
    const services = item.labRequirements?.services ?? [];

    for (const svc of services) {
      const fee = getLabFeeForServiceType(
        svc.type,
        labRates,
        labRatesByServiceType as Record<string, number>
      );
      if (fee <= 0) continue;

      const svcQty = svc.type === 'bundling' || svc.type === 'kitting'
        ? Math.ceil(qty / Math.max(1, svc.bundleQuantity ?? 1))
        : qty;
      const amt = roundMoney(svcQty * fee);

      if (svc.type === 'relabeling' || (String(svc.type).toLowerCase().includes('label'))) {
        labRelabelTotal += amt;
      } else {
        const key = svc.type;
        if (!labOtherByType[key]) labOtherByType[key] = { qty: 0, amount: 0 };
        labOtherByType[key].qty += svcQty;
        labOtherByType[key].amount += amt;
      }
    }

    // FBA/FBW: relabeling required for all units if not already in services
    if (prepServicesOnly && !services.some((s) => s.type === 'relabeling')) {
      const fee = getLabFeeForServiceType('relabeling', labRates, labRatesByServiceType as Record<string, number>);
      if (fee > 0) {
        labRelabelTotal += roundMoney(qty * fee);
      }
    }
  }

  if (labRelabelTotal > 0) {
    const relabelFee = getLabFeeForServiceType('relabeling', labRates, labRatesByServiceType as Record<string, number>);
    lineItems.push({
      code: 'LAB_RELABELING',
      label: 'LAB Relabeling',
      quantity: totalUnits,
      unit: 'unit',
      unitPrice: relabelFee,
      amount: roundMoney(labRelabelTotal),
    });
    total += roundMoney(labRelabelTotal);
  }

  const labels: Record<string, string> = {
    bundling: 'LAB Bundling',
    kitting: 'LAB Kitting',
    'shrink-wrap': 'LAB Shrink wrap',
    'bubble-wrap': 'LAB Bubble wrap',
    'quality-control': 'LAB Quality control',
    'custom-inserts': 'LAB Custom inserts',
    'gift-wrapping': 'LAB Gift wrapping',
    personalization: 'LAB Personalization',
  };
  for (const [type, data] of Object.entries(labOtherByType)) {
    if (data.amount <= 0) continue;
    lineItems.push({
      code: `LAB_${type.toUpperCase().replace(/-/g, '_')}`,
      label: labels[type] || `LAB ${type}`,
      quantity: data.qty,
      unit: 'unit',
      unitPrice: roundMoney(data.amount / data.qty),
      amount: roundMoney(data.amount),
    });
    total += roundMoney(data.amount);
  }

  const perUnitCost = totalUnits > 0 ? roundMoney(total / totalUnits) : 0;

  return {
    total: roundMoney(total),
    perUnit: perUnitCost,
    lineItems,
    warehouseCode,
  };
}
