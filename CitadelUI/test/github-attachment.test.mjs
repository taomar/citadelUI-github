/**
 * Attaching a GitHub repository as an environment.
 *
 * Attachment creates a working branch on GitHub *before* Citadel can confirm the
 * repository is compatible, so failure has to unwind two systems at once: local
 * registry records, the `/data` mirror those records reconcile from, and the
 * branch itself. These tests cover what each partial failure must leave behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { attachGitHubEnvironment, resolvePendingRemovals } from '../web/js/workspace-context.mjs';

/** Durable browser state: survives a reload, and a restart, exactly as localStorage does. */
function storageDouble(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

/** A registry double whose durable state can outlive the object, like a restart. */
function registryDouble(options = {}) {
  const projects = new Map(options.projects || []);
  const environments = new Map();
  const storage = options.storage || storageDouble();
  let active = null;
  return {
    projects,
    environments,
    storage,
    get active() {
      return active;
    },
    async createProject(label) {
      const project = { id: `project-${projects.size + 1}`, label };
      projects.set(project.id, project);
      return project;
    },
    async removeProject(id) {
      projects.delete(id);
    },
    async addGitHubEnvironment(projectId, label, source, extra = {}) {
      const environment = {
        id: extra.id || `env-${environments.size + 1}`,
        projectId,
        label,
        source,
      };
      environments.set(environment.id, environment);
      return environment;
    },
    async updateEnvironment(id, patch) {
      const environment = { ...environments.get(id), ...patch };
      environments.set(id, environment);
      return environment;
    },
    async removeEnvironment(id) {
      environments.delete(id);
    },
    getHandle: () => null,
    setActive(projectId, environmentId) {
      active = { projectId, environmentId };
    },
    // The durable records the attachment flow depends on, with the same
    // semantics as the real registry's localStorage-backed state.
    pendingAttachments() {
      const raw = storage.getItem('pending-attachment');
      return raw ? JSON.parse(raw) : [];
    },
    pendingAttachment(selection = null) {
      const entries = this.pendingAttachments();
      if (!selection) return entries[0] || null;
      return (
        entries.find(
          (entry) =>
            entry.repositoryId === selection.repositoryId &&
            entry.sourceBranch === selection.sourceBranch &&
            entry.writeMode === selection.writeMode
        ) || null
      );
    },
    savePendingAttachment(value) {
      const entries = this.pendingAttachments().filter(
        (entry) => entry.operationKey !== value.operationKey
      );
      entries.push(value);
      storage.setItem('pending-attachment', JSON.stringify(entries));
      return value;
    },
    clearPendingAttachment(operationKey = null) {
      if (!operationKey) {
        storage.removeItem('pending-attachment');
        return true;
      }
      const entries = this.pendingAttachments().filter(
        (entry) => entry.operationKey !== operationKey
      );
      if (entries.length) storage.setItem('pending-attachment', JSON.stringify(entries));
      else storage.removeItem('pending-attachment');
      return true;
    },
    tombstones() {
      const raw = storage.getItem('pending-removals');
      return raw ? JSON.parse(raw) : { projectIds: [], environmentIds: [] };
    },
    addTombstones({ projectIds = [], environmentIds = [] } = {}) {
      const current = this.tombstones();
      const merged = {
        projectIds: [...new Set([...current.projectIds, ...projectIds])],
        environmentIds: [...new Set([...current.environmentIds, ...environmentIds])],
      };
      storage.setItem('pending-removals', JSON.stringify(merged));
      return merged;
    },
    removeTombstones({ projectIds = [], environmentIds = [] } = {}) {
      const current = this.tombstones();
      const droppedProjects = new Set(projectIds);
      const droppedEnvironments = new Set(environmentIds);
      const merged = {
        projectIds: current.projectIds.filter((id) => !droppedProjects.has(id)),
        environmentIds: current.environmentIds.filter((id) => !droppedEnvironments.has(id)),
      };
      if (!merged.projectIds.length && !merged.environmentIds.length) {
        return this.clearTombstones();
      }
      storage.setItem('pending-removals', JSON.stringify(merged));
      return true;
    },
    clearTombstones() {
      storage.removeItem('pending-removals');
      return true;
    },
  };
}

/**
 * The `/data` mirror, reconstructed the way a restart would: the mirror is the
 * only durable record, so whatever it holds is what comes back.
 */
function mirrorDouble(registry) {
  const durable = { projects: new Map(), environments: new Map() };
  const calls = [];
  const mirror = async (options = {}) => {
    calls.push(options);
    if (mirror.fail) throw new Error('mirror failed');
    const removedProjects = new Set(options.removedProjectIds || []);
    const removedEnvironments = new Set(options.removedEnvironmentIds || []);
    // The real `RegistryStore.reconcile` applies removals *before* upserts, so a
    // payload naming the same id in both lists re-creates it. `syncRegistryMetadata`
    // therefore filters removed ids out of the upsert arrays, and this double has
    // to reproduce both halves or it would hide that interaction.
    for (const id of removedEnvironments) durable.environments.delete(id);
    for (const id of removedProjects) durable.projects.delete(id);
    for (const [id, project] of registry.projects) {
      if (removedProjects.has(id)) continue;
      durable.projects.set(id, { ...project });
    }
    for (const [id, environment] of registry.environments) {
      if (removedEnvironments.has(id) || removedProjects.has(environment.projectId)) continue;
      durable.environments.set(id, { ...environment });
    }
  };
  mirror.calls = calls;
  mirror.durable = durable;
  return mirror;
}

function attachment(overrides = {}) {
  return {
    operationId: 'A'.repeat(43),
    createdWorkingBranch: true,
    head: 'a'.repeat(40),
    source: {
      kind: 'github',
      repositoryId: 9001,
      fullName: 'octo/citadel',
      sourceBranch: 'main',
      workingBranch: 'citadel-ui/env-1',
    },
    ...overrides,
  };
}

const MAIN_ALIAS = 'bicep/infra/main.bicepparam';
const LLM_ALIAS = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
const CONTRACT_ROOT = 'bicep/infra/citadel-access-contracts';

/** The named parameters each primary editor is recognised by. */
const MAIN_NAMES = [
  'environmentName', 'location', 'resourceGroupName', 'apimServiceName', 'vnetName',
  'apimSku', 'apimSkuUnits', 'aiSearchInstances', 'aiFoundryInstances', 'entraTenantId',
  'entraClientId', 'aiFoundryModelsConfig', 'logicAppsSkuCapacityUnits', 'apicSku',
  'enableAPICenter', 'enableOpenAIRealtime', 'redisSkuName',
];
const LLM_NAMES = [
  'apim', 'apimManagedIdentity', 'llmBackendConfig', 'configureCircuitBreaker',
  'circuitBreakerDefaults', 'configureSessionAffinity', 'sessionAffinityDefaults', 'modelAliases',
];
const ACCESS_NAMES = [
  'apim', 'useTargetAzureKeyVault', 'keyVault', 'useCase', 'apiNameMapping',
  'services', 'productTerms', 'useTargetFoundry',
];

/** A `.bicepparam` with the given signature, padded to `count` parameters. */
function paramFile(names, count, extra = '') {
  const lines = ["using 'main.bicep'"];
  for (const name of names) lines.push(`param ${name} = 'value'`);
  for (let index = names.length; index < count; index += 1) {
    lines.push(`param filler${index} = 'value'`);
  }
  if (extra) lines.push(extra);
  return `${lines.join('\n')}\n`;
}

/**
 * A provider over a workspace Citadel either does or does not recognise.
 *
 * The compatible shape is built from the real capability signatures rather than
 * stubbed, so `assertSupportedScan` is genuinely exercised.
 */
function providerDouble(compatibility) {
  const files = new Map();
  if (compatibility === 'supported') {
    files.set(MAIN_ALIAS, paramFile(MAIN_NAMES, 50));
    files.set('bicep/infra/main.bicep', 'param environmentName string\n');
    files.set(LLM_ALIAS, paramFile(LLM_NAMES, 8));
    files.set('bicep/infra/llm-backend-onboarding/main.bicep', 'param apim object\n');
    files.set(
      `${CONTRACT_ROOT}/main.bicepparam`,
      paramFile(
        ACCESS_NAMES,
        17,
        "param policyXml = loadTextContent('policies/default-ai-product-policy.xml')"
      )
    );
    files.set(`${CONTRACT_ROOT}/main.bicep`, 'param apim object\n');
    files.set(`${CONTRACT_ROOT}/policies/default-ai-product-policy.xml`, '<policies />\n');
  } else {
    // A repository that is not a Citadel repository.
    files.set('readme.bicepparam', "using 'other.bicep'\nparam name = 'x'\n");
  }
  return {
    async entries() {
      return [...files.keys()].map((alias) => ({
        alias,
        kind: alias.endsWith('.bicepparam')
          ? 'bicepparam'
          : alias.endsWith('.bicep')
            ? 'bicep'
            : 'other',
      }));
    },
    async read(alias) {
      const text = files.get(alias);
      return { text, size: text.length, hash: 'f'.repeat(64) };
    },
    async assertWritable() {},
    reset() {},
  };
}

test('a successful attachment records the project, environment and branch', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  const abandoned = [];
  const result = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'Development',
    repositoryId: 9001,
    sourceBranch: 'main',
    registry,
    mirror,
    attach: async (request) => {
      assert.equal(request.repositoryId, 9001);
      assert.equal(request.sourceBranch, 'main');
      assert.equal(request.writeMode, 'working-branch');
      // A stable key lets a lost response be retried without a second branch.
      assert.match(request.operationKey, /^[0-9a-f-]{36}$/);
      assert.equal(request.environmentId, request.environmentId);
      return attachment();
    },
    abandon: async (request) => {
      abandoned.push(request);
      return { removed: true };
    },
    makeProvider: async () => providerDouble('supported'),
  });
  assert.equal(result.environment.source.repositoryId, 9001);
  assert.equal(result.environment.source.workingBranch, 'citadel-ui/env-1');
  assert.equal(result.environment.permission, 'granted');
  assert.deepEqual(abandoned, []);
  // The durable mirror holds both records, so a restart restores them.
  assert.equal(mirror.durable.projects.size, 1);
  assert.equal(mirror.durable.environments.size, 1);
  assert.equal(registry.active.environmentId, result.environment.id);
});

