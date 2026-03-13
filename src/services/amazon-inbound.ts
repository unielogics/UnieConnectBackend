import { randomUUID } from 'crypto';
import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { InboundShipment } from '../models/inbound-shipment';
import { ShipFromLocation } from '../models/ship-from-location';
import { Supplier } from '../models/supplier';
import { spApiFetch } from './amazon-spapi';

type ShipFromAddress = {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  districtOrCounty?: string;
  phone?: string;
};

type InboundItem = {
  sellerSku: string;
  asin?: string;
  title?: string;
  quantityPlanned?: number;
  quantityShipped: number;
  quantityInCase?: number;
  boxCount?: number;
  unitsPerBox?: number;
  packingTemplateName?: string;
  packingTemplateType?: string;
  packingGroupId?: string;
  packingStatus?: 'missing_inputs' | 'ready';
  packingNote?: string;
  prepDetailsList?: any[];
};

type DraftItem = {
  sellerSku: string;
  asin?: string;
  title?: string;
  quantity: number;
  quantityInCase?: number;
  boxCount?: number;
  unitsPerBox?: number;
  packingTemplateName?: string;
  packingTemplateType?: string;
  packingGroupId?: string;
  packingStatus?: 'missing_inputs' | 'ready';
  packingNote?: string;
  prepDetailsList?: any[];
};

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizePlanItems(items: Array<{ sellerSku: string; quantity: number; asin?: string; title?: string }>) {
  return items.map((item) => ({
    sellerSku: item.sellerSku,
    asin: item.asin,
    title: item.title,
    quantityPlanned: item.quantity,
    quantityShipped: item.quantity,
  }));
}

function normalizeDraftItems(items: DraftItem[]) {
  return items.map((item) => ({
    sellerSku: item.sellerSku,
    asin: item.asin,
    title: item.title,
    quantityPlanned: item.quantity,
    quantityShipped: item.quantity,
    quantityInCase: item.quantityInCase,
    boxCount: item.boxCount,
    unitsPerBox: item.unitsPerBox,
    packingTemplateName: item.packingTemplateName,
    packingTemplateType: item.packingTemplateType,
    packingGroupId: item.packingGroupId,
    packingStatus: item.packingStatus,
    packingNote: item.packingNote,
    prepDetails: item.prepDetailsList,
  }));
}

function normalizeShipmentItems(items: InboundItem[]) {
  return items.map((item) => ({
    sellerSku: item.sellerSku,
    asin: item.asin,
    title: item.title,
    quantityPlanned: item.quantityPlanned ?? item.quantityShipped,
    quantityShipped: item.quantityShipped,
    quantityInCase: item.quantityInCase,
    boxCount: item.boxCount,
    unitsPerBox: item.unitsPerBox,
    packingTemplateName: item.packingTemplateName,
    packingTemplateType: item.packingTemplateType,
    packingGroupId: item.packingGroupId,
    packingStatus: item.packingStatus,
    packingNote: item.packingNote,
    prepDetails: item.prepDetailsList,
  }));
}

function extractPlanOptions(response: any): any[] {
  const payload = response?.payload ?? response;
  const plans = payload?.InboundShipmentPlans ?? payload?.inboundShipmentPlans;
  return Array.isArray(plans) ? plans : [];
}

function hasReadyPacking(doc: any): boolean {
  const items = Array.isArray(doc?.items) ? doc.items : [];
  return Boolean(
    items.length > 0 &&
      (doc?.shipFromLocationId || doc?.shipFromAddress) &&
      items.every(
        (item: any) =>
          item?.packingStatus === 'ready' && Number(item?.quantityShipped ?? item?.quantityPlanned ?? 0) > 0,
      ),
  );
}

function hasSkuLabels(doc: any): boolean {
  return Boolean(doc?.skuLabels?.fetchedAt || doc?.skuLabels?.requestedAt);
}

function hasBoxLabels(doc: any): boolean {
  return Boolean(doc?.boxLabels?.url || doc?.labels?.url);
}

