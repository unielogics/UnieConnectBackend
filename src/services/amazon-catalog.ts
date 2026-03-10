import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { spApiFetch } from './amazon-spapi';

type SearchAmazonCatalogItemsParams = {
  channelAccountId: string;
  marketplaceId?: string;
  query?: string;
  nextToken?: string;
  pageSize?: number;
  log: FastifyBaseLogger;
};

function isAsin(value: string): boolean {
  return /^[A-Z0-9]{10}$/i.test(value.trim());
}

function firstString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function loadAmazonAccount(channelAccountId: string) {
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) throw new Error('Channel account not found');
  if (account.channel !== 'amazon') throw new Error('Account is not Amazon');
  if (!account.sellingPartnerId) throw new Error('Missing sellingPartnerId for Amazon account');
  return account;
}

function resolveMarketplaceId(account: { marketplaceIds?: string[] }, marketplaceId?: string) {
  const resolved = marketplaceId || account.marketplaceIds?.[0];
  if (!resolved) throw new Error('Amazon marketplaceId is required');
  return resolved;
}

function pickTitleFromAttributes(attributes: any): string | undefined {
  const itemName = asArray<any>(attributes?.item_name)[0];
  if (itemName?.value && typeof itemName.value === 'string') return itemName.value;
  const title = asArray<any>(attributes?.item_name_keyword)[0];
  if (title?.value && typeof title.value === 'string') return title.value;
  return undefined;
}

function normalizeListingsItems(items: any[]) {
  return items
    .map((item) => {
      const summary = asArray<any>(item?.summaries)[0] || {};
      const fulfillment = asArray<any>(item?.fulfillmentAvailability)[0] || {};
      const issues = asArray<any>(item?.issues);
      const productType = firstString(item?.productType, asArray<any>(item?.productTypes)[0]?.productType, summary?.productType);
      const sellerSku = firstString(item?.sku, summary?.sellerSku, summary?.sku);
      const asin = firstString(summary?.asin, item?.asin);
      const title = firstString(summary?.itemName, item?.itemName, pickTitleFromAttributes(item?.attributes));
      if (!sellerSku && !asin) return null;

      return {
        sellerSku,
        asin,
        title,
        conditionType: firstString(summary?.conditionType, summary?.conditionTypeValue),
        status: firstString(item?.status, summary?.status),
        productType,
        fulfillmentAvailability: item?.fulfillmentAvailability || [],
        availableQuantity: fulfillment?.quantity ?? fulfillment?.fulfillableQuantity,
        issues,
        raw: item,
      };
    })
    .filter(Boolean);
}

function normalizeInventorySummaries(items: any[]) {
  return items
    .map((item) => {
      const sellerSku = firstString(item?.sellerSku);
      const asin = firstString(item?.asin);
      if (!sellerSku && !asin) return null;
      const inventoryDetails = item?.inventoryDetails || {};
      const researchableQuantity =
        inventoryDetails?.fulfillableQuantity ??
        inventoryDetails?.availableQuantity ??
        item?.totalQuantity ??
        item?.inventoryQuantity;
      return {
        sellerSku,
        asin,
        title: undefined,
        conditionType: firstString(item?.condition),
        status: 'ACTIVE',
        productType: undefined,
        fulfillmentAvailability: item?.inventoryDetails || {},
        availableQuantity: researchableQuantity,
        issues: [],
        raw: item,
      };
    })
    .filter(Boolean);
}

function dedupeCatalogItems(items: any[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sellerSku || ''}::${item.asin || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchAmazonCatalogItems(params: SearchAmazonCatalogItemsParams) {
  const { channelAccountId, query, nextToken, log } = params;
  const pageSize = Math.min(Math.max(params.pageSize || 25, 1), 50);
  const account = await loadAmazonAccount(channelAccountId);
  const sellerId = account.sellingPartnerId || '';
  const marketplaceId = resolveMarketplaceId(account, params.marketplaceId);

  const combined: any[] = [];
  let listingsNextToken: string | undefined;
  let inventoryNextToken: string | undefined;

  if (nextToken) {
    const listingsRes = await spApiFetch(account, {
      method: 'GET',
      path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
      query: {
        marketplaceIds: [marketplaceId],
        nextToken,
        pageSize,
        includedData: ['summaries', 'fulfillmentAvailability', 'issues', 'productTypes', 'attributes'],
      },
    });
    const items = normalizeListingsItems(asArray<any>(listingsRes?.items ?? listingsRes?.payload?.items));
    log.info({ channelAccountId, marketplaceId, nextToken, results: items.length }, 'amazon catalog items searched via next token');
    return {
      strategy: 'listings_search',
      marketplaceId,
      nextToken: firstString(listingsRes?.pagination?.nextToken, listingsRes?.nextToken),
      items,
      raw: listingsRes,
    };
  }

  if (query && query.trim()) {
    const trimmed = query.trim();
    const listingsRes = await spApiFetch(account, {
      method: 'GET',
      path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
      query: {
        marketplaceIds: [marketplaceId],
        pageSize,
        includedData: ['summaries', 'fulfillmentAvailability', 'issues', 'productTypes', 'attributes'],
        identifiers: [trimmed],
        identifiersType: isAsin(trimmed) ? 'ASIN' : 'SKU',
      },
    });
    const listingItems = normalizeListingsItems(asArray<any>(listingsRes?.items ?? listingsRes?.payload?.items));
    listingsNextToken = firstString(listingsRes?.pagination?.nextToken, listingsRes?.nextToken);
    combined.push(...listingItems);

    const inventoryRes = await spApiFetch(account, {
      method: 'GET',
      path: '/fba/inventory/v1/summaries',
      query: {
        granularityType: 'Marketplace',
        granularityId: marketplaceId,
        marketplaceIds: [marketplaceId],
        details: true,
        sellerSkus: [trimmed],
      },
    });
    const inventoryItems = normalizeInventorySummaries(
      asArray<any>(inventoryRes?.payload?.inventorySummaries ?? inventoryRes?.inventorySummaries),
    );
    inventoryNextToken = firstString(inventoryRes?.pagination?.nextToken, inventoryRes?.nextToken);
    combined.push(...inventoryItems);

    const filtered = dedupeCatalogItems(combined).filter((item) => {
      const haystack = [item.sellerSku, item.asin, item.title].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(trimmed.toLowerCase());
    });

    log.info({ channelAccountId, marketplaceId, query: trimmed, results: filtered.length }, 'amazon catalog items searched');
    return {
      strategy: 'combined_exact',
      marketplaceId,
      nextToken: listingsNextToken || inventoryNextToken,
      items: filtered,
      raw: { listingsRes, inventoryRes },
    };
  }

  const inventoryRes = await spApiFetch(account, {
    method: 'GET',
    path: '/fba/inventory/v1/summaries',
    query: {
      granularityType: 'Marketplace',
      granularityId: marketplaceId,
      marketplaceIds: [marketplaceId],
      details: true,
      startDateTime: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  const items = normalizeInventorySummaries(asArray<any>(inventoryRes?.payload?.inventorySummaries ?? inventoryRes?.inventorySummaries));
  inventoryNextToken = firstString(inventoryRes?.pagination?.nextToken, inventoryRes?.nextToken);
  log.info({ channelAccountId, marketplaceId, results: items.length }, 'amazon catalog inventory loaded');
  return {
    strategy: 'inventory_browse',
    marketplaceId,
    nextToken: inventoryNextToken,
    items,
    raw: inventoryRes,
  };
}
