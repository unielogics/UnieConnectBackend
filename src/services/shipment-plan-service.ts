import { randomUUID } from 'crypto';
import { FastifyBaseLogger } from 'fastify';
import { Types } from 'mongoose';
import { ASN } from '../models/asn';
import { Item } from '../models/item';
import { ItemActivityLog } from '../models/item-activity-log';
import { PricingCard } from '../models/pricing-card';
import {
  ShipmentPlan,
  IShipmentPlan,
  IShipmentPlanItem,
  ShipmentPlanStatus,
} from '../models/shipment-plan';
import { ShipmentActivityLog } from '../models/shipment-activity-log';
import { ShipFromLocation } from '../models/ship-from-location';
import { Supplier } from '../models/supplier';
import { Facility } from '../models/facility';
import { getClosestFacility, geocodeAddressIfNeeded, AddressWithCoords } from './facility-routing';
import { shippoRateQuoteFromTo } from './shippo-rate-shopping';
import fetch from 'node-fetch';
import { config } from '../config/env';

export interface ValidationError {
  field: string;
  message: string;
}

export function validateShipmentPlanItems(items: IShipmentPlanItem[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const skuSet = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const qty = Number(item.quantity) || 0;
    const boxes = Number(item.boxCount) || 0;
    const unitsPerBox = Number(item.unitsPerBox) || 0;

    if (!item.sku?.trim()) {
      errors.push({ field: `items[${i}].sku`, message: 'SKU is required' });
    } else if (skuSet.has(item.sku.trim())) {
      errors.push({ field: `items[${i}].sku`, message: 'Duplicate SKU in plan' });
    } else {
      skuSet.add(item.sku.trim());
    }

    if (qty <= 0) {
      errors.push({ field: `items[${i}].quantity`, message: 'Quantity must be greater than 0' });
    }
    if (boxes <= 0) {
      errors.push({ field: `items[${i}].boxCount`, message: 'Box count must be at least 1' });
    }
    if (unitsPerBox <= 0) {
      errors.push({ field: `items[${i}].unitsPerBox`, message: 'Units per box must be greater than 0' });
    }
    if (boxes * unitsPerBox !== qty) {
      errors.push({
        field: `items[${i}]`,
        message: `Box count × units per box must equal quantity (${boxes} × ${unitsPerBox} ≠ ${qty})`,
      });
    }
    const expDt = item.expDate;
    if (expDt && new Date(expDt) < new Date()) {
      errors.push({ field: `items[${i}].expDate`, message: 'Expiration date must be in the future' });
    }
  }

  return errors;
}

const EDITABLE_STATUSES: ShipmentPlanStatus[] = ['draft'];
const CANCELLABLE_STATUSES: ShipmentPlanStatus[] = ['draft', 'submitted'];

async function resolveShipFromAddress(
  userId: string,
  shipFromLocationId: string
): Promise<AddressWithCoords & { name?: string; phone?: string }> {
  const location = await ShipFromLocation.findOne({ _id: shipFromLocationId, userId })
    .lean()
    .exec();
  if (!location) throw new Error('Ship-from location not found');

  const supplier = await Supplier.findOne({ _id: location.supplierId, userId }).lean().exec();
  if (!supplier) throw new Error('Supplier not found');

  const addr = location.address as any;
  return {
    name: (location.contactName || supplier.name || location.label) as string,
    addressLine1: addr.addressLine1,
    addressLine2: addr.addressLine2,
    city: addr.city,
    stateOrProvinceCode: addr.stateOrProvinceCode,
    postalCode: addr.postalCode,
    countryCode: addr.countryCode,
    lat: addr.lat,
    long: addr.long,
    phone: (location.phone || supplier.phone) as string,
  };
}

async function logShipmentActivity(params: {
  userId: string;
  shipmentPlanId: string;
  internalShipmentId: string;
  action: string;
  metadata?: Record<string, unknown>;
}) {
  await ShipmentActivityLog.create({
    userId: params.userId,
    shipmentPlanId: params.shipmentPlanId,
    internalShipmentId: params.internalShipmentId,
    action: params.action,
    metadata: params.metadata,
  });
}

