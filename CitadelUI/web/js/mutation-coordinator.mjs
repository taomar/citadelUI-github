import { configurationOf, unitForAlias, unconfirmedNativeCreation } from '../../shared/workspace-configuration.mjs';
import { nativeHistoryProof } from '../../shared/terraform/workspace.mjs';

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
  /** Local bytes travel in separate bounded backup/write steps, not an aggregate JSON request. */
  async validateRequest(_files, _options = {}) {}

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

export function localRecoveryFailure(error, transactionId, detail) {
  return Object.assign(new Error(`${error.message} ${detail}`, { cause: error }),
    { code: 'LOCAL_RECOVERY_REQUIRED', transactionId, applied: null, recoveryRequired: true });
}

/** Normal commits and History Complete must reconcile the same durable receipt boundary. */
export async function commitLocalReceipt(request, {
  transactionId, environmentId, transactionToken, authorizationToken, receipts,
}) {
  const base = `/api/transactions/${encodeURIComponent(transactionId)}`;
  const headers = { 'X-Citadel-Environment': environmentId, 'X-Citadel-Transaction': transactionToken };
  const recoveryFailure = (error, detail) => localRecoveryFailure(error, transactionId, detail);
  const inspect = () => request(`${base}?environmentId=${encodeURIComponent(environmentId)}`);
  try {
    const result = await request(`${base}/receipt`, {
      method: 'POST',
      headers: { ...headers, 'X-Citadel-Authorization': authorizationToken },
      body: JSON.stringify({ receipts }),
    });
    return { ...result, transactionId, applied: true, outcome: 'applied' };
  } catch (error) {
    // An unanswered receipt may already be committed. Never undo source bytes
    // while that durable outcome is uncertain.
    let recorded;
    try { recorded = await inspect(); }
    catch (inspectionError) {
      throw recoveryFailure(error, `The receipt could not be confirmed. Source bytes were retained; inspect History recovery. ${inspectionError.message}`);
    }
    const confirmed = (record) => ({
      transactionId, status: 'committed', committedAt: record.transaction.committedAt,
      applied: true, outcome: 'applied',
      warnings: [
        'The receipt response failed, but the committed journal confirms this save.',
        ...(record.transaction.auditRecorded === false
          ? ['The terminal audit is still pending. Inspect History before another change.'] : []),
      ],
    });
    if (recorded.transaction.status === 'committed') return confirmed(recorded);
    // Recovery is already durable here; repeating /fail is an invalid transition.
    if (recorded.transaction.status === 'failed' && recorded.transaction.recoveryRequired) {
      throw recoveryFailure(error, 'The save receipt is not confirmed. Source bytes were retained; inspect History recovery.');
    }
    try {
      await request(`${base}/fail`, {
        method: 'POST', headers,
        body: JSON.stringify({ changedAliases: receipts.map((file) => file.alias) }),
      });
    } catch (recoveryError) {
      let latest;
      try { latest = await inspect(); }
      catch (inspectionError) {
        throw recoveryFailure(error, `Source bytes were retained, but recovery could not be recorded or confirmed. Inspect History. ${recoveryError.message} ${inspectionError.message}`);
      }
      if (latest.transaction.status === 'committed') return confirmed(latest);
      throw recoveryFailure(error, `Source bytes were retained, but recovery could not be recorded. Inspect History. ${recoveryError.message}`);
    }
    throw recoveryFailure(error, 'The save receipt is not confirmed. Source bytes were retained; inspect History recovery.');
  }
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
 * journal-driven recovery and History behavior. Ordinary saves and History
 * Complete share receipt reconciliation; rollback keeps its source-safety rules.
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
      unconfirmedCreation: Boolean(unconfirmedNativeCreation(result.transaction)),
      canComplete:
        unconfirmedNativeCreation(result.transaction) ? false : result.transaction.status === 'reverting'
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
    const configuration = configurationOf(context.environment);
    const native = configuration.format === 'terraform';
    if (native) await nativeHistoryProof(provider, configuration, transaction);
    const transactionHeaders = {
      'X-Citadel-Environment': environmentId,
      'X-Citadel-Transaction': recovery.transactionToken,
    };
    if (action === 'complete' && transaction.status !== 'reverting') {
      if (inspection.unconfirmedCreation) throw new Error('This native creation is unconfirmed. Citadel will not adopt a present file. Keep or move the file outside Citadel; rollback can close this attempt once the selected path is absent.');
      if (!inspection.canComplete) throw new Error('Not every target matches its planned final hash.');
      return commitLocalReceipt(this.request.bind(this), {
        transactionId, environmentId, transactionToken: recovery.transactionToken,
        authorizationToken: recovery.authorizationToken,
        receipts: inspection.files.map((file) => ({
          alias: file.alias,
          hash: file.currentHash,
          size: file.currentSize,
        })),
      });
    }
    if (action !== 'rollback' && !(action === 'complete' && transaction.status === 'reverting')) {
      throw new Error('Unknown recovery action.');
    }

    const receipts = [];
    for (const file of [...transaction.files].reverse()) {
      if (native) await nativeHistoryProof(provider, configuration, transaction);
      let current = null;
      try {
        current = await provider.read(file.alias);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (!file.existed) {
        if (current) {
          if (inspection.unconfirmedCreation) throw new Error('This native creation is unconfirmed. Citadel will not remove a present file, even when it matches the proposed bytes. Keep or move it outside Citadel before retrying rollback.');
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
        if (native && (current?.hash !== file.finalHash || current?.size !== file.finalSize)) {
          throw new Error('The native recovery target has foreign or missing bytes. No backup was applied.');
        }
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
          ...(native ? { validateBeforeWrite: () => nativeHistoryProof(provider, configuration, transaction) } : {}),
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
    const configuration = configurationOf(context.environment);
    const native = configuration.format === 'terraform';
    const proof = native ? await nativeHistoryProof(provider, configuration, detail.transaction) : null;
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
      if (native && (current?.hash !== file.finalHash || current?.size !== file.finalSize)) {
        throw new Error('The native History target no longer matches the saved transaction. Its current bytes were not overwritten.');
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
    return this.commit(files, { action: 'history-restore', context,
      ...(native ? { nativeProof: proof, validateBeforeWrite: () => nativeHistoryProof(provider, configuration, detail.transaction) } : {}) });
  }

  async revertCreation(transaction, options = {}) {
    const context = this.resolve(options);
    const provider = context.provider;
    const boundary = contractCreationBoundary(transaction);
    const configuration = configurationOf(context.environment);
    const nativeCreation = configuration.format === 'terraform' && transaction.files.length &&
      transaction.files.every((file) => !file.existed && unitForAlias(configuration, file.alias)?.allowCreate);
    if ((!boundary && !nativeCreation) || transaction.status !== 'committed') {
      throw new Error('This transaction has no prior file bytes to restore.');
    }
    if (nativeCreation) await nativeHistoryProof(provider, configuration, transaction);
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
      if (nativeCreation) await nativeHistoryProof(provider, configuration, transaction);
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
      applied: true,
      outcome: 'applied',
      transactionId: transaction.transactionId,
      removed: receipts.map((item) => item.alias),
    };
  }
}
