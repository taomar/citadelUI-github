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

The playground is a maintained, executable companion to the source notebook. It
adds a notebook-like reading surface without becoming a general-purpose
notebook: the cited Markdown and code are visible, attributable, and protected,
while only declared parameters and configuration values are editable.

Each guided sample remains traceable to its exact source cells while separating
shared environment context, sample-specific configuration, request generation,
execution capability, and result assertions.

## Product and Architecture Decision

The product keeps the server-authoritative catalogue and typed, allowlisted
executor. The browser selects a catalogue sample and supplies only that sample's
declared inputs, transient declared secrets, and any required acknowledgement.
It never supplies source code, a command, an executable, a plan, a URL, headers,
or a filesystem path.

The notebook-like surface is therefore a protected-source experience:

- show the exact repository-owned cells cited by the selected sample;
- identify every cell by notebook index, type, byte length, and digest;
- keep source read-only and make the editable parameter zones explicit;
- validate Python locally with a parser-only operation that does not import or
  execute the sample; and
- run real behavior only through the separately labelled registered executor.

This is intentionally a maintained product rather than a generic notebook host.
The tradeoff is deliberate: every upstream source or behavior change must be
reviewed and reflected in provenance, catalogue metadata, typed builders,
allowlists, assertions, and tests. That costs more maintenance than accepting
editable cells, but preserves a reviewable operation, bounded authority,
deterministic plans, honest evidence, and a usable path for operators who should
not need to understand or safely edit the original notebook.

## Why an Existing Notebook Product Was Not Adopted

The evaluated products solve a different authority problem:

- JupyterLab, VS Code notebooks, Codespaces, Azure Machine Learning, and Runme
  expose editable code and/or a terminal by design.
- JupyterLite is a strong offline presentation reference but cannot faithfully
  provide the installed Azure CLI, native dependencies, or server-side Azure
  identity required by these scenarios.
- Papermill supplies useful parameter and output-run provenance, but not a
  protected form, plan review, approval, or execution allowlist.
- Voila, marimo app mode, Observable, and Streamlit offer useful presentation
  and reactive-input patterns, but Citadel would still have to build its visible
  provenance, typed schema, secret handling, risk approval, server-side plan,
  operation allowlist, and evidence semantics.

Replacing the current application would add framework, kernel, dependency, and
supply-chain surface without replacing the Citadel-specific work. The
lowest-risk and lowest-duplication choice is to extend the existing catalogue
and executor while borrowing notebook interaction patterns.

## Experience Model

The product direction is a per-recipe, Azure-style Signed Run Dossier wizard.
Its steps are derived from the selected recipe rather than repeated mechanically:

1. the applicable Azure account, gateway connection, or hosted execution context;
2. required and active conditional inputs;
3. ephemeral credentials plus optional, generated, and advanced values;
4. review and risk-specific approval; and
5. the active run and its result.

Steps that do not apply are omitted and the displayed count is renumbered
honestly. The current recipe and step are URL-owned so browser history restores
the operator's place without persisting secrets. Protected source, guide content,
provenance, and diagnostics are secondary inspectors: they remain attributable
and immutable, but they never displace an actionable blocker.

The trust boundary stays visible through separate **Identity**, **Target**, and
**Authorization** facts. Authorization uses **Ready to Attempt** when the known
gates pass; it never claims that Azure or the target has authorized an operation
before the attempt. Primary controls say **Review Sample**, **Run Sample**, and
**Cancel Run**. Output alone may use internal **Transcript**, **Evidence**, and
**Artifacts** tabs.

## Operating Context

- The authoritative source is `citadel-publish-contract-tests.ipynb`, imported unchanged from the Azure Samples repository.
- Users may be preparing or validating Azure API Management, MCP, A2A, Foundry, Application Insights, Key Vault, rate-limit, and cleanup workflows.
- Real Azure and gateway credentials were not available during development, so live behavior must remain explicitly unproven until a non-production integration run.
- Preview mode performs no effects. Exact protected source retrieval is
  available in every mode because it requires no process.
- Parser-only Python validation is available only in explicit loopback local
  operator mode. Keeping it out of public preview and the hosted relay preserves
  their process-free boundary.
- An explicitly enabled loopback-only operator mode executes catalogue-owned
  Azure CLI, HTTPS, generated-artifact, assertion, and registered Python steps.
- The existing hosted relay remains HTTP/assertion-only. Its deployed direct path
  is fixed at one replica per active revision because nonce and admission state
  are process-local; horizontal scale-out requires one shared atomic adapter, and
  rollouts must drain the acknowledgement validity window because process-local
  replay history is replaced. Its separate managed-run state machine is replica-
  safe with a durable shared store, as proved offline, but is not wired by the
  hosted entrypoint or Bicep.
