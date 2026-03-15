/**
 * Catalog content sync scheduler.
 * Runs every 30 min (same cadence as shopify-cron) to push OMS catalog content to WMS.
 */
import { FastifyBaseLogger } from 'fastify';
import { syncCatalogContentToWms } from './catalog-sync-to-wms.service';

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let timer: ReturnType<typeof setInterval> | null = null;

export function startCatalogSyncToWmsScheduler(log: FastifyBaseLogger): void {
  if (timer) {
    log.info('catalog-sync-to-wms scheduler already running');
    return;
  }
  timer = setInterval(async () => {
    try {
      await syncCatalogContentToWms(log);
    } catch (err: any) {
      log.error({ err }, 'catalog-sync-to-wms scheduled run failed');
    }
  }, INTERVAL_MS);
  log.info('catalog-sync-to-wms scheduler started (every 30 minutes)');
}

export function stopCatalogSyncToWmsScheduler(log?: FastifyBaseLogger): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log?.info?.('catalog-sync-to-wms scheduler stopped');
  }
}
