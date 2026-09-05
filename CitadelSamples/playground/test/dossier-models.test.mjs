import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  ACCOUNT_CONTROL_STATES,
  buildDossierModel,
  buildDossierIdentityModel,
  buildLedgerAction,
  normalizeAccountControlState,
} from '../src/view/dossierModels.mjs';
import { CATALOGUE, fieldByPath, getSample } from '../src/catalogue/index.mjs';
import { hostedRelayContext } from '../src/core/executionContext.mjs';
import { createPlaygroundState } from '../src/core/state.mjs';
import { createUnavailableExecutor, executionResult } from '../src/core/executor.mjs';
import { capabilitiesPayload } from '../server.mjs';
import { FAKE_API_KEY, makeFixtureReader } from './helpers/fixtures.mjs';

test('the account control supports the complete launch-gated state vocabulary', () => {
  assert.deepEqual(ACCOUNT_CONTROL_STATES, [
    'login-disabled',
    'signed-out',
    'starting',
    'waiting-system-ui',
    'verifying',
    'cancel-requested',
    'device-fallback-blocked',
    'status-unknown',
    'cancelled',
    'failed',
    'timed-out',
    'ready',
    'subscription-disabled',
    'subscription-mismatch',
  ]);
});

test('account switching fails closed without an advertised system-browser launch', () => {
  assert.deepEqual(normalizeAccountControlState({ state: 'ready', canLaunch: true, launchMode: 'terminal' }), {
    state: 'ready',
    message: '',
    sessionId: '',
    launchMode: null,
    canLaunch: false,
    canCancel: false,
    canVerify: false,
    canSetActive: false,
    canSelect: false,
    subscriptionsBusy: false,
    activeAccountId: '',
    activeSubscriptionId: '',
    intendedSubscriptionId: '',
    accounts: [],
    subscriptions: [],
    active: false,
    terminal: false,
  });
  assert.equal(normalizeAccountControlState({ state: 'unknown-state', canLaunch: true }).state, 'login-disabled');
  assert.equal(
    normalizeAccountControlState({ state: 'subscription-mismatch', canSetActive: true }).canSetActive,
    true,
  );
  assert.equal(
    normalizeAccountControlState({ state: 'subscription-disabled', canSetActive: true }).canSetActive,
    true,
  );
  assert.equal(
    normalizeAccountControlState({
      state: 'waiting-system-ui',
      systemBrowserAzureLogin: true,
      canLaunch: false,
    }).launchMode,
    'system-browser',
  );
});

test('identity fails closed when neither execution context nor account adapter reports', () => {
  const identity = buildDossierIdentityModel();
  assert.equal(identity.authorization.ready, false);
  assert.equal(identity.authorization.label, 'Not Ready');
  assert.match(identity.authorization.detail, /system-browser launch capability/i);
});

test('the dossier consumes the separated signed-in account and subscription context', () => {
  const identity = buildDossierIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'azure-cli-management',
        label: 'Citadel private Azure CLI session',
        summary: 'Ready to attempt.',
        state: 'ready-to-attempt',
        canExecute: true,
        signedInAccount: {
          state: 'signed-in',
          principalName: 'operator@example.test',
          principalType: 'user',
          tenantId: 'tenant-1',
        },
        executionCredential: { type: 'azure-cli-user', source: 'azure-cli' },
        activeCliSubscription: { id: 'sub-active', name: 'Active', tenantId: 'tenant-1' },
        intendedTarget: { subscriptionId: 'sub-target', matchesActive: false },
        authorization: { state: 'not-checked', label: 'Authorization Not Checked' },
      },
    },
  });
  assert.equal(identity.human, 'operator@example.test');
  assert.equal(identity.runsAs, 'operator@example.test');
  assert.equal(identity.tenantId, 'tenant-1');
  assert.deepEqual(identity.subscription, {
    activeId: 'sub-active',
    activeName: 'Active',
    intendedId: 'sub-target',
    matches: false,
  });
  assert.equal(identity.authorization.label, 'Ready to Attempt');
  assert.equal(identity.accountControl.visible, true);
});

test('gateway identity has no Azure account switcher and never overclaims authorization', () => {
  const identity = buildDossierIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'gateway-key',
        state: 'ready',
        canExecute: true,
        label: 'Gateway key',
        summary: 'The key is present.',
        authority: { principalName: null, tenantId: null },
        subscription: null,
        gateway: { keyPresent: true, headerName: 'api-key' },
      },
    },
    accountControlState: {
      state: 'ready',
      canLaunch: true,
      launchMode: 'system-browser',
    },
  });
  assert.equal(identity.human, 'Browser Session');
  assert.equal(identity.accountControl.visible, false);
  assert.equal(identity.authorization.label, 'Ready to Attempt');
});

test('offline identity never exposes local Azure account controls', () => {
  const identity = buildDossierIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'offline-python',
        state: 'ready',
        canExecute: true,
        label: 'Local parser',
        summary: 'No cloud contact.',
      },
    },
    accountControlState: {
      state: 'ready',
      canLaunch: true,
      launchMode: 'system-browser',
    },
  });
  assert.equal(identity.accountControl.visible, false);
});

test('hosted identity exposes the complete relay authority chain', () => {
  const identity = buildDossierIdentityModel({
    contextState: {
      status: 'ready',
      context: {
        kind: 'hosted-relay',
        state: 'ready',
        canExecute: true,
        label: 'Hosted relay',
        summary: 'Relay ready.',
        authority: { principalName: null, tenantId: null },
        subscription: null,
        hostedRelay: {},
      },
    },
  });
  assert.deepEqual(identity.chain, [
    'Entra Caller',
    'Playground Identity',
    'Relay Managed Identity',
    'Key Vault Mapping',
    'Target',
  ]);
  assert.equal(identity.accountControl.visible, false);
});

