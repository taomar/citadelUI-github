import { BrowserDirectoryProvider, sha256 } from './directory-provider.mjs';
import { environmentSourceOf } from './registry.mjs';
import { registryEnvironmentIdentity as reattachmentIdentity, registrySync, workspaceRegistry } from './registry-sync.mjs';
import { createProvider } from './source-factory.mjs';
import { githubStatus } from './github-session.mjs';
import { githubSessions } from './github-session-manager.mjs';
import { note } from './activity.mjs';
import { discoverConfiguredWorkspace } from '../../shared/terraform/workspace.mjs';
import { configurationOf } from '../../shared/workspace-configuration.mjs';

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

export function withSourceUnavailable(error, environment, { kind, path } = {}) {
  if (!error || typeof error !== 'object' || error.sourceUnavailable) return error;
  const code = error.code || '';
  const source = environmentSourceOf(environment);
  const knownKind = kind || (/^(?:GITHUB_SESSION_|CONNECTION_)/.test(code) ? 'connection'
    : ['NotAllowedError', 'SecurityError'].includes(error.name) || /^(?:PERMISSION_|FOLDER_PERMISSION_)/.test(code) ? 'permission'
      : error.name === 'NotFoundError' || code === 'ENOENT' || code === 'SOURCE_NOT_FOUND' ? 'missing-file' : 'unavailable');
  const guidance = knownKind === 'connection'
    ? 'Open Workspaces and restore the named connection. If it was removed, use the explicit recovery action on that workspace; another connection will not be selected automatically.'
    : knownKind === 'permission'
      ? 'Open Settings or Workspaces to reconnect the original browser-selected folder and allow access. The displayed path alone is not permission.'
      : knownKind === 'missing-file'
        ? 'Inspect the original source outside Citadel. Restore the intended file there if appropriate, then retry and review against its current bytes. Citadel will not recreate this missing file from a retained draft.'
        : source.kind === 'github'
          ? 'Inspect access to the exact repository and retained refs, then retry through Workspaces. No alternate repository or ref is selected and no missing file is recreated.'
          : 'Check the original source folder and required configuration files, then retry through Settings or Workspaces. No missing file is recreated.';
  error.sourceUnavailable = {
    kind: knownKind,
    ...(typeof (path || error.alias) === 'string' ? { path: path || error.alias } : {}),
    message: error.message || 'The selected source could not be read.',
    guidance,
  };
  return error;
}

function reattachmentError(message, code = 'WORKSPACE_REATTACHMENT_REQUIRED', cause) {
  const error = Object.assign(new Error(message, { cause }), { code });
  if (code === 'CONNECTION_MISMATCH') return withSourceUnavailable(error, null, { kind: 'connection' });
  if (['REPOSITORY_RENAMED', 'REPOSITORY_READ_ONLY', 'WORKSPACE_SOURCE_UNAVAILABLE'].includes(code)) {
    return withSourceUnavailable(error, { source: { kind: 'github' } }, { kind: 'unavailable' });
  }
  return error;
}

