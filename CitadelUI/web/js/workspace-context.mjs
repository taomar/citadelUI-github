import { BrowserDirectoryProvider } from './directory-provider.mjs';
import { browserCapabilities, environmentSourceOf } from './registry.mjs';
import { registrySync, workspaceRegistry as registry } from './registry-sync.mjs';
import { workspaceActivation, createWorkspaceReattachment, withSourceUnavailable, scanProvider, assertSupportedScan } from './workspace-activation.mjs';
import { createWorkspaceAttachment } from './workspace-attachment.mjs';
import { confirmDialog, promptDialog } from './dialog.mjs';
import { createProvider } from './source-factory.mjs';
import {
  abandonGitHubAttachment,
  attachGitHubRepository,
  attachGitHubStatus,
  checkGitHubCompatibility,
  getGitHubRepository,
  gitHubRepositoryCreationStatus,
  isSessionError,
  listGitHubBranches,
  listGitHubRepositories,
  nativeGitHubInventory,
  listGitHubRepositoryCreations,
  listRepositoryOwners,
  checkRepositoryOwner,
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
import { presentWorkspaceCatalog, runAddWorkspace, workspaceRow } from './workspace-catalog.mjs';
import { validateLocalPath, localPathMatchesHandle } from '../../shared/local-path.mjs';
export { validateLocalPath, localPathMatchesHandle } from '../../shared/local-path.mjs';

const workspaceAttachment = createWorkspaceAttachment({
  registry,
  sync: registrySync,
  makeProvider: createProvider,
  attach: attachGitHubRepository,
  status: attachGitHubStatus,
  abandon: abandonGitHubAttachment,
  scan: scanProvider,
});

const workspaceReattachment = createWorkspaceReattachment({
  registry, sync: registrySync,
  connections: {
    status: () => githubSessions.status(),
    list: listConnections,
    generation: () => githubSessions.generation,
    isCurrent: (generation) => githubSessions.isCurrent(generation),
  },
  repositories: { get: getGitHubRepository, check: checkGitHubCompatibility },
});

export const syncRegistryMetadata = registrySync.syncRegistryMetadata;
export const establishRegistryAuthority = registrySync.establishRegistryAuthority;
export const reconcileRegistryMetadata = registrySync.reconcileRegistryMetadata;
export const resolvePendingRemovals = registrySync.resolvePendingRemovals;
export const attachEnvironment = workspaceAttachment.attachEnvironment;
export const attachGitHubEnvironment = workspaceAttachment.attachGitHubEnvironment;
export { scanProvider, assertSupportedScan };
export { activeWorkspace, clearActiveWorkspace, commitActiveWorkspaceReconnect } from './workspace-activation.mjs';

export function attachLocalSourceEnvironment(options) {
  return workspaceAttachment.attachLocalSourceEnvironment(options, workspaceActivation.acceptWorkspace);
}

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

function compatibilityMessage(capabilities) {
  const missing = [];
  if (!capabilities.chromium) missing.push('Microsoft Edge or Google Chrome desktop');
  if (!capabilities.secureContext) missing.push('the fixed http://127.0.0.1:4173 origin');
  if (!capabilities.directoryPicker) missing.push('File System Access API support');
  if (!capabilities.indexedDB) missing.push('IndexedDB');
  return `Citadel UI needs ${missing.join(', ')}. No folder was accessed.`;
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

  const retained = workspaceActivation.acceptWorkspace(await workspaceActivation.retainedWorkspace());
  if (retained) return retained;

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
 * UI-specific actions stay here; synchronization, activation and attachment are
 * composed from the headless owners. The catalogue receives effects rather than
 * importing the composition root.
 */
export async function openRegisteredWorkspace(environmentId) {
  const environment = await registry.getEnvironment(environmentId);
  if (!environment) throw new Error('This workspace no longer exists in the registry.');
  return catalogActions().openEnvironment(environment);
}

export async function addRegisteredWorkspace({ projectId = null, onOpenExisting = () => {} } = {}) {
  const actions = catalogActions();
  const [projects, environments, connectionState] = await Promise.all([
    actions.listProjects(), actions.listEnvironments(), actions.listConnections(),
  ]);
  const connections = connectionState.profiles || [];
  const rows = environments.map((environment) => workspaceRow(environment, {
    project: projects.find((project) => project.id === environment.projectId), connections,
  }));
  return new Promise((resolve) => runAddWorkspace({ actions, connections, vault: connectionState.vault,
    rows, projectId, onDone: resolve, onOpenExisting }));
}

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
    repositoryOwners: listRepositoryOwners,
    checkRepositoryOwner,
    prepareRepository: prepareGitHubRepository,
    repositoryCreationStatus: gitHubRepositoryCreationStatus,
    startRepositoryCreation: startGitHubRepositoryCreation,
    resumeRepositoryCreation: resumeGitHubRepositoryCreation,
    pauseRepositoryCreation: pauseGitHubRepositoryCreation,
    scanLocalSource: scanProvider,
    async nativeInventory({ handle, repositoryId, branch }) {
      if (handle) return { files: await new BrowserDirectoryProvider(handle, { nativeInventory: true }).entries() };
      return nativeGitHubInventory(repositoryId, branch);
    },
    async validateNativeLocal(handle, configuration) {
      const provider = new BrowserDirectoryProvider(handle, { configuration });
      await provider.assertWritable({ request: true });
      const scan = await scanProvider(provider);
      assertSupportedScan(scan);
      return scan;
    },
    attachLocalSource: attachLocalSourceEnvironment,

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
    reviewReattachment: workspaceReattachment.review,
    commitReattachment: workspaceReattachment.commit,
    revalidateReattachment: workspaceReattachment.revalidate,
    pendingReattachment: workspaceReattachment.pending,

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
      if (workspaceReattachment.pending?.(environment.id)) {
        throw Object.assign(new Error('This workspace has an unconfirmed connection reattachment. Open its pending review in Workspaces and confirm that same connection before opening.'), { code: 'REATTACH_SYNC_PENDING' });
      }
      return workspaceActivation.openEnvironment(environment);
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
        if (!source.connectionProfileId || !connections.some((profile) => profile.id === source.connectionProfileId)) {
          throw withSourceUnavailable(new Error('Use Reattach connection on this workspace to explicitly review a replacement connection and the exact retained source.'),
            environment, { kind: 'connection' });
        }
        await workspaceActivation.ensureGitHubSessionFor(source, { connections });
        return actions.openEnvironment(environment);
      }
      onProgress('Choose the Citadel folder\u2026');
      let handle = await registry.getHandle(environment.id);
      if (!handle) {
        try { handle = await globalThis.showDirectoryPicker({ mode: 'readwrite' }); }
        catch (error) {
          if (error.name === 'AbortError') throw error;
          throw withSourceUnavailable(error, environment, { kind: 'permission' });
        }
      }
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

    async attachLocal({ projectId, projectLabel, environmentLabel, localPath, handle, configuration, onProgress, stage = () => {} }) {
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
      const provider = new BrowserDirectoryProvider(handle, { configuration });
      await provider.assertWritable({ request: true });
      const scan = await scanProvider(provider);
      assertSupportedScan(scan);
      onProgress?.('Saving the workspace\u2026');
      stage('metadata');
      workspaceActivation.acceptWorkspace(await attachEnvironment({
        project: projectId ? state.projects.find((project) => project.id === projectId) : null,
        projectLabel,
        environmentLabel,
        localPath: path,
        handle,
        scan,
        provider,
        configuration,
        recoverMirror: true,
      }));
      stage('ready');
      return workspaceActivation.currentWorkspace();
    },

    async attachGitHub({
      projectId,
      projectLabel,
      environmentLabel,
      repositoryId,
      sourceBranch,
      writeMode,
      workingBranch,
      adoptExisting,
      configuration,
      connectionProfileId,
      expectedHead,
      stage = () => {},
    }) {
      return workspaceActivation.acceptWorkspace(await attachGitHubEnvironment({
        project: projectId ? state.projects.find((project) => project.id === projectId) : null,
        projectLabel,
        environmentLabel,
        repositoryId,
        sourceBranch,
        writeMode,
        workingBranch,
        adoptExisting,
        configuration,
        connectionProfileId,
        expectedHead,
        stage,
      }));
    },
  };
  return actions;
}

export { registry as workspaceRegistry };
