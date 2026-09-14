import { githubError } from './api.mjs';
import { validateBranchName, validateCommitSha } from './repositories.mjs';
import { MAX_ENV_BYTES, MAX_SOURCE_BYTES } from '../../shared/source-scope.mjs';
import { workspaceScope } from '../../shared/workspace-configuration.mjs';
import { isReachable, readBlob, requireBranchHead, resolveEntry, treeIndex } from './git-reader.mjs';

const MAX_HISTORY = 100;

/** History prepares inverse changes; the existing workspace writer publishes them. */
export function createGitHubHistory({ commitChangeSet, parseTrailers }) {
  /**
   * Citadel-authored commits on the working branch, newest first.
   *
   * Shaped for the History UI: each entry carries the identifiers the inspect and
   * undo actions need, a status, changed aliases, and a timestamp. A commit is
   * only listed when the server's own audit record proves Citadel UI created it,
   * so forged trailers cannot inject entries.
   */
  async function loadHistory(client, token, fullName, branch, environmentId, options = {}) {
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
   * Describe the files one Citadel commit changed, and whether the branch still
   * holds exactly the bytes that commit produced.
   */
  async function inspectCommit(client, token, fullName, branch, commitSha, options = {}) {
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
  async function revertCommit(client, token, options) {
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

  return { loadHistory, inspectCommit, revertCommit };
}
