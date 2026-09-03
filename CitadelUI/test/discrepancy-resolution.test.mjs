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

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { rescueBranchName, workingBranchName } from '../server/github/repositories.mjs';
import { findAppliedCommit } from '../server/github/workspace.mjs';
import { compareUrl, describeSaveResolution, saveStatusLine } from '../web/js/save-resolution.mjs';
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
// Creating, never forcing.
// --------------------------------------------------------------------------

test('rescuing creates a ref and never forces or overwrites one', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  context.github.calls.length = 0;
  context.github.failNextRefUpdate = true;

  const result = await save(context, id);

  assert.equal(result.resolution.kind, 'branch-moved');
  assert.equal(context.repository.refs.get(result.resolution.branch), result.commit);
  // The working branch is byte-for-byte where it was.
  assert.equal(context.repository.refs.get(BRANCH), head);

  const refWrites = context.github.calls.filter((call) => call.path.includes('/git/ref'));
  const creates = refWrites.filter((call) => call.method === 'POST');
  const updates = refWrites.filter((call) => call.method === 'PATCH');
  assert.equal(creates.length, 1, 'the rescue must be exactly one create');
  // The only PATCH is the refused attempt on the working branch, and it was not
  // forced. No PATCH is ever issued against the rescue branch.
  assert.equal(updates.length, 1);
  assert.equal(
    updates.every((call) => !call.path.includes(result.resolution.branch)),
    true
  );
  assert.equal(
    context.github.calls.some((call) => call.method === 'DELETE'),
    false
  );
});

