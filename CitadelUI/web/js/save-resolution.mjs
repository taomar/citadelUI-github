/**
 * What to tell the user when a save landed somewhere other than where it aimed.
 *
 * ## Why this exists
 *
 * A working branch can refuse a commit for two ordinary reasons: someone else
 * pushed to it, or it is protected. Citadel used to report both as failures —
 * *"your edits were not applied; reload and review again"* — and that was
 * wrong twice over. The commit object, with the reviewed parent, already
 * existed by the time the branch refused it; only the ref update failed. So the
 * work was durable, and the advice was to reload and destroy it.
 *
 * The server now gives that commit a branch of its own. This module turns that
 * outcome into something a person can act on: what happened, where the change
 * is, and a link to see it. It is deliberately pure so the wording and the URL
 * can be tested without a DOM.
 *
 * The compare link is a plain github.com URL the user's own session authorises.
 * Citadel makes no pull request API call and needs no such permission.
 */

/** GitHub's compare view between two branches of one repository. */
export function compareUrl(fullName, base, head) {
  if (!fullName || !base || !head) return null;
  const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  return `https://github.com/${fullName}/compare/${range}?expand=1`;
}

/**
 * Describe a rescued save.
 *
 * Returns `null` for an ordinary save, so the caller's normal path is
 * unchanged and this only ever *adds* an explanation.
 */
export function describeSaveResolution(result, source) {
  const resolution = result?.resolution;
  if (!resolution?.branch) return null;
  const intended = source?.workingBranch || null;
  const cause =
    resolution.kind === 'branch-protected'
      ? `${intended || 'The branch'} is protected, so Citadel could not update it.`
      : `${intended || 'The branch'} moved while you were saving, so it would not accept this change.`;
  return {
    kind: resolution.kind,
    branch: resolution.branch,
    commit: result.commit || null,
    title: 'Saved to a separate branch',
    // Stated in this order on purpose: what happened, then that nothing was
    // lost, then where it is. A user who reads only the first sentence must not
    // come away believing their work is gone.
    message: `${cause} Your change was committed and is safe — Citadel put it on ${resolution.branch} instead of discarding it. Compare it against ${
      intended || 'the branch'
    } and open a pull request when you are ready.`,
    compareUrl: compareUrl(source?.fullName, intended, resolution.branch),
    linkLabel: `Compare ${resolution.branch}`,
  };
}

/**
 * One line for the status bar.
 *
 * A rescued save is still a save: it is reported as done, with the caveat
 * appended, exactly as the existing post-write warnings are.
 */
export function saveStatusLine(result, source) {
  const rescued = describeSaveResolution(result, source);
  const caveats = (result?.warnings || []).join(' ');
  if (!result?.changed) return { text: 'Nothing changed.', tone: 'ok' };
  const base = `Saved ${result.path}. Previous revision archived to ${result.archived}`;
  if (rescued) {
    return {
      text: `${base}. ${rescued.message}${caveats ? ` ${caveats}` : ''}`,
      tone: 'warn',
      rescued,
    };
  }
  return { text: `${base}${caveats ? ` ${caveats}` : ''}`, tone: caveats ? 'warn' : 'ok' };
}
