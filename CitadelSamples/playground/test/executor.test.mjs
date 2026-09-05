/**
 * The executor boundary: the honest default, the narrow relay seam, and the
 * server that reports capability without disclosing its relay configuration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { CATALOGUE, buildSamplePlan, getSample } from '../src/catalogue/index.mjs';
import {
  RELAY_PROTOCOL_VERSION,
  createRelayExecutor,
  createUnavailableExecutor,
  executionResult,
  runPlan,
  unsupportedStepTypes,
} from '../src/core/executor.mjs';
import { EXECUTION_STATES } from '../src/core/types.mjs';
import { createLocalExecutorClient } from '../web/js/localClient.mjs';
import { FAKE_API_KEY, makeFixtureReader } from './helpers/fixtures.mjs';

const ALL_IDS = CATALOGUE.samples.map((sample) => sample.id);

function planFor(id) {
  const { plan } = buildSamplePlan(getSample(id), makeFixtureReader());
  return plan;
}

/* ------------------------------------------------- the unavailable default */

test('the default executor reports honestly that it cannot execute', () => {
  const capability = createUnavailableExecutor().describeCapability();
  assert.equal(capability.kind, 'unavailable');
  assert.equal(capability.canExecute, false);
  assert.deepEqual([...capability.supportedStepTypes], []);
  assert.ok(capability.reason.length > 30);
});

test('the default executor returns blocked for every recipe, never a success shape', async () => {
  const executor = createUnavailableExecutor();
  for (const id of ALL_IDS) {
    const plan = planFor(id);
    const result = await executor.execute(plan);
    assert.equal(result.state, 'blocked', `${id} should be blocked`);
    assert.notEqual(result.state, 'completed');
    assert.equal(result.sampleId, id);
    assert.match(result.summary, /Not run/);
    assert.deepEqual(result.assertions, []);
    assert.deepEqual(result.meta.requiredStepTypes, [...plan.requiredStepTypes]);
  }
});

test('the default executor supports nothing, and says which step types it lacks', () => {
  const executor = createUnavailableExecutor();
  const plan = planFor('publish-assets');
  const support = executor.supports(plan);
  assert.equal(support.supported, false);
  assert.deepEqual(support.unsupportedStepTypes, [...plan.requiredStepTypes]);
});

test('an unknown execution state cannot be constructed', () => {
  assert.throws(() => executionResult({ state: 'passed', sampleId: 'x', summary: 'y' }), /Unknown execution state/);
  for (const state of EXECUTION_STATES) {
    assert.equal(executionResult({ state, sampleId: 'x', summary: 'y' }).state, state);
  }
  assert.ok(!EXECUTION_STATES.includes('passed'), '"passed" must not be a state an executor can claim');
});

/* --------------------------------------------------------- the relay seam */

test('the relay refuses to be constructed without an allow-list, or with an arbitrary URL', () => {
  assert.throws(() => createRelayExecutor({ allowedSampleIds: [] }), /allowedSampleIds/);
  assert.throws(
    () => createRelayExecutor({ allowedSampleIds: ALL_IDS, endpoint: 'https://evil.test/proxy' }),
    /same-origin path/,
  );
  assert.throws(
    () => createRelayExecutor({ allowedSampleIds: ALL_IDS, endpoint: '//evil.test/proxy' }),
    /same-origin path/,
  );
  const relay = createRelayExecutor({ allowedSampleIds: ['weather-mcp-discovery'] });
  assert.deepEqual(relay.describeCapability().allowedSampleIds, ['weather-mcp-discovery']);
  assert.throws(() => relay.describeCapability().allowedSampleIds.push('publish-assets'), TypeError);
});

test('the relay body carries only sampleId, inputs and secret ref NAMES', () => {
  const relay = createRelayExecutor({ allowedSampleIds: ALL_IDS });
  const plan = planFor('weather-mcp-discovery');
  const body = relay.buildRequestBody(plan, { inputs: { hub: { gatewayUrl: 'https://gw.test' } } });
  assert.deepEqual(Object.keys(body).sort(), ['inputs', 'protocolVersion', 'sampleId', 'secretRefs']);
  assert.equal(body.protocolVersion, RELAY_PROTOCOL_VERSION);
  assert.equal(body.sampleId, 'weather-mcp-discovery');
  assert.deepEqual(body.secretRefs, ['gatewayAccess.apiKey']);
  assert.equal(JSON.stringify(body).includes(FAKE_API_KEY), false, 'the relay must not carry secret values');
  assert.equal(body.url, undefined, 'the relay must not accept a URL');
  assert.equal(body.steps, undefined, 'the relay must not accept a raw request');
});

