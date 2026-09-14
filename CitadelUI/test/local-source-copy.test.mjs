import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { LocalSourceCopy, assertEmptyImportFolder } from '../web/js/local-source-copy.mjs';
import { createLocalSourceClient } from '../web/js/local-source-client.mjs';
import { scanProvider, attachEnvironment, resolvePendingRemovals } from '../web/js/workspace-context.mjs';
import { validateLocalFolderName, validateLocalSnapshot } from '../shared/repository-snapshot.mjs';
import { localChildDisplayPath } from '../shared/local-path.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { publicSourceFixture } from './_local-source-fixture.mjs';
import { LocalDirectory } from './_local-directory-fixture.mjs';

export async function preparedFixture(files) {
  const fixture = publicSourceFixture({ files });
  const operation = await fixture.prepare();
  assert.equal(operation.state, 'ready', JSON.stringify(operation.error));
  const manifest = fixture.service.manifest(operation.id);
  const snapshot = validateLocalSnapshot(manifest);
  return {
    manifest, snapshot, fixture, operation,
    blobs: new Map(snapshot.files.map((file) => [file.sha, new Uint8Array(Buffer.from(fixture.service.blob(operation.id, file.sha).content, 'base64'))])),
  };
}

const registration = (calls) => async (verified) => {
  assert.equal(verified.scan.compatibility, 'supported');
  calls.push(verified);
  return { projectId: 'project', environment: { id: 'environment', label: 'Development' }, ...verified };
};
const newCopy = (prepared) => new LocalSourceCopy(prepared, { folderName: 'Citadel sample' });

test('local copy: exact snapshot including license, binary, dotfiles and empty files is verified before registering once', async () => {
  const prepared = await preparedFixture(citadelRepositoryFiles({
    LICENSE: 'Synthetic license\r\n', 'assets/data.bin': Buffer.from([0, 255, 13, 10, 254]),
    'empty.txt': '', '.github/ISSUE_TEMPLATE.md': 'issue fixture', '.env.template': 'DISPLAY=example',
  }));
  const parent = new LocalDirectory();
  const copy = newCopy(prepared);
  await copy.chooseFolder(parent);
  assert.equal(parent.children.size, 0);
  prepared.fixture.unavailable = true;
  const calls = [];
  const progress = [];
  const options = { scan: scanProvider, attach: registration(calls), onProgress: (value) => progress.push(value) };
  const first = copy.run(options);
  assert.equal(copy.run(options), first, 'double invocation must share one operation');
  const workspace = await first;
  assert.equal(copy.state, 'complete');
  assert.equal(workspace.handle, copy.root);
  assert.equal(calls.length, 1);
  const actual = copy.root.allFiles().sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(actual, prepared.fixture.github.snapshot(prepared.fixture.github.source, 'citadel-v1')
    .map(({ path, bytes }) => ({ path, bytes: new Uint8Array(bytes) })).sort((a, b) => a.path.localeCompare(b.path)));
  assert(!actual.some((file) => file.path.startsWith('.git/')));
  assert(progress.findIndex((value) => value.phase === 'register') > progress.findIndex((value) => value.phase === 'verify'));
  assert.equal(await copy.run(options), workspace);
  assert.equal(calls.length, 1);
});

test('local copy: hidden or Git entries make a selected folder nonempty, before mutation', async () => {
  for (const path of ['.hidden', '.git/config', 'README.md']) {
    const parent = new LocalDirectory();
    parent.put(path, 'foreign');
    await assert.rejects(assertEmptyImportFolder(parent), { code: 'LOCAL_IMPORT_NOT_EMPTY' });
    assert.equal(parent.owner.trace.some((event) => /^create/.test(event.operation)), false);
    assert.equal(parent.allFiles().length, 1);
  }
});

test('local copy: rechecks emptiness after selection and source bytes before any mutation', async () => {
  const prepared = await preparedFixture();
  const parent = new LocalDirectory();
  const copy = newCopy(prepared);
  await copy.chooseFolder(parent);
  parent.put('.late', 'foreign');
  await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }), { code: 'LOCAL_IMPORT_NOT_EMPTY' });
  assert.equal(parent.children.size, 1);
  const empty = new LocalDirectory();
  const corrupt = newCopy(prepared);
  await corrupt.chooseFolder(empty);
  prepared.blobs.set(prepared.snapshot.files[0].sha, new Uint8Array([0]));
  await assert.rejects(corrupt.run({ scan: scanProvider, attach: registration([]) }), { code: 'LOCAL_IMPORT_HASH_MISMATCH' });
  assert.equal(empty.children.size, 0);
});