test('a first attachment that fails leaves no ghost project in the mirror', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  const abandoned = [];
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => attachment(),
      abandon: async (request) => {
        abandoned.push(request);
        return { removed: true };
      },
      // The repository is not a Citadel repository.
      makeProvider: async () => providerDouble('unsupported'),
    }),
    /Citadel/i
  );

  // Nothing local survives.
  assert.equal(registry.projects.size, 0);
  assert.equal(registry.environments.size, 0);
  // And nothing durable survives, so reconciliation on the next start cannot
  // restore a project with no environments.
  assert.equal(mirror.durable.projects.size, 0);
  assert.equal(mirror.durable.environments.size, 0);
  // The removals were mirrored once, after both local records were gone.
  const removal = mirror.calls.at(-1);
  assert.equal(removal.removedEnvironmentIds.length, 1);
  assert.equal(removal.removedProjectIds.length, 1);
  // Cleanup names only the opaque operation, never a branch the browser chose.
  assert.deepEqual(abandoned, [{ operationId: 'A'.repeat(43) }]);
});

test('a failed second environment leaves the existing project untouched', async () => {
  const registry = registryDouble({ projects: [['project-1', { id: 'project-1', label: 'Citadel' }]] });
  const mirror = mirrorDouble(registry);
  await mirror();
  await assert.rejects(
    attachGitHubEnvironment({
      project: { id: 'project-1', label: 'Citadel' },
      environmentLabel: 'Production',
      repositoryId: 9002,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => attachment({ source: { ...attachment().source, repositoryId: 9002 } }),
      abandon: async () => ({ removed: true }),
      makeProvider: async () => providerDouble('unsupported'),
    })
  );
  // The project the user already had is not removed by a failed addition.
  assert.equal(registry.projects.size, 1);
  assert.equal(mirror.durable.projects.size, 1);
  assert.equal(registry.environments.size, 0);
  assert.equal(mirror.calls.at(-1).removedProjectIds.length, 0);
});

