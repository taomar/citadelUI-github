import { MutationCoordinator } from './mutation-coordinator.mjs';

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

  async commit(files, options = {}) {
    const context = this.resolve(options);
    const provider = context.provider;
    const head = await provider.workspaceHead();
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
        after: toBase64(file.after),
      });
    }
    const result = await this.request(`${this.base(context)}/commits`, {
      method: 'POST',
      body: JSON.stringify({
        action: options.action || 'parameter-edit',
        expectedHead: head,
        transactionId: globalThis.crypto.randomUUID(),
        files: payload,
      }),
    });
    provider.reset();
    return {
      transactionId: result.transactionId,
      commit: result.commit,
      baseCommit: result.baseCommit,
      branch: result.branch,
      // The save landed. A later fast-forward by someone else is normal
      // collaboration, surfaced as a warning rather than a failure.
      movedAfterSave: Boolean(result.movedAfterSave),
      // Anything the server could not confirm *after* the commit landed. These
      // never mean "retry"; they mean "applied, with something to know".
      headUnknown: Boolean(result.headUnknown),
      warnings: result.warnings || [],
      files: files.map((file) => ({ alias: file.alias, hash: file.afterHash || null })),
    };
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
    const result = await this.request(`${this.base(context)}/reverts`, {
      method: 'POST',
      body: JSON.stringify({
        commit,
        transactionId: globalThis.crypto.randomUUID(),
      }),
    });
    context.provider.reset();
    return result;
  }

  /**
   * A Git commit either happened or did not, so there is no interrupted state to
   * recover. Recovery exists only for the local backup-before-write protocol.
   */
  async recover() {
    throw new Error('GitHub saves are single commits and never need recovery.');
  }
}
