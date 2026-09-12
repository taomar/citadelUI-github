import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceRegistry } from '../web/js/registry.mjs';
import { createRegistrySync } from '../web/js/registry-sync.mjs';
import { createWorkspaceAttachment } from '../web/js/workspace-attachment.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';

const timestamp = '2026-01-03T04:05:06.000Z';
const failure = (status, extra = {}) => Object.assign(new Error(`Synthetic failure ${status}`), { status, ...extra });
const native = () => createConfiguration('terraform', [{
  area: 'deployment', rootAlias: '', valueAlias: 'environments/development.tfvars',
  syntax: 'hcl-tfvars', allowCreate: false, nonsecret: true,
}]);

async function fixture() {
  const storageValues = new Map(), trace = [], requests = [], attachments = [], statuses = [], abandoned = [];
  const state = {
    projects: [{ id: 'existing-project', label: 'Browser stale label' }],
    environments: [{ id: 'existing-workspace', projectId: 'existing-project', label: 'Existing',
      source: { kind: 'local', folderName: 'existing', localPath: 'C:\\existing' } }],
    remote: { epoch: 'server-epoch', revision: 50,
      projects: [{ id: 'existing-project', label: 'Server current label' }], environments: [] },
    puts: 0, projectsCreated: 0, localsCreated: 0, ids: 0,
    cleanup: { removed: true, retryable: false }, createdWorkingBranch: true,
  };
  const handle = { kind: 'directory', name: 'synthetic-root' };
  const provider = { marker: 'provider' };
  const scanResult = {
    compatibility: 'supported', fingerprint: 'scan-fingerprint', lastScannedAt: timestamp,
    catalog: { marker: 'already-scanned' },
  };
  const registry = new WorkspaceRegistry({
    dbName: 'citadel-r3-attachment', indexedDB: {},
    storage: {
      getItem: (key) => storageValues.get(key) ?? null,
      setItem(key, value) {
        if (state.failRecoveryRecord && key === registry.tombstoneKey) throw new Error('Recovery record unavailable');
        storageValues.set(key, value);
      },
      removeItem: (key) => storageValues.delete(key),
    },
  });
  const select = registry.setActive.bind(registry);
  registry.setActive = (projectId, environmentId) => {
    trace.push(['select', projectId, environmentId]); select(projectId, environmentId);
    if (state.failActivation) { state.failActivation = false; throw new Error('Selection response lost'); }
  };
  registry.setActive('existing-project', 'existing-workspace');
  registry.listProjects = async () => state.projects;
  registry.metadataSnapshot = async () => ({
    projects: state.projects, environments: state.environments,
  });
  registry.replaceMetadata = async () => { throw new Error('Registration must not replace unrelated browser metadata'); };
  registry.createProject = async (label) => {
    trace.push(['create-project', label]);
    const project = { id: `new-project-${++state.projectsCreated}`, label };
    state.projects.push(project);
    return project;
  };
  registry.addEnvironment = async (projectId, label, selectedHandle, fingerprint, options) => {
    trace.push(['add-local', projectId, label, selectedHandle, fingerprint, options]);
    const environment = {
      id: `new-local-${++state.localsCreated}`, projectId, label, configuration: options.configuration,
      source: { kind: 'local', folderName: selectedHandle.name, localPath: options.localPath },
    };
    state.environments.push(environment);
    return environment;
  };
  registry.addGitHubEnvironment = async (projectId, label, source, options) => {
    trace.push(['add-git', projectId, label, source, options]);
    const environment = { id: options.id, projectId, label, source, configuration: options.configuration };
    state.environments.push(environment);
    return environment;
  };
  registry.updateEnvironment = async (id, patch) => {
    trace.push(['update', id, patch]);
    const value = { ...state.environments.find((entry) => entry.id === id), ...patch };
    state.environments = state.environments.map((entry) => entry.id === id ? value : entry);
    return value;
  };
  registry.removeEnvironment = async (id) => {
    trace.push(['remove-environment', id]);
    if (state.localRemovalError) throw state.localRemovalError;
    state.environments = state.environments.filter((entry) => entry.id !== id);
    if (registry.active()?.environmentId === id) registry.clearRetainedSelection();
  };
  registry.removeProject = async (id) => {
    trace.push(['remove-project', id]);
    if (state.localRemovalError) throw state.localRemovalError;
    state.projects = state.projects.filter((entry) => entry.id !== id);
  };
  registry.getHandle = async () => handle;
  const tombstone = registry.addTombstones.bind(registry), retire = registry.removeTombstones.bind(registry);
  registry.addTombstones = (value) => { trace.push(['tombstone', value]); return tombstone(value); };
  registry.removeTombstones = (value) => { trace.push(['retire', value]); return state.failRetirement ? false : retire(value); };
  const request = async (path, options) => {
    assert.equal(path, '/api/registry');
    if (!options) {
      requests.push({ method: 'GET' }); trace.push(['authority']);
      if (state.getError) throw state.getError;
      return structuredClone(state.remote);
    }
    const body = JSON.parse(options.body);
    requests.push({ method: options.method, body }); trace.push(['mirror', body]);
    state.puts += 1;
    await state.beforePut?.(body, state.puts);
    assert.equal(body.expectedEpoch, state.remote.epoch);
    assert.equal(body.expectedRevision, state.remote.revision);
    const merge = (existing, additions, removed) => {
      const values = new Map(existing.filter((item) => !removed.includes(item.id)).map((item) => [item.id, item]));
      for (const item of additions) values.set(item.id, item);
      return [...values.values()];
    };
    state.remote = {
      epoch: state.remote.epoch, revision: state.remote.revision + 1,
      projects: merge(state.remote.projects, body.projects, body.removedProjectIds),
      environments: merge(state.remote.environments.filter((item) => !body.removedProjectIds.includes(item.projectId)),
        body.environments, body.removedEnvironmentIds),
    };
    await state.afterPut?.(body, state.puts);
    return structuredClone(state.remote);
  };
  const sync = createRegistrySync({ registry, request });
  await sync.establishRegistryAuthority();
  trace.length = 0; requests.length = 0;
  const clock = {
    now: () => timestamp,
    uuid: () => `00000000-0000-4000-8000-${String(++state.ids).padStart(12, '0')}`,
    wait: async (ms) => { trace.push(['wait', ms]); },
  };
  const resultFor = (payload) => ({
    operationId: `reservation-${payload.operationKey}`, createdWorkingBranch: state.createdWorkingBranch,
    source: {
      kind: 'github', connectionProfileId: 'profile-one', repositoryId: payload.repositoryId,
      fullName: 'synthetic/repo', sourceBranch: payload.sourceBranch,
      workingBranch: payload.workingBranch || `server-selected/${payload.environmentId}`,
      writeMode: payload.writeMode, lastKnownHead: 'a'.repeat(40),
    },
  });
  const ports = {
    registry, sync, clock,
    async attach(payload) {
      trace.push(['attach', payload]); attachments.push(payload);
      assert(registry.pendingAttachments().some((entry) => entry.operationKey === payload.operationKey));
      return state.attach ? state.attach(payload) : resultFor(payload);
    },
    async status(payload) { trace.push(['status', payload]); statuses.push(payload); return state.status ? state.status(payload) : { state: 'unknown' }; },
    async abandon(payload) { trace.push(['abandon', payload]); abandoned.push(payload); return state.cleanup; },
    async makeProvider(environment, dependencies) {
      trace.push(['provider', environment, dependencies]);
      if (state.providerError) throw state.providerError;
      return provider;
    },
    async scan(value) { trace.push(['scan', value]); if (state.scanError) throw state.scanError; return scanResult; },
  };
  return { state, trace, requests, attachments, statuses, abandoned, registry, sync, ports, clock,
    handle, provider, scanResult, resultFor, attachment: createWorkspaceAttachment(ports) };
}