test('local copy: pause retains attributable files; retry continues unchanged files without new source reads', async () => {
  const prepared = await preparedFixture();
  const copy = newCopy(prepared);
  const parent = new LocalDirectory();
  await copy.chooseFolder(parent);
  const calls = [];
  let paused = false;
  await assert.rejects(copy.run({
    scan: scanProvider, attach: registration(calls),
    onProgress: (value) => {
      if (!paused && value.phase === 'copy' && value.completed === 2) { paused = true; copy.cancel(); }
    },
  }), { code: 'LOCAL_IMPORT_CANCELLED' });
  assert.equal(calls.length, 0);
  assert.equal(copy.root.allFiles().length, 2);
  const writes = parent.owner.trace.filter((entry) => entry.operation === 'write').map((entry) => entry.path);
  prepared.fixture.unavailable = true;
  await copy.run({ scan: scanProvider, attach: registration(calls) });
  assert.equal(calls.length, 1);
  for (const path of writes) assert.equal(parent.owner.trace.filter((entry) => entry.operation === 'write' && entry.path === path).length, 1);
});

test('local copy: write failure aborts unpublished bytes and can retry, while permission loss stays explicit', async () => {
  const copy = newCopy(await preparedFixture());
  const parent = new LocalDirectory();
  await copy.chooseFolder(parent);
  let denied = false;
  parent.owner.before = (event) => {
    if (!denied && event.operation === 'write') {
      denied = true;
      throw new DOMException('Disk is full', 'QuotaExceededError');
    }
  };
  await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }), /Disk is full/);
  assert.equal(copy.root.allFiles()[0].bytes.length, 0, 'failed staging must not publish');
  parent.owner.before = null;
  parent.owner.permission = 'denied';
  await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }), { code: 'LOCAL_IMPORT_PERMISSION' });
  parent.owner.permission = 'granted';
  await copy.run({ scan: scanProvider, attach: registration([]) });
  assert.equal(copy.state, 'complete');
});

for (const variant of ['foreign file', 'edited owned file', 'replaced directory', 'replaced root']) {
  test(`local copy: ${variant} blocks retry without overwriting or removing data`, async () => {
    const copy = newCopy(await preparedFixture());
    const parent = new LocalDirectory();
    await copy.chooseFolder(parent);
    await assert.rejects(copy.run({
      scan: scanProvider, attach: registration([]),
      onProgress: (value) => { if (value.phase === 'copy' && value.completed === 1) copy.cancel(); },
    }));
    if (variant === 'foreign file') copy.root.put('foreign.txt', 'foreign bytes');
    if (variant === 'edited owned file') copy.files.values().next().value.handle.change('foreign edits');
    if (variant === 'replaced directory') copy.root.children.set('bicep', new LocalDirectory('bicep', parent.owner));
    if (variant === 'replaced root') parent.children.set(copy.childName, new LocalDirectory(copy.childName, parent.owner));
    const before = parent.allFiles();
    const mutations = parent.owner.trace.filter((entry) => ['write', 'close', 'createFile', 'createDirectory'].includes(entry.operation)).length;
    await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }));
    assert.deepEqual(parent.allFiles(), before);
    assert.equal(parent.owner.trace.filter((entry) => ['write', 'close', 'createFile', 'createDirectory'].includes(entry.operation)).length, mutations);
  });
}

test('local copy: a target appearing between writes or changing during staging is retained, not overwritten', async () => {
  const prepared = await preparedFixture();
  const copy = newCopy(prepared);
  const parent = new LocalDirectory();
  await copy.chooseFolder(parent);
  let injected = false;
  parent.owner.before = ({ operation, handle }) => {
    if (!injected && operation === 'write') {
      injected = true;
      handle.change('created outside during staging');
    }
  };
  await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }), { code: 'LOCAL_IMPORT_CONFLICT' });
  assert.equal(new TextDecoder().decode(copy.root.allFiles()[0].bytes), 'created outside during staging');
  assert.equal(parent.owner.trace.filter((entry) => entry.operation === 'close').length, 0);
});

