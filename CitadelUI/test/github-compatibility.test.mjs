import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { workingBranchName } from '../server/github/repositories.mjs';
import { primaryCapabilities } from '../shared/citadel-core.mjs';
import { citadelRepositoryFiles, incompatibleRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN } from './_github-mock.mjs';

function context() {
  const records = {};
  const github = new MockGitHub();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    sessions: new GitHubSessionStore(),
    registryStore: { getEnvironment: async (id) => records[id] || null },
    audit: new MemoryAudit(),
  });
  return { github, routes, records };
}

async function session(routes) {
  const connected = await routes.connect({ token: TEST_TOKEN });
  return connected.id;
}

function req(sessionId, method = 'GET') {
  return { method, headers: { 'x-citadel-github-session': sessionId } };
}

function routeUrl(path) {
  return new URL(path, 'http://127.0.0.1:4173');
}

async function compatibility(routes, sessionId, repositoryId, branch = 'main') {
  const url = routeUrl(`/api/github/repos/${repositoryId}/compatibility?branch=${branch}`);
  return routes.handle({
    req: req(sessionId),
    url,
    parts: url.pathname.split('/').filter(Boolean),
    readBody: async () => ({}),
  });
}

async function attach(routes, sessionId, body) {
  return routes.attach(req(sessionId, 'POST'), {
    repositoryId: body.repositoryId,
    sourceBranch: body.sourceBranch || 'main',
    environmentId: body.environmentId || 'env-test',
    writeMode: body.writeMode || 'working-branch',
    ...(body.expectedHead ? { expectedHead: body.expectedHead } : {}),
  });
}

test('attach rejects an ordinary repository before creating local state', async () => {
  const cx = context();
  const repository = cx.github.addRepository({ id: 9101, fullName: 'taomar/ordinary' });
  cx.github.seed(repository, 'main', incompatibleRepositoryFiles());
  const id = await session(cx.routes);

  await assert.rejects(
    attach(cx.routes, id, { repositoryId: 9101, environmentId: 'env-ordinary' }),
    (error) => error.status === 422 && error.code === 'REPOSITORY_UNSUPPORTED'
  );
  assert.equal(repository.refs.has(workingBranchName('env-ordinary')), false);
  assert.deepEqual(cx.records, {});
});

test('compatibility route reports supported and unsupported repositories read-only', async () => {
  const cx = context();
  const valid = cx.github.addRepository({ id: 9201, fullName: 'taomar/valid' });
  const invalid = cx.github.addRepository({ id: 9202, fullName: 'taomar/invalid' });
  cx.github.seed(valid, 'main', citadelRepositoryFiles());
  cx.github.seed(invalid, 'main', incompatibleRepositoryFiles());
  const id = await session(cx.routes);

  const supported = await compatibility(cx.routes, id, 9201);
  assert.equal(supported.supported, true);
  assert.deepEqual(supported.missingCapabilities, []);
  assert.deepEqual(supported.detected, ['Main deployment', 'LLM onboarding', 'Access contracts']);

  const unsupported = await compatibility(cx.routes, id, 9202);
  assert.equal(unsupported.supported, false);
  assert(unsupported.missingCapabilities.length > 0);
  assert.equal(valid.refs.has('citadel-ui/env-test'), false);
  assert.equal(invalid.refs.has('citadel-ui/env-test'), false);
});

test('repository compatibility is structural rather than name-based', async () => {
  const cx = context();
  const ordinaryName = cx.github.addRepository({ id: 9301, fullName: 'taomar/anything-at-all' });
  const citadelName = cx.github.addRepository({ id: 9302, fullName: 'taomar/citadel-but-empty' });
  cx.github.seed(ordinaryName, 'main', citadelRepositoryFiles());
  cx.github.seed(citadelName, 'main', incompatibleRepositoryFiles());
  const id = await session(cx.routes);

  const accepted = await attach(cx.routes, id, { repositoryId: 9301, environmentId: 'env-ordinary-name' });
  assert.equal(accepted.source.fullName, 'taomar/anything-at-all');

  await assert.rejects(
    attach(cx.routes, id, { repositoryId: 9302, environmentId: 'env-citadel-name' }),
    (error) => error.status === 422 && error.code === 'REPOSITORY_UNSUPPORTED'
  );
});

test('degraded repositories are reported but are not attachable', async () => {
  const cx = context();
  const files = citadelRepositoryFiles();
  delete files[primaryCapabilities.llmPath];
  const repository = cx.github.addRepository({ id: 9401, fullName: 'taomar/partial' });
  cx.github.seed(repository, 'main', files);
  const id = await session(cx.routes);

  const result = await compatibility(cx.routes, id, 9401);
  assert.equal(result.compatibility, 'degraded');
  assert.equal(result.supported, false);
  assert(result.missingCapabilities.includes(primaryCapabilities.llmPath));

  await assert.rejects(
    attach(cx.routes, id, { repositoryId: 9401, environmentId: 'env-partial' }),
    (error) => error.status === 422 && error.code === 'REPOSITORY_UNSUPPORTED'
  );
});

test('attach rejects a stale compatibility head without creating a branch', async () => {
  const cx = context();
  const repository = cx.github.addRepository({ id: 9501, fullName: 'taomar/race' });
  cx.github.seed(repository, 'main', citadelRepositoryFiles());
  const id = await session(cx.routes);
  const checked = { head: repository.refs.get('main') };
  cx.github.seed(
    repository,
    'main',
    citadelRepositoryFiles({ 'README.md': '# moved\n' }),
    { parents: [checked.head], message: 'move branch' }
  );

  await assert.rejects(
    attach(cx.routes, id, {
      repositoryId: 9501,
      environmentId: 'env-race',
      expectedHead: checked.head,
    }),
    (error) => error.status === 409 && error.code === 'REPOSITORY_MOVED'
  );
  assert.equal(repository.refs.has(workingBranchName('env-race')), false);
});

test('attach succeeds when expectedHead matches the branch head', async () => {
  const cx = context();
  const repository = cx.github.addRepository({ id: 9601, fullName: 'taomar/expected-head' });
  cx.github.seed(repository, 'main', citadelRepositoryFiles());
  const id = await session(cx.routes);
  const checked = { head: repository.refs.get('main') };

  const result = await attach(cx.routes, id, {
    repositoryId: 9601,
    environmentId: 'env-head-ok',
    expectedHead: checked.head,
  });
  assert.equal(result.createdWorkingBranch, true);
  assert.equal(repository.refs.get(workingBranchName('env-head-ok')), checked.head);
});
