/**
 * Where the edits actually go, proven against a repository.
 *
 * ## The defect these prove fixed
 *
 * A user attached `taomar/citadelQA` on branch `CitadelQA`. Citadel created
 * `citadel-ui/d79d23d1-d638-42fd-a0ff-1992dfbfa2eb` without being asked and
 * wrote every save there. Nothing in the product said so; the only way to find
 * out was to open GitHub and look at the branch list.
 *
 * `branch-target.test.mjs` proves the decision. These prove the consequence:
 * which refs exist in the repository afterwards, which branch the next save
 * commits to, and that a workspace attached before any of this existed keeps
 * writing exactly where it always has.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { BRANCH_CHOICES } from '../server/github/repositories.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

const REPOSITORY_ID = 9701;
const FULL_NAME = 'taomar/citadelQA';
const SOURCE_BRANCH = 'CitadelQA';
const ENVIRONMENT_ID = 'd79d23d1-d638-42fd-a0ff-1992dfbfa2eb';

/**
 * A repository plus a registry whose record can be shaped per test.
 *
 * The registry entry is what the save route reads to decide which branch to
 * commit to, so it is the thing a migration has to get right.
 */
function fixture(source = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: REPOSITORY_ID, fullName: FULL_NAME });
  github.seed(repository, SOURCE_BRANCH, citadelRepositoryFiles());
  const audit = new MemoryAudit();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    audit,
    sessions: new GitHubSessionStore(),
    registryStore: environmentRegistry({
      [ENVIRONMENT_ID]: {
        id: ENVIRONMENT_ID,
        source: {
          kind: 'github',
          repositoryId: REPOSITORY_ID,
          fullName: FULL_NAME,
          sourceBranch: SOURCE_BRANCH,
          workingBranch: SOURCE_BRANCH,
          writeMode: 'direct',
          ...source,
        },
      },
    }),
  });
  return { github, repository, routes, audit };
}

async function connected(context) {
  const session = await context.routes.connect({ token: TEST_TOKEN });
  return session.id;
}

function attach(context, id, body) {
  return context.routes.attach(
    { method: 'POST', headers: { 'x-citadel-github-session': id } },
    { repositoryId: REPOSITORY_ID, sourceBranch: SOURCE_BRANCH, environmentId: ENVIRONMENT_ID, ...body }
  );
}

/** Every `citadel-ui/*` ref in the repository. */
function citadelRefs(repository) {
  return [...repository.refs.keys()].filter((name) => name.startsWith('citadel-ui/')).sort();
}

// --------------------------------------------------------------------------
// Writing to the branch the user chose.
// --------------------------------------------------------------------------

test('choosing your own branch creates no citadel-ui branch at all', async () => {
  const context = fixture();
  const id = await connected(context);

  const result = await attach(context, id, {
    writeMode: 'direct',
    workingBranch: SOURCE_BRANCH,
  });

  assert.equal(result.source.writeMode, 'direct');
  assert.equal(result.source.workingBranch, SOURCE_BRANCH);
  assert.equal(result.source.branchChoice, 'selected');
  assert.equal(result.createdWorkingBranch, false);
  // The complaint, answered: no branch was invented.
  assert.deepEqual(citadelRefs(context.repository), []);
  assert.deepEqual([...context.repository.refs.keys()], [SOURCE_BRANCH]);
});

test('a save in direct mode commits to the selected branch and nowhere else', async () => {
  const context = fixture();
  const id = await connected(context);
  await attach(context, id, { writeMode: 'direct', workingBranch: SOURCE_BRANCH });
  const before = context.repository.refs.get(SOURCE_BRANCH);

  const result = await context.routes.workspace({
    req: { method: 'POST', headers: { 'x-citadel-github-session': id } },
    url: new URL(`/api/github/workspaces/${ENVIRONMENT_ID}/commits`, 'http://127.0.0.1:4173'),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: before,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: 'bicep/infra/direct.bicepparam',
          create: true,
          after: Buffer.from('x\n').toString('base64'),
        },
      ],
    }),
  });

  assert.equal(result.branch, SOURCE_BRANCH);
  assert.equal(context.repository.refs.get(SOURCE_BRANCH), result.commit);
  assert.notEqual(context.repository.refs.get(SOURCE_BRANCH), before);
  assert.deepEqual(citadelRefs(context.repository), []);
});

// --------------------------------------------------------------------------
// The name is the user's, and it is reused.
// --------------------------------------------------------------------------