test('the relay refuses a sample id that is not in the catalogue', () => {
  const relay = createRelayExecutor({ allowedSampleIds: ['weather-mcp-discovery'] });
  assert.throws(() => relay.buildRequestBody({ sampleId: 'anything-else' }, {}), /refused unknown sample/);
});

test('the relay body carries an acknowledgement only when one is actually supplied', () => {
  const relay = createRelayExecutor({ allowedSampleIds: ALL_IDS });
  const plan = planFor('weather-mcp-discovery');
  const withoutAck = relay.buildRequestBody(plan, { inputs: {} });
  assert.deepEqual(Object.keys(withoutAck).sort(), ['inputs', 'protocolVersion', 'sampleId', 'secretRefs']);
  const withAck = relay.buildRequestBody(plan, {
    inputs: {},
    acknowledgement: { accepted: true, sampleId: plan.sampleId },
  });
  assert.deepEqual(Object.keys(withAck).sort(), ['acknowledgement', 'inputs', 'protocolVersion', 'sampleId', 'secretRefs']);
  assert.deepEqual(withAck.acknowledgement, { accepted: true, sampleId: plan.sampleId });
});

test('the relay forwards the acknowledgement supplied to execute()', async () => {
  const calls = [];
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ state: 'completed', summary: 'ran' }) };
    },
  });
  await relay.execute(planFor('a2a-agent-card'), {
    inputs: {},
    acknowledgement: { accepted: true, sampleId: 'a2a-agent-card' },
  });
  assert.deepEqual(calls[0].acknowledgement, { accepted: true, sampleId: 'a2a-agent-card' });
});

test('a relay result propagates configurationUpdates and secretUpdates, same as the local client', async () => {
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        state: 'completed',
        summary: 'ran',
        configurationUpdates: { 'hub.gatewayUrl': 'https://gw.example.net' },
        secretUpdates: { 'gatewayAccess.apiKey': 'rotated-value' },
      }),
    }),
  });
  const result = await relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  assert.deepEqual(result.configurationUpdates, { 'hub.gatewayUrl': 'https://gw.example.net' });
  assert.deepEqual(result.secretUpdates, { 'gatewayAccess.apiKey': 'rotated-value' });
});

test('a relay result with no updates reports empty objects, never undefined', async () => {
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ state: 'completed', summary: 'ran' }) }),
  });
  const result = await relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  assert.deepEqual(result.configurationUpdates, {});
  assert.deepEqual(result.secretUpdates, {});
});

test('the relay posts to its fixed same-origin endpoint and nowhere else', async () => {
  const calls = [];
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ state: 'completed', summary: 'Ran on the relay.' }),
      };
    },
  });
  const result = await relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/execute');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(result.state, 'completed');
  assert.equal(result.meta.executor, 'relay');
});

test('relay cancellation aborts the exact pre-response request and returns a cancelled result without leaking its error', async () => {
  let requestSignal;
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error(`Abort exposed ${FAKE_API_KEY}`);
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  const running = relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await relay.cancel(), { cancelled: true, sampleId: 'a2a-agent-card' });
  const result = await running;
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.state, 'cancelled');
  assert.equal(result.sampleId, 'a2a-agent-card');
  assert.deepEqual(result.configurationUpdates, {});
  assert.deepEqual(result.secretUpdates, {});
  assert.doesNotMatch(JSON.stringify(result), new RegExp(FAKE_API_KEY));
});

test('relay cancellation remains available while a received response body is still pending', async () => {
  let responseSignal;
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async (_url, init) => {
      responseSignal = init.signal;
      return {
        ok: true,
        status: 200,
        json: async () => new Promise(() => {}),
      };
    },
  });
  const running = relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await relay.cancel(), { cancelled: true, sampleId: 'a2a-agent-card' });
  const result = await running;
  assert.equal(responseSignal.aborted, true);
  assert.equal(result.state, 'cancelled');
});

