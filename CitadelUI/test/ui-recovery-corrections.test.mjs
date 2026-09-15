import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRegistrySync, registryEnvironmentIdentity } from '../web/js/registry-sync.mjs';
import { createWorkspaceActivation, createWorkspaceReattachment, withSourceUnavailable } from '../web/js/workspace-activation.mjs';
import { createProvider } from '../web/js/source-factory.mjs';
import { environmentSourceOf } from '../web/js/registry.mjs';
import { validateLocalPath } from '../shared/local-path.mjs';
import { presentWorkspaceCatalog, workspaceRow } from '../web/js/workspace-catalog.mjs';
import { closeDialog, dismissDialog } from '../web/js/dialog.mjs';
import { installDom, readText } from './_dom-stub.mjs';

const clone = (value) => structuredClone(value);
const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const original = {
  id: 'retained', projectId: 'project', label: 'Retained workspace',
  permission: 'granted', compatibility: 'supported',
  source: {
    kind: 'github', connectionProfileId: 'removed', repositoryId: 41, fullName: 'synthetic/retained',
    sourceBranch: 'main', workingBranch: 'review/work', writeMode: 'working-branch',
    branchChoice: 'adopted', validatedAt: '2026-01-01T00:00:00.000Z',
  },
};
const profile = { id: 'replacement', name: 'Reviewed account', accountId: 51, accountLogin: 'synthetic', status: 'session' };
const other = { ...clone(original), id: 'unrelated', label: 'Unrelated workspace', source: { ...original.source, repositoryId: 42, fullName: 'synthetic/unrelated', connectionProfileId: profile.id } };

function fixture({ mode = 'accept', registry: overrideRegistry, sync: overrideSync } = {}) {
  const state = {
    local: clone(original), remote: clone(original), other: clone(other), revision: 1, mode,
    updates: 0, puts: [], heads: { main: 'a'.repeat(40), 'review/work': 'b'.repeat(40) },
    drafts: [{ environmentId: original.id, bytes: 'unchanged draft bytes' }],
    history: [{ environmentId: original.id, id: 'retained-change' }],
  };
  const registry = {
    getEnvironment: async () => clone(state.local),
    async updateEnvironment(id, patch) {
      assert.equal(id, original.id);
      state.updates++;
      state.local = { ...state.local, ...clone(patch) };
      return clone(state.local);
    },
    metadataSnapshot: async () => ({ projects: [{ id: original.projectId }], environments: [clone(state.local), clone(state.other)] }),
    ...overrideRegistry,
  };
  const request = async (_url, options = {}) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      state.puts.push(body);
      assert.equal(body.expectedEpoch, 'owned-review');
      assert.equal(body.expectedRevision, state.revision);
      assert.deepEqual(body.projects, []);
      assert.deepEqual(body.environments.map((item) => item.id), [original.id]);
      if (state.mode === 'reject') throw Object.assign(new Error('Registry publication rejected'), { code: 'REGISTRY_UNAVAILABLE' });
      state.remote = clone(body.environments[0]);
      state.revision++;
      if (state.mode === 'lost') throw Object.assign(new Error('Accepted registry response lost'), { code: 'REGISTRY_RESPONSE_LOST' });
    }
    return { epoch: 'owned-review', revision: state.revision, projects: [], environments: [clone(state.remote), clone(state.other)] };
  };
  const sync = overrideSync || createRegistrySync({ registry, request });
  const recovery = createWorkspaceReattachment({
    registry, sync,
    connections: {
      generation: () => 1, isCurrent: (value) => value === 1,
      status: async () => ({ connected: true, profileId: profile.id, accountId: profile.accountId, login: profile.accountLogin }),
      list: async () => ({ profiles: [profile] }),
    },
    repositories: {
      get: async () => ({ id: original.source.repositoryId, fullName: original.source.fullName, canPush: true }),
      check: async (repositoryId, branch) => ({ repositoryId, fullName: original.source.fullName, branch, supported: true, head: state.heads[branch] }),
    },
    now: () => '2026-09-12T12:00:00.000Z',
  });
  return { state, registry, sync, recovery };
}

