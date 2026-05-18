import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { addressRoutes } from './address.routes';
import { cortexRoutes } from './cortex.routes';
import { omsProductionRoutes } from './oms-production.routes';
import { sqlModeRoutes } from './sql-mode.routes';
import { wmsIntegrationRoutes } from './wms-integration.routes';
import { supportRoutes } from './support.routes';
import { uploadRoutes } from './upload.routes';

export async function registerRoutes(app: FastifyInstance) {
  await healthRoutes(app);
  await addressRoutes(app);
  await omsProductionRoutes(app);
  await supportRoutes(app);
  await uploadRoutes(app);
  await cortexRoutes(app);
  await wmsIntegrationRoutes(app);
  await sqlModeRoutes(app);
}
