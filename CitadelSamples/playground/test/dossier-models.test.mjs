import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  ACCOUNT_CONTROL_STATES,
  buildDossierIdentityModel,
  buildLedgerAction,
  normalizeAccountControlState,
} from '../src/view/dossierModels.mjs';

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