- Any future hosted process execution must use a fresh, no-ingress, per-run
  isolated job rather than the public playground or long-lived relay process.

## Runner and Evidence Contract

Runner locality and evidence source are separate facts and must never share one
badge.

| Runner badge | Meaning |
| --- | --- |
| **PREVIEW ONLY** | Generate and inspect without execution |
| **OFFLINE SELF-TEST** | Run the fixed local checkout checks |
| **LOCAL OPERATOR** | Run registered operations on this machine |
| **HOSTED RELAY** | Run an eligible allowlisted HTTP/assertion plan through the narrow relay |

| Evidence badge | Meaning |
| --- | --- |
| **NOT RUN** | No execution evidence exists |
| **LOCAL CHECKOUT EVIDENCE** | Protected source, parser, or fixed self-test evidence; Azure was not contacted |
| **LIVE TARGET EVIDENCE** | The approved target was contacted and the result derives from that run |

Every result must also state `azureContacted` and `liveEvidence`. A local parser
result is always local checkout evidence. A real sample may run through
**LOCAL OPERATOR** and produce **LIVE TARGET EVIDENCE**; local must never be used
as a synonym for simulated or offline.

## Capabilities and Constraints

- Present one selected sample at a time rather than rendering every scenario on one page.
- Preserve a catalogue of all 19 atomic recipes found in the notebook; do not invent image-generation, multimodal, LLM-inference, or other samples absent from the source.
- Show the exact cited notebook cells in a read-only, notebook-like surface with
  per-cell provenance.
- Show only the fields a selected sample actually uses, grouped as mandatory, conditional, optional/defaulted, generated/override, or secret.
- Provide one per-recipe wizard whose steps are derived from execution context and
  declared requirements. Preserve entered values between steps, validate before
  advancing, and allow direct navigation only to the current or completed steps.
  Source and guide content open as inspectors rather than workflow tabs.
- Keep one global execution-context surface. Gateway-key recipes show key
  presence and never offer Azure sign-in. Hosted relay recipes show the Entra
  caller, playground identity, relay managed identity, Key Vault mapping, and
  target as separate authority hops.
- Allow local account switching only when the loopback server advertises a
  launch-gated system-browser capability. Otherwise the UI fails closed and
  explains that the launch-private CLI session is unavailable rather than
  exposing its path for terminal authentication. The UI never exposes a device
  URL, short code, private profile path, or copy action.
- Treat active Azure CLI subscription and intended recipe target as separate
  facts. A server-enumerated subscription selector requires an explicit
  **Set Active** action and explains that the change affects only this launch.
- Generate deterministic, redacted configuration manifests and execution plans that users can copy or download.
- Distinguish parser-only Python validation from registered Python sample
  execution in both controls and evidence.
- Execute validated samples through an explicit local operator mode while keeping ordinary startup preview-only.
- Stream bounded run and step progress, support cancellation by the exact active
  run ID, and expose only declared, contained artifacts in the final result.
- Keep partial progress free of raw evidence, commands, source, secret updates,
  and artifact paths.
- Treat durable redacted run manifests and authorized artifact history as a
  future product capability, not as evidence already delivered by transient
  local workspaces.
- Treat missing executors, credentials, and target environments as `Not configured` or `Not run`, never as success.
- Never persist secrets in browser storage, copied previews, URLs, logs, or fixtures.
- Require explicit confirmation for state-changing, load-generating, and destructive operations.
- Keep the hosted relay HTTP/assertion-only. Do not add Python, Azure CLI,
  arbitrary files, or process creation to its image or request contract.
- Treat future hosted process execution as a separate capability gated on
  per-run no-ingress isolation, immutable images, least-privilege identity,
  external egress enforcement, durable ownership, quota, cancellation, artifact
  quarantine, cleanup, and independent security review.
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
2. Protected code and declared inputs over arbitrary editability.
3. Explain prerequisites before asking for parameters.
4. Preview the exact operation before any effect.
5. Keep secrets ephemeral and redact them everywhere else.
6. Distinguish runner locality from evidence source, including local operator
   runs that produce live target evidence.
7. Distinguish queued, running, cancelled, passed, failed, blocked, and
   inconclusive states precisely.

## Accessibility & Inclusion

Target WCAG 2.2 AA. All workflows must be keyboard-operable, expose programmatic labels and validation messages, maintain visible focus, support 200% zoom and reduced motion, and remain usable from a 320px viewport through wide desktop screens.
