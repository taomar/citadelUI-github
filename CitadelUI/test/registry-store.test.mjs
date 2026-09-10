import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RegistryStore } from '../server/registry-store.mjs';
import { WorkspaceRegistry } from '../web/js/registry.mjs';
import {
  attachEnvironment,
  localPathMatchesHandle,
  reconcileRegistryMetadata,
  validateLocalPath,
} from '../web/js/workspace-context.mjs';
import { createEnvironmentOperation } from '../web/js/settings-operation.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { nativeConfiguration, nativeDirectory } from './_native-fixture.mjs';

const timestamp = '2026-08-31T10:00:00.000Z';
const project = {
  id: 'project-one',
  label: 'Citadel rollout',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const environment = {
  id: 'environment-one',
  projectId: project.id,
  label: 'Development',
  folderName: 'citadel-dev',
  localPath: 'C:\\source\\citadel-dev',
  fingerprint: 'a'.repeat(64),
  toolVersion: '1.0.0-local',
  settingsVersion: 2,
  fingerprintVersion: 1,
  compatibility: 'supported',
  createdAt: timestamp,
  updatedAt: timestamp,
  lastOpenedAt: timestamp,
  lastScannedAt: timestamp,
};
const productionEnvironment = {
  ...environment,
  id: 'environment-production',
  label: 'Production',
  folderName: 'citadel-production',
  localPath: 'C:\\source\\citadel-production',
};

/** Registry v3 projection of a v2 fixture, used to assert the migration. */
function migrated(value) {
  const { folderName, localPath, ...rest } = value;
  return { ...rest, source: { kind: 'local', folderName, localPath } };
}

async function authority(store) {
  const current = await store.read();
  return {
    expectedEpoch: current.epoch,
    expectedRevision: current.revision,
  };
}

function request(result) {
  const value = { result };
  queueMicrotask(() => value.onsuccess?.());
  return value;
}

function memoryRegistry() {
  const records = {
    projects: new Map([[project.id, project]]),
    environments: new Map([[environment.id, { ...environment, permission: 'granted' }]]),
    handles: new Map([[environment.id, { kind: 'directory', name: environment.folderName }]]),
    drafts: new Map([[
      `${environment.id}:main`,
      { key: `${environment.id}:main`, environmentId: environment.id, alias: 'main' },
    ]]),
  };
  const storageValues = new Map();
  const storage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, value),
    removeItem: (key) => storageValues.delete(key),
  };
  const registry = new WorkspaceRegistry({
    indexedDB: {},
    storage,
    dbName: 'citadel-ui-qa-memory',
    stateKey: 'citadel-ui-qa-memory.active-context',
  });
  registry.run = async (_names, _mode, callback) =>
    callback({
      objectStore(name) {
        const values = records[name];
        return {
          delete: (key) => values.delete(key),
          get: (key) => request(values.get(key)),
          getAll: () => request([...values.values()]),
          index: (field) => ({ getAll: (key) => request([...values.values()].filter((value) => value[field] === key)) }),
          add(value, key) {
            const id = key ?? value.id ?? value.key;
            if (values.has(id)) throw new Error('Duplicate fixture identity.');
            values.set(id, value);
          },
          put(value, key) {
            values.set(key ?? value.id ?? value.key, value);
          },
        };
      },
    });
  return { records, registry };
}

test('browser registry namespace is injectable for QA isolation', () => {
  const registry = new WorkspaceRegistry({
    indexedDB: {},
    storage: {},
    dbName: 'citadel-ui-qa-run',
    stateKey: 'citadel-ui-qa-run.active-context',
    testMode: true,
    origin: 'http://127.0.0.1:45173',
  });
  assert.equal(registry.dbName, 'citadel-ui-qa-run');
  assert.equal(registry.stateKey, 'citadel-ui-qa-run.active-context');
  assert.throws(
    () => new WorkspaceRegistry({ indexedDB: {}, storage: {}, testMode: true }),
    /isolated Citadel registry namespace/
  );
  assert.throws(
    () => new WorkspaceRegistry({
      indexedDB: {},
      storage: {},
      dbName: 'citadel-ui-qa-run',
      testMode: true,
      origin: 'http://127.0.0.1:4173',
    }),
    /production Citadel origin/
  );
});

