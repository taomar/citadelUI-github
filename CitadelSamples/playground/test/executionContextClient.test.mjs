import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getSample } from '../src/catalogue/index.mjs';
import {
  azureAuthCapabilityFromPayload,
  buildExecutionContextProjection,
  createExecutionContextClient,
  reconcileAzureContextCurrent,
} from '../web/js/executionContextClient.mjs';

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

test('execution context projection follows the sample authority classification', () => {
  const values = {
    'hub.subscriptionId': 'hub-subscription',
    'keyVault.subscriptionId': 'vault-subscription',
    'gatewayAccess.subscriptionKeyHeader': 'api-key',
  };
  const options = {
    read: (path) => values[path] ?? '',
    hasSecret: (path) => path === 'gatewayAccess.apiKey',
  };

  assert.deepEqual(
    buildExecutionContextProjection({ sample: getSample('weather-api-ensure'), ...options }),
    {
      sampleId: 'weather-api-ensure',
      configuredSubscriptionId: 'hub-subscription',
      gateway: null,
    },
  );
  assert.deepEqual(
    buildExecutionContextProjection({ sample: getSample('access-contract-kv-verify'), ...options }),
    {
      sampleId: 'access-contract-kv-verify',
      configuredSubscriptionId: 'vault-subscription',
      gateway: null,
    },
  );
  assert.deepEqual(
    buildExecutionContextProjection({ sample: getSample('weather-mcp-discovery'), ...options }),
    {
      sampleId: 'weather-mcp-discovery',
      configuredSubscriptionId: null,
      gateway: { keyPresent: true, headerName: 'api-key' },
    },
  );
});

test('the execution-context client sends only the safe per-sample context shape', async () => {
  const calls = [];
  const client = createExecutionContextClient({
    fetchImpl: async (path, options) => {
      calls.push({ path, options, body: JSON.parse(options.body) });
      return response({
        context: {
          kind: 'gateway-key',
          label: 'Gateway subscription key',
          summary: 'The request uses the declared APIM subscription key.',
          state: 'ready',
          code: 'gateway-key-ready',
          canExecute: true,
          authority: null,
          subscription: null,
          gateway: { keyPresent: true, headerName: 'api-key' },
          hostedRelay: null,
          guarantees: { tokensExposed: false, credentialsPersisted: false },
        },
        futureHostedProcess: { state: 'deferred' },
      });
    },
  });

  const context = await client.getContext({
    sampleId: 'weather-tools-call',
    configuredSubscriptionId: '00000000-1111-2222-3333-444444444444',
    gateway: { keyPresent: true, headerName: 'api-key', secret: 'must-not-send' },
  });
  assert.equal(context.state, 'ready');
  assert.deepEqual(calls[0].body, {
    protocolVersion: 2,
    sampleId: 'weather-tools-call',
    configuredSubscriptionId: '00000000-1111-2222-3333-444444444444',
    gateway: { keyPresent: true, headerName: 'api-key' },
  });
  assert.equal(calls[0].path, '/api/execution-context');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
});

test('the client preserves a disabled Azure subscription context for recovery controls', async () => {
  const client = createExecutionContextClient({
    fetchImpl: async () =>
      response({
        context: {
          kind: 'azure-cli-token',
          label: 'Azure CLI',
          summary: 'The active subscription is disabled.',
          state: 'subscription-disabled',
          code: 'subscription-disabled',
          canExecute: false,
          signedInAccount: {
            state: 'signed-in',
            principalName: 'operator@example.test',
            principalType: 'user',
            tenantId: 'tenant-1',
          },
          executionCredential: { type: 'azure-cli', source: 'azure-cli' },
          activeCliSubscription: {
            id: '00000000-1111-2222-3333-444444444444',
            name: 'Disabled',
            tenantId: 'tenant-1',
            state: 'Disabled',
          },
          intendedTarget: { subscriptionId: null, matchesActive: null },
          authorization: { state: 'not-checked', label: 'Authorization Not Checked' },
          gateway: null,
          hostedRelay: null,
          guarantees: { tokensExposed: false, credentialsPersisted: false },
        },
        futureHostedProcess: { state: 'deferred' },
      }),
  });

  const context = await client.getContext({
    sampleId: 'azure-context-check',
    configuredSubscriptionId: null,
    gateway: null,
  });
  assert.equal(context.state, 'subscription-disabled');
  assert.equal(context.canExecute, false);
});

