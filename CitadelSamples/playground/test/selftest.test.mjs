/**
 * The offline self-test module in isolation: exact request schema and the
 * fixed checks it runs against this checkout. No server, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSelfTest, SELF_TEST_SCENARIO, validateSelfTestRequest } from '../src/server/selfTest.mjs';
import { RequestRefused } from '../src/server/runRequest.mjs';
import { CATALOGUE } from '../src/catalogue/index.mjs';
import { EXECUTION_PROTOCOL_VERSION, EXPECTED_SAMPLE_COUNT } from '../src/core/types.mjs';
import { checkStateChangingRequest } from '../server.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/* --------------------------------------------------------- request schema */

test('validateSelfTestRequest accepts exactly { protocolVersion }', () => {
  assert.equal(validateSelfTestRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION }), true);
});

test('validateSelfTestRequest refuses a non-object body', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    assert.throws(() => validateSelfTestRequest(bad), RequestRefused);
  }
});

test('validateSelfTestRequest refuses a wrong protocol version', () => {
  assert.throws(
    () => validateSelfTestRequest({ protocolVersion: 999 }),
    (error) => error instanceof RequestRefused && error.code === 'protocol-version',
  );
});

test('validateSelfTestRequest refuses any extra member, including a sample id', () => {
  assert.throws(
    () => validateSelfTestRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'cleanup' }),
    (error) => error instanceof RequestRefused && error.code === 'forbidden-member',
  );
});

test('validateSelfTestRequest refuses a plan, inputs, or configuration disguised as extra fields', () => {
  for (const extra of [{ inputs: {} }, { plan: {} }, { acknowledgement: { accepted: true } }, { secrets: {} }]) {
    assert.throws(
      () => validateSelfTestRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION, ...extra }),
      (error) => error instanceof RequestRefused && error.code === 'forbidden-member',
    );
  }
});

test('validateSelfTestRequest refuses a missing protocolVersion', () => {
  assert.throws(() => validateSelfTestRequest({}), RequestRefused);
});

/* ---------------------------------------------------------------- checks */

test('runSelfTest never invents live evidence and never contacts Azure', async () => {
  const result = await runSelfTest({
    playgroundRoot: PLAYGROUND_ROOT,
    catalogue: CATALOGUE,
    mode: 'preview',
    checkStateChangingRequest,
    port: 4173,
    host: '127.0.0.1',
  });
  assert.equal(result.scenario, SELF_TEST_SCENARIO);
  assert.equal(result.azureContacted, false);
  assert.equal(result.liveEvidence, false);
  assert.equal(result.protocolVersion, EXECUTION_PROTOCOL_VERSION);
  assert.ok(['passed', 'failed'].includes(result.state));
  // Never a catalogue sample id, so it can never be mistaken for a live scenario.
  assert.equal(CATALOGUE.byId.has(result.scenario), false);
});

test('runSelfTest reports every fixed check by id, and this checkout passes all of them', async () => {
  const result = await runSelfTest({
    playgroundRoot: PLAYGROUND_ROOT,
    catalogue: CATALOGUE,
    mode: 'preview',
    checkStateChangingRequest,
    port: 4173,
    host: '127.0.0.1',
  });
  const ids = result.checks.map((check) => check.id).sort();
  assert.deepEqual(ids, [
    'accelerator-bundle-present',
    'catalogue-sample-count',
    'notebook-provenance',
    'run-workspace-ignored',
    'same-origin-guard',
  ]);
  for (const check of result.checks) {
    assert.equal(typeof check.label, 'string');
    assert.ok(check.label.length > 0);
    assert.equal(typeof check.detail, 'string');
    assert.equal(check.passed, true, `${check.id}: ${check.detail}`);
  }
  assert.equal(result.state, 'passed');
});

test('runSelfTest asserts the catalogue keeps exactly 19 recipes, never a twentieth', async () => {
  const result = await runSelfTest({
    playgroundRoot: PLAYGROUND_ROOT,
    catalogue: CATALOGUE,
    mode: 'execute',
    checkStateChangingRequest,
    port: 4173,
    host: '127.0.0.1',
  });
  const catalogueCheck = result.checks.find((check) => check.id === 'catalogue-sample-count');
  assert.equal(catalogueCheck.passed, true);
  assert.equal(CATALOGUE.samples.length, EXPECTED_SAMPLE_COUNT);
  assert.equal(EXPECTED_SAMPLE_COUNT, 19);
});

test('runSelfTest fails closed if the catalogue ever grows a twentieth recipe', async () => {
  const tamperedCatalogue = { ...CATALOGUE, samples: [...CATALOGUE.samples, { id: 'invented-20th' }] };
  const result = await runSelfTest({
    playgroundRoot: PLAYGROUND_ROOT,
    catalogue: tamperedCatalogue,
    mode: 'preview',
    checkStateChangingRequest,
    port: 4173,
    host: '127.0.0.1',
  });
  const catalogueCheck = result.checks.find((check) => check.id === 'catalogue-sample-count');
  assert.equal(catalogueCheck.passed, false);
  assert.equal(result.state, 'failed');
});

test('runSelfTest reports the mode it was told, without probing anything else', async () => {
  const preview = await runSelfTest({
    playgroundRoot: PLAYGROUND_ROOT,
    catalogue: CATALOGUE,
    mode: 'preview',
    checkStateChangingRequest,
    port: 4173,
    host: '127.0.0.1',
  });
  const execute = await runSelfTest({
    playgroundRoot: PLAYGROUND_ROOT,
    catalogue: CATALOGUE,
    mode: 'execute',
    checkStateChangingRequest,
    port: 4173,
    host: '127.0.0.1',
  });
  assert.equal(preview.mode, 'preview');
  assert.equal(execute.mode, 'execute');
});

test('runSelfTest exercises the production same-origin guard rather than a copy of it', async () => {
  let calls = 0;
  const spyGuard = (request, options) => {
    calls += 1;
    return checkStateChangingRequest(request, options);
  };
  const result = await runSelfTest({
    playgroundRoot: PLAYGROUND_ROOT,
    catalogue: CATALOGUE,
    mode: 'preview',
    checkStateChangingRequest: spyGuard,
    port: 4173,
    host: '127.0.0.1',
  });
  assert.ok(calls >= 2, 'expected the guard to be exercised with both a cross-site and a same-origin request');
  const guardCheck = result.checks.find((check) => check.id === 'same-origin-guard');
  assert.equal(guardCheck.passed, true);
});
