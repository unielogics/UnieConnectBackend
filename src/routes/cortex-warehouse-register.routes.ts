/**
 * Cortex/WMS → OMS facility registration.
 *
 * A warehouse facility created in the WMS auto-registers here as a GLOBAL
 * network facility (user_id = NULL) so it is known network-wide (Cortex
 * candidate + network facility count) WITHOUT attaching any client. Clients
 * reach a facility only via the separate WH1-owned toggle + approval flow —
 * this endpoint never creates an oms_warehouse_links / client row.
 *
 * Auth: X-Internal-Api-Key (the same shared secret WMS uses for
 * /internal/wms/events, config.internalApiKey). Falls back to the cortex
 * x-api-key for parity with cortex-ingest. Idempotent on (code) for the
 * global (user_id IS NULL) row.
 */
import { FastifyInstance } from 'fastify';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

interface WarehouseRegisterBody {
  warehouseCode: string;
  warehouseId?: string;
  name?: string;
  networkEligible?: boolean;
  address?: Record<string, unknown>;
  source?: string;
}

function checkInternalAuth(req: any): boolean {
  const internal = config.internalApiKey;
  const cortexKey = process.env.WMS_TO_UNIECONNECT_API_KEY || (config as any).cortex?.apiKey;
  if (!internal && !cortexKey) return true; // dev mode — no key configured
  const provided = req.headers['x-internal-api-key'] || req.headers['x-api-key'];
  if (typeof provided !== 'string') return false;
  return (!!internal && provided === internal) || (!!cortexKey && provided === cortexKey);
}

