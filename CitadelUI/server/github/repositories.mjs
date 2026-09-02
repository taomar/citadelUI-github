/**
 * Repository, ref, and tree validation plus repository/branch discovery.
 *
 * Repository identity is always the immutable numeric ID. A full name is only
 * ever used as GitHub returned it for that ID, so a renamed or transferred
 * repository cannot silently redirect a selection.
 */
import { githubError } from './api.mjs';
import {
  isSkippedDirectory,
  isSourceExtension,
  MAX_SOURCE_BYTES,
  sourceExtension,
} from '../../shared/source-scope.mjs';

export const WORKING_BRANCH_PREFIX = 'citadel-ui/';
export const MAX_TREE_ENTRIES = 100_000;
export const BLOB_MODE_FILE = '100644';
export const BLOB_MODE_EXECUTABLE = '100755';
const SUPPORTED_BLOB_MODES = new Set([BLOB_MODE_FILE, BLOB_MODE_EXECUTABLE]);
const SYMLINK_MODE = '120000';
const SUBMODULE_MODE = '160000';

export function validateRepositoryId(value) {
  const id = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw githubError(400, 'INVALID_REPOSITORY_ID', 'A numeric repository id is required.');
  }
  return id;
}

/**
 * Validate a Git branch name against the documented ref rules.
 *
 * Refs reach path segments and JSON bodies of GitHub calls, so anything that
 * could traverse, inject a query, or produce an ambiguous ref is rejected here.
 */
export function validateBranchName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 255) {
    throw githubError(400, 'INVALID_BRANCH', 'A branch name of 1 to 255 characters is required.');
  }
  if (
    /[\u0000-\u001f\u007f ~^:?*[\\]/.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.includes('@{') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.startsWith('-') ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name === '@' ||
    name.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw githubError(400, 'INVALID_BRANCH', 'That branch name is not a valid Git ref.');
  }
  return name;
}

export function validateCommitSha(value, label = 'commit') {
  const sha = String(value ?? '').trim();
  if (!/^[0-9a-f]{40}$/.test(sha) && !/^[0-9a-f]{64}$/.test(sha)) {
    throw githubError(400, 'INVALID_SHA', `A full ${label} SHA is required.`);
  }
  return sha;
}

/** Working branch for an environment, derived only from validated ids. */
export function workingBranchName(environmentId) {
  const id = String(environmentId ?? '');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) {
    throw githubError(400, 'INVALID_ENVIRONMENT', 'Invalid environment id.');
  }
  return validateBranchName(`${WORKING_BRANCH_PREFIX}${id}`);
}

/**
 * Where a commit goes when its branch would not take it.
 *
 * Two properties matter, and both come from the name:
 *
 *   - It is derived from the commit, so retrying the same save converges on the
 *     same branch instead of littering the repository with one branch per
 *     attempt. Recovery has to be idempotent or it is not recovery.
 *   - It is a *sibling* of the working branch, never a child. Git refs are
 *     paths, so `citadel-ui/<id>/save-x` cannot exist while `citadel-ui/<id>`
 *     does — one cannot be both a file and a directory. A nested name would fail
 *     precisely in the case this exists to handle.
 */
export function rescueBranchName(environmentId, commitSha) {
  const id = String(environmentId ?? '');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) {
    throw githubError(400, 'INVALID_ENVIRONMENT', 'Invalid environment id.');
  }
  const sha = validateCommitSha(commitSha);
  return validateBranchName(`${WORKING_BRANCH_PREFIX}${id}-save-${sha.slice(0, 12)}`);
}

/** Public, non-sensitive projection of a GitHub repository. */
export function describeRepository(repository) {
  return {
    id: repository.id,
    fullName: repository.full_name,
    owner: repository.owner?.login || null,
    name: repository.name,
    visibility: repository.private ? 'private' : 'public',
    archived: Boolean(repository.archived),
    disabled: Boolean(repository.disabled),
    defaultBranch: repository.default_branch || null,
    canPush: Boolean(repository.permissions?.push),
    canAdmin: Boolean(repository.permissions?.admin),
    updatedAt: repository.updated_at || null,
  };
}

