import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import {
  RepositorySelection,
  isRepositorySelectable,
  repositoryBlockedReason,
} from '../web/js/github-selection.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

/**
 * Multi-repository, multi-branch fixture.
 *
 * These names are test data standing in for a real account, not product
 * knowledge: the picker is driven entirely by what the credential returns.
 * `assertNoHardcodedNames` below proves the shipped modules contain none of
 * them.
 */
function account() {
  const github = new MockGitHub();
  const qa = github.addRepository({
    id: 501,
    fullName: 'taomar/citadelQA',
    defaultBranch: 'CitadelQA',
  });
  const accelerator = github.addRepository({
    id: 502,
    fullName: 'taomar/ai-hub-gateway-solution-accelerator',
    defaultBranch: 'CitadelProd',
  });
  const archived = github.addRepository({
    id: 503,
    fullName: 'taomar/legacy-archive',
    archived: true,
  });
  const readOnly = github.addRepository({
    id: 504,
    fullName: 'contoso/shared-templates',
    canPush: false,
  });
  // Each branch gets a distinguishing file so their heads actually differ. The
  // mock is content-addressed, so identically seeded branches would share one
  // commit SHA and no test could tell "attached CitadelDev" from "attached
  // CitadelProd".
  const branchMarker = (branch) => ({ [`branches/${branch}.bicepparam`]: `// ${branch}\n` });
  for (const branch of ['CitadelQA', 'citadel-v1', 'main']) {
    github.seed(qa, branch, citadelRepositoryFiles(branchMarker(branch)));
  }
  for (const branch of ['CitadelDev', 'CitadelProd', 'citadel-v1', 'main']) {
    github.seed(accelerator, branch, citadelRepositoryFiles(branchMarker(branch)));
  }
  github.seed(archived, 'main', { 'a.bicepparam': 'x\n' });
  github.seed(readOnly, 'main', { 'a.bicepparam': 'x\n' });
  return { github, qa, accelerator, archived, readOnly };
}

async function connectedSelection(fixture, overrides = {}) {
  const sessions = new GitHubSessionStore();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: fixture.github.fetch }),
    sessions,
    audit: new MemoryAudit(),
    registryStore: environmentRegistry({}),
  });
  const session = await routes.connect({ token: TEST_TOKEN });
  const req = { method: 'GET', headers: { 'x-citadel-github-session': session.id } };
  const selection = new RepositorySelection({
    listRepositories: () =>
      routes.handle({
        req,
        url: new URL('http://127.0.0.1:4173/api/github/repos'),
        parts: ['api', 'github', 'repos'],
        readBody: async () => ({}),
      }),
    listBranches: (id) =>
      routes.handle({
        req,
        url: new URL('http://127.0.0.1:4173/api/github/repos'),
        parts: ['api', 'github', 'repos', String(id), 'branches'],
        readBody: async () => ({}),
      }),
    checkCompatibility: async (repositoryId, branch) => ({
      branch,
      head: fixture.github.repositories.get(repositoryId)?.refs.get(branch) || null,
      supported: true,
      missingCapabilities: [],
    }),
    ...overrides,
  });
  await selection.connect({ login: 'octo-dev' });
  return { selection, routes, session };
}

/**
 * Expected display order.
 *
 * The product sorts with `localeCompare`, matching the rest of the codebase, so
 * the assertion is written with the same comparator rather than pinning one
 * locale's collation into the test.
 */
function displayOrder(names) {
  return [...names].sort((left, right) => left.localeCompare(right));
}

test('every repository the token can reach is listed, including private ones', async () => {
  const fixture = account();
  const { selection } = await connectedSelection(fixture);
  assert.deepEqual(
    selection.repositories.map((repository) => repository.fullName),
    [
      'contoso/shared-templates',
      'taomar/ai-hub-gateway-solution-accelerator',
      'taomar/citadelQA',
      'taomar/legacy-archive',
    ]
  );
  assert.equal(
    selection.repositories.every((repository) => repository.visibility === 'private'),
    true
  );
  // Repositories that cannot receive commits are shown but not selectable, so a
  // user can see why rather than wondering where the repository went.
  assert.equal(repositoryBlockedReason(fixture.github.repositories.get(503) && selection.repositories.find((r) => r.id === 503)), 'archived');
  assert.equal(selection.repositories.find((r) => r.id === 504).canPush, false);
  assert.equal(isRepositorySelectable(selection.repositories.find((r) => r.id === 504)), false);
  assert.equal(isRepositorySelectable(selection.repositories.find((r) => r.id === 501)), true);
});

