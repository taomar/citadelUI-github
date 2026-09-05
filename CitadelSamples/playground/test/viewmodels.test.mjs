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
  buildExecutionIdentityModel,
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

test('execution identity stays honest while unavailable and maps safe ready context', () => {
  const unavailable = buildExecutionIdentityModel({
    contextState: { status: 'unavailable', message: 'Start with npm run start:execute.' },
  });
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.canSignIn, false);
  assert.match(unavailable.summary, /start:execute/);

  const ready = buildExecutionIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'azure-cli-management',
        label: 'Azure CLI user',
        summary: 'Signed in for this local operator run.',
        state: 'ready',
        canExecute: true,
        authority: {
          type: 'azure-cli-user',
          principalName: 'Ada Lovelace',
          principalType: 'user',
          tenantId: 'tenant-1',
        },
        subscription: { activeId: 'sub-1', activeName: 'Sandbox', configuredId: 'sub-1', matches: true },
        guarantees: { tokensExposed: false, credentialsPersisted: false },
      },
    },
  });
  assert.equal(ready.runsAs, 'Ada Lovelace');
  assert.equal(ready.credentialSource, 'Azure CLI device sign-in');
  assert.equal(ready.subscription.matches, true);
  assert.equal(ready.canSignIn, true);
  assert.equal(ready.signInLabel, 'Switch Azure account');
});

test('execution identity offers account switching for a subscription mismatch', () => {
  const model = buildExecutionIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'azure-cli-python-management',
        label: 'Azure CLI user',
        summary: 'The active subscription does not match.',
        state: 'subscription-mismatch',
        canExecute: false,
        authority: {
          type: 'azure-cli-user',
          principalName: 'Ada Lovelace',
          principalType: 'user',
          tenantId: 'tenant-1',
        },
        subscription: { activeId: 'sub-1', activeName: 'Sandbox', configuredId: 'sub-2', matches: false },
      },
    },
  });

  assert.equal(model.canSignIn, true);
  assert.equal(model.signInLabel, 'Switch Azure account');
});

test('execution identity exposes device login without treating it as ready', () => {
  const model = buildExecutionIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'azure-cli-management',
        label: 'Azure CLI',
        summary: 'Sign in before this sample can run.',
        state: 'signed-out',
        canExecute: false,
      },
    },
    loginState: {
      status: 'ready',
      login: {
        loginId: 'login-1',
        state: 'waiting-for-user',
        verificationUrl: 'https://microsoft.com/devicelogin',
        userCode: 'ABCD-EFGH',
        message: 'Enter this code.',
      },
    },
  });

  assert.equal(model.canSignIn, false);
  assert.equal(model.login.active, true);
  assert.equal(model.login.userCode, 'ABCD-EFGH');
  assert.notEqual(model.badge.label, 'Ready');
});

test('a failed in-flight login remains cancellable and must be cancelled before retry', () => {
  const model = buildExecutionIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'azure-cli-management',
        label: 'Azure CLI',
        summary: 'Sign in before this sample can run.',
        state: 'signed-out',
        canExecute: false,
      },
    },
    loginState: {
      status: 'ready',
      login: {
        loginId: 'azure-login-0001',
        state: 'failed',
        message: 'Status could not be refreshed.',
      },
    },
  });
  assert.equal(model.canSignIn, false);
  assert.equal(model.login.cancelAvailable, true);
  assert.equal(model.login.id, 'azure-login-0001');
});

test('execution identity names gateway, offline Python, hosted, and deferred credential sources', () => {
  const modelFor = (context) =>
    buildExecutionIdentityModel({ contextState: { status: 'ready', context: { canExecute: false, ...context } } });

  assert.equal(
    modelFor({
      kind: 'gateway-key',
      label: 'Gateway key',
      summary: 'A key is required.',
      state: 'missing-key',
      gateway: { keyPresent: false, headerName: 'api-key' },
    }).credentialSource,
    'APIM subscription key held in this browser tab',
  );
  assert.equal(
    modelFor({
      kind: 'offline-python',
      label: 'Offline Python parser',
      summary: 'No cloud contact.',
      state: 'ready',
    }).runsAs,
    'Local parser only',
  );
  assert.equal(
    modelFor({
      kind: 'hosted-relay',
      label: 'Hosted relay',
      summary: 'Managed identity.',
      state: 'ready',
    }).credentialSource,
    'Hosted managed identity',
  );
  assert.equal(
    modelFor({
      kind: 'future-hosted-process',
      label: 'Future hosted process',
      summary: 'No isolated worker exists yet.',
      state: 'deferred',
    }).runsAs,
    'No hosted process identity',
  );
});

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
    activeTab: overrides.activeTab ?? 'code',
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

