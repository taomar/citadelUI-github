# Product and UX research: executable Citadel Publish Playground

## Decision

Rebuild the current workbench as a notebook-like runbook, not as a notebook
authoring environment.

The source notebook is immutable. Its Markdown and code cells are visible,
selectable, copyable, and traceable, but never editable. The only editable
surfaces are generated parameter, configuration, confirmation, and secret cells
declared by the catalogue. Every effect follows the same sequence:

1. Select a sample and inspect its protected source cells.
2. Complete the declared editable cells.
3. Review the parameter and generated-operation diff.
4. Give a fresh, explicit approval.
5. Run one compiled cell or the complete sample through the allowlisted runner.
6. Inspect streamed output, assertions, artifacts, and durable redacted evidence.

This is the strongest product recommendation: **make the trust boundary visible
in the page structure**. Protected source, editable inputs, approval, execution,
and evidence must look like different kinds of cells. A general code editor or
terminal would erase the most important safety and provenance properties the
existing application already enforces.

## Research basis

The current product is a strong single-sample operations workbench:

- `playground/web/index.html` defines a semantic header, recipe navigation,
  selected-sample main region, context rail, skip link, and polite status region.
- `playground/src/view/models.mjs` already separates Guide, Configure, Request,
  and Response decisions and distinguishes needed values from user errors.
- `playground/src/core/state.mjs` keeps secrets in a closure-owned `Map`, omits
  them from persistable state, and invalidates acknowledgements after any edit.
- `playground/src/server/runManager.mjs` rebuilds plans on the server, limits
  concurrent runs, creates isolated workspaces, and owns cancellation.
- `playground/src/server/localExecutor.mjs` permits only catalogue-owned
  artifact, Azure CLI, HTTPS, registered Python, and assertion steps. It applies
  output limits, timeouts, cancellation, and redaction at the execution boundary.
- `playground/provenance.json` maps all 19 scenarios to notebook cells and records
  the exact imported notebook hash and byte count.
- `playground/test/catalogue.test.mjs` verifies the notebook bytes, shape,
  complete code-cell coverage, and scenario-to-cell map.
- `playground/test/markup.test.mjs` verifies focus, reduced motion, component
  states, responsive shape change, and narrow-width overflow handling.
- `playground/scripts/smoke.mjs` exercises the current real browser workflow.

The redesign should retain those strengths. The material product gaps are the
absence of an exact in-product source view, explicit input/plan diff, durable run
history, streamed stdout and stderr, artifact access, cell-scoped execution, and
unmistakable evidence labels.

## Non-negotiable product invariants

1. `CitadelSamples/citadel-publish-contract-tests.ipynb` remains byte-for-byte
   unchanged: SHA-256
   `ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb`,
   66,241 bytes, LF line endings.
2. The original notebook file is never used as a write target. "Download
   original" returns those exact bytes.
3. Source cells never become content-editable, textareas, or editor models.
4. Editable fields come only from the selected sample's normalized catalogue
   contract. The UI cannot add arbitrary arguments, headers, commands, URLs,
   scripts, environment variables, or paths.
5. The browser submits only sample identity, declared values, transient declared
   secrets, execution scope, and fresh approval. The server rebuilds the plan.
6. Secret values never enter source views, diffs, URLs, exports, logs, evidence,
   browser storage, run history, or artifacts.
7. Preview is never presented as execution. Offline checks are never presented
   as live-target evidence. A local runner is not necessarily offline.
8. Approval is bound to the current sample, execution scope, effective
   configuration, generated plan, target, and source hash. Any relevant change
   invalidates it.
9. "Run cell" never evaluates arbitrary notebook text. It executes only a
   server-owned, allowlisted plan slice mapped to that protected cell.
10. Every one of the 19 scenarios retains a stable sample ID and visible source
    cell citation.

## Product vocabulary

Use these terms consistently:

| Term | Meaning |
| --- | --- |
| Source cell | Protected Markdown or code imported from the exact notebook |
| Parameter cell | Editable, non-secret field generated from the catalogue |
| Secret cell | Editable secret field in the protected secret zone; memory-only |
| Generated cell | Read-only effective plan, request, or artifact preview |
| Evidence cell | Read-only streamed or completed output and assertions |
| Run cell | Execute the allowlisted plan slice mapped to the selected source cell |
| Run sample | Execute the selected sample's complete rebuilt plan in order |
| Preview | Generate and inspect without performing effects |
| Approval | Fresh consent for one exact configuration and execution scope |

