import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE } from '../src/catalogue/index.mjs';
import {
  AZURE_CLI_PRINCIPAL_TYPES,
  EXECUTION_CONTEXT_STATES,
  classifiedSampleIds,
  configuredSubscriptionForSample,
  sampleExecutionContext,
} from '../src/core/executionContext.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import {
  ACCOUNT_LIST_ARGS,
  ACCOUNT_SHOW_ARGS,
  SYSTEM_AZURE_LOGIN_ARGS,
  SYSTEM_AZURE_LOGIN_ENV,
  SYSTEM_AZURE_LOGIN_ID,
  containsDeviceFallback,
  createExecutionContextManager,
  validateExecutionContextRequest,
  validateLoginStartRequest,
  validateLoginTargetRequest,
  validateSubscriptionActivateRequest,
  validateSubscriptionListRequest,
} from '../src/server/executionContextManager.mjs';
import { createRunManager } from '../src/server/runManager.mjs';
import { RequestRefused } from '../src/server/runRequest.mjs';
import { createPlaygroundServer } from '../server.mjs';
import {
  claimLocalSession,
  createAuthenticatedFetch,
  TEST_BOOTSTRAP_CAPABILITY,
} from './helpers/localSession.mjs';
import { fakeFileSystem } from './helpers/transports.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ACCELERATOR_ROOT = resolve(PLAYGROUND_ROOT, 'runtime', 'accelerator');
const CONFIGURED_SUBSCRIPTION = '00000000-1111-2222-3333-444444444444';
const ACTIVE_SUBSCRIPTION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZWNyZXQifQ.c2lnbmF0dXJl';

const account = (id = ACTIVE_SUBSCRIPTION) =>
  JSON.stringify({
    id,
    name: 'Operator Subscription',
    tenantId: 'tenant-0001',
    user: { name: 'operator@example.test', type: 'user' },
    isDefault: true,
    state: 'Enabled',
  });

const contextRequest = (sampleId, overrides = {}) => ({
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  sampleId,
  configuredSubscriptionId: null,
  gateway: null,
  ...overrides,
});

function recordingSpawn(handler) {
  const calls = [];
  const spawn = async (options) => {
    calls.push(options);
    return handler(options, calls.length);
  };
  spawn.calls = calls;
  return spawn;
}

async function waitForLogin(manager, loginId, state) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = manager.statusSystemLogin(loginId);
    if (current.login.state === state) return current;
    await new Promise((done) => setTimeout(done, 2));
  }
  assert.fail(`Azure login ${loginId} did not reach ${state}.`);
}

async function withServer(options, body) {
  const server = createPlaygroundServer({
    ...options,
    testBootstrapCapability: options?.testBootstrapCapability ?? TEST_BOOTSTRAP_CAPABILITY,
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const claimed = server.localSessionAuth ? await claimLocalSession(baseUrl, TEST_BOOTSTRAP_CAPABILITY) : null;
  const call = claimed
    ? createAuthenticatedFetch(baseUrl, claimed.cookie)
    : (path, init = {}) => fetch(new URL(path, baseUrl), init);
  try {
    return await body({ call, server });
  } finally {
    server.executionContextManager?.cancelAll();
    await new Promise((done) => server.close(done));
  }
}

test('every catalogue sample has exactly one typed execution-context classification', () => {
  assert.deepEqual([...classifiedSampleIds()].sort(), CATALOGUE.samples.map((sample) => sample.id).sort());
  assert.equal(sampleExecutionContext('weather-api-ensure').kind, 'azure-cli-python-management');
  assert.equal(sampleExecutionContext('foundry-enable-a2a').kind, 'azure-cli-foundry-token');
  assert.equal(sampleExecutionContext('agent-framework-hr-question').kind, 'gateway-key');
  assert.match(sampleExecutionContext('access-contract-deploy').summary, /AzureCliCredential/);
  assert.ok(EXECUTION_CONTEXT_STATES.includes('subscription-disabled'));
  assert.deepEqual(AZURE_CLI_PRINCIPAL_TYPES, ['user', 'service-principal', 'managed-identity']);
  assert.equal(
    configuredSubscriptionForSample('access-contract-kv-verify', {
      'hub.subscriptionId': CONFIGURED_SUBSCRIPTION,
      'keyVault.subscriptionId': ACTIVE_SUBSCRIPTION,
    }),
    ACTIVE_SUBSCRIPTION,
  );
  assert.equal(
    configuredSubscriptionForSample('access-contract-kv-verify', {
      'hub.subscriptionId': CONFIGURED_SUBSCRIPTION,
      'keyVault.subscriptionId': '',
    }),
    CONFIGURED_SUBSCRIPTION,
  );
});

test('execution-context requests have an exact safe schema', () => {
  assert.deepEqual(validateExecutionContextRequest(contextRequest('azure-context-check'), CATALOGUE), {
    sampleId: 'azure-context-check',
    configuredSubscriptionId: null,
    gateway: null,
  });
  assert.throws(
    () =>
      validateExecutionContextRequest(
        { ...contextRequest('azure-context-check'), command: ['az', 'login'] },
        CATALOGUE,
      ),
    (error) => error instanceof RequestRefused && error.code === 'forbidden-member',
  );
  assert.throws(
    () =>
      validateExecutionContextRequest(
        contextRequest('azure-context-check', {
          gateway: { keyPresent: true, headerName: 'api-key' },
        }),
        CATALOGUE,
      ),
    (error) => error instanceof RequestRefused && error.code === 'unexpected-gateway-projection',
  );
  assert.throws(
    () =>
      validateExecutionContextRequest(
        contextRequest('weather-mcp-discovery', {
          gateway: { keyPresent: true, headerName: 'bad header' },
        }),
        CATALOGUE,
      ),
    /valid HTTP header name/,
  );
  assert.doesNotThrow(() => validateLoginStartRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION }));
  assert.doesNotThrow(() =>
    validateLoginTargetRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION, loginId: SYSTEM_AZURE_LOGIN_ID }),
  );
  assert.throws(
    () => validateLoginStartRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION, args: ['--debug'] }),
    /accepts exactly/,
  );
  assert.doesNotThrow(() => validateSubscriptionListRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION }));
  assert.equal(
    validateSubscriptionActivateRequest({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      subscriptionId: CONFIGURED_SUBSCRIPTION.toUpperCase(),
    }),
    CONFIGURED_SUBSCRIPTION,
  );
  assert.throws(
    () =>
      validateSubscriptionActivateRequest({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        subscriptionId: CONFIGURED_SUBSCRIPTION,
        name: 'browser-controlled',
      }),
    /accepts exactly/,
  );
});

test('preview reports the classified context as unavailable without spawning anything', async () => {
  const spawn = recordingSpawn(() => {
    throw new Error('preview must not spawn');
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'preview',
    transports: { spawn },
  });
  const result = await manager.describe(contextRequest('foundry-enable-a2a'), CATALOGUE);
  assert.equal(result.context.kind, 'azure-cli-foundry-token');
  assert.equal(result.context.state, 'unavailable');
  assert.equal(result.context.canExecute, false);
  assert.equal(result.futureHostedProcess.identity, 'per-run-managed-identity');
  assert.equal(result.futureHostedProcess.isolation, 'no-ingress-job');
  assert.equal(result.futureHostedProcess.proven, false);
  assert.equal(spawn.calls.length, 0);
});

