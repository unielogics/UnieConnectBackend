/**
 * Debug order status: verify DB values and API response for status/paid.
 * Usage: npx ts-node scripts/debug-order-status.ts
 * Requires: DB_URL in .env
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { normalizeWmsStatus, shopifyFulfillmentToWmsStatus } from '../src/lib/order-status-converter';
import { shopifyFinancialStatusToPaid } from '../src/lib/financial-status-to-paid';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function run() {
  const dbUrl = process.env.DB_URL || '';
  if (!dbUrl) {
    console.error('DB_URL not set in .env');
    process.exit(1);
  }

  await mongoose.connect(dbUrl);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No db');
  const orders = db.collection('orders');

  console.log('\n=== 1. Raw DB: Sample orders (status, wmsStatus, marketplaceStatus, paid) ===\n');
  const docs = await orders.find({}).limit(8).project({
    externalOrderId: 1,
    channel: 1,
    status: 1,
    wmsStatus: 1,
    marketplaceStatus: 1,
    paid: 1,
    'raw.fulfillment_status': 1,
    'raw.financial_status': 1,
  }).toArray();

  if (docs.length === 0) {
    console.log('No orders in DB. Run a Shopify/Amazon sync first.');
    await mongoose.disconnect();
    process.exit(0);
  }

  for (const o of docs) {
    const effectiveDb = o.wmsStatus ?? o.status;
    const apiStatus = normalizeWmsStatus(effectiveDb);
    const raw = o.raw || {};
    console.log(`Order ${o.externalOrderId} (${o.channel}):`);
    console.log(`  DB: status="${o.status}" wmsStatus="${o.wmsStatus ?? 'null'}" marketplaceStatus="${o.marketplaceStatus ?? 'null'}" paid="${o.paid ?? 'null'}"`);
    console.log(`  raw.fulfillment_status="${raw.fulfillment_status ?? 'null'}" raw.financial_status="${raw.financial_status ?? 'null'}"`);
    console.log(`  effectiveStatus (wmsStatus ?? status) = "${effectiveDb}"`);
    console.log(`  normalizeWmsStatus(effective) = "${apiStatus}"`);
    console.log(`  => API would return status="${apiStatus}" paid="${o.paid ?? null}"`);
    console.log();
  }

  console.log('\n=== 2. Check: any orders with status = "paid" (financial, wrong) ===\n');
  const paidStatusCount = await orders.countDocuments({ status: 'paid' });
  const marketplaceStatusPaid = await orders.countDocuments({ marketplaceStatus: 'paid' });
  console.log(`  Orders where status="paid" (BAD - financial in fulfillment field): ${paidStatusCount}`);
  console.log(`  Orders where marketplaceStatus="paid" (OK - stored separately): ${marketplaceStatusPaid}`);

  console.log('\n=== 3. Test mappers (Shopify) ===\n');
  const testCases = [
    { fulfillment: null, financial: 'paid' },
    { fulfillment: 'unfulfilled', financial: 'paid' },
    { fulfillment: 'fulfilled', financial: 'paid' },
    { fulfillment: 'partial', financial: 'pending' },
  ];
  for (const t of testCases) {
    const st = shopifyFulfillmentToWmsStatus(t.fulfillment);
    const pd = shopifyFinancialStatusToPaid(t.financial);
    console.log(`  fulfillment=${JSON.stringify(t.fulfillment)} financial=${t.financial} => status=${st} paid=${pd}`);
  }

  console.log('\n=== 4. Test normalizeWmsStatus ===\n');
  for (const s of ['paid', 'pending', 'open', 'processing', 'shipped', 'unknown', 'fulfilled']) {
    console.log(`  normalizeWmsStatus("${s}") = "${normalizeWmsStatus(s)}"`);
  }

  await mongoose.disconnect();
  console.log('\nDone.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