test('a branch is created with the name the user typed, not one derived from a uuid', async () => {
  const context = fixture();
  const id = await connected(context);

  const result = await attach(context, id, {
    writeMode: 'working-branch',
    workingBranch: 'citadel-ui/my-work',
  });

  assert.equal(result.source.workingBranch, 'citadel-ui/my-work');
  assert.equal(result.source.branchChoice, 'created');
  assert.equal(result.createdWorkingBranch, true);
  assert.deepEqual(citadelRefs(context.repository), ['citadel-ui/my-work']);
  // The opaque name the user complained about is nowhere in the repository.
  assert.equal(context.repository.refs.has(`citadel-ui/${ENVIRONMENT_ID}`), false);
  // Created from the branch they selected, which is not moved.
  assert.equal(
    context.repository.refs.get('citadel-ui/my-work'),
    context.repository.refs.get(SOURCE_BRANCH)
  );
});

test('the named branch is the write target for every later save, not just the first', async () => {
  const context = fixture({ workingBranch: 'citadel-ui/my-work', writeMode: 'working-branch' });
  const id = await connected(context);
  await attach(context, id, {
    writeMode: 'working-branch',
    workingBranch: 'citadel-ui/my-work',
  });

  const commit = async (alias, transactionId) => {
    const head = context.repository.refs.get('citadel-ui/my-work');
    return context.routes.workspace({
      req: { method: 'POST', headers: { 'x-citadel-github-session': id } },
      url: new URL(`/api/github/workspaces/${ENVIRONMENT_ID}/commits`, 'http://127.0.0.1:4173'),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId,
        files: [{ alias, create: true, after: Buffer.from('x\n').toString('base64') }],
      }),
    });
  };

  const first = await commit('bicep/infra/one.bicepparam', '11111111-1111-4111-8111-111111111111');
  const second = await commit('bicep/infra/two.bicepparam', '22222222-2222-4222-8222-222222222222');

  assert.equal(first.branch, 'citadel-ui/my-work');
  assert.equal(second.branch, 'citadel-ui/my-work');
  assert.equal(context.repository.refs.get('citadel-ui/my-work'), second.commit);
  // One branch, reused. Not a second branch per save.
  assert.deepEqual(citadelRefs(context.repository), ['citadel-ui/my-work']);
  assert.equal(context.repository.refs.get(SOURCE_BRANCH) !== second.commit, true);
});

// --------------------------------------------------------------------------
// An existing name is a decision, not a side effect.
// --------------------------------------------------------------------------

test('a typed name that already exists is refused rather than adopted', async () => {
  const context = fixture();
  const id = await connected(context);
  // Somebody else's branch, standing where the user wants to write.
  context.repository.refs.set('shared/work', context.repository.refs.get(SOURCE_BRANCH));

  await assert.rejects(
    attach(context, id, { writeMode: 'working-branch', workingBranch: 'shared/work' }),
    (error) => error.code === 'BRANCH_EXISTS' && error.status === 409
  );
  // Nothing was created, and no provenance is retained for an attach that did
  // not happen.
  assert.equal(context.routes.attachments.size, 0);
});

test('an existing name is adopted only when the user says so, and is recorded as adopted', async () => {
  const context = fixture();
  const id = await connected(context);
  const head = context.repository.refs.get(SOURCE_BRANCH);
  context.repository.refs.set('shared/work', head);

  const result = await attach(context, id, {
    writeMode: 'working-branch',
    workingBranch: 'shared/work',
    adoptExisting: true,
  });

  assert.equal(result.source.workingBranch, 'shared/work');
  assert.equal(result.source.branchChoice, 'adopted');
  // Adopted, never moved or reset.
  assert.equal(context.repository.refs.get('shared/work'), head);
  assert.equal(result.createdWorkingBranch, false);
});

test('naming the source branch as a new branch is refused with an explanation', async () => {
  const context = fixture();
  const id = await connected(context);
  await assert.rejects(
    attach(context, id, { writeMode: 'working-branch', workingBranch: SOURCE_BRANCH }),
    (error) => error.code === 'INVALID_BRANCH' && /branch you selected/.test(error.message)
  );
});

test('an invalid typed name never reaches GitHub', async () => {
  const context = fixture();
  const id = await connected(context);
  const before = [...context.repository.refs.keys()];
  await assert.rejects(
    attach(context, id, { writeMode: 'working-branch', workingBranch: 'my branch' }),
    (error) => error.code === 'INVALID_BRANCH'
  );
  assert.deepEqual([...context.repository.refs.keys()], before);
});

// --------------------------------------------------------------------------
// Recovery must keep working. This is not negotiable.
// --------------------------------------------------------------------------