test('local copy: a lost close response is reconciled by exact content rather than a second write', async () => {
  const copy = newCopy(await preparedFixture());
  const parent = new LocalDirectory();
  await copy.chooseFolder(parent);
  let lost = false;
  parent.owner.afterClose = () => {
    if (!lost) { lost = true; throw new Error('Close acknowledgement lost'); }
  };
  await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }), /acknowledgement lost/);
  const path = parent.owner.trace.find((entry) => entry.operation === 'write').path;
  await copy.run({ scan: scanProvider, attach: registration([]) });
  assert.equal(parent.owner.trace.filter((entry) => entry.operation === 'write' && entry.path === path).length, 1);
});

test('local copy: compatibility or registration failure never reports success and retry registration does not rewrite files', async () => {
  const copy = newCopy(await preparedFixture());
  await copy.chooseFolder(new LocalDirectory());
  const calls = [];
  await assert.rejects(copy.run({ scan: async () => ({ compatibility: 'unsupported' }), attach: registration(calls) }), { code: 'IMPORT_SOURCE_UNSUPPORTED' });
  assert.equal(calls.length, 0);
  await assert.rejects(copy.run({ scan: scanProvider, attach: async () => { throw new Error('Registry unavailable'); } }), /Registry unavailable/);
  assert.notEqual(copy.state, 'complete');
  const writes = copy.parent.owner.trace.filter((entry) => entry.operation === 'write').length;
  await copy.run({ scan: scanProvider, attach: registration(calls) });
  assert.equal(calls.length, 1);
  assert.equal(copy.parent.owner.trace.filter((entry) => entry.operation === 'write').length, writes);
});

test('local transfer: source provenance, encoding and hash are checked before a folder is touched', async () => {
  const prepared = await preparedFixture();
  const { service } = prepared.fixture;
  let corrupt = false;
  const client = createLocalSourceClient(async (path) => {
    if (path.endsWith('/manifest')) return service.manifest(prepared.operation.id);
    const blob = service.blob(prepared.operation.id, path.split('/').at(-1));
    return corrupt ? { ...blob, content: 'AA==' } : blob;
  });
  const result = await client.download(prepared.operation.id, { source: prepared.operation.source });
  assert.equal(result.snapshot.files.length, prepared.snapshot.files.length);
  await assert.rejects(client.download(prepared.operation.id, { source: { ...prepared.operation.source, commit: '0'.repeat(40) } }), { code: 'LOCAL_IMPORT_SOURCE_CHANGED' });
  corrupt = true;
  await assert.rejects(client.download(prepared.operation.id, { source: prepared.operation.source }), { code: 'LOCAL_IMPORT_INVALID_BLOB' });
});

test('local registration: lost mirror response is compensated and unresolved rollback leaves a recovery record, never active success', async () => {
  const projects = [];
  const environments = [];
  const tombstones = { projectIds: [], environmentIds: [] };
  let active = 'previous-workspace';
  const registry = {
    createProject: async (label) => { const value = { id: randomUUID(), label }; projects.push(value); return value; },
    addEnvironment: async (projectId, label) => { const value = { id: randomUUID(), projectId, label }; environments.push(value); return value; },
    updateEnvironment: async (id, patch) => Object.assign(environments.find((item) => item.id === id), patch),
    removeEnvironment: async (id) => { environments.splice(environments.findIndex((item) => item.id === id), 1); },
    removeProject: async (id) => { projects.splice(projects.findIndex((item) => item.id === id), 1); },
    setActive: () => { active = 'new-workspace'; },
    active: () => ({ projectId: 'previous-project', environmentId: 'previous-workspace' }),
    addTombstones: (value) => { tombstones.projectIds.push(...value.projectIds); tombstones.environmentIds.push(...value.environmentIds); },
    removeTombstones: () => { tombstones.projectIds = []; tombstones.environmentIds = []; },
  };
  const mirrors = [];
  await assert.rejects(attachEnvironment({
    projectLabel: 'New local', environmentLabel: 'Development', handle: new LocalDirectory(), localPath: 'C:\\source',
    scan: { compatibility: 'supported', catalog: {}, fingerprint: 'fixture' },
    registry, recoverMirror: true,
    mirror: async (removals) => { mirrors.push(removals); throw new Error('Lost registry response'); },
  }), { code: 'LOCAL_IMPORT_REGISTRY_PENDING' });
  assert.equal(projects.length, 0);
  assert.equal(environments.length, 0);
  assert.equal(tombstones.projectIds.length, 1);
  assert.equal(tombstones.environmentIds.length, 1);
  assert.deepEqual(mirrors[1].removedEnvironmentIds, tombstones.environmentIds);
  assert.equal(active, 'previous-workspace');
});

