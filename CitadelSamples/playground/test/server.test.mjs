/**
 * The server surface and the vendored runtime bundle.
 *
 * Two things are proved here without any real execution:
 *
 *   1. preview mode and operator mode differ in exactly the documented way, and
 *      every state-changing endpoint is guarded before it reaches a manager;
 *   2. the vendored accelerator bundle is byte-identical to its recorded
 *      provenance and is closed under its own relative references, so a run
 *      never needs a file from outside `CitadelSamples`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRelayConfig,
  capabilitiesPayload,
  checkStateChangingRequest,
  createPlaygroundServer,
  isLoopbackHost,
  probeRuntimes,
  resolveServedPath,
} from '../server.mjs';
import { CATALOGUE, getSample } from '../src/catalogue/index.mjs';
import { ACCELERATOR_ROOT, EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import { describeSampleCapability, probeFromCapabilityPayload, summariseCapability } from '../src/core/capability.mjs';
import { canonicalInputDigest } from '../src/relay/acknowledgement.mjs';
import { resolveSpawnInvocation, spawnProcess } from '../src/server/transports.mjs';
import { createRunManager } from '../src/server/runManager.mjs';
import { createDenyAllAuthenticator, createSharedSecretAuthenticator } from '../src/relay/principalAuth.mjs';
import { FIXTURE_VALUES } from './helpers/fixtures.mjs';
import { fakeFileSystem, fakeSpawn } from './helpers/transports.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BUNDLE_ROOT = resolve(PLAYGROUND_ROOT, ACCELERATOR_ROOT);

/** Start a server on an ephemeral port and hand back a fetch helper. */
async function withServer(options, body) {
  const server = createPlaygroundServer(options);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const call = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
  try {
    return await body({ call, port, server });
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/* --------------------------------------------------------------- modes */

test('preview mode executes nothing and says how to attach the executor', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.mode, 'preview');
    assert.equal(capabilities.executor.canExecute, false);
    assert.equal(capabilities.capability.label, 'Preview only');
    assert.match(capabilities.executor.reason, /start:execute/);

    const run = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check' }),
    });
    assert.equal(run.status, 501);
    const payload = await run.json();
    assert.equal(payload.state, 'blocked');
    assert.match(payload.detail, /preview mode/i);
  });
});

test('operator mode reaches the run manager, and the manager decides', async () => {
  const started = [];
  const manager = {
    start: async (payload) => {
      started.push(payload);
      return { runId: 'test-0001', state: 'completed', summary: 'ok', steps: [], assertions: [] };
    },
    cancel: (runId) => ({ cancelled: true, runId }),
    cancelAll: () => {},
    activeCount: 0,
    listActive: () => [],
  };
  await withServer({ mode: 'execute', runManager: manager, probe: { azureCli: { available: true } } }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.mode, 'execute');
    assert.equal(capabilities.executor.kind, 'local');
    assert.equal(capabilities.executor.endpoint, '/api/run');

    const response = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check', inputs: {} }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).runId, 'test-0001');
    assert.equal(started.length, 1);

    const cancelled = await call('/api/run/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'test-0001' }),
    });
    assert.deepEqual(await cancelled.json(), { cancelled: true, runId: 'test-0001' });
  });
});

test('operator mode streams run lifecycle events as bounded NDJSON', async () => {
  const manager = {
    start: async (_payload, { onStart, onProgress }) => {
      onStart({ runId: 'stream-0001', sampleId: 'azure-context-check', workspace: '.' });
      onProgress({ type: 'step-start', step: { id: 'account-show', title: 'Read account', kind: 'azure-cli' } });
      onProgress({
        type: 'step',
        step: { id: 'account-show', title: 'Read account', kind: 'azure-cli', state: 'completed', evidence: {} },
      });
      return { runId: 'stream-0001', state: 'completed', summary: 'ok', steps: [], assertions: [] };
    },
    cancel: (runId) => ({ cancelled: true, runId }),
    cancelAll: () => {},
    activeCount: 0,
    listActive: () => [],
  };

  await withServer({ mode: 'execute', runManager: manager }, async ({ call }) => {
    const response = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check', inputs: {} }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    assert.equal(response.headers.get('x-citadel-run-id'), 'stream-0001');

    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ['run-start', 'step-start', 'step', 'result']);
    assert.equal(events.at(-1).result.state, 'completed');
  });
});

