import { FastifyInstance } from 'fastify';
import {
  approveRecommendation,
  createBulkProductResearchRun,
  createProductResearchRun,
  createSellerOptimizationRun,
  getDataReadiness,
  getIntelligenceRun,
  getLatestOptimization,
  getProductResearchResultForSku,
  getProductResearchRuns,
  getRecommendations,
  getScreenIntelligenceContext,
  getSellerOptimizationRun,
  getSellerOptimizationRuns,
  rejectRecommendation,
} from '../services/oms-intelligence.service';

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

export async function omsIntelligenceRoutes(fastify: FastifyInstance) {
  fastify.get('/oms/intelligence/readiness', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getDataReadiness(userId);
  });

  fastify.post('/oms/intelligence/product-research/runs', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return createProductResearchRun(userId, req.body || {});
  });

  fastify.post('/oms/intelligence/product-research/bulk', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return createBulkProductResearchRun(userId, req.body || {});
  });

  fastify.get('/oms/intelligence/product-research/runs', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getProductResearchRuns(userId, Number(req.query?.limit || 50));
  });

  fastify.get('/oms/intelligence/product-research/runs/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const detail = await getIntelligenceRun(userId, String(req.params?.id || ''));
    if (!detail) return reply.code(404).send({ error: 'Run not found' });
    return detail;
  });

  fastify.get('/oms/intelligence/product-research/results/:skuId', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const result = await getProductResearchResultForSku(userId, String(req.params?.skuId || ''));
    if (!result) return reply.code(404).send({ error: 'Product Research result not found' });
    return result;
  });

  fastify.post('/oms/intelligence/seller-optimization/runs', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return createSellerOptimizationRun(userId, req.body || {});
  });

  fastify.get('/oms/intelligence/seller-optimization/runs', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getSellerOptimizationRuns(userId, Number(req.query?.limit || 20));
  });

  fastify.get('/oms/intelligence/seller-optimization/runs/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const detail = await getSellerOptimizationRun(userId, String(req.params?.id || ''));
    if (!detail) return reply.code(404).send({ error: 'Seller Optimization run not found' });
    return detail;
  });

  fastify.get('/oms/intelligence/latest-optimization', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getLatestOptimization(userId);
  });

  fastify.get('/oms/intelligence/recommendations', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getRecommendations(userId, req.query || {});
  });

  fastify.post('/oms/intelligence/recommendations/:id/approve', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const result = await approveRecommendation(userId, String(req.params?.id || ''), req.body || {});
    if (!result) return reply.code(404).send({ error: 'Recommendation not found' });
    return result;
  });

  fastify.post('/oms/intelligence/recommendations/:id/reject', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const result = await rejectRecommendation(userId, String(req.params?.id || ''), req.body || {});
    if (!result) return reply.code(404).send({ error: 'Recommendation not found' });
    return result;
  });

  fastify.get('/oms/intelligence/copilot/context', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getScreenIntelligenceContext(userId, String(req.query?.screen || 'command'));
  });
}