test('browser draft lookup resolves the owning stored environment without rewriting legacy identity', async () => {
  const { registry, records } = memoryRegistry();
  assert.equal((await registry.getEnvironment(environment.id)).id, environment.id);
  assert.equal(await registry.getEnvironment('missing'), null);
  await registry.saveDraft(environment.id, 'bicep/infra/main.bicepparam', 'a'.repeat(64),
    [{ op: 'set', path: ['environmentName'], value: 'draft' }]);
  assert.equal((await registry.getDraft(environment.id, 'bicep/infra/main.bicepparam')).operations[0].value, 'draft');
  assert.equal(records.environments.get(environment.id).configuration, undefined);
});

test('native registry admits distinct Local folders, refuses same/overlapping folders and restores only owning handles', async () => {
  const { registry, records } = memoryRegistry();
  records.environments.clear(); records.handles.clear(); records.drafts.clear();
  const folder = nativeDirectory(), child = await folder.getDirectoryHandle('environments');
  const native = await registry.addEnvironment(project.id, 'Native', folder, null, {
    localPath: 'C:\\synthetic\\synthetic-native', configuration: nativeConfiguration(['deployment']),
  });
  await assert.rejects(registry.addEnvironment(project.id, 'Same', folder, null, {
    localPath: 'C:\\display-is-not-authority\\synthetic-native', configuration: createConfiguration('bicep'),
  }), /overlap/);
  await assert.rejects(registry.addEnvironment(project.id, 'Child', child, null, {
    localPath: 'C:\\synthetic\\environments', configuration: createConfiguration('bicep'),
  }), /overlap/);
  const otherFolder = nativeDirectory();
  const other = await registry.addEnvironment(project.id, 'Other', otherFolder, null, {
    localPath: 'C:\\synthetic\\synthetic-native', configuration: nativeConfiguration(['deployment']),
  });
  assert.notEqual(other.id, native.id);
  await assert.rejects(registry.reconnectEnvironment(native.id, otherFolder), /already attached/);
  await registry.reconnectEnvironment(native.id, folder);
  const snapshot = await registry.environmentSnapshot(native.id);
  await assert.rejects(registry.restoreEnvironmentSnapshot({ ...snapshot, handle: otherFolder }), /original owning/);
  const retargeted = structuredClone(snapshot.environment);
  retargeted.configuration.units[0].valueAlias = 'environments/retargeted.tfvars';
  await assert.rejects(registry.restoreEnvironmentSnapshot({ environment: retargeted, handle: folder }), { code: 'CONFIGURATION_RETARGET' });
  records.handles.delete(native.id);
  await assert.rejects(registry.reconnectEnvironment(native.id, folder), /unproven folder/);

  records.environments.clear(); records.handles.clear();
  await registry.addEnvironment(project.id, 'Child first', child, null, {
    localPath: 'C:\\synthetic\\environments', configuration: createConfiguration('bicep'),
  });
  await assert.rejects(registry.addEnvironment(project.id, 'Parent later', folder, null, {
    localPath: 'C:\\synthetic\\synthetic-native', configuration: nativeConfiguration(['deployment']),
  }), /overlap/);
});

