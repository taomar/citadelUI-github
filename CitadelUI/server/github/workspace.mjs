/**
 * GitHub workspace operations.
 *
 * Reads resolve a branch to an immutable commit, then address trees and blobs by
 * SHA so a concurrent push cannot change bytes underneath a review. Writes build
 * one blob/tree/commit/ref transaction per Citadel action and update the ref with
 * `force: false`, so a moved branch is rejected instead of overwritten.
 */
import { githubError, redactSecrets } from './api.mjs';
import {
  BLOB_MODE_EXECUTABLE,
  BLOB_MODE_FILE,
  filterSourceTree,
  isLfsPointer,
  MAX_TREE_ENTRIES,
  rescueBranchName,
  validateBranchName,
  validateCommitSha,
} from './repositories.mjs';
import {
  isSkippedDirectory,
  MAX_ENV_BYTES,
  MAX_SOURCE_BYTES,
  normalizeAlias,
  sha256,
  subscriptionEnvironmentAlias,
  SUBSCRIPTION_ENVIRONMENT_KEY,
} from '../../shared/source-scope.mjs';

const MAX_COMMIT_FILES = 64;
const MAX_HISTORY = 100;
/**
 * How far back to look for a change that already landed.
 *
 * Bounded because this walk is one request per commit and runs on a path that
 * is already handling a refusal. In practice it stops at the reviewed parent
 * long before this, because a branch that moved has moved by a few commits, not
 * by twenty.
 */
const MAX_RECONCILE_DEPTH = 20;
const TRAILER_ACTION = 'Citadel-Action';
const TRAILER_ENVIRONMENT = 'Citadel-Environment';
const TRAILER_TRANSACTION = 'Citadel-Transaction';
const ACTIONS = new Set([
  'parameter-edit',
  'policy-edit',
  'contract-create',
  'environment-copy',
  'history-restore',
  'subscription-edit',
  'history-undo',
]);

function encodePath(alias) {
  return alias.split('/').map(encodeURIComponent).join('/');
}

