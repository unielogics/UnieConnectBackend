import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import cors from '@fastify/cors';

const DBG = path.join(process.cwd(), '..', '..', '.cursor', 'debug.log');
const dbg = (o: object) => { try { fs.appendFileSync(DBG, JSON.stringify({ ...o, ts: Date.now() }) + '\n'); } catch {} };
import jwt from 'jsonwebtoken';
import { registerRoutes } from './routes';
import { startDemandPushScheduler } from './services/demand-push.scheduler';
import { startDirectOptimizeScheduler } from './services/direct-optimize.scheduler';
import { startMarketplaceSyncScheduler } from './services/marketplace-sync.scheduler';
import { authRoutes } from './routes/auth.routes';
import { config } from './config/env';
import { pgQuery } from './db/postgres';

async function start() {
  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req: any, body, done) => {
    if (req.url.includes('/webhooks/shopify')) req.rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body as any);
    try {
      const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
      done(null, text ? JSON.parse(text) : {});
    } catch (err: any) {
      done(err, undefined);
    }
  });

  // Request/response tracing for observability
  app.addHook('onRequest', async (req) => {
    (req as any).startTime = process.hrtime.bigint();
    if (req.method === 'POST' && req.url.includes('auth/login')) dbg({ src: 'UCB-server', step: 'onRequest', method: req.method, url: req.url });
    req.log.info({ reqId: req.id, method: req.method, url: req.url, ip: req.ip }, 'incoming request');
    const origin = req.headers.origin;
  });

  app.addHook('onResponse', async (req, reply) => {
    const start = (req as any).startTime as bigint | undefined;
    const durationMs = start ? Number(process.hrtime.bigint() - start) / 1_000_000 : undefined;
    reply.header('x-request-id', req.id);
    req.log.info({ reqId: req.id, statusCode: reply.statusCode, durationMs }, 'request completed');
  });

  app.addHook('onError', async (req, _reply, err) => {
    req.log.error({ reqId: req.id, err }, 'unhandled error');
  });
  app.log.info('UnieConnect backend starting in Aurora PostgreSQL mode.');

  // Production sanity: WMS_API_URL must NOT be localhost
  const isProduction = process.env.NODE_ENV === 'production';
  const wmsUrl = config.wmsApiUrl || '';
  if (isProduction && (wmsUrl.includes('localhost') || wmsUrl.includes('127.0.0.1'))) {
    // eslint-disable-next-line no-console
    console.error(
      '[FATAL] WMS_API_URL must point to production UnieBackend in production. ' +
      'Currently: ' + wmsUrl + '. Set WMS_API_URL=https://api.uniewms.com (or your prod WMS URL) in your hosting env.'
    );
    process.exit(1);
  }

  const defaultCorsOrigins = ['https://unieconnect.com', 'https://user.unieconnect.com', 'http://localhost:3000'];
  const corsOrigins = Array.from(new Set([...defaultCorsOrigins, ...config.corsOrigins]));
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Language', 'X-Requested-With', 'X-Warehouse-ID', 'X-WMS-Client-ID', 'X-WMS-Passkey', 'Idempotency-Key', 'X-Internal-Api-Key'],
    credentials: true,
  });
  // Single /api/v1 plugin: JWT preHandler for ALL routes (auth + main). apiKeyAuthHook only affects routes that need it.
  app.register(async (instance) => {
    instance.addHook('preHandler', async (req: any) => {
      const auth = req.headers.authorization;
      const parseCookies = (h: string | undefined) => !h ? {} : h.split(';').reduce<Record<string, string>>((acc, p) => {
        const [k, ...v] = p.trim().split('=');
        if (k) acc[k] = decodeURIComponent((v.join('=') || '').trim());
        return acc;
      }, {});
      const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : (parseCookies(req.headers.cookie)['unie-token'] || '').trim();
      if (token) {
        try {
          req.user = jwt.verify(token, config.authSecret);
        } catch {
          try {
            const claims: any = jwt.verify(token, config.shopify.clientSecret, {
              algorithms: ['HS256'],
              audience: config.shopify.clientId,
            });
            const issuer = new URL(String(claims.iss || ''));
            const destination = new URL(String(claims.dest || ''));
            const shop = destination.hostname.toLowerCase();
            if (issuer.hostname.toLowerCase() !== shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Invalid Shopify ID token destination');
            const result = await pgQuery<{ user_id: string; email: string; role: string }>(
              `SELECT c.user_id, u.email, u.role
               FROM marketplace_connections c
               JOIN app_users u ON u.id = c.user_id
               WHERE c.channel = 'shopify' AND lower(c.shop_domain) = lower($1) AND c.status = 'connected'
               ORDER BY c.updated_at DESC LIMIT 1`,
              [shop],
            );
            const account = result?.rows?.[0];
            if (account?.user_id) {
              req.user = { userId: account.user_id, email: account.email, role: account.role, authSource: 'shopify_id_token', shop };
            }
          } catch {
            /* The route-level authentication guard returns the appropriate response. */
          }
        }
      }
    });
    await authRoutes(instance);
    await registerRoutes(instance);
  }, { prefix: '/api/v1' });
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`UnieConnect listening on ${config.port}`);
  try { startDemandPushScheduler(); } catch (e) { app.log.error(e, 'demand-push scheduler failed to start'); }
  try { startDirectOptimizeScheduler(); } catch (e) { app.log.error(e, 'direct-optimize scheduler failed to start'); }
  try { startMarketplaceSyncScheduler(); } catch (e) { app.log.error(e, 'marketplace-sync scheduler failed to start'); }
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
