INSERT INTO features (id, name, description, category, status, price, payload)
VALUES
  (
    'core-command-center',
    'Core Command Center',
    'Lean OMS home with operating status, setup prompts, and next actions.',
    'core',
    'active',
    0,
    '{"isCore":true,"isStandard":true,"isMarketplaceApp":false,"tags":["core"],"metadata":{"unlockedScreens":["command"],"navGroup":"overview","navLabel":"Command Center","navIcon":"cockpit"},"marketplaceOrder":10}'::jsonb
  ),
  (
    'core-inventory',
    'Core Inventory',
    'Basic SKU, supplier, and shipment planning records required to operate the OMS.',
    'core',
    'active',
    0,
    '{"isCore":true,"isStandard":true,"isMarketplaceApp":false,"tags":["core"],"metadata":{"unlockedScreens":["skus","suppliers","shipments"],"navGroup":"inventory","navLabel":"Inventory","navIcon":"inventory"},"marketplaceOrder":20}'::jsonb
  ),
  (
    'core-orders',
    'Core Orders',
    'Basic customer and order records for manual, CSV, API, and marketplace intake.',
    'core',
    'active',
    0,
    '{"isCore":true,"isStandard":true,"isMarketplaceApp":false,"tags":["core"],"metadata":{"unlockedScreens":["orders","customers"],"navGroup":"sales","navLabel":"Orders","navIcon":"orders"},"marketplaceOrder":30}'::jsonb
  ),
  (
    'core-connections',
    'Core Connections',
    'Account setup, API keys, WMS links, carrier links, and marketplace connection health.',
    'core',
    'active',
    0,
    '{"isCore":true,"isStandard":true,"isMarketplaceApp":false,"tags":["core","api"],"metadata":{"unlockedScreens":["connections"],"navGroup":"system","navLabel":"Connections","navIcon":"plug"},"marketplaceOrder":40}'::jsonb
  ),
  (
    'core-marketplace',
    'Core Marketplace',
    'Install apps and open App Studio to customize the OMS.',
    'core',
    'active',
    0,
    '{"isCore":true,"isStandard":true,"isMarketplaceApp":false,"tags":["core","apps"],"metadata":{"unlockedScreens":["marketplace"],"navGroup":"marketplace","navLabel":"Marketplace","navIcon":"grid"},"marketplaceOrder":50}'::jsonb
  ),
  (
    'core-support',
    'Core Support',
    'Support tickets and account help for OMS operations.',
    'core',
    'active',
    0,
    '{"isCore":true,"isStandard":true,"isMarketplaceApp":false,"tags":["core"],"metadata":{"unlockedScreens":["support"],"navGroup":"system","navLabel":"Support","navIcon":"support"},"marketplaceOrder":60}'::jsonb
  ),
  (
    'app-studio',
    'App Studio',
    'Guided setup for private apps, API keys, third-party APIs, AI employees, and guarded workflows.',
    'marketplace',
    'active',
    0,
    '{"isCore":true,"isStandard":true,"isMarketplaceApp":false,"tags":["core","api","workflow","ai-employees"],"metadata":{"route":"marketplace","navLabel":"App Studio","navIcon":"studio","unlockedScreens":["marketplace"]},"setupSteps":["Create API key","Connect third-party API","Create workflow","Test event","Deploy"],"marketplaceOrder":70}'::jsonb
  ),
  (
    'optimize-suite',
    'Optimize Suite',
    'Unlock Business Double, Inventory Plan, placement economics, and optimization recommendations.',
    'optimization',
    'active',
    0,
    '{"isMarketplaceApp":true,"tags":["featured","ai","inventory","forecast"],"unlockedScreens":["double","plan"],"requiredConnections":["Marketplace or CSV data","WMS inventory truth"],"setupSteps":["Connect sales data","Connect WMS","Review Business Double","Approve plan"],"metadata":{"appType":"suite","navGroup":"optimize","navGroupLabel":"Optimize","navIcon":"double","unlockedScreens":["double","plan"],"requiredConnections":["Marketplace or CSV data","WMS inventory truth"]},"pricing":{"type":"free","currency":"USD"},"marketplaceOrder":100}'::jsonb
  ),
  (
    'finance-suite',
    'Finance Suite',
    'Unlock Billing & Profit plus Audits & Claims for current versus optimized cost control.',
    'finance',
    'active',
    0,
    '{"isMarketplaceApp":true,"tags":["finance","billing","claims"],"unlockedScreens":["billing","audits"],"requiredConnections":["WMS billing events","Carrier evidence"],"setupSteps":["Connect billing feed","Import carrier invoices","Review claim rules"],"metadata":{"appType":"suite","navGroup":"finance","navGroupLabel":"Finance","navIcon":"billing","unlockedScreens":["billing","audits"],"requiredConnections":["WMS billing events","Carrier evidence"]},"pricing":{"type":"free","currency":"USD"},"marketplaceOrder":110}'::jsonb
  ),
  (
    'inventory-heatmap',
    'Inventory Heatmap',
    'Map demand, warehouse coverage, stock risk, and regional placement gaps.',
    'analytics',
    'active',
    0,
    '{"isMarketplaceApp":true,"tags":["map","inventory","analytics"],"unlockedScreens":["heatmap"],"requiredConnections":["Sales history","Warehouse inventory"],"setupSteps":["Connect demand source","Connect WMS","Open heatmap"],"metadata":{"appType":"widget","navGroup":"inventory","navIcon":"map","unlockedScreens":["heatmap"],"requiredConnections":["Sales history","Warehouse inventory"]},"pricing":{"type":"free","currency":"USD"},"marketplaceOrder":120}'::jsonb
  ),
  (
    'advanced-analytics',
    'Advanced Analytics Ledger',
    'Expose the intelligence ledger and cross-system decision history for power users.',
    'analytics',
    'active',
    0,
    '{"isMarketplaceApp":true,"tags":["ledger","analytics","audit"],"unlockedScreens":["ledger"],"requiredConnections":["OMS activity"],"setupSteps":["Enable app","Review ledger"],"metadata":{"appType":"analytics","navGroup":"system","navIcon":"ledger","unlockedScreens":["ledger"],"requiredConnections":["OMS activity"]},"pricing":{"type":"free","currency":"USD"},"marketplaceOrder":130}'::jsonb
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  status = EXCLUDED.status,
  price = EXCLUDED.price,
  payload = EXCLUDED.payload,
  updated_at = now();

UPDATE features
SET
  name = 'Marketplace Connections',
  description = 'Connect Amazon, Shopify, eBay, CSV, and custom commerce feeds.',
  category = 'marketplace',
  status = 'active',
  payload = '{
    "isMarketplaceApp": true,
    "tags": ["marketplace", "connections", "csv", "api"],
    "unlockedScreens": ["connections"],
    "requiredConnections": ["Amazon, Shopify, eBay, CSV, or custom API"],
    "setupSteps": ["Choose channel", "Authorize or upload CSV", "Verify sync health"],
    "metadata": {
      "appType": "connector",
      "navGroup": "system",
      "navIcon": "plug",
      "unlockedScreens": ["connections"],
      "requiredConnections": ["Amazon, Shopify, eBay, CSV, or custom API"]
    },
    "pricing": { "type": "free", "currency": "USD" },
    "marketplaceOrder": 90
  }'::jsonb,
  updated_at = now()
