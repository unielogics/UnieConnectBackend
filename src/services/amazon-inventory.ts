import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { spApiFetch } from './amazon-spapi';

type InventoryUpdate = {
  sku: string;
  quantity: number;
  marketplaceIds?: string[];
};

export async function pushAmazonInventory(channelAccountId: string, updates: InventoryUpdate[], log: FastifyBaseLogger) {
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');
  if (!account.sellingPartnerId) throw new Error('Missing sellingPartnerId for Amazon account');

  const marketplaceIds =
    updates.find((u) => Array.isArray(u.marketplaceIds) && u.marketplaceIds.length)
      ?.marketplaceIds || account.marketplaceIds || [];

  for (const update of updates) {
    const sku = update.sku?.trim();
    if (!sku) continue;
    const marketplaces = update.marketplaceIds && update.marketplaceIds.length > 0 ? update.marketplaceIds : marketplaceIds;
    if (!marketplaces || marketplaces.length === 0) {
      log.warn({ sku }, 'amazon inventory push skipped: no marketplaceIds');
      continue;
    }

    await spApiFetch(account, {
      method: 'PATCH' as any,
      path: `/listings/2021-08-01/items/${encodeURIComponent(account.sellingPartnerId)}/${encodeURIComponent(sku)}`,
      query: { marketplaceIds: marketplaces },
      body: {
        patches: [
          {
            op: 'replace',
            path: '/attributes/fulfillmentAvailability',
            value: [
              {
                fulfillmentChannelCode: 'DEFAULT',
                quantity: update.quantity,
              },
            ],
          },
        ],
      },
    });
  }
}






