# Desktop UI improvement plan

## Decision and source

The user authorized implementation of the UI review's findings and
recommendations on 12 September 2026, with compatible changes combined into
single sessions. This supersedes the review-only restriction for this queue.
The work remains desktop-only and limited to the Citadel Control Plane.

The reviewed application revision is
`08fa39d4fac540ccfa43b5f1260a7330179c6bbe`. The subsequent MAIN revision
`fbd68b136a49d1d7cf7671ac36b5adaf5c486c9f` changes orchestration instructions,
not the application. Initial implementation assignments started from
`4fd705771a96fa033ae4b3ec48edc39743a91766`; each later assignment names its
own exact review or integration source.

The first review is accepted as actionable evidence, not exhaustive
verification: 22 components, 477 control/action/state families, 16 findings
and 10 recommendations. It left 22 feasible interactions without executable
coverage; nine external/manual gaps remain explicit. The existing full-suite
run had 24 failures, not all independently established as pre-existing.

The coverage follow-through is accepted locally at `f4754d8`. All 22 controls
now have executable evidence. The initial oracle recorded 21 verified controls
and the settled policy-outline mismatch `COV-POLICY-01`. Follow-up native evidence
confirmed the existing reading-position behavior: `aria-current` tracks the
reading band, while the saved destination and heading focus describe the
explicit jump. MAIN retains these separate contracts rather than pinning the
reading marker. The earlier failed-oracle evidence remains preserved; both
contracts must be checked with the final shell. MAIN independently reviewed
the nine test/fixture changes and
replayed their Node and native desktop checks. This closes the coverage handoff,
not overall product acceptance or the nine external/manual limits.
The acceptance record is `ui-coverage-main-acceptance-01.json` in MAIN's
artifact directory.

Inputs/export is independently reviewed and accepted locally at `569ef21`.
This covers F02/F04/F08/F10, the shared invalid-field helper and its export
callers, exact numeric drafts, explanation normalization and export stage
position. MAIN also checked the actual reviewed ZIP bytes and retained coverage.
The ordinary editor's R04 first-invalid-field consumer is independently verified
on shell source `f5b5b3d`, not inferred from producer-only tests. It remains a
regression gate for the corrected composition. The input disposition is
`ui-input-export-main-acceptance-01.json`.

The independent review of shell candidate `f5b5b3d` identified six follow-up
findings: SH01 skip-link navigation, SH02 breakpoint IME
composition, SH03 notification focus, SH04 retired filter callbacks, SH05
obsolete-source attribution and SH06 humanized-label collisions. The original
shell owner returned their correction together with the separately assigned
`MODEL-FOCUS-R01-01` at exact candidate `da51017`. MAIN verified its five unchanged
prerequisite incorporations and two manual commits over `d9a564b`. Only the app,
new shell regression file and appended model-mutation tests differ; all original
26 model-focus cases remain byte-identical. The writer handoff is closed.
The independent shell re-review now accepts SH01-SH04 in scope. Two narrower
gaps remain: an already-visible generic source error loses its evidence after
replacement-source success, and independently suffixed contract labels can
still collide. These are `UI-SHELL-CORR-R01-01` and `UI-SHELL-CORR-R01-02`;
neither report alleges wrong-source writes or lost source bytes. The fresh
`UI-shell-final-corrections` task starts from preserved candidate `e697985`.
Recovery is integrated locally; model and final combined acceptance remain
separate gates.
The initial recovery and policy/model candidates are not accepted by their
presence in the shell's review candidate.

Policy/model component correction `4dec00c` is now independently reviewed and
accepted for all three correction findings. Complete policy representations,
byte-preserving guided edits and component-scoped model focus are covered.
The actual app focus-owner consumer at `54358bd` completed independent review.
The original Raw/read-only export mutation finding is independently resolved
at `da51017`. Re-review found a separate shared object-batch quarantine/painting
gap, `MODEL-FOCUS-R02-01`. Its precise correction returned at `e697985`, retaining
the entire prior 46-case file and adding twelve batch cases. Independent model
review-03 approves that frozen candidate. MAIN verified the exact source,
runtime bodies, preserved evidence and all 58 consumer outcomes, then replayed
those consumers and the mandatory cancellation itself. No model/batch finding
remains; compatible application integration is still pending.
The component disposition is `ui-policy-model-main-acceptance-01.json`.

