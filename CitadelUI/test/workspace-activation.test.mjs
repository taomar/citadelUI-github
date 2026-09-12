import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createWorkspaceActivation, workspaceActivation } from '../web/js/workspace-activation.mjs';
import { registrySync, workspaceRegistry } from '../web/js/registry-sync.mjs';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import * as contextFacade from '../web/js/workspace-context.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ kind = 'local', configuration } = {}) {
  const handle = { kind: 'directory', name: 'synthetic-root' };
  const environment = {
    id: 'workspace-one', projectId: 'project-one', label: 'One', configuration,
    source: kind === 'local' ? { kind, folderName: handle.name, localPath: 'C:\\synthetic-root' }
      : { kind, repositoryId: 42, fullName: 'synthetic/repo', sourceBranch: 'source', workingBranch: 'chosen', connectionProfileId: 'profile-one' },
  };
  const state = {
    environment, handle, selected: { projectId: environment.projectId, environmentId: environment.id },
    permission: 'granted', connected: true, current: { profileId: 'profile-one' },
    resumed: { account: { profileId: 'profile-one', login: 'synthetic' } },
    scan: { compatibility: 'supported', fingerprint: 'scan-hash', lastScannedAt: '2026-01-02T00:00:00.000Z', catalog: { marker: 'catalog' } },
    mirrors: 0, scans: 0,
  };
  const trace = [];
  const provider = {
    configuration,
    async permission() {
      trace.push(['permission']);
      if (state.permissionError) throw state.permissionError;
      return state.permission;
    },
    async assertWritable(options) { trace.push(['writable', options]); if (state.writeError) throw state.writeError; },
  };
  const registry = {
    active: () => state.selected,
    async listEnvironments(projectId) { trace.push(['environments', projectId]); return state.missing ? [] : [state.environment]; },
    async getHandle(id) { trace.push(['handle', id]); return state.handle; },
    async updateEnvironment(id, patch) {
      trace.push(['update', id, patch]);
      state.environment = { ...state.environment, id, ...patch };
      return state.environment;
    },
    setActive(projectId, environmentId) { trace.push(['select', projectId, environmentId]); state.selected = { projectId, environmentId }; },
    clearRetainedSelection() { trace.push(['clear']); state.selected = null; },
  };
  const providers = {
    local: class {
      constructor(value, options) { trace.push(['local-provider', value, options]); return provider; }
    },
    async create(value, dependencies) { trace.push(['provider', value, dependencies]); return provider; },
  };
  const connections = {
    async status() { trace.push(['status']); if (state.statusError) throw state.statusError; return { connected: state.connected }; },
    reset() { trace.push(['reset-session']); },
    async restore() { trace.push(['restore-session']); if (state.restoreError) throw state.restoreError; return state.current; },
    async resumeProfile(id) { trace.push(['resume', id]); if (state.resumeError) throw state.resumeError; return state.resumed; },
  };
  const sync = { async syncRegistryMetadata() {
    state.mirrors += 1; trace.push(['mirror']);
    await state.mirrorHook?.(state.mirrors);
  } };
  const scan = async (value) => {
    state.scans += 1; trace.push(['scan', value]);
    await state.scanHook?.(state.scans);
    if (state.scanError) throw state.scanError;
    return state.scan;
  };
  return { state, trace, registry, providers, connections, provider,
    activation: createWorkspaceActivation({ registry, sync, providers, connections, scan }) };
}

for (const absent of ['selection', 'environment', 'handle']) {
  test(`R3 workspace activation: missing retained ${absent} never prompts or activates`, async () => {
    const f = fixture();
    if (absent === 'selection') f.state.selected = null;
    if (absent === 'environment') f.state.missing = true;
    if (absent === 'handle') f.state.handle = null;
    assert.equal(await f.activation.retainedWorkspace(), null);
    assert.equal(f.activation.currentWorkspace(), null);
    assert.equal(f.trace.some(([kind]) => ['permission', 'writable', 'mirror', 'select'].includes(kind)), false);
  });
}

