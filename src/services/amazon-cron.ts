import { FastifyBaseLogger } from 'fastify';
import { ChannelAccount } from '../models/channel-account';
import { pullAmazonAll } from './amazon-pull';

const CRON_INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes
const REFRESH_EVERY_MS = 60 * 60 * 1000; // 1 hour cadence

export function startAmazonCron(log: FastifyBaseLogger) {
  setInterval(async () => {
    try {
      const now = Date.now();
      const accounts = await ChannelAccount.find({ channel: 'amazon', status: 'active' }).lean().exec();
      for (const account of accounts) {
        const last = account.lastCronAt ? new Date(account.lastCronAt).getTime() : 0;
        if (now - last < REFRESH_EVERY_MS) continue;

        await runAmazonRefresh(String(account._id), log);
        await ChannelAccount.updateOne({ _id: account._id }, { lastCronAt: new Date() }).exec();
      }
    } catch (err: any) {
      log.error({ err }, 'amazon cron iteration failed');
    }
  }, CRON_INTERVAL_MS);
}

export async function runAmazonRefresh(channelAccountId: string, log: FastifyBaseLogger) {
  const res = await pullAmazonAll(channelAccountId, log);
  log.info({ channelAccountId, res }, 'amazon refresh completed');
}






