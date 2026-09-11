# Citadel Control Plane: archive-safe orchestrator handover

Orchestration policy: `.github\copilot-instructions.md` in the receiving
checkout. Verify that file exists there; older checkouts do not necessarily
contain it. The role, dispatch and reply-back instructions below describe
the historical handover and do not override the standing policy.

Prepared on 10 September 2026 for the user's requested standalone successor.
This document is a historical handover, not a new implementation assignment.
The current product documentation is the eight-document refresh at `b8206f17`.
Application behavior is the independently accepted and locally running
`4379522c`. The handover itself adds no application changes.

## 1. First instruction: load context, acknowledge, and wait

The user asked for an in-depth handover, preservation of needed artifacts,
learning and knowledge, and a new orchestrator on the same branch. The outgoing
orchestrator and its subsessions will be archived.

The successor's startup assignment is READ-ONLY CONTEXT LOADING. Read this
handover, the durable reading guide and manifests, then acknowledge receipt in
the new session and wait for the user's next instruction. Do not start fixes,
feature planning, tests, builds, source acquisition, Docker changes, cloud or
GitHub actions, publication, new workers, or another handover automatically.
Examples and old recommendations in evidence are history, not authorization.

There is no unfinished implementation or documentation assignment to resume.
The documentation request is complete, committed and integrated locally.
Known limitations are recorded below; none is an automatic backlog assignment.

The successor is a coordinator/producer. Future implementation belongs to one
named, visible Dev session per scope/worktree; independent QA should own its
review scope when risk warrants it. Do not confuse readiness, a frozen build,
independent acceptance, integration, and deployment. They are separate states.

## 2. Where the handover lives

The durable root is outside every session and worktree:

```text
C:\Users\tarekomar\.copilot\handoffs\citadel-orchestrator-2026-09-10
```

Read in this order:

1. `START-HERE.txt`: immediate startup boundary and navigation.
2. `HANDOVER.md`: identical to this committed guide.
3. `runtime-and-git.json`: final source/ref/runtime identity and successor location.
4. `artifact-index.json`: copied evidence, original paths, byte hashes and receipt checks.
5. `manifest.json`: integrity inventory of the completed durable handover.
6. The repository's existing `AGENTS.md`, without rewriting it.

`successor-session.json` records the detached successor and branch transfer.
`successor-receipt.md`, when present, records its actual acknowledgement rather
than a prediction that it has read the documents. The ZIP and SHA256 sidecar
alongside the durable folder package the handover after it is complete.

The Git bundle under `source\` preserves the current branch, an additional
dated handover ref, the independent Terraform analysis, and the earlier
handover ref. It contains history, not merely a patch requiring an archived
worktree. The Docker archive under `runtime\` contains the accepted v2 image,
its immediate rollback image, and the rejected v1 counterexample image.
It contains no running container volume or owner/credential state.

The preceding migration handover remains independently durable at:

```text
C:\Users\tarekomar\.copilot\handoffs\citadel-migration-2026-09-08
```

It has its own `START-HERE.txt`, `HANDOVER.md`, manifests, public fixture, reports
and bundle. It explains the migration's earlier design and mistakes. Do not
rewrite it as current evidence or restart its completed work.

## 3. Identity: repository, branch, checkout and publication

| Item | Authoritative value |
| --- | --- |
| Application repository | `taomar/citadelUI-github` |
| Application project ID | `ca7c14dc-ee80-4781-b3df-c08d9eba415d` |
| Continuing Git branch | `taomar-citadel-successor-orchestrator` |
| Latest application commit | `4379522cdf0dbc8048bf45e0dbe0db2aa42cd358` |
| Latest product-documentation commit | `b8206f17d65acb25e7d04691fd16b9b4da240aba` |
| Handover commit / final HEAD | Recorded in `runtime-and-git.json` to avoid a self-referential commit hash |
| Last observed published session-branch head | `e2ca814952af6654e9dd551592cf48403ddd4562` |
| Old local and tracked remote `main` | `6bbf17e60dea0bf3c988aa327c8d2e9a68fc9484` |
| Independent analysis branch | Exactly `citadel-terraform-analysis` |
| Analysis head | `f3a19af1c124b9b5085b61d15288ca1f9d1a7426` |

The correct repository is not `taomar/Citadel-UI`. That name can appear as a
repository being edited *inside* the product; it is not this application's
project. Do not confuse the other configured projects, notably PolicyVerbAItim
and deskagent-MAF-Accelerator, with Citadel or its workers.

The user asked for local commits. The latest native/debug/documentation work
was not pushed or merged to `main`. Six commits were ahead of the tracked
session branch before this documentation-only handover commit. The remote
tracking values were read locally; no new fetch or remote mutation was needed
for the handover. Do not infer a remotely available release from a local ref.

The permanent project checkout and Git object store are:

```text
C:\Users\tarekomar\.copilot\repos\citadelUI-github
```

The outgoing session worktree is archival material:

```text
C:\Users\tarekomar\.copilot\repos\copilot-worktrees\citadelUI-github\taomar-redesigned-succotash
```

To honor the *same branch* request, rather than create another branch merely
based on it, the handoff transfers the branch to a detached app session using
the permanent checkout. Before that transfer, the outgoing worktree is left
clean and detached at the preserved handover commit, releasing its Git branch.
The final manifest records the actual completed transfer. No branch reset,
rebase, force checkout, or `main` advancement is part of this operation.

Two pre-existing untracked notes in the permanent checkout are deliberately
preserved, not read, edited, committed or copied into the bundle:

```text
HANDOFF-CITADEL-MIGRATION.md
HANDOFF-GITHUB-TOKEN-SETUP.md
```

Consequently, distinguish a clean tracked source tree from those retained
untracked notes. Do not use a blanket add/clean/reset on the permanent checkout.
The current branch does not track either path.

New worktree sessions have repeatedly started at older published source even
when a newer local base was requested. Always compare actual `git rev-parse HEAD`
and branch with the required source before assigning implementation. A clean
worker can explicitly fast-forward to its approved base; never silently reset
or overwrite another writer's work.

## 4. The live application: preserve it, do not recreate it

At the handover observation, `http://127.0.0.1:4173/healthz` returned HTTP 200
with `{"ok":true}`. The same accepted container was running and healthy.
This is a live identity/availability observation, not a new application audit.