test('a cancelled relay request cannot cancel the next run, and a completed run is no longer cancellable', async () => {
  const signals = [];
  let calls = 0;
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async (_url, init) => {
      signals.push(init.signal);
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return { ok: true, status: 200, json: async () => ({ state: 'completed', summary: 'next run' }) };
    },
  });

  const first = relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await relay.cancel()).cancelled, true);
  assert.equal((await first).state, 'cancelled');

  const second = await relay.execute(planFor('weather-mcp-discovery'), { inputs: {} });
  assert.equal(second.state, 'completed');
  assert.equal(second.sampleId, 'weather-mcp-discovery');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.deepEqual(await relay.cancel(), { cancelled: false, reason: 'No relay run is in flight.' });
});

test('the relay client is single-flight and refuses a concurrent run without starting another request', async () => {
  let calls = 0;
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async () => {
      calls += 1;
      return new Promise(() => {});
    },
  });
  const first = relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  await new Promise((resolve) => setImmediate(resolve));

  const concurrent = await relay.execute(planFor('weather-mcp-discovery'), { inputs: {} });
  assert.equal(concurrent.state, 'blocked');
  assert.equal(concurrent.sampleId, 'weather-mcp-discovery');
  assert.equal(concurrent.meta.reason, 'relay-single-flight');
  assert.equal(concurrent.meta.activeSampleId, 'a2a-agent-card');
  assert.equal(calls, 1);

  await relay.cancel();
  assert.equal((await first).state, 'cancelled');
});

test('the relay blocks a plan whose step types it does not support', async () => {
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    supportedStepTypes: ['http', 'assertion'],
    fetchImpl: async () => {
      throw new Error('must not be called for an unsupported plan');
    },
  });
  const plan = planFor('publish-assets'); // artifact + azure-cli + assertion
  const support = relay.supports(plan);
  assert.equal(support.supported, false);
  assert.deepEqual(support.unsupportedStepTypes.sort(), ['artifact', 'azure-cli']);
  const result = await relay.execute(plan, { inputs: {} });
  assert.equal(result.state, 'blocked');
});

test('an unrecognised relay answer is inconclusive, never a pass', async () => {
  const relay = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ verdict: 'looks fine' }) }),
  });
  const result = await relay.execute(planFor('a2a-agent-card'), { inputs: {} });
  assert.equal(result.state, 'inconclusive');
});

test('a relay HTTP 501 becomes blocked and any other error becomes failed', async () => {
  const notImplemented = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async () => ({ ok: false, status: 501, json: async () => ({ detail: 'no relay configured' }) }),
  });
  assert.equal((await notImplemented.execute(planFor('a2a-agent-card'), {})).state, 'blocked');

  const broken = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ detail: 'upstream' }) }),
  });
  assert.equal((await broken.execute(planFor('a2a-agent-card'), {})).state, 'failed');

  const offline = createRelayExecutor({
    allowedSampleIds: ALL_IDS,
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  const result = await offline.execute(planFor('a2a-agent-card'), {});
  assert.equal(result.state, 'failed');
  assert.equal(result.detail, '');
  assert.doesNotMatch(JSON.stringify(result), /ECONNREFUSED/);
});

test('unsupportedStepTypes reports exactly the gap', () => {
  const plan = planFor('weather-api-ensure'); // library + assertion
  assert.deepEqual(unsupportedStepTypes(plan, ['assertion']).sort(), ['library']);
  assert.deepEqual(unsupportedStepTypes(plan, ['library', 'assertion']), []);
});

test('runPlan never reaches an executor for an unacknowledged risky plan', async () => {
  let reached = false;
  const executor = {
    describeCapability: () => ({ canExecute: true, supportedStepTypes: ['http'] }),
    supports: () => ({ supported: true, unsupportedStepTypes: [] }),
    execute: async () => {
      reached = true;
      return executionResult({ state: 'completed', sampleId: 'x', summary: 'ran' });
    },
  };
  const sample = getSample('tool-rate-limit-burst');
  const { plan, validation } = buildSamplePlan(sample, makeFixtureReader());
  const blocked = await runPlan(executor, plan, {
    validation,
    acknowledgement: { required: true, satisfied: false, issues: [{ message: 'Acknowledge first.' }] },
  });
  assert.equal(reached, false);
  assert.equal(blocked.state, 'blocked');

  const allowed = await runPlan(executor, plan, {
    validation,
    acknowledgement: { required: true, satisfied: true, issues: [] },
  });
  assert.equal(reached, true);
  assert.equal(allowed.state, 'completed');
});

