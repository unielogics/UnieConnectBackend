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
  // Fail CLOSED when no key is configured — a missing key must never make these
  // stock-affecting internal endpoints public. Opt into the old dev behavior explicitly.
  if (!internal && !cortexKey) return process.env.ALLOW_UNAUTHENTICATED_INTERNAL === 'true';
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
      if (existing?.rows?.length) {
        const id = existing.rows[0]?.id;
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
      return reply.code(200).send({ ok: true, facilityId: inserted?.rows?.[0]?.id, status: 'created' });
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
      // Resolve the OMS user for this client. WMS may send clientId as the OMS user id, an
      // email, or (for warehouse-invited clients with no OMS-identity link) an intermediary
      // number — try each so the client can actually see the plan. If unresolved, the row is
      // still stored (client_id kept) and can be back-linked later, but we WARN because an
      // unlinked plan is invisible to the client until then.
      let userId: string | null = null;
      try {
        const u = await pgQuery<{ id: string }>(
          `SELECT id FROM app_users WHERE id = $1 OR lower(email) = lower($1) LIMIT 1`,
          [clientId],
        );
        userId = u?.rows[0]?.id || null;
      } catch { userId = null; }
      // Fallback: resolve via the warehouse-link / intermediary number for this warehouse.
      if (!userId && body.intermediaryNumber) {
        try {
          const l = await pgQuery<{ user_id: string }>(
            `SELECT user_id FROM oms_warehouse_links
              WHERE warehouse_code = $1 AND (metadata->>'intermediaryNumber' = $2 OR connection_code = $2)
              ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
            [body.warehouseCode || body.owningWarehouseCode || '', body.intermediaryNumber],
          );
          userId = l?.rows[0]?.user_id || null;
        } catch { userId = null; }
      }
      if (!userId) {
        req.log?.warn({ clientId, decisionId, intermediaryNumber: body.intermediaryNumber },
          '[cortex-relay-plan] could not resolve OMS user_id — plan stored but invisible until back-linked');
      }

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

  // WMS → OMS: attach/detach a PEER-NETWORK warehouse as a secondary rate-shop node on a client's
  // account. When an operator accepts a peer/partner warehouse for their own warehouse, that peer
  // should become a second connected + network-eligible warehouse for the operator's clients so
  // multi-warehouse (single-vs-multi) rate shopping turns on. Peer-accept in the WMS otherwise only
  // writes Warehouse.network.partners[] and never reaches the client's OMS warehouse links.
  //
  // Distinct from /warehouse-register (global facility only, no client link) and from the OMS
  // /oms/connect bootstrap (full credential-provisioned primary connection). This creates a
  // lightweight NETWORK-node link tagged metadata.source='peer_partner_network' so detach never
  // touches a client's real primary/bootstrap connection. Idempotent per (user_id, warehouse_code).
  app.post('/internal/cortex/client-network-warehouse', async (req: any, reply) => {
    if (!checkInternalAuth(req)) {
      return reply.code(401).send({ error: 'invalid internal key' });
    }
    const body = req.body as {
      action?: 'attach' | 'detach';
      warehouseCode?: string;          // the peer warehouse (WH-X) to add/remove as a network node
      ownerWarehouseCode?: string;     // the accepting warehouse (e.g. WH-007) — used to resolve clients
      networkEligible?: boolean;
      // The peer warehouse's physical address, sent by the WMS fan-out. WITHOUT this the peer
      // facility has no rateable origin, so the single-vs-multi rate shop can't quote it (label
      // rate unavailable, savings $0). name is the peer's display name.
      name?: string;
      address?: Record<string, unknown>;
      latitude?: number;
      longitude?: number;
      clients?: Array<{
        omsUserId?: string;
        wmsIntermediaryId?: string;
        externalOmsIntermediaryId?: string;
        intermediaryNumber?: string;
      }>;
    };
    const action = body?.action === 'detach' ? 'detach' : 'attach';
    const peerCode = String(body?.warehouseCode || '').trim();
    const ownerCode = String(body?.ownerWarehouseCode || '').trim();
    const clients = Array.isArray(body?.clients) ? body.clients : [];
    if (!peerCode || !ownerCode || clients.length === 0) {
      return reply.code(400).send({ error: 'warehouseCode, ownerWarehouseCode and non-empty clients required' });
    }
    const isAppUserId = (v?: string) => !!v && /^[0-9a-fA-F-]{16,40}$/.test(String(v));
    const results: Array<{ status: string; userId?: string; reason?: string }> = [];
    try {
      for (const client of clients) {
        // 1) Resolve the OMS user_id. The WMS cannot invert the sha1 → the only reliable source is
        //    the client's EXISTING link on the owner warehouse (metadata carries the WMS ids).
        let userId: string | null = null;
        if (isAppUserId(client.omsUserId)) {
          const u = await pgQuery<{ id: string }>(
            `SELECT id FROM app_users WHERE id = $1 LIMIT 1`, [client.omsUserId],
          ).catch(() => ({ rows: [] as any[] }));
          userId = u?.rows?.[0]?.id || null;
        }
        if (!userId) {
          const l = await pgQuery<{ user_id: string }>(
            `SELECT user_id FROM oms_warehouse_links
              WHERE warehouse_code = $1
                AND ( ($2 <> '' AND metadata->>'wmsIntermediaryId' = $2)
                   OR ($3 <> '' AND metadata->>'wmsOmsIntermediaryId' = $3)
                   OR ($4 <> '' AND connection_code = $4) )
              ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
            [ownerCode, String(client.wmsIntermediaryId || ''), String(client.externalOmsIntermediaryId || ''), String(client.intermediaryNumber || '')],
          ).catch(() => ({ rows: [] as any[] }));
          userId = l?.rows?.[0]?.user_id || null;
        }
        if (!userId) {
          req.log?.warn({ ownerCode, peerCode, client }, '[client-network-warehouse] unresolved OMS user — skipped');
          results.push({ status: 'skipped', reason: 'unresolved_user' });
          continue;
        }

        if (action === 'detach') {
          // Only remove links this bridge created — never a client's primary/bootstrap connection.
          await pgQuery(
            `UPDATE oms_warehouse_links
                SET status = 'removed', updated_at = now()
              WHERE user_id = $1 AND warehouse_code = $2 AND metadata->>'source' = 'peer_partner_network'`,
            [userId, peerCode],
          ).catch(() => null);
          results.push({ status: 'detached', userId });
          continue;
        }

        // 2) Ensure a per-user facility for the peer warehouse with networkEligible=true (the pricing
        //    join reads THIS facility's metadata to decide eligibility) AND its physical address
        //    (the rate shop needs an origin to quote the peer node — without it the single-vs-multi
        //    card shows "label rate unavailable" and $0 savings). lat/lon may arrive top-level or
        //    nested in address; the pricing context reads facilities.address {postal,state,lat,lon}.
        // Strict coordinate parse: reject '', null, boolean, and exactly 0 (Number('')/Number(false)
        // both coerce to 0 — a (0,0) origin is a bogus ocean point that silently breaks rate shopping).
        const coord = (v: unknown): number | null => {
          if (v === '' || v === null || v === undefined || typeof v === 'boolean') return null;
          const n = Number(v);
          return Number.isFinite(n) && n !== 0 ? n : null;
        };
        const addr = (body.address && typeof body.address === 'object') ? { ...body.address } as Record<string, unknown> : {};
        const lat = coord(body.latitude ?? (addr.latitude as any) ?? (addr.lat as any));
        const lon = coord(body.longitude ?? (addr.longitude as any) ?? (addr.lon as any) ?? (addr.lng as any));
        const hasAddress = Object.keys(addr).length > 0;
        // Raw name: null when absent so the COALESCE guard actually preserves an existing display name
        // (defaulting to peerCode here would make NULLIF dead code and clobber a good name on re-attach).
        const facilityName = String(body.name || '').trim() || null;
        const facilityRes = await pgQuery<{ id: string }>(
          `INSERT INTO facilities (user_id, code, name, facility_type, status, address, latitude, longitude, metadata)
             VALUES ($1, $2, COALESCE($3, $2), 'warehouse', 'active', $4::jsonb, $5, $6, $7::jsonb)
           ON CONFLICT (user_id, code) DO UPDATE SET
             status = 'active',
             name = COALESCE($3, facilities.name),
             -- Address + coordinates move together: when a non-empty address is sent, take the new
             -- address AND its (possibly null) coords so we never pair a new address with stale coords.
             -- When no address is sent, keep the existing address and only fill missing coords.
             address = CASE WHEN $8 THEN EXCLUDED.address ELSE facilities.address END,
             latitude = CASE WHEN $8 THEN EXCLUDED.latitude ELSE COALESCE(EXCLUDED.latitude, facilities.latitude) END,
             longitude = CASE WHEN $8 THEN EXCLUDED.longitude ELSE COALESCE(EXCLUDED.longitude, facilities.longitude) END,
             metadata = facilities.metadata || $7::jsonb,
             updated_at = now()
           RETURNING id`,
          [
            userId,
            peerCode,
            facilityName,
            JSON.stringify(hasAddress ? addr : {}),
            lat,
            lon,
            JSON.stringify({ source: 'peer_partner_network', networkEligible: body.networkEligible !== false, ownerWarehouseCode: ownerCode }),
            hasAddress,
          ],
        ).catch((err: any) => { req.log?.error({ err, userId, peerCode }, '[client-network-warehouse] facility upsert failed'); return { rows: [] as Array<{ id: string }> }; });
        const facilityId = facilityRes?.rows?.[0]?.id || null;

        // 3) Upsert the connected network-node link for the client.
        await pgQuery(
          `INSERT INTO oms_warehouse_links (user_id, facility_id, warehouse_code, status, metadata)
             VALUES ($1, $2, $3, 'connected', $4::jsonb)
           ON CONFLICT (user_id, warehouse_code) DO UPDATE SET
             facility_id = EXCLUDED.facility_id,
             status = 'connected',
             connected_at = now(),
             metadata = oms_warehouse_links.metadata || EXCLUDED.metadata,
             updated_at = now()`,
          [
            userId,
            facilityId,
            peerCode,
            JSON.stringify({ source: 'peer_partner_network', ownerWarehouseCode: ownerCode, partnerAcceptedAt: new Date().toISOString() }),
          ],
        ).catch((err: any) => { req.log?.error({ err, userId, peerCode }, '[client-network-warehouse] link upsert failed'); });
        results.push({ status: 'attached', userId });
      }
      return reply.code(200).send({ ok: true, action, warehouseCode: peerCode, results });
    } catch (err: any) {
      req.log?.error({ err }, '[client-network-warehouse] failed');
      return reply.code(500).send({ error: err?.message || 'client-network-warehouse failed' });
    }
  });

  app.get('/internal/cortex/warehouse-register/health', async (_req, reply) => {
    return reply.code(200).send({ ok: true, route: 'cortex-warehouse-register' });
  });
}
