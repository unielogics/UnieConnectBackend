CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS oms_intelligence_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  source_priority TEXT NOT NULL DEFAULT 'marketplace_first',
  source_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC,
  cortex_status TEXT,
  cortex_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_product_research_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES oms_intelligence_runs(id) ON DELETE SET NULL,
  item_id TEXT REFERENCES catalog_items(id) ON DELETE SET NULL,
  sku TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC,
  source_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_seller_optimization_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES oms_intelligence_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_double JSONB NOT NULL DEFAULT '{}'::jsonb,
  inventory_plan JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES oms_intelligence_runs(id) ON DELETE SET NULL,
  recommendation_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  current_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  optimized_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_impact JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_action TEXT,
  approval_state TEXT NOT NULL DEFAULT 'draft',
  wms_truth_state TEXT NOT NULL DEFAULT 'forecast_only',
  confidence NUMERIC,
  source_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'open',
  rejection_reason TEXT,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_recommendation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  recommendation_id UUID REFERENCES oms_recommendations(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oms_intelligence_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES oms_intelligence_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oms_intel_runs_user_type_created ON oms_intelligence_runs(user_id, run_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_product_research_user_sku_created ON oms_product_research_results(user_id, sku, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_seller_opt_user_created ON oms_seller_optimization_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_recommendations_user_status_created ON oms_recommendations(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oms_recommendations_user_entity ON oms_recommendations(user_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_oms_intel_events_run_created ON oms_intelligence_run_events(run_id, created_at DESC);

INSERT INTO features (id, name, description, category, status, price, payload)
VALUES (
  'product-research',
  'Product Research',
  'Analyze individual products or bulk CSV catalogs with Cortex enrichment, marketplace signals, pallet economics, and warehouse-fit intelligence.',
  'optimization',
  'active',
  0,
  '{
    "isMarketplaceApp": true,
    "tags": ["ai", "product-research", "csv", "marketplace", "featured"],
    "unlockedScreens": ["product-research"],
    "requiredConnections": ["Marketplace connection preferred", "CSV product data fallback", "SKU dimensions and cost improve confidence"],
    "setupSteps": ["Connect marketplace or upload CSV", "Run single item or bulk analysis", "Review SKU intelligence", "Feed Optimize Suite"],
    "metadata": {
      "appType": "addon",
      "navGroup": "optimize",
      "navGroupLabel": "Optimize",
      "navIcon": "sparkle",
      "unlockedScreens": ["product-research"],
      "requiredConnections": ["Marketplace connection preferred", "CSV product data fallback", "SKU dimensions and cost improve confidence"]
    },
    "pricing": { "type": "free", "currency": "USD" },
    "marketplaceOrder": 105
  }'::jsonb
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
  name = 'Optimize Suite',
  description = 'Seller Optimization powered by marketplace connections first, with CSV/manual fallback, WMS truth, Business Double, Inventory Plan, and current-vs-optimized impact across the OMS.',
  payload = payload || '{
    "tags": ["featured", "ai", "inventory", "forecast", "seller-optimization"],
    "requiredConnections": ["Marketplace connection preferred", "CSV/manual fallback", "WMS inventory truth improves execution"],
    "setupSteps": ["Connect marketplace data", "Connect WMS truth", "Run Seller Optimization", "Review Business Double", "Approve guarded plan"],
    "metadata": {
      "summary": "Marketplace-first Seller Optimization across Business Double, Inventory Plan, SKU, supplier, order, shipment, billing, and audit views."
    }
  }'::jsonb,
  updated_at = now()
WHERE id = 'optimize-suite';
