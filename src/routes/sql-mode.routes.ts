import { createHash, randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import { config } from '../config/env';
import { pgQuery, withPgTransaction } from '../db/postgres';
import { CAN_MANAGE_USERS, isValidRole, normalizeRole } from '../lib/roles';
import { publicEntityId } from '../lib/public-id';
import { registerWmsCredential } from '../services/oms-wms-credentials.service';
import { ensureCortexCredentialForUser } from '../services/cortex-credentials.service';
import { buildEbayAuthUrl, exchangeEbayCodeForToken, refreshEbayAccessToken } from '../services/ebay';
import { exchangeCodeForTokens as exchangeAmazonCodeForTokens } from '../services/amazon-auth';
import { getSyncStatus, setSyncStatus } from '../services/channel-sync-status';
import { markMarketplaceRefresh, pullEbaySql, pullShopifySql } from '../services/marketplace-sql-sync';

type AnyRow = Record<string, any>;

const number = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const money = (value: unknown) => Math.round(number(value) * 100) / 100;
const json = (value: unknown, fallback: any) => (value == null ? fallback : value);
const iso = (value: unknown) => (value ? new Date(value as any).toISOString() : undefined);
const trim = (value: unknown) => (value == null ? '' : String(value).trim());
const normalizedEmail = (value: unknown) => trim(value).toLowerCase();
const CORE_FEATURE_IDS = [
  'core-command-center',
  'core-inventory',
  'core-orders',
  'core-connections',
  'core-marketplace',
  'core-support',
  'app-studio',
];

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

function requireManager(req: any, reply: any): string | null {
  const userId = requireUser(req, reply);
  if (!userId) return null;
  const role = normalizeRole(req.user?.role);
  if (!CAN_MANAGE_USERS.includes(role)) {
    reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    return null;
  }
  return userId;
}

async function one<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T | null> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows[0] || null;
}

async function rows<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

function pagination(query: any) {
  return {
    limit: Math.min(500, Math.max(1, Number(query?.limit || 200))),
    offset: Math.max(0, Number(query?.offset || 0)),
  };
}

function addressText(address: any): string | null {
  if (!address || typeof address !== 'object') return null;
  return [
    address.addressLine1 || address.line1 || address.street,
    address.city,
    address.state || address.stateOrProvinceCode,
    address.zipCode || address.postalCode,
    address.country,
  ]
    .filter(Boolean)
    .join(', ') || null;
}

function supplierMetadataFromBody(body: any) {
  const metadata = { ...((body?.metadata && typeof body.metadata === 'object') ? body.metadata : {}) };
  const pickupProfile = { ...((metadata as any).pickupProfile || {}) };
  const pickupKeys = [
    'loadingDock',
    'maxVehicleSize',
    'hoursOfOperation',
    'equipmentRequired',
    'appointmentRequired',
    'dockAppointmentLeadTimeHours',
    'liftgateRequired',
    'insidePickup',
    'palletExchange',
    'pickupInstructions',
    'contactName',
  ];
  pickupKeys.forEach((key) => {
    if (body?.[key] !== undefined) (pickupProfile as any)[key] = body[key];
  });
  ['website', 'notes', 'onlineSupplier', 'paymentTerms', 'relationship'].forEach((key) => {
    if (body?.[key] !== undefined) (metadata as any)[key] = body[key];
  });
  if (Object.keys(pickupProfile).length) {
    (metadata as any).pickupProfile = pickupProfile;
    if ((pickupProfile as any).hoursOfOperation !== undefined) {
      (metadata as any).hoursOfOperation = (pickupProfile as any).hoursOfOperation;
    }
  }
  return metadata;
}

function supplierPickupProfile(row: AnyRow) {
  const metadata = json(row.metadata, {});
  const pickup = metadata.pickupProfile || metadata.pickup || {};
  return {
    loadingDock: pickup.loadingDock ?? metadata.loadingDock ?? null,
    maxVehicleSize: pickup.maxVehicleSize || metadata.maxVehicleSize || null,
    hoursOfOperation: pickup.hoursOfOperation || metadata.hoursOfOperation || '',
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
  };
}

function channelDisplay(row: AnyRow) {
  return row.display_name || row.shop_domain || row.selling_partner_id || row.external_account_id || row.channel;
}

function mapChannel(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    status: row.status,
    displayName: row.display_name,
    shopDomain: row.shop_domain,
    sellingPartnerId: row.selling_partner_id,
    marketplaceId: row.marketplace_id,
    externalAccountId: row.external_account_id,
    scopes: row.scopes || [],
    metadata: json(row.metadata, {}),
    lastSyncAt: iso(row.last_sync_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    label: channelDisplay(row),
  };
}

function wantsJson(req: any) {
  return trim(req.query?.format).toLowerCase() === 'json' || String(req.headers?.accept || '').includes('application/json');
}

function redirectOrJson(req: any, reply: any, url: string, extra: Record<string, unknown> = {}) {
  if (wantsJson(req)) return reply.send({ url, ...extra });
  return reply.redirect(url);
}

function amazonSellerCentralBase(region?: string) {
  const r = trim(region || config.amazon.region).toLowerCase();
  if (r === 'eu') return 'https://sellercentral-europe.amazon.com';
  if (r === 'fe') return 'https://sellercentral.amazon.co.jp';
  return 'https://sellercentral.amazon.com';
}

function buildAmazonAuthUrl(state: string) {
  const params = new URLSearchParams({
    application_id: config.amazon.appId,
    state,
    redirect_uri: config.amazon.redirectUri,
  });
  return `${amazonSellerCentralBase()}/apps/authorize/consent?${params.toString()}`;
}

function mapItem(row: AnyRow, extra: Record<string, unknown> = {}) {
  return {
    _id: row.id,
    id: row.id,
    publicId: publicEntityId('SK', row.id),
    displayId: publicEntityId('SK', row.id),
    userId: row.user_id,
    sku: row.sku,
    title: row.title,
    description: row.description,
    attributes: json(row.attributes, {}),
    defaultUom: row.default_uom,
    tags: row.tags || [],
    supplierId: row.supplier_id,
    image: row.image,
    images: json(row.images, []),
    upc: row.upc,
    ean: row.ean,
    asin: row.asin,
    category: row.category,
    subCategory: row.sub_category,
    lob: row.lob,
    weight: row.weight == null ? undefined : number(row.weight),
    dimensions: json(row.dimensions, {}),
    archived: row.archived,
    wmsInventory: json(row.wms_inventory, {}),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...extra,
  };
}