Avoid "edit notebook", "run this code", and "terminal" on primary controls. The
product does not edit the notebook, execute its raw Python, or expose a shell.
Call the output surface **Runner transcript** and the boundary **Allowlisted
runner**.

## Information architecture

### Global frame

Retain the current three-region desktop frame, but make the notebook the center
of gravity:

1. **Masthead**
   - Product and exact source notebook identity.
   - Persistent execution-environment badge.
   - Persistent evidence-source badge.
   - Capability check and **Retry capability check** action.
2. **Sample navigator**
   - Searchable seven-group tree with 19 stable scenarios.
   - Status for draft inputs, approval, active run, and latest outcome.
   - Cell citations and risk visible before selection.
3. **Notebook runbook**
   - Protected source cells in notebook order.
   - Inserted editable and generated cells clearly marked "Playground cell -
     not part of the source notebook."
   - Sticky sample actions: **Review sample**, **Run sample**, **Cancel run**.
4. **Run and evidence drawer**
   - Current run progress, transcript, files, assertions, and history.
   - Resizable on wide screens; full-width section on narrow screens.

The current Guide, Configure, Request, and Response information remains useful,
but it should become a linear notebook flow rather than four mutually exclusive
tabs:

`Source context -> Declared inputs -> Generated operation -> Review and approval
-> Output and evidence`

Users should not have to remember which tab contains a blocker.

### URL and session state

Deep-link only non-sensitive navigation:

`?sample=weather-mcp-discovery&cell=20&view=source&run=<opaque-history-id>`

The URL may contain selected sample, selected cell, view mode, and an opaque
run-history identifier. This requires narrowly re-scoping the current guard that
forbids all `history.pushState` and `history.replaceState` calls: permit URL writes
only through one helper that allowlists `sample`, `cell`, `view`, and `run`, while
retaining and strengthening the tests that reject credentials and configuration
in URLs. It must not contain field values, resource IDs, endpoints, secret
presence, approval tokens, search text that may include identifiers, or output.

Draft configuration remains memory-only by default. Existing redacted JSON and
`.env.example` import/export provide explicit portability. Do not silently add
browser persistence under the label "resume."

## Sample navigator

Keep the current group order and counts:

- Discover (2)
- Prepare (3)
- Publish and grant (3)
- Exercise (6)
- Observe (2)
- Policy (2)
- Lifecycle (1)

Each navigator row should show:

- short title;
- code-cell citation;
- risk text and icon;
- readiness: `3 inputs needed`, `Ready to review`, or `Approved`;
- latest outcome, if one exists;
- active-run indicator, if applicable.

Search should continue to match title, group, risk, ID, and cell number. Add
filters for `Ready`, `Needs input`, `Has run`, and risk. Search and filters never
hide an active run; show an "Active run outside filters" return row.

Selecting a sample preserves unsaved values for other samples in memory for the
life of the current page, but never preserves approval and never writes
`sessionStorage`. If navigation would abandon a currently edited secret cell,
move focus first and announce that the value stays in this tab only.

On narrow layouts replace the tree with a labelled native select plus **Previous
sample** and **Next sample** buttons. Include the group in each option label, for
example `Exercise - Weather tool: direct tools/call`.

## Protected Source and Notebook view

### Exactness

Offer two source modes:

1. **Notebook view** renders the exact ordered cell sources from the imported
   `.ipynb`. Syntax highlighting may wrap tokens in presentation spans but must
   not normalize, reformat, repair, or rewrite source text.
2. **Raw notebook** displays or downloads the exact imported bytes and shows the
   verified SHA-256, byte count, upstream commit, and verification state.

Each source cell header includes:

- `Source Markdown cell 19` or `Source code cell 20`;
- protected lock icon with accessible text `Protected source`;
- sample mappings, including when one source cell maps to multiple scenarios;
- **Copy exact source**;
- **View raw notebook at this cell**;
- **Run cell** only when an allowlisted compiled scope exists.

