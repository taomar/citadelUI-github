/**
 * The executor boundary.
 *
 * An executor is anything that can turn an ExecutionPlan into a result. The
 * default one cannot run anything, and says so precisely. It never returns a
 * success-shaped result, which is the invariant the product depends on.
 *
 * A future adapter — an allowlisted relay, an Azure management adapter, a
 * Python Agent Framework runner — implements the same three methods and the UI
 * does not change.
 *
 *   describeCapability() -> { id, kind, canExecute, supportedStepTypes, reason }
 *   supports(plan)       -> { supported: boolean, unsupportedStepTypes: string[] }
 *   execute(plan, ctx)   -> Promise<ExecutionResult>
 *   cancel()             -> Promise<{ cancelled: boolean, reason?: string }>
 */

import { EXECUTION_PROTOCOL_VERSION, EXECUTION_STATES } from './types.mjs';

/**
 * @deprecated kept for backward compatibility; equal to `EXECUTION_PROTOCOL_VERSION`,
 * the same wire version the local `/api/execute` and `/api/run` contracts use.
 */
export const RELAY_PROTOCOL_VERSION = EXECUTION_PROTOCOL_VERSION;

/** Build a typed result. `state` must be one of EXECUTION_STATES. */
export function executionResult({ state, sampleId, summary, detail = '', steps = [], assertions = [], meta = {} }) {
  if (!EXECUTION_STATES.includes(state)) {
    throw new TypeError(`Unknown execution state "${state}"`);
  }
  return Object.freeze({
    state,
    sampleId,
    summary,
    detail,
    steps: Object.freeze([...steps]),
    assertions: Object.freeze([...assertions]),
    meta: Object.freeze({ ...meta }),
  });
}

export function unsupportedStepTypes(plan, supportedStepTypes) {
  const supported = new Set(supportedStepTypes ?? []);
  return (plan?.requiredStepTypes ?? []).filter((type) => !supported.has(type));
}