test('runPlan forwards progress only after validation and acknowledgement pass', async () => {
  const reported = [];
  const onProgress = (event) => reported.push(event);
  const reviewedIdentity = {
    principalName: 'operator@example.test',
    principalType: 'user',
    tenantId: 'tenant-1',
    subscriptionId: '00000000-1111-2222-3333-444444444444',
  };
  const executor = {
    describeCapability: () => ({ canExecute: true, supportedStepTypes: ['azure-cli', 'assertion'] }),
    supports: () => ({ supported: true, unsupportedStepTypes: [] }),
    execute: async (_plan, context) => {
      assert.equal(context.onProgress, onProgress);
      assert.equal(context.reviewedIdentity, reviewedIdentity);
      context.onProgress({ type: 'step-start', step: { id: 'account-show' } });
      return executionResult({ state: 'completed', sampleId: 'azure-context-check', summary: 'ran' });
    },
  };
  const sample = getSample('azure-context-check');
  const { plan, validation } = buildSamplePlan(sample, makeFixtureReader());
  const result = await runPlan(executor, plan, {
    validation,
    acknowledgement: { required: false, satisfied: true, issues: [] },
    reviewedIdentity,
    onProgress,
  });

  assert.equal(result.state, 'completed');
  assert.deepEqual(reported, [{ type: 'step-start', step: { id: 'account-show' } }]);
});

test('the local client learns the run id before completion so it can cancel the active run', async () => {
  let finishRun;
  const runBody = new Promise((resolve) => {
    finishRun = resolve;
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/run/cancel') {
      return {
        ok: true,
        status: 200,
        headers: {},
        json: async () => ({ cancelled: true, runId: 'weather-run-1' }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'x-citadel-run-id' ? 'weather-run-1' : null) },
      json: async () => runBody,
    };
  };
  const client = createLocalExecutorClient({
    allowedSampleIds: ALL_IDS,
    supportedStepTypes: ['http', 'assertion'],
    fetchImpl,
  });
  const plan = planFor('weather-mcp-discovery');
  const running = client.execute(plan, {
    sampleId: plan.sampleId,
    inputs: {},
    secrets: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.activeRunId, 'weather-run-1');
  assert.deepEqual(await client.cancel(), { cancelled: true, runId: 'weather-run-1' });
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[1].init.credentials, 'same-origin');
  assert.equal(JSON.parse(calls[1].init.body).runId, 'weather-run-1');

  finishRun({
    runId: 'weather-run-1',
    state: 'cancelled',
    summary: 'Cancelled.',
    steps: [],
    assertions: [],
  });
  const result = await running;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.meta.runId, 'weather-run-1');
  assert.equal(client.activeRunId, null);
});

test('the local client sends the reviewed Azure identity without command material', () => {
  const client = createLocalExecutorClient({ allowedSampleIds: ALL_IDS });
  const reviewedIdentity = {
    principalName: 'operator@example.test',
    principalType: 'user',
    tenantId: 'tenant-1',
    subscriptionId: '00000000-1111-2222-3333-444444444444',
  };
  const body = client.buildRequestBody({
    sampleId: 'azure-context-check',
    inputs: {},
    secrets: {},
    reviewedIdentity,
  });
  assert.deepEqual(body.reviewedIdentity, reviewedIdentity);
  assert.equal(body.command, undefined);
  assert.equal(body.args, undefined);
});

test('the local client aborts a pending run request before response headers expose a run id', async () => {
  let requestSignal;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  const fetchImpl = async (_url, init) => {
    requestSignal = init.signal;
    markFetchStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  };
  const client = createLocalExecutorClient({
    allowedSampleIds: ALL_IDS,
    supportedStepTypes: ['azure-cli', 'assertion'],
    fetchImpl,
  });
  const plan = planFor('azure-context-check');
  const running = client.execute(plan, { sampleId: plan.sampleId, inputs: {}, secrets: {} });

  await fetchStarted;
  assert.equal(client.activeRunId, null);
  assert.deepEqual(await client.cancel(), { cancelled: true, pending: true });
  assert.equal(requestSignal.aborted, true);

  const result = await running;
  assert.equal(result.state, 'cancelled');
  assert.equal(client.activeRunId, null);
});

