/**
 * A discrepancy between the container and GitHub must still reach an outcome.
 *
 * ## The defect these prove fixed
 *
 * A working branch refuses a commit for two ordinary reasons: someone else
 * pushed to it, or it is protected. Citadel reported both as failed saves —
 * *"your edits were not applied; reload and review again"* — and that was wrong
 * twice. By the time the branch refuses it, the blob, the tree, the commit with
 * the reviewed parent and the audit record all exist; only the ref update
 * failed. So the work was durable, and the advice was to destroy it. The
 * protected-branch case was worse: it said *"open a pull request from
 * `<branch>`"* about a branch that did not contain the change.
 *
 * The commit is now given a branch of its own. These tests hold that path to
 * the standard the rest of the repository is held to, because it is the only
 * code here that writes to a real repository:
 *
 *   - it only ever CREATES a ref, and never forces or overwrites one
 *   - retrying converges on one branch rather than forking a second
 *   - an ambiguous outcome says so, and carries the commit SHA
 *   - work that was committed is never reported as lost
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { rescueBranchName, workingBranchName } from '../server/github/repositories.mjs';
import { findAppliedCommit } from '../server/github/workspace.mjs';
import {
  compareUrl,
  describeCreatedBranch,
  describeSaveResolution,
  saveStatusLine,
} from '../web/js/save-resolution.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

const ENVIRONMENT_ID = 'env-rescue';
const BRANCH = workingBranchName(ENVIRONMENT_ID);
const REPOSITORY_ID = 9801;
const FULL_NAME = 'taomar/citadelQA';
const NEW_SOURCE = 'bicep/infra/new.bicepparam';

function fixture() {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: REPOSITORY_ID, fullName: FULL_NAME });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const audit = new MemoryAudit();
  // Held so a test can intercept transport failures: the client reads
  // `this.fetch` per call, so replacing it after construction takes effect.
  const client = new GitHubApiClient({ fetch: github.fetch });
  const routes = new GitHubRoutes({
    client,
    audit,
    sessions: new GitHubSessionStore(),
    registryStore: environmentRegistry({
      [ENVIRONMENT_ID]: {
        id: ENVIRONMENT_ID,
        source: {
          kind: 'github',
          repositoryId: REPOSITORY_ID,
          fullName: FULL_NAME,
          sourceBranch: 'main',
          workingBranch: BRANCH,
          writeMode: 'working-branch',
        },
      },
    }),
  });
  return { github, repository, routes, audit, client };
}

async function attached(context) {
  const session = await context.routes.connect({ token: TEST_TOKEN });
  await context.routes.attach(
    { method: 'POST', headers: { 'x-citadel-github-session': session.id } },
    {
      repositoryId: REPOSITORY_ID,
      sourceBranch: 'main',
      environmentId: ENVIRONMENT_ID,
      writeMode: 'working-branch',
    }
  );
  return session.id;
}

/** One save, driven exactly as the workspace route drives it. */
async function save(context, id, options = {}) {
  return context.routes.workspace({
    req: { method: 'POST', headers: { 'x-citadel-github-session': id } },
    url: new URL(`/api/github/workspaces/${ENVIRONMENT_ID}/commits`, 'http://127.0.0.1:4173'),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: options.expectedHead ?? context.repository.refs.get(BRANCH),
      transactionId: options.transactionId || '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: options.alias || NEW_SOURCE,
          create: true,
          after: Buffer.from(options.content || 'x\n').toString('base64'),
        },
      ],
    }),
  });
}

/** The user's answer: put that commit on a branch of this name. */
function createBranch(context, id, commit, branch) {
  return context.routes.workspace({
    req: { method: 'POST', headers: { 'x-citadel-github-session': id } },
    url: new URL(
      `/api/github/workspaces/${ENVIRONMENT_ID}/commit-branches`,
      'http://127.0.0.1:4173'
    ),
    environmentId: ENVIRONMENT_ID,
    operation: 'commit-branches',
    readBody: async () => ({ commit, branch }),
  });
}

// --------------------------------------------------------------------------
// The name.
// --------------------------------------------------------------------------

