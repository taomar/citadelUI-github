/**
 * The local-execution client.
 *
 * The browser's whole contribution to a run is this object:
 *
 *   { protocolVersion, sampleId, inputs, secrets, acknowledgement }
 *
 * It carries no plan, no command, no URL, no header, no path and no script. The
 * server rebuilds every one of those from its own catalogue, which is what
 * makes it safe for the executor to spawn a process at all.
 */

import { EXECUTION_PROTOCOL_VERSION } from '../../src/core/types.mjs';
import { executionResult } from '../../src/core/executor.mjs';

/**
 * @param {object} options
 * @param {string[]} options.allowedSampleIds
 * @param {Function} [options.fetchImpl]  injected by the smoke driver
 */
export function createLocalExecutorClient({ allowedSampleIds, fetchImpl, supportedStepTypes = [] } = {}) {
  const allowed = new Set(allowedSampleIds ?? []);
  const capability = Object.freeze({
    id: 'local',
    kind: 'local',
    canExecute: true,
    supportedStepTypes: Object.freeze([...supportedStepTypes]),
    reason: 'The local executor is attached. Samples run on this machine, bound to loopback.',
  });
  let activeRunId = null;

  const doFetch = () => fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

  return Object.freeze({
    id: 'local',
    describeCapability: () => capability,
    supports: (plan) => ({ supported: allowed.has(plan?.sampleId), unsupportedStepTypes: [] }),

    /** Exposed so a test can assert the exact wire shape without a network. */
    buildRequestBody({ sampleId, inputs, secrets, acknowledgement }) {
      if (!allowed.has(sampleId)) throw new Error(`Refused unknown sample "${sampleId}"`);
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sampleId,
        inputs: JSON.parse(JSON.stringify(inputs ?? {})),
        secrets: { ...(secrets ?? {}) },
        acknowledgement: acknowledgement ?? null,
      };
    },

    get activeRunId() {
      return activeRunId;
    },

    async cancel() {
      const fetchImplementation = doFetch();
      if (!fetchImplementation || !activeRunId) return { cancelled: false };
      try {
        const response = await fetchImplementation('/api/run/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ runId: activeRunId }),
        });
        return await response.json();
      } catch {
        return { cancelled: false };
      }
    },

    async execute(plan, { sampleId, inputs = {}, secrets = {}, acknowledgement = null } = {}) {
      const fetchImplementation = doFetch();
      if (!fetchImplementation) {
        return executionResult({
          state: 'blocked',
          sampleId: plan.sampleId,
          summary: 'Not run — no fetch implementation is available.',
          meta: { executor: 'local' },
        });
      }
      const body = this.buildRequestBody({ sampleId: sampleId ?? plan.sampleId, inputs, secrets, acknowledgement });
      let response;
      try {
        response = await fetchImplementation('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        return executionResult({
          state: 'failed',
          sampleId: plan.sampleId,
          summary: 'The local executor could not be reached.',
          detail: String(error?.message ?? error),
          meta: { executor: 'local' },
        });
      }
      try {
        activeRunId = responseHeader(response, 'X-Citadel-Run-Id');
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!payload) {
          return executionResult({
            state: 'inconclusive',
            sampleId: plan.sampleId,
            summary: 'The executor answered with something that is not JSON.',
            meta: { executor: 'local' },
          });
        }
        if (!response.ok) {
          return executionResult({
            state: payload.state === 'blocked' ? 'blocked' : 'failed',
            sampleId: plan.sampleId,
            summary: payload.summary ?? `The executor returned HTTP ${response.status}.`,
            detail: payload.detail ?? '',
            meta: { executor: 'local', status: response.status, code: payload.code },
          });
        }
        const result = executionResult({
          state: payload.state,
          sampleId: plan.sampleId,
          summary: payload.summary ?? 'Run complete.',
          detail: payload.detail ?? '',
          steps: payload.steps ?? [],
          assertions: payload.assertions ?? [],
          meta: {
            ...(payload.meta ?? {}),
            executor: 'local',
            runId: payload.runId ?? activeRunId,
          },
        });
        // `configurationUpdates` are public and offered to the user.
        // `secretUpdates` go straight into the in-memory secret store and are
        // never rendered, persisted, or logged.
        return Object.freeze({
          ...result,
          configurationUpdates: payload.configurationUpdates ?? {},
          secretUpdates: payload.secretUpdates ?? {},
        });
      } finally {
        activeRunId = null;
      }
    },
  });
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === 'function') return response.headers.get(name);
  const match = Object.entries(response?.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : null;
}