const localOptions = (f, overrides = {}) => ({
  projectLabel: 'Synthetic project', environmentLabel: 'Synthetic local',
  localPath: 'C:\\synthetic-root', handle: f.handle, provider: f.provider, scan: f.scanResult, ...overrides,
});
const gitOptions = (f, overrides = {}) => ({
  projectLabel: 'Synthetic project', environmentLabel: 'Synthetic Git', repositoryId: 42, sourceBranch: 'source',
  connectionProfileId: 'profile-one', reconcileDelays: [0], wait: f.clock.wait, ...overrides,
});

for (const activate of [true, false]) {
  test(`R3 workspace attachment: Local registration returns exact updated context after mirror (activate: ${activate})`, async () => {
    const f = await fixture();
    const configuration = native();
    f.provider.configuration = configuration;
    const result = await f.attachment.attachEnvironment(localOptions(f, { activate }));
    assert.equal(result.handle, f.handle);
    assert.equal(result.provider, f.provider);
    assert.equal(result.catalog, f.scanResult.catalog);
    assert.equal(result.environment.configuration, configuration);
    assert.equal(result.environment.lastOpenedAt, timestamp);
    assert.deepEqual(f.trace.map(([kind]) => kind), ['create-project', 'add-local', 'update', 'mirror', ...(activate ? ['select'] : [])]);
    assert.deepEqual(f.registry.active(), activate
      ? { projectId: result.projectId, environmentId: result.environment.id }
      : { projectId: 'existing-project', environmentId: 'existing-workspace' });
  });
}

