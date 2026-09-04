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
  const intervals = [];
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
    setIntervalFn: (callback, ms) => {
      const interval = { callback, ms };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn: (interval) => {
      interval.cleared = true;
    },
    ...options,
  });
  return { orchestrator, timers, intervals, advance: (milliseconds) => (now += milliseconds) };
}

// Builds an orchestrator that shares an external store and clock with other
// orchestrators, so tests can simulate multiple cooperating (or competing)
// dispatcher processes racing over the same persisted run records.
function createSharedOrchestrator({ store, now, sequenceOffset = 0, ...options }) {
  let sequence = sequenceOffset;
  const timers = [];
  const intervals = [];
  const orchestrator = createManagedRunOrchestrator({
    store,
    now,
    random: () => `abcdefghijklmnopqrstuvwx${String(++sequence).padStart(2, '0')}`,
    setTimeoutFn: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer.cleared = true;
    },
    setIntervalFn: (callback, ms) => {
      const interval = { callback, ms };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn: (interval) => {
      interval.cleared = true;
    },
    ...options,
  });
  return { orchestrator, timers, intervals };
}

let nonceSequence = 0;

// A generously far-future, real-wall-clock-based acknowledgement expiry —
// always safely beyond any fake `now()` value these tests' harnesses use
// (which run in the low thousands to low millions) — used as the default
// wherever a test is not itself specifically exercising
// acknowledgement-expiry-driven nonce retention (see the dedicated test
// further down that supplies its own, deliberately shorter-than-real-TTL
// value).
const FAR_FUTURE_ACK_EXPIRY = Date.now() + 60 * 60_000;

function createRun(orchestrator, overrides = {}) {
  return orchestrator.create({
    owner: OWNER,
    tenant: TENANT,
    sampleId: SAMPLE,
    requestDigest: DIGEST,
    idempotencyKey: 'key-1',
    work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
    // Unique, well-formed (>= 8 characters) by default so ordinary tests
    // never accidentally collide on nonce reuse; overridden explicitly by
    // tests that specifically exercise nonce collision/replay behavior.
    nonce: `test-nonce-${++nonceSequence}`,
    acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
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
    claimDispatch: (...args) => base.claimDispatch(...args),
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

test('a renewed dispatch lease survives past its original expiry so a second orchestrator never redispatches still-active work, while a genuinely abandoned dispatch is still recovered exactly once', async () => {
  let now = 1_000;
  const store = createInMemoryManagedRunStore({ now: () => now });
  let launches = 0;
  const dispatcherA = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });
  const dispatcherB = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 100,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });

  const heartbeated = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'heartbeated' });
  const abandoned = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'abandoned' });
  await new Promise((done) => setImmediate(done));
  assert.equal(heartbeated.outcome, 'created');
  assert.equal(abandoned.outcome, 'created');
  assert.equal(launches, 2, 'each run dispatches exactly once on creation');
  assert.equal(dispatcherA.intervals.length, 2, 'each active dispatch starts its own renewing heartbeat');

  // Reproduce the original 60s dispatch-lease expiry window (advancing the
  // clock in DEFAULT_DISPATCH_LEASE_MS / 3 heartbeat-cadence steps) but only
  // tick the heartbeat for `heartbeated`. `abandoned` simulates a dispatcher
  // whose heartbeat has stopped outright (e.g. its process crashed).
  for (let tick = 0; tick < 4; tick += 1) {
    now += 20_000;
    dispatcherA.intervals[0].callback();
    await new Promise((done) => setImmediate(done));
  }
  assert.ok(now - 1_000 > 60_000, 'the original, un-renewed 60s dispatch lease would already have expired');

  const heartbeatedStillOwned = await store.get(heartbeated.run.runId);
  assert.ok(heartbeatedStillOwned.dispatchLeaseExpiresAt > now, 'the heartbeat kept renewing the lease past the current time');
  const abandonedLapsed = await store.get(abandoned.run.runId);
  assert.ok(abandonedLapsed.dispatchLeaseExpiresAt <= now, 'the abandoned run\'s lease was never renewed and has lapsed');

  const relaunchedCount = await dispatcherB.orchestrator.recover();
  await new Promise((done) => setImmediate(done));
  assert.equal(relaunchedCount, 1, 'only the genuinely abandoned run is recoverable');
  assert.equal(launches, 3, 'the still-heartbeated run must never be redispatched a second time');

  const stillRunning = await dispatcherA.orchestrator.status({ owner: OWNER, tenant: TENANT, runId: heartbeated.run.runId });
  assert.equal(stillRunning.state, 'running');

  // recover() must itself be idempotent: dispatcher B now owns `abandoned`
  // with a fresh, unexpired lease, so calling recover() again must not
  // relaunch it (or anything else) a further time.
  const secondRecoverPass = await dispatcherB.orchestrator.recover();
  assert.equal(secondRecoverPass, 0);
  assert.equal(launches, 3);
});