test('Azure system login and subscription switching use fixed endpoints and exact request bodies', async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push([path, JSON.parse(options.body)]);
    if (path.endsWith('/list')) {
      return response({
        subscriptions: [
          {
            id: '00000000-1111-2222-3333-444444444444',
            name: 'Sandbox',
            tenantId: 'tenant-1',
            user: { name: 'operator@example.test', type: 'user' },
            isDefault: true,
          },
        ],
        current: {
          signedInAccount: {
            state: 'signed-in',
            principalName: 'operator@example.test',
            principalType: 'user',
            tenantId: 'tenant-1',
          },
          activeCliSubscription: {
            id: '00000000-1111-2222-3333-444444444444',
            name: 'Sandbox',
            tenantId: 'tenant-1',
            state: 'Enabled',
          },
        },
        warning: 'Changes the shared Azure CLI default.',
      });
    }
    if (path.endsWith('/activate')) {
      return response({
        subscription: {
          id: '00000000-1111-2222-3333-444444444444',
          name: 'Sandbox',
          tenantId: 'tenant-1',
          user: { name: 'operator@example.test', type: 'user' },
          isDefault: true,
        },
        current: {
          signedInAccount: {
            state: 'signed-in',
            principalName: 'operator@example.test',
            principalType: 'user',
            tenantId: 'tenant-1',
          },
          activeCliSubscription: {
            id: '00000000-1111-2222-3333-444444444444',
            name: 'Sandbox',
            tenantId: 'tenant-1',
            state: 'Enabled',
          },
        },
        warning: 'Changes the shared Azure CLI default.',
      });
    }
    return response({
      login: {
        id: 'azure-system-login',
        state: path.endsWith('/start') ? 'waiting-system-ui' : path.endsWith('/cancel') ? 'cancelled' : 'ready',
        message: 'Continue in the system account UI.',
        accountChange: 'unverified',
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        expiresAt: new Date(1).toISOString(),
      },
      context: null,
    });
  };
  const client = createExecutionContextClient({ fetchImpl });

  await client.startSystemAzureLogin();
  await client.getSystemAzureLogin('azure-system-login');
  await client.cancelSystemAzureLogin('azure-system-login');
  await client.listAzureSubscriptions();
  await client.activateAzureSubscription('00000000-1111-2222-3333-444444444444');

  assert.deepEqual(calls, [
    ['/api/azure-auth/start', { protocolVersion: 2 }],
    ['/api/azure-auth/status', { protocolVersion: 2, loginId: 'azure-system-login' }],
    ['/api/azure-auth/cancel', { protocolVersion: 2, loginId: 'azure-system-login' }],
    ['/api/azure-subscriptions/list', { protocolVersion: 2 }],
    [
      '/api/azure-subscriptions/activate',
      { protocolVersion: 2, subscriptionId: '00000000-1111-2222-3333-444444444444' },
    ],
  ]);
});

test('subscription refresh reconciles the account and active default from the server snapshot', () => {
  const target = '00000000-1111-2222-3333-444444444444';
  const context = reconcileAzureContextCurrent(
    {
      kind: 'azure-cli-management',
      label: 'Azure CLI',
      summary: 'Stale summary.',
      state: 'subscription-mismatch',
      canExecute: false,
      signedInAccount: {
        state: 'signed-in',
        principalName: 'old@example.test',
        principalType: 'user',
        tenantId: 'tenant-old',
      },
      executionCredential: { type: 'azure-cli-user', source: 'azure-cli' },
      activeCliSubscription: {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        name: 'Old',
        tenantId: 'tenant-old',
        state: 'Enabled',
      },
      intendedTarget: { subscriptionId: target, matchesActive: false },
      authorization: { state: 'not-checked', label: 'Authorization Not Checked' },
    },
    {
      signedInAccount: {
        state: 'signed-in',
        principalName: 'new@example.test',
        principalType: 'user',
        tenantId: 'tenant-new',
      },
      activeCliSubscription: {
        id: target,
        name: 'Fresh',
        tenantId: 'tenant-new',
        state: 'Enabled',
      },
    },
    { sampleId: 'publish-assets' },
  );
  assert.equal(context.state, 'ready-to-attempt');
  assert.equal(context.canExecute, true);
  assert.equal(context.signedInAccount.principalName, 'new@example.test');
  assert.equal(context.executionCredential.principalName, 'new@example.test');
  assert.equal(context.activeCliSubscription.id, target);
  assert.equal(context.intendedTarget.matchesActive, true);
  assert.match(context.summary, /Ready to Attempt/);
});