function raceAbortSignal(promise, signal) {
  const pending = Promise.resolve(promise);
  pending.catch(() => {});
  if (!signal) return pending;
  if (signal.aborted) {
    const error = new Error('Aborted.');
    error.name = 'AbortError';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const error = new Error('Aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function cancelledRelayExecutionResult(sampleId, executor) {
  return Object.freeze({
    ...executionResult({
      state: 'cancelled',
      sampleId,
      summary: 'Relay run cancelled before a response was received.',
      meta: { executor },
    }),
    configurationUpdates: Object.freeze({}),
    secretUpdates: Object.freeze({}),
  });
}

/**
 * The production default. It reports honestly that no runtime is attached and
 * returns `blocked` for every plan.
 */
export function createUnavailableExecutor({
  reason = 'No execution runtime is attached to this playground. Plans are generated and previewed only.',
} = {}) {
  const capability = Object.freeze({
    id: 'unavailable',
    kind: 'unavailable',
    canExecute: false,
    supportedStepTypes: Object.freeze([]),
    reason,
  });
  return Object.freeze({
    id: 'unavailable',
    describeCapability: () => capability,
    supports: (plan) => ({
      supported: false,
      unsupportedStepTypes: [...(plan?.requiredStepTypes ?? [])],
    }),
    async execute(plan) {
      return executionResult({
        state: 'blocked',
        sampleId: plan?.sampleId ?? 'unknown',
        summary: 'Not run — no execution runtime is configured.',
        detail: `${reason} The plan above is complete and can be run by hand, or by an approved adapter that supports: ${(plan?.requiredStepTypes ?? []).join(', ') || 'no steps'}.`,
        meta: { executor: 'unavailable', requiredStepTypes: [...(plan?.requiredStepTypes ?? [])] },
      });
    },
  });
}

/**
 * The optional relay seam.
 *
 * Deliberately narrow: the client posts `{ protocolVersion, sampleId, inputs }`
 * to ONE same-origin endpoint. It cannot be handed a URL, so it can never be
 * used as a general proxy, and it does not carry secret values — the relay is
 * expected to hold its own credentials for the refs it is told about.
 *
 * @param {object} options
 * @param {string[]} options.allowedSampleIds  the catalogue's ids; anything else is refused
 * @param {string}  [options.endpoint]         same-origin path, not a URL
 * @param {Function}[options.fetchImpl]        injected for tests
 */
export function createRelayExecutor({
  allowedSampleIds,
  endpoint = '/api/execute',
  fetchImpl,
  supportedStepTypes = ['http', 'assertion'],
  id = 'relay',
} = {}) {
  if (!Array.isArray(allowedSampleIds) || allowedSampleIds.length === 0) {
    throw new TypeError('createRelayExecutor requires allowedSampleIds');
  }
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.includes('//')) {
    throw new TypeError('Relay endpoint must be a same-origin path such as /api/execute');
  }
  const allowed = new Set(allowedSampleIds);
  const capability = Object.freeze({
    id,
    kind: 'relay',
    canExecute: true,
    supportedStepTypes: Object.freeze([...supportedStepTypes]),
    reason: 'An approved relay is configured. It runs a fixed set of catalogue samples on the server side.',
  });
  let activeRequest = null;

  return Object.freeze({
    id,
    describeCapability: () => capability,
    supports(plan) {
      const missing = unsupportedStepTypes(plan, supportedStepTypes);
      return {
        supported: allowed.has(plan?.sampleId) && missing.length === 0,
        unsupportedStepTypes: missing,
      };
    },
    get activeSampleId() {
      return activeRequest?.sampleId ?? null;
    },
    async cancel() {
      const request = activeRequest;
      if (!request) return Object.freeze({ cancelled: false, reason: 'No relay run is in flight.' });
      request.controller.abort();
      return Object.freeze({ cancelled: true, sampleId: request.sampleId });
    },
    /** Exposed so tests can assert the exact wire shape without a network. */
    buildRequestBody(plan, { inputs = {}, acknowledgement } = {}) {
      if (!allowed.has(plan?.sampleId)) {
        throw new Error(`Relay refused unknown sample "${plan?.sampleId}"`);
      }
      const body = {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        sampleId: plan.sampleId,
        inputs: JSON.parse(JSON.stringify(inputs)),
        secretRefs: [...(plan.secretRefs ?? [])],
      };
      // Only present when the caller actually supplies one, so a request that
      // never carried a risk acknowledgement is not forced to invent one.
      if (acknowledgement) {
        body.acknowledgement = JSON.parse(JSON.stringify(acknowledgement));
      }
      return body;
    },
    async execute(plan, { inputs = {}, acknowledgement, signal } = {}) {
      if (activeRequest) {
        return executionResult({
          state: 'blocked',
          sampleId: plan?.sampleId ?? 'unknown',
          summary: 'Not run — another relay request is already in flight.',
          detail: 'Wait for the active relay request to finish or cancel it before starting another.',
          meta: { executor: id, reason: 'relay-single-flight', activeSampleId: activeRequest.sampleId },
        });
      }
      const body = this.buildRequestBody(plan, { inputs, acknowledgement });
      const missing = unsupportedStepTypes(plan, supportedStepTypes);
      if (missing.length > 0) {
        return executionResult({
          state: 'blocked',
          sampleId: plan.sampleId,
          summary: 'Not run — the configured relay does not support every step in this plan.',
          detail: `Unsupported step types: ${missing.join(', ')}.`,
          meta: { executor: id, unsupportedStepTypes: missing },
        });
      }
      const doFetch = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
      if (!doFetch) {
        return executionResult({
          state: 'blocked',
          sampleId: plan.sampleId,
          summary: 'Not run — no fetch implementation is available.',
          meta: { executor: id },
        });
      }
      const request = {
        controller: new AbortController(),
        sampleId: plan.sampleId,
      };
      const abortFromCaller = () => request.controller.abort();
      signal?.addEventListener('abort', abortFromCaller, { once: true });
      if (signal?.aborted) request.controller.abort();
      activeRequest = request;
      try {
        let response;
        try {
          response = await raceAbortSignal(
            doFetch(endpoint, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify(body),
              signal: request.controller.signal,
            }),
            request.controller.signal,
          );
        } catch (error) {
          if (request.controller.signal.aborted || error?.name === 'AbortError') {
            return cancelledRelayExecutionResult(plan.sampleId, id);
          }
          return executionResult({
            state: 'failed',
            sampleId: plan.sampleId,
            summary: 'Relay call failed before a response was received.',
            meta: { executor: id },
          });
        }
        let payload = null;
        try {
          payload = await raceAbortSignal(response.json(), request.controller.signal);
        } catch (error) {
          if (request.controller.signal.aborted || error?.name === 'AbortError') {
            return cancelledRelayExecutionResult(plan.sampleId, id);
          }
          payload = null;
        }
        if (!response.ok) {
          const payloadState = EXECUTION_STATES.includes(payload?.state) ? payload.state : null;
          return executionResult({
            state: response.status === 501 || payloadState === 'blocked' ? 'blocked' : 'failed',
            sampleId: plan.sampleId,
            summary:
              payload?.summary ??
              (response.status === 501
                ? 'Not run — the local server has no relay configured.'
                : `Relay returned HTTP ${response.status}.`),
            detail: payload?.detail ?? payload?.message ?? '',
            meta: { executor: id, status: response.status, code: payload?.code },
          });
        }
        if (!payload || !EXECUTION_STATES.includes(payload.state)) {
          return executionResult({
            state: 'inconclusive',
            sampleId: plan.sampleId,
            summary: 'The relay answered, but not with a recognised result state.',
            detail: 'Treating an unrecognised relay response as inconclusive rather than as a pass.',
            meta: { executor: id },
          });
        }
        const result = executionResult({
          state: payload.state,
          sampleId: plan.sampleId,
          summary: payload.summary ?? 'Relay result.',
          detail: payload.detail ?? '',
          steps: payload.steps ?? [],
          assertions: payload.assertions ?? [],
          meta: { ...(payload.meta ?? {}), executor: id },
        });
        // `configurationUpdates` are public and offered to the user;
        // `secretUpdates` go straight into the in-memory secret store — same
        // contract as the local executor (`web/js/localClient.mjs`).
        return Object.freeze({
          ...result,
          configurationUpdates: payload.configurationUpdates ?? {},
          secretUpdates: payload.secretUpdates ?? {},
        });
      } finally {
        signal?.removeEventListener('abort', abortFromCaller);
        if (activeRequest === request) activeRequest = null;
      }
    },
  });
}