test('recovering a genuinely abandoned dispatch keeps concurrency accounting correct: capacity stays reserved exactly once and is released when the recovered run finishes', async () => {
  let now = 1_000;
  const store = createInMemoryManagedRunStore({ now: () => now });
  const executions = [];
  const dispatcherA = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    limits: { maxConcurrentRuns: 1, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => new Promise(() => {}), // never settles; abandoned outright
    },
  });
  const dispatcherB = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 100,
    limits: { maxConcurrentRuns: 1, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => {
        const execution = deferred();
        executions.push(execution);
        return execution.promise;
      },
    },
  });

  const created = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'solo' });
  await new Promise((done) => setImmediate(done));
  assert.equal(created.outcome, 'created');

  // At the concurrency limit: a second create() must be refused while the
  // (still-registered, un-renewed) dispatch is outstanding.
  const overLimit = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'blocked-by-limit' });
  assert.equal(overLimit.outcome, 'limit');

  now += 61_000; // past the original, never-renewed dispatch lease
  const relaunchedCount = await dispatcherB.orchestrator.recover();
  await new Promise((done) => setImmediate(done));
  assert.equal(relaunchedCount, 1);
  assert.equal(executions.length, 1, 'the recovered run launches exactly once under its new dispatcher');

  // Capacity must still be reserved exactly once for the recovered run: a
  // brand-new run for the same principal must still be refused.
  const stillOverLimit = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'still-blocked' });
  assert.equal(stillOverLimit.outcome, 'limit');

  executions[0].resolve({ state: 'completed', steps: [] });
  await new Promise((done) => setImmediate(done));
  const finishedStatus = await dispatcherB.orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(finishedStatus.state, 'completed');

  // Now that the recovered run has finished and released its capacity, a new
  // run for the same principal must succeed.
  const afterCompletion = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'after-completion' });
  assert.equal(afterCompletion.outcome, 'created');
});

test('recover() defers to jobLauncher.isActive for a lapsed dispatch lease, skipping redispatch only while the platform confirms the job is still running', async () => {
  let now = 1_000;
  const store = createInMemoryManagedRunStore({ now: () => now });
  let launches = 0;
  let active = true;
  const dispatcherA = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });
  const dispatcherB = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 100,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
      isActive: async () => active,
    },
  });

  const created = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'platform-verified' });
  await new Promise((done) => setImmediate(done));
  assert.equal(created.outcome, 'created');
  assert.equal(launches, 1);

  now += 61_000; // dispatch lease lapses; dispatcher A never renewed it

  const whileActive = await dispatcherB.orchestrator.recover();
  assert.equal(whileActive, 0, 'the launcher confirms the platform job is still running, so recover() must not redispatch it');
  assert.equal(launches, 1);

  active = false;
  const onceInactive = await dispatcherB.orchestrator.recover();
  await new Promise((done) => setImmediate(done));
  assert.equal(onceInactive, 1, 'once the launcher can no longer confirm the job is active, recover() redispatches it');
  assert.equal(launches, 2);
});

test('recover() fails closed when jobLauncher.isActive throws: no redispatch, and the run\'s state and capacity reservation stay untouched', async () => {
  let now = 1_000;
  const store = createInMemoryManagedRunStore({ now: () => now });
  let launches = 0;
  const onErrors = [];
  const dispatcherA = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    limits: { maxConcurrentRuns: 1, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });
  const dispatcherB = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 100,
    limits: { maxConcurrentRuns: 1, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
      isActive: async () => {
        throw new Error('the platform status endpoint is unavailable');
      },
    },
    onError: (info) => onErrors.push(info),
  });

  const created = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'isactive-throws' });
  await new Promise((done) => setImmediate(done));
  assert.equal(created.outcome, 'created');
  assert.equal(launches, 1);

  now += 61_000; // the original dispatch lease lapses; dispatcher A never renewed it

  const relaunchedCount = await dispatcherB.orchestrator.recover();
  assert.equal(relaunchedCount, 0, 'an isActive check that could not be completed must never be treated as "not active"');
  assert.equal(launches, 1, 'no duplicate job is launched while the platform check is unverifiable');
  assert.equal(onErrors.length, 1);
  assert.equal(onErrors[0].runId, created.run.runId);

  // The run's state and its capacity reservation are exactly as they were:
  // the original dispatcher's run is still reported running, and a
  // brand-new run for the same principal is still refused for capacity —
  // proving the failed verification neither released nor duplicated the
  // reservation.
  const status = await dispatcherA.orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(status.state, 'running');
  const overLimit = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'still-blocked-after-fail-closed' });
  assert.equal(overLimit.outcome, 'limit');
});