test('a rescue branch is a sibling of the working branch, never a child of it', () => {
  const working = workingBranchName(ENVIRONMENT_ID);
  const rescue = rescueBranchName(ENVIRONMENT_ID, 'a'.repeat(40));

  // Git refs are paths: `citadel-ui/<id>/save-x` cannot exist while
  // `citadel-ui/<id>` does, because one cannot be both a file and a directory.
  // A nested name would fail in exactly the case this exists to handle.
  assert.equal(rescue.startsWith(`${working}/`), false, `${rescue} nests under ${working}`);
  assert.equal(rescue, `${working}-save-${'a'.repeat(12)}`);
  assert.notEqual(rescue, working);
});

test('the rescue branch name is derived from the commit, so a retry converges', () => {
  const first = rescueBranchName(ENVIRONMENT_ID, 'b'.repeat(40));
  const again = rescueBranchName(ENVIRONMENT_ID, 'b'.repeat(40));
  const other = rescueBranchName(ENVIRONMENT_ID, 'c'.repeat(40));
  assert.equal(first, again);
  assert.notEqual(first, other);
});

test('a rescue branch name rejects an unusable environment id or commit', () => {
  assert.throws(
    () => rescueBranchName('../evil', 'a'.repeat(40)),
    (error) => error.code === 'INVALID_ENVIRONMENT'
  );
  assert.throws(
    () => rescueBranchName(ENVIRONMENT_ID, 'not-a-sha'),
    (error) => error.code === 'INVALID_SHA'
  );
});

// --------------------------------------------------------------------------
// Citadel creates no ref the user did not ask for.
// --------------------------------------------------------------------------

test('a refused save creates NO ref, and returns the decision instead', async () => {
  // The regression that matters. A user opened their repository and found three
  // branches they had never requested — the product created one every time a
  // save was refused. Creating a ref changes their repository, and the commit is
  // reachable by SHA with nothing pointing at it, so asking costs nothing.
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  const refsBefore = [...context.repository.refs.keys()].sort();
  context.github.calls.length = 0;
  context.github.failNextRefUpdate = true;

  const result = await save(context, id);

  // Zero refs. This is the assertion that would have caught those three
  // branches.
  assert.deepEqual([...context.repository.refs.keys()].sort(), refsBefore);
  assert.equal(
    context.github.calls.some((call) => call.method === 'POST' && /\/git\/refs$/.test(call.path)),
    false,
    'a ref was created for a save the user has not answered yet'
  );
  // The working branch is byte-for-byte where it was.
  assert.equal(context.repository.refs.get(BRANCH), head);

  // And the user is given the decision, with the commit that makes it safe.
  assert.equal(result.applied, false);
  assert.equal(result.unresolved.kind, 'branch-moved');
  assert.equal(result.unresolved.intendedBranch, BRANCH);
  assert.match(result.unresolved.commit, /^[0-9a-f]{40}$/);
  // A name is offered for the field. Nothing is created from it.
  assert.equal(result.unresolved.suggestedBranch, rescueBranchName(ENVIRONMENT_ID, result.unresolved.commit));
  assert.equal(context.repository.refs.has(result.unresolved.suggestedBranch), false);
  assert.equal(
    context.github.calls.some((call) => call.method === 'DELETE'),
    false
  );
});

test('a protected branch also creates nothing and asks', async () => {
  const context = fixture();
  const id = await attached(context);
  const refsBefore = [...context.repository.refs.keys()].sort();
  context.github.protectedBranches.add(BRANCH);

  const result = await save(context, id);

  assert.deepEqual([...context.repository.refs.keys()].sort(), refsBefore);
  assert.equal(result.unresolved.kind, 'branch-protected');
  assert.equal(result.applied, false);
});

test('answering with a name creates exactly one ref, create-only', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);
  context.github.calls.length = 0;

  const outcome = await createBranch(context, id, refused.unresolved.commit, 'my/rescue');

  assert.equal(outcome.branch, 'my/rescue');
  assert.equal(outcome.created, true);
  assert.equal(context.repository.refs.get('my/rescue'), refused.unresolved.commit);
  // The working branch is still untouched.
  assert.equal(context.repository.refs.get(BRANCH), head);

  const refWrites = context.github.calls.filter((call) => call.path.includes('/git/ref'));
  assert.equal(refWrites.filter((call) => call.method === 'POST').length, 1, 'not exactly one create');
  assert.equal(
    refWrites.some((call) => call.method === 'PATCH'),
    false,
    'a user-invoked creation became an update'
  );
  assert.equal(
    context.github.calls.some((call) => call.method === 'DELETE'),
    false
  );
});