test('the directory reports input and dependency readiness with one recommended next recipe', () => {
  const model = buildDirectoryModel({
    selectedSampleId: 'azure-context-check',
    read,
    hasSecret: (path) => Boolean(FIXTURE_SECRETS[path]),
    runtimeProbe: {
      mode: 'execute',
      azureCli: { available: true, version: 'test' },
      python: { available: true, version: 'test', modules: {} },
      accelerator: { available: true, files: 1 },
    },
  });
  assert.ok(model.flat.every((sample) => sample.readiness && Array.isArray(sample.readiness.dependencies)));
  assert.ok(model.flat.some((sample) => sample.readiness.state === 'ready'));
  assert.equal(model.flat.filter((sample) => sample.recommendedNext).length, 1);
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
    artifact: {
      fileName: 'source-validation.json',
      mediaType: 'application/json',
      text: '{"state":"passed"}',
      bytes: 18,
      sha256: 'abc123',
      retainedInWorkspace: false,
    },
  };
  const model = buildSourceValidationModel({ status: 'ready', result });
  assert.equal(model.state, 'passed');
  assert.equal(model.badge.label, 'Passed offline');
  assert.equal(model.validationMode, 'python-compile-only');
  assert.equal(model.liveEvidence, false);
  assert.equal(model.workspaceRemoved, true);
  assert.deepEqual(model.artifact, result.artifact);

  const unsafe = buildSourceValidationModel({
    status: 'ready',
    result: { ...result, sourceExecuted: true, liveEvidence: true },
  });
  assert.equal(unsafe.state, 'failed');
  assert.match(unsafe.summary, /did not preserve/);
});

test('offline Python validation is unavailable unless the execute server advertises it', () => {
  const model = buildSourceValidationModel({ status: 'not-run', available: false });
  assert.equal(model.available, false);
  assert.equal(model.state, 'blocked');
  assert.match(model.summary, /loopback execute server/);
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
  assert.ok(paths.includes('keyVault.subscriptionId'));
  assert.ok(paths.includes('hub.subscriptionId'), 'the hub subscription is the external-vault fallback');
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
  const subscription = fieldOf(model, 'hub.subscriptionId');
  assert.equal(resourceGroup.errors.length, 1);
  assert.match(resourceGroup.errors[0], /required/);
  assert.equal(subscription.errors.length, 1);
  assert.match(subscription.errors[0], /required/);
  assert.equal(model.blockingCount, 2, 'both command coordinates are blocking');
  assert.equal(model.satisfied, false);
});

test('a mustEqual guard is blocking until its required value is satisfied', () => {
  const sample = getSample('cleanup');
  const path = 'samples.cleanup.confirmNonProduction';
  const unconfirmed = buildConfigureModel({
    sample,
    read: makeFixtureReader({ [path]: false }),
    hasSecret: () => true,
    isTouched: () => true,
  });
  const falseField = fieldOf(unconfirmed, path);
  assert.equal(falseField.supplied, false);
  assert.equal(falseField.blocking, true);
  assert.equal(unconfirmed.satisfied, false);

  const confirmed = buildConfigureModel({
    sample,
    read: makeFixtureReader({ [path]: true }),
    hasSecret: () => true,
    isTouched: () => true,
  });
  const trueField = fieldOf(confirmed, path);
  assert.equal(trueField.supplied, true);
  assert.equal(trueField.blocking, false);
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
  assert.equal(untouched.blockingCount, 2, 'readiness still counts both command coordinates as unmet');
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
    ['hub.subscriptionId', 'hub.resourceGroupName'],
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
    ['hub.subscriptionId', 'hub.resourceGroupName'],
  );
  const mandatory = model.readiness.groups.find((group) => group.id === 'mandatory');
  assert.equal(mandatory.blocking, 2);
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

test('a completed run keeps the evidence environment captured when it started', () => {
  const sample = getSample('azure-context-check');
  const hosted = buildResponseModel({
    sample,
    capability: { kind: 'local', canExecute: true },
    result: executionResult({
      state: 'completed',
      sampleId: sample.id,
      summary: 'Read-only check completed.',
      meta: { executor: 'relay', evidenceClass: 'hosted-relay' },
    }),
  });
  assert.equal(hosted.environment.mode, 'hosted-relay');

  const offline = buildResponseModel({
    sample,
    capability: { kind: 'local', canExecute: true },
    result: {
      state: 'passed',
      sampleId: sample.id,
      summary: 'Protected source compiled.',
      steps: [],
      assertions: [],
      meta: { evidenceClass: 'offline' },
    },
  });
  assert.equal(offline.environment.mode, 'offline-local');
  assert.equal(offline.environment.liveCapable, false);
  assert.equal(offline.environment.evidenceLabel, 'No live evidence');
});

/* ----------------------------------------------------------- workbench */

test('the workbench exposes the protected code-to-output journey in a fixed order', () => {
  const model = workbench('weather-mcp-discovery');
  assert.deepEqual(model.tabs.map((tab) => [tab.id, tab.label]), [
    ['code', 'Code'],
    ['guide', 'Guide'],
    ['request', 'Review & approve'],
    ['response', 'Output'],
  ]);
  assert.equal(model.activeTab, 'code');
});

test('the Code tab counts the parameter values still missing, and nothing else', () => {
  const clean = workbench('apim-discovery');
  assert.equal(clean.tabs.find((tab) => tab.id === 'code').count, 0);

  const dirty = buildWorkbenchModel({
    sample: getSample('apim-discovery'),
    read: makeEmptyReader(),
    hasSecret: () => false,
    activeTab: 'code',
    capability,
  });
  assert.equal(dirty.tabs.find((tab) => tab.id === 'code').count, 2);
  assert.match(dirty.runBlockedReason, /2 required values still missing/);
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
    for (const tab of ['guide', 'code', 'request', 'response']) {
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