/** A connection-only metadata change. Never creates a branch, workspace or source file. */
export function createWorkspaceReattachment({ registry, sync, connections, repositories, now = () => new Date().toISOString() }) {
  const reviews = new WeakMap();
  const pendingReviews = new Map();
  let busy = false;

  async function guarded(work) {
    if (busy) throw reattachmentError('A connection reattachment is already in progress. Wait for its result.');
    busy = true;
    try { return await work(); }
    finally { busy = false; }
  }

  async function currentEnvironment(expected, allowProfile = null) {
    const current = await registry.getEnvironment(expected.id);
    if (!current || reattachmentIdentity(current, { connection: false }) !== reattachmentIdentity(expected, { connection: false })) {
      throw reattachmentError('The workspace source or native binding changed. Return to workspaces and review its current identity.');
    }
    const actual = environmentSourceOf(current).connectionProfileId;
    if (actual !== environmentSourceOf(expected).connectionProfileId && (allowProfile === null || actual !== allowProfile)) {
      throw reattachmentError('The workspace connection changed elsewhere. Return to workspaces before reviewing it again.');
    }
    return current;
  }

  async function validate(environment, profileId) {
    const source = environmentSourceOf(environment);
    if (source.kind !== 'github' || !profileId) throw reattachmentError('Explicitly choose a GitHub connection for this workspace.');
    if (configurationOf(environment).format === 'terraform') {
      throw reattachmentError(
        'Native workspace connection identity is immutable. Attach a separate workspace with an intentional source binding; the retained workspace, drafts and history are not transferred.',
        'NATIVE_SOURCE_RETARGET'
      );
    }
    const generation = connections.generation();
    const account = await connections.status();
    const { profiles } = await connections.list();
    const profile = profiles.find((item) => item.id === profileId);
    const assertAccount = (value) => {
      if (!value?.connected || !Number.isSafeInteger(value.accountId) || value.accountId <= 0 ||
          value.profileId !== profileId || !profile || String(value.accountId) !== String(profile.accountId) ||
          value.login !== profile.accountLogin || !connections.isCurrent(generation)) {
        throw reattachmentError('The selected account is no longer connected. Choose it explicitly and validate again.', 'CONNECTION_MISMATCH');
      }
    };
    assertAccount(account);
    let repository;
    try { repository = await repositories.get(source.repositoryId); }
    catch (error) { throw withSourceUnavailable(error, environment); }
    if (repository.id !== source.repositoryId || repository.fullName !== source.fullName) {
      throw reattachmentError('The repository identity or name changed. Reattachment will not retarget this workspace.', 'REPOSITORY_RENAMED');
    }
    if (!repository.canPush || repository.archived || repository.disabled) {
      throw reattachmentError('This connection cannot edit the retained repository. Use a connection with access to this exact repository.', 'REPOSITORY_READ_ONLY');
    }
    const refs = [];
    for (const branch of new Set([source.sourceBranch, source.workingBranch])) {
      let verdict;
      try { verdict = await repositories.check(source.repositoryId, branch, environment.configuration); }
      catch (error) { throw withSourceUnavailable(error, environment); }
      if (verdict.repositoryId !== source.repositoryId || verdict.fullName !== source.fullName || verdict.branch !== branch ||
          !verdict.supported || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(verdict.head)) {
        throw reattachmentError(
          `The retained ref "${branch}" is missing or incompatible. Restore or inspect that source outside Citadel, then validate again. No branch or missing file will be recreated.`,
          'WORKSPACE_SOURCE_UNAVAILABLE'
        );
      }
      refs.push({ branch, head: verdict.head });
    }
    const current = await connections.status();
    assertAccount(current);
    if (current.accountId !== account.accountId) throw reattachmentError('The account changed during validation. Validate again.', 'CONNECTION_MISMATCH');
    return { accountId: account.accountId, login: account.login, profileId, profileName: profile.name, refs, generation };
  }

  async function review(environment, profileId) {
    return guarded(async () => {
      if (pendingReviews.has(environment.id)) {
        throw reattachmentError('This workspace already has a pending reattachment. Reopen its pending review and revalidate that same connection.', 'REATTACH_SYNC_PENDING');
      }
      const original = structuredClone(await currentEnvironment(environment));
      const checked = await validate(original, profileId);
      await currentEnvironment(original);
      const result = Object.freeze({
        environmentId: original.id, workspace: original.label, source: Object.freeze(environmentSourceOf(original)),
        profileId, profileName: checked.profileName, accountId: checked.accountId, login: checked.login,
        refs: Object.freeze(checked.refs.map((ref) => Object.freeze(ref))), reviewedAt: now(),
      });
      reviews.set(result, { original, checked, staged: false });
      return result;
    });
  }

  async function commit(reviewed) {
    return guarded(async () => {
      const saved = reviews.get(reviewed);
      if (!saved) throw reattachmentError('Review this workspace and connection before reattaching.');
      const { original, checked } = saved;
      const current = await currentEnvironment(original, saved.staged ? checked.profileId : null);
      // A retry may follow a lost mirror response. Read fresh authority, but only
      // publish this environment and only if its original identity still agrees.
      const remote = await sync.establishRegistryAuthority();
      const retained = remote.environments.find((item) => item.id === original.id);
      if (!retained || reattachmentIdentity(retained, { connection: false }) !== reattachmentIdentity(original, { connection: false }) ||
          ![environmentSourceOf(original).connectionProfileId, ...(saved.staged ? [checked.profileId] : [])]
            .includes(environmentSourceOf(retained).connectionProfileId)) {
        throw reattachmentError('The saved workspace changed elsewhere. Return to workspaces and review the authoritative source.');
      }
      const fresh = await validate(current, checked.profileId);
      if (fresh.accountId !== checked.accountId || fresh.login !== checked.login ||
          JSON.stringify(fresh.refs) !== JSON.stringify(checked.refs)) {
        throw reattachmentError('The reviewed account or repository ref moved. Go Back and validate the new state before confirming.', 'REATTACH_REVIEW_STALE');
      }
      await currentEnvironment(original, saved.staged ? checked.profileId : null);
      if (!connections.isCurrent(fresh.generation)) throw reattachmentError('The connection changed. Validate again.', 'CONNECTION_MISMATCH');
      const intended = { ...current, source: { ...environmentSourceOf(current), connectionProfileId: checked.profileId } };
      const confirmedRetry = saved.staged && reattachmentIdentity(retained) === reattachmentIdentity(intended);
      const confirmedEnvironment = (response) => {
        const matches = Array.isArray(response?.environments) ? response.environments.filter((item) => item.id === original.id) : [];
        if (matches.length !== 1 || reattachmentIdentity(matches[0]) !== reattachmentIdentity(intended)) {
          throw reattachmentError('The server did not confirm the reviewed workspace and connection identity.', 'REATTACH_CONFIRMATION_MISMATCH');
        }
        return matches[0];
      };
      if (!saved.staged) {
        saved.updated = await registry.updateEnvironment(original.id, {
          source: { ...intended.source, validatedAt: now() },
          permission: 'granted', compatibility: 'supported', unavailableReason: null,
        });
        saved.staged = true;
      }
      pendingReviews.set(original.id, reviewed);
      try {
        if (reattachmentIdentity(saved.updated) !== reattachmentIdentity(intended)) {
          throw reattachmentError('The staged workspace no longer matches this reviewed connection.', 'REATTACH_REVIEW_STALE');
        }
        // An accepted-but-lost reply is confirmed by this fresh authoritative read,
        // not by sending the same change again with a new registry revision.
        const confirmed = confirmedRetry
          ? confirmedEnvironment(remote)
          : confirmedEnvironment(await sync.syncRegistryMetadata(
            {}, { projectIds: [], environmentIds: [original.id] }, { reviewedEnvironments: [intended] }
          ));
        const latest = await currentEnvironment(original, checked.profileId);
        if (reattachmentIdentity(latest) !== reattachmentIdentity(intended) || !connections.isCurrent(fresh.generation)) {
          throw reattachmentError('The workspace or connection changed before confirmation completed. Keep this pending review and revalidate its owner.', 'REATTACH_REVIEW_STALE');
        }
        reviews.delete(reviewed);
        pendingReviews.delete(original.id);
        return { ...saved.updated, ...confirmed };
      } catch (cause) {
        throw reattachmentError(
          'Connection reattachment is not confirmed by the server. Keep this workspace and retry this confirmation; no files, refs, drafts or history were changed.',
          'REATTACH_SYNC_PENDING', cause
        );
      }
    });
  }

  async function revalidate(reviewed) {
    return guarded(async () => {
      const saved = reviews.get(reviewed);
      if (!saved) throw reattachmentError('Review this workspace and connection before revalidating.');
      const current = await currentEnvironment(saved.original, saved.staged ? saved.checked.profileId : null);
      const checked = await validate(current, saved.checked.profileId);
      if (checked.accountId !== saved.checked.accountId || checked.login !== saved.checked.login) {
        throw reattachmentError('The reviewed account changed. Restore that account before retrying this pending reattachment.', 'CONNECTION_MISMATCH');
      }
      await currentEnvironment(saved.original, saved.staged ? saved.checked.profileId : null);
      const next = Object.freeze({
        ...reviewed, refs: Object.freeze(checked.refs.map((ref) => Object.freeze(ref))), reviewedAt: now(),
      });
      reviews.set(next, { ...saved, checked });
      reviews.delete(reviewed);
      if (saved.staged) pendingReviews.set(saved.original.id, next);
      return next;
    });
  }

  return { review, commit, revalidate, pending: (environmentId) => pendingReviews.get(environmentId) || null };
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
    // Provider construction resolves retained handles from the registry, not source I/O.
    const provider = await createProvider(environment, {
      getHandle: async (id) => {
        const handle = await registry.getHandle(id);
        if (!handle) throw withSourceUnavailable(new Error('Reconnect the original folder for this environment.'), environment, { kind: 'permission' });
        return handle;
      },
    });
    let scan;
    try {
      if (source.kind === 'local') {
        try { await provider.assertWritable({ request: true }); }
        catch (error) { throw withSourceUnavailable(error, environment, { kind: 'permission' }); }
      }
      scan = await scanProvider(provider);
      assertSupportedScan(scan);
    } catch (error) {
      throw withSourceUnavailable(error, environment);
    }
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
      throw withSourceUnavailable(new Error(
        'This workspace predates named connections. Use Reattach connection on its workspace row to review a connection and the retained source.'
      ), { source }, { kind: 'connection' });
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
      const failure = new Error(`${error.message} Reconnect ${name} in GitHub connections, then open this workspace.`, { cause: error });
      throw withSourceUnavailable(failure, { source }, { kind: 'connection' });
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
