#!/usr/bin/env node
// scripts/seed-demo-data.js
//
// Idempotent demo seed for an OMS account: 1 marketplace connection, 50 SKUs,
// 200 orders across 30 days, 6 facilities, 1 supplier with pickup profile, 1
// connected WMS link. Sized so getDataReadiness() returns a 'ready' posture
// (score ≥ 85) and seller-optimization yields visible monthly savings.
//
// All rows are tagged metadata.source='demo' so a future real marketplace
// connection can supersede them.
//
// Usage:
//   node scripts/seed-demo-data.js <userId>
//   node scripts/seed-demo-data.js --wipe-demo <userId>   # remove only demo rows

process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv/config');
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const { getPostgresPool } = require('/var/www/unie-backend/dist/db/postgres.js');
const { randomUUID } = require('crypto');

const argv = process.argv.slice(2);
const wipe = argv.includes('--wipe-demo');
const userId = argv.filter(a => !a.startsWith('--'))[0];
if (!userId) {
  console.error('usage: seed-demo-data.js [--wipe-demo] <userId>');
  process.exit(2);
}

const FACILITIES = [
  { code: 'ATL1', name: 'Atlanta Hub', city: 'Atlanta', state: 'GA', lat: 33.7, lon: -84.4 },
  { code: 'DFW2', name: 'Dallas Hub', city: 'Dallas', state: 'TX', lat: 32.8, lon: -96.8 },
  { code: 'EWR4', name: 'Newark Hub', city: 'Newark', state: 'NJ', lat: 40.7, lon: -74.2 },
  { code: 'ONT3', name: 'Ontario Hub', city: 'Ontario', state: 'CA', lat: 34.1, lon: -117.6 },
  { code: 'ORD5', name: 'Chicago Hub', city: 'Chicago', state: 'IL', lat: 41.9, lon: -87.9 },
  { code: 'SEA6', name: 'Seattle Hub', city: 'Seattle', state: 'WA', lat: 47.6, lon: -122.3 },
];

const SKU_TEMPLATES = [
  { cat: 'Kitchen', sub: 'Cookware', basePrice: 39.99, baseCost: 14.5, weight: 2.3, dims: { length: 12, width: 10, height: 5 } },
  { cat: 'Kitchen', sub: 'Storage', basePrice: 24.99, baseCost: 8.8, weight: 1.6, dims: { length: 11, width: 8, height: 6 } },
  { cat: 'Supplements', sub: 'Vitamins', basePrice: 28.5, baseCost: 6.2, weight: 0.6, dims: { length: 4, width: 4, height: 5 } },
  { cat: 'Supplements', sub: 'Protein', basePrice: 49.99, baseCost: 17.0, weight: 3.1, dims: { length: 6, width: 6, height: 9 } },
  { cat: 'Electronics', sub: 'Cables', basePrice: 19.99, baseCost: 3.8, weight: 0.4, dims: { length: 7, width: 4, height: 1 } },
  { cat: 'Electronics', sub: 'Accessories', basePrice: 34.99, baseCost: 9.2, weight: 0.9, dims: { length: 8, width: 5, height: 2 } },
  { cat: 'Apparel', sub: 'Tees', basePrice: 22.5, baseCost: 5.5, weight: 0.5, dims: { length: 10, width: 8, height: 1 } },
  { cat: 'Apparel', sub: 'Accessories', basePrice: 16.99, baseCost: 4.1, weight: 0.3, dims: { length: 7, width: 6, height: 1 } },
];