test('pending native attachments retain exact identities across restart and distinguish formats, files, branches and adoption', () => {
  const { registry } = memoryRegistry();
  const base = { repositoryId: 99, sourceBranch: 'main', workingBranch: 'work', writeMode: 'working-branch',
    projectId: project.id, connectionProfileId: 'shared-connection', adoptExisting: false };
  const entries = [
    { ...base, configuration: nativeConfiguration(['deployment']) },
    { ...base, configuration: createConfiguration('bicep') },
    { ...base, configuration: nativeConfiguration(['llm']) },
    { ...base, workingBranch: 'another', configuration: nativeConfiguration(['deployment']) },
    { ...base, adoptExisting: true, configuration: nativeConfiguration(['deployment']) },
  ].map((entry, index) => ({ ...entry, operationKey: `attempt-${index}`, environmentId: `pending-${index}` }));
  for (const entry of entries) registry.savePendingAttachment(entry);
  const original = registry.storage.getItem(registry.pendingAttachmentKey);
  for (const change of [{ environmentId: 'foreign' }, { repositoryId: 100 }, { projectId: 'foreign' },
    { workingBranch: 'foreign' }, { adoptExisting: true }, { connectionProfileId: 'foreign' },
    { configuration: nativeConfiguration(['llm']) }, { operationKey: 'foreign' }]) {
    assert.throws(() => registry.savePendingAttachment({ ...entries[0], ...change }));
    assert.equal(registry.storage.getItem(registry.pendingAttachmentKey), original);
  }
  const restarted = new WorkspaceRegistry({ indexedDB: {}, storage: registry.storage, dbName: registry.dbName });
  for (const entry of entries) {
    const pending = restarted.pendingAttachment({ ...entry,
      configuration: entry.configuration.format === 'terraform'
        ? nativeConfiguration(entry.configuration.units.map(({ id, ...unit }) => unit))
        : createConfiguration('bicep') });
    assert.equal(pending.operationKey, entry.operationKey);
    assert.deepEqual(pending.configuration, entry.configuration);
  }
  restarted.clearPendingAttachment(entries[0].operationKey);
  assert.equal(restarted.pendingAttachments().length, 4);
  const future = JSON.stringify([{ ...entries[0], configuration: { ...entries[0].configuration, version: 2 } }]);
  registry.storage.setItem(registry.pendingAttachmentKey, future);
  assert.throws(() => restarted.pendingAttachments(), { code: 'CONFIGURATION_VERSION' });
  assert.equal(registry.storage.getItem(registry.pendingAttachmentKey), future);
  registry.storage.setItem(registry.pendingAttachmentKey, '{damaged');
  assert.throws(() => restarted.pendingAttachments(), /retry data was retained/);
  assert.equal(registry.storage.getItem(registry.pendingAttachmentKey), '{damaged');
  const overlap = JSON.stringify([entries[0], { ...entries[0], operationKey: 'duplicate-environment' }]);
  registry.storage.setItem(registry.pendingAttachmentKey, overlap);
  assert.throws(() => restarted.pendingAttachments(), /identities overlap/);
  assert.equal(registry.storage.getItem(registry.pendingAttachmentKey), overlap);
});

test('server native metadata preserves descriptors across restart and rejects future versions, retargeting and copied identities', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-native-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const native = { ...migrated(environment), id: 'native-metadata', configuration: nativeConfiguration(['deployment']) };
  await store.reconcile({ ...await authority(store), projects: [project], environments: [native] });
  const restarted = new RegistryStore({ dataRoot: root });
  await restarted.initialize();
  assert.deepEqual((await restarted.getEnvironment(native.id)).configuration, native.configuration);
  const path = join(root, 'settings', 'registry.json'), before = await readFile(path);
  await assert.rejects(restarted.reconcile({ ...await authority(restarted), projects: [project],
    environments: [{ ...native, configuration: { ...native.configuration, version: 2 } }] }), { code: 'CONFIGURATION_VERSION' });
  const changed = structuredClone(native);
  changed.configuration.units[0].valueAlias = 'environments/other.tfvars';
  await assert.rejects(restarted.reconcile({ ...await authority(restarted), projects: [project], environments: [changed] }), { code: 'CONFIGURATION_RETARGET' });
  await assert.rejects(restarted.reconcile({ ...await authority(restarted), projects: [project],
    environments: [native, { ...native, id: 'copied-identity', label: 'Another workspace' }] }), { code: 'NATIVE_IDENTITY_OVERLAP' });
  assert.deepEqual(await readFile(path), before);
});

test('profile fields survive reload until the completed profile clears them', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const options = {
    indexedDB: {},
    storage,
    dbName: 'citadel-ui-profile-draft',
    stateKey: 'citadel-ui-profile-draft.active-context',
  };
  const first = new WorkspaceRegistry(options);
  first.saveProfileDraft('setup', {
    projectLabel: 'Citadel rollout',
    environmentLabel: 'Production',
    localPath: 'C:\\source\\citadel-production',
  });

  const reloaded = new WorkspaceRegistry(options);
  assert.deepEqual(reloaded.profileDraft('setup'), {
    projectLabel: 'Citadel rollout',
    environmentLabel: 'Production',
    localPath: 'C:\\source\\citadel-production',
  });
  assert.equal(reloaded.clearProfileDraft('setup'), true);
  assert.equal(first.profileDraft('setup'), null);
});

