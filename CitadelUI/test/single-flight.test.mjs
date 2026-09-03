/**
 * One click, one commit.
 *
 * ## The defect these prove fixed
 *
 * A user created a contract in `taomar/citadelQA` and found their work on two
 * branches. The GitHub API tells the story exactly:
 *
 * | commit    | tree         | parent    | time       |
 * | --------- | ------------ | --------- | ---------- |
 * | `1668f8c` | 7826930ed1a3 | `cf630db` | 22:52:42Z  |
 * | `ae0288e` | 7826930ed1a3 | `cf630db` | 22:52:45Z  |
 *
 * Identical tree, identical parent, three seconds apart. One user action
 * produced two commits, because `commitSave` was bound straight to a button —
 * `onclick: commitSave` — with nothing between the click and the work. Both
 * invocations read the same reviewed head, so both built a commit from the same
 * parent. The first won the ref update; the second was refused and rescued onto
 * a branch of its own.
 *
 * The lock has to be a real lock, not a disabled attribute. A control cannot be
 * repainted before a second event in the same tick reaches the handler, so
 * `disabled` is feedback and `single-flight` is the guarantee.
 *
 * ## What is asserted here
 *
 * The guard is exercised against the real save route and a GitHub-shaped mock,
 * not against a spy, because the claim is about commits and only a repository
 * can count those. The source-contract assertions at the end exist because a
 * perfect module that nothing imports fixes nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { workingBranchName } from '../server/github/repositories.mjs';
import {
  SKIPPED,
  createSingleFlight,
  guardedHandler,
  markBusy,
} from '../web/js/single-flight.mjs';
import { createEnvironmentOperation } from '../web/js/settings-operation.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';
import { installDom } from './_dom-stub.mjs';

const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n'
);

const ENVIRONMENT_ID = 'env-double-click';
const BRANCH = workingBranchName(ENVIRONMENT_ID);
const REPOSITORY_ID = 9901;
const FULL_NAME = 'taomar/citadelQA';
const NEW_SOURCE = 'bicep/infra/double.bicepparam';

function fixture() {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: REPOSITORY_ID, fullName: FULL_NAME });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    audit: new MemoryAudit(),
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
  return { github, repository, routes };
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

/**
 * One save, driven exactly as the browser drives it.
 *
 * `expectedHead` is passed in rather than re-read, because that is the whole
 * point: the browser captures the reviewed head once, when the review dialog
 * opens, and both clicks of a double-click carry that same value.
 */
function save(context, id, expectedHead, transactionId = '11111111-2222-3333-4444-555555555555') {
  return context.routes.workspace({
    req: { method: 'POST', headers: { 'x-citadel-github-session': id } },
    url: new URL(`/api/github/workspaces/${ENVIRONMENT_ID}/commits`, 'http://127.0.0.1:4173'),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'contract-create',
      expectedHead,
      transactionId,
      files: [{ alias: NEW_SOURCE, create: true, after: Buffer.from('x\n').toString('base64') }],
    }),
  });
}

/**
 * How many commits this action actually asked GitHub to create.
 *
 * Counted from the requests rather than from the mock's object store, because
 * the mock derives a commit SHA from its content and two identical commits
 * therefore collapse into one entry. Real Git does not: the incident's two
 * commits shared a tree and a parent and were still distinct objects, three
 * seconds apart. The request count is the honest measure of "how many times did
 * one click commit".
 */
function commitWrites(github) {
  return github.calls.filter(
    (call) => call.method === 'POST' && /\/git\/commits$/.test(call.path)
  ).length;
}

// --------------------------------------------------------------------------
// The incident, reproduced against a repository.
// --------------------------------------------------------------------------