test('branches are listed dynamically for whichever repository is selected', async () => {
  const fixture = account();
  const { selection } = await connectedSelection(fixture);

  await selection.selectRepository(501);
  assert.deepEqual(
    selection.branches.map((branch) => branch.name),
    displayOrder(['CitadelQA', 'citadel-v1', 'main'])
  );
  // Nothing is preselected. The branch decides which tree Citadel edits, so a
  // user who never looked at the control must not attach one by default.
  assert.equal(selection.branch, '');

  await selection.selectRepository(502);
  assert.deepEqual(
    selection.branches.map((branch) => branch.name),
    displayOrder(['CitadelDev', 'CitadelProd', 'citadel-v1', 'main'])
  );
  assert.equal(selection.branch, '');

  assert.equal(selection.selectBranch('CitadelDev'), 'CitadelDev');
  assert.equal(selection.selectBranch('does-not-exist'), '');
});

test('a branch must be chosen before a repository can be attached', async () => {
  const fixture = account();
  const { selection } = await connectedSelection(fixture);

  await selection.selectRepository(501);
  assert.equal(selection.branch, '');
  assert.equal(selection.canAttach(), false, 'no branch chosen yet');
  assert.throws(() => selection.attachment(), /Select a repository and branch/);
});

test('switching repository resets branch state, including a stale branch filter', async () => {
  const fixture = account();
  const { selection } = await connectedSelection(fixture);

  await selection.selectRepository(501);
  selection.selectBranch('citadel-v1');
  selection.setBranchFilter('QA');
  assert.deepEqual(selection.visibleBranches().map((branch) => branch.name), ['CitadelQA']);

  await selection.selectRepository(502);
  // A filter typed for the previous repository must not hide the new one's
  // branches, and the previous branch must not remain selected.
  assert.equal(selection.branchFilter, '');
  assert.equal(selection.branch, '', 'switching repository clears the branch choice');
  assert.deepEqual(
    selection.visibleBranches().map((branch) => branch.name),
    displayOrder(['CitadelDev', 'CitadelProd', 'citadel-v1', 'main'])
  );
});

test('an out-of-order branch response cannot leak into a later repository', async () => {
  const fixture = account();
  const pending = new Map();
  const { selection } = await connectedSelection(fixture, {
    listBranches: (id) =>
      new Promise((resolve) => {
        pending.set(id, resolve);
      }),
  });

  const first = selection.selectRepository(501);
  const second = selection.selectRepository(502);
  // The slow first response lands after the user already moved on.
  pending.get(501)({ branches: [{ name: 'stale-branch' }] });
  pending.get(502)({ branches: [{ name: 'CitadelDev' }, { name: 'CitadelProd' }] });
  await Promise.all([first, second]);

  assert.equal(selection.repository.id, 502);
  assert.deepEqual(
    selection.branches.map((branch) => branch.name),
    ['CitadelDev', 'CitadelProd']
  );
  // Nothing is preselected from the second repository either.
  assert.equal(selection.branch, '');
  assert.equal(selection.branches.some((branch) => branch.name === 'stale-branch'), false);
});

test('filters narrow repositories and branches without touching the selection', async () => {
  const fixture = account();
  const { selection } = await connectedSelection(fixture);

  selection.setRepositoryFilter('citadelqa');
  assert.deepEqual(
    selection.visibleRepositories().map((repository) => repository.fullName),
    ['taomar/citadelQA']
  );
  selection.setRepositoryFilter('taomar/');
  assert.equal(selection.visibleRepositories().length, 3);
  selection.setRepositoryFilter('nothing-matches');
  assert.deepEqual(selection.visibleRepositories(), []);

  selection.setRepositoryFilter('');
  await selection.selectRepository(502);
  selection.setBranchFilter('citadel');
  assert.deepEqual(
    selection.visibleBranches().map((branch) => branch.name),
    displayOrder(['CitadelDev', 'CitadelProd', 'citadel-v1'])
  );
  // Filtering is a view concern only, and still selects nothing on its own.
  assert.equal(selection.branch, '');
});