The three shell test adaptations are accepted at endpoint `2a9afd5`: actual
migration-command execution, bootstrap-safe breakpoint behavior and the exact
pending-status contract. MAIN independently replayed that composed endpoint
without weakening existing assertions. This is test-only acceptance, not
approval of the underlying shell or recovery candidates. The pending-status
adapter is now integrated with recovery; the two shell-only adapters still
await their compatible application source. The disposition is
`ui-shell-adapters-main-acceptance-01.json`.

Recovery through `432a360` is independently accepted and integrated locally.
WR03 now preserves registry/provider-construction failures without claiming
folder or file recovery is needed. WR01/WR02/WR04 retain their reviewed evidence
and limits. MAIN checked all 23 integrated paths, the exact partial status-test
adaptation, the unchanged 15-case composed recipe and the full 27-case R3,
34-case correction and 29-case recovery groups. The six remaining selection
failures also fail on pre-integration MAIN `3938bf1`, with matching causes;
this is not an all-green application claim. The detailed dispositions are
`ui-recovery-main-acceptance-02.json` and
`ui-recovery-main-integration-01/acceptance.json`.

MAIN verified the returned source identities, scopes and preservation, then
reused three idle workers for the shell correction and two independent reviews.
`ui-returned-candidates-main-intake-02.json` records the exact handoffs.

MAIN also recorded an isolated full Node baseline at the exact pre-correction
composition `d9a564b`: all 768 source files match the immutable Git object.
The run has 2,391 entries, 2,346 passes, ten failures and 35 skips. Eight
non-fixture failures have been independently classified against accepted MAIN:
six are prior registry/structural-test disagreements, one is the newly mismatched
Diagnostics entry contract and one is a Windows full temporary-path limit.
The six prior disagreements remain outside this correction. The unchanged
receiver passes with a measured 252-character path instead of the failing 265;
no product, infrastructure or OS setting was changed.
This comparison does not replace corrected-shell or final desktop acceptance.
MAIN's independent full returned-candidate replay has 2,429 entries, 2,384
passes, the same ten failing case names, 35 skips and no cancellations.
All 18 shell correction, 26 original model-focus and 20 new model-mutation
cases pass. All 769 candidate source files remain unchanged. The failure-name
comparison is supplemented by that cause classification and the returned
independent desktop review; the candidate is not yet integrated into MAIN.

Diagnostics test/documentation alignment `af36085` is independently accepted
in its four-path scope. It retains the supported header entry, public owner
bootstrap, protected APIs and all existing capture/transport controls. MAIN
verified all original bootstrap assertions and eight other server tests
unchanged, then replayed the exact candidate. All ten required server/cancellation
cases and 25 additional shared-diagnostic cases pass; the two known fixture
admissions remain. Current MAIN has no Diagnostics header entry, so this accepted
test/docs change must integrate with its compatible shell source rather than
creating an inconsistent intermediate application.

The original report, screenshots, exact results and unsuccessful attempts remain
preserved outside worktrees in:

```text
C:\Users\tarekomar\.copilot\session-state\ed142fd6-9404-4a29-b26b-cdf31a456e67\files\ui-functional-ux-review-01.artifacts
```

MAIN's acceptance is recorded in `ui-review-main-evidence-validation-02.json`
in the parent artifact directory. It checks preserved files, source references,
physical execution records and actual ZIP bytes. The first validator's overly
strict per-case source-pin assumption is preserved separately and explained.

## Five consolidated workstreams

Four implementation sessions and the reused independent reviewer share the
work. These are compatible groups, not one session per finding.

