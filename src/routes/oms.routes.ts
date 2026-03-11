import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
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
import { listWarehouses, removeWarehouse, testWarehouse } from '../controllers/oms-warehouses.controller';

/**
 * Require Authorization (JWT or API key). Connect route handles both.
 * Verifies JWT and sets req.user so redeemConnectionCode has userId.
 */
async function requireAuth(req: any, reply: any) {
  const auth = (req.headers.authorization || '').trim();
  const parseCookies = (h: string | undefined) =>
    !h ? {} : h.split(';').reduce<Record<string, string>>((acc, p) => {
      const [k, ...v] = p.trim().split('=');
      if (k) acc[k] = decodeURIComponent((v.join('=') || '').trim());
      return acc;
    }, {});
  const token = auth?.startsWith('Bearer ')
    ? auth.slice(7).trim()
    : (parseCookies(req.headers.cookie)['unie-token'] || '').trim();
  if (!token) {
    return reply.code(401).send({ error: 'Authorization required', message: 'Please log in and try again.' });
  }
  const hasJwtFormat = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  if (hasJwtFormat) {
    try {
      req.user = jwt.verify(token, config.authSecret);
    } catch (e) {
      req.log?.warn?.({ err: (e as Error)?.message }, 'oms/connect: JWT verify failed');
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired session. Please log in again.' });
    }
  }
}

export async function omsRoutes(app: FastifyInstance) {
  // Connect: redeem connection code (JWT or OMS API key)
  app.post('/oms/connect', { preHandler: [requireAuth] }, async (req, reply) => {
    return redeemConnectionCode(req, reply);
  });

  // User warehouse list, test, remove (JWT only)
  app.get('/oms/warehouses', { preHandler: [requireAuth] }, async (req, reply) => {
    return listWarehouses(req, reply);
  });
  app.delete('/oms/warehouses/:warehouseCode', { preHandler: [requireAuth] }, async (req, reply) => {
    return removeWarehouse(req, reply);
  });
  app.post('/oms/warehouses/:warehouseCode/test', { preHandler: [requireAuth] }, async (req, reply) => {
    return testWarehouse(req, reply);
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
