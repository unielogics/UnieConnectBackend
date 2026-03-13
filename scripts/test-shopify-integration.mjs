#!/usr/bin/env node
/**
 * Test script for Shopify integration debug.
 * Usage: UC_EMAIL=... UC_PASSWORD=... node scripts/test-shopify-integration.mjs
 * Or: node scripts/test-shopify-integration.mjs <email> <password>
 */
const API_BASE = process.env.UC_API_URL || 'https://api.unieconnect.com';
const email = process.env.UC_EMAIL || process.argv[2];
const password = process.env.UC_PASSWORD || process.argv[3];

if (!email || !password) {
  console.error('Usage: UC_EMAIL=... UC_PASSWORD=... node scripts/test-shopify-integration.mjs');
  console.error('   Or: node scripts/test-shopify-integration.mjs <email> <password>');
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
    const text = await loginRes.text();
    console.error('Login failed:', loginRes.status, text);
    process.exit(1);
  }
  const { token } = await loginRes.json();
  if (!token) {
    console.error('No token in response');
    process.exit(1);
  }
  console.log('Login OK, token received\n');

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  console.log('--- 2. Channel Accounts ---');
  const accountsRes = await fetch(`${API_BASE}/api/v1/channel-accounts`, { headers });
  if (!accountsRes.ok) {
    console.error('Channel accounts failed:', accountsRes.status, await accountsRes.text());
    process.exit(1);
  }
  const accounts = await accountsRes.json();
  console.log('Accounts:', JSON.stringify(accounts, null, 2));

  const shopifyAccount = Array.isArray(accounts) ? accounts.find((a) => a.channel === 'shopify') : null;
  if (!shopifyAccount) {
    console.log('\nNo Shopify account found. Connect a store first.');
    return;
  }

  const accountId = shopifyAccount.id || shopifyAccount._id;
  console.log('\n--- 3. Shopify Account Debug ---');
  const debugRes = await fetch(`${API_BASE}/api/v1/channel-accounts/${accountId}/debug`, { headers });
  if (!debugRes.ok) {
    console.error('Debug failed:', debugRes.status, await debugRes.text());
    return;
  }
  const debug = await debugRes.json();
  console.log(JSON.stringify(debug, null, 2));

  console.log('\n--- 4. Trigger Refresh (orders sync) ---');
  const refreshRes = await fetch(`${API_BASE}/api/v1/channel-accounts/${accountId}/refresh`, {
    method: 'POST',
    headers,
  });
  if (!refreshRes.ok) {
    console.error('Refresh failed:', refreshRes.status, await refreshRes.text());
    return;
  }
  const refreshResult = await refreshRes.json();
  console.log('Refresh result:', JSON.stringify(refreshResult, null, 2));

  console.log('\n--- 5. Orders ---');
  const ordersRes = await fetch(`${API_BASE}/api/v1/orders`, { headers });
  if (!ordersRes.ok) {
    console.error('Orders failed:', ordersRes.status, await ordersRes.text());
    return;
  }
  const orders = await ordersRes.json();
  console.log('Order count:', orders?.length ?? 0);
  if (orders?.length > 0) {
    console.log('Latest 3 orders:', JSON.stringify(orders.slice(0, 3).map((o) => ({
      id: o.id || o._id,
      externalOrderId: o.externalOrderId,
      status: o.status,
      placedAt: o.placedAt,
    })), null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
