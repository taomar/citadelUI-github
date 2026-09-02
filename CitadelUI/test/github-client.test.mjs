import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { GitHubRepositoryProvider } from '../web/js/github-provider.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { SourceMutationCoordinator } from '../web/js/source-factory.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

const ENVIRONMENT_ID = 'env-github-one';
const BRANCH = 'citadel-ui/env-github-one';
const MAIN = 'bicep/infra/main.bicepparam';

/**
 * Wire the browser modules to the real server routes over the mocked GitHub API.
 * Only the HTTP hop is replaced, so the provider, coordinator, routes, and Git
 * protocol are all exercised together.
 */
async function harness(options = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'main', {
    ...citadelRepositoryFiles(options.files || {}),
  });
  const sessions = new GitHubSessionStore();
  const audit = new MemoryAudit();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    audit,
    sessions,
    registryStore: environmentRegistry({
      [ENVIRONMENT_ID]: {
        id: ENVIRONMENT_ID,
        source: {
          kind: 'github',
          repositoryId: 9001,
          fullName: 'taomar/citadelQA',
          sourceBranch: 'main',
          workingBranch: BRANCH,
          writeMode: 'working-branch',
        },
      },
    }),
  });
  const session = await routes.connect({ token: TEST_TOKEN });
  await routes.attach(
    { method: 'POST', headers: { 'x-citadel-github-session': session.id } },
    {
      repositoryId: 9001,
      sourceBranch: 'main',
      environmentId: ENVIRONMENT_ID,
      writeMode: 'working-branch',
    }
  );

  const calls = [];
  const request = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET' });
    const url = new URL(path, 'http://127.0.0.1:4173');
    const parts = url.pathname.split('/').filter(Boolean);
    return routes.handle({
      req: {
        method: init.method || 'GET',
        headers: { 'x-citadel-github-session': session.id },
      },
      url,
      parts,
      readBody: async () => JSON.parse(init.body || '{}'),
    });
  };

  const provider = new GitHubRepositoryProvider({ request, environmentId: ENVIRONMENT_ID });
  const environment = {
    id: ENVIRONMENT_ID,
    projectId: 'project-one',
    label: 'GitHub QA',
    source: {
      kind: 'github',
      repositoryId: 9001,
      fullName: 'taomar/citadelQA',
      sourceBranch: 'main',
      workingBranch: BRANCH,
      writeMode: 'working-branch',
    },
  };
  const context = { projectId: 'project-one', environment, provider };
  return { github, repository, routes, provider, context, request, calls, environment };
}

test('the GitHub provider enumerates and reads pinned to one commit', async () => {
  const harnessed = await harness();
  const entries = await harnessed.provider.entries();
  const aliases = entries.map((entry) => entry.alias).sort();
  assert(aliases.includes('bicep/infra/main.bicep'));
  assert(aliases.includes(MAIN));
  assert.deepEqual(entries.find((entry) => entry.alias === MAIN).kind, 'bicepparam');

  const source = await harnessed.provider.read(MAIN);
  assert.match(source.text, /environmentName = 'dev'/);
  assert.equal(source.size, source.bytes.byteLength);
  assert.equal(source.workspaceHead, harnessed.repository.refs.get(BRANCH));
  assert.match(source.version, /^[0-9a-f]{40}$/);
  assert.equal(source.lastModified, null);

  // The second read is served from the immutable blob cache.
  const before = harnessed.calls.length;
  await harnessed.provider.read(MAIN);
  assert.equal(harnessed.calls.length, before);
});

test('the GitHub provider verifies bytes against the server hash', async () => {
  const harnessed = await harness();
  const provider = new GitHubRepositoryProvider({
    environmentId: ENVIRONMENT_ID,
    request: async (path, init) => {
      const result = await harnessed.request(path, init);
      if (path.includes('/blob')) return { ...result, hash: 'f'.repeat(64) };
      return result;
    },
  });
  await assert.rejects(provider.read(MAIN), /hash verification failed/);
});

test('the GitHub provider refuses per-file writes and removals', async () => {
  const harnessed = await harness();
  await assert.rejects(harnessed.provider.write(MAIN, new Uint8Array()), /one commit/);
  await assert.rejects(harnessed.provider.remove(MAIN), /one commit/);
  assert.deepEqual(await harnessed.provider.missingDirectories(MAIN), []);
  await assert.rejects(harnessed.provider.read('bicep/infra/absent.bicepparam'), {
    name: 'NotFoundError',
  });
});

