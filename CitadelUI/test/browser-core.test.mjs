import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseBicepParam } from '../shared/bicepparam/parser.mjs';
import { applyPolicyChanges, assertBalancedXml, readPolicyControls } from '../shared/policy.mjs';
import { setRawPolicyDraft } from '../web/js/policy-edit-state.mjs';
import { rewriteContractTemplate } from '../web/js/workspace-service.mjs';

const root = new URL('../../', import.meta.url);
const parameterUrl = new URL(
  'bicep/infra/citadel-access-contracts/main.bicepparam',
  root
);
const policyUrl = new URL(
  'bicep/infra/citadel-access-contracts/policies/default-ai-product-policy.xml',
  root
);
const parameterText = await readFile(parameterUrl, 'utf8');
const policyText = await readFile(policyUrl, 'utf8');

const created = rewriteContractTemplate(parameterText, '../../main.bicep');
assert.doesNotThrow(() => parseBicepParam(created));
const changedLines = parameterText
  .split(/\r?\n/)
  .map((line, index) => (line === created.split(/\r?\n/)[index] ? null : index + 1))
  .filter(Boolean);
assert.equal(changedLines.length, 2, `contract template changed lines: ${changedLines.join(', ')}`);
assert.equal((created.match(/\/\//g) || []).length, (parameterText.match(/\/\//g) || []).length);
assert.match(created, /using '\.\.\/\.\.\/main\.bicep'/);
assert.match(created, /policyXml:\s*loadTextContent\('\.\/ai-product-policy\.xml'\)/);

const controls = readPolicyControls(policyText);
assert.ok(controls.tokenLimit);
const updated = applyPolicyChanges(policyText, {
  tokenLimit: { attributes: { 'tokens-per-minute': 4321 } },
});
assert.equal(
  readPolicyControls(updated).tokenLimit.attributes['tokens-per-minute'].value,
  '4321'
);
assert.throws(() => assertBalancedXml('<policies><inbound></policies>'), /Malformed XML/);
assert.equal(
  policyText.split(/\r?\n/).filter((line, index) => line !== updated.split(/\r?\n/)[index]).length,
  1
);

const policyState = {
  operations: [],
  policyChanges: { tokenLimit: { attributes: { 'tokens-per-minute': '2000' } } },
  policyRaw: null,
};
let pendingActionRefreshes = 0;
setRawPolicyDraft(policyState, `${policyText}\n`, () => {
  pendingActionRefreshes += 1;
});
assert.equal(policyState.policyRaw, `${policyText}\n`);
assert.deepEqual(policyState.policyChanges, {});
assert.equal(pendingActionRefreshes, 1);
assert.equal(
  policyState.operations.length +
    (Object.keys(policyState.policyChanges).length > 0 || policyState.policyRaw !== null ? 1 : 0),
  1,
  'raw input must become pending before the workspace is re-rendered'
);

console.log('browser core: contract and policy fidelity passed');
