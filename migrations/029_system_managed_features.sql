UPDATE features
SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{systemManaged}', 'true'::jsonb, true),
    updated_at = now()
WHERE id IN (
  'app-studio',
  'cortex-intelligence',
  'carrier-rates',
  'carrier-label-audit',
  'label-audit'
);
