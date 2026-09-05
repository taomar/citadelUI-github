# Agent Progress

## Current Milestone

Protected-source playground redesign implemented and verified at integration
reference `0707925`. The product decision is final:
retain the server-authoritative catalogue and typed allowlisted local executor,
add a notebook-like read-only source surface, and allow edits only to declared
inputs. Do not introduce a general-purpose editable notebook.

## Redesign Decision Record

### Fixed product boundary

- The 19 catalogue IDs remain the stable identity across navigation,
  configuration, exact notebook provenance, plans, execution, evidence, and
  tests.
- Repository-owned cited cells are visible and protected. The browser cannot
  submit source text, code, a command, executable, plan, URL, header set, script,
  path, identity, or dependency.
- The server selects source by catalogue sample ID, verifies provenance, validates
  declared inputs, and rebuilds the typed plan from its own catalogue.
- This is a maintained product. Upstream notebook changes require deliberate
  reconciliation across provenance, catalogue metadata, typed builders,
  allowlists, assertions, runtime registrations, and tests.

### Runner and evidence contract

- Runner badges are **PREVIEW ONLY**, **OFFLINE SELF-TEST**,
  **LOCAL OPERATOR**, and **HOSTED RELAY**.
- Evidence badges are **NOT RUN**, **LOCAL CHECKOUT EVIDENCE**, and
  **LIVE TARGET EVIDENCE**.
- Runner locality and evidence source are separate facts. A
  **LOCAL OPERATOR** run may produce **LIVE TARGET EVIDENCE**.
- Parser-only validation accepts only the protocol version, produces
  **LOCAL CHECKOUT EVIDENCE**, and always reports `azureContacted: false` and
  `liveEvidence: false`.
- Parser acceptance, executor readiness, process exit 0, and HTTP 2xx never
  become live target evidence by themselves.

### Execution boundaries

- Local runs preserve server-authoritative reconstruction and operation
  allowlists while streaming bounded lifecycle events into the response view.
  Cancellation addresses the exact active run ID; declared artifacts stay under
  the contained run workspace.
- Partial progress stores state and evidence availability only. Raw evidence,
  commands, source, secret updates, and artifact paths wait for the final typed
  result.
- Parser-only Python validation is not registered Python sample execution. It
  validates protected source without imports, top-level execution, package
  installation, network, credentials, source edits, or submitted configuration
  values.
- Exact protected source retrieval is available in every mode. Parser-only
  validation is available only in explicit loopback local operator mode, keeping
  public preview and the hosted relay process-free.
- The existing hosted relay remains HTTP/assertion-only. Its structural absence
  of Python, Azure CLI, process transports, workspaces, and artifact writers is a
  security control, not a missing convenience.
- Hosted relay admission and managed run state are replica-safe offline:
  owner-bound nonce/idempotency, distributed concurrency and active-job capacity,
  dispatcher lease recovery, polling, cancellation, and timeout behavior are
  covered without claiming a live deployment.
- Future hosted process work may run only in a fresh immutable no-ingress job per
  run, with dedicated least-privilege identity, externally enforced egress,
  owner-bound durable state, platform quotas, verified termination, artifact
  quarantine, cleanup, supply-chain evidence, and independent security review.

### Implemented redesign checkpoint

- The protected Code view renders exact server-selected cited cells and
  server-owned declared parameter zones without accepting source from the
  browser.
- Code is the default workspace. Its sticky task pane leads with the selected
  sample's execution identity and target, then renders the one canonical set of
  required, conditional, secret, defaulted, and generated inputs.
- Azure management, Python management, and Foundry samples identify the local
  Azure CLI principal, tenant, and active/configured subscription match before
  execution. Explicit device-code sign-in uses only
  `az login --use-device-code`; tokens are never returned to the browser.
- Gateway samples identify the memory-only APIM subscription-key context without
  exposing the key. Offline validation and hosted relay samples use separately
  labelled local-parser and managed-identity contexts.
- Agent Framework A2A execution validates every advertised transport route and
  injects the APIM key only after an exact gateway-origin, path, and method check;
  a remote card cannot redirect the credential.
- Human policy labels remain readable while deterministic safe identifiers drive
  generated product, subscription, contract, and workspace paths. Free-text
  product terms use the shared Bicep serializer.