test('the local client consumes streamed progress before returning the final result', async () => {
  const encoder = new TextEncoder();
  const events = [
    { type: 'run-start', runId: 'stream-0001', sampleId: 'azure-context-check', workspace: '.' },
    { type: 'step-start', step: { id: 'account-show', title: 'Read account', kind: 'azure-cli' } },
    {
      type: 'result',
      result: {
        runId: 'stream-0001',
        state: 'completed',
        summary: 'Completed.',
        steps: [],
        assertions: [],
      },
    },
  ];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(events[0])}\n${JSON.stringify(events[1]).slice(0, 20)}`));
      controller.enqueue(encoder.encode(`${JSON.stringify(events[1]).slice(20)}\n${JSON.stringify(events[2])}\n`));
      controller.close();
    },
  });
  const client = createLocalExecutorClient({
    allowedSampleIds: ALL_IDS,
    supportedStepTypes: ['azure-cli', 'assertion'],
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name) => {
          if (name.toLowerCase() === 'x-citadel-run-id') return 'stream-0001';
          if (name.toLowerCase() === 'content-type') return 'application/x-ndjson; charset=utf-8';
          return null;
        },
      },
      body,
    }),
  });
  const progress = [];
  const plan = planFor('azure-context-check');
  const result = await client.execute(plan, {
    sampleId: plan.sampleId,
    inputs: {},
    secrets: {},
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.state, 'completed');
  assert.equal(result.meta.runId, 'stream-0001');
  assert.deepEqual(progress.map((event) => event.type), ['run-start', 'step-start']);
});

/* ------------------------------------------------------------ the server */

test('the server reports capability without disclosing its relay configuration', async () => {
  const { capabilitiesPayload } = await import('../server.mjs');
  const payload = capabilitiesPayload();
  assert.equal(payload.status, 'ok');
  assert.equal(payload.executor.kind, 'unavailable');
  assert.equal(payload.executor.canExecute, false);
  assert.equal(payload.relayConfigured, false);
  const serialized = JSON.stringify(payload);
  assert.ok(!/token/i.test(serialized), 'the capability payload must not mention a token');
  assert.ok(!/https?:\/\/(?!$)/.test(serialized), 'the capability payload must not disclose a relay URL');
});

test('the server refuses to serve anything outside web/ and src/', async () => {
  const { resolveServedPath } = await import('../server.mjs');
  assert.ok(resolveServedPath('/web/index.html'));
  assert.ok(resolveServedPath('/src/catalogue/index.mjs'));
  assert.ok(resolveServedPath('/'), 'the root maps to the index');
  for (const attempt of [
    '/../package.json',
    '/web/../../package.json',
    '/provenance.json',
    '/../../../etc/passwd',
    '/web/%2e%2e/%2e%2e/package.json',
  ]) {
    assert.equal(resolveServedPath(attempt), null, `${attempt} should be refused`);
  }
});

test('the server sends restrictive security headers and answers the capability probe', async () => {
  const { createPlaygroundServer } = await import('../server.mjs');
  const server = createPlaygroundServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const capabilities = await fetch(`http://127.0.0.1:${port}/api/capabilities`);
    assert.equal(capabilities.status, 200);
    const payload = await capabilities.json();
    assert.equal(payload.executor.canExecute, false);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.ok(!/unsafe-inline/.test(page.headers.get('content-security-policy')));
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('permissions-policy'), /camera=\(\)/);

    const module = await fetch(`http://127.0.0.1:${port}/src/catalogue/index.mjs`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /text\/javascript/);

    const traversal = await fetch(`http://127.0.0.1:${port}/../package.json`);
    assert.equal(traversal.status, 404);

    const execute = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sampleId: 'a2a-agent-card', inputs: {} }),
    });
    assert.equal(execute.status, 401, 'an unclaimed plain URL cannot invoke the relay proxy');
    const body = await execute.json();
    assert.equal(body.state, 'blocked');
    assert.equal(body.code, 'local-session-required');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
