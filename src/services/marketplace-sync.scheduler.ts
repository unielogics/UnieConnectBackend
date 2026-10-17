import { pgQuery } from '../db/postgres';
import { markMarketplaceRefresh, pullShopifySql } from './marketplace-sql-sync';

const DEFAULT_INTERVAL_MINUTES = 6 * 60;
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

type ShopifyConnection = {
  id: string;
  user_id: string;
  shop_domain: string;
  access_token_enc: string;
  historical_backfill_complete: boolean;
};

function intervalMs() {
  const configured = Number(process.env.MARKETPLACE_SYNC_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  const minutes = Number.isFinite(configured) ? Math.min(1440, Math.max(15, configured)) : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

export async function runMarketplaceSyncOnce() {
  const result = { connections: 0, synced: 0, failed: 0 };
  const query = await pgQuery<ShopifyConnection>(
    `SELECT m.id, m.user_id, m.shop_domain, m.access_token_enc,
            COALESCE((
              SELECT COALESCE(NULLIF(s.metadata->>'historicalBackfill', ''), 'false')::boolean
              FROM channel_sync_status s
              WHERE s.channel_account_id = m.id AND s.entity_type = 'orders'
            ), false) AS historical_backfill_complete
       FROM marketplace_connections m
      WHERE m.channel = 'shopify'
        AND m.status = 'connected'
        AND m.shop_domain IS NOT NULL
        AND m.access_token_enc IS NOT NULL
        AND COALESCE(m.metadata->>'source', '') <> 'demo'
      ORDER BY m.updated_at ASC`,
  );

  for (const connection of query?.rows || []) {
    result.connections++;
    try {
      const syncResult = await pullShopifySql({
        userId: connection.user_id,
        channelAccountId: connection.id,
        shopDomain: connection.shop_domain,
        accessToken: connection.access_token_enc,
        initialSync: !connection.historical_backfill_complete,
      });
      await markMarketplaceRefresh(connection.id, connection.user_id, syncResult);
      const syncErrors = Object.keys(syncResult.errors || {});
      const syncWarnings = Object.keys(syncResult.warnings || {});
      const issueCount = syncErrors.length + syncWarnings.length;
      await pgQuery(
        `INSERT INTO oms_execution_ledger
          (user_id, entity_type, entity_id, event_type, source_system, summary, payload)
         VALUES ($1, 'marketplace_connection', $2, $3, 'shopify', $4, $5::jsonb)`,
        [
          connection.user_id,
          connection.id,
          issueCount ? 'scheduled_refresh_partial' : 'scheduled_refresh_completed',
          issueCount
            ? `Scheduled Shopify refresh completed with ${issueCount} warning(s) for ${connection.shop_domain}.`
            : `Scheduled Shopify refresh completed for ${connection.shop_domain}.`,
          JSON.stringify({ accountId: connection.id, syncResult }),
        ],
      ).catch(() => null);
      if (issueCount) result.failed++;
      else result.synced++;
    } catch (error: any) {
      await pgQuery(
        `INSERT INTO oms_execution_ledger
          (user_id, entity_type, entity_id, event_type, source_system, summary, payload)
         VALUES ($1, 'marketplace_connection', $2, 'scheduled_refresh_failed', 'shopify', $3, $4::jsonb)`,
        [
          connection.user_id,
          connection.id,
          `Scheduled Shopify refresh failed for ${connection.shop_domain}.`,
          JSON.stringify({ accountId: connection.id, error: error?.message || 'Refresh failed' }),
        ],
      ).catch(() => null);
      result.failed++;
    }
  }

  return result;
}

export function startMarketplaceSyncScheduler() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runMarketplaceSyncOnce();
      console.log('[marketplace-sync] run complete', result);
    } catch (error: any) {
      console.error('[marketplace-sync] run failed', error?.message || String(error));
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => { void tick(); }, intervalMs());
  setTimeout(() => { void tick(); }, FIRST_RUN_DELAY_MS);
  console.log(`[marketplace-sync] scheduler started (${Math.round(intervalMs() / 60000)}m; first run in 2m)`);
}

export function stopMarketplaceSyncScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