test('subscription refresh cannot re-enable a disabled active subscription', () => {
  const context = reconcileAzureContextCurrent(
    {
      kind: 'azure-cli-management',
      label: 'Azure CLI',
      summary: 'Disabled.',
      state: 'subscription-disabled',
      code: 'subscription-disabled',
      canExecute: false,
      signedInAccount: {
        state: 'signed-in',
        principalName: 'operator@example.test',
        principalType: 'user',
        tenantId: 'tenant-1',
      },
      executionCredential: { type: 'azure-cli-user', source: 'azure-cli' },
      activeCliSubscription: {
        id: '00000000-1111-2222-3333-444444444444',
        name: 'Disabled',
        tenantId: 'tenant-1',
        state: 'Disabled',
      },
      intendedTarget: { subscriptionId: null, matchesActive: null },
      authorization: { state: 'not-checked', label: 'Authorization Not Checked' },
    },
    {
      signedInAccount: {
        state: 'signed-in',
        principalName: 'operator@example.test',
        principalType: 'user',
        tenantId: 'tenant-1',
      },
      activeCliSubscription: {
        id: '00000000-1111-2222-3333-444444444444',
        name: 'Disabled',
        tenantId: 'tenant-1',
        state: 'Disabled',
      },
    },
  );
  assert.equal(context.state, 'subscription-disabled');
  assert.equal(context.canExecute, false);
});

test('Azure auth capability adapter exposes stable system-login and subscription flags', () => {
  assert.deepEqual(
    azureAuthCapabilityFromPayload({
      azureAuth: {
        systemLogin: { available: true, loginId: 'azure-system-login' },
        subscriptions: { available: true, warning: 'Shared CLI warning.' },
      },
    }),
    {
      systemLoginAllowed: true,
      systemLoginState: 'available',
      loginId: 'azure-system-login',
      accountSwitchLabel: 'Switch Azure account',
      subscriptionsAvailable: true,
      warning: 'Shared CLI warning.',
    },
  );
  assert.equal(azureAuthCapabilityFromPayload({}).systemLoginState, 'login-disabled');
});

test('the execution-context client rejects success-shaped invalid responses', async () => {
  const client = createExecutionContextClient({
    fetchImpl: async () =>
      response({ context: { kind: 'azure-cli-management', label: 'Azure CLI', summary: 'Ready', state: 'ready' } }),
  });
  await assert.rejects(() => client.getContext({ sampleId: 'azure-context-check' }), /canExecute/);
});

test('the execution-context client surfaces server refusal rather than inventing a fallback', async () => {
  const client = createExecutionContextClient({
    fetchImpl: async () =>
      response(
        {
          state: 'blocked',
          summary: 'Local execute mode is required.',
          code: 'preview-unavailable',
        },
        { ok: false, status: 409 },
      ),
  });

  await assert.rejects(() => client.getContext({ sampleId: 'azure-context-check' }), (error) => {
    assert.match(error.message, /Local execute mode is required/);
    assert.match(error.message, /preview-unavailable/);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'preview-unavailable');
    return true;
  });
});

test('Azure login refusal preserves the production summary and reconciles the in-progress descriptor', async () => {
  const client = createExecutionContextClient({
    fetchImpl: async () =>
      response(
        {
          state: 'blocked',
          summary: 'An Azure CLI system sign-in is already in progress.',
          code: 'login-in-progress',
          login: {
            id: 'azure-system-login',
            state: 'waiting-system-ui',
            message: 'Continue the current sign-in.',
            accountChange: 'unverified',
          },
          context: null,
        },
        { ok: false, status: 409 },
      ),
  });
  await assert.rejects(() => client.startSystemAzureLogin(), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'login-in-progress');
    assert.match(error.message, /already in progress/);
    assert.deepEqual(error.login, {
      id: 'azure-system-login',
      state: 'waiting-system-ui',
      message: 'Continue the current sign-in.',
      accountChange: 'unverified',
      loginId: 'azure-system-login',
      context: null,
    });
    return true;
  });
});