export function assertAction(value) {
  const action = String(value || '');
  if (!ACTIONS.has(action)) {
    throw githubError(400, 'INVALID_ACTION', 'Unsupported Citadel action.');
  }
  return action;
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
 * Create the Citadel working branch from the source branch when it is missing.
 * An existing branch is reused; it is never moved or reset.
 */
export async function ensureWorkingBranch(
  client,
  token,
  fullName,
  sourceBranch,
  workingBranch,
  options = {}
) {
  const working = validateBranchName(workingBranch);
  const existing = await branchHead(client, token, fullName, working);
  if (existing) {
    // `requireAbsent` makes reuse a decision rather than a side effect, and is
    // passed only for a name a *human typed*. A name Citadel derived embeds the
    // environment id, so a branch already standing there is this workspace's
    // own and adopting it is the whole point of respecting a working branch
    // across reopens. A name someone typed may be a colleague's.
    if (options.requireAbsent) {
      throw githubError(
        409,
        'BRANCH_EXISTS',
        `${working} already exists in this repository. Choose another name, or confirm that you want Citadel to use the existing branch.`,
        { branch: working, head: existing }
      );
    }
    return { branch: working, head: existing, created: false, adopted: true };
  }
  const base = await requireBranchHead(client, token, fullName, sourceBranch);
  const { data } = await client.request(`/repos/${fullName}/git/refs`, {
    token,
    method: 'POST',
    body: { ref: `refs/heads/${working}`, sha: base },
  });
  return {
    branch: working,
    head: validateCommitSha(data?.object?.sha || base),
    created: true,
    adopted: false,
  };
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
export async function loadTree(client, token, fullName, commitSha) {
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
  const { files, rejected } = filterSourceTree(entries);
  return { commit: commitSha, treeSha, files, rejected, truncated: Boolean(data?.truncated) };
}

/**
 * Raw path-to-blob index for one commit.
 *
 * History and undo must verify the exact files a Citadel commit wrote, and one
 * of those files -- `.azure/<environment>/.env` -- is deliberately outside the
 * browsable source scope. Enumeration filtering answers "what may the editor
 * show"; this answers "what does this commit actually contain", so identity
 * checks use it instead of the filtered listing.
 *
 * Only regular file blobs are indexed, so a symlink or submodule can never be
 * treated as restorable content.
 */
/**
 * Index every entry in a commit's tree by path.
 *
 * `complete` includes trees and submodules, not just regular blobs, because a
 * creation must be able to see *any* object already occupying its path. A
 * blob-only index would report a directory or submodule as absent and let a
 * create replace it.
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
 * literal path is walked instead — which is also the only way to see inside
 * directories the enumeration policy skips, such as `.azure`.
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
 * Apply the shared scope policy and report a violation as a client error.
 *
 * `normalizeAlias` throws a plain `Error`, which the server would sanitize into
 * a 500. A malformed or out-of-scope alias is a bad request, and the policy
 * message itself is safe to show, so it is mapped to a 400 here.
 */
function assertScopedAlias(alias) {
  try {
    return normalizeAlias(alias);
  } catch (error) {
    throw githubError(400, 'INVALID_ALIAS', error.message);
  }
}

/**
 * Read one in-scope source blob.
 *
 * The alias is the authority: it passes the shared scope policy first, and the
 * blob SHA must match what the branch tree actually holds for that alias. A
 * caller-supplied SHA on its own can therefore never reach a blob outside the
 * editable scope -- notably `.azure/<environment>/.env`, which `normalizeAlias`
 * rejects outright and which only the subscription bridge may read.
 */
export async function readSourceBlob(client, token, fullName, commitSha, alias, blobSha, tree) {
  const safe = assertScopedAlias(alias);
  const snapshot = tree || (await loadTree(client, token, fullName, commitSha));
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
 * Scope policy for a path Citadel UI intends to *write*.
 *
 * `normalizeAlias` alone is not enough: it accepts `.github/private.xml`,
 * because `.xml` is an editable extension and `.github` is not `.azure`.
 * Enumeration already hides skipped directories, so writes must apply the same
 * rule or the editor could commit to a path it can never show.
 */
export function assertWritableAlias(alias) {
  const safe = assertScopedAlias(alias);
  const blocked = safe.split('/').slice(0, -1).find(isSkippedDirectory);
  if (blocked) {
    throw githubError(400, 'INVALID_ALIAS', `Citadel UI does not edit sources under ${blocked}.`);
  }
  return safe;
}

/**
 * Resolve one exact path by walking tree objects segment by segment.
 *
 * A recursive tree can come back truncated, and the subtree walk used for
 * enumeration deliberately skips directories such as `.azure`. Neither is a safe
 * basis for concluding that a specific file is absent, so this walks the literal
 * path instead and is the only lookup allowed to answer "not present".
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

function trailerBlock(action, environmentId, transactionId) {
  return [
    '',
    `${TRAILER_ACTION}: ${action}`,
    `${TRAILER_ENVIRONMENT}: ${environmentId}`,
    `${TRAILER_TRANSACTION}: ${transactionId}`,
  ].join('\n');
}

export function parseTrailers(message) {
  const text = String(message || '');
  const read = (name) => {
    const match = new RegExp(`^${name}:[ \\t]*([^\\r\\n]{1,128})$`, 'm').exec(text);
    return match ? match[1].trim() : null;
  };
  return {
    action: read(TRAILER_ACTION),
    environmentId: read(TRAILER_ENVIRONMENT),
    transactionId: read(TRAILER_TRANSACTION),
  };
}

function summary(action, aliases) {
  const names = aliases.map((alias) => alias.split('/').at(-1));
  const shown = names.slice(0, 3).join(', ');
  const extra = names.length > 3 ? ` and ${names.length - 3} more` : '';
  return `Citadel ${action}: ${shown}${extra}`.slice(0, 200);
}

/**
 * Validate the browser's change set before any GitHub write happens.
 *
 * Each entry names an in-scope alias, the blob SHA and SHA-256 the user actually
 * reviewed, and the bytes to write.
 *
 * `.azure/<environment>/.env` is **not** reachable here. Subscription patching
 * is a server-internal capability that only `saveSubscriptionId` may use, and it
 * is granted by `options.subscriptionAlias`, never by a request field. A browser
 * cannot opt into it, so the generic endpoint can never replace or delete an
 * environment file.
 */
export function normalizeChangeSet(files, options = {}) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_COMMIT_FILES) {
    throw githubError(400, 'INVALID_CHANGE_SET', 'A change set of 1 to 64 files is required.');
  }
  const subscriptionAlias = options.subscriptionAlias || null;
  const seen = new Set();
  return files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw githubError(400, 'INVALID_CHANGE_SET', 'Invalid file entry.');
    }
    if (file.subscription !== undefined) {
      throw githubError(
        403,
        'SUBSCRIPTION_NOT_ALLOWED',
        'Environment files are edited only through the subscription setting.'
      );
    }
    const requested = String(file.alias || '');
    const subscription = Boolean(subscriptionAlias) && requested === subscriptionAlias;
    const alias = subscription ? subscriptionAlias : assertWritableAlias(requested);
    if (seen.has(alias)) {
      throw githubError(400, 'INVALID_CHANGE_SET', `Duplicate file in change set: ${alias}`);
    }
    seen.add(alias);
    const remove = Boolean(file.remove);
    const create = Boolean(file.create);
    if (remove && create) {
      throw githubError(400, 'INVALID_CHANGE_SET', 'A file cannot be created and removed.');
    }
    let after = null;
    if (!remove) {
      if (typeof file.after !== 'string') {
        throw githubError(400, 'INVALID_CHANGE_SET', 'Base64 file content is required.');
      }
      const limit = subscription ? MAX_ENV_BYTES : MAX_SOURCE_BYTES;
      after = decodeBase64Strict(file.after, undefined);
      if (after.byteLength > limit) {
        throw githubError(413, 'SOURCE_TOO_LARGE', `Source exceeds the ${limit} byte limit.`);
      }
    }
    if (!create) {
      // An update or delete must name the exact revision the user reviewed, so
      // the precondition can be bound to this path rather than to any blob.
      if (typeof file.blobSha !== 'string') {
        throw githubError(400, 'INVALID_CHANGE_SET', 'A reviewed blob SHA is required.');
      }
      if (typeof file.beforeHash !== 'string' || !/^[0-9a-f]{64}$/.test(file.beforeHash)) {
        throw githubError(400, 'INVALID_CHANGE_SET', 'A reviewed content hash is required.');
      }
      if (file.mode !== BLOB_MODE_FILE && file.mode !== BLOB_MODE_EXECUTABLE) {
        throw githubError(
          400,
          'INVALID_CHANGE_SET',
          'A reviewed file mode is required for an update or deletion.'
        );
      }
    } else if (
      file.mode !== undefined &&
      file.mode !== BLOB_MODE_FILE &&
      file.mode !== BLOB_MODE_EXECUTABLE
    ) {
      throw githubError(400, 'INVALID_CHANGE_SET', 'Unsupported file mode.');
    }
    return {
      alias,
      create,
      remove,
      subscription,
      blobSha: create ? null : validateCommitSha(file.blobSha, 'blob'),
      beforeHash: create ? null : file.beforeHash,
      // On an update this is a *precondition* only. The mode actually written
      // comes from the authoritative current entry, never from the request.
      expectedMode: create ? null : String(file.mode),
      createMode: create && file.mode ? String(file.mode) : BLOB_MODE_FILE,
      after,
    };
  });
}