test('a parameter save through WorkspaceService becomes exactly one commit', async () => {
  const harnessed = await harness();
  const coordinator = new GitHubCommitCoordinator({
    request: harnessed.request,
    contextProvider: () => harnessed.context,
  });
  const service = new WorkspaceService({
    request: harnessed.request,
    coordinator,
    contextProvider: () => harnessed.context,
  });

  const before = await harnessed.provider.read(MAIN);
  const head = harnessed.repository.refs.get(BRANCH);
  const commitsBefore = harnessed.github.commits.size;

  const result = await service.save(
    MAIN,
    [{ op: 'set', path: ['environmentName'], value: 'production' }],
    before.hash
  );
  assert.equal(result.changed, true);

  const after = harnessed.repository.refs.get(BRANCH);
  assert.notEqual(after, head);
  assert.equal(harnessed.github.commits.get(after).parents[0], head);
  assert.equal(harnessed.github.commits.size, commitsBefore + 1);
  assert.match(
    harnessed.github.fileText(harnessed.repository, BRANCH, MAIN),
    /environmentName = 'production'/
  );
  // Comment and byte fidelity: only the edited value changed.
  assert.match(
    harnessed.github.fileText(harnessed.repository, BRANCH, MAIN),
    /param location = 'westeurope'/
  );
  assert.match(
    harnessed.github.commits.get(after).message,
    /Citadel-Action: parameter-edit/
  );
});

test('a save reviewed against stale bytes is rejected before any commit', async () => {
  const harnessed = await harness();
  const coordinator = new GitHubCommitCoordinator({
    request: harnessed.request,
    contextProvider: () => harnessed.context,
  });
  const service = new WorkspaceService({
    request: harnessed.request,
    coordinator,
    contextProvider: () => harnessed.context,
  });
  const head = harnessed.repository.refs.get(BRANCH);
  const commitsBefore = harnessed.github.commits.size;
  await assert.rejects(
    service.save(MAIN, [{ op: 'set', path: ['environmentName'], value: 'x' }], 'a'.repeat(64)),
    /Reload before saving/
  );
  assert.equal(harnessed.repository.refs.get(BRANCH), head);
  assert.equal(harnessed.github.commits.size, commitsBefore);
});

test('contract creation writes both files in one commit and undo removes both', async () => {
  const harnessed = await harness();
  const coordinator = new GitHubCommitCoordinator({
    request: harnessed.request,
    contextProvider: () => harnessed.context,
  });
  const head = harnessed.repository.refs.get(BRANCH);
  const created = await coordinator.commit(
    [
      {
        alias: 'bicep/infra/citadel-access-contracts/contracts/team/main.bicepparam',
        create: true,
        after: new TextEncoder().encode("using '../../main.bicep'\n"),
      },
      {
        alias: 'bicep/infra/citadel-access-contracts/contracts/team/ai-product-policy.xml',
        create: true,
        after: new TextEncoder().encode('<policies/>\n'),
      },
    ],
    { action: 'contract-create', context: harnessed.context }
  );
  assert.equal(harnessed.github.commits.get(created.commit).parents[0], head);
  assert.equal(
    harnessed.github.treeOf(created.commit).filter((entry) =>
      entry.path.includes('/contracts/team/')
    ).length,
    2
  );

  const undone = await coordinator.revert(created.commit, { context: harnessed.context });
  assert.equal(
    harnessed.github.treeOf(undone.commit).filter((entry) =>
      entry.path.includes('/contracts/team/')
    ).length,
    0
  );
  // History is appended, never rewritten.
  assert.equal(harnessed.github.commits.has(created.commit), true);
  assert.equal(harnessed.github.commits.get(undone.commit).parents[0], created.commit);
});

test('History lists only Citadel commits for this environment', async () => {
  const harnessed = await harness();
  const coordinator = new GitHubCommitCoordinator({
    request: harnessed.request,
    contextProvider: () => harnessed.context,
  });
  await coordinator.commit(
    [
      {
        alias: 'bicep/infra/extra.bicepparam',
        create: true,
        after: new TextEncoder().encode("using 'main.bicep'\n"),
      },
    ],
    { action: 'parameter-edit', context: harnessed.context }
  );
  // An unrelated push by someone else must not appear in Citadel History.
  const head = harnessed.repository.refs.get(BRANCH);
  harnessed.repository.refs.set(
    BRANCH,
    harnessed.github.writeCommit(harnessed.github.commits.get(head).tree, [head], 'chore: unrelated')
  );
  const history = await coordinator.history({ context: harnessed.context });
  assert.equal(history.transactions.length, 1);
  assert.equal(history.transactions[0].action, 'parameter-edit');
});