for (const field of ['connectionProfileId', 'repositoryId', 'fullName', 'sourceBranch', 'workingBranch', 'writeMode', 'branchChoice']) {
  test(`UI recovery corrections: publication rejects a changed reviewed ${field} at the snapshot boundary`, async () => {
    const f = fixture();
    await f.sync.establishRegistryAuthority();
    const reviewed = clone(original);
    f.state.local.source[field] = field === 'repositoryId' ? 99 : 'changed';
    await assert.rejects(f.sync.syncRegistryMetadata({}, { projectIds: [], environmentIds: [original.id] }, {
      reviewedEnvironments: [reviewed],
    }), { code: 'REGISTRY_REVIEW_CHANGED' });
    assert.equal(f.state.puts.length, 0);
    assert.deepEqual(f.state.remote, original);
  });
}

test('UI recovery corrections: review pins are captured before awaiting a mutable snapshot', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture();
  const reviewed = clone(original);
  f.registry.metadataSnapshot = async () => {
    entered.resolve();
    await release.promise;
    return { projects: [], environments: [clone(f.state.local)] };
  };
  await f.sync.establishRegistryAuthority();
  const writing = f.sync.syncRegistryMetadata({}, { projectIds: [], environmentIds: [original.id] }, { reviewedEnvironments: [reviewed] });
  await entered.promise;
  reviewed.source.connectionProfileId = f.state.local.source.connectionProfileId = 'another-client';
  release.resolve();
  await assert.rejects(writing, { code: 'REGISTRY_REVIEW_CHANGED' });
  assert.equal(f.state.puts.length, 0);
});

test('UI recovery corrections: reviewed scope/removal filtering cannot silently omit the pinned workspace', async () => {
  for (const [removals, scope] of [
    [{ removedEnvironmentIds: [original.id] }, null],
    [{ removedProjectIds: [original.projectId] }, null],
    [{}, { projectIds: [], environmentIds: [other.id] }],
  ]) {
    const f = fixture();
    await f.sync.establishRegistryAuthority();
    await assert.rejects(f.sync.syncRegistryMetadata(removals, scope, { reviewedEnvironments: [original] }), { code: 'REGISTRY_REVIEW_CHANGED' });
    assert.equal(f.state.puts.length, 0);
  }
});

test('UI recovery corrections: legacy synchronization keeps its default snapshot behavior', async () => {
  const f = fixture();
  await f.sync.establishRegistryAuthority();
  f.state.local.source.connectionProfileId = profile.id;
  const remote = await f.sync.syncRegistryMetadata({}, { projectIds: [], environmentIds: [original.id] });
  assert.equal(remote.environments[0].source.connectionProfileId, profile.id);
  assert.equal(f.state.puts.length, 1);
  assert.deepEqual(f.state.other, other);
});

test('UI recovery corrections: a wrong confirmed identity never advances guarded authority or succeeds', async () => {
  const bodies = [];
  const sync = createRegistrySync({
    registry: { metadataSnapshot: async () => ({ projects: [], environments: [clone(original)] }) },
    request: async (_url, options = {}) => {
      if (options.method !== 'PUT') return { epoch: 'owned', revision: 4, environments: [clone(original)] };
      bodies.push(JSON.parse(options.body));
      return { epoch: 'owned', revision: 5, environments: [{ ...clone(original), source: { ...original.source, connectionProfileId: 'wrong-response' } }] };
    },
  });
  await sync.establishRegistryAuthority();
  for (let count = 0; count < 2; count++) {
    await assert.rejects(sync.syncRegistryMetadata({}, null, { reviewedEnvironments: [original] }), { code: 'REGISTRY_CONFIRMATION_MISMATCH' });
  }
  assert.deepEqual(bodies.map((body) => body.expectedRevision), [4, 4]);
});

