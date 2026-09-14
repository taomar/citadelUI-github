import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrySync } from '../web/js/registry-sync.mjs';

function fixture() {
  const snapshot = {
    projects: [{ id: 'p-one', label: 'One' }, { id: 'p-two', label: 'Two' }],
    environments: [
      { id: 'e-one', projectId: 'p-one', label: 'First' },
      { id: 'e-two', projectId: 'p-one', label: 'Second' },
      { id: 'e-three', projectId: 'p-two', label: 'Third' },
    ],
  };
  const state = {
    snapshot, remote: { epoch: 'epoch-one', revision: 4, projects: [], environments: [] },
    pending: { projectIds: [], environmentIds: [] },
  };
  const trace = [], requests = [];
  const registry = {
    async metadataSnapshot() { trace.push('snapshot'); return state.snapshot; },
    async replaceMetadata(value) {
      trace.push('replace');
      if (state.replaceError) throw state.replaceError;
      state.replaced = value;
    },
    tombstones: () => state.pending,
    async removeEnvironment(id) {
      trace.push(`remove-environment:${id}`);
      if (state.removeError) throw state.removeError;
    },
    async removeProject(id) { trace.push(`remove-project:${id}`); },
    clearTombstones() {
      trace.push('clear');
      state.pending = { projectIds: [], environmentIds: [] };
    },
    removeTombstones(value) {
      trace.push('retire');
      if (state.retire === false) return false;
      state.pending = {
        projectIds: state.pending.projectIds.filter((id) => !value.projectIds.includes(id)),
        environmentIds: state.pending.environmentIds.filter((id) => !value.environmentIds.includes(id)),
      };
      return true;
    },
  };
  const request = async (path, options) => {
    requests.push({ path, options, ...(options?.body ? { body: JSON.parse(options.body) } : {}) });
    trace.push(options?.method || 'GET');
    if (!options) {
      if (state.getError) throw state.getError;
      return state.remote;
    }
    if (state.putError) throw state.putError;
    state.remote = { ...state.remote, revision: state.remote.revision + 1 };
    return state.remote;
  };
  return { registry, request, state, trace, requests, sync: createRegistrySync({ registry, request }) };
}

test('R3 registry sync: an unestablished authority rejects before reading or sending metadata', async () => {
  const f = fixture();
  let pending;
  assert.doesNotThrow(() => { pending = f.sync.syncRegistryMetadata(); });
  await assert.rejects(pending, /Registry metadata has not been reconciled/);
  assert.deepEqual(f.trace, []);
  assert.deepEqual(f.requests, []);
});

test('R3 registry sync: a handshake learns authority without replacing local metadata', async () => {
  const f = fixture();
  const remote = f.state.remote;
  assert.equal(await f.sync.establishRegistryAuthority(), remote);
  assert.deepEqual(f.requests, [{ path: '/api/registry', options: undefined }]);
  assert.deepEqual(f.trace, ['GET']);
  assert.equal(f.state.replaced, undefined);
  await f.sync.syncRegistryMetadata();
  assert.deepEqual(f.requests[1].body, {
    expectedEpoch: 'epoch-one', expectedRevision: 4,
    projects: f.state.snapshot.projects, environments: f.state.snapshot.environments,
    removedProjectIds: [], removedEnvironmentIds: [],
  });
});

test('R3 registry sync: reconciliation preserves explicit registry and request overrides', async () => {
  const f = fixture();
  const remote = { epoch: 'override', revision: 17, projects: [], environments: [] };
  const calls = [];
  const target = { replaceMetadata: async (value) => { assert.equal(value, remote); calls.push('replace'); } };
  assert.equal(await f.sync.reconcileRegistryMetadata(target, async (...args) => {
    assert.deepEqual(args, ['/api/registry']); calls.push('GET'); return remote;
  }), remote);
  assert.deepEqual(calls, ['GET', 'replace']);
  assert.deepEqual(f.trace, []);
  await f.sync.syncRegistryMetadata();
  assert.equal(f.requests[0].body.expectedEpoch, 'override');
  assert.equal(f.requests[0].body.expectedRevision, 17);
});

test('R3 registry sync: replacement failure cannot advance the accepted authority', async () => {
  const f = fixture();
  await f.sync.establishRegistryAuthority();
  f.state.remote = { epoch: 'new-epoch', revision: 99 };
  f.state.replaceError = new Error('Local replacement refused');
  await assert.rejects(f.sync.reconcileRegistryMetadata(), (error) => error === f.state.replaceError);
  await f.sync.syncRegistryMetadata();
  assert.equal(f.requests.at(-1).body.expectedEpoch, 'epoch-one');
  assert.equal(f.requests.at(-1).body.expectedRevision, 4);
  assert.deepEqual(f.trace, ['GET', 'GET', 'replace', 'snapshot', 'PUT']);
});

test('R3 registry sync: tombstoned projects and children cannot reappear in the same upsert', async () => {
  const f = fixture();
  const before = structuredClone(f.state.snapshot);
  await f.sync.establishRegistryAuthority();
  await f.sync.syncRegistryMetadata({
    removedProjectIds: ['p-one'], removedEnvironmentIds: ['e-three', 'e-three'],
  });
  assert.deepEqual(f.requests.at(-1).body, {
    expectedEpoch: 'epoch-one', expectedRevision: 4,
    projects: [{ id: 'p-two', label: 'Two' }], environments: [],
    removedProjectIds: ['p-one'], removedEnvironmentIds: ['e-three', 'e-three'],
  });
  assert.deepEqual(f.state.snapshot, before);
});

