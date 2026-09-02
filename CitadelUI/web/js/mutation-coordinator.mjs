/**
 * Source-owning mutation boundary.
 *
 * `WorkspaceService` prepares exact before/after bytes for an operation and
 * hands them to a coordinator once. The coordinator owns atomicity, recovery,
 * concurrency, and the history model for its source kind, so the editor never
 * has to know whether it is writing a local folder or a Git repository.
 *
 * A local folder has no immutable parent revision, so the local coordinator
 * keeps the verified backup-before-write transaction protocol. A Git repository
 * already stores immutable parents, so its coordinator uses one commit per
 * operation and inverse commits for undo.
 */
export class MutationCoordinator {
  /** Apply every file change as one all-or-nothing operation. */
  async commit(_files, _options = {}) {
    throw new Error('Mutation coordinator does not implement commit.');
  }

  /** List Citadel-authored changes for the active environment. */
  async history(_options = {}) {
    throw new Error('Mutation coordinator does not implement history.');
  }

  /** Describe one recorded change against the current source state. */
  async inspect(_changeId, _options = {}) {
    throw new Error('Mutation coordinator does not implement inspect.');
  }

  /** Undo one recorded change without rewriting shared history. */
  async revert(_changeId, _options = {}) {
    throw new Error('Mutation coordinator does not implement revert.');
  }
}

function isNotFound(error) {
  return error?.name === 'NotFoundError' || /not found/i.test(error?.message || '');
}

function contractCreationBoundary(transaction) {
  if (
    transaction.targetLabel !== 'contract-create' ||
    !transaction.files?.length ||
    transaction.files.some((file) => file.existed)
  ) {
    return null;
  }
  const matches = transaction.files.map((file) =>
    /^(.*\/citadel-access-contracts\/contracts)\/([^/]+)\/[^/]+$/.exec(file.alias)
  );
  if (
    matches.some((match) => !match) ||
    matches.some((match) => match[1] !== matches[0][1] || match[2] !== matches[0][2])
  ) {
    return null;
  }
  return matches[0][1];
}

/**
 * Local folder coordinator.
 *
 * This is the existing prepare/backup/authorize/commit/receipt protocol plus the
 * journal-driven recovery and History behavior that previously lived inside
 * `WorkspaceService`. Behavior is unchanged; only ownership moved.
 */
export class LocalTransactionCoordinator extends MutationCoordinator {
  constructor(options = {}) {
    super();
    this.request = options.request;
    this.commitFiles = options.commitFiles;
    this.contextProvider = options.contextProvider;
  }

  resolve(options = {}) {
    const context = options.context || this.contextProvider?.();
    if (!context) throw new Error('No environment is attached.');
    return context;
  }

  async commit(files, options = {}) {
    return this.commitFiles(files, options);
  }

  async history(options = {}) {
    const context = this.resolve(options);
    return this.request(
      `/api/transactions?environmentId=${encodeURIComponent(context.environment.id)}`
    );
  }

