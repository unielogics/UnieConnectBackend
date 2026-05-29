import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import { randomBytes } from 'crypto';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

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

  app.post('/public/audit-signup/start', async (req: any, reply) => {
    const reference = String(req.body?.reference || '').trim().toUpperCase();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const company = String(req.body?.company || '').trim();
    const website = String(req.body?.website || '').trim();
    if (!/^CAT-[A-Z0-9-]{4,}$/.test(reference)) {
      return reply.code(400).send({ error: 'Valid CAT audit reference is required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'Valid work email is required' });
    }

    const audit = await forwardToCortex('GET', `${CORTEX_PUBLIC_AUDIT_PATH}/${encodeURIComponent(reference)}`);
    if (audit.status !== 200) {
      return reply.code(404).send({ error: 'Catalog audit reference could not be validated' });
    }
    const auditWebsite = String(audit.data?.website || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
    const requestedWebsite = website.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
    if (auditWebsite && requestedWebsite && auditWebsite !== requestedWebsite) {
      return reply.code(409).send({ error: 'Catalog audit website does not match the signup request' });
    }

    const token = randomBytes(24).toString('hex');
    const metadata = {
      source: 'unieconnect_public_audit',
      audit_reference: reference,
      website: audit.data?.website || website || null,
      company: audit.data?.company || company || null,
      email,
      product_count: audit.data?.product_count ?? null,
      confidence: audit.data?.confidence ?? null,
      created_from: 'public_audit_signup',
    };
    await pgQuery(
      `INSERT INTO invite_tokens (token, role, created_by, metadata)
       VALUES ($1, 'ecommerce_client', NULL, $2::jsonb)`,
      [token, JSON.stringify(metadata)],
    );
    return {
      token,
      role: 'ecommerce_client',
      expiresInDays: 7,
      auditReference: reference,
      inviteLink: `/signup?token=${encodeURIComponent(token)}&audit=${encodeURIComponent(reference)}`,
    };
  });
}
