/*
 * reconcile-wms-dupes.js  (run ON the OMS box: /var/www/unie-backend)
 *
 * One-off reconciliation for the P0 duplicate-identity bug: before the identity-match fix,
 * WMS fulfillment events INSERTed channel='wms' SHADOW orders/asns instead of updating the
 * client's ORIGINAL native record. This merges each shadow's fulfillment progress back onto
 * the native order/ASN it belongs to (matched by alternativeOrderNumber -> native
 * id/order_number/external_order_id, same user_id), then deletes the shadow.
 *
 *   node reconcile-wms-dupes.js            # DRY-RUN (default): prints what it WOULD do
 *   node reconcile-wms-dupes.js --apply    # APPLY: performs the merges + deletes
 *
 * Safe to re-run: once a shadow is merged+deleted it no longer appears.
 */
const path = require('path');
const { pgQuery } = require(path.join(process.cwd(), 'dist', 'db', 'postgres.js'));

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '[APPLY]' : '[DRY-RUN]';

// Fixed stage-rank; must mirror wmsStatusAllowsTransition in wms-integration.routes.ts.
const ORDER_RANK = { pending: 0, confirmed: 1, picking: 2, packing: 3, ready_to_ship: 4, shipped: 5, completed: 6 };
const ASN_RANK = { 'in-transit': 0, pending: 0, partial: 1, received: 2, completed: 3 };

function allowsTransition(rankMap, current, incoming) {
  const cur = String(current || '').trim().toLowerCase();
  const inc = String(incoming || '').trim().toLowerCase();
  if (!inc) return false;
  if (!cur) return true;
  if (cur === inc) return true;
  if (cur === 'cancelled') return inc === 'cancelled';
  if (inc === 'cancelled') return true;
  const rc = rankMap[cur];
  const ri = rankMap[inc];
  if (rc === undefined || ri === undefined) return true;
  return ri >= rc;
}

function altOf(metadata) {
  if (!metadata || typeof metadata !== 'object') return '';
  const raw = metadata.raw && typeof metadata.raw === 'object' ? metadata.raw : {};
  return String(
    raw.alternativeOrderNumber ||
    metadata.alternativeOrderNumber ||
    raw.poNumber ||
    metadata.poNumber ||
    metadata.externalReference ||
    '',
  ).trim();
}

