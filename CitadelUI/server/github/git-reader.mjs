/**
 * Read-only GitHub tree, blob, path and branch access.
 *
 * Branch heads are mutable. Callers own any immutable tree/blob caching.
 */
import { githubError } from './api.mjs';
import { workspaceScope } from '../../shared/workspace-configuration.mjs';
import {
  BLOB_MODE_EXECUTABLE,
  BLOB_MODE_FILE,
  filterSourceTree,
  isLfsPointer,
  MAX_TREE_ENTRIES,
  validateBranchName,
  validateCommitSha,
} from './repositories.mjs';
import { isSkippedDirectory, MAX_SOURCE_BYTES, sha256 } from '../../shared/source-scope.mjs';

export function encodePath(alias) {
  return alias.split('/').map(encodeURIComponent).join('/');
}

/** Read the current commit SHA for a branch, or null when the branch is absent. */
export async function branchHead(client, token, fullName, branch) {
  const ref = validateBranchName(branch);
  try {
    const { data } = await client.request(
      `/repos/${fullName}/git/ref/heads/${encodePath(ref)}`,
      { token }
    );
    if (data?.object?.type !== 'commit') {
      throw githubError(409, 'AMBIGUOUS_REF', 'That branch does not resolve to a commit.');
    }
    return validateCommitSha(data.object.sha);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function requireBranchHead(client, token, fullName, branch) {
  const head = await branchHead(client, token, fullName, branch);
  if (!head) {
    throw githubError(404, 'BRANCH_NOT_FOUND', `Branch ${branch} no longer exists.`);
  }
  return head;
}

/**
 * Is `candidate` an ancestor of, or equal to, the branch head?
 *
 * A commit on some other branch is still fetchable by SHA, so reachability from
 * the selected working branch is what makes an undo legitimate.
 */
export async function isReachable(client, token, fullName, branch, candidate) {
  const ref = validateBranchName(branch);
  const { data } = await client.request(
    `/repos/${fullName}/commits?sha=${encodeURIComponent(ref)}&per_page=100`,
    { token }
  );
  return (Array.isArray(data) ? data : []).some((entry) => entry.sha === candidate);
}

async function commitTreeSha(client, token, fullName, commitSha) {
  const { data } = await client.request(
    `/repos/${fullName}/git/commits/${validateCommitSha(commitSha)}`,
    { token }
  );
  const tree = data?.tree?.sha;
  if (!tree) throw githubError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned no tree for the commit.');
  return validateCommitSha(tree, 'tree');
}

/**
 * Walk subtrees when a recursive tree is truncated.
 *
 * Only directories that pass the shared skip policy are visited, and the total
 * entry count is bounded so a hostile repository cannot force unbounded work.
 */
async function walkSubtrees(client, token, fullName, rootTreeSha) {
  const entries = [];
  const queue = [{ sha: rootTreeSha, prefix: '' }];
  let visited = 0;
  while (queue.length) {
    const { sha, prefix } = queue.shift();
    visited += 1;
    if (visited > 2000 || entries.length > MAX_TREE_ENTRIES) {
      throw githubError(
        413,
        'TREE_TOO_LARGE',
        'This repository tree is too large for Citadel UI to enumerate.'
      );
    }
    const { data } = await client.request(`/repos/${fullName}/git/trees/${sha}`, { token });
    for (const entry of data?.tree || []) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'tree') {
        if (isSkippedDirectory(entry.path)) continue;
        queue.push({ sha: entry.sha, prefix: path });
        continue;
      }
      entries.push({ ...entry, path });
    }
  }
  return entries;
}

/** Enumerate the Citadel source scope for one commit. */
export async function loadTree(client, token, fullName, commitSha, configuration = undefined, options = {}) {
  const treeSha = await commitTreeSha(client, token, fullName, commitSha);
  const { data } = await client.request(
    `/repos/${fullName}/git/trees/${treeSha}?recursive=1`,
    { token, limit: 24 * 1024 * 1024 }
  );
  const raw = Array.isArray(data?.tree) ? data.tree : [];
  if (raw.length > MAX_TREE_ENTRIES) {
    throw githubError(413, 'TREE_TOO_LARGE', 'This repository tree is too large for Citadel UI.');
  }
  const entries = data?.truncated
    ? await walkSubtrees(client, token, fullName, treeSha)
    : raw;
  const { files, rejected } = filterSourceTree(entries, configuration, options);
  return { commit: commitSha, treeSha, files, rejected, truncated: Boolean(data?.truncated) };
}

/**
 * Index a commit's tree by path, independently of the browsable source scope.
 *
 * By default only regular file blobs are indexed. `includeAll` retains other
 * blob modes; `complete` also includes trees and submodules so a creation can
 * detect any object occupying its path.
 *
 * `truncated` is reported because the fallback walk applies the enumeration skip
 * policy, so absence in a truncated index is not proof of absence in the
 * repository. Callers that must be certain use `lookupPath`.
 */