| Workstream | Findings and recommendations | Product ownership |
| --- | --- | --- |
| Inputs and export | F02 unchanged export drafts; F04 blank integers; F08 export review position; F10 explanation artifacts. R04 validity and draft semantics; export portions of R05; field portions of R09/R10. | `fields.mjs`, `native-controls.mjs`, `editor-focus.mjs`, `paramview.mjs`, `explain.mjs`, `dom.mjs`, `terraform-export-controls.mjs`, `terraform-export-view.mjs`, and `terraform-export.css`. |
| Shell and navigation | F01 search/caret; F06 draft-owner prompts; F09 stale notifications; F12 command hierarchy; F14 contract labels; F16 PR labels. R01/R02/R03; shell, save and History portions of R05/R09/R10; shared presentation for R08. | `app.mjs`, `editor-document-session.mjs`, `document-action.mjs`, `history-entry.mjs`, `dialog.mjs`, `index.html`, `app.css`, and `components.css`. |
| Workspace and recovery | F03 removed connections; F05 catalog/diagnostics focus; F11 snapshot identity; F15 missing-source recovery. R07/R08; setup, migration and recovery portions of R05; diagnostics portions of R09/R10. | Catalog/list, workspace activation/context/settings, GitHub setup, owner gate, local-source import UI, migration wizard/snapshot/value view, diagnostics page, `debug.html` and `debug.css`. |
| Policy and model editors | F07 recognized-but-hidden policy value; F13 destructive action names. R06 complex forms and the corresponding R04/R09 requirements. | `policyview.mjs`, `policynav.mjs`, `llmview.mjs`, `llmschema.mjs`, and `CitadelUI/shared/policy.mjs`. |
| Independent coverage and regression | Close the 22 executable coverage gaps; repair directly related stale UI test adapters without weakening their assertions; independently review product candidates and integrated desktop behavior. | Test-only work and external review artifacts. No product edits and no self-approval of its test changes. |

The task assignments enumerate exact file ownership. Implementation sessions
add distinctly named regression files; the reviewer owns the specified existing
VM test-adapter repairs. No two workers edit a shared source or test file.
MAIN owns this plan, integration and directly related documentation.

After the coverage handoff was accepted and its writer released, the shell
owner received a narrow integration grant for VM dependency wiring and realistic
header/DOM context in `mutation-caller-outcomes.test.mjs`,
`native-classification.test.mjs`, `native-navigation.test.mjs` and
`contract-catalog-refresh.test.mjs`, plus delimiter/dependency wiring only in
`test\fixtures\ui-review\shell-harness.mjs`. It must first incorporate the accepted
coverage candidate, load the actual production helpers and retain every
assertion. The reviewer has read-only product-review scope during this work;
there is no concurrent test writer.

After the original shell writer released `f5b5b3d`, its first follow-up was limited to
unchanged recovery-correction incorporation and the two migration/catalog
structural test adapters. The returned policy correction `4dec00c` also needed
an explicit app consumer: a stable model-viewer focus token across context and
mount rebuilding. That two-file consumer was assigned to the released policy
owner while the shell follow-up had no manual product-edit grant.

The consumer writer and reviewer released `54358bd` before the shell correction
received sole app ownership for SH01-SH06 and `MODEL-FOCUS-R01-01`. Its narrow
additional test grant preserved all original model-focus cases. The shell writer
subsequently released `da51017` and the separate batch correction `e697985`.
A prepared late addendum was never sent after its guard found the completed
batch result. That completed task was not reopened.
The released original app-consumer owner now has sole app ownership for the
two remaining SH05/SH06 corrections, with bounded additions only to
`ui-shell-corrections.test.mjs`. The original model reviewer independently reviewed
frozen `e697985`; the complete 58-case model test file is not writable by the
shell follow-up. The model review is complete and accepted, as are Diagnostics
and baseline-classification handoffs. The remaining shell successor still needs
its independent review before final compatible integration.

The returned candidate incorporates the complete unchanged policy correction,
`54358bd` app consumer and `432a360` recovery correction over accepted test
endpoint `2a9afd5`, preserving each mapping and the clean `d9a564b` baseline.
Recovery is separately accepted. The returned shell and app mutation corrections
still require independent acceptance and compatible MAIN integration; no mutable
worker checkout is copied.

The user also requested Bicep and Terraform SVG icons. MAIN owns the original
assets in `CitadelUI/web/icons/`, the shared `formatIcon` renderer and its focused
tests. The existing shell, workspace and export owners integrate the same
decorative icons beside visible format labels; there is no additional worker.
These are original format symbols, not official vendor marks. Unknown formats
must not be presented as Bicep or Terraform.

## Implementation decisions

### Professional desktop shell

Use the existing zero-dependency application and Fluent-aligned tokens, not a
new framework or an Azure Portal clone. Separate a restrained persistent
identity/settings band from contextual workspace, document and source/write-ref
information. Keep Review & save stable and primary. Group existing experimental
commands under Tools without changing eligibility, consent or write behavior.
Do not invent SSO, cloud search, multi-account support or deployment status.

Keep command heights consistent at 1280, 1440 and 1920 desktop widths, make
workspace/file identity intelligible, and use a practical explorer rail.
Search results must update without replacing the focused input. Disambiguate
contract labels without renaming source files.