test('attachment carries the immutable repository id and the selected branch', async () => {
  const fixture = account();
  const { selection, routes, session } = await connectedSelection(fixture);

  assert.throws(() => selection.attachment(), /Select a repository and branch/);

  await selection.selectRepository(502);
  selection.selectBranch('CitadelDev');
  await selection.validate();
  // The default is now the branch the user picked. Creating a working branch is
  // an opt-in they name themselves, because attaching used to invent
  // `citadel-ui/<uuid>` without anybody choosing it and then write every edit
  // there. The user asked for this to change.
  assert.deepEqual(selection.attachment(), {
    repositoryId: 502,
    sourceBranch: 'CitadelDev',
    writeMode: 'direct',
    workingBranch: 'CitadelDev',
    adoptExisting: false,
    expectedHead: fixture.accelerator.refs.get('CitadelDev'),
  });

  // Opting in, and naming it.
  selection.setWriteMode('working-branch');
  assert.equal(selection.canAttach(), false, 'an unnamed branch must not be attachable');
  selection.setNewBranchName('citadel-ui/accel-work');
  assert.deepEqual(selection.attachment(), {
    repositoryId: 502,
    sourceBranch: 'CitadelDev',
    writeMode: 'working-branch',
    workingBranch: 'citadel-ui/accel-work',
    adoptExisting: false,
    expectedHead: fixture.accelerator.refs.get('CitadelDev'),
  });

  const attached = await routes.attach(
    { method: 'POST', headers: { 'x-citadel-github-session': session.id } },
    { ...selection.attachment(), environmentId: 'env-accel' }
  );
  assert.deepEqual(attached.source, {
    kind: 'github',
    // Ownership comes from the credential that performed the attach. This
    // session was created without a saved connection, so there is none — and it
    // is recorded as null rather than invented.
    connectionProfileId: null,
    repositoryId: 502,
    fullName: 'taomar/ai-hub-gateway-solution-accelerator',
    sourceBranch: 'CitadelDev',
    // The name the user typed, not one derived from an identifier they have
    // never seen.
    workingBranch: 'citadel-ui/accel-work',
    writeMode: 'working-branch',
    branchChoice: 'created',
    lastKnownHead: fixture.accelerator.refs.get('citadel-ui/accel-work'),
    capabilities: attached.source.capabilities,
    validatedAt: attached.source.validatedAt,
  });
  assert.ok(Array.isArray(attached.source.capabilities));
  assert.ok(!Number.isNaN(Date.parse(attached.source.validatedAt)));
  // No branch named after the environment id exists at all.
  assert.equal(fixture.accelerator.refs.has('citadel-ui/env-accel'), false);
  // The chosen source branch is the parent of the working branch and is not moved.
  assert.equal(
    fixture.accelerator.refs.get('citadel-ui/accel-work'),
    fixture.accelerator.refs.get('CitadelDev')
  );
  assert.notEqual(
    fixture.accelerator.refs.get('CitadelDev'),
    fixture.accelerator.refs.get('CitadelProd')
  );
});

test('direct write mode attaches the selected branch itself', async () => {
  const fixture = account();
  const { selection, routes, session } = await connectedSelection(fixture);
  await selection.selectRepository(501);
  selection.selectBranch('citadel-v1');
  await selection.validate();
  assert.equal(selection.setWriteMode('direct'), 'direct');
  const attached = await routes.attach(
    { method: 'POST', headers: { 'x-citadel-github-session': session.id } },
    { ...selection.attachment(), environmentId: 'env-direct' }
  );
  assert.equal(attached.source.sourceBranch, 'citadel-v1');
  assert.equal(attached.source.workingBranch, 'citadel-v1');
  assert.equal(attached.createdWorkingBranch, false);
  assert.equal(fixture.qa.refs.has('citadel-ui/env-direct'), false);
});