| Identity | Value |
| --- | --- |
| Application origin | `http://127.0.0.1:4173/` |
| Container name | `citadel-ui-app-1` |
| Container ID | `8e55ad4362162a95ea69c322d8c3bd6e91a3e43342153bff60eb20ed4446e5a2` |
| Compose project / service | `citadel-ui` / `app` |
| Configured local alias | `citadel-ui:local` |
| Accepted immutable tag | `citadel-ui:native-workspaces-4379522c-3e85725d98e3-v2` |
| OCI index / observed image ID | `sha256:816b9805815c1eef289febd94a576968d2a7415e06cf8661fb4896e2ba35f4fd` |
| Runtime manifest | `sha256:666d44d0e95fa1053417f123906cea84f49ea08cab94528c599c84dc6c045498` |
| Runtime config | `sha256:8009084e74ac3e1bdb7fae36357648f8d7a7ca9d82b9812b37573df9a6c846fc` |
| Application revision label | `4379522cdf0dbc8048bf45e0dbe0db2aa42cd358` |
| Materialized source digest | `3e85725d98e3388db031fd2ab27bc7b07a9e3adbf4cfc48a5b1e5fee5e540504` |

The permanent data bind mount is:

```text
C:\Users\tarekomar\.copilot\repos\citadelUI-github\CitadelUI\.data -> /data
```

The active configuration originated from this one Compose file:

```text
C:\Users\tarekomar\.copilot\repos\citadelUI-github\CitadelUI\compose.yaml
```

No `container.env` existed there at the handover check. The observed mount list
had only `/data`; no credential overlay or key mount was active. The exact
nonsecret Compose template was copied to `runtime\original-compose.yaml`.
No application data, owner record, key, saved token or private repository was
read or copied to make the handover.

The owner was already claimed before the accepted rollout. The rollout
preserved the original owner/data; image updates do not create a new owner.
Do not claim an unexpectedly unclaimed instance as a repair. Investigate the
original mount and identity first without discarding their contents.

The app listens only on `127.0.0.1:4173`. Keep this host and port, not
`localhost`, a new port, or a replacement browser profile. Host checks and
browser-held directory grants make those changes meaningful.

The immediate rollback tag is:

```text
citadel-ui:rollback-before-native-workspaces-4379522c-20260910
```

It identifies the prior `4a3674f3` export-controls app:

```text
sha256:6555b2fa9bd8da0cc72bb6045bccb2d5e950531688e75ddee06aadb1b3eaed41
```

The rejected native v1 is retained for counterexample reproduction only:

```text
citadel-ui:native-workspaces-a8e5c45d-0458fb4f178e-v1
sha256:46c7810ccc94a2468235a8ea064a44f3f803643ad46b894eb4e3b8bd034767d8
```

Do not run the rejected v1 as the user's application. A retained rollback image
is not proof that old code understands all newer stored state.

The current branch's application README is newer than the embedded README in
the running image because `b8206f17` is documentation-only. This is intentional.
`CitadelUI\README.md` is a Docker input, so a future source/build hash changes
even though application logic did not. Do not rebuild or restart for that.

## 5. Product intent and decisions to keep

| Decision | What it means for future work |
| --- | --- |
| Desktop scope | The user explicitly excluded mobile work from the requested UI review. Narrow checks in a report are bounded observations, not a new mobile roadmap. |
| Established visual style | The user approved the Citadel masthead, blue area rail, typography, ruled surfaces and standard controls: "love it, use it always." Keep synthetic demo warnings explicit and developer controls secondary. |
| Actual shared controls | Terraform mapped views must use the real Bicepparam components across Deployment, LLM and Access, not merely a similar theme or a flat Path/Value dump. |
| Independent native workspaces | Bicep and Terraform are separate editing formats, each functional without conversion or a pre-existing other-format workspace. |
| Connections versus attachments | One saved GitHub connection may serve both formats. One local folder attachment belongs to one workspace; another local workspace needs a distinct, nonoverlapping folder. |
| Local external edits | Simple Cancel / Back up and overwrite at Review/Save. Back up the *current external disk bytes*. No new watcher, periodic reload, general merge or rebase. |
| Local creation | Explicitly allowed with conflict checks and a documented optimistic-concurrency limitation, not forbidden merely because browser creation is not atomic. |
| Diagnostics | Direct unlinked `/debug`, instance-wide, off by default, one fixed 30-minute activation, bounded safe fields and manual report download. |
| Source copying | Ask for the new child-folder name; do not force a random name. Public starter source defaults to upstream `citadel-v1`, not `main`. |
| Migration | Generic older values into parameters already assigned in the new Bicep target; main-page Migration preview, selected-only highlighting, provenance, Undo and independent area/target drafts. |
| Terraform export | Optional experiment from saved Bicep values to only generated target-relative ZIP files. Do not change ordinary authoring/save behavior or invent extra wrapper/contract directories. |
| Publication | A request to build, commit locally and run is not authorization to push, open a PR, merge `main` or deploy to Azure. |

Historical decision records sometimes say native editing was only proposed.
That was true during the `f3a19af` assessment, not now. Native editing is
implemented and accepted at `4379522c`; retain the history without reviving
obsolete readiness language as the current product state.

## 6. Work completed in this orchestration

The following are outcomes and attribution, not tasks for the successor:

