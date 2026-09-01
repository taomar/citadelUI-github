import assert from 'node:assert/strict';

import {
  readSubscriptionIdFromText,
  validateAzdEnvironmentName,
  validateSubscriptionId,
  writeSubscriptionIdToText,
} from '../web/js/subscription-env.mjs';

const original = [
  '# azd values',
  'SECRET_VALUE="never expose or change"',
  'AZURE_SUBSCRIPTION_ID="11111111-1111-1111-1111-111111111111" # target only',
  'ANOTHER_SECRET=still-untouched',
  '',
].join('\r\n');
const updated = writeSubscriptionIdToText(
  original,
  '22222222-2222-2222-2222-222222222222'
);

assert.deepEqual(readSubscriptionIdFromText(original), {
  found: true,
  value: '11111111-1111-1111-1111-111111111111',
  valid: true,
});
assert.equal(
  updated.replace('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111'),
  original
);
assert.match(updated, /SECRET_VALUE="never expose or change"/);
assert.match(updated, /ANOTHER_SECRET=still-untouched/);
assert.equal(
  readSubscriptionIdFromText('OTHER=value\n').value,
  ''
);
assert.match(
  writeSubscriptionIdToText(
    'OTHER=value\n',
    '33333333-3333-3333-3333-333333333333'
  ),
  /^OTHER=value\nAZURE_SUBSCRIPTION_ID="33333333-3333-3333-3333-333333333333"\n$/
);
assert.throws(
  () => readSubscriptionIdFromText(
    'AZURE_SUBSCRIPTION_ID="11111111-1111-1111-1111-111111111111"\n' +
    'AZURE_SUBSCRIPTION_ID="22222222-2222-2222-2222-222222222222"\n'
  ),
  /more than once/
);
assert.throws(
  () => readSubscriptionIdFromText('AZURE_SUBSCRIPTION_ID="unterminated\n'),
  /unsupported \.env syntax/
);
assert.throws(() => validateSubscriptionId('not-a-guid'), /complete Azure subscription GUID/);
assert.equal(validateAzdEnvironmentName('citadel-dev'), 'citadel-dev');
assert.throws(() => validateAzdEnvironmentName('../prod'), /safe azd environment/);

console.log('Subscription-only azd environment editing checks passed.');
