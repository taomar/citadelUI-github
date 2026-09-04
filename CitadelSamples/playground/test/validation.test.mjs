/**
 * Validation matrices: required, conditional, typed, and the acknowledgement
 * guards that stand between a risky recipe and an executor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE, acknowledgementFor, buildSamplePlan, getSample, validateSample } from '../src/catalogue/index.mjs';
import { coerceValue, errorsOf, evaluateCondition, isBlank, validateFields } from '../src/core/validation.mjs';
import { createUnavailableExecutor, runPlan } from '../src/core/executor.mjs';
import { makeEmptyReader, makeFixtureReader } from './helpers/fixtures.mjs';

function errorPaths(sample, read) {
  return errorsOf(validateSample(sample, read).issues).map((issue) => issue.path);
}

test('a blank, whitespace, empty-array or REPLACE value counts as not supplied', () => {
  for (const value of ['', '   ', 'REPLACE', null, undefined, []]) {
    assert.equal(isBlank(value), true, `${JSON.stringify(value)} should be blank`);
  }
  for (const value of ['x', 0, false, ['a']]) {
    assert.equal(isBlank(value), false, `${JSON.stringify(value)} should not be blank`);
  }
});

test('required hub fields block every recipe that uses them', () => {
  const read = makeEmptyReader();
  // Discovery binds both APIM reads to the configured subscription and group.
  const discovery = errorPaths(getSample('apim-discovery'), read);
  assert.deepEqual(discovery, ['hub.subscriptionId', 'hub.resourceGroupName']);

  // The context check reads only the subscription id.
  const context = errorPaths(getSample('azure-context-check'), read);
  assert.deepEqual(context, ['hub.subscriptionId']);

  // A subscription-scoped deployment needs all four, because it writes them
  // into the parameter file and names the deployment location.
  const publish = errorPaths(getSample('publish-assets'), read);
  for (const path of ['hub.subscriptionId', 'hub.resourceGroupName', 'hub.apimName', 'hub.location']) {
    assert.ok(publish.includes(path), `publish-assets must be blocked by ${path}`);
  }
});

test('a recipe is never blocked by a shared-profile field it does not read', () => {
  const read = makeEmptyReader();
  // Key Vault verification needs the hub subscription only as the fallback.
  const kvVerify = errorPaths(getSample('access-contract-kv-verify'), read);
  assert.ok(kvVerify.includes('hub.subscriptionId'));
  assert.ok(kvVerify.includes('keyVault.name'));
  const externalKv = errorPaths(
    getSample('access-contract-kv-verify'),
    makeEmptyReader({ 'keyVault.subscriptionId': '99999999-8888-7777-6666-555555555555' }),
  );
  assert.ok(!externalKv.includes('hub.subscriptionId'), 'an external vault subscription removes the hub fallback');

  // The A2A card recipe lists the Foundry profile but never reads it.
  const card = errorPaths(getSample('a2a-agent-card'), read);
  assert.ok(!card.some((path) => path.startsWith('foundry.')), 'no Foundry field may block the agent-card recipe');
});

test('a complete configuration produces no errors for any recipe', () => {
  const read = makeFixtureReader();
  for (const sample of CATALOGUE.samples) {
    const result = validateSample(sample, read);
    assert.equal(
      result.satisfied,
      true,
      `${sample.id} is not satisfied: ${JSON.stringify(errorsOf(result.issues))}`,
    );
  }
});

test('conditional Foundry fields are required only when the A2A asset is on', () => {
  const sample = getSample('publish-assets');
  const withoutFoundry = {
    'foundry.accountName': '',
    'foundry.projectName': '',
    'foundry.agentName': '',
  };

  const on = errorPaths(sample, makeFixtureReader({ ...withoutFoundry, 'foundry.enableA2aAsset': true }));
  assert.deepEqual(on.sort(), ['foundry.accountName', 'foundry.agentName', 'foundry.projectName']);

  const off = errorPaths(sample, makeFixtureReader({ ...withoutFoundry, 'foundry.enableA2aAsset': false }));
  assert.deepEqual(off, [], 'nothing should be required when the A2A asset is off');
});

test('the Key Vault name is required only when Key Vault publishing is on', () => {
  const sample = getSample('access-contract-deploy');
  const on = errorPaths(sample, makeFixtureReader({ 'keyVault.name': '', 'keyVault.useAccessContractKv': true }));
  assert.ok(on.includes('keyVault.name'));

  const off = errorPaths(sample, makeFixtureReader({ 'keyVault.name': '', 'keyVault.useAccessContractKv': false }));
  assert.ok(!off.includes('keyVault.name'));
});

test('the conditional matrix holds for every conditional entry every sample declares', () => {
  let checked = 0;
  for (const sample of CATALOGUE.samples) {
    for (const entry of sample.configurationEntries) {
      if (entry.requirement !== 'conditional') continue;
      checked += 1;
      const read = makeFixtureReader({ [entry.path]: '' });
      const holds = evaluateCondition(entry.requiredWhen, read);
      const paths = errorPaths(sample, read);
      assert.equal(
        paths.includes(entry.path),
        holds,
        `${sample.id}: ${entry.path} required=${paths.includes(entry.path)} but its condition holds=${holds}`,
      );
    }
  }
  assert.ok(checked >= 8, `the catalogue should declare conditional entries; found ${checked}`);
});

test('type validation rejects a non-numeric integer, an out-of-range value and a bad GUID', () => {
  const fields = [
    { name: 'count', label: 'Count', type: 'integer', classification: 'required', min: 1, max: 10 },
  ];
  const bad = validateFields(fields, () => 'twelve');
  assert.ok(bad.issues.some((issue) => /whole number/.test(issue.message)));

  const high = validateFields(fields, () => '99');
  assert.ok(high.issues.some((issue) => /at most 10/.test(issue.message)));

  const low = validateFields(fields, () => '0');
  assert.ok(low.issues.some((issue) => /at least 1/.test(issue.message)));

  const guid = validateFields(
    [
      {
        name: 'subscriptionId',
        label: 'Subscription',
        type: 'string',
        classification: 'required',
        pattern: /^[0-9a-f-]{36}$/,
        patternMessage: 'Subscription ID must be a GUID.',
      },
    ],
    () => 'not-a-guid',
  );
  assert.ok(guid.issues.some((issue) => /must be a GUID/.test(issue.message)));
});

test('an https-only URL field rejects http and a bare host', () => {
  const fields = [{ name: 'gatewayUrl', label: 'Gateway URL', type: 'url', classification: 'required' }];
  for (const value of ['http://example.net', 'example.net', 'ftp://example.net']) {
    const result = validateFields(fields, () => value);
    assert.ok(result.issues.some((issue) => /https:\/\/ URL/.test(issue.message)), `${value} should be rejected`);
  }
  assert.equal(validateFields(fields, () => 'https://example.net').issues.length, 0);
});

test('Foundry account names cannot alter the credentialed PATCH origin', () => {
  const sample = getSample('foundry-enable-a2a');
  for (const accountName of ['attacker.example/#', 'aif_test', '-aif-test', 'aif-test-', 'AIF-test']) {
    const paths = errorPaths(sample, makeFixtureReader({ 'foundry.accountName': accountName }));
    assert.ok(paths.includes('foundry.accountName'), `${accountName} must be rejected`);
  }
});

test('a blank derived value warns rather than blocking', () => {
  const sample = getSample('access-contract-kv-verify');
  const read = makeFixtureReader({ 'keyVault.keySecretName': '', 'keyVault.endpointSecretNames': [] });
  const result = validateSample(sample, read);
  assert.equal(result.satisfied, true, 'derived values must not block plan generation');
  const warnings = result.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.path);
  assert.ok(warnings.includes('keyVault.keySecretName'));
  assert.ok(warnings.includes('keyVault.endpointSecretNames'));
});

test('coercion handles integers, booleans and lists from raw form values', () => {
  const integer = { name: 'n', label: 'N', type: 'integer' };
  assert.equal(coerceValue(integer, '42'), 42);
  assert.equal(coerceValue(integer, ' 42 '), 42);
  assert.ok(Number.isNaN(coerceValue(integer, 'x')));
  assert.equal(coerceValue(integer, ''), undefined);

  const boolean = { name: 'b', label: 'B', type: 'boolean' };
  assert.equal(coerceValue(boolean, 'true'), true);
  assert.equal(coerceValue(boolean, 'false'), false);
  assert.equal(coerceValue(boolean, false), false);

  const list = { name: 'l', label: 'L', type: 'string-list' };
  assert.deepEqual(coerceValue(list, 'a\nb , c'), ['a', 'b', 'c']);
  assert.deepEqual(coerceValue(list, ['a', ' b ']), ['a', 'b']);
});

/* --------------------------------------------------- acknowledgement gate */