  async inspect(transactionId, options = {}) {
    const context = this.resolve(options);
    const provider = context.provider;
    const result = await this.request(
      `/api/transactions/${encodeURIComponent(transactionId)}?environmentId=${encodeURIComponent(context.environment.id)}`
    );
    const files = [];
    for (const file of result.transaction.files || []) {
      let current = null;
      try {
        current = await provider.read(file.alias);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      files.push({
        ...file,
        currentHash: current?.hash || null,
        currentSize: current?.size || 0,
        state:
          current?.hash === file.finalHash && current?.size === file.finalSize
            ? 'final'
            : file.existed && current?.hash === file.originalHash && current?.size === file.originalSize
              ? 'original'
              : !file.existed && !current
                ? 'absent'
                : 'unexpected',
      });
    }
    return {
      transaction: result.transaction,
      files,
      canComplete:
        result.transaction.status === 'reverting'
          ? files.every((file) => file.state === 'absent')
          : files.every((file) => file.state === 'final'),
    };
  }

  async recover(transactionId, action, options = {}) {
    const context = this.resolve(options);
    const provider = context.provider;
    const environmentId = context.environment.id;
    const inspection = await this.inspect(transactionId, { context });
    const recovery = await this.request(
      `/api/transactions/${encodeURIComponent(transactionId)}/recover`,
      {
        method: 'POST',
        headers: { 'X-Citadel-Environment': environmentId },
        body: JSON.stringify({}),
      }
    );
    const transaction = inspection.transaction;
    const transactionHeaders = {
      'X-Citadel-Environment': environmentId,
      'X-Citadel-Transaction': recovery.transactionToken,
    };
    if (action === 'complete' && transaction.status !== 'reverting') {
      if (!inspection.canComplete) throw new Error('Not every target matches its planned final hash.');
      return this.request(`/api/transactions/${encodeURIComponent(transactionId)}/receipt`, {
        method: 'POST',
        headers: {
          ...transactionHeaders,
          'X-Citadel-Authorization': recovery.authorizationToken,
        },
        body: JSON.stringify({
          receipts: inspection.files.map((file) => ({
            alias: file.alias,
            hash: file.currentHash,
            size: file.currentSize,
          })),
        }),
      });
    }
    if (action !== 'rollback' && !(action === 'complete' && transaction.status === 'reverting')) {
      throw new Error('Unknown recovery action.');
    }

    const receipts = [];
    for (const file of [...transaction.files].reverse()) {
      let current = null;
      try {
        current = await provider.read(file.alias);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!file.existed) {
        if (current) {
          if (current.hash !== file.finalHash || current.size !== file.finalSize) {
            throw new Error(`Created source changed outside Citadel UI: ${file.alias}`);
          }
          await provider.remove(file.alias, {
            expectedHash: file.finalHash,
            removeEmptyDirectories: (
              transaction.status === 'reverting'
                ? transaction.revertCleanupDirectories || []
                : transaction.createdDirectories || []
            ).filter((directory) => file.alias.startsWith(`${directory}/`)),
          });
        }
        receipts.push({ alias: file.alias, removed: true });
        continue;
      }
      if (current?.hash !== file.originalHash || current?.size !== file.originalSize) {
        const backup = await this.request(
          `/api/transactions/${encodeURIComponent(transactionId)}/backups/${encodeURIComponent(file.id)}?environmentId=${encodeURIComponent(environmentId)}`,
          {
            responseType: 'bytes',
            headers: { 'X-Citadel-Transaction': recovery.transactionToken },
          }
        );
        const verified = await provider.write(file.alias, backup.bytes, {
          create: !current,
          expectedHash: current?.hash ?? null,
          finalHash: file.originalHash,
        });
        current = verified;
      }
      receipts.push({ alias: file.alias, hash: current.hash, size: current.size });
    }
    return this.request(`/api/transactions/${encodeURIComponent(transactionId)}/rollback`, {
      method: 'POST',
      headers: transactionHeaders,
      body: JSON.stringify({ receipts }),
    });
  }

  async revert(transactionId, options = {}) {
    const context = this.resolve(options);
    const provider = context.provider;
    const environmentId = context.environment.id;
    const detail = await this.request(
      `/api/transactions/${encodeURIComponent(transactionId)}?environmentId=${encodeURIComponent(environmentId)}`
    );
    const restorable = (detail.transaction.files || []).filter((file) => file.existed);
    if (!restorable.length) {
      return this.revertCreation(detail.transaction, { context });
    }
    const token = await this.request(
      `/api/transactions/${encodeURIComponent(transactionId)}/restore-token`,
      {
        method: 'POST',
        headers: { 'X-Citadel-Environment': environmentId },
        body: JSON.stringify({}),
      }
    );
    const files = [];
    for (const file of restorable) {
      const backup = await this.request(
        `/api/transactions/${encodeURIComponent(transactionId)}/backups/${encodeURIComponent(file.id)}?environmentId=${encodeURIComponent(environmentId)}`,
        {
          responseType: 'bytes',
          headers: { 'X-Citadel-Backup-Read': token.backupReadToken },
        }
      );
      let current = null;
      try {
        current = await provider.read(file.alias);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      files.push({
        alias: file.alias,
        before: current?.bytes || null,
        beforeHash: current?.hash || null,
        after: backup.bytes,
        changed: ['restore'],
        create: !current,
      });
    }
    return this.commit(files, { action: 'history-restore', context });
  }

  async revertCreation(transaction, options = {}) {
    const context = this.resolve(options);
    const provider = context.provider;
    const boundary = contractCreationBoundary(transaction);
    if (!boundary || transaction.status !== 'committed') {
      throw new Error('This transaction has no prior file bytes to restore.');
    }
    const current = new Map();
    for (const file of transaction.files) {
      let source;
      try {
        source = await provider.read(file.alias);
      } catch (error) {
        if (isNotFound(error)) {
          throw new Error(`Created source is missing: ${file.alias}`);
        }
        throw error;
      }
      if (source.hash !== file.finalHash || source.size !== file.finalSize) {
        throw new Error(`Created source changed outside Citadel UI: ${file.alias}`);
      }
      current.set(file.alias, source);
    }

    const environmentId = context.environment.id;
    const revert = await this.request(
      `/api/transactions/${encodeURIComponent(transaction.transactionId)}/revert`,
      {
        method: 'POST',
        headers: { 'X-Citadel-Environment': environmentId },
        body: JSON.stringify({}),
      }
    );

    for (const file of transaction.files) {
      const source = await provider.read(file.alias);
      if (source.hash !== file.finalHash || source.size !== file.finalSize) {
        throw new Error(`Created source changed outside Citadel UI: ${file.alias}`);
      }
    }

    const receipts = [];
    for (const file of [...transaction.files].reverse()) {
      await provider.remove(file.alias, {
        expectedHash: file.finalHash,
        removeEmptyDirectories: (revert.cleanupDirectories || []).filter((directory) =>
          file.alias.startsWith(`${directory}/`)
        ),
      });
      receipts.push({ alias: file.alias, removed: true });
    }
    const result = await this.request(
      `/api/transactions/${encodeURIComponent(transaction.transactionId)}/rollback`,
      {
        method: 'POST',
        headers: {
          'X-Citadel-Environment': environmentId,
          'X-Citadel-Transaction': revert.transactionToken,
        },
        body: JSON.stringify({ receipts }),
      }
    );
    return {
      ...result,
      transactionId: transaction.transactionId,
      removed: receipts.map((item) => item.alias),
    };
  }
}
