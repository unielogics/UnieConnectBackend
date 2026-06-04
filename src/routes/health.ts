import { FastifyInstance } from 'fastify';
import { config } from '../config/env';
import { getPostgresPool } from '../db/postgres';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

let _ddb: DynamoDBClient | null = null;
function ddb(): DynamoDBClient {
  if (!_ddb) _ddb = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });
  return _ddb;
}

async function withTimeout(fn: () => Promise<unknown>, ms: number, label: string): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms)),
    ]);
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err: any) {
    return { ok: false, latency_ms: Date.now() - start, error: err?.message || String(err) };
  }
}

export async function healthRoutes(fastify: FastifyInstance) {
  // Liveness — process is alive, no dependency checks.
  fastify.get('/health', async (req) => {
    const appBaseUrl = config.shopify.appBaseUrl || config.amazon.appBaseUrl || '';
    const amazonRedirectUri =
      config.amazon.redirectUri ||
      (appBaseUrl ? `${appBaseUrl.replace(/\/+$/, '')}/api/v1/auth/amazon/callback` : null);
    return {
      status: 'ok',
      service: 'UnieConnect',
      ts: new Date().toISOString(),
      host: req.headers.host || null,
      origin: req.headers.origin || null,
      appBaseUrl,
      corsOrigins: config.corsOrigins,
      amazonRedirectUri: amazonRedirectUri || undefined,
      amazonAppIdKind: config.amazon.appId
        ? config.amazon.appId.startsWith('amzn1.sellerapps.app.')
          ? 'seller_app'
          : 'nonstandard'
        : 'missing',
    };
  });

  // Readiness — exercises every dependency the service needs to serve requests.
  fastify.get('/ready', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; latency_ms: number; error?: string }> = {};
    checks.postgres = await withTimeout(async () => {
      const p = getPostgresPool();
      if (!p) throw new Error('postgres pool not configured');
      await p.query('SELECT 1');
    }, 2000, 'postgres');
    checks.dynamodb_keepa = await withTimeout(async () => {
      await ddb().send(new DescribeTableCommand({ TableName: process.env.KEEPA_TABLE || 'unie-keepa-snapshots' }));
    }, 2000, 'dynamodb');
    const allOk = Object.values(checks).every((c) => c.ok);
    return reply.code(allOk ? 200 : 503).send({
      status: allOk ? 'ready' : 'degraded',
      ts: new Date().toISOString(),
      checks,
    });
  });
}