function deriveWorkflowStatus(docs: any[]): string {
  if (docs.some((doc) => hasBoxLabels(doc))) return 'box_labels_ready';
  if (docs.some((doc) => doc?.rawShipment)) return 'shipment_confirmed';
  if (docs.some((doc) => doc?.rawPlan)) return 'placement_ready';
  if (docs.some((doc) => hasSkuLabels(doc))) return 'sku_labels_ready';
  if (docs.some((doc) => hasReadyPacking(doc))) return 'packaging_ready';
  return 'draft';
}

function buildSkuLabelSnapshot(items: DraftItem[]) {
  return {
    requestedAt: new Date(),
    fetchedAt: new Date(),
    itemCount: items.length,
    note: 'SKU labels staged for the selected Amazon listed items.',
    items: items.map((item) => ({
      sellerSku: item.sellerSku,
      asin: item.asin,
      title: item.title,
      quantity: item.quantity,
    })),
  };
}

function toWorkflowStatus(doc: any): string {
  return deriveWorkflowStatus([doc]);
}

async function loadAmazonAccount(channelAccountId: string) {
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');
  return account;
}

async function resolveShipFromData(params: {
  userId: string;
  supplierId?: string;
  shipFromLocationId?: string;
  shipFromAddress?: ShipFromAddress;
}) {
  if (params.shipFromAddress) {
    return {
      supplierId: params.supplierId,
      shipFromLocationId: params.shipFromLocationId,
      shipFromAddress: params.shipFromAddress,
    };
  }

  if (!params.shipFromLocationId) {
    throw new Error('shipFromLocationId or shipFromAddress is required');
  }

  const location = await ShipFromLocation.findOne({ _id: params.shipFromLocationId, userId: params.userId }).lean().exec();
  if (!location) throw new Error('Ship-from location not found');

  const supplier = await Supplier.findOne({ _id: location.supplierId, userId: params.userId }).lean().exec();
  if (!supplier) throw new Error('Supplier not found for ship-from location');

  return {
    supplierId: params.supplierId || String(supplier._id),
    shipFromLocationId: String(location._id),
    shipFromAddress: {
      name: firstString(location.contactName, supplier.name, location.label) || 'Ship From',
      addressLine1: location.address.addressLine1,
      addressLine2: location.address.addressLine2,
      addressLine3: location.address.addressLine3,
      city: location.address.city,
      stateOrProvinceCode: location.address.stateOrProvinceCode,
      postalCode: location.address.postalCode,
      countryCode: location.address.countryCode,
      districtOrCounty: location.address.districtOrCounty,
      phone: firstString(location.phone, supplier.phone),
    },
  };
}

function buildResolveShipFromParams(params: {
  userId: string;
  supplierId: string | undefined;
  shipFromLocationId: string | undefined;
  shipFromAddress: ShipFromAddress | undefined;
}) {
  const nextParams: {
    userId: string;
    supplierId?: string;
    shipFromLocationId?: string;
    shipFromAddress?: ShipFromAddress;
  } = {
    userId: params.userId,
  };
  if (params.supplierId) nextParams.supplierId = params.supplierId;
  if (params.shipFromLocationId) nextParams.shipFromLocationId = params.shipFromLocationId;
  if (params.shipFromAddress) nextParams.shipFromAddress = params.shipFromAddress;
  return nextParams;
}

