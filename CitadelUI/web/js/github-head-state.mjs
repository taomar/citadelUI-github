const revisions = new Map();
export const githubHeadEvents = new EventTarget();

export function githubBranchKey(source) {
  return source?.kind === 'github' ? JSON.stringify([String(source.repositoryId), source.workingBranch]) : null;
}

export function githubHeadRevision(key) { return key ? revisions.get(key) || 0 : 0; }

export function notifyGitHubHead(environment, commit) {
  const key = githubBranchKey(environment.source);
  if (!key) return;
  revisions.set(key, githubHeadRevision(key) + 1);
  githubHeadEvents.dispatchEvent(new CustomEvent('change', { detail: { key, environmentId: environment.id, commit } }));
}