/**
 * Apply one change set as a single commit.
 *
 * Preconditions are bound to the exact target path, not merely to a blob the
 * caller supplied: the base tree is indexed once, a creation must find its path
 * absent, and an update or delete must find the reviewed SHA and content hash at
 * that path with a supported mode. The existing mode is carried forward so an
 * executable file does not silently become non-executable.
 *
 * The ref update is non-forced, so a losing race leaves the branch untouched and
 * only unreferenced objects behind.
 */
/**
 * Decide what really happened when a ref update did not answer.
 *
 * A `PATCH` that fails in transport may still have been applied. Three outcomes
 * are possible and only one of them is a failure:
 *
 *   - the commit is the branch head, or an ancestor of it: applied;
 *   - the branch is readable and the commit is provably not reachable: not
 *     applied, and safe to report as such;
 *   - the branch cannot be read either: indeterminate. Reporting "not applied"
 *     here would invite a retry that duplicates a commit that already landed, so
 *     the commit SHA is handed back and the caller is told to refresh instead.
 *
 * Returns normally when the change is applied; throws otherwise.
 */
async function reconcileAmbiguousRefUpdate(client, token, options) {
  const { fullName, branch, commitSha, cause } = options;
  let head;
  try {
    head = await requireBranchHead(client, token, fullName, branch);
  } catch (lookupError) {
    throw githubError(
      503,
      'INDETERMINATE_SAVE',
      `Citadel UI could not confirm whether commit ${commitSha} was applied to ${branch}: ${redactSecrets(
        lookupError.message
      )} Reload the environment before saving again; retrying now could duplicate the change.`,
      { commit: commitSha, branch, indeterminate: true }
    );
  }
  if (head === commitSha) return { applied: true, head };
  // The reachability probe is a second network call and can fail exactly like
  // the head read did. Letting it throw raw would report a fourth, unnamed
  // outcome as an ordinary failure — with no commit SHA and no warning — even
  // though the commit may well already be an ancestor of `head`.
  let reachable;
  try {
    reachable = await isReachable(client, token, fullName, branch, commitSha);
  } catch (reachError) {
    throw githubError(
      503,
      'INDETERMINATE_SAVE',
      `Citadel UI could not confirm whether commit ${commitSha} was applied to ${branch}: ${redactSecrets(
        reachError.message
      )} Reload the environment before saving again; retrying now could duplicate the change.`,
      { commit: commitSha, branch, indeterminate: true }
    );
  }
  if (reachable) {
    // Applied, and someone has already built on it.
    return { applied: true, head };
  }
  throw githubError(
    502,
    'SAVE_NOT_APPLIED',
    `The branch update did not complete: ${redactSecrets(
      cause.message
    )} Your edits were not applied; review and save again.`
  );
}

/**
 * Is this change already on the branch?
 *
 * ## The defect this exists to fix
 *
 * A refused ref update was treated as proof that the change was absent, and the
 * commit was given a rescue branch. Those are different facts. A user
 * double-clicked Save; both invocations built a commit from the same reviewed
 * parent with the same content; the first won the ref and the second was
 * refused with 422. The branch head's tree was byte-identical to the tree of the
 * commit being "rescued", so the honest answer was *your change is already
 * saved* and the correct number of new branches was zero. Instead the user got
 * two branches for one action.
 *
 * ## Why the tree SHA is the right question
 *
 * A Git tree SHA is a content hash of the entire tree. If the branch holds a
 * commit whose tree equals ours, the repository already contains exactly the
 * state this save intended to produce — whether this save put it there, a
 * retry did, or a collaborator made the identical change. In every one of those
 * cases a rescue branch is noise, and telling the user their work went
 * somewhere else would be false.
 *
 * ## Bounds
 *
 * The walk follows first parents only, stops at the reviewed parent — beyond
 * that point the content predates the save and cannot be it — and is capped at
 * `MAX_RECONCILE_DEPTH` commits. `baseCommit` itself is never a match: it is
 * the state the user was editing *away* from.
 *
 * Returns the matching commit SHA, or null. Never throws: an unreadable history
 * means "cannot prove it is already there", which falls through to the rescue
 * that was going to happen anyway.
 */