F14 also requires unique discovery identities for flat contract files: changing
the label alone does not fix opening the wrong source. The shell owner has a
narrow additional grant for `pathContract` and `contractMetadata` in
`CitadelUI/shared/citadel-core.mjs`. Non-main files retain their full relative
filename in the identity; conventional `main.bicepparam` folder identities and
the canonical template remain compatible. Deferred and parsed discovery must
agree, and mutation/undo/delete safety must remain intact.

### Explicit input and operation state

Blank is not zero. Preserve unfinished invalid input and show a field-level
reason; do not silently reinterpret it as omitted, null or a valid number.
Unchanged input and undo-to-original must not leave an invisible blocking draft.
Keep native numeric lexemes and literal policy escaping intact.

Cross-document prompts identify the actual draft owner and discard scope.
Review stages bring their heading and summary into view; Back preserves the
appropriate prior-stage state. Supersede only resolved operation errors, not
unrelated or still-active failures. Never present pending or indeterminate
outcomes as success.

### Safe recovery and readable complex forms

A removed connection must lead to explicit validated reattachment, not silent
binding to a different connection. Missing files must produce actionable
guidance without reconstructing them or losing retained drafts. Snapshot labels
must distinguish time/source/ref or revision and file count.

Unconfirmed reattachment has the explicit `Confirmation pending` label and
warning chip, not Ready. Its status contract adds the exact `pending` category
without weakening the labels or chip requirements for existing states.

Group model and policy inputs by identity, endpoint/authentication,
deployment/capacity and lifecycle. Keep advanced fields discoverable. A
recognized but unsupported guided value stays visible as inspect-only with a
reason rather than being coerced or hidden. Destructive controls have
target-specific accessible names and predictable focus after removal.

## Acceptance and sequencing

1. Close and preserve the original review handoff, then reuse its suitable idle
   session for concrete coverage and regression work. Start the four disjoint
   implementation bundles from the same pinned source. Five occupied sessions
   is the ceiling, including completed candidates awaiting review or cleanup.
2. Each bundle reproduces its findings, adds focused regressions, implements
   the complete in-scope behavior and returns a preserved candidate commit.
   Work outside the assigned ownership boundary requires a concrete MAIN
   integration request, not edits to another worker's files.
3. MAIN inspects each returned candidate and runs targeted baseline/candidate
   comparisons. An independent reviewer receives an exact product candidate
   for review and executable checks; MAIN independently reviews its test
   changes. Released implementation workers can be reused to review another
   owner's immutable candidate after their producer handoff closes; final
   code acceptance and integration remain separate MAIN gates. No self-review
   or completion label substitutes for acceptance.
4. Integrate compatible accepted changes as they become available. Shared
   validation/navigation interfaces and the final visual token application
   receive combined checks before final acceptance. One blocked bundle does
   not hold independent acceptance or ready work.
5. Verify the integrated desktop workflows, native typing/caret/focus,
   dialogs/menus, errors/recovery, source-byte preservation and representative
   screenshots. Account for every F01-F16 and R01-R10 outcome, the follow-through
   finding `COV-POLICY-01`, and remaining manual work in the final report and
   documentation.

Use the repository's complete quoted test glob from `CitadelUI` with bounded
selectors and a fresh owned TEMP/TMP. Preserve existing failure evidence;
do not weaken source/ownership/write-safety checks to obtain a green run.
Synthetic OPFS and simulated GitHub behavior do not prove real OS-picker,
credential-vault, cloud, live-GitHub or real-folder durability behavior.

Human Narrator, high-contrast, zoom/DPI and real-service UAT remain explicit
operator work where automation cannot establish the result. Do not claim
formal accessibility compliance or deployed resource correctness.

## Boundaries

No push, PR publication, deployment, production mutation, credential/account
change, gateway product-data edit or `CitadelSamples` work is authorized.
Cancelled resource/model refresh, optional refactors and recovery/watchdog
infrastructure remain excluded. Existing review, ownership, consent,
single-flight and archival gates remain in force.

Each actual assignment gets a fresh durable result path and exactly one
`RESULT_READY` callback to MAIN after publication and read-back. There are no
progress pings, timers, extra supervisors or new receipt/audit infrastructure.
Accepted artifacts are preserved before cleanup; only the owning worker changes
its worktree, and a session slot is released only after successful archival.