test('recover() never redispatches a run this SAME orchestrator still has a live local controller/job for, even once its dispatch lease has lapsed', async () => {
  let now = 1_000;
  // `createHarness()`'s in-memory store defaults to real wall-clock time
  // internally (it is never given the harness's own fake `now`), which
  // would make an `advance()` call invisible to the store's own dispatch
  // lease bookkeeping. Build the store explicitly, sharing the SAME fake
  // clock with the orchestrator, exactly as the other lease-expiry tests
  // above do — this is what makes the manual clock advance below actually
  // lapse the record's dispatch lease.
  const store = createInMemoryManagedRunStore({ now: () => now });
  const { orchestrator } = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    limits: { maxConcurrentRuns: 1, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => new Promise(() => {}), // never settles: the job stays live in this same process
    },
  });

  const created = await createRun(orchestrator, { idempotencyKey: 'same-orchestrator-live-job' });
  await new Promise((done) => setImmediate(done));
  assert.equal(created.outcome, 'created');
  const running = await orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(running.state, 'running');

  // Lapse the dispatch lease WITHOUT ticking the renewing heartbeat, as if
  // this process's own heartbeat interval had missed every renewal (for
  // example, a starved event loop) while the job itself is still live and
  // fully tracked in this same orchestrator's local `controllers`/`jobs`
  // bookkeeping.
  now += 61_000;

  const relaunchedCount = await orchestrator.recover();
  await new Promise((done) => setImmediate(done));
  assert.equal(relaunchedCount, 0, 'a run this orchestrator still tracks locally must never be counted as a redispatch attempt');

  const stillRunning = await orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(stillRunning.state, 'running', 'recover() must not have touched this run at all');

  // Capacity must still be reserved exactly once: a second run for the same
  // principal is still refused, proving recover() neither released nor
  // duplicated the reservation for the run it skipped.
  const overLimit = await createRun(orchestrator, { idempotencyKey: 'still-blocked-by-live-local-job' });
  assert.equal(overLimit.outcome, 'limit');
});

test('a worker that claims a run in the gap between listRecoverable\'s snapshot and the dispatch claim wins the race: recover() must not redispatch it', async () => {
  let now = 1_000;
  const base = createInMemoryManagedRunStore({ now: () => now });
  let launches = 0;
  // Wraps the real store so `listRecoverable` simulates a worker claiming
  // the run in the exact gap a stale snapshot leaves open — AFTER the
  // snapshot recover() will iterate over is taken, but BEFORE recover()'s
  // per-record dispatch-claim attempt runs.
  const store = {
    findIdempotency: (...args) => base.findIdempotency(...args),
    claim: (...args) => base.claim(...args),
    claimDispatch: (...args) => base.claimDispatch(...args),
    get: (...args) => base.get(...args),
    update: (...args) => base.update(...args),
    async listRecoverable() {
      const recoverable = await base.listRecoverable();
      for (const record of recoverable) {
        await base.claimWorker(record.runId, 'external-worker-1');
      }
      return recoverable;
    },
  };
  const dispatcherA = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });
  // Recovery is attempted by a SEPARATE orchestrator: dispatcher A's own
  // launch() call for this run is still live (its job never settles), and
  // this same orchestrator must never redispatch a run it still tracks
  // locally regardless of lease state (see the dedicated
  // same-orchestrator-live-controller test below) — that guard would make
  // dispatcher A recovering its OWN run a no-op before this race is ever
  // reached. The worker-claims-the-gap race this test protects against is a
  // genuinely different dispatcher's recovery attempt.
  const dispatcherB = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 100,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });

  const created = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'race-worker-claim' });
  await new Promise((done) => setImmediate(done));
  assert.equal(created.outcome, 'created');
  assert.equal(launches, 1);

  now += 61_000; // the dispatch lease lapses; dispatcher A never renewed it

  const relaunchedCount = await dispatcherB.orchestrator.recover();
  await new Promise((done) => setImmediate(done));
  // `recover()`'s return value reflects how many recoverable records it
  // attempted to redispatch (a pre-existing, unrelated characteristic — see
  // the other recover() tests above, which check actual launch counts the
  // same way); the correctness property this race protects is that no
  // SECOND job is ever actually launched on top of the worker-owned run.
  assert.equal(relaunchedCount, 1);
  assert.equal(launches, 1, 'the worker that claimed the run in the snapshot-to-dispatch gap wins the race: no duplicate job is launched on top of it');

  const record = await base.get(created.run.runId);
  assert.equal(record.workerLease, 'external-worker-1');
});

