# Backup and Recovery

Every mutation uses one transaction journal under
`/data/environments/<environment-id>/transactions/<transaction-id>/`.

## States

- `preparing`: no source write is authorized. Existing targets must have a
  durable, hash-verified backup.
- `authorized`: backups are complete and the browser is performing its final
  source hash check.
- `committing`: final hashes and sizes are journaled; browser writes may be in
  progress. A restart marks the transaction as requiring recovery.
- `committed`: every final receipt matched.
- `rolled-back`: every existing target matched its original backup hash and
  every newly created target was removed.
- `failed` or `abandoned`: no successful source mutation is claimed.

The browser re-reads before each write and verifies after close. A multi-file
failure restores changed targets in reverse order before sending rollback
receipts. Backup or authorization failure aborts without a source write.

## User recovery

1. Open the affected labeled environment through its retained or reconnected
   folder handle.
2. Open **Settings > History**.
3. Inspect the transaction aliases and status.
4. Verify current hashes against the expected final or original hashes.
5. Complete only when every target matches the planned final hash; otherwise
   restore every existing target from its verified backup and remove planned new
   targets.
6. Submit the completion or rollback receipt so the lease can be released.

Never copy backup files manually over a repository while Citadel UI is running.
A restore is itself a new transaction and first backs up the current source.

## Retention

Committed revisions are retained for 90 days while preserving at least the
latest 20 revisions for each target. Cleanup applies the 2 GiB per-environment
soft limit only after minimum retention. Failed and rollback journals are kept
for 30 days. Profile removal never deletes repository files or `/data` history.
