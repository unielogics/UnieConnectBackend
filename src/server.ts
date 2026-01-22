import Fastify from 'fastify';
import fetch from 'node-fetch';
import cors from '@fastify/cors';
import { registerRoutes } from './routes';
import { config } from './config/env';
import { connectMongo } from './config/mongo';
import { startShopifyCron } from './services/shopify-cron';
import { startAmazonCron } from './services/amazon-cron';

async function start() {
  const app = Fastify({ logger: true });

  // Request/response tracing for observability
  app.addHook('onRequest', async (req) => {
    (req as any).startTime = process.hrtime.bigint();
    req.log.info({ reqId: req.id, method: req.method, url: req.url, ip: req.ip }, 'incoming request');
    const origin = req.headers.origin;
    if (origin) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'cors-pre',hypothesisId:'H1',location:'src/server.ts:19',message:'request origin observed',data:{origin,method:req.method,url:req.url},timestamp:Date.now()})}).catch(()=>{});
      // #endregion agent log
    }
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
  const defaultCorsOrigins = ['https://unieconnect.com', 'https://user.unieconnect.com', 'http://localhost:3000'];
  const corsOrigins = Array.from(new Set([...defaultCorsOrigins, ...config.corsOrigins]));
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/868bcac9-47ee-4f49-9fa2-f82e87e09392',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'cors-pre',hypothesisId:'H2',location:'src/server.ts:30',message:'cors configuration',data:{corsOrigins},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });
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

