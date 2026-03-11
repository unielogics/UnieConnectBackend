/**
 * Test UnieConnect auth flow: login -> user/features.
 * Usage: node scripts/test-auth.mjs
 * Requires: BACKEND_URL (default http://localhost:4001), and a valid user in DB.
 *
 * Set UC_TEST_EMAIL and UC_TEST_PASSWORD in env, or edit below.
 */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:4001';
const EMAIL = process.env.UC_TEST_EMAIL || 'franco@unielogics.com';
const PASSWORD = process.env.UC_TEST_PASSWORD || '';

async function run() {
  console.log('Testing UnieConnect auth at', BACKEND);
  console.log('Login with', EMAIL);

  if (!PASSWORD) {
    console.error('Set UC_TEST_PASSWORD in env, e.g: $env:UC_TEST_PASSWORD="yourpassword"; node scripts/test-auth.mjs');
    process.exit(1);
  }

  try {
    const loginRes = await fetch(`${BACKEND}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const loginJson = await loginRes.json();

    if (!loginRes.ok) {
      console.error('Login failed:', loginRes.status, loginJson);
      process.exit(1);
    }

    const token = loginJson.token;
    if (!token) {
      console.error('Login OK but no token in response');
      process.exit(1);
    }
    console.log('Login OK, token received');

    // Try auth/me first (auth plugin) then user/features (main plugin)
    const meRes = await fetch(`${BACKEND}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token.trim()}` },
    });
    const meJson = await meRes.json();
    if (!meRes.ok) {
      console.error('auth/me failed:', meRes.status, meJson);
      process.exit(1);
    }
    console.log('auth/me OK');

    const featuresRes = await fetch(`${BACKEND}/api/v1/user/features`, {
      headers: { Authorization: `Bearer ${token.trim()}` },
    });
    const featuresText = await featuresRes.text();
    const featuresJson = (() => { try { return JSON.parse(featuresText); } catch { return {}; } })();

    if (!featuresRes.ok) {
      console.error('user/features failed:', featuresRes.status, featuresJson);
      process.exit(1);
    }

    console.log('user/features OK:', featuresJson.features?.length ?? 0, 'features');
    console.log('Auth flow works.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