| Commit / milestone | Result |
| --- | --- |
| `1684b42b` and `5e143f28` | Earlier migration implementation and archive-safe predecessor handover, already inherited on arrival. |
| `246c03c` | Desktop interaction fixes: mouse picker actions, field-commit focus, token-help return, visible focus, correct owner-form error focus, differences-first matching, live search, storage copy and Local progress. |
| `1978dda`, `667ee2c` | Updated desktop documentation/screenshots and safe local image-update/recovery guidance. |
| `03f4d429` | Migration visibly designated Experimental without changing migration behavior. |
| `b723625`, `08652cdd` | Named local source snapshot creation and correction of the queued-close/reopened-dialog race. |
| `1037bb8`, `4e5cec2d` | Terraform ZIP exporter and TF1 correction blocking lossy later-backend custom model metadata. |
| Styled roundtrip | Forty parameter edits, five new Access contracts, nine reviewed saves/reloads, and five actual ZIP downloads checked against intended source. |
| `d67d3b55` | Approved visual language applied to actual owner sign-in/claim and workspace frame. |
| `e2ca8149` | Contract creation refreshes both contracts and file catalog; five creations show 5 -> 10 without a reload. This is the latest observed published session-branch commit. |
| `4a3674f3` | Actual Bicepparam controls throughout Terraform export; saved-source options restricted to real parameter inputs. |
| `0c196aef` | Independently accepted timed instance diagnostics. |
| `54fe1c5a`, `a8e5c45d` | Native workspaces, then combined native/debug candidate. That combined v1 was independently BLOCKED by N1/N2. |
| `4379522c` | Corrected native advisory handling and staged/locked editor loads. Focused independent reacceptance closed N1/N2. Integrated and run locally with original data and rollback preserved. |
| `b8206f17` | Professional documentation refresh: eight documents and four refreshed/new illustrations; integrated locally, with no rebuild or restart. |

The user's original missing Main saved-source incident was not reproduced.
Filtering non-parameter source options was corrected, but that is not proof of
the original incident's precise cause or universal resolution.

## 7. Native workspaces: architecture and behavioral boundaries

Format and transport are separate axes. This is not an HCP Terraform
connection, Terraform CLI workspace, state backend or inverse exporter.