- Exact source retrieval works in preview and operator modes.
- Compile-only Python validation is available only in loopback operator mode,
  accepts only the protocol version, removes its ephemeral workspace, and reports
  no execution, Azure contact, network contact, or live evidence.
- The local executor validates fixed catalogue-owned Azure CLI and Python
  operation shapes, builds child environments from an allowlist, bounds output,
  and terminates timed-out process trees without a shell.
- Local runs stream bounded NDJSON lifecycle events. The browser's pure reducer
  preserves ordered terminal state and retains only evidence availability until
  the final typed result.
- The real Python validation path has been exercised across all 19 catalogue
  scenarios, including workspace cleanup.
- Full static, recursive Node, and browser verification passes after route,
  provenance, protected-source acceptance, and smoke reconciliation.

### Final verified baseline

`npm run verify` at `0707925` exited 0:

- `npm run check` — 114 modules, 0 dependencies, nothing outside
  `CitadelSamples`;
- `node --test` — 737/737 passing;
- `npm run smoke` — 89/89 passing.

The separate protected-source browser acceptance passed 160/160 checks, and the
Impeccable layout detector returned no findings.

No Azure endpoint, subscription, gateway key, Foundry project, Policy burst, or
Cleanup operation was used by this verification.

## Earlier Executable Playground Checkpoint

The sections below record the pre-redesign checkpoint. Their test totals and
four-view interface description are historical evidence, not the final
protected-source redesign baseline.

### Delivered

- Every one of the 19 recipes now declares only the configuration it actually uses, grouped as mandatory, conditional, optional/defaulted, generated/override, or secret.
- The Configure tab shows those groups, missing values, runtime readiness, and deterministic JSON plus `.env.example` copy/download actions. Secret values never enter either export.
- `npm start` remains preview-only. `npm run start:execute` attaches a loopback-only local executor for generated artifacts, registered Azure CLI operations, catalogue-built HTTPS requests, registered Python wrappers, and assertions.
- The server accepts only a sample ID, declared values, transient declared secrets, and acknowledgement. It validates and rebuilds the plan from its own catalogue; a browser cannot supply an executable, command, URL, header set, script, plan, or path.
- A pinned, closed accelerator dependency bundle and registered Python wrappers live under `playground/runtime`; runs write only under ignored `.runs/<run-id>/` workspaces.
- Runs report per-step state, duration, safe evidence, assertions, public configuration updates, and memory-only secret updates. Active run IDs are returned in response headers so cancellation can stop an in-flight run.
- Windows resolves the official `az.cmd` launcher to the Azure CLI's bundled Python entry point without enabling a shell.
- Runtime capability is evaluated per sample. Optional Python fallback support does not block access-contract deployment; missing primary Python modules block only the recipes that actually need them.
- `CitadelSamples/.gitattributes` keeps the imported notebook byte-exact when Git is configured to convert line endings on Windows.
- `playground/.gitignore` keeps generated `.runs/` workspaces out of source control and satisfies the existing workspace-isolation assertion.

### Review corrections included

- Applied the same-origin JSON guard to the external relay endpoint.
- Added the missing subscription ID requirement to the Weather API Python recipe.
- Preserved missing Python-module state when the browser reconstructs per-sample capability.
- Enforced streaming HTTP response limits before an oversized body is buffered.
- Propagated assertion outputs into downstream steps for APIM selection, managed-identity selection, Foundry scope composition, and Application Insights selection.
- Stopped execution after a failed/inconclusive step so an empty derived binding can never reach a later side effect.
- Added safe two-pass access-contract discovery: if the live LLM API set differs from the generated configuration, the run updates the form and stops before writing or deploying; the operator reviews and runs again.
- Added exact role-and-scope verification after the Foundry identity grant.

### Original symptom (resolved)

- The Request tab can generate a complete `ExecutionPlan`, but the default server always reports that no runtime is attached.
- Configure labels describe where a field came from (`required`, `derived`, `sample default`, `secret`) rather than answering the user's immediate question: “Must I provide this value to execute this sample?”
- There is no downloadable configuration contract that a user can fill, review, archive, or hand to an operator.

### Violated assumptions