test('a name the user could not have typed into the attach flow is refused here too', async () => {
  // This path takes a branch name from the browser. It must not be a way around
  // the validation every other named branch goes through.
  const context = fixture();
  const id = await attached(context);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);

  for (const name of ['my branch', 'feature/../etc', 'trailing.', '@', 'x'.repeat(256)]) {
    await assert.rejects(
      createBranch(context, id, refused.unresolved.commit, name),
      (error) => error.code === 'INVALID_BRANCH',
      name
    );
  }
  assert.equal(
    [...context.repository.refs.keys()].some((key) => key !== BRANCH && key !== 'main'),
    false
  );
});

test('a name already pointing elsewhere is refused rather than moved', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);
  // Somebody else's branch, standing where the user wants to put this commit.
  context.repository.refs.set('taken/elsewhere', head);

  await assert.rejects(
    createBranch(context, id, refused.unresolved.commit, 'taken/elsewhere'),
    (error) => error.code === 'BRANCH_EXISTS'
  );
  // Not moved.
  assert.equal(context.repository.refs.get('taken/elsewhere'), head);
});

test('retrying the same answer converges rather than failing', async () => {
  const context = fixture();
  const id = await attached(context);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);

  const first = await createBranch(context, id, refused.unresolved.commit, 'my/rescue');
  // The answer was lost; the user pressed the button again.
  const again = await createBranch(context, id, refused.unresolved.commit, 'my/rescue');

  assert.equal(first.created, true);
  assert.equal(again.created, false, 'a retry reported a second creation');
  assert.equal(again.branch, 'my/rescue');
  assert.deepEqual(
    [...context.repository.refs.keys()].filter((name) => name.startsWith('my/')),
    ['my/rescue']
  );
});

// --------------------------------------------------------------------------
// The commit SHA comes from the browser, so it has to be bound to this
// workspace. Unconstrained, this is "create a ref at any object in the repo".
// --------------------------------------------------------------------------

test('a commit this workspace did not create cannot be given a branch', async () => {
  const context = fixture();
  const id = await attached(context);
  // A real commit, reachable, and nothing to do with any Citadel save.
  const foreign = context.github.writeCommit(
    context.github.commits.get(context.repository.refs.get('main')).tree,
    [context.repository.refs.get('main')],
    'someone else'
  );

  await assert.rejects(
    createBranch(context, id, foreign, 'my/rescue'),
    (error) => error.code === 'COMMIT_NOT_ATTRIBUTED' && error.status === 403
  );
  assert.equal(context.repository.refs.has('my/rescue'), false);
});

test('the refusal names nothing about the repository the caller did not already send', async () => {
  const context = fixture();
  const id = await attached(context);
  const foreign = context.github.writeCommit('a'.repeat(40), [], 'other');
  const error = await createBranch(context, id, foreign, 'my/rescue').catch((failure) => failure);

  assert.equal(error.code, 'COMMIT_NOT_ATTRIBUTED');
  // No SHAs, no branch names, no internals echoed back.
  assert.doesNotMatch(error.message, /[0-9a-f]{40}/);
  assert.doesNotMatch(error.message, new RegExp(BRANCH));
});

test('a commit belonging to another environment in the same repository is refused', async () => {
  // Real, audited, and still not this workspace's to name.
  const context = fixture();
  const id = await attached(context);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);
  // The same commit, audited under a different environment.
  context.audit.commits.push({
    commit: refused.unresolved.commit,
    environmentId: 'some-other-environment',
    branch: BRANCH,
    repositoryId: REPOSITORY_ID,
  });
  // Strip this environment's own record so only the foreign one remains.
  context.audit.commits = context.audit.commits.filter(
    (item) => item.environmentId !== ENVIRONMENT_ID
  );

  await assert.rejects(
    createBranch(context, id, refused.unresolved.commit, 'my/rescue'),
    (error) => error.code === 'COMMIT_NOT_ATTRIBUTED'
  );
  assert.equal(context.repository.refs.has('my/rescue'), false);
});

test('a branch the user asked for is attributable in the change log', async () => {
  const context = fixture();
  const id = await attached(context);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);
  const before = context.audit.commits.length;

  await createBranch(context, id, refused.unresolved.commit, 'my/rescue');

  const logged = context.audit.commits.slice(before);
  assert.equal(logged.length, 1, 'the created branch is not in the change log');
  assert.equal(logged[0].branch, 'my/rescue');
  assert.equal(logged[0].commit, refused.unresolved.commit);
  assert.equal(logged[0].environmentId, ENVIRONMENT_ID);
});

