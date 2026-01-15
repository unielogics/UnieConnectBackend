import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { pullShopifyAll } from './shopify-pull';
import { pullEbayAll } from './ebay-pull';
import { refreshEbayAccessToken } from './ebay';
import { config } from '../config/env';

const CRON_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const REFRESH_EVERY_MS = 30 * 60 * 1000; // 30 minutes cadence
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const REFRESHABLE_CHANNELS = ['shopify', 'ebay'];

export function startShopifyCron(log: FastifyBaseLogger) {
  setInterval(async () => {
    try {
      const now = Date.now();
      const accounts = await ChannelAccount.find({
        channel: { $in: REFRESHABLE_CHANNELS },
        status: 'active',
      })
        .lean()
        .exec();
      for (const account of accounts) {
        const last = account.lastCronAt ? new Date(account.lastCronAt).getTime() : 0;
        if (now - last < REFRESH_EVERY_MS) continue;

        await runRefresh(String(account._id), log);
        await ChannelAccount.updateOne({ _id: account._id }, { lastCronAt: new Date() }).exec();
      }
    } catch (err: any) {
      log.error({ err }, 'shopify cron iteration failed');
    }
  }, CRON_INTERVAL_MS);
}

export async function runRefresh(channelAccountId: string, log: FastifyBaseLogger) {
  const account = await ChannelAccount.findById(channelAccountId).exec();
  if (!account) {
    log.warn({ channelAccountId }, 'refresh skipped: account not found');
    return;
  }

  if (account.channel === 'shopify') {
    const res = await pullShopifyAll({
      shopDomain: account.shopDomain || '',
      accessToken: account.accessToken,
      channelAccountId: account._id.toString(),
      userId: account.userId.toString(),
      log,
    });
    log.info({ channelAccountId, res }, 'shopify refresh completed');
    return;
  }

  if (account.channel === 'ebay') {
    const accessToken = await ensureEbayAccessToken(account._id.toString(), account, log);
    if (!accessToken) {
      log.warn({ channelAccountId }, 'ebay refresh skipped: missing access token');
      return;
    }
    const res = await pullEbayAll({
      accessToken,
      channelAccountId: account._id.toString(),
      userId: account.userId.toString(),
      log,
      marketplaceId: config.ebay.marketplaceId,
    });
    log.info({ channelAccountId, res }, 'ebay refresh completed');
    return;
  }

  log.info({ channelAccountId, channel: account.channel }, 'refresh skipped: unsupported channel');
}

async function ensureEbayAccessToken(
  channelAccountId: string,
  account: any,
  log: FastifyBaseLogger,
): Promise<string | null> {
  const expiresAt = account.expiresAt ? new Date(account.expiresAt).getTime() : 0;
  const isExpired = !expiresAt || expiresAt - EXPIRY_BUFFER_MS < Date.now();
  if (!isExpired) return account.accessToken;

  if (!account.refreshToken) {
    log.warn({ channelAccountId }, 'eBay token expired and no refresh token present');
    return null;
  }

  const refreshed = await refreshEbayAccessToken(account.refreshToken);
  const nextRefreshToken = refreshed.refreshToken || account.refreshToken;
  await ChannelAccount.updateOne(
    { _id: account._id },
    {
      accessToken: refreshed.accessToken,
      refreshToken: nextRefreshToken,
      expiresAt: refreshed.expiresAt,
    },
  ).exec();
  return refreshed.accessToken;
}

