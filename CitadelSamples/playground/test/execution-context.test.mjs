import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOGUE } from '../src/catalogue/index.mjs';
import {
  classifiedSampleIds,
  configuredSubscriptionForSample,
  sampleExecutionContext,
} from '../src/core/executionContext.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import {
  ACCOUNT_SHOW_ARGS,
  DEVICE_CODE_LOGIN_ARGS,
  createExecutionContextManager,
  validateExecutionContextRequest,
  validateLoginStartRequest,
  validateLoginTargetRequest,
} from '../src/server/executionContextManager.mjs';
import { createRunManager } from '../src/server/runManager.mjs';
import { RequestRefused } from '../src/server/runRequest.mjs';
import { createPlaygroundServer } from '../server.mjs';
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
    const current = manager.statusLogin(loginId);
    if (current.login.state === state) return current;
    await new Promise((done) => setTimeout(done, 2));
  }
  assert.fail(`Azure login ${loginId} did not reach ${state}.`);
}

async function withServer(options, body) {
  const server = createPlaygroundServer(options);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const call = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
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
    validateLoginTargetRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION, loginId: 'azure-login-0001' }),
  );
  assert.throws(
    () => validateLoginStartRequest({ protocolVersion: EXECUTION_PROTOCOL_VERSION, args: ['--debug'] }),
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
  assert.equal(result.context.authority.principalName, null);
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
  assert.equal(result.context.state, 'ready');
  assert.equal(result.context.authority.principalName, 'operator@example.test');
  assert.equal(result.context.authority.principalType, 'user');
  assert.equal(result.context.authority.tenantId, 'tenant-0001');
  assert.equal(result.context.subscription.activeName, 'Operator Subscription');
  assert.equal(result.context.subscription.matches, true);
  assert.equal(result.context.guarantees.tokensExposed, false);
  assert.equal(result.context.guarantees.credentialsPersisted, false);
  assert.equal(JSON.stringify(result).includes(JWT), false);
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
  assert.equal(ready.context.state, 'ready');
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
  assert.equal(localGateway.state, 'ready');

  const localManagement = await manager.forRun({
    sampleId: 'publish-assets',
    configuredSubscriptionId: ACTIVE_SUBSCRIPTION,
  });
  assert.equal(localManagement.kind, 'azure-cli-management');
  assert.equal(localManagement.state, 'ready');
});

test('device-code login publishes safe instructions, permits one flight, and refreshes account context', async () => {
  let releaseLogin;
  const held = new Promise((resolvePromise) => {
    releaseLogin = resolvePromise;
  });
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'login') {
      options.onOutput?.({
        stream: 'stderr',
        text: `Open https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate. ${JWT}`,
      });
      await held;
      return { code: 0, stdout: '[{"name":"ignored"}]', stderr: '', timedOut: false, aborted: false };
    }
    return { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });

  const started = manager.startLogin();
  assert.deepEqual(spawn.calls[0].args, DEVICE_CODE_LOGIN_ARGS);
  assert.equal(started.login.state, 'waiting-for-user');
  assert.equal(started.login.verificationUrl, 'https://microsoft.com/devicelogin');
  assert.equal(started.login.userCode, 'ABCD-EFGH');
  assert.equal(JSON.stringify(started).includes(JWT), false);
  assert.throws(
    () => manager.startLogin(),
    (error) => error instanceof RequestRefused && error.code === 'login-in-progress',
  );

  releaseLogin();
  const succeeded = await waitForLogin(manager, started.login.id, 'succeeded');
  assert.equal(succeeded.context.principalName, 'operator@example.test');
  assert.equal(succeeded.context.subscription.activeId, ACTIVE_SUBSCRIPTION);
  assert.equal(JSON.stringify(succeeded).includes(JWT), false);
  assert.deepEqual(spawn.calls[1].args, ACCOUNT_SHOW_ARGS);
});

test('device-code login reports failure without returning process output', async () => {
  const spawn = recordingSpawn(async (options) => {
    options.onOutput?.({ stream: 'stderr', text: `internal failure ${JWT}` });
    return { code: 2, stdout: '', stderr: `internal failure ${JWT}`, timedOut: false, aborted: false };
  });
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const started = manager.startLogin();
  const failed = await waitForLogin(manager, started.login.id, 'failed');
  assert.equal(failed.login.code, 'login-failed');
  assert.equal(JSON.stringify(failed).includes('internal failure'), false);
  assert.equal(JSON.stringify(failed).includes(JWT), false);
});