test('a change log failure does not turn a created branch into a failure', async () => {
  const context = fixture();
  const id = await attached(context);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);
  context.audit.record = async () => {
    throw new Error('disk full');
  };

  const outcome = await createBranch(context, id, refused.unresolved.commit, 'my/rescue');

  assert.equal(outcome.created, true);
  assert.equal(outcome.unlogged, true);
  assert.equal(context.repository.refs.get('my/rescue'), refused.unresolved.commit);
});


// --------------------------------------------------------------------------
// "It already happened" is not "it needs saving somewhere else".
// --------------------------------------------------------------------------

test('a refusal whose tree is already on the branch creates no branch at all', async () => {
  // The incident, reproduced by its actual mechanism. Two saves in flight
  // together both read the same branch head, so both build a commit from the
  // same parent with the same content:
  //
  //   1668f8c  tree 7826930ed1a3  parent cf630db  22:52:42Z
  //   ae0288e  tree 7826930ed1a3  parent cf630db  22:52:45Z
  //
  // The first won the ref. The second was refused with 422 and rescued onto a
  // branch of its own — even though the branch head's tree was byte-identical
  // to the tree being "rescued". The correct answer was "already saved", and
  // the correct number of new branches was zero.
  //
  // A sequential retry cannot produce this: it is refused by the reviewed-head
  // precondition long before a commit exists. Only the race reaches here, which
  // is why the guard in `single-flight` and this reconcile are two fixes and
  // not one.
  const context = fixture();
  const id = await attached(context);
  const reviewedHead = context.repository.refs.get(BRANCH);
  const refsBefore = [...context.repository.refs.keys()].sort();

  const [first, second] = await Promise.all([
    save(context, id, {
      expectedHead: reviewedHead,
      transactionId: '11111111-1111-4111-8111-111111111111',
    }),
    save(context, id, {
      expectedHead: reviewedHead,
      transactionId: '22222222-2222-4222-8222-222222222222',
    }),
  ]);

  // Both commits exist as objects — that is the hazard this reconciles, not
  // something it prevents. What must not exist is a second *branch*.
  const outcomes = [first, second];
  const duplicate = outcomes.find((result) => result.alreadyApplied);
  const landed = outcomes.find((result) => !result.alreadyApplied);

  assert(duplicate, 'neither save recognised that the change was already applied');
  assert.equal(duplicate.resolution, undefined, 'a rescue resolution was reported anyway');
  assert.equal(duplicate.branch, BRANCH, 'the save was reported against the wrong branch');
  // The commit handed back is the one the branch actually holds. The duplicate
  // exists as an object but nothing references it, so History could never list
  // it and Undo would refuse it.
  assert.equal(duplicate.commit, landed.commit);
  assert.notEqual(duplicate.duplicateCommit, duplicate.commit);
  assert.equal(context.repository.refs.get(BRANCH), landed.commit);

  // The assertion the user cares about: zero new branches.
  assert.deepEqual([...context.repository.refs.keys()].sort(), refsBefore);
  assert.equal(
    [...context.repository.refs.keys()].some((name) => name.includes('-save-')),
    false,
    'a rescue branch was created for a change that was already saved'
  );

  // Each save writes one audit record before it touches the ref; that is the
  // existing design and is harmless, because History and Undo both require
  // reachability. What must not happen is the *third* record the rescue path
  // writes for a branch it created.
  assert.equal(
    context.audit.commits.length,
    2,
    'an already-applied save was written to the change log a second time'
  );

  assert(
    duplicate.warnings.some((warning) => warning.includes('already on')),
    `expected the user to be told, got ${JSON.stringify(duplicate.warnings)}`
  );
  // A no-op save must not read as "somebody moved the branch".
  assert.equal(duplicate.movedAfterSave, undefined);
});

test('an already-applied save is reported to the user as an ordinary save', () => {
  // No compare link, no "saved to a separate branch" dialog: nothing went
  // anywhere unexpected. `describeSaveResolution` keys off `resolution.branch`,
  // and an already-applied result deliberately carries no resolution.
  const source = { fullName: FULL_NAME, workingBranch: BRANCH };
  const result = { changed: true, path: 'p', archived: 'a', alreadyApplied: true, warnings: [] };
  assert.equal(describeSaveResolution(result, source), null);
  assert.equal(saveStatusLine(result, source).rescued, undefined);
});