test('an unremovable working branch is reported, never silently left behind', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => attachment(),
      abandon: async () => {
        throw new Error('network down');
      },
      makeProvider: async () => providerDouble('unsupported'),
    }),
    (error) => {
      // The original cause is preserved and the leftover branch is named.
      assert.match(error.message, /citadel-ui\/env-1/);
      assert.match(error.message, /request-failed/);
      return true;
    }
  );
});

test('a reused branch is not deleted when attachment fails', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  let cleanup = null;
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      // The working branch already existed, so Citadel did not create it.
      attach: async () => attachment({ createdWorkingBranch: false }),
      abandon: async (request) => {
        cleanup = request;
        return { removed: false, reason: 'not-created' };
      },
      makeProvider: async () => providerDouble('unsupported'),
    }),
    (error) => {
      // Nothing is claimed about a branch Citadel never created.
      assert.doesNotMatch(error.message, /could not be removed/);
      return true;
    }
  );
  assert.deepEqual(cleanup, { operationId: 'A'.repeat(43) });
});

test('a failed attach call creates no local records at all', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  let abandonCalled = false;
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => {
        throw Object.assign(new Error('That repository does not exist.'), { status: 404 });
      },
      abandon: async () => {
        abandonCalled = true;
        return { removed: true };
      },
      makeProvider: async () => providerDouble('supported'),
    }),
    /does not exist/
  );
  assert.equal(registry.projects.size, 0);
  assert.equal(mirror.calls.length, 0);
  // There is no reservation to clean up when attachment never succeeded.
  assert.equal(abandonCalled, false);
  // A 404 is a definite rejection: the server answered, reconciled, and
  // discarded anything it created, so nothing is left for a retry to reach.
  assert.equal(registry.pendingAttachment(), null);
});

