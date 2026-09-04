# Project Brief

## Outcome

Deliver an isolated, selector-driven Citadel Publish Playground under `CitadelSamples` that faithfully presents every atomic sample from the imported publish-contract notebook.

## Scope

- Preserve the upstream notebook unchanged.
- Catalogue 19 selectable recipes across Discover, Prepare, Publish and grant, Exercise, Observe, Policy, and Lifecycle groups.
- Provide per-sample purpose, flow, prerequisites, acquisition/setup guidance, typed parameters, validation, redacted request plan, execution status, and result assertions.
- Implement a zero-build Node.js/ES-module web application with no runtime dependencies.
- Reproduce the Control Plane visual system locally without importing or changing `CitadelUI` files.
- Add automated tests and browser-level verification that do not require Azure credentials.

## Explicit Exclusions

- No invented image or multimodal sample.
- No fabricated live response or successful execution.
- No arbitrary URL proxy or browser exposure of Azure management tokens.
- No changes outside `CitadelSamples`.
- No live Azure mutation, load burst, or cleanup until the user supplies a safe test environment and explicitly enables it.

## Architecture

The catalogue is the single source of truth for navigation, guides, schemas, risk, source provenance, and builder dispatch. Pure builders compile validated inputs into typed `ExecutionPlan` steps. The initial executor returns a typed unavailable result; future allowlisted relay, Azure management, and Python Agent Framework adapters can implement the same contract without changing the UI or builders.

## Acceptance Criteria

- All 19 notebook recipes have unique IDs and source-cell citations.
- Every recipe has guide, prerequisite, configuration, preview, and response/assertion content.
- Required and conditional inputs are validated before plan generation.
- MCP session chaining and A2A JSON-RPC semantics are represented correctly.
- Secret fields remain memory-only and previews/copies are redacted.
- Risky operations require acknowledgement even when a future executor is configured.
- The notebook hash remains unchanged.
- Automated tests, static design checks, and desktop/mobile browser checks pass.

## Current Limitations

Live endpoints, Azure context, gateway keys, and test credentials are intentionally absent. The initial release proves catalogue completeness, input handling, request generation, redaction, state modelling, and executor integration boundaries.