for (const mode of ['reject', 'lost']) {
  test(`UI recovery corrections: ${mode} publication keeps a branded pending owner and retries without restaging`, async () => {
    const f = fixture({ mode });
    const draft = clone(f.state.drafts), history = clone(f.state.history);
    const review = await f.recovery.review(original, profile.id);
    await assert.rejects(f.recovery.commit(review), { code: 'REATTACH_SYNC_PENDING' });
    assert.equal(f.recovery.pending(original.id), review);
    assert.equal(f.recovery.pending(other.id), null);
    assert.equal(f.state.updates, 1);
    assert.equal(f.state.puts.length, 1);
    await assert.rejects(f.recovery.review(f.state.local, profile.id), { code: 'REATTACH_SYNC_PENDING' });
    const refreshed = await f.recovery.revalidate(review);
    assert.equal(f.recovery.pending(original.id), refreshed);
    await assert.rejects(f.recovery.commit(review), /Review this workspace/);
    f.state.mode = 'accept';
    const confirmed = await f.recovery.commit(refreshed);
    assert.equal(confirmed.source.connectionProfileId, profile.id);
    assert.equal(registryEnvironmentIdentity(confirmed), registryEnvironmentIdentity(f.state.remote));
    assert.equal(f.state.updates, 1);
    assert.equal(f.state.puts.length, mode === 'lost' ? 1 : 2);
    assert.equal(f.recovery.pending(original.id), null);
    assert.deepEqual(f.state.drafts, draft);
    assert.deepEqual(f.state.history, history);
    assert.deepEqual(f.state.other, other);
  });
}

test('UI recovery corrections: the reattachment owner independently checks the returned confirmation', async () => {
  const f = fixture({
    sync: {
      establishRegistryAuthority: async () => ({ environments: [clone(original)] }),
      syncRegistryMetadata: async () => ({ environments: [{ ...clone(original), source: { ...original.source, connectionProfileId: 'wrong' } }] }),
    },
  });
  const review = await f.recovery.review(original, profile.id);
  await assert.rejects(f.recovery.commit(review), (error) => {
    assert.equal(error.code, 'REATTACH_SYNC_PENDING');
    assert.equal(error.cause.code, 'REATTACH_CONFIRMATION_MISMATCH');
    assert.equal(error.sourceUnavailable, undefined);
    return true;
  });
  assert.equal(f.recovery.pending(original.id), review);
});