test('a lost attach response is recovered in place, with the same environment and key', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  const requests = [];
  const branchFor = (environmentId) => `citadel-ui/${environmentId}`;
  // The server is idempotent by operation key, so the retry recovers the branch
  // the first attempt already created rather than creating a second.
  const branches = new Map();
  const attach = async (request) => {
    requests.push(request);
    const existing = branches.get(request.operationKey);
    if (existing) return existing;
    const result = {
      operationId: `op-${branches.size + 1}${'A'.repeat(40)}`,
      createdWorkingBranch: true,
      head: 'a'.repeat(40),
      source: {
        kind: 'github',
        repositoryId: request.repositoryId,
        fullName: 'octo/citadel',
        sourceBranch: request.sourceBranch,
        workingBranch: branchFor(request.environmentId),
      },
    };
    branches.set(request.operationKey, result);
    if (requests.length === 1) {
      // The branch was created; the response never arrived.
      throw Object.assign(new Error('socket hang up'), { retryable: true });
    }
    return result;
  };

  // The lost answer is reconciled inside the same call. Reporting it as a
  // failure was the production defect: the activity log recorded the attach as
  // `ok` while the user was told GitHub could not be reached.
  const result = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'Development',
    repositoryId: 9001,
    sourceBranch: 'main',
    registry,
    mirror,
    attach,
    // This server has no record — after a restart, or past the reservation TTL —
    // so recovery has to fall back to replaying the idempotent attach.
    attachmentStatus: async () => ({ state: 'unknown', result: null }),
    abandon: async () => ({ removed: true }),
    makeProvider: async () => providerDouble('supported'),
    wait: async () => {},
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].environmentId, requests[0].environmentId);
  assert.equal(requests[1].operationKey, requests[0].operationKey);
  // One branch, and it is the one the first attempt created.
  assert.equal(branches.size, 1);
  assert.equal(result.environment.source.workingBranch, branchFor(requests[0].environmentId));
  assert.equal(result.environment.id, requests[0].environmentId);
  // Resolved, so a later unrelated attach starts fresh.
  assert.equal(registry.pendingAttachment(), null);
});

