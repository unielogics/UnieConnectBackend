-- Advisory, informational summary of the WMS warehouse-wide pricing profile, pushed per active
-- OMS<->warehouse client link (enqueuePricingProfileOmsSync, billing.controller.ts on the WMS
-- side). Purely a display mirror for the client -- NOT wired into billing_rate_overrides' real
-- savings-projection system (that stays advisory/separate per the existing
-- generateBillingPlanRecommendations design).
CREATE TABLE IF NOT EXISTS wms_pricing_profiles (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  warehouse_code TEXT NOT NULL,
  pricing_profile_id TEXT NOT NULL,
  rate_version INTEGER NOT NULL DEFAULT 1,
  effective_from TIMESTAMPTZ,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, warehouse_code)
);

CREATE INDEX IF NOT EXISTS idx_wms_pricing_profiles_user ON wms_pricing_profiles(user_id);
