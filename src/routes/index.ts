import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { shopifyAuthRoutes } from './shopify-auth.routes';
import { ebayAuthRoutes } from './ebay-auth.routes';
import { shopifyWebhookRoutes } from './shopify-webhooks.routes';
import { channelAccountRoutes } from './channel-accounts.routes';
import { authRoutes } from './auth.routes';
import { itemRoutes } from './items.routes';
import { customerRoutes } from './customers.routes';
import { orderRoutes } from './orders.routes';
import { shopifyFulfillmentRoutes } from './shopify-fulfillment.routes';
import { amazonAuthRoutes } from './amazon-auth.routes';
import { amazonRoutes } from './amazon.routes';
import { auditRoutes } from './audit.routes';
import { ebayWebhookRoutes } from './ebay-webhooks.routes';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export async function registerRoutes(app: FastifyInstance) {
  // Attach user if Authorization bearer token is provided
  app.addHook('preHandler', async (req: any, _reply) => {
    const auth = req.headers.authorization;
    const parseCookies = (cookieHeader: string | undefined) => {
      if (!cookieHeader) return {};
      return cookieHeader.split(';').reduce<Record<string, string>>((acc, part) => {
        const [rawKey, ...rest] = part.trim().split('=');
        if (!rawKey) return acc;
        acc[rawKey] = decodeURIComponent(rest.join('='));
        return acc;
      }, {});
    };
    const token =
      auth?.startsWith('Bearer ')
        ? auth.slice(7)
        : parseCookies(req.headers.cookie || '')['unie-token'];
    if (token) {
      try {
        req.user = jwt.verify(token, config.authSecret);
      } catch {
        // ignore invalid tokens
      }
    }
  });

  await authRoutes(app);
  await healthRoutes(app);
  await shopifyAuthRoutes(app);
  await ebayAuthRoutes(app);
  await amazonAuthRoutes(app);
  await amazonRoutes(app);
  await shopifyWebhookRoutes(app);
  await channelAccountRoutes(app);
  await itemRoutes(app);
  await customerRoutes(app);
  await orderRoutes(app);
  await shopifyFulfillmentRoutes(app);
  await auditRoutes(app);
  await ebayWebhookRoutes(app);
}