export async function treeIndex(client, token, fullName, commitSha, options = {}) {
  const treeSha = await commitTreeSha(client, token, fullName, commitSha);
  const { data } = await client.request(
    `/repos/${fullName}/git/trees/${treeSha}?recursive=1`,
    { token, limit: 24 * 1024 * 1024 }
  );
  const truncated = Boolean(data?.truncated);
  const entries = truncated
    ? await walkSubtrees(client, token, fullName, treeSha)
    : Array.isArray(data?.tree)
      ? data.tree
      : [];
  const index = new Map();
  for (const entry of entries) {
    if (typeof entry?.path !== 'string') continue;
    if (!options.complete) {
      if (entry.type !== 'blob') continue;
      if (
        !options.includeAll &&
        entry.mode !== BLOB_MODE_FILE &&
        entry.mode !== BLOB_MODE_EXECUTABLE
      ) {
        continue;
      }
    }
    index.set(entry.path, {
      sha: entry.sha,
      mode: entry.mode,
      size: Number(entry.size) || 0,
      type: entry.type,
    });
  }
  index.truncated = truncated;
  return index;
}

/**
 * Authoritative entry for one path.
 *
 * A complete recursive listing answers directly. A truncated one cannot, so the
 * literal path is walked instead, including directories enumeration skips.
 */
export async function resolveEntry(client, token, fullName, commitSha, alias, index) {
  if (index && !index.truncated) return index.get(alias) ?? null;
  return lookupPath(client, token, fullName, commitSha, alias);
}

function decodeBase64Strict(content, expectedSize) {
  const compact = String(content || '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw githubError(502, 'GITHUB_INVALID_BLOB', 'GitHub returned an undecodable blob.');
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw githubError(502, 'GITHUB_INVALID_BLOB', 'GitHub returned an undecodable blob.');
  }
  if (Number.isFinite(expectedSize) && bytes.byteLength !== expectedSize) {
    throw githubError(502, 'GITHUB_INVALID_BLOB', 'GitHub blob size did not match its contents.');
  }
  return bytes;
}

/**
 * Read one blob by SHA.
 *
 * The blob is addressed by content, never by a mutable branch path, so the bytes
 * cannot change between review and save.
 */
export async function readBlob(client, token, fullName, blobSha, options = {}) {
  const sha = validateCommitSha(blobSha, 'blob');
  const limit = options.maxBytes || MAX_SOURCE_BYTES;
  const { data } = await client.request(`/repos/${fullName}/git/blobs/${sha}`, {
    token,
    limit: Math.ceil(limit * 1.4) + 4096,
  });
  if (data?.encoding !== 'base64') {
    throw githubError(415, 'UNSUPPORTED_BLOB', 'Citadel UI cannot read this source encoding.');
  }
  const declared = Number(data.size);
  if (!Number.isFinite(declared) || declared < 0 || declared > limit) {
    throw githubError(413, 'SOURCE_TOO_LARGE', `Source exceeds the ${limit} byte limit.`);
  }
  const bytes = decodeBase64Strict(data.content, declared);
  const text = bytes.toString('utf8');
  if (!options.allowLfs && isLfsPointer(text)) {
    throw githubError(
      415,
      'LFS_POINTER',
      'This file is stored with Git LFS and cannot be edited by Citadel UI.'
    );
  }
  return { sha, bytes, text, size: bytes.byteLength, hash: await sha256(bytes) };
}

/**
 * Read one in-scope source blob.
 *
 * The alias is the authority: it passes the shared scope policy first, and the
 * blob SHA must match what the branch tree actually holds for that alias.
 */
export async function readSourceBlob(client, token, fullName, commitSha, alias, blobSha, tree, configuration = undefined) {
  const safe = workspaceScope(configuration).read(alias);
  const snapshot = tree || (await loadTree(client, token, fullName, commitSha, configuration));
  const entry = snapshot.files.find((file) => file.alias === safe);
  if (!entry) {
    throw githubError(404, 'SOURCE_NOT_FOUND', `Source not found: ${safe}`);
  }
  if (blobSha && entry.sha !== validateCommitSha(blobSha, 'blob')) {
    throw githubError(
      409,
      'STALE_SOURCE',
      'File changed outside Citadel UI. Reload before saving.'
    );
  }
  return readBlob(client, token, fullName, entry.sha);
}

/**
 * Resolve one exact path by walking tree objects segment by segment.
 *
 * Recursive enumeration can be truncated and its fallback skips directories
 * such as `.azure`, so only this literal lookup can establish their absence.
 */
export async function lookupPath(client, token, fullName, commitSha, path) {
  const segments = String(path || '').split('/').filter(Boolean);
  if (!segments.length) return null;
  let treeSha = await commitTreeSha(client, token, fullName, commitSha);
  for (let index = 0; index < segments.length; index += 1) {
    const { data } = await client.request(`/repos/${fullName}/git/trees/${treeSha}`, { token });
    const entry = (data?.tree || []).find((item) => item.path === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) {
      return {
        path,
        sha: entry.sha,
        mode: entry.mode,
        size: Number(entry.size) || 0,
        type: entry.type,
      };
    }
    if (entry.type !== 'tree') return null;
    treeSha = entry.sha;
  }
  return null;
}
