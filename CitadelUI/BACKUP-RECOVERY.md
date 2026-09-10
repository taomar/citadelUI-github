# Backup and Recovery

Use **Settings > History** in the affected workspace to inspect a save or recover
an interrupted Local transaction. Preserve the original source, browser profile
and application data while deciding what to do. Do not delete state or overwrite
unknown files to clear an error.

Local saves write the original files on the browser's machine, through its
retained folder handle. The application stores journals and verified backups at
`/data/environments/<environment-id>/transactions/<transaction-id>/`; `/data`
is not the editable repository. A displayed Local path cannot restore authority
to a lost browser handle.

GitHub saves use atomic commits on the workspace's registered working branch.
Their originals remain in Git history, not Local backup storage. GitHub undo
appends an inverse commit without resetting or force-pushing. See
[GitHub write behavior](README.md#workspace-activity).

## Existing files changed outside Citadel

For an already-open Local file, Citadel compares current source with the loaded
version at Review/Save:

| Choice | Outcome |
| --- | --- |
| **Cancel** | No overwrite; the draft is retained |
| **Back up and overwrite** | Back up the current external on-disk bytes, then write the reviewed replacement |

The backup contains the external edits, not just the stale version originally
loaded. Backup failure prevents the write. A further change after confirmation
requires renewed consent. This is not automatic merging, rebasing, a filesystem
watcher or periodic reload; all other scope, schema, secret and permission
checks still apply.

For native inputs, known secret-bearing operator or dependency files block the
normal save/backup path even if only a nonsecret field was edited. Hiding a value
does not make a whole-file backup safe.

## States

Local transaction status and `recoveryRequired` describe the recorded outcome,
not a reason to repeat the save blindly:

| Journal status | Meaning |
| --- | --- |
| `preparing` | No source write is authorized; existing targets need verified backups |
| `authorized` | Backups are complete; final source checks precede writing |
| `committing` | Final hashes/sizes are journaled; writes may be in progress |
| `committed` | Every required final receipt matched |
| `reverting` | Removal of a previously committed creation is in progress |
| `rolled_back` | Required original-byte or removal receipts matched |
| `failed` / `abandoned` | No successful completion is claimed; a failed transaction can still require recovery |

The browser re-reads before writes and verifies after close. A recoverable
multi-file failure attempts rollback in reverse order. It does not claim rollback
when source identity, ownership or receipts are uncertain. A server restart
marks interrupted committing/reverting work for recovery.

If a receipt response is lost, Citadel checks the saved journal. Confirmed
commits are not blindly undone. When confirmation is unavailable, source bytes
can be retained with an explicit recovery record.

## User recovery

1. Open the affected workspace with its original retained folder handle and
   grant permission if requested.
2. Open **Settings > History**, find the transaction and choose **Recover** when
   offered. Review each file alias and state; the UI compares hashes without
   showing source values.
3. Use **Complete** only when available and the intended final state is present.
   Use **Roll back** to request the recorded backup/removal path. For an
   interrupted creation undo, the actions are **Continue removal** and
   **Confirm removed**.
4. Wait for the result and recheck History. A refused operation remains unresolved;
   do not treat a matching-looking file or a closed dialog as a recovery receipt.

For a completed eligible revision, **Restore prior** starts a new transaction
and backs up current source before restoring. Native history is bound to the
same profile/unit and reviewed schema/module/policy dependencies. Changed
dependencies make it read-only until those exact dependencies are restored.
Native recovery refuses foreign or missing existing-file bytes rather than
overwriting an unrecognized version.

Do not copy backup files manually over an active repository. Preserve external
changes and investigate a reported mismatch before attempting another recovery.

## Native file creation

Creation must be selected explicitly during attachment with **Create an empty
operator file if absent**. Opening the unit does not copy an example or write a
file. The first reviewed save has a separate concurrency warning.

Keep that folder untouched by other applications during creation. Absence,
content, modification-time and dependency checks, plus an exclusive writable
stream where supported, are not OS-level exclusion or atomic create-if-absent.
A detected existing file is a collision, not permission to overwrite it.
Simultaneous same-path creation cannot always be distinguished.

A confirmed creation may offer **Undo creation**. It removes only the committed
created files while they still match their recorded bytes and applicable native
dependencies. An unconfirmed or ambiguous creation is different: **Complete**
is unavailable, and Citadel will neither adopt nor delete a present file just
because it matches the proposed bytes.

For an unconfirmed file, preserve and inspect it outside Citadel. If you choose
to retain it elsewhere, move it deliberately; do not blindly delete it.
**Roll back** can close that attempt only once the selected target is absent
and the remaining native checks pass. This does not transfer the file or old
history to a new workspace automatically.

Whole-project **Create local from Citadel source** has a different, memory-only
retry record. Its partial folders are retained, and only attributable unchanged
entries can be retried. See the
[local source procedure](../guides/using-the-control-plane.md#create-a-local-project-from-citadel-source).

## Lost native folder handles

A native Local workspace can reconnect its retained original handle; it cannot
prove that a newly picked folder is the old owner after that handle is lost.
Selecting the same path does not restore old draft/history identity.

Keep the old record and history. A new workspace needs an intentional new
identity and a source folder that passes ownership checks; a distinct
operator-managed copy is an option when the old folder is refused. This does
not recover the old drafts or make its History writable. If recovery of that
identity is required, stop for support rather than clearing browser or server
registry data.

## Retention

Committed revisions are retained for 90 days while preserving at least the
latest 20 revisions for each target. Cleanup applies the 2 GiB per-environment
soft limit only after minimum retention. Failed/abandoned journals use a 30-day
cutoff; active recovery is not a cleanup workaround. Profile removal never
deletes repository files or `/data` history.

Protect `/data` and its backups with restrictive host permissions. Bicep backups
and migration prepared sources can contain sensitive configuration. Do not
include application data, browser storage, credentials or raw backups in a
support bundle. For a bounded report designed for manual support sharing, use
[Timed diagnostic capture](DIAGNOSTICS.md).
