/**
 * Direct-seller auto-optimization scheduler ("AI at the will of the AI").
 *
 * Direct UnieConnect signups (app_users.origin='direct') are self-owned and get autonomous
 * Cortex network optimization with no warehouse-review gate — suggestions go straight to the
 * client. This job runs Cortex's client-optimize for each direct seller on the AI's cadence
 * (daily tick; per-user staggered by last run). Cortex stamps origin='direct' so the produced
 * decisions are attributed to the client and can be surfaced in their OMS recommendations.
 *
 * Warehouse-invited clients are handled by the WMS cadence scheduler (owner-reviewed), NOT here.
 * Single-flight, per-user try/catch, off the :00/:30 marks. Started from server.ts after listen.
 */
import { pgQuery } from '../db/postgres';
import { postCortex } from './cortex-orchestration';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const FIRST_RUN_DELAY_MS = 7 * 60 * 1000; // 7 min after boot (stagger vs demand-push at 3 min)
const MIN_RERUN_HOURS = 24;
let timer: NodeJS.Timeout | null = null;
let running = false;

async function runOnce(): Promise<{ users: number; ran: number; failed: number }> {
  const result = { users: 0, ran: 0, failed: 0 };
  // Direct sellers only. last_direct_optimize_at gates rerun frequency (24h min).
  const rows = await pgQuery<{ id: string; last_at: string | null }>(
    `SELECT u.id AS id,
            (SELECT max(created_at) FROM app_user_activity_log l
              WHERE l.user_id = u.id AND l.action = 'direct_cortex_optimize') AS last_at
       FROM app_users u
      WHERE u.origin = 'direct'`,
  ).catch(() => ({ rows: [] as any[] }));

  for (const u of (rows?.rows as any[]) || []) {
    result.users++;
    const lastAt = u.last_at ? new Date(u.last_at).getTime() : 0;
    if (lastAt && (Date.now() - lastAt) / 3_600_000 < MIN_RERUN_HOURS) continue;
    try {
      // Direct sellers resolve to self_service policy (full national candidate pool); tenant_id
      // for a direct seller is the user id (Cortex keys the seller's own optimization on it).
      const res = await postCortex(
        '/v1/orchestration/oms/client-optimize',
        { tenant_id: u.id, client_id: u.id, origin: 'direct', owning_warehouse_code: null },
        { userId: u.id },
      );
      if (res && (res.ok || res.status === 200 || res.data)) {
        result.ran++;
        await pgQuery(
          `INSERT INTO app_user_activity_log (user_id, action, metadata) VALUES ($1, 'direct_cortex_optimize', $2::jsonb)`,
          [u.id, JSON.stringify({ at: new Date().toISOString(), source: 'direct_optimize_scheduler' })],
        ).catch(() => null);
      } else {
        result.failed++;
      }
    } catch (err) {
      result.failed++;
    }
  }
  return result;
}

export async function startDirectOptimizeScheduler(): Promise<void> {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runOnce();
      if (r.ran > 0) console.log(`[DirectOptimizeScheduler] ran optimization for ${r.ran}/${r.users} direct seller(s)`);
    } catch (e) {
      console.error('[DirectOptimizeScheduler] error:', e instanceof Error ? e.message : String(e));
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, INTERVAL_MS);
  setTimeout(() => { void tick(); }, FIRST_RUN_DELAY_MS);
  console.log('[DirectOptimizeScheduler] Started (daily; direct sellers, 24h min rerun)');
}

export function stopDirectOptimizeScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
