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
  const graphParams: { shop: string; accessToken: string; uri: string; topics: string[]; log?: WebhookLog } = { shop, accessToken, uri, topics };
  if (log) graphParams.log = log;
  return registerGraphqlWebhooks(graphParams);
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
  return { created, existingCount: existing.length, deliveryUri: uri };
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

