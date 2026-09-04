/**
 * The run manager: wire request in, result out.
 *
 * This is the only test that exercises the whole path — validation, plan
 * reconstruction, workspace, executor, redaction and summary — and it does so
 * entirely through fake transports. No Azure resource, gateway, vault, burst or
 * deletion is reachable from here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRunManager } from '../src/server/runManager.mjs';
import { RequestRefused } from '../src/server/runRequest.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import { FIXTURE_VALUES } from './helpers/fixtures.mjs';
import { fakeFetch, fakeFileSystem, fakeSpawn } from './helpers/transports.mjs';

const PLAYGROUND_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ACCELERATOR_ROOT = resolve(PLAYGROUND_ROOT, 'runtime', 'accelerator');

function manager({ spawn, fetch, maxConcurrentRuns = 2, fs } = {}) {
  const filesystem = fakeFileSystem({ realReadRoots: [ACCELERATOR_ROOT] });
  const executionContextManager = {
    forRun: async ({ sampleId }) => ({
      kind: 'test-context',
      label: 'Fake execution context',
      summary: 'Approved by the fake execution-context manager.',
      state: 'ready',
      code: null,
      canExecute: true,
      sampleId,
    }),
  };
  return {
    filesystem,
    instance: createRunManager({
      playgroundRoot: PLAYGROUND_ROOT,
      transports: {
        spawn: spawn ?? fakeSpawn([]),
        fetch: fetch ?? fakeFetch([]),
        writeFile: filesystem.writeFile,
        access: filesystem.access,
      },
      fs: fs ?? filesystem.fs,
      pythonExecutable: 'python',
      maxConcurrentRuns,
      executionContextManager,
    }),
  };
}

const request = (sampleId, inputs = {}, extra = {}) => ({
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  sampleId,
  inputs,
  ...extra,
});

test('a valid request runs and comes back with a run id and per-step results', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 2).join(' ') === 'account show',
      result: {
        code: 0,
        stdout: JSON.stringify({
          id: FIXTURE_VALUES['hub.subscriptionId'],
          name: 'Fake Subscription',
          user: { name: 'operator@example.test' },
          tenantId: 'tenant',
        }),
      },
    },
  ]);
  const { instance } = manager({ spawn });
  const result = await instance.start(
    request('azure-context-check', { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] }),
  );
  assert.match(result.runId, /^azure-context-check-0001$/);
  assert.equal(result.state, 'completed');
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].kind, 'azure-cli');
  assert.equal(result.assertions[0].status, 'passed');
  assert.equal(instance.activeCount, 0, 'the run is removed from the active set when it finishes');
});

test('the manager reports step progress while a run is in flight', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 2).join(' ') === 'account show',
      result: {
        code: 0,
        stdout: JSON.stringify({
          id: FIXTURE_VALUES['hub.subscriptionId'],
          name: 'Fake Subscription',
          user: { name: 'operator@example.test' },
          tenantId: 'tenant',
        }),
      },
    },
  ]);
  const { instance } = manager({ spawn });
  const progress = [];
  const result = await instance.start(
    request('azure-context-check', { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] }),
    { onProgress: (event) => progress.push(event) },
  );

  assert.equal(result.state, 'completed');
  assert.ok(progress.some((event) => event.type === 'step-start' && event.step.id === 'account-show'));
  assert.ok(progress.some((event) => event.type === 'step' && event.step.id === 'account-show'));
  assert.ok(progress.some((event) => event.type === 'step' && event.step.kind === 'assertion'));
});

test('onStart runs before the executor can emit its first progress event', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 2).join(' ') === 'account show',
      result: {
        code: 0,
        stdout: JSON.stringify({
          id: FIXTURE_VALUES['hub.subscriptionId'],
          name: 'Fake Subscription',
          user: { name: 'operator@example.test' },
          tenantId: 'tenant',
        }),
      },
    },
  ]);
  const { instance } = manager({ spawn });
  const events = [];
  await instance.start(
    request('azure-context-check', { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] }),
    {
      onStart: ({ runId }) => events.push(`start:${runId}`),
      onProgress: (event) => events.push(event.type),
    },
  );

  assert.match(events[0], /^start:azure-context-check-0001$/);
  assert.equal(events[1], 'step-start');
});

test('a run id is unique per run and safe as a directory name', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: JSON.stringify({ id: FIXTURE_VALUES['hub.subscriptionId'] }) } }]);
  const { instance } = manager({ spawn });
  const inputs = { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] };
  const first = await instance.start(request('azure-context-check', inputs));
  const second = await instance.start(request('azure-context-check', inputs));
  assert.notEqual(first.runId, second.runId);
  for (const id of [first.runId, second.runId]) {
    assert.match(id, /^[a-z0-9-]+$/, 'a run id must be safe as a path segment');
  }
});

test('the manager refuses an incomplete configuration before anything is spawned', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: '{}' } }]);
  const { instance } = manager({ spawn });
  await assert.rejects(
    () => instance.start(request('apim-discovery', {})),
    (error) => error instanceof RequestRefused && error.code === 'incomplete-configuration',
  );
  assert.equal(spawn.calls.length, 0, 'nothing may be spawned for a configuration that cannot run');
});

test('the manager refuses a risky sample without a fresh acknowledgement, and spawns nothing', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: '{}' } }]);
  const { instance } = manager({ spawn });
  await assert.rejects(
    () =>
      instance.start(
        request('cleanup', {
          'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'],
          'hub.resourceGroupName': 'rg-test',
          'hub.apimName': 'apim-test',
          'samples.cleanup.confirmNonProduction': true,
        }),
      ),
    (error) => error instanceof RequestRefused && error.code === 'acknowledgement-required',
  );
  assert.equal(spawn.calls.length, 0);
});

test('a destructive run with both switches off deletes nothing and still reports the residue', async () => {
  const spawn = fakeSpawn([{ match: () => true, result: { code: 0, stdout: '{}' } }]);
  const { instance } = manager({ spawn });
  const result = await instance.start(
    request(
      'cleanup',
      {
        'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'],
        'hub.resourceGroupName': 'rg-test',
        'hub.apimName': 'apim-test',
        'samples.cleanup.confirmNonProduction': true,
      },
      { acknowledgement: { accepted: true, sampleId: 'cleanup' } },
    ),
  );
  assert.equal(spawn.calls.length, 0, 'no deletion may be attempted with both switches off');
  assert.equal(result.state, 'completed');
  const residue = result.assertions.find((assertion) => assertion.id === 'report-residue');
  assert.equal(residue.status, 'passed');
  assert.match(residue.detail, /residual item/);
});

test('the non-production confirmation is a hard precondition the server re-checks', async () => {
  const { instance } = manager();
  await assert.rejects(
    () =>
      instance.start(
        request(
          'cleanup',
          {
            'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'],
            'hub.resourceGroupName': 'rg-test',
            'hub.apimName': 'apim-test',
            'samples.cleanup.confirmNonProduction': false,
          },
          { acknowledgement: { accepted: true, sampleId: 'cleanup' } },
        ),
      ),
    // The browser's acknowledgement is not enough: the confirmation is a value
    // the server validates in its own right.
    (error) => error instanceof RequestRefused && /Confirm the target/i.test(error.message),
  );
});

test('concurrency is bounded and the limit is reported rather than queued silently', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const spawn = fakeSpawn([
    {
      match: () => true,
      result: async () => {
        await held;
        return { code: 0, stdout: JSON.stringify({ id: FIXTURE_VALUES['hub.subscriptionId'] }) };
      },
    },
  ]);
  const { instance } = manager({ spawn, maxConcurrentRuns: 1 });
  const inputs = { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] };
  const first = instance.start(request('azure-context-check', inputs));
  await new Promise((done) => setTimeout(done, 20));
  await assert.rejects(
    () => instance.start(request('azure-context-check', inputs)),
    (error) => error instanceof RequestRefused && error.status === 429,
  );
  release();
  await first;
});

test('workspace creation reserves concurrency before its first await completes', async () => {
  let workspaceStarted;
  const started = new Promise((resolveStarted) => {
    workspaceStarted = resolveStarted;
  });
  let releaseWorkspace;
  const held = new Promise((resolveHeld) => {
    releaseWorkspace = resolveHeld;
  });
  const fs = {
    async mkdir() {
      workspaceStarted();
      await held;
    },
  };
  const spawn = fakeSpawn([
    {
      match: () => true,
      result: { code: 0, stdout: JSON.stringify({ id: FIXTURE_VALUES['hub.subscriptionId'] }) },
    },
  ]);
  const { instance } = manager({ spawn, maxConcurrentRuns: 1, fs });
  const inputs = { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] };
  const first = instance.start(request('azure-context-check', inputs));
  await started;
  try {
    assert.equal(instance.activeCount, 1);
    await assert.rejects(
      () => instance.start(request('azure-context-check', inputs)),
      (error) => error instanceof RequestRefused && error.code === 'too-many-runs',
    );
  } finally {
    releaseWorkspace();
  }
  await first;
  assert.equal(instance.activeCount, 0);
});

test('validation and workspace setup failures release their concurrency reservation', async () => {
  let failWorkspace = true;
  const fs = {
    async mkdir() {
      if (failWorkspace) {
        failWorkspace = false;
        throw new Error('workspace setup failed');
      }
    },
  };
  const spawn = fakeSpawn([
    {
      match: () => true,
      result: { code: 0, stdout: JSON.stringify({ id: FIXTURE_VALUES['hub.subscriptionId'] }) },
    },
  ]);
  const { instance } = manager({ spawn, maxConcurrentRuns: 1, fs });
  await assert.rejects(
    () => instance.start(request('apim-discovery', {})),
    (error) => error instanceof RequestRefused && error.code === 'incomplete-configuration',
  );
  assert.equal(instance.activeCount, 0);

  const inputs = { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] };
  await assert.rejects(() => instance.start(request('azure-context-check', inputs)), /workspace setup failed/);
  assert.equal(instance.activeCount, 0);

  const result = await instance.start(request('azure-context-check', inputs));
  assert.equal(result.state, 'completed');
  assert.equal(instance.activeCount, 0);
});

test('cancelling names the run it stopped, and an unknown run id is reported honestly', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const spawn = fakeSpawn([
    {
      match: () => true,
      result: async (options) => {
        await Promise.race([held, new Promise((done) => options.signal?.addEventListener('abort', done, { once: true }))]);
        return { code: -1, stdout: '', stderr: 'aborted', timedOut: false };
      },
    },
  ]);
  const { instance } = manager({ spawn });
  const inputs = { 'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'] };
  let announcedRunId = null;
  const running = instance.start(request('azure-context-check', inputs), {
    onStart: ({ runId }) => {
      announcedRunId = runId;
    },
  });
  await new Promise((done) => setTimeout(done, 20));
  const active = instance.listActive();
  assert.equal(active.length, 1);
  assert.equal(announcedRunId, active[0].runId, 'the caller must learn the run id while the run is still active');
  assert.deepEqual(instance.cancel('not-a-run'), { cancelled: false, reason: 'That run is not in flight.' });
  const cancelled = instance.cancel(active[0].runId);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.sampleId, 'azure-context-check');
  release();
  const result = await running;
  assert.ok(['cancelled', 'failed'].includes(result.state), `a cancelled run must never report completed, got ${result.state}`);
});

test('the documented key fallback runs only when the deployment returned no key', async () => {
  const minted = 'FALLBACK-KEY-0002';
  const spawn = fakeSpawn([
    { match: (options) => options.args.slice(0, 3).join(' ') === 'apim api list', result: { code: 0, stdout: '["universal-llm-api"]' } },
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'deployment sub create',
      // No `apiKey` in the outputs: exactly the case the fallback exists for.
      result: {
        code: 0,
        stdout: JSON.stringify({
          properties: {
            provisioningState: 'Succeeded',
            outputs: { endpoints: { value: [{ apiName: 'weather-tool' }] }, subscriptions: { value: [{ keyVaultApiKeySecretName: 'KEY' }] } },
          },
        }),
      },
    },
    { match: (options) => options.args[0] === '-c', result: { code: 0, stdout: '' } },
    {
      match: (options) => String(options.args[0]).endsWith('apim_subscription_key.py'),
      result: { code: 0, stdout: JSON.stringify({ apiKey: minted }) },
    },
  ]);
  const { instance } = manager({ spawn });
  const result = await instance.start(
    request(
      'access-contract-deploy',
      {
        'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'],
        'hub.resourceGroupName': 'rg-test',
        'hub.apimName': 'apim-test',
        'hub.location': 'swedencentral',
        'keyVault.name': 'kv-test',
        'samples.access-contract-deploy.existingLlmApis': ['universal-llm-api'],
      },
      { acknowledgement: { accepted: true, sampleId: 'access-contract-deploy' } },
    ),
  );
  const fallback = result.steps.find((step) => step.id === 'key-fallback');
  assert.equal(fallback.state, 'completed', 'the fallback must run when the outputs carried no key');
  assert.equal(result.secretUpdates['gatewayAccess.apiKey'], minted);

  const withoutSecrets = JSON.stringify({ ...result, secretUpdates: undefined });
  assert.ok(!withoutSecrets.includes(minted), 'the fallback key must not appear in any step, evidence or summary');

  // The wrapper was told which subscription to read, derived server-side.
  const wrapperCall = spawn.calls.find((call) => String(call.args[0]).endsWith('apim_subscription_key.py'));
  const params = JSON.parse(wrapperCall.stdin);
  assert.equal(params.subscriptionName, 'MULTI-Governance-PublishedAssets-DEV-SUB-01');
});

test('generated artifacts land in the run workspace and are named in the result', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'deployment sub create',
      result: {
        code: 0,
        stdout: JSON.stringify({
          properties: {
            provisioningState: 'Succeeded',
            outputs: {
              publishedAssets: {
                value: [
                  { assetType: 'mcp-from-api', name: 'weather-tool', path: 'mcp/weather-tool-mcp', endpoint: 'https://gw.test/mcp/weather-tool-mcp/mcp' },
                  { assetType: 'a2a', name: 'hr-chat-agent', path: 'agent/hr-chat-agent', endpoint: 'https://gw.test/agent/hr-chat-agent' },
                ],
              },
            },
          },
        }),
      },
    },
  ]);
  const { instance, filesystem } = manager({ spawn });
  const result = await instance.start(
    request(
      'publish-assets',
      {
        'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'],
        'hub.resourceGroupName': 'rg-test',
        'hub.apimName': 'apim-test',
        'hub.location': 'swedencentral',
        'foundry.accountName': 'aif-test',
        'foundry.projectName': 'proj-test',
        'foundry.agentName': 'HR-ChatAgent',
      },
      { acknowledgement: { accepted: true, sampleId: 'publish-assets' } },
    ),
  );
  assert.equal(result.state, 'completed');
  assert.deepEqual(result.meta.artifacts, ['citadel-publish-contracts/contracts/sample-assets/dev/main.bicepparam']);

  // Written inside the run workspace, alongside a staged copy of the template
  // it declares with `using '../../../main.bicep'`.
  const written = [...filesystem.files.keys()].map((path) => path.replace(/\\/g, '/'));
  assert.ok(written.some((path) => path.includes(`/.runs/${result.runId}/citadel-publish-contracts/contracts/sample-assets/dev/main.bicepparam`)));
  assert.ok(
    written.some((path) => path.endsWith(`/.runs/${result.runId}/citadel-publish-contracts/main.bicep`)),
    'the template the parameter file points at is staged beside it',
  );
  assert.ok(
    written.some((path) => path.endsWith(`/.runs/${result.runId}/modules/apim/policies/frag-mcp-usage.xml`)),
    'a transitively referenced policy fragment is staged too',
  );

  // Discovery feeds the Exercise recipes without the user retyping anything.
  assert.equal(
    result.configurationUpdates['samples.weather-mcp-discovery.deployedEndpoint'],
    'https://gw.test/mcp/weather-tool-mcp/mcp',
  );
  assert.equal(result.configurationUpdates['samples.a2a-message-send.deployedPath'], 'agent/hr-chat-agent');
});

test('the executed command names the staged template, never a path outside the workspace', async () => {
  const spawn = fakeSpawn([
    {
      match: (options) => options.args.slice(0, 3).join(' ') === 'deployment sub create',
      result: { code: 0, stdout: JSON.stringify({ properties: { provisioningState: 'Succeeded', outputs: {} } }) },
    },
  ]);
  const { instance } = manager({ spawn });
  const result = await instance.start(
    request(
      'publish-assets',
      {
        'hub.subscriptionId': FIXTURE_VALUES['hub.subscriptionId'],
        'hub.resourceGroupName': 'rg-test',
        'hub.apimName': 'apim-test',
        'hub.location': 'swedencentral',
        'foundry.enableA2aAsset': false,
      },
      { acknowledgement: { accepted: true, sampleId: 'publish-assets' } },
    ),
  );
  const deploy = spawn.calls.find((call) => call.args.slice(0, 3).join(' ') === 'deployment sub create');
  const templateIndex = deploy.args.indexOf('--template-file');
  const parametersIndex = deploy.args.indexOf('--parameters');
  for (const index of [templateIndex + 1, parametersIndex + 1]) {
    const path = deploy.args[index].replace(/\\/g, '/');
    assert.ok(path.includes(`/.runs/${result.runId}/`), `${path} is not inside the run workspace`);
    assert.ok(!path.includes('..'), `${path} carries a relative escape`);
  }
});
