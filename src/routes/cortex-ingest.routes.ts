/**
 * Cortex ingest routes — receive decisions from the Cortex/WMS pipeline that
 * target the UnieConnect OMS account (the seller, not the warehouse).
 *
 * Currently handles `client_cost_optimization`: writes to a per-user
 * intelligence-recommendations log so the user sees the AI suggestion in their
 * dashboard.
 */
import { FastifyInstance } from 'fastify';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

interface ClientCostOptimizationBody {
  decision_id: string;
  oms_user_id: string;
  warehouse_code: string;
  recommendation_type: string;
  monthly_savings_usd?: number;
  why_narrative?: string;
  confidence?: number;
  model_version?: string;
  approval_state: 'approved' | 'waiting_approval' | 'rejected';
}

function checkInternalAuth(req: any): boolean {
  const expected = process.env.WMS_TO_UNIECONNECT_API_KEY || config.cortex?.apiKey;
  if (!expected) return true; // dev mode — no key configured
  const provided = req.headers['x-api-key'];
  return typeof provided === 'string' && provided === expected;
}

export async function cortexIngestRoutes(app: FastifyInstance) {
  app.post('/internal/cortex/client-cost-optimization', async (req: any, reply) => {
    if (!checkInternalAuth(req)) {
      return reply.code(401).send({ error: 'invalid internal key' });
    }
    const body = req.body as ClientCostOptimizationBody;
    if (!body?.decision_id || !body?.oms_user_id) {
      return reply.code(400).send({ error: 'decision_id and oms_user_id required' });
    }

    // Best-effort: write a row that the user's dashboard can render. The exact
    // table here is `oms_intelligence_recommendations` — created lazily via
    // the same pattern as oms_intelligence_runs. If the table doesn't exist
    // yet, we ensure-create it on the fly so this endpoint is self-bootstrapping.
    try {
      await pgQuery(
        `CREATE TABLE IF NOT EXISTS oms_intelligence_recommendations (
          decision_id          TEXT PRIMARY KEY,
          oms_user_id          TEXT NOT NULL,
          warehouse_code       TEXT,
          recommendation_type  TEXT NOT NULL,
          monthly_savings_usd  NUMERIC,
          why_narrative        TEXT,
          confidence           NUMERIC,
          model_version        TEXT,
          approval_state       TEXT NOT NULL DEFAULT 'waiting_approval',
          received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          acknowledged_at      TIMESTAMPTZ,
          notes                JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS oms_intel_rec_user_idx ON oms_intelligence_recommendations (oms_user_id, received_at DESC);
        CREATE INDEX IF NOT EXISTS oms_intel_rec_state_idx ON oms_intelligence_recommendations (approval_state, received_at DESC);`
      );

      await pgQuery(
        `INSERT INTO oms_intelligence_recommendations
           (decision_id, oms_user_id, warehouse_code, recommendation_type,
            monthly_savings_usd, why_narrative, confidence, model_version, approval_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (decision_id) DO UPDATE SET
           monthly_savings_usd = EXCLUDED.monthly_savings_usd,
           why_narrative = EXCLUDED.why_narrative,
           confidence = EXCLUDED.confidence,
           model_version = EXCLUDED.model_version,
           approval_state = EXCLUDED.approval_state`,
        [
          body.decision_id,
          body.oms_user_id,
          body.warehouse_code,
          body.recommendation_type,
          body.monthly_savings_usd ?? null,
          body.why_narrative ?? null,
          body.confidence ?? null,
          body.model_version ?? null,
          body.approval_state,
        ]
      );

      return reply.code(200).send({
        ok: true,
        decision_id: body.decision_id,
        approval_state: body.approval_state,
      });
    } catch (err: any) {
      req.log?.error({ err }, '[cortex-ingest] client-cost-optimization failed');
      return reply.code(500).send({ error: err?.message || 'ingest failed' });
    }
  });

  app.get('/internal/cortex/client-cost-optimization/health', async () => ({
    service: 'unieconnect-cortex-ingest',
    routes: ['POST /internal/cortex/client-cost-optimization'],
  }));
}