test('device-code login supports exact cancellation', async () => {
  const spawn = recordingSpawn(
    (options) =>
      new Promise((resolvePromise) => {
        options.onOutput?.({
          stream: 'stderr',
          text: 'Open https://microsoft.com/devicelogin and enter the code WXYZ-1234 to authenticate.',
        });
        options.signal.addEventListener(
          'abort',
          () => resolvePromise({ code: -1, stdout: '', stderr: '', timedOut: false, aborted: true }),
          { once: true },
        );
      }),
  );
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const started = manager.startLogin();
  assert.throws(
    () => manager.cancelLogin('azure-login-9999'),
    (error) => error instanceof RequestRefused && error.code === 'unknown-login',
  );
  const cancelled = manager.cancelLogin(started.login.id);
  assert.equal(cancelled.login.state, 'cancelled');
  assert.equal(cancelled.login.code, 'login-cancelled');
  assert.equal((await waitForLogin(manager, started.login.id, 'cancelled')).login.state, 'cancelled');
});

test('device-code login reports timeout distinctly', async () => {
  const spawn = recordingSpawn(async () => ({
    code: -1,
    stdout: '',
    stderr: '',
    timedOut: true,
    aborted: false,
  }));
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const started = manager.startLogin();
  const timedOut = await waitForLogin(manager, started.login.id, 'timed-out');
  assert.equal(timedOut.login.code, 'login-timeout');
});

test('cancelling during the post-login account refresh cannot flip back to succeeded', async () => {
  let accountStarted;
  const sawAccount = new Promise((resolvePromise) => {
    accountStarted = resolvePromise;
  });
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'login') {
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    accountStarted();
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
    transports: { spawn },
  });
  const started = manager.startLogin();
  await sawAccount;
  const cancelled = manager.cancelLogin(started.login.id);
  assert.equal(cancelled.login.state, 'cancelled');
  await new Promise((done) => setTimeout(done, 5));
  const final = manager.statusLogin(started.login.id);
  assert.equal(final.login.state, 'cancelled');
  assert.equal(final.context, null);
});

test('a post-login account refresh timeout reports a refresh failure, not signed-out', async () => {
  const spawn = recordingSpawn(async (options) =>
    options.args[0] === 'login'
      ? { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false }
      : { code: -1, stdout: '', stderr: '', timedOut: true, aborted: false },
  );
  const manager = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
    transports: { spawn },
  });
  const started = manager.startLogin();
  const failed = await waitForLogin(manager, started.login.id, 'failed');
  assert.equal(failed.login.code, 'login-failed');
  assert.match(failed.login.message, /refreshing the active account timed out/);
  assert.doesNotMatch(failed.login.message, /sign in/i);
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
  });
  assert.equal(result.executionContext.state, 'subscription-mismatch');
  assert.equal(result.executionContext.canExecute, true);
  assert.equal(result.assertions[0].status, 'failed');
  assert.equal(spawn.calls.length, 2, 'one admission probe and one registered diagnostic command should run');
});

test('server exposes the exact context and login endpoints with same-origin preview containment', async () => {
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

    const login = await call('/api/azure-login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(login.status, 501);
    assert.equal((await login.json()).code, 'preview-unavailable');
    assert.equal(spawn.calls.length, 0);
  });
});

test('server device-code endpoints start, poll, and return refreshed context without tokens', async () => {
  let releaseLogin;
  const held = new Promise((resolvePromise) => {
    releaseLogin = resolvePromise;
  });
  const spawn = recordingSpawn(async (options) => {
    if (options.args[0] === 'login') {
      options.onOutput?.({
        stream: 'stderr',
        text: 'Open https://microsoft.com/devicelogin and enter the code SRVR-1234 to authenticate.',
      });
      await held;
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
    }
    return { code: 0, stdout: account(ACTIVE_SUBSCRIPTION), stderr: '', timedOut: false, aborted: false };
  });
  const identity = createExecutionContextManager({
    playgroundRoot: PLAYGROUND_ROOT,
    mode: 'execute',
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
    { mode: 'execute', executionContextManager: identity, runManager },
    async ({ call }) => {
      const start = await call('/api/azure-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
      });
      assert.equal(start.status, 202);
      const started = await start.json();
      assert.equal(started.login.state, 'waiting-for-user');

      releaseLogin();
      await waitForLogin(identity, started.login.id, 'succeeded');
      const status = await call('/api/azure-login/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, loginId: started.login.id }),
      });
      assert.equal(status.status, 200);
      const completed = await status.json();
      assert.equal(completed.login.state, 'succeeded');
      assert.equal(completed.context.subscription.activeName, 'Operator Subscription');
      assert.equal(JSON.stringify(completed).includes(JWT), false);
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