test('a rescue branch that already exists is adopted, not overwritten', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  // A ref already standing where the rescue will go, pointing somewhere else:
  // the create must be refused by GitHub and must not become a force update.
  context.github.failNextRefUpdate = true;
  const first = await save(context, id);
  const rescued = first.resolution.branch;
  const landed = context.repository.refs.get(rescued);

  // The identical save again — a user clicking Save after the first answer.
  context.github.failNextRefUpdate = true;
  context.github.calls.length = 0;
  const second = await save(context, id, { expectedHead: head });

  assert.equal(second.resolution.branch, rescued, 'a retry forked a second branch');
  assert.equal(context.repository.refs.get(rescued), landed, 'the existing ref was moved');
  assert.equal(
    context.github.calls.some(
      (call) => call.method === 'PATCH' && call.path.includes(rescued)
    ),
    false,
    'an existing rescue ref was force-updated'
  );
  assert(
    second.warnings.some((warning) => warning.includes('already held this change')),
    `expected the retry to say so, got ${JSON.stringify(second.warnings)}`
  );
  // One branch, not two.
  const rescueRefs = [...context.repository.refs.keys()].filter((name) =>
    name.includes('-save-')
  );
  assert.deepEqual(rescueRefs, [rescued]);
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

test('a refusal whose tree is genuinely absent still rescues, and still creates', async () => {
  // The other half of the same question. The reconcile must not swallow a real
  // rescue: if the change is not on the branch, the commit still needs a name.
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  context.github.calls.length = 0;
  context.github.failNextRefUpdate = true;

  const result = await save(context, id);

  assert.equal(result.alreadyApplied, undefined, 'an absent change was called already-applied');
  assert.equal(result.resolution.kind, 'branch-moved');
  assert.equal(context.repository.refs.get(result.resolution.branch), result.commit);
  assert.equal(context.repository.refs.get(BRANCH), head, 'the working branch moved');

  // Created, never forced — the property the rescue has always had.
  const refWrites = context.github.calls.filter((call) => call.path.includes('/git/ref'));
  assert.equal(refWrites.filter((call) => call.method === 'POST').length, 1);
  assert.equal(
    refWrites.some(
      (call) => call.method === 'PATCH' && call.path.includes(result.resolution.branch)
    ),
    false,
    'the rescue ref was force-updated'
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

// --------------------------------------------------------------------------
// Ambiguity is reported as ambiguity.
// --------------------------------------------------------------------------

test('a rescue that cannot be confirmed reports the commit rather than a lost save', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  const original = context.client.fetch;
  context.client.fetch = async (href, init) => {
    if (init?.method === 'POST' && href.endsWith('/git/refs')) {
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    return original(href, init);
  };
  context.github.failNextRefUpdate = true;

  await assert.rejects(save(context, id), (error) => {
    assert.equal(error.code, 'INDETERMINATE_RESCUE');
    assert.equal(error.status, 503);
    // The whole point: the commit is named, so the work is recoverable by SHA
    // even though no branch points at it. `githubError` spreads its detail onto
    // the error, which is the same shape `INDETERMINATE_SAVE` reports.
    assert.match(error.commit, /^[0-9a-f]{40}$/);
    assert.equal(error.indeterminate, true);
    assert.equal(error.branch, rescueBranchName(ENVIRONMENT_ID, error.commit));
    // And it must never claim the change was not applied.
    assert.equal(/not applied|were not applied/.test(error.message), false);
    assert.match(error.message, /committed as [0-9a-f]{40}/);
    assert.match(error.message, /exists and is not lost/);
    // A blind retry could duplicate the commit, so the advice is to reload.
    assert.match(error.message, /Reload the environment/);
    return true;
  });

  context.client.fetch = original;
  // Nothing was moved or destroyed while failing.
  assert.equal(context.repository.refs.get(BRANCH), head);
  assert.equal(
    [...context.repository.refs.keys()].some((name) => name.includes('-save-')),
    false,
    'a branch was created despite the create failing'
  );
});

test('a failed audit write for the rescue never turns a saved change into a lost one', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(BRANCH);
  let calls = 0;
  context.audit.record = async (entry) => {
    calls += 1;
    // The pre-commit record succeeds; the one describing the rescue fails.
    if (calls > 1) throw new Error('disk full');
    context.audit.commits.push({ ...entry });
  };
  context.github.failNextRefUpdate = true;

  const result = await save(context, id);

  assert.equal(result.resolution.kind, 'branch-moved');
  assert.equal(context.repository.refs.get(result.resolution.branch), result.commit);
  assert.equal(context.repository.refs.get(BRANCH), head);
  assert(
    result.warnings.some((warning) => warning.includes('change log')),
    `expected the log failure to be surfaced, got ${JSON.stringify(result.warnings)}`
  );
});

test('the rescue branch is recorded in the audit', async () => {
  const context = fixture();
  const id = await attached(context);
  context.github.failNextRefUpdate = true;
  const result = await save(context, id);

  const record = await context.audit.find({
    commit: result.commit,
    repositoryId: REPOSITORY_ID,
    environmentId: ENVIRONMENT_ID,
    branch: result.resolution.branch,
  });
  assert(record, 'the rescue branch was not recorded');
  assert.equal(record.commit, result.commit);
  assert.equal(record.branch, result.resolution.branch);
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

test('a rescued save is reported as saved, says where it went, and links to it', () => {
  const source = { fullName: FULL_NAME, sourceBranch: 'main', workingBranch: BRANCH };
  const result = {
    changed: true,
    path: NEW_SOURCE,
    archived: 'transaction-1',
    commit: 'd'.repeat(40),
    warnings: [],
    resolution: { kind: 'branch-moved', branch: `${BRANCH}-save-${'d'.repeat(12)}` },
  };
  const rescued = describeSaveResolution(result, source);

  assert.equal(rescued.branch, `${BRANCH}-save-${'d'.repeat(12)}`);
  assert.match(rescued.message, /moved while you were saving/);
  // The reassurance has to come before the instruction, because a user who
  // reads one sentence must not conclude their work is gone.
  assert(
    rescued.message.indexOf('safe') < rescued.message.indexOf('Compare'),
    'the message buries the fact that nothing was lost'
  );
  assert.equal(/not applied|reload and review/.test(rescued.message), false);
  assert.equal(
    rescued.compareUrl,
    `https://github.com/${FULL_NAME}/compare/${encodeURIComponent(BRANCH)}...${encodeURIComponent(
      rescued.branch
    )}?expand=1`
  );

  const line = saveStatusLine(result, source);
  assert.equal(line.tone, 'warn');
  assert.match(line.text, /^Saved /);
  assert.equal(line.rescued.branch, rescued.branch);
});

test('a protected branch is explained as a permission, not as a move', () => {
  const source = { fullName: FULL_NAME, sourceBranch: 'main', workingBranch: BRANCH };
  const rescued = describeSaveResolution(
    {
      changed: true,
      path: NEW_SOURCE,
      resolution: { kind: 'branch-protected', branch: `${BRANCH}-save-abc123abc123` },
    },
    source
  );
  assert.match(rescued.message, /protected/);
  assert.equal(/moved while/.test(rescued.message), false);
});

test('the compare link is a plain github.com URL with both refs encoded', () => {
  assert.equal(compareUrl(FULL_NAME, null, 'x'), null);
  assert.equal(compareUrl(null, 'a', 'b'), null);
  const url = compareUrl(FULL_NAME, 'feature/a b', 'citadel-ui/x-save-1');
  assert.match(url, /^https:\/\/github\.com\/taomar\/citadelQA\/compare\//);
  assert(url.includes('feature%2Fa%20b'));
  assert(url.includes('citadel-ui%2Fx-save-1'));
});
