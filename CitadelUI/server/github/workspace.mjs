/**
 * GitHub workspace operations.
 *
 * Reads resolve a branch to an immutable commit, then address trees and blobs by
 * SHA so a concurrent push cannot change bytes underneath a review. Writes build
 * one blob/tree/commit/ref transaction per Citadel action and update the ref with
 * `force: false`, so a moved branch is rejected instead of overwritten.
 */
import { githubError, redactSecrets } from './api.mjs';
import { workspaceScope } from '../../shared/workspace-configuration.mjs';
import {
  BLOB_MODE_EXECUTABLE,
  BLOB_MODE_FILE,
  rescueBranchName,
  validateBranchName,
  validateCommitSha,
} from './repositories.mjs';
import {
  isSkippedDirectory,
  MAX_ENV_BYTES,
  MAX_SOURCE_BYTES,
  MAX_COMMIT_FILES,
  normalizeAlias,
  subscriptionEnvironmentAlias,
  SUBSCRIPTION_ENVIRONMENT_KEY,
} from '../../shared/source-scope.mjs';
import { assertGitHubRequestBudget } from '../../shared/github-request-budget.mjs';
import { branchHead, encodePath, lookupPath, readBlob, requireBranchHead, resolveEntry, treeIndex } from './git-reader.mjs';

export { branchHead, requireBranchHead, loadTree, treeIndex, resolveEntry, readBlob, readSourceBlob, lookupPath } from './git-reader.mjs';

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

