import fetch from 'node-fetch';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

type TokenResponse = {
  access_token: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};
type WebhookLog = { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void };

export async function exchangeCodeForToken(shop: string, code: string): Promise<string> {
  const url = `https://${shop}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
      code,
      expiring: 1,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as TokenResponse;
  return body.access_token;
}

export async function ensureShopifyAccessToken(connection: {
  id?: string | null;
  user_id?: string | null;
  shop_domain?: string | null;
  access_token_enc?: string | null;
  refresh_token_enc?: string | null;
  token_expires_at?: string | Date | null;
}) {
  const connectionId = String(connection.id || '').trim();
  const userId = String(connection.user_id || '').trim();
  if (!connectionId || !userId) throw new Error('Shopify connection identity is incomplete.');
  const accessToken = String(connection.access_token_enc || '').trim();
  const expiresAt = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : null;
  if (accessToken && (!expiresAt || expiresAt > Date.now() + 5 * 60 * 1000)) return accessToken;

  const refreshToken = String(connection.refresh_token_enc || '').trim();
  const shopDomain = String(connection.shop_domain || '').trim();
  if (!refreshToken) {
    if (accessToken && !expiresAt) return accessToken;
    throw new Error('Shopify authorization expired. Reconnect the store to continue synchronization.');
  }
  if (!shopDomain) throw new Error('Shopify connection is missing its store domain.');
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || `Shopify token refresh failed (${response.status})`);
  }
  const tokenExpiresAt = new Date(Date.now() + Math.max(60, Number(body.expires_in || 3600)) * 1000);
  await pgQuery(
    `UPDATE marketplace_connections
        SET access_token_enc = $3,
            refresh_token_enc = COALESCE($4, refresh_token_enc),
            token_expires_at = $5,
            metadata = metadata || $6::jsonb,
            updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [
      connectionId,
      userId,
      body.access_token,
      body.refresh_token || null,
      tokenExpiresAt,
      JSON.stringify({
        shopifyTokenType: 'expiring_offline',
        shopifyTokenRefreshedAt: new Date().toISOString(),
        shopifyRefreshTokenExpiresIn: body.refresh_token_expires_in || null,
      }),
    ],
  );
  return body.access_token;
}

