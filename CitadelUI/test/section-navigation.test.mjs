import assert from 'node:assert/strict';

import { sectionNavTitle } from '../web/js/paramview.mjs';

const names = new Map([
  ['BASIC PARAMETERS', 'Basics'],
  ['FEATURE FLAGS - Deploy specific capabilities', 'Features'],
  ['RESOURCE NAMES - Assign custom names to different provisioned services', 'Resources'],
  ['MONITORING - Log Analytics configuration', 'Monitoring'],
  ['NETWORKING PARAMETERS - Network configuration and access controls', 'Networking'],
  ['INFERENCE API DIAGNOSTIC LOG SETTINGS', 'Inference logs'],
  ['COMPUTE SKU & SIZE - SKUs and capacity settings', 'Compute'],
  ['ACCELERATOR SPECIFIC PARAMETERS', 'Accelerator'],
  ['ENTRA ID AUTHENTICATION', 'Entra ID'],
  ['API Management (APIM) Configuration', 'APIM'],
  ['APIM Managed Identity Configuration', 'Managed identity'],
  ['LLM Backend Configuration Array', 'Backends'],
  ['Circuit Breaker Configuration', 'Circuit breaker'],
  ['Circuit Breaker Defaults', 'Breaker defaults'],
  ['Session Affinity (Sticky Routing)', 'Session affinity'],
  ['Session Affinity Defaults', 'Affinity defaults'],
  ['Model Aliases', 'Model aliases'],
]);

for (const [source, expected] of names) {
  assert.equal(sectionNavTitle(source), expected);
}
assert.equal(sectionNavTitle('Short custom section'), 'Short custom section');
assert.equal(
  sectionNavTitle('Extremely long custom section name without a delimiter'),
  'Extremely long custom'
);

console.log('Section navigation labels are concise and deterministic.');
