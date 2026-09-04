# Project Brief

## Outcome

Deliver an isolated, selector-driven Citadel Publish Playground under `CitadelSamples` that faithfully presents every atomic sample from the imported publish-contract notebook.

## Scope

- Preserve the upstream notebook unchanged.
- Catalogue 19 selectable recipes across Discover, Prepare, Publish and grant, Exercise, Observe, Policy, and Lifecycle groups.
- Provide per-sample purpose, flow, prerequisites, acquisition/setup guidance, mandatory/conditional/optional/generated/secret parameters, downloadable redacted configuration, request plan, execution status, and result assertions.
- Implement a zero-build Node.js/ES-module web application with no runtime dependencies.
- Provide a preview-safe default and an explicitly enabled, loopback-only local executor for the catalogue's typed Azure CLI, HTTPS, generated-artifact, assertion, and registered Python steps.
- Reproduce the Control Plane visual system locally without importing or changing `CitadelUI` files.
- Add automated tests and browser-level verification that do not require Azure credentials.

## Explicit Exclusions

- No invented image or multimodal sample.
- No fabricated live response or successful execution.
- No arbitrary URL proxy or browser exposure of Azure management tokens.
- No changes outside `CitadelSamples`.
- No automated integration test may mutate Azure, generate load, or run cleanup. Those actions remain gated behind explicit operator mode, complete configuration, non-production confirmation, and fresh per-run acknowledgement.

## Architecture

The catalogue is the single source of truth for navigation, guides, exact per-sample configuration requirements, risk, source provenance, runtime dependencies, and builder dispatch. Pure builders compile validated inputs into typed `ExecutionPlan` steps. The server independently validates inputs and rebuilds each plan before a loopback-only local executor runs allowlisted operations. Preview mode remains the default; a narrow external relay remains available for remote deployments.

## Acceptance Criteria

- All 19 notebook recipes have unique IDs and source-cell citations.
- Every recipe has guide, prerequisite, configuration, preview, and response/assertion content.
- Every recipe exposes only relevant inputs and clearly separates mandatory, conditional, optional/defaulted, generated/override, and secret values.
- Configuration JSON and `.env.example` exports never include secret values.
- Required and conditional inputs are validated both before plan generation and again by the executing server.
- MCP session chaining and A2A JSON-RPC semantics are represented correctly.
- Secret fields remain memory-only and previews/copies are redacted.
- Risky operations require fresh acknowledgement; load and destructive recipes also require an explicit non-production confirmation.
- No browser-supplied command, URL, executable, header set, script, or path can reach the executor.
- The notebook hash remains unchanged.
- Automated tests, static design checks, and desktop/mobile browser checks pass.

## Current Limitations

Live endpoints, Azure context, gateway keys, and test credentials were intentionally absent during development. Automated validation proves catalogue completeness, configuration generation, server-side reconstruction, allowlisted execution behavior with fake transports, redaction, cancellation, state modelling, and browser workflows; it does not prove any recipe against a live Azure environment.