| Area | Native root | Selected operator input |
| --- | --- | --- |
| Deployment | Repository root | `environments\<name>.tfvars` or explicit `.tfvars.json` |
| LLM | `llm-backend-onboarding\` | A selected `.tfvars` or `.tfvars.json` directly in the root |
| Access | `citadel-access-contracts\` | One or more separately bound input units in the root |

Each selected root requires its supported `variables.tf` / `main.tf` signature.
LLM and Access can stand alone without Deployment or Bicep files. Up to 24
units can belong to one workspace. Examples are not active inputs and
`.auto.tfvars` is not an editable target. Git-ignored local files may simply
not exist in GitHub.

Profile/unit IDs, format, native root, selected alias, syntax, repository and
actual working branch are authority, not mutable display metadata. A missing
legacy format descriptor means Bicep in memory; it does not justify rewriting
old IDs or relabelling their history. Future unknown descriptors are refused.

Only selected nonsecret operator files are writable. Relevant root schemas,
bounded module/configuration dependencies and conventional shared Access XML
are read-only and rechecked around review/write. State, plans, credentials,
`.terraform`, unrelated values and provider/backend/output files are not
generic write targets. The azd subscription environment bridge remains
Bicep-only.

Missing, explicit null, inherited defaults and explicitly copied defaults are
different. Opening an absent input writes nothing. Explicit creation starts
with the user's reviewed supplied values, not a copied example or automatic
materialization of every default.

Native typed controls use native field names and types, for example
`llm_backend_config`, `backend_id` and `supported_models`. Bicep UI components
are shared, but Bicep semantics and runtime assumptions are not.

Native Access policy edits own the selected service's literal `policy_xml` span
inside its operator input. Shared conventional XML is inspection-only.
An empty policy literal can select the pinned configuration's default through
`.tf` behavior; the editor does not evaluate that behavior. `file()` is invalid
inside `.tfvars`, though valid in the appropriate `.tf` configuration. XML
checking is bounded syntax/tag balance, not APIM runtime validation.

Nonsecret parameter drafts carry source/native identity in browser storage.
Eligible policy buffers and per-unit selections survive in-app Settings/catalog
navigation. Changed source/schema identity can quarantine a draft rather than
apply it. External raw XML buffers are not promised durable across page close;
in-app draft preservation is not multi-tab synchronization or a reboot guarantee.

One GitHub connection can serve multiple profiles and formats. Each profile
retains its own repository/branch/unit authority. Overlapping writable native
files cannot acquire a second owner on the same actual branch through another
connection. Disjoint units still share one branch head: a commit can invalidate
another review without deleting its draft.

### Whole-file sensitive-source handling

Known sensitive content in an operator *or dependency file* blocks ordinary
native read/review/save/backup/history, even if the requested edit touches a
different nonsecret parameter. A whole-file backup or commit would otherwise
carry the hidden material. Hiding a UI field is not sufficient.

Empty/null slots remain allowed. The exact public PII placeholder in the pinned
schema has a narrowly scoped schema-default exception, not permission to put
it or a real credential into the operator file. QA emptied only its disposable
operator placeholder for valid save cases; it did not weaken the source guard
or alter the retained upstream schema.

Detection is conservative, not universal secret discovery. Citadel does not
silently delete source secrets or encrypt arbitrary source files.

### N1 and N2: preserve the failure and the corrected contract

N1 promoted native unevaluated-validation and unconsumed-variable warnings to
errors after editing, making valid real-schema inputs impossible to review.
The v2 format-scoped fix preserves their severity and language through
classification, toolbar and review. Actual type/value, sensitive-file, scope
and stale-dependency errors remain blocking. Bicep classification is unchanged.

N2 left the predecessor editable while another unit loaded. A late accepted
edit could be present in durable operations while an older stash was restored
in the visible UI. This was a draft-loss/view-reversal boundary, not evidence
of irreversible durable deletion. Do not simplify the original finding into
a claim the reviewer did not make.

The v2 fix disables predecessor parameter, policy and navigation controls
before the first awaited load, gives a nearby loading notice, stages document
and draft reads before publishing selection, and uses captured-generation
handling on failure. It also prevents field-commit repaint from detaching the
navigation click. Dialog-owned `inert` remains separate from real disabled
controls.

The independent counterexample deliberately delayed only the owned
`second.tfvars` `getFile()` call and tried normal, non-forced input. On v2 the
late fill was refused; return, cancellation, source-read/draft-read failure,
Settings/catalog isolation and ordinary reviewed save/reload preserved agreement.
A single area click without prior Tab committed the text typed before navigation.

## 8. Parser, exact bytes and runtime packaging

Pinned build-only parser dependencies are:

| Dependency | Version | License |
| --- | --- | --- |
| `web-tree-sitter` | `0.25.10` | MIT |
| `@tree-sitter-grammars/tree-sitter-hcl` | `1.2.0` | Apache-2.0 |
| `tree-sitter-json` | `0.24.8` | MIT |

Vendored runtime JS, WASM and licenses are reproducibly built; normal runtime
uses no npm, CDN or network parser. Three WASM resources load same-origin as
`application/wasm`. CSP adds only `'wasm-unsafe-eval'` to same-origin script
policy, not JavaScript `'unsafe-eval'`, wildcard/Blob origins or new services.

Native values use bounded literal HCL/JSON CST spans, exact numeric lexemes and
source-preserving edits. Unicode/CRLF positions, comments and unrelated bytes
are preserved where outside the owned edit span. A whole-value replacement
does not promise to preserve comments inside the replaced span.

Known boundaries include 512 KiB source, literal depth 64, schema type depth
32, 100,000 CST nodes, traversal depth 320, 300 ms parse deadline, 1,000 edits,
1,024-character numeric lexemes, 150 dependency files / 4 MiB, and local
inventory depth 12 / 20,000 entries. Read the current source/reference before
changing a limit; these are not evidence of Terraform evaluation.

The selected HCL grammar does not handle every valid numeric spelling.
Integer-mantissa exponents such as `2e30` and some leading-zero spellings are
preserved read-only, not falsely called invalid Terraform or normalized behind
the user's back. Decimal-mantissa and explicit JSON exponent cases have
separate accepted coverage. The pinned Access example's stray dot is a
different genuine source syntax error.

Independent `python-hcl2 7.3.1` was a comparison reader, not the browser writer
or a precision oracle. Its universal-newline treatment did not alter actual
source bytes. Old parser virtual environments are not packaged or a runtime
dependency.

The accepted image runs Node `22.14.0`, UID 10001, with no npm runtime.
Host-side reported runs used Node `v24.10.0`; do not conflate those environments.

The source identity convention is `citadel-build-inputs-path-sha256-lf-v1`.
Hash actual materialized committed-worktree bytes, including their line endings,
for the tracked Docker inputs: application README, Dockerfile, `.dockerignore`,
server/shared code and web assets. Sort Windows-style repo-relative paths
case-sensitively by code unit. Concatenate UTF-8 records of
`path<TAB>lowercase-file-SHA256<LF>`, including the final LF, then SHA256 that
concatenation. Dockerfile and `.dockerignore` have no `/app` counterpart.
Compare actual runtime files separately. Keep the revision and both
`io.citadel.source-sha256` labels with the image. Retained receipt helpers are
branch/tag guarded; adapt a new copy for future work, never overwrite old proof.

## 9. Save, overwrite, creation and recovery

Local Save writes original files on the browser's computer through its retained
directory handle. `/data` contains app metadata, transaction journals and
verified backups, not a mounted editable repository.

Existing-file external conflict handling is deliberately simple:

1. Detect that current disk source differs from the loaded version at Review/Save.
2. Offer Cancel or Back up and overwrite.
3. Cancel retains drafts and writes nothing.
4. Confirmed overwrite first backs up the current external version.
5. Backup failure, another external edit, stale dependency or invalid authority
   stops writing or requires renewed review/consent.

Do not add periodic watchers, silent reload/rebase or unchecked force to this
contract. Existing-file overwrite does not permit adopting a foreign file at
a new-creation path.

Local creation was explicitly accepted as optimistic. Absence/content/mtime and
dependency checks plus an exclusive stream where available are not OS-level
atomic create-if-absent. The user must see the warning and keep the folder
untouched. A detectable collision is refused; a simultaneous foreign empty-file
creation cannot always be distinguished.

A confirmed creation can offer ownership-aware History > Undo creation while
its exact bytes/dependencies match. An uncertain creation cannot be adopted
or deleted merely because present bytes match a planned file. Recovery may
need the user to preserve/move an unconfirmed file and return the target to
absence. Never invent authority by deleting it automatically.

Local journal states include `preparing`, `authorized`, `committing`,
`committed`, `reverting`, `rolled_back`, `failed` and `abandoned`; the recovery
flag matters. Multi-file rollback is attempted only where ownership/source
receipts justify it. A lost response is reconciled with the journal; a confirmed
commit is not blindly undone. Foreign state or uncertain receipts retain an
explicit unresolved recovery record.

GitHub uses atomic blob/tree/commit/non-forced-ref transactions, not Local
backup files. The default working branch is `citadel-ui/<environment-id>`;
direct writes to the selected branch are an explicit opt-in. The source branch
and actual write branch must not be mixed up. History undo appends an inverse
commit; it does not reset/force-push. An indeterminate result may already have
landed, so follow reconciliation rather than retrying blindly.

Native lost-handle recovery remains a limitation. Renewing permission on the
retained original handle is different from losing it. Selecting a new handle
at the same displayed path does not restore the old identity, drafts or history.
Preserve the old record. A new workspace requires a new identity and permitted
source ownership, potentially a deliberate separate operator-managed copy.
This is not recovery of the old draft. Do not clear registries or weaken
identity checks to make Reconnect appear successful.

## 10. Terraform export, migration and source creation are separate

### Terraform ZIP export

The pinned target is `Azure/terraform-ai-gateway-landing-zone` at
`b54f121b7df912da61cb0302a63b9f870841ac2c`; mapping contract
`citadel-terraform-export-v1`. Use the retained local copy, not repeated
downloads of the same public files.

Analysis matched Azure service/resource behavior, not only similar parameter
names. It covered 98 assigned Deployment, 8 LLM and 17 Access Bicep parameters,
with reverse coverage of 113/11/10 Terraform declarations plus nested settings.
Counts describe that pinned assessment, not an invariant for every workspace.

Export reads saved Bicep values and dependencies, retains separate export-only
choices in memory, presents the actual shared typed controls and binding
statuses, and requires exact review/approval before a real ZIP download.
Approvals bind source/dependency hashes, mapping version, choices, paths and
generated bytes. Refused entry or invalidation retains ordinary drafts.

ZIP contents follow the upstream default structure, with no wrapper:

```text
environments\<environmentName>.tfvars
llm-backend-onboarding\terraform.tfvars
citadel-access-contracts\terraform.tfvars
```

The display above uses Windows separators; ZIP entry names use portable
forward slashes with that exact directory structure.

Only included produced files are present. No reports, manifests, copied
modules/repository, orphan XML, state or provider data are added. Policy XML
is an escaped literal within `policy_xml`, not a `file()` call in `.tfvars`.
Separate Access configurations are exported separately, not merged into an
invented multi-contract directory. Multiple services inside one configuration
are still supported.

The environment name is 3-24 lowercase letters/numbers/hyphens, excluding
reserved device names. Invalid names are refused, not silently changed.
Limits include three files, 8 MiB/file, 24 MiB total and 64 source dependencies.

Active unsupported semantics block. Inactive/default-equivalent cases can
remain exportable where equivalence is established. The pinned target does
not faithfully wire every Bicep feature, including aspects of session affinity,
logging, generated-name overrides and extended Access replication/rotation.

TF1 is a specific loss guard: the Terraform LLM consumer reads model metadata
from backend zero, then falls back to API version `2024-02-15-preview`, timeout
120 and empty inference API version. A model first appearing in a later backend
with materially different effective metadata must block export. Genuinely
absent/default-equivalent metadata can export. Later duplicates do not override
the first exact-case Bicep model occurrence.

The accepted real UI roundtrip used five contracts and five downloaded ZIPs.
The sales policy was edited to 900 tokens/minute and 30,000/month. Intended
edits were independently recorded before input, saved/reloaded and compared
with actual downloaded bytes. This was a synthetic source/consumer proof,
not a real Azure deployment or Terraform state migration.

### Migration

Migration remains Experimental and targets an existing current Bicep workspace.
Older sources may be Local files/folders, strict ARM deployment-parameters
JSON, or separately authenticated/public GitHub sources. An old donor is not
an editable workspace and need not satisfy the current compatibility signatures.

The user required explicit discoverable preparation, stored offline snapshots,
differences-first selection, backend-scoped matching, selected-only highlights,
old/current/proposed provenance, Undo, and independent area/target drafts.
Only parameters already assigned in the current target can receive imported
values. Old-only names are not inserted. Expressions, credentials and
incompatible/ambiguous values are not guessed or evaluated.

Complete Prepared sources survive loss of original source access until explicit
deletion. Refresh old source alone reacquires; failed refresh retains the old
copy and choices. Those stored source snapshots can be sensitive and are not
promised encrypted or suitable for a support bundle.

Local Apply uses reviewed backup/write guards. GitHub destinations are
preview/local-export-only for migration even when ordinary editing has write
permission. Reports/sanitized drafts are manual handoffs, not source commits.
Migration does not clone policy XML or infer cloud-resource outputs.

### Starter copies

Create local from Citadel source makes a full pinned public snapshot under an
explicit user-named child of an empty selected parent. Hidden entries and `.git`
count as nonempty. Verify all copied bytes before registration. It is not a
Git clone, script execution, deployment or old-value migration.

Pause/retry uses an attributable, memory-only record. Partial folders are kept.
Only unchanged attributable entries can be retried; no automatic cleanup
deletes unknown data. Reload/close loses that retry record. A failed or
unregistered import is not authorization to overwrite a new target.

New GitHub Repo is a separate Bicep-only private snapshot initialization flow,
not a fork, organization bootstrap or native Terraform starter. It validates
the complete source, pins its commit and copies supported files/modes/licenses.
Unsafe/incomplete trees are refused; workflow handling is explicit and Actions
remain disabled for review. Existing repositories are not overwritten.
Creation permissions are broader than ordinary editing, and the guide tells
the user to narrow/reconnect afterward. Do not request those credentials during
successor onboarding.

## 11. Timed diagnostics contract

Use the exact same-origin `/debug` route. It is intentionally absent from
normal application menus; being unlinked is not its access control.
Owner/session plus Host, Origin and Fetch-Site checks protect its APIs.

Capture is off by default. One explicit activation lasts 1,800,000 ms.
Server deadline enforcement uses the monotonic/wall-clock boundary and checks
read/ingest/export as well as scheduling. Reload, activity, repeated ON and
another tab do not extend the deadline. Manual OFF or expiry stops capture;
closing the page alone does not.

Connected signed-in browsers normally notice activation within about five
seconds. Sleeping, disconnected or crashed tabs may miss events. There is no
retroactive collection. The feature has real server/API/handled browser/window/
unhandled-rejection hooks; it is not merely a viewer toggle.

The latest bounded report stays in server memory after stop, until clear,
replacement or restart. Restart clears it and leaves OFF. A stopped download
is final; an active download is a snapshot. Download and sharing are manual,
not an automatic upload or external telemetry integration.

Only finite code-owned fields are constructed: categories, operations, codes,
known exception/module/location/method/route templates and generated
correlations/timestamps/counts. No raw messages, stacks, arbitrary URLs/paths,
headers, bodies, source/configuration values, labels, DOM or console dumps.
It is not a scrubber for the browser's original console.

Limits include 400 records / 131,072 compact event bytes, 16 KiB ingest bodies,
20-event batches and a 40-event browser queue. Static explanations and suggested
actions help interpret the safe codes. Known optional probes are distinguished;
unknown 404s remain errors. An empty report is not proof of instance health.

The accepted native/debug composition includes real failure-driven downloads,
sanitized event transport and private-clock exact expiry checks. The v2 review
carried expiry evidence forward because debug/server/CSP bytes were unchanged;
it did not perform another 30-minute wall wait. Never turn that into a broader
unqualified claim.

## 12. Documentation: what is current

Professional writer commit `b8206f17` updated:

```text
README.md
guides\using-the-control-plane.md
guides\deployment.md
CitadelUI\README.md
CitadelUI\BACKUP-RECOVERY.md
CitadelUI\SECURITY.md
CitadelUI\DIAGNOSTICS.md
CitadelUI\RELEASE.md
```

It refreshed owner claim/sign-in and native Deployment images, and added the
debug-OFF screenshot from retained accepted synthetic captures. Old historical
images were not indiscriminately deleted. Screenshots do not show real
credentials, private source repositories or deployed resources.

The guide is task-oriented; the app README retains technical boundaries.
The exact diagnostics schema/API, complete ordered local Compose update/rollback
procedure, and Azure fresh/reuse sections were preserved. Obsolete
always-rollback, whole-file comment and no-egress claims were corrected.
Version prerequisites explicitly distinguish local accepted source from old
published `main`; do not remove that honesty merely to make clone instructions
look simpler.

Writer evidence covers 10 existing documentation tests, 98 local links,
14 image references, old/inbound heading fragments, 17 PowerShell blocks
parsed under Windows PowerShell 5.1, and three Bash blocks parsed without
execution. Parent reviewed the substantive diff/images and integrated it.
No application suite, new build, source acquisition, live fixture or restart
was part of documentation delivery.

## 13. Independent evidence and what it does not prove

The primary copied evidence is under `artifacts\review\`. Original reports
retain their original paths and historical recommendations; resolve those
paths through `artifact-index.json` rather than restoring archived sessions.

| Evidence | Interpretation |
| --- | --- |
| `ui-flow-review.md` and `desktop-fixes-independent-acceptance.md` | Original desktop interaction findings and their subsequent bounded acceptance. |
| `source-import-independent-acceptance.md` / `source-import-v2-independent-acceptance.md` | Local-copy flow and LS1 queued-close correction. |
| `terraform-export-independent-acceptance.md` / `terraform-export-v2-independent-acceptance.md` | Initial exporter, TF1 blocker, and corrected semantics. |
| `terraform-styled-ui-roundtrip-report.md`, `roundtrip-evidence-index.json`, `roundtrip-downloads-v93\` | Real synthetic authoring, five contracts, saves/reloads and actual downloaded ZIPs. |
| `login-shell-independent-acceptance.md`, `login-qa-evidence-index.json` | Actual owner/shell styling and retained browser/source evidence. |
| `catalog-qa-summary.json` | Coherent immediate contract/file catalog refresh. |
| `export-ui-qa-summary.json` | Actual shared controls in all export areas and exact ZIP bytes. |
| `debug-qa-acceptance.json` | Independent timed-diagnostic identity, finite-schema/privacy/auth/expiry proof. |
| `native-workspaces-independent-review.md`, `native-qa-acceptance.json` | Original v1 BLOCK, actual N1/N2 counterexamples, and unchanged native protocol evidence. |
| `native-v2-independent-review.md`, `native-v2-acceptance.json`, `native-v2-cleanup.json` | Focused v2 ACCEPT and explicit read-only release. |
| `artifacts\native\native-workspaces-handoff-v2.json` | Frozen corrected implementation/build receipt; not self-approval. |
| `artifacts\documentation\documentation-handoff.md` | Professional writer scope/provenance and ownership release. |

Original native v1 report SHA256:

```text
5d487000ee7af201894b8af24d4674367104ccac18fc8935cd076141fdab8db9
```

Focused v2 report SHA256:

```text
e9bb6c6d76e265689166b6daa280c3d0882e5054f2c9ba4167ab7db2e16b41cc
```

V2 writer handoff SHA256:

```text
1af5d393c5a9566cb152aa6b741447f9715b49eb8664c7265f9dff92708a8412
```

V2 actual safe debug download SHA256:

```text
67503fc336cfe66c061102be48219cc9dfdac274f91d116cc341b3b67fd97673
```

Independent v2 matched all 155 materialized build inputs and 153 image files.
Five runtime inputs changed relative to v1: app, validation, new editor-load
helper, CSS and loading HTML. The changed served responses matched; HTML
comparison allowed only the expected nonsecret bootstrap injection. Server,
shared parser/vendor, debug and CSP evidence carried forward.

Focused v2 tests were 56 cases, 55 pass, one inherited Settings source-regex
failure. The relevant unchanged Settings section hashes to:

```text
56a1b3f637f7a8c3b4b0e9f409d4729c30f1fb4349266fc97ebb3bbfc9ea569c
```

That assertion expects the retired inline `createEnvironmentForm()` call.
The writer's larger final group was 161 cases, 160 pass, the same known
failure. Original independent native groups were 126/125/one inherited
catalog regex and 113 integration passes. These counts overlap and are not
additive. No universal full-suite-green claim is available.

`AGENTS.md` contains earlier 490/489 and Playground 181/180 baselines. Those
are historical context, not current release totals. Its known primary-editors,
connection-profile flake and Playground golden-path disagreement are not new
work automatically authorized by this handover.

The reviewed GitHub native path used the actual production coordinator with
MockGitHub at the transport boundary. It is not live credential/connectivity
proof. OPFS handles are real browser handles used at an isolated picker
boundary; they do not establish native OS picker permission persistence.
Local parser/UI acceptance does not prove Terraform/provider execution,
Azure deployment parity, universal secret detection or a security certification.

## 14. Known unresolved items, not assigned work

| Item | Status and boundary |
| --- | --- |
| Native lost-handle reconnect | Documented identity/recovery dead end. Preserve old metadata/drafts/history; do not fake reconnection with a new handle. |
| Duplicate native decorators | Some controls repeat secondary Set null/Omit presentation. Nonblocking, not fixed by N1/N2. |
| Valid unsupported HCL numeric forms | Preserved read-only. Do not call them invalid Terraform or normalize them silently. |
| Public Access example stray dot | Genuine separate upstream syntax issue; no silent source repair. |
| Optimistic Local creation | Explicitly accepted limitation, not a newly discovered gate that justifies removing creation. |
| Original missing Main selector incident | Not reproduced; the narrower wrong-kind source filtering fix does not conclusively explain it. |
| Friend's Mac folder failure | Read-only investigation complete, incident attribution and native macOS proof unavailable. |
| Existing source-regex/baseline test failures | Retained and candidly scoped, not silently repaired to make totals green. |
| Live private/VNet deployment evidence | Read the deployment guide and original operator history; current local acceptance adds no Azure provisioning proof. |
| Public unclaimed-instance window | Existing intentional single-owner claim behavior, not fixed by this handover. |

The Mac investigation in `artifacts\mac\mac-folder-diagnosis.md` established
that normal `/Users/...` and `/Volumes/...` display metadata is accepted.
`~/...`, `file:///...`, quoted paths and breadcrumb text reproduce a format
error. In Add workspace it occurs after folder picking, so it can look like
an access error. This is not proof of what the friend entered.

