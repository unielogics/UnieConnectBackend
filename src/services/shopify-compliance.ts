import { pgQuery, withPgTransaction } from '../db/postgres';

type ComplianceTopic = 'customers/data_request' | 'customers/redact' | 'shop/redact';

const trim = (value: unknown) => String(value ?? '').trim();

export async function ensureShopifyComplianceSchema() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS shopify_compliance_requests (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      webhook_id TEXT NOT NULL UNIQUE,
      shop_domain TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      error TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pgQuery(
    'CREATE INDEX IF NOT EXISTS idx_shopify_compliance_status_received ON shopify_compliance_requests(status, received_at)',
  );
}

export async function enqueueShopifyComplianceWebhook(params: {
  webhookId: string;
  shopDomain: string;
  topic: ComplianceTopic;
  payload: any;
}) {
  await ensureShopifyComplianceSchema();
  const result = await pgQuery<{ id: string; status: string }>(
    `INSERT INTO shopify_compliance_requests (webhook_id, shop_domain, topic, request_payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (webhook_id)
     DO UPDATE SET updated_at = now()
     RETURNING id, status`,
    [params.webhookId, params.shopDomain, params.topic, JSON.stringify(params.payload || {})],
  );
  return result?.rows[0] || null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(trim).filter(Boolean) : [];
}

async function findShopifyAccount(shopDomain: string) {
  const result = await pgQuery<{
    id: string;
    user_id: string;
    shop_domain: string;
  }>(
    `SELECT id, user_id, shop_domain
       FROM marketplace_connections
      WHERE channel = 'shopify' AND lower(shop_domain) = lower($1)
      ORDER BY updated_at DESC
      LIMIT 1`,
    [shopDomain],
  );
  return result?.rows[0] || null;
}

async function writeComplianceLedger(
  userId: string,
  accountId: string,
  eventType: string,
  summary: string,
  payload: Record<string, unknown>,
) {
  await pgQuery(
    `INSERT INTO oms_execution_ledger
      (user_id, entity_type, entity_id, event_type, source_system, summary, payload)
     VALUES ($1, 'marketplace_connection', $2, $3, 'shopify', $4, $5::jsonb)`,
    [userId, accountId, eventType, summary, JSON.stringify(payload)],
  ).catch(() => null);
}

async function recordCustomerDataRequest(
  account: { id: string; user_id: string },
  payload: any,
  webhookId: string | null,
) {
  const customerId = trim(payload?.customer?.id);
  const requestedOrders = stringList(payload?.orders_requested);
  const result = await pgQuery<{ customer_count: number; order_count: number }>(
    `SELECT
       (SELECT COUNT(*)::int
          FROM customer_channel_mappings
         WHERE user_id = $1 AND channel_connection_id = $2
           AND ($3 = '' OR external_customer_id = $3)) AS customer_count,
       (SELECT COUNT(*)::int
          FROM orders
         WHERE user_id = $1 AND channel_connection_id = $2
           AND (cardinality($4::text[]) = 0 OR external_order_id = ANY($4::text[]))) AS order_count`,
    [account.user_id, account.id, customerId, requestedOrders],
  );
  const counts = result?.rows[0] || { customer_count: 0, order_count: 0 };
  await writeComplianceLedger(
    account.user_id,
    account.id,
    'shopify_customer_data_request_received',
    'Shopify customer data access request received.',
    {
      webhookId,
      customerId: customerId || null,
      requestedOrderIds: requestedOrders,
      matchedCustomers: Number(counts.customer_count || 0),
      matchedOrders: Number(counts.order_count || 0),
    },
  );
  return { action: 'data_request_recorded', ...counts };
}

async function redactCustomer(
  account: { id: string; user_id: string },
  payload: any,
  webhookId: string | null,
) {
  const customerId = trim(payload?.customer?.id);
  const orderIds = stringList(payload?.orders_to_redact);
  const result = await withPgTransaction(async (client) => {
    const mapped = customerId
      ? await client.query<{ customer_id: string }>(
          `SELECT customer_id
             FROM customer_channel_mappings
            WHERE user_id = $1 AND channel_connection_id = $2 AND external_customer_id = $3`,
          [account.user_id, account.id, customerId],
        )
      : { rows: [] as Array<{ customer_id: string }> };
    const customerIds = [...new Set(mapped.rows.map((row) => row.customer_id).filter(Boolean))];

    const orders = await client.query(
      `UPDATE orders
          SET customer_id = NULL,
              shipping_address = '{}'::jsonb,
              billing_address = '{}'::jsonb,
              tracking_number = NULL,
              metadata = jsonb_build_object('privacyRedacted', true, 'privacyRedactedAt', now()),
              updated_at = now()
        WHERE user_id = $1 AND channel_connection_id = $2
          AND (
            (cardinality($3::text[]) > 0 AND external_order_id = ANY($3::text[]))
            OR (cardinality($4::text[]) > 0 AND customer_id = ANY($4::text[]))
          )`,
      [account.user_id, account.id, orderIds, customerIds],
    );

    if (customerId) {
      await client.query(
        `DELETE FROM customer_channel_mappings
          WHERE user_id = $1 AND channel_connection_id = $2 AND external_customer_id = $3`,
        [account.user_id, account.id, customerId],
      );
    }
    const customers = customerIds.length
      ? await client.query(
          `UPDATE customers
              SET name = 'Redacted customer', email = NULL, phone = NULL, company = NULL,
                  addresses = '[]'::jsonb,
                  metadata = jsonb_build_object('privacyRedacted', true, 'privacyRedactedAt', now()),
                  updated_at = now()
            WHERE user_id = $1 AND id = ANY($2::text[])`,
          [account.user_id, customerIds],
        )
      : { rowCount: 0 };
    return { redactedCustomers: customers.rowCount || 0, redactedOrders: orders.rowCount || 0 };
  });

  const summary = result || { redactedCustomers: 0, redactedOrders: 0 };
  await writeComplianceLedger(
    account.user_id,
    account.id,
    'shopify_customer_redacted',
    'Shopify customer personal data was redacted.',
    { webhookId, customerId: customerId || null, requestedOrderIds: orderIds, ...summary },
  );
  return { action: 'customer_redacted', ...summary };
}

