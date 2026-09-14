import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { GitHubRepositoryProvider } from '../web/js/github-provider.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MockGitHub, MemoryAudit, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

/** Real browser/service/routes; only GitHub and the HTTP hop are synthetic. */
export async function githubWorkspaceFixture(options = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'synthetic/review' });
  github.seed(repository, 'main', citadelRepositoryFiles(options.files));
  const environment = {
    id: options.environmentId || 'review-github', projectId: 'synthetic-project', label: 'Synthetic GitHub',
    configuration: createConfiguration('bicep'),
    source: {
      kind: 'github', repositoryId: repository.id, fullName: repository.full_name,
      sourceBranch: 'main', workingBranch: `citadel-ui/${options.environmentId || 'review-github'}`, writeMode: 'working-branch',
    },
  };
  const environments = { [environment.id]: environment };
  const hooks = {};
  const audit = new MemoryAudit();
  const client = new GitHubApiClient({ fetch: (...args) => github.fetch(...args) });
  const routes = new GitHubRoutes({
    client, sessions: new GitHubSessionStore(), registryStore: environmentRegistry(environments), audit,
  });
  const session = await routes.connect({ token: TEST_TOKEN });
  const headers = { 'x-citadel-github-session': session.id };
  await routes.attach({ method: 'POST', headers }, {
    repositoryId: repository.id, sourceBranch: 'main', environmentId: environment.id, writeMode: 'working-branch',
  });
  if (options.filesAfterAttach) {
    github.seed(repository, environment.source.workingBranch, citadelRepositoryFiles(options.filesAfterAttach),
      { parents: [repository.refs.get(environment.source.workingBranch)], message: 'Synthetic external source change' });
  }
  const calls = [];
  const request = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET', body: init.body });
    await hooks.beforeRequest?.(path, init);
    const url = new URL(path, 'http://synthetic.invalid');
    const result = await routes.handle({
      req: { method: init.method || 'GET', headers }, url, parts: url.pathname.split('/').filter(Boolean),
      readBody: async () => JSON.parse(init.body || '{}'),
    });
    await hooks.afterRequest?.(path, init, result);
    return result;
  };
  const provider = new GitHubRepositoryProvider({
    request, environmentId: environment.id, source: environment.source, configuration: environment.configuration,
  });
  const context = { projectId: environment.projectId, environment, provider };
  const coordinator = new GitHubCommitCoordinator({ request, contextProvider: () => context });
  const service = new WorkspaceService({ request, coordinator, contextProvider: () => context });
  const raw = (alias, branch = environment.source.workingBranch) => {
    const entry = github.treeOf(repository.refs.get(branch)).find((file) => file.path === alias);
    return entry ? new Uint8Array(Buffer.from(github.blobs.get(entry.sha), 'base64')) : null;
  };
  return { github, repository, environment, environments, client, audit, routes, request, hooks, calls, provider, context, coordinator, service, raw };
}