export function assertAction(value) {
  const action = String(value || '');
  if (!ACTIONS.has(action)) {
    throw githubError(400, 'INVALID_ACTION', 'Unsupported Citadel action.');
  }
  return action;
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

// Keep mutation base resolution local rather than exposing reader internals.
async function commitTreeSha(client, token, fullName, commitSha) {
  const { data } = await client.request(
    `/repos/${fullName}/git/commits/${validateCommitSha(commitSha)}`,
    { token }
  );
  const tree = data?.tree?.sha;
  if (!tree) throw githubError(502, 'GITHUB_INVALID_RESPONSE', 'GitHub returned no tree for the commit.');
  return validateCommitSha(tree, 'tree');
}

// Browser payload admission stays separate from the reader's private decoder.
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
 * Scope policy for a path Citadel UI intends to *write*.
 *
 * `normalizeAlias` alone is not enough: it accepts `.github/private.xml`,
 * because `.xml` is an editable extension and `.github` is not `.azure`.
 * Enumeration already hides skipped directories, so writes must apply the same
 * rule or the editor could commit to a path it can never show.
 */
export function assertWritableAlias(alias, configuration = undefined) {
  const safe = workspaceScope(configuration).write(alias);
  const blocked = safe.split('/').slice(0, -1).find(isSkippedDirectory);
  if (blocked) {
    throw githubError(400, 'INVALID_ALIAS', `Citadel UI does not edit sources under ${blocked}.`);
  }
  return safe;
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
  if (options.requestBudget !== false) assertGitHubRequestBudget(options.requestBody || { files });
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
    const alias = subscription ? subscriptionAlias : assertWritableAlias(requested, options.configuration);
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
 * Distinguish an audited applied retry from current content equivalence.
 *
 * A reachable audited commit from the reviewed parent proves the save happened,
 * even when collaborators subsequently moved the branch. An unaudited matching
 * ancestor proves neither authorship nor current content: it may be reverted.
 * Only the current matching tree can complete such an intent as a no-op.
 *
 * The first-parent walk stops before the reviewed parent and is bounded. Read
 * failures propagate so callers retain an explicitly indeterminate outcome.
 */
export async function findAppliedCommit(client, token, options) {
  const { fullName, branch, treeSha, baseCommit, audit, environmentId, repositoryId } = options;
  const depth = options.depth || MAX_RECONCILE_DEPTH;
  if (!treeSha) return null;
  const attributed = async (commit, data) => {
    const record = audit ? await audit.find({ commit, repositoryId, environmentId, branch }) : null;
    if (!record || record.fullName !== fullName || record.baseCommit !== baseCommit ||
        (record.configurationKey || null) !== (options.configurationKey || null)) return null;
    return { kind: 'applied', commit, record, author: data?.author?.name || null };
  };
  const initialHead = await branchHead(client, token, fullName, branch);
  let cursor = initialHead, equivalent = null;
  const seen = new Set();
  for (let step = 0; step < depth && cursor; step += 1) {
    if (seen.has(cursor) || cursor === baseCommit) break;
    seen.add(cursor);
    const { data } = await client.request(
      `/repos/${fullName}/git/commits/${validateCommitSha(cursor)}`, { token }
    );
    if (data?.tree?.sha === treeSha) {
      const applied = await attributed(cursor, data);
      if (applied) return applied;
      if (cursor === initialHead) equivalent = { kind: 'equivalent', head: cursor };
    }
    const next = Array.isArray(data?.parents) ? data.parents[0]?.sha : null;
    cursor = next ? validateCommitSha(next) : null;
  }
  if (!equivalent) return null;
  const latest = await branchHead(client, token, fullName, branch);
  if (latest === initialHead) return equivalent;
  if (!latest || latest === baseCommit) return null;
  const { data } = await client.request(`/repos/${fullName}/git/commits/${validateCommitSha(latest)}`, { token });
  if (data?.tree?.sha !== treeSha) return null;
  return await attributed(latest, data) || { kind: 'equivalent', head: latest };
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
  if (options.configuration?.format === 'terraform' || record.configurationKey) {
    const { assertNativeAuditScope, assertNativeHistoryBytes } = await import('./native-workspace.mjs');
    assertNativeAuditScope(record, options.configuration);
    await assertNativeHistoryBytes(client, token, fullName, sha, options.configuration, record.aliases);
    await assertNativeHistoryBytes(client, token, fullName, record.baseCommit, options.configuration, record.aliases);
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
  const changes = normalizeChangeSet(files, {
    subscriptionAlias, configuration: options.configuration, requestBudget: options.requestBudget,
    requestBody: options.requestBody || { action, expectedHead, transactionId, files,
      nativeProof: options.nativeProof, nativeIdentity: options.nativeIdentity },
  });
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
  let nativeConfigurationKey = null;
  if (options.configuration?.format === 'terraform') {
    nativeConfigurationKey = await (await import('./native-workspace.mjs')).validateNativeChangeSet(client, token, options, changes, head);
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
    ...(nativeConfigurationKey ? { configurationKey: nativeConfigurationKey,
      nativeCreation: changes.every((change) => change.create) } : {}),
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
  let equivalent = null;
  let indeterminate = false;

  try {
    await client.request(`/repos/${fullName}/git/refs/heads/${encodePath(branch)}`, {
      token,
      method: 'PATCH',
      body: { sha: commitSha, force: false },
    });
  } catch (error) {
    if (error.status === 422 || error.status === 403 || error.status === 409) {
      let reconciled;
      try {
        reconciled = await findAppliedCommit(client, token, {
          fullName, branch, treeSha, baseCommit: head, audit, environmentId,
          repositoryId: options.repositoryId, configurationKey: nativeConfigurationKey,
        });
      } catch (inspectionError) {
        indeterminate = true;
        warnings.push(`The branch could not be inspected after refusing the update. Keep this draft and inspect History before retrying. ${redactSecrets(inspectionError.message)}`);
      }
      alreadyApplied = reconciled?.kind === 'applied' ? reconciled : null;
      equivalent = reconciled?.kind === 'equivalent' ? reconciled : null;
      if (alreadyApplied) {
        // Report the reachable audited commit, not this attempt's unreferenced
        // proposal. Only the actual applied commit belongs in branch History.
        warnings.push(
          `This change was already on ${branch} as ${alreadyApplied.commit.slice(0, 12)}, so Citadel did not save it a second time.`
        );
      } else if (equivalent) {
        warnings.push(`The current tree on ${branch} already matches the reviewed change. No Citadel commit was applied; the matching commit ${equivalent.head.slice(0, 12)} is not attributed to this save in History.`);
      } else {
        // No proof of application. Keep the proposal available for an explicit
        // branch decision, including when inspection left the outcome unknown.
        unresolved = {
          kind: indeterminate ? 'outcome-unknown' : error.status === 422 ? 'branch-moved' : 'branch-protected',
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
    transactionId: alreadyApplied?.record.transactionId || transactionId,
    outcome: indeterminate ? 'indeterminate' : unresolved ? 'pending' : equivalent ? 'unchanged' : 'applied',
    applied: indeterminate ? null : !unresolved && !equivalent,
    changed: !unresolved && !equivalent,
    // When the change was already there, the commit the user should be given is
    // the one the branch actually holds. Ours is a real object but nothing
    // references it, so History would never list it and Undo would refuse it.
    commit: equivalent ? null : alreadyApplied?.commit || commitSha,
    baseCommit: alreadyApplied?.record.baseCommit || head,
    // Always the branch this save aimed at. No ref was created, so there is no
    // other branch to name.
    branch,
    author: equivalent ? null : alreadyApplied ? alreadyApplied.author : authorName || null,
    files: tree.map((entry) => ({ alias: entry.path, sha: entry.sha, mode: entry.mode })),
    warnings,
    ...(alreadyApplied ? { alreadyApplied: true, duplicateCommit: commitSha, attemptTransactionId: transactionId } : {}),
    ...(equivalent ? { equivalentCommit: equivalent.head, head: equivalent.head, proposedCommit: commitSha } : {}),
    ...(indeterminate ? { indeterminate: true } : {}),
    ...(unresolved ? { unresolved } : {}),
  };
  if (unresolved || equivalent) {
    // Neither an unresolved proposal nor content equivalence is a newly applied
    // Citadel commit.
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
      warnings.push(`${branch} moved after this audited save. The next source read reflects the current branch, not necessarily the saved revision.`);
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
  const { assertNativeAuditScope } = await import('./native-workspace.mjs');
  const eligible = audited.filter((record) => {
    try { assertNativeAuditScope(record, options.configuration); return true; }
    catch (error) { if (error.code === 'NATIVE_HISTORY_SCOPE' || error.code === 'NATIVE_SOURCE_SCOPE') return false; throw error; }
  });
  const auditedByCommit = new Map(eligible.map((item) => [item.commit, item]));
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
        ...(record.configurationKey ? { nativeCreation: Boolean(record.nativeCreation) } : {}),
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
  if (options.configuration?.format === 'terraform' || options.record?.configurationKey) {
    (await import('./native-workspace.mjs')).assertNativeAuditScope(options.record, options.configuration);
  }
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
    if (options.configuration?.format === 'terraform') workspaceScope(options.configuration).write(alias);
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
  if (options.configuration?.format === 'terraform') {
    const { assertNativeHistoryBytes } = await import('./native-workspace.mjs');
    const aliases = files.map((file) => file.alias);
    const savedDependencies = await assertNativeHistoryBytes(client, token, fullName, sha, options.configuration, aliases);
    if (parent) await assertNativeHistoryBytes(client, token, fullName, parent, options.configuration, files.map((file) => file.alias));
    const currentDependencies = await assertNativeHistoryBytes(client, token, fullName, head, options.configuration, aliases);
    if (JSON.stringify(savedDependencies) !== JSON.stringify(currentDependencies)) {
      throw githubError(409, 'NATIVE_HISTORY_STALE', 'The native schema, module or policy dependencies changed since this commit. History undo is blocked until the exact reviewed dependencies are restored.');
    }
  }
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
  const inspection = await inspectCommit(client, token, fullName, branch, commitSha, { record, configuration: options.configuration });
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
    // The undo HTTP request contains identifiers only. Restored blobs are sent
    // individually to GitHub, not as an aggregate browser commit request.
    requestBudget: false,
    files,
    action: 'history-undo',
    environmentId,
    transactionId,
    repositoryId,
    audit,
    // Undo may legitimately restore the environment file the subscription
    // bridge previously wrote, and only for that exact path.
    subscriptionAlias,
    configuration: options.configuration,
    nativeHistory: options.configuration?.format === 'terraform',
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
