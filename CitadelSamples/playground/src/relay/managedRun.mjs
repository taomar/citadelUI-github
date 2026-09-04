/**
 * Managed, non-secret state for work delegated to a hosted relay job.
 *
 * Request payloads, acknowledgements, resolved secrets, authorization headers,
 * and executor output never enter this store. A job receives those only through
 * the in-memory closure supplied by the HTTP handler. The durable shape below is
 * intentionally small enough to be safe to persist in a managed database.
 */

import { createHash, randomBytes } from 'node:crypto';

import { raceAbortSignal } from './deadline.mjs';

const ACTIVE_STATES = new Set(['pending', 'running']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'inconclusive']);
const STEP_STATES = new Set(['completed', 'failed', 'cancelled', 'inconclusive']);
const STEP_KINDS = new Set(['http', 'assertion']);
const ASSERTION_STATES = new Set(['passed', 'failed', 'inconclusive']);
const DEFAULT_WORKER_LEASE_MS = 60_000;
const DEFAULT_DISPATCH_LEASE_MS = 60_000;

export const DEFAULT_MANAGED_RUN_LIMITS = Object.freeze({
  maxConcurrentRuns: 8,
  maxConcurrentRunsPerPrincipal: 2,
  runTimeoutMs: 5 * 60_000,
});

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function idempotencyIdentity({ owner, tenant, key }) {
  return `${owner}\u0000${tenant}\u0000${digest(key)}`;
}

function validIdentifier(value, maximum = 128) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value.length <= maximum;
}

function validClaim(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function copy(record) {
  return structuredClone(record);
}

function safeStep(step) {
  if (!step || typeof step !== 'object' || !validIdentifier(step.id) || !STEP_KINDS.has(step.kind)) return null;
  const state = STEP_STATES.has(step.state) ? step.state : 'inconclusive';
  const result = { id: step.id, kind: step.kind, state };
  if (Number.isSafeInteger(step.durationMs) && step.durationMs >= 0 && step.durationMs <= 24 * 60 * 60_000) {
    result.durationMs = step.durationMs;
  }
  if (step.kind === 'assertion' && ASSERTION_STATES.has(step.assertion?.status)) {
    result.assertion = { status: step.assertion.status };
  }
  return result;
}

function safeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 128).map(safeStep).filter(Boolean);
}

function terminalState(result) {
  if (result?.state === 'completed') return 'completed';
  if (result?.state === 'failed' || result?.state === 'blocked') return 'failed';
  if (result?.state === 'cancelled') return 'cancelled';
  return 'inconclusive';
}

function publicRecord(record) {
  return {
    runId: record.runId,
    sampleId: record.sampleId,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    steps: safeSteps(record.steps),
  };
}

/**
 * Privileged worker helper for a hosted-job adapter. The adapter enqueues only
 * `runId`; a fresh worker reloads the durable non-secret descriptor and writes
 * its safe partial/final projection back through the same store. This is what
 * lets a platform job outlive an individual relay process.
 */
