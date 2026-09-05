import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getSample } from '../src/catalogue/index.mjs';
import {
  buildExecutionContextProjection,
  createExecutionContextClient,
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
  assert.deepEqual(calls[0].options.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
});

test('Azure device login uses fixed endpoints and exact request bodies', async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push([path, JSON.parse(options.body)]);
    return response({
      login: {
        id: 'login-1',
        state: path.endsWith('/start') ? 'waiting-for-user' : path.endsWith('/cancel') ? 'cancelled' : 'succeeded',
        verificationUrl: 'https://microsoft.com/devicelogin',
        userCode: 'ABCD-EFGH',
        message: 'Continue in the browser.',
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        expiresAt: new Date(1).toISOString(),
      },
      context: null,
    });
  };
  const client = createExecutionContextClient({ fetchImpl });

  await client.startAzureLogin();
  await client.getAzureLogin('login-1');
  await client.cancelAzureLogin('login-1');

  assert.deepEqual(calls, [
    ['/api/azure-login/start', { protocolVersion: 2 }],
    ['/api/azure-login/status', { protocolVersion: 2, loginId: 'login-1' }],
    ['/api/azure-login/cancel', { protocolVersion: 2, loginId: 'login-1' }],
  ]);
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
          summary: 'An Azure CLI device-code login is already in progress.',
          code: 'login-in-progress',
          login: {
            id: 'azure-login-0042',
            state: 'waiting-for-user',
            verificationUrl: 'https://microsoft.com/devicelogin',
            userCode: 'RETRY-1234',
            message: 'Continue the current sign-in.',
          },
          context: null,
        },
        { ok: false, status: 409 },
      ),
  });
  await assert.rejects(() => client.startAzureLogin(), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'login-in-progress');
    assert.match(error.message, /already in progress/);
    assert.deepEqual(error.login, {
      id: 'azure-login-0042',
      state: 'waiting-for-user',
      verificationUrl: 'https://microsoft.com/devicelogin',
      userCode: 'RETRY-1234',
      message: 'Continue the current sign-in.',
      loginId: 'azure-login-0042',
      context: null,
    });
    return true;
  });
});
