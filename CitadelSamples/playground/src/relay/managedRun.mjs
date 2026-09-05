/**
 * Managed, non-secret state for work delegated to a hosted relay job.
 *
 * Request payloads, acknowledgements, resolved secrets, authorization headers,
 * and executor output never enter this store. A job receives those only through
 * the in-memory closure supplied by the HTTP handler. The durable shape below is
 * intentionally small enough to be safe to persist in a managed database.
 */

import { createHash, randomBytes } from 'node:crypto';

import { DEADLINE_EXCEEDED, raceAbortSignal, raceDeadline } from './deadline.mjs';

const ACTIVE_STATES = new Set(['pending', 'running']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'inconclusive']);
const STEP_STATES = new Set(['completed', 'failed', 'cancelled', 'inconclusive']);
const STEP_KINDS = new Set(['http', 'assertion']);
const ASSERTION_STATES = new Set(['passed', 'failed', 'inconclusive']);
const DEFAULT_WORKER_LEASE_MS = 60_000;
const DEFAULT_DISPATCH_LEASE_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 5 * 60_000;
// An absolute ceiling on how long a single-use nonce is retained, independent
// of any per-request acknowledgement expiry threaded in by a caller (see
// `claim`'s `nonceExpiresAt` below). This bounds the worst case for a
// malformed or abusive far-future expiry that somehow reached this store
// without first passing `verifyAcknowledgement`'s own TTL bound
// (`ACKNOWLEDGEMENT_TTL_MS` in acknowledgement.mjs) — generous enough to
// cover any plausible acknowledgement lifetime while still bounding memory.
const MAX_NONCE_RETENTION_MS = 30 * 60_000;
const MAX_TRACKED_NONCES = 10_000;

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
 * `{ runId, launchToken }`; a fresh worker reloads the durable non-secret
 * descriptor and writes its safe partial/final projection back through the
 * same store. The token binds that worker to one exact dispatch generation so
 * a delayed worker from an older launch cannot execute a recovered run.
 * `workerLeaseMs` must match the durable store's lease duration; the in-memory
 * store exposes its value so the worker derives a safe polling cadence.
 */