for (const existing of [false, true]) {
  test(`R3 workspace attachment: ordinary Local rollback removes only records it created (existing project: ${existing})`, async () => {
    const f = await fixture(), problem = new Error('Mirror refused');
    await assert.rejects(f.attachment.attachEnvironment(localOptions(f, {
      project: existing ? f.state.projects[0] : null, mirror: async () => { throw problem; },
    })), (error) => error === problem);
    assert.deepEqual(f.state.projects.map((item) => item.id), ['existing-project']);
    assert.deepEqual(f.state.environments.map((item) => item.id), ['existing-workspace']);
    assert.equal(f.trace.some(([kind]) => kind === 'select'), false);
    assert.equal(f.trace.filter(([kind]) => kind === 'remove-project').length, existing ? 0 : 1);
  });
}

test('R3 workspace attachment: failed Local activation is compensated and restores the old selection', async () => {
  const f = await fixture();
  f.state.failActivation = true;
  await assert.rejects(f.attachment.attachEnvironment(localOptions(f, { recoverMirror: true })), /Selection response lost/);
  assert.deepEqual(f.registry.active(), { projectId: 'existing-project', environmentId: 'existing-workspace' });
  assert.deepEqual(f.registry.tombstones(), { projectIds: [], environmentIds: [] });
  assert.deepEqual(f.state.environments.map((item) => item.id), ['existing-workspace']);
});

for (const existing of [false, true]) {
  test(`R3 workspace attachment: Local import sends only created identities after a fresh handshake (existing project: ${existing})`, async () => {
    const f = await fixture();
    f.state.remote.revision = 900;
    const result = await f.attachment.attachLocalSourceEnvironment(localOptions(f, {
      projectId: existing ? 'existing-project' : null,
    }));
    assert.deepEqual(f.requests.map((item) => item.method), ['GET', 'PUT']);
    const body = f.requests[1].body;
    assert.equal(body.expectedRevision, 900);
    assert.deepEqual(body.projects.map((item) => item.id), existing ? [] : [result.projectId]);
    assert.deepEqual(body.environments.map((item) => item.id), [result.environment.id]);
    assert.deepEqual(body.removedProjectIds, []);
    assert.deepEqual(body.removedEnvironmentIds, []);
    assert.equal(f.state.remote.projects.find((item) => item.id === 'existing-project').label, 'Server current label');
    assert.equal(f.state.projects[0].label, 'Browser stale label');
    assert.equal(f.trace.some(([kind]) => kind === 'scan'), false, 'the already verified copy is not rescanned');
  });
}

test('R3 workspace attachment: a lost Local mirror response learns the new revision for scoped compensation', async () => {
  const f = await fixture(), lost = new Error('Registry response lost');
  f.state.afterPut = async (_body, count) => { if (count === 1) throw lost; };
  await assert.rejects(f.attachment.attachLocalSourceEnvironment(localOptions(f)), (error) => error === lost);
  assert.deepEqual(f.requests.map((item) => item.method), ['GET', 'PUT', 'GET', 'PUT']);
  const [created, removed] = f.requests.filter((item) => item.body).map((item) => item.body);
  assert.equal(created.expectedRevision, 50);
  assert.equal(removed.expectedRevision, 51);
  assert.deepEqual(removed.projects, []);
  assert.deepEqual(removed.environments, []);
  assert.deepEqual(removed.removedProjectIds, created.projects.map((item) => item.id));
  assert.deepEqual(removed.removedEnvironmentIds, created.environments.map((item) => item.id));
  assert.equal(f.state.remote.projects.find((item) => item.id === 'existing-project').label, 'Server current label');
  assert.deepEqual(f.registry.active(), { projectId: 'existing-project', environmentId: 'existing-workspace' });
});

