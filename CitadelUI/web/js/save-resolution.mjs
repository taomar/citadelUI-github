import { mutationComplete, mutationOutcome } from '../../shared/mutation-outcome.mjs';

/**
 * What to ask the user when a save is refused and the work is not on the branch.
 *
 * ## A deliberate reversal
 *
 * This module used to explain where a save had *gone*. When a branch refused a
 * commit, Citadel created `<branch>-save-<sha>` automatically and this turned
 * that into a sentence and a compare link.
 *
 * That was already the second design. The first reported durable work as lost
 * and advised a reload that would have destroyed it, which was worse. But
 * auto-creating the branch was still wrong: a user opened their repository and
 * found three branches they had never asked for. Creating a ref changes their
 * repository, and it was being done on their behalf without a word.
 *
 * The commit is what makes asking affordable. It exists, with the reviewed
 * parent, and Git reaches it by SHA with no branch pointing at it — so nothing
 * is lost in the time it takes to ask. Citadel now creates nothing and puts the
 * choice in front of the user.
 *
 * Still pure, so the wording and the URL are testable without a DOM.
 */

/** GitHub's compare view between two branches of one repository. */
export function compareUrl(fullName, base, head) {
  if (!fullName || !base || !head) return null;
  const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  return `https://github.com/${fullName}/compare/${range}?expand=1`;
}

/**
 * Describe a refused save as a decision the user has to make.
 *
 * Returns `null` for an ordinary save, so the caller's normal path is unchanged
 * and this only ever *adds* a question.
 */
export function describeSaveResolution(result, source) {
  const unresolved = result?.unresolved;
  if (!unresolved?.commit) return null;
  const intended = unresolved.intendedBranch || source?.workingBranch || 'the branch';
  if (unresolved.kind === 'outcome-unknown') {
    return {
      ...unresolved, title: 'This change needs outcome confirmation',
      message: `Commit ${unresolved.commit.slice(0, 12)} exists, but Citadel could not confirm its outcome on ${intended}. Keep this action and inspect History or reopen the workspace before retrying. You may explicitly give the commit another branch name; that does not change this workspace's target.`,
    };
  }
  const cause =
    unresolved.kind === 'branch-protected'
      ? `${intended} is protected, so Citadel could not update it.`
      : `${intended} moved while you were saving, so it would not accept this change.`;
  return {
    kind: unresolved.kind,
    commit: unresolved.commit,
    intendedBranch: unresolved.intendedBranch || null,
    suggestedBranch: unresolved.suggestedBranch || null,
    title: 'This change needs somewhere to go',
    // Order matters. What happened, then that nothing is lost, then the choice.
    // A user who reads only the first sentence must not conclude their work is
    // gone — and must not be told a branch exists when none does.
    message: `${cause} Your change is committed as ${unresolved.commit.slice(
      0,
      12
    )} and is safe, but Citadel has not put it on any branch — it does not create branches you did not ask for. Give it a branch name, or reload and save again onto ${intended}.`,
  };
}

/**
 * One line for the status bar.
 *
 * A refused save is not a completed one, so it is not reported as "Saved". The
 * work is safe and the sentence says so, but the outcome is a question.
 */
export function saveStatusLine(result, source, options = {}) {
  const pending = describeSaveResolution(result, source);
  const caveats = (result?.warnings || []).join(' ');
  if (pending) {
    return { text: `${pending.message}${caveats ? ` ${caveats}` : ''}`, tone: 'warn', pending };
  }
  if (!mutationComplete(result)) {
    const base = mutationOutcome(result) === 'recovery-required'
      ? 'This change requires History recovery. Source bytes and the pending action must be retained.'
      : mutationOutcome(result) === 'pending'
        ? 'This change has not been applied. The pending action is retained.'
        : 'The mutation outcome is not confirmed. Keep the pending action and inspect History before another attempt.';
    return { text: `${base}${caveats ? ` ${caveats}` : ''}`, tone: 'warn' };
  }
  if (mutationOutcome(result) === 'unchanged') {
    return { text: `${options.unchangedText || 'Nothing changed.'}${caveats ? ` ${caveats}` : ''}`, tone: caveats ? 'warn' : 'ok' };
  }
  const base = options.successText || `Saved ${result.path}. Previous revision archived to ${result.archived}`;
  return { text: `${base}${caveats ? ` ${caveats}` : ''}`, tone: caveats ? 'warn' : 'ok' };
}

/** Confirmation once the user has named a branch and Citadel has created it. */
export function describeCreatedBranch(outcome, source, intendedBranch) {
  if (!outcome?.branch || typeof outcome.branch !== 'string' || typeof outcome.created !== 'boolean') return null;
  const warnings = [...(outcome.warnings || [])];
  if (outcome.unlogged) warnings.push('The branch exists, but its History audit record could not be written.');
  const message = outcome.created
    ? `Your change is on ${outcome.branch}. Compare it against ${intendedBranch || 'the branch'} and open a pull request when you are ready.`
    : `${outcome.branch} already held this change.`;
  return {
    branch: outcome.branch,
    commit: outcome.commit || null,
    message: `${message}${warnings.length ? ` ${warnings.join(' ')}` : ''}`,
    tone: warnings.length ? 'warn' : 'info',
    warnings,
    compareUrl: compareUrl(source?.fullName, intendedBranch, outcome.branch),
    linkLabel: `Compare ${outcome.branch}`,
  };
}
