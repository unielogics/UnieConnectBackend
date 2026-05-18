export type EntityPrefix =
  | 'AC'
  | 'AS'
  | 'CU'
  | 'IN'
  | 'IV'
  | 'OR'
  | 'SH'
  | 'SK'
  | 'SU'
  | 'TI'
  | 'WH';

const PREFIX_BY_ENTITY: Record<string, EntityPrefix> = {
  account: 'AC',
  asn: 'AS',
  customer: 'CU',
  intermediary: 'IN',
  invoice: 'IV',
  item: 'SK',
  order: 'OR',
  shipment: 'SH',
  shipment_plan: 'SH',
  sku: 'SK',
  supplier: 'SU',
  support_ticket: 'TI',
  ticket: 'TI',
  warehouse: 'WH',
};

export function prefixForEntity(entityType?: string | null, fallback: EntityPrefix = 'AC'): EntityPrefix {
  const key = String(entityType || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return PREFIX_BY_ENTITY[key] || fallback;
}

export function publicEntityId(prefix: EntityPrefix | string, value: unknown): string {
  const normalizedPrefix = String(prefix || 'AC').slice(0, 2).toUpperCase().padEnd(2, 'X');
  const source = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const numeric = String(hash % 100000000).padStart(8, '0');
  return `${normalizedPrefix}${numeric}`;
}
