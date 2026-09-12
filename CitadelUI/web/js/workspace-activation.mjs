import { BrowserDirectoryProvider, sha256 } from './directory-provider.mjs';
import { environmentSourceOf } from './registry.mjs';
import { registrySync, workspaceRegistry } from './registry-sync.mjs';
import { createProvider } from './source-factory.mjs';
import { githubStatus } from './github-session.mjs';
import { githubSessions } from './github-session-manager.mjs';
import { note } from './activity.mjs';
import { discoverConfiguredWorkspace } from '../../shared/terraform/workspace.mjs';

// Discovery owns selective reads; this adapter only forwards existing narrowing.
export async function scanProvider(provider, options = {}) {
  const catalog = await discoverConfiguredWorkspace(provider, null, {
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

export function createWorkspaceActivation({ registry, sync, providers, connections, scan: scanProvider }) {
  const { local: BrowserDirectoryProvider, create: createProvider } = providers;
  const syncRegistryMetadata = sync.syncRegistryMetadata;
  const githubStatus = connections.status;
  const githubSessions = connections;
  let active = null;
  let activationGeneration = 0;

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
      provider = new BrowserDirectoryProvider(handle, { configuration: environment.configuration });
    } else {
      // This live status check bypasses the manager's cached account.
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

  async function openEnvironment(environment) {
    const generation = ++activationGeneration;
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
    if (generation !== activationGeneration) throw new Error('Workspace opening was superseded by a newer selection.');
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
  }

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

  async function commitActiveWorkspaceReconnect(current, next, mirror) {
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

  function activeWorkspace() {
    if (!active) throw new Error('No environment is attached.');
    return active;
  }

  function currentWorkspace() {
    return active;
  }

  // Setup and attachment keep their original acceptance points without owning
  // another active object or advancing the explicit-open generation.
  function acceptWorkspace(workspace) {
    active = workspace;
    return active;
  }

  function clearActiveWorkspace() {
    // Navigation releases memory and retained selection, not metadata or credentials.
    activationGeneration += 1;
    active = null;
    registry.clearRetainedSelection?.();
  }

  return {
    retainedWorkspace, openEnvironment, ensureGitHubSessionFor, commitActiveWorkspaceReconnect,
    activeWorkspace, currentWorkspace, acceptWorkspace, clearActiveWorkspace,
  };
}

export const workspaceActivation = createWorkspaceActivation({
  registry: workspaceRegistry,
  sync: registrySync,
  providers: { local: BrowserDirectoryProvider, create: createProvider },
  connections: {
    status: githubStatus,
    reset: () => githubSessions.reset(),
    restore: () => githubSessions.restore(),
    resumeProfile: (profileId) => githubSessions.resumeProfile(profileId),
  },
  scan: scanProvider,
});

export const activeWorkspace = workspaceActivation.activeWorkspace;
export const clearActiveWorkspace = workspaceActivation.clearActiveWorkspace;
export const commitActiveWorkspaceReconnect = workspaceActivation.commitActiveWorkspaceReconnect;
export { workspaceRegistry };