export async function findAppliedCommit(client, token, options) {
  const { fullName, branch, treeSha, baseCommit } = options;
  const depth = options.depth || MAX_RECONCILE_DEPTH;
  if (!treeSha) return null;
  try {
    let cursor = await branchHead(client, token, fullName, branch);
    const seen = new Set();
    for (let step = 0; step < depth && cursor; step += 1) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      // The reviewed parent bounds the search. Anything at or below it is the
      // state that existed before this save, so it cannot be this save.
      if (baseCommit && cursor === baseCommit) return null;
      const { data } = await client.request(
        `/repos/${fullName}/git/commits/${validateCommitSha(cursor)}`,
        { token }
      );
      if (data?.tree?.sha === treeSha) return cursor;
      const parents = Array.isArray(data?.parents) ? data.parents : [];
      const next = parents[0]?.sha;
      cursor = next ? validateCommitSha(next) : null;
    }
  } catch {
    // Unprovable, not disproven. The caller rescues, which is safe.
    return null;
  }
  return null;
}

/**
 * Give a commit a branch of its own — only when the user asks for it.
 *
 * ## A deliberate reversal
 *
 * This used to happen automatically. When a branch refused a commit, Citadel
 * created `citadel-ui/<environmentId>-save-<commit12>` and told the user where
 * the work went. That was a real improvement on what came before it, which was
 * to report durable work as lost and advise a reload that would destroy it.
 *
 * It was still wrong. A user found three branches in their repository that they
 * had never asked for. Creating a ref is a change to someone's repository, and
 * the commit is reachable by SHA with no branch pointing at it — so nothing is
 * lost while we ask. Asking is strictly better than acting, and it is what the
 * user wants. The refusal path now returns a decision and creates nothing; this
 * runs only once the user has answered it with a name.
 *
 * Two controls, because this takes a commit SHA from a browser:
 *
 *   - The commit must be one this environment's own saves produced, proven by
 *     the audit. Unconstrained, this endpoint would be "create a ref at any
 *     object in this repository".
 *   - The name goes through the same validation as any branch the user types,
 *     so this path cannot smuggle in a name the attach flow would refuse.
 *
 * Create-only, as ever. A user asking for a branch is not permission to move
 * one that already exists.
 */
export async function createCommitBranch(client, token, options) {
  const { fullName, commitSha, branch, audit, environmentId, repositoryId } = options;
  const sha = validateCommitSha(commitSha);
  const name = validateBranchName(branch);

  // Attribution first: the audit is what makes "where did this branch come
  // from" answerable inside the product, and it is also what stops this being a
  // way to name arbitrary objects.
  const record = audit
    ? await audit.find({ commit: sha, environmentId, repositoryId, branch: options.intendedBranch })
    : null;
  if (!record) {
    throw githubError(
      403,
      'COMMIT_NOT_ATTRIBUTED',
      'Citadel can only branch a commit it made for this workspace.'
    );
  }

  try {
    await client.request(`/repos/${fullName}/git/refs`, {
      token,
      method: 'POST',
      body: { ref: `refs/heads/${name}`, sha },
    });
  } catch (error) {
    if (error.status === 422) {
      // Already there. Either this exact request was retried and its answer was
      // lost, or the name is taken. Both are answered the same way: nothing was
      // moved, and the user is told rather than having a branch reassigned.
      const existing = await branchHead(client, token, fullName, name).catch(() => null);
      if (existing === sha) return { branch: name, commit: sha, created: false };
      throw githubError(
        409,
        'BRANCH_EXISTS',
        `${name} already exists and points somewhere else. Choose another name.`
      );
    }
    throw githubError(
      503,
      'BRANCH_NOT_CREATED',
      `Your change is committed as ${sha} and is not lost, but Citadel could not create ${name}: ${redactSecrets(
        error.message
      )} Try again, or use a different name.`,
      { commit: sha, branch: name }
    );
  }

  if (audit) {
    // Best effort: the ref exists now, and a log failure must not be reported as
    // a failure to create it.
    try {
      await audit.record({ ...record, branch: name, commit: sha });
    } catch {
      return { branch: name, commit: sha, created: true, unlogged: true };
    }
  }
  return { branch: name, commit: sha, created: true };
}

