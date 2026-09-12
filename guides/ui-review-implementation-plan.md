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
The ordinary editor's R04 first-invalid-field consumer remains a shell gate,
not a producer-only success. The detailed scoped disposition is
`ui-input-export-main-acceptance-01.json`.

The shell has returned the preserved candidate `f5b5b3d`, including its 25
owned changed paths and unchanged producer prerequisites. Its own changes
proceed to independent review without waiting for the four recovery and three
policy/model corrections. Those corrections, two reported structural test
expectations and final combined desktop acceptance remain separate gates.
The initial recovery and policy/model candidates are not accepted by their
presence in the shell's review candidate.

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

After the original shell writer released `f5b5b3d`, its follow-up is limited to
unchanged recovery-correction incorporation and the two migration/catalog
structural test adapters. The returned policy correction `4dec00c` also needs
an explicit app consumer: a stable model-viewer focus token across context and
mount rebuilding. MAIN transfers only that `app.mjs` slice and the new
`ui-model-focus-integration.test.mjs` to the released policy owner. The shell
follow-up has no manual product-edit grant, so these assignments do not overlap.
Both correction candidates and the new consumer still require independent
review; source composition alone is not acceptance.

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
