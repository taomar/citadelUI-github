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
import { describeSampleCapability } from '../src/core/capability.mjs';
import {
  buildConfigureModel,
  buildContextModel,
  buildDirectoryModel,
  buildExecutionEnvironmentModel,
  buildGuideModel,
  buildRequestModel,
  buildResponseModel,
  buildSourceModel,
  buildSourceValidationModel,
  buildWorkbenchModel,
  riskBadge,
  stateBadge,
} from '../src/view/models.mjs';
import { FAKE_API_KEY, FIXTURE_SECRETS, makeEmptyReader, makeFixtureReader } from './helpers/fixtures.mjs';

const capability = createUnavailableExecutor().describeCapability();
const read = makeFixtureReader();

function sourcePayload(sample) {
  return {
    protocolVersion: 2,
    sampleId: sample.id,
    notebook: {
      fileName: CATALOGUE.sourceNotebook.fileName,
      sha256: CATALOGUE.sourceNotebook.sha256,
      bytes: 123456,
    },
    protection: {
      editable: false,
      source: 'imported-notebook',
      statement: 'This source is selected and verified by the server.',
    },
    parameterZones: [
      {
        id: 'configuration',
        title: 'Configuration',
        count: 1,
        fields: [{ path: 'hub.subscriptionId', label: 'Subscription ID', secret: false, blockingWhenBlank: true }],
      },
    ],
    cells: [
      {
        cellIndex: sample.sourceCells[0],
        cellType: 'code',
        language: 'python',
        text: 'value = "unchanged"  \nprint(value)\n',
        bytes: new TextEncoder().encode('value = "unchanged"  \nprint(value)\n').byteLength,
        sha256: 'a'.repeat(64),
        editable: false,
        protected: true,
      },
    ],
  };
}

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
    runtimeProbe: overrides.runtimeProbe ?? { mode: 'preview' },
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

/* ---------------------------------------------------------------- source */

test('the protected source model keeps exact code and exposes no editable surface', () => {
  const sample = getSample('azure-context-check');
  const payload = sourcePayload(sample);
  const model = buildSourceModel({ sample, sourceState: { status: 'ready', payload } });
  assert.equal(model.state, 'ready');
  assert.equal(model.protected, true);
  assert.equal(model.editable, false);
  assert.equal(model.cells[0].text, payload.cells[0].text, 'source whitespace and final newline must remain exact');
  assert.equal(model.cells[0].lineCount, 3);
  assert.equal(model.cells[0].editable, false);
  assert.equal(model.cells[0].protected, true);
  assert.equal(model.parameterZones[0].fields[0].path, 'hub.subscriptionId');
});

test('the source model rejects stale, editable, or digest-mismatched responses', () => {
  const sample = getSample('azure-context-check');
  for (const payload of [
    { ...sourcePayload(sample), sampleId: 'cleanup' },
    { ...sourcePayload(sample), notebook: { ...sourcePayload(sample).notebook, sha256: 'b'.repeat(64) } },
    {
      ...sourcePayload(sample),
      cells: sourcePayload(sample).cells.map((cell) => ({ ...cell, editable: true })),
    },
  ]) {
    const model = buildSourceModel({ sample, sourceState: { status: 'ready', payload } });
    assert.equal(model.state, 'error');
    assert.deepEqual(model.cells, []);
  }
});

test('offline validation accepts only a compile-only response with no live evidence', () => {
  const result = {
    mode: 'offline-local',
    validation: 'python-compile-only',
    sourceExecuted: false,
    azureContacted: false,
    networkContacted: false,
    liveEvidence: false,
    state: 'passed',
    summary: 'Two cells compiled.',
    workspaceRemoved: true,
    checks: [{ id: 'compile', label: 'Python syntax', passed: true, detail: 'Both cells compiled.' }],
    steps: [{ id: 'compile-1', title: 'Compile cell 1', state: 'completed', detail: 'Syntax accepted.' }],
  };
  const model = buildSourceValidationModel({ status: 'ready', result });
  assert.equal(model.state, 'passed');
  assert.equal(model.badge.label, 'Passed offline');
  assert.equal(model.validationMode, 'python-compile-only');
  assert.equal(model.liveEvidence, false);
  assert.equal(model.workspaceRemoved, true);

  const unsafe = buildSourceValidationModel({
    status: 'ready',
    result: { ...result, sourceExecuted: true, liveEvidence: true },
  });
  assert.equal(unsafe.state, 'failed');
  assert.match(unsafe.summary, /did not preserve/);
});

