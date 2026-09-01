import assert from 'node:assert/strict';

import { policyMatrixRowName } from '../web/js/policynav.mjs';

const heading = (tagName, textContent) => ({
  tagName,
  textContent,
  querySelector: () => null,
});

assert.equal(
  policyMatrixRowName(heading('H4', 'Fallback for models without their own limit')),
  'Fallback for models without their own limit'
);
assert.equal(
  policyMatrixRowName({
    tagName: 'HEADER',
    querySelector: () => heading('H4', 'gpt-5.4-mini'),
  }),
  'gpt-5.4-mini'
);
assert.equal(policyMatrixRowName(null), 'All models');

console.log('Policy matrix row identity checks passed.');
