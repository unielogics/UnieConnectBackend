#!/usr/bin/env node
/**
 * Disconnect Shopify store and get reconnect URL.
 * Usage: node scripts/redo-shopify-connection.mjs <email> <password>
 */
const API_BASE = process.env.UC_API_URL || 'https://api.unieconnect.com';
const SHOP = process.env.SHOP || 'unielogics-test-1.myshopify.com';
const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error('Usage: node scripts/redo-shopify-connection.mjs <email> <password>');
  process.exit(1);
}

async function main() {
  console.log('--- 1. Login ---');
  const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    console.error('Login failed:', loginRes.status, await loginRes.text());
    process.exit(1);
  }
  const { token } = await loginRes.json();
  if (!token) {
    console.error('No token');
    process.exit(1);
  }
  console.log('OK\n');

  const headers = { Authorization: `Bearer ${token}` };

  console.log('--- 2. Get channel accounts ---');
  const accountsRes = await fetch(`${API_BASE}/api/v1/channel-accounts`, { headers });
  const accounts = await accountsRes.json();
  const shopify = Array.isArray(accounts) ? accounts.find((a) => a.channel === 'shopify') : null;
  if (!shopify) {
    console.log('No Shopify account - nothing to disconnect\n');
  } else {
    const accountId = shopify.id || shopify._id;
    console.log('Disconnecting:', shopify.shopDomain, '(id:', accountId, ')\n');

    console.log('--- 3. Disconnect (DELETE) ---');
    const delRes = await fetch(`${API_BASE}/api/v1/channel-accounts/${accountId}`, {
      method: 'DELETE',
      headers,
    });
    if (!delRes.ok) {
      console.error('Delete failed:', delRes.status, await delRes.text());
      process.exit(1);
    }
    console.log('Disconnected OK\n');
  }

  console.log('--- 4. Get OAuth start URL ---');
  const startUrl = `${API_BASE}/api/v1/auth/shopify/start?shop=${encodeURIComponent(SHOP)}&tenantId=default&format=json`;
  const startRes = await fetch(startUrl, {
    headers: { ...headers, Accept: 'application/json' },
  });
  if (!startRes.ok) {
    console.error('Start failed:', startRes.status, await startRes.text());
    process.exit(1);
  }
  const { url } = await startRes.json();
  if (!url) {
    console.error('No URL in response');
    process.exit(1);
  }

  console.log('\n=== OPEN THIS URL IN YOUR BROWSER TO RECONNECT ===\n');
  console.log(url);
  console.log('\n==================================================\n');
  console.log('After you complete the OAuth flow in the browser,');
  console.log('check Settings > Notifications > Webhooks in the store admin.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