test('R3 workspace attachment: in-memory Local recovery survives failed tombstone persistence and blocks duplicate registration', async () => {
  const f = await fixture(), lost = new Error('Registry response lost');
  f.state.afterPut = async (_body, count) => { if (count === 1) throw lost; };
  f.state.localRemovalError = new Error('Local rollback unavailable');
  f.state.failRecoveryRecord = true;
  await assert.rejects(f.attachment.attachLocalSourceEnvironment(localOptions(f)), { code: 'LOCAL_IMPORT_REGISTRY_PENDING' });
  assert.equal(f.state.projectsCreated, 1);
  assert.equal(f.state.localsCreated, 1);
  assert.deepEqual(f.registry.tombstones(), { projectIds: [], environmentIds: [] });
  await assert.rejects(f.attachment.attachLocalSourceEnvironment(localOptions(f)), /Registry recovery is still pending/);
  assert.equal(f.state.projectsCreated, 1);
  f.state.localRemovalError = null;
  f.state.failRecoveryRecord = false;
  f.trace.length = 0;
  const result = await f.attachment.attachLocalSourceEnvironment(localOptions(f));
  assert.deepEqual(f.trace.slice(0, 2).map(([kind]) => kind), ['remove-environment', 'remove-project']);
  assert.equal(f.state.projectsCreated, 2);
  assert.equal(f.state.localsCreated, 2);
  assert.deepEqual(f.state.environments.map((item) => item.id), ['existing-workspace', result.environment.id]);
});

test('R3 workspace attachment: missing project and invalid Local path fail before new records or source work', async () => {
  const f = await fixture();
  await assert.rejects(f.attachment.attachLocalSourceEnvironment(localOptions(f, { projectId: 'missing' })), /selected project no longer exists/);
  await assert.rejects(f.attachment.attachLocalSourceEnvironment(localOptions(f, { localPath: 'relative' })), /absolute/);
  assert.equal(f.state.projectsCreated, 0);
  assert.equal(f.state.localsCreated, 0);
  assert.deepEqual(f.requests, []);
});

test('R3 workspace attachment: Git request records exact retry selection before submission and mirrors before opening', async () => {
  const f = await fixture(), configuration = native(), stages = [];
  const options = gitOptions(f, {
    configuration, workingBranch: 'operator/target', adoptExisting: true,
    expectedHead: 'b'.repeat(40), stage: (id) => stages.push(id),
  });
  const result = await f.attachment.attachGitHubEnvironment(options);
  const payload = f.attachments[0];
  assert.deepEqual(payload, {
    repositoryId: 42, sourceBranch: 'source',
    environmentId: '00000000-0000-4000-8000-000000000001',
    writeMode: 'working-branch', operationKey: '00000000-0000-4000-8000-000000000002',
    workingBranch: 'operator/target', adoptExisting: true, configuration, expectedHead: 'b'.repeat(40),
  });
  assert.equal('connectionProfileId' in payload, false, 'the server owns the credential binding');
  assert.equal(result.environment.source.connectionProfileId, 'profile-one');
  assert.equal(result.environment.configuration, configuration);
  assert.equal(result.handle, null);
  assert.equal(result.catalog, f.scanResult.catalog);
  assert.deepEqual(stages, ['revalidate', 'metadata', 'open', 'ready']);
  assert.deepEqual(f.trace.map(([kind]) => kind), ['attach', 'create-project', 'add-git', 'mirror', 'provider', 'scan', 'update', 'mirror', 'select', 'retire']);
  assert.deepEqual(f.registry.pendingAttachments(), []);
});

test('R3 workspace attachment: status confirmation of a lost Git response does not replay a mutation', async () => {
  const f = await fixture(), stages = [];
  let confirmed;
  f.state.attach = async (payload) => { confirmed = f.resultFor(payload); throw failure(502); };
  f.state.status = async () => ({ state: 'attached', result: confirmed });
  const result = await f.attachment.attachGitHubEnvironment(gitOptions(f, { stage: (id) => stages.push(id) }));
  assert.equal(f.attachments.length, 1);
  assert.deepEqual(f.statuses, [{ operationKey: f.attachments[0].operationKey }]);
  assert.equal(result.attachment, confirmed);
  assert.deepEqual(stages, ['revalidate', 'branch', 'metadata', 'open', 'ready']);
});

