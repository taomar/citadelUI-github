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
  let activeRequest = null;

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
      return activeRequest?.runId ?? null;
    },

    async cancel() {
      const fetchImplementation = doFetch();
      const request = activeRequest;
      if (!fetchImplementation || !request) return { cancelled: false };
      if (!request.runId) {
        request.controller.abort();
        return { cancelled: true, pending: true };
      }
      try {
        const response = await fetchImplementation('/api/run/cancel', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ runId: request.runId }),
        });
        return await response.json();
      } catch {
        return { cancelled: false };
      }
    },

    async execute(plan, { sampleId, inputs = {}, secrets = {}, acknowledgement = null, onProgress } = {}) {
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
      const request = { controller: new AbortController(), runId: null };
      activeRequest = request;
      let response;
      try {
        response = await fetchImplementation('/api/run', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json' },
          body: JSON.stringify(body),
          signal: request.controller.signal,
        });
      } catch (error) {
        if (activeRequest === request) activeRequest = null;
        if (request.controller.signal.aborted || error?.name === 'AbortError') {
          return cancelledExecutionResult(plan.sampleId);
        }
        return executionResult({
          state: 'failed',
          sampleId: plan.sampleId,
          summary: 'The local executor could not be reached.',
          detail: String(error?.message ?? error),
          meta: { executor: 'local' },
        });
      }
      try {
        request.runId = responseHeader(response, 'X-Citadel-Run-Id');
        let payload = null;
        try {
          payload = responseHeader(response, 'Content-Type')?.includes('application/x-ndjson')
            ? await readNdjsonResponse(response, onProgress)
            : await response.json();
        } catch {
          payload = null;
        }
        if (request.controller.signal.aborted) return cancelledExecutionResult(plan.sampleId);
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
            runId: payload.runId ?? request.runId,
            workspace: payload.workspace ?? payload.meta?.workspace ?? '',
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
        if (activeRequest === request) activeRequest = null;
      }
    },
  });
}

function cancelledExecutionResult(sampleId) {
  return executionResult({
    state: 'cancelled',
    sampleId,
    summary: 'Run cancelled before the executor started.',
    meta: { executor: 'local' },
  });
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === 'function') return response.headers.get(name);
  const match = Object.entries(response?.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : null;
}

async function readNdjsonResponse(response, onProgress) {
  let finalResult = null;
  let runId = null;
  let workspace = '';
  const consume = (line, { partial = false } = {}) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      onProgress?.({ type: 'stream-warning', code: partial ? 'partial-ndjson' : 'malformed-ndjson' });
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      onProgress?.({ type: 'stream-warning', code: 'malformed-ndjson' });
      return;
    }
    if (event.type === 'result') {
      finalResult = event.result ?? null;
      return;
    }
    if (event.type === 'run-start') {
      runId = typeof event.runId === 'string' ? event.runId : runId;
      workspace = typeof event.workspace === 'string' ? event.workspace : workspace;
    }
    onProgress?.(event);
  };
  const completedResult = () => {
    if (!finalResult || typeof finalResult !== 'object' || Array.isArray(finalResult)) return finalResult;
    return {
      ...finalResult,
      runId: finalResult.runId ?? runId,
      workspace: finalResult.workspace ?? workspace,
    };
  };

  if (!response.body?.getReader) {
    for (const line of String(await response.text()).split('\n')) consume(line);
    return completedResult();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffered, { partial: true });
  return completedResult();
}