function isEmptyJson(v) {
  if (v == null) return true;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

async function reconcileOrders() {
  console.log(`\n${tag} ==== ORDERS ====`);
  const shadows = (await pgQuery(
    `SELECT id, user_id, order_number, external_order_id, status, totals, shipping_address,
            tracking_number, metadata
       FROM orders WHERE channel='wms' ORDER BY created_at ASC`,
    [],
  )).rows;
  console.log(`${tag} ${shadows.length} channel='wms' shadow order(s) found`);

  let merged = 0, orphans = 0;
  for (const s of shadows) {
    const alt = altOf(s.metadata);
    if (!alt) { console.log(`${tag}  - shadow ${s.id} (${s.order_number}) has no alternativeOrderNumber -> LEAVE`); orphans++; continue; }
    const native = (await pgQuery(
      `SELECT id, status FROM orders
        WHERE user_id=$1 AND channel<>'wms' AND (id::text=$2 OR order_number=$2 OR external_order_id=$2)
        LIMIT 1`,
      [s.user_id, alt],
    )).rows[0];
    if (!native) { console.log(`${tag}  - shadow ${s.id} (${s.order_number}) alt=${alt} -> NO native match, LEAVE`); orphans++; continue; }

    const applyStatus = allowsTransition(ORDER_RANK, native.status, s.status);
    const newStatus = applyStatus ? s.status : native.status;
    const setTotals = !isEmptyJson(s.totals);
    const setShipping = !isEmptyJson(s.shipping_address);
    console.log(`${tag}  - MERGE shadow ${s.id} (${s.order_number}, ${s.status}) -> native ${native.id} (${native.status}) alt=${alt}`);
    console.log(`${tag}      status:${native.status}->${newStatus}${applyStatus ? '' : ' (guard: keep native)'}  tracking:${s.tracking_number || '-'}  totals:${setTotals}  shipping:${setShipping}`);

    if (APPLY) {
      const wmsMeta = JSON.stringify({
        wmsOrderNumber: s.order_number || undefined,
        wmsEntityId: s.external_order_id || undefined,
        lastWmsSyncAt: (s.metadata && s.metadata.lastWmsSyncAt) || undefined,
        reconciledFromShadow: s.id,
      });
      await pgQuery(
        `UPDATE orders SET
           status=$3,
           totals = CASE WHEN $4::boolean THEN $5::jsonb ELSE totals END,
           shipping_address = CASE WHEN $6::boolean THEN $7::jsonb ELSE shipping_address END,
           tracking_number = COALESCE($8::text, tracking_number),
           metadata = metadata || $9::jsonb,
           updated_at = now()
         WHERE user_id=$1 AND id=$2`,
        [s.user_id, native.id, newStatus, setTotals, JSON.stringify(s.totals || {}),
         setShipping, JSON.stringify(s.shipping_address || {}), s.tracking_number || null, wmsMeta],
      );
      // Move shadow's order_lines onto native ONLY if native has none (don't duplicate the client's lines).
      const nativeLines = (await pgQuery(`SELECT count(*)::int AS n FROM order_lines WHERE user_id=$1 AND order_id=$2`, [s.user_id, native.id])).rows[0].n;
      if (nativeLines === 0) {
        await pgQuery(`UPDATE order_lines SET order_id=$3 WHERE user_id=$1 AND order_id=$2`, [s.user_id, s.id, native.id]);
      } else {
        await pgQuery(`DELETE FROM order_lines WHERE user_id=$1 AND order_id=$2`, [s.user_id, s.id]);
      }
      await pgQuery(`DELETE FROM orders WHERE user_id=$1 AND id=$2`, [s.user_id, s.id]);
    }
    merged++;
  }
  console.log(`${tag} orders: ${merged} merged, ${orphans} left (no match)`);
}

async function reconcileAsns() {
  console.log(`\n${tag} ==== ASNs ====`);
  // Shadow ASNs are those the WMS created carrying an alternativeOrderNumber/poNumber that points
  // at a DIFFERENT native ASN. Detect by: an ASN whose payload has wmsEntityId/alternativeOrderNumber
  // and a sibling native ASN (no wmsEntityId) sharing that reference.
  const wmsAsns = (await pgQuery(
    `SELECT id, user_id, asn_number, status, payload FROM asns
      WHERE payload->>'wmsEntityId' IS NOT NULL ORDER BY created_at ASC`,
    [],
  )).rows;
  console.log(`${tag} ${wmsAsns.length} WMS-stamped ASN(s) found`);

  let merged = 0, orphans = 0;
  for (const s of wmsAsns) {
    const p = s.payload || {};
    const alt = String(p.alternativeOrderNumber || p.poNumber || (p.raw && (p.raw.alternativeOrderNumber || p.raw.poNumber)) || '').trim();
    if (!alt) { orphans++; continue; }
    const native = (await pgQuery(
      `SELECT id, status FROM asns
        WHERE user_id=$1 AND id<>$2 AND (payload->>'wmsEntityId') IS NULL
          AND (asn_number=$3 OR payload->>'poNumber'=$3)
        LIMIT 1`,
      [s.user_id, s.id, alt],
    )).rows[0];
    if (!native) { orphans++; continue; }

    const applyStatus = allowsTransition(ASN_RANK, native.status, s.status);
    const newStatus = applyStatus ? s.status : native.status;
    console.log(`${tag}  - MERGE shadow asn ${s.id} (${s.asn_number}, ${s.status}) -> native ${native.id} (${native.status}) alt=${alt}  status->${newStatus}`);
    if (APPLY) {
      await pgQuery(
        `UPDATE asns SET status=$3, payload = payload || $4::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`,
        [s.user_id, native.id, newStatus, JSON.stringify({ wmsEntityId: p.wmsEntityId, wmsExecution: p, reconciledFromShadow: s.id })],
      );
      await pgQuery(`DELETE FROM asns WHERE user_id=$1 AND id=$2`, [s.user_id, s.id]);
    }
    merged++;
  }
  console.log(`${tag} asns: ${merged} merged, ${orphans} left (no match)`);
}

async function deleteSmoke() {
  console.log(`\n${tag} ==== SMOKE cleanup ====`);
  const rows = (await pgQuery(
    `SELECT id, order_number FROM orders WHERE order_number ILIKE 'SMOKE%' OR external_order_id ILIKE 'SMOKE%'`,
    [],
  )).rows;
  for (const r of rows) {
    console.log(`${tag}  - SMOKE order ${r.id} (${r.order_number}) -> delete`);
    if (APPLY) {
      await pgQuery(`DELETE FROM order_lines WHERE order_id=$1`, [r.id]);
      await pgQuery(`DELETE FROM orders WHERE id=$1`, [r.id]);
    }
  }
  console.log(`${tag} smoke: ${rows.length} row(s)`);
}

async function summary() {
  console.log(`\n${tag} ==== POST-STATE ====`);
  const oc = (await pgQuery(`SELECT channel, count(*)::int AS n FROM orders GROUP BY channel ORDER BY channel`, [])).rows;
  console.log(`${tag} orders by channel:`, oc.map(r => `${r.channel}=${r.n}`).join(' '));
  const wa = (await pgQuery(`SELECT count(*)::int AS n FROM asns WHERE payload->>'wmsEntityId' IS NOT NULL`, [])).rows[0].n;
  console.log(`${tag} asns still WMS-stamped: ${wa}`);
}

(async () => {
  console.log(`${tag} reconcile-wms-dupes starting (APPLY=${APPLY})`);
  await reconcileOrders();
  await reconcileAsns();
  await deleteSmoke();
  await summary();
  console.log(`\n${tag} done. ${APPLY ? 'Changes applied.' : 'No changes made (dry-run). Re-run with --apply to commit.'}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