export async function saveInboundWorkflowDraft(params: {
  channelAccountId: string;
  userId: string;
  workflowId?: string;
  supplierId?: string;
  shipFromLocationId?: string;
  shipFromAddress?: ShipFromAddress;
  labelPrepPreference?: string;
  packingMode?: string;
  items?: DraftItem[];
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, userId, shipFromAddress, labelPrepPreference, packingMode, items, log, supplierId, shipFromLocationId } = params;
  const workflowId = params.workflowId || randomUUID();
  const account = await loadAmazonAccount(channelAccountId);
  const normalizedItems = Array.isArray(items) ? normalizeDraftItems(items) : [];
  const resolvedShipFrom =
    shipFromLocationId || shipFromAddress
      ? await resolveShipFromData(buildResolveShipFromParams({ userId, supplierId, shipFromLocationId, shipFromAddress }))
      : null;
  const workflowStatus = resolvedShipFrom && normalizedItems.length > 0 && normalizedItems.every((item) => item.packingStatus === 'ready') ? 'packaging_ready' : 'draft';

  const doc = await InboundShipment.findOneAndUpdate(
    { channelAccountId, workflowId, shipmentId: { $exists: false } },
    {
      userId,
      channelAccountId,
      workflowId,
      channel: 'amazon',
      marketplaceId: (account.marketplaceIds || [])[0],
      packingMode,
      workflowStatus,
      labelPrepPreference,
      supplierId: resolvedShipFrom?.supplierId,
      shipFromLocationId: resolvedShipFrom?.shipFromLocationId,
      shipFromAddress: resolvedShipFrom?.shipFromAddress,
      items: normalizedItems,
      status: workflowStatus === 'packaging_ready' ? 'PACKAGING_READY' : 'DRAFT',
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .lean()
    .exec();

  log.info({ channelAccountId, workflowId }, 'amazon inbound workflow draft saved');
  return doc;
}

export async function fetchInboundSkuLabels(params: {
  channelAccountId: string;
  userId: string;
  workflowId?: string;
  supplierId?: string;
  shipFromLocationId?: string;
  shipFromAddress?: ShipFromAddress;
  labelPrepPreference?: string;
  packingMode?: string;
  items: DraftItem[];
  log: FastifyBaseLogger;
}) {
  const draft = await saveInboundWorkflowDraft(params);
  const workflowId = String(draft.workflowId);
  const labelSnapshot = buildSkuLabelSnapshot(params.items);

  await InboundShipment.findOneAndUpdate(
    { channelAccountId: params.channelAccountId, workflowId, shipmentId: { $exists: false } },
    {
      workflowStatus: 'sku_labels_ready',
      status: 'SKU_LABELS_READY',
      skuLabels: labelSnapshot,
    },
    { new: true, setDefaultsOnInsert: true },
  ).exec();

  params.log.info({ channelAccountId: params.channelAccountId, workflowId }, 'amazon inbound sku labels staged');
  return { workflowId, skuLabels: labelSnapshot };
}

export async function createInboundPlan(params: {
  channelAccountId: string;
  userId: string;
  workflowId?: string;
  packingMode?: string;
  supplierId?: string;
  shipFromLocationId?: string;
  shipFromAddress?: ShipFromAddress;
  labelPrepPreference?: string;
  items: Array<{
    sellerSku: string;
    quantity: number;
    asin?: string;
    condition?: string;
    title?: string;
    quantityInCase?: number;
    boxCount?: number;
    unitsPerBox?: number;
    packingTemplateName?: string;
    packingTemplateType?: string;
    packingGroupId?: string;
    packingStatus?: 'missing_inputs' | 'ready';
    packingNote?: string;
  }>;
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, userId, shipFromAddress, labelPrepPreference, items, log, packingMode, supplierId, shipFromLocationId } = params;
  const workflowId = params.workflowId || randomUUID();
  const account = await loadAmazonAccount(channelAccountId);
  const resolvedShipFrom = await resolveShipFromData(buildResolveShipFromParams({ userId, supplierId, shipFromLocationId, shipFromAddress }));

  const body = {
    ShipFromAddress: resolvedShipFrom.shipFromAddress,
    LabelPrepPreference: labelPrepPreference || 'SELLER_LABEL',
    InboundShipmentPlanRequestItems: items.map((i) => ({
      SellerSKU: i.sellerSku,
      ASIN: i.asin,
      Condition: i.condition || 'NewItem',
      Quantity: i.quantity,
    })),
  };

  const res = await spApiFetch(account, {
    method: 'POST',
    path: '/fba/inbound/v0/plans',
    body,
  });

  const placementOptions = extractPlanOptions(res);
  const marketplaceId = (account.marketplaceIds || [])[0];
  const existingDraft = await InboundShipment.findOne({ channelAccountId, workflowId, shipmentId: { $exists: false } }).lean().exec();
  const existingSkuLabels = existingDraft?.skuLabels;

  await InboundShipment.deleteMany({ channelAccountId, workflowId, shipmentId: { $exists: false } }).exec();

  if (placementOptions.length === 0) {
    await InboundShipment.findOneAndUpdate(
      { channelAccountId, workflowId, shipmentId: { $exists: false } },
      {
        userId,
        channelAccountId,
        workflowId,
        channel: 'amazon',
        marketplaceId,
        packingMode,
        workflowStatus: 'placement_ready',
        labelPrepPreference,
        supplierId: resolvedShipFrom.supplierId,
        shipFromLocationId: resolvedShipFrom.shipFromLocationId,
        shipFromAddress: resolvedShipFrom.shipFromAddress,
        items: items.length > 0 ? normalizeDraftItems(items) : normalizePlanItems(items),
        placementOptions,
        rawPlan: res,
        skuLabels: existingSkuLabels,
        status: 'PLACEMENT_READY',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
  } else {
    for (const placement of placementOptions) {
      const shipmentId = firstString(placement?.ShipmentId, placement?.shipmentId);
      if (!shipmentId) continue;
      const planItemsRaw = Array.isArray(placement?.Items) ? placement.Items : Array.isArray(placement?.items) ? placement.items : [];
      const planItems =
        planItemsRaw.length > 0
          ? planItemsRaw.map((item: any) => ({
              sellerSku: firstString(item?.SellerSKU, item?.sellerSku) || '',
              asin: firstString(item?.ASIN, item?.asin),
              title: firstString(item?.ItemName, item?.itemName),
              quantityPlanned: Number(item?.Quantity ?? item?.quantity ?? 0),
              quantityShipped: Number(item?.Quantity ?? item?.quantity ?? 0),
            }))
          : normalizePlanItems(items);
      const destinationFulfillmentCenterId = firstString(
        placement?.DestinationFulfillmentCenterId,
        placement?.destinationFulfillmentCenterId,
      );

      await InboundShipment.findOneAndUpdate(
        { channelAccountId, shipmentId },
        {
          userId,
          channelAccountId,
          workflowId,
          channel: 'amazon',
          marketplaceId,
          shipmentId,
          destinationFulfillmentCenterId,
          packingMode,
          workflowStatus: 'placement_ready',
          labelPrepPreference,
          shipmentName: firstString(placement?.ShipmentName, placement?.shipmentName) || `Inbound ${shipmentId}`,
          supplierId: resolvedShipFrom.supplierId,
          shipFromLocationId: resolvedShipFrom.shipFromLocationId,
          shipFromAddress: resolvedShipFrom.shipFromAddress,
          items: planItems.map((planItem: any) => {
            const selectedItem = items.find((item) => item.sellerSku === planItem.sellerSku);
            return {
              ...planItem,
              quantityInCase: selectedItem?.quantityInCase,
              boxCount: selectedItem?.boxCount,
              unitsPerBox: selectedItem?.unitsPerBox,
              packingTemplateName: selectedItem?.packingTemplateName,
              packingTemplateType: selectedItem?.packingTemplateType,
              packingGroupId: selectedItem?.packingGroupId,
              packingStatus: selectedItem?.packingStatus,
              packingNote: selectedItem?.packingNote,
            };
          }),
          placementOptions,
          rawPlan: placement,
          skuLabels: existingSkuLabels,
          status: firstString(placement?.ShipmentStatus, placement?.shipmentStatus) || 'PLACEMENT_READY',
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
    }
  }

  log.info({ channelAccountId, workflowId, shipments: placementOptions.length }, 'amazon inbound plan created');
  return { workflowId, placementOptions, raw: res };
}

export async function createInboundShipment(params: {
  channelAccountId: string;
  userId: string;
  workflowId?: string;
  shipmentId: string;
  destinationFulfillmentCenterId: string;
  supplierId?: string;
  shipFromLocationId?: string;
  shipFromAddress?: ShipFromAddress;
  packingMode?: string;
  labelPrepPreference?: string;
  shipmentName?: string;
  items: InboundItem[];
  log: FastifyBaseLogger;
}) {
  const {
    channelAccountId,
    userId,
    workflowId,
    shipmentId,
    destinationFulfillmentCenterId,
    shipFromAddress,
    supplierId,
    shipFromLocationId,
    packingMode,
    labelPrepPreference,
    shipmentName,
    items,
    log,
  } = params;

  const account = await loadAmazonAccount(channelAccountId);
  const resolvedShipFrom = await resolveShipFromData(buildResolveShipFromParams({ userId, supplierId, shipFromLocationId, shipFromAddress }));

  const body = {
    ShipmentId: shipmentId,
    InboundShipmentHeader: {
      ShipmentName: shipmentName || `Inbound ${shipmentId}`,
      ShipFromAddress: resolvedShipFrom.shipFromAddress,
      DestinationFulfillmentCenterId: destinationFulfillmentCenterId,
      LabelPrepPreference: labelPrepPreference || 'SELLER_LABEL',
      ShipmentStatus: 'WORKING',
    },
    InboundShipmentItems: items.map((i) => ({
      SellerSKU: i.sellerSku,
      QuantityShipped: i.quantityShipped,
      QuantityInCase: i.quantityInCase,
      PrepDetailsList: i.prepDetailsList,
    })),
  };

  const res = await spApiFetch(account, {
    method: 'POST',
    path: '/fba/inbound/v0/shipments',
    body,
  });

  await InboundShipment.findOneAndUpdate(
    { channelAccountId, shipmentId },
    {
      userId,
      channelAccountId,
      workflowId: workflowId || shipmentId,
      channel: 'amazon',
      marketplaceId: (account.marketplaceIds || [])[0],
      shipmentId,
      destinationFulfillmentCenterId,
      packingMode,
      workflowStatus: 'shipment_confirmed',
      labelPrepPreference,
      shipmentName,
      supplierId: resolvedShipFrom.supplierId,
      shipFromLocationId: resolvedShipFrom.shipFromLocationId,
      shipFromAddress: resolvedShipFrom.shipFromAddress,
      items: normalizeShipmentItems(items),
      rawShipment: res,
      status: firstString(res?.payload?.ShipmentStatus, res?.ShipmentStatus) || 'WORKING',
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  log.info({ channelAccountId, workflowId, shipmentId }, 'amazon inbound shipment created');
  return res;
}

export async function getInboundLabels(params: {
  channelAccountId: string;
  shipmentId: string;
  pageType?: string;
  labelType?: string;
  numberOfPackages?: number;
  log: FastifyBaseLogger;
}) {
  const { channelAccountId, shipmentId, pageType, labelType, numberOfPackages, log } = params;
  const account = await loadAmazonAccount(channelAccountId);

  const res = await spApiFetch(account, {
    method: 'GET',
    path: `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/labels`,
    query: {
      PageType: pageType || 'PackageLabel_Letter',
      LabelType: labelType,
      NumberOfPackages: numberOfPackages,
    },
  });

  const labelUrl = res?.payload?.TransportDocument?.PdfDocument || res?.payload?.DownloadURL || res?.DownloadURL;

  await InboundShipment.updateOne(
    { channelAccountId, shipmentId },
    {
      workflowStatus: 'box_labels_ready',
      boxLabels: {
        url: labelUrl,
        pageType: pageType || 'PackageLabel_Letter',
        labelType,
        fetchedAt: new Date(),
      },
      labels: {
        url: labelUrl,
        pageType: pageType || 'PackageLabel_Letter',
        labelType,
        fetchedAt: new Date(),
      },
    },
  ).exec();

  log.info({ channelAccountId, shipmentId }, 'amazon inbound labels fetched');
  return res;
}

export async function listInboundShipmentHistory(params: {
  channelAccountId: string;
  userId: string;
  workflowStatus?: string;
  limit?: number;
}) {
  const { channelAccountId, userId, workflowStatus } = params;
  const limit = Math.min(Math.max(params.limit || 50, 1), 200);
  const query: Record<string, unknown> = { channelAccountId, userId };
  if (workflowStatus) query.workflowStatus = workflowStatus;

  const docs = await InboundShipment.find(query).sort({ updatedAt: -1, createdAt: -1 }).limit(Math.min(limit * 5, 500)).lean().exec();
  const workflows = new Map<string, any[]>();

  docs.forEach((doc: any) => {
    const key = String(doc.workflowId || '');
    if (!key) return;
    if (!workflows.has(key)) workflows.set(key, []);
    workflows.get(key)!.push(doc);
  });

  return Array.from(workflows.values())
    .map((workflowDocs) => {
      const sorted = [...workflowDocs].sort((a: any, b: any) => {
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
      });
      const latest = sorted[0];
      const skuSet = new Set<string>();

      workflowDocs.forEach((doc: any) => {
        (Array.isArray(doc.items) ? doc.items : []).forEach((item: any) => {
          if (item?.sellerSku) skuSet.add(String(item.sellerSku));
        });
      });

      return {
        id: String(latest._id),
        workflowId: latest.workflowId,
        shipmentId: latest.shipmentId,
        shipmentName: latest.shipmentName || latest.workflowId,
        shipmentCount:
          workflowDocs.filter((doc: any) => doc?.rawShipment).length || workflowDocs.filter((doc: any) => doc?.shipmentId).length || workflowDocs.length,
        workflowStatus: deriveWorkflowStatus(workflowDocs),
        status: latest.status,
        packingMode: latest.packingMode,
        supplierId: latest.supplierId,
        shipFromLocationId: latest.shipFromLocationId,
        shipFromAddress: latest.shipFromAddress,
        marketplaceId: latest.marketplaceId,
        destinationFulfillmentCenterId: latest.destinationFulfillmentCenterId,
        itemCount: skuSet.size,
        skuLabels: workflowDocs.find((doc: any) => hasSkuLabels(doc))?.skuLabels,
        boxLabels: workflowDocs.find((doc: any) => hasBoxLabels(doc))?.boxLabels || workflowDocs.find((doc: any) => doc?.labels?.url)?.labels,
        labels: workflowDocs.find((doc: any) => hasBoxLabels(doc))?.boxLabels || workflowDocs.find((doc: any) => doc?.labels?.url)?.labels,
        updatedAt: latest.updatedAt,
        createdAt: workflowDocs.reduce((earliest: string | undefined, doc: any) => {
          if (!doc?.createdAt) return earliest;
          if (!earliest) return doc.createdAt;
          return new Date(doc.createdAt).getTime() < new Date(earliest).getTime() ? doc.createdAt : earliest;
        }, undefined),
      };
    })
    .sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
    .slice(0, limit);
}

export async function getInboundShipmentDetail(params: {
  channelAccountId: string;
  userId: string;
  shipmentId?: string;
  workflowId?: string;
}) {
  const { channelAccountId, userId, shipmentId, workflowId } = params;
  if (!shipmentId && !workflowId) throw new Error('shipmentId or workflowId is required');

  let resolvedWorkflowId = workflowId;
  if (!resolvedWorkflowId && shipmentId) {
    const existing = await InboundShipment.findOne({ channelAccountId, userId, shipmentId }).lean().exec();
    if (!existing) return null;
    resolvedWorkflowId = existing.workflowId;
  }

  const docs = await InboundShipment.find({ channelAccountId, userId, workflowId: resolvedWorkflowId }).sort({ createdAt: 1 }).lean().exec();
  if (docs.length === 0) return null;

  return {
    workflowId: resolvedWorkflowId,
    workflowStatus: deriveWorkflowStatus(docs),
    shipments: docs,
  };
}


