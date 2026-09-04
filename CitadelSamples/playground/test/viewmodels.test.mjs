/**
 * View models.
 *
 * The renderers are thin, so this is where the interaction decisions are
 * tested: what the directory shows, what search matches, which tab counts a
 * badge, and — the one that matters most — that a not-run recipe is never
 * described as having passed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE, getSample } from '../src/catalogue/index.mjs';
import { createPlaygroundState } from '../src/core/state.mjs';
import { createUnavailableExecutor, executionResult } from '../src/core/executor.mjs';
import {
  buildConfigureModel,
  buildContextModel,
  buildDirectoryModel,
  buildGuideModel,
  buildRequestModel,
  buildResponseModel,
  buildWorkbenchModel,
  riskBadge,
  stateBadge,
} from '../src/view/models.mjs';
import { FAKE_API_KEY, FIXTURE_SECRETS, makeEmptyReader, makeFixtureReader } from './helpers/fixtures.mjs';

const capability = createUnavailableExecutor().describeCapability();
const read = makeFixtureReader();

function workbench(id, overrides = {}) {
  const sample = getSample(id);
  return buildWorkbenchModel({
    sample,
    read: makeFixtureReader(overrides.values ?? {}),
    hasSecret: () => true,
    secrets: FIXTURE_SECRETS,
    activeTab: overrides.activeTab ?? 'guide',
    acknowledged: overrides.acknowledged ?? false,
    result: overrides.result ?? null,
    capability: overrides.capability ?? capability,
  });
}

/* ------------------------------------------------------------ directory */

test('the directory lists every recipe under its group, in operating order', () => {
  const model = buildDirectoryModel({});
  assert.equal(model.total, 19);
  assert.deepEqual(
    model.groups.map((group) => group.id),
    ['discover', 'prepare', 'publish-grant', 'exercise', 'observe', 'policy', 'lifecycle'],
  );
  assert.equal(model.flat.length, 19);
  assert.equal(model.empty, false);
});

test('search matches name, group, risk and notebook cell, and all terms must match', () => {
  assert.ok(buildDirectoryModel({ query: 'weather' }).total >= 3);
  assert.equal(buildDirectoryModel({ query: 'destructive' }).total, 1);
  assert.ok(buildDirectoryModel({ query: 'cell 31' }).total >= 2);
  assert.equal(buildDirectoryModel({ query: 'weather burst' }).total, 0, 'terms are ANDed');
  assert.equal(buildDirectoryModel({ query: '   ' }).total, 19, 'blank search shows everything');
});

test('a search with no match reports empty rather than silently showing everything', () => {
  const model = buildDirectoryModel({ query: 'zzzz-nothing' });
  assert.equal(model.total, 0);
  assert.equal(model.empty, true);
  assert.equal(model.catalogueTotal, 19);
});

test('exactly one directory entry is marked as the current position', () => {
  const model = buildDirectoryModel({ selectedSampleId: 'cleanup' });
  const selected = model.flat.filter((sample) => sample.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'cleanup');
});

test('risk and state badges map to the semantic tones', () => {
  assert.deepEqual(riskBadge('read-only'), { tone: 'neutral', label: 'Read-only' });
  assert.deepEqual(riskBadge('destructive'), { tone: 'danger', label: 'Destructive' });
  assert.deepEqual(stateBadge('blocked'), { tone: 'warning', label: 'Blocked' });
  assert.deepEqual(stateBadge('completed'), { tone: 'success', label: 'Completed' });
  assert.deepEqual(stateBadge('not-run'), { tone: 'neutral', label: 'Not run' });
});

/* --------------------------------------------------------------- guide */

test('the guide model carries every documented part of a recipe', () => {
  for (const sample of CATALOGUE.samples) {
    const guide = buildGuideModel(sample);
    assert.ok(guide.purpose.length > 100, `${sample.id} guide purpose`);
    assert.ok(guide.explanation.length >= 3, `${sample.id} guide explanation`);
    assert.ok(guide.flow.length >= 3, `${sample.id} guide flow`);
    assert.deepEqual(guide.flow.map((entry) => entry.index), guide.flow.map((_, i) => i + 1));
    assert.ok(guide.prerequisites.length >= 2, `${sample.id} guide prerequisites`);
    assert.ok(guide.risk.badge.label, `${sample.id} guide risk badge`);
    assert.ok(guide.source.cells.length > 0, `${sample.id} guide source`);
  }
});

/* ----------------------------------------------------------- configure */