- A playground is expected to execute a configured sample, not only preview it.
- Source classification and execution requirement are different concerns and cannot share one label.
- Browser-side plan generation alone is not a safe authority for Azure, HTTP, Python, load-generating, or destructive execution.

### Root cause and owning boundary

The first release intentionally stopped at a relay contract. It has no trusted local execution authority. The catalogue also groups shared profile fields coarsely, so the form cannot yet express a sample-specific configuration contract.

The correction belongs at three boundaries:

1. **Catalogue/configuration boundary** — derive a per-sample manifest that separates mandatory, conditional, optional/defaulted, generated/override, and secret inputs.
2. **Server execution boundary** — rebuild and validate the selected plan from catalogue-owned inputs, then execute only typed, allowlisted steps without accepting arbitrary commands, URLs, or file paths from the browser.
3. **UI boundary** — expose configuration generation, local-runtime capability, run/cancel state, step evidence, and safely applied derived outputs.

### Architecture decision

- Keep preview-only startup safe by default.
- Add an explicit local-execution startup mode for operators who intend to run samples.
- Send only `sampleId`, catalogue-shaped public inputs, declared secret values, and a fresh acknowledgement to the server.
- Rebuild the plan server-side; never execute a client-supplied plan.
- Spawn executables without a shell, enforce executable/step allowlists, timeouts, output limits, cancellation, and per-run workspaces inside `CitadelSamples`.
- Resolve only HTTPS requests generated by catalogue builders and never provide an arbitrary proxy.
- Keep secrets transient, redact them from results and logs, and return secret updates only to the requesting browser's in-memory state when a recipe legitimately mints one.
- Represent unsupported/missing runtimes per sample as blocked capability, never as success.
- Generate copyable/downloadable JSON configuration with explicit requirement groups and environment placeholders for secrets.

### Alternatives considered

- **Keep only the external relay:** safest but does not satisfy the requested executable playground.
- **Execute the browser-generated plan directly:** rejected because the browser must not be the authority for commands, URLs, paths, or risk acknowledgement.
- **Provide arbitrary shell/HTTP controls:** rejected because it would turn the playground into a command runner and SSRF proxy.
- **Mark every shared-profile field mandatory:** rejected because it overstates requirements and obscures what each sample actually needs.

### Validation plan

- Unit-test configuration manifests and mandatory/optional grouping for all 19 samples.
- Test plan reconstruction, command/path/URL allowlists, redaction, cancellation, timeout, output limits, and assertion evaluation with injected fake transports only.
- Browser-test configuration copy/download, capability reporting, run/cancel, step evidence, derived-value application, and blocked runtime states.
- Run independent QA without targeting live Azure resources.

## Completed

### Provenance

- Verified the imported notebook against its true upstream rather than trusting the recorded hash alone. Fetched `Azure-Samples/AI-Hub-Gateway-Solution-Accelerator` → `validation/citadel-publish-contract-tests.ipynb` at `main` (commit `ede33909b10800700bc1a5394af84efbe2add892`, 2026-08-14, blob `e07fdb18607db6ea1b0f8eef6920f24a88cb7e73`) and confirmed it is byte-identical to `CitadelSamples/citadel-publish-contract-tests.ipynb`.
- Confirmed SHA-256 `ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb`, 66 241 bytes, unchanged. A test recomputes it from disk on every run.
- Recorded that this repository's own `validation/` copy differs only in line endings (CRLF), so its SHA-256 differs while its git blob SHA-1 matches.
- Wrote `playground/provenance.json` with the upstream record, notebook shape, sample-to-cell map, non-recipe cells and stated exclusions. A test asserts it agrees with the catalogue and with the file on disk.

### Catalogue