test('local path validation is display-only and checks the selected folder leaf', () => {
  assert.equal(validateLocalPath('C:\\source\\citadel-dev'), 'C:\\source\\citadel-dev');
  assert.equal(validateLocalPath('/home/user/citadel-dev'), '/home/user/citadel-dev');
  assert.equal(validateLocalPath('\\\\server\\share\\citadel-dev'), '\\\\server\\share\\citadel-dev');
  assert.throws(() => validateLocalPath('relative\\citadel-dev'), /absolute/);
  assert.equal(localPathMatchesHandle('C:\\source\\citadel-dev', 'citadel-dev'), true);
  assert.equal(localPathMatchesHandle('C:\\source\\renamed-alias', 'citadel-dev'), false);
});

test('registry metadata survives a store restart without handles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new RegistryStore({ dataRoot: root });
  await first.initialize();
  await first.reconcile({
    ...await authority(first),
    projects: [project],
    environments: [environment],
  });
  const second = new RegistryStore({ dataRoot: root });
  await second.initialize();
  const persisted = await second.read();
  assert.deepEqual(persisted.projects, [project]);
  assert.deepEqual(persisted.environments, [migrated(environment)]);
  assert.equal(persisted.version, 4);
  const raw = await readFile(join(root, 'settings', 'registry.json'), 'utf8');
  assert.equal(persisted.environments[0].source.localPath, environment.localPath);
  for (const forbidden of ['handle', '.azure', '.env']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
});

test('registry rejects handles, invalid display paths, absolute folder names, and unknown projects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  await assert.rejects(
    store.reconcile({
      ...await authority(store),
      projects: [project],
      environments: [{ ...environment, handle: {} }],
    }),
    (error) => error.code === 'INVALID_REGISTRY_ENVIRONMENT'
  );
  await assert.rejects(
    store.reconcile({
      ...await authority(store),
      projects: [project],
      environments: [{ ...environment, localPath: 'relative\\citadel-dev' }],
    }),
    (error) => error.code === 'INVALID_LOCAL_PATH'
  );
  await assert.rejects(
    store.reconcile({
      ...await authority(store),
      projects: [project],
      environments: [{ ...environment, folderName: 'C:\\source\\citadel' }],
    }),
    (error) => error.code === 'INVALID_FOLDER_NAME'
  );
  await assert.rejects(
    store.reconcile({
      ...await authority(store),
      projects: [],
      environments: [{ ...environment, projectId: 'missing-project' }],
    }),
    (error) => error.code === 'UNKNOWN_REGISTRY_PROJECT'
  );
});

test('a registry written by a newer Citadel UI is refused and left byte-identical', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-future-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'settings', 'registry.json');
  await mkdir(join(root, 'settings'), { recursive: true });
  const future = `${JSON.stringify(
    {
      version: 5,
      epoch: 'future-epoch',
      revision: 7,
      projects: [project],
      environments: [
        {
          ...migrated(environment),
          somethingThisVersionDoesNotKnow: { retained: true },
        },
      ],
    },
    null,
    2
  )}\n`;
  await writeFile(path, future);
  const before = createHash('sha256').update(await readFile(path)).digest('hex');

  const store = new RegistryStore({ dataRoot: root });
  await assert.rejects(
    store.initialize(),
    (error) => error.code === 'REGISTRY_VERSION_UNSUPPORTED'
  );
  await assert.rejects(
    store.read(),
    (error) => error.code === 'REGISTRY_VERSION_UNSUPPORTED'
  );

  // Refusing must not rewrite, downgrade, or drop the unknown field.
  const after = createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(after, before);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(raw.version, 5);
  assert.deepEqual(raw.environments[0].somethingThisVersionDoesNotKnow, { retained: true });
});

test('a v1 registry migrates to the v4 source union', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-v1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'settings'), { recursive: true });
  await writeFile(
    join(root, 'settings', 'registry.json'),
    `${JSON.stringify({
      version: 1,
      epoch: 'legacy-epoch',
      revision: 3,
      projects: [project],
      environments: [environment],
    })}\n`
  );
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const current = await store.read();
  assert.equal(current.version, 4);
  assert.deepEqual(current.environments[0].source, {
    kind: 'local',
    folderName: 'citadel-dev',
    localPath: 'C:\\source\\citadel-dev',
  });
  // The epoch and revision are preserved so a mirror conflict is still detected.
  assert.equal(current.epoch, 'legacy-epoch');
  assert.equal(current.revision, 3);
});