export async function commitChangeSet(client, token, options) {
  const {
    fullName,
    branch,
    expectedHead,
    files,
    action,
    environmentId,
    transactionId,
    authorName,
    subscriptionAlias,
    audit,
  } = options;
  const changes = normalizeChangeSet(files, { subscriptionAlias });
  if (!expectedHead) {
    throw githubError(
      400,
      'EXPECTED_HEAD_REQUIRED',
      'A reviewed branch head is required before saving.'
    );
  }
  const head = await requireBranchHead(client, token, fullName, branch);
  if (head !== validateCommitSha(expectedHead)) {
    throw githubError(
      409,
      'STALE_WORKSPACE',
      'The branch moved after you reviewed these changes. Reload before saving.'
    );
  }
  const baseTree = await commitTreeSha(client, token, fullName, head);
  const baseIndex = await treeIndex(client, token, fullName, head, { complete: true });

  for (const change of changes) {
    // Authoritative per-path resolution: a truncated listing, or the skip policy
    // used to walk one, must never let an existing path look absent.
    const entry = await resolveEntry(client, token, fullName, head, change.alias, baseIndex);
    if (change.create) {
      if (entry) {
        throw githubError(
          409,
          'SOURCE_EXISTS',
          `Something already exists at ${change.alias}. Reload before saving.`
        );
      }
      continue;
    }
    if (!entry) {
      throw githubError(
        409,
        'STALE_SOURCE',
        `No source exists at ${change.alias}. Reload before saving.`
      );
    }
    if (
      entry.type !== 'blob' ||
      (entry.mode !== BLOB_MODE_FILE && entry.mode !== BLOB_MODE_EXECUTABLE)
    ) {
      throw githubError(
        415,
        'UNSUPPORTED_MODE',
        `Citadel UI cannot edit ${change.alias}; it is not a regular file.`
      );
    }
    if (entry.sha !== change.blobSha) {
      throw githubError(
        409,
        'STALE_SOURCE',
        'File changed outside Citadel UI. Reload before saving.'
      );
    }
    // The reviewed mode is part of the precondition, so a collaborator toggling
    // the executable bit is a conflict rather than a silent overwrite.
    if (entry.mode !== change.expectedMode) {
      throw githubError(
        409,
        'STALE_SOURCE',
        `The file mode of ${change.alias} changed outside Citadel UI. Reload before saving.`
      );
    }
    const current = await readBlob(client, token, fullName, entry.sha, {
      maxBytes: change.subscription ? MAX_ENV_BYTES : MAX_SOURCE_BYTES,
      allowLfs: change.subscription,
    });
    if (current.hash !== change.beforeHash) {
      throw githubError(
        409,
        'STALE_SOURCE',
        'File changed outside Citadel UI. Reload before saving.'
      );
    }
    change.currentMode = entry.mode;
  }

  const tree = [];
  for (const change of changes) {
    // Authoritative: an update keeps the mode the repository actually has, so a
    // request can never flip the executable bit as a side effect of an edit.
    const mode = change.create ? change.createMode : change.currentMode;
    if (change.remove) {
      tree.push({ path: change.alias, mode, type: 'blob', sha: null });
      continue;
    }
    const { data } = await client.request(`/repos/${fullName}/git/blobs`, {
      token,
      method: 'POST',
      body: { content: change.after.toString('base64'), encoding: 'base64' },
    });
    tree.push({
      path: change.alias,
      mode,
      type: 'blob',
      sha: validateCommitSha(data?.sha, 'blob'),
    });
  }

  const { data: created } = await client.request(`/repos/${fullName}/git/trees`, {
    token,
    method: 'POST',
    body: { base_tree: baseTree, tree },
  });
  const treeSha = validateCommitSha(created?.sha, 'tree');

  const { data: commit } = await client.request(`/repos/${fullName}/git/commits`, {
    token,
    method: 'POST',
    body: {
      message: `${summary(action, changes.map((change) => change.alias))}\n${trailerBlock(
        action,
        environmentId,
        transactionId
      )}`,
      tree: treeSha,
      parents: [head],
    },
  });
  const commitSha = validateCommitSha(commit?.sha);
  const record = {
    repositoryId: options.repositoryId ?? null,
    fullName,
    environmentId,
    branch,
    action,
    transactionId,
    baseCommit: head,
    commit: commitSha,
    aliases: changes.map((change) => change.alias),
  };

  // The audit is written before the ref moves, and a failure aborts the save.
  //
  // Advancing the ref anyway would land a commit that History cannot list and
  // Undo must refuse — a change the user can see in Git but not manage here. The
  // commit object created above simply stays unreferenced, which Git collects,
  // and the branch is untouched, so a retry is safe rather than duplicating.
  //
  // The converse is harmless: a record for a ref update that then fails refers
  // to a commit that is not reachable from the branch, and both History and
  // Undo independently require reachability.
  if (audit) {
    try {
      await audit.record(record);
    } catch (error) {
      throw githubError(
        503,
        'AUDIT_UNAVAILABLE',
        `Your change was not applied because the change log could not be written: ${redactSecrets(
          error.message
        )} Nothing was committed; retry once the Citadel data directory is writable.`
      );
    }
  }
  const warnings = [];
  let unresolved = null;
  let alreadyApplied = null;

  try {
    await client.request(`/repos/${fullName}/git/refs/heads/${encodePath(branch)}`, {
      token,
      method: 'PATCH',
      body: { sha: commitSha, force: false },
    });
  } catch (error) {
    if (error.status === 422 || error.status === 403 || error.status === 409) {
      // The branch will not take this commit — it moved, or it is protected.
      //
      // That is not a failed save. The blob, the tree, the commit with the
      // reviewed parent and the audit record all exist by now; only the ref
      // update was refused. Reporting "your edits were not applied" would be
      // false, and telling the user to reload would destroy work that is
      // already durable in the repository.
      //
      // But "the ref would not move" is not the same fact as "the change is
      // not there". Ask the branch first: if it already holds a commit with
      // this exact tree, this save has landed, and the right number of new
      // branches is zero. Skipping this question is what turned one
      // double-clicked save into two branches holding an identical tree.
      alreadyApplied = await findAppliedCommit(client, token, {
        fullName,
        branch,
        treeSha,
        baseCommit: head,
      });
      if (alreadyApplied) {
        // Idempotent success. No ref is created and no second audit record is
        // written: the commit that is really on the branch already has one, and
        // logging this attempt again would count one user action twice.
        warnings.push(
          `This change was already on ${branch} as ${alreadyApplied.slice(0, 12)}, so Citadel did not save it a second time.`
        );
      } else {
        // Genuinely absent, and this is where Citadel used to create a branch
        // nobody asked for. It no longer does. The commit is real and reachable
        // by SHA with no ref pointing at it, so nothing is lost while the user
        // is asked what they want done with it — and asking is the only way to
        // keep the promise that Citadel creates no ref the user did not request.
        unresolved = {
          kind: error.status === 422 ? 'branch-moved' : 'branch-protected',
          commit: commitSha,
          intendedBranch: branch,
          baseCommit: head,
          reason:
            error.status === 422
              ? `${branch} moved while you were saving, so it would not accept this change.`
              : `${redactSecrets(error.message)}`,
          // Offered as a starting point for the name field. Nothing is created
          // from it unless the user accepts or replaces it.
          suggestedBranch: rescueBranchName(environmentId, commitSha),
        };
      }
    } else {
      // Anything else — a transport failure, a timeout, a 5xx — means the update
      // may have been applied before the answer was lost. Saying "not applied"
      // would invite a retry that duplicates a commit that already landed, so the
      // branch is asked what actually happened.
      await reconcileAmbiguousRefUpdate(client, token, {
        fullName,
        branch,
        commitSha,
        cause: error,
      });
      warnings.push(
        `The branch confirmed your change, but the update itself did not answer: ${redactSecrets(
          error.message
        )}`
      );
    }
  }

  // Past this line the commit is durably in the repository — on `branch`, or as
  // an unreferenced object the user is about to be asked about. Nothing below
  // may throw: reporting a failure for work that already landed would invite the
  // user to re-apply it, and a retry would duplicate the commit.
  const result = {
    transactionId,
    // When the change was already there, the commit the user should be given is
    // the one the branch actually holds. Ours is a real object but nothing
    // references it, so History would never list it and Undo would refuse it.
    commit: alreadyApplied || commitSha,
    baseCommit: head,
    // Always the branch this save aimed at. No ref was created, so there is no
    // other branch to name.
    branch,
    author: authorName || null,
    files: tree.map((entry) => ({ alias: entry.path, sha: entry.sha, mode: entry.mode })),
    warnings,
    ...(alreadyApplied ? { alreadyApplied: true, duplicateCommit: commitSha } : {}),
    ...(unresolved ? { unresolved, applied: false } : {}),
  };
  if (unresolved) {
    // The branch is untouched and nothing was created. What the user needs is
    // the decision, not a re-read of a head that did not move.
    return result;
  }
  try {
    const finalHead = await requireBranchHead(client, token, fullName, branch);
    // Compared against the commit this save is *reported* as, not against the
    // object we happened to build. When the change was already applied those
    // differ, and comparing the wrong one would report "someone moved the
    // branch" about a branch sitting exactly where it should be.
    if (finalHead !== result.commit) {
      // Someone else fast-forwarding immediately afterwards is normal
      // collaboration, not a failed save.
      result.movedAfterSave = true;
      result.head = finalHead;
    }
  } catch (error) {
    result.headUnknown = true;
    warnings.push(
      `Your change was committed, but the branch could not be re-read: ${redactSecrets(error.message)}`
    );
  }
  return result;
}

