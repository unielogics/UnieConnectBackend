/**
 * Test Connect to Warehouse flow: login -> oms/connect with connection code.
 * Usage: node scripts/test-connect-warehouse.mjs
 * Set UC_TEST_PASSWORD, UC_TEST_EMAIL, CONNECTION_CODE in env.
 */
const BACKEND = process.env.BACKEND_URL || 'http://localhost:4001';
const EMAIL = process.env.UC_TEST_EMAIL || 'franco@unielogics.com';
const PASSWORD = process.env.UC_TEST_PASSWORD || '';
const CONNECTION_CODE = process.env.CONNECTION_CODE || 'NJ-834048';

async function run() {
  console.log('=== Connect to Warehouse Debug ===');
  console.log('Backend:', BACKEND);
  console.log('Email:', EMAIL);
  console.log('Connection code:', CONNECTION_CODE);

  if (!PASSWORD) {
    console.error('Set UC_TEST_PASSWORD');
    process.exit(1);
  }

  try {
    console.log('\n1. Login...');
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
      console.error('No token in login response');
      process.exit(1);
    }
    console.log('   OK, token received');

    console.log('\n2. POST /api/v1/oms/connect with connectionCode...');
    const connectRes = await fetch(`${BACKEND}/api/v1/oms/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.trim()}`,
      },
      body: JSON.stringify({ connectionCode: CONNECTION_CODE.trim() }),
    });
    const connectJson = await connectRes.json();

    console.log('   Status:', connectRes.status);
    console.log('   Response:', JSON.stringify(connectJson, null, 2));

    if (connectRes.ok) {
      console.log('\n✅ Connect to warehouse SUCCESS');
      if (connectJson.warehouseCode) {
        console.log('   Warehouse:', connectJson.warehouseCode);
      }
    } else {
      console.log('\n❌ Connect to warehouse FAILED');
      if (connectJson.error) console.log('   Error:', connectJson.error);
      if (connectJson.message) console.log('   Message:', connectJson.message);
      process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
