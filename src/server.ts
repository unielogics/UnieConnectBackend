import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes';
import { config } from './config/env';
import { connectMongo } from './config/mongo';
import { startShopifyCron } from './services/shopify-cron';
import { startAmazonCron } from './services/amazon-cron';

async function start() {
  const app = Fastify({ logger: true, trustProxy: true });

  // Request/response tracing for observability
  app.addHook('onRequest', async (req) => {
    (req as any).startTime = process.hrtime.bigint();
    req.log.info({ reqId: req.id, method: req.method, url: req.url, ip: req.ip }, 'incoming request');
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
  await connectMongo();
  const allowedOrigins =
    config.corsOrigins && config.corsOrigins.length > 0
      ? config.corsOrigins
      : ['https://unieconnect.com', 'https://user.unieconnect.com', 'https://admin.unieconnect.com'];

  await app.register(cors, {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Root health check (no prefix)
  app.get('/health', async () => ({
    status: 'ok',
    service: 'UnieConnect',
    ts: new Date().toISOString(),
  }));
  // Register all routes under /api/v1 to match redirect/webhook URLs
  app.register(async (instance) => {
    await registerRoutes(instance);
  }, { prefix: '/api/v1' });
  startShopifyCron(app.log);
  startAmazonCron(app.log);
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`UnieConnect listening on ${config.port}`);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