test('R3 workspace attachment: unknown Git status replays the same request object and operation identity', async () => {
  const f = await fixture();
  f.state.attach = async (payload) => {
    if (f.attachments.length === 1) throw failure(504);
    return f.resultFor(payload);
  };
  await f.attachment.attachGitHubEnvironment(gitOptions(f, { workingBranch: 'chosen', adoptExisting: false }));
  assert.equal(f.attachments.length, 2);
  assert.equal(f.attachments[0], f.attachments[1]);
  assert.equal(f.state.ids, 2);
  assert.deepEqual(f.abandoned, []);
});

for (const status of [400, 401, 404, 409]) {
  test(`R3 workspace attachment: deterministic Git rejection ${status} retires only its own attempt`, async () => {
    const f = await fixture(), rejected = failure(status);
    f.state.attach = async () => { throw rejected; };
    await assert.rejects(f.attachment.attachGitHubEnvironment(gitOptions(f)), (error) => error === rejected && error.attachStage === 'revalidate');
    assert.equal(f.attachments.length, 1);
    assert.deepEqual(f.statuses, []);
    assert.deepEqual(f.registry.pendingAttachments(), []);
    assert.deepEqual(f.requests, []);
  });
}

for (const status of [undefined, 403, 408, 422, 429, 500]) {
  test(`R3 workspace attachment: ambiguous Git rejection ${status} retains the exact pending attempt`, async () => {
    const f = await fixture();
    f.state.attach = async () => { throw failure(status); };
    await assert.rejects(f.attachment.attachGitHubEnvironment(gitOptions(f)), (error) =>
      error.code === 'ATTACH_UNRESOLVED' && error.attachUnconfirmed && error.retryable && error.attachStage === 'branch');
    assert.equal(f.attachments.length, 2);
    assert.equal(f.attachments[0], f.attachments[1]);
    assert.equal(f.registry.pendingAttachments().length, 1);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.abandoned, []);
  });
}

test('R3 workspace attachment: unconfirmed provenance overrides an otherwise terminal HTTP status', async () => {
  const f = await fixture();
  f.state.attach = async () => { throw failure(409, { attachUnconfirmed: true }); };
  await assert.rejects(f.attachment.attachGitHubEnvironment(gitOptions(f)), { code: 'ATTACH_UNRESOLVED' });
  assert.equal(f.registry.pendingAttachments().length, 1);
  assert.equal(f.attachments.length, 2);
});

test('R3 workspace attachment: a recreated composition reuses saved Git identity, configuration and profile selection', async () => {
  const f = await fixture(), configuration = native();
  f.state.attach = async () => { throw failure(503); };
  const options = gitOptions(f, { configuration, workingBranch: 'native/target', adoptExisting: true });
  await assert.rejects(f.attachment.attachGitHubEnvironment(options), { code: 'ATTACH_UNRESOLVED' });
  const saved = f.registry.pendingAttachments()[0], issued = f.state.ids;
  assert.equal(saved.connectionProfileId, 'profile-one');
  assert.deepEqual(saved.configuration, configuration);
  f.state.attach = null;
  const resumed = createWorkspaceAttachment(f.ports);
  const result = await resumed.attachGitHubEnvironment(options);
  assert.equal(result.environment.id, saved.environmentId);
  assert.equal(f.attachments.at(-1).operationKey, saved.operationKey);
  assert.deepEqual(f.attachments.at(-1).configuration, saved.configuration);
  assert.equal(f.state.ids, issued);
  assert.deepEqual(f.registry.pendingAttachments(), []);
});

for (const change of ['connection', 'branch', 'configuration']) {
  test(`R3 workspace attachment: a different ${change} selection cannot consume another Git attempt`, async () => {
    const f = await fixture(), configuration = native();
    f.state.attach = async () => { throw failure(503); };
    const options = gitOptions(f, { configuration, workingBranch: 'native/target' });
    await assert.rejects(f.attachment.attachGitHubEnvironment(options), { code: 'ATTACH_UNRESOLVED' });
    const original = f.registry.pendingAttachments()[0];
    const changed = change === 'connection' ? { connectionProfileId: 'profile-two' }
      : change === 'branch' ? { workingBranch: 'other/target' } : { configuration: createConfiguration('bicep') };
    await assert.rejects(f.attachment.attachGitHubEnvironment({ ...options, ...changed }), { code: 'ATTACH_UNRESOLVED' });
    assert.equal(f.registry.pendingAttachments().length, 2);
    assert.deepEqual(f.registry.pendingAttachments()[0], original);
    assert.notEqual(f.attachments[2].environmentId, original.environmentId);
    assert.deepEqual(f.abandoned, []);
  });
}