test('absent and already-applied are distinguished, and neither creates a ref', async () => {
  // The two halves of the refusal question, side by side. The reconcile must
  // not swallow a genuine refusal, and a genuine refusal must not invent a
  // branch. Both outcomes create nothing.
  const absent = fixture();
  const absentId = await attached(absent);
  const head = absent.repository.refs.get(BRANCH);
  absent.github.failNextRefUpdate = true;
  const refused = await save(absent, absentId);

  assert.equal(refused.alreadyApplied, undefined, 'an absent change was called already-applied');
  assert.equal(refused.unresolved.kind, 'branch-moved');
  assert.equal(absent.repository.refs.get(BRANCH), head, 'the working branch moved');
  assert.deepEqual(
    [...absent.repository.refs.keys()].filter((name) => name.includes('-save-')),
    []
  );

  const duplicate = fixture();
  const duplicateId = await attached(duplicate);
  const reviewed = duplicate.repository.refs.get(BRANCH);
  const [first, second] = await Promise.all([
    save(duplicate, duplicateId, {
      expectedHead: reviewed,
      transactionId: '11111111-1111-4111-8111-111111111111',
    }),
    save(duplicate, duplicateId, {
      expectedHead: reviewed,
      transactionId: '22222222-2222-4222-8222-222222222222',
    }),
  ]);
  const already = [first, second].find((result) => result.alreadyApplied);
  assert(already, 'the duplicate was not recognised');
  assert.equal(already.unresolved, undefined, 'an already-applied save asked a needless question');
  assert.deepEqual(
    [...duplicate.repository.refs.keys()].filter((name) => name.includes('-save-')),
    []
  );
});

test('the walk back through history is bounded and terminates', async () => {
  const context = fixture();
  await attached(context);

  // A history far longer than the bound, none of which matches.
  let parent = context.repository.refs.get(BRANCH);
  for (let index = 0; index < 60; index += 1) {
    parent = context.github.writeCommit(
      context.github.commits.get(parent).tree,
      [parent],
      `filler ${index}`
    );
  }
  context.repository.refs.set(BRANCH, parent);
  context.github.calls.length = 0;

  const found = await findAppliedCommit(context.client, TEST_TOKEN, {
    fullName: FULL_NAME,
    branch: BRANCH,
    treeSha: 'f'.repeat(40),
    baseCommit: null,
  });

  assert.equal(found, null);
  const reads = context.github.calls.filter((call) => call.path.includes('/git/commits/'));
  assert.equal(reads.length <= 20, true, `walked ${reads.length} commits; the bound is 20`);
});

test('the walk stops at the reviewed parent rather than matching older content', async () => {
  // Everything at or below the reviewed parent is the state the user was
  // editing away from. Matching it would report a save as already-applied
  // because the file looked the way it did before the edit.
  const context = fixture();
  await attached(context);
  const head = context.repository.refs.get(BRANCH);
  const headTree = context.github.commits.get(head).tree;

  const found = await findAppliedCommit(context.client, TEST_TOKEN, {
    fullName: FULL_NAME,
    branch: BRANCH,
    treeSha: headTree,
    baseCommit: head,
  });

  assert.equal(found, null, 'the reviewed parent was treated as proof the save had landed');
});

test('a matching tree further back on the branch is still found', async () => {
  // The branch may have moved on since the save landed. Someone else pushing
  // afterwards is normal collaboration and must not turn an applied change into
  // a rescued one.
  const context = fixture();
  await attached(context);
  const applied = context.repository.refs.get(BRANCH);
  const appliedTree = context.github.commits.get(applied).tree;
  let head = applied;
  for (let index = 0; index < 3; index += 1) {
    head = context.github.writeCommit(context.github.writeBlob(`later ${index}`), [head], 'later');
  }
  context.repository.refs.set(BRANCH, head);

  const found = await findAppliedCommit(context.client, TEST_TOKEN, {
    fullName: FULL_NAME,
    branch: BRANCH,
    treeSha: appliedTree,
    baseCommit: null,
  });

  assert.equal(found, applied);
});