All displayed cell numbers are the notebook's zero-based positional indexes used
by `provenance.json`. The navigator, source header, URL, review, run record, and
evidence export must use that same numbering without converting to one-based
labels.

Do not put a disabled editor around code. A semantic `section` containing a
focusable `pre`/`code` block makes protected code selectable and copyable without
suggesting it can be unlocked. If line numbers are shown, hide line-number
decoration from assistive technology.

### Inserted playground cells

Inserted cells use a different left rule, background, header, and label:

`Playground parameter cell - not part of source notebook`

They appear immediately after the protected source context they operationalize.
Never interleave an inserted cell without that label; visual similarity alone is
not enough. A source-only toggle hides all inserted cells and reconstructs the
36-cell notebook view.

Notebook code cells 2 and 33 remain visible but non-runnable:

- cell 2 is represented by shared profile parameter cells;
- cell 33 is represented by per-sample evidence and assertions because the
  source roll-up is incomplete.

The UI should state that mapping rather than making either code cell disappear.

## Editable parameter and configuration cells

Render only the fields declared for the selected scenario. Preserve the current
requirement groups:

- Mandatory
- Conditional
- Optional
- Generated / override
- Secrets

Every field shows:

- visible label and requirement;
- owning profile or scenario;
- source notebook reference;
- why the sample needs it;
- how to obtain it and authoritative link where available;
- effective default or fallback;
- validation message with a concrete next step.

Generated values are read-only by default. **Override generated value** reveals
the declared override control and explains what produced the current value.
Clearing the override returns to the generated value. Cross-sample values state
their producer, for example `From Publish the three assets`.

Untouched missing fields remain `Needed`, not `Error`. On **Review sample**,
validate all fields, move focus to the first error, and provide a summary whose
links focus each field.

There is no arbitrary "add parameter" affordance.

## Protected secret space

Place secret cells in a visually bounded **Protected secret space** after ordinary
configuration and before review. The space states:

`Secrets stay in this browser tab for this run. They are sent only to the selected
runner and are never included in source, previews, exports, history, artifacts,
or evidence.`

Requirements:

- password input with an explicit label and meaningful `name`;
- `autocomplete="off"`, spellcheck disabled, paste allowed;
- **Show secret** is a press-and-hold or explicit toggle with an announced state;
- **Clear secret** removes it immediately and invalidates approval;
- secret presence is represented only as `Not set` or `Set for this tab`;
- copied and downloaded previews contain a `SecretRef` or environment placeholder,
  never a value;
- leaving the page warns when an in-memory secret would be lost;
- history says `1 secret supplied` at most and never identifies value length,
  prefix, digest, or change.

Do not offer "remember secret," browser password-manager storage, history reuse,
or copy from a previous run.

## Diff, review, and approval

**Review sample** opens an in-flow review section, not a modal. The review has four
ordered parts:

1. **Source integrity**
   - `Source unchanged`
   - notebook hash, cited cells, and deviations disclosed by the catalogue.
2. **Parameter diff**
   - declared path and friendly label;
   - notebook/default/generated baseline;
   - effective value;
   - source of change: user, discovery, prior sample, or default;
   - secrets rendered as `Set` / `Not set`.
3. **Generated operation diff**
   - step kind, allowlisted operation identity, target host/resource, artifact
     path, and redacted arguments;
   - difference from the last approved or last run plan, if one exists;
   - no green "no change" implication when no baseline exists; say
     `First review - no prior run to compare`.
4. **Effect and approval**
   - environment, target, risk, blast radius, reversibility, timeouts, and files;
   - sample-specific acknowledgement text;
   - non-production confirmation for burst and cleanup scenarios;
   - specific action: **Approve and run cell** or **Approve and run sample**.

Approval is single-use. It is invalidated by:

- any input, confirmation, override, or secret edit;
- changed source hash or catalogue version;
- changed generated plan;
- changed runner or target;
- switching between cell and sample scope;
- completion, failure, cancellation, or timeout.

Read-only scenarios still require review, but their final action can be
**Run read-only sample** without an effect acknowledgement. State-changing,
load-generating, and destructive scenarios require the explicit acknowledgement
already represented by the catalogue.

## Run cell and Run sample