const STATE_DISTRIBUTION = ['CA', 'TX', 'FL', 'NY', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI', 'NJ', 'WA', 'AZ', 'MA', 'TN'];

function jitter(base, pct) { return base * (1 + (Math.random() - 0.5) * 2 * pct); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function wipeDemo(p) {
  console.log('[wipe] removing demo rows for', userId);
  await p.query(`DELETE FROM orders WHERE user_id=$1 AND metadata->>'source'='demo'`, [userId]);
  await p.query(`DELETE FROM item_channel_mappings WHERE user_id=$1 AND payload->>'source'='demo'`, [userId]);
  await p.query(`DELETE FROM catalog_items WHERE user_id=$1 AND metadata->>'source'='demo'`, [userId]);
  await p.query(`DELETE FROM marketplace_connections WHERE user_id=$1 AND metadata->>'source'='demo'`, [userId]);
  await p.query(`DELETE FROM suppliers WHERE user_id=$1 AND metadata->>'source'='demo'`, [userId]);
  await p.query(`DELETE FROM oms_warehouse_links WHERE user_id=$1 AND metadata->>'source'='demo'`, [userId]);
  await p.query(`DELETE FROM facilities WHERE user_id=$1 AND metadata->>'source'='demo'`, [userId]);
  console.log('[wipe] done');
}

async function seed(p) {
  // 1. Marketplace connection
  const mcId = randomUUID();
  await p.query(
    `INSERT INTO marketplace_connections (id, user_id, channel, status, display_name, shop_domain, marketplace_id, scopes, metadata, last_sync_at)
     VALUES ($1,$2,'shopify','connected','Demo Shopify Storefront','demo-store.myshopify.com','demo-shopify',$3,$4::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
    [mcId, userId, ['read_orders', 'read_products'], JSON.stringify({ source: 'demo', display_provider: 'shopify' })],
  );
  console.log('[seed] marketplace_connection', mcId);

  // 2. Facilities (shared across users; only insert if missing per code)
  for (const f of FACILITIES) {
    await p.query(
      `INSERT INTO facilities (id, user_id, code, name, facility_type, status, address, latitude, longitude, metadata)
       VALUES ($1,$2,$3,$4,'distribution_center','active',$5::jsonb,$6,$7,$8::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        userId,
        f.code,
        f.name,
        JSON.stringify({ city: f.city, state: f.state, country: 'US' }),
        f.lat,
        f.lon,
        JSON.stringify({ source: 'demo' }),
      ],
    );
  }
  console.log('[seed] facilities ×', FACILITIES.length);

  // 3. Supplier with pickup profile
  const supplierId = randomUUID();
  await p.query(
    `INSERT INTO suppliers (id, user_id, name, email, phone, status, address, metadata)
     VALUES ($1,$2,'Pacific Source Co.','ops@pacificsource.demo','+1-555-0142','active',$3::jsonb,$4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      supplierId,
      userId,
      JSON.stringify({ line1: '320 Industrial Blvd', city: 'Ontario', state: 'CA', postalCode: '91761', country: 'US' }),
      JSON.stringify({
        source: 'demo',
        leadTime: 14,
        onTime: 0.96,
        qualityPass: 0.98,
        paymentTerms: 'NET 30',
        pickupProfile: {
          loadingDock: true,
          maxVehicleSize: '53ft',
          hoursOfOperation: 'Mon-Fri 07:00-16:00 PT',
          equipmentRequired: ['pallet_jack'],
          appointmentRequired: true,
          dockAppointmentLeadTimeHours: 24,
          liftgateRequired: false,
          insidePickup: false,
          palletExchange: false,
          pickupInstructions: 'Drivers check in at dock 3.',
          contactName: 'Maria Vega',
        },
      }),
    ],
  );
  console.log('[seed] supplier', supplierId);

  // 4. WMS link
  await p.query(
    `INSERT INTO oms_warehouse_links (id, user_id, warehouse_code, status, connection_code, connected_at, metadata)
     VALUES ($1,$2,'ATL1','connected','DEMO-WMS-LINK', now(), $3::jsonb)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), userId, JSON.stringify({ source: 'demo', system: 'uniewms' })],
  );
  console.log('[seed] oms_warehouse_links');

  // 5. Catalog items (50 SKUs)
  const SKU_COUNT = 50;
  const itemIds = [];
  for (let i = 0; i < SKU_COUNT; i++) {
    const tpl = SKU_TEMPLATES[i % SKU_TEMPLATES.length];
    const id = randomUUID();
    const sku = `DEMO-${tpl.cat.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(4, '0')}`;
    const price = Number(jitter(tpl.basePrice, 0.1).toFixed(2));
    const cost = Number(jitter(tpl.baseCost, 0.08).toFixed(2));
    const velocity30d = Math.round(jitter(80, 0.6));
    await p.query(
      `INSERT INTO catalog_items
         (id, user_id, sku, title, description, attributes, default_uom, tags, supplier_id, asin, category, sub_category, weight, dimensions, archived, wms_inventory, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'each',$7,$8,$9,$10,$11,$12,$13::jsonb,false,$14::jsonb,$15::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        userId,
        sku,
        `${tpl.cat} ${tpl.sub} item ${i + 1}`,
        `Demo ${tpl.cat} > ${tpl.sub} SKU used to populate the AI demo dataset.`,
        JSON.stringify({ price, cost, marginPct: ((price - cost) / price) * 100 }),
        ['demo', tpl.cat.toLowerCase()],
        supplierId,
        `B0DEMO${String(i + 1).padStart(4, '0')}`,
        tpl.cat,
        tpl.sub,
        tpl.weight,
        JSON.stringify(tpl.dims),
        JSON.stringify({
          ATL1: Math.round(velocity30d * 0.6),
          DFW2: Math.round(velocity30d * 0.5),
          EWR4: Math.round(velocity30d * 0.4),
        }),
        JSON.stringify({ source: 'demo', velocity30d, importSource: 'demo_seed' }),
      ],
    );
    itemIds.push({ id, sku });
    // channel mapping
    await p.query(
      `INSERT INTO item_channel_mappings (id, user_id, item_id, channel_connection_id, channel, channel_item_id, channel_variant_id, sku, status, payload)
       VALUES ($1,$2,$3,$4,'shopify',$5,$6,$7,'active',$8::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        randomUUID(),
        userId,
        id,
        mcId,
        `gid://shopify/Product/demo${i + 1}`,
        `gid://shopify/ProductVariant/demo${i + 1}-v1`,
        sku,
        JSON.stringify({ source: 'demo' }),
      ],
    );
  }
  console.log('[seed] catalog_items ×', SKU_COUNT, '+ channel mappings');

  // 6. Orders (200 over the last 30 days)
  const ORDER_COUNT = 200;
  const now = Date.now();
  for (let i = 0; i < ORDER_COUNT; i++) {
    const item = pick(itemIds);
    const state = pick(STATE_DISTRIBUTION);
    const placed = new Date(now - Math.floor(Math.random() * 30 * 86400_000));
    const qty = 1 + Math.floor(Math.random() * 3);
    const lineTotal = Number((qty * (10 + Math.random() * 80)).toFixed(2));
    await p.query(
      `INSERT INTO orders (id, user_id, channel_connection_id, channel, external_order_id, order_number, status, paid, placed_at, totals, shipping_address, billing_address, metadata)
       VALUES ($1,$2,$3,'shopify',$4,$5,$6,'paid',$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        randomUUID(),
        userId,
        mcId,
        `SHOP-DEMO-${10000 + i}`,
        `#D${10000 + i}`,
        i < ORDER_COUNT * 0.85 ? 'fulfilled' : 'open',
        placed,
        JSON.stringify({ subtotal: lineTotal, shipping: 5.99, tax: lineTotal * 0.07, total: lineTotal + 5.99 + lineTotal * 0.07, currency: 'USD', units: qty }),
        JSON.stringify({ name: `Demo Customer ${i + 1}`, city: 'Demoville', state, postalCode: '00000', country: 'US' }),
        JSON.stringify({ name: `Demo Customer ${i + 1}`, city: 'Demoville', state, postalCode: '00000', country: 'US' }),
        JSON.stringify({ source: 'demo', sku: item.sku, itemId: item.id, qty }),
      ],
    );
  }
  console.log('[seed] orders ×', ORDER_COUNT);
}

(async () => {
  const p = getPostgresPool();
  if (!p) {
    console.error('Postgres not configured.');
    process.exit(1);
  }
  if (wipe) {
    await wipeDemo(p);
  } else {
    await seed(p);
  }
  // readiness preview
  const r = await p.query(
    `SELECT
       (SELECT COUNT(*) FROM marketplace_connections WHERE user_id=$1)::int AS mc,
       (SELECT COUNT(*) FROM catalog_items WHERE user_id=$1)::int AS items,
       (SELECT COUNT(*) FROM orders WHERE user_id=$1)::int AS orders,
       (SELECT COUNT(*) FROM facilities WHERE user_id=$1)::int AS facilities,
       (SELECT COUNT(*) FROM oms_warehouse_links WHERE user_id=$1 AND status='connected')::int AS wms_links,
       (SELECT COUNT(*) FROM suppliers WHERE user_id=$1)::int AS suppliers`,
    [userId],
  );
  console.log('\n[done] counts:', r.rows[0]);
  await p.end();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
