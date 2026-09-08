import { BrowserDirectoryProvider, sha256 } from './directory-provider.mjs';
import { WorkspaceRegistry, browserCapabilities, environmentSourceOf } from './registry.mjs';
import { discoverWorkspace } from '../../shared/citadel-core.mjs';
import { localRequest } from './local-api.mjs';
import { confirmDialog, promptDialog } from './dialog.mjs';
import { createProvider } from './source-factory.mjs';
import {
  abandonGitHubAttachment,
  attachGitHubRepository,
  attachGitHubStatus,
  checkGitHubCompatibility,
  getGitHubRepository,
  gitHubRepositoryCreationStatus,
  githubStatus,
  isSessionError,
  listGitHubBranches,
  listGitHubRepositories,
  listGitHubRepositoryCreations,
  pauseGitHubRepositoryCreation,
  prepareGitHubRepository,
  resumeGitHubRepositoryCreation,
  startGitHubRepositoryCreation,
} from './github-session.mjs';
import { githubSessions } from './github-session-manager.mjs';
import { RepositorySelection } from './github-selection.mjs';
import {
  disconnectConnection,
  isConnectionLive,
  isConnectionResumable,
  listConnections,
  removeConnection,
  renameConnection,
  setConnectionPersistence,
} from './github-connections.mjs';
import { listActivity, note } from './activity.mjs';
import { presentWorkspaceCatalog } from './workspace-catalog.mjs';

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
const registry = new WorkspaceRegistry({
  dbName: registryNamespace,
  stateKey: `${registryNamespace}.active-context`,
  testMode: testRuntime,
});
let active = null;

/**
 * The masthead's view of a setup in progress.
 *
 * Published rather than imported: `app.mjs` owns the header and this module owns
 * the setup screen, and a direct import either way would be circular.
 */
let setupContextListener = null;

export function observeSetupContext(listener) {
  setupContextListener = listener || null;
}

function publishSetupContext(context) {
  setupContextListener?.(context || null);
}
let registryAuthority = null;