### Run cell

**Run cell** executes a server-owned plan slice mapped to the selected protected
source cell and selected scenario. It never executes notebook text.

Rules:

- shared source cells (20, 22, and 31) use the currently selected scenario
  variant;
- source cells spanning one scenario (14 and 15) expose separate compiled slices
  only after the catalogue declares their step ownership;
- a cell with unmet dependencies is blocked with links to the producing cells or
  scenarios;
- non-recipe cells 2 and 33 have no run action;
- if the server cannot rebuild and validate a cell-scoped plan, do not show
  **Run cell**. Never make it silently run the whole sample.

### Run sample

**Run sample** rebuilds and executes the complete selected sample plan in
catalogue order. Show total steps and the execution budget before approval.

Running either scope creates a new run ID and isolated workspace. Outputs from a
cell run may satisfy later cells only within that run lineage. Editing an
upstream input marks dependent output cells `Stale` and requires a new review.

### Allowlisted runner

The product offers no command prompt. The runner transcript may show:

- approved executable identity (`az` or registered Python);
- redacted argument array;
- HTTPS method and host;
- generated artifact relative path;
- assertion identity.

It must not accept typing. Local execution remains loopback-only. Hosted
execution remains behind the narrower relay boundary. The same server-side
rebuild, allowlist, same-origin, redaction, output bound, and workspace
containment rules apply to cell and sample runs.

## Streamed output, cancellation, and timeouts

The current local executor already has progress callback concepts, but the browser
currently receives the completed JSON response. The local redesign should use a
run-start response plus a same-origin event stream for public progress. Every
event is redacted before emission, and the stream endpoint must apply the same
loopback, Origin, authorization, output-bound, and redaction controls as the run
endpoint.

Hosted relay execution cannot promise this experience yet: the current relay
buffers a completed response and has no streaming or cancellation protocol.
Until that protocol exists, label hosted progress `Waiting for hosted result`,
show only coarse request state, and do not offer a cancellation control that the
relay cannot honor.

The output cell shows:

- `Step 2 of 6: Read the selected service`;
- state: queued, running, completed, failed, inconclusive, cancelling, cancelled,
  timed out, blocked, or skipped;
- elapsed duration and applicable timeout budget;
- separate **Output**, **Errors**, **Evidence**, and **Assertions** views;
- bounded, redacted text with **Download redacted log**;
- follow-output toggle, paused automatically when the user scrolls upward.

Do not place the full transcript in an ARIA live region. Announce only aggregated
events such as `Step 2 completed` and `Run failed at step 3`; otherwise streamed
text overwhelms screen-reader users.

**Cancel run** changes immediately to `Cancelling...` and remains present until
the server confirms cancellation or reports that the run already ended. Preserve
partial evidence and label unstarted steps `Not run after cancellation`.

Timeouts are not generic failures:

- `Step timed out after 180 seconds`
- `Run budget exceeded after 900 seconds`

Show the enforced values from runner capability; do not let ordinary users
increase them in a free-form input. **Retry failed step** is available only when
the catalogue marks the step retry-safe and dependencies remain valid.
Otherwise use **Review and run sample again**. A retry is a new run with new
approval, never a mutation of historical evidence.

## Files, artifacts, and evidence history

### Files

Every generated file row shows:

- file name and relative workspace path;
- producing run, cell, and step;
- MIME/type, size, and SHA-256;
- **Preview**, **Download**, and **Compare with previous** when safe;
- redaction or omission state.

Text previews are read-only. Artifact links must resolve through an allowlisted
run-artifact endpoint rather than exposing filesystem paths. Never preview or
download secret-bearing files. Reject unknown paths even when they appear in a
historical record. In hosted deployments, both artifact and history requests are
authorized to the signed-in principal; current sequential local run IDs are not
authorization. Hosted IDs must be opaque and unguessable.

### History

Add a per-sample **Runs** section and a global recent-runs view. A history row
contains:

- run ID and time formatted with `Intl.DateTimeFormat`;
- sample ID/version and source cells;
- source hash and catalogue version;
- scope: cell or sample;
- runner locality and evidence source;
- risk and approval fact;
- redacted configuration snapshot or configuration-document reference;
- outcome, duration, steps, assertions, and artifact metadata.

