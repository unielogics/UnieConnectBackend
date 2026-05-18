import { pgQuery, isPostgresConfigured } from '../db/postgres';
import { prefixForEntity, publicEntityId } from '../lib/public-id';

type Row = Record<string, any>;

async function rows<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> {
  if (!isPostgresConfigured()) return [];
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

const map = (r: Row) => ({
  id: r.id,
  publicId: publicEntityId('TI', r.id),
  displayId: publicEntityId('TI', r.id),
  subject: r.subject,
  body: r.body ?? undefined,
  entityType: r.entity_type ?? undefined,
  entityId: r.entity_id ?? undefined,
  entityDisplayId: r.entity_id ? publicEntityId(prefixForEntity(r.entity_type), r.entity_id) : undefined,
  linkedEntityDisplayId: r.entity_id ? publicEntityId(prefixForEntity(r.entity_type), r.entity_id) : undefined,
  channel: r.channel,
  priority: r.priority,
  status: r.status,
  owner: r.owner ?? undefined,
  messagesCount: Number(r.messages_count || 0),
  attachmentsCount: Number(r.attachments_count || 0),
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
  updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
});

const mapMessage = (r: Row) => ({
  id: r.id,
  publicId: publicEntityId('TI', r.id),
  ticketId: r.ticket_id,
  authorType: r.author_type || 'client',
  authorName: r.author_name || undefined,
  body: r.body || '',
  attachments: Array.isArray(r.attachments) ? r.attachments : [],
  createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
});

export async function listTickets(userId: string) {
  const r = await rows(
    `SELECT t.*,
            COUNT(m.id)::int AS messages_count,
            COALESCE(SUM(jsonb_array_length(COALESCE(m.attachments, '[]'::jsonb))), 0)::int AS attachments_count
     FROM support_tickets t
     LEFT JOIN support_ticket_messages m ON m.ticket_id = t.id AND m.user_id = t.user_id
     WHERE t.user_id = $1
     GROUP BY t.id
     ORDER BY t.created_at DESC
     LIMIT 200`,
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

export async function getTicketDetail(userId: string, id: string) {
  const tickets = await rows(
    `SELECT t.*,
            COUNT(m.id)::int AS messages_count,
            COALESCE(SUM(jsonb_array_length(COALESCE(m.attachments, '[]'::jsonb))), 0)::int AS attachments_count
     FROM support_tickets t
     LEFT JOIN support_ticket_messages m ON m.ticket_id = t.id AND m.user_id = t.user_id
     WHERE t.user_id = $1 AND t.id = $2
     GROUP BY t.id
     LIMIT 1`,
    [userId, id],
  );
  if (!tickets[0]) {
    const err: any = new Error('Ticket not found');
    err.statusCode = 404;
    throw err;
  }
  const messages = await rows(
    `SELECT * FROM support_ticket_messages
     WHERE user_id = $1 AND ticket_id = $2
     ORDER BY created_at ASC`,
    [userId, id],
  );
  return { ticket: map(tickets[0]), messages: messages.map(mapMessage) };
}

export async function addTicketMessage(
  userId: string,
  id: string,
  body: {
    body?: string;
    authorType?: string;
    authorName?: string;
    attachments?: Array<Record<string, unknown>>;
  },
) {
  const text = String(body.body || '').trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!text && attachments.length === 0) {
    const err: any = new Error('message body or attachment is required');
    err.statusCode = 400;
    throw err;
  }

  const ticket = await rows('SELECT * FROM support_tickets WHERE user_id = $1 AND id = $2 LIMIT 1', [userId, id]);
  if (!ticket[0]) {
    const err: any = new Error('Ticket not found');
    err.statusCode = 404;
    throw err;
  }

  const inserted = await rows(
    `INSERT INTO support_ticket_messages
      (user_id, ticket_id, author_type, author_name, body, attachments)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      userId,
      id,
      String(body.authorType || 'client'),
      body.authorName || null,
      text || null,
      JSON.stringify(attachments),
    ],
  );

  await pgQuery(
    `UPDATE support_tickets
     SET status = CASE WHEN status = 'resolved' THEN status ELSE 'in-progress' END,
         updated_at = now()
     WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );

  if (!inserted[0]) {
    const err: any = new Error('Message was not persisted');
    err.statusCode = 503;
    throw err;
  }
  return { message: mapMessage(inserted[0]) };
}
