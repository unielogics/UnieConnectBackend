/**
 * One-time migration script: sync OMS catalog content (image, images, description, itemName) to WMS.
 * Usage: npx ts-node scripts/sync-catalog-content-to-wms.ts [--dry-run]
 */
import { connectMongo } from '../src/config/mongo';
import { syncCatalogContentToWms } from '../src/services/catalog-sync-to-wms.service';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('[sync-catalog-content-to-wms] DRY RUN - no WMS API calls will be made');
  }

  await connectMongo();

  const log = {
    info: (o: object, msg?: string) => console.log(msg || 'info', o),
    warn: (o: object, msg?: string) => console.warn(msg || 'warn', o),
  };

  const result = await syncCatalogContentToWms(log, dryRun);

  console.log('[sync-catalog-content-to-wms] Result:', {
    usersProcessed: result.usersProcessed,
    itemsUpdated: result.itemsUpdated,
    errors: result.errors.length > 0 ? result.errors : undefined,
  });

  if (result.errors.length > 0) {
    console.error('Errors:', result.errors);
  }

  process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