WHERE id = 'marketplace-connections';

UPDATE features
SET
  name = 'Carrier Label Audit',
  description = 'Audit carrier labels, late delivery, refunds, and disputes from uploads or carrier evidence.',
  category = 'audit',
  status = 'active',
  payload = '{
    "isMarketplaceApp": true,
    "tags": ["audit", "carrier", "refunds"],
    "unlockedScreens": ["labels"],
    "requiredConnections": ["Carrier invoices or label CSV"],
    "setupSteps": ["Upload labels", "Connect carrier evidence", "Review findings"],
    "metadata": {
      "appType": "audit",
      "navGroup": "sales",
      "navIcon": "audit",
      "unlockedScreens": ["labels"],
      "requiredConnections": ["Carrier invoices or label CSV"]
    },
    "pricing": { "type": "free", "currency": "USD" },
    "marketplaceOrder": 115
  }'::jsonb,
  updated_at = now()
WHERE id = 'label-audit';

INSERT INTO user_features (user_id, feature_id, status, payload)
SELECT u.id, f.id, 'enabled', '{"source":"migration_core_default"}'::jsonb
FROM app_users u
JOIN features f ON f.id IN (
  'core-command-center',
  'core-inventory',
  'core-orders',
  'core-connections',
  'core-marketplace',
  'core-support',
  'app-studio'
)
ON CONFLICT (user_id, feature_id) DO NOTHING;

UPDATE app_users
SET enabled_features = (
  SELECT ARRAY(
    SELECT DISTINCT value
    FROM unnest(COALESCE(enabled_features, ARRAY[]::TEXT[]) || ARRAY[
      'core-command-center',
      'core-inventory',
      'core-orders',
      'core-connections',
      'core-marketplace',
      'core-support',
      'app-studio'
    ]::TEXT[]) AS value
    WHERE value <> ''
  )
), updated_at = now();