test('a blocked repository can never be attached', async () => {
  const fixture = account();
  const { selection, routes, session } = await connectedSelection(fixture);
  for (const id of [503, 504]) {
    await selection.selectRepository(id);
    assert.equal(selection.canAttach(), false, String(id));
    assert.throws(() => selection.attachment(), /Select a repository and branch/);
    await assert.rejects(
      routes.attach(
        { method: 'POST', headers: { 'x-citadel-github-session': session.id } },
        { repositoryId: id, sourceBranch: 'main', environmentId: 'env-blocked' }
      ),
      (error) => ['REPOSITORY_ARCHIVED', 'REPOSITORY_READ_ONLY'].includes(error.code)
    );
  }
});

test('two environments can attach different repositories and different branches', async () => {
  const fixture = account();
  const { selection, routes, session } = await connectedSelection(fixture);
  const req = { method: 'POST', headers: { 'x-citadel-github-session': session.id } };

  await selection.selectRepository(501);
  selection.selectBranch('CitadelQA');
  await selection.validate();
  selection.setWriteMode('working-branch');
  selection.setNewBranchName('citadel-ui/qa-work');
  const first = await routes.attach(req, { ...selection.attachment(), environmentId: 'env-qa' });

  await selection.selectRepository(502);
  selection.selectBranch('CitadelProd');
  await selection.validate();
  selection.setWriteMode('working-branch');
  selection.setNewBranchName('citadel-ui/prod-work');
  const second = await routes.attach(req, { ...selection.attachment(), environmentId: 'env-prod' });

  assert.notEqual(first.source.repositoryId, second.source.repositoryId);
  assert.notEqual(first.source.workingBranch, second.source.workingBranch);
  assert.equal(fixture.qa.refs.get('citadel-ui/qa-work'), fixture.qa.refs.get('CitadelQA'));
  assert.equal(
    fixture.accelerator.refs.get('citadel-ui/prod-work'),
    fixture.accelerator.refs.get('CitadelProd')
  );
});

test('constructing a selection never notifies its renderer', () => {
  // A renderer closes over the instance being constructed, so notifying from the
  // constructor throws a temporal-dead-zone error before the panel can mount.
  let notified = 0;
  const selection = new RepositorySelection({
    onChange: () => {
      notified += 1;
      // Touching the binding under construction is what a real renderer does.
      assert.ok(selection);
    },
  });
  assert.equal(notified, 0);
  assert.equal(selection.connected, false);
  selection.reset();
  assert.equal(notified, 1);
});

test('disconnect clears every selection so nothing carries into a new credential', async () => {
  const fixture = account();
  const { selection } = await connectedSelection(fixture);
  await selection.selectRepository(501);
  selection.setRepositoryFilter('citadel');
  selection.setWriteMode('direct');
  selection.reset();
  assert.equal(selection.connected, false);
  assert.deepEqual(selection.repositories, []);
  assert.equal(selection.repository, null);
  assert.deepEqual(selection.branches, []);
  assert.equal(selection.branch, '');
  assert.equal(selection.repositoryFilter, '');
  assert.equal(selection.branchFilter, '');
  // Reset returns to the honest default: write to the branch you selected.
  assert.equal(selection.writeMode, 'direct');
  assert.equal(selection.newBranchName, '');
  assert.equal(selection.adoptExisting, false);
  assert.equal(selection.canAttach(), false);
});