async function logItemActivities(params: {
  userId: string;
  skus: string[];
  action: string;
  shipmentPlanId: string;
  internalShipmentId: string;
  metadata?: Record<string, unknown>;
}) {
  const items = await Item.find({ userId: params.userId, sku: { $in: params.skus } })
    .lean()
    .exec();
  const itemBySku = new Map(items.map((i: any) => [i.sku, i]));

  for (const sku of params.skus) {
    await ItemActivityLog.create({
      userId: params.userId,
      itemId: itemBySku.get(sku)?._id,
      sku,
      action: params.action,
      shipmentPlanId: params.shipmentPlanId,
      internalShipmentId: params.internalShipmentId,
      metadata: params.metadata,
    });
  }
}

export async function computeEstimatedCost(params: {
  facilityId: string;
  userId: string;
  items: IShipmentPlanItem[];
}): Promise<{ total: number; perUnit: number; breakdown: Record<string, number> }> {
  const card = await PricingCard.findOne({ facilityId: params.facilityId, userId: params.userId })
    .lean()
    .exec();

  const costPerBox = Number(card?.costPerBox ?? 0);
  const costPerUnit = Number(card?.costPerUnit ?? 0);
  const labelingPerUnit = Number(card?.labeling ?? 0);

  let total = 0;
  const breakdown: Record<string, number> = { boxes: 0, units: 0, labeling: 0 } as Record<string, number>;

  for (const item of params.items) {
    const qty = Number(item.quantity) || 0;
    const boxes = Number(item.boxCount) || 0;
    const boxCost = boxes * costPerBox;
    const unitCost = qty * costPerUnit;
    const labelCost = qty * labelingPerUnit;
    breakdown['boxes'] = (breakdown['boxes'] ?? 0) + boxCost;
    breakdown['units'] = (breakdown['units'] ?? 0) + unitCost;
    breakdown['labeling'] = (breakdown['labeling'] ?? 0) + labelCost;
    total += boxCost + unitCost + labelCost;
  }

  const totalUnits = params.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
  const perUnit = totalUnits > 0 ? total / totalUnits : 0;

  return { total, perUnit, breakdown };
}

export type CreateShipmentPlanInput = {
  userId: string;
  supplierId: string;
  shipFromLocationId: string;
  prepServicesOnly: boolean;
  marketplaceId?: string;
  marketplaceType?: 'FBA' | 'FBW';
  items: IShipmentPlanItem[];
  orderNo?: string;
  receiptNo?: string;
  orderDate?: Date;
  estimatedArrivalDate?: Date;
  shipmentTitle?: string;
  log?: FastifyBaseLogger;
};