History never contains secrets, raw bearer headers, complete credential-shaped
output, or unredacted stderr. Local history can index the existing run
workspaces. Hosted history is a new managed, principal-scoped service rather than
a property of the currently stateless relay; it needs an explicit store,
authorization model, retention policy, and deletion contract. `Clear history` is
destructive and requires confirmation; artifact deletion reports what was and
was not removed.

Historical output is immutable. **Use configuration from this run** creates a
new editable draft containing only non-secret declared fields and clearly marks
all secret cells `Not set`.

## Unmistakable environment and evidence labels

Runner locality and evidence source are different facts and must never share one
ambiguous status chip.

### Runner badge

Use exactly one:

- `PREVIEW ONLY - no runner attached`
- `OFFLINE SELF-TEST - fixed local checks`
- `LOCAL OPERATOR - runs on this machine`
- `HOSTED RELAY - runs in the managed relay`

### Evidence badge

Use exactly one:

- `NOT RUN - no execution evidence`
- `LOCAL CHECKOUT EVIDENCE - no Azure contact`
- `LIVE TARGET EVIDENCE - target contacted`
- `INCONCLUSIVE - execution did not prove the assertion`

`LOCAL OPERATOR` can still produce `LIVE TARGET EVIDENCE`; local describes where
the process runs, not what it contacts. The offline self-test always reports
`LOCAL CHECKOUT EVIDENCE` and retains `azureContacted: false` and
`liveEvidence: false`.

Repeat both labels in the masthead, approval section, active output, historical
run header, and exported evidence. Do not rely on color. Use a striped or outlined
visual treatment for preview/offline states and a solid treatment for a live
target, with full text in every case.

## State model

### Draft and review states

| State | Meaning | Primary action |
| --- | --- | --- |
| pristine | Defaults loaded; no user edit | Start configuration |
| editing | At least one editable cell changed | Review sample |
| invalid | Review found blocking issues | Fix first issue |
| ready-to-review | Required inputs valid; no current review | Review sample |
| reviewed | Diff generated for current revision | Approve execution |
| approved | Single-use approval matches current revision and scope | Run now |
| stale | Inputs, source, target, or capability changed after review | Review changes |

### Run states

| State | Meaning | Recovery |
| --- | --- | --- |
| queued | Accepted but not started | Cancel run |
| running | A step is active | Cancel run |
| cancelling | Cancellation requested | Wait for confirmation |
| completed | All required steps and assertions completed | Inspect evidence |
| failed | A step or assertion disproved the expected result | Review error and rerun |
| inconclusive | Execution could not prove or disprove the result | Follow stated next step |
| timed-out | Step or run budget expired | Review timeout and rerun |
| cancelled | Runner confirmed cancellation | Review partial evidence |
| blocked | Runner or prerequisite refused execution | Resolve named blocker |

Do not collapse `failed`, `inconclusive`, `timed-out`, `cancelled`, and `blocked`.
Do not use a check mark for HTTP completion when a JSON-RPC assertion failed.

### Revision rules

Maintain a monotonically increasing in-memory draft revision. Review records the
revision and generated plan identity. An input edit creates a new revision,
invalidates approval, and marks downstream output stale. History stores only
completed redacted revisions.

## Error and retry design

Every error has:

1. what happened;
2. what was and was not attempted;
3. whether any effects may have occurred;
4. the next safe action;
5. a link to the relevant input, prerequisite, step, or evidence.

Examples:

- `Azure CLI is not available. Install it, then choose Retry capability check.
  No sample step ran.`
- `The runner refused this request because the approval no longer matches the
  edited configuration. Review the 1 changed value and approve again.`
- `Step 3 timed out after 180 seconds. The request may have reached the target.
  Inspect the target before running the state-changing sample again.`
- `The executor returned non-JSON output. The result is inconclusive, not passed.
  Download the redacted response and retry after checking the endpoint.`
- `2 runs are already active. Cancel one or wait for it to finish.`

Capability checks, safe read-only steps, and history retrieval have explicit
retry actions. State-changing retries always return through review and approval.

## First-run and onboarding

Use an inline first-run panel at the top of the notebook, not a modal tour:

**Run the notebook safely**