- Authored 19 atomic recipes with unique kebab-case ids across seven groups, in the planned distribution: Discover 2, Prepare 3, Publish and grant 3, Exercise 6, Observe 2, Policy 2, Lifecycle 1.
- Mapped every one of the 19 code cells: 17 are cited by recipes, and cells 2 and 33 are documented as deliberate non-recipes (variable initialisation → the five shared profiles; results roll-up → per-recipe assertions). A test fails if any code cell is neither.
- Built the five shared profiles — Hub, Gateway access, Foundry, Key Vault, Policy — with every field classified `required`, `conditional`, `derived`, `sample-default` or `secret`, each carrying help text, acquisition guidance, a notebook reference and an authoritative link.
- Every recipe carries purpose, a multi-paragraph explanation, a numbered flow, prerequisites with how-to and links, a typed schema, validation, risk (level, effect, blast radius, reversibility, acknowledgement prompt), source-cell citation, a deterministic builder, and expected-result assertions including what "not run" means.
- Verified all 61 documentation links resolve; corrected the Foundry A2A link from `/azure/ai-foundry/` to `/azure/foundry/`.
- Stated the absent scenarios explicitly rather than leaving them as silent gaps: **the notebook has no image or multimodal sample**, no LLM-inference call, no model-RBAC exercise and no API Center registration. This is surfaced in the catalogue, in the UI's context rail, in `provenance.json`, in the README, and asserted by a test that also fails if an invented image recipe ever appears.

### Correctness points implemented and disclosed

- **APIM discovery lists before it selects.** Zero or several candidates stop the recipe; the first is never adopted silently.
- **Key Vault verification requires both halves.** The notebook's roll-up is computed from the endpoint secrets alone, so a missing api-key secret reads as a pass there. The key secret is additionally checked with `--query length(value)` so a live credential is never printed.
- **MCP is faithful and correct.** Numeric JSON-RPC ids, protocol `2025-06-18`, `Mcp-Session-Id` captured from the initialize response and bound into the follow-up call, `Accept` covering JSON and SSE, and a parser handling both including multi-line `data:` folding.
- **A JSON-RPC error inside an HTTP 200 is a failure.** The notebook's A2A cell records a pass from the status code alone.
- **Weather assertions match the accelerator's mock policy**, read from `bicep/infra/modules/apim/sample/weather/policy.xml`: `city`, `temperature`, `temperature_format`, `description`, `humidity`, `wind_speed`, with Fahrenheit for Seattle, New York City and Los Angeles and Celsius otherwise. Randomised values are deliberately not asserted.
- **Metrics use a run window.** The notebook's KQL is unbounded; a `lookbackMinutes` input adds `ago(Nm)`, and an empty window inside the ingestion delay is reported inconclusive, never a pass.
- **Circuit-breaker defaults asserted**: count 3 over `PT5M`, trip `PT1M`, 429 and 500–503, `Retry-After` honoured, with Consumption-tier unsupportedness distinguished from misconfiguration. The gap between cell 25's heading and cell 26's code is exposed as an opt-in.
- **Burst defaults preserved**: tool 20/min → 35 requests, agent 10/min → 25 requests, concurrency 10, plus an explicit non-production confirmation the notebook does not have.
- **Cleanup discloses its seven residues** — the Weather API, the Foundry role assignment, the agent's A2A enablement, Key Vault secrets, generated contract files, telemetry and deployment history — each with the command that removes it, and reports every deletion independently rather than as a roll-up.
- **Found and documented a defect in the source**: cell 8 as published sends `"Authorization": f"******"`, a redaction artefact, so its PATCH would be rejected. The recipe binds a real bearer token from the preceding token step.
- **Documented that cell 35 references variables defined only in cell 17**, so running cleanup standalone raises `NameError` rather than cleaning anything up.

### Architecture

- `CitadelSamples/playground` is a zero-build Node + native ES-module application: no dependencies, no lockfile, no `node_modules`, `node --test` for tests.
- Pure deterministic builders compile validated inputs into a frozen `ExecutionPlan` of typed steps (`artifact`, `azure-cli`, `http`, `library`, `assertion`) with `produces`/`consumes` bindings validated for existence and order at construction time. No timestamps, no random ids.
- The notebook's `_bicep` serialiser is ported faithfully, so the Request tab shows the exact `.bicepparam` and product-policy XML the notebook would write.
- Secrets are handled structurally: a plan never contains a credential value, only an inert `SecretRef` rendered as `${CITADEL_GATEWAY_ACCESS_API_KEY}`. Redaction is a second line of defence, and `assertNoSecretValues` guards every preview and every copy.
- The shipped executor is `UnavailableExecutor`, returning a typed `blocked` for all 19 recipes. `passed` is not a state an executor can construct.
- The relay seam posts `{ protocolVersion, sampleId, inputs, secretRefs }` to one same-origin path, refuses sample ids outside the catalogue, cannot be handed a URL, and treats an unrecognised answer as inconclusive.
- The loopback server sends a CSP with no `unsafe-inline`, plus `nosniff`, `DENY`, `no-referrer`, COOP/CORP and a Permissions-Policy; serves only `web/` and `src/` with traversal refused; and never discloses the relay URL or token to browser code.

