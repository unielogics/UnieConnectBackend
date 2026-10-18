import assert from 'node:assert/strict';
import {
  cortexChatDeliveryState,
  humanizeInternalLanguage,
  polishCortexChatText,
  scrubVendorLanguage,
} from '../src/services/oms-intelligence.service';

assert.deepEqual(cortexChatDeliveryState('live'), {
  available: true,
  integrated: true,
  live: true,
  mode: 'live',
  reason: 'live_chat_available',
});
assert.equal(cortexChatDeliveryState('account_grounded').available, true);
assert.equal(cortexChatDeliveryState('account_grounded').reason, 'account_grounded_answer');
assert.equal(cortexChatDeliveryState('fallback').available, false);
assert.equal(cortexChatDeliveryState('account_scoped').available, false);
assert.equal(cortexChatDeliveryState('unavailable').integrated, false);

const vendorAnswer = scrubVendorLanguage('NVIDIA NIM uses NVIDIA GPU drivers for inference.');
assert.equal(vendorAnswer.includes('NVIDIA'), false);
assert.equal(vendorAnswer.includes('NIM'), false);
assert.equal(vendorAnswer.includes('GPU driver'), false);
assert.match(vendorAnswer, /Cortex/);

assert.equal(
  scrubVendorLanguage('The largest cost drivers are freight and storage.'),
  'The largest cost drivers are freight and storage.',
);
assert.equal(
  scrubVendorLanguage('The delivery driver needs the supplier pickup instructions.'),
  'The delivery driver needs the supplier pickup instructions.',
);

assert.equal(
  humanizeInternalLanguage('Set facility_sqft in network-context facility_profile.'),
  'add warehouse square footage to the warehouse profile.',
);
assert.equal(
  humanizeInternalLanguage('Grant read_locations before using oms_marketplace_connections.'),
  'Grant Shopify location inventory access before using marketplace connections.',
);
assert.equal(
  polishCortexChatText('Confidence: 0.80\n\nSources: oms_orders'),
  'Confidence: 80%',
);
assert.equal(
  polishCortexChatText('NVIDIA NIM identified freight as the largest cost driver.'),
  'Cortex identified freight as the largest cost driver.',
);
assert.equal(
  polishCortexChatText('```json\n{"answer":"Reconnect Shopify and approve read_locations.","confidence":0.8}\n```'),
  'Reconnect Shopify and approve Shopify location inventory access.',
);

console.log('Cortex chat language contract passed.');