test('R3 workspace attachment: Git metadata rollback removes records before its mirror and names only server-authorized cleanup', async () => {
  const f = await fixture(), rejected = new Error('Metadata unavailable');
  f.state.beforePut = async (_body, count) => { if (count === 1) throw rejected; };
  await assert.rejects(f.attachment.attachGitHubEnvironment(gitOptions(f)), (error) => error === rejected && error.attachStage === 'metadata');
  const kinds = f.trace.map(([kind]) => kind);
  assert.deepEqual(kinds, ['attach', 'create-project', 'add-git', 'mirror', 'remove-environment', 'remove-project', 'tombstone', 'mirror', 'abandon']);
  assert.deepEqual(f.abandoned, [{ operationId: `reservation-${f.attachments[0].operationKey}` }]);
  assert.deepEqual(f.requests.at(-1).body.removedEnvironmentIds, [f.attachments[0].environmentId]);
  assert.deepEqual(f.state.projects.map((item) => item.id), ['existing-project']);
  assert.deepEqual(f.registry.pendingAttachments(), []);
});

for (const retryable of [true, false]) {
  test(`R3 workspace attachment: Git cleanup refusal preserves truthful branch and retry state (retryable: ${retryable})`, async () => {
    const f = await fixture();
    f.state.scanError = Object.assign(new Error('Source admission refused'), { code: 'SOURCE_REFUSED' });
    f.state.cleanup = { removed: false, retryable, reason: 'server-refused', branch: 'server-owned-target' };
    await assert.rejects(f.attachment.attachGitHubEnvironment(gitOptions(f)), (error) =>
      error.code === 'SOURCE_REFUSED' && error.attachStage === 'open' &&
      /server-owned-target could not be removed \(server-refused\)/.test(error.message));
    assert.equal(f.registry.pendingAttachments().length, retryable ? 1 : 0);
    assert.deepEqual(Object.keys(f.abandoned[0]), ['operationId']);
    assert.equal(f.trace.some(([kind]) => kind === 'select'), false);
  });
}

test('R3 workspace attachment: successful retry retires only matching tombstones and pending identities', async () => {
  const f = await fixture();
  f.state.attach = async () => { throw failure(503); };
  await assert.rejects(f.attachment.attachGitHubEnvironment(gitOptions(f)), { code: 'ATTACH_UNRESOLVED' });
  const saved = f.registry.pendingAttachments()[0];
  await assert.rejects(f.attachment.attachGitHubEnvironment(gitOptions(f, { connectionProfileId: 'other-profile' })), { code: 'ATTACH_UNRESOLVED' });
  const other = f.registry.pendingAttachments()[1];
  f.registry.addTombstones({ projectIds: ['unrelated-project'], environmentIds: [saved.environmentId, 'unrelated-environment'] });
  f.state.attach = null;
  const result = await f.attachment.attachGitHubEnvironment(gitOptions(f));
  assert.equal(result.environment.id, saved.environmentId);
  assert.deepEqual(f.registry.pendingAttachments(), [other]);
  assert.deepEqual(f.registry.tombstones(), { projectIds: ['unrelated-project'], environmentIds: ['unrelated-environment'] });
});

test('R3 workspace attachment: Local import accepts through the existing owner before its result settles', async () => {
  const f = await fixture(), observed = [];
  const pending = f.attachment.attachLocalSourceEnvironment(localOptions(f), (workspace) => {
    assert.deepEqual(f.registry.active(), { projectId: workspace.projectId, environmentId: workspace.environment.id });
    assert.equal(f.requests.at(-1).method, 'PUT');
    observed.push(workspace);
    return workspace;
  });
  const result = await pending.then((workspace) => {
    assert.equal(observed[0], workspace);
    return workspace;
  });
  assert.deepEqual(observed, [result]);
});

test('R3 workspace attachment: unconfirmed Local registration never invokes the active-owner adapter', async () => {
  const f = await fixture();
  let accepted = false;
  f.state.beforePut = async () => { throw new Error('Registry unavailable'); };
  await assert.rejects(f.attachment.attachLocalSourceEnvironment(localOptions(f), () => {
    accepted = true;
  }), { code: 'LOCAL_IMPORT_REGISTRY_PENDING' });
  assert.equal(accepted, false);
  assert.deepEqual(f.registry.active(), { projectId: 'existing-project', environmentId: 'existing-workspace' });
});