test('a stale recovery whose claimDispatch finds the run already cancelled must not release capacity while the original job might still be externally running', async () => {
  let now = 1_000;
  const base = createInMemoryManagedRunStore({ now: () => now });
  let claimDispatchCalls = 0;
  const gate = deferred();
  // Wraps the real store so the SECOND claimDispatch call — dispatcher B's,
  // made from inside its own recover()-triggered launch() — is gated open
  // only once the test has driven dispatcher A's own cancellation in
  // between. Dispatcher A's initial claim (the first claimDispatch call,
  // made from its own create()-triggered launch()) is left ungated.
  const store = {
    findIdempotency: (...args) => base.findIdempotency(...args),
    claim: (...args) => base.claim(...args),
    async claimDispatch(...args) {
      claimDispatchCalls += 1;
      if (claimDispatchCalls === 2) await gate.promise;
      return base.claimDispatch(...args);
    },
    get: (...args) => base.get(...args),
    update: (...args) => base.update(...args),
    listRecoverable: (...args) => base.listRecoverable(...args),
  };

  let launchesB = 0;
  const dispatcherA = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    limits: { maxConcurrentRuns: 1, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => new Promise(() => {}), // never settles: simulates external work that keeps running past cancellation
    },
  });
  const dispatcherB = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 100,
    limits: { maxConcurrentRuns: 1, maxConcurrentRunsPerPrincipal: 1 },
    jobLauncher: {
      launch: () => {
        launchesB += 1;
        return new Promise(() => {});
      },
    },
  });

  const created = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'stale-recovery-preserve-capacity' });
  await new Promise((done) => setImmediate(done));
  assert.equal(created.outcome, 'created');
  const running = await dispatcherA.orchestrator.status({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(running.state, 'running');
  assert.equal(claimDispatchCalls, 1, 'dispatcher A\'s own initial claim is the first, ungated claimDispatch call');

  now += 61_000; // the dispatch lease lapses; dispatcher A's heartbeat never ticks again from here

  // Start dispatcher B's recovery pass without awaiting it yet: it reaches
  // its own (second, gated) claimDispatch call and blocks there — exactly
  // in the gap between listRecoverable's snapshot and the dispatch-claim
  // write claimDispatch's own atomicity is meant to close.
  const recoverPromise = dispatcherB.orchestrator.recover();
  await new Promise((done) => setImmediate(done));
  assert.equal(claimDispatchCalls, 2, 'dispatcher B\'s recovery must have reached its own claimDispatch call');
  assert.equal(launchesB, 0, 'no replacement job yet: the gated claimDispatch has not resolved');

  // While B's claim is still gated, cancel the run through dispatcher A. A's
  // own live controller aborts (raceAbortSignal rejects promptly, per
  // deadline.mjs), but the underlying never-settling job promise itself
  // never actually stops — exactly the scenario where a real platform job
  // can keep running after its record goes terminal.
  const cancelled = await dispatcherA.orchestrator.cancel({ owner: OWNER, tenant: TENANT, runId: created.run.runId });
  assert.equal(cancelled.state, 'cancelled');
  await new Promise((done) => setImmediate(done));

  // Release the gate: dispatcher B's claimDispatch now observes the record
  // as already cancelled (`not-runnable`), with `startedAt` still set from
  // when it really did reach 'running'.
  gate.resolve();
  const relaunchedCount = await recoverPromise;
  await new Promise((done) => setImmediate(done));

  assert.equal(relaunchedCount, 1, 'recover() still counts this as an attempted redispatch even though the race lost');
  assert.equal(launchesB, 0, 'a not-runnable dispatch claim must never launch a replacement job, regardless of the capacity decision');

  // Capacity must still be reserved: a brand-new run is refused, proving the
  // stale recovery did NOT release the reservation just because the record
  // went terminal — the original job might still be running externally and
  // no jobLauncher.isActive check was available to prove otherwise.
  const replacement = await createRun(dispatcherA.orchestrator, { idempotencyKey: 'stale-recovery-replacement-still-blocked' });
  assert.deepEqual(replacement, { outcome: 'limit', scope: 'global' });
});

