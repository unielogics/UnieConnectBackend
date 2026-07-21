/**
 * Shared warehouse-routing resolver — the ONE place that decides which connected warehouse a
 * shipment/ASN should route to, so shipment-plan confirm, order push, pricing preview, and
 * multi-warehouse accept all apply the same rule instead of the two divergent ones that existed
 * before this file (connectedShipmentFacility had no geo/online logic at all; the pricing-context
 * haversine override in sql-mode.routes.ts never checked the supplier's onlineSupplier flag).
 *
 * THE RULE:
 *   - Online supplier (no physical pickup address), or no supplier / no resolvable address at
 *     all: skip geography entirely, ALWAYS return the account's owner/primary connected
 *     warehouse. An online supplier has no ship-FROM location for distance to mean anything, and
 *     the owner warehouse is who actually holds the OMS account relationship.
 *   - Non-online supplier with a real geocoded address: the closest connected + network-eligible
 *     warehouse to the supplier wins automatically (existing haversine behavior, preserved) — a
 *     genuinely closer/cheaper peer CAN win over the owner here, by design.
 *   - An explicit caller-requested facility/warehouse still wins first, when it resolves to an
 *     actual connected link for this account (never trust an arbitrary id — it must appear in
 *     the connected-links set).
 */
import { pgQuery } from '../db/postgres';

type AnyRow = Record<string, any>;

async function one<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T | null> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows[0] || null;
}

async function rows<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

const trim = (value: unknown) => (value == null ? '' : String(value).trim());
const json = (value: unknown, fallback: any) => (value == null ? fallback : value);
const numberOrNaN = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Pull a {lat,lon} from any address-shaped JSONB — top-level or nested, tolerant of the
 *  lat/lon/lng AND lat/long spelling variants seen across suppliers/facilities/ship-from rows. */
