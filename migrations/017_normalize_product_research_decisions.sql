UPDATE oms_recommendations
SET
  recommendation_type = 'data_readiness',
  approval_state = 'blocked',
  required_action = 'complete_missing_product_data',
  optimized_value = jsonb_build_object(
    'action', 'Complete the missing baseline fields before Cortex creates an optimization decision.',
    'requiredFields', COALESCE(current_value->'missingFields', '[]'::jsonb)
  ),
  estimated_impact = jsonb_build_object(
    'confidenceGain', GREATEST(0, 90 - ROUND(COALESCE(confidence, 0)::numeric * 100)),
    'confidence', confidence
  ),
  updated_at = now()
WHERE recommendation_type = 'product_research'
  AND approval_state = 'blocked';

UPDATE oms_recommendations
SET
  approval_state = 'not_required',
  required_action = 'feed_optimize_suite',
  optimized_value = optimized_value || jsonb_build_object(
    'action', 'Use this SKU in Optimize Suite when reviewing inventory placement and replenishment.'
  ),
  updated_at = now()
WHERE recommendation_type = 'product_research'
  AND approval_state IN ('waiting_approval', 'draft')
  AND COALESCE(estimated_impact->>'monthlySavings', '') = ''
  AND COALESCE(estimated_impact->>'annualizedSavings', '') = '';