/**
 * Guarded entry point used by the UI. It refuses to reach an executor when the
 * recipe is invalid or its risk has not been acknowledged for this run.
 *
 * Everything after the two guards is passed straight through, including the
 * catalogue-shaped `inputs`, the transient `secrets`, and the acknowledgement
 * payload the server independently re-checks.
 */
export async function runPlan(executor, plan, context = {}) {
  const { validation, acknowledgement } = context;
  if (validation && validation.satisfied === false) {
    return executionResult({
      state: 'blocked',
      sampleId: plan.sampleId,
      summary: 'Not run — required inputs are missing or invalid.',
      detail: (validation.issues ?? []).map((issue) => issue.message).join(' '),
      meta: { reason: 'validation' },
    });
  }
  if (acknowledgement && acknowledgement.required && !acknowledgement.satisfied) {
    return executionResult({
      state: 'blocked',
      sampleId: plan.sampleId,
      summary: 'Not run — this recipe needs an explicit acknowledgement first.',
      detail: (acknowledgement.issues ?? []).map((issue) => issue.message).join(' '),
      meta: { reason: 'acknowledgement' },
    });
  }
  return executor.execute(plan, {
    sampleId: context.sampleId ?? plan.sampleId,
    inputs: context.inputs ?? {},
    secrets: context.secrets ?? {},
    acknowledgement: context.acknowledgementPayload ?? null,
    reviewedIdentity: context.reviewedIdentity ?? null,
    signal: context.signal,
    onProgress: context.onProgress,
  });
}