### Interface

- Operations workbench: grouped, searchable recipe directory on the left, one selected sample in the centre under Guide / Configure / Request / Response, readiness and provenance rail on the right.
- The Control Plane world is reproduced locally in `web/css/world.css` and `web/css/workbench.css`. Nothing reads, links or changes `CitadelUI`; a test asserts it.
- Below ~66rem both rails are replaced — a native `<select>` and a disclosure — rather than squeezed. No horizontal overflow at 320px or at 200% zoom.
- A required field the user has not reached yet reads as *needed* in brand blue rather than as an *error* in red; touch-tracking distinguishes the two.
- The opening `index.html` comment is a 134-word five-block direction contract.

### Verification

`npm run verify` is green end to end at this checkpoint:

- `npm run check` — 57 modules, every relative import resolves, zero dependencies, nothing references anything outside `CitadelSamples`.
- `npm test` — 279 assertions across 14 files, 0 failures.
- `npm run smoke` — 81 headless-browser checks, 0 failures.

The verification also passes from a Windows checkout with `core.autocrlf=true`: the imported notebook remains 66,241 bytes with SHA-256 `ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb`, and `.runs/` is reported as ignored.

At that earlier checkpoint, the smoke driver used the DevTools Protocol over
Node's built-in `WebSocket`, so browser-level verification added no dependency.
It covered selection, tab keyboard navigation, form labels, inline validation,
acknowledgement invalidation, secret redaction, directory search, and the 320px
and 200%-zoom layouts. Screenshots of the then-current four tabs found and fixed
a grid-item bug and a context-rail label breaking mid-word.

### Independent QA

- QA exercised the rendered application with a separate Chromium/CDP driver and approximately 210 checks across provenance, all seven recipe groups, guides, plans, validation, secret handling, risk gates, accessibility, and responsive layouts.
- QA found and fixed two defects inside `CitadelSamples`: checkbox help/error ARIA was attached to the wrapping label rather than the focusable input, and untouched required confirmations rendered as errors rather than as needed inputs.
- All 35 rendered boolean controls now expose their descriptions on the input, all three required confirmations expose `aria-required`, and untouched/touched confirmation states follow the same needed/error model as other fields.
- Fourteen sampled text roles were independently measured for WCAG AA contrast; all passed, with the lowest ratio at 5.38:1.
- The earlier independent QA suite remains part of the history below. Iteration 2
  added execution and configuration-generation coverage after that pass and
  recorded 279/279 unit/integration assertions and 81/81 browser checks.

### Scope

- Every change is inside `CitadelSamples`. `git status` shows only `?? CitadelSamples/`.
- The source notebook is untouched.
- Nothing was staged, committed or pushed, and no pull request was opened.
- For the record: commit `e1d6570` appeared on this branch during the session. It was authored by the repository owner, contains no `CitadelSamples` files, and absorbed the unrelated dirty files that were already present at start. It was not created by this work.

## Offline self-test (queue item 5)

### Delivered

