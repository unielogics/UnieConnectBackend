import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  hashApiKey,
  resolveOmsApiKeyAuth,
  resolveWmsApiKeyAuth,
} from '../lib/api-key-auth';

/**
 * Registers API key auth into the preHandler chain.
 * Runs after JWT; if req.user is not set and Bearer token looks like an API key (not JWT),
 * attempts to resolve via ApiKey + (for OMS) X-Warehouse-ID.
 */
export async function apiKeyAuthHook(req: FastifyRequest, reply: FastifyReply) {
  const user = (req as any).user;
  if (user?.userId) return; // Already authenticated via JWT

  const auth = (req.headers.authorization || '').trim();
  if (!auth.startsWith('Bearer ')) return;

  const token = auth.slice(7).trim();
  if (!token) return;

  // JWT format: three base64 parts separated by dots
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return; // Likely JWT, let existing JWT handling deal with it (or it already failed)
  }

  // Try OMS key first (requires X-Warehouse-ID)
  const omsResult = await resolveOmsApiKeyAuth(req, reply, token);
  if (omsResult === true) return; // Success
  if (omsResult !== false) return omsResult; // Error reply was sent

  // Try WMS key
  const wmsSet = await resolveWmsApiKeyAuth(req, token);
  if (wmsSet) return;
}