test('a different selection does not resume a stale pending attempt', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  registry.savePendingAttachment({
    repositoryId: 9001,
    sourceBranch: 'main',
    writeMode: 'working-branch',
    environmentId: 'env-stale',
    operationKey: 'key-stale',
  });
  const requests = [];
  await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'Development',
    // A different repository entirely.
    repositoryId: 9002,
    sourceBranch: 'main',
    registry,
    mirror,
    attach: async (request) => {
      requests.push(request);
      return attachment({
        source: { ...attachment().source, repositoryId: 9002, workingBranch: 'citadel-ui/env-new' },
      });
    },
    abandon: async () => ({ removed: true }),
    makeProvider: async () => providerDouble('supported'),
  });
  assert.notEqual(requests[0].environmentId, 'env-stale');
  assert.notEqual(requests[0].operationKey, 'key-stale');
});

test('a rollback whose mirror fails leaves a tombstone that survives a restart', async () => {
  // One durable store, two registry objects: the second stands for the process
  // or browser restarting.
  const storage = storageDouble();
  const registry = registryDouble({ storage });
  const mirror = mirrorDouble(registry);

  mirror.fail = true;
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => attachment(),
      abandon: async () => ({ removed: true }),
      makeProvider: async () => providerDouble('unsupported'),
    })
  );

  // The local records are gone, but the container was never told.
  assert.equal(registry.projects.size, 0);
  const pending = registry.tombstones();
  assert.equal(pending.projectIds.length, 1);
  assert.equal(pending.environmentIds.length, 1);

  // Restart. The durable state is all that carries over.
  const restarted = registryDouble({ storage });
  const restartedMirror = mirrorDouble(restarted);
  // /data still holds exactly what the failed mirror could not remove.
  for (const id of pending.projectIds) {
    restartedMirror.durable.projects.set(id, { id, label: 'Citadel' });
  }
  for (const id of pending.environmentIds) {
    restartedMirror.durable.environments.set(id, { id });
  }

  restartedMirror.fail = true;
  const stillFailing = await resolvePendingRemovals({
    registry: restarted,
    mirror: restartedMirror,
    establishAuthority: async () => ({ epoch: 1, revision: 1 }),
  });
  assert.equal(stillFailing.resolved, false);
  // Not cleared while unresolved, so it is retried again rather than lost.
  assert.equal(restarted.tombstones().projectIds.length, 1);

  restartedMirror.fail = false;
  const resolved = await resolvePendingRemovals({
    registry: restarted,
    mirror: restartedMirror,
    establishAuthority: async () => ({ epoch: 1, revision: 1 }),
  });
  assert.equal(resolved.resolved, true);
  // The ghost is gone from /data rather than resurrected.
  assert.equal(restartedMirror.durable.projects.size, 0);
  assert.equal(restartedMirror.durable.environments.size, 0);
  assert.deepEqual(restarted.tombstones(), { projectIds: [], environmentIds: [] });
});

test('startup establishes authority before pushing a tombstone, and does not overwrite local state', async () => {
  const storage = storageDouble();
  const registry = registryDouble({ storage });
  registry.addTombstones({ projectIds: ['project-ghost'], environmentIds: ['env-ghost'] });
  const order = [];
  const mirror = mirrorDouble(registry);
  mirror.durable.projects.set('project-ghost', { id: 'project-ghost', label: 'Ghost' });
  mirror.durable.environments.set('env-ghost', { id: 'env-ghost' });
  const tracked = async (options) => {
    order.push('mirror');
    return mirror(options);
  };
  tracked.durable = mirror.durable;

  const result = await resolvePendingRemovals({
    registry,
    mirror: tracked,
    establishAuthority: async () => {
      // The handshake must not replace the local database: doing so would
      // restore exactly the records this call exists to remove.
      order.push('authority');
      return { epoch: 1, revision: 4 };
    },
  });

  assert.equal(result.resolved, true);
  assert.deepEqual(order, ['authority', 'mirror']);
  assert.equal(mirror.durable.projects.size, 0);
  assert.equal(mirror.durable.environments.size, 0);
  assert.deepEqual(registry.tombstones(), { projectIds: [], environmentIds: [] });
});