test('UI recovery corrections: concurrent local staging rejects A rather than publishing B through A', async () => {
  const state = { local: clone(original), remote: clone(original), revision: 1, reads: { A: 0, B: 0 }, checks: 0, committing: false, puts: [] };
  const bothChecked = deferred(), aUpdated = deferred(), bUpdated = deferred(), aFinished = deferred();
  function client(name) {
    const chosen = { ...profile, id: `profile-${name}`, accountId: name === 'A' ? 51 : 52 };
    const registry = {
      async getEnvironment() {
        const value = clone(state.local);
        if (state.committing && ++state.reads[name] === 2) {
          if (++state.checks === 2) bothChecked.resolve();
          await bothChecked.promise;
        }
        return value;
      },
      async updateEnvironment(_id, patch) {
        if (name === 'B') await aUpdated.promise;
        state.local = { ...state.local, ...clone(patch) };
        const value = clone(state.local);
        if (name === 'A') { aUpdated.resolve(); await bUpdated.promise; }
        else bUpdated.resolve();
        return value;
      },
      metadataSnapshot: async () => ({ projects: [], environments: [clone(state.local)] }),
    };
    const sync = createRegistrySync({
      registry,
      async request(_url, options = {}) {
        if (options.method === 'PUT') {
          const body = JSON.parse(options.body);
          state.puts.push({ client: name, profile: body.environments[0].source.connectionProfileId });
          if (name === 'B') await aFinished.promise;
          if (body.expectedRevision !== state.revision) throw Object.assign(new Error('Concurrent revision'), { code: 'REGISTRY_CONFLICT' });
          state.remote = clone(body.environments[0]);
          state.revision++;
        }
        return { epoch: 'owned', revision: state.revision, environments: [clone(state.remote)] };
      },
    });
    return createWorkspaceReattachment({
      registry, sync,
      connections: {
        generation: () => 1, isCurrent: (value) => value === 1, list: async () => ({ profiles: [chosen] }),
        status: async () => ({ connected: true, profileId: chosen.id, accountId: chosen.accountId, login: chosen.accountLogin }),
      },
      repositories: {
        get: async () => ({ id: original.source.repositoryId, fullName: original.source.fullName, canPush: true }),
        check: async (repositoryId, branch) => ({ repositoryId, fullName: original.source.fullName, branch, supported: true, head: 'a'.repeat(40) }),
      },
    });
  }
  const a = client('A'), b = client('B');
  const reviewA = await a.review(original, 'profile-A'), reviewB = await b.review(original, 'profile-B');
  state.committing = true;
  const outcomes = await Promise.allSettled([a.commit(reviewA).finally(() => aFinished.resolve()), b.commit(reviewB)]);
  assert.equal(outcomes[0].status, 'rejected');
  assert.equal(outcomes[0].reason.cause.code, 'REGISTRY_REVIEW_CHANGED');
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.deepEqual(state.puts, [{ client: 'B', profile: 'profile-B' }]);
  assert.equal(outcomes[1].value.source.connectionProfileId, state.remote.source.connectionProfileId);
  assert.equal(a.pending(original.id), reviewA);
  assert.equal(b.pending(original.id), null);
});

const contextSource = await readFile(new URL('../web/js/workspace-context.mjs', import.meta.url), 'utf8');
const start = contextSource.indexOf('function catalogActions() {');
const end = contextSource.indexOf('\nexport { registry as workspaceRegistry }', start);
assert(start >= 0 && end > start);
function composedActions(workspaceActivation, registry, workspaceReattachment = {}) {
  const unused = () => assert.fail('Unrelated action in composed recovery test');
  const bindings = {
    workspaceActivation, workspaceReattachment, registry, withSourceUnavailable, environmentSourceOf, validateLocalPath,
    getGitHubRepository: unused, listGitHubRepositoryCreations: unused, prepareGitHubRepository: unused,
    listRepositoryOwners: unused, checkRepositoryOwner: unused,
    gitHubRepositoryCreationStatus: unused, startGitHubRepositoryCreation: unused,
    resumeGitHubRepositoryCreation: unused, pauseGitHubRepositoryCreation: unused, scanProvider: unused, attachLocalSourceEnvironment: unused,
  };
  return new Function(...Object.keys(bindings), `"use strict"; return (${contextSource.slice(start, end).trim()})();`)(...Object.values(bindings));
}