export function pointFromAnyAddress(address: AnyRow | null | undefined): GeoPoint | null {
  const a = json(address, {}) as AnyRow;
  const lat = numberOrNaN(a.latitude ?? a.lat);
  const lon = numberOrNaN(a.longitude ?? a.lon ?? a.lng ?? a.long);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export function haversineMiles(a?: GeoPoint | null, b?: GeoPoint | null): number | null {
  if (!a || !b) return null;
  const { lat: lat1, lon: lon1 } = a;
  const { lat: lat2, lon: lon2 } = b;
  if (![lat1, lon1, lat2, lon2].every((n) => Number.isFinite(n))) return null;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.7613; // earth radius, miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

interface ConnectedLink {
  warehouse_code: string;
  metadata: any;
  connected_at: string | null;
  facility_id: string | null;
  facility_code: string | null;
  facility_name: string | null;
  facility_address: any;
  facility_metadata: any;
  latitude: number | null;
  longitude: number | null;
}

/** Load every connected oms_warehouse_link for this account, owner/non-peer links sorted first
 *  by default (peer_partner_network links sort last unless a distance override applies). */
async function loadConnectedLinks(userId: string): Promise<ConnectedLink[]> {
  return rows<ConnectedLink>(
    `SELECT
       l.warehouse_code,
       l.metadata,
       l.connected_at,
       f.id AS facility_id,
       f.code AS facility_code,
       f.name AS facility_name,
       f.address AS facility_address,
       f.metadata AS facility_metadata,
       f.latitude,
       f.longitude
     FROM oms_warehouse_links l
     LEFT JOIN facilities f ON f.id = l.facility_id
     WHERE l.user_id = $1 AND l.status = 'connected'
     ORDER BY (COALESCE(l.metadata->>'source', '') = 'peer_partner_network') ASC, l.connected_at DESC NULLS LAST`,
    [userId],
  ).catch(() => []);
}

function isOwnerLink(link: ConnectedLink): boolean {
  return trim(json(link.metadata, {})?.source) !== 'peer_partner_network';
}

function linkGeo(link: ConnectedLink): GeoPoint | null {
  if (Number.isFinite(link.latitude as any) && Number.isFinite(link.longitude as any)) {
    return { lat: Number(link.latitude), lon: Number(link.longitude) };
  }
  return pointFromAnyAddress(link.facility_address);
}

export interface ResolvedWarehouse {
  warehouseCode: string;
  facilityId: string | null;
  facilityCode: string | null;
  facilityName: string | null;
  facilityAddress: any;
  facilityMetadata: any;
  /** Why this link was chosen — surfaced for logging/debugging routing decisions. */
  reason: 'requested_override' | 'online_supplier_owner' | 'no_supplier_owner' | 'no_address_owner' | 'closest_to_supplier' | 'owner_fallback';
}

export interface ResolveShipmentWarehouseInput {
  supplierId?: string | null | undefined;
  /** Precomputed supplier location, when the caller already resolved it (avoids a second lookup). */
  supplierLocation?: GeoPoint | null | undefined;
  /** Explicit caller override — must resolve to an actual connected link, else ignored. */
  requestedFacilityId?: string | null | undefined;
  requestedWarehouseCode?: string | null | undefined;
}

/**
 * THE single warehouse-routing decision. Returns null when the account has no connected
 * warehouse at all (callers should fall back to their own "connect a warehouse" prompt).
 */
export async function resolveShipmentWarehouse(
  userId: string,
  input: ResolveShipmentWarehouseInput = {},
): Promise<ResolvedWarehouse | null> {
  const links = await loadConnectedLinks(userId);
  if (links.length === 0) return null;

  const toResolved = (link: ConnectedLink, reason: ResolvedWarehouse['reason']): ResolvedWarehouse => ({
    warehouseCode: trim(link.warehouse_code || link.facility_code),
    facilityId: link.facility_id || null,
    facilityCode: link.facility_code || null,
    facilityName: link.facility_name || null,
    facilityAddress: json(link.facility_address, {}),
    facilityMetadata: json(link.facility_metadata, {}),
    reason,
  });

  // 1. Explicit override — must be an actual connected link for this account.
  const requestedFacilityId = trim(input.requestedFacilityId);
  const requestedWarehouseCode = trim(input.requestedWarehouseCode).toUpperCase();
  if (requestedFacilityId || requestedWarehouseCode) {
    const match = links.find(
      (l) =>
        (requestedFacilityId && trim(l.facility_id) === requestedFacilityId) ||
        (requestedWarehouseCode && trim(l.warehouse_code).toUpperCase() === requestedWarehouseCode),
    );
    if (match) return toResolved(match, 'requested_override');
  }

  const ownerLinks = links.filter(isOwnerLink);
  // links.length > 0 is guaranteed by the early return above — reduce() over a non-empty array
  // always has a defined result, unlike bare indexing (which TS can't prove is in-bounds).
  // Falls back to the most-recent link overall when every connected link is peer-sourced.
  const ownerLink: ConnectedLink = (ownerLinks.length > 0 ? ownerLinks : links).reduce((first) => first);

  // 2. Resolve the supplier + whether it's online.
  let supplier: AnyRow | null = null;
  if (input.supplierId) {
    supplier = await one('SELECT id, address, metadata FROM suppliers WHERE id = $1 AND user_id = $2', [input.supplierId, userId]);
  }
  const onlineSupplier = Boolean(json(supplier?.metadata, {})?.onlineSupplier);

  if (!supplier) {
    // No supplier context at all (e.g. an internal/legacy call site) — can't do geo, use the owner.
    return toResolved(ownerLink, 'no_supplier_owner');
  }
  if (onlineSupplier) {
    // Online supplier: geography is meaningless (no physical pickup point) — ALWAYS the owner.
    return toResolved(ownerLink, 'online_supplier_owner');
  }

  const supplierLocation = input.supplierLocation ?? pointFromAnyAddress(supplier.address);
  if (!supplierLocation) {
    // Non-online supplier but no resolvable address (bad data) — degrade to the owner rather
    // than guessing; never let missing geo silently promote an arbitrary link.
    return toResolved(ownerLink, 'no_address_owner');
  }

  // 3. Non-online + real address: closest connected + network-eligible warehouse wins, even a peer.
  const eligible = links.filter((l) => json(l.facility_metadata, {})?.networkEligible !== false);
  const candidates = eligible.length > 0 ? eligible : links;
  const distFor = (l: ConnectedLink): number => {
    const d = haversineMiles(supplierLocation, linkGeo(l));
    return d == null ? Number.POSITIVE_INFINITY : d; // links with no geo sort last
  };
  const closest = candidates.slice().sort((a, b) => distFor(a) - distFor(b))[0];
  if (closest && Number.isFinite(distFor(closest))) {
    return toResolved(closest, 'closest_to_supplier');
  }
  // No candidate had usable geo to compare against — fall back to the owner.
  return toResolved(ownerLink, 'owner_fallback');
}

/** Resolve a supplier's geocoded location for a given catalog item/SKU (used by callers that
 *  only have an item id, not a supplierId, at the point of routing). Mirrors the lookup
 *  previously duplicated inline in sql-mode.routes.ts. */
export async function supplierLocationForItem(userId: string, itemIdOrSku?: string): Promise<GeoPoint | null> {
  const key = trim(itemIdOrSku);
  if (!key) return null;
  try {
    const row = await one<{ address: any }>(
      `SELECT s.address
         FROM catalog_items c
         JOIN suppliers s ON s.id = c.supplier_id AND s.user_id = c.user_id
        WHERE c.user_id = $1 AND (c.id = $2 OR c.sku = $2)
        LIMIT 1`,
      [userId, key],
    );
    return pointFromAnyAddress(row?.address);
  } catch {
    return null;
  }
}