test('R3 registry sync: a fresh revision still sends only the explicitly scoped records', async () => {
  const f = fixture();
  f.state.remote = { epoch: 'fresh', revision: 800 };
  await f.sync.establishRegistryAuthority();
  await f.sync.syncRegistryMetadata({}, { projectIds: [], environmentIds: ['e-three'] });
  assert.deepEqual(f.requests.at(-1).body, {
    expectedEpoch: 'fresh', expectedRevision: 800, projects: [],
    environments: [{ id: 'e-three', projectId: 'p-two', label: 'Third' }],
    removedProjectIds: [], removedEnvironmentIds: [],
  });
  await f.sync.syncRegistryMetadata({ removedEnvironmentIds: ['e-three'] }, {
    projectIds: [], environmentIds: ['e-three'],
  });
  assert.deepEqual(f.requests.at(-1).body.environments, []);
  assert.equal(f.requests.at(-1).body.expectedRevision, 801);
});

test('R3 registry sync: a failed PUT preserves the last confirmed authority and original error', async () => {
  const f = fixture();
  await f.sync.establishRegistryAuthority();
  f.state.putError = new Error('Unconfirmed registry response');
  await assert.rejects(f.sync.syncRegistryMetadata(), (error) => error === f.state.putError);
  f.state.putError = null;
  await f.sync.syncRegistryMetadata();
  await f.sync.syncRegistryMetadata();
  assert.deepEqual(f.requests.filter((item) => item.body).map((item) => item.body.expectedRevision), [4, 4, 5]);
});

test('R3 registry sync: no pending removals means no handshake, mirror or retirement', async () => {
  const f = fixture();
  assert.deepEqual(await f.sync.resolvePendingRemovals(), { resolved: true });
  assert.deepEqual(f.trace, []);
});

test('R3 registry sync: merged tombstones are mirrored before authoritative replacement', async () => {
  const f = fixture();
  f.state.pending = { projectIds: ['p-one'], environmentIds: ['e-one'] };
  const result = await f.sync.resolvePendingRemovals({
    pending: { projectIds: ['p-one'], environmentIds: ['e-one', 'e-two'] },
  });
  assert.deepEqual(result, {
    resolved: true, pending: { projectIds: ['p-one'], environmentIds: ['e-one', 'e-two'] },
  });
  assert.deepEqual(f.trace, ['GET', 'snapshot', 'PUT', 'clear']);
  assert.deepEqual(f.requests[1].body.projects, [{ id: 'p-two', label: 'Two' }]);
  assert.deepEqual(f.requests[1].body.environments, [{ id: 'e-three', projectId: 'p-two', label: 'Third' }]);
  await f.sync.reconcileRegistryMetadata();
  assert.deepEqual(f.trace, ['GET', 'snapshot', 'PUT', 'clear', 'GET', 'replace']);
});

test('R3 registry sync: failed authority leaves recovery actionable without any upsert', async () => {
  const f = fixture();
  f.state.pending = { projectIds: ['ghost'], environmentIds: [] };
  f.state.getError = new Error('Authority unavailable');
  assert.deepEqual(await f.sync.resolvePendingRemovals(), {
    resolved: false, pending: { projectIds: ['ghost'], environmentIds: [] }, message: 'Authority unavailable',
  });
  assert.deepEqual(f.trace, ['GET']);
  assert.deepEqual(f.state.pending.projectIds, ['ghost']);
});

test('R3 registry sync: Local recovery removes environments then projects before learning authority', async () => {
  const f = fixture();
  f.state.pending = { projectIds: ['p-one'], environmentIds: ['e-one', 'e-two'] };
  assert.equal((await f.sync.resolvePendingRemovals({ removeLocal: true })).resolved, true);
  assert.deepEqual(f.trace, [
    'remove-environment:e-one', 'remove-environment:e-two', 'remove-project:p-one',
    'GET', 'snapshot', 'PUT', 'retire',
  ]);
});

test('R3 registry sync: Local removal and retirement failures remain explicit pending outcomes', async () => {
  const f = fixture();
  f.state.pending = { projectIds: ['p-one'], environmentIds: ['e-one'] };
  f.state.removeError = new Error('Local removal unavailable');
  assert.equal((await f.sync.resolvePendingRemovals({ removeLocal: true })).message, 'Local removal unavailable');
  assert.deepEqual(f.trace, ['remove-environment:e-one']);
  f.state.removeError = null;
  f.state.retire = false;
  const result = await f.sync.resolvePendingRemovals({ removeLocal: true });
  assert.equal(result.resolved, false);
  assert.match(result.message, /could not retire the registration recovery record/);
  assert.deepEqual(f.state.pending, { projectIds: ['p-one'], environmentIds: ['e-one'] });
});

test('R3 registry sync: per-operation recovery adapters do not consume the default registry', async () => {
  const f = fixture();
  const calls = [];
  const target = {
    tombstones: () => ({ projectIds: ['other-project'], environmentIds: [] }),
    clearTombstones: () => calls.push('clear'),
  };
  const result = await f.sync.resolvePendingRemovals({
    registry: target,
    establishAuthority: async () => calls.push('authority'),
    mirror: async (value) => calls.push(value),
  });
  assert.equal(result.resolved, true);
  assert.deepEqual(calls, [
    'authority', { removedEnvironmentIds: [], removedProjectIds: ['other-project'] }, 'clear',
  ]);
  assert.deepEqual(f.trace, []);
});