1. `Choose 1 of 19 traced samples.`
2. `Edit only the highlighted playground cells. Source cells stay protected.`
3. `Review the exact changes and target before anything runs.`

Provide two starts:

- **Explore in preview** selects `Azure context check`, opens protected cells 3
  and 4, and leaves execution disabled.
- **Run offline self-test** runs the fixed local checkout checks and then returns
  to the selected sample. It never becomes sample evidence.

On first entry to operator mode, show capability facts and missing prerequisites
inline. Never auto-run `az login`, install Python packages, contact Azure, or
request credentials.

Dismissal is remembered only in memory for the life of the current page and does
not survive reload. **Show getting started** remains in Help.

## Responsive layout

### Wide desktop, 80rem and above

- navigator: 18-22rem;
- notebook: fluid center, readable code width with horizontal code scrolling;
- evidence drawer: 22-30rem, resizable;
- sticky masthead and sample action bar must not cover focused cells.

### Compact desktop and tablet, 48rem-79.99rem

- navigator becomes a collapsible side sheet or native grouped select;
- notebook remains primary;
- evidence drawer docks below the notebook;
- review diff changes from side-by-side to stacked `Before` / `Effective`.

### Mobile and 200% zoom, below 48rem effective width

- single column;
- native sample select, environment labels, and current state precede content;
- cell actions wrap below cell metadata;
- transcript tabs become a native select or horizontally scrollable tab list;
- all code and transcript regions scroll internally without causing page-level
  horizontal overflow;
- sticky action bar includes safe-area padding and never hides focused controls;
- no hover-only controls.

At 320 CSS pixels, users must be able to select a sample, edit every declared
field, reveal help, review the stacked diff, approve, run, cancel, and inspect
evidence without horizontal page scrolling.

## Keyboard model

- `Tab` follows visual order through navigator, cell header, source, inserted
  inputs, review, runner, and evidence.
- Arrow, Home, and End keys continue to operate tabs where tabs remain.
- `/` focuses sample search only when focus is not in an editable control.
- `Ctrl+Enter` or `Cmd+Enter` on a source or parameter cell opens review for that
  cell. It never bypasses approval or starts execution.
- `Shift+Enter` in an editable cell moves to the next editable cell; at the last
  editable cell it focuses **Review sample**.
- `Escape` stops transcript auto-follow or closes a temporary side sheet; it
  does not cancel a run.
- Cancellation requires focus and activation of **Cancel run**.

Show shortcuts in a keyboard-help disclosure. Do not intercept browser or screen
reader commands. Every shortcut has an ordinary visible-control equivalent.

## Accessibility acceptance criteria

Target WCAG 2.2 AA and require all of the following:

1. Landmarks, skip link, unique page title, and hierarchical headings identify
   navigator, notebook, runner, files, and history.
2. Every input has a visible associated label. Required state, help, error, and
   secret handling are programmatically associated.
3. Protected source is selectable and focusable but not exposed as disabled or
   editable. Assistive text says `Protected source, read only`.
4. Inserted playground cells are identified in text, not only by color or
   position.
5. All status chips have complete text. Risk, runner locality, evidence source,
   and outcomes meet 4.5:1 text contrast.
6. Focus is always visible with `:focus-visible`; sticky regions do not cover
   focused content.
7. Review focuses its heading; failed review focuses the summary, whose links
   move to fields. A run finishing does not steal focus.
8. Aggregated run events use a polite live region. Raw streams do not.
9. Transcript auto-follow can be paused. New output does not move a user's
   reading position after they scroll away.
10. All controls work with keyboard alone. Cell selection and resizing have
    non-drag alternatives.
11. Motion honors `prefers-reduced-motion`; running state remains understandable
    without animation.
12. Touch targets are at least 24 by 24 CSS pixels under WCAG 2.2 AA, with 44 by
    44 preferred for primary mobile actions.
13. The complete workflow works at 320 CSS pixels, 200% zoom, Windows High
    Contrast, and 400% zoom/reflow for the central task.
14. Source code, logs, and diffs use semantic text, not canvas rendering.
15. Errors never rely on color and always state a recovery action.
16. Dates, durations, and counts use `Intl` formatting. Identifiers and source
    code use `translate="no"`.