for (const permission of ['prompt', 'denied']) {
  test(`R3 workspace activation: retained Local ${permission} permission remains nonprompting`, async () => {
    const f = fixture();
    f.state.permission = permission;
    f.provider.unavailableReason = 'operator must reconnect';
    assert.equal(await f.activation.retainedWorkspace(), null);
    assert.deepEqual(f.trace.map(([kind]) => kind), ['environments', 'handle', 'local-provider', 'permission', 'update']);
    assert.deepEqual(f.trace.at(-1), ['update', 'workspace-one', { permission, unavailableReason: 'operator must reconnect' }]);
  });
}

test('R3 workspace activation: retained native context keeps exact handle, unit identities and scanned catalog', async () => {
  const configuration = createConfiguration('terraform', [{
    area: 'deployment', rootAlias: '', valueAlias: 'environments/development.tfvars',
    syntax: 'hcl-tfvars', allowCreate: false, nonsecret: true,
  }]);
  const f = fixture({ configuration });
  const originalHandle = f.state.handle;
  const result = await f.activation.retainedWorkspace();
  assert.equal(result.handle, originalHandle);
  assert.equal(result.provider, f.provider);
  assert.equal(result.catalog, f.state.scan.catalog);
  assert.equal(result.environment.configuration, configuration);
  assert.equal(result.environment.configuration.units[0], configuration.units[0]);
  assert.equal(f.trace.find(([kind]) => kind === 'local-provider')[2].configuration, configuration);
  assert.deepEqual(f.trace.map(([kind]) => kind), ['environments', 'handle', 'local-provider', 'permission', 'update', 'scan', 'update', 'mirror']);
  assert.equal(f.activation.currentWorkspace(), null, 'startup accepts the result only after this promise returns');
  assert.equal(f.activation.acceptWorkspace(result), result);
  assert.equal(f.activation.activeWorkspace(), result);
});

test('R3 workspace activation: unreachable retained permission records the reason despite mirror failure', async () => {
  const f = fixture();
  f.state.permissionError = new Error('Folder unavailable');
  f.state.mirrorHook = async () => { throw new Error('Mirror also unavailable'); };
  assert.equal(await f.activation.retainedWorkspace(), null);
  assert.deepEqual(f.trace.at(-2), ['update', 'workspace-one', {
    permission: 'reconnect-required', compatibility: 'unavailable', unavailableReason: 'Folder unavailable',
  }]);
  assert.equal(f.state.mirrors, 1);
  assert.equal(f.state.scans, 0);
});

test('R3 workspace activation: unsupported retained scans are mirrored but not activated', async () => {
  const f = fixture();
  f.state.scan.compatibility = 'unsupported';
  assert.equal(await f.activation.retainedWorkspace(), null);
  assert.equal(f.state.environment.compatibility, 'invalid-citadel-root');
  assert.equal(f.state.environment.fingerprint, 'scan-hash');
  assert.equal(f.state.mirrors, 1);
  assert.equal(f.activation.currentWorkspace(), null);
});

test('R3 workspace activation: retained scan failure publishes unavailable metadata without requesting write access', async () => {
  const f = fixture();
  f.state.scanError = new Error('Cannot read source');
  assert.equal(await f.activation.retainedWorkspace(), null);
  assert.deepEqual(f.trace.at(-2), ['update', 'workspace-one', { permission: 'reconnect-required', compatibility: 'unavailable' }]);
  assert.equal(f.trace.some(([kind]) => kind === 'writable'), false);
});

test('R3 workspace activation: failed retained scan mirror preserves the incumbent fallback and thrown error boundary', async () => {
  const f = fixture();
  const mirrorError = new Error('Mirror unavailable');
  f.state.mirrorHook = async (count) => { if (count === 1) throw mirrorError; };
  assert.equal(await f.activation.retainedWorkspace(), null);
  assert.equal(f.state.mirrors, 2);
  assert.equal(f.state.environment.compatibility, 'unavailable');
  f.state.mirrorHook = async () => { throw mirrorError; };
  await assert.rejects(f.activation.retainedWorkspace(), (error) => error === mirrorError);
});

for (const lost of ['disconnected', 'request-error']) {
  test(`R3 workspace activation: retained Git ${lost} resets only the credential view and marks reconnect`, async () => {
    const f = fixture({ kind: 'github' });
    f.state.connected = false;
    if (lost === 'request-error') f.state.statusError = new Error('Status unavailable');
    assert.equal(await f.activation.retainedWorkspace(), null);
    assert.deepEqual(f.trace.map(([kind]) => kind), ['environments', 'status', 'reset-session', 'update']);
    assert.equal(f.state.environment.permission, 'reconnect-required');
    assert.equal(f.state.mirrors, 0);
  });
}

