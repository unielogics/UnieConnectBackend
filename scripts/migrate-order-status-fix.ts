/**
 * Migration: Fix orders that have financial status (paid, pending, etc.) wrongly stored in status field.
 * Corrects status to fulfillment-based and sets paid from marketplace/financial.
 *
 * Usage: npx ts-node scripts/migrate-order-status-fix.ts
 * (dry run by default; set MIGRATE_DRY_RUN=false to apply)
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { shopifyFulfillmentToWmsStatus } from '../src/lib/order-status-converter';
import { shopifyFinancialStatusToPaid } from '../src/lib/financial-status-to-paid';
import { amazonOrderStatusToWmsStatus } from '../src/lib/order-status-converter';
import { amazonOrderStatusToPaid } from '../src/lib/financial-status-to-paid';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const FINANCIAL_STATUSES = new Set([
  'paid', 'pending', 'authorized', 'refunded', 'voided', 'partially_refunded',
  'open', 'partially_paid',
]);

function isFinancialStatus(s?: string | null): boolean {
  return Boolean(s && FINANCIAL_STATUSES.has((s || '').toLowerCase()));
}

async function run() {
  const dbUrl = process.env.DB_URL || '';
  const dryRun = process.env.MIGRATE_DRY_RUN !== 'false';

  if (!dbUrl) {
    console.error('DB_URL not set');
    process.exit(1);
  }

  await mongoose.connect(dbUrl);
  const Order = mongoose.connection.collection('orders');

  const cursor = Order.find({ status: { $in: Array.from(FINANCIAL_STATUSES) } });
  const toFix: any[] = [];
  for await (const doc of cursor) {
    toFix.push(doc);
  }

  console.log(`\nFound ${toFix.length} orders with financial status in status field.`);
  if (toFix.length === 0) {
    await mongoose.disconnect();
    return;
  }

  if (dryRun) {
    console.log('DRY RUN - no changes applied. Set MIGRATE_DRY_RUN=false to apply.\n');
  }

  let updated = 0;
  for (const o of toFix) {
    const channel = (o.channel || '').toLowerCase();
    let newStatus: string;
    let newPaid: string;

    if (channel === 'shopify' && o.raw) {
      const raw = o.raw;
      newStatus = shopifyFulfillmentToWmsStatus(raw.fulfillment_status);
      newPaid = shopifyFinancialStatusToPaid(raw.financial_status);
    } else if (channel === 'amazon' && o.raw) {
      const raw = o.raw;
      const orderStatus = raw.OrderStatus || raw.order_status || o.status;
      newStatus = amazonOrderStatusToWmsStatus(orderStatus);
      newPaid = amazonOrderStatusToPaid(orderStatus);
    } else {
      newStatus = 'pending';
      newPaid = o.marketplaceStatus ? shopifyFinancialStatusToPaid(o.marketplaceStatus) : 'unknown';
    }

    const update = {
      $set: {
        status: newStatus,
        paid: newPaid,
        marketplaceStatus: channel === 'shopify' && o.raw?.financial_status
          ? o.raw.financial_status
          : o.marketplaceStatus,
      },
    };

    console.log(`  ${o.externalOrderId} (${channel}): status "${o.status}" -> "${newStatus}", paid -> "${newPaid}"`);

    if (!dryRun) {
      await Order.updateOne({ _id: o._id }, update);
      updated++;
    }
  }

  if (!dryRun && updated > 0) {
    console.log(`\nUpdated ${updated} orders.`);
  }

  await mongoose.disconnect();
  console.log('\nDone.\n');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