export async function syncRegistryMetadata(removals = {}) {
  if (!registryAuthority) throw new Error('Registry metadata has not been reconciled.');
  const snapshot = await registry.metadataSnapshot();
  const removedProjectIds = removals.removedProjectIds || [];
  const removedEnvironmentIds = removals.removedEnvironmentIds || [];
  // A removal must never be contradicted by its own request. If a previous
  // reconciliation restored a tombstoned record into the local database, the
  // snapshot still carries it, and the server applies removals before upserts —
  // so sending both would re-create exactly what this call exists to delete,
  // and the caller would then clear the tombstone believing it had succeeded.
  const removedProjects = new Set(removedProjectIds);
  const removedEnvironments = new Set(removedEnvironmentIds);
  const projects = snapshot.projects.filter((item) => !removedProjects.has(item.id));
  const environments = snapshot.environments.filter(
    (item) => !removedEnvironments.has(item.id) && !removedProjects.has(item.projectId)
  );
  const remote = await localRequest('/api/registry', {
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

/**
 * Learn the server's current epoch and revision without touching local state.
 *
 * Startup needs the authority *before* it can push anything — including a
 * rollback the container has not yet accepted — but `reconcileRegistryMetadata`
 * also overwrites the local database with what the server holds. Doing that
 * first would restore the very records the rollback removed, so the handshake
 * and the overwrite are separate steps.
 */
export async function establishRegistryAuthority(request = localRequest) {
  const remote = await request('/api/registry');
  registryAuthority = { epoch: remote.epoch, revision: remote.revision };
  return remote;
}

export async function reconcileRegistryMetadata(
  targetRegistry = registry,
  request = localRequest
) {
  const remote = await request('/api/registry');
  await targetRegistry.replaceMetadata(remote);
  registryAuthority = { epoch: remote.epoch, revision: remote.revision };
  return remote;
}

function element(name, attributes = {}, ...children) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function retainedWorkspace() {
  const selected = registry.active();
  if (!selected) return null;
  const environments = await registry.listEnvironments(selected.projectId);
  const environment = environments.find((item) => item.id === selected.environmentId);
  if (!environment) return null;
  const source = environmentSourceOf(environment);
  let handle = null;
  let provider = null;
  if (source.kind === 'local') {
    handle = await registry.getHandle(environment.id);
    if (!handle) return null;
    provider = new BrowserDirectoryProvider(handle);
  } else {
    // A GitHub environment has no durable credential. Without a live in-memory
    // server session it stays listed but must be reconnected.
    //
    // Checked live rather than through the manager's cache: a session can expire
    // on the server without the browser hearing about it. The manager is told
    // when the answer is "gone" so no panel keeps rendering a stale account.
    if (!(await githubStatus().catch(() => ({ connected: false }))).connected) {
      githubSessions.reset();
      await registry.updateEnvironment(environment.id, { permission: 'reconnect-required' });
      return null;
    }
    provider = await createProvider(environment, {
      getHandle: (id) => registry.getHandle(id),
    });
  }
  let permission;
  try {
    permission = await provider.permission();
  } catch (error) {
    // Startup must never be stranded by a source that became unreachable. The
    // environment stays listed so the user can reconnect or reselect it.
    await registry.updateEnvironment(environment.id, {
      permission: 'reconnect-required',
      compatibility: 'unavailable',
      unavailableReason: error.message,
    });
    await syncRegistryMetadata().catch(() => {});
    return null;
  }
  await registry.updateEnvironment(environment.id, {
    permission,
    ...(permission === 'granted'
      ? {}
      : { unavailableReason: provider.unavailableReason || null }),
  });
  if (permission !== 'granted') return null;
  try {
    const scan = await scanProvider(provider);
    if (scan.compatibility !== 'supported') {
      await registry.updateEnvironment(environment.id, {
        permission,
        compatibility: 'invalid-citadel-root',
        fingerprint: scan.fingerprint,
        lastScannedAt: scan.lastScannedAt,
      });
      await syncRegistryMetadata();
      return null;
    }
    const updated = await registry.updateEnvironment(environment.id, {
      permission,
      compatibility: scan.compatibility,
      fingerprint: scan.fingerprint,
      lastOpenedAt: new Date().toISOString(),
      lastScannedAt: scan.lastScannedAt,
    });
    await syncRegistryMetadata();
    // The catalog this scan already produced, handed to `WorkspaceService` so
    // opening does not immediately scan the same repository a second time.
    return {
      projectId: selected.projectId,
      environment: updated,
      handle,
      provider,
      catalog: scan.catalog,
    };
  } catch {
    await registry.updateEnvironment(environment.id, {
      permission: 'reconnect-required',
      compatibility: 'unavailable',
    });
    await syncRegistryMetadata();
    return null;
  }
}

function compatibilityMessage(capabilities) {
  const missing = [];
  if (!capabilities.chromium) missing.push('Microsoft Edge or Google Chrome desktop');
  if (!capabilities.secureContext) missing.push('the fixed http://127.0.0.1:4173 origin');
  if (!capabilities.directoryPicker) missing.push('File System Access API support');
  if (!capabilities.indexedDB) missing.push('IndexedDB');
  return `Citadel UI needs ${missing.join(', ')}. No folder was accessed.`;
}

/**
 * Scan a provider and describe what was found.
 *
 * The read scope is not decided here. `discoverWorkspace` narrows a remote
 * provider to what Citadel's three editors need, because that is the one
 * function that performs the reads; deciding it a second time in this wrapper
 * would be two places holding one policy, and the two would eventually disagree.
 * `options.scope` is still forwarded for the callers that legitimately want
 * something narrower.
 */
export async function scanProvider(provider, options = {}) {
  const catalog = await discoverWorkspace(provider, {
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  return {
    catalog,
    compatibility: catalog.compatibility,
    fingerprint: await sha256(new TextEncoder().encode(catalog.fingerprintSource)),
    lastScannedAt: new Date().toISOString(),
  };
}

export function assertSupportedScan(scan) {
  if (scan.compatibility === 'supported') return scan;
  throw new Error(
    `Select the Citadel repository root. Missing primary editor capabilities: ${scan.catalog.missingCapabilities.join(', ')}.`
  );
}

export function validateLocalPath(value) {
  const path = String(value || '').trim();
  if (!path) throw new Error('Local path is required.');
  if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(path)) {
    throw new Error('Local path must be an absolute Windows, UNC, or POSIX path.');
  }
  return path;
}

export function localPathMatchesHandle(localPath, handleName) {
  const parts = String(localPath).replace(/[\\/]+$/, '').split(/[\\/]/);
  const leaf = parts.at(-1) || '';
  return leaf.localeCompare(String(handleName || ''), undefined, { sensitivity: 'accent' }) === 0;
}

export async function attachEnvironment(options) {
  const {
    project: existingProject,
    projectLabel,
    environmentLabel,
    localPath,
    handle,
    scan,
    provider,
    registry: targetRegistry = registry,
    mirror = syncRegistryMetadata,
    allowDuplicate = false,
    activate = true,
  } = options;
  let project = existingProject;
  let environment = null;
  const createdProject = !project;
  try {
    project ||= await targetRegistry.createProject(projectLabel);
    environment = await targetRegistry.addEnvironment(
      project.id,
      environmentLabel,
      handle,
      null,
      { allowDuplicate, localPath }
    );
    const updated = await targetRegistry.updateEnvironment(environment.id, {
      permission: 'granted',
      compatibility: scan.compatibility,
      fingerprint: scan.fingerprint,
      lastOpenedAt: new Date().toISOString(),
      lastScannedAt: scan.lastScannedAt,
    });
    await mirror();
    if (activate) targetRegistry.setActive(project.id, updated.id);
    return { projectId: project.id, environment: updated, handle, provider, catalog: scan.catalog };
  } catch (error) {
    if (environment) await targetRegistry.removeEnvironment(environment.id);
    if (createdProject && project) await targetRegistry.removeProject(project.id);
    throw error;
  }
}

/**
 * Attach a GitHub repository and branch as an environment.
 *
 * The environment id is minted first because the Citadel working branch is
 * derived from it. The registry record is mirrored to `/data` before the
 * provider is used, because the server resolves repository and branch from that
 * mirror rather than from request parameters.
 *
 * Two durable records make failure survivable:
 *
 *   - The attempt itself — environment id, operation key and exact selection —
 *     is written down *before* the request. An attach that creates a branch and
 *     then loses its response has already changed GitHub; regenerating those
 *     values on the retry would create a second branch and orphan the first.
 *   - Rollback removals are tombstoned, because `/data` is the durable copy and
 *     a mirror that fails would otherwise let reconciliation restore a project
 *     the user never successfully created.
 */
export async function attachGitHubEnvironment(options) {
  const {
    project: existingProject,
    projectLabel,
    environmentLabel,
    repositoryId,
    sourceBranch,
    writeMode = 'working-branch',
    expectedHead = null,
    registry: targetRegistry = registry,
    mirror = syncRegistryMetadata,
    attach = attachGitHubRepository,
    abandon = abandonGitHubAttachment,
    attachmentStatus = attachGitHubStatus,
    makeProvider = createProvider,
    activate = true,
    stage = () => {},
    // Bounded, and deliberately short: this runs while the user watches. Four
    // waits is long enough to outlast a gateway blip and short enough that an
    // unresolved attempt reaches the Retry affordance quickly.
    reconcileDelays = [500, 1500, 3000, 5000],
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  // Reuse an unresolved attempt for this exact selection so a retry addresses
  // the branch the previous attempt may already have created. Attempts for other
  // selections are left untouched: overwriting one would discard the only
  // handles that could clean its branch up.
  const selection = { repositoryId, sourceBranch, writeMode };
  const previous = targetRegistry.pendingAttachment?.(selection);
  const environmentId = previous?.environmentId || globalThis.crypto.randomUUID();
  const operationKey = previous?.operationKey || globalThis.crypto.randomUUID();
  targetRegistry.savePendingAttachment?.({ ...selection, environmentId, operationKey });

  const request = {
    repositoryId,
    sourceBranch,
    environmentId,
    writeMode,
    operationKey,
    // The head the structure check passed against, so the server can refuse an
    // attach whose branch moved after validation.
    ...(expectedHead ? { expectedHead } : {}),
  };

  /**
   * Ask the server what became of this attempt, then replay it if it must.
   *
   * The defect this exists to fix: a 502 after the server had already created
   * the working branch was reported to the user as a failure, while the activity
   * log recorded the attach as `ok`. The transport lost the answer; the operation
   * succeeded. Nothing retried, because the code path that kept the durable
   * attempt then threw immediately.
   *
   * Both moves here are safe. The status read is a read. The replay carries the
   * same operation key, and the server serialises on it and returns the original
   * reservation, so it cannot create a second branch.
   */
  async function reconcile() {
    let lastError = null;
    for (const delay of reconcileDelays) {
      await wait(delay);
      try {
        const status = await attachmentStatus({ operationKey });
        if (status?.state === 'attached' && status.result) return status.result;
      } catch (statusError) {
        lastError = statusError;
      }
      try {
        // `unknown` is not "nothing happened": this server may have restarted,
        // or the reservation may have aged out. Replaying the idempotent attach
        // is the only way to find out, and it is what makes a duplicate branch
        // impossible rather than merely unlikely.
        return await attach(request);
      } catch (retryError) {
        if (isTerminalAttachFailure(retryError)) throw retryError;
        lastError = retryError;
      }
    }
    throw Object.assign(
      new Error(
        'GitHub may have completed this step, but the result could not be confirmed. Retry to resume the same attempt \u2014 it will not create a second branch.'
      ),
      {
        code: 'ATTACH_UNRESOLVED',
        attachUnresolved: true,
        attachUnconfirmed: true,
        retryable: true,
        cause: lastError,
      }
    );
  }

  let project = existingProject;
  let environment = null;
  const createdProject = !project;
  let attachment = null;
  // The step actually in progress. Inferring it afterwards from which objects
  // exist gets it wrong: the environment record is created *during* the metadata
  // step, so a mirror failure would be reported as an "open" failure and a retry
  // would resume past the step that failed.
  let at = 'revalidate';
  const enter = (id, label) => {
    at = id;
    stage(id, label);
  };
  try {
    enter('revalidate');
    try {
      attachment = await attach(request);
    } catch (error) {
      // A definite client-side rejection proves nothing was created. Anything
      // else is ambiguous and is reconciled rather than reported as a failure.
      if (isTerminalAttachFailure(error)) throw error;
      enter('branch', 'Creating or recovering working branch \u2014 confirming with GitHub');
      attachment = await reconcile();
    }
    enter('metadata');
    project ||= await targetRegistry.createProject(projectLabel);
    environment = await targetRegistry.addGitHubEnvironment(
      project.id,
      environmentLabel,
      attachment.source,
      { id: environmentId }
    );
    await mirror();
    enter('open');
    const provider = await makeProvider(environment, {
      getHandle: (id) => targetRegistry.getHandle(id),
    });
    const scan = await scanProvider(provider);
    assertSupportedScan(scan);
    const updated = await targetRegistry.updateEnvironment(environment.id, {
      permission: 'granted',
      compatibility: scan.compatibility,
      fingerprint: scan.fingerprint,
      lastOpenedAt: new Date().toISOString(),
      lastScannedAt: scan.lastScannedAt,
    });
    await mirror();
    if (activate) targetRegistry.setActive(project.id, updated.id);
    targetRegistry.clearPendingAttachment?.(operationKey);
    // A retry reuses the environment id of the attempt it resumes, so an id a
    // failed rollback tombstoned can legitimately be alive again. The tombstone
    // has to go with it: startup applies tombstones before reconciliation, and
    // would otherwise remove the record this attach just succeeded in creating.
    targetRegistry.removeTombstones?.({
      projectIds: [project.id],
      environmentIds: [updated.id],
    });
    stage('ready');
    return {
      projectId: project.id,
      environment: updated,
      handle: null,
      provider,
      attachment,
      catalog: scan.catalog,
    };
  } catch (error) {
    // The step that was actually running, so a retry resumes there rather than
    // at the beginning. A metadata failure after the branch succeeded must never
    // be narrated as a branch failure.
    if (!error.attachStage) error.attachStage = at;
    // Remove every local record *before* mirroring, and mirror once. Mirroring
    // the environment removal first and deleting the project afterwards would
    // leave the project in /data, which reconciliation would then restore as a
    // ghost on the next start.
    const removedEnvironmentIds = [];
    const removedProjectIds = [];
    if (environment) {
      await targetRegistry.removeEnvironment(environment.id);
      removedEnvironmentIds.push(environment.id);
    }
    if (createdProject && project) {
      await targetRegistry.removeProject(project.id);
      removedProjectIds.push(project.id);
    }
    if (removedEnvironmentIds.length || removedProjectIds.length) {
      // Tombstoned first: if the mirror fails, /data still holds these records
      // and the next reconciliation would restore them. The tombstone survives a
      // restart and is retried before anything reads the registry again.
      targetRegistry.addTombstones?.({
        projectIds: removedProjectIds,
        environmentIds: removedEnvironmentIds,
      });
      try {
        await mirror({ removedEnvironmentIds, removedProjectIds });
        targetRegistry.clearTombstones?.();
      } catch {
        // Left for `resolvePendingRemovals` to retry.
      }
    }
    // Attachment created the working branch before Citadel compatibility could
    // be confirmed. Cleanup names only the server's opaque operation id, so it
    // can never be aimed at another environment's branch.
    if (attachment?.operationId) {
      const cleanup = await abandon({ operationId: attachment.operationId }).catch(
        (cleanupError) => ({ removed: false, reason: 'request-failed', message: cleanupError.message, retryable: true })
      );
      if (cleanup.removed || !cleanup.retryable) {
        // Terminal either way: the branch is gone, or it is one the server will
        // not remove. Nothing is left for a retry to address.
        targetRegistry.clearPendingAttachment?.(operationKey);
      }
      if (!cleanup.removed && attachment.createdWorkingBranch) {
        // Never swallowed: the user is told exactly what is left behind.
        error.message = `${error.message} The working branch ${
          cleanup.branch || attachment.source.workingBranch
        } could not be removed (${cleanup.reason || 'unknown'}); delete it on GitHub if it is not needed.`;
      }
    } else if (!attachment && isTerminalAttachFailure(error)) {
      // A failed `attach` is terminal only when the server answered *and*
      // answered deterministically: it then reconciled and discarded anything it
      // created. A transport failure, a timeout, or a 5xx leaves the branch in
      // doubt, and the durable attempt is the only way a retry can address it
      // rather than creating a second one.
      targetRegistry.clearPendingAttachment?.(operationKey);
    }
    throw error;
  }
}

/**
 * Did the server answer this attach deterministically?
 *
 * Only a definite client-side rejection proves nothing was created and nothing
 * remains to reconcile. A transport failure carries no status; a 5xx, a timeout
 * or a gateway error means the request may have been applied before the answer
 * was lost. Treating those as terminal would discard the pending attempt and
 * strand whatever the server did create.
 *
 * Status class is not sufficient on its own. When the server could neither
 * confirm nor deny the branch it may have created, it keeps the reservation and
 * marks the error `attachUnconfirmed` — and that error carries GitHub's own
 * status, which for a secondary rate limit is 403 and for "Reference already
 * exists" is 422. The marker is authoritative over the status; 403 and 422 are
 * additionally excluded so an older server that cannot set it still fails safe.
 */
function isTerminalAttachFailure(error) {
  if (error?.attachUnconfirmed) return false;
  const status = error?.status;
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 429 || status === 403 || status === 422) return false;
  return status >= 400 && status < 500;
}

/**
 * Retry removals the server has not yet accepted.
 *
 * Run before the registry is *read* at startup: `/data` is authoritative for
 * reconciliation, so a rollback whose mirror failed would otherwise come back as
 * a ghost project the user never successfully created.
 *
 * The mirror needs the server's epoch and revision, which nothing has fetched
 * yet at this point in startup, so the authority handshake happens here. It
 * deliberately does not overwrite the local database: that is reconciliation's
 * job, and doing it first would restore the records this call exists to remove.
 */
export async function resolvePendingRemovals(options = {}) {
  const targetRegistry = options.registry || registry;
  const mirror = options.mirror || syncRegistryMetadata;
  const establish = options.establishAuthority || establishRegistryAuthority;
  const pending = targetRegistry.tombstones?.() || { projectIds: [], environmentIds: [] };
  if (!pending.projectIds.length && !pending.environmentIds.length) return { resolved: true };
  try {
    await establish();
    await mirror({
      removedEnvironmentIds: pending.environmentIds,
      removedProjectIds: pending.projectIds,
    });
  } catch (error) {
    // Kept for the next attempt, and surfaced rather than swallowed.
    return { resolved: false, pending, message: error.message };
  }
  targetRegistry.clearTombstones?.();
  return { resolved: true, pending };
}

export async function commitActiveWorkspaceReconnect(current, next, mirror) {
  if (
    !current ||
    current.projectId !== next?.projectId ||
    current.environment?.id !== next?.environment?.id
  ) {
    throw new Error('Reconnect context does not match the active environment.');
  }
  await mirror();
  current.environment = next.environment;
  current.handle = next.handle;
  current.provider = next.provider;
  return current;
}

export async function ensureWorkspace() {
  const capabilities = browserCapabilities();
  if (!capabilities.supported) {
    const message = compatibilityMessage(capabilities);
    document.getElementById('workspace')?.replaceChildren(
      element(
        'section',
        { class: 'empty-state workspace-setup' },
        element('h1', {}, 'Browser not supported'),
        element('p', {}, message),
        element('p', { class: 'hint' }, 'Citadel UI did not enumerate, read, or change any local folder.')
      )
    );
    throw new Error(message);
  }

  // Removals the server has not yet accepted are retried first. /data is what
  // reconciliation reads, so a rollback whose mirror failed would otherwise
  // come back as a ghost project the user never successfully created.
  const removals = await resolvePendingRemovals().catch((error) => ({
    resolved: false,
    message: error.message,
  }));
  // Reconciliation overwrites the local database with what `/data` holds. While
  // a removal is still unaccepted, that would restore the ghost the tombstone
  // exists to erase — so the local records are left alone until the container
  // has confirmed the removal.
  if (!removals || removals.resolved) {
    await reconcileRegistryMetadata();
  }
  if (removals && !removals.resolved) {
    // Surfaced rather than swallowed: the user is told the workspace list may
    // still hold something a failed rollback could not remove.
    console.warn(
      `Citadel UI could not confirm a rolled-back project was removed from the container: ${
        removals.message || 'the container did not accept the removal'
      }`
    );
  }

  active = await retainedWorkspace();
  if (active) return active;

  return presentWorkspaceCatalog({
    container: document.getElementById('workspace'),
    preferences: registry.viewPreferences(),
    savePreferences: (value) => registry.saveViewPreferences(value),
    sessions: githubSessions,
    onContext: (context) => publishSetupContext(context),
    actions: catalogActions(),
  });
}

/**
 * The catalogue's effects, in one place.
 *
 * The catalogue renders and sequences; every consequence lives here, on the side
 * that already owns the registry, the mirror and the provider factory. Handing
 * it a plain object of functions rather than importing it into the view keeps
 * the dependency pointing one way and lets the whole flow be driven in a test
 * without IndexedDB or a network.
 */
function catalogActions() {
  const state = { projects: [] };
  const actions = {
    projects: state.projects,

    async listProjects() {
      const projects = await registry.listProjects();
      state.projects.length = 0;
      state.projects.push(...projects);
      return projects;
    },

    listEnvironments: () => registry.listEnvironments(),

    hasHandle: (environmentId) => registry.getHandle(environmentId),

    projectName(projectId) {
      return state.projects.find((project) => project.id === projectId)?.label || projectId;
    },

    async listConnections() {
      const result = await listConnections();
      // Mirrored locally so a later paint can name a workspace's connection
      // without waiting for the network again.
      await registry.replaceConnections(result?.profiles || []).catch(() => {});
      return result;
    },

    listActivity: () => listActivity(25),

    getRepository: getGitHubRepository,
    listRepositoryCreations: listGitHubRepositoryCreations,
    prepareRepository: prepareGitHubRepository,
    repositoryCreationStatus: gitHubRepositoryCreationStatus,
    startRepositoryCreation: startGitHubRepositoryCreation,
    resumeRepositoryCreation: resumeGitHubRepositoryCreation,
    pauseRepositoryCreation: pauseGitHubRepositoryCreation,

    createSelection: () =>
      new RepositorySelection({
        listRepositories: listGitHubRepositories,
        listBranches: listGitHubBranches,
        checkCompatibility: checkGitHubCompatibility,
        sessions: githubSessions,
      }),

    async createConnection({ name, token, persist }) {
      const outcome = await githubSessions.connectProfile({ name, token, persist });
      if (!outcome?.account) throw new Error('The GitHub connection was superseded. Try again.');
      return outcome.account;
    },

    async reconnectConnection(profileId, { token, persist }) {
      const outcome = await githubSessions.reconnectProfile(profileId, { token, persist });
      if (!outcome?.account) throw new Error('The GitHub connection was superseded. Try again.');
      return outcome.account;
    },

    async resumeConnection(profileId) {
      const outcome = await githubSessions.resumeProfile(profileId);
      if (!outcome?.account) throw new Error('The GitHub connection was superseded. Try again.');
      return outcome.account;
    },

    /**
     * Adopt a connection that is already live.
     *
     * A live session already has a credential on the server; asking it to resume
     * would tear that session down and mint another for no reason. The match has
     * to be exact — a session with no profile is not this profile's credential,
     * and treating it as one is how a repository chosen under one account gets
     * edited under another.
     */
    async useConnection(profileId) {
      const current = await githubSessions.restore().catch(() => null);
      if (current?.profileId === profileId) return current;
      return actions.resumeConnection(profileId);
    },

    renameConnection: (profileId, name) => renameConnection(profileId, name),
    setConnectionPersistence: (profileId, persist) =>
      setConnectionPersistence(profileId, persist),
    disconnectConnection: (profileId) => disconnectConnection(profileId),
    removeConnection: (profileId) => removeConnection(profileId),

    async promptLabel({ title, message, value }) {
      const values = await promptDialog({
        title,
        description: message,
        fields: [{ name: 'label', label: 'Name', value, required: true }],
        submitLabel: 'Save',
      });
      return values?.label?.trim() || null;
    },

    async pickFolder() {
      return globalThis.showDirectoryPicker({ mode: 'readwrite' });
    },

    /**
     * Open a saved workspace.
     *
     * A GitHub workspace whose connection is saved-but-idle is resumed first, so
     * the common case after a container restart is one click rather than a
     * detour through the connections table.
     */
    async openEnvironment(environment) {
      const source = environmentSourceOf(environment);
      if (source.kind === 'github') await ensureGitHubSessionFor(source);
      const provider = await createProvider(environment, {
        getHandle: (id) => registry.getHandle(id),
      });
      if (source.kind === 'local') {
        await provider.assertWritable({ request: true });
      }
      const scan = await scanProvider(provider);
      assertSupportedScan(scan);
      const updated = await registry.updateEnvironment(environment.id, {
        permission: 'granted',
        compatibility: scan.compatibility,
        fingerprint: scan.fingerprint,
        lastOpenedAt: new Date().toISOString(),
        lastScannedAt: scan.lastScannedAt,
      });
      await syncRegistryMetadata();
      registry.setActive(environment.projectId, environment.id);
      note({ action: 'environment.open', target: updated.label });
      active = {
        projectId: environment.projectId,
        environment: updated,
        handle: source.kind === 'local' ? await registry.getHandle(environment.id) : null,
        provider,
        catalog: scan.catalog,
      };
      return active;
    },

    /**
     * Bring a workspace back into a usable state, then open it.
     *
     * Local reconnection re-picks the folder handle; GitHub reconnection
     * establishes a credential for the connection the workspace was attached
     * through. Both end in the same place, because "Reconnect" and "Open" differ
     * only in what has to happen first.
     */
    async reconnectEnvironment(environment, { connections = [], onProgress = () => {} } = {}) {
      const source = environmentSourceOf(environment);
      if (source.kind === 'github') {
        onProgress('Reconnecting GitHub\u2026');
        // A record migrated from v3 has no recorded connection. This is the
        // moment the documented binding happens: the connection the user is
        // actually holding is written onto the environment, once, so every later
        // open and every commit is attributed to it rather than to whatever
        // session happens to be live.
        let target = environment;
        if (!source.connectionProfileId) {
          const current = await githubSessions.restore().catch(() => null);
          if (!current?.profileId) {
            throw new Error(
              'Connect a GitHub connection first, then reconnect this workspace to bind it to that connection.'
            );
          }
          target = await registry.updateEnvironment(environment.id, {
            source: { ...source, connectionProfileId: current.profileId },
          });
          await syncRegistryMetadata();
        }
        await ensureGitHubSessionFor(environmentSourceOf(target), { connections });
        return actions.openEnvironment(target);
      }
      onProgress('Choose the Citadel folder\u2026');
      let handle = await registry.getHandle(environment.id);
      if (!handle) handle = await globalThis.showDirectoryPicker({ mode: 'readwrite' });
      const localPath = validateLocalPath(source.localPath || handle.name);
      await registry.reconnectEnvironment(environment.id, handle, localPath);
      return actions.openEnvironment(environment);
    },

    async renameEnvironment(environment, label) {
      await registry.assertLabelAvailable(environment.projectId, label, environment.id);
      await registry.updateEnvironment(environment.id, { label });
      await syncRegistryMetadata();
    },

    /**
     * Forget a workspace on this device.
     *
     * Metadata only. No branch is deleted and no file is touched: destroying a
     * Git branch is a separate, explicitly confirmed operation that this product
     * does not offer, and removing a row must never be a way to reach it by
     * accident.
     */
    async detachEnvironment(environment) {
      const snapshot = { id: environment.id, label: environment.label };
      await registry.removeEnvironment(environment.id);
      registry.addTombstones?.({ environmentIds: [snapshot.id] });
      try {
        await syncRegistryMetadata({ removedEnvironmentIds: [snapshot.id] });
        registry.removeTombstones?.({ environmentIds: [snapshot.id] });
      } catch (error) {
        // The tombstone survives: the next start retries the removal before
        // anything reads the registry, so /data cannot resurrect this row.
        throw new Error(
          `The workspace was removed here, but the container did not confirm it: ${error.message} It will be retried on the next start.`
        );
      }
      note({ action: 'repository.detach', target: snapshot.label });
    },

    async attachLocal({ projectId, projectLabel, environmentLabel, localPath, handle, onProgress, stage = () => {} }) {
      stage('revalidate');
      const path = validateLocalPath(localPath);
      if (
        !localPathMatchesHandle(path, handle.name) &&
        !(await confirmDialog({
          title: 'Local path differs from folder',
          message: `The Local path leaf does not match the selected folder "${handle.name}". The browser cannot verify this display-only path.`,
          confirmLabel: 'Use this folder',
        }))
      ) {
        throw new Error('Attach cancelled.');
      }
      onProgress?.('Reading the Citadel folder\u2026');
      stage('read');
      const provider = new BrowserDirectoryProvider(handle);
      await provider.assertWritable({ request: true });
      const scan = await scanProvider(provider);
      assertSupportedScan(scan);
      onProgress?.('Saving the workspace\u2026');
      stage('metadata');
      active = await attachEnvironment({
        project: projectId ? state.projects.find((project) => project.id === projectId) : null,
        projectLabel,
        environmentLabel,
        localPath: path,
        handle,
        scan,
        provider,
      });
      stage('ready');
      return active;
    },

    async attachGitHub({
      projectId,
      projectLabel,
      environmentLabel,
      repositoryId,
      sourceBranch,
      writeMode,
      expectedHead,
      stage = () => {},
    }) {
      active = await attachGitHubEnvironment({
        project: projectId ? state.projects.find((project) => project.id === projectId) : null,
        projectLabel,
        environmentLabel,
        repositoryId,
        sourceBranch,
        writeMode,
        expectedHead,
        stage,
      });
      return active;
    },
  };
  return actions;
}

/**
 * Make sure a credential exists for the connection this workspace belongs to.
 *
 * The rule is strict on purpose: a live credential may open this workspace only
 * if it belongs to the very connection the workspace was attached through.
 * Accepting "any live session" would open a repository that was chosen under one
 * account using a different account's credential — the rebinding the schema
 * exists to prevent, arriving through the read path instead of the write path.
 *
 * Otherwise the connection is resumed. That is silent when the credential was
 * saved with the encrypted option, which is the whole point of the checkbox, and
 * fails with an actionable sentence when it was not.
 */
async function ensureGitHubSessionFor(source, { connections = [] } = {}) {
  const wanted = source.connectionProfileId || null;
  if (!wanted) {
    throw new Error(
      'This workspace predates named connections. Reconnect it from GitHub connections to bind it to one.'
    );
  }
  const current = await githubSessions.restore().catch(() => null);
  if (current && current.profileId === wanted) return current;
  const known = connections.find((profile) => profile.id === wanted) || null;
  const name = known?.name ? `"${known.name}"` : 'this workspace\u2019s GitHub connection';
  try {
    const outcome = await githubSessions.resumeProfile(wanted);
    if (outcome?.account) return outcome.account;
    throw new Error('The GitHub connection was superseded.');
  } catch (error) {
    throw new Error(
      `${error.message} Reconnect ${name} in GitHub connections, then open this workspace.`
    );
  }
}

export function activeWorkspace() {
  if (!active) throw new Error('No environment is attached.');
  return active;
}

/**
 * Release the active workspace without touching any stored metadata.
 *
 * Returning to setup is a navigation, not a detach: projects, environments and
 * the server's live credential all survive. Only this module's notion of "the
 * workspace currently open" is cleared, plus the retained selection so the next
 * `ensureWorkspace` shows the setup screen rather than reopening what the user
 * just left.
 */
export function clearActiveWorkspace() {
  active = null;
  registry.clearRetainedSelection?.();
}

export { registry as workspaceRegistry };