- A server-authoritative `POST /api/self-test` route, available in both preview and `start:execute` mode (unlike `/api/run`, which stays blocked in preview). It is advertised in `/api/capabilities` as `selfTest: { endpoint, available, scenario }`.
- The request body accepts exactly one field, `protocolVersion`, and nothing else — no sample id, inputs, plan, or configuration. Any other member, a wrong protocol version, or a non-object body is refused by name (`forbidden-member` / `protocol-version`) before anything runs. This is enforced by the same `checkStateChangingRequest` same-origin/content-type guard every other state-changing endpoint uses, exercised on the real production function, not a copy.
- `runSelfTest` performs five deterministic, network-free checks against this exact checkout: the imported notebook's SHA-256 recomputed from disk, the catalogue holding exactly `CATALOGUE.expectedSampleCount` (19) recipes — never a twentieth, invented one — the vendored offline accelerator bundle being present, `.runs/` being listed in `.gitignore`, and the same-origin guard itself refusing a synthetic cross-site request while accepting a synthetic same-origin one.
- The result is a single frozen object carrying a scenario id (`offline-self-test`) that can never collide with a catalogue sample id, `azureContacted: false` and `liveEvidence: false` as fixed constants (not computed from anything reachable), and one row per check with a pass/fail flag and a concrete, disk-derived detail string. Nothing in the result is timestamped, random, or otherwise variable between runs on an unchanged checkout.
- The masthead gained an `Offline self-test` disclosure alongside the existing `Preview only` / `Local execution ready` capability chip. It states in its own copy that it needs no Azure subscription, no credential and no network, and never contacts Azure or produces live evidence. Its status chip (`Not run` / `Running…` / `Passed — offline only` / `Failed — offline only` / `Blocked` / `Error`) and its five check rows are rendered from the real response of a real fetch to `/api/self-test` — there is no fake executor seam in this path, unlike the `?testExecutor` hook used elsewhere for run testing. A result is also announced through the existing polite `#live` region.
- This state (`selfTest`) is a separate object from `results` (real recipe runs), so the two can never render into the same place or be confused with each other in the DOM.

### Verification

- `test/selftest.test.mjs` — unit tests for `validateSelfTestRequest` (exact-schema acceptance and refusal of non-object bodies, wrong protocol versions, extra members, and missing fields) and `runSelfTest` (never contacts Azure or the network; all five checks pass on this checkout; fails closed if the catalogue is artificially given a 20th sample; respects injected mode; exercises the real guard function through a spy rather than a re-implementation of it).
- `test/server.test.mjs` gained integration coverage for `/api/self-test`: availability and response shape in preview mode, availability in execute mode (where `/api/run` stays blocked), method/guard enforcement (405, 403, 415), and exact-schema rejection (bad protocol version, extra member, empty body).
- `scripts/smoke.mjs` drives the real button through the real server at two viewports: a normal desktop width (asserts the chip reads `Passed — offline only`, the summary states no Azure contact and no live evidence, exactly five checks render and all pass, and the live region announces the result) and 320px (the width that first exposed a popover-overflow bug during manual review; the fix is now covered by an assertion that running the self-test at 320px completes and leaves no horizontal overflow).
- Fixing this smoke coverage also surfaced and corrected a latent bug in `scripts/smoke.mjs` itself: the driver created the playground server with an ephemeral `server.listen(0, …)` port while `createPlaygroundServer()` still defaulted its own notion of `port` to the fixed constant used for the same-origin `Origin` check, so any state-changing endpoint reached in smoke tests would have failed the guard once exercised for real. The driver now reserves a loopback port first and passes it explicitly to both `createPlaygroundServer({ port })` and `server.listen(port, …)`, so the guard's expected origin matches the port the browser actually navigates to.
- Manual review with a real Chromium session (not the smoke driver) additionally covered keyboard operation — `Tab` reaches the disclosure `summary`, `Enter` opens it, a further `Tab` reaches the run button in document order, and `Enter` runs it — and confirmed no console errors either before or after the fix to the 320px layout.
- Historical baseline at the offline-self-test checkpoint:
  `npm run check` — 89 modules, 0 dependencies, nothing outside
  `CitadelSamples`; `node --test` — 563/563 passing; `npm run smoke` — 88/88
  passing. The final protected-source baseline is recorded above.

### A defect found and fixed during this work

- The disclosure's body was first positioned absolutely, anchored to the toggle itself. Below the ~66rem breakpoint, once the masthead's right-hand group wraps onto its own row, that anchor no longer sits where the popover's `left`/`right` offsets assumed, and the panel could render partly off the right edge of a 320px viewport — invisible against the page background until content was long enough to reveal it, and capable of overlapping the existing compact mobile recipe strip enough to intercept clicks on the run button. The fix renders the panel in normal document flow (`position: static`, full width, its own row) once the masthead itself wraps, rather than trying to keep an absolutely positioned popover correctly anchored across a layout that reflows underneath it. Re-verified at 320px with a real click through to a passed result, and covered going forward by the smoke assertion above.

### Limitations