test('resuming an attempt adopts the branch it already created, refusal notwithstanding', async () => {
  // The refusal above exists to stop a user silently taking over somebody
  // else's branch. A branch *this same operation* created moments ago before
  // losing its answer is not somebody else's, and refusing it would break
  // attachment recovery to enforce a rule that does not apply.
  const context = fixture();
  const id = await connected(context);
  const payload = {
    writeMode: 'working-branch',
    workingBranch: 'citadel-ui/my-work',
    operationKey: 'attach-key-0001',
  };

  const first = await attach(context, id, payload);
  assert.equal(first.createdWorkingBranch, true);

  // The response was lost; the browser retries with the same operation key.
  const retry = await attach(context, id, payload);
  assert.equal(retry.source.workingBranch, 'citadel-ui/my-work');
  assert.equal(retry.operationId, first.operationId);
  // One branch, not two, and not a 409 in the user's face.
  assert.deepEqual(citadelRefs(context.repository), ['citadel-ui/my-work']);
});

test('a caller that supplies no name still gets the derived branch, unchanged', async () => {
  // The API contract that predates branch naming. The browser always supplies a
  // name now, but the server must not break a caller that does not — and a
  // derived name embeds this environment's own id, so adopting it on a re-attach
  // is correct rather than a silent takeover.
  const context = fixture();
  const id = await connected(context);

  const first = await attach(context, id, { writeMode: 'working-branch' });
  assert.equal(first.source.workingBranch, `citadel-ui/${ENVIRONMENT_ID}`);
  assert.equal(first.source.branchChoice, 'created');

  const again = await attach(context, id, { writeMode: 'working-branch' });
  assert.equal(again.source.workingBranch, `citadel-ui/${ENVIRONMENT_ID}`);
  assert.deepEqual(citadelRefs(context.repository), [`citadel-ui/${ENVIRONMENT_ID}`]);
});

// --------------------------------------------------------------------------
// The migration. The user's live workspace must not be disturbed.
// --------------------------------------------------------------------------

test('the live workspace keeps writing to the branch it has always written to', async () => {
  // Exactly the registry record the user has today: a working branch named
  // after the environment uuid, and no `branchChoice`, because that field did
  // not exist when it was attached.
  const legacyBranch = `citadel-ui/${ENVIRONMENT_ID}`;
  const context = fixture({ workingBranch: legacyBranch, writeMode: 'working-branch' });
  const id = await connected(context);
  // The branch exists in the repository, holding their work.
  context.repository.refs.set(legacyBranch, context.repository.refs.get(SOURCE_BRANCH));
  const head = context.repository.refs.get(legacyBranch);
  const refsBefore = [...context.repository.refs.keys()].sort();

  const result = await context.routes.workspace({
    req: { method: 'POST', headers: { 'x-citadel-github-session': id } },
    url: new URL(`/api/github/workspaces/${ENVIRONMENT_ID}/commits`, 'http://127.0.0.1:4173'),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: head,
      transactionId: '33333333-3333-4333-8333-333333333333',
      files: [
        {
          alias: 'bicep/infra/after-migration.bicepparam',
          create: true,
          after: Buffer.from('x\n').toString('base64'),
        },
      ],
    }),
  });

  // Same branch. No rename, no strand, no second branch.
  assert.equal(result.branch, legacyBranch);
  assert.equal(context.repository.refs.get(legacyBranch), result.commit);
  assert.deepEqual([...context.repository.refs.keys()].sort(), refsBefore);
  assert.deepEqual(citadelRefs(context.repository), [legacyBranch]);
  // And the source branch is untouched, as it always was.
  assert.notEqual(context.repository.refs.get(SOURCE_BRANCH), result.commit);
});

test('a legacy record still resolves its branch, and does not crash the route', async () => {
  // Migration was dropped on the user's instruction. The remaining bar is that
  // an old record loads and behaves predictably — the route reads
  // `workingBranch`, which is recorded, so the workspace still resolves.
  const legacyBranch = `citadel-ui/${ENVIRONMENT_ID}`;
  const context = fixture({ workingBranch: legacyBranch, writeMode: 'working-branch' });
  const id = await connected(context);
  context.repository.refs.set(legacyBranch, context.repository.refs.get(SOURCE_BRANCH));

  const tree = await context.routes.workspace({
    req: { method: 'GET', headers: { 'x-citadel-github-session': id } },
    url: new URL(`/api/github/workspaces/${ENVIRONMENT_ID}/tree`, 'http://127.0.0.1:4173'),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });

  assert.equal(tree.branch, legacyBranch);
  assert.equal(tree.sourceBranch, SOURCE_BRANCH);
  assert.equal(tree.writeMode, 'working-branch');
});

test('the branch-choice vocabulary is closed', () => {
  assert.deepEqual([...BRANCH_CHOICES], ['selected', 'created', 'adopted']);
});
