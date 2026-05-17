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
  entityType: r.entity_type ?? undefined,
  entityId: r.entity_id ?? undefined,
  channel: r.channel,
  priority: r.priority,
  status: r.status,
  owner: r.owner ?? undefined,
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
});

export async function listTickets(userId: string) {
  const r = await rows(
    `SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [userId]
  );
  return { tickets: r.map(map) };
}

export async function createTicket(
  userId: string,
  body: {
    subject?: string;
    body?: string;
    entityType?: string;
    entityId?: string;
    channel?: string;
    priority?: string;
  }
) {
  const subject = (body.subject || '').trim();
  if (!subject) {
    const err: any = new Error('subject is required');
    err.statusCode = 400;
    throw err;
  }
  const r = await rows(
    `INSERT INTO support_tickets (user_id, subject, body, entity_type, entity_id, channel, priority, status, owner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', 'Cortex')
     RETURNING *`,
    [
      userId,
      subject,
      body.body || null,
      body.entityType || null,
      body.entityId || null,
      body.channel || 'internal',
      body.priority || 'med',
    ]
  );
  if (!r[0]) {
    const err: any = new Error('Persistence unavailable');
    err.statusCode = 503;
    throw err;
  }
  return { ticket: map(r[0]) };
}

export async function updateTicketStatus(userId: string, id: string, status: string) {
  const r = await rows(
    `UPDATE support_tickets SET status = $3, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, status]
  );
  if (!r[0]) {
    const err: any = new Error('Ticket not found');
    err.statusCode = 404;
    throw err;
  }
  return { ticket: map(r[0]) };
}