test('a double-invoked save commits once, not twice', async () => {
  const context = fixture();
  const id = await attached(context);
  const { node } = installDom();
  const button = node('button');

  // The reviewed head, captured once. This is the shared state that made both
  // commits share a parent.
  const reviewedHead = context.repository.refs.get(BRANCH);
  const refsBefore = [...context.repository.refs.keys()].sort();
  context.github.calls.length = 0;

  let invocations = 0;
  const onSave = guardedHandler(async () => {
    invocations += 1;
    return save(context, id, reviewedHead);
  });

  // Two clicks in the same tick, which is what a double-click is.
  const first = onSave({ currentTarget: button });
  const second = onSave({ currentTarget: button });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  // Ignored, not queued. A queued second call would still have run the work.
  assert.equal(invocations, 1, 'the save ran more than once');
  assert.equal(secondResult, SKIPPED, 'the second click was not dropped');
  assert.equal(typeof firstResult?.commit, 'string');

  // The claim that matters, measured where the user saw the damage: one commit
  // was asked for, not two sharing a tree and a parent.
  assert.equal(commitWrites(context.github), 1, 'one user action committed more than once');
  // And no branch was invented to hold a second one.
  assert.deepEqual([...context.repository.refs.keys()].sort(), refsBefore);
  assert.equal(context.repository.refs.get(BRANCH), firstResult.commit);
});

test('without the lock the same two clicks would build two commits from one parent', async () => {
  // The negative control. If this stops producing two commits, the test above
  // has stopped proving anything, because the hazard it guards against would no
  // longer be reachable in the code it drives.
  const context = fixture();
  const id = await attached(context);
  const reviewedHead = context.repository.refs.get(BRANCH);
  context.github.calls.length = 0;

  // Distinct transaction ids, as two real clicks would carry.
  const results = await Promise.allSettled([
    save(context, id, reviewedHead, '11111111-1111-4111-8111-111111111111'),
    save(context, id, reviewedHead, '22222222-2222-4222-8222-222222222222'),
  ]);

  assert.equal(
    commitWrites(context.github),
    2,
    'the hazard this feature exists to prevent is no longer reachable'
  );
  // Both built from the same reviewed parent with the same content, exactly as
  // the incident recorded: identical tree, identical parent, moments apart.
  const commits = results
    .filter((entry) => entry.status === 'fulfilled')
    .map((entry) => context.github.commits.get(entry.value.duplicateCommit || entry.value.commit))
    .filter(Boolean);
  assert.equal(commits.length, 2, 'the two saves did not both produce a commit');
  assert.equal(new Set(commits.map((commit) => commit.tree)).size, 1, 'trees differed');
  assert.equal(
    new Set(commits.map((commit) => commit.parents.join())).size,
    1,
    'parents differed'
  );
});

// --------------------------------------------------------------------------
// The control has to say so.
// --------------------------------------------------------------------------

test('the control is disabled and marked busy while the action is in flight', async () => {
  const { node } = installDom();
  const button = node('button');
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });

  const onClick = guardedHandler(() => blocked);
  const running = onClick({ currentTarget: button });

  assert.equal(button.disabled, true, 'an in-flight action left its control live');
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.classList.contains('is-busy'), true);

  release('done');
  await running;

  assert.equal(button.disabled, false, 'the control was left disabled after the action');
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.classList.contains('is-busy'), false);
});

test('a control disabled for its own reasons is not enabled by finishing an action', async () => {
  const { node } = installDom();
  const button = node('button');
  button.disabled = true;

  await guardedHandler(async () => 'ok')({ currentTarget: button });

  assert.equal(button.disabled, true, 'restoring the control overrode its own state');
});

test('a dropped re-entry leaves no trace on a control another call owns', async () => {
  const { node } = installDom();
  const button = node('button');
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const onClick = guardedHandler(() => blocked);

  const running = onClick({ currentTarget: button });
  assert.equal(await onClick({ currentTarget: button }), SKIPPED);
  // The second click must not have restored the button out from under the first.
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');

  release('done');
  await running;
  assert.equal(button.disabled, false);
});

test('the lock is released so a later click works, and a failure does not wedge it', async () => {
  const onOk = guardedHandler(async () => 'first');
  assert.equal(await onOk({}), 'first');
  assert.equal(await onOk({}), 'first', 'the lock was never released');

  const onFail = guardedHandler(async () => {
    throw new Error('nope');
  });
  await assert.rejects(() => onFail({}), /nope/);
  await assert.rejects(() => onFail({}), /nope/, 'a failure left the lock held');
});

