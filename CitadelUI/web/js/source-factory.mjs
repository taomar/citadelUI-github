import { BrowserDirectoryProvider } from './directory-provider.mjs';
import { GitHubRepositoryProvider } from './github-provider.mjs';
import { GitHubCommitCoordinator } from './github-coordinator.mjs';
import { LocalTransactionCoordinator, MutationCoordinator } from './mutation-coordinator.mjs';
import { githubRequest } from './github-session.mjs';
import { environmentSourceOf } from './registry.mjs';

/**
 * Composition root for sources.
 *
 * This is the one place that knows a source kind exists. `WorkspaceService` asks
 * for a provider or a coordinator and never inspects `source.kind` itself, so
 * adding a source later does not touch editor behavior.
 */

export function sourceKind(environment) {
  return environmentSourceOf(environment).kind;
}

/**
 * Build the provider for an environment.
 *
 * @param {object} environment registry record carrying the tagged source union
 * @param {object} deps `getHandle` resolves a retained local directory handle
 */
export async function createProvider(environment, deps = {}) {
  const source = environmentSourceOf(environment);
  if (source.kind === 'github') {
    return new GitHubRepositoryProvider({
      request: deps.githubRequest || githubRequest,
      environmentId: environment.id,
    });
  }
  const handle = await deps.getHandle(environment.id);
  if (!handle) throw new Error('Reconnect the folder for this environment.');
  return new BrowserDirectoryProvider(handle);
}

/**
 * Coordinator that dispatches on the active environment's source kind.
 *
 * The dispatch lives here rather than in `WorkspaceService` so atomicity and
 * concurrency stay owned by the source, and the editor keeps calling one
 * coordinator once per operation.
 */
export class SourceMutationCoordinator extends MutationCoordinator {
  constructor(options = {}) {
    super();
    this.contextProvider = options.contextProvider;
    this.local =
      options.local ||
      new LocalTransactionCoordinator({
        request: options.request,
        commitFiles: options.commitFiles,
        contextProvider: options.contextProvider,
      });
    this.github =
      options.github ||
      new GitHubCommitCoordinator({
        request: options.githubRequest || githubRequest,
        contextProvider: options.contextProvider,
      });
  }

  select(options = {}) {
    const context = options.context || this.contextProvider?.();
    if (!context) throw new Error('No environment is attached.');
    const coordinator = sourceKind(context.environment) === 'github' ? this.github : this.local;
    return { coordinator, context };
  }

  async commit(files, options = {}) {
    const { coordinator, context } = this.select(options);
    return coordinator.commit(files, { ...options, context });
  }

  async history(options = {}) {
    const { coordinator, context } = this.select(options);
    return coordinator.history({ ...options, context });
  }

  async inspect(changeId, options = {}) {
    const { coordinator, context } = this.select(options);
    return coordinator.inspect(changeId, { ...options, context });
  }

  async revert(changeId, options = {}) {
    const { coordinator, context } = this.select(options);
    return coordinator.revert(changeId, { ...options, context });
  }

  async recover(changeId, action, options = {}) {
    const { coordinator, context } = this.select(options);
    return coordinator.recover(changeId, action, { ...options, context });
  }
}