export function describeBranch(branch) {
  return {
    name: branch.name,
    commit: branch.commit?.sha || null,
    protected: Boolean(branch.protected),
  };
}

/**
 * List every repository the credential can read.
 *
 * Archived and disabled repositories are returned but flagged so the UI can
 * disable them for write mode instead of silently hiding them.
 */
export async function listRepositories(client, token) {
  const { items, truncated } = await client.paginate('/user/repos?affiliation=owner,collaborator,organization_member&sort=updated', {
    token,
    maxPages: 10,
    perPage: 100,
    maxItems: 1000,
  });
  const repositories = items
    .filter((item) => item && typeof item.id === 'number' && typeof item.full_name === 'string')
    .map(describeRepository);
  repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
  return { repositories, truncated };
}

/**
 * Re-resolve a repository by its immutable numeric ID.
 *
 * Every later call uses the `full_name` this returns, never a name supplied by
 * the browser.
 */
export async function getRepository(client, token, repositoryId) {
  const id = validateRepositoryId(repositoryId);
  const { data } = await client.request(`/repositories/${id}`, { token });
  if (!data || data.id !== id || typeof data.full_name !== 'string') {
    throw githubError(404, 'REPOSITORY_NOT_FOUND', 'That repository is not available to this credential.');
  }
  return describeRepository(data);
}

export async function listBranches(client, token, repositoryId) {
  const repository = await getRepository(client, token, repositoryId);
  const { items, truncated } = await client.paginate(
    `/repos/${repository.fullName}/branches`,
    { token, maxPages: 5, perPage: 100, maxItems: 500 }
  );
  const branches = items
    .filter((item) => item && typeof item.name === 'string')
    .map(describeBranch);
  branches.sort((left, right) => left.name.localeCompare(right.name));
  return { repository, branches, truncated };
}

/**
 * Reduce a recursive Git tree to the Citadel source scope.
 *
 * Symlinks, submodules, oversized blobs, and unsupported modes are rejected
 * rather than skipped when they fall inside the scope, because silently ignoring
 * them would let a repository hide a file the editor believes it enumerated.
 */
export function filterSourceTree(entries) {
  const files = [];
  const rejected = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry.path !== 'string') continue;
    const path = entry.path;
    if (path.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(path)) {
      rejected.push({ path, reason: 'unsafe-path' });
      continue;
    }
    const parts = path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      rejected.push({ path, reason: 'unsafe-path' });
      continue;
    }
    if (entry.type === 'tree') continue;
    if (entry.type === 'commit' || entry.mode === SUBMODULE_MODE) {
      if (!parts.slice(0, -1).some(isSkippedDirectory)) {
        rejected.push({ path, reason: 'submodule' });
      }
      continue;
    }
    if (parts.slice(0, -1).some(isSkippedDirectory)) continue;
    const leaf = parts.at(-1);
    if (!isSourceExtension(leaf)) continue;
    if (entry.mode === SYMLINK_MODE) {
      rejected.push({ path, reason: 'symlink' });
      continue;
    }
    if (!SUPPORTED_BLOB_MODES.has(entry.mode)) {
      rejected.push({ path, reason: 'unsupported-mode' });
      continue;
    }
    if (!/^[0-9a-f]{40}$/.test(String(entry.sha || '')) && !/^[0-9a-f]{64}$/.test(String(entry.sha || ''))) {
      rejected.push({ path, reason: 'invalid-sha' });
      continue;
    }
    const size = Number(entry.size);
    if (!Number.isFinite(size) || size < 0) {
      rejected.push({ path, reason: 'invalid-size' });
      continue;
    }
    if (size > MAX_SOURCE_BYTES) {
      rejected.push({ path, reason: 'too-large' });
      continue;
    }
    files.push({
      alias: path,
      kind: sourceExtension(leaf).slice(1),
      sha: entry.sha,
      mode: entry.mode,
      size,
    });
  }
  files.sort((left, right) => left.alias.localeCompare(right.alias));
  return { files, rejected };
}

/** Git LFS pointer detection, so a pointer is never edited as if it were source. */
export function isLfsPointer(text) {
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(String(text || ''));
}