17. Test with Chromium plus at least one Firefox/Safari engine and conduct manual
    NVDA, JAWS, or VoiceOver passes before calling the redesign AA-complete.

## Core UI copy

| Surface | Recommended copy |
| --- | --- |
| Source lock | Protected source |
| Inserted cell | Playground parameter cell - not part of source notebook |
| Empty mandatory field | Needed before review |
| Secret empty | Not set - stays in this tab only |
| Source check | Source unchanged - exact notebook hash verified |
| First diff | First review - no prior run to compare |
| Preview action | Generate preview |
| Review action | Review sample |
| Read-only run | Run read-only sample |
| Risky run | Approve and run sample |
| Cell action | Approve and run cell 20 |
| Active cancellation | Cancelling... |
| Offline evidence | Local checkout evidence - Azure was not contacted |
| No execution | Not run - no execution evidence |
| Live evidence | Live target evidence |
| Stale output | Stale - inputs changed after this output was produced |
| Retry | Review changes and run again |
| Artifact omission | Not available - this file may contain protected material |

## Scenario traceability

The navigator and every run/evidence record must retain this exact mapping:

| Group | Stable sample ID | User-facing title | Source cells | Risk |
| --- | --- | --- | --- | --- |
| Discover | `azure-context-check` | Azure context check | 3, 4 | Read-only |
| Discover | `apim-discovery` | API Management discovery | 5, 6 | Read-only |
| Prepare | `foundry-enable-a2a` | Enable incoming A2A on the Foundry agent | 7, 8 | State-changing |
| Prepare | `apim-foundry-grant` | Grant the APIM identity Foundry access | 9, 10 | State-changing |
| Prepare | `weather-api-ensure` | Ensure the `weather-api` source API exists | 11, 12 | State-changing |
| Publish and grant | `publish-assets` | Publish the three assets | 13, 14, 15 | State-changing |
| Publish and grant | `access-contract-deploy` | Deploy the mixed access contract | 16, 17 | State-changing |
| Publish and grant | `access-contract-kv-verify` | Verify the Key Vault secrets | 18 | Read-only |
| Exercise | `weather-mcp-discovery` | Weather tool: MCP handshake and tools/list | 19, 20 | Read-only |
| Exercise | `learn-mcp-discovery` | Microsoft Learn tool: MCP handshake and tools/list | 19, 20 | Read-only |
| Exercise | `a2a-agent-card` | A2A agent card | 21, 22 | Read-only |
| Exercise | `a2a-message-send` | A2A message/send through the gateway | 21, 22 | Read-only |
| Exercise | `agent-framework-hr-question` | Agent Framework: ask the HR agent | 27, 28 | Read-only |
| Exercise | `weather-tools-call` | Weather tool: direct tools/call | 29 | Read-only |
| Observe | `usage-metrics` | Usage metrics in Application Insights | 23, 24 | Read-only |
| Observe | `circuit-breaker-check` | Circuit breaker on the published backend | 25, 26 | Read-only |
| Policy | `tool-rate-limit-burst` | Tool rate-limit burst | 30, 31 | Load-generating |
| Policy | `agent-rate-limit-burst` | Agent rate-limit burst | 30, 31 | Load-generating |
| Lifecycle | `cleanup` | Cleanup | 34, 35 | Destructive |

Traceability behavior:

- Selecting a navigator item scrolls to its first mapped cell and highlights all
  mapped cells without hiding intervening notebook context.
- A shared source cell lists all mapped scenarios; selecting one changes only the
  inserted playground cells and compiled run scope.
- Run records persist sample ID, source cells, source hash, catalogue version,
  and disclosed deviations.
- The UI never invents image generation, LLM inference, model RBAC validation, or
  API Center registration scenarios absent from the notebook.

## Browser E2E acceptance scenarios

1. **Exact source integrity**
   - Load the product, open Raw notebook, and verify hash, byte count, 36 cells,
     17 Markdown cells, 19 code cells, no outputs, and no attachments.
   - Download original and verify byte identity.
2. **All scenario mappings**
   - Assert 19 unique navigator entries and the group distribution
     2/3/3/6/2/2/1.
   - Open each scenario and verify its mapped source cells and stable ID.
