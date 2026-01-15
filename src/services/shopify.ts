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
}) {
  const { shop, accessToken, address, topics } = params;
  const version = config.shopify.apiVersion;

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
  const existingJson = existingRes.ok ? await existingRes.json() : { webhooks: [] };
  const existing = Array.isArray(existingJson?.webhooks) ? existingJson.webhooks : [];
  const existingSet = new Set(
    existing
      .filter((w: any) => w?.topic && w?.address)
      .map((w: any) => `${String(w.topic)}|${String(w.address)}`),
  );

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
      // If the webhook already exists for this address/topic, Shopify returns 422; ignore.
      if (res.status === 422) {
        continue;
      }
      throw new Error(`Webhook create failed for ${topic} (${res.status}): ${text}`);
    }
  }
}