/* ----------------------------------------------------------- configure */

/** Find one field across the requirement groups. */
function fieldOf(model, path) {
  for (const group of model.groups) {
    const found = group.fields.find((field) => field.path === path);
    if (found) return found;
  }
  return null;
}

test('the configure model never exposes a secret value, only its presence', () => {
  const model = buildConfigureModel({
    sample: getSample('weather-mcp-discovery'),
    read,
    hasSecret: () => true,
  });
  const apiKey = fieldOf(model, 'gatewayAccess.apiKey');
  assert.equal(apiKey.classification, 'secret');
  assert.equal(apiKey.requirement, 'secret');
  assert.equal(apiKey.value, '', 'a secret value must never reach the view model');
  assert.equal(apiKey.secretSet, true);
  assert.equal(JSON.stringify(model).includes(FAKE_API_KEY), false);
});

test('the configure model groups fields by requirement and counts each group', () => {
  const model = buildConfigureModel({ sample: getSample('weather-mcp-discovery'), read, hasSecret: () => true });
  const ids = model.groups.map((group) => group.id);
  assert.deepEqual(ids, ['conditional', 'optional', 'generated', 'secret']);
  for (const group of model.groups) {
    assert.equal(group.fields.length, group.count);
    assert.ok(group.summary.length > 20, `${group.id} must explain itself`);
  }
  assert.match(model.contractLine, /nothing missing/);
});

test('the configure model renders only the fields the sample declares', () => {
  const model = buildConfigureModel({ sample: getSample('access-contract-kv-verify'), read, hasSecret: () => false });
  const paths = model.groups.flatMap((group) => group.fields.map((field) => field.path));
  assert.ok(paths.includes('keyVault.name'));
  assert.ok(!paths.some((path) => path.startsWith('hub.')), 'no hub field is read by this recipe, so none is shown');
  assert.ok(!paths.some((path) => path.startsWith('gatewayAccess.')));
});

test('every rendered field says why it is needed and what happens if it is blank', () => {
  for (const sample of CATALOGUE.samples) {
    const model = buildConfigureModel({ sample, read, hasSecret: () => true });
    for (const group of model.groups) {
      for (const field of group.fields) {
        assert.ok(field.requirementReason, `${sample.id}/${field.path} has no reason`);
        assert.ok(field.ownerLabel, `${sample.id}/${field.path} has no owner label`);
        if (field.requirement === 'optional' || field.requirement === 'generated') {
          assert.ok(field.fallback, `${sample.id}/${field.path} has no stated fallback`);
        }
        if (field.requirement === 'conditional') {
          assert.ok(field.condition, `${sample.id}/${field.path} has no stated condition`);
        }
      }
    }
  }
});

test('the configure model surfaces per-field errors on the right field', () => {
  const model = buildConfigureModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    isTouched: () => true,
  });
  const resourceGroup = fieldOf(model, 'hub.resourceGroupName');
  assert.equal(resourceGroup.errors.length, 1);
  assert.match(resourceGroup.errors[0], /required/);
  assert.equal(model.blockingCount, 1, 'only the one value this recipe actually needs is blocking');
  assert.equal(model.satisfied, false);
});

test('an untouched, empty required field reads as needed rather than as an error', () => {
  const untouched = buildConfigureModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    isTouched: () => false,
  });
  const field = fieldOf(untouched, 'hub.resourceGroupName');
  assert.equal(field.pending, true, 'an untouched empty required field is pending');
  assert.deepEqual(field.errors, [], 'it must not be painted as an error');
  assert.equal(field.needed.length, 1, 'but it must still say what it needs');
  assert.match(field.needed[0], /required/);

  // The readiness count is unaffected: the recipe is still not runnable.
  assert.equal(untouched.blockingCount, 1, 'readiness still counts it as unmet');
});

