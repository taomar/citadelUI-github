import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalInputDigest } from '../../src/relay/acknowledgement.mjs';
import { createInMemoryManagedRunStore, createManagedRunOrchestrator, createManagedRunWorker } from '../../src/relay/managedRun.mjs';

const OWNER = 'caller-a';
const TENANT = 'tenant-a';
const SAMPLE = 'weather-mcp-discovery';
const DIGEST = canonicalInputDigest({ sampleId: SAMPLE, inputs: { 'hub.gatewayUrl': 'https://gateway.example.test' }, secretRefs: ['gatewayAccess.apiKey'] });

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness(options = {}) {
  let sequence = 0;
  let now = 1_000;
  const timers = [];
  const orchestrator = createManagedRunOrchestrator({
    store: createInMemoryManagedRunStore(),
    now: () => now,
    random: () => `abcdefghijklmnopqrstuvwx${String(++sequence).padStart(2, '0')}`,
    setTimeoutFn: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cleared = true;
    },
    ...options,
  });
  return { orchestrator, timers, advance: (milliseconds) => (now += milliseconds) };
}

function createRun(orchestrator, overrides = {}) {
  return orchestrator.create({
    owner: OWNER,
    tenant: TENANT,
    sampleId: SAMPLE,
    requestDigest: DIGEST,
    idempotencyKey: 'key-1',
    work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
    ...overrides,
  });
}

test('managed runs allocate unguessable IDs and persist only the safe lifecycle projection', async () => {
  const completion = deferred();
  const { orchestrator } = createHarness({
    jobLauncher: {
      launch: ({ reportPartial }) => {
        reportPartial([
          {
            id: 'initialize',
            kind: 'http',
            state: 'completed',
            title: 'untrusted upstream title',
            detail: 'secret-value',
            evidence: { authorization: 'secret-value' },
          },
        ]);
        return completion.promise;
      },
    },
  });
  const created = await createRun(orchestrator);
  assert.equal(created.outcome, 'created');
  assert.match(created.run.runId, /^run_[A-Za-z0-9_-]{24,128}$/);

  await new Promise((done) => setImmediate(done));
  const running = await orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(running.state, 'running');
  assert.deepEqual(running.steps, [{ id: 'initialize', kind: 'http', state: 'completed' }]);
  assert.doesNotMatch(JSON.stringify(running), /secret-value|authorization|untrusted upstream/i);

  completion.resolve({
    state: 'inconclusive',
    summary: 'upstream response containing secret-value',
    steps: [{ id: 'assert-weather', kind: 'assertion', state: 'inconclusive', assertion: { status: 'inconclusive', evidence: 'secret-value' } }],
  });
  await new Promise((done) => setImmediate(done));
  const finished = await orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(finished.state, 'inconclusive');
  assert.deepEqual(finished.steps, [{ id: 'assert-weather', kind: 'assertion', state: 'inconclusive', assertion: { status: 'inconclusive' } }]);
  assert.doesNotMatch(JSON.stringify(finished), /secret-value|upstream response/i);
});

test('an idempotency key reuses exactly its canonical request digest and launches only once', async () => {
  const completion = deferred();
  let launches = 0;
  const { orchestrator } = createHarness({
    jobLauncher: {
      launch: () => {
        launches += 1;
        return completion.promise;
      },
    },
  });
  const first = await createRun(orchestrator);
  const repeated = await createRun(orchestrator);
  const conflict = await createRun(orchestrator, { requestDigest: 'a'.repeat(64) });
  assert.equal(first.outcome, 'created');
  assert.equal(repeated.outcome, 'existing');
  assert.equal(repeated.run.runId, first.run.runId);
  assert.equal(conflict.outcome, 'conflict');
  await new Promise((done) => setImmediate(done));
  assert.equal(launches, 1);
  completion.resolve({ state: 'completed', steps: [] });
});

test('managed runs enforce global and per-principal concurrency without retrying failed work', async () => {
  const active = deferred();
  let launches = 0;
  const { orchestrator } = createHarness({
    limits: { maxConcurrentRuns: 2, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => {
        launches += 1;
        return active.promise;
      },
    },
  });
  const first = await createRun(orchestrator);
  await new Promise((done) => setImmediate(done));
  const principalLimit = await createRun(orchestrator, { idempotencyKey: 'key-2' });
  const second = await createRun(orchestrator, {
    owner: 'caller-b',
    idempotencyKey: 'key-3',
  });
  const globalLimit = await createRun(orchestrator, {
    owner: 'caller-c',
    idempotencyKey: 'key-4',
  });
  assert.equal(first.outcome, 'created');
  assert.deepEqual(principalLimit, { outcome: 'limit', scope: 'principal' });
  assert.equal(second.outcome, 'created');
  assert.deepEqual(globalLimit, { outcome: 'limit', scope: 'global' });
  active.resolve({ state: 'failed', steps: [] });
  await new Promise((done) => setImmediate(done));
  assert.equal(launches, 2);
});

test('cancellation and the run timeout abort the hosted job signal with distinct terminal states', async () => {
  const started = deferred();
  const { orchestrator, timers } = createHarness({
    limits: { runTimeoutMs: 25 },
    jobLauncher: {
      launch: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ state: 'completed', steps: [{ id: 'late', kind: 'http', state: 'completed', detail: 'must not win' }] }),
            { once: true },
          );
          started.resolve();
        }),
    },
  });
  const created = await createRun(orchestrator);
  await started.promise;
  timers[0].callback();
  await new Promise((done) => setImmediate(done));
  const timedOut = await orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(timedOut.state, 'inconclusive');

  const manual = deferred();
  let platformCancelCalls = 0;
  const second = createHarness({
    jobLauncher: {
      launch: ({ signal }) => ({
        result: new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ state: 'completed', steps: [] }), { once: true });
          manual.resolve();
        }),
        cancel: () => {
          platformCancelCalls += 1;
        },
      }),
    },
  });
  const another = await createRun(second.orchestrator, { idempotencyKey: 'key-2' });
  await manual.promise;
  const cancelled = await second.orchestrator.cancel({ owner: OWNER, tenant: TENANT, runId: another.run.runId });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(platformCancelCalls, 1);
  assert.equal((await second.orchestrator.status({ owner: 'other', tenant: TENANT, runId: another.run.runId })), null);
});