test('a record written before this change loads without crashing', async (t) => {
  // Migration was dropped on the user's instruction: old data does not matter,
  // and if earlier records are wrong they do not mind. The only remaining bar is
  // that such a record must not take the app down. It may need re-attaching; it
  // may describe itself as unknown. It may not throw.
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'settings'), { recursive: true });
  const legacy = {
    kind: 'github',
    connectionProfileId: null,
    repositoryId: 9001,
    fullName: 'taomar/citadelQA',
    sourceBranch: 'CitadelQA',
    workingBranch: 'citadel-ui/d79d23d1-d638-42fd-a0ff-1992dfbfa2eb',
    writeMode: 'working-branch',
    lastKnownHead: null,
    capabilities: null,
    validatedAt: null,
  };
  await writeFile(
    join(root, 'settings', 'registry.json'),
    `${JSON.stringify({
      version: 4,
      epoch: 'live-epoch',
      revision: 7,
      projects: [project],
      environments: [{ ...environment, source: legacy }],
    })}\n`
  );

  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const current = await store.read();
  const found = await store.getEnvironment(environment.id);

  // Loads, and is still identifiable.
  assert.equal(current.environments.length, 1);
  assert.equal(found.source.fullName, 'taomar/citadelQA');
  // Provenance is unknown and is left unknown rather than invented — that is
  // what "no bad data going forward" means for a record nobody can vouch for.
  assert.equal(found.source.branchChoice, undefined);
  // And writing it back is accepted, with the unknown recorded as null rather
  // than guessed.
  const saved = await store.reconcile({
    expectedEpoch: current.epoch,
    expectedRevision: current.revision,
    projects: [project],
    environments: [{ ...environment, source: legacy }],
    removedProjectIds: [],
    removedEnvironmentIds: [],
  });
  assert.equal(saved.environments[0].source.branchChoice, null);
  assert.equal(
    saved.environments[0].source.workingBranch,
    'citadel-ui/d79d23d1-d638-42fd-a0ff-1992dfbfa2eb'
  );
});

test('branch choice cannot contradict the write mode', async (t) => {
  // `writeMode` already answers "is the target the source branch". If
  // `branchChoice` could disagree there would be two records of one fact, and a
  // later reader would have to guess which to believe. Contradiction is refused
  // rather than silently reconciled.
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const base = await store.read();
  const contradiction = (writeMode, branchChoice) =>
    store.reconcile({
      expectedEpoch: base.epoch,
      expectedRevision: base.revision,
      projects: [project],
      environments: [
        {
          ...environment,
          source: {
            kind: 'github',
            repositoryId: 9001,
            fullName: 'taomar/citadelQA',
            sourceBranch: 'CitadelQA',
            workingBranch: writeMode === 'direct' ? 'CitadelQA' : 'citadel-ui/x',
            writeMode,
            branchChoice,
          },
        },
      ],
      removedProjectIds: [],
      removedEnvironmentIds: [],
    });

  await assert.rejects(
    () => contradiction('working-branch', 'selected'),
    (error) => error.code === 'INVALID_REGISTRY_SOURCE'
  );
  await assert.rejects(
    () => contradiction('direct', 'created'),
    (error) => error.code === 'INVALID_REGISTRY_SOURCE'
  );
  await assert.rejects(
    () => contradiction('working-branch', 'invented'),
    (error) => error.code === 'INVALID_REGISTRY_SOURCE'
  );
});

test('QA data roots leave production registry bytes unchanged', async (t) => {
  const productionRoot = await mkdtemp(join(tmpdir(), 'citadel-production-'));
  const qaRoot = await mkdtemp(join(tmpdir(), 'citadel-qa-'));
  t.after(() => Promise.all([
    rm(productionRoot, { recursive: true, force: true }),
    rm(qaRoot, { recursive: true, force: true }),
  ]));
  const production = new RegistryStore({ dataRoot: productionRoot });
  await production.initialize();
  await production.reconcile({
    ...await authority(production),
    projects: [project],
    environments: [environment],
  });
  const productionPath = join(productionRoot, 'settings', 'registry.json');
  const before = createHash('sha256').update(await readFile(productionPath)).digest('hex');

  const qa = new RegistryStore({ dataRoot: qaRoot });
  await qa.initialize();
  await qa.reconcile({
    ...await authority(qa),
    projects: [{ ...project, id: 'qa-project', label: 'QA only' }],
    environments: [{ ...environment, id: 'qa-environment', projectId: 'qa-project' }],
  });

  const after = createHash('sha256').update(await readFile(productionPath)).digest('hex');
  assert.equal(after, before);
  assert.equal((await production.read()).environments[0].label, 'Development');
  assert.equal((await qa.read()).environments[0].label, 'Development');
});