test('the configure model never exposes a secret value, only its presence', () => {
  const model = buildConfigureModel({
    sample: getSample('weather-mcp-discovery'),
    read,
    hasSecret: () => true,
  });
  const gateway = model.profiles.find((profile) => profile.id === 'gatewayAccess');
  const apiKey = gateway.fields.find((field) => field.name === 'apiKey');
  assert.equal(apiKey.classification, 'secret');
  assert.equal(apiKey.value, '', 'a secret value must never reach the view model');
  assert.equal(apiKey.secretSet, true);
  assert.equal(JSON.stringify(model).includes(FAKE_API_KEY), false);
});

test('the configure model surfaces per-field errors on the right field', () => {
  const model = buildConfigureModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    isTouched: () => true,
  });
  const hub = model.profiles.find((profile) => profile.id === 'hub');
  const subscription = hub.fields.find((field) => field.name === 'subscriptionId');
  assert.equal(subscription.errors.length, 1);
  assert.match(subscription.errors[0], /required/);
  assert.ok(model.errorCount >= 3);
});

test('an untouched, empty required field reads as needed rather than as an error', () => {
  const untouched = buildConfigureModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    isTouched: () => false,
  });
  const field = untouched.profiles
    .find((profile) => profile.id === 'hub')
    .fields.find((entry) => entry.name === 'subscriptionId');
  assert.equal(field.pending, true, 'an untouched empty required field is pending');
  assert.deepEqual(field.errors, [], 'it must not be painted as an error');
  assert.equal(field.needed.length, 1, 'but it must still say what it needs');
  assert.match(field.needed[0], /required/);

  // The readiness count is unaffected: the recipe is still not runnable.
  assert.ok(untouched.errorCount >= 3, 'readiness still counts it as unmet');
});

test('a touched field, or one holding an invalid value, is a real error', () => {
  const touched = buildConfigureModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    isTouched: (path) => path === 'hub.subscriptionId',
  });
  const fields = touched.profiles.find((profile) => profile.id === 'hub').fields;
  const subscription = fields.find((field) => field.name === 'subscriptionId');
  assert.equal(subscription.pending, false);
  assert.equal(subscription.errors.length, 1);

  const badGuid = buildConfigureModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader({ 'hub.subscriptionId': 'not-a-guid' }),
    hasSecret: () => false,
    isTouched: () => false,
  });
  const invalid = badGuid.profiles
    .find((profile) => profile.id === 'hub')
    .fields.find((field) => field.name === 'subscriptionId');
  assert.equal(invalid.pending, false, 'a non-blank invalid value is an error even when untouched');
  assert.match(invalid.errors[0], /GUID/);
});

test('a recipe with no parameters of its own says so rather than showing an empty box', () => {
  const model = buildConfigureModel({
    sample: getSample('azure-context-check'),
    read,
    hasSecret: () => false,
  });
  assert.equal(model.own.fields.length, 0);
});

/* ------------------------------------------------------------- request */

test('an incomplete configuration reports why no plan exists rather than showing a blank tab', () => {
  const model = buildRequestModel({ sample: getSample('apim-discovery'), read: makeEmptyReader() });
  assert.equal(model.available, false);
  assert.match(model.reason, /Complete the required inputs/);
  assert.ok(model.errors.length >= 3);
  assert.ok(model.errors.every((error) => error.path && error.message));
});

test('a complete configuration yields a plan, a per-step preview and no secret value', () => {
  const model = buildRequestModel({ sample: getSample('weather-tools-call'), read, secrets: FIXTURE_SECRETS });
  assert.equal(model.available, true);
  assert.equal(model.steps.length, model.plan.steps.length);
  assert.ok(model.fullText.includes('${CITADEL_GATEWAY_ACCESS_API_KEY}'));
  assert.equal(model.fullText.includes(FAKE_API_KEY), false);
  assert.deepEqual(model.secretRefs, ['gatewayAccess.apiKey']);
});

/* ------------------------------------------------------------ response */

test('a recipe that has not run is never described as passing', () => {
  for (const sample of CATALOGUE.samples) {
    const model = buildResponseModel({ sample, result: null, capability });
    assert.equal(model.state, 'not-run');
    assert.equal(model.isSuccessShaped, false);
    assert.match(model.summary, /Not run/);
    for (const expected of model.expected) {
      assert.equal(expected.status, 'not-evaluated', `${sample.id}/${expected.id} claims a status`);
      assert.match(expected.statusText, /Not run|Still reported/);
    }
  }
});

test('a blocked result is rendered as blocked, not as a failure and not as a pass', () => {
  const model = buildResponseModel({
    sample: getSample('publish-assets'),
    result: executionResult({ state: 'blocked', sampleId: 'publish-assets', summary: 'Not run — no runtime.' }),
    capability,
  });
  assert.equal(model.state, 'blocked');
  assert.equal(model.badge.tone, 'warning');
  assert.equal(model.isSuccessShaped, false);
});