function mapAmazonProfile(row: AnyRow) {
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
    channelConnectionId: row.channel_connection_id,
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
    raw: json(row.raw, {}),
    fbaEligible,
    identityState,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function amazonBlockersForItem(item: AnyRow, profile: AnyRow = {}) {
  const dims = json(item.dimensions, {});
  const blockers: string[] = [];
  if (!trim(profile.sellerSku || profile.seller_sku || item.sku)) blockers.push('Missing Amazon seller SKU');
  if (!trim(profile.asin || item.asin)) blockers.push('Missing ASIN or Amazon listing mapping');
  if (!trim(item.title)) blockers.push('Missing product title');
  if (!trim(item.upc || item.ean || profile.asin || item.asin)) blockers.push('Missing product identifier');
  if (!number(item.weight)) blockers.push('Missing item weight');
  if (!number(dims.length) || !number(dims.width) || !number(dims.height)) blockers.push('Missing item dimensions');
  if ((profile.fulfillmentChannel || profile.fulfillment_channel || '').toUpperCase() === 'AMAZON' && !trim(profile.asin || item.asin)) {
    blockers.push('FBA requires an Amazon listing before shipment planning');
  }
  return blockers;
}

function listingDraftPayload(item: AnyRow, body: AnyRow = {}) {
  const dims = json(item.dimensions, {});
  const metadata = json(item.metadata, {});
  const images = json(item.images, []);
  return {
    marketplaceId: body.marketplaceId || 'ATVPDKIKX0DER',
    sellerSku: trim(body.sellerSku || item.sku),
    asin: trim(body.asin || item.asin) || null,
    productType: body.productType || metadata.productType || item.category || 'PRODUCT',
    title: body.title || item.title,
    brand: body.brand || metadata.brand || metadata.manufacturer || '',
    description: body.description || item.description || '',
    price: body.price ?? metadata.price ?? null,
    condition: body.condition || 'new_new',
    fulfillmentChannel: body.fulfillmentChannel || 'AMAZON',
    identifiers: {
      upc: body.upc || item.upc || null,
      ean: body.ean || item.ean || null,
      asin: body.asin || item.asin || null,
    },
    dimensions: {
      length: number(body.length ?? dims.length),
      width: number(body.width ?? dims.width),
      height: number(body.height ?? dims.height),
    },
    weight: number(body.weight ?? item.weight),
    images: Array.isArray(body.images) ? body.images : (Array.isArray(images) ? images : []).filter(Boolean),
  };
}

function validateListingPayload(payload: AnyRow) {
  const required = [
    { key: 'sellerSku', label: 'Seller SKU' },
    { key: 'productType', label: 'Amazon product type' },
    { key: 'title', label: 'Title' },
    { key: 'brand', label: 'Brand' },
    { key: 'price', label: 'Price' },
    { key: 'condition', label: 'Condition' },
    { key: 'weight', label: 'Weight' },
    { key: 'dimensions.length', label: 'Length' },
    { key: 'dimensions.width', label: 'Width' },
    { key: 'dimensions.height', label: 'Height' },
  ];
  const errors = required
    .filter(({ key }) => {
      const value = key.split('.').reduce((acc: any, part) => acc?.[part], payload);
      return value === undefined || value === null || value === '' || (typeof value === 'number' && value <= 0);
    })
    .map(({ label }) => `${label} is required before publishing to Amazon`);
  if (!payload.identifiers?.upc && !payload.identifiers?.ean && !payload.identifiers?.asin) {
    errors.push('UPC, EAN, or ASIN is required before publishing to Amazon');
  }
  const warnings: string[] = [];
  if (!Array.isArray(payload.images) || payload.images.length === 0) {
    warnings.push('Add at least one product image before publishing for stronger Amazon listing quality');
  }
  return { required, errors, warnings };
}

function mapSupplier(row: AnyRow) {
  const metadata = json(row.metadata, {});
  const pickupProfile = supplierPickupProfile(row);
  return {
    _id: row.id,
    id: row.id,
    publicId: publicEntityId('SU', row.id),
    displayId: publicEntityId('SU', row.id),
    userId: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    address: json(row.address, {}),
    website: metadata.website || null,
    notes: metadata.notes || null,
    onlineSupplier: Boolean(metadata.onlineSupplier ?? false),
    hoursOfOperation: pickupProfile.hoursOfOperation,
    loadingDock: pickupProfile.loadingDock,
    maxVehicleSize: pickupProfile.maxVehicleSize,
    equipmentRequired: pickupProfile.equipmentRequired,
    appointmentRequired: pickupProfile.appointmentRequired,
    dockAppointmentLeadTimeHours: pickupProfile.dockAppointmentLeadTimeHours,
    liftgateRequired: pickupProfile.liftgateRequired,
    insidePickup: pickupProfile.insidePickup,
    palletExchange: pickupProfile.palletExchange,
    pickupInstructions: pickupProfile.pickupInstructions,
    contactName: pickupProfile.contactName,
    pickupProfile,
    metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapCustomer(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    publicId: publicEntityId('CU', row.id),
    displayId: publicEntityId('CU', row.id),
    userId: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    company: row.company,
    channel: row.channel,
    externalCustomerId: row.external_customer_id,
    addresses: json(row.addresses, []),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapOrder(row: AnyRow, lines: AnyRow[] = []) {
  return {
    _id: row.id,
    id: row.id,
    publicId: publicEntityId('OR', row.id),
    displayId: publicEntityId('OR', row.id),
    userId: row.user_id,
    customerId: row.customer_id,
    customerDisplayId: row.customer_id ? publicEntityId('CU', row.customer_id) : undefined,
    channelAccountId: row.channel_connection_id,
    channel: row.channel,
    externalOrderId: row.external_order_id,
    orderNumber: row.order_number,
    status: row.status,
    paid: row.paid,
    placedAt: iso(row.placed_at),
    totals: json(row.totals, {}),
    shippingAddress: json(row.shipping_address, {}),
    billingAddress: json(row.billing_address, {}),
    trackingNumber: row.tracking_number,
    metadata: json(row.metadata, {}),
    lines: lines.map((line) => ({
      _id: line.id,
      id: line.id,
      publicId: publicEntityId('SK', line.id),
      itemId: line.item_id,
      sku: line.sku,
      title: line.title,
      quantity: number(line.quantity),
      unitPrice: money(line.unit_price),
      totalPrice: money(line.total_price),
      metadata: json(line.metadata, {}),
    })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapFacility(row: AnyRow) {
  const address = json(row.address, {});
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    code: row.code,
    name: row.name,
    facilityType: row.facility_type,
    type: row.facility_type,
    status: row.status,
    address,
    latitude: row.latitude == null ? undefined : number(row.latitude),
    longitude: row.longitude == null ? undefined : number(row.longitude),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapShipFrom(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    userId: row.user_id,
    supplierId: row.supplier_id,
    name: row.name,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    address: json(row.address, {}),
    isDefault: row.is_default,
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapShipmentPlan(row: AnyRow) {
  return {
    _id: row.id,
    id: row.id,
    publicId: publicEntityId('SH', row.id),
    displayId: publicEntityId('SH', row.id),
    userId: row.user_id,
    supplierId: row.supplier_id,
    supplierDisplayId: row.supplier_id ? publicEntityId('SU', row.supplier_id) : undefined,
    shipFromLocationId: row.ship_from_location_id,
    facilityId: row.facility_id,
    internalShipmentId: row.internal_shipment_id,
    shipmentTitle: row.shipment_title,
    status: row.status,
    prepServicesOnly: row.prep_services_only,
    marketplaceId: row.marketplace_id,
    marketplaceType: row.marketplace_type,
    orderNo: row.order_no,
    receiptNo: row.receipt_no,
    orderDate: iso(row.order_date),
    estimatedArrivalDate: iso(row.estimated_arrival_date),
    shipFromAddress: json(row.ship_from_address, {}),
    items: json(row.items, []),
    metadata: json(row.metadata, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapFeature(row: AnyRow) {
  const payload = json(row.payload, {}) || {};
  const pricing = payload.pricing || {
    type: money(row.price) > 0 ? 'subscription' : 'free',
    amount: money(row.price),
    currency: 'USD',
  };
  const metadata = payload.metadata || {};
  const isStandard = Boolean(payload.isStandard || payload.isCore);
  const userStatus = row.user_status || (isStandard ? 'enabled' : 'available');
  const isEnabled = Boolean(isStandard || row.is_enabled || userStatus === 'enabled');
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    slug: payload.slug || row.id,
    description: row.description,
    longDescription: payload.longDescription || row.description,
    category: row.category,
    status: row.status,
    price: money(row.price),
    pricing,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    icon: payload.icon || metadata.navIcon,
    screenshots: Array.isArray(payload.screenshots) ? payload.screenshots : [],
    isActive: row.status === 'active',
    isStandard,
    isEnabled,
    userStatus,
    enabledAt: iso(row.enabled_at),
    metadata,
    unlockedScreens: payload.unlockedScreens || metadata.unlockedScreens || [],
    requiredConnections: payload.requiredConnections || metadata.requiredConnections || [],
    setupSteps: payload.setupSteps || metadata.setupSteps || [],
    payload,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapUser(row: AnyRow) {
  return {
    id: row.id,
    userId: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    llcName: row.llc_name,
    billingAddress: json(row.billing_address, null),
    enabledFeatures: row.enabled_features || [],
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function writeLedger(userId: string, params: { entityType: string; entityId?: string | null; eventType: string; sourceSystem?: string; summary: string; payload?: any; confidence?: number }) {
  await pgQuery(
    `INSERT INTO oms_execution_ledger
      (user_id, entity_type, entity_id, event_type, source_system, summary, payload, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      userId,
      params.entityType,
      params.entityId || null,
      params.eventType,
      params.sourceSystem || 'oms',
      params.summary,
      JSON.stringify(params.payload || {}),
      params.confidence ?? null,
    ],
  ).catch(() => null);
}

async function closestFacility(userId: string) {
  return one('SELECT * FROM facilities WHERE (user_id = $1 OR user_id IS NULL) AND status = $2 ORDER BY user_id NULLS LAST, created_at ASC LIMIT 1', [userId, 'active']);
}

async function seedDefaultFacility(userId: string) {
  const existing = await closestFacility(userId);
  if (existing) return existing;
  return one(
    `INSERT INTO facilities (user_id, code, name, facility_type, address, latitude, longitude, metadata)
     VALUES ($1, 'NJ-01', 'New Jersey Market Hub', 'warehouse', $2::jsonb, 40.7357, -74.1724, '{"source":"sql_default"}'::jsonb)
     ON CONFLICT (user_id, code) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [userId, JSON.stringify({ city: 'Newark', state: 'NJ', stateOrProvinceCode: 'NJ', country: 'US' })],
  );
}

function wmsBillingAddress(address: AnyRow | null | undefined) {
  const a = json(address, {}) || {};
  return {
    addressLine1: trim(a.addressLine1 || a.line1 || a.address1 || a.street || a.address),
    addressLine2: trim(a.addressLine2 || a.line2 || a.address2),
    city: trim(a.city),
    state: trim(a.state || a.stateOrProvinceCode || a.province),
    zipCode: trim(a.zipCode || a.postalCode || a.zip || a.postcode),
    country: trim(a.country || a.countryCode || 'US') || 'US',
  };
}

async function buildWmsOmsProfile(userId: string) {
  const user = await one(
    `SELECT id, email, first_name, last_name, phone, llc_name, billing_address
     FROM app_users
     WHERE id = $1`,
    [userId],
  );
  if (!user) return { profile: null, missing: ['user'] };

  const billingAddress = wmsBillingAddress(user.billing_address);
  const firstName = trim(user.first_name);
  const lastName = trim(user.last_name);
  const phone = trim(user.phone);
  const email = normalizedEmail(user.email);
  const llcName = trim(user.llc_name);

  const missing: string[] = [];
  if (!firstName) missing.push('firstName');
  if (!lastName) missing.push('lastName');
  if (!email) missing.push('email');
  if (!phone) missing.push('phone');
  if (!llcName) missing.push('llcName');
  for (const [key, value] of Object.entries({
    billingAddressLine1: billingAddress.addressLine1,
    billingCity: billingAddress.city,
    billingState: billingAddress.state,
    billingZipCode: billingAddress.zipCode,
    billingCountry: billingAddress.country,
  })) {
    if (!value) missing.push(key);
  }

  return {
    profile: {
      omsIntermediaryId: userId,
      omsCompanyName: llcName || [firstName, lastName].filter(Boolean).join(' ') || email || `OMS ${userId}`,
      omsFirstName: firstName,
      omsLastName: lastName,
      omsPhone: phone,
      omsEmail: email,
      omsLlcName: llcName,
      omsBillingAddress: billingAddress,
    },
    missing,
  };
}

async function callWmsInternal<T = AnyRow>(path: string, body: AnyRow): Promise<T> {
  if (!config.wmsApiUrl) {
    const err = new Error('WMS_API_URL is not configured');
    (err as any).status = 503;
    throw err;
  }
  if (!config.internalApiKey) {
    const err = new Error('UNIECONNECT_INTERNAL_API_KEY is not configured');
    (err as any).status = 503;
    throw err;
  }
  const res = await fetch(`${config.wmsApiUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Api-Key': config.internalApiKey,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as AnyRow;
  if (!res.ok) {
    const err = new Error(String(data.message || data.error || `WMS request failed with ${res.status}`));
    (err as any).status = res.status;
    (err as any).payload = data;
    throw err;
  }
  return data as T;
}

const DEFAULT_WMS_BRIDGE_SCOPES = [
  'inventory:read',
  'inventory:update',
  'orders:create',
  'orders:update',
  'asns:read',
  'asns:create',
  'asns:update',
  'billing:read',
  'events:write',
  'disputes:write',
  'account:deactivate',
];

export async function sqlModeRoutes(app: FastifyInstance) {
  app.get('/legacy/status', async () => ({
    database: "aurora_postgres",
    message: 'Legacy feature groups are served by Aurora SQL routes.',
  }));

  app.get('/channel-accounts', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM marketplace_connections WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return data.map(mapChannel);
  });

  app.delete('/channel-accounts/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM marketplace_connections WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(userId, { entityType: 'marketplace_connection', entityId: deleted.id, eventType: 'deleted', summary: `Removed ${deleted.channel} marketplace connection.` });
    return { success: true };
  });

  app.get('/channel-accounts/:id/debug', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const account = await one('SELECT * FROM marketplace_connections WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    return {
      account: mapChannel(account),
      storage: 'aurora_postgres',
      tokenPresent: Boolean(account.access_token_enc || account.refresh_token_enc),
      lastSyncAt: iso(account.last_sync_at),
    };
  });

  app.get('/channel-accounts/:id/sync-status', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const account = await one('SELECT * FROM marketplace_connections WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    const sync = await getSyncStatus(account.id);
    return {
      accountId: account.id,
      channel: account.channel,
      status: account.status,
      syncStatus: sync.fullSync ? 'complete' : 'pending',
      lastSyncAt: iso(account.last_sync_at),
      ...sync,
      source: 'aurora_postgres',
    };
  });

  app.post('/channel-accounts/:id/refresh', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const account = await one('SELECT * FROM marketplace_connections WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    if (account.status !== 'connected') {
      return reply.code(409).send({ error: 'Marketplace connection is not connected', status: account.status });
    }
    let syncResult: any = null;
    try {
      if (account.channel === 'shopify') {
        if (!account.shop_domain || !account.access_token_enc) {
          return reply.code(400).send({ error: 'Shopify connection is missing shop domain or access token' });
        }
        syncResult = await pullShopifySql({
          userId,
          channelAccountId: account.id,
          shopDomain: account.shop_domain,
          accessToken: account.access_token_enc,
          initialSync: !account.last_sync_at,
          log: req.log,
        });
      } else if (account.channel === 'ebay') {
        let accessToken = account.access_token_enc;
        if ((!accessToken || (account.token_expires_at && new Date(account.token_expires_at).getTime() < Date.now() + 60_000)) && account.refresh_token_enc) {
          const token = await refreshEbayAccessToken(account.refresh_token_enc);
          accessToken = token.accessToken;
          await pgQuery(
            `UPDATE marketplace_connections
             SET access_token_enc = $3, refresh_token_enc = COALESCE($4, refresh_token_enc), token_expires_at = $5, updated_at = now()
             WHERE id = $1 AND user_id = $2`,
            [account.id, userId, accessToken, token.refreshToken || null, token.expiresAt || null],
          );
        }
        if (!accessToken) return reply.code(400).send({ error: 'eBay connection is missing access token' });
        syncResult = await pullEbaySql({
          userId,
          channelAccountId: account.id,
          accessToken,
          marketplaceId: account.marketplace_id || config.ebay.marketplaceId,
          log: req.log,
        });
      } else if (account.channel === 'amazon') {
        await setSyncStatus(account.id, 'products', 'error', { error: 'Amazon SP-API pull is still pending provider integration' });
        return reply.code(202).send({
          success: false,
          account: mapChannel(account),
          syncStatus: 'pending_provider_integration',
          message: 'Amazon OAuth can be staged, but live SP-API catalog/order/inventory pulls are not wired yet.',
        });
      } else {
        return reply.code(400).send({ error: `Unsupported marketplace channel: ${account.channel}` });
      }
      const updated = await markMarketplaceRefresh(account.id, userId, syncResult);
      await writeLedger(userId, {
        entityType: 'marketplace_connection',
        entityId: account.id,
        eventType: 'refresh_completed',
        summary: `Refresh completed for ${account.channel} marketplace connection.`,
        payload: { accountId: account.id, syncResult },
      });
      const sync = await getSyncStatus(account.id);
      return { success: true, account: mapChannel(updated || account), syncStatus: sync.fullSync ? 'complete' : 'partial', syncResult, ...sync };
    } catch (err: any) {
      req.log.error({ err, accountId: account.id, channel: account.channel }, 'marketplace refresh failed');
      await writeLedger(userId, {
        entityType: 'marketplace_connection',
        entityId: account.id,
        eventType: 'refresh_failed',
        summary: `Refresh failed for ${account.channel} marketplace connection.`,
        payload: { accountId: account.id, error: err?.message || 'Refresh failed' },
      });
      return reply.code(502).send({ error: 'Marketplace refresh failed', detail: err?.message || 'Refresh failed' });
    }
  });

  app.get('/auth/shopify/start', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const shop = trim(req.query?.shop).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!shop) return reply.code(400).send({ error: 'shop is required' });
    const state = randomBytes(18).toString('hex');
    await pgQuery(
      'INSERT INTO oauth_states (user_id, channel, state, payload) VALUES ($1, $2, $3, $4::jsonb)',
      [userId, 'shopify', state, JSON.stringify({ shop })],
    );
    if (!config.shopify.clientId || !config.shopify.clientSecret || !config.shopify.appBaseUrl) {
      await one(
        `INSERT INTO marketplace_connections (user_id, channel, status, display_name, shop_domain, metadata)
         VALUES ($1, 'shopify', 'needs_configuration', $2, $2, $3::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [userId, shop, JSON.stringify({ reason: 'missing_shopify_oauth_env', state })],
      );
      return reply.code(503).send({ error: 'Shopify OAuth is missing server configuration', state });
    }
    const redirectUri = `${config.shopify.appBaseUrl.replace(/\/+$/, '')}/api/v1/auth/shopify/callback`;
    const params = new URLSearchParams({
      client_id: config.shopify.clientId,
      scope: 'read_products,read_orders,read_inventory,read_locations,read_customers',
      redirect_uri: redirectUri,
      state,
    });
    return redirectOrJson(req, reply, `https://${shop}/admin/oauth/authorize?${params.toString()}`, {
      channel: 'shopify',
      state,
    });
  });

  app.get('/auth/shopify/callback', async (req: any, reply) => {
    const state = trim(req.query?.state);
    const code = trim(req.query?.code);
    const shop = trim(req.query?.shop);
    const saved = await one('SELECT * FROM oauth_states WHERE state = $1 AND channel = $2 AND used_at IS NULL AND expires_at > now()', [state, 'shopify']);
    if (!saved || !code || !shop) return reply.code(400).send({ error: 'Invalid Shopify OAuth state' });
    let tokenPayload: any = {};
    try {
      const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret, code }),
      } as any);
      tokenPayload = await res.json();
      if (!res.ok) throw new Error(tokenPayload?.error || 'Shopify token exchange failed');
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || 'Shopify token exchange failed' });
    }
    const account = await one(
      `INSERT INTO marketplace_connections
        (user_id, channel, status, display_name, shop_domain, access_token_enc, scopes, metadata)
       VALUES ($1, 'shopify', 'connected', $2, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [saved.user_id, shop, tokenPayload.access_token || null, String(tokenPayload.scope || '').split(',').filter(Boolean), JSON.stringify({ oauthCompletedAt: new Date().toISOString() })],
    );
    if (account?.id) {
      await Promise.all([
        setSyncStatus(account.id, 'products', 'pending'),
        setSyncStatus(account.id, 'orders', 'pending'),
        setSyncStatus(account.id, 'customers', 'pending'),
        setSyncStatus(account.id, 'inventory', 'pending'),
      ]);
    }
    await pgQuery('UPDATE oauth_states SET used_at = now() WHERE state = $1', [state]);
    await writeLedger(saved.user_id, { entityType: 'marketplace_connection', entityId: account?.id, eventType: 'connected', summary: `Shopify marketplace connected for ${shop}.` });
    return reply.redirect(`${config.frontendOrigin.replace(/\/+$/, '')}/dashboard?connected=shopify`);
  });

  for (const channel of ['amazon', 'ebay']) {
    app.get(`/auth/${channel}/start`, async (req: any, reply) => {
      const userId = requireUser(req, reply);
      if (!userId) return;
      const state = randomBytes(18).toString('hex');
      await pgQuery(
        'INSERT INTO oauth_states (user_id, channel, state, payload) VALUES ($1, $2, $3, $4::jsonb)',
        [userId, channel, state, JSON.stringify(req.query || {})],
      );

      if (channel === 'ebay') {
        if (!config.ebay.clientId || !config.ebay.ruName) {
          await one(
            `INSERT INTO marketplace_connections (user_id, channel, status, display_name, metadata)
             VALUES ($1, 'ebay', 'needs_configuration', 'EBAY pending configuration', $2::jsonb)
             RETURNING *`,
            [userId, JSON.stringify({ state, reason: 'missing_ebay_oauth_env' })],
          );
          return reply.code(503).send({ error: 'eBay OAuth is missing server configuration', state });
        }
        await one(
          `INSERT INTO marketplace_connections (user_id, channel, status, display_name, metadata)
           VALUES ($1, 'ebay', 'needs_authorization', 'EBAY pending authorization', $2::jsonb)
           RETURNING *`,
          [userId, JSON.stringify({ state, provider: 'ebay' })],
        );
        return redirectOrJson(req, reply, buildEbayAuthUrl(state), {
          status: 'authorization_url_created',
          channel,
          state,
        });
      }

      if (channel === 'amazon') {
        if (!config.amazon.clientId || !config.amazon.clientSecret || !config.amazon.appId || !config.amazon.redirectUri) {
          await one(
            `INSERT INTO marketplace_connections (user_id, channel, status, display_name, metadata)
             VALUES ($1, 'amazon', 'needs_configuration', 'Amazon pending configuration', $2::jsonb)
             RETURNING *`,
            [userId, JSON.stringify({ state, reason: 'missing_amazon_oauth_env' })],
          );
          return reply.code(503).send({ error: 'Amazon OAuth is missing server configuration', state });
        }
        await one(
          `INSERT INTO marketplace_connections (user_id, channel, status, display_name, metadata)
           VALUES ($1, 'amazon', 'needs_authorization', 'Amazon pending authorization', $2::jsonb)
           RETURNING *`,
          [userId, JSON.stringify({
            state,
            provider: 'amazon',
            appIdKind: config.amazon.appId.startsWith('amzn1.sellerapps.app.') ? 'seller_app' : 'nonstandard',
            redirectUri: config.amazon.redirectUri,
          })],
        );
        return redirectOrJson(req, reply, buildAmazonAuthUrl(state), {
          status: 'authorization_url_created',
          channel,
          state,
          appIdKind: config.amazon.appId.startsWith('amzn1.sellerapps.app.') ? 'seller_app' : 'nonstandard',
        });
      }
    });

    app.get(`/auth/${channel}/callback`, async (req: any, reply) => {
      const state = trim(req.query?.state);
      const saved = await one('SELECT * FROM oauth_states WHERE state = $1 AND channel = $2 AND used_at IS NULL AND expires_at > now()', [state, channel]);
      if (!saved) return reply.code(400).send({ error: `Invalid ${channel} OAuth state` });

      if (channel === 'ebay' && trim(req.query?.code)) {
        try {
          const token = await exchangeEbayCodeForToken(trim(req.query?.code));
          const scopes = config.ebay.scope.replace(/\\/g, ' ').split(/\s+/).filter(Boolean);
          const metadata = {
            state,
            callbackReceivedAt: new Date().toISOString(),
            marketplaceId: config.ebay.marketplaceId,
            tokenSource: 'oauth_callback',
          };
          let account = await one(
            `UPDATE marketplace_connections
             SET status = 'connected',
                 display_name = COALESCE(display_name, 'eBay'),
                 marketplace_id = $3,
                 access_token_enc = $4,
                 refresh_token_enc = COALESCE($5, refresh_token_enc),
                 token_expires_at = $6,
                 scopes = $7,
                 updated_at = now(),
                 metadata = metadata || $8::jsonb
             WHERE user_id = $1 AND channel = 'ebay' AND metadata->>'state' = $2
             RETURNING *`,
            [
              saved.user_id,
              state,
              config.ebay.marketplaceId,
              token.accessToken,
              token.refreshToken || null,
              token.expiresAt || null,
              scopes,
              JSON.stringify(metadata),
            ],
          );
          if (!account) {
            account = await one(
              `INSERT INTO marketplace_connections
                (user_id, channel, status, display_name, marketplace_id, access_token_enc, refresh_token_enc, token_expires_at, scopes, metadata)
               VALUES ($1, 'ebay', 'connected', 'eBay', $2, $3, $4, $5, $6, $7::jsonb)
               RETURNING *`,
              [
                saved.user_id,
                config.ebay.marketplaceId,
                token.accessToken,
                token.refreshToken || null,
                token.expiresAt || null,
                scopes,
                JSON.stringify(metadata),
              ],
            );
          }
          if (account?.id) {
            await Promise.all([
              setSyncStatus(account.id, 'products', 'pending'),
              setSyncStatus(account.id, 'orders', 'pending'),
              setSyncStatus(account.id, 'customers', 'pending'),
              setSyncStatus(account.id, 'inventory', 'pending'),
            ]);
          }
          await writeLedger(saved.user_id, {
            entityType: 'marketplace_connection',
            entityId: account?.id || null,
            eventType: 'connected',
            summary: 'eBay marketplace connected through OAuth.',
          });
          await pgQuery('UPDATE oauth_states SET used_at = now() WHERE state = $1', [state]);
          return reply.redirect(`${config.frontendOrigin.replace(/\/+$/, '')}/oms?view=connections&connected=ebay`);
        } catch (err: any) {
          return reply.code(400).send({ error: err?.message || 'eBay token exchange failed' });
        }
      }

      if (channel === 'amazon') {
        const code = trim(req.query?.spapi_oauth_code || req.query?.code);
        const sellingPartnerId = trim(req.query?.selling_partner_id);
        if (!code) return reply.code(400).send({ error: 'Amazon callback is missing spapi_oauth_code' });
        try {
          const token = await exchangeAmazonCodeForTokens(code, config.amazon.redirectUri);
          const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null;
          const scopes = ['sellingpartnerapi::orders', 'sellingpartnerapi::listings', 'sellingpartnerapi::fba_inventory', 'sellingpartnerapi::fulfillment_inbound'];
          const metadata = {
            state,
            callbackReceivedAt: new Date().toISOString(),
            tokenSource: 'oauth_callback',
            query: req.query || {},
            appIdKind: config.amazon.appId.startsWith('amzn1.sellerapps.app.') ? 'seller_app' : 'nonstandard',
          };
          let account = await one(
            `UPDATE marketplace_connections
             SET status = 'connected',
                 display_name = COALESCE(display_name, 'Amazon Seller Central'),
                 selling_partner_id = COALESCE($3, selling_partner_id),
                 marketplace_id = COALESCE(marketplace_id, $4),
                 access_token_enc = $5,
                 refresh_token_enc = COALESCE($6, refresh_token_enc),
                 token_expires_at = $7,
                 scopes = $8,
                 updated_at = now(),
                 metadata = metadata || $9::jsonb
             WHERE user_id = $1 AND channel = 'amazon' AND metadata->>'state' = $2
             RETURNING *`,
            [
              saved.user_id,
              state,
              sellingPartnerId || null,
              trim(req.query?.marketplace_id) || 'ATVPDKIKX0DER',
              token.access_token,
              token.refresh_token || null,
              expiresAt,
              scopes,
              JSON.stringify(metadata),
            ],
          );
          if (!account) {
            account = await one(
              `INSERT INTO marketplace_connections
                (user_id, channel, status, display_name, selling_partner_id, marketplace_id, access_token_enc, refresh_token_enc, token_expires_at, scopes, metadata)
               VALUES ($1, 'amazon', 'connected', 'Amazon Seller Central', $2, $3, $4, $5, $6, $7, $8::jsonb)
               RETURNING *`,
              [
                saved.user_id,
                sellingPartnerId || null,
                trim(req.query?.marketplace_id) || 'ATVPDKIKX0DER',
                token.access_token,
                token.refresh_token || null,
                expiresAt,
                scopes,
                JSON.stringify(metadata),
              ],
            );
          }
          if (account?.id) {
            await Promise.all([
              setSyncStatus(account.id, 'products', 'pending'),
              setSyncStatus(account.id, 'orders', 'pending'),
              setSyncStatus(account.id, 'customers', 'pending'),
              setSyncStatus(account.id, 'inventory', 'pending'),
            ]);
          }
          await writeLedger(saved.user_id, {
            entityType: 'marketplace_connection',
            entityId: account?.id || null,
            eventType: 'connected',
            summary: 'Amazon marketplace connected through OAuth.',
            payload: { sellingPartnerId: sellingPartnerId || null },
          });
          await pgQuery('UPDATE oauth_states SET used_at = now() WHERE state = $1', [state]);
          return reply.redirect(`${config.frontendOrigin.replace(/\/+$/, '')}/oms?view=connections&connected=amazon`);
        } catch (err: any) {
          return reply.code(400).send({ error: err?.message || 'Amazon token exchange failed' });
        }
      }

      await pgQuery(
        `UPDATE marketplace_connections
         SET status = 'needs_token_exchange', updated_at = now(), metadata = metadata || $3::jsonb
         WHERE user_id = $1 AND channel = $2 AND status = 'needs_authorization'`,
        [saved.user_id, channel, JSON.stringify({ callbackReceivedAt: new Date().toISOString(), query: req.query || {} })],
      );
      await pgQuery('UPDATE oauth_states SET used_at = now() WHERE state = $1', [state]);
      return reply.redirect(`${config.frontendOrigin.replace(/\/+$/, '')}/dashboard?connected=${channel}&status=pending-token-exchange`);
    });
  }

  app.post('/webhooks/shopify', async (_req: any, reply) => reply.code(202).send({ accepted: true, storage: 'aurora_postgres' }));
  app.post('/webhooks/ebay/account-deletion', async (_req: any, reply) => reply.code(200).send({ accepted: true }));

  app.get('/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const channel = trim(req.query?.channel);
    const values: unknown[] = [userId, limit, offset];
    let where = 'i.user_id = $1';
    if (channel && channel !== 'unmapped') {
      values.push(channel);
      where += ` AND EXISTS (SELECT 1 FROM item_channel_mappings m WHERE m.item_id = i.id AND m.channel = $${values.length})`;
    } else if (channel === 'unmapped') {
      where += ' AND NOT EXISTS (SELECT 1 FROM item_channel_mappings m WHERE m.item_id = i.id)';
    }
    const data = await rows(`SELECT i.* FROM catalog_items i WHERE ${where} ORDER BY i.updated_at DESC LIMIT $2 OFFSET $3`, values);
    const ids = data.map((item) => item.id);
    const mappings = ids.length
      ? await rows(
          `SELECT m.*, c.display_name, c.shop_domain, c.selling_partner_id
           FROM item_channel_mappings m
           LEFT JOIN marketplace_connections c ON c.id = m.channel_connection_id
           WHERE m.user_id = $1 AND m.item_id = ANY($2::text[])`,
          [userId, ids],
        )
      : [];
    const byItem = mappings.reduce<Record<string, AnyRow[]>>((acc, row) => {
      const key = String(row.item_id);
      if (!acc[key]) acc[key] = [];
      acc[key]!.push(row);
      return acc;
    }, {});
    return data.map((item) => {
      const itemMappings = byItem[item.id] || [];
      return mapItem(item, {
        channels: [...new Set(itemMappings.map((m) => m.channel))],
        mappings: itemMappings.map((m) => ({
          _id: m.id,
          id: m.id,
          channel: m.channel,
          channelDisplay: m.display_name || m.shop_domain || m.selling_partner_id || m.channel,
          channelAccountId: m.channel_connection_id,
          channelItemId: m.channel_item_id,
          channelVariantId: m.channel_variant_id,
          status: m.status,
        })),
      });
    });
  });

  app.post('/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!trim(body.sku) || !trim(body.title)) return reply.code(400).send({ error: 'sku and title required' });
    try {
      const item = await one(
        `INSERT INTO catalog_items
          (user_id, sku, title, description, attributes, default_uom, tags, supplier_id, image, images, upc, ean, asin, category, sub_category, lob, weight, dimensions, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb)
         RETURNING *`,
        [
          userId,
          trim(body.sku),
          trim(body.title),
          body.description || null,
          JSON.stringify(body.attributes || {}),
          body.defaultUom || null,
          Array.isArray(body.tags) ? body.tags : [],
          body.supplierId || null,
          body.image || null,
          JSON.stringify(Array.isArray(body.images) ? body.images : []),
          body.upc || null,
          body.ean || null,
          body.asin || null,
          body.category || null,
          body.subCategory || null,
          body.lob || null,
          body.weight === '' || body.weight == null ? null : Number(body.weight),
          JSON.stringify(body.dimensions || {}),
          JSON.stringify(body.metadata || {}),
        ],
      );
      await writeLedger(userId, { entityType: 'catalog_item', entityId: item?.id, eventType: 'created', summary: `Catalog item ${trim(body.sku)} created in Aurora.` });
      return mapItem(item || {});
    } catch (err: any) {
      req.log.error({ err }, 'failed to create SQL item');
      return reply.code(400).send({ error: 'Could not create item', detail: err?.message });
    }
  });

  app.get('/items/:id/wms-activities', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT * FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    return {
      sku: item.sku,
      source: 'aurora_postgres_wms_projection',
      wmsInventory: json(item.wms_inventory, {}),
      inventoryByWarehouse: [],
      activities: [],
      message: 'Live WMS activity is exposed after WMS event streaming is connected to Aurora.',
    };
  });

  app.get('/items/:id/shipment-activity', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT sku FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!item) return reply.code(404).send({ error: 'Not found' });
    const events = await rows(
      `SELECT * FROM shipment_activity_log
       WHERE user_id = $1 AND payload->>'sku' = $2
       ORDER BY created_at DESC LIMIT 100`,
      [userId, item.sku],
    );
    return { events, total: events.length };
  });

  app.get('/items/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT * FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!item) return reply.code(404).send({ error: 'Not found' });
    const mappings = await rows('SELECT * FROM item_channel_mappings WHERE item_id = $1 AND user_id = $2 ORDER BY updated_at DESC', [item.id, userId]);
    return mapItem(item, {
      channels: [...new Set(mappings.map((m) => m.channel))],
      mappings: mappings.map((m) => ({ _id: m.id, id: m.id, channel: m.channel, channelAccountId: m.channel_connection_id, channelItemId: m.channel_item_id, status: m.status })),
    });
  });

  app.patch('/items/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const item = await one(
      `UPDATE catalog_items
       SET title = COALESCE($3, title),
           description = COALESCE($4, description),
           attributes = COALESCE($5::jsonb, attributes),
           default_uom = COALESCE($6, default_uom),
           tags = COALESCE($7, tags),
           supplier_id = $8,
           image = $9,
           images = COALESCE($10::jsonb, images),
           upc = $11,
           ean = $12,
           asin = $13,
           category = $14,
           sub_category = $15,
           lob = $16,
           weight = $17,
           dimensions = COALESCE($18::jsonb, dimensions),
           archived = COALESCE($19, archived),
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        req.params.id,
        userId,
        body.title === undefined ? null : trim(body.title),
        body.description === undefined ? null : body.description,
        body.attributes === undefined ? null : JSON.stringify(body.attributes || {}),
        body.defaultUom === undefined ? null : body.defaultUom,
        body.tags === undefined ? null : (Array.isArray(body.tags) ? body.tags : []),
        body.supplierId === undefined ? null : body.supplierId || null,
        body.image === undefined ? null : body.image || null,
        body.images === undefined ? null : JSON.stringify(Array.isArray(body.images) ? body.images : []),
        body.upc === undefined ? null : body.upc || null,
        body.ean === undefined ? null : body.ean || null,
        body.asin === undefined ? null : body.asin || null,
        body.category === undefined ? null : body.category || null,
        body.subCategory === undefined ? null : body.subCategory || null,
        body.lob === undefined ? null : body.lob || null,
        body.weight === undefined || body.weight === '' ? null : Number(body.weight),
        body.dimensions === undefined ? null : JSON.stringify(body.dimensions || {}),
        body.archived === undefined ? null : Boolean(body.archived),
      ],
    );
    if (!item) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(userId, { entityType: 'catalog_item', entityId: item.id, eventType: 'updated', summary: `Catalog item ${item.sku} updated.` });
    return mapItem(item);
  });

  app.post('/items/:id/map', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!body.channelAccountId || !body.channelItemId) return reply.code(400).send({ error: 'channelAccountId and channelItemId required' });
    const item = await one('SELECT * FROM catalog_items WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    const account = await one('SELECT * FROM marketplace_connections WHERE id = $1 AND user_id = $2', [body.channelAccountId, userId]);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    if (!account) return reply.code(400).send({ error: 'Invalid channelAccountId' });
    const mapping = await one(
      `INSERT INTO item_channel_mappings (user_id, item_id, channel_connection_id, channel, channel_item_id, channel_variant_id, sku, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'active'))
       ON CONFLICT (user_id, channel, channel_item_id, (COALESCE(channel_variant_id, '')))
       DO UPDATE SET item_id = EXCLUDED.item_id, channel_connection_id = EXCLUDED.channel_connection_id, sku = EXCLUDED.sku, status = EXCLUDED.status, updated_at = now()
       RETURNING *`,
      [userId, item.id, account.id, account.channel, trim(body.channelItemId), body.channelVariantId || null, body.sku || item.sku, body.status || 'active'],
    );
    return { _id: mapping?.id, id: mapping?.id, ...mapping };
  });

  app.get('/mappings/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const items = await rows('SELECT id, sku, title FROM catalog_items WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    const mappings = await rows('SELECT * FROM item_channel_mappings WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return { items: items.map((i) => ({ _id: i.id, ...i })), mappings: mappings.map((m) => ({ _id: m.id, ...m })) };
  });

  app.get('/customers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const search = trim(req.query?.search || req.query?.q);
    const values: unknown[] = [userId, limit, offset];
    let where = 'user_id = $1';
    if (search) {
      values.push(`%${search}%`);
      where += ` AND (name ILIKE $${values.length} OR email ILIKE $${values.length} OR company ILIKE $${values.length})`;
    }
    const data = await rows(`SELECT * FROM customers WHERE ${where} ORDER BY updated_at DESC LIMIT $2 OFFSET $3`, values);
    return data.map(mapCustomer);
  });

  app.post('/customers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const customer = await one(
      `INSERT INTO customers (user_id, name, email, phone, company, channel, external_customer_id, addresses, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
       RETURNING *`,
      [userId, body.name || null, normalizedEmail(body.email) || null, body.phone || null, body.company || null, body.channel || null, body.externalCustomerId || null, JSON.stringify(body.addresses || []), JSON.stringify(body.metadata || {})],
    );
    return mapCustomer(customer || {});
  });

  app.get('/customers/:id/orders', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM orders WHERE user_id = $1 AND customer_id = $2 ORDER BY placed_at DESC NULLS LAST, created_at DESC LIMIT 200', [userId, req.params.id]);
    const totalValue = data.reduce((sum, row) => sum + number(json(row.totals, {}).total), 0);
    const byStatus = data.reduce<Record<string, number>>((acc, row) => {
      const status = row.status || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return {
      orders: data.map((row) => mapOrder(row)),
      total: data.length,
      summary: {
        totalOrders: data.length,
        totalValue: money(totalValue),
        ordersByStatus: Object.entries(byStatus).map(([_id, count]) => ({ _id, count })),
      },
    };
  });

  app.get('/customers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const customer = await one('SELECT * FROM customers WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!customer) return reply.code(404).send({ error: 'Not found' });
    return mapCustomer(customer);
  });

  app.patch('/customers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const customer = await one(
      `UPDATE customers
       SET name = COALESCE($3, name), email = COALESCE($4, email), phone = COALESCE($5, phone), company = COALESCE($6, company),
           addresses = COALESCE($7::jsonb, addresses), metadata = metadata || COALESCE($8::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.name ?? null, body.email === undefined ? null : normalizedEmail(body.email), body.phone ?? null, body.company ?? null, body.addresses === undefined ? null : JSON.stringify(body.addresses || []), body.metadata === undefined ? null : JSON.stringify(body.metadata || {})],
    );
    if (!customer) return reply.code(404).send({ error: 'Not found' });
    return mapCustomer(customer);
  });

  app.post('/customers/:id/map', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const customer = await one('SELECT * FROM customers WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!customer) return reply.code(404).send({ error: 'Customer not found' });
    const mapping = await one(
      `INSERT INTO customer_channel_mappings (user_id, customer_id, channel_connection_id, channel, external_customer_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (user_id, channel, external_customer_id)
       DO UPDATE SET customer_id = EXCLUDED.customer_id, channel_connection_id = EXCLUDED.channel_connection_id, payload = EXCLUDED.payload, updated_at = now()
       RETURNING *`,
      [userId, customer.id, body.channelAccountId || null, body.channel || customer.channel || 'manual', body.externalCustomerId || body.channelCustomerId, JSON.stringify(body.payload || {})],
    );
    return { _id: mapping?.id, id: mapping?.id, ...mapping };
  });

  app.get('/mappings/customers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const customers = await rows('SELECT id, name, email FROM customers WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    const mappings = await rows('SELECT * FROM customer_channel_mappings WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return { customers: customers.map((c) => ({ _id: c.id, ...c })), mappings: mappings.map((m) => ({ _id: m.id, ...m })) };
  });

  app.get('/orders', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const data = await rows('SELECT * FROM orders WHERE user_id = $1 ORDER BY placed_at DESC NULLS LAST, created_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
    return data.map((row) => mapOrder(row));
  });

  app.post('/orders', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const linesInput = Array.isArray(body.lines) ? body.lines : [];
    if (!body.customerId) return reply.code(400).send({ error: 'customerId required' });
    if (!linesInput.length) return reply.code(400).send({ error: 'at least one order line required' });

    const customer = await one('SELECT * FROM customers WHERE id = $1 AND user_id = $2', [body.customerId, userId]);
    if (!customer) return reply.code(400).send({ error: 'Customer must exist before creating an order' });

    const normalizedLines: Array<{
      itemId: string;
      sku: string;
      title: string;
      quantity: number;
      unitPrice: number;
      totalPrice: number;
      metadata: AnyRow;
    }> = [];
    for (const raw of linesInput) {
      const quantity = Math.max(1, number(raw?.quantity, 1));
      const unitPrice = money(raw?.unitPrice ?? raw?.unit_price ?? 0);
      let item: AnyRow | null = null;
      if (raw?.itemId) {
        item = await one('SELECT * FROM catalog_items WHERE id = $1 AND user_id = $2', [raw.itemId, userId]);
      } else if (trim(raw?.sku)) {
        item = await one('SELECT * FROM catalog_items WHERE lower(sku) = lower($1) AND user_id = $2 ORDER BY updated_at DESC LIMIT 1', [trim(raw.sku), userId]);
      }
      if (!item) return reply.code(400).send({ error: `Item/SKU must exist before creating an order line${raw?.sku ? `: ${raw.sku}` : ''}` });
      normalizedLines.push({
        itemId: item.id,
        sku: item.sku,
        title: raw?.title || item.title,
        quantity,
        unitPrice,
        totalPrice: money(quantity * unitPrice),
        metadata: raw?.metadata || {},
      });
    }

    const subtotal = money(normalizedLines.reduce((sum, line) => sum + line.totalPrice, 0));
    const total = money(body.total ?? subtotal);
    const result = await withPgTransaction(async (client) => {
      const orderResult = await client.query(
        `INSERT INTO orders
          (user_id, customer_id, channel, external_order_id, order_number, status, paid, placed_at, totals, shipping_address, billing_address, metadata)
         VALUES ($1, $2, COALESCE($3, 'manual'), $4, $5, COALESCE($6, 'open'), $7, COALESCE($8::timestamptz, now()), $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
         RETURNING *`,
        [
          userId,
          customer.id,
          body.channel || 'manual',
          trim(body.externalOrderId || body.external_order_id || body.orderNumber) || null,
          trim(body.orderNumber || body.order_number || body.externalOrderId) || null,
          body.status || 'open',
          body.paid == null ? null : String(body.paid),
          body.placedAt || body.placed_at || null,
          JSON.stringify({ subtotal, total, currency: body.currency || 'USD', ...(body.totals || {}) }),
          JSON.stringify(body.shippingAddress || body.shipping_address || {}),
          JSON.stringify(body.billingAddress || body.billing_address || {}),
          JSON.stringify(body.metadata || {}),
        ],
      );
      const order = orderResult.rows[0];
      const createdLines = [];
      for (const line of normalizedLines) {
        const lineResult = await client.query(
          `INSERT INTO order_lines (user_id, order_id, item_id, sku, title, quantity, unit_price, total_price, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           RETURNING *`,
          [userId, order.id, line.itemId, line.sku, line.title, line.quantity, line.unitPrice, line.totalPrice, JSON.stringify(line.metadata)],
        );
        createdLines.push(lineResult.rows[0]);
      }
      return { order, lines: createdLines };
    });

    if (!result) return reply.code(500).send({ error: 'Postgres is not configured' });
    await writeLedger(userId, {
      entityType: 'order',
      entityId: result.order.id,
      eventType: 'created',
      summary: `Manual OMS order ${result.order.order_number || result.order.external_order_id || result.order.id} created with ${result.lines.length} line item(s).`,
      payload: { source: body.source || 'oms_manual', lineCount: result.lines.length, total },
    });
    return mapOrder(result.order, result.lines);
  });

  app.get('/orders/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const order = await one('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!order) return reply.code(404).send({ error: 'Not found' });
    const lines = await rows('SELECT * FROM order_lines WHERE order_id = $1 AND user_id = $2 ORDER BY created_at ASC', [order.id, userId]);
    return mapOrder(order, lines);
  });

  app.post('/orders/:id/cancel', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const reason = trim(req.body?.reason || 'Cancelled from OMS');
    const order = await one(
      `UPDATE orders
       SET status = 'cancelled',
           metadata = metadata || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        req.params.id,
        userId,
        JSON.stringify({
          cancelledAt: new Date().toISOString(),
          cancelReason: reason,
          cancelledBy: req.user?.email || userId,
        }),
      ],
    );
    if (!order) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(userId, {
      entityType: 'order',
      entityId: order.id,
      eventType: 'cancelled',
      summary: `Order ${order.order_number || publicEntityId('OR', order.id)} cancelled.`,
      payload: { reason, publicId: publicEntityId('OR', order.id) },
    });
    const lines = await rows('SELECT * FROM order_lines WHERE order_id = $1 AND user_id = $2 ORDER BY created_at ASC', [order.id, userId]);
    return { order: mapOrder(order, lines), success: true };
  });

  app.get('/suppliers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const data = await rows('SELECT * FROM suppliers WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
    return data.map(mapSupplier);
  });

  app.post('/suppliers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!trim(body.name)) return reply.code(400).send({ error: 'name required' });
    const metadata = supplierMetadataFromBody(body);
    const supplier = await one(
      `INSERT INTO suppliers (user_id, name, email, phone, status, address, metadata)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), $6::jsonb, $7::jsonb) RETURNING *`,
      [userId, trim(body.name), normalizedEmail(body.email) || null, body.phone || null, body.status || 'active', JSON.stringify(body.address || {}), JSON.stringify(metadata)],
    );
    return mapSupplier(supplier || {});
  });

  app.get('/suppliers/:id/products', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM catalog_items WHERE user_id = $1 AND supplier_id = $2 ORDER BY updated_at DESC', [userId, req.params.id]);
    return { items: data.map((row) => mapItem(row)), total: data.length };
  });

  app.get('/suppliers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const supplier = await one('SELECT * FROM suppliers WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!supplier) return reply.code(404).send({ error: 'Not found' });
    return mapSupplier(supplier);
  });

  app.patch('/suppliers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const hasMetadataPatch = body.metadata !== undefined
      || [
        'website',
        'notes',
        'onlineSupplier',
        'paymentTerms',
        'relationship',
        'loadingDock',
        'maxVehicleSize',
        'hoursOfOperation',
        'equipmentRequired',
        'appointmentRequired',
        'dockAppointmentLeadTimeHours',
        'liftgateRequired',
        'insidePickup',
        'palletExchange',
        'pickupInstructions',
        'contactName',
      ].some((key) => body[key] !== undefined);
    const metadata = hasMetadataPatch ? supplierMetadataFromBody(body) : null;
    const supplier = await one(
      `UPDATE suppliers
       SET name = COALESCE($3, name), email = COALESCE($4, email), phone = COALESCE($5, phone), status = COALESCE($6, status),
           address = COALESCE($7::jsonb, address), metadata = metadata || COALESCE($8::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.name ?? null, body.email === undefined ? null : normalizedEmail(body.email), body.phone ?? null, body.status ?? null, body.address === undefined ? null : JSON.stringify(body.address || {}), metadata === null ? null : JSON.stringify(metadata)],
    );
    if (!supplier) return reply.code(404).send({ error: 'Not found' });
    return mapSupplier(supplier);
  });

  app.delete('/suppliers/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM suppliers WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });

  app.get('/ship-from-locations', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM ship_from_locations WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return data.map(mapShipFrom);
  });

  app.post('/ship-from-locations', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const loc = await one(
      `INSERT INTO ship_from_locations (user_id, supplier_id, name, contact_name, phone, email, address, is_default, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb) RETURNING *`,
      [userId, body.supplierId || null, body.name || 'Ship-from location', body.contactName || null, body.phone || null, body.email || null, JSON.stringify(body.address || {}), Boolean(body.isDefault), JSON.stringify(body.metadata || {})],
    );
    return mapShipFrom(loc || {});
  });

  app.get('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const loc = await one('SELECT * FROM ship_from_locations WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!loc) return reply.code(404).send({ error: 'Not found' });
    return mapShipFrom(loc);
  });

  app.patch('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const loc = await one(
      `UPDATE ship_from_locations
       SET supplier_id = COALESCE($3, supplier_id), name = COALESCE($4, name), contact_name = COALESCE($5, contact_name),
           phone = COALESCE($6, phone), email = COALESCE($7, email), address = COALESCE($8::jsonb, address),
           is_default = COALESCE($9, is_default), metadata = metadata || COALESCE($10::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.supplierId ?? null, body.name ?? null, body.contactName ?? null, body.phone ?? null, body.email ?? null, body.address === undefined ? null : JSON.stringify(body.address || {}), body.isDefault === undefined ? null : Boolean(body.isDefault), body.metadata === undefined ? null : JSON.stringify(body.metadata || {})],
    );
    if (!loc) return reply.code(404).send({ error: 'Not found' });
    return mapShipFrom(loc);
  });

  app.delete('/ship-from-locations/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM ship_from_locations WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });

  app.get('/facilities', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    await seedDefaultFacility(userId);
    const data = await rows('SELECT * FROM facilities WHERE user_id = $1 OR user_id IS NULL ORDER BY code ASC', [userId]);
    return data.map(mapFacility);
  });

  app.post('/facilities', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!trim(body.code) || !trim(body.name)) return reply.code(400).send({ error: 'code and name required' });
    const facility = await one(
      `INSERT INTO facilities (user_id, code, name, facility_type, status, address, latitude, longitude, metadata)
       VALUES ($1, $2, $3, COALESCE($4, 'warehouse'), COALESCE($5, 'active'), $6::jsonb, $7, $8, $9::jsonb)
       ON CONFLICT (user_id, code) DO UPDATE SET name = EXCLUDED.name, facility_type = EXCLUDED.facility_type, status = EXCLUDED.status, address = EXCLUDED.address, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, metadata = EXCLUDED.metadata, updated_at = now()
       RETURNING *`,
      [userId, trim(body.code), trim(body.name), body.facilityType || body.type || 'warehouse', body.status || 'active', JSON.stringify(body.address || {}), body.latitude == null ? null : Number(body.latitude), body.longitude == null ? null : Number(body.longitude), JSON.stringify(body.metadata || {})],
    );
    return mapFacility(facility || {});
  });

  app.get('/shipment-plans/activity', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const data = await rows('SELECT * FROM shipment_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [userId, limit, offset]);
    return { events: data.map((e) => ({ _id: e.id, id: e.id, action: e.action, summary: e.summary, payload: json(e.payload, {}), createdAt: iso(e.created_at) })), total: data.length };
  });

  app.post('/shipment-plans/estimate-service-fees', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const units = items.reduce((sum: number, item: any) => sum + number(item.quantity, 1), 0);
    return {
      currency: 'USD',
      lineItems: [
        { code: 'receiving', label: 'Receiving', amount: money(Math.max(12, units * 0.18)) },
        { code: 'prep', label: 'Prep services', amount: money(units * 0.35) },
        { code: 'palletization', label: 'Palletization estimate', amount: money(Math.ceil(units / 80) * 18) },
      ],
      total: money(Math.max(12, units * 0.18) + units * 0.35 + Math.ceil(units / 80) * 18),
      source: 'aurora_sql_estimate',
    };
  });

  app.get('/shipment-plans/closest-facility-preview', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const facility = await seedDefaultFacility(userId);
    return { facilityId: facility?.id || null, facility: facility ? mapFacility(facility) : null, distanceMiles: null, shipFromAddress: undefined };
  });

  app.get('/shipment-plans', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const status = trim(req.query?.status);
    const values: unknown[] = [userId, limit, offset];
    let where = 'user_id = $1';
    if (status) {
      values.push(status);
      where += ` AND status = $${values.length}`;
    }
    const data = await rows(`SELECT * FROM shipment_plans WHERE ${where} ORDER BY updated_at DESC LIMIT $2 OFFSET $3`, values);
    return { plans: data.map(mapShipmentPlan), total: data.length, limit, offset };
  });

  app.post('/shipment-plans', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const facility = body.facilityId ? await one('SELECT * FROM facilities WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)', [body.facilityId, userId]) : await seedDefaultFacility(userId);
    const shipFrom = body.shipFromLocationId ? await one('SELECT * FROM ship_from_locations WHERE id = $1 AND user_id = $2', [body.shipFromLocationId, userId]) : null;
    const plan = await one(
      `INSERT INTO shipment_plans
        (user_id, supplier_id, ship_from_location_id, facility_id, internal_shipment_id, shipment_title, status, prep_services_only, marketplace_id, marketplace_type, order_no, receipt_no, order_date, estimated_arrival_date, ship_from_address, items, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb)
       RETURNING *`,
      [
        userId,
        body.supplierId || null,
        body.shipFromLocationId || null,
        facility?.id || null,
        `UC-${Date.now().toString(36).toUpperCase()}`,
        body.shipmentTitle || `Shipment ${new Date().toLocaleDateString('en-US')}`,
        Boolean(body.prepServicesOnly),
        body.marketplaceId || null,
        body.marketplaceType || null,
        body.orderNo || null,
        body.receiptNo || null,
        body.orderDate ? new Date(body.orderDate) : null,
        body.estimatedArrivalDate ? new Date(body.estimatedArrivalDate) : null,
        JSON.stringify(shipFrom?.address || body.shipFromAddress || {}),
        JSON.stringify(Array.isArray(body.items) ? body.items : []),
        JSON.stringify({ autoRoutedBy: 'cortex_oms', warehouseSelectionHiddenFromClient: true }),
      ],
    );
    await pgQuery('INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary, payload) VALUES ($1, $2, $3, $4, $5::jsonb)', [userId, plan?.id, 'created', 'Shipment plan created in Aurora SQL mode.', JSON.stringify({ planId: plan?.id })]);
    return mapShipmentPlan(plan || {});
  });

  app.get('/shipment-plans/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    return mapShipmentPlan(plan);
  });

  app.put('/shipment-plans/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const plan = await one(
      `UPDATE shipment_plans
       SET items = COALESCE($3::jsonb, items), order_no = COALESCE($4, order_no), receipt_no = COALESCE($5, receipt_no),
           order_date = COALESCE($6, order_date), estimated_arrival_date = COALESCE($7, estimated_arrival_date),
           shipment_title = COALESCE($8, shipment_title), status = COALESCE($9, status), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.items === undefined ? null : JSON.stringify(body.items || []), body.orderNo ?? null, body.receiptNo ?? null, body.orderDate ? new Date(body.orderDate) : null, body.estimatedArrivalDate ? new Date(body.estimatedArrivalDate) : null, body.shipmentTitle ?? null, body.status ?? null],
    );
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    return mapShipmentPlan(plan);
  });

  app.post('/shipment-plans/:id/submit', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId, 'submitted']);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    await pgQuery('INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary) VALUES ($1, $2, $3, $4)', [userId, plan.id, 'submitted', 'Shipment plan submitted for WMS/Cortex execution.']);
    return mapShipmentPlan(plan);
  });

  app.post('/shipment-plans/:id/cancel', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *', [req.params.id, userId, 'cancelled']);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    await pgQuery('INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary) VALUES ($1, $2, $3, $4)', [userId, plan.id, 'cancelled', 'Shipment plan cancelled.']);
    return mapShipmentPlan(plan);
  });

  app.get('/shipment-plans/:id/closest-facility', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const facility = plan.facility_id ? await one('SELECT * FROM facilities WHERE id = $1', [plan.facility_id]) : await seedDefaultFacility(userId);
    return { facilityId: facility?.id || null, facility: facility ? mapFacility(facility) : null, distanceMiles: null };
  });

  app.post('/shipment-plans/:id/create-asn', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const asn = await one(
      `INSERT INTO asns (user_id, shipment_plan_id, asn_number, status, payload)
       VALUES ($1, $2, $3, 'created', $4::jsonb) RETURNING *`,
      [userId, plan.id, `ASN-${Date.now().toString(36).toUpperCase()}`, JSON.stringify({ shipmentPlan: mapShipmentPlan(plan), source: 'aurora_postgres' })],
    );
    await pgQuery('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2', [plan.id, userId, 'asn_created']);
    return {
      asn: {
        _id: asn?.id,
        id: asn?.id,
        publicId: publicEntityId('AS', asn?.id),
        displayId: publicEntityId('AS', asn?.id),
        asnNumber: asn?.asn_number,
        status: asn?.status,
        payload: json(asn?.payload, {}),
        createdAt: iso(asn?.created_at),
      },
      plan: mapShipmentPlan({ ...plan, status: 'asn_created' }),
    };
  });

  app.post('/asn/:id/cancel', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const reason = trim(req.body?.reason || 'Cancelled from OMS');
    const asn = await one(
      `UPDATE asns
       SET status = 'cancelled',
           payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        req.params.id,
        userId,
        JSON.stringify({
          cancelledAt: new Date().toISOString(),
          cancelReason: reason,
          cancelledBy: req.user?.email || userId,
        }),
      ],
    );
    if (!asn) return reply.code(404).send({ error: 'ASN not found' });
    if (asn.shipment_plan_id) {
      await pgQuery('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2', [asn.shipment_plan_id, userId, 'asn_cancelled']);
      await pgQuery(
        'INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary) VALUES ($1, $2, $3, $4)',
        [userId, asn.shipment_plan_id, 'asn_cancelled', `ASN ${asn.asn_number || publicEntityId('AS', asn.id)} cancelled.`],
      );
    }
    await writeLedger(userId, {
      entityType: 'asn',
      entityId: asn.id,
      eventType: 'cancelled',
      summary: `ASN ${asn.asn_number || publicEntityId('AS', asn.id)} cancelled.`,
      payload: { reason, publicId: publicEntityId('AS', asn.id), shipmentPlanId: asn.shipment_plan_id || null },
    });
    return {
      asn: {
        _id: asn.id,
        id: asn.id,
        publicId: publicEntityId('AS', asn.id),
        displayId: publicEntityId('AS', asn.id),
        asnNumber: asn.asn_number,
        status: asn.status,
        payload: json(asn.payload, {}),
        createdAt: iso(asn.created_at),
        updatedAt: iso(asn.updated_at),
      },
      success: true,
    };
  });

  app.post('/asn/:id/stop', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const reason = trim(req.body?.reason || 'Stopped from OMS before warehouse execution');
    const asn = await one(
      `UPDATE asns
       SET status = 'stopped',
           payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        req.params.id,
        userId,
        JSON.stringify({
          stoppedAt: new Date().toISOString(),
          stopReason: reason,
          stoppedBy: req.user?.email || userId,
        }),
      ],
    );
    if (!asn) return reply.code(404).send({ error: 'ASN not found' });
    if (asn.shipment_plan_id) {
      await pgQuery('UPDATE shipment_plans SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2', [asn.shipment_plan_id, userId, 'asn_stopped']);
      await pgQuery(
        'INSERT INTO shipment_activity_log (user_id, shipment_plan_id, action, summary) VALUES ($1, $2, $3, $4)',
        [userId, asn.shipment_plan_id, 'asn_stopped', `ASN ${asn.asn_number || publicEntityId('AS', asn.id)} stopped before execution.`],
      );
    }
    await writeLedger(userId, {
      entityType: 'asn',
      entityId: asn.id,
      eventType: 'stopped',
      summary: `ASN ${asn.asn_number || publicEntityId('AS', asn.id)} stopped before warehouse execution.`,
      payload: { reason, publicId: publicEntityId('AS', asn.id), shipmentPlanId: asn.shipment_plan_id || null },
    });
    return {
      asn: {
        _id: asn.id,
        id: asn.id,
        publicId: publicEntityId('AS', asn.id),
        displayId: publicEntityId('AS', asn.id),
        asnNumber: asn.asn_number,
        status: asn.status,
        payload: json(asn.payload, {}),
        createdAt: iso(asn.created_at),
        updatedAt: iso(asn.updated_at),
      },
      success: true,
    };
  });

  app.post('/shipment-plans/:id/rate-shop-to-warehouse', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const items = Array.isArray(plan.items) ? plan.items : [];
    const units = items.reduce((sum: number, item: any) => sum + number(item.quantity, 1), 0);
    const base = Math.max(125, units * 1.85);
    return {
      planId: plan.id,
      currency: 'USD',
      rates: [
        { serviceTier: 'economy', carrier: 'Cortex LTL', amount: money(base * 0.86), transitDays: 5, recommendation: 'Best cost when consolidation is allowed.' },
        { serviceTier: 'standard', carrier: 'Cortex LTL', amount: money(base), transitDays: 3, recommendation: 'Balanced speed and utilization.' },
        { serviceTier: 'priority', carrier: 'Cortex LTL', amount: money(base * 1.28), transitDays: 2, recommendation: 'Faster movement with lower consolidation tolerance.' },
      ],
      source: 'aurora_sql_rate_model',
    };
  });

  app.get('/shipment-plans/:id/estimated-cost', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plan = await one('SELECT * FROM shipment_plans WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!plan) return reply.code(404).send({ error: 'Not found' });
    const units = Array.isArray(plan.items) ? plan.items.reduce((sum: number, item: any) => sum + number(item.quantity, 1), 0) : 0;
    return { currency: 'USD', total: money(95 + units * 1.1), source: 'aurora_sql_estimate', facilityId: plan.facility_id };
  });

  app.get('/invoices', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const shipmentPlanId = trim(req.query?.shipmentPlanId);
    const data = shipmentPlanId
      ? await rows('SELECT * FROM invoice_lines WHERE user_id = $1 AND shipment_plan_id = $2 ORDER BY created_at DESC', [userId, shipmentPlanId])
      : await rows('SELECT * FROM invoice_lines WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [userId]);
    return { invoices: data.map((line) => ({ _id: line.id, id: line.id, shipmentPlanId: line.shipment_plan_id, invoiceId: line.invoice_id, description: line.description, amount: money(line.amount), currency: line.currency, status: line.status, payload: json(line.payload, {}), createdAt: iso(line.created_at) })) };
  });

  app.get('/notes', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const entityType = trim(req.query?.entityType);
    const entityId = trim(req.query?.entityId);
    if (!entityType || !entityId) return reply.code(400).send({ error: 'entityType and entityId required' });
    const data = await rows('SELECT * FROM notes WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at DESC', [userId, entityType, entityId]);
    return { notes: data.map((n) => ({ _id: n.id, id: n.id, entityType: n.entity_type, entityId: n.entity_id, note: n.note, body: n.body, pinned: n.pinned, authorId: n.author_id, createdAt: iso(n.created_at), updatedAt: iso(n.updated_at) })) };
  });

  app.post('/notes', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    if (!body.entityType || !body.entityId || !(body.note || body.body)) return reply.code(400).send({ error: 'entityType, entityId and note required' });
    const note = await one(
      `INSERT INTO notes (user_id, entity_type, entity_id, note, body, author_id, pinned, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
      [userId, body.entityType, body.entityId, body.note || body.body, body.body || body.note, userId, Boolean(body.pinned), JSON.stringify(body.metadata || {})],
    );
    return { _id: note?.id, id: note?.id, entityType: note?.entity_type, entityId: note?.entity_id, note: note?.note, body: note?.body, createdAt: iso(note?.created_at) };
  });

  app.get('/features', async (req: any) => {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const data = await rows(
      `SELECT f.*, uf.status AS user_status, uf.enabled_at, (uf.status = 'enabled') AS is_enabled
       FROM features f
       LEFT JOIN user_features uf ON uf.feature_id = f.id AND uf.user_id = $1
       ORDER BY COALESCE((f.payload->>'marketplaceOrder')::int, 999), f.category, f.name`,
      [userId],
    );
    return { features: data.map(mapFeature) };
  });

  app.get('/features/marketplace', async (req: any) => {
    const userId = req.user?.userId ? String(req.user.userId) : null;
    const data = await rows(
      `SELECT f.*, uf.status AS user_status, uf.enabled_at, (uf.status = 'enabled') AS is_enabled
       FROM features f
       LEFT JOIN user_features uf ON uf.feature_id = f.id AND uf.user_id = $1
       WHERE f.status = 'active'
         AND COALESCE((f.payload->>'isMarketplaceApp')::boolean, f.category IN ('marketplace','optimization','finance','audit','analytics'))
       ORDER BY COALESCE((f.payload->>'marketplaceOrder')::int, 999), f.name`,
      [userId],
    );
    const categories = Array.from(new Set(data.map((feature) => String(feature.category || '')).filter(Boolean)));
    return { features: data.map(mapFeature), categories };
  });

  app.get('/features/:id', async (req: any, reply) => {
    const feature = await one('SELECT * FROM features WHERE id = $1', [req.params.id]);
    if (!feature) return reply.code(404).send({ error: 'Not found' });
    return mapFeature(feature);
  });

  app.get('/user/features', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows(
      `SELECT f.*,
              COALESCE(uf.status, CASE WHEN COALESCE((f.payload->>'isCore')::boolean, false) THEN 'enabled' ELSE NULL END) AS user_status,
              uf.enabled_at,
              COALESCE((f.payload->>'isCore')::boolean, false) OR uf.status = 'enabled' AS is_enabled
       FROM features f
       LEFT JOIN user_features uf ON uf.feature_id = f.id AND uf.user_id = $1
       ORDER BY COALESCE((f.payload->>'marketplaceOrder')::int, 999), f.category, f.name`,
      [userId],
    );
    return { features: data.map(mapFeature) };
  });

  for (const action of ['enable', 'purchase']) {
    app.post(`/features/:id/${action}`, async (req: any, reply) => {
      const userId = requireUser(req, reply);
      if (!userId) return;
      const target = trim(req.params.id);
      const featureRow = await one('SELECT * FROM features WHERE id = $1 OR payload->>\'slug\' = $1 LIMIT 1', [target]);
      if (!featureRow) return reply.code(404).send({ error: 'Feature not found' });
      const feature = await one(
        `INSERT INTO user_features (user_id, feature_id, status, payload)
         VALUES ($1, $2, 'enabled', $3::jsonb)
         ON CONFLICT (user_id, feature_id) DO UPDATE SET status = 'enabled', enabled_at = now(), payload = EXCLUDED.payload
         RETURNING *`,
        [userId, featureRow.id, JSON.stringify({ action, at: new Date().toISOString() })],
      );
      await pgQuery(
        `UPDATE app_users
         SET enabled_features = (
           SELECT ARRAY(
             SELECT DISTINCT value
             FROM unnest(COALESCE(enabled_features, ARRAY[]::TEXT[]) || $2::TEXT[]) AS value
             WHERE value <> ''
           )
         ), updated_at = now()
         WHERE id = $1`,
        [userId, [featureRow.id]],
      ).catch(() => null);
      return { success: true, message: `${featureRow.name} enabled`, feature: mapFeature({ ...featureRow, user_status: feature?.status || 'enabled', enabled_at: feature?.enabled_at, is_enabled: true }) };
    });
  }

  app.post('/features/:id/disable', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const target = trim(req.params.id);
    const featureRow = await one('SELECT * FROM features WHERE id = $1 OR payload->>\'slug\' = $1 LIMIT 1', [target]);
    if (!featureRow) return reply.code(404).send({ error: 'Feature not found' });
    const payload = json(featureRow.payload, {}) || {};
    if (payload.isCore || featureRow.id === 'app-studio') {
      return reply.code(400).send({ error: 'Core features cannot be disabled' });
    }
    await pgQuery(
      `INSERT INTO user_features (user_id, feature_id, status)
       VALUES ($1, $2, 'disabled')
       ON CONFLICT (user_id, feature_id) DO UPDATE SET status = 'disabled'`,
      [userId, featureRow.id],
    );
    await pgQuery(
      `UPDATE app_users
       SET enabled_features = array_remove(COALESCE(enabled_features, ARRAY[]::TEXT[]), $2), updated_at = now()
       WHERE id = $1`,
      [userId, featureRow.id],
    ).catch(() => null);
    return { success: true, message: `${featureRow.name} disabled`, feature: mapFeature({ ...featureRow, user_status: 'disabled', is_enabled: false }) };
  });

  app.get('/transportation-templates', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows('SELECT * FROM transportation_templates WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return { templates: data.map((t) => ({ _id: t.id, id: t.id, name: t.name, mode: t.mode, serviceTier: t.service_tier, origin: json(t.origin, {}), destination: json(t.destination, {}), packageRules: json(t.package_rules, {}), payload: json(t.payload, {}), createdAt: iso(t.created_at), updatedAt: iso(t.updated_at) })) };
  });

  app.get('/transportation-templates/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const t = await one('SELECT * FROM transportation_templates WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!t) return reply.code(404).send({ error: 'Not found' });
    return { _id: t.id, id: t.id, name: t.name, mode: t.mode, serviceTier: t.service_tier, origin: json(t.origin, {}), destination: json(t.destination, {}), packageRules: json(t.package_rules, {}), payload: json(t.payload, {}) };
  });

  app.post('/transportation-templates', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const t = await one(
      `INSERT INTO transportation_templates (user_id, name, mode, service_tier, origin, destination, package_rules, payload)
       VALUES ($1, $2, COALESCE($3, 'ltl'), COALESCE($4, 'standard'), $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb) RETURNING *`,
      [userId, body.name || 'Transportation template', body.mode || 'ltl', body.serviceTier || 'standard', JSON.stringify(body.origin || {}), JSON.stringify(body.destination || {}), JSON.stringify(body.packageRules || {}), JSON.stringify(body.payload || {})],
    );
    return { _id: t?.id, id: t?.id, ...t };
  });

  app.put('/transportation-templates/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const body = req.body || {};
    const t = await one(
      `UPDATE transportation_templates SET name = COALESCE($3, name), mode = COALESCE($4, mode), service_tier = COALESCE($5, service_tier),
       origin = COALESCE($6::jsonb, origin), destination = COALESCE($7::jsonb, destination), package_rules = COALESCE($8::jsonb, package_rules),
       payload = payload || COALESCE($9::jsonb, '{}'::jsonb), updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, userId, body.name ?? null, body.mode ?? null, body.serviceTier ?? null, body.origin === undefined ? null : JSON.stringify(body.origin || {}), body.destination === undefined ? null : JSON.stringify(body.destination || {}), body.packageRules === undefined ? null : JSON.stringify(body.packageRules || {}), body.payload === undefined ? null : JSON.stringify(body.payload || {})],
    );
    if (!t) return reply.code(404).send({ error: 'Not found' });
    return { _id: t.id, id: t.id, ...t };
  });

  app.delete('/transportation-templates/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const deleted = await one('DELETE FROM transportation_templates WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, userId]);
    if (!deleted) return reply.code(404).send({ error: 'Not found' });
    return { success: true };
  });

  app.get('/users', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const data = await rows('SELECT id, email, role, first_name, last_name, phone, avatar_url, llc_name, billing_address, enabled_features, last_login_at, created_at, updated_at FROM app_users ORDER BY created_at DESC');
    return { users: data.map(mapUser) };
  });

  app.post('/users', async (req: any, reply) => {
    const managerId = requireManager(req, reply);
    if (!managerId) return;
    const body = req.body || {};
    const email = normalizedEmail(body.email);
    if (!email || !body.password) return reply.code(400).send({ error: 'Email and password required' });
    const role = isValidRole(body.role) ? body.role : 'ecommerce_client';
    const passwordHash = await bcrypt.hash(String(body.password), 10);
    const user = await one(
      `INSERT INTO app_users (id, email, password_hash, role, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, role, first_name, last_name, phone, avatar_url, llc_name, billing_address, enabled_features, last_login_at, created_at, updated_at`,
      [randomUUID(), email, passwordHash, role, body.firstName || null, body.lastName || null, body.phone || null],
    );
    if (user?.id) {
      await pgQuery(
        `INSERT INTO user_features (user_id, feature_id, status, payload)
         SELECT $1, f.id, 'enabled', '{"source":"admin_create_default"}'::jsonb
         FROM features f
         WHERE f.id = ANY($2::TEXT[])
         ON CONFLICT (user_id, feature_id) DO NOTHING`,
        [user.id, CORE_FEATURE_IDS],
      ).catch(() => null);
      await pgQuery('UPDATE app_users SET enabled_features = $2::TEXT[], updated_at = now() WHERE id = $1', [user.id, CORE_FEATURE_IDS]).catch(() => null);
      await ensureCortexCredentialForUser(user.id).catch((err) => {
        req.log.warn({ err, userId: user.id }, 'cortex credential auto-provision failed during manager create');
      });
    }
    await pgQuery('INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)', [user?.id, 'created_by_manager', JSON.stringify({ managerId })]);
    return mapUser(user || {});
  });

  app.post('/users/invites', async (req: any, reply) => {
    const managerId = requireManager(req, reply);
    if (!managerId) return;
    const role = isValidRole(req.body?.role) ? req.body.role : 'ecommerce_client';
    const token = randomBytes(24).toString('hex');
    await pgQuery('INSERT INTO invite_tokens (token, role, created_by) VALUES ($1, $2, $3)', [token, role, managerId]);
    return { inviteLink: `/signup?token=${encodeURIComponent(token)}`, token, role, expiresInDays: 7 };
  });

  app.get('/users/:userId/activity', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const data = await rows('SELECT * FROM app_user_activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [req.params.userId]);
    return { events: data.map((e) => ({ _id: e.id, id: e.id, action: e.action, metadata: json(e.metadata, {}), createdAt: iso(e.created_at) })), total: data.length };
  });

  app.post('/oms/connect', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const code = trim(req.body?.connectionCode || req.body?.warehouseCode);
    if (!code) return reply.code(400).send({ error: 'connectionCode required' });
    const { profile, missing } = await buildWmsOmsProfile(userId);
    if (!profile || missing.length > 0) {
      return reply.code(400).send({
        error: 'profile_incomplete',
        message: 'Complete your OMS company profile before connecting a warehouse.',
        missingFields: missing,
      });
    }

    try {
      const connected = await callWmsInternal<{
        warehouseCode: string;
        omsIntermediaryId?: string;
        wmsIntermediaryId: string;
        message?: string;
      }>('/internal/oms/connect', {
        connectionCode: code,
        ...profile,
      });

      const warehouseCode = trim(connected.warehouseCode);
      const wmsOmsIntermediaryId = trim(connected.omsIntermediaryId);
      const wmsIntermediaryId = trim(connected.wmsIntermediaryId);
      if (!warehouseCode || !wmsOmsIntermediaryId || !wmsIntermediaryId) {
        return reply.code(502).send({
          error: 'wms_connect_invalid_response',
          message: 'WMS connected the code but did not return a warehouse/intermediary identity.',
        });
      }

      const credentialResponse = await callWmsInternal<{
        clientId: string;
        passkey: string;
        credential?: {
          scopes?: string[];
          expiresAt?: string | null;
          id?: string;
        };
      }>('/internal/oms/integration-credentials', {
        warehouseCode,
        omsIntermediaryId: wmsOmsIntermediaryId,
        wmsIntermediaryId,
        name: `UnieConnect bridge - ${warehouseCode}`,
        scopes: DEFAULT_WMS_BRIDGE_SCOPES,
        metadata: {
          source: 'unieconnect_oms_connect',
          connectionCode: code,
        },
      });

      if (!credentialResponse.clientId || !credentialResponse.passkey) {
        return reply.code(502).send({
          error: 'wms_credential_invalid_response',
          message: 'WMS connected the warehouse but did not return bridge credentials.',
        });
      }

      await registerWmsCredential({
        userId,
        warehouseCode,
        clientId: credentialResponse.clientId,
        passkey: credentialResponse.passkey,
        scopes: credentialResponse.credential?.scopes || DEFAULT_WMS_BRIDGE_SCOPES,
        expiresAt: credentialResponse.credential?.expiresAt ? new Date(credentialResponse.credential.expiresAt) : null,
        metadata: {
          wmsCredentialId: credentialResponse.credential?.id,
          wmsOmsIntermediaryId,
          wmsIntermediaryId,
          source: 'wms_internal_bootstrap',
        },
      });

      const facility =
        (await one('SELECT * FROM facilities WHERE code = $1 AND (user_id = $2 OR user_id IS NULL)', [warehouseCode, userId])) ||
        (await seedDefaultFacility(userId));
      const link = await one(
        `INSERT INTO oms_warehouse_links (user_id, facility_id, warehouse_code, connection_code, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (user_id, warehouse_code) DO UPDATE SET
          facility_id = EXCLUDED.facility_id,
          status = 'connected',
          connection_code = EXCLUDED.connection_code,
          connected_at = now(),
          metadata = EXCLUDED.metadata
         RETURNING *`,
        [
          userId,
          facility?.id || null,
          warehouseCode,
          code,
          JSON.stringify({
            connectedBy: 'wms_internal_connect',
            connectedAt: new Date().toISOString(),
            wmsIntermediaryId,
            wmsOmsIntermediaryId,
            wmsCredentialClientId: credentialResponse.clientId,
          }),
        ],
      );

      await writeLedger(userId, {
        entityType: 'oms_wms_bridge',
        entityId: link?.id || null,
        eventType: 'warehouse_connected',
        sourceSystem: 'wms',
        summary: `Connected OMS account to WMS warehouse ${warehouseCode}.`,
        payload: {
          warehouseCode,
          wmsOmsIntermediaryId,
          wmsIntermediaryId,
          clientId: credentialResponse.clientId,
          scopes: credentialResponse.credential?.scopes || DEFAULT_WMS_BRIDGE_SCOPES,
        },
      });

      return {
        success: true,
        message: connected.message || 'Warehouse connected.',
        warehouseCode,
        wmsOmsIntermediaryId,
        wmsIntermediaryId,
        credential: {
          clientId: credentialResponse.clientId,
          scopes: credentialResponse.credential?.scopes || DEFAULT_WMS_BRIDGE_SCOPES,
          expiresAt: credentialResponse.credential?.expiresAt || null,
        },
      };
    } catch (err: any) {
      const status = Number(err?.status || 502);
      const payload = err?.payload || {};
      const message = String(err?.message || 'WMS connection failed');
      req.log?.warn?.({ err: message, status, payload }, 'OMS-WMS connect failed');
      return reply.code(status >= 400 && status < 600 ? status : 502).send({
        error: payload.error || 'wms_connect_failed',
        message,
        details: payload,
      });
    }
  });

  app.get('/oms/warehouses', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows(
      `SELECT l.*, f.name, f.address
       FROM oms_warehouse_links l
       LEFT JOIN facilities f ON f.id = l.facility_id
       WHERE l.user_id = $1 AND l.status = 'connected'
       ORDER BY l.connected_at DESC`,
      [userId],
    );
    return {
      warehouses: data.map((row) => {
        const address = json(row.address, {});
        return {
          warehouseCode: row.warehouse_code,
          name: row.name || row.warehouse_code,
          state: address.state || address.stateOrProvinceCode || null,
          city: address.city || null,
          address: addressText(address),
          connectedAt: iso(row.connected_at),
        };
      }),
    };
  });

  app.delete('/oms/warehouses/:warehouseCode', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    await pgQuery('UPDATE oms_warehouse_links SET status = $3 WHERE user_id = $1 AND warehouse_code = $2', [userId, req.params.warehouseCode, 'removed']);
    return { success: true };
  });

  app.post('/oms/warehouses/:warehouseCode/test', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const link = await one('SELECT * FROM oms_warehouse_links WHERE user_id = $1 AND warehouse_code = $2 AND status = $3', [userId, req.params.warehouseCode, 'connected']);
    return { ok: Boolean(link), warehouseCode: req.params.warehouseCode, source: 'aurora_postgres' };
  });

  app.get('/oms/accounts', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const data = await rows('SELECT * FROM oms_accounts ORDER BY created_at DESC');
    return { accounts: data.map((a) => ({ id: a.id, companyName: a.company_name, email: a.email, status: a.status, createdAt: iso(a.created_at) })) };
  });

  app.post('/oms/accounts', async (req: any, reply) => {
    const managerId = requireManager(req, reply);
    if (!managerId) return;
    const body = req.body || {};
    if (!trim(body.companyName) || !normalizedEmail(body.email)) return reply.code(400).send({ error: 'companyName and email required' });
    const account = await one(
      'INSERT INTO oms_accounts (user_id, company_name, email, metadata) VALUES ($1, $2, $3, $4::jsonb) RETURNING *',
      [managerId, trim(body.companyName), normalizedEmail(body.email), JSON.stringify({ createdBy: managerId })],
    );
    return { id: account?.id, companyName: account?.company_name, email: account?.email, status: account?.status, createdAt: iso(account?.created_at) };
  });

  app.get('/oms/accounts/:id', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const account = await one('SELECT * FROM oms_accounts WHERE id = $1', [req.params.id]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    return { id: account.id, companyName: account.company_name, email: account.email, status: account.status, createdAt: iso(account.created_at) };
  });

  app.post('/oms/accounts/:id/api-keys', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const account = await one('SELECT * FROM oms_accounts WHERE id = $1', [req.params.id]);
    if (!account) return reply.code(404).send({ error: 'Not found' });
    const raw = `uc_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const prefix = raw.slice(0, 10);
    await pgQuery('INSERT INTO api_keys (user_id, name, key_hash, prefix, scopes) VALUES ($1, $2, $3, $4, $5)', [account.user_id || req.user.userId, req.body?.name || 'OMS API Key', keyHash, prefix, ['oms:connect']]);
    return { apiKey: raw, warning: 'Save this key now. It is not shown again.' };
  });

  app.post('/oms/accounts/:id/link-warehouse', async (req: any, reply) => {
    if (!requireManager(req, reply)) return;
    const account = await one('SELECT * FROM oms_accounts WHERE id = $1', [req.params.id]);
    const facility = await one('SELECT * FROM facilities WHERE id = $1', [req.body?.facilityId]);
    if (!account || !facility) return reply.code(404).send({ error: 'Account or facility not found' });
    await pgQuery(
      `INSERT INTO oms_warehouse_links (user_id, oms_account_id, facility_id, warehouse_code, status, metadata)
       VALUES ($1, $2, $3, $4, 'connected', $5::jsonb)
       ON CONFLICT (user_id, warehouse_code) DO UPDATE SET oms_account_id = EXCLUDED.oms_account_id, facility_id = EXCLUDED.facility_id, status = 'connected', connected_at = now()`,
      [account.user_id || req.user.userId, account.id, facility.id, facility.code, JSON.stringify({ linkedBy: req.user.userId })],
    );
    return { success: true, message: 'Linked.' };
  });

  app.get('/oms/facilities', async (req: any, reply) => {
    const userId = requireManager(req, reply);
    if (!userId) return;
    await seedDefaultFacility(userId);
    const data = await rows('SELECT * FROM facilities ORDER BY code ASC');
    return { facilities: data.map(mapFacility) };
  });

  app.post('/shopify/inventory', async (_req: any, reply) => reply.code(202).send({ accepted: true, source: 'aurora_postgres' }));

  app.get('/amazon/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { limit, offset } = pagination(req.query);
    const filter = trim(req.query?.filter).toLowerCase();
    const q = trim(req.query?.q).toLowerCase();
    const values: unknown[] = [userId];
    const clauses = ['p.user_id = $1'];
    if (q) {
      values.push(`%${q}%`);
      clauses.push(`(LOWER(p.seller_sku) LIKE $${values.length} OR LOWER(COALESCE(p.asin, '')) LIKE $${values.length} OR LOWER(COALESCE(p.title, i.title, '')) LIKE $${values.length})`);
    }
    if (filter === 'listed') clauses.push("p.listing_status IN ('listed', 'active', 'publish_pending')");
    if (filter === 'needs_listing') clauses.push("p.listing_status = 'needs_listing'");
    if (filter === 'sync_error') clauses.push("p.sync_status = 'sync_error'");
    if (filter === 'fba') clauses.push("p.fulfillment_channel IN ('AMAZON', 'FBA')");
    values.push(limit, offset);
    const data = await rows(
      `SELECT p.*, i.sku AS catalog_sku, i.title AS catalog_title, i.image AS catalog_image, i.dimensions, i.weight, i.metadata AS item_metadata,
              c.display_name AS account_name, c.channel AS account_channel
       FROM amazon_item_profiles p
       LEFT JOIN catalog_items i ON i.id = p.item_id AND i.user_id = p.user_id
       LEFT JOIN marketplace_connections c ON c.id = p.channel_connection_id AND c.user_id = p.user_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY COALESCE(p.last_amazon_sync_at, p.updated_at, p.created_at) DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      items: data.map((row) => ({
        ...mapAmazonProfile(row),
        catalogSku: row.catalog_sku,
        catalogTitle: row.catalog_title,
        catalogImage: row.catalog_image,
        accountName: row.account_name,
        accountChannel: row.account_channel,
      })),
    };
  });

  app.post('/amazon/items/sync', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const connection = await one(
      "SELECT * FROM marketplace_connections WHERE user_id = $1 AND channel = 'amazon' AND status <> 'archived' ORDER BY updated_at DESC LIMIT 1",
      [userId],
    );
    const amazonMappings = await rows(
      `SELECT *
       FROM item_channel_mappings
       WHERE user_id = $1 AND channel = 'amazon'
       ORDER BY updated_at DESC`,
      [userId],
    );
    const mappingByItem = new Map<string, AnyRow>();
    for (const mapping of amazonMappings) {
      const key = String(mapping.item_id || '');
      if (key && !mappingByItem.has(key)) mappingByItem.set(key, mapping);
    }
    const items = await rows(
      `SELECT * FROM catalog_items
       WHERE user_id = $1 AND archived = false
       ORDER BY updated_at DESC LIMIT 500`,
      [userId],
    );
    const synced: AnyRow[] = [];
    for (const item of items) {
      const metadata = json(item.metadata, {});
      const mapping = mappingByItem.get(String(item.id));
      const mappingPayload = json(mapping?.payload, {});
      const fbaInventory = json(mappingPayload.fbaInventory || mappingPayload.inventory || {}, {});
      const fulfillmentChannel = trim(
        mappingPayload.fulfillmentChannel ||
        mappingPayload.fulfillment_channel ||
        metadata.amazonFulfillmentChannel ||
        metadata.fulfillmentChannel ||
        (item.asin || mappingPayload.asin ? 'AMAZON' : 'UNKNOWN'),
      ).toUpperCase();
      const profile = {
        sellerSku: mappingPayload.sellerSku || mappingPayload.seller_sku || mapping?.sku || metadata.amazonSellerSku || item.sku,
        asin: mappingPayload.asin || metadata.amazonAsin || item.asin || (/^B0[A-Z0-9]{8}$/i.test(String(mapping?.channel_item_id || '')) ? mapping?.channel_item_id : null),
        fulfillmentChannel,
      };
      const blockers = amazonBlockersForItem(item, profile).filter((blocker) => {
        if (fulfillmentChannel !== 'AMAZON' && fulfillmentChannel !== 'FBA') return blocker !== 'FBA requires an Amazon listing before shipment planning';
        return true;
      });
      const listingStatus = mappingPayload.listingStatus || mappingPayload.listing_status || (mapping?.status === 'active' ? 'listed' : profile.asin ? 'listed' : 'needs_listing');
      const id = randomUUID();
      const row = await one(
        `INSERT INTO amazon_item_profiles (
          id, user_id, item_id, channel_connection_id, marketplace_id, seller_sku, asin, title,
          listing_status, fulfillment_channel, available_fba_qty, inbound_working_qty,
          inbound_shipped_qty, inbound_receiving_qty, reserved_qty, sync_status, last_amazon_sync_at, blockers, raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'profiled_from_catalog', now(), $16::text[], $17::jsonb)
        ON CONFLICT (user_id, marketplace_id, seller_sku)
        DO UPDATE SET item_id = EXCLUDED.item_id,
          channel_connection_id = COALESCE(EXCLUDED.channel_connection_id, amazon_item_profiles.channel_connection_id),
          asin = COALESCE(EXCLUDED.asin, amazon_item_profiles.asin),
          title = EXCLUDED.title,
          listing_status = EXCLUDED.listing_status,
          fulfillment_channel = EXCLUDED.fulfillment_channel,
          blockers = EXCLUDED.blockers,
          raw = amazon_item_profiles.raw || EXCLUDED.raw,
          sync_status = EXCLUDED.sync_status,
          last_amazon_sync_at = now(),
          updated_at = now()
        RETURNING *`,
        [
          id,
          userId,
          item.id,
          mapping?.channel_connection_id || connection?.id || null,
          req.body?.marketplaceId || mappingPayload.marketplaceId || mappingPayload.marketplace_id || connection?.marketplace_id || 'ATVPDKIKX0DER',
          profile.sellerSku,
          profile.asin,
          item.title,
          listingStatus,
          fulfillmentChannel,
          number(fbaInventory.available ?? metadata.availableFbaQty),
          number(fbaInventory.inboundWorking ?? metadata.inboundWorkingQty),
          number(fbaInventory.inboundShipped ?? metadata.inboundShippedQty),
          number(fbaInventory.inboundReceiving ?? metadata.inboundReceivingQty),
          number(fbaInventory.reserved ?? metadata.reservedQty),
          blockers,
          JSON.stringify({
            source: mapping ? 'amazon_channel_mapping_sync' : 'catalog_profile_sync',
            mappingId: mapping?.id || null,
            connectionStatus: connection?.status || 'not_connected',
          }),
        ],
      );
      if (row) synced.push(row);
    }
    return {
      synced: synced.length,
      providerStatus: connection ? 'profiled_from_catalog_until_sp_api_sync' : 'profiled_without_amazon_connection',
      items: synced.slice(0, 100).map(mapAmazonProfile),
    };
  });

  app.post('/amazon/items/:itemId/refresh', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT * FROM catalog_items WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, req.params.itemId]);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    const metadata = json(item.metadata, {});
    const fulfillmentChannel = trim(req.body?.fulfillmentChannel || metadata.amazonFulfillmentChannel || metadata.fulfillmentChannel || (item.asin ? 'AMAZON' : 'UNKNOWN')).toUpperCase();
    const profile = {
      sellerSku: trim(req.body?.sellerSku || metadata.amazonSellerSku || item.sku),
      asin: trim(req.body?.asin || metadata.amazonAsin || item.asin) || null,
      fulfillmentChannel,
    };
    const blockers = amazonBlockersForItem(item, profile);
    const row = await one(
      `INSERT INTO amazon_item_profiles (
        id, user_id, item_id, marketplace_id, seller_sku, asin, title, listing_status, fulfillment_channel,
        sync_status, last_amazon_sync_at, blockers, raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual_refresh', now(), $10::text[], $11::jsonb)
      ON CONFLICT (user_id, marketplace_id, seller_sku)
      DO UPDATE SET item_id = EXCLUDED.item_id,
        asin = EXCLUDED.asin,
        title = EXCLUDED.title,
        listing_status = EXCLUDED.listing_status,
        fulfillment_channel = EXCLUDED.fulfillment_channel,
        blockers = EXCLUDED.blockers,
        raw = amazon_item_profiles.raw || EXCLUDED.raw,
        sync_status = 'manual_refresh',
        last_amazon_sync_at = now(),
        updated_at = now()
      RETURNING *`,
      [
        randomUUID(),
        userId,
        item.id,
        req.body?.marketplaceId || 'ATVPDKIKX0DER',
        profile.sellerSku,
        profile.asin,
        item.title,
        profile.asin ? 'listed' : 'needs_listing',
        fulfillmentChannel,
        blockers,
        JSON.stringify({ source: 'manual_refresh' }),
      ],
    );
    if (row) {
      await pgQuery(
        `INSERT INTO item_channel_mappings (user_id, item_id, channel_connection_id, channel, channel_item_id, channel_variant_id, sku, status, payload)
         VALUES ($1, $2, NULL, 'amazon', $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (user_id, channel, channel_item_id, (COALESCE(channel_variant_id, '')))
         DO UPDATE SET item_id = EXCLUDED.item_id, sku = EXCLUDED.sku, status = EXCLUDED.status, payload = item_channel_mappings.payload || EXCLUDED.payload, updated_at = now()`,
        [
          userId,
          item.id,
          profile.asin || profile.sellerSku,
          profile.sellerSku,
          profile.sellerSku,
          profile.asin ? 'active' : 'needs_listing',
          JSON.stringify({
            source: 'amazon_item_refresh',
            asin: profile.asin,
            sellerSku: profile.sellerSku,
            fulfillmentChannel,
          }),
        ],
      );
    }
    return { item: row ? mapAmazonProfile(row) : null };
  });

  app.post('/amazon/listings/drafts', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const item = await one('SELECT * FROM catalog_items WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, req.body?.itemId]);
    if (!item) return reply.code(404).send({ error: 'Item not found' });
    const payload = listingDraftPayload(item, req.body || {});
    const validation = validateListingPayload(payload);
    const status = validation.errors.length ? 'needs_input' : 'ready_to_publish';
    const row = await one(
      `INSERT INTO amazon_listing_drafts (
        id, user_id, item_id, channel_connection_id, marketplace_id, seller_sku, asin, product_type,
        fulfillment_channel, status, required_fields, payload, validation_errors, warnings
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb)
      RETURNING *`,
      [
        randomUUID(),
        userId,
        item.id,
        req.body?.channelConnectionId || null,
        payload.marketplaceId,
        payload.sellerSku,
        payload.asin,
        payload.productType,
        payload.fulfillmentChannel,
        status,
        JSON.stringify(validation.required),
        JSON.stringify(payload),
        JSON.stringify(validation.errors),
        JSON.stringify(validation.warnings),
      ],
    );
    return { draft: row, validation };
  });

  app.post('/amazon/listings/drafts/:draftId/validate', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const draft = await one('SELECT * FROM amazon_listing_drafts WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, req.params.draftId]);
    if (!draft) return reply.code(404).send({ error: 'Listing draft not found' });
    const payload = { ...json(draft.payload, {}), ...(req.body?.payload || {}) };
    const validation = validateListingPayload(payload);
    const status = validation.errors.length ? 'needs_input' : 'ready_to_publish';
    const row = await one(
      `UPDATE amazon_listing_drafts
       SET payload = $3::jsonb, validation_errors = $4::jsonb, warnings = $5::jsonb, status = $6, updated_at = now()
       WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, req.params.draftId, JSON.stringify(payload), JSON.stringify(validation.errors), JSON.stringify(validation.warnings), status],
    );
    return { draft: row, validation };
  });

  app.post('/amazon/listings/drafts/:draftId/publish', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const draft = await one('SELECT * FROM amazon_listing_drafts WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, req.params.draftId]);
    if (!draft) return reply.code(404).send({ error: 'Listing draft not found' });
    const payload = { ...json(draft.payload, {}), ...(req.body?.payload || {}) };
    const validation = validateListingPayload(payload);
    if (validation.errors.length) {
      await pgQuery(
        `UPDATE amazon_listing_drafts
         SET payload = $3::jsonb, validation_errors = $4::jsonb, warnings = $5::jsonb, status = 'needs_input', updated_at = now()
         WHERE user_id = $1 AND id = $2`,
        [userId, req.params.draftId, JSON.stringify(payload), JSON.stringify(validation.errors), JSON.stringify(validation.warnings)],
      );
      return reply.code(400).send({ error: 'Listing draft is missing Amazon-required fields', validation });
    }
    const submissionResult = {
      provider: 'amazon_listings_items',
      status: 'pending_provider_integration',
      message: 'Draft is validated and ready for Amazon SP-API Listings Items submission.',
      requestedAt: new Date().toISOString(),
    };
    const row = await one(
      `UPDATE amazon_listing_drafts
       SET payload = $3::jsonb, validation_errors = '[]'::jsonb, warnings = $4::jsonb,
           submission_result = $5::jsonb, status = 'pending_provider_integration', updated_at = now()
       WHERE user_id = $1 AND id = $2 RETURNING *`,
      [userId, req.params.draftId, JSON.stringify(payload), JSON.stringify(validation.warnings), JSON.stringify(submissionResult)],
    );
    await pgQuery(
      `INSERT INTO amazon_item_profiles (
        id, user_id, item_id, channel_connection_id, marketplace_id, seller_sku, asin, title,
        listing_status, fulfillment_channel, sync_status, blockers, raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'publish_pending', $9, 'listing_draft_validated', ARRAY[]::text[], $10::jsonb)
      ON CONFLICT (user_id, marketplace_id, seller_sku)
      DO UPDATE SET item_id = EXCLUDED.item_id,
        asin = COALESCE(EXCLUDED.asin, amazon_item_profiles.asin),
        title = EXCLUDED.title,
        listing_status = 'publish_pending',
        fulfillment_channel = EXCLUDED.fulfillment_channel,
        blockers = ARRAY[]::text[],
        raw = amazon_item_profiles.raw || EXCLUDED.raw,
        sync_status = 'listing_draft_validated',
        updated_at = now()`,
      [
        randomUUID(),
        userId,
        draft.item_id,
        draft.channel_connection_id || null,
        payload.marketplaceId,
        payload.sellerSku,
        payload.asin || null,
        payload.title,
        payload.fulfillmentChannel,
        JSON.stringify({ submissionResult }),
      ],
    );
    await pgQuery(
      `INSERT INTO item_channel_mappings (user_id, item_id, channel_connection_id, channel, channel_item_id, channel_variant_id, sku, status, payload)
       VALUES ($1, $2, $3, 'amazon', $4, $5, $6, 'publish_pending', $7::jsonb)
       ON CONFLICT (user_id, channel, channel_item_id, (COALESCE(channel_variant_id, '')))
       DO UPDATE SET item_id = EXCLUDED.item_id,
         channel_connection_id = COALESCE(EXCLUDED.channel_connection_id, item_channel_mappings.channel_connection_id),
         sku = EXCLUDED.sku,
         status = EXCLUDED.status,
         payload = item_channel_mappings.payload || EXCLUDED.payload,
         updated_at = now()`,
      [
        userId,
        draft.item_id,
        draft.channel_connection_id || null,
        payload.asin || payload.sellerSku,
        payload.sellerSku,
        payload.sellerSku,
        JSON.stringify({
          source: 'amazon_listing_draft',
          draftId: draft.id,
          productType: payload.productType,
          asin: payload.asin || null,
          sellerSku: payload.sellerSku,
          fulfillmentChannel: payload.fulfillmentChannel,
          submissionResult,
        }),
      ],
    );
    return reply.code(202).send({ draft: row, submissionResult });
  });

  app.post('/amazon/fba/workflows', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const itemIds: string[] = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(String) : [];
    if (!itemIds.length) return reply.code(400).send({ error: 'At least one item is required for an Amazon FBA workflow' });
    const profiles = await rows(
      `SELECT p.*, i.sku AS catalog_sku, i.title AS catalog_title, i.supplier_id
       FROM amazon_item_profiles p
       LEFT JOIN catalog_items i ON i.id = p.item_id AND i.user_id = p.user_id
       WHERE p.user_id = $1 AND p.item_id = ANY($2::text[])`,
      [userId, itemIds],
    );
    const byItem = new Map(profiles.map((profile) => [String(profile.item_id), profile]));
    const invalid = itemIds
      .map((itemId) => {
        const profile = byItem.get(itemId);
        if (!profile) return { itemId, blockers: ['Item is not mapped to an Amazon profile'] };
        const mapped = mapAmazonProfile(profile);
        return mapped.fbaEligible ? null : { itemId, sellerSku: mapped.sellerSku, blockers: mapped.blockers.length ? mapped.blockers : ['Item is not eligible for FBA shipment planning'] };
      })
      .filter(Boolean);
    if (invalid.length) {
      return reply.code(400).send({ error: 'Some items are not Amazon FBA eligible', invalid });
    }
    const accountIds = Array.from(new Set(profiles.map((profile) => String(profile.channel_connection_id || '')).filter(Boolean)));
    const requestedAccountId = trim(req.body?.channelConnectionId);
    if (accountIds.length > 1 && (!requestedAccountId || !accountIds.includes(requestedAccountId))) {
      return reply.code(400).send({
        error: 'Selected FBA items belong to multiple Amazon accounts',
        invalid: accountIds.map((accountId) => ({
          channelConnectionId: accountId,
          blockers: ['Choose one Amazon account before creating an FBA inbound workflow'],
        })),
      });
    }
    const channelConnectionId = requestedAccountId || accountIds[0] || null;
    const selectedItems = profiles.map((profile) => ({
      itemId: profile.item_id,
      sku: profile.catalog_sku || profile.seller_sku,
      title: profile.catalog_title || profile.title,
      sellerSku: profile.seller_sku,
      asin: profile.asin,
      channelConnectionId: profile.channel_connection_id || null,
      marketplaceId: profile.marketplace_id,
      quantity: number(req.body?.quantities?.[profile.item_id], 0),
    }));
    const quantityInvalid = selectedItems
      .filter((item) => item.quantity <= 0)
      .map((item) => ({ itemId: item.itemId, sellerSku: item.sellerSku, blockers: ['FBA quantity must be greater than zero'] }));
    if (quantityInvalid.length) {
      return reply.code(400).send({ error: 'Some items need valid FBA quantities', invalid: quantityInvalid });
    }
    const packagePlan = {
      channel: 'amazon',
      workflowType: 'fba_inbound',
      channelConnectionId,
      marketplaceId: req.body?.marketplaceId || profiles[0]?.marketplace_id || 'ATVPDKIKX0DER',
      prepOwner: req.body?.prepOwner || 'SELLER',
      labelOwner: req.body?.labelOwner || 'SELLER',
      packingMode: req.body?.packingMode || 'case_pack',
      cartonContentSource: req.body?.cartonContentSource || 'provided_by_seller',
      sourceDraftId: req.body?.sourceDraftId || null,
      shipmentPlanId: req.body?.shipmentPlanId || null,
      asnId: req.body?.asnId || null,
    };
    if (req.body?.sourceDraftId) {
      const updated = await one(
        `UPDATE oms_shipment_wizard_drafts
         SET selected_items = $3::jsonb,
             package_plan = package_plan || $4::jsonb,
             cortex_routing = cortex_routing || $5::jsonb,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [
          req.body.sourceDraftId,
          userId,
          JSON.stringify(selectedItems),
          JSON.stringify(packagePlan),
          JSON.stringify({ amazonFba: true, mode: 'amazon_fba_guarded', requiresProviderSubmission: true }),
        ],
      );
      if (!updated) return reply.code(404).send({ error: 'Source shipment wizard draft not found' });
      await writeLedger(userId, {
        entityType: 'shipment_wizard',
        entityId: updated.id,
        eventType: 'amazon_fba_branch_added',
        summary: 'Amazon FBA shipment branch attached to the OMS shipment wizard draft.',
        payload: { selectedItems, packagePlan },
      });
      return { workflowId: updated.id, workflow: updated, selectedItems };
    }
    const draft = await one(
      `INSERT INTO oms_shipment_wizard_drafts (user_id, supplier_id, selected_items, package_plan, cortex_routing)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb) RETURNING *`,
      [
        userId,
        req.body?.supplierId || profiles[0]?.supplier_id || null,
        JSON.stringify(selectedItems),
        JSON.stringify(packagePlan),
        JSON.stringify({ mode: 'amazon_fba_guarded', requiresProviderSubmission: true }),
      ],
    );
    return { workflowId: draft?.id, workflow: draft, selectedItems };
  });

  app.get('/amazon/send-to-amazon/workflows', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const data = await rows("SELECT * FROM oms_shipment_wizard_drafts WHERE user_id = $1 AND package_plan->>'channel' = 'amazon' ORDER BY created_at DESC", [userId]);
    return { workflows: data };
  });

  app.post('/amazon/send-to-amazon/workflows', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const draft = await one(
      `INSERT INTO oms_shipment_wizard_drafts (user_id, supplier_id, selected_items, package_plan, cortex_routing)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb) RETURNING *`,
      [userId, req.body?.supplierId || null, JSON.stringify(req.body?.items || []), JSON.stringify({ ...(req.body || {}), channel: 'amazon' }), JSON.stringify({ mode: 'auto_routed' })],
    );
    return { workflowId: draft?.id, workflow: draft };
  });

  const amazonPending = async (_req: any, reply: any) => reply.code(202).send({ status: 'pending_provider_integration', source: 'aurora_postgres' });
  app.get('/amazon/send-to-amazon/workflows/:workflowId', amazonPending);
  app.post('/amazon/send-to-amazon/workflows/:workflowId/placement-preview', amazonPending);
  app.post('/amazon/send-to-amazon/workflows/:workflowId/confirm-placement', amazonPending);
  app.post('/amazon/send-to-amazon/workflows/:workflowId/shipments/:shipmentId/labels', amazonPending);
  app.post('/amazon/inventory', amazonPending);
  app.post('/amazon/fulfillment', amazonPending);
  app.post('/amazon/inbound/plan', amazonPending);
  app.post('/amazon/inbound/shipment', amazonPending);
  app.get('/amazon/inbound/:shipmentId/labels', amazonPending);
  app.post('/amazon/inbound/workflows/draft', amazonPending);
  app.post('/amazon/inbound/workflows/sku-labels', amazonPending);
  app.get('/amazon/inbound/history', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const plans = await rows('SELECT * FROM shipment_plans WHERE user_id = $1 AND marketplace_type = $2 ORDER BY created_at DESC LIMIT 100', [userId, 'FBA']);
    return { history: plans.map(mapShipmentPlan) };
  });
  app.get('/amazon/inbound/history/:workflowOrShipmentId', amazonPending);
  app.get('/amazon/catalog/items', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const items = await rows('SELECT * FROM catalog_items WHERE user_id = $1 AND asin IS NOT NULL ORDER BY updated_at DESC LIMIT 200', [userId]);
    return { items: items.map((row) => mapItem(row)) };
  });
  app.get('/amazon/shipping/labels/:shipmentId', amazonPending);
  app.post('/amazon/shipping/shipments', amazonPending);
}
