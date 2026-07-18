import { FastifyInstance } from 'fastify';
import { healthRoutes } from './health';
import { addressRoutes } from './address.routes';
import { cortexRoutes } from './cortex.routes';
import { cortexIngestRoutes } from './cortex-ingest.routes';
import { cortexWarehouseRegisterRoutes } from './cortex-warehouse-register.routes';
import { omsProductionRoutes } from './oms-production.routes';
import { omsIntelligenceRoutes } from './oms-intelligence.routes';
import { omsCustomizationRoutes } from './oms-customization.routes';
import { sqlModeRoutes } from './sql-mode.routes';
import { wmsIntegrationRoutes } from './wms-integration.routes';
import { supportRoutes } from './support.routes';
import { uploadRoutes } from './upload.routes';
import { publicWebsiteAuditRoutes } from './public-website-audit.routes';

export async function registerRoutes(app: FastifyInstance) {
  await healthRoutes(app);
  await addressRoutes(app);
  await omsProductionRoutes(app);
  await omsIntelligenceRoutes(app);
  await omsCustomizationRoutes(app);
  await supportRoutes(app);
  await uploadRoutes(app);
  await publicWebsiteAuditRoutes(app);
  await cortexRoutes(app);
  await cortexIngestRoutes(app);
  await cortexWarehouseRegisterRoutes(app);
  await wmsIntegrationRoutes(app);
  await sqlModeRoutes(app);
}
