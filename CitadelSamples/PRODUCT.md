# Citadel Publish Playground

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Azure platform engineers, API-management engineers, and application developers who need to understand, configure, and exercise Citadel publish-contract scenarios without reading a long validation notebook cell by cell.

## Product Purpose

Turn the imported Citadel publish-contract validation notebook into a guided playground. A user selects one sample, learns what it does, completes only the inputs and prerequisites that sample needs, inspects the exact operation that would run, and executes it when an approved runtime and credentials are supplied.

Success means every notebook scenario is represented faithfully, its prerequisites are actionable, generated operations are deterministic and inspectable, and unavailable live execution is reported honestly rather than simulated.

## Positioning

The playground is an executable companion to the source notebook: each guided sample remains traceable to its original cells while separating shared environment context, sample-specific configuration, request generation, execution capability, and result assertions.

## Operating Context

- The authoritative source is `citadel-publish-contract-tests.ipynb`, imported unchanged from the Azure Samples repository.
- Users may be preparing or validating Azure API Management, MCP, A2A, Foundry, Application Insights, Key Vault, rate-limit, and cleanup workflows.
- Real Azure and gateway credentials were not available during development, so live behavior must remain explicitly unproven until a non-production integration run.
- Preview mode performs no effects. An explicitly enabled loopback-only operator mode executes catalogue-owned Azure CLI, HTTPS, generated-artifact, assertion, and registered Python steps. A remote deployment uses the narrower relay boundary instead.

## Capabilities and Constraints

- Present one selected sample at a time rather than rendering every scenario on one page.
- Preserve a catalogue of all 19 atomic recipes found in the notebook; do not invent image-generation, multimodal, LLM-inference, or other samples absent from the source.
- Show only the fields a selected sample actually uses, grouped as mandatory, conditional, optional/defaulted, generated/override, or secret.
- Provide Guide, Configure, Request, and Response views for every sample.
- Generate deterministic, redacted configuration manifests and execution plans that users can copy or download.
- Execute validated samples through an explicit local operator mode while keeping ordinary startup preview-only.
- Treat missing executors, credentials, and target environments as `Not configured` or `Not run`, never as success.
- Never persist secrets in browser storage, copied previews, URLs, logs, or fixtures.
- Require explicit confirmation for state-changing, load-generating, and destructive operations.
- Keep all project files and changes within `CitadelSamples`.

## Brand Commitments

Use the existing Citadel Control Plane visual language as the binding design authority: a deep Azure-blue masthead, bright paper-like working sheet, dense rails, restrained semantic colour, hairline rules, recessed input wells, Segoe UI typography, and Cascadia Mono for identifiers and values.

## Evidence on Hand

- `citadel-publish-contract-tests.ipynb` is the exact upstream notebook, SHA-256 `ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb`.
- The notebook contains 36 cells: 17 Markdown cells and 19 code cells, with no saved outputs or attachments.
- Existing Control Plane implementation is available read-only under `../CitadelUI/web`.
- No live Azure response evidence or credentials are available yet; the product must not fabricate either.

## Product Principles

1. Source fidelity over invented convenience.
2. Explain prerequisites before asking for parameters.
3. Preview the exact operation before any effect.
4. Keep secrets ephemeral and redact them everywhere else.
5. Distinguish generated, blocked, running, passed, failed, and inconclusive states precisely.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All workflows must be keyboard-operable, expose programmatic labels and validation messages, maintain visible focus, support 200% zoom and reduced motion, and remain usable from a 320px viewport through wide desktop screens.