test('a subscription save works when driven exactly as the UI drives it', async () => {
  const original = 'AZURE_ENV_NAME="dev"\nAZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"\n';
  const harnessed = await harness({ files: { '.azure/dev/.env': original } });
  const service = new WorkspaceService({
    request: harnessed.request,
    coordinator: new GitHubCommitCoordinator({
      request: harnessed.request,
      contextProvider: () => harnessed.context,
    }),
    contextProvider: () => harnessed.context,
  });

  const before = await harnessed.provider.readSubscriptionId('dev');
  assert.equal(before.value, '00000000-0000-0000-0000-000000000000');

  // Three arguments, exactly as WorkspaceService.saveSubscriptionId is called
  // from the parameter editor. Nothing extra is threaded through the UI.
  const saved = await service.saveSubscriptionId(
    'dev',
    '11111111-2222-3333-4444-555555555555',
    before.hash
  );
  assert.equal(saved.changed, true);
  assert.equal(saved.value, '11111111-2222-3333-4444-555555555555');
  assert.equal(
    harnessed.github.fileText(harnessed.repository, BRANCH, '.azure/dev/.env'),
    original.replace(
      '00000000-0000-0000-0000-000000000000',
      '11111111-2222-3333-4444-555555555555'
    )
  );

  // A second save with a now-stale reviewed hash must be refused.
  await assert.rejects(
    service.saveSubscriptionId('dev', '22222222-2222-3333-4444-555555555555', before.hash),
    /changed outside Citadel UI/
  );
});

test('a subscription file can be created when it is absent', async () => {
  const harnessed = await harness();
  const service = new WorkspaceService({
    request: harnessed.request,
    coordinator: new GitHubCommitCoordinator({
      request: harnessed.request,
      contextProvider: () => harnessed.context,
    }),
    contextProvider: () => harnessed.context,
  });
  const before = await harnessed.provider.readSubscriptionId('dev');
  assert.equal(before.available, false);
  assert.equal(before.hash, null);

  const saved = await service.saveSubscriptionId(
    'dev',
    '11111111-2222-3333-4444-555555555555',
    before.hash
  );
  assert.equal(saved.changed, true);
  assert.equal(
    harnessed.github.fileText(harnessed.repository, BRANCH, '.azure/dev/.env'),
    'AZURE_SUBSCRIPTION_ID="11111111-2222-3333-4444-555555555555"\n'
  );
});

test('the source coordinator dispatches on the attached source kind', async () => {
  const seen = [];
  const stub = (name) => ({
    commit: async () => (seen.push(`${name}:commit`), { transactionId: name }),
    history: async () => (seen.push(`${name}:history`), { transactions: [] }),
    inspect: async () => (seen.push(`${name}:inspect`), {}),
    revert: async () => (seen.push(`${name}:revert`), {}),
    recover: async () => (seen.push(`${name}:recover`), {}),
  });
  let environment = { id: 'a', source: { kind: 'local', folderName: 'citadel' } };
  const coordinator = new SourceMutationCoordinator({
    contextProvider: () => ({ environment, provider: {} }),
    local: stub('local'),
    github: stub('github'),
  });
  await coordinator.commit([]);
  await coordinator.history();
  environment = {
    id: 'b',
    source: {
      kind: 'github',
      repositoryId: 1,
      fullName: 'o/r',
      sourceBranch: 'main',
      workingBranch: 'citadel-ui/b',
    },
  };
  await coordinator.commit([]);
  await coordinator.revert('sha');
  assert.deepEqual(seen, [
    'local:commit',
    'local:history',
    'github:commit',
    'github:revert',
  ]);

  // A v2 record with no source union is still treated as local.
  environment = { id: 'c', folderName: 'citadel', localPath: 'C:\\citadel' };
  await coordinator.inspect('x');
  assert.equal(seen.at(-1), 'local:inspect');
});
