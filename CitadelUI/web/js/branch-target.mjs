/**
 * Where will this save land, and did the user actually choose it?
 *
 * ## The defect this exists to fix
 *
 * Attaching a repository silently created a branch named
 * `citadel-ui/<environment-uuid>` and wrote every edit there. The user picked
 * `CitadelQA` in a list titled "Source branch", pressed Attach, and their work
 * went to a branch they had never seen, whose name contained a UUID they had no
 * way to recognise. The only way to discover this was to open GitHub.
 *
 * Three things were wrong, and only one of them was the name:
 *
 *   - creating a branch was automatic, and the checkbox that would have stopped
 *     it was pre-checked;
 *   - the branch that got created was not the branch the user had just chosen;
 *   - nothing ever said, in words, where a save was going to go.
 *
 * ## Why this is a module
 *
 * The decision has three inputs (the selected branch, whether the user opted
 * into a new one, and the name they typed), a validation rule that must produce
 * a *reason* rather than a boolean, a collision check against branches that
 * already exist, and one sentence of output that the user reads before
 * committing to any of it. That is logic, and the panel it used to live in
 * cannot be tested — the same reason `github-selection.mjs` was extracted.
 *
 * Pure by construction: no DOM, no network, no globals.
 */
import { refNameProblem } from '../../shared/git-refs.mjs';

/** Nothing is chosen for the user; the default is the branch they picked. */
export const DEFAULT_TARGET = Object.freeze({ createBranch: false, name: '', adopt: false });

/**
 * A name Citadel would be happy with, offered rather than imposed.
 *
 * Returned as a suggestion the user can take in one action, never written into
 * the field. Pre-filling is how the opaque branch happened: a value nobody typed
 * looks exactly like a value somebody approved.
 *
 * Derived from the source branch, so it reads as what it is — a working copy of
 * that branch — instead of an opaque identifier.
 */
export function suggestedBranchName(sourceBranch, existing = []) {
  const base = String(sourceBranch || '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
    .replace(/\/+/g, '-');
  const stem = `citadel-ui/${base || 'work'}`;
  if (refNameProblem(stem)) return null;
  const taken = new Set((existing || []).map((branch) => branch?.name ?? branch));
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the write target, or say precisely why it cannot be resolved.
 *
 * Returns `{ ok, writeMode, workingBranch, branchChoice, problem, exists,
 * needsAdoption, protectedTarget, summary }`.
 *
 * `problem` is a sentence for the field. `summary` is the sentence for the user
 * that names the branch a save will land on, and it is produced for valid and
 * invalid states alike so the UI never has to invent one.
 */
export function resolveWriteTarget(options = {}) {
  const {
    sourceBranch = '',
    createBranch = false,
    name = '',
    adopt = false,
    branches = [],
  } = options;

  const known = new Map(
    (branches || [])
      .filter((branch) => branch && typeof branch.name === 'string')
      .map((branch) => [branch.name, branch])
  );
  const sourceIsProtected = Boolean(known.get(sourceBranch)?.protected);

  if (!sourceBranch) {
    return {
      ok: false,
      writeMode: null,
      workingBranch: null,
      branchChoice: null,
      problem: 'Choose a source branch first.',
      exists: false,
      needsAdoption: false,
      protectedTarget: false,
      summary: 'No branch chosen yet.',
    };
  }

  // The default, and the thing the user asked for: their edits go to the branch
  // they selected.
  if (!createBranch) {
    return {
      ok: true,
      writeMode: 'direct',
      workingBranch: sourceBranch,
      branchChoice: 'selected',
      problem: null,
      exists: true,
      needsAdoption: false,
      // Surfaced at selection time, not after the first save fails. A protected
      // branch will refuse the commit; the user is entitled to know that while
      // the choice is still theirs to change.
      protectedTarget: sourceIsProtected,
      summary: `Saves commit directly to ${sourceBranch}.`,
    };
  }

  const typed = String(name || '').trim();
  const problem = refNameProblem(typed);
  if (problem) {
    return {
      ok: false,
      writeMode: 'working-branch',
      workingBranch: null,
      branchChoice: null,
      problem,
      exists: false,
      needsAdoption: false,
      protectedTarget: false,
      summary: 'Name the branch Citadel should create.',
    };
  }

  if (typed === sourceBranch) {
    return {
      ok: false,
      writeMode: 'working-branch',
      workingBranch: null,
      branchChoice: null,
      problem: `${typed} is the branch you selected. Clear this option to write to it directly.`,
      exists: true,
      needsAdoption: false,
      protectedTarget: sourceIsProtected,
      summary: `Saves commit directly to ${sourceBranch}.`,
    };
  }

  const existing = known.get(typed) || null;
  if (existing && !adopt) {
    // Neither silently overwritten nor silently adopted. Adopting somebody
    // else's branch is a decision, and it is made here or not at all.
    return {
      ok: false,
      writeMode: 'working-branch',
      workingBranch: null,
      branchChoice: null,
      problem: `${typed} already exists in this repository. Use it as it is, or choose another name.`,
      exists: true,
      needsAdoption: true,
      protectedTarget: Boolean(existing.protected),
      summary: `${typed} already exists.`,
    };
  }

  return {
    ok: true,
    writeMode: 'working-branch',
    workingBranch: typed,
    branchChoice: existing ? 'adopted' : 'created',
    problem: null,
    exists: Boolean(existing),
    needsAdoption: false,
    protectedTarget: Boolean(existing?.protected),
    summary: existing
      ? `Saves commit to the existing branch ${typed}.`
      : `Citadel creates ${typed} from ${sourceBranch}, and saves commit there.`,
  };
}

/**
 * One sentence naming where a save will land, for a workspace already attached.
 *
 * The editor needs this every time it shows a review dialog, and it must be
 * derivable from the registry record alone — a user should never have to open
 * GitHub to find out which branch got their edits.
 */
export function describeWriteTarget(source) {
  if (!source || source.kind !== 'github') return null;
  const branch = source.workingBranch || source.sourceBranch || null;
  if (!branch) return null;
  // Absent stays absent. A record written before this field existed cannot be
  // described honestly by guessing, and inventing one would be exactly the bad
  // data this is here to prevent.
  const choice = source.branchChoice || null;
  const origin =
    choice === 'selected'
      ? 'the branch you selected'
      : choice === 'adopted'
        ? 'a branch you adopted'
        : choice === 'created'
          ? 'a branch Citadel created'
          : 'how this branch was chosen is not recorded';
  return { branch, choice, text: `${branch} — ${origin}` };
}