export async function registerWebhooks(params: {
  shop: string;
  accessToken: string;
  address: string;
  topics: string[];
  log?: WebhookLog;
}) {
  const { shop, accessToken, address, topics, log } = params;
  const uri = config.shopify.webhookUri || address;
  if (uri !== address || uri.startsWith('pubsub://') || uri.startsWith('arn:aws:events:')) {
    const graphParams: { shop: string; accessToken: string; uri: string; topics: string[]; log?: WebhookLog } = { shop, accessToken, uri, topics };
    if (log) graphParams.log = log;
    return registerGraphqlWebhooks(graphParams);
  }
  const version = config.shopify.apiVersion;
  log?.info?.({ shop, address, version, topicCount: topics.length }, '[Shopify] registerWebhooks start');

  // Fetch existing webhooks to make registration idempotent
  const existingRes = await fetch(
    `https://${shop}/admin/api/${version}/webhooks.json?limit=250`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    },
  );
  if (!existingRes.ok) {
    const errText = await existingRes.text();
    log?.warn?.({ shop, version, status: existingRes.status }, '[Shopify] webhook list failed');
    throw new Error(`Webhook list failed (${existingRes.status}): ${errText.slice(0, 200)}`);
  }
  const existingJson = await existingRes.json();
  const existing = Array.isArray(existingJson?.webhooks) ? existingJson.webhooks : [];
  const existingSet = new Set(
    existing
      .filter((w: any) => w?.topic && w?.address)
      .map((w: any) => `${String(w.topic)}|${String(w.address)}`),
  );
  log?.info?.({ shop, existingCount: existing.length }, '[Shopify] registerWebhooks existing count');

  // Remove callbacks left behind by older UnieConnect deployments. The exact UnieConnect
  // webhook path identifies callbacks owned by this app; topic filtering would leave obsolete
  // fulfillment subscriptions pointing at dead preview/ngrok hosts. Unrelated merchant webhook
  // paths remain untouched.
  const stale = existing.filter((webhook: any) => {
    const existingAddress = String(webhook?.address || '');
    return Boolean(
      webhook?.id
      && existingAddress !== address
      && existingAddress.includes('/api/v1/webhooks/shopify'),
    );
  });
  let removed = 0;
  for (const webhook of stale) {
    const res = await fetch(`https://${shop}/admin/api/${version}/webhooks/${encodeURIComponent(String(webhook.id))}.json`, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (res.ok || res.status === 404) removed++;
    else log?.warn?.({ webhookId: webhook.id, topic: webhook.topic, status: res.status }, '[Shopify] stale webhook removal failed');
  }

  let created = 0;
  for (const topic of topics) {
    if (existingSet.has(`${topic}|${address}`)) {
      continue;
    }
    const res = await fetch(`https://${shop}/admin/api/${version}/webhooks.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        webhook: { topic, address, format: 'json' },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 422) continue;
      log?.warn?.({ topic, status: res.status, text: text.slice(0, 300) }, '[Shopify] webhook create failed');
      throw new Error(`Webhook create failed for ${topic} (${res.status}): ${text.slice(0, 200)}`);
    }
    created++;
  }
  log?.info?.({ shop, created, removed, totalTopics: topics.length }, '[Shopify] registerWebhooks done');
  return { created, removed, existingCount: existing.length };
}

function topicToEnum(topic: string) {
  return topic.trim().replace(/[\/.-]/g, '_').toUpperCase();
}

async function shopifyGraphql(shop: string, accessToken: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json?.errors) {
    throw new Error(`Shopify GraphQL failed (${res.status}): ${JSON.stringify(json?.errors || json).slice(0, 300)}`);
  }
  return json;
}

export async function registerGraphqlWebhooks(params: {
  shop: string;
  accessToken: string;
  uri: string;
  topics: string[];
  log?: WebhookLog;
}) {
  const { shop, accessToken, uri, topics, log } = params;
  log?.info?.({ shop, uri, topicCount: topics.length, version: config.shopify.apiVersion }, '[Shopify] registerGraphqlWebhooks start');
  const existingQuery = `query {
    webhookSubscriptions(first: 250) {
      nodes { id topic uri }
    }
  }`;
  const existingJson = await shopifyGraphql(shop, accessToken, existingQuery, {});
  const existing = Array.isArray(existingJson?.data?.webhookSubscriptions?.nodes) ? existingJson.data.webhookSubscriptions.nodes : [];
  const existingSet = new Set(existing.map((w: any) => `${String(w.topic)}|${String(w.uri)}`));
  const mutation = `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic uri format }
      userErrors { field message }
    }
  }`;
  let created = 0;
  const errors: Record<string, string> = {};
  for (const topic of topics) {
    const topicEnum = topicToEnum(topic);
    if (existingSet.has(`${topicEnum}|${uri}`)) continue;
    const result = await shopifyGraphql(shop, accessToken, mutation, {
      topic: topicEnum,
      webhookSubscription: { uri, format: 'JSON' },
    });
    const userErrors = result?.data?.webhookSubscriptionCreate?.userErrors || [];
    if (Array.isArray(userErrors) && userErrors.length) {
      const message = userErrors.map((e: any) => e?.message).filter(Boolean).join('; ');
      if (/already|taken|exists/i.test(message)) continue;
      errors[topic] = message || 'Webhook subscription rejected';
      log?.warn?.({ shop, topic, uri, message }, '[Shopify] GraphQL webhook create user error');
      continue;
    }
    created++;
  }
  if (Object.keys(errors).length) {
    throw new Error(`Shopify webhook registration partially failed: ${JSON.stringify(errors)}`);
  }
  log?.info?.({ shop, uri, created, totalTopics: topics.length }, '[Shopify] registerGraphqlWebhooks done');
}

export function shopifyWebhookHealth() {
  const defaultHttpUri = config.shopify.appBaseUrl
    ? `${config.shopify.appBaseUrl.replace(/\/+$/, '')}/api/v1/webhooks/shopify`
    : '';
  const uri = config.shopify.webhookUri || defaultHttpUri;
  const deliveryMode = uri.startsWith('pubsub://')
    ? 'google_pubsub'
    : uri.startsWith('arn:aws:events:')
      ? 'amazon_eventbridge'
      : uri
        ? 'https'
        : 'missing';
  return {
    oauthReady: Boolean(config.shopify.clientId && config.shopify.clientSecret && config.shopify.appBaseUrl),
    hasWebhookSecret: Boolean(config.shopify.clientSecret || config.shopify.webhookSecret),
    hasAutomationToken: Boolean(config.shopify.appAutomationToken),
    apiVersion: config.shopify.apiVersion,
    webhookUri: uri || null,
    deliveryMode,
    topics: config.shopify.webhookTopics,
    pubSubServiceAccount: 'delivery@shopify-pubsub-webhooks.iam.gserviceaccount.com',
  };
}