test('a second Connect cannot display the first credential\u2019s repositories', async () => {
  const first = account();
  // A different account: overlapping ids would hide the defect.
  const second = new MockGitHub();
  const other = second.addRepository({ id: 901, fullName: 'contoso/platform' });
  second.seed(other, 'main', { 'bicep/infra/main.bicepparam': "using 'main.bicep'\n" });

  const sessions = new GitHubSessionStore();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: first.github.fetch }),
    sessions,
    audit: new MemoryAudit(),
    registryStore: environmentRegistry({}),
  });
  const secondRoutes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: second.fetch }),
    sessions,
    audit: new MemoryAudit(),
    registryStore: environmentRegistry({}),
  });

  let active = routes;
  const revoked = [];
  const selection = new RepositorySelection({
    listRepositories: () =>
      active.handle({
        req: { method: 'GET', headers: { 'x-citadel-github-session': active.currentSession } },
        url: new URL('http://127.0.0.1:4173/api/github/repos'),
        parts: ['api', 'github', 'repos'],
        readBody: async () => ({}),
      }),
    listBranches: async () => ({ branches: [] }),
  });

  // Connection A is slow. Connection B is started before A resolves.
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const connectA = async () => {
    const session = await routes.connect({ token: TEST_TOKEN });
    routes.currentSession = session.id;
    await gate;
    return {
      login: 'octo-a',
      revoke: async () => {
        revoked.push('a');
        await routes.handle({
          req: { method: 'DELETE', headers: { 'x-citadel-github-session': session.id } },
          url: new URL('http://127.0.0.1:4173/api/github/sessions'),
          parts: ['api', 'github', 'sessions', session.id],
          readBody: async () => ({}),
        });
      },
    };
  };

  const pending = selection.beginConnect(connectA, TEST_TOKEN);

  // While A is in flight the control is locked, so a second Connect cannot be
  // started at all: two overlapping sessions is the defect.
  assert.equal(selection.connecting, true);
  await assert.rejects(
    selection.beginConnect(connectA, TEST_TOKEN),
    /already in progress/
  );

  // The user disconnects instead, which supersedes the pending attempt and
  // releases the control.
  selection.reset();
  assert.equal(selection.connecting, false);
  releaseFirst();
  assert.equal(await pending, null);
  // A's credential was revoked rather than left occupying a session slot.
  assert.deepEqual(revoked, ['a']);
  assert.deepEqual(selection.repositories, []);

  // B now connects and sees only its own repositories.
  active = secondRoutes;
  const sessionB = await secondRoutes.connect({ token: TEST_TOKEN });
  secondRoutes.currentSession = sessionB.id;
  await selection.beginConnect(async () => ({ login: 'octo-b' }), TEST_TOKEN);
  assert.deepEqual(
    selection.repositories.map((repository) => repository.fullName),
    ['contoso/platform']
  );

  // A's session is gone, so it consumes no limit and is unreachable.
  await assert.rejects(
    routes.handle({
      req: { method: 'GET', headers: { 'x-citadel-github-session': routes.currentSession } },
      url: new URL('http://127.0.0.1:4173/api/github/repos'),
      parts: ['api', 'github', 'repos'],
      readBody: async () => ({}),
    }),
    (error) => error.status === 401
  );
});

test('a repository response from a superseded connection is discarded', async () => {
  let resolveList;
  const selection = new RepositorySelection({
    listRepositories: () =>
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    listBranches: async () => ({ branches: [] }),
  });
  selection.account = { login: 'octo-a' };
  const pending = selection.loadRepositories();
  // The user disconnects before the list arrives.
  selection.reset();
  resolveList({ repositories: [{ id: 1, fullName: 'stale/repo', canPush: true }] });
  await pending;
  assert.deepEqual(selection.repositories, []);
  assert.equal(selection.loading, false);
});

test('no repository or branch name is hardcoded in the shipped application', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const roots = ['web/js', 'shared', 'server'].map((part) =>
    fileURLToPath(new URL(`../${part}/`, import.meta.url))
  );
  const forbidden = [
    'citadelQA',
    'ai-hub-gateway-solution-accelerator',
    'CitadelDev',
    'CitadelProd',
    'citadel-v1',
  ];
  const walk = async (directory) => {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(path)));
      else if (entry.name.endsWith('.mjs')) found.push(path);
    }
    return found;
  };
  for (const root of roots) {
    for (const file of await walk(root)) {
      const text = await readFile(file, 'utf8');
      for (const name of forbidden) {
        assert.equal(text.includes(name), false, `${file} must not hardcode ${name}`);
      }
    }
  }
});