for (const phase of ['handle-registry', 'provider-handle-registry', 'identity', 'update', 'mirror', 'transaction-pending']) {
  test(`UI recovery corrections: composed reconnect preserves non-source ${phase} errors and causes`, async () => {
    const cause = new Error('Original non-source cause');
    const failure = Object.assign(new Error(`Owned ${phase} failure`, { cause }), {
      code: phase === 'identity' ? 'NATIVE_SOURCE_RETARGET' : phase === 'transaction-pending' ? 'TRANSACTION_PENDING'
        : phase === 'provider-handle-registry' ? 'REGISTRY_UNAVAILABLE' : 'REGISTRY_CONFLICT',
    });
    const environment = { ...clone(original), source: { kind: 'local', folderName: 'original-folder', localPath: 'C:\\synthetic\\original-folder' } };
    const before = clone(environment);
    const calls = [];
    let reads = 0;
    const handle = {
      kind: 'directory', name: 'original-folder',
      queryPermission: async () => { calls.push('permission'); return 'granted'; },
    };
    const registry = {
      async getHandle(id) {
        assert.equal(id, environment.id);
        calls.push(`handle-${++reads}`);
        if (phase === 'handle-registry' || phase === 'provider-handle-registry' && reads === 2) throw failure;
        return handle;
      },
      async reconnectEnvironment(id, selected, localPath) {
        calls.push('reconnect');
        assert.equal(id, environment.id);
        assert.equal(selected, handle);
        assert.equal(localPath, environment.source.localPath);
        if (phase === 'identity') throw failure;
      },
      async updateEnvironment() {
        calls.push('update');
        if (phase === 'update' || phase === 'transaction-pending') throw failure;
        return environment;
      },
      setActive: () => assert.fail('Failed recovery must not become active'),
    };
    const activation = createWorkspaceActivation({
      registry, sync: { syncRegistryMetadata: async () => { calls.push('mirror'); throw failure; } },
      providers: { create: createProvider }, connections: {},
      scan: async (provider) => {
        calls.push('scan');
        assert.equal(provider.root, handle);
        return { compatibility: 'supported' };
      },
    });
    const previous = { environment: clone(other) };
    activation.acceptWorkspace(previous);
    const actions = composedActions(activation, registry);
    await assert.rejects(actions.reconnectEnvironment(environment), (error) => {
      assert.equal(error, failure);
      assert.equal(error.cause, cause);
      assert.equal(error.sourceUnavailable, undefined);
      return true;
    });
    assert.equal(activation.activeWorkspace(), previous);
    assert.deepEqual(environment, before);
    const expected = phase === 'handle-registry' ? ['handle-1']
      : phase === 'identity' ? ['handle-1', 'reconnect']
        : phase === 'provider-handle-registry' ? ['handle-1', 'reconnect', 'handle-2']
          : ['handle-1', 'reconnect', 'handle-2', 'permission', 'scan', 'update', ...(phase === 'mirror' ? ['mirror'] : [])];
    assert.deepEqual(calls, expected, 'Rejected registry resolution must precede permission, source scanning and publication');
  });
}

for (const name of ['NotFoundError', 'AbortError']) {
  test(`UI recovery corrections: real provider registry ${name} is not classified by its source-like name or code`, async () => {
    const cause = new Error('Original retained-handle registry cause');
    const failure = Object.assign(new Error('Retained-handle registry lookup failed', { cause }), {
      name, code: name === 'NotFoundError' ? 'ENOENT' : 'ABORT_ERR', alias: 'registry-handle-record',
    });
    const environment = { ...clone(original), source: { kind: 'local', folderName: 'original-folder', localPath: 'C:\\synthetic\\original-folder' } };
    const handle = {
      kind: 'directory', name: 'original-folder',
      queryPermission: () => assert.fail('A registry lookup failure must not request source permission'),
    };
    let reads = 0, reconnects = 0;
    const registry = {
      async getHandle(id) {
        assert.equal(id, environment.id);
        if (++reads === 2) throw failure;
        return handle;
      },
      async reconnectEnvironment(id, selected) {
        assert.equal(id, environment.id);
        assert.equal(selected, handle);
        reconnects++;
      },
      updateEnvironment: () => assert.fail('A registry lookup failure must not publish source success'),
      setActive: () => assert.fail('A registry lookup failure must not activate the workspace'),
    };
    const activation = createWorkspaceActivation({
      registry, providers: { create: createProvider }, connections: {},
      sync: { syncRegistryMetadata: () => assert.fail('A registry lookup failure must not mirror metadata') },
      scan: () => assert.fail('A registry lookup failure must not scan the source'),
    });
    await assert.rejects(composedActions(activation, registry).reconnectEnvironment(environment), (error) => {
      assert.equal(error, failure);
      assert.equal(error.cause, cause);
      assert.equal(error.name, name);
      assert.equal(error.alias, 'registry-handle-record');
      assert.equal(error.sourceUnavailable, undefined);
      return true;
    });
    assert.equal(reads, 2);
    assert.equal(reconnects, 1);
    assert.equal(activation.currentWorkspace(), null);
  });
}

