/**
 * Test Shopify sync: login -> channel-accounts -> refresh -> orders -> sync-status.
 * Usage: node scripts/test-shopify-sync.mjs
 * Requires: BACKEND_URL (default http://localhost:4001), UC_TEST_PASSWORD
 */
const BACKEND = (process.env.BACKEND_URL || 'http://localhost:4001').replace(/\/+$/, '');
const EMAIL = process.env.UC_TEST_EMAIL || 'franco@unielogics.com';
const PASSWORD = process.env.UC_TEST_PASSWORD || 'Money123!';

import { appendFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const LOG_PATH = process.env.DEBUG_LOG_PATH || join(__dirname, '..', '..', '..', '.cursor', 'debug.log');
function dlog(msg, data = {}) {
  const line = JSON.stringify({ ts: Date.now(), message: msg, ...data }) + '\n';
  try { appendFileSync(LOG_PATH, line); } catch {}
  console.log('[LOG]', msg, Object.keys(data).length ? data : '');
}

async function run() {
  dlog('test-shopify-sync start', { BACKEND, EMAIL });

  if (!PASSWORD) {
    console.error('Set UC_TEST_PASSWORD or use default');
    process.exit(1);
  }

  try {
    // 1. Login
    dlog('1. Login attempt');
    const loginRes = await fetch(`${BACKEND}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const loginJson = await loginRes.json();
    if (!loginRes.ok) {
      dlog('Login failed', { status: loginRes.status, body: loginJson });
      console.error('Login failed:', loginRes.status, loginJson);
      process.exit(1);
    }
    const token = loginJson.token;
    dlog('Login OK', { hasToken: !!token, userId: loginJson.user?.userId });

    // 2. Get channel accounts
    dlog('2. Fetch channel-accounts');
    const accRes = await fetch(`${BACKEND}/api/v1/channel-accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const accounts = await accRes.json();
    if (!accRes.ok) {
      dlog('channel-accounts failed', { status: accRes.status });
      process.exit(1);
    }
    const shopify = Array.isArray(accounts) ? accounts.find(a => a.channel === 'shopify') : null;
    dlog('Channel accounts', { count: Array.isArray(accounts) ? accounts.length : 0, shopifyId: shopify?.id });

    if (!shopify?.id) {
      dlog('No Shopify account - connect Shopify first');
      console.log('No Shopify account. Connect Shopify in the dashboard first.');
      process.exit(0);
    }

    // 3. Trigger refresh
    dlog('3. POST refresh', { accountId: shopify.id });
    const refreshRes = await fetch(`${BACKEND}/api/v1/channel-accounts/${shopify.id}/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const refreshJson = await refreshRes.json();
    dlog('Refresh response', { status: refreshRes.status, syncResult: refreshJson.syncResult });

    // 4. Get sync status
    dlog('4. Fetch sync-status');
    const statusRes = await fetch(`${BACKEND}/api/v1/channel-accounts/${shopify.id}/sync-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const syncStatus = await statusRes.json();
    dlog('Sync status', { entities: syncStatus?.entities, fullSync: syncStatus?.fullSync });

    // 5. Get orders
    dlog('5. Fetch orders');
    const ordersRes = await fetch(`${BACKEND}/api/v1/orders`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const orders = await ordersRes.json();
    dlog('Orders', { status: ordersRes.status, count: Array.isArray(orders) ? orders.length : 0 });

    // 6. Debug endpoint
    dlog('6. Fetch debug');
    const debugRes = await fetch(`${BACKEND}/api/v1/channel-accounts/${shopify.id}/debug`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const debug = await debugRes.json();
    dlog('Debug', debug);

    console.log('\n=== Summary ===');
    console.log('Sync result:', JSON.stringify(refreshJson.syncResult, null, 2));
    console.log('Orders count:', Array.isArray(orders) ? orders.length : 0);
    console.log('Debug:', JSON.stringify(debug, null, 2));
  } catch (err) {
    dlog('Error', { message: err.message, stack: err.stack });
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