test('a touched field, or one holding an invalid value, is a real error', () => {
  const touched = buildConfigureModel({
    sample: getSample('azure-context-check'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    isTouched: (path) => path === 'hub.subscriptionId',
  });
  const subscription = fieldOf(touched, 'hub.subscriptionId');
  assert.equal(subscription.pending, false);
  assert.equal(subscription.errors.length, 1);

  const badGuid = buildConfigureModel({
    sample: getSample('azure-context-check'),
    read: makeEmptyReader({ 'hub.subscriptionId': 'not-a-guid' }),
    hasSecret: () => false,
    isTouched: () => false,
  });
  const invalid = fieldOf(badGuid, 'hub.subscriptionId');
  assert.equal(invalid.pending, false, 'a non-blank invalid value is an error even when untouched');
  assert.match(invalid.errors[0], /GUID/);
});

test('a recipe with one parameter shows exactly one group entry for it', () => {
  const model = buildConfigureModel({ sample: getSample('azure-context-check'), read, hasSecret: () => false });
  const paths = model.groups.flatMap((group) => group.fields.map((field) => field.path));
  assert.deepEqual(paths, ['hub.subscriptionId'], 'the context check reads exactly one value');
});

/* ------------------------------------------------------------ exports */

test('the configuration export is copyable JSON that never carries a secret value', () => {
  const model = buildConfigureModel({
    sample: getSample('weather-mcp-discovery'),
    read,
    hasSecret: () => true,
    plan: buildRequestModel({ sample: getSample('weather-mcp-discovery'), read, secrets: FIXTURE_SECRETS }).plan,
  });
  assert.equal(model.exports.fileNames.json, 'citadel-weather-mcp-discovery.config.json');
  assert.equal(model.exports.fileNames.env, 'citadel-weather-mcp-discovery.env.example');
  assert.equal(model.exports.json.includes(FAKE_API_KEY), false, 'the JSON must never carry a credential');
  assert.equal(model.exports.env.includes(FAKE_API_KEY), false, 'the env example must never carry a credential');
  assert.match(model.exports.env, /CITADEL_GATEWAY_ACCESS_API_KEY=\s*$/m, 'the placeholder is left empty');

  const document = JSON.parse(model.exports.json);
  assert.equal(document.sample.id, 'weather-mcp-discovery');
  assert.equal(document.source.sha256, CATALOGUE.sourceNotebook.sha256);
  assert.ok(document.inputs.optional.length > 0);
  assert.equal(document.secrets[0].environmentVariable, 'CITADEL_GATEWAY_ACCESS_API_KEY');
  assert.equal(document.secrets[0].required, true);
  assert.equal(document.generates.available, true);
  assert.ok(document.generates.requests.length >= 2);
  assert.ok(document.requirements.runtime.dependencies.includes('gateway-network'));
});

test('the export is deterministic and names the values still missing', () => {
  const build = () =>
    buildConfigureModel({ sample: getSample('apim-discovery'), read: makeEmptyReader(), hasSecret: () => false }).exports;
  assert.equal(build().json, build().json, 'two exports of the same state must be byte-identical');
  const document = JSON.parse(build().json);
  assert.deepEqual(
    document.missing.map((entry) => entry.path),
    ['hub.resourceGroupName'],
  );
  assert.equal(document.generates.available, false);
});

/* ------------------------------------------------------------- request */

test('an incomplete configuration reports why no plan exists rather than showing a blank tab', () => {
  const model = buildRequestModel({ sample: getSample('apim-discovery'), read: makeEmptyReader() });
  assert.equal(model.available, false);
  assert.match(model.reason, /Complete the required inputs/);
  assert.ok(model.errors.length >= 1);
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

test('the context rail reports readiness per requirement group and never claims capability it lacks', () => {
  const model = buildContextModel({ sample: getSample('access-contract-deploy'), read, hasSecret: () => false, capability });
  assert.equal(model.readiness.ready, true);
  assert.ok(model.readiness.groups.length >= 3);
  assert.deepEqual(model.readiness.blocking, []);
  assert.equal(model.capability.canExecute, false);
  assert.equal(model.capability.badge.label, 'Not attached');
  assert.equal(model.provenance.sha256, CATALOGUE.sourceNotebook.sha256);
  assert.ok(model.provenance.cells.length > 0);
});

test('a missing mandatory value is counted as blocking in the context rail', () => {
  const model = buildContextModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    capability,
  });
  assert.equal(model.readiness.ready, false);
  assert.deepEqual(
    model.readiness.blocking.map((entry) => entry.path),
    ['hub.resourceGroupName'],
  );
  const mandatory = model.readiness.groups.find((group) => group.id === 'mandatory');
  assert.equal(mandatory.blocking, 1);
});

test('the context rail reports the runtime this sample needs, per dependency', () => {
  const preview = buildContextModel({
    sample: getSample('weather-api-ensure'),
    read,
    hasSecret: () => false,
    capability,
    sampleCapability: describeSampleCapability(getSample('weather-api-ensure'), { mode: 'preview' }),
  });
  assert.equal(preview.runtime.state, 'preview-only');
  assert.equal(preview.runtime.badge.label, 'Preview only');
  assert.deepEqual(
    preview.runtime.dependencies.map((dependency) => dependency.id),
    ['azure-cli', 'python', 'accelerator'],
  );
});

test('execution environments distinguish preview, local machine, and hosted relay evidence', () => {
  assert.deepEqual(
    [capability, { kind: 'local', canExecute: true }, { kind: 'relay', canExecute: true }].map((item) => {
      const model = buildExecutionEnvironmentModel(item);
      return [model.label, model.evidenceLabel];
    }),
    [
      ['Preview only', 'Offline validation'],
      ['Local machine', 'Live-capable'],
      ['Hosted relay', 'Live-capable'],
    ],
  );
});

/* ----------------------------------------------------------- workbench */

test('the workbench exposes the protected code-to-output journey in a fixed order', () => {
  const model = workbench('weather-mcp-discovery');
  assert.deepEqual(model.tabs.map((tab) => [tab.id, tab.label]), [
    ['guide', 'Guide'],
    ['code', 'Code'],
    ['configure', 'Configure'],
    ['request', 'Review & approve'],
    ['response', 'Output'],
  ]);
  assert.equal(model.activeTab, 'guide');
});

test('the configure tab counts the values still missing, and nothing else', () => {
  const clean = workbench('apim-discovery');
  assert.equal(clean.tabs.find((tab) => tab.id === 'configure').count, 0);

  const dirty = buildWorkbenchModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    activeTab: 'configure',
    capability,
  });
  assert.equal(dirty.tabs.find((tab) => tab.id === 'configure').count, 1);
  assert.match(dirty.runBlockedReason, /1 required value still missing/);
});