test('R3 workspace activation: retained Git checks live status before provider permission and scanning', async () => {
  const f = fixture({ kind: 'github' });
  const result = await f.activation.retainedWorkspace();
  assert.equal(result.handle, null);
  assert.equal(result.provider, f.provider);
  assert.deepEqual(f.trace.map(([kind]) => kind), ['environments', 'status', 'provider', 'permission', 'update', 'scan', 'update', 'mirror']);
});

test('R3 workspace activation: explicit Local open requests write permission and mirrors before selection', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  f.state.mirrorHook = async () => { entered.resolve(); await release.promise; };
  const pending = f.activation.openEnvironment(f.state.environment);
  await entered.promise;
  assert.equal(f.activation.currentWorkspace(), null);
  assert.equal(f.trace.some(([kind]) => kind === 'select'), false);
  assert.deepEqual(f.trace.find(([kind]) => kind === 'writable')[1], { request: true });
  release.resolve();
  const result = await pending;
  assert.equal(f.activation.activeWorkspace(), result);
  assert.equal(result.handle, f.state.handle);
  assert.equal(result.catalog, f.state.scan.catalog);
  assert.deepEqual(f.trace.map(([kind]) => kind), ['provider', 'writable', 'scan', 'update', 'mirror', 'select', 'handle']);
  assert.equal(await f.trace[0][2].getHandle('workspace-one'), f.state.handle);
});

test('R3 workspace activation: explicit Local permission refusal preserves the previous active object', async () => {
  const f = fixture();
  const previous = { environment: { id: 'previous' } };
  f.activation.acceptWorkspace(previous);
  f.state.writeError = new Error('Write permission refused');
  await assert.rejects(f.activation.openEnvironment(f.state.environment), (error) => error === f.state.writeError);
  assert.equal(f.activation.activeWorkspace(), previous);
  assert.deepEqual(f.trace.map(([kind]) => kind), ['provider', 'writable']);
});

test('R3 workspace activation: explicit Git uses only the selected named connection without Local permission escalation', async () => {
  const f = fixture({ kind: 'github' });
  f.state.current = { profileId: 'different-profile' };
  const result = await f.activation.openEnvironment(f.state.environment);
  assert.equal(result.handle, null);
  assert.deepEqual(f.trace.map(([kind]) => kind), ['restore-session', 'resume', 'provider', 'scan', 'update', 'mirror', 'select']);
  assert.deepEqual(f.trace[1], ['resume', 'profile-one']);
  f.trace.length = 0;
  f.state.current = { profileId: 'profile-one' };
  assert.equal(await f.activation.ensureGitHubSessionFor(f.state.environment.source), f.state.current);
  assert.deepEqual(f.trace, [['restore-session']]);
});

test('R3 workspace activation: unnamed and unavailable connection errors remain actionable before provider creation', async () => {
  const f = fixture({ kind: 'github' });
  await assert.rejects(f.activation.ensureGitHubSessionFor({}), /predates named connections/);
  assert.deepEqual(f.trace, []);
  f.state.current = null;
  f.state.resumeError = new Error('Credential locked');
  await assert.rejects(f.activation.ensureGitHubSessionFor(f.state.environment.source, {
    connections: [{ id: 'profile-one', name: 'Operator account' }],
  }), { message: 'Credential locked Reconnect "Operator account" in GitHub connections, then open this workspace.' });
  assert.equal(f.trace.some(([kind]) => kind === 'provider'), false);
  f.state.resumeError = null;
  f.state.resumed = {};
  await assert.rejects(f.activation.openEnvironment(f.state.environment), /connection was superseded/);
});

