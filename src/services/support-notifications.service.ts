import { pgQuery } from '../db/postgres';
import { findSqlUserById } from './sql-auth';
import { recentLedger } from './oms-production.service';
import { callWmsInternal } from '../routes/sql-mode.routes';

const SUPPORT_EMAIL = 'support@unielogics.com';

/**
 * OMS has no email-sending infrastructure of its own (no SMTP/SES config on this box) — reuse the
 * WMS's already-proven Mailgun-backed sendEmail via its internal API instead of standing up a
 * brand-new, untested email transport for one internal ops alert.
 */
async function sendPlatformEmail(subject: string, text: string): Promise<void> {
  await callWmsInternal('/internal/oms/support-notify', { subject, text });
}

function formatLedgerRow(row: any): string {
  const when = row.created_at ? new Date(row.created_at).toISOString() : 'unknown time';
  return `  - [${when}] (${row.source_system}/${row.event_type}) ${row.summary}`;
}

/**
 * Called after ANY oms_warehouse_links row for a user reaches status='connected' again (invite
 * redemption, manual admin link, peer-network attach). If that user's fulfillment_status was
 * previously paused/blocked by a severed primary link, restore it to active so the OMS banner
 * (FulfillmentPausedBanner) disappears on next load. A no-op for users who were already active.
 */
export async function resetFulfillmentStatusIfNeeded(userId: string): Promise<void> {
  await pgQuery(
    `UPDATE app_users SET fulfillment_status = 'active', fulfillment_status_note = NULL, fulfillment_status_at = now()
     WHERE id = $1 AND fulfillment_status <> 'active'`,
    [userId],
  ).catch(() => null);
}

/**
 * Emails support@unielogics.com when a client's PRIMARY warehouse relationship is severed
 * (see handleWmsIntermediaryDeleted in wms-integration.routes.ts). Never lets a failure here
 * block the sync event that triggered it — callers must wrap this in try/catch.
 */
export async function sendSupportSeveredClientEmail(params: {
  userId: string;
  warehouseCode: string;
  reason: string;
  deletedBy?: string;
  remainingConnectedCount: number;
}): Promise<void> {
  const { userId, warehouseCode, reason, deletedBy, remainingConnectedCount } = params;

  const profile = await findSqlUserById(userId);
  const [orderCountRes, billedTotalRes, ledgerRows] = await Promise.all([
    pgQuery<{ count: string }>('SELECT count(*) FROM orders WHERE user_id = $1', [userId]).catch(() => null),
    pgQuery<{ total: string | null }>('SELECT sum(amount) AS total FROM invoice_lines WHERE user_id = $1', [userId]).catch(() => null),
    recentLedger(userId, 25),
  ]);

  const orderCount = orderCountRes?.rows?.[0]?.count || '0';
  const billedTotal = billedTotalRes?.rows?.[0]?.total || '0';
  const clientLabel = profile
    ? `${[profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.email} <${profile.email}>`
    : userId;

  const escalation = remainingConnectedCount === 0
    ? 'ESCALATED: client now has NO active warehouse connection — needs immediate attention.'
    : `Client still has ${remainingConnectedCount} other connected warehouse link(s) — degraded, not fully down.`;

  const subject = `[UnieConnect] Client severed from warehouse ${warehouseCode}${remainingConnectedCount === 0 ? ' — NO warehouses left' : ''}`;
  const text = [
    `A warehouse deleted a client's relationship in UnieWMS.`,
    ``,
    `Client: ${clientLabel}`,
    `User ID: ${userId}`,
    `Severed warehouse: ${warehouseCode}`,
    `Reason given: ${reason || '(none provided)'}`,
    `Deleted by: ${deletedBy || 'unknown'}`,
    `Severed at: ${new Date().toISOString()}`,
    ``,
    escalation,
    ``,
    `Account activity summary:`,
    `  Total orders: ${orderCount}`,
    `  Total billed (invoice_lines): $${billedTotal}`,
    ``,
    `Recent OMS activity (last ${ledgerRows.length}):`,
    ...(ledgerRows.length ? ledgerRows.map(formatLedgerRow) : ['  (no ledger activity found)']),
  ].join('\n');

  await sendPlatformEmail(subject, text);
}