test('local destination: names are validated verbatim and an existing empty child is never adopted', async () => {
  for (const name of ['', null, '.', '..', '.git', '.azure', '.env.test', 'x'.repeat(161), 'NUL.txt', 'CONIN$', 'COM\u00b9', 'nested/folder', 'nested\\folder', 'file:stream', 'trailing.', ' Leading', 'trailing ', 'fullwidth\uff0fseparator']) {
    assert.throws(() => validateLocalFolderName(name), { code: 'LOCAL_IMPORT_INVALID_FOLDER_NAME' }, String(name));
  }
  assert.equal(validateLocalFolderName('My Citadel Project'), 'My Citadel Project');
  assert.throws(() => localChildDisplayPath('C:\\' + 'a'.repeat(1020), 'child'), /at most 1024/);
  assert.throws(() => localChildDisplayPath('C:\\bad\npath', 'child'), /control characters/);
  const copy = newCopy(await preparedFixture());
  const parent = new LocalDirectory();
  await copy.chooseFolder(parent);
  await parent.getDirectoryHandle(copy.childName, { create: true });
  const mutations = parent.owner.trace.filter((event) => /^create|write|close/.test(event.operation)).length;
  await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }), { code: 'LOCAL_IMPORT_NOT_EMPTY' });
  assert.equal(copy.root, null);
  assert.equal(parent.children.size, 1);
  assert.equal(parent.owner.trace.filter((event) => /^create|write|close/.test(event.operation)).length, mutations);
});

test('local destination: the final child lookup detects a folder created after the parent emptiness check', async () => {
  const copy = newCopy(await preparedFixture());
  const parent = new LocalDirectory();
  await copy.chooseFolder(parent);
  parent.owner.before = ({ operation, path }) => {
    if (operation === 'getDirectory' && path === copy.childName) {
      parent.children.set(copy.childName, new LocalDirectory(copy.childName, parent.owner));
    }
  };
  await assert.rejects(copy.run({ scan: scanProvider, attach: registration([]) }), { code: 'LOCAL_IMPORT_DESTINATION_EXISTS' });
  assert.equal(copy.root, null);
  assert.equal(parent.owner.trace.some((event) => /^create|write|close/.test(event.operation)), false);
});

function recoveryRegistry() {
  const state = {
    projects: [], environments: [], pending: { projectIds: [], environmentIds: [] },
    selected: { projectId: 'old-project', environmentId: 'old-workspace' },
    failRemoval: false, failRecord: false, failRetirement: false, failActivation: false,
  };
  const registry = {
    state,
    active: () => state.selected,
    setActive: (projectId, environmentId) => {
      state.selected = { projectId, environmentId };
      if (state.failActivation) { state.failActivation = false; throw new Error('Selection acknowledgement failed'); }
    },
    clearRetainedSelection: () => { state.selected = null; },
    createProject: async (label) => { const project = { id: randomUUID(), label }; state.projects.push(project); return project; },
    addEnvironment: async (projectId, label) => { const environment = { id: randomUUID(), projectId, label }; state.environments.push(environment); return environment; },
    updateEnvironment: async (id, updates) => Object.assign(state.environments.find((item) => item.id === id), updates),
    removeEnvironment: async (id) => {
      if (state.failRemoval) throw new Error('IndexedDB unavailable');
      state.environments = state.environments.filter((item) => item.id !== id);
      if (state.selected?.environmentId === id) state.selected = null;
    },
    removeProject: async (id) => {
      if (state.failRemoval) throw new Error('IndexedDB unavailable');
      state.projects = state.projects.filter((item) => item.id !== id);
    },
    tombstones: () => structuredClone(state.pending),
    addTombstones: (pending) => {
      if (state.failRecord) throw new Error('Recovery storage unavailable');
      state.pending = structuredClone(pending);
    },
    removeTombstones: (pending) => {
      if (state.failRetirement) return false;
      state.pending.projectIds = state.pending.projectIds.filter((id) => !pending.projectIds.includes(id));
      state.pending.environmentIds = state.pending.environmentIds.filter((id) => !pending.environmentIds.includes(id));
      return true;
    },
  };
  return registry;
}