3. **Protected source**
   - Verify source can be focused, selected, and copied.
   - Verify no source element is editable and no save-source action exists.
4. **Inserted-cell distinction**
   - Verify every editable cell has the text `not part of source notebook`.
   - Toggle source-only mode and verify exactly the imported 36 cells remain.
5. **Declared-input boundary**
   - For all 19 samples, compare rendered editable fields with the catalogue
     requirement manifest; no extra field is present.
6. **Needed versus error**
   - Open an incomplete sample and verify untouched required inputs read `Needed`.
   - Enter invalid data, review, and verify focus and actionable error summary.
7. **Secret containment**
   - Paste a secret, verify only `Set for this tab`, and inspect DOM, URL,
     clipboard previews, exports, history, transcript, and artifacts for absence.
   - Clear it and verify approval invalidation.
8. **Generated override**
   - Accept a discovered public configuration update, override it, clear the
     override, and verify source attribution at every state.
9. **First review**
   - Verify source integrity, parameter diff, generated operation, effect, runner,
     target, and `no prior run` copy.
10. **Approval invalidation**
    - Approve a risky sample, then change ordinary input, secret, target, runner,
      and execution scope in separate cases; Run must be blocked each time.
11. **Cell-scope enforcement (enabled only after catalogue cell-to-step mappings
    exist)**
    - Run an allowlisted mapped cell and verify only its declared plan slice ran.
    - Verify cells 2 and 33 have no Run action.
    - Verify an unsupported cell scope never falls back to Run sample.
12. **Sample-scope execution**
    - Run a multi-step sample and verify server-side plan reconstruction,
      sequential step states, isolated run ID, and final assertions.
13. **Stream separation**
    - Stream stdout, stderr, evidence, and assertions; verify redaction, bounds,
      ordered steps, pause-follow behavior, and non-chatty live announcements.
14. **Cancellation**
    - Cancel during an active step; verify `Cancelling...`, confirmed cancellation,
      partial evidence retention, and unstarted steps marked not run.
15. **Timeout**
    - Force step and run timeout seams; verify distinct copy, effect uncertainty,
      and safe retry route.
16. **Outcome precision**
    - Exercise completed, failed, blocked, inconclusive, timed-out, and cancelled
      outcomes. None may share success styling or copy.
17. **Artifact containment**
    - Preview and download an allowed redacted artifact, reject a traversal path,
      reject an unknown artifact, and compare two safe text artifacts.
18. **History**
    - Navigate between samples and reload a historical redacted run. Verify
      immutable evidence, source hash, runner/evidence badges, and no secrets.
19. **Environment labels**
    - Verify Preview only, Offline self-test, Local operator, and Hosted relay.
    - Verify local operator can separately report live target evidence.
20. **Concurrency**
    - Start the allowed number of runs, verify the next is blocked with an
      actionable message, then cancel one and retry.
21. **Keyboard-only workflow**
    - Select, configure, review, approve, run, cancel, inspect errors, download an
      artifact, and open history without pointer input.
22. **Responsive workflow**
    - Repeat the primary flow at 320 CSS pixels, 200% zoom, and wide desktop with
      no page-level horizontal overflow or hidden focused control.
23. **Assistive technology**
    - Verify labels, source read-only semantics, inserted-cell identification,
      error association, aggregate announcements, and stable focus through run
      completion.
24. **Offline first run**
    - Complete onboarding and self-test in preview and operator modes; verify
      `azureContacted: false`, `liveEvidence: false`, and no promotion of self-test
      output into sample evidence.

## Recommended delivery order

1. Add the protected exact source renderer and preserve the current configuration
   and request builders as inserted cells.
2. Replace tab-gated navigation with the linear source/input/review/output flow.
3. Add revision-bound review and approval before changing execution behavior.
4. Add run-start plus event-stream transport and explicit cancellation states.
5. Add safe artifact retrieval and redacted local history.
6. Add cell-scoped execution only after the catalogue owns exact cell-to-step
   mappings; until then, expose **Run sample** only.
7. Complete cross-browser, zoom, keyboard, and assistive-technology acceptance.

This order preserves the current safe execution boundary while making provenance
and editability understandable before adding new execution scopes.
