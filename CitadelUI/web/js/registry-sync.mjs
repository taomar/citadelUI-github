import { WorkspaceRegistry } from './registry.mjs';
import { localRequest } from './local-api.mjs';

export function createRegistrySync({ registry, request }) {
  let registryAuthority = null;

  async function syncRegistryMetadata(removals = {}, scope = null) {
    if (!registryAuthority) throw new Error('Registry metadata has not been reconciled.');
    const snapshot = await registry.metadataSnapshot();
    const removedProjectIds = removals.removedProjectIds || [];
    const removedEnvironmentIds = removals.removedEnvironmentIds || [];
    // The server removes before upserting. A restored local tombstone must not
    // contradict its own removal by appearing in the same request's upserts.
    const removedProjects = new Set(removedProjectIds);
    const removedEnvironments = new Set(removedEnvironmentIds);
    const projects = snapshot.projects.filter((item) =>
      !removedProjects.has(item.id) && (!scope || scope.projectIds.includes(item.id)));
    const environments = snapshot.environments.filter(
      (item) => !removedEnvironments.has(item.id) && !removedProjects.has(item.projectId) &&
        (!scope || scope.environmentIds.includes(item.id))
    );
    const remote = await request('/api/registry', {
      method: 'PUT',
      body: JSON.stringify({
        expectedEpoch: registryAuthority.epoch,
        expectedRevision: registryAuthority.revision,
        projects,
        environments,
        removedProjectIds,
        removedEnvironmentIds,
      }),
    });
    registryAuthority = { epoch: remote.epoch, revision: remote.revision };
    return remote;
  }

  // Learning authority must not restore records an unconfirmed rollback removed.
  async function establishRegistryAuthority(send = request) {
    const remote = await send('/api/registry');
    registryAuthority = { epoch: remote.epoch, revision: remote.revision };
    return remote;
  }

  async function reconcileRegistryMetadata(targetRegistry = registry, send = request) {
    const remote = await send('/api/registry');
    await targetRegistry.replaceMetadata(remote);
    registryAuthority = { epoch: remote.epoch, revision: remote.revision };
    return remote;
  }

  async function resolvePendingRemovals(options = {}) {
    const targetRegistry = options.registry || registry;
    const mirror = options.mirror || syncRegistryMetadata;
    const establish = options.establishAuthority || establishRegistryAuthority;
    const stored = targetRegistry.tombstones?.() || { projectIds: [], environmentIds: [] };
    const pending = {
      projectIds: [...new Set([...stored.projectIds, ...(options.pending?.projectIds || [])])],
      environmentIds: [...new Set([...stored.environmentIds, ...(options.pending?.environmentIds || [])])],
    };
    if (!pending.projectIds.length && !pending.environmentIds.length) return { resolved: true };
    try {
      if (options.removeLocal) {
        // In-dialog retries cannot mirror records whose local rollback failed.
        for (const id of pending.environmentIds) await targetRegistry.removeEnvironment(id);
        for (const id of pending.projectIds) await targetRegistry.removeProject(id);
      }
      await establish();
      await mirror({
        removedEnvironmentIds: pending.environmentIds,
        removedProjectIds: pending.projectIds,
      });
      if (options.removeLocal && targetRegistry.removeTombstones(pending) === false) {
        throw new Error('The browser could not retire the registration recovery record.');
      }
    } catch (error) {
      return { resolved: false, pending, message: error.message };
    }
    if (!options.removeLocal) targetRegistry.clearTombstones?.();
    return { resolved: true, pending };
  }

  return { establishRegistryAuthority, reconcileRegistryMetadata, syncRegistryMetadata, resolvePendingRemovals };
}

const bootstrapNamespace =
  typeof document !== 'undefined'
    ? document.querySelector('meta[name="citadel-registry-namespace"]')?.content
    : null;
const testRuntime =
  Boolean(globalThis.__CITADEL_TEST_RUNTIME__) ||
  (typeof document !== 'undefined' &&
    document.querySelector('meta[name="citadel-test-runtime"]')?.content === 'true');
const registryNamespace =
  globalThis.__CITADEL_REGISTRY_NAMESPACE__ || bootstrapNamespace || 'citadel-ui';

export const workspaceRegistry = new WorkspaceRegistry({
  dbName: registryNamespace,
  stateKey: `${registryNamespace}.active-context`,
  testMode: testRuntime,
});
export const registrySync = createRegistrySync({ registry: workspaceRegistry, request: localRequest });