for (const action of ['openEnvironment', 'reconnectEnvironment']) {
  test(`UI recovery corrections: real provider missing retained handle during ${action} keeps folder-permission guidance`, async () => {
    const environment = { ...clone(original), source: { kind: 'local', folderName: 'original-folder', localPath: 'C:\\synthetic\\original-folder' } };
    const before = clone(environment);
    const handle = {
      kind: 'directory', name: 'original-folder',
      queryPermission: () => assert.fail('Missing retained handle must not request permission'),
    };
    const calls = [];
    const registry = {
      async getHandle() {
        calls.push('handle');
        return action === 'reconnectEnvironment' && calls.length === 1 ? handle : null;
      },
      async reconnectEnvironment(id, selected) {
        assert.equal(id, environment.id);
        assert.equal(selected, handle);
        calls.push('reconnect');
      },
      updateEnvironment: () => assert.fail('Missing retained handle must not publish source success'),
      setActive: () => assert.fail('Missing retained handle must not activate the workspace'),
    };
    const activation = createWorkspaceActivation({
      registry, providers: { create: createProvider }, connections: {},
      sync: { syncRegistryMetadata: () => assert.fail('Missing retained handle must not mirror metadata') },
      scan: () => assert.fail('Missing retained handle must not scan the source'),
    });
    await assert.rejects(composedActions(activation, registry)[action](environment), (error) => {
      assert.match(error.message, /Reconnect the original folder/);
      assert.equal(error.sourceUnavailable.kind, 'permission');
      assert.match(error.sourceUnavailable.guidance, /original browser-selected folder/);
      assert.deepEqual(Object.keys(error.sourceUnavailable).sort(), ['guidance', 'kind', 'message']);
      assert(Object.values(error.sourceUnavailable).every((value) => typeof value === 'string'));
      return true;
    });
    assert.deepEqual(calls, action === 'openEnvironment' ? ['handle'] : ['handle', 'reconnect', 'handle']);
    assert.deepEqual(environment, before);
    assert.equal(activation.currentWorkspace(), null);
  });
}

for (const phase of ['picker', 'permission', 'source-read']) {
  test(`UI recovery corrections: composed ${phase} I/O retains the original error and plain recovery payload`, async () => {
    const failure = Object.assign(new Error('Original source I/O message', { cause: new Error('Original I/O cause') }), {
      name: phase === 'source-read' ? 'NotFoundError' : 'NotAllowedError', alias: 'bicep/infra/main.bicepparam',
    });
    const cause = failure.cause;
    const environment = { ...clone(original), source: { kind: 'local', folderName: 'original-folder', localPath: 'C:\\synthetic\\original-folder' } };
    const handle = {
      kind: 'directory', name: 'original-folder',
      async queryPermission() { if (phase === 'permission') throw failure; return 'granted'; },
      async getDirectoryHandle(_name, options) {
        assert.deepEqual(options, { create: false }, 'Missing source content must not be recreated');
        throw failure;
      },
    };
    const registry = {
      getHandle: async () => phase === 'picker' ? null : handle,
      reconnectEnvironment: async () => {},
      updateEnvironment: () => assert.fail('Source I/O failed before publication'),
    };
    const activation = createWorkspaceActivation({
      registry, sync: {}, connections: {},
      providers: { create: createProvider },
      scan: async (provider) => provider.read(failure.alias),
    });
    const previous = globalThis.showDirectoryPicker;
    globalThis.showDirectoryPicker = async () => { throw failure; };
    try {
      await assert.rejects(composedActions(activation, registry).reconnectEnvironment(environment), (error) => {
        assert.equal(error, failure);
        assert.equal(error.cause, cause);
        assert.equal(error.sourceUnavailable.kind, phase === 'source-read' ? 'missing-file' : 'permission');
        assert.deepEqual(Object.keys(error.sourceUnavailable).sort(), ['guidance', 'kind', 'message', 'path']);
        assert(Object.values(error.sourceUnavailable).every((value) => typeof value === 'string'));
        return true;
      });
    } finally { globalThis.showDirectoryPicker = previous; }
  });
}

