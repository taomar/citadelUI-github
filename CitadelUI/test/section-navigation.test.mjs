import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

const paramviewSource = readFileSync(new URL('../web/js/paramview.mjs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
const componentStyles = readFileSync(
  new URL('../web/css/components.css', import.meta.url),
  'utf8'
);
assert.match(paramviewSource, /class: `outline\$\{tabs \? ' outline-tabs' : ''\}`/);
assert.doesNotMatch(paramviewSource, /outline-drawer/);
assert.match(appSource, /class: 'sheet-sticky'/);
assert.match(appSource, /renderOutlineNav\(doc, editContext\(doc\), markCurrentSection, 'tabs'\)/);
assert.match(appSource, /function markCurrentSection\(requestedId = null\)/);
assert.match(appSource, /link\.dataset\.section === requestedId/);
assert.match(appSource, /sticky\.getBoundingClientRect\(\)\.bottom[\s\S]*?\+\s*32/);
assert.match(paramviewSource, /const behavior = tabs \? 'auto' : scrollBehavior\(\)/);
assert.match(componentStyles, /\.sheet-sticky\s*\{[\s\S]*?position:\s*sticky/);
assert.match(componentStyles, /\.outline-tabs \.outline-list\s*\{[\s\S]*?overflow-x:\s*auto/);
assert.doesNotMatch(componentStyles, /\.outline-drawer/);

console.log('Section navigation labels are concise and deterministic.');