test('a cycle in history cannot spin the walk forever', async () => {
  const context = fixture();
  await attached(context);
  const head = context.repository.refs.get(BRANCH);
  // A commit that claims itself as its own parent. Real Git cannot express
  // this, but a bounded walk must not depend on that being true.
  context.github.commits.get(head).parents = [head];

  const found = await findAppliedCommit(context.client, TEST_TOKEN, {
    fullName: FULL_NAME,
    branch: BRANCH,
    treeSha: 'e'.repeat(40),
    baseCommit: null,
  });
  assert.equal(found, null);
});

test('an unreadable history is not mistaken for proof the change is absent', async () => {
  // "Cannot prove it is already there" is not "it is not there". The walk
  // swallows its own failure and answers null, so the caller rescues — which is
  // safe, create-only, and was going to happen anyway.
  const context = fixture();
  await attached(context);
  const unreachable = new GitHubApiClient({
    fetch: async () => {
      throw new Error('history unavailable');
    },
  });

  const found = await findAppliedCommit(unreachable, TEST_TOKEN, {
    fullName: FULL_NAME,
    branch: BRANCH,
    treeSha: 'a'.repeat(40),
    baseCommit: null,
  });

  assert.equal(found, null, 'an unreadable history threw instead of falling through');
});

test('no tree to compare means no claim that the change is already applied', async () => {
  const context = fixture();
  await attached(context);
  assert.equal(
    await findAppliedCommit(context.client, TEST_TOKEN, {
      fullName: FULL_NAME,
      branch: BRANCH,
      treeSha: null,
      baseCommit: null,
    }),
    null
  );
});

test('every refusal status reaches the same reconcile, not only a moved branch', () => {
  // The 422 path is proven end to end above. A protected branch refuses with
  // 403 and a conflict with 409, and both are the same question: is the change
  // already there?
  //
  // This is asserted on the dispatch rather than through a fixture, deliberately.
  // Building an end-to-end 403 case would require a protected branch that
  // already holds the change — but for the branch to hold it, the change must
  // have landed, which protection forbids. Simulating that state would buy
  // confidence in the mock, not in the product. What is provable is that the
  // three statuses enter one branch and that the reconcile is the first thing
  // in it, ahead of any ref creation.
  const source = readFileSync(
    new URL('../server/github/workspace.mjs', import.meta.url),
    'utf8'
  ).replace(/\r\n/g, '\n');
  const commit = source.slice(source.indexOf('export async function commitChangeSet'));
  const body = commit.slice(0, commit.indexOf('\n}\n'));

  const guard = /if \(\s*error\.status === 422 \|\| error\.status === 403 \|\| error\.status === 409\s*\)/;
  assert.match(body, guard, 'the three refusal statuses no longer share one branch');

  const branch = body.slice(body.search(guard));
  assert.notEqual(
    branch.indexOf('findAppliedCommit'),
    -1,
    'the refusal branch no longer asks whether it already landed'
  );
  // And the whole branch creates nothing. This is the structural form of
  // Invariant 1: no code path in a refusal may reach a ref create.
  assert.doesNotMatch(
    branch,
    /method:\s*'POST'[\s\S]{0,200}git\/refs/,
    'the refusal path creates a ref again'
  );
  assert.doesNotMatch(body, /rescueCommit/, 'automatic rescue is back');
});

// --------------------------------------------------------------------------
// Ambiguity is reported as ambiguity.
// --------------------------------------------------------------------------