test('UI recovery corrections: direct catalog activation blocks only the pending workspace', async () => {
  const opened = [];
  const actions = composedActions({ openEnvironment: async (environment) => { opened.push(environment.id); return environment; } }, {}, {
    pending: (id) => id === original.id ? { environmentId: id } : null,
  });
  await assert.rejects(actions.openEnvironment(original), { code: 'REATTACH_SYNC_PENDING' });
  assert.equal(await actions.openEnvironment(other), other);
  assert.deepEqual(opened, [other.id]);
});

test('UI recovery corrections: local display-path validation is not a source failure', async () => {
  const registry = {
    getHandle: async () => ({ name: 'original-folder' }),
    reconnectEnvironment: () => assert.fail('Invalid display path must not reconnect'),
  };
  await assert.rejects(composedActions({}, registry).reconnectEnvironment({
    ...clone(original), source: { kind: 'local', folderName: 'original-folder', localPath: 'not-absolute' },
  }), (error) => {
    assert.match(error.message, /absolute/);
    assert.equal(error.sourceUnavailable, undefined);
    return true;
  });
});

test('UI recovery corrections: native picker cancellation remains an unannotated no-write outcome', async () => {
  const failure = Object.assign(new Error('Cancelled picker'), { name: 'AbortError' });
  const previous = globalThis.showDirectoryPicker;
  globalThis.showDirectoryPicker = async () => { throw failure; };
  try {
    await assert.rejects(composedActions({}, {
      getHandle: async () => null,
      reconnectEnvironment: () => assert.fail('Cancelled selection must not reconnect'),
    }).reconnectEnvironment({ ...clone(original), source: { kind: 'local', folderName: 'original-folder' } }), (error) => {
      assert.equal(error, failure);
      assert.equal(error.sourceUnavailable, undefined);
      return true;
    });
  } finally { globalThis.showDirectoryPicker = previous; }
});

const dom = installDom();
let frames = [];
const all = (node) => [node, ...node.children.flatMap(all)];
const button = (node, label) => all(node).find((entry) => entry.tagName === 'BUTTON' && readText(entry) === label);
const flush = async () => { await turn(); for (const frame of frames.splice(0)) frame(); };
beforeEach(() => {
  closeDialog();
  dom.root.replaceChildren(dom.modal);
  document.activeElement = dom.root;
  frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
});