test('empty authoritative registry prunes browser metadata, handles, drafts, and active context', async () => {
  const { records, registry } = memoryRegistry();
  registry.setActive(project.id, environment.id);
  const requests = [];
  await reconcileRegistryMetadata(registry, async (path, options) => {
    requests.push({ path, options });
    return {
      version: 2,
      epoch: 'empty-registry-epoch',
      revision: 0,
      projects: [],
      environments: [],
    };
  });
  assert.deepEqual(requests, [{ path: '/api/registry', options: undefined }]);
  assert.equal(records.projects.size, 0);
  assert.equal(records.environments.size, 0);
  assert.equal(records.handles.size, 0);
  assert.equal(records.drafts.size, 0);
  assert.equal(registry.active(), null);
});

test('attach returns the updated environment and activates only after mirroring', async () => {
  const calls = [];
  const target = {
    createProject: async () => {
      calls.push('create-project');
      return project;
    },
    addEnvironment: async () => {
      calls.push('add-environment');
      return environment;
    },
    updateEnvironment: async (_id, updates) => {
      calls.push('update-environment');
      return { ...environment, ...updates };
    },
    setActive: () => calls.push('set-active'),
    removeEnvironment: async () => calls.push('remove-environment'),
    removeProject: async () => calls.push('remove-project'),
  };
  const result = await attachEnvironment({
    projectLabel: project.label,
    environmentLabel: environment.label,
    localPath: environment.localPath,
    handle: { kind: 'directory', name: environment.folderName },
    provider: { kind: 'provider' },
    scan: {
      compatibility: 'supported',
      fingerprint: environment.fingerprint,
      lastScannedAt: timestamp,
    },
    registry: target,
    mirror: async () => calls.push('mirror'),
  });
  assert.equal(result.environment.id, environment.id);
  assert.equal(result.environment.compatibility, 'supported');
  assert.deepEqual(calls, [
    'create-project',
    'add-environment',
    'update-environment',
    'mirror',
    'set-active',
  ]);
});

test('attach mirror failure rolls back environment and newly created project without activation', async () => {
  const calls = [];
  const target = {
    createProject: async () => project,
    addEnvironment: async () => environment,
    updateEnvironment: async () => environment,
    setActive: () => calls.push('set-active'),
    removeEnvironment: async () => calls.push('remove-environment'),
    removeProject: async () => calls.push('remove-project'),
  };
  await assert.rejects(
    attachEnvironment({
      projectLabel: project.label,
      environmentLabel: environment.label,
      localPath: environment.localPath,
      handle: { kind: 'directory', name: environment.folderName },
      provider: {},
      scan: {
        compatibility: 'supported',
        fingerprint: environment.fingerprint,
        lastScannedAt: timestamp,
      },
      registry: target,
      mirror: async () => {
        calls.push('mirror');
        throw new Error('mirror unavailable');
      },
    }),
    /mirror unavailable/
  );
  assert.deepEqual(calls, ['mirror', 'remove-environment', 'remove-project']);
});

for (const failure of [
  'Registry revision conflict. Reload Settings before retrying.',
  'Registry mirror failed. Check the local Citadel service and retry.',
]) {
  test(`project removal restores metadata, handles, drafts, and active context after ${failure.split('.')[0].toLowerCase()}`, async () => {
    const { records, registry } = memoryRegistry();
    registry.setActive(project.id, environment.id);
    const before = {
      project: records.projects.get(project.id),
      environment: records.environments.get(environment.id),
      handle: records.handles.get(environment.id),
      draft: records.drafts.get(`${environment.id}:main`),
      active: registry.active(),
    };
    const inline = [];
    const global = [];
    const remove = createEnvironmentOperation({
      setInlineStatus: (message, tone) => inline.push({ message, tone }),
      setGlobalStatus: (message, tone) => global.push({ message, tone }),
    });

    await remove('Removing project\u2026', async (onRollback) => {
      const snapshot = await registry.projectSnapshot(project.id);
      onRollback(() => registry.restoreProjectSnapshot(snapshot));
      await registry.removeProject(project.id);
      throw new Error(failure);
    })();

    assert.deepEqual(records.projects.get(project.id), before.project);
    assert.deepEqual(records.environments.get(environment.id), before.environment);
    assert.equal(records.handles.get(environment.id), before.handle);
    assert.deepEqual(records.drafts.get(`${environment.id}:main`), before.draft);
    assert.deepEqual(registry.active(), before.active);
    assert.deepEqual(inline.at(-1), { message: failure, tone: 'error' });
    assert.deepEqual(global.at(-1), { message: failure, tone: 'error' });
  });
}