test('independent keys do not block each other, and a shared key does', async () => {
  const registry = createSingleFlight();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });

  const saveParameters = guardedHandler(() => blocked, { registry, key: 'save-parameters' });
  const savePolicy = guardedHandler(async () => 'policy', { registry, key: 'save-policy' });
  const otherSaveButton = guardedHandler(() => blocked, { registry, key: 'save-parameters' });

  const running = saveParameters({});
  // A different operation is not collateral damage.
  assert.equal(await savePolicy({}), 'policy');
  // A second control driving the *same* operation is.
  assert.equal(await otherSaveButton({}), SKIPPED);

  release('done');
  await running;
});

test('markBusy tolerates an absent control', async () => {
  // A programmatic call has no control that was clicked. The lock still applies;
  // only the visual state has nothing to attach to.
  assert.equal(typeof markBusy(null), 'function');
  const guarded = guardedHandler(async () => 'ok');
  assert.equal(await guarded(), 'ok');
});

// --------------------------------------------------------------------------
// The siblings. This was the reason to centralise rather than patch one button.
// --------------------------------------------------------------------------

test('an environment operation runs once however many times it is invoked', async () => {
  // The defect in its own right: this factory had a `setBusy` callback that
  // disabled a row's buttons, and one of its two call sites passed one while the
  // other passed none. Disabling a control is feedback, not a lock, and the call
  // site with no callback had neither.
  let runs = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const operation = createEnvironmentOperation({
    setInlineStatus() {},
    setGlobalStatus() {},
    // Deliberately no `setBusy`, reproducing `environmentOperation` exactly.
  })('Removing environment\u2026', async () => {
    runs += 1;
    await blocked;
    return 'removed';
  });

  const first = operation();
  const second = operation();
  release('go');
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(runs, 1, 'an environment operation ran twice');
  assert.equal(secondResult, SKIPPED);
  assert.equal(firstResult, 'removed');
});

test('a busy environment row is marked busy and released again, including on failure', async () => {
  const busy = [];
  const operation = createEnvironmentOperation({
    setInlineStatus() {},
    setGlobalStatus() {},
    setBusy: (value) => busy.push(value),
  })('Renaming environment\u2026', async () => {
    throw new Error('rename failed');
  });

  await operation();

  assert.deepEqual(busy, [true, false], 'the row was left busy after a failure');
  // And the lock came back, so the user can correct the problem and retry.
  await operation();
  assert.deepEqual(busy, [true, false, true, false]);
});

test('two different environment operations are independent', async () => {
  const factory = createEnvironmentOperation({
    setInlineStatus() {},
    setGlobalStatus() {},
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const rename = factory('Renaming\u2026', () => blocked);
  const remove = factory('Removing\u2026', async () => 'removed');

  const running = rename();
  assert.equal(await remove(), 'removed', 'one operation blocked an unrelated one');
  release('done');
  await running;
});

// --------------------------------------------------------------------------
// The module has to actually be used.
// --------------------------------------------------------------------------

test('every mutating save in the editor is bound through the guard', () => {
  assert.match(app, /import \{ guardedHandler \} from '\.\/single-flight\.mjs'/);
  // The parameter save: the exact binding that produced the duplicate.
  assert.match(app, /onclick:\s*guardedHandler\(commitSave,\s*\{\s*key:\s*'save-parameters'\s*\}\)/);
  // Its two siblings, which had the same shape and the same absence of a guard.
  assert.match(app, /guardedHandler\(async \(\) => \{[\s\S]*?\}, \{ key: 'save-policy' \}\)/);
  assert.match(app, /saveSubscriptionId:\s*guardedHandler\(/);
  assert.match(app, /\{ key: 'save-subscription-id' \}\)/);
});

test('no save is bound directly to a handler any more', () => {
  // The literal shape of the defect. If this reappears, the button is live
  // twice again.
  assert.doesNotMatch(app, /onclick:\s*commitSave\b/);
});

test('the save keys are stable strings, not per-render identities', () => {
  // `saveSubscriptionId` is rebuilt by `editContext` on every render. A lock
  // keyed by the wrapper would be a fresh lock each time, so a re-render during
  // an in-flight save would unlock it.
  const context = app.slice(app.indexOf('function editContext'));
  const body = context.slice(0, context.indexOf('\n}\n'));
  assert.match(body, /key: 'save-subscription-id'/);
});