for (const [mode, dismiss, pendingApi] of [['reject', 'button', true], ['lost', 'escape', false]]) {
  test(`UI recovery corrections: ${dismiss} close preserves ${mode} pending recovery through refresh and catalog recreation`, async () => {
    const f = fixture({ mode });
    const container = dom.node('main');
    dom.root.append(container);
    const opened = [], callbacks = [];
    const actions = {
      listProjects: async () => [{ id: original.projectId, label: 'Retained project' }],
      listEnvironments: async () => [clone(f.state.local), clone(other)],
      listConnections: async () => ({ profiles: [profile], vault: { available: false } }),
      listActivity: async () => [], hasHandle: async () => false,
      useConnection: async () => ({ profileId: profile.id }),
      reviewReattachment: f.recovery.review, commitReattachment: f.recovery.commit, revalidateReattachment: f.recovery.revalidate,
      ...(pendingApi ? { pendingReattachment: f.recovery.pending } : {}),
      openEnvironment: async (environment) => { opened.push(environment.id); return { environment }; },
    };
    const options = { container, actions, sessions: { subscribe(callback) { callbacks.push(callback); return () => {}; } } };
    const first = presentWorkspaceCatalog(options);
    await flush();
    button(container, 'Reattach connection').click();
    await flush();
    const choice = document.getElementById('workspace-reattach-connection');
    choice.value = profile.id;
    choice.dispatch('change');
    const consent = document.getElementById('workspace-reattach-consent');
    consent.checked = true;
    consent.dispatch('change');
    button(dom.modal, 'Validate connection and source').click();
    await flush();
    button(dom.modal, 'Reattach this workspace').click();
    await flush();
    const pending = f.recovery.pending(original.id);
    assert(pending);
    if (dismiss === 'escape') dom.modal.dispatch('keydown', { key: 'Escape' });
    else button(dom.modal, 'Close with pending reattachment').click();
    await flush();
    for (let refresh = 0; refresh < 2; refresh++) {
      const primary = document.getElementById(`catalog-workspace-${original.id}-primary`);
      assert.equal(readText(primary), 'Review pending reattachment');
      assert.match(readText(primary.closest('tr').children[6]), /Confirmation pending/);
      callbacks.at(-1)();
      await flush();
    }
    document.getElementById(`catalog-workspace-${other.id}-primary`).click();
    assert.equal((await first).environment.id, other.id);
    assert.deepEqual(opened, [other.id]);
    presentWorkspaceCatalog({ ...options, actions: { ...actions } });
    await flush();
    document.getElementById(`catalog-workspace-${original.id}-primary`).click();
    await flush();
    assert.equal(document.getElementById('workspace-reattach-connection'), null, 'The retained review cannot silently choose a different connection');
    assert.match(readText(dom.modal), /Reviewed account/);
    assert.equal(button(dom.modal, 'Back').disabled, true);
    assert.equal(f.recovery.pending(original.id), pending);
    button(dom.modal, 'Revalidate this connection').click();
    await flush();
    assert.notEqual(f.recovery.pending(original.id), pending);
    f.state.mode = 'accept';
    button(dom.modal, 'Retry confirmation').click();
    await flush();
    assert.match(readText(dom.modal), /server confirmed this workspace metadata/);
    dismissDialog(false);
    await flush();
    assert.equal(readText(document.getElementById(`catalog-workspace-${original.id}-primary`)), 'Open');
    assert.equal(f.state.updates, 1);
    assert.equal(f.state.puts.length, mode === 'lost' ? 1 : 2);
    assert.deepEqual(opened, [other.id], 'No pending workspace activation was attempted');
  });
}

test('UI recovery corrections: catalog refresh reopens the owning Actions disclosure before restoring its child', async () => {
  const container = dom.node('main');
  dom.root.append(container);
  let refresh;
  presentWorkspaceCatalog({
    container,
    actions: {
      listProjects: async () => [{ id: original.projectId, label: 'Retained project' }],
      listEnvironments: async () => [clone(other)], listConnections: async () => ({ profiles: [profile] }),
      listActivity: async () => [], hasHandle: async () => false,
    },
    sessions: { subscribe(callback) { refresh = callback; } },
  });
  await flush();
  const id = `catalog-workspace-${other.id}-edit`;
  const previous = document.getElementById(id);
  previous.closest('details').open = true;
  previous.focus();
  refresh();
  await flush();
  const current = document.getElementById(id);
  assert.notEqual(current, previous);
  assert.equal(document.activeElement, current);
  assert.equal(current.closest('details').open, true);
  current.closest('details').dispatch('keydown', { key: 'Escape' });
  assert.equal(document.activeElement.id, `catalog-workspace-${other.id}-actions`);
  assert.equal(current.closest('details').open, false);
  assert.equal(workspaceRow(other, { connections: [profile], pendingReattachment: { environmentId: other.id } }).status, 'pending');
});
