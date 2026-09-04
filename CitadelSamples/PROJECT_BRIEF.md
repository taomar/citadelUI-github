# Project Brief

## Outcome

Deliver an isolated, selector-driven Citadel Publish Playground under
`CitadelSamples` that faithfully presents every atomic sample from the imported
publish-contract notebook. Add a notebook-like surface for reading exact,
protected source while preserving the existing server-authoritative catalogue
and typed, allowlisted execution model.

## Scope

- Preserve the upstream notebook unchanged.
- Catalogue 19 selectable recipes across Discover, Prepare, Publish and grant, Exercise, Observe, Policy, and Lifecycle groups.
- Show each recipe's exact cited notebook cells as read-only source with cell
  index, type, byte length, and digest.
- Provide per-sample purpose, flow, prerequisites, acquisition/setup guidance, mandatory/conditional/optional/generated/secret parameters, downloadable redacted configuration, request plan, execution status, and result assertions.
- Allow edits only to declared parameter and configuration fields. Source, code,
  commands, executables, URLs, headers, scripts, and paths remain
  server-selected.
- Provide parser-only local Python validation of exact protected cells without
  importing or executing the sample.
- Implement a zero-build Node.js/ES-module web application with no runtime dependencies.
- Provide a preview-safe default and an explicitly enabled, loopback-only local executor for the catalogue's typed Azure CLI, HTTPS, generated-artifact, assertion, and registered Python steps.
- Stream bounded run and step progress, preserve exact-run cancellation, and
  contain generated artifacts under the run workspace.
- Keep the hosted relay limited to allowlisted HTTP/assertion work. Treat hosted
  process execution as a future, separately gated per-run no-ingress job.
- Reproduce the Control Plane visual system locally without importing or changing `CitadelUI` files.
- Add automated tests and browser-level verification that do not require Azure credentials.

## Explicit Exclusions

- No invented image or multimodal sample.
- No fabricated live response or successful execution.
- No editable notebook cells, arbitrary Python, shell, Azure CLI, dependency
  installation, or caller-selected execution plan.
- No arbitrary URL proxy or browser exposure of Azure management tokens.
- No Python, Azure CLI, process creation, or artifact writer in the hosted
  HTTP/assertion relay.
- No hosted process execution until a per-run no-ingress isolation design passes
  its dedicated security and integration gates.
- No changes outside `CitadelSamples`.
- No automated integration test may mutate Azure, generate load, or run cleanup. Those actions remain gated behind explicit operator mode, complete configuration, non-production confirmation, and fresh per-run acknowledgement.

## Architecture

The catalogue is the single source of truth for navigation, guides, exact
per-sample configuration requirements, risk, source provenance, runtime
dependencies, and builder dispatch. The protected-source service resolves cited
cells from the unchanged notebook by catalogue sample ID; source text is never a
browser input.

Pure builders compile validated inputs into typed `ExecutionPlan` steps. The
server independently validates inputs and rebuilds each plan before a
loopback-only local executor runs allowlisted operations. Local runs stream
bounded lifecycle events, retain exact-run cancellation, and return redacted
evidence plus declared artifacts.

Preview mode remains the default. Exact protected source retrieval is available
in every mode. Parser-only offline validation is distinct from real registered
sample execution and is available only in explicit loopback local operator mode
so public preview and the hosted relay remain process-free.

The existing hosted relay remains a narrower HTTP/assertion boundary. Any future
hosted Azure CLI or Python work must run in a fresh, immutable, no-ingress job
with dedicated identity, external egress control, durable owned state, enforced
quota, verified termination, and artifact quarantine.

The target information architecture is a linear notebook-like runbook:
protected source, declared inputs, generated operation, review and approval,
then runner transcript and evidence. Existing workbench views may be retained
during incremental delivery, but they are not a reason to adopt an editable
kernel or terminal.

## Runner and Evidence Labels

- Runner badges are **PREVIEW ONLY**, **OFFLINE SELF-TEST**,
  **LOCAL OPERATOR**, and **HOSTED RELAY**.
- Evidence badges are **NOT RUN**, **LOCAL CHECKOUT EVIDENCE**, and
  **LIVE TARGET EVIDENCE**.
- Runner locality and evidence source are separate. A **LOCAL OPERATOR** run can
  produce **LIVE TARGET EVIDENCE**.
- Parser-only validation and the fixed self-test produce
  **LOCAL CHECKOUT EVIDENCE** with `azureContacted: false` and
  `liveEvidence: false`.
- Live target evidence is never inferred from HTTP success, executor
  availability, process exit, or parser success.

## Acceptance Criteria

- All 19 notebook recipes have unique IDs and source-cell citations.
- All 19 scenarios preserve the exact catalogue-ID-to-notebook-cell mapping in
  `playground/provenance.json`; cells 2 and 33 remain the two documented
  non-recipe code cells.
- Every recipe has guide, prerequisite, configuration, preview, and response/assertion content.
- Every recipe has a read-only protected-source view; neither the DOM nor any API
  can submit edited source.
- Every recipe exposes only relevant inputs and clearly separates mandatory, conditional, optional/defaulted, generated/override, and secret values.
- Configuration JSON and `.env.example` exports never include secret values.
- Required and conditional inputs are validated both before plan generation and again by the executing server.
- Offline Python validation loads server-selected protected source, verifies its
  digest, parses without import or execution, accepts only a protocol version
  and no value/code/path/command input, and labels its report local-checkout and
  not live.
- MCP session chaining and A2A JSON-RPC semantics are represented correctly.
- Secret fields remain memory-only and previews/copies are redacted.
- Risky operations require fresh acknowledgement; load and destructive recipes also require an explicit non-production confirmation.
- No browser-supplied command, URL, executable, header set, script, or path can reach the executor.
- Local runs expose bounded progress before completion, cancel only the exact
  active run, and keep declared artifacts inside the run workspace.
- The hosted relay remains structurally HTTP/assertion-only, with replica-safe
  owner-bound admission, nonce/idempotency, distributed concurrency, lease
  recovery, polling, cancellation, and timeout behavior covered offline.
- Hosted process execution remains disabled unless every per-run isolation,
  identity, egress, quota, cancellation, cleanup, artifact, supply-chain, and
  independent-review gate passes.
- The notebook hash remains unchanged.
- Automated tests, static design checks, and desktop/mobile browser checks pass.

## Current Limitations

Live endpoints, Azure context, gateway keys, and test credentials were
intentionally absent during development. Automated validation can prove
catalogue completeness, protected-source fidelity, parser behavior,
configuration generation, server-side reconstruction, allowlisted execution
behavior with fake transports, streaming, redaction, cancellation, artifact
containment, state modelling, and browser workflows. It does not prove any
recipe against a live Azure environment.

The protected-source model is not maintenance-free. Upstream notebook changes
must be reviewed and deliberately reconciled with provenance, catalogue
metadata, typed builders, runtime registrations, assertions, and tests before
they become executable product behavior.

Local active-run state and generated workspaces are not yet a durable,
shareable, redacted evidence history. A future history record must bind source,
catalogue, plan, runtime, public inputs, step states, assertions, and artifact
digests while structurally excluding secrets and authorization material.
