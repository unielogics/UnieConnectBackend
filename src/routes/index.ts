import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { addressRoutes } from './address.routes';
import { cortexRoutes } from './cortex.routes';
import { omsProductionRoutes } from './oms-production.routes';
import { isMongoDisabled } from '../services/degraded-auth';

export async function registerRoutes(app: FastifyInstance) {
  await healthRoutes(app);
  await addressRoutes(app);
  await omsProductionRoutes(app);
  await cortexRoutes(app);

  if (isMongoDisabled()) {
    app.get('/legacy/status', async () => ({
      mongo: 'disabled',
      replacement: 'aurora_postgres',
      message: 'Legacy Mongo-backed routes are disabled while UnieConnect is running in AWS SQL mode.',
    }));
    return;
  }

  const { apiKeyAuthHook } = await import('../middleware/api-key-auth');
  app.addHook('preHandler', apiKeyAuthHook);

  await (await import('./shopify-auth.routes')).shopifyAuthRoutes(app);
  await (await import('./ebay-auth.routes')).ebayAuthRoutes(app);
  await (await import('./amazon-auth.routes')).amazonAuthRoutes(app);
  await (await import('./amazon.routes')).amazonRoutes(app);
  await (await import('./shopify-webhooks.routes')).shopifyWebhookRoutes(app);
  await (await import('./channel-accounts.routes')).channelAccountRoutes(app);
  await (await import('./items.routes')).itemRoutes(app);
  await (await import('./customers.routes')).customerRoutes(app);
  await (await import('./orders.routes')).orderRoutes(app);
  await (await import('./shopify-fulfillment.routes')).shopifyFulfillmentRoutes(app);
  await (await import('./shopify.routes')).shopifyRoutes(app);
  await (await import('./audit.routes')).auditRoutes(app);
  await (await import('./ebay-webhooks.routes')).ebayWebhookRoutes(app);
  await (await import('./features.routes')).featureRoutes(app);
  await (await import('./suppliers.routes')).supplierRoutes(app);
  await (await import('./ship-from-locations.routes')).shipFromLocationRoutes(app);
  await (await import('./shipment-plan.routes')).shipmentPlanRoutes(app);
  await (await import('./asn.routes')).asnRoutes(app);
  await (await import('./invoices.routes')).invoicesRoutes(app);
  await (await import('./transportation-template.routes')).transportationTemplateRoutes(app);
  await (await import('./facilities.routes')).facilitiesRoutes(app);
  await (await import('./users.routes')).usersRoutes(app);
  await (await import('./oms.routes')).omsRoutes(app);
  await (await import('./internal.routes')).internalRoutes(app);
  await (await import('./notes.routes')).notesRoutes(app);
}
