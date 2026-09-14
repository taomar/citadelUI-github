import { MutationCoordinator } from './mutation-coordinator.mjs';
import { notifyGitHubHead } from './github-head-state.mjs';
import { sha256, MAX_SOURCE_BYTES, MAX_COMMIT_FILES } from '../../shared/source-scope.mjs';
import { mutationComplete, withMutationOutcome } from '../../shared/mutation-outcome.mjs';
import { assertGitHubRequestBudget } from '../../shared/github-request-budget.mjs';

function toBase64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index]);
  }
  return btoa(binary);
}

/**
 * Git-backed mutation coordinator.
 *
 * `WorkspaceService` prepares the same before/after bytes it prepares for a
 * local save; this coordinator turns them into exactly one commit. Atomicity
 * comes from a single tree and commit, and concurrency from a non-forced ref
 * update against the branch head the user reviewed.
 *
 * There is no backup protocol here on purpose: the parent commit already holds
 * immutable originals, so no source bytes need to be copied into `/data`.
 */
export class GitHubCommitCoordinator extends MutationCoordinator {
  constructor(options = {}) {
    super();
    this.request = options.request;
    this.contextProvider = options.contextProvider;
  }

  resolve(options = {}) {
    const context = options.context || this.contextProvider?.();
    if (!context) throw new Error('No environment is attached.');
    return context;
  }

  base(context) {
    return `/api/github/workspaces/${encodeURIComponent(context.environment.id)}`;
  }

  async requestMutation(context, operation, body) {
    const encoded = JSON.stringify(body);
    if (operation === 'commits') assertGitHubRequestBudget(encoded);
    let result;
    try {
      result = await this.request(`${this.base(context)}/${operation}`, {
        method: 'POST', body: encoded,
      });
    } catch (error) {
      if (!error.indeterminate && Number.isInteger(error.status) &&
          (error.status < 500 || ['SAVE_NOT_APPLIED', 'AUDIT_UNAVAILABLE'].includes(error.code))) throw error;
      result = {
        applied: null, indeterminate: true, transactionId: body.transactionId,
        commit: error.commit || null, branch: context.environment.source?.workingBranch,
        warnings: [`${error.message} The GitHub mutation outcome is not confirmed. Keep this action and inspect History or reopen the workspace before another attempt.`],
        ...(error.commit ? { unresolved: { kind: 'outcome-unknown', commit: error.commit,
          intendedBranch: context.environment.source?.workingBranch } } : {}),
      };
    }
    const outcome = withMutationOutcome({ transactionId: body.transactionId, ...result });
    if (outcome.outcome === 'indeterminate' && !outcome.warnings?.length) {
      outcome.warnings = ['GitHub did not return a confirmed mutation outcome. Keep this action and inspect History before another attempt.'];
    }
    if (mutationComplete(outcome)) {
      notifyGitHubHead(context.environment, outcome.head || outcome.commit || outcome.equivalentCommit);
      context.provider.reset();
    }
    return outcome;
  }

  async prepareRequest(files, options = {}) {
    const context = this.resolve(options);
    const provider = context.provider;
    if (!Array.isArray(files) || !files.length || files.length > MAX_COMMIT_FILES) {
      throw new Error('A change set of 1 to 64 files is required.');
    }
    let contentBytes = 0;
    for (const file of files) {
      if (!(file.after instanceof Uint8Array) || file.after.byteLength > MAX_SOURCE_BYTES) {
        throw Object.assign(new Error('Each source must contain at most 8 MiB of reviewed bytes.'), { code: 'SOURCE_TOO_LARGE' });
      }
      contentBytes += 4 * Math.ceil(file.after.byteLength / 3);
    }
    const head = await provider.workspaceHead();
    if (options.expectedHead && options.expectedHead !== head) throw new Error('The shared GitHub branch head changed after review. Your draft is preserved; review it against the new head.');
    const payload = [];
    for (const file of files) {
      const create = Boolean(file.create);
      // A non-created file carries the blob SHA, the SHA-256 the user actually
      // reviewed, and the file's current mode, so the server can bind every
      // precondition to this exact path and not silently change an executable.
      const entry = create ? null : await provider.entry(file.alias);
      payload.push({
        alias: file.alias,
        create,
        blobSha: create ? null : entry.sha,
        beforeHash: create ? null : file.beforeHash,
        mode: create ? undefined : entry.mode,
        after: '',
      });
    }
    const body = {
        action: options.action || 'parameter-edit',
        expectedHead: head,
        transactionId: globalThis.crypto.randomUUID(),
        files: payload,
        ...(options.nativeProof ? { nativeProof: options.nativeProof } : {}),
        ...(options.nativeIdentity ? { nativeIdentity: options.nativeIdentity } : {}),
    };
    const budget = assertGitHubRequestBudget(body, contentBytes);
    return { context, body, budget };
  }

  async validateRequest(files, options = {}) {
    return (await this.prepareRequest(files, options)).budget;
  }

  async commit(files, options = {}) {
    await options.validateBeforeWrite?.();
    const { context, body } = await this.prepareRequest(files, options);
    body.files.forEach((file, index) => { file.after = toBase64(files[index].after); });
    const result = await this.requestMutation(context, 'commits', body);
    const plannedFiles = await Promise.all(files.map(async (file) => ({
      ...(result.files || []).find((entry) => entry.alias === file.alias),
      alias: file.alias, hash: await sha256(file.after),
    })));
    return {
      ...result,
      warnings: result.warnings || [],
      files: mutationComplete(result) ? plannedFiles : [],
      ...(!mutationComplete(result) ? { plannedFiles } : {}),
    };
  }

  /**
   * Put an unreferenced commit on a branch the user has just named.
   *
   * The only path in the product that creates a ref for a refused save, and it
   * exists solely because the user asked for one by name.
   */
  async createCommitBranch(commit, branch, options = {}) {
    const context = this.resolve(options);
    const result = await this.request(`${this.base(context)}/commit-branches`, {
      method: 'POST',
      body: JSON.stringify({ commit, branch }),
    });
    return result;
  }

  async history(options = {}) {
    const context = this.resolve(options);
    const result = await this.request(`${this.base(context)}/history`);
    return {
      transactions: (result.transactions || []).map((entry) => ({
        ...entry,
        // History rows are keyed by transactionId locally; for a Git source the
        // durable identifier is the commit, so both are present and equal.
        transactionId: entry.commit,
        commit: entry.commit,
      })),
    };
  }

  async inspect(commit, options = {}) {
    const context = this.resolve(options);
    const result = await this.request(
      `${this.base(context)}/commits?sha=${encodeURIComponent(commit)}`
    );
    const transaction = result.transaction;
    return {
      transaction: {
        ...transaction,
        transactionId: transaction.commit,
        status: 'committed',
        files: transaction.files,
      },
      files: transaction.files,
      canComplete: transaction.canRevert,
    };
  }

  /**
   * Undo creates an inverse commit. A branch is never reset, force-updated, or
   * rewritten, so concurrent work on the branch is never destroyed.
   */
  async revert(commit, options = {}) {
    const context = this.resolve(options);
    const result = await this.requestMutation(context, 'reverts', {
        commit,
        transactionId: globalThis.crypto.randomUUID(),
    });
    return mutationComplete(result) ? result : { ...result, plannedFiles: result.files || [], files: [] };
  }

  /**
   * A Git commit either happened or did not, so there is no interrupted state to
   * recover. Recovery exists only for the local backup-before-write protocol.
   */
  async recover() {
    throw new Error('GitHub saves are single commits and never need recovery.');
  }
}