for (const sameObject of [false, true]) {
  test(`R3 workspace activation: a delayed open cannot replace a newer selection (same object: ${sameObject})`, async () => {
    const f = fixture();
    const original = f.state.environment;
    const entered = deferred(), release = deferred();
    f.state.scanHook = async (count) => { if (count === 1) { entered.resolve(); await release.promise; } };
    const refused = assert.rejects(f.activation.openEnvironment(original), /superseded by a newer selection/);
    await entered.promise;
    const next = sameObject ? original : { ...original, id: 'workspace-two' };
    const accepted = await f.activation.openEnvironment(next);
    release.resolve();
    await refused;
    assert.equal(f.activation.activeWorkspace(), accepted);
    assert.deepEqual(f.trace.filter(([kind]) => kind === 'select'), [['select', next.projectId, next.id]]);
  });
}

test('R3 workspace activation: clearing navigation invalidates a held open without deleting metadata', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  f.state.scanHook = async () => { entered.resolve(); await release.promise; };
  const refused = assert.rejects(f.activation.openEnvironment(f.state.environment), /superseded/);
  await entered.promise;
  f.activation.clearActiveWorkspace();
  assert.throws(() => f.activation.activeWorkspace(), /No environment is attached/);
  release.resolve();
  await refused;
  assert.equal(f.activation.currentWorkspace(), null);
  assert.equal(f.state.environment.id, 'workspace-one');
  assert.equal(f.trace.some(([kind]) => kind === 'select'), false);
});

test('R3 workspace activation: a delayed older error cannot replace a newer active context', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred(), failure = new Error('Old scan failed');
  f.state.scanHook = async (count) => { if (count === 1) { entered.resolve(); await release.promise; throw failure; } };
  const refused = assert.rejects(f.activation.openEnvironment(f.state.environment), (error) => error === failure);
  await entered.promise;
  const accepted = await f.activation.openEnvironment({ ...f.state.environment, id: 'newer' });
  release.resolve();
  await refused;
  assert.equal(f.activation.activeWorkspace(), accepted);
});

test('R3 workspace activation: reconnect mutates the same object only after mirror and preserves independent pending state', async () => {
  const f = fixture();
  const configuration = createConfiguration('terraform', [{
    area: 'deployment', rootAlias: '', valueAlias: 'environments/development.tfvars',
    syntax: 'hcl-tfvars', allowCreate: false, nonsecret: true,
  }]);
  const current = { projectId: 'p', environment: { id: 'e', configuration }, handle: f.state.handle,
    provider: { marker: 'old' }, catalog: { pending: 'catalog' }, drafts: new Map([['file', 'pending']]) };
  const next = { projectId: 'p', environment: { id: 'e', configuration }, handle: current.handle, provider: { marker: 'new' } };
  const other = { environment: { id: 'other' }, drafts: new Map([['other', 'do not consume']]) };
  f.activation.acceptWorkspace(other);
  const original = { ...current }, gate = deferred(), entered = deferred();
  const pending = f.activation.commitActiveWorkspaceReconnect(current, next, async () => { entered.resolve(); await gate.promise; });
  await entered.promise;
  assert.equal(current.provider, original.provider);
  gate.resolve();
  assert.equal(await pending, current);
  assert.equal(current.provider, next.provider);
  assert.equal(current.environment, next.environment);
  assert.equal(current.environment.configuration.units[0], configuration.units[0]);
  assert.equal(current.handle, original.handle);
  assert.equal(current.catalog, original.catalog);
  assert.equal(current.drafts, original.drafts);
  assert.equal(f.activation.activeWorkspace(), other);
  assert.deepEqual([...other.drafts], [['other', 'do not consume']]);
});

test('R3 workspace activation: mismatched reconnect and failed mirror preserve original context and error timing', async () => {
  const f = fixture();
  const current = { projectId: 'p', environment: { id: 'e' }, provider: {} };
  const next = { projectId: 'p', environment: { id: 'e' }, provider: {} };
  let mirrors = 0, pending;
  assert.doesNotThrow(() => { pending = f.activation.commitActiveWorkspaceReconnect(current, { ...next, projectId: 'other' }, async () => { mirrors++; }); });
  await assert.rejects(pending, /Reconnect context does not match/);
  assert.equal(mirrors, 0);
  const failure = new Error('Mirror refused'), provider = current.provider;
  await assert.rejects(f.activation.commitActiveWorkspaceReconnect(current, next, async () => { throw failure; }), (error) => error === failure);
  assert.equal(current.provider, provider);
});

