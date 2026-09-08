const DB_NAME = 'citadel-ui';
const DB_VERSION = 4;
const PROJECTS = 'projects';
const ENVIRONMENTS = 'environments';
const HANDLES = 'handles';
const DRAFTS = 'drafts';
/**
 * Local read-only mirror of the server's connection profiles.
 *
 * The server owns these records: it is the only side that can bind one to a
 * credential. The mirror exists so the catalogue can render a workspace's
 * connection name in the same paint as the workspace itself, instead of showing
 * every row as "unknown connection" until a fetch returns.
 */
const CONNECTIONS = 'connections';
const VIEW_PREFERENCE_KEYS = Object.freeze(['search', 'source', 'status', 'sort', 'direction']);
const PROFILE_DRAFT_FIELDS = Object.freeze({
  projectLabel: 160,
  environmentLabel: 160,
  localPath: 1024,
});

function profileDraftScope(value) {
  const scope = String(value || '');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(scope)) {
    throw new Error('Invalid profile draft scope.');
  }
  return scope;
}

function normalizeProfileDraft(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid profile draft.');
  }
  const unsupported = Object.keys(value).find((key) => !(key in PROFILE_DRAFT_FIELDS));
  if (unsupported) throw new Error(`Unsupported profile draft field: ${unsupported}.`);
  const draft = {};
  for (const [key, maximum] of Object.entries(PROFILE_DRAFT_FIELDS)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > maximum) {
      throw new Error(`Invalid ${key} profile draft value.`);
    }
    draft[key] = value[key];
  }
  return draft;
}

function uuid() {
  return globalThis.crypto.randomUUID();
}

/**
 * Registry v4 tagged source union.
 *
 * `source` is the authority for where an environment's files come from. The
 * flat `folderName` and `localPath` fields are kept on the browser record only
 * as a convenience projection for existing local UI, and are always derived
 * from `source` so the two can never disagree.
 */
export function localSource(folderName, localPath) {
  return {
    kind: 'local',
    folderName: folderName || 'Selected folder',
    localPath: localPath || null,
  };
}

/**
 * Normalise a GitHub source to the v4 shape.
 *
 * The connection-ownership fields are always present, as nulls when unknown. A
 * v3 record migrated forward has no recorded account identity, so it cannot be
 * given a connection here without guessing which credential owns it — that
 * record surfaces as `Reconnect` and is bound on the first reconnection.
 */
export function githubSource(source) {
  const writeMode = source.writeMode || 'working-branch';
  return {
    kind: 'github',
    connectionProfileId: source.connectionProfileId ?? null,
    repositoryId: source.repositoryId,
    fullName: source.fullName,
    sourceBranch: source.sourceBranch,
    // Carried through untouched. A workspace attached before branch naming
    // existed keeps writing exactly where it always has; only the description of
    // how it got there is filled in.
    workingBranch: source.workingBranch,
    writeMode,
    branchChoice: source.branchChoice || null,
    lastKnownHead: source.lastKnownHead ?? null,
    capabilities: Array.isArray(source.capabilities) ? source.capabilities : null,
    validatedAt: source.validatedAt ?? null,
  };
}

export function environmentSourceOf(environment) {
  if (environment?.source?.kind === 'github') return githubSource(environment.source);
  if (environment?.source) return environment.source;
  return localSource(environment?.folderName, environment?.localPath);
}

/** Labels are compared case- and accent-insensitively, as the server does. */
export function labelKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function isGitHubEnvironment(environment) {
  return environmentSourceOf(environment).kind === 'github';
}

/**
 * Human-readable location of an environment's source.
 *
 * Local environments show their display-only path; GitHub environments show the
 * repository and the branch every save commits to, so a write target is never
 * ambiguous in the command bar or a save review.
 */
export function environmentLocation(environment) {
  const source = environmentSourceOf(environment);
  if (source.kind === 'github') {
    return `${source.fullName} @ ${source.workingBranch}`;
  }
  return source.localPath || 'Local path not recorded';
}