test('read-only recipes need no acknowledgement; the other eight do', () => {
  for (const sample of CATALOGUE.samples) {
    const gate = acknowledgementFor(sample, false);
    if (sample.risk.level === 'read-only') {
      assert.equal(gate.required, false, `${sample.id} should not require acknowledgement`);
      assert.equal(gate.satisfied, true);
    } else {
      assert.equal(gate.required, true, `${sample.id} should require acknowledgement`);
      assert.equal(gate.satisfied, false);
      assert.ok(gate.issues[0].message.length > 30);
    }
  }
});

test('a risky plan is blocked without acknowledgement, even with a capable executor', async () => {
  const capable = {
    id: 'fake',
    describeCapability: () => ({ id: 'fake', kind: 'fake', canExecute: true, supportedStepTypes: ['http', 'azure-cli', 'artifact', 'library', 'assertion'] }),
    supports: () => ({ supported: true, unsupportedStepTypes: [] }),
    execute: async () => {
      throw new Error('the executor must never be reached without acknowledgement');
    },
  };
  const sample = getSample('cleanup');
  const { plan, validation } = buildSamplePlan(sample, makeFixtureReader());
  const result = await runPlan(capable, plan, {
    validation,
    acknowledgement: acknowledgementFor(sample, false),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.meta.reason, 'acknowledgement');
});

test('an invalid configuration is blocked before the executor is reached', async () => {
  const capable = {
    id: 'fake',
    describeCapability: () => ({ canExecute: true, supportedStepTypes: ['http'] }),
    supports: () => ({ supported: true, unsupportedStepTypes: [] }),
    execute: async () => {
      throw new Error('the executor must never be reached for an invalid configuration');
    },
  };
  const sample = getSample('weather-mcp-discovery');
  const read = makeFixtureReader();
  const { plan } = buildSamplePlan(sample, read);
  const result = await runPlan(capable, plan, {
    validation: { satisfied: false, issues: [{ message: 'Gateway URL is required.' }] },
    acknowledgement: acknowledgementFor(sample, true),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.meta.reason, 'validation');
});

test('the non-production confirmation must be true, not merely present', () => {
  for (const id of ['tool-rate-limit-burst', 'agent-rate-limit-burst', 'cleanup']) {
    const sample = getSample(id);
    const path = `samples.${id}.confirmNonProduction`;

    const unconfirmed = validateSample(sample, makeFixtureReader({ [path]: false }));
    assert.equal(unconfirmed.satisfied, false, `${id} must not be runnable unconfirmed`);
    assert.ok(errorsOf(unconfirmed.issues).some((issue) => issue.path === path));

    const confirmed = validateSample(sample, makeFixtureReader({ [path]: true }));
    assert.equal(confirmed.satisfied, true, `${id} should be satisfied once confirmed`);
  }
});

test('an unconfirmed burst produces no plan at all', () => {
  const sample = getSample('tool-rate-limit-burst');
  const { plan } = buildSamplePlan(
    sample,
    makeFixtureReader({ 'samples.tool-rate-limit-burst.confirmNonProduction': false }),
  );
  assert.equal(plan, null, 'no plan should be generated without the confirmation');
});

test('an acknowledged risky plan still reaches only an executor that can run it', async () => {
  const sample = getSample('publish-assets');
  const { plan, validation } = buildSamplePlan(sample, makeFixtureReader());
  const result = await runPlan(createUnavailableExecutor(), plan, {
    validation,
    acknowledgement: acknowledgementFor(sample, true),
  });
  assert.equal(result.state, 'blocked');
  assert.equal(result.meta.executor, 'unavailable');
});