test('a hosted relay capability makes only its allowed and supported weather sample runnable in preview mode', () => {
  const payload = capabilitiesPayload({
    mode: 'preview',
    relay: {
      enabled: true,
      allowedSampleIds: ['weather-mcp-discovery', 'weather-api-ensure'],
    },
    operatorAuthorization: {
      required: true,
      signedIn: true,
      authorized: true,
      state: 'authorized',
      message: 'Authorized hosted operator.',
    },
  });
  const build = (sampleId, { acknowledged = false, available = true, result = null } = {}) =>
    buildDossierModel({
      sample: getSample(sampleId),
      read: makeFixtureReader(),
      hasSecret: () => true,
      isTouched: () => true,
      acknowledged,
      capability: payload.executor,
      runtimeProbe: { mode: payload.mode },
      contextState: {
        status: 'ready',
        context: hostedRelayContext({ available, hosted: true, authorized: true }),
      },
      result,
      sourceState: { status: 'loading' },
    });

  const ready = build('weather-mcp-discovery', {
    result: executionResult({
      state: 'completed',
      sampleId: 'weather-mcp-discovery',
      summary: 'Hosted weather discovery completed.',
      meta: { evidenceClass: 'hosted-relay' },
    }),
  });
  assert.equal(payload.mode, 'preview');
  assert.equal(ready.canAttempt, true);
  assert.equal(ready.ledger.canRun, true);
  assert.equal(ready.runtime.executionKind, 'relay');
  assert.equal(ready.context.runtime.badge.label, 'Hosted relay ready');
  assert.equal(ready.environment.label, 'Hosted relay');
  assert.equal(ready.response.environment.mode, 'hosted-relay');
  assert.equal(ready.response.environment.evidenceLabel, 'Live-capable');

  const disallowed = build('publish-assets', { acknowledged: true, available: false });
  assert.equal(disallowed.canAttempt, false);
  assert.equal(disallowed.ledger.canRun, false);
  assert.match(disallowed.ledger.runBlockedReason, /not allowlisted/i);

  const unsupported = build('weather-api-ensure', { acknowledged: true });
  assert.equal(unsupported.canAttempt, false);
  assert.equal(unsupported.ledger.canRun, false);
  assert.match(unsupported.ledger.runBlockedReason, /library step type/i);

  const localPreview = buildDossierModel({
    sample: getSample('weather-mcp-discovery'),
    read: makeFixtureReader(),
    hasSecret: () => true,
    isTouched: () => true,
    capability: createUnavailableExecutor().describeCapability(),
    runtimeProbe: { mode: 'preview' },
    contextState: { status: 'unavailable', message: 'No relay is configured.' },
    sourceState: { status: 'loading' },
  });
  assert.equal(localPreview.canAttempt, false);
  assert.equal(localPreview.environment.label, 'Preview only');
});

test('the ledger exposes one contextual action', () => {
  assert.deepEqual(buildLedgerAction({ blockingCount: 2, firstBlockerPath: 'hub.name' }), {
    id: 'resolve',
    label: 'Resolve 2 Required Inputs',
    target: 'hub.name',
    disabled: false,
  });
  assert.equal(buildLedgerAction({ canAttempt: true, stage: 'review' }).id, 'run');
  assert.equal(buildLedgerAction({ running: true }).id, 'cancel');
});

test('the dossier view layer contains no device-code contract fields', async () => {
  const source = await readFile(new URL('../src/view/dossierModels.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /device-code|verificationUrl|userCode/i);
});

test('playground state tracks dossier stage and unsaved input loss', () => {
  const state = createPlaygroundState({ catalogue: CATALOGUE });
  assert.equal(state.activeStage, 'configure');
  assert.equal(state.hasUnsavedChanges, false);

  state.setActiveStage('review');
  state.set('hub.subscriptionId', '00000000-1111-2222-3333-444444444444', fieldByPath('hub.subscriptionId'));
  assert.equal(state.activeStage, 'review');
  assert.equal(state.hasUnsavedChanges, true);

  state.markInputsHandled();
  assert.equal(state.hasUnsavedChanges, false);
  state.selectSample('apim-discovery');
  assert.equal(state.activeStage, 'configure');
});

test('destructive review repeats the exact APIM target and fingerprints public context', () => {
  const read = makeFixtureReader({
    'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
    'hub.resourceGroupName': 'rg-sandbox',
    'hub.apimName': 'apim-sandbox',
    'samples.cleanup.confirmNonProduction': true,
  });
  const model = buildDossierModel({
    sample: getSample('cleanup'),
    read,
    hasSecret: () => false,
    isTouched: () => true,
    acknowledged: true,
    capability: createUnavailableExecutor().describeCapability(),
    runtimeProbe: { mode: 'preview' },
    sourceState: { status: 'loading' },
    contextState: { status: 'unavailable', message: 'No identity.' },
  });
  assert.equal(model.reviewDecision.confirmationText, 'DELETE apim-sandbox');
  assert.equal(model.reviewDecision.target.apimName, 'apim-sandbox');
  assert.equal(model.reviewDecision.target.resourceGroup, 'rg-sandbox');
  assert.equal(model.reviewDecision.target.actionLabel, 'apim-sandbox');
  assert.equal(model.reviewDecision.authorization.label, 'Not Ready');
  assert.deepEqual(model.reviewDecision.requiredInputs, []);
  assert.match(model.reviewDecision.fingerprint, /apim-sandbox/);
  assert.ok(!model.reviewDecision.fingerprint.includes(FAKE_API_KEY));
});
