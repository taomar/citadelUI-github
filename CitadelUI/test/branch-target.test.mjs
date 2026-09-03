/**
 * The branch a save lands on is the user's choice, and it is named.
 *
 * ## The defect these prove fixed
 *
 * Attaching a repository silently created `citadel-ui/<environment-uuid>` and
 * wrote every edit there. A user picked `CitadelQA` from a list headed "Source
 * branch", pressed Attach, and their work went to a branch they had never seen,
 * named after an identifier they had no way to recognise. The only way to find
 * out was to open GitHub.
 *
 * Three separate things were wrong and only one of them was the name:
 *
 *   - creating a branch was automatic, and the checkbox that would have
 *     prevented it arrived pre-ticked;
 *   - the branch created was not the branch the user had just chosen;
 *   - nothing ever stated, in words, where a save was going to go.
 *
 * These assert the decision itself. It is a pure module precisely so the rules
 * can be held to this standard without a DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TARGET,
  describeWriteTarget,
  resolveWriteTarget,
  suggestedBranchName,
} from '../web/js/branch-target.mjs';
import { refNameProblem, isValidRefName } from '../../CitadelUI/shared/git-refs.mjs';
import { validateBranchName } from '../server/github/repositories.mjs';

const BRANCHES = [
  { name: 'main', protected: true },
  { name: 'CitadelQA', protected: false },
  { name: 'citadel-ui/taken', protected: false },
  { name: 'locked', protected: true },
];

// --------------------------------------------------------------------------
// The default is the branch you chose.
// --------------------------------------------------------------------------

test('nothing is chosen for the user, and the default is their own branch', () => {
  assert.deepEqual(DEFAULT_TARGET, { createBranch: false, name: '', adopt: false });

  const target = resolveWriteTarget({ sourceBranch: 'CitadelQA', branches: BRANCHES });

  assert.equal(target.ok, true);
  assert.equal(target.writeMode, 'direct');
  assert.equal(target.workingBranch, 'CitadelQA');
  assert.equal(target.branchChoice, 'selected');
  // Said in words, before anything is created.
  assert.equal(target.summary, 'Saves commit directly to CitadelQA.');
});

test('no branch chosen yet is not a write target', () => {
  const target = resolveWriteTarget({ sourceBranch: '', branches: BRANCHES });
  assert.equal(target.ok, false);
  assert.equal(target.workingBranch, null);
  assert.match(target.problem, /Choose a source branch/);
});

test('opting in without a name is refused, not filled in for you', () => {
  const target = resolveWriteTarget({
    sourceBranch: 'CitadelQA',
    createBranch: true,
    name: '',
    branches: BRANCHES,
  });
  assert.equal(target.ok, false);
  assert.equal(target.workingBranch, null);
  assert.match(target.problem, /Enter a branch name/);
  // And it must not quietly fall back to the source branch either.
  assert.notEqual(target.workingBranch, 'CitadelQA');
});

test('a named new branch is created from the branch the user selected', () => {
  const target = resolveWriteTarget({
    sourceBranch: 'CitadelQA',
    createBranch: true,
    name: 'citadel-ui/my-work',
    branches: BRANCHES,
  });
  assert.equal(target.ok, true);
  assert.equal(target.writeMode, 'working-branch');
  assert.equal(target.workingBranch, 'citadel-ui/my-work');
  assert.equal(target.branchChoice, 'created');
  assert.match(target.summary, /creates citadel-ui\/my-work from CitadelQA/);
});

// --------------------------------------------------------------------------
// A name that is not a Git ref is refused, with the reason.
// --------------------------------------------------------------------------

test('every rejected character class says which rule it broke', () => {
  const cases = [
    ['my branch', /spaces/],
    ['feature/../etc', /"\.\."/],
    ['feature~1', /"~"/],
    ['feature^2', /"\^"/],
    ['feature:name', /":"/],
    ['what?', /"\?"/],
    ['star*', /"\*"/],
    ['bracket[1]', /"\["/],
    ['back\\slash', /backslash/],
    ['/leading', /start with "\/"/],
    ['trailing/', /end with "\/"/],
    ['double//segment', /empty path segment/],
    ['-leading', /start with "-"/],
    ['trailing.', /end with "\."/],
    ['thing.lock', /"\.lock"/],
    ['feature/.hidden', /start with "\."/],
    ['feature/sub.lock/x', /"\.lock"/],
    ['@', /"@"/],
    ['head@{1}', /"@\{"/],
    ['', /Enter a branch name/],
    ['x'.repeat(256), /at most 255/],
  ];
  for (const [name, expected] of cases) {
    const problem = refNameProblem(name);
    assert.match(problem || '', expected, `${JSON.stringify(name)} was accepted or misexplained`);
    assert.equal(isValidRefName(name), false, name);
    // And the same name is refused through the write-target decision, so the
    // field and the attach agree.
    const target = resolveWriteTarget({
      sourceBranch: 'CitadelQA',
      createBranch: true,
      name,
      branches: BRANCHES,
    });
    assert.equal(target.ok, false, name);
    assert.equal(target.workingBranch, null, name);
  }
});

test('the browser and the server apply one rule, not two copies of it', () => {
  // The rules moved to `shared/` when the user gained the ability to type a
  // name. A second copy in the browser would drift, and the copy the user reads
  // would eventually disagree with the copy that decides.
  for (const name of ['my branch', 'feature/../etc', 'trailing.', '@', 'x'.repeat(256)]) {
    assert.equal(isValidRefName(name), false, name);
    assert.throws(() => validateBranchName(name), (error) => error.code === 'INVALID_BRANCH', name);
  }
  for (const name of ['feature/one', 'citadel-ui/my-work', 'CitadelQA']) {
    assert.equal(isValidRefName(name), true, name);
    assert.equal(validateBranchName(name), name);
  }
});

// --------------------------------------------------------------------------
// An existing name is neither overwritten nor silently adopted.
// --------------------------------------------------------------------------

test('a name that already exists is reported as existing, not taken over', () => {
  const target = resolveWriteTarget({
    sourceBranch: 'CitadelQA',
    createBranch: true,
    name: 'citadel-ui/taken',
    branches: BRANCHES,
  });
  assert.equal(target.ok, false, 'an existing branch was adopted without being asked');
  assert.equal(target.exists, true);
  assert.equal(target.needsAdoption, true);
  assert.equal(target.workingBranch, null);
  assert.match(target.problem, /already exists/);
  assert.match(target.problem, /choose another name/i);
});

test('adoption is deliberate, and is then recorded as adoption rather than creation', () => {
  const target = resolveWriteTarget({
    sourceBranch: 'CitadelQA',
    createBranch: true,
    name: 'citadel-ui/taken',
    adopt: true,
    branches: BRANCHES,
  });
  assert.equal(target.ok, true);
  assert.equal(target.workingBranch, 'citadel-ui/taken');
  // Not `created`. A branch Citadel made and a branch it was pointed at are
  // different things to the person whose repository it is.
  assert.equal(target.branchChoice, 'adopted');
  assert.match(target.summary, /existing branch citadel-ui\/taken/);
});

test('naming the branch you already selected is explained, not silently accepted', () => {
  const target = resolveWriteTarget({
    sourceBranch: 'CitadelQA',
    createBranch: true,
    name: 'CitadelQA',
    branches: BRANCHES,
  });
  assert.equal(target.ok, false);
  assert.match(target.problem, /is the branch you selected/);
  // It is offered as the thing it actually is, rather than as an error to solve.
  assert.match(target.problem, /Clear this option/);
});

// --------------------------------------------------------------------------
// Protection is surfaced when the choice is still the user's to change.
// --------------------------------------------------------------------------

test('a protected branch is flagged at selection time, not after the first save', () => {
  const target = resolveWriteTarget({ sourceBranch: 'main', branches: BRANCHES });
  assert.equal(target.ok, true);
  assert.equal(target.protectedTarget, true, 'protection was not surfaced before attaching');

  const unprotected = resolveWriteTarget({ sourceBranch: 'CitadelQA', branches: BRANCHES });
  assert.equal(unprotected.protectedTarget, false);
});

test('adopting a protected branch reports the protection too', () => {
  const target = resolveWriteTarget({
    sourceBranch: 'CitadelQA',
    createBranch: true,
    name: 'locked',
    adopt: true,
    branches: BRANCHES,
  });
  assert.equal(target.ok, true);
  assert.equal(target.protectedTarget, true);
});

test('a branch Citadel is about to create cannot already be protected', () => {
  const target = resolveWriteTarget({
    sourceBranch: 'CitadelQA',
    createBranch: true,
    name: 'citadel-ui/brand-new',
    branches: BRANCHES,
  });
  assert.equal(target.protectedTarget, false);
});

// --------------------------------------------------------------------------
// The suggestion is offered, never imposed.
// --------------------------------------------------------------------------

test('a suggested name is derived from the branch, and is itself a valid ref', () => {
  const suggested = suggestedBranchName('CitadelQA', BRANCHES);
  assert.equal(suggested, 'citadel-ui/citadelqa');
  assert.equal(isValidRefName(suggested), true);
  // Readable, not an opaque identifier. This is the whole complaint.
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(suggested), false);
});

test('a suggestion never collides with a branch that already exists', () => {
  const suggested = suggestedBranchName('taken', [
    { name: 'citadel-ui/taken' },
    { name: 'citadel-ui/taken-2' },
  ]);
  assert.equal(suggested, 'citadel-ui/taken-3');
});

test('a branch name that cannot be made into a ref yields no suggestion', () => {
  assert.equal(suggestedBranchName('...', []), 'citadel-ui/work');
  assert.equal(isValidRefName(suggestedBranchName('feature/deep/name', [])), true);
});

// --------------------------------------------------------------------------
// After attaching, the user is still told where saves go.
// --------------------------------------------------------------------------

test('an attached workspace can always say where a save will land', () => {
  assert.deepEqual(
    describeWriteTarget({
      kind: 'github',
      sourceBranch: 'CitadelQA',
      workingBranch: 'CitadelQA',
      writeMode: 'direct',
      branchChoice: 'selected',
    }),
    { branch: 'CitadelQA', choice: 'selected', text: 'CitadelQA — the branch you selected' }
  );
  assert.deepEqual(
    describeWriteTarget({
      kind: 'github',
      sourceBranch: 'main',
      workingBranch: 'citadel-ui/my-work',
      writeMode: 'working-branch',
      branchChoice: 'created',
    }),
    {
      branch: 'citadel-ui/my-work',
      choice: 'created',
      text: 'citadel-ui/my-work — a branch Citadel created',
    }
  );
  assert.equal(
    describeWriteTarget({
      kind: 'github',
      sourceBranch: 'main',
      workingBranch: 'shared/work',
      writeMode: 'working-branch',
      branchChoice: 'adopted',
    }).text,
    'shared/work — a branch you adopted'
  );
});

test('a record written before this field existed does not pretend to know', () => {
  // Migration was dropped: old data does not matter, and inventing provenance
  // for a record nobody can vouch for is exactly the bad data going forward the
  // user asked to avoid. It still names the branch, so nothing crashes and the
  // user can still see where saves go.
  const described = describeWriteTarget({
    kind: 'github',
    sourceBranch: 'CitadelQA',
    workingBranch: 'citadel-ui/d79d23d1-d638-42fd-a0ff-1992dfbfa2eb',
    writeMode: 'working-branch',
  });
  assert.equal(described.branch, 'citadel-ui/d79d23d1-d638-42fd-a0ff-1992dfbfa2eb');
  assert.equal(described.choice, null);
  assert.match(described.text, /citadel-ui\/d79d23d1/);
  assert.match(described.text, /not recorded/);
});

test('a local workspace has no branch to describe', () => {
  assert.equal(describeWriteTarget({ kind: 'local', folderName: 'citadel' }), null);
  assert.equal(describeWriteTarget(null), null);
});