export async function createShipmentPlan(input: CreateShipmentPlanInput): Promise<any> {
  const { userId, log } = input;
  const errors = validateShipmentPlanItems(input.items);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.map((e) => e.message).join('; ')}`);
  }

  const shipFromAddr = await resolveShipFromAddress(userId, input.shipFromLocationId);
  const closest = await getClosestFacility({
    userId,
    address: shipFromAddr,
    ...(log != null && { log }),
  });

  const internalShipmentId = `SP-${randomUUID().slice(0, 8).toUpperCase()}`;

  const facilityId = closest?.facilityId;
  const validFacilityId =
    facilityId &&
    typeof facilityId === 'string' &&
    facilityId.length === 24 &&
    /^[a-f0-9]{24}$/i.test(facilityId)
      ? facilityId
      : undefined;

  const doc = await ShipmentPlan.create({
    internalShipmentId,
    userId,
    supplierId: input.supplierId,
    shipFromLocationId: input.shipFromLocationId,
    prepServicesOnly: input.prepServicesOnly,
    marketplaceId: input.marketplaceId,
    marketplaceType: input.marketplaceType,
    facilityId: validFacilityId,
    status: 'draft',
    items: input.items,
    shipFromAddress: {
      name: shipFromAddr.name,
      addressLine1: shipFromAddr.addressLine1,
      addressLine2: (shipFromAddr as any).addressLine2,
      addressLine3: (shipFromAddr as any).addressLine3,
      city: shipFromAddr.city,
      stateOrProvinceCode: shipFromAddr.stateOrProvinceCode,
      postalCode: shipFromAddr.postalCode,
      countryCode: shipFromAddr.countryCode,
      phone: shipFromAddr.phone,
      ...(shipFromAddr.lat != null && { lat: shipFromAddr.lat }),
      ...(shipFromAddr.long != null && { long: shipFromAddr.long }),
    },
    orderNo: input.orderNo,
    receiptNo: input.receiptNo,
    orderDate: input.orderDate,
    estimatedArrivalDate: input.estimatedArrivalDate,
    shipmentTitle: input.shipmentTitle,
  });

  const planId = String(doc._id);
  await logShipmentActivity({
    userId,
    shipmentPlanId: planId,
    internalShipmentId,
    action: 'created',
    metadata: {
      supplierId: input.supplierId,
      facilityId: closest?.facilityId,
      itemCount: input.items.length,
    },
  });
  await logItemActivities({
    userId,
    skus: input.items.map((i) => i.sku),
    action: 'shipment_created',
    shipmentPlanId: planId,
    internalShipmentId,
    metadata: { itemCount: input.items.length },
  });

  log?.info({ internalShipmentId, planId }, 'Shipment plan created');
  return serializeShipmentPlan(doc, closest);
}

export type UpdateShipmentPlanInput = {
  userId: string;
  id: string;
  items?: IShipmentPlanItem[];
  orderNo?: string;
  receiptNo?: string;
  orderDate?: Date;
  estimatedArrivalDate?: Date;
  shipmentTitle?: string;
  status?: ShipmentPlanStatus;
  log?: FastifyBaseLogger;
};

export async function updateShipmentPlan(input: UpdateShipmentPlanInput): Promise<any> {
  const { userId, id, log } = input;
  const existing = await ShipmentPlan.findOne({ _id: id, userId }).exec();
  if (!existing) throw new Error('Shipment plan not found');

  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw new Error(`Cannot edit shipment plan in status ${existing.status}`);
  }

  if (input.items != null) {
    const errors = validateShipmentPlanItems(input.items);
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.map((e) => e.message).join('; ')}`);
    }
    existing.items = input.items;
  }
  if (input.orderNo !== undefined) existing.orderNo = input.orderNo;
  if (input.receiptNo !== undefined) existing.receiptNo = input.receiptNo;
  if (input.orderDate !== undefined) existing.orderDate = input.orderDate;
  if (input.estimatedArrivalDate !== undefined) existing.estimatedArrivalDate = input.estimatedArrivalDate;
  if (input.shipmentTitle !== undefined) existing.shipmentTitle = input.shipmentTitle;
  if (input.status) existing.status = input.status;

  await existing.save();
  const closest = existing.facilityId
    ? { facilityId: String(existing.facilityId), facility: null, distanceMiles: 0 }
    : null;

  await logShipmentActivity({
    userId,
    shipmentPlanId: id,
    internalShipmentId: existing.internalShipmentId,
    action: 'updated',
    metadata: { previousStatus: existing.status },
  });
  if (input.items) {
    await logItemActivities({
      userId,
      skus: input.items.map((i) => i.sku),
      action: 'shipment_updated',
      shipmentPlanId: id,
      internalShipmentId: existing.internalShipmentId,
    });
  }

  return serializeShipmentPlan(existing, closest);
}

export async function cancelShipmentPlan(params: {
  userId: string;
  id: string;
  log?: FastifyBaseLogger;
}): Promise<any> {
  const { userId, id, log } = params;
  const existing = await ShipmentPlan.findOne({ _id: id, userId }).exec();
  if (!existing) throw new Error('Shipment plan not found');

  if (!CANCELLABLE_STATUSES.includes(existing.status)) {
    throw new Error(`Cannot cancel shipment plan in status ${existing.status}`);
  }

  const prevStatus = existing.status;
  existing.status = 'cancelled';
  await existing.save();

  await logShipmentActivity({
    userId,
    shipmentPlanId: id,
    internalShipmentId: existing.internalShipmentId,
    action: 'cancelled',
    metadata: { previousStatus: prevStatus },
  });

  log?.info({ id, internalShipmentId: existing.internalShipmentId }, 'Shipment plan cancelled');
  return serializeShipmentPlan(existing);
}

