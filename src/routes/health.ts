import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async (req) => ({
    status: 'ok',
    service: 'UnieConnect',
    ts: new Date().toISOString(),
    host: req.headers.host || null,
    origin: req.headers.origin || null,
    appBaseUrl: config.shopify.appBaseUrl || config.amazon.appBaseUrl || '',
    corsOrigins: config.corsOrigins,
  }));
}

