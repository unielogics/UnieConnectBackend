import { FastifyInstance } from 'fastify';
import { requireRole, CAN_MANAGE_USERS } from '../lib/roles';
import {
  createOmsAccount,
  listOmsAccounts,
  getOmsAccount,
  createOmsApiKey,
  linkOmsToWarehouse,
  listFacilitiesForOms,
} from '../controllers/oms-accounts.controller';
import { redeemConnectionCode } from '../controllers/oms-connect.controller';

/**
 * Require Authorization (JWT or API key). Connect route handles both.
 */
async function requireAuth(req: any, reply: any) {
  const auth = (req.headers.authorization || '').trim();
  if (!auth || !auth.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Authorization required' });
  }
}

export async function omsRoutes(app: FastifyInstance) {
  // Connect: redeem connection code (JWT or OMS API key)
  app.post('/oms/connect', { preHandler: [requireAuth] }, async (req, reply) => {
    return redeemConnectionCode(req, reply);
  });

  const requireManage = requireRole(CAN_MANAGE_USERS);

  // OMS account management (management / super_admin)
  app.post('/oms/accounts', { preHandler: [requireManage] }, async (req, reply) => {
    return createOmsAccount(req, reply);
  });
  app.get('/oms/accounts', { preHandler: [requireManage] }, async (req, reply) => {
    return listOmsAccounts(req, reply);
  });
  app.get('/oms/accounts/:id', { preHandler: [requireManage] }, async (req, reply) => {
    return getOmsAccount(req, reply);
  });
  app.post('/oms/accounts/:id/api-keys', { preHandler: [requireManage] }, async (req, reply) => {
    return createOmsApiKey(req, reply);
  });
  app.post('/oms/accounts/:id/link-warehouse', { preHandler: [requireManage] }, async (req, reply) => {
    return linkOmsToWarehouse(req, reply);
  });

  // Facilities for OMS linking (management / super_admin)
  app.get('/oms/facilities', { preHandler: [requireManage] }, async (req, reply) => {
    return listFacilitiesForOms(req, reply);
  });
}