export function createManagedRunWorker({
  store,
  executeWork,
  now = () => Date.now(),
  workerId = `worker_${randomBytes(16).toString('base64url')}`,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  cancellationPollMs = 250,
} = {}) {
  if (
    !store ||
    typeof store.claimWorker !== 'function' ||
    typeof store.renewWorkerLease !== 'function' ||
    typeof store.get !== 'function' ||
    typeof store.update !== 'function'
  ) {
    throw new TypeError('Managed run worker requires a store with atomic claimWorker, renewWorkerLease, get, and update methods.');
  }
  if (typeof executeWork !== 'function') throw new TypeError('Managed run worker requires an executeWork function.');
  if (!validIdentifier(workerId)) throw new TypeError('Managed run worker requires a valid workerId.');
  if (typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function' || !Number.isSafeInteger(cancellationPollMs) || cancellationPollMs < 1) {
    throw new TypeError('Managed run worker requires valid cancellation polling controls.');
  }

  async function savePartial(runId, steps) {
    return store.update(runId, (current) => {
      if (!ACTIVE_STATES.has(current.state)) return current;
      return { ...current, steps: safeSteps(steps) };
    });
  }

  return Object.freeze({
    async execute(runId, { signal } = {}) {
      // The durable store makes this compare-and-set atomic with cancellation:
      // either cancellation wins and no worker can cross an execution
      // boundary, or one worker claims the running job and the launcher must
      // propagate subsequent cancellation to that platform job.
      const claim = await store.claimWorker(runId, workerId);
      if (claim.outcome === 'missing') throw new TypeError('Managed run work was not found.');
      if (claim.outcome !== 'claimed') return publicRecord(claim.record);
      const current = claim.record;
      const controller = new AbortController();
      const onExternalAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener('abort', onExternalAbort, { once: true });
      const pollCancellation = async () => {
        const latest = await store.get(runId);
        if (!latest || !ACTIVE_STATES.has(latest.state) || latest.workerLease !== workerId) {
          controller.abort();
          return;
        }
        if (!(await store.renewWorkerLease(runId, workerId))) controller.abort();
      };
      try {
        await pollCancellation();
      } catch {
        controller.abort();
      }
      const cancellationPoll = setIntervalFn(() => {
        void pollCancellation().catch(() => controller.abort());
      }, cancellationPollMs);
      if (controller.signal.aborted) {
        clearIntervalFn(cancellationPoll);
        signal?.removeEventListener('abort', onExternalAbort);
        const cancelled = await store.update(runId, (current) => ({
          ...current,
          state: 'cancelled',
          finishedAt: now(),
          capacityReserved: false,
        }));
        return publicRecord(cancelled);
      }
      try {
        const result = await executeWork(copy(current.work), {
          signal: controller.signal,
          reportPartial: (steps) => savePartial(runId, steps),
        });
        const updated = await store.update(runId, (current) => {
          if (TERMINAL_STATES.has(current.state)) return { ...current, capacityReserved: false };
          return {
            ...current,
            state: controller.signal.aborted ? 'cancelled' : terminalState(result),
            finishedAt: now(),
            steps: safeSteps(result?.steps ?? current.steps),
            capacityReserved: false,
            workerLease: null,
            workerLeaseExpiresAt: null,
          };
        });
        return publicRecord(updated);
      } catch {
        const updated = await store.update(runId, (current) =>
          TERMINAL_STATES.has(current.state)
            ? { ...current, capacityReserved: false }
            : {
                ...current,
                state: controller.signal.aborted ? 'cancelled' : 'failed',
                finishedAt: now(),
                capacityReserved: false,
                workerLease: null,
                workerLeaseExpiresAt: null,
              },
        );
        return publicRecord(updated);
      } finally {
        clearIntervalFn(cancellationPoll);
        signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  });
}

/**
 * In-memory store for one relay process. Hosted deployments supply a durable
 * store with the same atomic `claim`, `claimWorker`, `get`, and `update`
 * operations.
 */
export function createInMemoryManagedRunStore({
  now = () => Date.now(),
  workerLeaseMs = DEFAULT_WORKER_LEASE_MS,
  dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS,
} = {}) {
  requirePositiveInteger(workerLeaseMs, 'workerLeaseMs');
  requirePositiveInteger(dispatchLeaseMs, 'dispatchLeaseMs');
  const runs = new Map();
  const idempotency = new Map();

  function reapExpiredWorkerLeases() {
    for (const [runId, current] of runs) {
      if (!ACTIVE_STATES.has(current.state) || !current.workerLease || current.workerLeaseExpiresAt > now()) continue;
      runs.set(
        runId,
        copy({ ...current, state: 'inconclusive', finishedAt: now(), capacityReserved: false, workerLease: null, workerLeaseExpiresAt: null }),
      );
    }
  }

  return Object.freeze({
    async findIdempotency({ owner, tenant, idempotencyKeyHash, requestDigest }) {
      const runId = idempotency.get(idempotencyIdentity({ owner, tenant, key: idempotencyKeyHash }));
      if (!runId) return { outcome: 'missing' };
      const record = runs.get(runId);
      return record.requestDigest === requestDigest ? { outcome: 'existing', record: copy(record) } : { outcome: 'conflict' };
    },
    async claim(record, limits) {
      // This runs in the same atomic store operation as the concurrency
      // check, so an expired worker can never retain a slot indefinitely just
      // because the relay has not restarted to call `recover()` again.
      reapExpiredWorkerLeases();
      const key = record.idempotencyKeyHash
        ? idempotencyIdentity({ owner: record.owner, tenant: record.tenant, key: record.idempotencyKeyHash })
        : null;
      const existingId = key ? idempotency.get(key) : null;
      if (existingId) {
        const existing = runs.get(existingId);
        if (existing.requestDigest === record.requestDigest) return { outcome: 'existing', record: copy(existing) };
        return { outcome: 'conflict', record: copy(existing) };
      }

      const active = [...runs.values()].filter((run) => run.capacityReserved !== false);
      if (active.length >= limits.maxConcurrentRuns) return { outcome: 'limit', scope: 'global' };
      if (active.filter((run) => run.owner === record.owner).length >= limits.maxConcurrentRunsPerPrincipal) {
        return { outcome: 'limit', scope: 'principal' };
      }

      runs.set(record.runId, copy(record));
      if (key) idempotency.set(key, record.runId);
      return { outcome: 'created', record: copy(record) };
    },
    async get(runId) {
      const record = runs.get(runId);
      return record ? copy(record) : null;
    },
    async claimWorker(runId, workerId) {
      const current = runs.get(runId);
      if (!current) return { outcome: 'missing' };
      if (!ACTIVE_STATES.has(current.state)) {
        const released = { ...current, capacityReserved: false };
        runs.set(runId, copy(released));
        return { outcome: 'not-runnable', record: copy(released) };
      }
      if (current.workerLease) {
        if (current.workerLeaseExpiresAt > now()) return { outcome: 'already-claimed', record: copy(current) };
        const stranded = {
          ...current,
          state: 'inconclusive',
          finishedAt: now(),
          capacityReserved: false,
          workerLease: null,
          workerLeaseExpiresAt: null,
        };
        runs.set(runId, copy(stranded));
        return { outcome: 'not-runnable', record: copy(stranded) };
      }
      const claimed = {
        ...current,
        workerLease: workerId,
        workerClaimedAt: now(),
        workerLeaseExpiresAt: now() + workerLeaseMs,
      };
      runs.set(runId, copy(claimed));
      return { outcome: 'claimed', record: copy(claimed) };
    },
    async renewWorkerLease(runId, workerId) {
      const current = runs.get(runId);
      if (!current || current.workerLease !== workerId || !ACTIVE_STATES.has(current.state)) return false;
      runs.set(runId, copy({ ...current, workerLeaseExpiresAt: now() + workerLeaseMs }));
      return true;
    },
    async listRecoverable() {
      reapExpiredWorkerLeases();
      const recovered = [];
      for (const [runId, current] of runs) {
        if (!ACTIVE_STATES.has(current.state)) continue;
        if (!current.workerLease && (!current.dispatchLeaseExpiresAt || current.dispatchLeaseExpiresAt <= now())) recovered.push(copy(current));
      }
      return recovered;
    },
    async update(runId, mutate) {
      const current = runs.get(runId);
      if (!current) return null;
      const next = mutate(copy(current));
      if (!next || typeof next !== 'object') throw new TypeError('Managed run store update must return a record.');
      runs.set(runId, copy(next));
      return copy(next);
    },
  });
}

/**
 * Orchestrates a one-shot job without retaining its request or credentials.
 *
 * `jobLauncher.launch({ run, work, signal, reportPartial })` receives a
 * validated, non-secret work descriptor that a hosted worker can reload after
 * a relay restart. It may return a Promise result or `{ result: Promise,
 * cancel?: () => void }`. Cancellation always aborts `signal`; an adapter may
 * additionally cancel its platform job.
 */
export function createManagedRunOrchestrator({
  store,
  jobLauncher,
  now = () => Date.now(),
  random = () => randomBytes(24).toString('base64url'),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onError = ({ runId, operation }) => console.error(`Managed run ${runId} could not ${operation}.`),
  limits = {},
} = {}) {
  if (
    !store ||
    typeof store.findIdempotency !== 'function' ||
    typeof store.claim !== 'function' ||
    typeof store.get !== 'function' ||
    typeof store.update !== 'function'
  ) {
    throw new TypeError('Managed run orchestration requires a store with findIdempotency, claim, get, and update methods.');
  }
  if (!jobLauncher || typeof jobLauncher.launch !== 'function') {
    throw new TypeError('Managed run orchestration requires a jobLauncher.launch method.');
  }
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('Managed run orchestration requires timer functions.');
  }
  if (typeof onError !== 'function') throw new TypeError('Managed run orchestration requires an onError function.');
  const bounds = Object.freeze({
    maxConcurrentRuns: requirePositiveInteger(limits.maxConcurrentRuns ?? DEFAULT_MANAGED_RUN_LIMITS.maxConcurrentRuns, 'maxConcurrentRuns'),
    maxConcurrentRunsPerPrincipal: requirePositiveInteger(
      limits.maxConcurrentRunsPerPrincipal ?? DEFAULT_MANAGED_RUN_LIMITS.maxConcurrentRunsPerPrincipal,
      'maxConcurrentRunsPerPrincipal',
    ),
    runTimeoutMs: requirePositiveInteger(limits.runTimeoutMs ?? DEFAULT_MANAGED_RUN_LIMITS.runTimeoutMs, 'runTimeoutMs'),
  });
  const controllers = new Map();
  const jobs = new Map();
  const dispatcherId = `dispatcher_${randomBytes(16).toString('base64url')}`;

  function makeRunId() {
    const token = random();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
      throw new TypeError('Managed run ID source must return an unguessable base64url token.');
    }
    return `run_${token}`;
  }

  function abortJob(runId) {
    controllers.get(runId)?.abort();
    try {
      jobs.get(runId)?.();
    } catch {
      onError({ runId, operation: 'cancel its hosted job' });
    }
  }

  async function reportPartial(runId, steps) {
    return store.update(runId, (current) => {
      if (!ACTIVE_STATES.has(current.state)) return current;
      return { ...current, steps: safeSteps(steps) };
    });
  }

  async function finish(runId, result, { aborted, timedOut }) {
    return store.update(runId, (current) => {
      if (TERMINAL_STATES.has(current.state)) return current;
      const state = timedOut ? 'inconclusive' : aborted ? 'cancelled' : terminalState(result);
      return { ...current, state, finishedAt: now(), steps: safeSteps(result?.steps ?? current.steps) };
    });
  }

  async function releaseCapacity(runId) {
    return store.update(runId, (current) => (current.capacityReserved === false ? current : { ...current, capacityReserved: false }));
  }

  async function launch(record) {
    const controller = new AbortController();
    controllers.set(record.runId, controller);
    let timer;
    let timedOut = false;
    let executionLaunched = false;
    try {
      let dispatchAcquired = false;
      const dispatched = await store.update(record.runId, (current) => {
        if (current.dispatcherId && current.dispatchLeaseExpiresAt > now()) {
          return current;
        }
        dispatchAcquired = true;
        return { ...current, dispatcherId, dispatchLeaseExpiresAt: now() + DEFAULT_DISPATCH_LEASE_MS };
      });
      if (!dispatchAcquired || dispatched.dispatcherId !== dispatcherId) return;
      const started = await store.update(record.runId, (current) =>
        TERMINAL_STATES.has(current.state) ? current : { ...current, state: 'running', startedAt: now() },
      );
      if (TERMINAL_STATES.has(started.state)) {
        // Cancellation can win while the asynchronous store writes the
        // pending->running transition. No platform job has launched in that
        // case, so its reserved slot must be released here.
        await releaseCapacity(record.runId);
        return;
      }

      timer = setTimeoutFn(() => {
        timedOut = true;
        abortJob(record.runId);
      }, bounds.runTimeoutMs);
      const launched = jobLauncher.launch({
        run: publicRecord(record),
        work: copy(record.work),
        signal: controller.signal,
        reportPartial: (steps) => reportPartial(record.runId, steps),
      });
      const isJobHandle = launched && typeof launched === 'object' && 'result' in launched;
      if (isJobHandle && typeof launched.cancel === 'function') jobs.set(record.runId, launched.cancel);
      if (controller.signal.aborted) abortJob(record.runId);
      const execution = isJobHandle ? launched.result : launched;
      executionLaunched = true;
      // A timeout bounds the public run state, but it does not prove an
      // uncooperative platform job stopped. Keep its capacity reservation
      // until its promise actually settles so repeated timeouts cannot evade
      // either concurrency limit.
      Promise.resolve(execution).then(
        () => void releaseCapacity(record.runId).catch(() => onError({ runId: record.runId, operation: 'release its capacity reservation' })),
        () => void releaseCapacity(record.runId).catch(() => onError({ runId: record.runId, operation: 'release its capacity reservation' })),
      );
      const result = await raceAbortSignal(
        execution,
        controller.signal,
        'The managed run exceeded its time budget or was cancelled.',
      );
      await finish(record.runId, result, { aborted: controller.signal.aborted, timedOut });
      await releaseCapacity(record.runId);
    } catch {
      // A start or store failure is still terminal; release the reservation
      // only when no launched job remains. A store that cannot record this is
      // an infrastructure failure and its own durable implementation must
      // surface it to its operator.
      await finish(record.runId, null, { aborted: controller.signal.aborted, timedOut }).catch(() =>
        onError({ runId: record.runId, operation: 'record its terminal state' }),
      );
      if (!executionLaunched) {
        await releaseCapacity(record.runId).catch(() => onError({ runId: record.runId, operation: 'release its capacity reservation' }));
      }
    } finally {
      if (timer) clearTimeoutFn(timer);
      controllers.delete(record.runId);
      jobs.delete(record.runId);
    }
  }

  return Object.freeze({
    limits: bounds,
    async idempotency({ owner, tenant, idempotencyKey, requestDigest }) {
      if (!validClaim(owner) || !validClaim(tenant) || typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
        throw new TypeError('Managed run idempotency lookup requires validated identity and key values.');
      }
      const found = await store.findIdempotency({ owner, tenant, idempotencyKeyHash: digest(idempotencyKey), requestDigest });
      return found.outcome === 'existing' ? { outcome: 'existing', run: publicRecord(found.record) } : found;
    },
    async create({ owner, tenant, sampleId, requestDigest, idempotencyKey, work }) {
      if (!validClaim(owner) || !validClaim(tenant) || !validIdentifier(sampleId) || !/^[a-f0-9]{64}$/.test(requestDigest)) {
        throw new TypeError('Managed run identity, sample, and request digest must be validated server-side values.');
      }
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
        throw new TypeError('An Idempotency-Key header of 1 to 128 visible ASCII characters is required.');
      }
      if (!work || typeof work !== 'object' || Array.isArray(work)) {
        throw new TypeError('Managed run creation requires a validated non-secret work descriptor.');
      }

      const record = {
        runId: makeRunId(),
        owner,
        tenant,
        sampleId,
        requestDigest,
        idempotencyKeyHash: digest(idempotencyKey),
        work: copy(work),
        state: 'pending',
        capacityReserved: true,
        createdAt: now(),
        steps: [],
      };
      const claimed = await store.claim(record, bounds);
      if (claimed.outcome === 'existing') return { outcome: 'existing', run: publicRecord(claimed.record) };
      if (claimed.outcome === 'conflict') return { outcome: 'conflict' };
      if (claimed.outcome === 'limit') return { outcome: 'limit', scope: claimed.scope };
      if (claimed.outcome !== 'created' || !claimed.record) throw new TypeError('Managed run store returned an invalid claim result.');

      void launch(claimed.record);
      return { outcome: 'created', run: publicRecord(claimed.record) };
    },
    async status({ owner, tenant, runId }) {
      const record = await store.get(runId);
      if (!record || record.owner !== owner || record.tenant !== tenant) return null;
      return publicRecord(record);
    },
    async cancel({ owner, tenant, runId }) {
      const record = await store.get(runId);
      if (!record || record.owner !== owner || record.tenant !== tenant) return null;
      const cancelled = await store.update(runId, (current) => {
        if (TERMINAL_STATES.has(current.state)) return current;
        return { ...current, state: 'cancelled', finishedAt: now() };
      });
      if (!TERMINAL_STATES.has(record.state)) {
        abortJob(runId);
      }
      return publicRecord(cancelled);
    },
    async recover() {
      if (typeof store.listRecoverable !== 'function') {
        throw new TypeError('Managed run recovery requires a store with listRecoverable.');
      }
      const recoverable = await store.listRecoverable();
      for (const record of recoverable) void launch(record);
      return recoverable.length;
    },
  });
}