test('a creation that cannot be confirmed names the commit rather than a lost save', async () => {
  // The property survives the reversal: an ambiguous ref create still reports
  // the commit SHA, because the commit is real and reachable by SHA whether or
  // not a branch points at it. It just applies to the user-invoked creation now.
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  context.github.failNextRefUpdate = true;
  const refused = await save(context, id);

  const original = context.client.fetch;
  context.client.fetch = async (href, init) => {
    if (init?.method === 'POST' && href.endsWith('/git/refs')) {
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    return original(href, init);
  };

  await assert.rejects(
    createBranch(context, id, refused.unresolved.commit, 'my/rescue'),
    (error) => {
      assert.equal(error.code, 'BRANCH_NOT_CREATED');
      assert.equal(error.status, 503);
      assert.match(error.commit, /^[0-9a-f]{40}$/);
      assert.equal(error.branch, 'my/rescue');
      // It must never claim the change was not applied.
      assert.equal(/not applied|were not applied/.test(error.message), false);
      assert.match(error.message, /committed as [0-9a-f]{40}/);
      assert.match(error.message, /is not lost/);
      return true;
    }
  );

  context.client.fetch = original;
  // Nothing was moved or destroyed while failing.
  assert.equal(context.repository.refs.get(BRANCH), head);
  assert.equal(context.repository.refs.has('my/rescue'), false);
});

test('a failed audit write for the refused save never turns it into a lost one', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  context.github.failNextRefUpdate = true;

  const result = await save(context, id);

  // The save is not reported as applied — because it is not — but the commit is
  // named and the branch is untouched, so nothing is lost and nothing invites a
  // destructive reload.
  assert.equal(result.applied, false);
  assert.match(result.unresolved.commit, /^[0-9a-f]{40}$/);
  assert.equal(context.repository.refs.get(BRANCH), head);
  assert.equal(
    [...context.repository.refs.keys()].some((name) => name.includes('-save-')),
    false
  );
});

test('the refused commit is already in the audit, so it can be attributed later', async () => {
  // The pre-write record is what later proves the commit belongs to this
  // workspace, which is what makes naming a branch for it safe.
  const context = fixture();
  const id = await attached(context);
  context.github.failNextRefUpdate = true;
  const result = await save(context, id);

  const record = await context.audit.find({
    commit: result.unresolved.commit,
    repositoryId: REPOSITORY_ID,
    environmentId: ENVIRONMENT_ID,
    branch: BRANCH,
  });
  assert(record, 'the refused commit was not recorded');
  assert.equal(record.commit, result.unresolved.commit);
  assert.deepEqual(record.aliases, [NEW_SOURCE]);
});

// --------------------------------------------------------------------------
// What the user is told.
// --------------------------------------------------------------------------

test('an ordinary save is described exactly as before', () => {
  const source = { fullName: FULL_NAME, sourceBranch: 'main', workingBranch: BRANCH };
  assert.equal(describeSaveResolution({ changed: true, path: 'a', archived: 't' }, source), null);
  const line = saveStatusLine({ changed: true, path: 'a', archived: 't', warnings: [] }, source);
  assert.equal(line.tone, 'ok');
  assert.equal(line.text, 'Saved a. Previous revision archived to t');
  assert.equal(saveStatusLine({ changed: false }, source).text, 'Nothing changed.');
});

test('a refused save is reported as a question, and never as saved', () => {
  const source = { fullName: FULL_NAME, sourceBranch: 'main', workingBranch: BRANCH };
  const result = {
    changed: true,
    path: NEW_SOURCE,
    archived: 'transaction-1',
    warnings: [],
    applied: false,
    unresolved: {
      kind: 'branch-moved',
      commit: 'd'.repeat(40),
      intendedBranch: BRANCH,
      suggestedBranch: `${BRANCH}-save-${'d'.repeat(12)}`,
    },
  };
  const pending = describeSaveResolution(result, source);

  assert.equal(pending.commit, 'd'.repeat(40));
  assert.equal(pending.intendedBranch, BRANCH);
  assert.equal(pending.suggestedBranch, `${BRANCH}-save-${'d'.repeat(12)}`);
  assert.match(pending.message, /moved while you were saving/);
  // The reassurance has to come before the instruction, because a user who
  // reads one sentence must not conclude their work is gone.
  assert(
    pending.message.indexOf('safe') < pending.message.indexOf('branch name'),
    'the message buries the fact that nothing was lost'
  );
  assert.equal(/not applied|reload and review/.test(pending.message), false);
  // And it must not claim a branch exists when none does.
  assert.match(pending.message, /has not put it on any branch/);
  assert.equal(pending.compareUrl, undefined);

  const line = saveStatusLine(result, source);
  assert.equal(line.tone, 'warn');
  // Not "Saved". The change is safe, but it did not land where it was aimed and
  // saying otherwise would be false.
  assert.equal(/^Saved /.test(line.text), false);
  assert.equal(line.pending.commit, 'd'.repeat(40));
});

test('a protected branch is explained as a permission, not as a move', () => {
  const source = { fullName: FULL_NAME, sourceBranch: 'main', workingBranch: BRANCH };
  const pending = describeSaveResolution(
    {
      changed: true,
      path: NEW_SOURCE,
      unresolved: {
        kind: 'branch-protected',
        commit: 'e'.repeat(40),
        intendedBranch: BRANCH,
      },
    },
    source
  );
  assert.match(pending.message, /protected/);
  assert.equal(/moved while/.test(pending.message), false);
});

