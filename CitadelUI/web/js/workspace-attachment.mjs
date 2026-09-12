import { createConfiguration } from '../../shared/workspace-configuration.mjs';
import { validateLocalPath } from '../../shared/local-path.mjs';
import { assertSupportedScan } from './workspace-activation.mjs';

export function createWorkspaceAttachment({
  registry, sync, makeProvider: createProvider,
  attach: attachGitHubRepository, status: attachGitHubStatus, abandon: abandonGitHubAttachment,
  scan: scanProvider,
  clock = {
    now: () => new Date().toISOString(),
    uuid: () => globalThis.crypto.randomUUID(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
}) {
  const { syncRegistryMetadata, establishRegistryAuthority, resolvePendingRemovals } = sync;
  let localImportRegistrationRecovery = null;

  async function attachEnvironment(options) {
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
      recoverMirror = false,
      onRecovery = () => {},
    } = options;
    let project = existingProject;
    let environment = null;
    const createdProject = !project;
    const configuration = options.configuration ||
      (provider?.configuration?.format === 'terraform' ? provider.configuration : createConfiguration('bicep'));
    const previousSelection = recoverMirror && activate ? targetRegistry.active() : null;
    let activationAttempted = false;
    try {
      project ||= await targetRegistry.createProject(projectLabel);
      environment = await targetRegistry.addEnvironment(
        project.id,
        environmentLabel,
        handle,
        null,
        { allowDuplicate, localPath, configuration }
      );
      const updated = await targetRegistry.updateEnvironment(environment.id, {
        permission: 'granted',
        compatibility: scan.compatibility,
        fingerprint: scan.fingerprint,
        lastOpenedAt: clock.now(),
        lastScannedAt: scan.lastScannedAt,
      });
      await mirror(recoverMirror ? {
        createdProjectIds: createdProject ? [project.id] : [],
        createdEnvironmentIds: [updated.id],
      } : undefined);
      if (activate) {
        activationAttempted = true;
        targetRegistry.setActive(project.id, updated.id);
      }
      return { projectId: project.id, environment: updated, handle, provider, catalog: scan.catalog };
    } catch (error) {
      if (recoverMirror) {
        const removedEnvironmentIds = environment ? [environment.id] : [];
        const removedProjectIds = createdProject && project ? [project.id] : [];
        const pending = { projectIds: removedProjectIds, environmentIds: removedEnvironmentIds };
        const failures = [];
        if (removedEnvironmentIds.length || removedProjectIds.length) {
          onRecovery(pending);
          let recordFailure = null;
          try { targetRegistry.addTombstones(pending); }
          catch (failure) { recordFailure = failure; }
          for (const [id, remove] of [
            [environment?.id, (value) => targetRegistry.removeEnvironment(value)],
            [createdProject && project?.id, (value) => targetRegistry.removeProject(value)],
          ]) {
            if (!id) continue;
            try { await remove(id); }
            catch (failure) { failures.push(`Local registry rollback: ${failure.message}`); }
          }
          try {
            await mirror({ removedEnvironmentIds, removedProjectIds });
          } catch (failure) { failures.push(`Server registry rollback: ${failure.message}`); }
          if (!failures.length) {
            try {
              if (targetRegistry.removeTombstones(pending) === false) throw new Error('The browser could not retire the registration recovery record.');
            } catch (failure) { failures.push(failure.message); }
          }
          if (failures.length && recordFailure) {
            failures.push(`Recovery record: ${recordFailure.message} Keep this dialog open until recovery succeeds.`);
          }
          if (!failures.length) onRecovery(null);
        }
        if (activationAttempted) {
          try {
            const selected = targetRegistry.active();
            if (selected?.projectId !== previousSelection?.projectId || selected?.environmentId !== previousSelection?.environmentId) {
              if (previousSelection) targetRegistry.setActive(previousSelection.projectId, previousSelection.environmentId);
              else targetRegistry.clearRetainedSelection();
            }
          } catch (failure) { failures.push(`Previous workspace selection: ${failure.message}`); }
        }
        if (failures.length) {
          throw Object.assign(new Error(`${error.message} Workspace registration was not confirmed. ${failures.join(' ')} Retry after restoring registry access; the copied folder is retained.`),
            { code: 'LOCAL_IMPORT_REGISTRY_PENDING', cause: error });
        }
        throw error;
      }
      if (environment) await targetRegistry.removeEnvironment(environment.id);
      if (createdProject && project) await targetRegistry.removeProject(project.id);
      throw error;
    }
  }

  async function attachLocalSourceEnvironment(options, acceptWorkspace = (workspace) => workspace) {
    const mirrorScoped = (changes = {}) => syncRegistryMetadata(changes, {
      projectIds: changes.createdProjectIds || [],
      environmentIds: changes.createdEnvironmentIds || [],
    });
    const pending = await resolvePendingRemovals({
      removeLocal: true, pending: localImportRegistrationRecovery, mirror: mirrorScoped,
    });
    if (!pending.resolved) throw Object.assign(new Error(`Registry recovery is still pending: ${pending.message}`), { code: 'LOCAL_IMPORT_REGISTRY_PENDING' });
    localImportRegistrationRecovery = null;
    const project = options.projectId
      ? (await registry.listProjects()).find((item) => item.id === options.projectId)
      : null;
    if (options.projectId && !project) throw new Error('The selected project no longer exists. Choose another project.');
    const result = await attachEnvironment({
      ...options, project, localPath: validateLocalPath(options.localPath), recoverMirror: true,
      onRecovery: (value) => { localImportRegistrationRecovery = value; },
      mirror: async (removals) => {
        // Learning a fresh revision does not authorize replaying unrelated metadata.
        await establishRegistryAuthority();
        return mirrorScoped(removals);
      },
    });
    return acceptWorkspace(result);
  }

  async function attachGitHubEnvironment(options) {
    const {
      project: existingProject,
      projectLabel,
      environmentLabel,
      repositoryId,
      sourceBranch,
      writeMode = 'working-branch',
      workingBranch,
      adoptExisting,
      configuration: requestedConfiguration,
      expectedHead = null,
      registry: targetRegistry = registry,
      mirror = syncRegistryMetadata,
      attach = attachGitHubRepository,
      abandon = abandonGitHubAttachment,
      attachmentStatus = attachGitHubStatus,
      makeProvider = createProvider,
      activate = true,
      stage = () => {},
      reconcileDelays = [500, 1500, 3000, 5000],
      wait = clock.wait,
    } = options;

    // Retry identities are durable before the request and belong to this exact
    // selection. Other unresolved selections must retain their cleanup handles.
    const selection = { repositoryId, sourceBranch, writeMode, workingBranch,
      adoptExisting: Boolean(adoptExisting), projectId: existingProject?.id || null,
      connectionProfileId: options.connectionProfileId || null, configuration: requestedConfiguration };
    const previous = targetRegistry.pendingAttachment?.(selection);
    const configuration = previous ? previous.configuration : requestedConfiguration;
    const environmentId = previous?.environmentId || clock.uuid();
    const operationKey = previous?.operationKey || clock.uuid();
    targetRegistry.savePendingAttachment?.({ ...selection, configuration, environmentId, operationKey });

    const request = {
      repositoryId,
      sourceBranch,
      environmentId,
      writeMode,
      operationKey,
      ...(workingBranch !== undefined ? { workingBranch } : {}),
      ...(adoptExisting !== undefined ? { adoptExisting } : {}),
      ...(configuration ? { configuration } : {}),
      ...(expectedHead ? { expectedHead } : {}),
    };

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
          // Unknown is not proof of non-application. Replay the same idempotent
          // request rather than manufacturing a new branch or reservation.
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
        { id: environmentId, configuration }
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
        lastOpenedAt: clock.now(),
        lastScannedAt: scan.lastScannedAt,
      });
      await mirror();
      if (activate) targetRegistry.setActive(project.id, updated.id);
      targetRegistry.clearPendingAttachment?.(operationKey);
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
      if (!error.attachStage) error.attachStage = at;
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
        targetRegistry.addTombstones?.({
          projectIds: removedProjectIds,
          environmentIds: removedEnvironmentIds,
        });
        try {
          await mirror({ removedEnvironmentIds, removedProjectIds });
          targetRegistry.clearTombstones?.();
        } catch {
          // The next startup retries these tombstones before reconciliation.
        }
      }
      if (attachment?.operationId) {
        const cleanup = await abandon({ operationId: attachment.operationId }).catch(
          (cleanupError) => ({ removed: false, reason: 'request-failed', message: cleanupError.message, retryable: true })
        );
        if (cleanup.removed || !cleanup.retryable) {
          targetRegistry.clearPendingAttachment?.(operationKey);
        }
        if (!cleanup.removed && attachment.createdWorkingBranch) {
          error.message = `${error.message} The working branch ${
            cleanup.branch || attachment.source.workingBranch
          } could not be removed (${cleanup.reason || 'unknown'}); delete it on GitHub if it is not needed.`;
        }
      } else if (!attachment && isTerminalAttachFailure(error)) {
        targetRegistry.clearPendingAttachment?.(operationKey);
      }
      throw error;
    }
  }

  return { attachEnvironment, attachLocalSourceEnvironment, attachGitHubEnvironment };
}

function isTerminalAttachFailure(error) {
  if (error?.attachUnconfirmed) return false;
  const status = error?.status;
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 429 || status === 403 || status === 422) return false;
  return status >= 400 && status < 500;
}
