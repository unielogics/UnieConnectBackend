/**
 * OMS-to-WMS catalog content sync.
 * Pushes item image, images, description, title from UnieConnect catalog to WMS Items.
 */
import fetch from 'node-fetch';
import { config } from '../config/env';
import { Item } from '../models/item';
import { User } from '../models/user';
import { OmsIntermediary } from '../models/oms-intermediary';
import { OmsIntermediaryWarehouse } from '../models/oms-intermediary-warehouse';

const BATCH_SIZE = 50;

export interface SyncResult {
  usersProcessed: number;
  itemsUpdated: number;
  errors: string[];
}

/**
 * Sync catalog content (image, images, description, itemName) from OMS to WMS.
 * Resolves User -> OmsIntermediary -> OmsIntermediaryWarehouse, then pushes Item content per warehouse.
 * @param dryRun If true, skip actual WMS API calls and only report what would be synced.
 */
export async function syncCatalogContentToWms(
  log?: {
  info: (o: object, msg?: string) => void;
  warn: (o: object, msg?: string) => void;
},
  dryRun = false
): Promise<SyncResult> {
  const result: SyncResult = { usersProcessed: 0, itemsUpdated: 0, errors: [] };

  if (!config.wmsApiUrl || !config.internalApiKey) {
    result.errors.push('WMS_API_URL and UNIECONNECT_INTERNAL_API_KEY must be set');
    return result;
  }

  const links = await OmsIntermediaryWarehouse.find({ status: 'active' })
    .populate('omsIntermediaryId', 'email')
    .lean()
    .exec();

  const omsIdsWithLinks = [...new Set(links.map((l: any) => String(l.omsIntermediaryId?._id || l.omsIntermediaryId)))];

  for (const omsId of omsIdsWithLinks) {
    const oms = await OmsIntermediary.findById(omsId).select('email').lean().exec();
    if (!oms?.email) continue;

    const user = await User.findOne({ email: (oms.email as string).toLowerCase() }).select('_id').lean().exec();
    if (!user?._id) continue;

    const userLinks = links.filter(
      (l: any) => String(l.omsIntermediaryId?._id || l.omsIntermediaryId) === omsId
    );
    if (userLinks.length === 0) continue;

    const items = await Item.find({ userId: user._id })
      .select('sku image images description title')
      .lean()
      .exec();

    if (items.length === 0) continue;

    result.usersProcessed++;

    for (const link of userLinks) {
      const warehouseCode = (link as any).warehouseCode;
      const wmsIntermediaryId = (link as any).wmsIntermediaryId;
      if (!warehouseCode || !wmsIntermediaryId) continue;

      const updates = items
        .map((it: any) => {
          const u: { sku: string; wmsIntermediaryId: string; image?: string; images?: string[]; description?: string; itemName?: string } = {
            sku: it.sku,
            wmsIntermediaryId: String(wmsIntermediaryId),
          };
          if (it.image) u.image = it.image;
          if (Array.isArray(it.images) && it.images.length > 0) u.images = it.images;
          if (it.description) u.description = it.description;
          if (it.title) u.itemName = it.title;
          return u;
        })
        .filter((u) => u.image || (u.images && u.images.length) || u.description || u.itemName);

      if (updates.length === 0) continue;

      for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE);
        if (dryRun) {
          result.itemsUpdated += batch.length;
          continue;
        }
        try {
          const res = await fetch(`${config.wmsApiUrl}/api/v1/internal/oms/items/sync-content`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Api-Key': config.internalApiKey,
            },
            body: JSON.stringify({ warehouseCode, updates: batch }),
          });
          if (res.ok) {
            const data = (await res.json()) as { updated?: number };
            result.itemsUpdated += data.updated ?? 0;
          } else {
            const text = await res.text();
            result.errors.push(`WMS sync ${warehouseCode} batch ${i / BATCH_SIZE}: ${res.status} ${text.slice(0, 200)}`);
          }
        } catch (err: any) {
          result.errors.push(`WMS sync ${warehouseCode} batch ${i / BATCH_SIZE}: ${err?.message || String(err)}`);
        }
      }
    }
  }

  if (result.errors.length > 0) {
    log?.warn?.({ errors: result.errors }, 'catalog-sync-to-wms completed with errors');
  } else {
    log?.info?.({ usersProcessed: result.usersProcessed, itemsUpdated: result.itemsUpdated }, 'catalog-sync-to-wms completed');
  }
  return result;
}
