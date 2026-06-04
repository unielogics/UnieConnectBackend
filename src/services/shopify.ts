import fetch from 'node-fetch';
import { config } from '../config/env';

type TokenResponse = { access_token: string; scope: string };
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
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as TokenResponse;
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
  log?.info?.({ shop, created, totalTopics: topics.length }, '[Shopify] registerWebhooks done');
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
    hasWebhookSecret: Boolean(config.shopify.webhookSecret),
    hasAutomationToken: Boolean(config.shopify.appAutomationToken),
    apiVersion: config.shopify.apiVersion,
    webhookUri: uri || null,
    deliveryMode,
    topics: config.shopify.webhookTopics,
    pubSubServiceAccount: 'delivery@shopify-pubsub-webhooks.iam.gserviceaccount.com',
  };
}