test('signed-out Azure CLI context is blocked and returns no CLI output', async () => {
  const spawn = recordingSpawn(async (options) => ({
    code: 1,
    stdout: JWT,
    stderr: `Please run az login. ${JWT}`,
    timedOut: false,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const result = await manager.describe(contextRequest('azure-context-check'), CATALOGUE);
  assert.deepEqual(spawn.calls[0].args, ACCOUNT_SHOW_ARGS);
  assert.equal(result.context.state, 'signed-out');
  assert.equal(result.context.code, 'signed-out');
  assert.equal(result.context.signedInAccount.state, 'signed-out');
  assert.equal(result.context.executionCredential.source, 'azure-cli');
  assert.equal(JSON.stringify(result).includes(JWT), false);
});

test('signed-in Azure CLI context exposes only the safe principal and subscription projection', async () => {
  const spawn = recordingSpawn(async () => ({
    code: 0,
    stdout: JSON.stringify({
      id: ACTIVE_SUBSCRIPTION,
      name: 'Operator\u0000 Subscription',
      tenantId: 'tenant-0001',
      user: { name: 'operator@example.test', type: 'user' },
      state: 'Enabled',
      accessToken: JWT,
    }),
    stderr: '',
    timedOut: false,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const result = await manager.describe(
    contextRequest('weather-api-ensure', { configuredSubscriptionId: ACTIVE_SUBSCRIPTION.toUpperCase() }),
    CATALOGUE,
  );
  assert.equal(result.context.kind, 'azure-cli-python-management');
  assert.equal(result.context.state, 'ready-to-attempt');
  assert.equal(result.context.signedInAccount.principalName, 'operator@example.test');
  assert.equal(result.context.signedInAccount.principalType, 'user');
  assert.equal(result.context.signedInAccount.tenantId, 'tenant-0001');
  assert.equal(result.context.activeCliSubscription.name, 'Operator Subscription');
  assert.equal(result.context.intendedTarget.matchesActive, true);
  assert.equal(result.context.authorization.label, 'Authorization Not Checked');
  assert.equal(result.context.guarantees.tokensExposed, false);
  assert.equal(result.context.guarantees.credentialsPersistedInApplicationState, false);
  assert.equal(result.context.guarantees.privateAzureCliCache, 'launch-temporary');
  assert.equal(result.context.guarantees.crashResiduePossible, true);
  assert.equal(JSON.stringify(result).includes(JWT), false);
});

test('run admission binds the reviewed Azure principal, tenant, and subscription', async () => {
  const spawn = recordingSpawn(async () => ({
    code: 0,
    stdout: account(ACTIVE_SUBSCRIPTION),
    stderr: '',
    timedOut: false,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  await assert.rejects(
    () => manager.forRun({ sampleId: 'publish-assets' }),
    (error) => error instanceof RequestRefused && error.code === 'reviewed-identity-required',
  );
  await assert.rejects(
    () =>
      manager.forRun({
        sampleId: 'publish-assets',
        reviewedIdentity: {
          principalName: 'other@example.test',
          principalType: 'user',
          tenantId: 'tenant-0001',
          subscriptionId: ACTIVE_SUBSCRIPTION,
        },
      }),
    (error) => error instanceof RequestRefused && error.code === 'reviewed-identity-changed',
  );
  const context = await manager.forRun({
    sampleId: 'publish-assets',
    reviewedIdentity: {
      principalName: 'operator@example.test',
      principalType: 'user',
      tenantId: 'tenant-0001',
      subscriptionId: ACTIVE_SUBSCRIPTION.toUpperCase(),
    },
  });
  assert.equal(context.canExecute, true);
});

test('run admission uses canonical service-principal and managed-identity types', async () => {
  for (const [cliType, principalType] of [
    ['servicePrincipal', 'service-principal'],
    ['managedIdentity', 'managed-identity'],
  ]) {
    const spawn = recordingSpawn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        id: ACTIVE_SUBSCRIPTION,
        name: 'Active subscription',
        tenantId: 'tenant-0001',
        user: { name: 'automation-principal', type: cliType },
        state: 'Enabled',
      }),
      stderr: '',
      timedOut: false,
      aborted: false,
    }));
    const manager = createExecutionContextManager({
      playgroundRoot: PLAYGROUND_ROOT,
      mode: 'execute',
      transports: { spawn },
    });
    const context = await manager.forRun({
      sampleId: 'publish-assets',
      reviewedIdentity: {
        principalName: 'automation-principal',
        principalType,
        tenantId: 'tenant-0001',
        subscriptionId: ACTIVE_SUBSCRIPTION,
      },
    });
    assert.equal(context.signedInAccount.principalType, principalType);
  }
});

test('a disabled active Azure CLI subscription cannot execute', async () => {
  const spawn = recordingSpawn(async () => ({
    code: 0,
    stdout: JSON.stringify({
      ...JSON.parse(account()),
      state: 'Disabled',
    }),
    stderr: '',
    timedOut: false,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const result = await manager.describe(contextRequest('publish-assets'), CATALOGUE);
  assert.equal(result.context.state, 'subscription-disabled');
  assert.equal(result.context.code, 'subscription-disabled');
  assert.equal(result.context.canExecute, false);
  await assert.rejects(
    () => manager.forRun({ sampleId: 'publish-assets' }),
    (error) => error instanceof RequestRefused && error.code === 'subscription-disabled',
  );
});

test('an incomplete Azure CLI account projection is unavailable and cannot execute', async () => {
  for (const projection of [
    { id: ACTIVE_SUBSCRIPTION },
    {
      id: ACTIVE_SUBSCRIPTION,
      tenantId: 'tenant-0001',
      user: { name: 'operator@example.test', type: 'unexpected-principal-type' },
    },
  ]) {
    const spawn = recordingSpawn(async () => ({
      code: 0,
      stdout: JSON.stringify(projection),
      stderr: '',
      timedOut: false,
      aborted: false,
    }));
    const manager = createExecutionContextManager({
      playgroundRoot: PLAYGROUND_ROOT,
      mode: 'execute',
      transports: { spawn },
    });
    const result = await manager.describe(contextRequest('publish-assets'), CATALOGUE);
    assert.equal(result.context.state, 'unavailable');
    assert.equal(result.context.code, 'account-context-invalid');
    assert.equal(result.context.canExecute, false);
    assert.equal(result.context.signedInAccount.state, 'status-unknown');
  }
});

test('a configured subscription mismatch blocks Azure CLI and AzureCliCredential samples', async () => {
  const spawn = recordingSpawn(async () => ({
    code: 0,
    stdout: account(ACTIVE_SUBSCRIPTION),
    stderr: '',
    timedOut: false,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  for (const sampleId of ['weather-api-ensure', 'access-contract-deploy']) {
    const result = await manager.describe(
      contextRequest(sampleId, { configuredSubscriptionId: CONFIGURED_SUBSCRIPTION }),
      CATALOGUE,
    );
    assert.equal(result.context.state, 'subscription-mismatch');
    assert.equal(result.context.code, 'subscription-mismatch');
    assert.equal(result.context.canExecute, false);
  }
  const diagnostic = await manager.describe(
    contextRequest('azure-context-check', { configuredSubscriptionId: CONFIGURED_SUBSCRIPTION }),
    CATALOGUE,
  );
  assert.equal(diagnostic.context.state, 'subscription-mismatch');
  assert.equal(diagnostic.context.canExecute, true);
  assert.match(diagnostic.context.summary, /diagnostic may run/);
});

test('an Azure CLI account probe timeout is unavailable, not signed-out', async () => {
  const spawn = recordingSpawn(async () => ({
    code: -1,
    stdout: '',
    stderr: 'timed out',
    timedOut: true,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });

  const result = await manager.describe(contextRequest('weather-api-ensure'), CATALOGUE);
  assert.equal(result.context.state, 'unavailable');
  assert.equal(result.context.code, 'azure-cli-timeout');
  assert.match(result.context.summary, /timed out/);
  assert.doesNotMatch(result.context.summary, /sign in/i);
});

test('an execution-context request abort reaches the Azure CLI account probe', async () => {
  const spawn = recordingSpawn(
    (options) =>
      new Promise((resolvePromise) => {
        options.signal.addEventListener(
          'abort',
          () =>
            resolvePromise({
              code: null,
              stdout: '',
              stderr: '',
              timedOut: false,
              aborted: true,
            }),
          { once: true },
        );
      }),
  );
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const controller = new AbortController();
  const pending = manager.describe(contextRequest('azure-context-check'), CATALOGUE, {
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(spawn.calls[0].signal, controller.signal);
  assert.equal(result.context.code, 'azure-cli-cancelled');
});

test('a missing Azure CLI executable is unavailable, not signed-out', async () => {
  const spawn = recordingSpawn(async () => ({
    code: -1,
    stdout: '',
    stderr: 'spawn az ENOENT',
    timedOut: false,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const result = await manager.describe(contextRequest('weather-api-ensure'), CATALOGUE);
  assert.equal(result.context.state, 'unavailable');
  assert.equal(result.context.code, 'azure-cli-unavailable');
  assert.match(result.context.summary, /not available/);
  assert.doesNotMatch(result.context.summary, /sign in/i);
});

test('gateway context reports only key presence and the configured header name', async () => {
  const spawn = recordingSpawn(() => {
    throw new Error('gateway context must not spawn');
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const missing = await manager.describe(contextRequest('weather-mcp-discovery'), CATALOGUE);
  assert.equal(missing.context.state, 'missing-key');
  const ready = await manager.describe(
    contextRequest('weather-mcp-discovery', {
      gateway: { keyPresent: true, headerName: 'Ocp-Apim-Subscription-Key' },
    }),
    CATALOGUE,
  );
  assert.equal(ready.context.state, 'ready-to-attempt');
  assert.deepEqual(ready.context.gateway, {
    keyPresent: true,
    headerName: 'Ocp-Apim-Subscription-Key',
  });
  assert.equal(JSON.stringify(ready).includes('key-value'), false);
  assert.equal(spawn.calls.length, 0);
});

test('hosted HTTP relay context names the Entra, managed identity, and Key Vault authority chain', async () => {
  const spawn = recordingSpawn(() => {
    throw new Error('relay context must not spawn locally');
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'preview',
    relay: { enabled: true, allowedSampleIds: ['a2a-agent-card'] },
    transports: { spawn },
  });
  const ready = await manager.describe(contextRequest('a2a-agent-card'), CATALOGUE);
  assert.equal(ready.context.kind, 'hosted-relay');
  assert.equal(ready.context.state, 'ready');
  assert.deepEqual(ready.context.hostedRelay, {
    callerAuthorization: 'entra',
    relayIdentity: 'tenant-scoped-managed-identity',
    keySource: 'key-vault-mapping',
  });
  const unavailable = await manager.describe(contextRequest('publish-assets'), CATALOGUE);
  assert.equal(unavailable.context.state, 'unavailable');
  assert.equal(unavailable.context.code, 'relay-sample-unavailable');
  assert.match(unavailable.context.summary, /not allowlisted/);
  assert.equal(spawn.calls.length, 0);
});

test('a configured relay never changes the authority used by a direct local run', async () => {
  const spawn = recordingSpawn(async () => ({
    code: 0,
    stdout: account(ACTIVE_SUBSCRIPTION),
    stderr: '',
    timedOut: false,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    relay: { enabled: true, allowedSampleIds: ['a2a-agent-card'] },
    transports: { spawn },
  });
  const effective = await manager.describe(contextRequest('a2a-agent-card'), CATALOGUE);
  assert.equal(effective.context.kind, 'hosted-relay');

  const localGateway = await manager.forRun({
    sampleId: 'a2a-agent-card',
    gateway: { keyPresent: true, headerName: 'api-key' },
  });
  assert.equal(localGateway.kind, 'gateway-key');
  assert.equal(localGateway.state, 'ready-to-attempt');

  const localManagement = await manager.forRun({
    sampleId: 'publish-assets',
    configuredSubscriptionId: ACTIVE_SUBSCRIPTION,
    reviewedIdentity: {
      principalName: 'operator@example.test',
      principalType: 'user',
      tenantId: 'tenant-0001',
      subscriptionId: ACTIVE_SUBSCRIPTION,
    },
  });
  assert.equal(localManagement.kind, 'azure-cli-management');
  assert.equal(localManagement.state, 'ready-to-attempt');
});

test('system login uses exact command and environment, permits one flight, and reports a switched account', async () => {
  let releaseLogin;
  const held = new Promise((resolvePromise) => {
    releaseLogin = resolvePromise;
  });
  let accountReads = 0;
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'account' && options.args[1] === 'show') {
      accountReads += 1;
      return accountReads === 1
        ? { code: 1, stdout: '', stderr: 'signed out', timedOut: false, aborted: false }
        : { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
    }
    if (options.args[0] === 'login') {
      await held;
      return { code: 0, stdout: JWT, stderr: '', timedOut: false, aborted: false };
    }
    assert.fail(`unexpected command ${options.args.join(' ')}`);
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });

  const started = manager.startSystemLogin();
  assert.equal(started.login.id, SYSTEM_AZURE_LOGIN_ID);
  await waitForLogin(manager, started.login.id, 'waiting-system-ui');
  assert.deepEqual(spawn.calls[0].args, ACCOUNT_SHOW_ARGS);
  assert.deepEqual(spawn.calls[1].args, SYSTEM_AZURE_LOGIN_ARGS);
  assert.deepEqual(spawn.calls[1].env, SYSTEM_AZURE_LOGIN_ENV);
  assert.equal(spawn.calls[1].captureOutput, false);
  assert.equal(spawn.calls[1].environmentProfile, 'system-browser');
  assert.equal(JSON.stringify(started).includes(JWT), false);
  assert.throws(
    () => manager.startSystemLogin(),
    (error) => error instanceof RequestRefused && error.code === 'login-in-progress',
  );

  releaseLogin();
  const ready = await waitForLogin(manager, started.login.id, 'ready');
  assert.equal(ready.login.accountChange, 'switched');
  assert.equal(ready.context.signedInAccount.principalName, 'operator@example.test');
  assert.equal(ready.context.activeCliSubscription.id, ACTIVE_SUBSCRIPTION);
  assert.equal(JSON.stringify(ready).includes(JWT), false);
  assert.deepEqual(spawn.calls[2].args, ACCOUNT_SHOW_ARGS);
});

test('system login blocks a CLI device fallback immediately without returning URL, code, or output', async () => {
  const fallbackOutput = `To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH. ${JWT}`;
  let accountReads = 0;
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'account') {
      accountReads += 1;
      return { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    options.onOutput?.({ stream: 'stderr', text: fallbackOutput.slice(0, 40) });
    options.onOutput?.({ stream: 'stderr', text: fallbackOutput.slice(40) });
    assert.equal(options.signal.aborted, true);
    return { code: -1, stdout: fallbackOutput, stderr: fallbackOutput, timedOut: false, aborted: true };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const started = manager.startSystemLogin();
  const blocked = await waitForLogin(manager, started.login.id, 'device-fallback-blocked');
  assert.equal(blocked.login.code, 'device-fallback-blocked');
  assert.match(blocked.login.message, /private CLI session.*terminal/i);
  assert.equal(JSON.stringify(blocked).includes('devicelogin'), false);
  assert.equal(JSON.stringify(blocked).includes('ABCD-EFGH'), false);
  assert.equal(JSON.stringify(blocked).includes(JWT), false);
  assert.equal(accountReads, 1);
  assert.equal(containsDeviceFallback(fallbackOutput), true);
  assert.equal(
    containsDeviceFallback(
      'A web browser has been opened at https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize. ' +
        'Please continue the login in the web browser. If no web browser is available, use device code flow with `az login --use-device-code`.',
    ),
    false,
  );
});

test('system login detects a device fallback split across one output stream despite interleaved output', async () => {
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'account') {
      return { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    options.onOutput?.({
      stream: 'stderr',
      text: 'To sign in, use a web browser to open https://microsoft.com/devi',
    });
    options.onOutput?.({ stream: 'stdout', text: 'unrelated Azure CLI status' });
    options.onOutput?.({ stream: 'stderr', text: 'celogin and enter the code ABCD-EFGH.' });
    assert.equal(options.signal.aborted, true);
    return { code: -1, stdout: '', stderr: '', timedOut: false, aborted: true };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });

  const started = manager.startSystemLogin();
  const blocked = await waitForLogin(manager, started.login.id, 'device-fallback-blocked');
  assert.equal(blocked.login.code, 'device-fallback-blocked');
  assert.equal(JSON.stringify(blocked).includes('devicelogin'), false);
  assert.equal(JSON.stringify(blocked).includes('ABCD-EFGH'), false);
});

test('shutdown drains a login process after device fallback reaches a terminal state', async () => {
  let releaseLogin;
  const heldLogin = new Promise((resolvePromise) => {
    releaseLogin = resolvePromise;
  });
  const fallbackOutput =
    'To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH.';
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'account') {
      return { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    options.onOutput?.({ stream: 'stderr', text: fallbackOutput });
    await heldLogin;
    return { code: -1, stdout: fallbackOutput, stderr: '', timedOut: false, aborted: true };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const started = manager.startSystemLogin();
  await waitForLogin(manager, started.login.id, 'device-fallback-blocked');

  let drained = false;
  const drain = manager.cancelAll().then(() => {
    drained = true;
  });
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(drained, false);
  releaseLogin();
  await drain;
  assert.equal(drained, true);
});

test('shutdown aborts an in-flight post-login account verification', async () => {
  let accountReads = 0;
  let verificationSignal = null;
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'login') {
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    accountReads += 1;
    if (accountReads === 1) {
      return { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    verificationSignal = options.signal;
    return new Promise((resolvePromise) => {
      options.signal.addEventListener(
        'abort',
        () => resolvePromise({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }),
        { once: true },
      );
    });
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });

  const started = manager.startSystemLogin();
  await waitForLogin(manager, started.login.id, 'verifying');
  assert.equal(verificationSignal?.aborted, false);
  await manager.cancelAll();
  assert.equal(verificationSignal.aborted, true);
});

test('shutdown aborts and drains subscription mutation and rejects new mutations', async () => {
  let activationSignal = null;
  const spawn = recordingSpawn(async (options) => {
    activationSignal = options.signal;
    return new Promise((resolvePromise) => {
      options.signal.addEventListener(
        'abort',
        () => resolvePromise({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }),
        { once: true },
      );
    });
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const activation = manager.activateSubscription(CONFIGURED_SUBSCRIPTION);
  const rejected = assert.rejects(
    activation,
    (error) => error instanceof RequestRefused && error.code === 'status-unknown',
  );
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(activationSignal?.aborted, false);
  await manager.cancelAll();
  await rejected;
  assert.equal(activationSignal.aborted, true);
  assert.throws(
    () => manager.startSystemLogin(),
    (error) => error instanceof RequestRefused && error.code === 'identity-manager-closed',
  );
  assert.throws(
    () => manager.acquireRunLease(),
    (error) => error instanceof RequestRefused && error.code === 'identity-manager-closed',
  );
  await assert.rejects(
    () => manager.activateSubscription(CONFIGURED_SUBSCRIPTION),
    (error) => error instanceof RequestRefused && error.code === 'identity-manager-closed',
  );
});

test('subscription reads block identity mutation and are aborted and drained during shutdown', async () => {
  let readSignal = null;
  const spawn = recordingSpawn(async (options) => {
    readSignal = options.signal;
    return new Promise((resolvePromise) => {
      options.signal.addEventListener(
        'abort',
        () => resolvePromise({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }),
        { once: true },
      );
    });
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });

  const read = manager.listSubscriptions();
  const rejected = assert.rejects(
    read,
    (error) => error instanceof RequestRefused && error.code === 'status-unknown',
  );
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(readSignal?.aborted, false);
  assert.throws(
    () => manager.startSystemLogin(),
    (error) => error instanceof RequestRefused && error.code === 'subscription-read-in-progress',
  );
  await assert.rejects(
    () => manager.activateSubscription(CONFIGURED_SUBSCRIPTION),
    (error) => error instanceof RequestRefused && error.code === 'subscription-read-in-progress',
  );

  await manager.cancelAll();
  await rejected;
  assert.equal(readSignal.aborted, true);
  await assert.rejects(
    () => manager.listSubscriptions(),
    (error) => error instanceof RequestRefused && error.code === 'identity-manager-closed',
  );
});

test('system login cancellation rechecks the account and reports an authentication race honestly', async () => {
  let accountReads = 0;
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'account') {
      accountReads += 1;
      return accountReads === 1
        ? { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false }
        : { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
    }
    return new Promise((resolvePromise) => {
      options.signal.addEventListener(
        'abort',
        () => resolvePromise({ code: 0, stdout: '', stderr: '', timedOut: false, aborted: true }),
        { once: true },
      );
    });
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const started = manager.startSystemLogin();
  await waitForLogin(manager, started.login.id, 'waiting-system-ui');
  assert.throws(
    () => manager.cancelSystemLogin('azure-login-9999'),
    (error) => error instanceof RequestRefused && error.code === 'unknown-login',
  );
  const cancelling = manager.cancelSystemLogin(started.login.id);
  assert.equal(cancelling.login.state, 'cancel-requested');
  const ready = await waitForLogin(manager, started.login.id, 'ready');
  assert.equal(ready.login.accountChange, 'switched');
  assert.match(ready.login.message, /account changed/);
});

test('cancelling an unknown pre-login account probe cannot invent an account switch', async () => {
  let accountReads = 0;
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] !== 'account') {
      assert.fail('az login must not start after immediate cancellation');
    }
    accountReads += 1;
    if (accountReads === 1) {
      return new Promise((resolvePromise) => {
        options.signal.addEventListener(
          'abort',
          () => resolvePromise({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }),
          { once: true },
        );
      });
    }
    return { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const started = manager.startSystemLogin();
  manager.cancelSystemLogin(started.login.id);
  const cancelled = await waitForLogin(manager, started.login.id, 'cancelled');
  assert.equal(cancelled.login.accountChange, 'unverified');
  assert.match(cancelled.login.message, /cancelled/i);
  assert.equal(cancelled.context.signedInAccount.principalName, 'operator@example.test');
});

test('system login reports cancellation, timeout, failure, unchanged account, and unknown status distinctly', async () => {
  const scenarios = [
    {
      name: 'cancelled',
      before: { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false },
      login: { code: -1, stdout: '', stderr: '', timedOut: false, aborted: true },
      after: { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false },
      cancel: true,
      state: 'cancelled',
      accountChange: 'unchanged',
    },
    {
      name: 'cancelled at timeout boundary',
      before: { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false },
      login: { code: -1, stdout: '', stderr: '', timedOut: true, aborted: true },
      after: { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false },
      cancel: true,
      state: 'cancelled',
      accountChange: 'unchanged',
    },
    {
      name: 'timed out',
      before: { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false },
      login: { code: -1, stdout: '', stderr: '', timedOut: true, aborted: false },
      state: 'timed-out',
      accountChange: 'unverified',
    },
    {
      name: 'failed',
      before: { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false },
      login: { code: 2, stdout: JWT, stderr: `internal failure ${JWT}`, timedOut: false, aborted: false },
      after: { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false },
      state: 'failed',
      accountChange: 'unverified',
    },
    {
      name: 'Azure CLI unavailable',
      before: { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false },
      login: {
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        spawnFailed: true,
      },
      after: { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false },
      state: 'failed',
      code: 'azure-cli-unavailable',
      accountChange: 'unverified',
    },
    {
      name: 'unchanged',
      before: { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false },
      login: { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false },
      after: { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false },
      state: 'ready',
      accountChange: 'unchanged',
    },
    {
      name: 'status unknown',
      before: { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false },
      login: { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false },
      after: { code: -1, stdout: '', stderr: '', timedOut: true, aborted: false },
      state: 'status-unknown',
      accountChange: 'unverified',
    },
  ];
  for (const scenario of scenarios) {
    let accountReads = 0;
    const spawn = recordingSpawn(async (options) => {
      if (options.args[0] === 'account') {
        accountReads += 1;
        return accountReads === 1 ? scenario.before : scenario.after;
      }
      if (scenario.cancel) {
        return new Promise((resolvePromise) => {
          options.signal.addEventListener('abort', () => resolvePromise(scenario.login), { once: true });
        });
      }
      return scenario.login;
    });
    const manager = createExecutionContextManager({
      playgroundRoot: PLAYGROUND_ROOT,
      mode: 'execute',
      allowSystemAzureLogin: true,
      transports: { spawn },
    });
    const started = manager.startSystemLogin();
    if (scenario.cancel) {
      await waitForLogin(manager, started.login.id, 'waiting-system-ui');
      manager.cancelSystemLogin(started.login.id);
    }
    const final = await waitForLogin(manager, started.login.id, scenario.state);
    assert.equal(final.login.accountChange, scenario.accountChange, scenario.name);
    if (scenario.code) assert.equal(final.login.code, scenario.code, scenario.name);
    assert.equal(JSON.stringify(final).includes(JWT), false, scenario.name);
  }
});

test('system login is disabled unless the server launch explicitly enables it', () => {
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
  });
  assert.throws(
    () => manager.startSystemLogin(),
    (error) => error instanceof RequestRefused && error.code === 'login-disabled',
  );
});

test('run leases serialize Azure CLI mutation against execution', async () => {
  let releaseLogin;
  const heldLogin = new Promise((resolvePromise) => {
    releaseLogin = resolvePromise;
  });
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'account') {
      return { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    options.signal.addEventListener(
      'abort',
      () => releaseLogin({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }),
      { once: true },
    );
    return heldLogin;
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });

  const releaseRun = manager.acquireRunLease();
  assert.throws(
    () => manager.startSystemLogin(),
    (error) => error instanceof RequestRefused && error.code === 'run-in-progress',
  );
  await assert.rejects(
    () => manager.activateSubscription(CONFIGURED_SUBSCRIPTION),
    (error) => error instanceof RequestRefused && error.code === 'run-in-progress',
  );
  releaseRun();

  const started = manager.startSystemLogin();
  await waitForLogin(manager, started.login.id, 'waiting-system-ui');
  assert.throws(
    () => manager.acquireRunLease(),
    (error) => error instanceof RequestRefused && error.code === 'azure-identity-mutation-in-progress',
  );
  manager.cancelSystemLogin(started.login.id);
  await waitForLogin(manager, started.login.id, 'cancelled');
});

test('subscription list returns only enabled records for the current principal and tenant', async () => {
  const enabled = {
    id: ACTIVE_SUBSCRIPTION,
    name: 'Operator Subscription',
    tenantId: 'tenant-0001',
    user: { name: 'operator@example.test', type: 'user' },
    isDefault: true,
    state: 'Enabled',
  };
  const spawn = recordingSpawn(async (options) => {
    if (options.args[1] === 'show') {
      return { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
    }
    assert.deepEqual(options.args, ACCOUNT_LIST_ARGS);
    return {
      code: 0,
      stdout: JSON.stringify([
        enabled,
        { ...enabled, id: CONFIGURED_SUBSCRIPTION, state: 'Disabled' },
        { ...enabled, id: '11111111-2222-3333-4444-555555555555', tenantId: 'tenant-0002' },
        { ...enabled, id: '22222222-3333-4444-5555-666666666666', user: { name: 'other@example.test', type: 'user' } },
        { ...enabled, id: 'not-a-guid' },
      ]),
      stderr: '',
      timedOut: false,
      aborted: false,
    };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const result = await manager.listSubscriptions();
  assert.deepEqual(result.subscriptions, [
    {
      id: ACTIVE_SUBSCRIPTION,
      name: 'Operator Subscription',
      tenantId: 'tenant-0001',
      user: { name: 'operator@example.test', type: 'user' },
      isDefault: true,
    },
  ]);
  assert.match(result.warning, /only this Citadel playground launch/);
});

test('subscription list accepts the complete bounded 500-record inventory', async () => {
  const records = Array.from({ length: 500 }, (_, index) => {
    const suffix = index.toString(16).padStart(12, '0');
    return {
      id: `00000000-1111-2222-3333-${suffix}`,
      name: `Subscription ${index}`,
      tenantId: 'tenant-0001',
      user: { name: 'operator@example.test', type: 'user' },
      isDefault: index === 0,
      state: 'Enabled',
    };
  });
  const inventory = JSON.stringify(records);
  const spawn = recordingSpawn(async (options) => {
    if (options.args[1] === 'show') {
      return {
        code: 0,
        stdout: account(records[0].id),
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    assert.ok(options.maxOutputBytes >= Buffer.byteLength(inventory));
    return { code: 0, stdout: inventory, stderr: '', timedOut: false, aborted: false };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const result = await manager.listSubscriptions();
  assert.equal(result.subscriptions.length, 500);
});

test('subscription activation refreshes, sets one exact enabled ID, and verifies readback', async () => {
  let accountReads = 0;
  const spawn = recordingSpawn(async (options) => {
    if (options.args[1] === 'show') {
      accountReads += 1;
      return {
        code: 0,
        stdout: account(accountReads === 1 ? ACTIVE_SUBSCRIPTION : CONFIGURED_SUBSCRIPTION),
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    if (options.args[1] === 'list') {
      assert.deepEqual(options.args, ACCOUNT_LIST_ARGS);
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            id: CONFIGURED_SUBSCRIPTION,
            name: 'Configured Subscription',
            tenantId: 'tenant-0001',
            user: { name: 'operator@example.test', type: 'user' },
            isDefault: false,
            state: 'Enabled',
          },
        ]),
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    assert.deepEqual(options.args, ['account', 'set', '--subscription', CONFIGURED_SUBSCRIPTION]);
    return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const result = await manager.activateSubscription(CONFIGURED_SUBSCRIPTION);
  assert.equal(result.subscription.id, CONFIGURED_SUBSCRIPTION);
  assert.equal(result.subscription.isDefault, true);
  assert.deepEqual(spawn.calls.map((call) => call.args), [
    ACCOUNT_SHOW_ARGS,
    ACCOUNT_LIST_ARGS,
    ['account', 'set', '--subscription', CONFIGURED_SUBSCRIPTION],
    ACCOUNT_SHOW_ARGS,
  ]);
});

test('subscription activation aborts its Azure CLI process when the caller disconnects', async () => {
  let setSignal;
  let notifySetStarted;
  const setStarted = new Promise((resolvePromise) => {
    notifySetStarted = resolvePromise;
  });
  const spawn = recordingSpawn(async (options) => {
    if (options.args[1] === 'show') {
      return { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
    }
    if (options.args[1] === 'list') {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            id: CONFIGURED_SUBSCRIPTION,
            name: 'Configured Subscription',
            tenantId: 'tenant-0001',
            user: { name: 'operator@example.test', type: 'user' },
            isDefault: false,
            state: 'Enabled',
          },
        ]),
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    setSignal = options.signal;
    notifySetStarted();
    return new Promise((resolvePromise) => {
      options.signal.addEventListener('abort', () => {
        resolvePromise({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      }, { once: true });
    });
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const controller = new AbortController();
  const pending = manager.activateSubscription(CONFIGURED_SUBSCRIPTION, { signal: controller.signal });
  await setStarted;
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof RequestRefused && error.code === 'subscription-set-failed',
  );
  assert.equal(setSignal.aborted, true);
});

test('subscription activation rejects unsafe readback after set', async () => {
  for (const scenario of [
    { state: 'Disabled', isDefault: true, code: 'subscription-readback-disabled' },
    { state: 'Enabled', isDefault: false, code: 'subscription-readback-mismatch' },
    { id: ACTIVE_SUBSCRIPTION, state: 'Enabled', isDefault: true, code: 'subscription-readback-mismatch' },
    { tenantId: 'tenant-0002', state: 'Enabled', isDefault: true, code: 'subscription-context-changed' },
    {
      user: { name: 'other@example.test', type: 'user' },
      state: 'Enabled',
      isDefault: true,
      code: 'subscription-context-changed',
    },
  ]) {
    let accountReads = 0;
    const spawn = recordingSpawn(async (options) => {
      if (options.args[1] === 'show') {
        accountReads += 1;
        const parsed = JSON.parse(account(accountReads === 1 ? ACTIVE_SUBSCRIPTION : CONFIGURED_SUBSCRIPTION));
        if (accountReads > 1) {
          if (scenario.id) parsed.id = scenario.id;
          if (scenario.tenantId) parsed.tenantId = scenario.tenantId;
          if (scenario.user) parsed.user = scenario.user;
          parsed.state = scenario.state;
          parsed.isDefault = scenario.isDefault;
        }
        return { code: 0, stdout: JSON.stringify(parsed), stderr: '', timedOut: false, aborted: false };
      }
      if (options.args[1] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              id: CONFIGURED_SUBSCRIPTION,
              name: 'Configured Subscription',
              tenantId: 'tenant-0001',
              user: { name: 'operator@example.test', type: 'user' },
              isDefault: false,
              state: 'Enabled',
            },
          ]),
          stderr: '',
          timedOut: false,
          aborted: false,
        };
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    });
    const manager = createExecutionContextManager({
      playgroundRoot: PLAYGROUND_ROOT,
      mode: 'execute',
      allowSystemAzureLogin: true,
      transports: { spawn },
    });
    await assert.rejects(
      () => manager.activateSubscription(CONFIGURED_SUBSCRIPTION),
      (error) => error instanceof RequestRefused && error.code === scenario.code,
    );
    assert.equal(spawn.calls.some((call) => call.args[1] === 'set'), true);
  }
});

test('subscription activation rejects stale, wrong-tenant, disabled, malformed, and smuggled requests before set', async () => {
  const cases = [
    { code: 'subscription-not-available', records: [] },
    {
      code: 'subscription-tenant-mismatch',
      records: [
        {
          id: CONFIGURED_SUBSCRIPTION,
          name: 'Wrong tenant',
          tenantId: 'tenant-0002',
          user: { name: 'operator@example.test', type: 'user' },
          isDefault: false,
          state: 'Enabled',
        },
      ],
    },
    {
      code: 'subscription-disabled',
      records: [
        {
          id: CONFIGURED_SUBSCRIPTION,
          name: 'Disabled',
          tenantId: 'tenant-0001',
          user: { name: 'operator@example.test', type: 'user' },
          isDefault: false,
          state: 'Disabled',
        },
      ],
    },
    {
      code: 'subscription-record-invalid',
      records: [
        {
          id: CONFIGURED_SUBSCRIPTION,
          name: '',
          tenantId: 'tenant-0001',
          user: { name: 'operator@example.test', type: 'user' },
          isDefault: false,
          state: 'Enabled',
        },
      ],
    },
  ];
  for (const scenario of cases) {
    const spawn = recordingSpawn(async (options) =>
      options.args[1] === 'show'
        ? { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false }
        : {
            code: 0,
            stdout: JSON.stringify(scenario.records),
            stderr: '',
            timedOut: false,
            aborted: false,
          },
    );
    const manager = createExecutionContextManager({
      playgroundRoot: PLAYGROUND_ROOT,
      mode: 'execute',
      allowSystemAzureLogin: true,
      transports: { spawn },
    });
    await assert.rejects(
      () => manager.activateSubscription(CONFIGURED_SUBSCRIPTION),
      (error) => error instanceof RequestRefused && error.code === scenario.code,
    );
    assert.equal(spawn.calls.some((call) => call.args[1] === 'set'), false);
  }
});

test('Python management run admission stops before a wrapper when CLI auth is absent or mismatched', async () => {
  for (const accountResult of [
    { code: 1, stdout: '', stderr: 'signed out', timedOut: false, aborted: false },
    { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false },
  ]) {
    const spawn = recordingSpawn(async () => accountResult);
    const filesystem = fakeFileSystem({ realReadRoots: [ACCELERATOR_ROOT] });
    const identity = createExecutionContextManager({
      playgroundRoot: PLAYGROUND_ROOT,
      mode: 'execute',
      transports: { spawn },
    });
    const manager = createRunManager({
      playgroundRoot: PLAYGROUND_ROOT,
      transports: {
        spawn,
        fetch: async () => {
          throw new Error('network must not be reached');
        },
        writeFile: filesystem.writeFile,
        access: filesystem.access,
      },
      fs: filesystem.fs,
      pythonExecutable: 'python',
      executionContextManager: identity,
    });
    await assert.rejects(
      () =>
        manager.start({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sampleId: 'weather-api-ensure',
          inputs: {
            'hub.subscriptionId': CONFIGURED_SUBSCRIPTION,
            'hub.resourceGroupName': 'rg-test',
            'hub.apimName': 'apim-test',
          },
          acknowledgement: { accepted: true, sampleId: 'weather-api-ensure' },
        }),
      (error) =>
        error instanceof RequestRefused &&
        (error.code === 'signed-out' || error.code === 'subscription-mismatch'),
    );
    assert.equal(spawn.calls.length, 1, 'only the safe Azure CLI account probe may run');
    assert.deepEqual(spawn.calls[0].args, ACCOUNT_SHOW_ARGS);
    assert.equal(filesystem.files.size, 0);
  }
});

test('run admission rejects an Azure identity changed after browser review before creating a workspace', async () => {
  const spawn = recordingSpawn(async () => ({
    code: 0,
    stdout: account(ACTIVE_SUBSCRIPTION),
    stderr: '',
    timedOut: false,
    aborted: false,
  }));
  const filesystem = fakeFileSystem({ realReadRoots: [ACCELERATOR_ROOT] });
  const identity = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const manager = createRunManager({
    playgroundRoot: PLAYGROUND_ROOT,
    transports: {
      spawn,
      fetch: async () => {
        throw new Error('network must not be reached');
      },
      writeFile: filesystem.writeFile,
      access: filesystem.access,
    },
    fs: filesystem.fs,
    executionContextManager: identity,
  });
  await assert.rejects(
    () =>
      manager.start({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sampleId: 'azure-context-check',
        inputs: { 'hub.subscriptionId': ACTIVE_SUBSCRIPTION },
        reviewedIdentity: {
          principalName: 'previous@example.test',
          principalType: 'user',
          tenantId: 'tenant-0001',
          subscriptionId: ACTIVE_SUBSCRIPTION,
        },
      }),
    (error) => error instanceof RequestRefused && error.code === 'reviewed-identity-changed',
  );
  assert.equal(spawn.calls.length, 1, 'only the post-lease Azure CLI account probe may run');
  assert.equal(filesystem.files.size, 0);
});

test('the read-only Azure context diagnostic still runs so it can report a subscription mismatch', async () => {
  const spawn = recordingSpawn(async () => ({
    code: 0,
    stdout: account(ACTIVE_SUBSCRIPTION),
    stderr: '',
    timedOut: false,
    aborted: false,
  }));
  const filesystem = fakeFileSystem({ realReadRoots: [ACCELERATOR_ROOT] });
  const identity = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const manager = createRunManager({
    playgroundRoot: PLAYGROUND_ROOT,
    transports: {
      spawn,
      fetch: async () => {
        throw new Error('network must not be reached');
      },
      writeFile: filesystem.writeFile,
      access: filesystem.access,
    },
    fs: filesystem.fs,
    pythonExecutable: 'python',
    executionContextManager: identity,
  });
  const result = await manager.start({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId: 'azure-context-check',
    inputs: { 'hub.subscriptionId': CONFIGURED_SUBSCRIPTION },
    reviewedIdentity: {
      principalName: 'operator@example.test',
      principalType: 'user',
      tenantId: 'tenant-0001',
      subscriptionId: ACTIVE_SUBSCRIPTION,
    },
  });
  assert.equal(result.executionContext.state, 'subscription-mismatch');
  assert.equal(result.executionContext.canExecute, true);
  assert.equal(result.assertions[0].status, 'failed');
  assert.equal(
    spawn.calls.length,
    3,
    'admission and pre-effect identity probes must precede the registered diagnostic command',
  );
});

test('identity drift after admission blocks the registered Azure effect', async () => {
  let identityReads = 0;
  const spawn = recordingSpawn(async (options) => {
    if (options.args.join(' ') === ACCOUNT_SHOW_ARGS.join(' ')) {
      identityReads += 1;
      return {
        code: 0,
        stdout:
          identityReads === 1
            ? account(ACTIVE_SUBSCRIPTION)
            : JSON.stringify({
                id: ACTIVE_SUBSCRIPTION,
                name: 'Operator Subscription',
                tenantId: 'tenant-0001',
                user: { name: 'drifted@example.test', type: 'user' },
                isDefault: true,
                state: 'Enabled',
              }),
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    assert.fail(`registered effect ran after identity drift: ${options.args.join(' ')}`);
  });
  const filesystem = fakeFileSystem({ realReadRoots: [ACCELERATOR_ROOT] });
  const identity = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const manager = createRunManager({
    playgroundRoot: PLAYGROUND_ROOT,
    transports: {
      spawn,
      fetch: async () => {
        throw new Error('network must not be reached');
      },
      writeFile: filesystem.writeFile,
      access: filesystem.access,
    },
    fs: filesystem.fs,
    executionContextManager: identity,
  });
  const result = await manager.start({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId: 'azure-context-check',
    inputs: { 'hub.subscriptionId': ACTIVE_SUBSCRIPTION },
    reviewedIdentity: {
      principalName: 'operator@example.test',
      principalType: 'user',
      tenantId: 'tenant-0001',
      subscriptionId: ACTIVE_SUBSCRIPTION,
    },
  });
  assert.equal(result.state, 'failed');
  assert.match(result.steps[0].detail, /next Azure effect was blocked/);
  assert.equal(identityReads, 2);
  assert.equal(spawn.calls.some((call) => call.args.join(' ') === 'account show -o json'), false);
});

test('server advertises disabled system login by default and retires the former endpoint', async () => {
  const spawn = recordingSpawn(() => {
    throw new Error('preview must not spawn');
  });
  const identity = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'preview',
    transports: { spawn },
  });
  await withServer({ mode: 'preview', executionContextManager: identity }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.executionContext.endpoint, '/api/execution-context');
    assert.equal(capabilities.azureAuth.systemLogin.state, 'login-disabled');
    assert.equal(capabilities.azureAuth.systemLogin.startEndpoint, null);
    assert.equal(capabilities.sourceValidation.executionIdentity, 'local-python-parser');

    const contextResponse = await call('/api/execution-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contextRequest('azure-context-check')),
    });
    assert.equal(contextResponse.status, 200);
    assert.equal((await contextResponse.json()).context.state, 'unavailable');

    const crossSite = await call('/api/execution-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify(contextRequest('azure-context-check')),
    });
    assert.equal(crossSite.status, 403);

    const login = await call('/api/azure-auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(login.status, 409);
    assert.equal((await login.json()).login.state, 'login-disabled');
    const gone = await call('/api/azure-login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(gone.status, 410);
    assert.equal((await gone.json()).code, 'legacy-login-gone');
    assert.equal(spawn.calls.length, 0);
  });
});

test('server system-login and subscription endpoints use fixed authenticated schemas without tokens', async () => {
  let releaseLogin;
  const held = new Promise((resolvePromise) => {
    releaseLogin = resolvePromise;
  });
  let accountReads = 0;
  const spawn = recordingSpawn(async (options) => {
    if (options.args[1] === 'show') {
      accountReads += 1;
      return accountReads === 1
        ? { code: 1, stdout: '', stderr: '', timedOut: false, aborted: false }
        : { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
    }
    if (options.args[1] === 'list') {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            id: ACTIVE_SUBSCRIPTION,
            name: 'Operator Subscription',
            tenantId: 'tenant-0001',
            user: { name: 'operator@example.test', type: 'user' },
            isDefault: true,
            state: 'Enabled',
          },
        ]),
        stderr: '',
        timedOut: false,
        aborted: false,
      };
    }
    if (options.args[0] === 'login') {
      await held;
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    assert.fail(`unexpected command ${options.args.join(' ')}`);
  });
  const identity = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    allowSystemAzureLogin: true,
    transports: { spawn },
  });
  const runManager = {
    start: async () => {
      throw new Error('not used');
    },
    cancel: () => ({ cancelled: false }),
    cancelAll: () => {},
  };
  await withServer(
    { mode: 'execute', executionContextManager: identity, runManager, allowSystemAzureLogin: true },
    async ({ call }) => {
      const capabilities = await (await call('/api/capabilities')).json();
      assert.equal(capabilities.azureAuth.systemLogin.available, true);
      assert.equal(capabilities.azureAuth.subscriptions.available, true);

      const start = await call('/api/azure-auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      });
      assert.equal(start.status, 202);
      const started = await start.json();
      assert.equal(started.login.id, SYSTEM_AZURE_LOGIN_ID);

      const duplicate = await call('/api/azure-auth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      });
      assert.equal(duplicate.status, 409);
      const inProgress = await duplicate.json();
      assert.equal(inProgress.code, 'login-in-progress');
      assert.equal(inProgress.login.id, started.login.id);

      releaseLogin();
      await waitForLogin(identity, started.login.id, 'ready');
      const status = await call('/api/azure-auth/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, loginId: started.login.id }),
      });
      assert.equal(status.status, 200);
      const completed = await status.json();
      assert.equal(completed.login.state, 'ready');
      assert.equal(completed.context.activeCliSubscription.name, 'Operator Subscription');
      assert.equal(JSON.stringify(completed).includes(JWT), false);
      assert.equal('verificationUrl' in completed.login, false);
      assert.equal('userCode' in completed.login, false);

      const subscriptions = await call('/api/azure-subscriptions/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      });
      assert.equal(subscriptions.status, 200);
      assert.equal((await subscriptions.json()).subscriptions.length, 1);
    },
  );
});

test('server aborts a subscription operation when its authenticated browser request disconnects', async () => {
  let operationSignal;
  let notifyStarted;
  const started = new Promise((resolvePromise) => {
    notifyStarted = resolvePromise;
  });
  const identity = {
    listSubscriptions: ({ signal }) => {
      operationSignal = signal;
      notifyStarted();
      return new Promise((resolvePromise, rejectPromise) => {
        signal.addEventListener('abort', () => {
          rejectPromise(new RequestRefused('Subscription request cancelled.', {
            status: 409,
            code: 'subscription-request-cancelled',
          }));
        }, { once: true });
      });
    },
    cancelAll: () => {},
  };
  const runManager = {
    start: async () => {
      throw new Error('not used');
    },
    cancel: () => ({ cancelled: false }),
    cancelAll: () => {},
  };
  await withServer(
    { mode: 'execute', executionContextManager: identity, runManager, allowSystemAzureLogin: true },
    async ({ call }) => {
      const controller = new AbortController();
      const request = call('/api/azure-subscriptions/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
        signal: controller.signal,
      });
      await started;
      controller.abort();
      await assert.rejects(request, (error) => error?.name === 'AbortError');
      await new Promise((done) => setTimeout(done, 10));
      assert.equal(operationSignal.aborted, true);
    },
  );
});

test('offline validation context is unavailable when the local Python parser is blocked', async () => {
  const identity = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: {
      spawn: recordingSpawn(() => {
        throw new Error('identity probe must not run');
      }),
    },
  });
  const codeValidationManager = {
    start: async () => ({
      scenario: 'offline-python-validation',
      state: 'blocked',
      summary: 'Not validated — a Python interpreter is not available.',
      sourceExecuted: false,
      azureContacted: false,
      networkContacted: false,
      liveEvidence: false,
    }),
    cancelAll: () => {},
  };
  const runManager = {
    start: async () => {
      throw new Error('not used');
    },
    cancel: () => ({ cancelled: false }),
    cancelAll: () => {},
  };
  await withServer(
    {
      mode: 'execute',
      executionContextManager: identity,
      codeValidationManager,
      runManager,
    },
    async ({ call }) => {
      const response = await call('/api/source/azure-context-check/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.state, 'blocked');
      assert.equal(result.executionContext.kind, 'offline-python');
      assert.equal(result.executionContext.state, 'unavailable');
      assert.equal(result.executionContext.canExecute, false);
    },
  );
});
