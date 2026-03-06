import { FastifyInstance } from 'fastify';
import { config } from '../config/env';

export async function healthRoutes(fastify: FastifyInstance) {
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
      /** Use this exact value as "OAuth Redirect URI" in the SP-API / LWA app configuration. */
      amazonRedirectUri: amazonRedirectUri || undefined,
    };
  });
}