test('two orchestrators sharing a store admit the identical concurrent request exactly once: one created, one existing, same run, and the job launches exactly once', async () => {
  const store = createInMemoryManagedRunStore();
  let launches = 0;
  const dispatcherA = createSharedOrchestrator({
    store,
    now: () => 1_000,
    sequenceOffset: 0,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });
  const dispatcherB = createSharedOrchestrator({
    store,
    now: () => 1_000,
    sequenceOffset: 100,
    jobLauncher: {
      launch: () => {
        launches += 1;
        return new Promise(() => {});
      },
    },
  });

  const params = {
    owner: OWNER,
    tenant: TENANT,
    sampleId: SAMPLE,
    requestDigest: DIGEST,
    idempotencyKey: 'shared-key',
    nonce: 'shared-nonce-123',
    acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
    work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
  };
  const [a, b] = await Promise.all([dispatcherA.orchestrator.create(params), dispatcherB.orchestrator.create(params)]);
  await new Promise((done) => setImmediate(done));

  assert.deepEqual([a.outcome, b.outcome].sort(), ['created', 'existing']);
  const created = a.outcome === 'created' ? a : b;
  const existing = a.outcome === 'existing' ? a : b;
  assert.equal(existing.run.runId, created.run.runId);
  assert.equal(launches, 1, 'the job launches exactly once, never once per racing orchestrator');
});

