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
import { createLocalExecutor } from './localExecutor.mjs';
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
  fs,
} = {}) {
  const active = new Map();
  let sequence = 0;

  async function start(payload, { onStart } = {}) {
    if (active.size >= maxConcurrentRuns) {
      throw new RequestRefused(
        `${active.size} run(s) are already in flight and the limit is ${maxConcurrentRuns}. Wait for one to finish or cancel it.`,
        { status: 429, code: 'too-many-runs' },
      );
    }
    const request = validateRunRequest(payload, catalogue);
    const { plan, resolvedInputs } = rebuildPlan(request, catalogue, { buildSamplePlan, requirementsFor });

    sequence += 1;
    const runId = makeRunId(request.sample.id, sequence);
    const workspace = createRunWorkspace({ playgroundRoot, runId, ...(fs ? { fs } : {}) });
    await workspace.ensureRoot();

    const controller = new AbortController();
    const executor = createLocalExecutor({
      transports,
      workspace,
      limits,
      pythonExecutable,
      pythonRoot: resolve(playgroundRoot, 'runtime', 'python'),
    });

    // The access-contract fallback needs the same subscription name the
    // contract produced, which only the catalogue's own classifier knows.
    const contract = contractFor(request.sample.id, resolvedInputs);

    const promise = executor
      .execute(plan, {
        sampleId: request.sample.id,
        inputs: resolvedInputs,
        secrets: request.secrets,
        acknowledgement: request.acknowledgement,
        contract,
        signal: controller.signal,
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

    active.set(runId, { runId, sampleId: request.sample.id, controller, startedAt: Date.now(), promise });
    try {
      onStart?.({
        runId,
        sampleId: request.sample.id,
        workspace: workspace.describe(workspace.root) || '.',
      });
    } catch (error) {
      controller.abort();
      await promise;
      throw error;
    }
    const result = await promise;
    return { runId, workspace: workspace.describe(workspace.root) || '.', ...result };
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
      return active.size;
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