test('assertion outcomes are shown only when the executor reported them', () => {
  const sample = getSample('a2a-agent-card');
  const model = buildResponseModel({
    sample,
    result: executionResult({
      state: 'failed',
      sampleId: sample.id,
      summary: 'One assertion failed.',
      assertions: [{ id: 'card-reachable', status: 'passed', detail: 'HTTP 200.' }],
    }),
    capability,
  });
  const reachable = model.expected.find((expected) => expected.id === 'card-reachable');
  assert.equal(reachable.status, 'passed');
  assert.equal(reachable.statusText, 'HTTP 200.');
  const others = model.expected.filter((expected) => expected.id !== 'card-reachable');
  assert.ok(others.every((expected) => expected.status === 'not-evaluated'));
});

/* ------------------------------------------------------------- context */

test('the context rail reports readiness per profile and never claims capability it lacks', () => {
  const model = buildContextModel({ sample: getSample('access-contract-deploy'), read, capability });
  assert.equal(model.readiness.ready, true);
  assert.equal(model.readiness.profiles.length, 5);
  assert.equal(model.capability.canExecute, false);
  assert.equal(model.capability.badge.label, 'Not attached');
  assert.equal(model.provenance.sha256, CATALOGUE.sourceNotebook.sha256);
  assert.ok(model.provenance.cells.length > 0);
});

test('an incomplete profile is counted as blocking in the context rail', () => {
  const model = buildContextModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    capability,
  });
  assert.equal(model.readiness.ready, false);
  const hub = model.readiness.profiles.find((profile) => profile.id === 'hub');
  assert.ok(hub.blockingCount >= 3);
  assert.equal(hub.ready, false);
});

/* ----------------------------------------------------------- workbench */

test('the workbench exposes exactly four tabs in a fixed order', () => {
  const model = workbench('weather-mcp-discovery');
  assert.deepEqual(model.tabs.map((tab) => tab.id), ['guide', 'configure', 'request', 'response']);
  assert.equal(model.activeTab, 'guide');
});

test('the configure tab carries an error count badge only when there are errors', () => {
  const clean = workbench('apim-discovery');
  assert.equal(clean.tabs.find((tab) => tab.id === 'configure').count, 0);

  const dirty = buildWorkbenchModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    activeTab: 'configure',
    capability,
  });
  assert.ok(dirty.tabs.find((tab) => tab.id === 'configure').count >= 3);
});

test('a risky recipe cannot be run until it is acknowledged, and then only if a runtime exists', () => {
  const unacknowledged = workbench('cleanup');
  assert.equal(unacknowledged.canRun, false);
  assert.match(unacknowledged.runBlockedReason, /Acknowledge/);

  const acknowledged = workbench('cleanup', { acknowledged: true });
  assert.equal(acknowledged.canRun, true, 'the plan is runnable in principle');
  assert.match(acknowledged.runBlockedReason, /No execution runtime|not attached/i);
});

test('a read-only recipe needs no acknowledgement but still reports the missing runtime', () => {
  const model = workbench('a2a-agent-card');
  assert.equal(model.request.acknowledgement.required, false);
  assert.equal(model.canRun, true);
  assert.ok(model.runBlockedReason.length > 0, 'the runtime gap must still be stated');
});

test('the workbench reports "generated" once a plan exists and "not run" when it does not', () => {
  assert.equal(workbench('weather-mcp-discovery').context.execution.label, 'Generated');
  const incomplete = buildWorkbenchModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    capability,
  });
  assert.equal(incomplete.context.execution.label, 'Not run');
});

test('a full workbench model for every recipe never leaks the fixture secret', () => {
  const state = createPlaygroundState({ catalogue: CATALOGUE });
  state.set('gatewayAccess.apiKey', FAKE_API_KEY);
  for (const sample of CATALOGUE.samples) {
    const model = buildWorkbenchModel({
      sample,
      read: makeFixtureReader(),
      hasSecret: (path) => state.hasSecret(path),
      secrets: state.secretValues(),
      capability,
    });
    assert.equal(JSON.stringify(model).includes(FAKE_API_KEY), false, `${sample.id} workbench model leaks the key`);
  }
});

test('every recipe produces a complete workbench model without throwing', () => {
  for (const sample of CATALOGUE.samples) {
    for (const tab of ['guide', 'configure', 'request', 'response']) {
      const model = workbench(sample.id, { activeTab: tab });
      assert.equal(model.activeTab, tab);
      assert.ok(model.guide.purpose);
      assert.ok(model.configure.profiles.length > 0);
      assert.ok(model.response.expected.length >= 2);
      assert.ok(model.context.provenance.cells.length > 0);
    }
  }
});