test('a failed authority handshake leaves the tombstone for the next start', async () => {
  const registry = registryDouble();
  registry.addTombstones({ projectIds: ['project-ghost'], environmentIds: [] });
  let mirrored = false;
  const result = await resolvePendingRemovals({
    registry,
    mirror: async () => {
      mirrored = true;
    },
    establishAuthority: async () => {
      throw new Error('the container did not answer');
    },
  });
  assert.equal(result.resolved, false);
  assert.match(result.message, /did not answer/);
  // Nothing was pushed without an authority, and the record survives.
  assert.equal(mirrored, false);
  assert.deepEqual(registry.tombstones().projectIds, ['project-ghost']);
});

test('choosing a different repository does not strand an unresolved attempt', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  const attempts = [];
  // A creates a branch, then the response is lost.
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async (request) => {
        attempts.push(request);
        throw new Error('socket hang up');
      },
      abandon: async () => ({ removed: true }),
      makeProvider: async () => providerDouble('supported'),
    })
  );
  const strandedA = registry.pendingAttachment({
    repositoryId: 9001,
    sourceBranch: 'main',
    writeMode: 'working-branch',
  });
  assert.ok(strandedA);

  // The user picks a different repository instead. A single-slot record would
  // be overwritten here, and A's environment id and operation key — the only
  // handles that could clean its branch up — would be unreachable forever.
  await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'Development',
    repositoryId: 9002,
    sourceBranch: 'main',
    registry,
    mirror,
    attach: async (request) => {
      attempts.push(request);
      return attachment({
        source: { ...attachment().source, repositoryId: 9002, workingBranch: 'citadel-ui/env-b' },
      });
    },
    abandon: async () => ({ removed: true }),
    makeProvider: async () => providerDouble('supported'),
  });

  // B resolved and was retired; A is still there, unchanged and recoverable.
  const remaining = registry.pendingAttachments();
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0], strandedA);

  // And retrying A reuses its original identifiers.
  await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'Development',
    repositoryId: 9001,
    sourceBranch: 'main',
    registry,
    mirror,
    attach: async (request) => {
      attempts.push(request);
      return attachment();
    },
    abandon: async () => ({ removed: true }),
    makeProvider: async () => providerDouble('supported'),
  });
  const retry = attempts.at(-1);
  assert.equal(retry.environmentId, strandedA.environmentId);
  assert.equal(retry.operationKey, strandedA.operationKey);
  assert.deepEqual(registry.pendingAttachments(), []);
});

test('an ambiguous server failure keeps the attempt; a definite rejection retires it', async () => {
  const cases = [
    { status: undefined, label: 'transport failure', kept: true },
    { status: 500, label: 'server error', kept: true },
    { status: 502, label: 'gateway error', kept: true },
    { status: 408, label: 'timeout', kept: true },
    { status: 429, label: 'rate limit', kept: true },
    // GitHub answers a secondary rate limit with 403 and "Reference already
    // exists" with 422. Both may follow a ref call that was accepted, so the
    // status class alone cannot prove nothing was created.
    { status: 403, label: 'secondary rate limit', kept: true },
    { status: 422, label: 'reference already exists', kept: true },
    // The server says so explicitly when it could neither confirm nor deny the
    // branch, whatever status GitHub attached to it.
    { status: 400, label: 'server-marked unconfirmed', kept: true, unconfirmed: true },
    { status: 404, label: 'unknown repository', kept: false },
    { status: 400, label: 'malformed request', kept: false },
  ];
  for (const { status, label, kept, unconfirmed } of cases) {
    const registry = registryDouble();
    const mirror = mirrorDouble(registry);
    await assert.rejects(
      attachGitHubEnvironment({
        projectLabel: 'Citadel',
        environmentLabel: 'Development',
        repositoryId: 9001,
        sourceBranch: 'main',
        registry,
        mirror,
        attach: async () => {
          const error = new Error(label);
          if (status) error.status = status;
          if (unconfirmed) error.attachUnconfirmed = true;
          throw error;
        },
        abandon: async () => ({ removed: true }),
        makeProvider: async () => providerDouble('supported'),
      })
    );
    assert.equal(
      registry.pendingAttachments().length,
      kept ? 1 : 0,
      `${label} (${status ?? 'no status'}) should ${kept ? 'keep' : 'retire'} the attempt`
    );
  }
});

