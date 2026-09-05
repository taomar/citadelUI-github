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
import { createPlaygroundState } from '../src/core/state.mjs';
import { createUnavailableExecutor } from '../src/core/executor.mjs';
import { FAKE_API_KEY, makeFixtureReader } from './helpers/fixtures.mjs';

test('the account control supports the complete launch-gated state vocabulary', () => {
  assert.deepEqual(ACCOUNT_CONTROL_STATES, [
    'login-disabled',
    'signed-out',
    'starting',
    'waiting-system-ui',
    'verifying',
    'device-fallback-blocked',
    'status-unknown',
    'cancelled',
    'failed',
    'timed-out',
    'ready',
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
    activeAccountId: '',
    activeSubscriptionId: '',
    intendedSubscriptionId: '',
    accounts: [],
    subscriptions: [],
    active: false,
    terminal: false,
  });
  assert.equal(normalizeAccountControlState({ state: 'unknown-state', canLaunch: true }).state, 'login-disabled');
});

test('identity fails closed when neither execution context nor account adapter reports', () => {
  const identity = buildDossierIdentityModel();
  assert.equal(identity.authorization.ready, false);
  assert.equal(identity.authorization.label, 'Not Ready');
  assert.match(identity.authorization.detail, /system-browser launch capability/i);
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
  assert.match(model.reviewDecision.fingerprint, /apim-sandbox/);
  assert.ok(!model.reviewDecision.fingerprint.includes(FAKE_API_KEY));
});
