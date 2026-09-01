import { BrowserDirectoryProvider, sha256 } from './directory-provider.mjs';
import { WorkspaceRegistry, browserCapabilities } from './registry.mjs';
import { discoverWorkspace } from '../../shared/citadel-core.mjs';
import { localRequest } from './local-api.mjs';
import { confirmDialog } from './dialog.mjs';

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
let registryAuthority = null;

export async function syncRegistryMetadata(removals = {}) {
  if (!registryAuthority) throw new Error('Registry metadata has not been reconciled.');
  const snapshot = await registry.metadataSnapshot();
  const remote = await localRequest('/api/registry', {
    method: 'PUT',
    body: JSON.stringify({
      expectedEpoch: registryAuthority.epoch,
      expectedRevision: registryAuthority.revision,
      projects: snapshot.projects,
      environments: snapshot.environments,
      removedProjectIds: removals.removedProjectIds || [],
      removedEnvironmentIds: removals.removedEnvironmentIds || [],
    }),
  });
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
  const handle = await registry.getHandle(environment.id);
  if (!handle) return null;
  const provider = new BrowserDirectoryProvider(handle);
  const permission = await provider.permission();
  await registry.updateEnvironment(environment.id, { permission });
  if (permission !== 'granted') return null;
  try {
    const scan = await scanProvider(provider);
    if (scan.compatibility !== 'supported') {
      const updated = await registry.updateEnvironment(environment.id, {
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
    const updated = await registry.updateEnvironment(environment.id, {
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

  await reconcileRegistryMetadata();

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
      'Choose the exact Citadel repository for this label. Local path is display-only metadata; the selected folder handle remains the sole file authority.'
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
      const localPathInput = element('input', {
        id: `reconnect-local-path-${environment.id}`,
        name: 'localPath',
        class: 'ctl',
        value: environment.localPath || '',
        placeholder: 'Enter the absolute local path',
        'aria-label': `Local path for ${environment.label}`,
      });
      return element(
        'section',
        { class: 'setup-reconnect' },
        element('strong', {}, environment.label),
        element('code', {}, environment.localPath || 'Local path not recorded'),
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
          `Reconnect folder (${environment.folderName})`
        )
      );
    });

    workspace.replaceChildren(
      element(
        'section',
        { class: 'empty-state workspace-setup' },
        element('h1', {}, 'Attach an environment'),
        message,
        element('label', { for: 'setup-project-label' }, 'Project label', projectInput),
        element('label', { for: 'setup-environment-label' }, 'Environment label', environmentInput),
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
        attach,
        reconnects.length ? element('div', { class: 'setup-reconnect' }, reconnects) : ''
      )
    );
  });
}

export function activeWorkspace() {
  if (!active) throw new Error('No environment is attached.');
  return active;
}

export { registry as workspaceRegistry };