test('successful project removal deletes only that project local state', async () => {
  const { records, registry } = memoryRegistry();
  registry.setActive(project.id, environment.id);
  const snapshot = await registry.projectSnapshot(project.id);
  assert.equal(snapshot.environments.length, 1);
  assert.equal(snapshot.handles[0].handle, records.handles.get(environment.id));
  assert.equal(snapshot.drafts.length, 1);

  await registry.removeProject(project.id);

  assert.equal(records.projects.size, 0);
  assert.equal(records.environments.size, 0);
  assert.equal(records.handles.size, 0);
  assert.equal(records.drafts.size, 0);
  assert.equal(registry.active(), null);
});

test('stale registry epochs and revisions cannot resurrect deleted metadata', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const initial = await store.read();
  await store.reconcile({
    expectedEpoch: initial.epoch,
    expectedRevision: initial.revision,
    projects: [],
    environments: [],
  });
  await assert.rejects(
    store.reconcile({
      expectedEpoch: initial.epoch,
      expectedRevision: initial.revision,
      projects: [project],
      environments: [environment],
    }),
    (error) => error.code === 'REGISTRY_CONFLICT'
  );
  assert.deepEqual((await store.read()).projects, []);
});

test('production application sources contain no browser QA profile fixtures', async () => {
  const applicationRoot = fileURLToPath(new URL('../', import.meta.url));
  const productionFiles = [];
  for (const directory of ['server', 'shared', 'web']) {
    const root = join(applicationRoot, directory);
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) productionFiles.push(join(entry.parentPath, entry.name));
    }
  }
  const source = (
    await Promise.all(productionFiles.map((path) => readFile(path, 'utf8')))
  ).join('\n');
  for (const forbidden of ['dev-checkout', 'quality-gate', 'release-tree', 'Alpha', 'Beta']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  const transactionSource = await readFile(
    join(applicationRoot, 'server', 'transactions.mjs'),
    'utf8'
  );
  assert.equal(
    transactionSource.includes('localPath'),
    false,
    'transaction and audit layer must not receive localPath'
  );
});

test('saved Development and Production remain visible across container and browser restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-registry-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new RegistryStore({ dataRoot: root });
  await first.initialize();
  await first.reconcile({
    ...await authority(first),
    projects: [project],
    environments: [environment, productionEnvironment],
  });
  const restarted = new RegistryStore({ dataRoot: root });
  await restarted.initialize();
  const durable = await restarted.read();
  assert.deepEqual(
    durable.environments.map((item) => [item.label, item.source.localPath]),
    [
      ['Development', 'C:\\source\\citadel-dev'],
      ['Production', 'C:\\source\\citadel-production'],
    ]
  );

  const retained = memoryRegistry();
  retained.registry.setActive(project.id, environment.id);
  await retained.registry.replaceMetadata(durable);
  assert.deepEqual(
    [...retained.records.environments.values()].map((item) => item.label),
    ['Development', 'Production']
  );
  assert.equal(retained.records.handles.has(environment.id), true);
  assert.equal(retained.records.environments.get(environment.id).permission, 'granted');
  assert.equal(
    retained.records.environments.get(productionEnvironment.id).permission,
    'reconnect-required'
  );
  assert.deepEqual(retained.registry.active(), {
    projectId: project.id,
    environmentId: environment.id,
  });

  const fresh = memoryRegistry();
  for (const values of Object.values(fresh.records)) values.clear();
  await fresh.registry.replaceMetadata(durable);
  assert.deepEqual(
    [...fresh.records.environments.values()].map((item) => [
      item.label,
      item.localPath,
      item.permission,
    ]),
    [
      ['Development', 'C:\\source\\citadel-dev', 'reconnect-required'],
      ['Production', 'C:\\source\\citadel-production', 'reconnect-required'],
    ]
  );
  assert.equal(fresh.records.handles.size, 0);
  assert.equal(fresh.registry.active(), null);
});
