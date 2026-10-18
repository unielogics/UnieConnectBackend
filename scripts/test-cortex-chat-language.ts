import assert from 'node:assert/strict';
import {
  humanizeInternalLanguage,
  polishCortexChatText,
  scrubVendorLanguage,
} from '../src/services/oms-intelligence.service';

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
  polishCortexChatText('Confidence: 0.80\n\nSources: oms_orders'),
  'Confidence: 80%',
);
assert.equal(
  polishCortexChatText('NVIDIA NIM identified freight as the largest cost driver.'),
  'Cortex identified freight as the largest cost driver.',
);

console.log('Cortex chat language contract passed.');
