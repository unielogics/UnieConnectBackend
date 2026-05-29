import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import { config } from '../config/env';

const CORTEX_PUBLIC_AUDIT_PATH = '/v1/public/website-catalog-audit';

function parseJson(text: string) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: 'Cortex returned a non-JSON response', raw: text.slice(0, 500) };
  }
}

async function forwardToCortex(method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = `${config.cortex.apiUrl}${path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const init: any = { method, headers };
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body || {});
  }
  const res: any = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, data: parseJson(text) };
}

export async function publicWebsiteAuditRoutes(app: FastifyInstance) {
  app.post('/public/website-catalog-audit', async (req: any, reply) => {
    try {
      const body = {
        ...(req.body || {}),
        source: 'unieconnect_public_audit',
      };
      const result = await forwardToCortex('POST', CORTEX_PUBLIC_AUDIT_PATH, body);
      return reply.code(result.status).send(result.data);
    } catch (err: any) {
      req.log.error({ err }, 'failed to proxy website catalog audit to Cortex');
      return reply.code(503).send({
        error: 'Cortex website catalog audit is unavailable',
        detail: err?.message || String(err),
      });
    }
  });

  app.get('/public/website-catalog-audit/:reference', async (req: any, reply) => {
    try {
      const reference = encodeURIComponent(String(req.params.reference || '').trim());
      const result = await forwardToCortex('GET', `${CORTEX_PUBLIC_AUDIT_PATH}/${reference}`);
      return reply.code(result.status).send(result.data);
    } catch (err: any) {
      req.log.error({ err }, 'failed to proxy website catalog audit lookup to Cortex');
      return reply.code(503).send({
        error: 'Cortex website catalog audit lookup is unavailable',
        detail: err?.message || String(err),
      });
    }
  });
}