export function createManagedRunWorker({
  store,
  executeWork,
  now = () => Date.now(),
  workerId = `worker_${randomBytes(16).toString('base64url')}`,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  workerLeaseMs = store?.workerLeaseMs ?? DEFAULT_WORKER_LEASE_MS,
  cancellationPollMs = Math.min(250, Math.max(1, Math.floor(workerLeaseMs / 3))),
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
  requirePositiveInteger(workerLeaseMs, 'workerLeaseMs');
  if (typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function' || !Number.isSafeInteger(cancellationPollMs) || cancellationPollMs < 1) {
    throw new TypeError('Managed run worker requires valid cancellation polling controls.');
  }
  if (cancellationPollMs >= workerLeaseMs) {
    throw new TypeError('cancellationPollMs must be less than workerLeaseMs so a healthy worker renews before its lease can expire.');
  }

  async function savePartial(runId, steps) {
    return store.update(runId, (current) => {
      if (
        !ACTIVE_STATES.has(current.state) ||
        current.workerLease !== workerId ||
        !Number.isFinite(current.workerLeaseExpiresAt) ||
        current.workerLeaseExpiresAt <= now()
      ) {
        return current;
      }
      return { ...current, steps: safeSteps(steps) };
    });
  }

  return Object.freeze({
    async execute(runId, { signal, launchToken } = {}) {
      // The durable store makes this compare-and-set atomic with cancellation:
      // either cancellation wins and no worker can cross an execution
      // boundary, or one worker claims the running job and the launcher must
      // propagate subsequent cancellation to that platform job.
      const claim = await store.claimWorker(runId, workerId, launchToken);
      if (claim.outcome === 'missing') throw new TypeError('Managed run work was not found.');
      if (claim.outcome !== 'claimed') return publicRecord(claim.record);
      const current = claim.record;
      const controller = new AbortController();
      let leaseLost = false;
      let leaseDeadline = current.workerLeaseExpiresAt;
      let pollPromise = null;
      const onExternalAbort = () => controller.abort();
      const loseLease = () => {
        leaseLost = true;
        controller.abort();
      };
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener('abort', onExternalAbort, { once: true });
      const pollCancellation = async () => {
        const latest = await store.get(runId);
        if (
          !latest ||
          !ACTIVE_STATES.has(latest.state) ||
          latest.workerLease !== workerId ||
          !Number.isFinite(latest.workerLeaseExpiresAt) ||
          latest.workerLeaseExpiresAt <= now()
        ) {
          loseLease();
          return false;
        }
        leaseDeadline = latest.workerLeaseExpiresAt;
        if (!(await store.renewWorkerLease(runId, workerId))) {
          loseLease();
          return false;
        }
        leaseDeadline = now() + workerLeaseMs;
        return true;
      };
      const startPoll = () => {
        if (pollPromise) return pollPromise;
        if (!Number.isFinite(leaseDeadline) || leaseDeadline <= now()) {
          loseLease();
          return Promise.resolve(false);
        }
        const pending = Promise.resolve().then(pollCancellation);
        pollPromise = pending;
        pending.then(
          () => {
            if (pollPromise === pending) pollPromise = null;
          },
          () => {
            if (pollPromise === pending) pollPromise = null;
          },
        );
        return pending;
      };
      const cancellationPoll = setIntervalFn(() => {
        if (pollPromise) {
          if (!Number.isFinite(leaseDeadline) || leaseDeadline <= now()) loseLease();
          return;
        }
        void startPoll().catch(loseLease);
      }, cancellationPollMs);
      try {
        await raceDeadline(startPoll(), controller.signal);
      } catch {
        loseLease();
      }
      if (controller.signal.aborted) {
        clearIntervalFn(cancellationPoll);
        signal?.removeEventListener('abort', onExternalAbort);
        const cancelled = await store.update(runId, (current) => {
          if (current.workerLease !== workerId) return current;
          if (TERMINAL_STATES.has(current.state)) {
            return { ...current, capacityReserved: false, workerLease: null, workerLeaseExpiresAt: null };
          }
          return {
            ...current,
            state:
              leaseLost || !Number.isFinite(current.workerLeaseExpiresAt) || current.workerLeaseExpiresAt <= now()
                ? 'inconclusive'
                : 'cancelled',
            finishedAt: now(),
            capacityReserved: false,
            workerLease: null,
            workerLeaseExpiresAt: null,
          };
        });
        return publicRecord(cancelled);
      }
      try {
        const result = await executeWork(copy(current.work), {
          signal: controller.signal,
          reportPartial: (steps) => savePartial(runId, steps),
        });
        const updated = await store.update(runId, (current) => {
          if (current.workerLease !== workerId) return current;
          if (TERMINAL_STATES.has(current.state)) {
            return { ...current, capacityReserved: false, workerLease: null, workerLeaseExpiresAt: null };
          }
          const expired =
            leaseLost || !Number.isFinite(current.workerLeaseExpiresAt) || current.workerLeaseExpiresAt <= now();
          return {
            ...current,
            state: expired ? 'inconclusive' : controller.signal.aborted ? 'cancelled' : terminalState(result),
            finishedAt: now(),
            steps: expired ? current.steps : safeSteps(result?.steps ?? current.steps),
            capacityReserved: false,
            workerLease: null,
            workerLeaseExpiresAt: null,
          };
        });
        return publicRecord(updated);
      } catch {
        const updated = await store.update(runId, (current) =>
          current.workerLease !== workerId
            ? current
            : TERMINAL_STATES.has(current.state)
              ? { ...current, capacityReserved: false, workerLease: null, workerLeaseExpiresAt: null }
            : {
                ...current,
                state:
                  leaseLost || !Number.isFinite(current.workerLeaseExpiresAt) || current.workerLeaseExpiresAt <= now()
                    ? 'inconclusive'
                    : controller.signal.aborted
                      ? 'cancelled'
                      : 'failed',
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
 * store with the same atomic `findIdempotency`, `claim`, `claimDispatch`,
 * `claimLaunch`, `claimWorker`, `renewWorkerLease`, `listRecoverable`, `get`,
 * and `update` operations — each one a single transaction against the backing
 * store, not a sequence of separate reads and writes an unrelated caller
 * could observe or interleave with.
 *
 * `claim` is the one atomic ADMISSION operation: given a fully-formed run
 * record and this request's single-use `nonce`, it combines the idempotency
 * lookup/digest-conflict check, nonce consumption, concurrency reservation,
 * and run creation into one indivisible step (see its own doc below). A
 * hosted adapter MUST implement this as one transaction — e.g. a single
 * conditional write, or a database transaction with the equivalent
 * isolation — never as separate lookup-then-write calls a concurrent caller
 * could observe between. Nonce single-use tracking therefore lives HERE, in
 * the same durable store as run state, not in the process-local
 * `nonceStore.mjs` used by the synchronous `/execute` path — only a store
 * shared by every replica can make nonce consumption atomic with the run
 * claim across more than one relay process. `claim`'s optional
 * `nonceExpiresAt` is the caller's already-validated acknowledgement expiry
 * (see `createManagedRunOrchestrator.create` below); the nonce is retained
 * until at least that real expiry — bounded by an absolute
 * `maxNonceRetentionMs` ceiling — rather than a single fixed default TTL, so
 * a longer-lived acknowledgement's nonce cannot be replayed merely because
 * this store's own default window would otherwise have lapsed first.
 *
 * `claimDispatch` is the one atomic DISPATCH-OWNERSHIP operation a hosted
 * adapter must also implement as a single transaction: it grants ownership
 * only when the run is still active, no worker holds an unexpired lease,
 * and no OTHER dispatcher holds an unexpired lease — never granting it based
 * on a separately-read snapshot that could already be stale by the time the
 * grant is written.
 */
export function createInMemoryManagedRunStore({
  now = () => Date.now(),
  workerLeaseMs = DEFAULT_WORKER_LEASE_MS,
  dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS,
  nonceTtlMs = DEFAULT_NONCE_TTL_MS,
  maxNonceRetentionMs = MAX_NONCE_RETENTION_MS,
} = {}) {
  requirePositiveInteger(workerLeaseMs, 'workerLeaseMs');
  requirePositiveInteger(dispatchLeaseMs, 'dispatchLeaseMs');
  requirePositiveInteger(nonceTtlMs, 'nonceTtlMs');
  requirePositiveInteger(maxNonceRetentionMs, 'maxNonceRetentionMs');
  const runs = new Map();
  const idempotency = new Map();
  const nonces = new Map(); // nonce -> expiresAtMs; single-use tracking for the atomic `claim` admission below.

  function strandExpiredWorker(current) {
    return {
      ...current,
      state: 'inconclusive',
      finishedAt: current.finishedAt ?? now(),
      // Lease expiry fences the worker's state writes, but does not prove its
      // promise or external job stopped. Keep both the reservation and worker
      // identity until settlement or an authoritative inactivity check.
      capacityReserved: current.capacityReserved !== false,
    };
  }

  function reapExpiredWorkerLeases() {
    for (const [runId, current] of runs) {
      if (!ACTIVE_STATES.has(current.state) || !current.workerLease || current.workerLeaseExpiresAt > now()) continue;
      runs.set(runId, copy(strandExpiredWorker(current)));
    }
  }

  // Mirrors `nonceStore.mjs`'s own shape bounds and fail-closed tracked-count
  // cap, but tracked HERE so consuming it can be part of the very same
  // atomic operation as the idempotency check and the concurrency
  // reservation in `claim` below — a process-local nonce store could never
  // give that guarantee once more than one orchestrator shares this store.
  function consumeNonce(nonce, nonceExpiresAt) {
    if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 200) return false;
    const cutoff = now();
    for (const [tracked, expiresAtMs] of nonces) {
      if (expiresAtMs <= cutoff) nonces.delete(tracked);
    }
    if (nonces.has(nonce)) return false;
    if (nonces.size >= MAX_TRACKED_NONCES) return false; // fail closed rather than grow unbounded
    // Retain the nonce until the caller's OWN validated acknowledgement
    // really expires, not merely this store's fixed default window: a
    // default shorter than an acknowledgement's legitimate, per-request TTL
    // would otherwise let a still-unexpired acknowledgement's nonce be
    // replayed once the default alone had lapsed. Bounded by
    // `maxNonceRetentionMs` against an abusive or malformed far-future
    // value; a missing, non-finite, or already-past value falls back to
    // this store's fixed default, preserving prior behavior for callers
    // that do not supply one.
    const retainUntil =
      typeof nonceExpiresAt === 'number' && Number.isFinite(nonceExpiresAt) && nonceExpiresAt > cutoff
        ? Math.min(nonceExpiresAt, cutoff + maxNonceRetentionMs)
        : cutoff + nonceTtlMs;
    nonces.set(nonce, retainUntil);
    return true;
  }

  return Object.freeze({
    workerLeaseMs,
    async findIdempotency({ owner, tenant, idempotencyKeyHash, requestDigest }) {
      const runId = idempotency.get(idempotencyIdentity({ owner, tenant, key: idempotencyKeyHash }));
      if (!runId) return { outcome: 'missing' };
      const record = runs.get(runId);
      return record.requestDigest === requestDigest ? { outcome: 'existing', record: copy(record) } : { outcome: 'conflict' };
    },
    /**
     * The one atomic admission operation: idempotency lookup/digest-conflict,
     * single-use nonce consumption, concurrency reservation, and run
     * creation, all in one indivisible step. Two callers racing with the
     * SAME (owner, tenant, Idempotency-Key, requestDigest, nonce) — whether
     * from the same orchestrator or two orchestrators sharing this store —
     * can never both create a run or both consume the nonce: whichever call
     * this store observes second finds the key already resolved by the
     * first and returns 'existing' (when the digest matches) or 'conflict'
     * (when it does not), WITHOUT ever touching the nonce — a loser is never
     * told its nonce was replayed merely because an equivalent request won.
     * The nonce is consumed only on the path that would otherwise create a
     * genuinely new run, so two DIFFERENT idempotency keys racing over the
     * SAME nonce resolve to exactly one 'created' and one 'nonce-replayed'.
     * A concurrency-limit refusal after nonce consumption still burns the
     * nonce — the same ordering this store has always applied when refusing
     * for capacity — but a request refused BEFORE this call is ever reached
     * (a validation failure upstream) never touches the nonce or reserves
     * anything here at all.
     */
    async claim(record, limits, { nonce, nonceExpiresAt } = {}) {
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

      if (!consumeNonce(nonce, nonceExpiresAt)) return { outcome: 'nonce-replayed' };

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
    /**
     * The one atomic dispatch-ownership operation: grants ownership only
     * when the run is still active, no worker holds an unexpired lease, and
     * no OTHER dispatcher holds an unexpired lease — all three checked and
     * written in the same step. This is what makes `recover()` safe against
     * a worker that claims a run in the gap between `listRecoverable`'s
     * snapshot and this call: the snapshot can be stale, but the grant it
     * requests here is always evaluated against the CURRENT record, so a
     * worker that won the race in between is never overridden by a
     * redispatch based on stale information.
     */
    async claimDispatch(runId, dispatcherId, leaseMs) {
      const current = runs.get(runId);
      if (!current) return { outcome: 'missing' };
      if (!ACTIVE_STATES.has(current.state)) return { outcome: 'not-runnable', record: copy(current) };
      if (current.workerLease) {
        if (current.workerLeaseExpiresAt > now()) return { outcome: 'worker-active', record: copy(current) };
        const stranded = strandExpiredWorker(current);
        runs.set(runId, copy(stranded));
        return { outcome: 'not-runnable', record: copy(stranded) };
      }
      if (current.dispatcherId && current.dispatcherId !== dispatcherId && current.dispatchLeaseExpiresAt > now()) {
        return { outcome: 'dispatcher-active', record: copy(current) };
      }
      const claimed = {
        ...current,
        dispatcherId,
        dispatchLeaseExpiresAt: now() + leaseMs,
        dispatchGeneration: Number.isSafeInteger(current.dispatchGeneration) ? current.dispatchGeneration + 1 : 1,
        launchCommittedAt: null,
        launchInvocationCommittedAt: null,
        launchToken: null,
      };
      runs.set(runId, copy(claimed));
      return { outcome: 'claimed', record: copy(claimed) };
    },
    /**
     * Claims the generation token that will fence the platform launch. The
     * orchestrator performs one final atomic `update` immediately before
     * invoking the launcher; `launchInvocationCommittedAt` distinguishes a
     * token that was only prepared from one whose invocation was committed.
     */
    async claimLaunch(runId, dispatcherId, launchToken) {
      const current = runs.get(runId);
      if (!current) return { outcome: 'missing' };
      if (!ACTIVE_STATES.has(current.state)) return { outcome: 'not-runnable', record: copy(current) };
      if (current.workerLease) return { outcome: 'worker-active', record: copy(current) };
      if (current.dispatcherId !== dispatcherId || !current.dispatchLeaseExpiresAt || current.dispatchLeaseExpiresAt <= now()) {
        return { outcome: 'dispatcher-lost', record: copy(current) };
      }
      if (typeof launchToken !== 'string' || !/^[a-f0-9]{48}$/.test(launchToken)) {
        throw new TypeError('Managed run launch claims require an unguessable fencing token.');
      }
      if (current.launchToken) return { outcome: 'already-claimed', record: copy(current) };
      const claimed = { ...current, launchCommittedAt: now(), launchToken };
      runs.set(runId, copy(claimed));
      return { outcome: 'claimed', record: copy(claimed) };
    },
    async claimWorker(runId, workerId, launchToken) {
      const current = runs.get(runId);
      if (!current) return { outcome: 'missing' };
      if (!ACTIVE_STATES.has(current.state)) {
        return { outcome: 'not-runnable', record: copy(current) };
      }
      if (!current.launchCommittedAt || !current.launchInvocationCommittedAt) {
        return { outcome: 'not-dispatched', record: copy(current) };
      }
      if (typeof launchToken !== 'string' || launchToken !== current.launchToken) {
        return { outcome: 'launch-token-mismatch', record: copy(current) };
      }
      if (current.workerLease) {
        if (current.workerLeaseExpiresAt > now()) return { outcome: 'already-claimed', record: copy(current) };
        const stranded = strandExpiredWorker(current);
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
      if (!Number.isFinite(current.workerLeaseExpiresAt) || current.workerLeaseExpiresAt <= now()) {
        runs.set(runId, copy(strandExpiredWorker(current)));
        return false;
      }
      runs.set(runId, copy({ ...current, workerLeaseExpiresAt: now() + workerLeaseMs }));
      return true;
    },
    async listRecoverable() {
      reapExpiredWorkerLeases();
      const recovered = [];
      for (const [runId, current] of runs) {
        if (TERMINAL_STATES.has(current.state) && current.capacityReserved !== false) {
          recovered.push(copy(current));
          continue;
        }
        if (ACTIVE_STATES.has(current.state) && !current.workerLease && (!current.dispatchLeaseExpiresAt || current.dispatchLeaseExpiresAt <= now())) {
          recovered.push(copy(current));
        }
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
 * `jobLauncher.launch({ run, work, signal, reportPartial, fence })` receives a
 * validated, non-secret work descriptor and an unguessable launch-generation
 * fence. A hosted adapter MUST use `{ run.runId, fence.token }` as its
 * atomic/idempotent platform-create identity, refuse an expired
 * `fence.expiresAt`, and enqueue that same token with the run ID for
 * `createManagedRunWorker.execute`. That makes a stale dispatcher or worker
 * harmless even if it resumes after a newer generation has recovered the run.
 * The launcher may return a Promise result or `{ result: Promise, cancel?: ()
 * => void }`. Cancellation always aborts `signal`; an adapter may additionally
 * cancel its platform job.
 *
 * `jobLauncher.isActive({ run, work, signal })` is optional. `recover()` calls it,
 * when present, for a run whose dispatch lease has lapsed with no worker
 * claim, so an adapter that can independently confirm its platform job is
 * still running can refuse a redundant redispatch instead of only trusting
 * lease expiry. Recovery also calls it for a terminal record that still owns
 * capacity after a restart; only an explicit `false` proves that reservation
 * safe to release. It must FAIL CLOSED: if it is absent for that terminal
 * record, throws, rejects, or returns anything other than a boolean,
 * `recover()` treats the platform state as unverifiable this pass — it reports
 * thrown errors through `onError`, leaves the run's state and capacity
 * reservation untouched, and does NOT redispatch it. An inconclusive check
 * must never be treated as license to launch a possible second, duplicate job
 * or under-count still-active external work; the next `recover()` pass gets
 * another chance to verify it. `launch()` also consults it — never to
 * redispatch, only to decide whether a STALE recovery attempt (one whose
 * `claimDispatch` found the run already terminal) may safely release its
 * capacity reservation; see the `not-runnable` handling in `launch()` below.
 *
 * `recover()` never redispatches a run this SAME orchestrator still has a
 * live local controller/job for, regardless of what the store's lease state
 * says: a lapsed lease usually means an owning process is genuinely gone,
 * but this process's own bookkeeping (`controllers`/`jobs`, populated for
 * exactly as long as its own `launch()` call for that run has not yet
 * returned) is always more current than anything the store's lease alone
 * can prove, and redispatching a run this process is already tracking would
 * always be wrong. `launch()` itself carries the same guard as a defensive
 * second layer.
 *
 * A dispatcher's ownership of a run is itself a renewable lease
 * (`dispatchLeaseMs`, renewed every `dispatchHeartbeatMs` while the run is
 * active and unclaimed by a worker) rather than a single fixed grant — this
 * is what lets a run whose execution outlives one lease period keep being
 * recognised as still owned, so a second orchestrator's `recover()` never
 * redispatches genuinely still-active work. Both the initial acquisition and
 * every renewal go through the store's atomic `claimDispatch`/`update`
 * operations, which re-check the CURRENT record — never a stale snapshot —
 * so a worker (or a different dispatcher) that claims a run in the gap
 * between `listRecoverable`'s snapshot and this dispatcher's own claim
 * attempt always wins that race; `recover()` never launches a duplicate job
 * on top of it. When that race instead finds the run has gone terminal
 * (`claimDispatch`'s `not-runnable` outcome — for example, cancelled while a
 * redispatch was in flight), releasing its capacity reservation is safe only
 * when no external job launched by any process could still be running for
 * it: see the `not-runnable` handling in `launch()` below.
 *
 * `startRecovery()` runs one immediate recovery pass and then keeps exactly one
 * bounded timer scheduled. Passes are single-flight: a timer tick, a manual
 * `recover()`, and a repeated `startRecovery()` all share the same in-progress
 * promise rather than overlapping store reads or dispatch attempts. The timer
 * wakes at least every `recoveryIntervalMs`, and sooner when a terminal launch
 * commitment has a nearer lease expiry. Every platform-status probe is itself
 * bounded by `recoveryProbeTimeoutMs`; timeout, abort, error, and non-boolean
 * outcomes are unverifiable and therefore retain capacity without redispatch.
 * If a timed-out dependency ignores abort, later passes do not start overlapping
 * probes for that record; verification resumes only after the outstanding call
 * settles. A call that never settles therefore keeps the reservation fail-closed.
 * `stopRecovery()` clears the scheduler timer, aborts in-flight probes, and
 * prevents an in-progress pass from scheduling another one during shutdown.
 */
export function createManagedRunOrchestrator({
  store,
  jobLauncher,
  now = () => Date.now(),
  random = () => randomBytes(24).toString('base64url'),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = ({ runId, operation }) =>
    console.error(runId ? `Managed run ${runId} could not ${operation}.` : `Managed run recovery could not ${operation}.`),
  limits = {},
  dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS,
  dispatchHeartbeatMs = Math.max(1, Math.floor(dispatchLeaseMs / 3)),
  recoveryIntervalMs = Math.max(1, Math.floor(dispatchLeaseMs / 2)),
  recoveryProbeTimeoutMs = 10_000,
} = {}) {
  if (
    !store ||
    typeof store.findIdempotency !== 'function' ||
    typeof store.claim !== 'function' ||
    typeof store.claimDispatch !== 'function' ||
    typeof store.claimLaunch !== 'function' ||
    typeof store.get !== 'function' ||
    typeof store.update !== 'function'
  ) {
    throw new TypeError('Managed run orchestration requires a store with findIdempotency, claim, claimDispatch, claimLaunch, get, and update methods.');
  }
  if (!jobLauncher || typeof jobLauncher.launch !== 'function') {
    throw new TypeError('Managed run orchestration requires a jobLauncher.launch method.');
  }
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('Managed run orchestration requires timer functions.');
  }
  if (typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    throw new TypeError('Managed run orchestration requires interval functions.');
  }
  if (typeof onError !== 'function') throw new TypeError('Managed run orchestration requires an onError function.');
  requirePositiveInteger(dispatchLeaseMs, 'dispatchLeaseMs');
  requirePositiveInteger(dispatchHeartbeatMs, 'dispatchHeartbeatMs');
  requirePositiveInteger(recoveryIntervalMs, 'recoveryIntervalMs');
  requirePositiveInteger(recoveryProbeTimeoutMs, 'recoveryProbeTimeoutMs');
  if (dispatchHeartbeatMs >= dispatchLeaseMs) {
    throw new TypeError('dispatchHeartbeatMs must be less than dispatchLeaseMs so a live dispatcher always renews before its lease can expire.');
  }
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
  const cancelledJobs = new Set();
  const dispatcherId = `dispatcher_${randomBytes(16).toString('base64url')}`;
  let recoveryTimer = null;
  let recoveryTimerDueAt = null;
  let recoveryPromise = null;
  let recoveryPromiseGeneration = null;
  let recoveryRestartPromise = null;
  let recoveryRestartGeneration = null;
  let recoverySchedulerStarted = false;
  let recoveryGeneration = 0;
  const recoveryProbeControllers = new Set();
  const outstandingHostedJobProbes = new Map();

  function recoveryIsCurrent(generation) {
    return generation === null || generation === recoveryGeneration;
  }

  async function probeHostedJobActive(record, operation) {
    if (outstandingHostedJobProbes.has(record.runId)) return null;
    const controller = new AbortController();
    recoveryProbeControllers.add(controller);
    let timedOut = false;
    const timeout = setTimeoutFn(() => {
      timedOut = true;
      controller.abort();
    }, recoveryProbeTimeoutMs);
    try {
      const probe = Promise.resolve().then(() =>
        jobLauncher.isActive({
          run: publicRecord(record),
          work: copy(record.work),
          signal: controller.signal,
        }),
      );
      outstandingHostedJobProbes.set(record.runId, probe);
      probe.then(
        () => {
          if (outstandingHostedJobProbes.get(record.runId) === probe) outstandingHostedJobProbes.delete(record.runId);
        },
        () => {
          if (outstandingHostedJobProbes.get(record.runId) === probe) outstandingHostedJobProbes.delete(record.runId);
        },
      );
      const outcome = await raceDeadline(probe, controller.signal);
      if (outcome === DEADLINE_EXCEEDED) {
        if (timedOut) onError({ runId: record.runId, operation });
        return null;
      }
      return typeof outcome === 'boolean' ? outcome : null;
    } catch {
      if (!controller.signal.aborted || timedOut) onError({ runId: record.runId, operation });
      return null;
    } finally {
      clearTimeoutFn(timeout);
      recoveryProbeControllers.delete(controller);
    }
  }

  function makeRunId() {
    const token = random();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
      throw new TypeError('Managed run ID source must return an unguessable base64url token.');
    }
    return `run_${token}`;
  }

  function abortJob(runId) {
    controllers.get(runId)?.abort();
    if (cancelledJobs.has(runId)) return;
    const cancel = jobs.get(runId);
    if (!cancel) return;
    cancelledJobs.add(runId);
    try {
      cancel();
    } catch {
      cancelledJobs.delete(runId);
      onError({ runId, operation: 'cancel its hosted job' });
    }
  }

  async function reportPartial(runId, steps, fence = null) {
    return store.update(runId, (current) => {
      if (!ownsDispatch(current, fence) || !ACTIVE_STATES.has(current.state)) return current;
      return { ...current, steps: safeSteps(steps) };
    });
  }

  function ownsDispatch(current, fence) {
    if (!fence) return true;
    if (current.dispatcherId !== fence.dispatcherId || current.dispatchGeneration !== fence.dispatchGeneration) return false;
    return fence.launchToken === null || current.launchToken === fence.launchToken;
  }

  async function finish(runId, result, { aborted, timedOut, fence = null }) {
    return store.update(runId, (current) => {
      if (!ownsDispatch(current, fence)) return current;
      if (TERMINAL_STATES.has(current.state)) return current;
      const state = timedOut ? 'inconclusive' : aborted ? 'cancelled' : terminalState(result);
      return { ...current, state, finishedAt: now(), steps: safeSteps(result?.steps ?? current.steps) };
    });
  }

  async function releaseCapacity(runId, fence = null) {
    return store.update(runId, (current) => {
      if (!ownsDispatch(current, fence) || current.capacityReserved === false) return current;
      return { ...current, capacityReserved: false };
    });
  }

  async function releaseRecoveredCapacity(runId) {
    try {
      await store.update(runId, (current) => {
        if (!TERMINAL_STATES.has(current.state) || current.capacityReserved === false) return current;
        return { ...current, capacityReserved: false, workerLease: null, workerLeaseExpiresAt: null };
      });
    } catch {
      onError({ runId, operation: 'release its recovered capacity reservation' });
    }
  }

  async function abandonUnlaunchedDispatch(runId, launchToken = null) {
    try {
      await store.update(runId, (current) => {
        if (current.dispatcherId !== dispatcherId) return current;
        if (launchToken !== null && current.launchToken !== launchToken) return current;
        if (current.workerLease) return current;
        const abandoned = {
          ...current,
          dispatchLeaseExpiresAt: now(),
          launchCommittedAt: null,
          launchInvocationCommittedAt: null,
          launchToken: null,
        };
        return TERMINAL_STATES.has(current.state) && current.capacityReserved !== false
          ? { ...abandoned, capacityReserved: false }
          : abandoned;
      });
    } catch {
      onError({ runId, operation: 'reconcile its unlaunched dispatch commitment' });
    }
  }

  async function launch(record, { recoveryFence = null } = {}) {
    if (!recoveryIsCurrent(recoveryFence)) return;
    // This orchestrator already has a live controller/job tracked locally
    // for this exact run — whether it is the SAME `launch()` call that
    // originally dispatched it, or an earlier call whose cleanup has not
    // yet run — so a second, concurrent `launch()` attempt here would
    // always be wrong regardless of what the store's lease state says: two
    // AbortControllers guarding the same run in this process would each
    // independently believe they alone own its cancellation and timeout
    // handling. A plain early return, outside any try/finally, so it never
    // touches the EXISTING entry's controller or job callback. `recover()`
    // additionally checks this itself before ever calling `launch()`, so a
    // genuinely still-tracked run is correctly reported as zero redispatch
    // attempts rather than an attempt that merely no-ops here.
    if (controllers.has(record.runId)) return;
    const controller = new AbortController();
    controllers.set(record.runId, controller);
    let timer;
    let dispatchHeartbeat;
    let timedOut = false;
    let launcherInvoked = false;
    let executionTracked = false;
    let executionSettled = false;
    let cleanupWhenSettled = false;
    let cleaned = false;
    let dispatchFence = null;
    const stopDispatchHeartbeat = () => {
      if (dispatchHeartbeat) {
        clearIntervalFn(dispatchHeartbeat);
        dispatchHeartbeat = null;
      }
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (timer) clearTimeoutFn(timer);
      stopDispatchHeartbeat();
      controllers.delete(record.runId);
      jobs.delete(record.runId);
      cancelledJobs.delete(record.runId);
    };
    try {
      // `claimDispatch` atomically requires the run to still be active, no
      // WORKER to hold an unexpired lease, and no OTHER dispatcher to hold
      // an unexpired lease — all evaluated against the current record, not
      // a snapshot `recover()` may have taken earlier. A worker (or another
      // dispatcher) that has already claimed this run by the time this call
      // runs always wins; this call then simply returns without launching a
      // duplicate job on top of it.
      const dispatchClaim = await store.claimDispatch(record.runId, dispatcherId, dispatchLeaseMs);
      if (!recoveryIsCurrent(recoveryFence)) {
        if (dispatchClaim.outcome === 'claimed') await abandonUnlaunchedDispatch(record.runId);
        return;
      }
      if (dispatchClaim.outcome === 'not-runnable') {
        // The run reached a terminal state before this dispatcher could
        // claim it (for example, cancelled while a redispatch was in
        // flight, or settled through some other path entirely). Whether
        // releasing its capacity reservation here is safe depends on
        // whether any process's `launch()` ever actually started external
        // work for it:
        //
        //  - If it never reached `startedAt`, or its durable
        //    `launchInvocationCommittedAt` is explicitly null, no process
        //    committed to invoke `jobLauncher.launch` for this generation.
        //    No external work can still be running, so releasing is safe.
        //  - If the invocation commitment IS set, some process may have
        //    started a platform job for it. That job may be a different,
        //    still-live dispatcher's job, or this run may have been
        //    cancelled while its job keeps running out from under it (see
        //    `raceAbortSignal` in deadline.mjs: cancellation makes a
        //    process's own `launch()` return promptly without proving its
        //    underlying job ever stopped). This call has no visibility into
        //    whether that job has actually stopped, so releasing must NOT
        //    be unconditional here. Only an explicit, successful
        //    `jobLauncher.isActive` check proving the platform job is no
        //    longer active makes releasing safe; a launcher with no such
        //    check, or one whose check itself fails, must fail closed and
        //    preserve the reservation for a later recovery pass rather than
        //    risk under-counting concurrency against still-active external
        //    work. This is a release decision only — it never calls
        //    `jobLauncher.launch` here, since redispatch already stopped the
        //    moment `claimDispatch` returned `not-runnable`.
        if (!dispatchClaim.record.startedAt || dispatchClaim.record.launchInvocationCommittedAt === null) {
          await releaseCapacity(record.runId);
          return;
        }
        if (typeof jobLauncher.isActive === 'function') {
          const stillActive = await probeHostedJobActive(
            dispatchClaim.record,
            'verify whether its hosted job is still active before releasing stale capacity',
          );
          if (!recoveryIsCurrent(recoveryFence)) return;
          if (stillActive === false) await releaseRecoveredCapacity(record.runId);
        }
        return;
      }
      if (dispatchClaim.outcome !== 'claimed') return;
      dispatchFence = {
        dispatcherId,
        dispatchGeneration: dispatchClaim.record.dispatchGeneration,
        launchToken: null,
      };

      // A one-shot dispatch lease only proves ownership at the instant it
      // was acquired. `dispatchLeaseMs` is deliberately far shorter than
      // `runTimeoutMs`, so without a renewing heartbeat here, an ordinary
      // run that is simply still executing would look abandoned to any
      // OTHER orchestrator sharing this store — and its `recover()` would
      // redispatch a second, duplicate job onto still-active external work.
      // This heartbeat renews ownership on a fixed cadence for as long as
      // the run stays active and no worker has separately claimed it (once
      // one has, via `createManagedRunWorker`, that worker's own lease is
      // the thing recovery must respect instead — see `listRecoverable`).
      // If a renewal ever finds this run still active but reassigned to a
      // DIFFERENT dispatcher (this heartbeat must itself have missed enough
      // renewals for the lease to have already lapsed), it stops this job
      // immediately rather than let two dispatchers' executions race to a
      // finish neither can safely undo.
      dispatchHeartbeat = setIntervalFn(() => {
        void store
          .update(record.runId, (current) => {
            if (!ACTIVE_STATES.has(current.state) || current.workerLease || current.dispatcherId !== dispatcherId) return current;
            return { ...current, dispatchLeaseExpiresAt: now() + dispatchLeaseMs };
          })
          .then((latest) => {
            if (!latest || !ACTIVE_STATES.has(latest.state) || latest.workerLease) {
              stopDispatchHeartbeat();
              if (latest?.state === 'cancelled') abortJob(record.runId);
              return;
            }
            if (latest.dispatcherId !== dispatcherId) {
              stopDispatchHeartbeat();
              abortJob(record.runId);
            }
          })
          .catch(() => onError({ runId: record.runId, operation: 'renew its dispatch lease' }));
      }, dispatchHeartbeatMs);

      const started = await store.update(record.runId, (current) =>
        TERMINAL_STATES.has(current.state) ? current : { ...current, state: 'running', startedAt: now() },
      );
      if (!recoveryIsCurrent(recoveryFence)) {
        await abandonUnlaunchedDispatch(record.runId);
        return;
      }
      if (TERMINAL_STATES.has(started.state)) {
        // Cancellation can win while the asynchronous store writes the
        // pending->running transition. No platform job has launched in that
        // case, so its reserved slot must be released here.
        stopDispatchHeartbeat();
        await releaseCapacity(record.runId);
        return;
      }

      // The running write is not launch permission: its response can be stale
      // by the time it reaches this process. `claimLaunch` prepares this
      // generation's token; the following atomic update is the final ordering
      // point against cancellation.
      const launchToken = randomBytes(24).toString('hex');
      const launchClaim = await store.claimLaunch(record.runId, dispatcherId, launchToken);
      if (!recoveryIsCurrent(recoveryFence)) {
        if (launchClaim.outcome === 'claimed') await abandonUnlaunchedDispatch(record.runId, launchToken);
        return;
      }
      if (launchClaim.outcome !== 'claimed') {
        stopDispatchHeartbeat();
        if (
          launchClaim.record &&
          TERMINAL_STATES.has(launchClaim.record.state) &&
          launchClaim.record.capacityReserved !== false &&
          launchClaim.record.dispatcherId === dispatcherId
        ) {
          await releaseCapacity(record.runId);
        }
        return;
      }
      dispatchFence = { ...dispatchFence, launchToken };

      // This is the last asynchronous boundary before the synchronous launcher
      // call. The store update atomically orders cancellation against the
      // launch invocation commitment: cancellation that wins first prevents
      // the commitment; cancellation that wins afterward preserves capacity
      // because this dispatcher must now invoke the launcher exactly once.
      const invocationCommittedAt = now();
      const beforeLaunch = await store.update(record.runId, (current) => {
        if (
          !ACTIVE_STATES.has(current.state) ||
          current.dispatcherId !== dispatcherId ||
          current.launchToken !== launchToken ||
          current.launchInvocationCommittedAt !== null ||
          !Number.isFinite(current.dispatchLeaseExpiresAt) ||
          current.dispatchLeaseExpiresAt <= now()
        ) {
          return current;
        }
        return { ...current, launchInvocationCommittedAt: invocationCommittedAt };
      });
      const invocationCommitted =
        beforeLaunch &&
        beforeLaunch.dispatcherId === dispatcherId &&
        beforeLaunch.launchToken === launchToken &&
        beforeLaunch.launchInvocationCommittedAt === invocationCommittedAt;
      if (!invocationCommitted || controller.signal.aborted || !recoveryIsCurrent(recoveryFence)) {
        stopDispatchHeartbeat();
        await abandonUnlaunchedDispatch(record.runId, launchToken);
        return;
      }

      timer = setTimeoutFn(() => {
        timedOut = true;
        abortJob(record.runId);
      }, bounds.runTimeoutMs);
      launcherInvoked = true;
      const launched = jobLauncher.launch({
        run: publicRecord(beforeLaunch),
        work: copy(beforeLaunch.work),
        signal: controller.signal,
        reportPartial: (steps) => reportPartial(record.runId, steps, dispatchFence),
        fence: Object.freeze({
          token: launchToken,
          generation: beforeLaunch.dispatchGeneration,
          expiresAt: beforeLaunch.dispatchLeaseExpiresAt,
        }),
      });
      const isJobHandle = launched && typeof launched === 'object' && 'result' in launched;
      if (isJobHandle && typeof launched.cancel === 'function') jobs.set(record.runId, launched.cancel);
      if (controller.signal.aborted) abortJob(record.runId);
      const execution = isJobHandle ? launched.result : launched;
      executionTracked = true;
      // A timeout bounds the public run state, but it does not prove an
      // uncooperative platform job stopped. Keep its capacity reservation
      // until its promise actually settles so repeated timeouts cannot evade
      // either concurrency limit.
      const executionPromise = Promise.resolve(execution);
      const onExecutionSettled = () => {
        executionSettled = true;
        void releaseCapacity(record.runId, dispatchFence).catch(() =>
          onError({ runId: record.runId, operation: 'release its capacity reservation' }),
        );
        if (cleanupWhenSettled) cleanup();
      };
      executionPromise.then(onExecutionSettled, onExecutionSettled);
      const afterLaunch = await store.get(record.runId);
      if (!afterLaunch || afterLaunch.state === 'cancelled' || afterLaunch.dispatcherId !== dispatcherId) abortJob(record.runId);
      const result = await raceAbortSignal(
        executionPromise,
        controller.signal,
        'The managed run exceeded its time budget or was cancelled.',
      );
      await finish(record.runId, result, { aborted: controller.signal.aborted, timedOut, fence: dispatchFence });
      await releaseCapacity(record.runId, dispatchFence);
    } catch {
      // Before this process has a returned ownership fence, it cannot safely
      // mutate the record: the claim may have committed and then been replaced
      // while its response failed. Leave state and capacity untouched for
      // recovery rather than risk overwriting that replacement.
      if (!dispatchFence) {
        onError({ runId: record.runId, operation: 'establish durable dispatch ownership' });
        return;
      }
      // Once ownership is known, a start or store failure is terminal for only
      // this exact dispatch generation. A launched job retains capacity until
      // it settles; an unlaunched one can release its own fenced reservation.
      if (launcherInvoked) {
        abortJob(record.runId);
        stopDispatchHeartbeat();
        cleanupWhenSettled = executionTracked && !executionSettled;
      }
      await finish(record.runId, null, { aborted: controller.signal.aborted, timedOut, fence: dispatchFence }).catch(() =>
        onError({ runId: record.runId, operation: 'record its terminal state' }),
      );
      if (!launcherInvoked) {
        await releaseCapacity(record.runId, dispatchFence).catch(() =>
          onError({ runId: record.runId, operation: 'release its capacity reservation' }),
        );
      }
    } finally {
      if (!cleanupWhenSettled) cleanup();
    }
  }

  async function recoverPass(recoveryFence) {
    if (typeof store.listRecoverable !== 'function') {
      throw new TypeError('Managed run recovery requires a store with listRecoverable.');
    }
    const recoverable = await store.listRecoverable();
    if (!recoveryIsCurrent(recoveryFence)) return { relaunched: 0, nextLeaseExpiry: null };
    let relaunched = 0;
    let nextLeaseExpiry = null;
    for (const record of recoverable) {
      if (!recoveryIsCurrent(recoveryFence)) break;
      // This orchestrator itself may still hold a live controller/job for
      // this run even though its dispatch lease lapsed in the store (for
      // example, its own renewing heartbeat missed enough ticks under a
      // starved event loop, or the run's own launch() call has not yet
      // reached its `finally` cleanup). Recovering a run this SAME
      // process is already tracking would always be wrong; skip it before
      // ever consulting jobLauncher.isActive or attempting a dispatch
      // claim, and before incrementing `relaunched`, so this case is
      // correctly reported as zero redispatch attempts rather than an
      // attempted-but-no-op redispatch.
      if (controllers.has(record.runId)) continue;
      if (TERMINAL_STATES.has(record.state)) {
        if (record.capacityReserved === false) continue;
        if (!record.startedAt) {
          await releaseRecoveredCapacity(record.runId);
          continue;
        }
        if (record.launchInvocationCommittedAt === null) {
          await releaseRecoveredCapacity(record.runId);
          continue;
        }
        // Once launch invocation commits, its owning dispatcher may still be
        // between durable permission and the synchronous platform launch call.
        // Preserve capacity until that renewable ownership lease expires. The
        // single scheduler wakes at the nearest such expiry.
        if (
          record.launchCommittedAt &&
          Number.isFinite(record.dispatchLeaseExpiresAt) &&
          record.dispatchLeaseExpiresAt > now()
        ) {
          nextLeaseExpiry =
            nextLeaseExpiry === null ? record.dispatchLeaseExpiresAt : Math.min(nextLeaseExpiry, record.dispatchLeaseExpiresAt);
          continue;
        }
        if (typeof jobLauncher.isActive !== 'function') continue;
        const stillActive = await probeHostedJobActive(record, 'verify whether its terminal hosted job is still active');
        if (!recoveryIsCurrent(recoveryFence)) break;
        if (stillActive === false) await releaseRecoveredCapacity(record.runId);
        continue;
      }
      // A lapsed dispatch lease usually means its owning process is
      // genuinely gone — the ordinary, safe-to-redispatch case the
      // heartbeat above cannot cover (a crash stops the heartbeat too).
      // For a hosted-job adapter, though, the platform job that dispatcher
      // started can legitimately keep running out from under it. When the
      // launcher can independently confirm the platform job is still
      // active, this defers to that rather than risk starting a second,
      // duplicate job for still-active external work; a launcher that
      // offers no such check keeps today's lease-expiry-only behavior.
      if (typeof jobLauncher.isActive === 'function') {
        const stillActive = await probeHostedJobActive(record, 'verify whether its hosted job is still active');
        if (!recoveryIsCurrent(recoveryFence)) break;
        if (stillActive !== false) continue;
      }
      if (!recoveryIsCurrent(recoveryFence)) break;
      relaunched += 1;
      void launch(record, { recoveryFence });
    }
    return { relaunched, nextLeaseExpiry };
  }

  function clearRecoveryTimer() {
    if (!recoveryTimer) return;
    clearTimeoutFn(recoveryTimer);
    recoveryTimer = null;
    recoveryTimerDueAt = null;
  }

  function scheduleRecovery(nextLeaseExpiry = null) {
    if (!recoverySchedulerStarted) return;
    const periodicDueAt = now() + recoveryIntervalMs;
    const dueAt =
      Number.isFinite(nextLeaseExpiry) && nextLeaseExpiry > now()
        ? Math.min(periodicDueAt, nextLeaseExpiry)
        : periodicDueAt;
    if (recoveryTimer && recoveryTimerDueAt <= dueAt) return;
    clearRecoveryTimer();
    recoveryTimerDueAt = dueAt;
    recoveryTimer = setTimeoutFn(() => {
      recoveryTimer = null;
      recoveryTimerDueAt = null;
      if (!recoverySchedulerStarted) return;
      void recoverCurrentGeneration().catch(() => onError({ operation: 'complete its scheduled pass' }));
    }, Math.max(1, dueAt - now()));
  }

  function recoverRuns() {
    if (recoveryPromise) return recoveryPromise;
    clearRecoveryTimer();
    const recoveryFence = recoveryGeneration;
    recoveryPromiseGeneration = recoveryFence;
    let nextLeaseExpiry = null;
    const pass = recoverPass(recoveryFence).then((result) => {
      nextLeaseExpiry = result.nextLeaseExpiry;
      return result.relaunched;
    });
    recoveryPromise = pass.finally(() => {
      recoveryPromise = null;
      recoveryPromiseGeneration = null;
      scheduleRecovery(nextLeaseExpiry);
    });
    return recoveryPromise;
  }

  function recoverCurrentGeneration() {
    if (recoveryRestartPromise && recoveryRestartGeneration === recoveryGeneration) return recoveryRestartPromise;
    if (recoveryPromise && recoveryPromiseGeneration === recoveryGeneration) return recoveryPromise;
    if (!recoveryPromise && !recoveryRestartPromise) return recoverRuns();

    const stalePass = recoveryRestartPromise ?? recoveryPromise;
    const requestedGeneration = recoveryGeneration;
    const restart = stalePass.then(
      () => (requestedGeneration === recoveryGeneration ? recoverRuns() : 0),
      () => (requestedGeneration === recoveryGeneration ? recoverRuns() : 0),
    );
    let trackedRestart;
    trackedRestart = restart.finally(() => {
      if (recoveryRestartPromise !== trackedRestart) return;
      recoveryRestartPromise = null;
      recoveryRestartGeneration = null;
    });
    recoveryRestartPromise = trackedRestart;
    recoveryRestartGeneration = requestedGeneration;
    return trackedRestart;
  }

  function startRecovery() {
    if (recoverySchedulerStarted) return recoverCurrentGeneration();
    recoverySchedulerStarted = true;
    return recoverCurrentGeneration();
  }

  function stopRecovery() {
    recoverySchedulerStarted = false;
    recoveryGeneration += 1;
    clearRecoveryTimer();
    for (const controller of recoveryProbeControllers) controller.abort();
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
    async create({ owner, tenant, sampleId, requestDigest, idempotencyKey, work, nonce, acknowledgementExpiresAt }) {
      if (!validClaim(owner) || !validClaim(tenant) || !validIdentifier(sampleId) || !/^[a-f0-9]{64}$/.test(requestDigest)) {
        throw new TypeError('Managed run identity, sample, and request digest must be validated server-side values.');
      }
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
        throw new TypeError('An Idempotency-Key header of 1 to 128 visible ASCII characters is required.');
      }
      if (!work || typeof work !== 'object' || Array.isArray(work)) {
        throw new TypeError('Managed run creation requires a validated non-secret work descriptor.');
      }
      if (typeof nonce !== 'string' || nonce.length === 0) {
        // Defensive only: callers are expected to have already run this
        // request's acknowledgement through `verifyAcknowledgement`, which
        // guarantees a non-empty nonce string before `create` is ever
        // reached.
        throw new TypeError('Managed run creation requires the request acknowledgement nonce.');
      }
      if (typeof acknowledgementExpiresAt !== 'number' || !Number.isFinite(acknowledgementExpiresAt) || acknowledgementExpiresAt <= now()) {
        // Defensive only: callers are expected to have already run this
        // request's acknowledgement through `verifyAcknowledgement`, which
        // guarantees a finite, still-future `expiresAt` before `create` is
        // ever reached. The store's nonce retention is keyed off exactly
        // this value (see `claim`'s `nonceExpiresAt` above), so a caller
        // that cannot supply it must not be allowed to silently fall back
        // to some other, unverified window.
        throw new TypeError('Managed run creation requires the request acknowledgement\'s validated expiry.');
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
        launchInvocationCommittedAt: null,
        createdAt: now(),
        steps: [],
      };
      const claimed = await store.claim(record, bounds, { nonce, nonceExpiresAt: acknowledgementExpiresAt });
      if (claimed.outcome === 'existing') return { outcome: 'existing', run: publicRecord(claimed.record) };
      if (claimed.outcome === 'conflict') return { outcome: 'conflict' };
      if (claimed.outcome === 'nonce-replayed') return { outcome: 'nonce-replayed' };
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
    recover: recoverCurrentGeneration,
    startRecovery,
    stopRecovery,
  });
}
