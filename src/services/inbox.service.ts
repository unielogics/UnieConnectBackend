import { pgQuery, isPostgresConfigured } from '../db/postgres';

type Row = Record<string, any>;

async function rows<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> {
  if (!isPostgresConfigured()) return [];
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

const map = (r: Row) => ({
  id: r.id,
  subject: r.subject,
  body: r.body ?? undefined,
  fromEmail: r.from_email ?? undefined,
  threadId: r.thread_id ?? undefined,
  eventType: r.event_type ?? undefined,
  warehouseCode: r.warehouse_code ?? undefined,
  read: !!r.read,
  readAt: r.read_at ? new Date(r.read_at).toISOString() : undefined,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
});

export async function listInboxMessages(
  userId: string,
  opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
) {
  const limit = Math.min(100, Math.max(1, opts.limit || 25));
  const offset = Math.max(0, opts.offset || 0);
  const where = ['user_id = $1'];
  const values: unknown[] = [userId];
  if (opts.unreadOnly) where.push('read = false');
  values.push(limit);
  const limitIdx = values.length;
  values.push(offset);
  const offsetIdx = values.length;

  // COUNT(*) OVER() window-function pagination — same pattern as getBillingInvoices
  // (oms-production.service.ts), NOT the LIMIT-200-no-count pattern used by listTickets/
  // getOmsOrders, which is a known latent scaling gap not to be repeated here.
  const data = await rows<Row & { total_count: string }>(
    `SELECT *, COUNT(*) OVER() AS total_count
     FROM oms_mailbox_messages
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    values,
  );
  const total = data.length ? Number(data[0]!.total_count) : 0;
  return { messages: data.map(map), total, limit, offset };
}

export async function markInboxMessageRead(userId: string, id: string) {
  const r = await rows(
    `UPDATE oms_mailbox_messages SET read = true, read_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId],
  );
  if (!r[0]) {
    const err: any = new Error('Message not found');
    err.statusCode = 404;
    throw err;
  }
  return { message: map(r[0]) };
}