test('a risky recipe cannot be run until it is acknowledged, and then only if a runtime exists', () => {
  const unacknowledged = workbench('cleanup');
  assert.equal(unacknowledged.canRun, false);
  assert.match(unacknowledged.runBlockedReason, /Acknowledge/);

  const acknowledged = workbench('cleanup', { acknowledged: true });
  assert.equal(acknowledged.canRun, false, 'preview mode is not a runtime');
  assert.match(acknowledged.runBlockedReason, /preview mode/i);

  const ready = workbench('cleanup', {
    acknowledged: true,
    runtimeProbe: { mode: 'execute', azureCli: { available: true }, accelerator: { available: true } },
  });
  assert.equal(ready.canRun, true, 'with the CLI present and consent given, cleanup is runnable');
  assert.equal(ready.runBlockedReason, '');
});

test('a sample whose runtime is incomplete says exactly which dependency is missing', () => {
  const model = workbench('weather-api-ensure', {
    acknowledged: true,
    runtimeProbe: {
      mode: 'execute',
      azureCli: { available: true },
      accelerator: { available: true },
      python: { available: false, reason: 'No Python interpreter was found.' },
    },
  });
  assert.equal(model.canRun, false);
  assert.match(model.runBlockedReason, /No Python interpreter/);
  assert.equal(model.runtime.state, 'partial');
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
    for (const tab of ['guide', 'code', 'configure', 'request', 'response']) {
      const model = workbench(sample.id, { activeTab: tab });
      assert.equal(model.activeTab, tab);
      assert.ok(model.guide.purpose);
      assert.ok(model.configure.groups.length > 0);
      assert.ok(model.configure.exports.json.length > 100);
      assert.ok(model.response.expected.length >= 2);
      assert.ok(model.context.provenance.cells.length > 0);
    }
  }
});
