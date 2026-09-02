import { BrowserDirectoryProvider, sha256 } from './directory-provider.mjs';
import { WorkspaceRegistry, browserCapabilities, environmentSourceOf } from './registry.mjs';
import { discoverWorkspace } from '../../shared/citadel-core.mjs';
import { localRequest } from './local-api.mjs';
import { confirmDialog } from './dialog.mjs';
import { createProvider } from './source-factory.mjs';
import { createGitHubPanel } from './github-setup.mjs';
import {
  abandonGitHubAttachment,
  attachGitHubRepository,
  githubStatus,
  isSessionError,
} from './github-session.mjs';
import { githubSessions } from './github-session-manager.mjs';

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
    return { projectId: selected.projectId, environment: updated, handle, provider };
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

export async function scanProvider(provider) {
  const catalog = await discoverWorkspace(provider);
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
    return { projectId: project.id, environment: updated, handle, provider };
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
    makeProvider = createProvider,
    activate = true,
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

  let project = existingProject;
  let environment = null;
  const createdProject = !project;
  let attachment = null;
  try {
    attachment = await attach({
      repositoryId,
      sourceBranch,
      environmentId,
      writeMode,
      operationKey,
      // The head the structure check passed against, so the server can refuse an
      // attach whose branch moved after validation.
      ...(expectedHead ? { expectedHead } : {}),
    });
    project ||= await targetRegistry.createProject(projectLabel);
    environment = await targetRegistry.addGitHubEnvironment(
      project.id,
      environmentLabel,
      attachment.source,
      { id: environmentId }
    );
    await mirror();
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
    return { projectId: project.id, environment: updated, handle: null, provider, attachment };
  } catch (error) {
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

  const projects = await registry.listProjects();
  const environments = await registry.listEnvironments();
  const setupDraft = registry.profileDraft('setup') || {};
  const workspace = document.getElementById('workspace');

  return new Promise((resolve, reject) => {
    const projectInput = element('input', {
      id: 'setup-project-label',
      name: 'projectLabel',
      class: 'ctl',
      value: setupDraft.projectLabel || projects[0]?.label || 'Citadel',
      'aria-label': 'Project label',
    });
    const environmentInput = element('input', {
      id: 'setup-environment-label',
      name: 'environmentLabel',
      class: 'ctl',
      value: setupDraft.environmentLabel || 'Development',
      'aria-label': 'Environment label',
    });
    const localPathInput = element('input', {
      id: 'setup-local-path',
      name: 'localPath',
      class: 'ctl',
      value: setupDraft.localPath || '',
      placeholder: 'C:\\source\\citadel or /home/user/citadel',
      'aria-label': 'Local path',
    });
    const message = element(
      'p',
      { class: 'hint' },
      'Choose the exact Citadel repository folder for this label.'
    );
    const attach = element('button', { class: 'btn btn-primary' }, 'Choose Citadel folder');
    const persistSetupDraft = () => {
      try {
        registry.saveProfileDraft('setup', {
          projectLabel: projectInput.value,
          environmentLabel: environmentInput.value,
          localPath: localPathInput.value,
        });
        return true;
      } catch (error) {
        message.textContent = `Profile fields could not be retained for reload: ${error.message}`;
        return false;
      }
    };
    for (const input of [projectInput, environmentInput, localPathInput]) {
      input.addEventListener('input', persistSetupDraft);
    }

    attach.addEventListener('click', async () => {
      persistSetupDraft();
      attach.disabled = true;
      try {
        const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite' });
        const localPath = validateLocalPath(localPathInput.value);
        if (
          !localPathMatchesHandle(localPath, handle.name) &&
          !(await confirmDialog({
            title: 'Local path differs from folder',
            message: `The Local path leaf does not match the selected folder "${handle.name}". The browser cannot verify this display-only path.`,
            confirmLabel: 'Use this folder',
          }))
        ) {
          attach.disabled = false;
          return;
        }
        const provider = new BrowserDirectoryProvider(handle);
        await provider.assertWritable({ request: true });
        const scan = await scanProvider(provider);
        assertSupportedScan(scan);
        active = await attachEnvironment({
          project: projects[0],
          projectLabel: projectInput.value,
          environmentLabel: environmentInput.value,
          localPath,
          handle,
          scan,
          provider,
        });
        if (!registry.clearProfileDraft('setup')) {
          message.textContent = 'The environment was saved, but the setup form cache could not be cleared.';
        }
        resolve(active);
      } catch (error) {
        if (error.name !== 'AbortError') message.textContent = error.message;
        attach.disabled = false;
      }
    });

    const reconnects = environments.map((environment) => {
      const source = environmentSourceOf(environment);
      if (source.kind === 'github') {
        return element(
          'section',
          { class: 'setup-reconnect' },
          element('strong', {}, environment.label),
          element('code', {}, `${source.fullName} @ ${source.workingBranch}`),
          element(
            'button',
            {
              class: 'btn btn-sm',
              onclick: async () => {
                try {
                  if (!(await githubStatus()).connected) {
                    githubSessions.reset();
                    throw new Error(
                      'Connect GitHub above first. The credential is memory-only and is cleared on restart.'
                    );
                  }
                  const provider = await createProvider(environment, {
                    getHandle: (id) => registry.getHandle(id),
                  });
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
                  active = {
                    projectId: environment.projectId,
                    environment: updated,
                    handle: null,
                    provider,
                  };
                  resolve(active);
                } catch (error) {
                  message.textContent = isSessionError(error)
                    ? 'The GitHub session expired. Connect GitHub again.'
                    : error.message;
                }
              },
            },
            `Reconnect GitHub (${source.fullName})`
          )
        );
      }
      const localPathInput = element('input', {
        id: `reconnect-local-path-${environment.id}`,
        name: 'localPath',
        class: 'ctl',
        value: source.localPath || '',
        placeholder: 'Enter the absolute local path',
        'aria-label': `Local path for ${environment.label}`,
      });
      return element(
        'section',
        { class: 'setup-reconnect' },
        element('strong', {}, environment.label),
        element('code', {}, source.localPath || 'Local path not recorded'),
        element('label', {}, 'Local path', localPathInput),
        element(
          'button',
          {
            class: 'btn btn-sm',
            onclick: async () => {
              try {
                const localPath = validateLocalPath(localPathInput.value);
                let handle = await registry.getHandle(environment.id);
                if (!handle) {
                  handle = await globalThis.showDirectoryPicker({ mode: 'readwrite' });
                }
                if (
                  !localPathMatchesHandle(localPath, handle.name) &&
                  !(await confirmDialog({
                    title: 'Local path differs from folder',
                    message: `The Local path leaf does not match the selected folder "${handle.name}". The browser cannot verify this display-only path.`,
                    confirmLabel: 'Use this folder',
                  }))
                ) {
                  return;
                }
                await registry.reconnectEnvironment(environment.id, handle, localPath);
                const provider = new BrowserDirectoryProvider(handle);
                await provider.assertWritable({ request: true });
                const scan = await scanProvider(provider);
                assertSupportedScan(scan);
                const updated = await registry.updateEnvironment(environment.id, {
                  permission: 'granted',
                  compatibility: scan.compatibility,
                  fingerprint: scan.fingerprint,
                  localPath,
                  lastOpenedAt: new Date().toISOString(),
                  lastScannedAt: scan.lastScannedAt,
                });
                await syncRegistryMetadata();
                registry.setActive(environment.projectId, environment.id);
                active = {
                  projectId: environment.projectId,
                  environment: updated,
                  handle,
                  provider,
                };
                resolve(active);
              } catch (error) {
                message.textContent = error.message;
              }
            },
          },
          `Reconnect folder (${source.folderName})`
        )
      );
    });

    const localPanel = element(
      'section',
      { class: 'setup-source-panel', id: 'setup-source-local' },
      element(
        'label',
        { for: 'setup-local-path' },
        'Local path',
        localPathInput,
        element(
          'small',
          { class: 'hint' },
          'Display only. The browser cannot verify it against the selected folder.'
        )
      ),
      element('div', { class: 'setup-actions' }, attach)
    );

    // The panel's own status line lives inside the panel. Routing it into the
    // page description let a hidden GitHub panel narrate the local screen, so
    // the local source was described in terms of an access token.
    const githubStatusLine = element('p', { class: 'hint setup-source-status' });
    const githubPanel = createGitHubPanel({
      onMessage: (text) => {
        githubStatusLine.textContent = text;
      },
      // The masthead is the product's "where am I", and during setup it used to
      // say nothing at all. The panel reports its state as the user moves
      // through it, so the header names the account, repository and branch being
      // chosen instead of a placeholder path.
      onContext: (context) => {
        publishSetupContext({
          sourceKind: 'github',
          projectLabel: projectInput.value,
          environmentLabel: environmentInput.value,
          ...context,
        });
      },
      onAttach: async (selection) => {
        persistSetupDraft();
        active = await attachGitHubEnvironment({
          project: projects[0],
          projectLabel: projectInput.value,
          environmentLabel: environmentInput.value,
          repositoryId: selection.repositoryId,
          sourceBranch: selection.sourceBranch,
          writeMode: selection.writeMode,
          expectedHead: selection.expectedHead,
        });
        registry.clearProfileDraft('setup');
        resolve(active);
      },
    });

    const githubWrapper = element(
      'section',
      { class: 'setup-source-panel', id: 'setup-source-github', hidden: true },
      githubPanel.root,
      githubStatusLine
    );

    async function selectSource(kind) {
      localPanel.hidden = kind !== 'local';
      githubWrapper.hidden = kind !== 'github';
      localChoice.setAttribute('aria-pressed', String(kind === 'local'));
      githubChoice.setAttribute('aria-pressed', String(kind === 'github'));
      localChoice.classList.toggle('btn-primary', kind === 'local');
      githubChoice.classList.toggle('btn-primary', kind === 'github');
      message.textContent =
        kind === 'github'
          ? 'Connect a fine-grained token, then choose a repository and branch.'
          : 'Choose the exact Citadel repository folder for this label.';
      if (kind === 'github') {
        // Awaited so the panel cannot offer Connect while the manager is still
        // asking the server whether a session survives.
        await githubPanel.restore().catch(() => {});
        githubPanel.publishContext?.();
      } else {
        publishSetupContext({
          sourceKind: 'local',
          projectLabel: projectInput.value,
          environmentLabel: environmentInput.value,
        });
      }
    }

    const localChoice = element(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        'aria-pressed': 'true',
        onclick: () => selectSource('local'),
      },
      'Local folder'
    );
    const githubChoice = element(
      'button',
      {
        class: 'btn',
        type: 'button',
        'aria-pressed': 'false',
        onclick: () => selectSource('github'),
      },
      'GitHub repository'
    );

    workspace.replaceChildren(
      element(
        'section',
        { class: 'workspace-setup' },
        element(
          'header',
          { class: 'setup-head' },
          element('h1', {}, 'Attach an environment'),
          message
        ),
        element(
          'section',
          { class: 'setup-group' },
          element('h2', {}, 'Identity'),
          element('label', { for: 'setup-project-label' }, 'Project label', projectInput),
          element('label', { for: 'setup-environment-label' }, 'Environment label', environmentInput)
        ),
        element(
          'section',
          { class: 'setup-group' },
          element('h2', {}, 'Source'),
          element(
            'div',
            { class: 'setup-source-choice', role: 'group', 'aria-label': 'Source' },
            localChoice,
            githubChoice
          ),
          localPanel,
          githubWrapper
        ),
        reconnects.length
          ? element(
              'section',
              { class: 'setup-group' },
              element('h2', {}, 'Saved environments'),
              element('div', { class: 'setup-reconnect-list' }, reconnects)
            )
          : ''
      )
    );
  });
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