test('a successful rollback leaves nothing to retry', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => attachment(),
      abandon: async () => ({ removed: true }),
      makeProvider: async () => providerDouble('unsupported'),
    })
  );
  assert.deepEqual(registry.tombstones(), { projectIds: [], environmentIds: [] });
  const result = await resolvePendingRemovals({
    registry,
    mirror,
    establishAuthority: async () => ({ epoch: 1, revision: 1 }),
  });
  assert.equal(result.resolved, true);
  assert.equal(mirror.calls.filter((call) => call.removedProjectIds).length, 1);
});

test('a retryable cleanup failure keeps the attempt so the branch can still be removed', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => attachment(),
      abandon: async () => ({
        removed: false,
        reason: 'delete-failed',
        branch: 'citadel-ui/env-1',
        retryable: true,
      }),
      makeProvider: async () => providerDouble('unsupported'),
    }),
    (error) => {
      assert.match(error.message, /could not be removed/);
      return true;
    }
  );
  // Unresolved, so the record stays and the same branch can be retried.
  assert.ok(registry.pendingAttachment());
});


/**
 * The resurrection case.
 *
 * A rollback whose mirror failed leaves a tombstone, and a retry deliberately
 * reuses the environment id of the attempt it resumes. If the tombstone outlives
 * the successful retry, the next startup applies it -- before reconciliation --
 * and deletes the environment the retry just created.
 */
test('a successful retry clears the tombstone left by the attempt it resumed', async () => {
  const registry = registryDouble();
  const mirror = mirrorDouble(registry);

  // First attempt: the environment is created, the mirror carrying it fails, the
  // rollback mirror fails too (so the removal is tombstoned), and the branch
  // cleanup is retryable (so the attempt survives and its ids will be reused).
  mirror.fail = true;
  await assert.rejects(
    attachGitHubEnvironment({
      projectLabel: 'Citadel',
      environmentLabel: 'Development',
      repositoryId: 9001,
      sourceBranch: 'main',
      registry,
      mirror,
      attach: async () => attachment(),
      abandon: async () => ({
        removed: false,
        reason: 'delete-failed',
        branch: 'citadel-ui/env-1',
        retryable: true,
      }),
      makeProvider: async () => providerDouble('supported'),
    })
  );
  const tombstoned = registry.tombstones();
  assert.ok(tombstoned.environmentIds.length, 'the failed rollback left a tombstone');
  const attempt = registry.pendingAttachment();
  assert.ok(attempt, 'the unresolved attempt survives for the retry');

  // The retry succeeds and reuses the same environment id.
  mirror.fail = false;
  const result = await attachGitHubEnvironment({
    projectLabel: 'Citadel',
    environmentLabel: 'Development',
    repositoryId: 9001,
    sourceBranch: 'main',
    registry,
    mirror,
    attach: async () => attachment(),
    abandon: async () => ({ removed: true }),
    makeProvider: async () => providerDouble('supported'),
  });
  assert.equal(result.environment.id, attempt.environmentId, 'the retry reused the id');

  // Nothing is left that a later startup could act on.
  const after = registry.tombstones();
  assert.equal(after.environmentIds.includes(result.environment.id), false);
  assert.equal(after.projectIds.includes(result.projectId), false);
  assert.equal(registry.pendingAttachment(), null);

  // And the durable copy really does still hold the environment, which is what
  // `resolvePendingRemovals` would otherwise have deleted on the next start.
  const removals = await resolvePendingRemovals({ registry, mirror });
  assert.equal(removals.resolved, true);
  assert.ok(mirror.durable.environments.has(result.environment.id), 'the live record survives');
});