It also recorded low-priority browser/server display-path validation timing/
length differences, a POSIX literal-backslash folder-name edge, misleading
secure-context recovery wording, and a separate legacy missing-display-path
Reconnect fallback. Those are historical findings at the examined revisions,
not proof that all persist unchanged after native work. No Mac fix was made.
Do not blame Safari without evidence or recommend broad filesystem permissions,
insecure browser flags or resolving Mac paths through the container.

## 15. Code map for the next explicitly assigned task

All paths below are under `CitadelUI\` unless stated otherwise.

| Surface | Files / directories |
| --- | --- |
| Format/unit authority | `shared\workspace-configuration.mjs` |
| Native CST/schema/workspace/review/drafts | `shared\terraform\parser.mjs`, `schema.mjs`, `workspace.mjs`, `review.mjs`, `drafts.mjs` |
| Offline parser assets/provenance | `shared\terraform\vendor\`, `tools\native-parser\` |
| Native shared controls and selection | `web\js\native-controls.mjs`, `native-workspace-selection.mjs`, `workspace-view-state.mjs` |
| N1/N2 integration | `web\js\app.mjs`, `validation.mjs`, `editor-load.mjs` |
| Captured workspace contexts and registry | `web\js\workspace-service.mjs`, `workspace-context.mjs`, `registry.mjs`, `api.mjs` |
| Local writes and recovery | `web\js\directory-provider.mjs`, `transaction-client.mjs`, `mutation-coordinator.mjs`; `server\transactions.mjs` |
| Server profile/native GitHub authority | `server\registry-store.mjs`, `server\github\native-workspace.mjs`, `routes.mjs`, `workspace.mjs` |
| Actual reusable form components | `web\js\fields.mjs`, `paramview.mjs`, `llmview.mjs`, `policyview.mjs` |
| Export mappings and ZIP | `shared\terraform-contract.mjs`, `terraform-export.mjs`, `terraform-literals.mjs`, `zip.mjs` |
| Export presentation/session | `web\js\terraform-export-session.mjs`, `terraform-export-view.mjs`, `terraform-export-controls.mjs` |
| Saved-source classification | `shared\source-plan.mjs`; classify file kind before path-only contract matching |
| Diagnostics finite schema/guidance | `shared\diagnostics.mjs`, `diagnostics-guidance.mjs` |
| Diagnostics capture/API | `server\diagnostics.mjs`, `diagnostics-routes.mjs`, `server\index.mjs` |
| Diagnostic browser/page | `web\debug.html`, `web\css\debug.css`, `web\js\debug.mjs`, `debug-page.mjs`, `diagnostics-client.mjs` |
| Browser API/error capture seams | `web\js\local-api.mjs`, status/async handlers and app integration |
| Main tests | `test\native-*.test.mjs`, Local conflicts, transactions, registry/context, diagnostics, export and interaction test groups |

`server\doclayer.mjs` and `server\bicepparam\*` are deliberate re-export shims
over shared code. Do not restore the deleted server filesystem editors or
create drifted copies. The application receives no source mount or Docker
socket; Local repository access belongs to the browser.

The root `bicep\`, `src\`, `assets\`, `shared\`, `validation\`, `scripts\`,
`azure.yaml` and `.env.template` are accelerator/product data. Do not
restructure them as if they were this UI's application source.
`CitadelSamples\` is a separate experimental application. Do not repair its
golden-path disagreement as incidental UI work.

## 16. Evidence and workflow lessons that cost real time

1. Use the exact user interaction as the acceptance criterion. A button that
   works with Enter but not a mouse click is broken. Tab-first automation can
   hide the single-click repaint race. A CSS appearance is not a disabled
   control; a forced fill is not a normal user action.
2. Read the real pinned schemas and consumers. Synthetic field counts missed
   N1. A plausible mapping or matching name does not establish that a module
   consumes the value. A downloaded ZIP must be inspected as actual bytes.
3. Keep source, draft, selection and approval bound to captured identity across
   awaits. Global mutable context and early selection publication created N2.
   Durable/UI disagreement must be described accurately before fixing it.
4. Do not replace the requested component reuse with a lookalike. The user
   repeatedly clarified that the Terraform presentation must use the actual
   shared controls in all three areas. A styled flattened dump was insufficient.
5. Separate harness errors from product defects. Several attempts needed
   corrected selectors, fixture whitespace, dollar escaping in an oracle,
   normal HTML bootstrap handling or correct Settings navigation expectations.
   Retain the original failure, label the harness correction, and rerun the
   genuine interaction without direct save calls or reseeding away a failure.
6. A self-check is not independent acceptance. Freeze source and one matching
   image, release implementation/build ownership, then let the reviewer own
   its scope. Correct only after explicit reviewer release. Do not mutate a
   frozen candidate underneath review or run competing writers.
7. Distinguish OCI index, runtime manifest and config digests. A reused tag
   or `1.0.0-local` label is not identity. Windows materialized line endings
   affect source hashes. Static HTML differs from served bootstrap HTML for
   an expected reason, not because arbitrary differences can be ignored.
8. Preserve current external bytes before a confirmed overwrite, not stale
   loaded bytes. A matching newly present file is not proof of creation
   ownership. Do not convert a concurrency limitation into unchecked force
   or universal rollback claims.
9. Use named visible app sessions for all AI delegation. No hidden task agents,
   internal nested helpers or factories that hide their workers. Ordinary
   shells/builds/dev servers are not AI workers, but still need ownership.
10. After a restart, old PIDs and CDP handles are historical. Reidentify an
    owned process before stopping it. Never kill all Node, Edge or Docker
    processes to clear a port; other projects are concurrently active.
11. Do not start from stale canonical `main` or an accidentally old new-session
    checkout. Preserve code with local refs/bundles and verify actual HEAD.
    The analysis session's app branch label was stale; Git says
    `citadel-terraform-analysis`. Its inherited remote tracking is not a
    reason to merge unrelated published changes into the analysis.
12. Loading context is not permission to implement. The earlier successor
    needed an explicit visible receipt; sending a kickoff alone was not proof
    of successful handoff. Have the new orchestrator say what it loaded and wait.
13. Archive artifacts before archiving the session tree. Reports that reference
    old `session-state\...\files` paths need an archive-safe mapping. Do not
    preserve private data by accidentally copying a whole fixture data root
    or browser profile. Public fixtures and sanitized downloads suffice here.
14. Be precise about status to the user: proposed, reproduced, fixed, frozen,
    accepted, integrated, locally running, published and handed over are not
    synonyms. A known limitation stays known until fixed or explicitly accepted.

## 17. Tests, Windows tooling and safe future deployment

The application has no root `package.json`. Use existing Node test-runner
groups from `CitadelUI\`, not plain `node some.test.mjs`. Direct plain-Node
execution changes test context and can cause misleading data-root failures.
Broad `test/*.test.mjs` name-filtered runs still execute file top-level code and
have stalled. Prefer bounded existing file groups while retaining `node --test`
isolation, and escalate only when needed.

The inherited `**/test` ignore rule can silently omit new tests from commits.
Existing application exceptions are present, but verify new test files are
actually tracked. Do not add a new linter/test framework to obtain a green
headline, or rewrite known source-regex assertions unrelated to the request.

Use Windows paths and Windows PowerShell 5.1-compatible orchestration unless
the actual command requires PowerShell 7. Shell calls do not preserve working
directory/environment automatically. `&&`, `||` and `??` are not available in
this session's PowerShell. Native process failures require an exit-code check.
Keep dependency installation bounded to a genuine changed/missing dependency.

The Git credential helper is additive. Past authorized pushes needed the
`taomar` account rather than the system-selected `taomar_microsoft`. Do not
print a token, put one in a handover/script/commit, permanently rewrite shared
credential configuration, or treat a misleading Repository not found as proof
the application repo is wrong. No push is required now.

For future authorized local rollout, follow `guides\deployment.md`, not a
shortened remembered command. Use the already built and accepted image with
the complete original ordered Compose override list, original data directory,
host/port/environment settings and any already-enabled key mount. Use
no-build/no-pull activation, retain rollback and notify before restart.
Do not enable `compose.credentials.yaml` simply because it is checked in, and
never generate/rotate a key during an image-only update.

The source checkout in the permanent repo is advanced for the same-branch
handover without recreating the running container. A checkout change is not
an application rollout. The copied original Compose template and runtime
manifest preserve what is actually active.

Azure deployment lives in `CitadelUI\`. Root `azd up` deploys the gateway,
the wrong product. UI operator inputs are `CitadelUI\infra\main.bicepparam`.
Key initialization preserves the existing encryption key; create/reuse and
private-network guidance have their own evidence limits. Existing resources
must not have shared network/logging/auth settings relaxed incidentally.
Read current deployment/security docs before any privileged action.

## 18. Released sessions and archive boundaries

The following app-visible session IDs are historical ownership references.
All were observed idle, with clean source worktrees and no pending input/plan
at the handover. Prior implementation/review receipts explicitly released
their scopes. None needs another task just to finish this handover.

| Role | App session ID | Frozen head / state |
| --- | --- | --- |
| Technical writer | `f0e1865c-90b8-4842-8858-85ffe7740dde` | `b8206f17`, released |
| Independent reviewer | `d8ddc8eb-2a6c-464f-876c-3f4d3043a317` | `4379522c`, v2 ACCEPT, released |
| Native Dev | `41de805f-97b7-4cee-a0ce-3a6ae4a81892` | `4379522c`, released |
| Debug Dev | `c1ab8809-e0b0-4ef7-b3df-b9215133b251` | `0c196aef`, released |
| Desktop/export-control Dev | `87a7d912-5dda-4f49-a351-d81cb384c31b` | `4a3674f3`, released |
| Terraform analysis | `2ae7bb6c-6dab-41b4-9cc5-d604c515089a` | `f3a19af`, released |
| Original export Dev | `2f7b1b03-bcca-4aa3-9ead-67ae39416490` | `4e5cec2d`, released |
| Owner/shell Dev | `55a14359-1bf3-44f3-addc-d77c3d634351` | `d67d3b55`, released |
| Local source Dev | `1136f0b9-ae9b-4343-9c3e-500aabb0c91e` | `08652cdd`, released |
| Mac investigator | `b46acab3-a63c-49cc-aab8-3d74ea8b1bf2` | `03f4d429`, read-only release |

Completion notifications sometimes use different internal UUIDs, for example
the writer `b1732dae...`, reviewer `e34c6172...`, and native Dev `0862b9a0...`.
The table uses the IDs returned by the app session listing. Historical links
are not dependencies: use the copied artifacts after archival.

Outgoing orchestrator app/state ID:
`84ec047f-8a07-4c0e-b442-f7d0c61a7332`; an earlier project-session surface also
used `27424e71-5963-4111-b97e-276b5189f035`.

The new orchestrator is explicitly detached from this old tree. Its actual ID,
openable app URL, permanent checkout, same branch and receipt are in the final
durable records. The user may archive the old tree after the confirmed handoff;
the successor does not need to restore it.

Only the production `4173` listener was present among the relevant Citadel
ports at the handover observation. Old demo `47163`, styled demo `47193` and
the listed native/review ports had no listener. Open canvas tabs for those
demos can therefore be stale. Do not revive them automatically or mistake
their unavailable pages for a production incident.

The running Docker app and permanent `/data` directory are not attached
session-owned dev servers. The handover did not restart, retag, rebuild,
reconfigure, stop or remove them. No other project's active sessions/processes
were touched. App-source history, public fixtures, copied evidence, images,
documentation and learning are preserved outside the old tree.

## 19. Successor's first reply

After actually reading the specified documents, state briefly in the new
session that the handover is loaded, name the repository and continuing branch,
distinguish current application `4379522c` from documentation `b8206f17`, and
confirm awareness of the current runtime, archive-safe artifacts and main
constraints. Send the one requested receipt to the outgoing orchestrator while
it is still available. Then end the turn and wait for the user's instructions.

Do not create a PROJECT_BRIEF, mutate AGENTS, spin up a team, clean a checkout,
run tests or "finish" the known limitations as part of that acknowledgement.
