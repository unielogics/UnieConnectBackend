/**
 * Seller-facing Cortex placement plans (final client approval → real movement).
 *
 * A plan reaches here only AFTER the owning warehouse reviewed + approved it (WMS relay →
 * /internal/cortex/relay-plan). The client sees it as pending and gives the FINAL approval,
 * which is the only thing that triggers real stock movement. Approval calls the WMS internal
 * execute endpoint, which creates an APPROVAL-GATED draft transfer (still requires the
 * warehouse's own PUT .../status=completed to physically move stock — no auto-apply anywhere).
 */
import { FastifyInstance } from 'fastify';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

async function callWmsInternal<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!config.wmsApiUrl || !config.internalApiKey) {
    throw new Error('WMS API or internal key is not configured');
  }
  const res = await fetch(`${config.wmsApiUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Api-Key': config.internalApiKey },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(String(data?.message || data?.error || `WMS request failed with ${res.status}`));
  return data as T;
}

export async function omsCortexPlansRoutes(fastify: FastifyInstance) {
  // Client lists their pending/decided Cortex placement plans.
  fastify.get('/oms/cortex/plans', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const status = String((req.query as any)?.status || '').trim();
    try {
      const params: any[] = [userId];
      let where = 'user_id = $1';
      if (status) { where += ' AND status = $2'; params.push(status); }
      const rows = await pgQuery(
        `SELECT id, decision_id, client_id, warehouse_code, owning_warehouse_code, plan, summary,
                total_savings_usd, status, approved_at, executed_at, created_at
           FROM oms_cortex_plans
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT 100`,
        params,
      ).catch(() => ({ rows: [] as any[] }));
      return reply.send({ plans: (rows?.rows as any[]) || [] });
    } catch (err: any) {
      req.log?.error({ err }, '[oms-cortex-plans] list failed');
      return reply.code(500).send({ error: err?.message || 'failed to list plans' });
    }
  });

  // Client FINAL approval → triggers a real (approval-gated) WMS transfer. Stock moves only here.
  fastify.post('/oms/cortex/plans/:id/approve', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    try {
      // ATOMIC CLAIM: flip pending_client_approval → approving in a single guarded UPDATE.
      // Only one concurrent request (double-click / retry) wins the row; the rest get 0 rows.
      // This prevents two approvals both calling WMS execute-plan for the same plan.
      const claim = await pgQuery(
        `UPDATE oms_cortex_plans
            SET status='approving', approved_at=now(), updated_at=now()
          WHERE id=$1 AND user_id=$2 AND status='pending_client_approval'
        RETURNING decision_id, warehouse_code, client_id, plan`,
        [id, userId],
      );
      const plan = claim?.rows?.[0];
      if (!plan) {
        // Either it doesn't belong to this user, doesn't exist, or was already claimed/decided.
        const existing = await pgQuery(`SELECT status FROM oms_cortex_plans WHERE id=$1 AND user_id=$2 LIMIT 1`, [id, userId]);
        const st = existing?.rows?.[0]?.status;
        if (!st) return reply.code(404).send({ error: 'Plan not found' });
        return reply.code(409).send({ error: `Plan already ${st}` });
      }

      // Ask WMS to create the APPROVAL-GATED draft transfer for this decision. WMS reuses its
      // buildDraftFromTransferSet path (status 'reviewing', waiting_approval) — it never
      // auto-moves stock; the warehouse still completes the transfer to physically move it.
      // WMS execute-plan is idempotent per decision_id (dedupes on the open draft), so rolling
      // back to pending on failure and letting the client retry cannot create a second transfer.
      let wmsResult: any = null;
      const rollbackToPending = async () => {
        await pgQuery(
          `UPDATE oms_cortex_plans SET status='pending_client_approval', approved_at=NULL, updated_at=now() WHERE id=$1`,
          [id],
        ).catch(() => null);
      };
      try {
        wmsResult = await callWmsInternal('/internal/oms/execute-plan', {
          decisionId: plan.decision_id,
          warehouseCode: plan.warehouse_code,
          clientId: plan.client_id,
          plan: plan.plan,
          approvedByUserId: userId,
        });
      } catch (err: any) {
        // Transport/HTTP error — roll back so the client can retry (no draft was created).
        await rollbackToPending();
        return reply.code(502).send({ error: 'WMS execution failed; please try again', detail: err?.message || String(err) });
      }
      // LOGICAL failure: WMS returns HTTP 200 with ok:false (e.g. no resolvable legs, item not
      // found). Do NOT mark executed — roll back so the client isn't shown a false success.
      if (!wmsResult || wmsResult.ok !== true) {
        await rollbackToPending();
        return reply.code(502).send({
          error: 'WMS could not build an executable transfer from this plan',
          detail: wmsResult?.message || wmsResult?.notes || 'no executable legs',
        });
      }

      await pgQuery(
        `UPDATE oms_cortex_plans SET status='executed', executed_at=now(), updated_at=now() WHERE id=$1`,
        [id],
      );
      return reply.send({ ok: true, status: 'executed', wms: wmsResult });
    } catch (err: any) {
      req.log?.error({ err }, '[oms-cortex-plans] approve failed');
      return reply.code(500).send({ error: err?.message || 'approve failed' });
    }
  });

  // Client declines a relayed plan.
  fastify.post('/oms/cortex/plans/:id/decline', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    try {
      const r = await pgQuery(
        `UPDATE oms_cortex_plans SET status='declined', updated_at=now()
          WHERE id=$1 AND user_id=$2 AND status='pending_client_approval'
        RETURNING id`,
        [id, userId],
      );
      if (!r?.rows?.length) return reply.code(404).send({ error: 'Plan not found or not pending' });
      return reply.send({ ok: true, status: 'declined' });
    } catch (err: any) {
      req.log?.error({ err }, '[oms-cortex-plans] decline failed');
      return reply.code(500).send({ error: err?.message || 'decline failed' });
    }
  });
}