function withSourceProjection(environment) {
  const source = environmentSourceOf(environment);
  return {
    ...environment,
    source,
    folderName:
      source.kind === 'local' ? source.folderName : `${source.fullName}@${source.workingBranch}`,
    localPath: source.kind === 'local' ? source.localPath : null,
  };
}

function openDatabase(indexedDB = globalThis.indexedDB, dbName = DB_NAME) {
  if (!indexedDB) throw new Error('IndexedDB is unavailable in this browser.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(ENVIRONMENTS)) {
        const store = db.createObjectStore(ENVIRONMENTS, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: 'key' });
      // v4. Added, never populated here: the server owns these records and the
      // mirror is replaced wholesale on the next fetch.
      if (!db.objectStoreNames.contains(CONNECTIONS)) {
        db.createObjectStore(CONNECTIONS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(storeNames, mode, run, indexedDB, dbName) {
  const db = await openDatabase(indexedDB, dbName);
  try {
    const tx = db.transaction(storeNames, mode);
    const result = await run(tx);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
    return result;
  } finally {
    db.close();
  }
}

export class WorkspaceRegistry {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB || globalThis.indexedDB;
    this.storage = options.storage || globalThis.localStorage;
    this.dbName = options.dbName || DB_NAME;
    const testRuntime = options.testMode || globalThis.__CITADEL_TEST_RUNTIME__;
    const runtimeOrigin = options.origin || globalThis.location?.origin;
    if (testRuntime) {
      if (this.dbName === DB_NAME) {
        throw new Error('Tests must use an isolated Citadel registry namespace.');
      }
      if (runtimeOrigin === 'http://127.0.0.1:4173') {
        throw new Error('Tests must not use the production Citadel origin.');
      }
    }
    this.stateKey = options.stateKey || `${this.dbName}.active-context`;
    this.profileDraftPrefix = options.profileDraftPrefix || `${this.dbName}.profile-draft`;
    this.pendingAttachmentKey = options.pendingAttachmentKey || `${this.dbName}.pending-attachment`;
    this.tombstoneKey = options.tombstoneKey || `${this.dbName}.pending-removals`;
    this.viewPreferenceKey = options.viewPreferenceKey || `${this.dbName}.catalog-view`;
  }

  run(storeNames, mode, callback) {
    return transaction(storeNames, mode, callback, this.indexedDB, this.dbName);
  }

  async listProjects() {
    return this.run([PROJECTS], 'readonly', async (tx) => {
      const rows = await requestResult(tx.objectStore(PROJECTS).getAll());
      return rows.sort((a, b) => a.label.localeCompare(b.label));
    });
  }

  async createProject(label) {
    const value = String(label || '').trim();
    if (!value) throw new Error('Project label is required.');
    const timestamp = new Date().toISOString();
    const project = { id: uuid(), label: value, createdAt: timestamp, updatedAt: timestamp };
    await this.run([PROJECTS], 'readwrite', (tx) => {
      tx.objectStore(PROJECTS).add(project);
    });
    return project;
  }

  async renameProject(id, label) {
    const value = String(label || '').trim();
    if (!value) throw new Error('Project label is required.');
    return this.run([PROJECTS], 'readwrite', async (tx) => {
      const store = tx.objectStore(PROJECTS);
      const project = await requestResult(store.get(id));
      if (!project) throw new Error('Unknown project.');
      const updated = { ...project, label: value, updatedAt: new Date().toISOString() };
      store.put(updated);
      return updated;
    });
  }

  async listEnvironments(projectId = null) {
    return this.run([ENVIRONMENTS], 'readonly', async (tx) => {
      const store = tx.objectStore(ENVIRONMENTS);
      const rows = projectId
        ? await requestResult(store.index('projectId').getAll(projectId))
        : await requestResult(store.getAll());
      return rows.sort((a, b) => a.label.localeCompare(b.label));
    });
  }

  async addEnvironment(projectId, label, handle, fingerprint = null, options = {}) {
    const value = String(label || '').trim();
    if (!value) throw new Error('Environment label is required.');
    if (!handle || handle.kind !== 'directory') throw new Error('A directory must be selected.');
    const localPath = String(options.localPath || '').trim();
    if (!localPath) throw new Error('Local path is required.');
    await this.assertLabelAvailable(projectId, value);
    const duplicate = await this.findSameHandle(handle);
    if (duplicate && !options.allowDuplicate) {
      throw new Error(`This folder is already attached as "${duplicate.label}". Reconnect that profile instead.`);
    }
    const environment = {
      id: uuid(),
      projectId,
      label: value,
      source: localSource(handle.name, localPath),
      folderName: handle.name || 'Selected folder',
      localPath,
      permission: 'prompt',
      compatibility: 'unscanned',
      fingerprint,
      toolVersion: '1.0.0-local',
      settingsVersion: DB_VERSION,
      fingerprintVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: null,
      lastScannedAt: null,
    };
    await this.run([ENVIRONMENTS, HANDLES], 'readwrite', (tx) => {
      tx.objectStore(ENVIRONMENTS).add(environment);
      tx.objectStore(HANDLES).add(handle, environment.id);
    });
    return environment;
  }

  /**
   * Refuse a workspace name already used inside the same project.
   *
   * Enforced here as well as on the server because the catalogue, the command
   * bar and every activity line identify a workspace by its label. Two rows
   * reading "Development" is not a cosmetic problem: it is an unanswerable
   * question about which one a save just went to.
   */
  async assertLabelAvailable(projectId, label, exceptId = null) {
    const wanted = labelKey(label);
    const clash = (await this.listEnvironments(projectId)).find(
      (item) => item.id !== exceptId && labelKey(item.label) === wanted
    );
    if (clash) {
      throw new Error(`This project already has a workspace named "${clash.label}".`);
    }
  }

  /**
   * The workspace already attached for this repository, branch and connection,
   * if there is one.
   *
   * Exposed rather than kept private because the catalogue offers "Open
   * existing" instead of an error: the user asked for that branch, and they
   * already have it.
   */
  async findAttachedGitHubEnvironment(projectId, source) {
    return (
      (await this.listEnvironments()).find(
        (item) =>
          item.source?.kind === 'github' &&
          item.projectId === projectId &&
          (item.source.connectionProfileId ?? null) === (source.connectionProfileId ?? null) &&
          item.source.repositoryId === source.repositoryId &&
          item.source.sourceBranch === source.sourceBranch
      ) || null
    );
  }

  /**
   * Attach a GitHub repository and branch as an environment.
   *
   * No credential, credential session id, or token-derived value is stored. The
   * record holds only the immutable repository id, the name GitHub returned for
   * that id, the branch the user explicitly chose, the head it was validated
   * at, and the id of the connection it was reached through.
   */
  async addGitHubEnvironment(projectId, label, source, options = {}) {
    const value = String(label || '').trim();
    if (!value) throw new Error('Environment label is required.');
    if (source?.kind !== 'github') throw new Error('A GitHub source is required.');
    const normalized = githubSource(source);
    await this.assertLabelAvailable(projectId, value);
    const duplicate = await this.findAttachedGitHubEnvironment(projectId, normalized);
    if (duplicate) {
      throw Object.assign(
        new Error(
          `${normalized.fullName} on ${normalized.sourceBranch} is already attached to this project as "${duplicate.label}". Open it instead.`
        ),
        { code: 'DUPLICATE_ENVIRONMENT_SOURCE', environmentId: duplicate.id }
      );
    }
    const environment = withSourceProjection({
      id: options.id || uuid(),
      projectId,
      label: value,
      source: normalized,
      permission: 'granted',
      compatibility: 'unscanned',
      fingerprint: null,
      toolVersion: '1.0.0-local',
      settingsVersion: DB_VERSION,
      fingerprintVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastOpenedAt: null,
      lastScannedAt: null,
    });
    await this.run([ENVIRONMENTS], 'readwrite', (tx) => {
      tx.objectStore(ENVIRONMENTS).add(environment);
    });
    return environment;
  }

  async updateEnvironment(id, updates) {
    return this.run([ENVIRONMENTS], 'readwrite', async (tx) => {
      const store = tx.objectStore(ENVIRONMENTS);
      const prior = await requestResult(store.get(id));
      if (!prior) throw new Error('Unknown environment.');
      const priorSource = environmentSourceOf(prior);
      const nextSource =
        updates.source ||
        (priorSource.kind === 'local'
          ? localSource(
              updates.folderName ?? priorSource.folderName,
              updates.localPath ?? priorSource.localPath
            )
          : priorSource);
      const next = withSourceProjection({
        ...prior,
        ...updates,
        source: nextSource,
        id: prior.id,
        projectId: prior.projectId,
        updatedAt: new Date().toISOString(),
      });
      store.put(next);
      return next;
    });
  }

  async environmentSnapshot(id) {
    const environments = await this.listEnvironments();
    const environment = environments.find((item) => item.id === id);
    if (!environment) throw new Error('Unknown environment.');
    return { environment, handle: await this.getHandle(id) };
  }

  async restoreEnvironmentSnapshot(snapshot) {
    const { environment, handle } = snapshot || {};
    if (!environment?.id) throw new Error('Invalid environment snapshot.');
    await this.run([ENVIRONMENTS, HANDLES], 'readwrite', (tx) => {
      tx.objectStore(ENVIRONMENTS).put(environment);
      if (handle) tx.objectStore(HANDLES).put(handle, environment.id);
      else tx.objectStore(HANDLES).delete(environment.id);
    });
  }

  async reconnectEnvironment(id, handle, localPath = null) {
    const duplicate = await this.findSameHandle(handle, id);
    if (duplicate) throw new Error(`This folder is already attached as "${duplicate.label}".`);
    await this.run([ENVIRONMENTS, HANDLES], 'readwrite', async (tx) => {
      const envStore = tx.objectStore(ENVIRONMENTS);
      const prior = await requestResult(envStore.get(id));
      if (!prior) throw new Error('Unknown environment.');
      if (environmentSourceOf(prior).kind !== 'local') {
        throw new Error('This environment is a GitHub repository. Reconnect GitHub instead.');
      }
      tx.objectStore(HANDLES).put(handle, id);
      const priorSource = environmentSourceOf(prior);
      envStore.put(
        withSourceProjection({
          ...prior,
          source: localSource(
            handle.name || priorSource.folderName,
            localPath || priorSource.localPath || null
          ),
          permission: 'prompt',
          updatedAt: new Date().toISOString(),
        })
      );
    });
  }

  async removeEnvironment(id) {
    await this.run([ENVIRONMENTS, HANDLES], 'readwrite', (tx) => {
      tx.objectStore(ENVIRONMENTS).delete(id);
      tx.objectStore(HANDLES).delete(id);
    });
    const active = this.active();
    if (active && active.environmentId === id) this.storage?.removeItem(this.stateKey);
  }

  async removeProject(id) {
    await this.run([PROJECTS, ENVIRONMENTS, HANDLES, DRAFTS], 'readwrite', async (tx) => {
      const environmentStore = tx.objectStore(ENVIRONMENTS);
      const environments = (await requestResult(environmentStore.getAll())).filter(
        (environment) => environment.projectId === id
      );
      tx.objectStore(PROJECTS).delete(id);
      const drafts = await requestResult(tx.objectStore(DRAFTS).getAll());
      for (const environment of environments) {
        environmentStore.delete(environment.id);
        tx.objectStore(HANDLES).delete(environment.id);
        for (const draft of drafts) {
          if (draft.environmentId === environment.id) tx.objectStore(DRAFTS).delete(draft.key);
        }
      }
    });
    const active = this.active();
    if (active?.projectId === id) this.storage?.removeItem(this.stateKey);
  }

  async projectSnapshot(id) {
    const snapshot = await this.run(
      [PROJECTS, ENVIRONMENTS, HANDLES, DRAFTS],
      'readonly',
      async (tx) => {
        const project = await requestResult(tx.objectStore(PROJECTS).get(id));
        if (!project) throw new Error('Unknown project.');
        const environments = (await requestResult(tx.objectStore(ENVIRONMENTS).getAll())).filter(
          (environment) => environment.projectId === id
        );
        const environmentIds = new Set(environments.map((environment) => environment.id));
        const handles = await Promise.all(
          environments.map(async (environment) => ({
            environmentId: environment.id,
            handle: await requestResult(tx.objectStore(HANDLES).get(environment.id)),
          }))
        );
        const drafts = (await requestResult(tx.objectStore(DRAFTS).getAll())).filter(
          (draft) => environmentIds.has(draft.environmentId)
        );
        return { project, environments, handles, drafts };
      }
    );
    return { ...snapshot, active: this.active() };
  }

  async restoreProjectSnapshot(snapshot) {
    if (!snapshot?.project?.id) throw new Error('Invalid project snapshot.');
    await this.run(
      [PROJECTS, ENVIRONMENTS, HANDLES, DRAFTS],
      'readwrite',
      (tx) => {
        tx.objectStore(PROJECTS).put(snapshot.project);
        for (const environment of snapshot.environments || []) {
          tx.objectStore(ENVIRONMENTS).put(environment);
        }
        for (const entry of snapshot.handles || []) {
          if (entry.handle) tx.objectStore(HANDLES).put(entry.handle, entry.environmentId);
          else tx.objectStore(HANDLES).delete(entry.environmentId);
        }
        for (const draft of snapshot.drafts || []) {
          tx.objectStore(DRAFTS).put(draft);
        }
      }
    );
    if (snapshot.active) {
      this.setActive(snapshot.active.projectId, snapshot.active.environmentId);
    } else {
      this.storage?.removeItem(this.stateKey);
    }
  }

  async getHandle(id) {
    return this.run([HANDLES], 'readonly', (tx) =>
      requestResult(tx.objectStore(HANDLES).get(id)));
  }

  async rememberMigrationSnapshotTarget(id, handle) {
    if (!/^[a-f0-9-]{36}$/.test(id) || handle?.kind !== 'directory') throw new Error('Invalid migration target identity.');
    await this.run([HANDLES], 'readwrite', (tx) => tx.objectStore(HANDLES).put(handle, `migration-source:${id}`));
  }

  async migrationSnapshotTarget(id) {
    return this.getHandle(`migration-source:${id}`);
  }

  async forgetMigrationSnapshotTarget(id) {
    await this.run([HANDLES], 'readwrite', (tx) => tx.objectStore(HANDLES).delete(`migration-source:${id}`));
  }

  async findSameHandle(handle, exceptId = null) {
    const environments = await this.listEnvironments();
    for (const environment of environments) {
      if (environment.id === exceptId) continue;
      const retained = await this.getHandle(environment.id);
      if (retained && typeof retained.isSameEntry === 'function' && await retained.isSameEntry(handle)) {
        return environment;
      }

    }
    return null;
  }

  async saveDraft(environmentId, alias, sourceHash, operations) {
    const key = `${environmentId}:${alias}`;
    const draft = {
      key,
      environmentId,
      alias,
      sourceHash,
      operations,
      updatedAt: new Date().toISOString(),
    };
    await this.run([DRAFTS], 'readwrite', (tx) => {
      tx.objectStore(DRAFTS).put(draft);
    });
    return draft;
  }

  async getDraft(environmentId, alias) {
    return this.run([DRAFTS], 'readonly', (tx) =>
      requestResult(tx.objectStore(DRAFTS).get(`${environmentId}:${alias}`)));
  }

  async removeDraft(environmentId, alias) {
    await this.run([DRAFTS], 'readwrite', (tx) => {
      tx.objectStore(DRAFTS).delete(`${environmentId}:${alias}`);
    });
  }

  async countDrafts(environmentId) {
    return this.run([DRAFTS], 'readonly', async (tx) => {
      const drafts = await requestResult(tx.objectStore(DRAFTS).getAll());
      return drafts.filter((draft) => draft.environmentId === environmentId).length;
    });
  }

  async replaceMetadata(snapshot) {
    const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
    const environments = Array.isArray(snapshot?.environments) ? snapshot.environments : [];
    const projectIds = new Set(projects.map((project) => project.id));
    const environmentIds = new Set(environments.map((environment) => environment.id));
    await this.run([PROJECTS, ENVIRONMENTS, HANDLES, DRAFTS], 'readwrite', async (tx) => {
      const projectStore = tx.objectStore(PROJECTS);
      const environmentStore = tx.objectStore(ENVIRONMENTS);
      const handleStore = tx.objectStore(HANDLES);
      const draftStore = tx.objectStore(DRAFTS);
      for (const existing of await requestResult(projectStore.getAll())) {
        if (!projectIds.has(existing.id)) projectStore.delete(existing.id);
      }
      for (const existing of await requestResult(environmentStore.getAll())) {
        if (!environmentIds.has(existing.id)) {
          environmentStore.delete(existing.id);
          handleStore.delete(existing.id);
        }
      }
      for (const draft of await requestResult(draftStore.getAll())) {
        if (!environmentIds.has(draft.environmentId)) draftStore.delete(draft.key);
      }
      for (const item of projects) projectStore.put(item);
      for (const item of environments) {
        const existing = await requestResult(environmentStore.get(item.id));
        const source = environmentSourceOf(item);
        environmentStore.put(
          withSourceProjection({
            ...item,
            source,
            // A GitHub environment has no durable credential, so after a restart
            // it is visible but must be reconnected before it can be used.
            permission:
              source.kind === 'github'
                ? existing?.permission === 'granted'
                  ? 'granted'
                  : 'reconnect-required'
                : existing?.permission || 'reconnect-required',
          })
        );
      }
    });
    const selected = this.active();
    if (
      selected &&
      (!projectIds.has(selected.projectId) || !environmentIds.has(selected.environmentId))
    ) {
      this.storage?.removeItem(this.stateKey);
    }
  }

  async metadataSnapshot() {
    const [projects, environments] = await Promise.all([
      this.listProjects(),
      this.listEnvironments(),
    ]);
    return {
      version: 4,
      projects: projects.map(({ id, label, createdAt, updatedAt }) => ({
        id,
        label,
        createdAt,
        updatedAt,
      })),
      environments: environments.map((environment) => ({
        id: environment.id,
        projectId: environment.projectId,
        label: environment.label,
        source: environmentSourceOf(environment),
        fingerprint: environment.fingerprint,
        toolVersion: environment.toolVersion,
        settingsVersion: environment.settingsVersion,
        fingerprintVersion: environment.fingerprintVersion,
        compatibility: environment.compatibility,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
        lastOpenedAt: environment.lastOpenedAt,
        lastScannedAt: environment.lastScannedAt,
      })),
    };
  }

  /**
   * Replace the local mirror of the server's connection profiles.
   *
   * Wholesale, not merged: the server is the only authority, so a profile absent
   * from its answer is a profile that no longer exists. Only display fields are
   * kept — nothing here unlocks anything.
   */
  async replaceConnections(profiles = []) {
    const rows = profiles.map((profile) => ({
      id: String(profile.id),
      name: String(profile.name || ''),
      accountLogin: String(profile.accountLogin || ''),
      accountType: profile.accountType === 'Organization' ? 'Organization' : 'User',
      credentialMode: profile.credentialMode === 'persistent' ? 'persistent' : 'session',
      status: String(profile.status || 'reconnect'),
      persisted: Boolean(profile.persisted),
      connected: Boolean(profile.connected),
      lastConnectedAt: profile.lastConnectedAt || null,
    }));
    const keep = new Set(rows.map((row) => row.id));
    await this.run([CONNECTIONS], 'readwrite', async (tx) => {
      const store = tx.objectStore(CONNECTIONS);
      for (const existing of await requestResult(store.getAll())) {
        if (!keep.has(existing.id)) store.delete(existing.id);
      }
      for (const row of rows) store.put(row);
    });
    return rows;
  }

  async listConnections() {
    return this.run([CONNECTIONS], 'readonly', async (tx) => {
      const rows = await requestResult(tx.objectStore(CONNECTIONS).getAll());
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  /**
   * Catalogue view state: search text, filters and sort order.
   *
   * Deliberately the only thing retained about the catalogue. It describes how
   * the user likes to look at their own list and reveals nothing about what is
   * in it, so it is safe in `localStorage` where the records themselves are not.
   */
  viewPreferences() {
    try {
      const value = JSON.parse(this.storage?.getItem(this.viewPreferenceKey) || 'null');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const preferences = {};
      for (const key of VIEW_PREFERENCE_KEYS) {
        if (typeof value[key] === 'string' && value[key].length <= 120) {
          preferences[key] = value[key];
        }
      }
      return preferences;
    } catch {
      return {};
    }
  }

  saveViewPreferences(value = {}) {
    const preferences = {};
    for (const key of VIEW_PREFERENCE_KEYS) {
      if (typeof value[key] === 'string' && value[key].length <= 120) preferences[key] = value[key];
    }
    try {
      this.storage?.setItem(this.viewPreferenceKey, JSON.stringify(preferences));
      return preferences;
    } catch {
      return preferences;
    }
  }

  profileDraft(scope) {
    const key = `${this.profileDraftPrefix}.${profileDraftScope(scope)}`;
    const raw = this.storage?.getItem?.(key);
    if (!raw) return null;
    try {
      return normalizeProfileDraft(JSON.parse(raw));
    } catch {
      this.storage?.removeItem?.(key);
      return null;
    }
  }

  saveProfileDraft(scope, value) {
    const key = `${this.profileDraftPrefix}.${profileDraftScope(scope)}`;
    const draft = normalizeProfileDraft(value);
    this.storage?.setItem?.(key, JSON.stringify(draft));
    return draft;
  }

  clearProfileDraft(scope) {
    const key = `${this.profileDraftPrefix}.${profileDraftScope(scope)}`;
    try {
      this.storage?.removeItem?.(key);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attachment attempts that have not reached a terminal state.
   *
   * An attach that creates a working branch and then loses its response has
   * already changed GitHub. Regenerating the environment id and operation key on
   * the retry would create a *second* branch and orphan the first, so the exact
   * attempt is written down before the request and reused until it resolves.
   *
   * A map, not a single slot: choosing a different repository must not overwrite
   * an attempt that is still unresolved, because the overwritten environment id
   * and operation key are the only handles that could ever clean its branch up.
   */
  pendingAttachments() {
    const raw = this.storage?.getItem?.(this.pendingAttachmentKey);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      const entries = Array.isArray(value) ? value : [value];
      return entries.filter(
        (entry) =>
          entry && typeof entry.operationKey === 'string' && typeof entry.environmentId === 'string'
      );
    } catch {
      this.storage?.removeItem?.(this.pendingAttachmentKey);
      return [];
    }
  }

  /** The unresolved attempt for one selection, if there is one. */
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
  }

  savePendingAttachment(value) {
    const entries = this.pendingAttachments().filter(
      (entry) => entry.operationKey !== value.operationKey
    );
    entries.push(value);
    this.storage?.setItem?.(this.pendingAttachmentKey, JSON.stringify(entries));
    return value;
  }

  /** Retire one attempt by operation key, leaving every other one reachable. */
  clearPendingAttachment(operationKey = null) {
    try {
      if (!operationKey) {
        this.storage?.removeItem?.(this.pendingAttachmentKey);
        return true;
      }
      const entries = this.pendingAttachments().filter(
        (entry) => entry.operationKey !== operationKey
      );
      if (entries.length) {
        this.storage?.setItem?.(this.pendingAttachmentKey, JSON.stringify(entries));
      } else {
        this.storage?.removeItem?.(this.pendingAttachmentKey);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Records the server has not yet accepted as removed.
   *
   * Rolling back a failed attachment removes the local records, but `/data` is
   * the durable copy: if the mirror that carries those removals fails, the next
   * reconciliation restores what was removed. A tombstone outlives that failure
   * and the process, and is retried before anything else reads the registry.
   */
  tombstones() {
    const raw = this.storage?.getItem?.(this.tombstoneKey);
    if (!raw) return { projectIds: [], environmentIds: [] };
    try {
      const value = JSON.parse(raw);
      return {
        projectIds: Array.isArray(value?.projectIds) ? value.projectIds.filter(Boolean) : [],
        environmentIds: Array.isArray(value?.environmentIds)
          ? value.environmentIds.filter(Boolean)
          : [],
      };
    } catch {
      this.storage?.removeItem?.(this.tombstoneKey);
      return { projectIds: [], environmentIds: [] };
    }
  }

  addTombstones({ projectIds = [], environmentIds = [] } = {}) {
    const current = this.tombstones();
    const merged = {
      projectIds: [...new Set([...current.projectIds, ...projectIds])],
      environmentIds: [...new Set([...current.environmentIds, ...environmentIds])],
    };
    this.storage?.setItem?.(this.tombstoneKey, JSON.stringify(merged));
    return merged;
  }

  /** Cleared only once the server has accepted the removals. */
  /**
   * Drop tombstones for records that have come back to life.
   *
   * A retry deliberately reuses the environment id of the attempt it resumes, so
   * an id that was tombstoned by a failed rollback can legitimately exist again.
   * Leaving the tombstone would make the next startup remove the live record.
   */
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
    try {
      this.storage?.setItem(this.tombstoneKey, JSON.stringify(merged));
      return true;
    } catch {
      return false;
    }
  }

  clearTombstones() {
    try {
      this.storage?.removeItem?.(this.tombstoneKey);
      return true;
    } catch {
      return false;
    }
  }

  setActive(projectId, environmentId) {
    this.storage?.setItem(this.stateKey, JSON.stringify({ projectId, environmentId }));
  }

  /** Forget which environment is open, leaving every stored record intact. */
  clearRetainedSelection() {
    this.storage?.removeItem(this.stateKey);
  }

  active() {
    try {
      return JSON.parse(this.storage?.getItem(this.stateKey) || 'null');
    } catch {
      return null;
    }
  }
}

export function browserCapabilities(scope = globalThis) {
  const brave = Boolean(scope.navigator?.brave);
  const userAgent = scope.navigator?.userAgent || '';
  const chromium =
    /(Chrome|Edg)\//.test(userAgent) &&
    !/(OPR|Vivaldi)\//.test(userAgent) &&
    !brave;
  return {
    secureContext: Boolean(scope.isSecureContext),
    directoryPicker: typeof scope.showDirectoryPicker === 'function',
    indexedDB: Boolean(scope.indexedDB),
    chromium,
    brave,
    supported:
      Boolean(scope.isSecureContext) &&
      typeof scope.showDirectoryPicker === 'function' &&
      Boolean(scope.indexedDB) &&
      chromium,
  };
}
