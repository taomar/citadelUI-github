/**
 * The History panel's view model, reconciled across sources.
 *
 * The local journal and a GitHub branch describe the same event differently:
 *
 *   local   { transactionId, timestamp,   files: [{ alias, existed }] }
 *   GitHub  { commit, committedAt, canUndo, files: [{ alias }] }
 *
 * The panel used to read `file.existed` directly. A GitHub row has no such
 * field, so `every(!existed)` answered "true" for every commit: ordinary edits
 * looked like contract creations, lost their Undo affordance entirely, and the
 * one case that did render offered to "Undo creation". Undo was also addressed
 * by `transactionId`, which on a GitHub row is the audit UUID rather than the
 * commit SHA the revert endpoint requires.
 *
 * Normalising here keeps both quirks out of the render and gives the panel one
 * shape to consume.
 */
export function historyEntry(transaction) {
  const files = transaction.files || transaction.targets || [];
  const action = transaction.targetLabel || transaction.action || null;
  const status = transaction.status || 'original';
  const undoable = ['committed', 'rolled_back'].includes(status);
  // Only a source that states `canUndo` has authoritative eligibility. The local
  // journal keeps its original rule, so its behaviour is unchanged.
  const stated = typeof transaction.canUndo === 'boolean';
  const isCreation = stated
    ? action === 'contract-create'
    : files.length > 0 && files.every((file) => !file.existed);
  return {
    // A GitHub undo is addressed by commit; a local one by transaction.
    id: transaction.commit || transaction.transactionId || transaction.id || null,
    status,
    action,
    aliases: (transaction.aliases?.length
      ? transaction.aliases
      : files.map((file) => file.alias)
    ).filter(Boolean),
    timestamp:
      transaction.timestamp ||
      transaction.createdAt ||
      transaction.committedAt ||
      transaction.completedAt ||
      null,
    isCreation,
    canUndo: stated
      ? transaction.canUndo && undoable
      : undoable &&
        (files.some((file) => file.existed) ||
          (status === 'committed' &&
            action === 'contract-create' &&
            files.every((file) => !file.existed))),
  };
}