test('a hosted-job adapter that ignores cancellation cannot leave the managed run active past its deadline', async () => {
  const { orchestrator, timers } = createHarness({
    limits: { maxConcurrentRuns: 1 },
    jobLauncher: { launch: () => new Promise(() => {}) },
  });
  const created = await createRun(orchestrator);
  await new Promise((done) => setImmediate(done));
  timers[0].callback();
  await new Promise((done) => setImmediate(done));
  const run = await orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(run.state, 'inconclusive');
  const blockedByUnconfirmedJob = await createRun(orchestrator, { idempotencyKey: 'key-2' });
  assert.deepEqual(blockedByUnconfirmedJob, { outcome: 'limit', scope: 'global' });
});

test('cancelling before an asynchronous pending-to-running write releases the unlaunched capacity reservation', async () => {
  const base = createInMemoryManagedRunStore();
  const gate = deferred();
  let updates = 0;
  const store = {
    findIdempotency: (...args) => base.findIdempotency(...args),
    claim: (...args) => base.claim(...args),
    get: (...args) => base.get(...args),
    update: (...args) => {
      updates += 1;
      return updates === 1 ? gate.promise.then(() => base.update(...args)) : base.update(...args);
    },
  };
  const { orchestrator } = createHarness({
    store,
    limits: { maxConcurrentRuns: 1 },
    jobLauncher: { launch: () => assert.fail('a cancelled pending run must not launch a job') },
  });
  const first = await createRun(orchestrator);
  const cancelled = await orchestrator.cancel({ owner: OWNER, tenant: TENANT, runId: first.run.runId });
  assert.equal(cancelled.state, 'cancelled');
  gate.resolve();
  await new Promise((done) => setImmediate(done));
  const second = await createRun(orchestrator, { idempotencyKey: 'key-2' });
  assert.equal(second.outcome, 'created');
});

test('a fresh hosted worker reloads durable non-secret work by run ID and completes its safe state projection', async () => {
  const store = createInMemoryManagedRunStore();
  let launchedRunId;
  const { orchestrator } = createHarness({
    store,
    jobLauncher: {
      launch: ({ run }) => {
        launchedRunId = run.runId;
        return new Promise(() => {});
      },
    },
  });
  const created = await createRun(orchestrator);
  await new Promise((done) => setImmediate(done));

  const worker = createManagedRunWorker({
    store,
    executeWork: async (work, { reportPartial }) => {
      assert.equal(work.auth.principal, OWNER);
      await reportPartial([{ id: 'initialize', kind: 'http', state: 'completed', detail: 'not persisted' }]);
      return { state: 'completed', summary: 'raw upstream output', steps: [{ id: 'initialize', kind: 'http', state: 'completed', evidence: { raw: 'not persisted' } }] };
    },
  });
  const completed = await worker.execute(launchedRunId);
  assert.equal(completed.state, 'completed');
  assert.deepEqual(completed.steps, [{ id: 'initialize', kind: 'http', state: 'completed' }]);
  assert.doesNotMatch(JSON.stringify(completed), /raw upstream|not persisted/i);
  assert.equal((await orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId })).state, 'completed');
});

test('a hosted worker does not execute a durable run cancelled while it was still queued', async () => {
  const store = createInMemoryManagedRunStore();
  let launchedRunId;
  const { orchestrator } = createHarness({
    store,
    limits: { maxConcurrentRuns: 1 },
    jobLauncher: {
      launch: ({ run }) => {
        launchedRunId = run.runId;
        return new Promise(() => {});
      },
    },
  });
  const created = await createRun(orchestrator);
  await new Promise((done) => setImmediate(done));
  await orchestrator.cancel({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  let executed = false;
  const worker = createManagedRunWorker({
    store,
    executeWork: async () => {
      executed = true;
      return { state: 'completed', steps: [] };
    },
  });
  const result = await worker.execute(launchedRunId);
  assert.equal(result.state, 'cancelled');
  assert.equal(executed, false);
  const replacement = await createRun(orchestrator, { idempotencyKey: 'key-2' });
  assert.equal(replacement.outcome, 'created');
});

test('an atomic worker lease allows only one worker to execute a queued run', async () => {
  const store = createInMemoryManagedRunStore();
  let launchedRunId;
  const { orchestrator } = createHarness({
    store,
    jobLauncher: {
      launch: ({ run }) => {
        launchedRunId = run.runId;
        return new Promise(() => {});
      },
    },
  });
  await createRun(orchestrator);
  await new Promise((done) => setImmediate(done));
  const execution = deferred();
  let calls = 0;
  const worker = createManagedRunWorker({
    store,
    workerId: 'worker-test',
    executeWork: async () => {
      calls += 1;
      return execution.promise;
    },
  });
  const first = worker.execute(launchedRunId);
  const second = worker.execute(launchedRunId);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 1);
  execution.resolve({ state: 'completed', steps: [] });
  assert.equal((await first).state, 'completed');
  assert.equal((await second).state, 'running');
});