export async function submitShipmentPlan(params: {
  userId: string;
  id: string;
  log?: FastifyBaseLogger;
}): Promise<any> {
  const { userId, id, log } = params;
  const existing = await ShipmentPlan.findOne({ _id: id, userId }).exec();
  if (!existing) throw new Error('Shipment plan not found');

  if (existing.status !== 'draft') {
    throw new Error('Can only submit draft plans');
  }

  const errors = validateShipmentPlanItems(existing.items);
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.map((e) => e.message).join('; ')}`);
  }

  existing.status = 'submitted';
  await existing.save();

  await logShipmentActivity({
    userId,
    shipmentPlanId: id,
    internalShipmentId: existing.internalShipmentId,
    action: 'submitted',
  });

  return serializeShipmentPlan(existing);
}

export async function createASNForShipmentPlan(params: {
  userId: string;
  shipmentPlanId: string;
  log?: FastifyBaseLogger;
}): Promise<any> {
  const { userId, shipmentPlanId, log } = params;
  const plan = await ShipmentPlan.findOne({ _id: shipmentPlanId, userId }).exec();
  if (!plan) throw new Error('Shipment plan not found');

  if (!plan.facilityId) throw new Error('No facility assigned; cannot create ASN');
  if (plan.asnId) throw new Error('ASN already exists for this plan');

  plan.invoicingTerms = { acknowledgedAt: new Date(), termsVersion: '1.0' };
  await plan.save();

  const poNo = plan.orderNo || `PO-${plan.internalShipmentId}`;

  let wmsAsnId: string | undefined;
  let wmsLineItems: Array<{ sku: string; wmsItemId: string; wmsSku: string }> = [];
  const facility = await Facility.findById(plan.facilityId).lean().exec();
  const warehouseCode = (facility as any)?.code;
  if (config.wmsApiUrl && config.internalApiKey && warehouseCode) {
    const facilityCode = warehouseCode;
    const { OmsIntermediary } = await import('../models/oms-intermediary');
    const { OmsIntermediaryWarehouse } = await import('../models/oms-intermediary-warehouse');
    const { User } = await import('../models/user');
    const user = await User.findById(userId).select('email').lean().exec();
    const oms = user?.email
      ? await OmsIntermediary.findOne({ email: (user.email as string).toLowerCase(), status: 'active' }).select('_id').lean().exec()
      : null;
    const omsId = oms?._id;
    const link = omsId
      ? await OmsIntermediaryWarehouse.findOne({ omsIntermediaryId: omsId, warehouseCode: facilityCode }).lean().exec()
      : null;
    const wmsIntermediaryId = link ? String((link as any).wmsIntermediaryId) : null;

    if (wmsIntermediaryId) {
      const shipFromAddr = await resolveShipFromAddress(userId, String(plan.shipFromLocationId));
      const url = `${config.wmsApiUrl}/api/v1/internal/oms/asn/create`;
      const body = {
        warehouseCode: facilityCode,
        omsIntermediaryId: omsId ? String(omsId) : undefined,
        wmsIntermediaryId,
        poNumber: poNo,
        shipFromAddress: {
          name: shipFromAddr.name,
          addressLine1: shipFromAddr.addressLine1,
          city: shipFromAddr.city,
          stateOrProvinceCode: shipFromAddr.stateOrProvinceCode,
          postalCode: shipFromAddr.postalCode,
          countryCode: shipFromAddr.countryCode,
        },
        lineItems: plan.items.map((i) => ({
          sku: i.sku,
          wmsSku: (i as any).wmsSku,
          itemName: (i as any).title || i.sku,
          quantity: i.quantity,
          unitsPerContainer: i.unitsPerBox,
          containersCount: i.boxCount,
          fnsku: i.fnsku,
          expDate: i.expDate,
        })),
        eta: plan.orderDate || new Date(),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Api-Key': config.internalApiKey,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        wmsAsnId = data.wmsAsnId;
        wmsLineItems = data.lineItems || [];
      } else {
        const errText = await res.text();
        log?.warn({ status: res.status, body: errText }, 'WMS ASN create failed');
        throw new Error(`WMS ASN create failed: ${res.status} ${errText.slice(0, 200)}`);
      }
    }
  }

  const asn = await ASN.create({
    shipmentPlanId: plan._id,
    facilityId: plan.facilityId,
    userId,
    poNo,
    orderDate: plan.orderDate || new Date(),
    lineItems: plan.items.map((i) => ({
      sku: i.sku,
      quantity: i.quantity,
      fnsku: i.fnsku,
      expDate: i.expDate,
    })),
    status: 'new',
    wmsAsnId: wmsAsnId || undefined,
  });

  plan.asnId = asn._id as Types.ObjectId;
  plan.status = 'asn_created';
  if (wmsAsnId) plan.wmsAsnId = wmsAsnId;
  if (wmsLineItems.length > 0) {
    const skuToWms = new Map(wmsLineItems.map((li) => [li.sku, li]));
    plan.items = plan.items.map((i) => {
      const w = skuToWms.get(i.sku);
      if (w) {
        const plain = typeof (i as unknown as { toObject?: () => object }).toObject === 'function'
          ? (i as unknown as { toObject: () => object }).toObject()
          : i;
        return {
          ...plain,
          wmsItemId: w.wmsItemId,
          wmsSku: w.wmsSku,
        } as unknown as IShipmentPlanItem;
      }
      return i;
    });
  }
  await plan.save();

  await logShipmentActivity({
    userId,
    shipmentPlanId,
    internalShipmentId: plan.internalShipmentId,
    action: 'asn_created',
    metadata: { asnId: String(asn._id) },
  });
  await logItemActivities({
    userId,
    skus: plan.items.map((i) => i.sku),
    action: 'asn_line_created',
    shipmentPlanId,
    internalShipmentId: plan.internalShipmentId,
    metadata: { asnId: String(asn._id) },
  });

  log?.info({ shipmentPlanId, asnId: asn._id }, 'ASN created');
  return { asn: serializeASN(asn), plan: serializeShipmentPlan(plan) };
}

export async function rateShopToWarehouse(params: {
  userId: string;
  shipmentPlanId: string;
  log?: FastifyBaseLogger;
}): Promise<{ parcel: Array<{ amount: number; currency: string; provider?: string }>; ltl: any[]; ftl: any[] }> {
  const { userId, shipmentPlanId, log } = params;
  const plan = await ShipmentPlan.findOne({ _id: shipmentPlanId, userId })
    .populate('facilityId')
    .lean()
    .exec();
  if (!plan) throw new Error('Shipment plan not found');
  const shipFrom = plan.shipFromAddress as any;
  const facility = plan.facilityId as any;
  if (!shipFrom?.city || !shipFrom?.stateOrProvinceCode) throw new Error('Ship-from address incomplete');
  if (!facility?.address?.city || !facility?.address?.stateOrProvinceCode) {
    const fac = await Facility.findById(plan.facilityId).lean().exec();
    if (!fac?.address) throw new Error('Facility address not found');
  }
  const addr = facility?.address || (await Facility.findById(plan.facilityId).lean().exec())?.address as any;
  const toCity = addr?.city || '';
  const toState = addr?.stateOrProvinceCode || addr?.state || '';
  const toZip = addr?.postalCode || addr?.postalCode || '';
  const totalUnits = (plan.items || []).reduce((s: number, i: any) => s + (Number(i.quantity) || 0), 0);
  const weightLbs = (plan.items || []).reduce((s: number, i: any) => {
    const w = Number(i.weightPerBox) || 0;
    const boxes = Number(i.boxCount) || 1;
    return s + w * boxes;
  }, 0) || Math.max(1, totalUnits * 0.5);
  try {
    const parcelQuote = await shippoRateQuoteFromTo({
      fromCity: shipFrom.city,
      fromState: shipFrom.stateOrProvinceCode,
      fromZip: shipFrom.postalCode,
      toCity,
      toState,
      toZip,
      weightLbs: Math.max(weightLbs, 1),
    });
    return {
      parcel: [{
        amount: parcelQuote.amount,
        currency: parcelQuote.currency,
        ...(parcelQuote.provider != null ? { provider: parcelQuote.provider } : {}),
      }],
      ltl: [],
      ftl: [],
    };
  } catch (err: any) {
    log?.warn({ err, shipmentPlanId }, 'rate shop to warehouse failed');
    throw err;
  }
}

export async function listShipmentPlans(params: {
  userId: string;
  limit?: number;
  offset?: number;
  status?: ShipmentPlanStatus;
}): Promise<{ plans: any[]; total: number }> {
  const { userId, limit = 50, offset = 0, status } = params;
  const query: Record<string, unknown> = { userId };
  if (status) query.status = status;

  const total = await ShipmentPlan.countDocuments(query);
  const docs = await ShipmentPlan.find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .populate('supplierId', 'name')
    .populate('facilityId', 'name code')
    .lean()
    .exec();

  const plans = docs.map((d: any) => serializeShipmentPlan(d));
  return { plans, total };
}

export async function getShipmentPlan(params: { userId: string; id: string }): Promise<any> {
  const { userId, id } = params;
  const doc = await ShipmentPlan.findOne({ _id: id, userId })
    .populate('supplierId', 'name email phone')
    .populate('facilityId', 'name code address')
    .populate('shipFromLocationId')
    .lean()
    .exec();

  if (!doc) return null;
  return serializeShipmentPlan(doc);
}

export async function getClosestFacilityByShipFromLocation(params: {
  userId: string;
  shipFromLocationId: string;
  log?: FastifyBaseLogger;
}): Promise<{
  facilityId: string | null;
  facility: any;
  distanceMiles: number | null;
  shipFromAddress?: { lat: number; long: number };
} | null> {
  const addr = await resolveShipFromAddress(params.userId, params.shipFromLocationId);
  const addrWithCoords = await geocodeAddressIfNeeded({
    address: addr,
    ...(params.log != null && { log: params.log }),
  });
  const closest = await getClosestFacility({
    userId: params.userId,
    address: addrWithCoords,
    ...(params.log != null && { log: params.log }),
  });
  const lat = addrWithCoords.lat;
  const long = addrWithCoords.long;
  const shipFromAddress =
    lat != null && long != null && Number.isFinite(lat) && Number.isFinite(long)
      ? { lat, long }
      : undefined;
  if (!closest) return shipFromAddress ? { facilityId: null as string | null, facility: null, distanceMiles: null as number | null, shipFromAddress } : null;
  const result: { facilityId: string; facility: any; distanceMiles: number; shipFromAddress?: { lat: number; long: number } } = { ...closest };
  if (shipFromAddress) result.shipFromAddress = shipFromAddress;
  return result;
}

export async function getClosestFacilityForPlan(params: {
  userId: string;
  shipmentPlanId: string;
  log?: FastifyBaseLogger;
}): Promise<any> {
  const { userId, shipmentPlanId, log } = params;
  const plan = await ShipmentPlan.findOne({ _id: shipmentPlanId, userId }).lean().exec();
  if (!plan) throw new Error('Shipment plan not found');

  const shipFromAddr = plan.shipFromAddress as any;
  if (!shipFromAddr) throw new Error('Ship-from address not resolved');

  const addr: AddressWithCoords = {
    addressLine1: shipFromAddr.addressLine1,
    city: shipFromAddr.city,
    stateOrProvinceCode: shipFromAddr.stateOrProvinceCode,
    postalCode: shipFromAddr.postalCode,
    countryCode: shipFromAddr.countryCode,
    lat: shipFromAddr.lat,
    long: shipFromAddr.long,
  };
  return getClosestFacility({ userId, address: addr, ...(log != null && { log }) });
}

function serializeShipmentPlan(doc: any, closest?: any): any {
  const d = doc?.toObject ? doc.toObject() : (doc || {});
  return {
    id: String(d._id),
    internalShipmentId: d.internalShipmentId,
    userId: String(d.userId),
    supplierId: String(d.supplierId),
    shipFromLocationId: String(d.shipFromLocationId),
    prepServicesOnly: d.prepServicesOnly,
    marketplaceId: d.marketplaceId,
    marketplaceType: d.marketplaceType,
    marketplaceShipmentId: d.marketplaceShipmentId,
    marketplacePlanId: d.marketplacePlanId,
    facilityId: d.facilityId ? String(d.facilityId) : null,
    facility: d.facilityId?.name ? { id: String(d.facilityId._id), name: d.facilityId.name, code: d.facilityId.code } : null,
    status: d.status,
    asnId: d.asnId ? String(d.asnId) : null,
    items: d.items || [],
    shipFromAddress: d.shipFromAddress,
    orderNo: d.orderNo,
    receiptNo: d.receiptNo,
    orderDate: d.orderDate,
    estimatedArrivalDate: d.estimatedArrivalDate,
    shipmentTitle: d.shipmentTitle,
    supplier: d.supplierId?.name ? { id: String(d.supplierId._id), name: d.supplierId.name } : null,
    closestFacility: closest ? { facilityId: closest.facilityId, facility: closest.facility, distanceMiles: closest.distanceMiles } : undefined,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function serializeASN(doc: any): any {
  const d = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(d._id),
    shipmentPlanId: String(d.shipmentPlanId),
    facilityId: String(d.facilityId),
    userId: String(d.userId),
    poNo: d.poNo,
    orderDate: d.orderDate,
    lineItems: d.lineItems || [],
    wmsAsnId: d.wmsAsnId,
    status: d.status,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}