test('disconnecting during delayed execution-context admission aborts the probe and prevents the run from starting', { timeout: 5_000 }, async () => {
  let markAdmissionStarted;
  let markAdmissionCancelled;
  const admissionStarted = new Promise((resolve) => {
    markAdmissionStarted = resolve;
  });
  const admissionCancelled = new Promise((resolve) => {
    markAdmissionCancelled = resolve;
  });
  let observedSignal;
  const executionContextManager = {
    async forRun({ sampleId }, { signal } = {}) {
      observedSignal = signal;
      markAdmissionStarted();
      if (!signal?.aborted) {
        await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
      }
      markAdmissionCancelled();
      return { kind: 'test', state: 'ready', canExecute: true, sampleId };
    },
  };
  const filesystem = fakeFileSystem();
  let executionCalls = 0;
  const manager = createRunManager({
    playgroundRoot: PLAYGROUND_ROOT,
    executionContextManager,
    fs: filesystem.fs,
    transports: {
      spawn: async () => {
        executionCalls += 1;
        return { code: 0, stdout: '{}', stderr: '', timedOut: false, aborted: false };
      },
      fetch: async () => {
        executionCalls += 1;
        return { status: 200, headers: {}, text: async () => '{}' };
      },
      writeFile: filesystem.writeFile,
      access: filesystem.access,
    },
  });

  await withServer({ mode: 'execute', runManager: manager }, async ({ port, server }) => {
    const body = JSON.stringify({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sampleId: 'azure-context-check',
      inputs: { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] },
    });
    const controller = new AbortController();
    try {
      const pending = fetch(`http://127.0.0.1:${port}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      }).then(
        async (response) => ({ kind: 'response', status: response.status, body: await response.text() }),
        (error) => ({ kind: 'error', error }),
      );
      const first = await Promise.race([admissionStarted.then(() => ({ kind: 'admission' })), pending]);
      assert.deepEqual(first, { kind: 'admission' });
      controller.abort();
      await admissionCancelled;
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(observedSignal.aborted, true);
      assert.equal(executionCalls, 0);
      assert.equal(manager.activeCount, 0);
      assert.equal(filesystem.dirs.size, 0, 'no run workspace is created after admission is cancelled');
    } finally {
      server.closeAllConnections?.();
    }
  });
});

test('the relay endpoint applies the same-origin JSON guard before forwarding', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    const crossSite = await call('/api/execute', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: '{}',
    });
    assert.equal(crossSite.status, 403);

    const wrongType = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(wrongType.status, 415);
  });
});

/* ------------------------------------------------------------ self-test */

test('the self-test endpoint is available in preview mode, contacts no Azure service, and cannot be mistaken for a live scenario', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.deepEqual(capabilities.selfTest, {
      endpoint: '/api/self-test',
      available: true,
      scenario: 'offline-self-test',
    });

    const response = await call('/api/self-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.scenario, 'offline-self-test');
    assert.equal(payload.mode, 'preview');
    assert.equal(payload.azureContacted, false);
    assert.equal(payload.liveEvidence, false);
    assert.equal(payload.state, 'passed');
    assert.equal(CATALOGUE.byId.has(payload.scenario), false, 'the self-test scenario id must never collide with a catalogue sample id');
    assert.equal(payload.checks.length, 5);
    assert.ok(payload.checks.every((check) => check.passed === true));
  });
});

test('the self-test endpoint is available in operator (execute) mode too, and still reports no Azure contact', async () => {
  await withServer({ mode: 'execute', probe: { azureCli: { available: true } } }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.selfTest.available, true);

    const response = await call('/api/self-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.mode, 'execute');
    assert.equal(payload.azureContacted, false);
    assert.equal(payload.liveEvidence, false);
  });
});

test('the self-test endpoint applies the same guard as every other state-changing route', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    const crossSite = await call('/api/self-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(crossSite.status, 403);
    const crossSitePayload = await crossSite.json();
    assert.equal(crossSitePayload.azureContacted, false);
    assert.equal(crossSitePayload.liveEvidence, false);

    const wrongType = await call('/api/self-test', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(wrongType.status, 415);

    const wrongMethod = await call('/api/self-test');
    assert.equal(wrongMethod.status, 405);
  });
});

test('the self-test endpoint accepts exactly { protocolVersion } and refuses everything else, by name', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    const badVersion = await call('/api/self-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 999 }),
    });
    assert.equal(badVersion.status, 400);
    const badVersionPayload = await badVersion.json();
    assert.equal(badVersionPayload.state, 'blocked');
    assert.equal(badVersionPayload.code, 'protocol-version');

    const extraMember = await call('/api/self-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'cleanup' }),
    });
    assert.equal(extraMember.status, 400);
    const extraMemberPayload = await extraMember.json();
    assert.equal(extraMemberPayload.state, 'blocked');
    assert.equal(extraMemberPayload.code, 'forbidden-member');

    const emptyBody = await call('/api/self-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(emptyBody.status, 400);
  });
});

/* ---------------------------------------------------- protected source */

test('protected source is readable in every mode, but Python validation is execute-only', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.protectedSource.available, true);
    assert.equal(capabilities.protectedSource.editable, false);
    assert.equal(capabilities.sourceValidation.available, false);

    const response = await call('/api/source/azure-context-check');
    assert.equal(response.status, 200);
    const source = await response.json();
    assert.equal(source.sampleId, 'azure-context-check');
    assert.equal(source.notebook.sha256, CATALOGUE.sourceNotebook.sha256);
    assert.equal(source.protection.editable, false);
    assert.ok(source.cells.length > 0);
    assert.ok(source.cells.every((cell) => cell.editable === false && cell.protected === true));

    const validation = await call('/api/source/azure-context-check/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(validation.status, 501);
    const result = await validation.json();
    assert.equal(result.state, 'blocked');
    assert.equal(result.sourceExecuted, false);
    assert.equal(result.azureContacted, false);
    assert.equal(result.networkContacted, false);
    assert.equal(result.liveEvidence, false);
  });
});

test('protected source rejects unknown samples and non-GET methods', async () => {
  await withServer({ mode: 'preview' }, async ({ call }) => {
    assert.equal((await call('/api/source/not-a-sample')).status, 404);
    assert.equal(
      (
        await call('/api/source/azure-context-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      405,
    );
  });
});

test('execute-mode source validation accepts only the fixed protocol request', async () => {
  const calls = [];
  const manager = {
    start: async (sampleId, payload) => {
      calls.push({ sampleId, payload });
      return {
        scenario: 'offline-python-source-validation',
        sampleId,
        runId: 'code-azure-context-check-0001',
        state: 'passed',
        summary: 'Protected source compiled.',
        mode: 'offline-local',
        validation: 'python-compile-only',
        sourceEditable: false,
        sourceExecuted: false,
        azureContacted: false,
        networkContacted: false,
        liveEvidence: false,
        source: null,
        steps: [],
        checks: [],
        artifact: null,
        workspaceRemoved: true,
      };
    },
    cancelAll: () => {},
  };
  await withServer({ mode: 'execute', codeValidationManager: manager }, async ({ call }) => {
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.sourceValidation.available, true);

    const response = await call('/api/source/azure-context-check/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'passed');
    assert.deepEqual(calls, [
      {
        sampleId: 'azure-context-check',
        payload: { protocolVersion: EXECUTION_PROTOCOL_VERSION },
      },
    ]);
  });

  await withServer({ mode: 'execute' }, async ({ call }) => {
    const response = await call('/api/source/azure-context-check/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        code: 'print("browser supplied")',
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'forbidden-member');
  });
});

test('disconnecting a source-validation socket cancels its exact run and releases the slot', async () => {
  let sequence = 0;
  let markFirstStarted;
  const firstStarted = new Promise((resolveStarted) => {
    markFirstStarted = resolveStarted;
  });
  const active = new Map();
  const cancelled = [];
  const result = (sampleId, runId, state) => ({
    scenario: 'offline-python-source-validation',
    sampleId,
    runId,
    state,
    summary: state === 'cancelled' ? 'Cancelled.' : 'Protected source compiled.',
    mode: 'offline-local',
    validation: 'python-compile-only',
    sourceEditable: false,
    sourceExecuted: false,
    azureContacted: false,
    networkContacted: false,
    liveEvidence: false,
    source: null,
    steps: [],
    checks: [],
    artifact: null,
    workspaceRemoved: true,
  });
  const manager = {
    async start(sampleId, _payload, { onStart } = {}) {
      sequence += 1;
      const runId = `code-${sampleId}-${String(sequence).padStart(4, '0')}`;
      if (sequence > 1) return result(sampleId, runId, 'passed');
      let finish;
      const completion = new Promise((resolveCompletion) => {
        finish = resolveCompletion;
      });
      active.set(runId, { finish, sampleId });
      onStart?.({ runId, sampleId });
      markFirstStarted(runId);
      try {
        return await completion;
      } finally {
        active.delete(runId);
      }
    },
    cancel(runId) {
      const run = active.get(runId);
      if (!run) return { cancelled: false };
      cancelled.push(runId);
      run.finish(result(run.sampleId, runId, 'cancelled'));
      return { cancelled: true, runId };
    },
    cancelAll() {
      for (const runId of active.keys()) this.cancel(runId);
    },
    get activeCount() {
      return active.size;
    },
  };

  await withServer({ mode: 'execute', codeValidationManager: manager }, async ({ call, port }) => {
    const body = JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION });
    let socketRequest;
    const socketClosed = new Promise((resolveClosed) => {
      socketRequest = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/source/azure-context-check/validate',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      });
      socketRequest.once('error', resolveClosed);
      socketRequest.once('close', resolveClosed);
      socketRequest.end(body);
    });

    const firstRunId = await firstStarted;
    assert.equal(manager.activeCount, 1);
    socketRequest.destroy();
    await socketClosed;
    const deadline = Date.now() + 2_000;
    while (manager.activeCount > 0 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.deepEqual(cancelled, [firstRunId]);
    assert.equal(manager.activeCount, 0);

    const next = await call('/api/source/azure-context-check/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(next.status, 200);
    assert.equal((await next.json()).state, 'passed');
    assert.deepEqual(cancelled, [firstRunId], 'a completed request must not be cancelled');
  });
});

/* --------------------------------------------------------- relay wiring */

/** A relay config for tests: no network, no env vars, a fully injectable seam. */
function fakeRelay({
  fetchImpl,
  authenticator = createDenyAllAuthenticator(),
  allowedSampleIds = ['weather-mcp-discovery'],
  callerPrincipal = 'citadel-playground-proxy',
  tenant = 'default-tenant',
} = {}) {
  return {
    enabled: true,
    url: 'https://relay.internal.example/execute',
    fetchImpl,
    credentialProvider: { getAuthorizationHeader: async () => 'test-credential' },
    authenticator,
    allowedSampleIds,
    callerPrincipal,
    tenant,
  };
}

const WEATHER_MCP_REQUEST = {
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  sampleId: 'weather-mcp-discovery',
  inputs: { 'hub.gatewayUrl': 'https://gw.example.net' },
};

test('buildRelayConfig is disabled with no URL configured, and never touches other env vars', () => {
  assert.deepEqual(buildRelayConfig({}), { enabled: false });
});

test('buildRelayConfig defaults callerPrincipal/tenant to fixed, non-blank values when unset', () => {
  const config = buildRelayConfig({ CITADEL_PLAYGROUND_RELAY_URL: 'https://relay.example/execute' });
  assert.equal(config.enabled, true);
  assert.equal(config.callerPrincipal, 'citadel-playground-proxy');
  assert.equal(config.tenant, 'default-tenant');
});

test('buildRelayConfig reads callerPrincipal/tenant from their own env vars when configured', () => {
  const config = buildRelayConfig({
    CITADEL_PLAYGROUND_RELAY_URL: 'https://relay.example/execute',
    CITADEL_PLAYGROUND_RELAY_CALLER_PRINCIPAL: 'proxy-east-1',
    CITADEL_PLAYGROUND_RELAY_TENANT: 'tenant-east',
  });
  assert.equal(config.callerPrincipal, 'proxy-east-1');
  assert.equal(config.tenant, 'tenant-east');
});

test('buildRelayConfig binds managed identity to the supplied Container Apps environment and user-assigned client id', async () => {
  const savedFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          access_token: 'playground-relay-token',
          expires_on: Math.floor(Date.now() / 1000) + 3600,
        }),
      };
    };
    const config = buildRelayConfig({
      CITADEL_PLAYGROUND_RELAY_URL: 'https://relay.internal.example/execute',
      CITADEL_PLAYGROUND_RELAY_RESOURCE: 'api://relay-app',
      CITADEL_PLAYGROUND_RELAY_CLIENT_ID: 'playground-user-assigned-id',
      CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED: 'true',
      CITADEL_PLAYGROUND_ENTRA_TENANT_ID: 'tenant-a',
      IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
      IDENTITY_HEADER: 'playground-identity-header',
    });

    assert.equal(await config.credentialProvider.getAuthorizationHeader(), 'Bearer playground-relay-token');
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.get('client_id'), 'playground-user-assigned-id');
    assert.deepEqual(calls[0].init.headers, { 'X-IDENTITY-HEADER': 'playground-identity-header' });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('the hosted playground requires its deployment-owned user-assigned client id', () => {
  assert.throws(
    () =>
      buildRelayConfig({
        CITADEL_PLAYGROUND_RELAY_URL: 'https://relay.internal.example/execute',
        CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED: 'true',
        CITADEL_PLAYGROUND_ENTRA_TENANT_ID: 'tenant-a',
        IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
        IDENTITY_HEADER: 'playground-identity-header',
      }),
    /CITADEL_PLAYGROUND_RELAY_CLIENT_ID must be configured/,
  );
});

test('a relay-disabled server answers /api/execute with 501, never forwarding anything', async () => {
  await withServer({ mode: 'preview', relay: { enabled: false } }, async ({ call }) => {
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(response.status, 501);
    assert.equal((await response.json()).state, 'blocked');
  });
});

test('a loopback caller reaches an enabled relay without presenting a credential', async () => {
  const calls = [];
  const relay = fakeRelay({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ state: 'completed', summary: 'Ran on the relay.' }),
      };
    },
  });
  await withServer({ mode: 'preview', relay }, async ({ call }) => {
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, relay.url);
  });
});

test('the local proxy mints its own nonce and forwards only the canonical, validated shape', async () => {
  const calls = [];
  const relay = fakeRelay({
    fetchImpl: async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay }, async ({ call }) => {
    // The caller supplies forbidden members (a URL, a header set, a plan) —
    // none of it may reach the relay.
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...WEATHER_MCP_REQUEST,
        url: 'https://attacker.example/steal',
        headers: { 'X-Injected': 'yes' },
        plan: { steps: [] },
      }),
    });
    assert.equal(response.status, 400, 'a forbidden member must be rejected before anything is forwarded');
    assert.equal(calls.length, 0);
  });

  const response = await withServer({ mode: 'preview', relay }, ({ call }) =>
    call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const forwarded = JSON.parse(calls[0].body);
  assert.deepEqual(Object.keys(forwarded).sort(), ['acknowledgement', 'inputs', 'protocolVersion', 'sampleId', 'secretRefs']);
  assert.equal(forwarded.sampleId, 'weather-mcp-discovery');
  assert.equal(forwarded.protocolVersion, EXECUTION_PROTOCOL_VERSION);
  assert.deepEqual(forwarded.secretRefs, ['gatewayAccess.apiKey']);
  assert.ok(!('url' in forwarded));
  assert.ok(!('headers' in forwarded));
  assert.ok(!('plan' in forwarded));
  assert.equal(typeof forwarded.acknowledgement.nonce, 'string');
  assert.ok(forwarded.acknowledgement.nonce.length >= 8);
  assert.equal(forwarded.acknowledgement.sampleId, 'weather-mcp-discovery');
  assert.equal(calls[0].headers.Authorization, 'test-credential');
});

test('the acknowledgement the proxy mints is bound to the destination, inputs and risk text of THIS request', async () => {
  const calls = [];
  const relay = fakeRelay({
    fetchImpl: async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay }, ({ call }) =>
    call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    }),
  );
  const forwarded = JSON.parse(calls[0].body);
  const ack = forwarded.acknowledgement;
  assert.equal(ack.accepted, true);
  assert.equal(ack.target, 'https://gw.example.net/mcp/weather-tool-mcp/mcp', 'target is the literal request URL this plan will actually contact, not merely the gateway origin');
  assert.equal(ack.riskText, getSample('weather-mcp-discovery').risk.effect);
  assert.equal(ack.caller, 'citadel-playground-proxy', "the acknowledgement is bound to the relay's own configured caller identity for this proxy, not the browser-facing /api/execute principal");
  assert.equal(ack.tenant, 'default-tenant', "the acknowledgement is bound to the relay's own configured tenant for this proxy");
  assert.equal(
    ack.inputDigest,
    canonicalInputDigest({ sampleId: 'weather-mcp-discovery', inputs: WEATHER_MCP_REQUEST.inputs, secretRefs: ['gatewayAccess.apiKey'] }),
  );
  assert.ok(ack.expiresAt > Date.now(), 'a freshly minted acknowledgement has not already expired');
  assert.ok(!('accepted' in (WEATHER_MCP_REQUEST.acknowledgement ?? {})), 'sanity: the browser sent no acknowledgement at all');
});

test('the acknowledgement target follows a recorded deployedEndpoint, not hub.gatewayUrl, when only the endpoint is set', async () => {
  // `deployedEndpoint` is authoritative once set (`mcpEndpoint()` in
  // `src/core/endpoints.mjs`): the plan this sample builds contacts that
  // endpoint directly, not anything composed from a gateway URL. Nothing
  // else is supplied here — `hub.gatewayUrl` is conditional and blank is
  // fine once a deployed endpoint is recorded — so a correct acknowledgement
  // MUST bind to the endpoint's own origin.
  const calls = [];
  const relay = fakeRelay({
    fetchImpl: async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay }, ({ call }) =>
    call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...WEATHER_MCP_REQUEST,
        inputs: { 'samples.weather-mcp-discovery.deployedEndpoint': 'https://deployed.example.net' },
      }),
    }),
  );
  assert.equal(calls.length, 1);
  const forwarded = JSON.parse(calls[0].body);
  assert.equal(
    forwarded.acknowledgement.target,
    'https://deployed.example.net/',
    'the recorded deployed endpoint is the only destination this plan actually contacts',
  );
});

test('the acknowledgement target follows deployedEndpoint over hub.gatewayUrl when both are set', async () => {
  // The regression this guards against: the OLD code derived the
  // acknowledgement target from raw `inputs['hub.gatewayUrl']` directly,
  // so setting both fields would have bound the acknowledgement to
  // `gw.example.net` even though `mcpEndpoint()` — and therefore the plan
  // this sample actually executes — contacts `deployed.example.net`
  // instead, because a recorded deployed endpoint always wins. Deriving the
  // target from the proxy's own rebuilt plan (via `planRequestUrls`) fixes
  // this: the acknowledgement now binds to the literal URL the plan will
  // actually reach.
  const calls = [];
  const relay = fakeRelay({
    fetchImpl: async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay }, ({ call }) =>
    call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...WEATHER_MCP_REQUEST,
        inputs: {
          'hub.gatewayUrl': 'https://gw.example.net',
          'samples.weather-mcp-discovery.deployedEndpoint': 'https://deployed.example.net',
        },
      }),
    }),
  );
  assert.equal(calls.length, 1);
  const forwarded = JSON.parse(calls[0].body);
  assert.equal(
    forwarded.acknowledgement.target,
    'https://deployed.example.net/',
    'deployedEndpoint is authoritative and overrides hub.gatewayUrl, so the acknowledgement must not bind to the gateway URL',
  );
});

test('a sample whose gateway URL input is not a well-formed https URL is refused before a plan is ever rebuilt, never forwarded', async () => {
  // `hub.gatewayUrl` is a `type: 'url'` field, so `not-a-url` fails the
  // catalogue's own https-only format check inside `rebuildRelayPlan` — the
  // very same validation the proxy's own `buildSamplePlan` call performs —
  // long before the plan-rebuild's destination-derivation step is reached.
  // That earlier, more specific failure (400, `invalid-configuration`) is
  // what a malformed URL actually produces today; the generic 502 "no
  // resolvable gateway destination" path guards a plan that rebuilds
  // successfully yet resolves no origin at all, which no catalogue sample
  // currently reaches (see the acknowledgement/target tests below for the
  // path that IS reachable: a valid but different destination).
  const calls = [];
  const relay = fakeRelay({
    fetchImpl: async (url, init) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay }, async ({ call }) => {
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...WEATHER_MCP_REQUEST, inputs: { 'hub.gatewayUrl': 'not-a-url' } }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.code, 'invalid-configuration');
    assert.match(payload.summary, /https:\/\/ URL/);
    assert.equal(calls.length, 0, 'nothing is forwarded when the configuration itself does not validate');
  });
});

test('two forwarded requests for the same sample carry two different nonces', async () => {
  const bodies = [];
  const relay = fakeRelay({
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay }, async ({ call }) => {
    for (let i = 0; i < 2; i++) {
      await call('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(WEATHER_MCP_REQUEST),
      });
    }
  });
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].acknowledgement.nonce, bodies[1].acknowledgement.nonce);
});

test('the relay endpoint rejects a sample outside its own allow-list, before forwarding', async () => {
  const calls = [];
  const relay = fakeRelay({
    allowedSampleIds: ['a2a-agent-card'],
    fetchImpl: async () => {
      calls.push(1);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay }, async ({ call }) => {
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).state, 'blocked');
    assert.equal(calls.length, 0);
  });
});

test('a non-loopback bind refuses every /api/execute caller by default (fail closed)', async () => {
  const calls = [];
  const relay = fakeRelay({
    fetchImpl: async () => {
      calls.push(1);
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  await withServer({ mode: 'preview', relay, host: 'playground.example.net' }, async ({ call }) => {
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
});

test('a non-loopback bind accepts a caller that presents the configured shared secret', async () => {
  const calls = [];
  const relay = fakeRelay({
    authenticator: createSharedSecretAuthenticator({ token: 'operator-secret' }),
    fetchImpl: async () => {
      calls.push(1);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'completed', summary: 'ok' }) };
    },
  });
  await withServer({ mode: 'preview', relay, host: 'playground.example.net' }, async ({ call }) => {
    const unauthenticated = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(unauthenticated.status, 401);

    const authenticated = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer operator-secret' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(authenticated.status, 200);
    assert.equal(calls.length, 1);
  });
});

test('the relay endpoint maps an unreachable relay and a non-JSON relay answer to 502', async () => {
  const offline = fakeRelay({
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  await withServer({ mode: 'preview', relay: offline }, async ({ call }) => {
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(response.status, 502);
  });

  const garbled = fakeRelay({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json' }),
  });
  await withServer({ mode: 'preview', relay: garbled }, async ({ call }) => {
    const response = await call('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(WEATHER_MCP_REQUEST),
    });
    assert.equal(response.status, 502);
  });
});

test('the capability payload reports the exact relay allow-list, and nothing wider', () => {
  const relay = fakeRelay({ allowedSampleIds: ['weather-mcp-discovery', 'a2a-agent-card'] });
  const payload = capabilitiesPayload({ mode: 'preview', relay });
  assert.equal(payload.executor.kind, 'relay');
  assert.deepEqual([...payload.executor.allowedSampleIds].sort(), ['a2a-agent-card', 'weather-mcp-discovery']);
  assert.equal(payload.relayConfigured, true);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(relay.url), 'the relay URL must never be disclosed to the browser');
});

test('operator mode exposes the run id in response headers before the run finishes', async () => {
  let finish;
  const held = new Promise((resolve) => {
    finish = resolve;
  });
  const manager = {
    start: async (_payload, { onStart }) => {
      onStart({ runId: 'active-run-0001' });
      await held;
      return { runId: 'active-run-0001', state: 'cancelled', summary: 'cancelled', steps: [], assertions: [] };
    },
    cancel: (runId) => {
      finish();
      return { cancelled: true, runId };
    },
    cancelAll: () => finish(),
    activeCount: 1,
    listActive: () => [{ runId: 'active-run-0001' }],
  };
  await withServer({ mode: 'execute', runManager: manager }, async ({ call }) => {
    const response = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: 'azure-context-check', inputs: {} }),
    });
    assert.equal(response.headers.get('X-Citadel-Run-Id'), 'active-run-0001');

    const cancelled = await call('/api/run/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'active-run-0001' }),
    });
    assert.equal((await cancelled.json()).cancelled, true);
    assert.equal((await response.json()).state, 'cancelled');
  });
});

test('local execution is refused on a non-loopback host', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('10.1.2.3'), false);
  assert.equal(isLoopbackHost('playground.example.net'), false);
});

/* ------------------------------------------------------ request guards */

test('a state-changing call must be same-origin and carry a JSON content type', () => {
  const make = (headers) => ({ headers });
  assert.equal(checkStateChangingRequest(make({ 'content-type': 'application/json' })).ok, true);

  const crossSite = checkStateChangingRequest(make({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }));
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.status, 403);

  const badOrigin = checkStateChangingRequest(
    make({ origin: 'https://evil.test', 'content-type': 'application/json' }),
    { port: 4173, host: '127.0.0.1' },
  );
  assert.equal(badOrigin.ok, false);
  assert.equal(badOrigin.status, 403);

  const formPost = checkStateChangingRequest(make({ 'content-type': 'application/x-www-form-urlencoded' }));
  assert.equal(formPost.ok, false);
  assert.equal(formPost.status, 415);
});

test('the state-changing guard accepts IPv6 loopback only at the configured origin', () => {
  const make = (origin) => ({
    headers: {
      origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
  });
  const options = { port: 4173, host: '::1' };

  assert.equal(checkStateChangingRequest(make('http://[::1]:4173'), options).ok, true);
  assert.equal(checkStateChangingRequest(make('http://[::1]:4173'), { ...options, host: '[::1]' }).ok, true);

  for (const origin of [
    'https://[::1]:4173',
    'http://[::1]:4174',
    'http://[::2]:4173',
    'http://127.0.0.2:4173',
    'http://localhost.example:4173',
  ]) {
    const result = checkStateChangingRequest(make(origin), options);
    assert.equal(result.ok, false, `${origin} must not be accepted`);
    assert.equal(result.status, 403);
  }
});

test('an oversized body is refused before it is parsed', async () => {
  const manager = { start: async () => ({ runId: 'x' }), cancel: () => ({}), cancelAll: () => {} };
  await withServer({ mode: 'execute', runManager: manager }, async ({ call }) => {
    const response = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, sampleId: 'azure-context-check', pad: 'x'.repeat(300 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).summary, /256 KB/);
  });
});

test('the server refuses to serve anything outside web/ and src/', () => {
  assert.equal(resolveServedPath('/../../secret.txt'), null);
  assert.equal(resolveServedPath('/package.json'), null);
  assert.equal(resolveServedPath('/runtime/accelerator/citadel-publish-contracts/main.bicep'), null);
  assert.equal(resolveServedPath('/.runs/anything'), null);
  assert.ok(resolveServedPath('/web/index.html'));
  assert.ok(resolveServedPath('/src/catalogue/index.mjs'));
});

test('the capability payload never discloses a relay URL or token', () => {
  const payload = JSON.stringify(capabilitiesPayload({ mode: 'preview' }));
  assert.ok(!payload.includes('RELAY_URL'));
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(payload), 'no external URL is disclosed');
  assert.equal(typeof capabilitiesPayload({ mode: 'preview' }).relayConfigured, 'boolean');
});

/* ----------------------------------------------------- capability model */

test('every sample reports preview-only until the executor is attached', () => {
  for (const sample of CATALOGUE.samples) {
    const capability = describeSampleCapability(sample, { mode: 'preview' });
    assert.equal(capability.state, 'preview-only');
    assert.equal(capability.ready, false);
    assert.match(capability.reasons[0], /preview mode/);
  }
  const summary = summariseCapability(CATALOGUE.samples, { mode: 'preview' });
  assert.equal(summary.ready, 0);
  assert.equal(summary.total, 19);
});

test('capability is per sample: the six gateway recipes need no CLI and no Python', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: false, reason: 'not installed' },
    python: { available: false, reason: 'not installed' },
    accelerator: { available: true, files: 22 },
  };
  const ready = CATALOGUE.samples.filter((sample) => describeSampleCapability(sample, probe).ready);
  assert.deepEqual(
    ready.map((sample) => sample.id).sort(),
    [
      'a2a-agent-card',
      'a2a-message-send',
      'agent-rate-limit-burst',
      'learn-mcp-discovery',
      'tool-rate-limit-burst',
      'weather-mcp-discovery',
      'weather-tools-call',
    ],
    'exactly the recipes that only need outbound HTTPS are runnable without the CLI or Python',
  );

  const blocked = describeSampleCapability(CATALOGUE.byId.get('weather-api-ensure'), probe);
  assert.equal(blocked.state, 'partial');
  assert.deepEqual(
    blocked.dependencies.filter((dependency) => dependency.available === false).map((dependency) => dependency.id),
    ['azure-cli', 'python'],
    'the recipe names each missing dependency rather than one global reason',
  );
});

test('a present Python with a missing module blocks only the samples that import it', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: true, version: '2.60.0' },
    accelerator: { available: true, files: 22 },
    python: { available: true, version: '3.12.0', modules: { 'agent_framework.a2a': false, 'azure.mgmt.apimanagement': true, 'azure.identity': true, httpx: true, nest_asyncio: true, 'a2a.client': true } },
  };
  const agentFramework = describeSampleCapability(CATALOGUE.byId.get('agent-framework-hr-question'), probe);
  assert.equal(agentFramework.ready, false);
  assert.match(agentFramework.reasons[0], /agent_framework\.a2a/);
  assert.match(agentFramework.reasons[0], /pip install -r runtime\/requirements\.txt/);

  const weather = describeSampleCapability(CATALOGUE.byId.get('weather-api-ensure'), probe);
  assert.equal(weather.ready, true, 'the weather recipe imports different modules and must stay runnable');
});

test('an unavailable optional Python key fallback does not block access-contract deployment', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: true, version: '2.77.0' },
    accelerator: { available: true, files: 22 },
    python: { available: false, reason: 'Python modules are not installed.' },
  };
  const capability = describeSampleCapability(CATALOGUE.byId.get('access-contract-deploy'), probe);
  assert.equal(capability.ready, true);
  assert.equal(capability.dependencies.find((dependency) => dependency.id === 'python').optional, true);
  assert.match(capability.advisories[0], /fallback/i);
});

test('the browser probe preserves missing modules from later Python-backed samples', () => {
  const probe = {
    mode: 'execute',
    azureCli: { available: true, version: '2.77.0' },
    accelerator: { available: true, files: 22 },
    python: {
      available: true,
      version: '3.11.9',
      modules: {
        'azure.mgmt.apimanagement': true,
        'azure.identity': true,
        httpx: false,
        nest_asyncio: false,
        'a2a.client': false,
        'agent_framework.a2a': false,
      },
    },
  };
  const payload = {
    mode: 'execute',
    capability: summariseCapability(CATALOGUE.samples, probe),
  };
  const reconstructed = probeFromCapabilityPayload(payload, CATALOGUE.byId);
  assert.equal(reconstructed.python.available, true);
  assert.equal(reconstructed.python.modules['azure.mgmt.apimanagement'], true);
  assert.equal(reconstructed.python.modules['agent_framework.a2a'], false);
  assert.equal(
    describeSampleCapability(CATALOGUE.byId.get('agent-framework-hr-question'), {
      ...reconstructed,
      mode: 'execute',
    }).ready,
    false,
  );
});

test('the runtime probe is skipped entirely in preview mode', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: '{}' } }]);
  const probe = await probeRuntimes({ mode: 'preview', spawn });
  assert.deepEqual(probe, { mode: 'preview' });
  assert.equal(spawn.calls.length, 0, 'preview mode must not spawn anything at all');
});

test('the runtime probe reads the CLI and the interpreter, and nothing on the network', async () => {
  const spawn = fakeSpawn([
    { match: (options) => options.executable === 'az', result: { code: 0, stdout: '{"azure-cli":"2.61.0"}' } },
    {
      match: (options) => options.args[0] === '-c',
      result: { code: 0, stdout: '{"version":"3.12.1","modules":{"httpx":true}}' },
    },
  ]);
  const probe = await probeRuntimes({ mode: 'execute', python: 'python', spawn, root: PLAYGROUND_ROOT });
  assert.equal(probe.azureCli.available, true);
  assert.equal(probe.azureCli.version, '2.61.0');
  assert.equal(probe.python.available, true);
  assert.equal(probe.accelerator.available, true);
  assert.ok(probe.accelerator.files >= 20);
  const pythonProbe = spawn.calls.find((call) => call.executable === 'python');
  assert.match(pythonProbe.args[1], /except \(ImportError, ModuleNotFoundError\)/);
  for (const call of spawn.calls) {
    assert.ok(['az', 'python'].includes(call.executable), `the probe spawned ${call.executable}`);
    assert.equal(call.cwd, PLAYGROUND_ROOT);
  }
});

test('the runtime probe satisfies the production transport workspace guard', async () => {
  const calls = [];
  const spawn = (options) => {
    calls.push(options);
    const stdout =
      options.executable === 'az'
        ? JSON.stringify({ 'azure-cli': '2.61.0' })
        : JSON.stringify({ version: '3.12.1', modules: { httpx: true } });
    return spawnProcess({
      ...options,
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
      allowedExecutables: [process.execPath],
    });
  };

  const probe = await probeRuntimes({ mode: 'execute', python: 'python', spawn, root: PLAYGROUND_ROOT });

  assert.equal(probe.azureCli.available, true, probe.azureCli.reason);
  assert.equal(probe.python.available, true, probe.python.reason);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.cwd, PLAYGROUND_ROOT);
    assert.equal(isAbsolute(call.cwd), true);
  }
});

/* -------------------------------------------------- the vendored bundle */

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, found);
    else found.push(full);
  }
  return found;
}

test('every vendored file matches its recorded SHA-256', async () => {
  const provenance = JSON.parse(await readFile(join(BUNDLE_ROOT, 'provenance.json'), 'utf-8'));
  assert.ok(provenance.files.length >= 20, 'the bundle should record every file it vendored');
  for (const record of provenance.files) {
    const bytes = await readFile(join(BUNDLE_ROOT, record.path.replace(/\//g, '/')));
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, record.sha256, `${record.path} has drifted from its recorded hash`);
    assert.equal(bytes.length, record.bytes, `${record.path} has drifted in size`);
  }
  const onDisk = (await walk(BUNDLE_ROOT))
    .map((file) => file.slice(BUNDLE_ROOT.length + 1).replace(/\\/g, '/'))
    .filter((file) => file !== 'provenance.json');
  assert.deepEqual(onDisk.sort(), provenance.files.map((file) => file.path).sort(), 'the bundle and its record disagree');
});

test('the vendored bundle is closed: every relative reference resolves inside it', async () => {
  const files = (await walk(BUNDLE_ROOT)).filter((file) => file.endsWith('.bicep'));
  assert.ok(files.length >= 12);
  const missing = [];
  for (const file of files) {
    const text = await readFile(file, 'utf-8');
    const references = [
      ...text.matchAll(/module\s+\w+\s+'([^']+\.bicep)'/g),
      ...text.matchAll(/loadTextContent\('([^']+)'\)/g),
      ...text.matchAll(/loadJsonContent\('([^']+)'\)/g),
    ].map((match) => match[1]);
    for (const reference of references) {
      const target = resolve(file, '..', reference);
      if (!target.startsWith(BUNDLE_ROOT)) {
        missing.push(`${file} references ${reference}, which resolves outside the bundle`);
        continue;
      }
      try {
        await readFile(target);
      } catch {
        missing.push(`${file} references ${reference}, which is not vendored`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('the catalogue defaults point inside the vendored bundle, never at the wider repository', () => {
  // Only defaults that name a file or directory on disk. An agent-card route is
  // a URL path, not a filesystem path, and is excluded by construction.
  const pathDefaults = Object.entries(CATALOGUE.defaultValues).filter(
    ([, value]) => typeof value === 'string' && /\.(bicep|bicepparam|json|xml)$|contracts$/.test(value) && !value.startsWith('/'),
  );
  assert.ok(pathDefaults.length >= 4, 'the catalogue should carry template path defaults');
  for (const [path, value] of pathDefaults) {
    assert.ok(value.startsWith(`${ACCELERATOR_ROOT}/`), `${path} points at "${value}", outside the vendored bundle`);
    assert.ok(!value.includes('..'), `${path} escapes with a relative segment`);
  }
  // Nothing anywhere in the catalogue still points at the sibling repository.
  const everything = JSON.stringify(CATALOGUE.defaultValues);
  assert.ok(!everything.includes('../bicep/'), 'a default still reaches outside CitadelSamples');
});

test('the shipped Python programs exist and never build a command from a parameter', async () => {
  const scripts = (await readdir(join(PLAYGROUND_ROOT, 'runtime', 'python'))).filter((name) => name.endsWith('.py'));
  assert.deepEqual(scripts.sort(), [
    'agent_framework_ask.py',
    'apim_subscription_key.py',
    'apim_weather_api.py',
    'validate_notebook_source.py',
  ]);
  for (const script of scripts) {
    const text = await readFile(join(PLAYGROUND_ROOT, 'runtime', 'python', script), 'utf-8');
    for (const forbidden of ['os.system', 'subprocess', 'shell=True', 'eval(', 'exec(']) {
      assert.ok(!text.includes(forbidden), `${script} uses ${forbidden}`);
    }
    if (script !== 'validate_notebook_source.py') {
      assert.ok(text.includes('json.load(sys.stdin)'), `${script} must read its parameters from stdin`);
    }
  }
});

test('a run workspace is git-ignored so nothing a run generates becomes a repository change', async () => {
  const ignore = await readFile(join(PLAYGROUND_ROOT, '.gitignore'), 'utf-8');
  assert.match(ignore, /^\.runs\/$/m);
});

test('the requirements file exists and installs nothing by itself', async () => {
  const requirements = await readFile(join(PLAYGROUND_ROOT, 'runtime', 'requirements.txt'), 'utf-8');
  assert.match(requirements, /NOTHING INSTALLS THESE FOR YOU/);
  for (const module of ['azure-mgmt-apimanagement', 'azure-identity', 'agent-framework', 'httpx', 'nest_asyncio']) {
    assert.match(requirements, new RegExp(`^${module}$`, 'm'), `${module} should be listed`);
  }
});

test('the real spawn transport refuses anything outside the executable allow-list', async () => {
  await assert.rejects(() => spawnProcess({ executable: 'bash', args: ['-c', 'echo hi'] }), /not on the executable allow-list/);
  await assert.rejects(() => spawnProcess({ executable: 'cmd', args: ['/c', 'dir'] }), /not on the executable allow-list/);
  await assert.rejects(() => spawnProcess({ executable: 'az', args: 'not-an-array' }), /array of strings/);
});

test('the Windows Azure CLI shim resolves to its bundled Python without a shell', () => {
  const existing = new Set([
    'c:\\azure\\cli2\\wbin\\az.cmd',
    'c:\\azure\\cli2\\python.exe',
  ]);
  const invocation = resolveSpawnInvocation('az', ['version', '-o', 'json'], {
    platform: 'win32',
    pathValue: 'C:\\Azure\\CLI2\\wbin',
    pathExt: '.EXE;.CMD',
    exists: (path) => existing.has(path.toLowerCase()),
  });
  assert.equal(invocation.executable.toLowerCase(), 'c:\\azure\\cli2\\python.exe');
  assert.deepEqual(invocation.args, ['-IBm', 'azure.cli', 'version', '-o', 'json']);
});

test('a Windows command shim other than the registered Azure CLI launcher is refused', () => {
  assert.throws(
    () =>
      resolveSpawnInvocation('python', ['--version'], {
        platform: 'win32',
        pathValue: 'C:\\Shims',
        pathExt: '.CMD',
        exists: (path) => path.toLowerCase() === 'c:\\shims\\python.cmd',
      }),
    /command shims require a shell/,
  );
});
