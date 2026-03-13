import fetch from 'node-fetch';
import { config } from '../config/env';

type TokenResponse = { access_token: string; scope: string };

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
  log?: { info: (o: object, msg?: string) => void; warn: (o: object, msg?: string) => void };
}) {
  const { shop, accessToken, address, topics, log } = params;
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