test('a branch the user asked for is confirmed, with a compare link', () => {
  const source = { fullName: FULL_NAME, workingBranch: BRANCH };
  const created = describeCreatedBranch(
    { branch: 'my/rescue', commit: 'f'.repeat(40), created: true },
    source,
    BRANCH
  );
  assert.match(created.message, /Your change is on my\/rescue/);
  assert.equal(
    created.compareUrl,
    `https://github.com/${FULL_NAME}/compare/${encodeURIComponent(BRANCH)}...${encodeURIComponent(
      'my/rescue'
    )}?expand=1`
  );
  // A retry that found the branch already there says so instead of claiming a
  // second creation.
  assert.match(
    describeCreatedBranch({ branch: 'my/rescue', created: false }, source, BRANCH).message,
    /already held this change/
  );
  assert.equal(describeCreatedBranch(null, source, BRANCH), null);
});

test('a refusal the user declines to resolve leaves the draft intact', () => {
  // The consequence of not auto-creating a branch. Under the old design the
  // work always had a home, so clearing the draft and reloading was safe. It no
  // longer is: if the user answers "leave it" after Citadel has cleared their
  // draft and reloaded, the branch shows its old content and their edits look
  // lost — the exact failure this whole change exists to prevent.
  //
  // The commit SHA is the safety net for the repository; the retained draft is
  // the safety net for the editor. Both, or neither is honest.
  const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
  );
  const save = app.slice(app.indexOf('async function commitSave'));
  const body = save.slice(0, save.indexOf('\n}\n'));

  // The pending branch returns before anything is cleared or reloaded.
  const pendingAt = body.indexOf('if (line.pending)');
  const clearAt = body.indexOf('state.operations = []');
  const reloadAt = body.indexOf('loadDocument');
  assert.notEqual(pendingAt, -1, 'a refused save is no longer distinguished');
  assert.equal(pendingAt < clearAt, true, 'the draft is cleared before the refusal is handled');
  assert.equal(pendingAt < reloadAt, true, 'the document is reloaded before the refusal is handled');
  const pendingBlock = body.slice(pendingAt, clearAt);
  assert.doesNotMatch(pendingBlock, /removeDraft/, 'a refused save discards the draft');
  assert.doesNotMatch(pendingBlock, /loadDocument|loadContract/, 'a refused save reloads anyway');
  assert.match(pendingBlock, /resolveUnsavedCommit/);
  assert.match(pendingBlock, /return;/);

  // And the draft is dropped only once the commit actually has a branch.
  const resolve = app.slice(app.indexOf('async function resolveUnsavedCommit'));
  const resolveBody = resolve.slice(0, resolve.indexOf('\n}\n'));
  const createdAt = resolveBody.indexOf('describeCreatedBranch');
  const dropAt = resolveBody.indexOf('removeDraft');
  assert.notEqual(dropAt, -1);
  assert.equal(createdAt < dropAt, true, 'the draft is dropped before the branch exists');
  // "Leave it" is a real answer, and it must not touch the draft at all.
  assert.match(resolveBody, /'Leave it for now'/);
  const leaveIt = resolveBody.slice(0, resolveBody.indexOf('const create'));
  assert.doesNotMatch(leaveIt, /removeDraft|state\.operations = \[\]/);
});

test('nothing in the editor announces a branch that was never created', () => {
  const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  // The old dialog said "Saved to a separate branch" about a branch Citadel had
  // just made without asking. It is gone, not renamed.
  assert.doesNotMatch(app, /announceRescuedSave/);
  assert.doesNotMatch(app, /line\.rescued/);
});
test('the compare link is a plain github.com URL with both refs encoded', () => {
  assert.equal(compareUrl(FULL_NAME, null, 'x'), null);
  assert.equal(compareUrl(null, 'a', 'b'), null);
  const url = compareUrl(FULL_NAME, 'feature/a b', 'citadel-ui/x-save-1');
  assert.match(url, /^https:\/\/github\.com\/taomar\/citadelQA\/compare\//);
  assert(url.includes('feature%2Fa%20b'));
  assert(url.includes('citadel-ui%2Fx-save-1'));
});
