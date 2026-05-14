import { FastifyInstance } from 'fastify';
import { cortexConfigStatus, postCortex } from '../services/cortex-orchestration';

function tenantFrom(req: any, body: any) {
  return String(body?.tenant_id || body?.tenantId || req.user?.id || req.headers['x-tenant-id'] || 'oms-default');
}

function withTenant(req: any, body: any) {
  return {
    ...(body || {}),
    tenant_id: tenantFrom(req, body || {}),
  };
}

async function proxy(reply: any, path: string, payload: any) {
  const result = await postCortex(path, payload);
  return reply.code(result.status).send(result.data);
}

export async function cortexRoutes(app: FastifyInstance) {
  app.get('/cortex/orchestration/health', async () => {
    return {
      service: 'unieconnect-cortex-orchestration-adapter',
      ...cortexConfigStatus(),
      endpoints: {
        decisionPlan: '/api/v1/cortex/orchestration/intelligence/decision-plan',
        inventoryTruthPlan: '/api/v1/cortex/orchestration/inventory/truth-plan',
        placementPlan: '/api/v1/cortex/orchestration/oms/placement-plan',
      },
    };
  });

  app.post('/cortex/orchestration/intelligence/decision-plan', async (req: any, reply) => {
    return proxy(reply, '/v1/orchestration/intelligence/decision-plan', withTenant(req, req.body));
  });

  app.post('/cortex/orchestration/inventory/truth-plan', async (req: any, reply) => {
    return proxy(reply, '/v1/orchestration/inventory/truth-plan', withTenant(req, req.body));
  });

  app.post('/cortex/orchestration/oms/placement-plan', async (req: any, reply) => {
    const body = withTenant(req, req.body || {});
    const payload = {
      tenant_id: body.tenant_id,
      inventory_truth: body.inventory_truth,
      forecast_outcomes: body.forecast_outcomes || [],
      seller_signals: body.seller_signals || [],
      pallet_lines: body.pallet_lines || [],
      lane_signals: body.lane_signals || [],
      decision_candidates: body.decision_candidates || [],
    };
    return proxy(reply, '/v1/orchestration/intelligence/decision-plan', payload);
  });
}