async function redactShop(
  account: { id: string; user_id: string },
  webhookId: string | null,
) {
  const result = await withPgTransaction(async (client) => {
    const itemMappings = await client.query<{ item_id: string }>(
      `DELETE FROM item_channel_mappings
        WHERE user_id = $1 AND channel_connection_id = $2
        RETURNING item_id`,
      [account.user_id, account.id],
    );
    const customerMappings = await client.query<{ customer_id: string }>(
      `DELETE FROM customer_channel_mappings
        WHERE user_id = $1 AND channel_connection_id = $2
        RETURNING customer_id`,
      [account.user_id, account.id],
    );
    const orders = await client.query(
      'DELETE FROM orders WHERE user_id = $1 AND channel_connection_id = $2',
      [account.user_id, account.id],
    );
    const customerIds = [...new Set(customerMappings.rows.map((row) => row.customer_id).filter(Boolean))];
    const customers = customerIds.length
      ? await client.query(
          `DELETE FROM customers c
            WHERE c.user_id = $1 AND c.id = ANY($2::text[])
              AND NOT EXISTS (SELECT 1 FROM customer_channel_mappings m WHERE m.customer_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)`,
          [account.user_id, customerIds],
        )
      : { rowCount: 0 };
    const itemIds = [...new Set(itemMappings.rows.map((row) => row.item_id).filter(Boolean))];
    const items = itemIds.length
      ? await client.query(
          `DELETE FROM catalog_items i
            WHERE i.user_id = $1 AND i.id = ANY($2::text[])
              AND NOT EXISTS (SELECT 1 FROM item_channel_mappings m WHERE m.item_id = i.id)
              AND NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.item_id = i.id)`,
          [account.user_id, itemIds],
        )
      : { rowCount: 0 };
    await client.query('DELETE FROM marketplace_connections WHERE id = $1 AND user_id = $2', [account.id, account.user_id]);
    return {
      deletedOrders: orders.rowCount || 0,
      deletedCustomers: customers.rowCount || 0,
      deletedItems: items.rowCount || 0,
      deletedItemMappings: itemMappings.rowCount || 0,
      deletedCustomerMappings: customerMappings.rowCount || 0,
    };
  });
  await writeComplianceLedger(
    account.user_id,
    account.id,
    'shopify_shop_redacted',
    'Shopify store data and credentials were removed.',
    { webhookId, ...(result || {}) },
  );
  return { action: 'shop_redacted', ...(result || {}) };
}

export async function processShopifyComplianceWebhook(params: {
  shopDomain: string;
  topic: ComplianceTopic;
  payload: any;
  webhookId?: string | null;
}) {
  const shopDomain = trim(params.shopDomain || params.payload?.shop_domain).toLowerCase();
  if (!shopDomain) throw new Error('Shopify compliance webhook is missing shop domain');
  const account = await findShopifyAccount(shopDomain);
  if (!account) return { action: 'no_stored_shop_data' };
  const webhookId = trim(params.webhookId) || null;
  if (params.topic === 'customers/data_request') return recordCustomerDataRequest(account, params.payload, webhookId);
  if (params.topic === 'customers/redact') return redactCustomer(account, params.payload, webhookId);
  return redactShop(account, webhookId);
}

export async function processQueuedShopifyComplianceWebhook(id: string) {
  const queued = await pgQuery<{
    id: string;
    webhook_id: string;
    shop_domain: string;
    topic: ComplianceTopic;
    status: string;
    request_payload: any;
  }>(
    `UPDATE shopify_compliance_requests
        SET status = 'processing', updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'failed')
      RETURNING id, webhook_id, shop_domain, topic, status, request_payload`,
    [id],
  );
  const request = queued?.rows[0];
  if (!request) return { action: 'already_processed' };
  try {
    const result = await processShopifyComplianceWebhook({
      shopDomain: request.shop_domain,
      topic: request.topic,
      payload: request.request_payload,
      webhookId: request.webhook_id,
    });
    await pgQuery(
      `UPDATE shopify_compliance_requests
          SET status = 'completed', response_payload = $2::jsonb,
              request_payload = CASE WHEN topic IN ('customers/redact', 'shop/redact') THEN '{}'::jsonb ELSE request_payload END,
              error = NULL, completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(result || {})],
    );
    return result;
  } catch (error: any) {
    await pgQuery(
      `UPDATE shopify_compliance_requests
          SET status = 'failed', error = $2, updated_at = now()
        WHERE id = $1`,
      [id, error?.message || 'Compliance processing failed'],
    ).catch(() => null);
    throw error;
  }
}
