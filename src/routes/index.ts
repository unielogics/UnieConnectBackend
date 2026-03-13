import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { shopifyAuthRoutes } from './shopify-auth.routes';
import { ebayAuthRoutes } from './ebay-auth.routes';
import { shopifyWebhookRoutes } from './shopify-webhooks.routes';
import { channelAccountRoutes } from './channel-accounts.routes';
import { itemRoutes } from './items.routes';
import { customerRoutes } from './customers.routes';
import { orderRoutes } from './orders.routes';
import { shopifyFulfillmentRoutes } from './shopify-fulfillment.routes';
import { shopifyRoutes } from './shopify.routes';
import { amazonAuthRoutes } from './amazon-auth.routes';
import { amazonRoutes } from './amazon.routes';
import { auditRoutes } from './audit.routes';
import { ebayWebhookRoutes } from './ebay-webhooks.routes';
import { featureRoutes } from './features.routes';
import { shipFromLocationRoutes } from './ship-from-locations.routes';
import { shipmentPlanRoutes } from './shipment-plan.routes';
import { asnRoutes } from './asn.routes';
import { invoicesRoutes } from './invoices.routes';
import { transportationTemplateRoutes } from './transportation-template.routes';
import { facilitiesRoutes } from './facilities.routes';
import { supplierRoutes } from './suppliers.routes';
import { usersRoutes } from './users.routes';
import { addressRoutes } from './address.routes';
import { omsRoutes } from './oms.routes';
import { internalRoutes } from './internal.routes';
import { apiKeyAuthHook } from '../middleware/api-key-auth';

export async function registerRoutes(app: FastifyInstance) {
  // JWT is set by server.ts preHandler (shared for auth + main routes)
  // API key auth: if req.user not set, try ApiKey (OMS: X-Warehouse-ID required; WMS: intermediaryId)
  app.addHook('preHandler', apiKeyAuthHook);

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
  await shopifyRoutes(app);
  await auditRoutes(app);
  await ebayWebhookRoutes(app);
  await featureRoutes(app);
  await supplierRoutes(app);
  await shipFromLocationRoutes(app);
  await shipmentPlanRoutes(app);
  await asnRoutes(app);
  await invoicesRoutes(app);
  await transportationTemplateRoutes(app);
  await facilitiesRoutes(app);
  await usersRoutes(app);
  await addressRoutes(app);
  await omsRoutes(app);
  await internalRoutes(app);
}

