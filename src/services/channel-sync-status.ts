import { pgQuery } from '../db/postgres';

export type SyncEntityType = 'products' | 'orders' | 'inventory' | 'customers';
export type SyncStatus = 'idle' | 'pending' | 'syncing' | 'synced' | 'error';

const ENTITY_TYPES: SyncEntityType[] = ['products', 'orders', 'inventory', 'customers'];

export async function setSyncStatus(
  channelAccountId: string,
  entityType: SyncEntityType,
  status: SyncStatus,
  opts: { count?: number; error?: string; metadata?: Record<string, unknown> } = {},
) {
  await pgQuery(
    `INSERT INTO channel_sync_status
       (channel_account_id, entity_type, status, count, error, metadata, last_synced_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
       CASE WHEN $3 IN ('synced', 'error') THEN now() ELSE NULL END,
       now())
     ON CONFLICT (channel_account_id, entity_type)
     DO UPDATE SET
       status = EXCLUDED.status,
       count = COALESCE(EXCLUDED.count, channel_sync_status.count),
       error = EXCLUDED.error,
       metadata = channel_sync_status.metadata || EXCLUDED.metadata,
       last_synced_at = CASE
         WHEN EXCLUDED.status IN ('synced', 'error') THEN now()
         ELSE channel_sync_status.last_synced_at
       END,
       updated_at = now()`,
    [
      channelAccountId,
      entityType,
      status,
      opts.count ?? null,
      opts.error ?? null,
      JSON.stringify(opts.metadata || {}),
    ],
  );
}

export async function getSyncStatus(channelAccountId: string) {
  const res = await pgQuery(
    `SELECT entity_type, status, count, error, metadata, last_synced_at, updated_at
     FROM channel_sync_status
     WHERE channel_account_id = $1`,
    [channelAccountId],
  );
  const rows = res?.rows || [];
  const entities = ENTITY_TYPES.reduce<Record<string, any>>((acc, entityType) => {
    const row = rows.find((candidate: any) => candidate.entity_type === entityType);
    acc[entityType] = {
      status: row?.status || 'idle',
      count: row?.count == null ? undefined : Number(row.count),
      error: row?.error || undefined,
      metadata: row?.metadata || {},
      lastSyncedAt: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : undefined,
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    };
    return acc;
  }, {});
  const values = Object.values(entities);
  const anySyncing = values.some((entity: any) => entity.status === 'syncing' || entity.status === 'pending');
  const allSynced = ['products', 'orders', 'inventory'].every((key) => entities[key]?.status === 'synced');
  return {
    channelAccountId,
    entities,
    fullSync: allSynced && !anySyncing,
  };
}