test('R3 workspace activation: direct service constructors retain facade defaults and explicit overrides', () => {
  const defaultService = new WorkspaceService();
  assert.equal(defaultService.contextProvider, contextFacade.activeWorkspace);
  assert.equal(defaultService.registry, contextFacade.workspaceRegistry);
  assert.throws(() => defaultService.context, /No environment is attached/);
  const current = { environment: { id: 'explicit' }, provider: {} };
  const registry = { marker: 'explicit-registry' }, createProvider = () => current.provider;
  const service = new WorkspaceService({ contextProvider: () => current, registry, createProvider });
  assert.equal(service.context, current);
  assert.equal(service.registry, registry);
  assert.equal(service.createProvider, createProvider);
});

test('R3 workspace activation: facade and API observe the same headless owner across context changes', async (t) => {
  const previous = workspaceActivation.currentWorkspace();
  t.after(() => workspaceActivation.acceptWorkspace(previous));
  assert.equal(contextFacade.workspaceRegistry, workspaceRegistry);
  assert.equal(contextFacade.activeWorkspace, workspaceActivation.activeWorkspace);
  assert.equal(contextFacade.clearActiveWorkspace, workspaceActivation.clearActiveWorkspace);
  assert.equal(contextFacade.commitActiveWorkspaceReconnect, workspaceActivation.commitActiveWorkspaceReconnect);
  assert.equal(contextFacade.syncRegistryMetadata, registrySync.syncRegistryMetadata);
  const { api } = await import('../web/js/api.mjs');
  const service = new WorkspaceService();
  const first = { environment: { id: 'first' }, provider: {} };
  workspaceActivation.acceptWorkspace(first);
  assert.equal(service.context, first);
  assert.equal(contextFacade.activeWorkspace(), first);
  assert.equal((await api.health()).environmentId, 'first');
  const second = { environment: { id: 'second' }, provider: {} };
  workspaceActivation.acceptWorkspace(second);
  assert.equal(service.context, second);
  assert.equal((await api.health()).environmentId, 'second');
  contextFacade.clearActiveWorkspace();
  assert.throws(() => service.context, /No environment is attached/);
  await assert.rejects(api.health(), /No environment is attached/);
});

test('R3 workspace activation: direct service provider defaults retain the registry handle and native binding', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(workspaceRegistry, 'getHandle');
  t.after(() => {
    if (previous) Object.defineProperty(workspaceRegistry, 'getHandle', previous);
    else delete workspaceRegistry.getHandle;
  });
  const calls = [];
  const handle = {
    kind: 'directory', name: 'synthetic-native',
    async queryPermission(options) { calls.push(['permission', options]); return 'granted'; },
    async requestPermission() { throw new Error('Creating a provider must not request permission'); },
  };
  workspaceRegistry.getHandle = async (id) => { calls.push(['handle', id]); return handle; };
  const configuration = createConfiguration('terraform', [{
    area: 'deployment', rootAlias: '', valueAlias: 'environments/development.tfvars',
    syntax: 'hcl-tfvars', allowCreate: false, nonsecret: true,
  }]);
  const service = new WorkspaceService();
  const provider = await service.createProvider({
    id: 'native-workspace', source: { kind: 'local', folderName: handle.name, localPath: 'C:\\synthetic-native' }, configuration,
  });
  assert(provider instanceof BrowserDirectoryProvider);
  assert.equal(provider.root, handle);
  assert.deepEqual(provider.configuration, configuration);
  assert.equal(await provider.permission(), 'granted');
  assert.deepEqual(calls, [['handle', 'native-workspace'], ['permission', { mode: 'readwrite' }]]);
});

test('R3 workspace activation: API supplies all existing service composition ports explicitly', () => {
  const source = readFileSync(new URL('../web/js/api.mjs', import.meta.url), 'utf8');
  const composition = source.slice(source.indexOf('const workspace = new WorkspaceService('), source.indexOf('export const api ='));
  assert.match(composition, /contextProvider:\s*activeWorkspace/);
  assert.match(composition, /registry:\s*workspaceRegistry/);
  assert.match(composition, /createProvider:\s*\(environment\)\s*=>\s*createProvider\(environment,\s*\{/);
  assert.match(composition, /getHandle:\s*\(id\)\s*=>\s*workspaceRegistry\.getHandle\(id\)/);
});