/**
 * Citadel-authored commits on the working branch, newest first.
 *
 * Shaped for the History UI: each entry carries the identifiers the inspect and
 * undo actions need, a status, changed aliases, and a timestamp. A commit is
 * only listed when the server's own audit record proves Citadel UI created it,
 * so forged trailers cannot inject entries.
 */
export async function loadHistory(client, token, fullName, branch, environmentId, options = {}) {
  const ref = validateBranchName(branch);
  const audit = options.audit || null;
  const audited = audit ? await audit.listForEnvironment(environmentId, ref) : [];
  const auditedByCommit = new Map(audited.map((item) => [item.commit, item]));
  const { data } = await client.request(
    `/repos/${fullName}/commits?sha=${encodeURIComponent(ref)}&per_page=100`,
    { token }
  );
  const commits = Array.isArray(data) ? data : [];
  const head = commits[0]?.sha || null;
  return commits
    .map((entry) => {
      const trailers = parseTrailers(entry?.commit?.message);
      const record = auditedByCommit.get(entry.sha) || null;
      if (!record) return null;
      if (trailers.environmentId && trailers.environmentId !== environmentId) return null;
      const parents = (entry.parents || []).map((parent) => parent.sha);
      return {
        // Identifiers the History panel uses for inspect and undo.
        transactionId: record.transactionId,
        id: entry.sha,
        commit: entry.sha,
        parent: parents[0] || null,
        parents,
        // UI contract fields.
        status: 'committed',
        targetLabel: record.action,
        action: record.action,
        aliases: record.aliases,
        files: record.aliases.map((item) => ({ alias: item })),
        author: entry.commit?.author?.name || null,
        committedAt: entry.commit?.author?.date || null,
        completedAt: entry.commit?.author?.date || null,
        subject: String(entry.commit?.message || '').split('\n')[0].slice(0, 200),
        // Undo is offered only for an audited single-parent commit.
        canUndo: parents.length === 1,
        isHead: entry.sha === head,
      };
    })
    .filter(Boolean)
    .slice(0, MAX_HISTORY);
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

/**
 * Describe the files one Citadel commit changed, and whether the branch still
 * holds exactly the bytes that commit produced.
 */
export async function inspectCommit(client, token, fullName, branch, commitSha, options = {}) {
  const sha = validateCommitSha(commitSha);
  const { data } = await client.request(`/repos/${fullName}/commits/${sha}`, { token });
  const parents = (data?.parents || []).map((parent) => parent.sha);
  const parent = parents[0] || null;
  const head = await requireBranchHead(client, token, fullName, branch);
  const current = await treeIndex(client, token, fullName, head, { complete: true });
  // The commit's own tree carries the mode it produced. The compare payload does
  // not, so without this a collaborator toggling only the executable bit would
  // look unchanged and undo would silently discard their edit.
  const produced = await treeIndex(client, token, fullName, sha, { complete: true });
  const files = [];
  for (const file of data?.files || []) {
    const alias = file.filename;
    const finalSha = file.sha || null;
    // Both lookups resolve exactly: a truncated listing must not leave the mode
    // unknown on either side, because an unknown mode reads as a change and
    // would refuse a legitimate undo.
    const finalEntry =
      (await resolveEntry(client, token, fullName, sha, alias, produced)) || null;
    const entry =
      (await resolveEntry(client, token, fullName, head, alias, current)) || null;
    const currentSha = entry?.sha || null;
    const currentMode = entry?.mode || null;
    const finalMode = finalEntry?.mode || null;
    files.push({
      alias,
      status: file.status,
      finalSha,
      finalMode,
      currentSha,
      currentMode,
      state:
        file.status === 'removed'
          ? currentSha
            ? 'unexpected'
            : 'final'
          : currentSha === finalSha && currentMode === finalMode
            ? 'final'
            : 'unexpected',
    });
  }
  const record = options.record ?? null;
  const singleParent = parents.length === 1;
  return {
    commit: sha,
    parent,
    parents,
    head,
    trailers: parseTrailers(data?.commit?.message),
    audited: Boolean(record),
    action: record?.action || null,
    files,
    canRevert:
      Boolean(record) &&
      singleParent &&
      files.length > 0 &&
      files.every((file) => file.state === 'final'),
  };
}

/**
 * Undo a Citadel commit by creating an inverse commit.
 *
 * Three things must hold before anything is written: the server's own audit
 * record must prove Citadel UI created this commit for this environment,
 * repository, and branch; the commit must have exactly one parent so the inverse
 * is well defined; and it must be reachable from the selected working branch so
 * a commit from an unrelated branch cannot be replayed here.
 *
 * The branch is never reset or force-updated. If later edits touched any file
 * this commit produced, the undo is refused rather than overwriting them.
 */
export async function revertCommit(client, token, options) {
  const { fullName, branch, commitSha, environmentId, transactionId, repositoryId, audit } =
    options;
  if (!audit) {
    throw githubError(500, 'AUDIT_UNAVAILABLE', 'Undo requires the Citadel commit audit.');
  }
  const record = await audit.find({
    commit: validateCommitSha(commitSha),
    repositoryId,
    environmentId,
    branch,
  });
  if (!record) {
    // Commit trailers live inside the repository and anyone with push access can
    // forge them, so they are never sufficient authority for a destructive undo.
    throw githubError(
      403,
      'UNAUDITED_COMMIT',
      'Citadel UI has no record of creating that commit for this environment.'
    );
  }
  if (!(await isReachable(client, token, fullName, branch, commitSha))) {
    throw githubError(
      409,
      'UNREACHABLE_COMMIT',
      'That commit is not on the selected working branch.'
    );
  }
  const inspection = await inspectCommit(client, token, fullName, branch, commitSha, { record });
  if (inspection.parents.length !== 1) {
    throw githubError(
      409,
      'NOT_SINGLE_PARENT',
      'Only a single-parent Citadel commit can be undone.'
    );
  }
  if (!inspection.canRevert) {
    throw githubError(
      409,
      'STALE_SOURCE',
      'Files from this change were modified afterwards. Undo was refused.'
    );
  }

  const files = [];
  // Loaded once: every restored file comes from the same parent revision.
  const parentIndex = await treeIndex(client, token, fullName, inspection.parent, {
    complete: true,
  });
  let subscriptionAlias = null;
  for (const file of inspection.files) {
    const subscription = /^\.azure\/[^/]+\/\.env$/.test(file.alias);
    if (subscription) subscriptionAlias = file.alias;
    // Exact resolution: a truncated parent listing, or the skip policy used to
    // walk one, must not make the environment file look absent and turn a
    // restore into a deletion.
    const original = await resolveEntry(
      client,
      token,
      fullName,
      inspection.parent,
      file.alias,
      parentIndex
    );

    if (file.status === 'added') {
      // The commit created it, so undo deletes it, bound to the reviewed blob
      // and the mode currently on the branch.
      const blob = await readBlob(client, token, fullName, file.finalSha, {
        maxBytes: subscription ? MAX_ENV_BYTES : MAX_SOURCE_BYTES,
        allowLfs: subscription,
      });
      files.push({
        alias: file.alias,
        remove: true,
        blobSha: file.finalSha,
        beforeHash: blob.hash,
        mode: file.currentMode,
      });
      continue;
    }

    if (!original || original.type !== 'blob') {
      // The commit deleted it. Undo restores it as a checked creation from the
      // parent revision; `sha: null` is not a blob and must never be sent as a
      // reviewed blob SHA.
      throw githubError(
        409,
        'MISSING_PARENT_SOURCE',
        `The parent revision has no content for ${file.alias}.`
      );
    }

    const restored = await readBlob(client, token, fullName, original.sha, {
      maxBytes: subscription ? MAX_ENV_BYTES : MAX_SOURCE_BYTES,
      allowLfs: subscription,
    });

    if (file.status === 'removed') {
      files.push({
        alias: file.alias,
        create: true,
        after: restored.bytes.toString('base64'),
        // The parent's mode is what the file had before deletion.
        mode: original.mode,
      });
      continue;
    }

    const currentBlob = await readBlob(client, token, fullName, file.finalSha, {
      maxBytes: subscription ? MAX_ENV_BYTES : MAX_SOURCE_BYTES,
      allowLfs: subscription,
    });
    files.push({
      alias: file.alias,
      blobSha: file.finalSha,
      beforeHash: currentBlob.hash,
      after: restored.bytes.toString('base64'),
      // Precondition against what is on the branch now; the write keeps it.
      mode: file.currentMode,
    });
  }

  return commitChangeSet(client, token, {
    fullName,
    branch,
    expectedHead: inspection.head,
    files,
    action: 'history-undo',
    environmentId,
    transactionId,
    repositoryId,
    audit,
    // Undo may legitimately restore the environment file the subscription
    // bridge previously wrote, and only for that exact path.
    subscriptionAlias,
  });
}

/**
 * Subscription environment bridge.
 *
 * Only `AZURE_SUBSCRIPTION_ID` and source-version metadata ever leave the
 * server. The rest of the file is never returned, logged, or cached.
 *
 * The lookup walks the literal path rather than a recursive listing: a truncated
 * tree, or the enumeration skip policy that deliberately hides `.azure`, would
 * otherwise make an existing secret-bearing file look absent and invite the
 * caller to create over it.
 */
export async function readSubscriptionId(client, token, fullName, commitSha, environmentName, readers) {
  const alias = subscriptionEnvironmentAlias(environmentName);
  const entry = await lookupPath(client, token, fullName, commitSha, alias);
  if (!entry) {
    return {
      available: false,
      configured: false,
      environmentName,
      source: alias,
      value: '',
      valid: false,
      hash: null,
      blobSha: null,
    };
  }
  if (entry.type !== 'blob' || (entry.mode !== BLOB_MODE_FILE && entry.mode !== BLOB_MODE_EXECUTABLE)) {
    // A symlink, submodule, or directory at this path is never replaced: doing
    // so could destroy something Citadel UI does not understand.
    throw githubError(
      415,
      'UNSUPPORTED_ENV_ENTRY',
      'The azd environment path is not a regular file. Citadel UI will not modify it.'
    );
  }
  if (Number(entry.size) > MAX_ENV_BYTES) {
    throw githubError(413, 'ENV_TOO_LARGE', 'The azd environment file exceeds the 1 MiB safety limit.');
  }
  const blob = await readBlob(client, token, fullName, entry.sha, {
    maxBytes: MAX_ENV_BYTES,
    allowLfs: true,
  });
  const parsed = readers.readSubscriptionIdFromText(blob.text);
  return {
    available: true,
    configured: parsed.found,
    environmentName,
    source: alias,
    value: parsed.value,
    valid: parsed.valid,
    hash: blob.hash,
    blobSha: blob.sha,
    mode: entry.mode,
    key: SUBSCRIPTION_ENVIRONMENT_KEY,
  };
}