- This is deliberately a fixed, structural self-check of the checkout on disk — it does not simulate or approximate a live Azure scenario, and its passing has no bearing on whether scenarios 1-16 will pass on a real hub. That distinction is stated in the card's own copy, in the summary text returned by the endpoint, and in the fixed `azureContacted`/`liveEvidence` fields, precisely so it cannot be read as such.
- It intentionally does not grow into a general-purpose diagnostics or inspection API: the request accepts exactly one field and the five checks are fixed in code, not configurable per call.

## Architectural Context

Unchanged from the plan. The four components — sample catalogue, execution-plan builders, executor boundary, playground UI — were implemented as designed, with one correction found during testing: the builder context originally resolved fields only within a recipe's own declared profiles, so the access-contract and cleanup recipes silently read empty strings for the publish contract's asset names instead of failing. The field index is now catalogue-wide, a `fromSample` accessor makes the cross-recipe reads explicit, and a golden plan test covers it.

### Important Invariants

All four hold and are enforced by tests:

- The source notebook is unchanged — SHA-256 recomputed from disk.
- A missing runtime never becomes a success — `blocked` for all 19 recipes, and `passed` is not constructible.
- Secrets never enter persisted state or copied previews — structural absence, plus a source-tree grep for storage APIs, cookies, IndexedDB, credential-bearing log lines and URL writes.
- Risky operations require explicit acknowledgement — enforced before the executor is reached, cleared by any input change, and spent by one run.

## Limitations

These are honest gaps, not deferred work described as done.

1. **Nothing has been executed against Azure.** The local executor is covered with injected process, HTTP, filesystem, and Python transports. No subscription, gateway, key, Foundry project, burst, or cleanup was touched, so no recipe is yet proven against a live hub.
2. **The current machine is partially ready.** Azure CLI 2.77 and Python 3.11 resolve correctly. The Weather API and Agent Framework recipes remain blocked until their modules from `runtime/requirements.txt` are installed. Access-contract deployment can run without Python unless its key fallback is needed.
3. **The HTTP/assertion relay has not been deployed or integration-tested.** Its
   implementation and deployment assets preserve a narrower remote boundary,
   but they are proved only by source inspection and offline tests. It is not an
   execution path for Python, Azure CLI, generated artifacts, bursts, or cleanup.
4. **Customer endpoint reachability and Azure permissions are not probed at startup.** The operator must satisfy each sample's in-product prerequisites and role guidance. Network, RBAC, policy-version, and service-state failures appear in the run result.
5. **State-changing retries remain operator decisions.** Plans are deterministic and read-backs/assertions expose partial outcomes, but the UI does not automatically retry deployments, role assignments, bursts, or deletions.
6. **Some expected results require corroboration across recipes.** In particular, proving an Agent Framework call traversed the gateway needs the usage metric, and the source API's anonymous 401 check is documented but not a separate notebook recipe.
7. **Browser evidence is Chromium-only.** Firefox, Safari, and a real NVDA/JAWS/VoiceOver pass remain outstanding.
8. **The complete live scenario matrix is the next validation phase.** Work through Discover → Prepare → Publish and grant → Exercise → Observe. Do not run Policy bursts or Lifecycle cleanup until the earlier groups pass on an isolated non-production environment.
9. **The vendored Bicep entry points compile, with one upstream warning.** `citadel-publish-contracts/modules/publishA2aAgent.bicep` emits BCP089 because the installed Bicep type definition does not recognize `a2aProperties` on the preview APIM API shape. This is inherited from the source bundle and must be verified against the target APIM API version during the first live publish run.

## Exact Next Action

Select and obtain owner approval for an isolated non-production environment.
Then install optional Python modules only when a registered scenario needs them
and validate the 19 scenarios in catalogue order. Record evidence class,
execution location, `azureContacted`, `liveEvidence`, source digest, redacted
step evidence, assertions, artifacts, and residue. Do not run Policy bursts or
Cleanup until scenarios 1-16 pass, and do not describe any future hosted
process-running job as implemented or approved.

Azure authentication is not required for ordinary playground development or local verification. Authenticate only when an operator explicitly starts the live-validation phase.

The complete continuation and operator runbook is in
[`CONTINUATION-PLAN.md`](CONTINUATION-PLAN.md).