test('two orchestrators sharing a store racing the same Idempotency-Key with different request digests: one created, one conflict, never both', async () => {
  const store = createInMemoryManagedRunStore();
  const dispatcherA = createSharedOrchestrator({ store, now: () => 1_000, sequenceOffset: 0, jobLauncher: { launch: () => new Promise(() => {}) } });
  const dispatcherB = createSharedOrchestrator({ store, now: () => 1_000, sequenceOffset: 100, jobLauncher: { launch: () => new Promise(() => {}) } });
  const otherDigest = canonicalInputDigest({
    sampleId: SAMPLE,
    inputs: { 'hub.gatewayUrl': 'https://gateway.example.test/other' },
    secretRefs: ['gatewayAccess.apiKey'],
  });

  const [a, b] = await Promise.all([
    dispatcherA.orchestrator.create({
      owner: OWNER,
      tenant: TENANT,
      sampleId: SAMPLE,
      requestDigest: DIGEST,
      idempotencyKey: 'conflict-key',
      nonce: 'nonce-conflict-aaaa',
      acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
      work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
    }),
    dispatcherB.orchestrator.create({
      owner: OWNER,
      tenant: TENANT,
      sampleId: SAMPLE,
      requestDigest: otherDigest,
      idempotencyKey: 'conflict-key',
      nonce: 'nonce-conflict-bbbb',
      acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
      work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
    }),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['conflict', 'created']);
});

test('two orchestrators sharing a store racing the same single-use nonce under different Idempotency-Keys: one created, one nonce-replayed', async () => {
  const store = createInMemoryManagedRunStore();
  const dispatcherA = createSharedOrchestrator({ store, now: () => 1_000, sequenceOffset: 0, jobLauncher: { launch: () => new Promise(() => {}) } });
  const dispatcherB = createSharedOrchestrator({ store, now: () => 1_000, sequenceOffset: 100, jobLauncher: { launch: () => new Promise(() => {}) } });
  const otherDigest = canonicalInputDigest({
    sampleId: SAMPLE,
    inputs: { 'hub.gatewayUrl': 'https://gateway.example.test/other' },
    secretRefs: ['gatewayAccess.apiKey'],
  });

  const [a, b] = await Promise.all([
    dispatcherA.orchestrator.create({
      owner: OWNER,
      tenant: TENANT,
      sampleId: SAMPLE,
      requestDigest: DIGEST,
      idempotencyKey: 'nonce-race-key-a',
      nonce: 'shared-nonce-xyz-123',
      acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
      work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
    }),
    dispatcherB.orchestrator.create({
      owner: OWNER,
      tenant: TENANT,
      sampleId: SAMPLE,
      requestDigest: otherDigest,
      idempotencyKey: 'nonce-race-key-b',
      nonce: 'shared-nonce-xyz-123',
      acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
      work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
    }),
  ]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['created', 'nonce-replayed']);
});

test('a request refused for nonce replay leaves no poisoned reservation: the same Idempotency-Key succeeds normally with a fresh nonce', async () => {
  const store = createInMemoryManagedRunStore();
  const { orchestrator } = createSharedOrchestrator({ store, now: () => 1_000, sequenceOffset: 0, jobLauncher: { launch: () => new Promise(() => {}) } });

  const first = await orchestrator.create({
    owner: OWNER,
    tenant: TENANT,
    sampleId: SAMPLE,
    requestDigest: DIGEST,
    idempotencyKey: 'key-once',
    nonce: 'reused-nonce-1',
    acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
    work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
  });
  assert.equal(first.outcome, 'created');

  // A different Idempotency-Key racing the SAME nonce is refused for
  // replay, never for anything about its own key.
  const replayed = await orchestrator.create({
    owner: OWNER,
    tenant: TENANT,
    sampleId: SAMPLE,
    requestDigest: DIGEST,
    idempotencyKey: 'key-replayed',
    nonce: 'reused-nonce-1',
    acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
    work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
  });
  assert.equal(replayed.outcome, 'nonce-replayed');

  // The rejected key must not be left poisoned: retrying it with a fresh
  // nonce must succeed normally, not resolve as an existing run or a
  // conflict inherited from the rejected attempt.
  const retried = await orchestrator.create({
    owner: OWNER,
    tenant: TENANT,
    sampleId: SAMPLE,
    requestDigest: DIGEST,
    idempotencyKey: 'key-replayed',
    nonce: 'fresh-nonce-2',
    acknowledgementExpiresAt: FAR_FUTURE_ACK_EXPIRY,
    work: { payload: { sampleId: SAMPLE }, auth: { principal: OWNER, tenant: TENANT } },
  });
  assert.equal(retried.outcome, 'created');
  assert.notEqual(retried.run.runId, first.run.runId);
});

test('the store retains a nonce until its validated acknowledgement really expires, not merely this store\'s fixed default TTL, so a longer-lived acknowledgement\'s nonce cannot be replayed once the default window alone would have lapsed', async () => {
  let now = 1_000;
  // Explicit shared-clock store construction (see the same-orchestrator
  // live-controller test above): the in-memory store's own nonce
  // bookkeeping runs on whatever `now` IT was constructed with, so the
  // orchestrator and the store must share the same fake clock for a manual
  // clock advance to actually lapse anything nonce-related.
  const store = createInMemoryManagedRunStore({ now: () => now });
  const { orchestrator } = createSharedOrchestrator({
    store,
    now: () => now,
    sequenceOffset: 0,
    jobLauncher: { launch: () => new Promise(() => {}) },
  });

  // An acknowledgement validated to run 8 minutes past its own issuance —
  // longer than this store's fixed 5-minute default nonce TTL (the same
  // DEFAULT_NONCE_TTL_MS the store falls back to for a caller that supplies
  // no expiry), but still comfortably inside ACKNOWLEDGEMENT_TTL_MS.
  const longLivedExpiresAt = now + 8 * 60_000;
  const first = await createRun(orchestrator, {
    idempotencyKey: 'ack-expiry-key-first',
    nonce: 'ack-expiry-shared-nonce',
    acknowledgementExpiresAt: longLivedExpiresAt,
  });
  assert.equal(first.outcome, 'created');

  // Advance the clock PAST the store's fixed 5-minute default nonce TTL
  // (measured from consumption time) but still well BEFORE this specific
  // acknowledgement's own, real 8-minute expiry.
  now += 5 * 60_000 + 1_000;

  // A DIFFERENT Idempotency-Key racing the SAME nonce must still be refused
  // as a replay here: under the old fixed-duration-from-consumption-time
  // retention scheme (a flat DEFAULT_NONCE_TTL_MS from the moment the nonce
  // was consumed, regardless of the acknowledgement's own real expiry), the
  // nonce would already have been reaped by now and this would have wrongly
  // succeeded as a second, independently 'created' run.
  const replay = await createRun(orchestrator, {
    idempotencyKey: 'ack-expiry-key-second',
    nonce: 'ack-expiry-shared-nonce',
    acknowledgementExpiresAt: now + 60_000,
  });
  assert.equal(replay.outcome, 'nonce-replayed');
});