export async function cortexWarehouseRegisterRoutes(app: FastifyInstance) {
  app.post('/internal/cortex/warehouse-register', async (req: any, reply) => {
    if (!checkInternalAuth(req)) {
      return reply.code(401).send({ error: 'invalid internal key' });
    }
    const body = req.body as WarehouseRegisterBody;
    const code = (body?.warehouseCode || '').trim();
    if (!code) {
      return reply.code(400).send({ error: 'warehouseCode required' });
    }

    try {
      const meta = {
        source: body.source || 'wms_auto',
        wmsWarehouseId: body.warehouseId || null,
        networkEligible: body.networkEligible === true,
        registeredAt: new Date().toISOString(),
      };
      // Global network facility: user_id IS NULL. The unique constraint is
      // (user_id, code) and treats NULL as distinct, so ON CONFLICT won't
      // dedupe here — do an explicit check-then-update/insert.
      const existing = await pgQuery(
        `SELECT id FROM facilities WHERE code = $1 AND user_id IS NULL LIMIT 1`,
        [code]
      );
      if (existing.rows.length) {
        const id = existing.rows[0].id;
        await pgQuery(
          `UPDATE facilities
             SET name = COALESCE($2, name),
                 address = COALESCE($3::jsonb, address),
                 metadata = metadata || $4::jsonb,
                 status = 'active',
                 updated_at = now()
           WHERE id = $1`,
          [id, body.name || null, body.address ? JSON.stringify(body.address) : null, JSON.stringify(meta)]
        );
        return reply.code(200).send({ ok: true, facilityId: id, status: 'updated' });
      }
      const inserted = await pgQuery(
        `INSERT INTO facilities (user_id, code, name, facility_type, status, address, metadata)
         VALUES (NULL, $1, $2, 'warehouse', 'active', $3::jsonb, $4::jsonb)
         RETURNING id`,
        [code, body.name || code, JSON.stringify(body.address || {}), JSON.stringify(meta)]
      );
      return reply.code(200).send({ ok: true, facilityId: inserted.rows[0]?.id, status: 'created' });
    } catch (err: any) {
      req.log?.error({ err }, '[cortex-warehouse-register] failed');
      return reply.code(500).send({ error: err?.message || 'register failed' });
    }
  });

  app.post('/internal/cortex/inventory-allocation', async (req: any, reply) => {
    if (!checkInternalAuth(req)) {
      return reply.code(401).send({ error: 'invalid internal key' });
    }
    const body = req.body as {
      decision_id?: string;
      user_id?: string;
      plan_id?: string;
      allocations?: Array<{ sku: string; warehouse_code?: string; proposed_units?: number; executable_units?: number; min_viable_units?: number; fill_percent?: number; service_tier?: string; status?: string; constraints?: any }>;
    };
    const userId = (body?.user_id || '').trim();
    const allocations = Array.isArray(body?.allocations) ? body.allocations : [];
    if (!userId || allocations.length === 0) {
      return reply.code(400).send({ error: 'user_id and non-empty allocations required' });
    }
    try {
      // Idempotent per (user_id, plan_id): clear the prior plan's rows, then insert fresh
      // (the table has no natural unique key, so this avoids accumulating stale allocations).
      if (body.plan_id) {
        await pgQuery(`DELETE FROM oms_inventory_allocations WHERE user_id=$1 AND plan_id=$2`, [userId, body.plan_id]);
      }
      let n = 0;
      for (const a of allocations) {
        const sku = String(a?.sku || '').trim();
        if (!sku) continue;
        await pgQuery(
          `INSERT INTO oms_inventory_allocations
             (user_id, plan_id, sku, warehouse_code, proposed_units, executable_units, min_viable_units,
              fill_percent, service_tier, status, constraints)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9,'standard'), COALESCE($10,'projected'), COALESCE($11,'[]')::jsonb)`,
          [
            userId,
            body.plan_id || null,
            sku,
            a.warehouse_code || null,
            Number(a.proposed_units) || 0,
            Number(a.executable_units) || 0,
            Number(a.min_viable_units) || 0,
            Number(a.fill_percent) || 0,
            a.service_tier || null,
            a.status || null,
            a.constraints ? JSON.stringify(a.constraints) : null,
          ]
        );
        n++;
      }
      return reply.code(200).send({ ok: true, upserted: n, decision_id: body.decision_id || null });
    } catch (err: any) {
      req.log?.error({ err }, '[cortex-inventory-allocation] failed');
      return reply.code(500).send({ error: err?.message || 'allocation ingest failed' });
    }
  });

  // WMS → OMS: relay an owning-warehouse-APPROVED Cortex placement plan to the client's OMS
  // as a PENDING plan awaiting the CLIENT's own final approval. Stores the plan; moves no stock.
  // The client's approval (POST /oms/cortex/plans/:id/approve, elsewhere) is the only thing that
  // triggers a real (still approval-gated) WMS transfer. Idempotent per (user_id, decision_id).
  app.post('/internal/cortex/relay-plan', async (req: any, reply) => {
    if (!checkInternalAuth(req)) {
      return reply.code(401).send({ error: 'invalid internal key' });
    }
    const body = req.body as {
      decisionId?: string;
      warehouseCode?: string;
      wmsIntermediaryId?: string;
      intermediaryNumber?: string;
      clientId?: string;
      owningWarehouseCode?: string;
      plan?: Record<string, unknown>;
      summary?: string | null;
      totalSavingsUsd?: number | null;
    };
    const decisionId = String(body?.decisionId || '').trim();
    const clientId = String(body?.clientId || '').trim();
    if (!decisionId || !clientId) {
      return reply.code(400).send({ error: 'decisionId and clientId required' });
    }
    try {
      await pgQuery(`
        CREATE TABLE IF NOT EXISTS oms_cortex_plans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          decision_id TEXT NOT NULL,
          user_id TEXT,
          client_id TEXT NOT NULL,
          wms_intermediary_id TEXT,
          intermediary_number TEXT,
          warehouse_code TEXT,
          owning_warehouse_code TEXT,
          plan JSONB NOT NULL DEFAULT '{}'::jsonb,
          summary TEXT,
          total_savings_usd NUMERIC,
          status TEXT NOT NULL DEFAULT 'pending_client_approval',
          approved_at TIMESTAMPTZ,
          executed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (decision_id)
        )
      `);
      // Resolve the OMS user for this client (link via app_users.origin/owning, else leave null;
      // the client's own dashboard reads by client_id + user_id when present).
      let userId: string | null = null;
      try {
        const u = await pgQuery<{ id: string }>(
          `SELECT id FROM app_users WHERE id = $1 OR email = $1 LIMIT 1`,
          [clientId],
        );
        userId = u?.rows[0]?.id || null;
      } catch { userId = null; }

      await pgQuery(
        `INSERT INTO oms_cortex_plans
           (decision_id, user_id, client_id, wms_intermediary_id, intermediary_number,
            warehouse_code, owning_warehouse_code, plan, summary, total_savings_usd, status, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'pending_client_approval', now())
         ON CONFLICT (decision_id) DO UPDATE SET
           plan = EXCLUDED.plan, summary = EXCLUDED.summary,
           total_savings_usd = EXCLUDED.total_savings_usd,
           status = 'pending_client_approval', updated_at = now()`,
        [
          decisionId,
          userId,
          clientId,
          body.wmsIntermediaryId || null,
          body.intermediaryNumber || null,
          body.warehouseCode || null,
          body.owningWarehouseCode || null,
          JSON.stringify(body.plan || {}),
          body.summary || null,
          body.totalSavingsUsd ?? null,
        ],
      );
      return reply.code(200).send({ ok: true, decisionId, status: 'pending_client_approval', userLinked: !!userId });
    } catch (err: any) {
      req.log?.error({ err }, '[cortex-relay-plan] failed');
      return reply.code(500).send({ error: err?.message || 'relay-plan failed' });
    }
  });

  app.get('/internal/cortex/warehouse-register/health', async (_req, reply) => {
    return reply.code(200).send({ ok: true, route: 'cortex-warehouse-register' });
  });
}
