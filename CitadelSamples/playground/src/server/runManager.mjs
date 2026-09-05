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
  const reservations = new Set();
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
    const inFlight = active.size + reservations.size;
    if (inFlight >= maxConcurrentRuns) {
      throw new RequestRefused(
        `${inFlight} run(s) are already in flight and the limit is ${maxConcurrentRuns}. Wait for one to finish or cancel it.`,
        { status: 429, code: 'too-many-runs' },
      );
    }
    const controller = new AbortController();
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const reservation = { runId: null, sampleId: null, controller, workspace: null, done };
    const abortFromCaller = () => abort(controller, signal?.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    reservations.add(reservation);

    let request;
    let plan;
    let resolvedInputs;
    let executionContext;
    let runId;
    let workspace;
    let executor;
    let contract;
    let activeRun;
    let executionStarted = false;
    let releaseIdentityLease = () => {};
    let reviewedIdentityFingerprint = null;
    try {
      if (typeof identity.acquireRunLease === 'function') {
        const release = identity.acquireRunLease();
        if (typeof release !== 'function') {
          throw new Error('The execution-context run lease did not return a release function.');
        }
        releaseIdentityLease = release;
      }
      throwIfStartAborted(controller.signal);
      request = validateRunRequest(payload, catalogue);
      reservation.sampleId = request.sample.id;
      throwIfStartAborted(controller.signal);
      ({ plan, resolvedInputs } = rebuildPlan(request, catalogue, { buildSamplePlan, requirementsFor }));
      throwIfStartAborted(controller.signal);
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
          reviewedIdentity: request.reviewedIdentity,
        },
        { signal: controller.signal },
      );
      throwIfStartAborted(controller.signal);
      reviewedIdentityFingerprint = request.reviewedIdentity
        ? Object.freeze({ ...request.reviewedIdentity })
        : null;
      if (reviewedIdentityFingerprint && typeof identity.verifyRunIdentity !== 'function') {
        throw new Error('The execution-context manager did not provide a run identity verifier.');
      }

      sequence += 1;
      runId = makeRunId(request.sample.id, sequence);
      reservation.runId = runId;
      workspace = createRunWorkspace({ playgroundRoot, runId, ...(fs ? { fs } : {}) });
      reservation.workspace = workspace;
      await workspace.ensureRoot({ signal: controller.signal });
      throwIfStartAborted(controller.signal);

      executor = createLocalExecutor({
        transports,
        workspace,
        limits,
        pythonExecutable,
        pythonRoot: resolve(playgroundRoot, 'runtime', 'python'),
        verifyAzureIdentity: reviewedIdentityFingerprint
          ? ({ signal: verificationSignal }) =>
              identity.verifyRunIdentity(reviewedIdentityFingerprint, { signal: verificationSignal })
          : null,
      });

      // The access-contract fallback needs the same subscription name the
      // contract produced, which only the catalogue's own classifier knows.
      contract = contractFor(request.sample.id, resolvedInputs);
      throwIfStartAborted(controller.signal);

      activeRun = {
        runId,
        sampleId: request.sample.id,
        controller,
        startedAt: Date.now(),
        promise: null,
        done,
        reviewedIdentityFingerprint,
      };
      reservations.delete(reservation);
      active.set(runId, activeRun);
      onStart?.({
        runId,
        sampleId: request.sample.id,
        workspace: workspace.describe(workspace.root) || '.',
        executionContext,
      });
      executionStarted = true;
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
        });
      activeRun.promise = promise;
      const result = await promise;
      return { runId, workspace: workspace.describe(workspace.root) || '.', executionContext, ...result };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      if (activeRun) {
        active.delete(runId);
        abort(controller);
      }
      if (cancelled && !executionStarted && workspace) {
        try {
          await workspace.removeRoot();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'The run could not start and its reserved workspace could not be removed.',
          );
        }
      }
      if (cancelled) throw cancelledBeforeStart();
      throw error;
    } finally {
      releaseIdentityLease();
      reservations.delete(reservation);
      signal?.removeEventListener('abort', abortFromCaller);
      resolveDone();
    }
  }

  function sampleUsesGatewayKey(sample) {
    return sample.configurationEntries.some((entry) => entry.path === 'gatewayAccess.apiKey');
  }

  function throwIfStartAborted(signal) {
    if (!signal?.aborted) return;
    throw cancelledBeforeStart();
  }

  function cancel(runId) {
    const run = active.get(runId) ?? [...reservations].find((candidate) => candidate.runId === runId);
    if (!run) return { cancelled: false, reason: 'That run is not in flight.' };
    abort(run.controller);
    return { cancelled: true, runId, sampleId: run.sampleId };
  }

  function cancelAll() {
    const runs = [...reservations, ...active.values()];
    for (const run of runs) abort(run.controller);
    return Promise.all(runs.map((run) => run.done)).then(() => undefined);
  }

  return {
    start,
    cancel,
    cancelAll,
    get activeCount() {
      return active.size + reservations.size;
    },
    listActive() {
      return [...active.values()].map((run) => ({ runId: run.runId, sampleId: run.sampleId, startedAt: run.startedAt }));
    },
  };
}

function abort(controller, reason) {
  if (!controller.signal.aborted) controller.abort(reason);
}

function cancelledBeforeStart() {
  return new RequestRefused('The run request was cancelled before execution started.', {
    status: 409,
    code: 'run-cancelled',
  });
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