for (const failRecord of [false, true]) {
  test(`local registration: same-dialog recovery removes stale local records before a retry (failed recovery persistence: ${failRecord})`, async () => {
    const registry = recoveryRegistry();
    registry.state.failRemoval = true;
    registry.state.failRecord = failRecord;
    let pending = null;
    let mirrors = 0;
    await assert.rejects(attachEnvironment({
      registry, recoverMirror: true, onRecovery: (value) => { pending = value; },
      projectLabel: 'New local', environmentLabel: 'Development', handle: new LocalDirectory(), localPath: 'C:\\source',
      scan: { compatibility: 'supported', catalog: {}, fingerprint: 'fixture' },
      mirror: async () => { mirrors++; throw new Error('Lost registry response'); },
    }), { code: 'LOCAL_IMPORT_REGISTRY_PENDING' });
    assert.equal(mirrors, 2, 'remote compensation must still be attempted when IndexedDB removal fails');
    assert(pending.projectIds.length && pending.environmentIds.length);
    assert.equal(registry.state.projects.length, 1);
    registry.state.failRemoval = false;
    registry.state.failRecord = false;
    const resolved = await resolvePendingRemovals({
      registry, pending, removeLocal: true, establishAuthority: async () => {},
      mirror: async (removals) => {
        assert.deepEqual(registry.state.projects, []);
        assert.deepEqual(registry.state.environments, []);
        assert.deepEqual(removals.removedProjectIds, pending.projectIds);
      },
    });
    assert.equal(resolved.resolved, true);
    assert.deepEqual(registry.state.pending, { projectIds: [], environmentIds: [] });
    assert.deepEqual(registry.state.selected, { projectId: 'old-project', environmentId: 'old-workspace' });
  });
}

test('local registration: recovery retirement failure is explicit; failed activation restores the old selection', async () => {
  const registry = recoveryRegistry();
  registry.state.pending = { projectIds: [randomUUID()], environmentIds: [randomUUID()] };
  registry.state.failRetirement = true;
  const outcome = await resolvePendingRemovals({
    registry, removeLocal: true, establishAuthority: async () => {}, mirror: async () => {},
  });
  assert.equal(outcome.resolved, false);
  assert.match(outcome.message, /retire/);
  registry.state.failRetirement = false;
  registry.state.failActivation = true;
  await assert.rejects(attachEnvironment({
    registry, recoverMirror: true,
    projectLabel: 'New local', environmentLabel: 'Development', handle: new LocalDirectory(), localPath: 'C:\\source',
    scan: { compatibility: 'supported', catalog: {}, fingerprint: 'fixture' }, mirror: async () => {},
  }), /Selection acknowledgement failed/);
  assert.deepEqual(registry.state.projects, []);
  assert.deepEqual(registry.state.environments, []);
  assert.deepEqual(registry.state.selected, { projectId: 'old-project', environmentId: 'old-workspace' });
});

test('local registration: mirror scope contains only new records, not the current project or workspace', async () => {
  for (const useExistingProject of [false, true]) {
    const registry = recoveryRegistry();
    const previousProject = { id: 'old-project', label: 'Existing project' };
    registry.state.projects.push(previousProject);
    const mirrored = [];
    const result = await attachEnvironment({
      registry, recoverMirror: true, project: useExistingProject ? previousProject : null,
      projectLabel: 'New project', environmentLabel: 'New workspace', handle: new LocalDirectory(), localPath: 'C:\\source',
      scan: { compatibility: 'supported', catalog: {}, fingerprint: 'fixture' },
      mirror: async (changes) => mirrored.push(changes),
    });
    assert.deepEqual(mirrored, [{
      createdProjectIds: useExistingProject ? [] : [result.projectId],
      createdEnvironmentIds: [result.environment.id],
    }]);
    assert.equal(previousProject.label, 'Existing project');
  }
});
