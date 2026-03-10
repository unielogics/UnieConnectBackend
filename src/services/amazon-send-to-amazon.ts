import { randomUUID } from 'crypto';
import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { AmazonInboundWorkflow, AmazonWorkflowStatus } from '../models/amazon-inbound-workflow';
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

type WorkflowItemInput = {
  sellerSku: string;
  asin?: string;
  title?: string;
  availableQuantity?: number;
  quantity: number;
  packingMode?: 'individual' | 'case_packed';
  cartonCount?: number;
  unitsPerCarton?: number;
  prepOwner?: 'AMAZON' | 'SELLER';
  labelOwner?: 'AMAZON' | 'SELLER';
};

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadAmazonAccount(channelAccountId: string) {
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');
  return account;
}

async function resolveShipFromData(params: {
  userId: string;
  shipFromLocationId?: string;
  shipFromAddress?: ShipFromAddress;
}) {
  if (params.shipFromAddress) {
    return {
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

function normalizeItem(input: WorkflowItemInput) {
  const quantity = Math.max(Number(input.quantity || 0), 0);
  const packingMode = input.packingMode === 'case_packed' ? 'case_packed' : 'individual';
  const cartonCount =
    packingMode === 'case_packed'
      ? Math.max(Number(input.cartonCount || 0), 0)
      : Math.max(Number(input.cartonCount || 1), 1);
  const unitsPerCarton =
    packingMode === 'case_packed'
      ? Math.max(Number(input.unitsPerCarton || 0), 0)
      : Math.max(Number(input.unitsPerCarton || quantity || 1), 1);

  const issues: string[] = [];
  if (!input.sellerSku) issues.push('Seller SKU is required.');
  if (quantity <= 0) issues.push('Enter a quantity greater than zero.');
  if (cartonCount <= 0) issues.push('Enter at least one box.');
  if (unitsPerCarton <= 0) issues.push('Enter units per box.');
  if (packingMode === 'case_packed' && cartonCount * unitsPerCarton !== quantity) {
    issues.push('Case-packed quantity must equal boxes multiplied by units per box.');
  }
  if (packingMode === 'individual' && unitsPerCarton !== quantity) {
    issues.push('For individual packing, units per box must match the quantity to send.');
  }

  return {
    sellerSku: String(input.sellerSku || ''),
    asin: input.asin,
    title: input.title,
    availableQuantity: input.availableQuantity,
    quantity,
    packingMode,
    cartonCount,
    unitsPerCarton,
    prepOwner: input.prepOwner || 'SELLER',
    labelOwner: input.labelOwner || 'SELLER',
    status: (issues.length === 0 ? 'ready' : quantity > 0 ? 'needs_input' : 'error') as 'selected' | 'needs_input' | 'ready' | 'error',
    issues,
  };
}

function buildCartons(items: ReturnType<typeof normalizeItem>[]) {
  return items.flatMap((item) => {
    if (item.quantity <= 0 || item.cartonCount <= 0 || item.unitsPerCarton <= 0) return [];
    return Array.from({ length: item.cartonCount }, (_, index) => ({
      cartonId: `${item.sellerSku}:${index + 1}`,
      cartonName: `${item.sellerSku} Box ${index + 1}`,
      quantity: 1,
      unitsPerCarton: item.unitsPerCarton,
      contentSource: 'BOX_CONTENT_PROVIDED' as const,
      items: [
        {
          sellerSku: item.sellerSku,
          quantity: item.unitsPerCarton,
        },
      ],
    }));
  });
}

function deriveWorkflowStatus(args: {
  items: Array<ReturnType<typeof normalizeItem>>;
  placementOptions?: any[];
  selectedPlacementOptionId?: string;
  shipments?: any[];
  hasLabels?: boolean;
  workflowErrors?: string[];
}): AmazonWorkflowStatus {
  if ((args.workflowErrors || []).length > 0) return 'error';
  if (args.hasLabels) return 'labels_ready';
  if ((args.shipments || []).length > 0) return 'shipment_confirmed';
  if (args.selectedPlacementOptionId) return 'placement_confirmed';
  if ((args.placementOptions || []).length > 0) return 'placement_generated';
  if (args.items.length > 0 && args.items.every((item) => item.status === 'ready')) return 'packing_ready';
  return 'draft';
}

async function waitForOperationStatus(params: {
  account: any;
  operationId?: string;
  log: FastifyBaseLogger;
  attempts?: number;
}) {
  if (!params.operationId) return null;

  const attempts = Math.max(params.attempts || 6, 1);
  let lastPayload: any = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastPayload = await spApiFetch(params.account, {
      method: 'GET',
      path: `/inbound/fba/2024-03-20/operations/${encodeURIComponent(params.operationId)}`,
    });

    const payload = lastPayload?.payload ?? lastPayload;
    const status = String(payload?.status || payload?.operationStatus || payload?.processingStatus || '').toUpperCase();

    if (['SUCCESS', 'SUCCEEDED', 'DONE', 'COMPLETED'].includes(status)) return lastPayload;
    if (['FAILED', 'ERROR', 'CANCELLED'].includes(status)) {
      const errorMessage = payload?.message || payload?.errors || 'Amazon inbound operation failed';
      throw new Error(typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage));
    }

    if (attempt < attempts) await sleep(1500);
  }

  return lastPayload;
}

function extractInboundPlanId(response: any) {
  const payload = response?.payload ?? response;
  return firstString(payload?.inboundPlanId, payload?.InboundPlanId);
}

function extractOperationId(response: any) {
  const payload = response?.payload ?? response;
  return firstString(payload?.operationId, payload?.OperationId);
}

function extractPackingOptions(response: any): any[] {
  const payload = response?.payload ?? response;
  return Array.isArray(payload?.packingOptions)
    ? payload.packingOptions
    : Array.isArray(payload?.PackingOptions)
    ? payload.PackingOptions
    : [];
}

function extractPlacementOptions(response: any): any[] {
  const payload = response?.payload ?? response;
  return Array.isArray(payload?.placementOptions)
    ? payload.placementOptions
    : Array.isArray(payload?.PlacementOptions)
    ? payload.PlacementOptions
    : [];
}

function mapPlacementOptions(rawOptions: any[]) {
  return rawOptions
    .map((option) => {
      const shipmentsRaw = Array.isArray(option?.shipments)
        ? option.shipments
        : Array.isArray(option?.ShipmentIds)
        ? option.ShipmentIds
        : Array.isArray(option?.shipmentConfigurations)
        ? option.shipmentConfigurations
        : [];

      const shipments = shipmentsRaw.map((shipment: any, index: number) => {
        const shipmentId = firstString(shipment?.shipmentId, shipment?.ShipmentId);
        const destinationFulfillmentCenterId = firstString(
          shipment?.destinationFulfillmentCenterId,
          shipment?.DestinationFulfillmentCenterId,
          shipment?.destinationId,
        );
        const items = Array.isArray(shipment?.items)
          ? shipment.items.map((item: any) => ({
              sellerSku: String(item?.msku || item?.sellerSku || item?.SellerSKU || ''),
              quantity: Number(item?.quantity || item?.Quantity || 0),
            }))
          : [];

        return {
          shipmentId,
          shipmentName: firstString(shipment?.shipmentName, shipment?.ShipmentName) || `Shipment ${index + 1}`,
          destinationFulfillmentCenterId,
          items: items.filter((item: { sellerSku: string }) => item.sellerSku),
        };
      });

      const placementOptionId = firstString(option?.placementOptionId, option?.PlacementOptionId);
      if (!placementOptionId) return null;
      return {
        placementOptionId,
        status: firstString(option?.status, option?.Status),
        preference: firstString(option?.placementServiceType, option?.PlacementServiceType, option?.preference),
        fees: option?.fees || option?.Fees,
        discounts: option?.discounts || option?.Discounts,
        shipments,
        raw: option,
      };
    })
    .filter(Boolean);
}

function mapShipmentRecords(placementOption: any, shipmentItemsById: Record<string, any[]>, shipmentBoxesById: Record<string, any[]>) {
  return (placementOption?.shipments || []).map((shipment: any) => {
    const shipmentId = String(shipment?.shipmentId || '');
    const items = Array.isArray(shipmentItemsById[shipmentId]) && shipmentItemsById[shipmentId].length > 0
      ? shipmentItemsById[shipmentId].map((item: any) => ({
          sellerSku: String(item?.msku || item?.sellerSku || item?.SellerSKU || ''),
          quantity: Number(item?.quantity || item?.Quantity || 0),
        }))
      : shipment.items || [];

    return {
      shipmentId,
      shipmentName: shipment?.shipmentName,
      destinationFulfillmentCenterId: shipment?.destinationFulfillmentCenterId,
      status: 'CONFIRMED',
      items: items.filter((item: { sellerSku: string }) => item.sellerSku),
      boxes: shipmentBoxesById[shipmentId] || [],
      raw: shipment,
    };
  });
}

function serializeWorkflow(doc: any) {
  if (!doc) return null;

  const itemCount = Array.isArray(doc.items) ? doc.items.length : 0;
  const readyItemCount = Array.isArray(doc.items) ? doc.items.filter((item: any) => item.status === 'ready').length : 0;
  const totalUnits = Array.isArray(doc.items) ? doc.items.reduce((sum: number, item: any) => sum + Number(item.quantity || 0), 0) : 0;
  const selectedPlacement = Array.isArray(doc.placementOptions)
    ? doc.placementOptions.find((option: any) => option.placementOptionId === doc.selectedPlacementOptionId) || null
    : null;

  return {
    id: String(doc._id),
    workflowId: String(doc.workflowId),
    workflowName: doc.workflowName || String(doc.workflowId),
    workflowStatus: doc.workflowStatus,
    marketplaceId: doc.marketplaceId,
    shipFromLocationId: doc.shipFromLocationId ? String(doc.shipFromLocationId) : undefined,
    shipFromAddress: doc.shipFromAddress,
    items: doc.items || [],
    cartons: doc.cartons || [],
    placementOptions: doc.placementOptions || [],
    selectedPlacementOptionId: doc.selectedPlacementOptionId,
    selectedPlacement,
    shipments: doc.shipments || [],
    warnings: doc.warnings || [],
    errors: doc.workflowErrors || [],
    amazonReferences: doc.amazonReferences || {},
    metrics: {
      itemCount,
      readyItemCount,
      totalUnits,
      shipmentCount: Array.isArray(doc.shipments) ? doc.shipments.length : 0,
      placementCount: Array.isArray(doc.placementOptions) ? doc.placementOptions.length : 0,
      cartonCount: Array.isArray(doc.cartons) ? doc.cartons.length : 0,
    },
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
  };
}

export async function saveSendToAmazonWorkflowDraft(params: {
  channelAccountId: string;
  userId: string;
  workflowId?: string;
  workflowName?: string;
  marketplaceId?: string;
  shipFromLocationId?: string;
  shipFromAddress?: ShipFromAddress;
  items: WorkflowItemInput[];
  log: FastifyBaseLogger;
}) {
  const account = await loadAmazonAccount(params.channelAccountId);
  const workflowId = params.workflowId || randomUUID();
  const resolvedShipFrom =
    params.shipFromLocationId || params.shipFromAddress
      ? await resolveShipFromData({
          userId: params.userId,
          ...(params.shipFromLocationId ? { shipFromLocationId: params.shipFromLocationId } : {}),
          ...(params.shipFromAddress ? { shipFromAddress: params.shipFromAddress } : {}),
        })
      : null;

  const normalizedItems = (Array.isArray(params.items) ? params.items : []).map(normalizeItem).filter((item) => item.sellerSku);
  const cartons = buildCartons(normalizedItems);
  const workflowStatus = deriveWorkflowStatus({ items: normalizedItems });

  const doc = await AmazonInboundWorkflow.findOneAndUpdate(
    { channelAccountId: params.channelAccountId, workflowId },
    {
      userId: params.userId,
      channelAccountId: params.channelAccountId,
      workflowId,
      workflowName: params.workflowName || `Send to Amazon ${workflowId.slice(0, 8)}`,
      marketplaceId: params.marketplaceId || (account.marketplaceIds || [])[0],
      shipFromLocationId: resolvedShipFrom?.shipFromLocationId,
      shipFromAddress: resolvedShipFrom?.shipFromAddress,
      items: normalizedItems,
      cartons,
      warnings: [],
      workflowErrors: normalizedItems.flatMap((item) => item.issues).slice(0, 25),
      workflowStatus,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .lean()
    .exec();

  params.log.info({ workflowId, channelAccountId: params.channelAccountId }, 'send-to-amazon workflow draft saved');
  return serializeWorkflow(doc);
}

export async function listSendToAmazonWorkflows(params: {
  channelAccountId: string;
  userId: string;
  limit?: number;
}) {
  const docs = await AmazonInboundWorkflow.find({ channelAccountId: params.channelAccountId, userId: params.userId })
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(Math.min(Math.max(params.limit || 25, 1), 100))
    .lean()
    .exec();

  return docs.map((doc) => serializeWorkflow(doc));
}

export async function getSendToAmazonWorkflow(params: {
  channelAccountId: string;
  userId: string;
  workflowId: string;
}) {
  const doc = await AmazonInboundWorkflow.findOne({
    channelAccountId: params.channelAccountId,
    userId: params.userId,
    workflowId: params.workflowId,
  })
    .lean()
    .exec();

  if (!doc) return null;
  return serializeWorkflow(doc);
}

export async function generateSendToAmazonPlacementPreview(params: {
  channelAccountId: string;
  userId: string;
  workflowId: string;
  log: FastifyBaseLogger;
}) {
  const account = await loadAmazonAccount(params.channelAccountId);
  const existing = await AmazonInboundWorkflow.findOne({
    channelAccountId: params.channelAccountId,
    userId: params.userId,
    workflowId: params.workflowId,
  })
    .lean()
    .exec();

  if (!existing) throw new Error('Workflow not found');
  if (!existing.shipFromAddress) throw new Error('Ship-from address is required before generating placements');

  const items = Array.isArray(existing.items) ? existing.items.filter((item: any) => item.status === 'ready' && Number(item.quantity || 0) > 0) : [];
  if (items.length === 0) {
    throw new Error('Add at least one ready SKU before generating Amazon placements');
  }

  const createPlanResponse = await spApiFetch(account, {
    method: 'POST',
    path: '/inbound/fba/2024-03-20/inboundPlans',
    body: {
      name: existing.workflowName || `Send to Amazon ${existing.workflowId}`,
      destinationMarketplaces: [existing.marketplaceId || (account.marketplaceIds || [])[0]].filter(Boolean),
      sourceAddress: existing.shipFromAddress,
      items: items.map((item: any) => ({
        msku: item.sellerSku,
        quantity: Number(item.quantity || 0),
        prepOwner: item.prepOwner || 'SELLER',
        labelOwner: item.labelOwner || 'SELLER',
      })),
    },
  });

  const createPlanOpId = extractOperationId(createPlanResponse);
  if (createPlanOpId) {
    await waitForOperationStatus({ account, operationId: createPlanOpId, log: params.log });
  }

  const inboundPlanId = extractInboundPlanId(createPlanResponse);
  if (!inboundPlanId) {
    throw new Error('Amazon did not return an inbound plan ID');
  }

  const generatePackingResponse = await spApiFetch(account, {
    method: 'POST',
    path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions`,
  });
  const genPackingOpId = extractOperationId(generatePackingResponse);
  if (genPackingOpId) {
    await waitForOperationStatus({ account, operationId: genPackingOpId, log: params.log });
  }

  const packingOptionsResponse = await spApiFetch(account, {
    method: 'GET',
    path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions`,
  });

  const packingOptions = extractPackingOptions(packingOptionsResponse);
  const selectedPackingOption = packingOptions[0];
  const packingOptionId = firstString(selectedPackingOption?.packingOptionId, selectedPackingOption?.PackingOptionId);

  if (packingOptionId) {
    const confirmPackingResponse = await spApiFetch(account, {
      method: 'POST',
      path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingOptions/${encodeURIComponent(packingOptionId)}/confirmation`,
    });
    const confirmPackingOpId = extractOperationId(confirmPackingResponse);
    if (confirmPackingOpId) {
      await waitForOperationStatus({ account, operationId: confirmPackingOpId, log: params.log });
    }
  }

  await spApiFetch(account, {
    method: 'POST',
    path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/packingInformation`,
    body: {
      packageGroupings: (existing.cartons || []).map((carton: any) => ({
        packingGroupId: carton.packingGroupId,
        boxes: [
          {
            boxId: carton.cartonId,
            contentInformationSource: 'BOX_CONTENT_PROVIDED',
            quantity: carton.quantity,
            dimensions: undefined,
            items: carton.items.map((item: any) => ({
              msku: item.sellerSku,
              quantity: item.quantity,
            })),
          },
        ],
      })),
    },
  });

  const generatePlacementResponse = await spApiFetch(account, {
    method: 'POST',
    path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions`,
  });
  const genPlacementOpId = extractOperationId(generatePlacementResponse);
  if (genPlacementOpId) {
    await waitForOperationStatus({ account, operationId: genPlacementOpId, log: params.log });
  }

  const placementOptionsResponse = await spApiFetch(account, {
    method: 'GET',
    path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions`,
  });

  const mappedPlacementOptions = mapPlacementOptions(extractPlacementOptions(placementOptionsResponse));
  const nextStatus = deriveWorkflowStatus({
    items: existing.items.map(normalizeItem as any),
    placementOptions: mappedPlacementOptions,
  });

  const updated = await AmazonInboundWorkflow.findOneAndUpdate(
    { channelAccountId: params.channelAccountId, userId: params.userId, workflowId: params.workflowId },
    {
      workflowStatus: nextStatus,
      placementOptions: mappedPlacementOptions,
      warnings: mappedPlacementOptions.length === 0 ? ['Amazon returned no placement options for the current carton data.'] : [],
      workflowErrors: [],
      amazonReferences: {
        inboundPlanId,
        packingOptionId,
        createPlanOperationId: extractOperationId(createPlanResponse),
        generatePackingOperationId: extractOperationId(generatePackingResponse),
        generatePlacementOperationId: extractOperationId(generatePlacementResponse),
      },
      raw: {
        createInboundPlan: createPlanResponse,
        packingOptions: packingOptionsResponse,
        placementOptions: placementOptionsResponse,
      },
    },
    { new: true },
  )
    .lean()
    .exec();

  params.log.info({ workflowId: params.workflowId, inboundPlanId, placementCount: mappedPlacementOptions.length }, 'send-to-amazon placements generated');
  return serializeWorkflow(updated);
}

export async function confirmSendToAmazonPlacement(params: {
  channelAccountId: string;
  userId: string;
  workflowId: string;
  placementOptionId?: string;
  log: FastifyBaseLogger;
}) {
  const account = await loadAmazonAccount(params.channelAccountId);
  const existing = await AmazonInboundWorkflow.findOne({
    channelAccountId: params.channelAccountId,
    userId: params.userId,
    workflowId: params.workflowId,
  })
    .lean()
    .exec();

  if (!existing) throw new Error('Workflow not found');

  const inboundPlanId = existing.amazonReferences?.inboundPlanId;
  if (!inboundPlanId) throw new Error('Generate placement options before confirming shipping');

  const placementOptionId =
    params.placementOptionId ||
    existing.selectedPlacementOptionId ||
    firstString(existing.placementOptions?.[0]?.placementOptionId);

  if (!placementOptionId) throw new Error('Choose a placement option before confirming shipping');

  const confirmPlacementResponse = await spApiFetch(account, {
    method: 'POST',
    path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/placementOptions/${encodeURIComponent(placementOptionId)}/confirmation`,
  });
  const confirmPlacementOpId = extractOperationId(confirmPlacementResponse);
  if (confirmPlacementOpId) {
    await waitForOperationStatus({ account, operationId: confirmPlacementOpId, log: params.log });
  }

  const selectedPlacement = (existing.placementOptions || []).find((option: any) => option.placementOptionId === placementOptionId);
  const shipmentItemsById: Record<string, any[]> = {};
  const shipmentBoxesById: Record<string, any[]> = {};

  for (const shipment of selectedPlacement?.shipments || []) {
    const shipmentId = String(shipment?.shipmentId || '');
    if (!shipmentId) continue;
    try {
      const itemsResponse = await spApiFetch(account, {
        method: 'GET',
        path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/items`,
      });
      const itemsPayload = itemsResponse?.payload ?? itemsResponse;
      shipmentItemsById[shipmentId] = Array.isArray(itemsPayload?.items)
        ? itemsPayload.items
        : Array.isArray(itemsPayload?.shipmentItems)
        ? itemsPayload.shipmentItems
        : [];
    } catch (error) {
      params.log.warn({ workflowId: params.workflowId, shipmentId, error }, 'failed to fetch shipment items');
    }

    try {
      const boxesResponse = await spApiFetch(account, {
        method: 'GET',
        path: `/inbound/fba/2024-03-20/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/boxes`,
      });
      const boxesPayload = boxesResponse?.payload ?? boxesResponse;
      shipmentBoxesById[shipmentId] = Array.isArray(boxesPayload?.boxes)
        ? boxesPayload.boxes
        : Array.isArray(boxesPayload?.shipmentBoxes)
        ? boxesPayload.shipmentBoxes
        : [];
    } catch (error) {
      params.log.warn({ workflowId: params.workflowId, shipmentId, error }, 'failed to fetch shipment boxes');
    }
  }

  const shipments = mapShipmentRecords(selectedPlacement, shipmentItemsById, shipmentBoxesById);
  const workflowStatus = deriveWorkflowStatus({
    items: (existing.items || []).map(normalizeItem as any),
    placementOptions: existing.placementOptions || [],
    selectedPlacementOptionId: placementOptionId,
    shipments,
  });

  const updated = await AmazonInboundWorkflow.findOneAndUpdate(
    { channelAccountId: params.channelAccountId, userId: params.userId, workflowId: params.workflowId },
    {
      workflowStatus,
      selectedPlacementOptionId: placementOptionId,
      shipments,
      amazonReferences: {
        ...(existing.amazonReferences || {}),
        confirmPlacementOperationId: extractOperationId(confirmPlacementResponse),
      },
      warnings: shipments.length === 0 ? ['Placement confirmed, but Amazon has not returned shipment records yet.'] : [],
      workflowErrors: [],
    },
    { new: true },
  )
    .lean()
    .exec();

  params.log.info({ workflowId: params.workflowId, placementOptionId, shipmentCount: shipments.length }, 'send-to-amazon placement confirmed');
  return serializeWorkflow(updated);
}

export async function fetchSendToAmazonShipmentLabels(params: {
  channelAccountId: string;
  userId: string;
  workflowId: string;
  shipmentId: string;
  log: FastifyBaseLogger;
}) {
  const account = await loadAmazonAccount(params.channelAccountId);
  const existing = await AmazonInboundWorkflow.findOne({
    channelAccountId: params.channelAccountId,
    userId: params.userId,
    workflowId: params.workflowId,
  })
    .lean()
    .exec();

  if (!existing) throw new Error('Workflow not found');
  const shipmentId = String(params.shipmentId || '');
  if (!shipmentId) throw new Error('shipmentId is required');

  const labelsResponse = await spApiFetch(account, {
    method: 'GET',
    path: `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/labels`,
    query: {
      PageType: 'PackageLabel_Letter',
    },
  });

  const labelUrl =
    labelsResponse?.payload?.TransportDocument?.PdfDocument ||
    labelsResponse?.payload?.DownloadURL ||
    labelsResponse?.DownloadURL;

  const shipments = (existing.shipments || []).map((shipment: any) =>
    String(shipment.shipmentId) === shipmentId
      ? {
          ...shipment,
          labels: {
            boxLabelUrl: labelUrl,
            fetchedAt: new Date(),
            raw: labelsResponse,
          },
        }
      : shipment,
  );

  const statusArgs: Parameters<typeof deriveWorkflowStatus>[0] = {
    items: (existing.items || []).map(normalizeItem as any),
    placementOptions: existing.placementOptions || [],
    shipments,
    hasLabels: shipments.some((shipment: any) => shipment?.labels?.boxLabelUrl),
  };
  if (existing.selectedPlacementOptionId) {
    statusArgs.selectedPlacementOptionId = existing.selectedPlacementOptionId;
  }
  const updated = await AmazonInboundWorkflow.findOneAndUpdate(
    { channelAccountId: params.channelAccountId, userId: params.userId, workflowId: params.workflowId },
    {
      workflowStatus: deriveWorkflowStatus(statusArgs),
      shipments,
      workflowErrors: [],
    },
    { new: true },
  )
    .lean()
    .exec();

  params.log.info({ workflowId: params.workflowId, shipmentId }, 'send-to-amazon box labels fetched');
  return {
    workflow: serializeWorkflow(updated),
    shipmentId,
    labelUrl,
    raw: labelsResponse,
  };
}
