/**
 * The run manager.
 *
 * Owns the small amount of mutable state real execution needs: which runs are
 * in flight, how many may be, and how one is cancelled. It holds no credential
 * beyond the life of the run that supplied it, and it writes nothing to disk
 * except through the run workspace.
 */

import { resolve } from 'node:path';

import { CATALOGUE, buildSamplePlan, requirementsFor } from '../catalogue/index.mjs';
import { classifyContract } from '../catalogue/samples/publish.mjs';
import { configuredSubscriptionForSample } from '../core/executionContext.mjs';
import { createLocalExecutor } from './localExecutor.mjs';
import { createExecutionContextManager } from './executionContextManager.mjs';
import { RequestRefused, rebuildPlan, validateRunRequest } from './runRequest.mjs';
import { createRunWorkspace, makeRunId } from './workspace.mjs';
import { realTransports } from './transports.mjs';

export const DEFAULT_MAX_CONCURRENT_RUNS = 2;

/**
 * @param {object} options
 * @param {string} options.playgroundRoot   absolute path to `playground/`
 * @param {object} [options.transports]     injected for tests
 * @param {string} [options.pythonExecutable]
 */
export function createRunManager({
  playgroundRoot,
  transports = realTransports(),
  pythonExecutable = process.env.CITADEL_PLAYGROUND_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS,
  limits = {},
  catalogue = CATALOGUE,
  executionContextManager = null,
  fs,
} = {}) {
  const active = new Map();
  let reservations = 0;
  let sequence = 0;
  const identity =
    executionContextManager ??
    createExecutionContextManager({
      playgroundRoot,
      mode: 'execute',
      relay: Object.freeze({ enabled: false }),
      transports,
    });

  async function start(payload, { onStart, onProgress, signal } = {}) {
    throwIfStartAborted(signal);
    const inFlight = active.size + reservations;
    if (inFlight >= maxConcurrentRuns) {
      throw new RequestRefused(
        `${inFlight} run(s) are already in flight and the limit is ${maxConcurrentRuns}. Wait for one to finish or cancel it.`,
        { status: 429, code: 'too-many-runs' },
      );
    }
    reservations += 1;
    let request;
    let plan;
    let resolvedInputs;
    let executionContext;
    let runId;
    let workspace;
    let controller;
    let executor;
    let contract;
    let activeRun;
    let abortExecution;
    try {
      request = validateRunRequest(payload, catalogue);
      ({ plan, resolvedInputs } = rebuildPlan(request, catalogue, { buildSamplePlan, requirementsFor }));
      executionContext = await identity.forRun(
        {
          sampleId: request.sample.id,
          configuredSubscriptionId: configuredSubscriptionForSample(request.sample.id, resolvedInputs),
          gateway:
            sampleUsesGatewayKey(request.sample) && resolvedInputs['gatewayAccess.subscriptionKeyHeader']
              ? {
                  keyPresent: typeof request.secrets['gatewayAccess.apiKey'] === 'string',
                  headerName: resolvedInputs['gatewayAccess.subscriptionKeyHeader'],
                }
              : null,
        },
        { signal },
      );
      throwIfStartAborted(signal);

      sequence += 1;
      runId = makeRunId(request.sample.id, sequence);
      workspace = createRunWorkspace({ playgroundRoot, runId, ...(fs ? { fs } : {}) });
      await workspace.ensureRoot();
      throwIfStartAborted(signal);

      controller = new AbortController();
      executor = createLocalExecutor({
        transports,
        workspace,
        limits,
        pythonExecutable,
        pythonRoot: resolve(playgroundRoot, 'runtime', 'python'),
      });

      // The access-contract fallback needs the same subscription name the
      // contract produced, which only the catalogue's own classifier knows.
      contract = contractFor(request.sample.id, resolvedInputs);

      activeRun = { runId, sampleId: request.sample.id, controller, startedAt: Date.now(), promise: null };
      active.set(runId, activeRun);
      abortExecution = () => controller.abort();
      signal?.addEventListener('abort', abortExecution, { once: true });
    } finally {
      reservations -= 1;
    }
    try {
      onStart?.({
        runId,
        sampleId: request.sample.id,
        workspace: workspace.describe(workspace.root) || '.',
        executionContext,
      });
    } catch (error) {
      active.delete(runId);
      signal?.removeEventListener('abort', abortExecution);
      controller.abort();
      throw error;
    }
    const promise = executor
      .execute(plan, {
        sampleId: request.sample.id,
        inputs: resolvedInputs,
        secrets: request.secrets,
        acknowledgement: request.acknowledgement,
        contract,
        signal: controller.signal,
        onProgress,
      })
      .catch((error) => ({
        state: 'failed',
        sampleId: request.sample.id,
        summary: 'The run stopped before it could report a result.',
        detail: String(error?.message ?? error),
        steps: [],
        assertions: [],
        configurationUpdates: {},
        secretUpdates: {},
        meta: { executor: 'local' },
      }))
      .finally(() => {
        active.delete(runId);
        signal?.removeEventListener('abort', abortExecution);
      });
    activeRun.promise = promise;
    const result = await promise;
    return { runId, workspace: workspace.describe(workspace.root) || '.', executionContext, ...result };
  }

  function sampleUsesGatewayKey(sample) {
    return sample.configurationEntries.some((entry) => entry.path === 'gatewayAccess.apiKey');
  }

  function throwIfStartAborted(signal) {
    if (!signal?.aborted) return;
    throw new RequestRefused('The run request was cancelled before execution started.', {
      status: 409,
      code: 'run-cancelled',
    });
  }

  function cancel(runId) {
    const run = active.get(runId);
    if (!run) return { cancelled: false, reason: 'That run is not in flight.' };
    run.controller.abort();
    return { cancelled: true, runId, sampleId: run.sampleId };
  }

  function cancelAll() {
    for (const run of active.values()) run.controller.abort();
  }

  return {
    start,
    cancel,
    cancelAll,
    get activeCount() {
      return active.size + reservations;
    },
    listActive() {
      return [...active.values()].map((run) => ({ runId: run.runId, sampleId: run.sampleId, startedAt: run.startedAt }));
    },
  };
}

/** Only the access-contract fallback needs the derived contract identity. */
function contractFor(sampleId, inputs) {
  if (sampleId !== 'access-contract-deploy') return null;
  try {
    const ctx = {
      get: (path) => inputs[path],
      fromSample: (sample, name) => inputs[`samples.${sample}.${name}`],
    };
    const assets = [
      { assetType: 'mcp-from-api', name: inputs['samples.publish-assets.weatherToolName'] },
      { assetType: 'mcp-existing', name: inputs['samples.publish-assets.learnToolName'] },
      ...(inputs['foundry.enableA2aAsset'] ? [{ assetType: 'a2a', name: inputs['samples.publish-assets.agentAssetName'] }] : []),
    ];
    return classifyContract(ctx, assets);
  } catch {
    return null;
  }
}
