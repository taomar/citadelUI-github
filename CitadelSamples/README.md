# Citadel Publish Playground

A guided, selector-driven companion to the Citadel publish-contract validation
notebook. Select one sample, read what it does and what it needs, fill only the
inputs that sample requires, inspect the exact operation that would run, and see
an honest result.

Nothing here fabricates a response, and nothing here runs against Azure unless
an approved execution adapter is deliberately attached.

The redesign makes this a maintained product with a notebook-like surface, not a
general-purpose editable notebook. Repository-owned source is visible,
attributable, and protected. Users can change only the declared, typed inputs for
the selected catalogue sample. The server remains authoritative for source
selection, validation, plan construction, operation registration, and
execution.

---

## Provenance

The authoritative source is `citadel-publish-contract-tests.ipynb`, imported
**unchanged** from the Azure Samples AI Hub Gateway solution accelerator.

| | |
| --- | --- |
| Upstream repository | [`Azure-Samples/AI-Hub-Gateway-Solution-Accelerator`](https://github.com/Azure-Samples/AI-Hub-Gateway-Solution-Accelerator) |
| Upstream path | `validation/citadel-publish-contract-tests.ipynb` |
| Ref / commit | `main` @ `ede33909b10800700bc1a5394af84efbe2add892` (2026-08-14) |
| Git blob SHA-1 | `e07fdb18607db6ea1b0f8eef6920f24a88cb7e73` |
| SHA-256 | `ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb` |
| Size | 66 241 bytes, LF line endings |
| Shape | 36 cells — 17 Markdown, 19 code, no saved outputs, no attachments |

The upstream raw file was fetched and hashed during the build; it matches the
imported copy byte for byte. The full record, including the sample-to-cell map,
lives in [`playground/provenance.json`](playground/provenance.json) and is
re-verified on every test run.

> The notebook is never modified, moved or reformatted. A test recomputes its
> SHA-256 from disk and fails if it changes.

### What the catalogue contains — and what it deliberately does not

Nineteen atomic recipes, one per selectable scenario, across seven groups:

| Group | Recipes | Notebook code cells |
| --- | --- | --- |
| Discover | 2 | 4, 6 |
| Prepare | 3 | 8, 10, 12 |
| Publish and grant | 3 | 14, 15, 17, 18 |
| Exercise | 6 | 20, 22, 28, 29 |
| Observe | 2 | 24, 26 |
| Policy | 2 | 31 |
| Lifecycle | 1 | 35 |

Two code cells are deliberately not recipes and say so: cell 2 is variable
initialisation, modelled as the five shared profiles; cell 33 is the notebook's
own results roll-up, which several cells never populate, so each recipe reports
its assertions directly instead.

**There is no image, multimodal or LLM-inference sample, because the notebook
has none.** None of its 19 code cells generates, uploads or interprets an image.
It grants LLM APIs and writes an `llm-token-limit` into the product policy, but
it never sends a completion or chat request — cell 30 states that LLM token
limits are "validated best-effort only when a model is reachable", and no cell
does so. Inventing those samples would put a passing result behind an assertion
the source never makes. The exclusions are listed in the catalogue, shown in the
UI, and asserted by a test.

### Exact 19-scenario provenance

The 19 catalogue IDs are the stable join keys between navigation,
configuration, source, plans, execution, results, and tests. Each ID maps to
exact zero-based notebook cell indexes in `playground/provenance.json`. The
protected source surface joins each cited cell's `source` array without
normalising it and identifies the cell by index, type, UTF-8 byte length, and
SHA-256.

Cells 2 and 33 are the only notebook code cells that are not standalone
scenarios. Cell 2 defines shared profile values; cell 33 is the notebook's
incomplete results roll-up. Catalogue and provenance tests require every other
code cell to be cited by at least one of the 19 scenarios.

| # | Stable catalogue ID | Group | Exact source cells |
| ---: | --- | --- | --- |
| 1 | `azure-context-check` | Discover | 3, 4 |
| 2 | `apim-discovery` | Discover | 5, 6 |
| 3 | `foundry-enable-a2a` | Prepare | 7, 8 |
| 4 | `apim-foundry-grant` | Prepare | 9, 10 |
| 5 | `weather-api-ensure` | Prepare | 11, 12 |
| 6 | `publish-assets` | Publish and grant | 13, 14, 15 |
| 7 | `access-contract-deploy` | Publish and grant | 16, 17 |
| 8 | `access-contract-kv-verify` | Publish and grant | 18 |
| 9 | `weather-mcp-discovery` | Exercise | 19, 20 |
| 10 | `learn-mcp-discovery` | Exercise | 19, 20 |
| 11 | `a2a-agent-card` | Exercise | 21, 22 |
| 12 | `a2a-message-send` | Exercise | 21, 22 |
| 13 | `agent-framework-hr-question` | Exercise | 27, 28 |
| 14 | `weather-tools-call` | Exercise | 29 |
| 15 | `usage-metrics` | Observe | 23, 24 |
| 16 | `circuit-breaker-check` | Observe | 25, 26 |
| 17 | `tool-rate-limit-burst` | Policy | 30, 31 |
| 18 | `agent-rate-limit-burst` | Policy | 30, 31 |
| 19 | `cleanup` | Lifecycle | 34, 35 |

These are zero-based notebook indexes. They are not renumbered for display,
review, execution, evidence, or exports.

### Why the code is protected

The notebook-like surface is for reading, provenance, declared configuration,
and controlled execution. It has no code-editing mode and no arbitrary Python,
shell, Azure CLI, dependency, URL, or filesystem input.

That boundary creates a real maintenance obligation. When the upstream notebook
changes, maintainers must deliberately reconcile its source and provenance with
catalogue metadata, typed builders, runtime registrations, allowlists,
assertions, and tests. This is more work than embedding an editable notebook
kernel, but it preserves deterministic plans, reviewable authority, meaningful
risk acknowledgement, and evidence that can be attributed to a fixed operation.

---

## Quick start

Node 20.6 or newer is required. The web application has no package dependencies,
and preview mode needs no installation.

```bash
cd CitadelSamples/playground

npm start
```

Open the secure launch URL printed in the terminal. Its one-time URL fragment is
removed immediately and exchanged for an HttpOnly local session cookie. Preview
mode lets you select all 19 samples, complete their configuration, export JSON
or `.env.example`, and inspect the exact protected source and generated plan. It
executes nothing. Opening the plain `http://127.0.0.1:4173/` URL is read-only and
cannot invoke self-test, validation, identity, login, relay, or execution APIs.

The diagnostics drawer includes an **Offline self-test** — a fixed, local
demonstration that needs no Azure subscription, no credential, and no network.
It runs deterministic checks against this exact checkout through the real
`/api/self-test` route in preview and operator mode. Its result always reports
`azureContacted: false` and `liveEvidence: false` and can never be mistaken for a
live scenario outcome.

To execute samples from this machine:

```bash
az login

# Required only by samples whose Runtime section names Python modules.
python -m pip install -r runtime/requirements.txt

npm run start:execute
```

Operator mode is deliberately separate from ordinary startup. It probes only
local runtimes at boot; it does not contact Azure or a gateway until **Run
Sample** is selected. Local execution is refused unless the server binds to
loopback. The launch capability and cookie rotate on restart; hosted deployments
keep their trusted proxy and Entra authentication boundary.

Available commands:

| Command | Purpose |
| --- | --- |
| `npm start` | Safe preview-only server |
| `npm run start:execute` | Loopback-only local execution |
| `npm test` | 670 recursive Node tests |
| `npm run check` | Static imports, zero dependencies, and isolation checks |
| `npm run smoke` | 89 browser interaction and responsive checks |
| `npm run verify` | Check, unit/integration tests, then browser smoke |

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CITADEL_PLAYGROUND_PORT` | `4173` | Listening port |
| `CITADEL_PLAYGROUND_HOST` | `127.0.0.1` | Bind address; local execution accepts loopback only |
| `CITADEL_PLAYGROUND_PYTHON` | `python` on Windows, `python3` elsewhere | Approved Python interpreter |
| `CITADEL_PLAYGROUND_PUBLIC_ORIGIN` | *(unset)* | Exact canonical HTTPS browser origin required by every state-changing JSON route on a non-loopback bind |
| `CITADEL_PLAYGROUND_RELAY_URL` | *(unset)* | Approved external execution relay |
| `CITADEL_PLAYGROUND_RELAY_ALLOWED_SAMPLE_IDS` | *(required when relay URL is set)* | Deployment-owned JSON array; the playground advertises and forwards only this subset |
| `CITADEL_PLAYGROUND_RELAY_TOKEN` | *(unset)* | Development-only static relay credential; hosted Container Apps uses managed identity instead |

The relay URL and credentials are never returned to browser code. Hosted
deployment passes the same serialized allowed-sample array to the playground and
relay. Unknown, duplicate, malformed, or relay-ineligible IDs are rejected rather
than widened to the catalogue-derived eligible set. The trusted public origin is
matched exactly; forwarded host and protocol headers do not broaden it.

---

## Prepare the Signed Run Dossier wizard

Every sample declares its configuration explicitly. The wizard derives only the
steps that recipe needs: Azure account and target, gateway connection, hosted
context, required inputs, credentials and options, review, and run/result.
Inapplicable steps are omitted and the displayed step count is renumbered.

| Group | Meaning |
| --- | --- |
| **Mandatory** | Must be supplied before the sample can run |
| **Conditional** | Mandatory only while the stated condition is true |
| **Optional** | Pre-filled from the notebook; blank uses the documented fallback |
| **Generated / override** | Produced by discovery or an earlier recipe; may be overridden |
| **Secrets** | Required only for samples that present a credential; memory-only |

Required inputs lead their task. Conditional fields appear only while their
condition applies; defaulted and generated/override values use progressive
disclosure. Every field states its purpose, readiness, expected format, and
concise recovery action. Inline errors name the correction needed.

The summary names missing values, identity mismatches, and runtime dependencies
before Run can be enabled. **Copy configuration (JSON)** and
**Download configuration** produce a deterministic manifest containing source
cells, prerequisites, grouped inputs, risk, runtime requirements, missing
values, and generated operations.
`.env.example` actions produce empty environment-variable placeholders. Neither
format can contain a secret value.

---

## Architecture

```
CitadelSamples/
  citadel-publish-contract-tests.ipynb   the imported source, never modified
  README.md                              this file
  PRODUCT.md  PROJECT_BRIEF.md  AGENT_PROGRESS.md
  playground/
    package.json          zero dependencies, "type": "module"
    provenance.json       upstream record + sample-to-cell map
    server.mjs            preview/operator server and guarded API routes
    runtime/
      accelerator/        pinned closed Bicep/policy/weather dependency bundle
      python/             registered Python wrappers + compile-only validator
      requirements.txt    optional Python modules; never auto-installed
    src/
      core/               types, endpoints, validation, secrets, parsing,
                          configuration, capability, plan, state, executor
      catalogue/
        profiles.mjs      the five shared profiles + every reference link
        requirements.mjs  exact per-sample execution requirements
        index.mjs         the single source of truth
        samples/          discover, prepare, publish, exercise, observe,
                          policy, lifecycle
      server/             source extraction, validation requests, compile-only
                          validation, reconstruction, operation registry,
                          transports, assertions, workspaces and run manager
      view/               pure view models and streamed-run reducer — no DOM
    web/
      index.html          direction contract and semantic landmarks
      css/                world.css (foundation), workbench.css (components)
      js/                 main.mjs + render/{dom,directory,panels,context}
    test/                 Node unit/integration suites, including relay tests
    scripts/              check.mjs (static), smoke.mjs (headless browser)
```

**The catalogue is the single source of truth.** Navigation, forms, validation,
guides, risk, provenance and builder dispatch all read it; nothing else owns
sample identity.

**Protected source is selected by the server.** The browser requests a catalogue
sample ID and expected provenance, never source text or a path. The server loads
the unchanged notebook, verifies its recorded digest, and resolves only the
cells cited by that sample. Parameters are a separate declared data contract;
editing them never rewrites source.

**Builders are pure and deterministic.** Each recipe compiles validated inputs
into an `ExecutionPlan` of typed steps — `artifact`, `azure-cli`, `http`,
`library`, `assertion` — with declared `produces` / `consumes` bindings between
them. No timestamps, no random ids: the same inputs always compile to the same
plan, which is what makes the golden plan tests meaningful. A plan never
performs I/O.

**Secrets are structural, not filtered.** A plan never contains a credential
*value*. Wherever the notebook would interpolate `api_key`, the plan carries an
inert `SecretRef` naming the field, and previews render it as
`${CITADEL_GATEWAY_ACCESS_API_KEY}`. Redaction is a second line of defence, and
`assertNoSecretValues` runs over every plan, every preview, and every string
before it reaches the clipboard. The single secret field lives in a `Map` in one
module; a test greps the whole source tree for browser storage APIs, cookies,
IndexedDB, credential-bearing log lines and URL writes.

**Risk is a gate, not a label.** Eight recipes are state-changing, load-
generating or destructive. Each needs an explicit per-run acknowledgement before
an executor is ever reached — whether or not a runtime is attached — and editing
any input clears every acknowledgement, so consent can never be inherited by a
different configuration. The two burst recipes and cleanup additionally require
a typed non-production confirmation before a plan is generated at all.

### Runner and evidence labels

Runner locality and evidence source are reported separately:

| Runner badge | What it means |
| --- | --- |
| **PREVIEW ONLY** | Generate and inspect without execution |
| **OFFLINE SELF-TEST** | Run the fixed local checkout checks |
| **LOCAL OPERATOR** | Run registered operations on this machine |
| **HOSTED RELAY** | Run eligible HTTP/assertion work through the narrow relay |

| Evidence badge | What it means |
| --- | --- |
| **NOT RUN** | No execution evidence exists |
| **LOCAL CHECKOUT EVIDENCE** | Protected source, parser, or fixed self-test evidence; Azure was not contacted |
| **LIVE TARGET EVIDENCE** | The approved target was contacted and the result derives from that run |

Local checkout evidence always reports `azureContacted: false` and
`liveEvidence: false`. A **LOCAL OPERATOR** run may produce
**LIVE TARGET EVIDENCE**, so local is not a synonym for offline or simulated.
Executor availability, process exit 0, HTTP 2xx, and parser success never become
live target evidence by themselves.

### Python validation is not Python execution

Offline Python validation loads the server-selected protected cells, verifies
their digest, and invokes a bounded parser-only standard-library operation. It
does not import the sample, run top-level code, resolve dependencies, install
packages, contact the network, use credentials, or write bytecode into the
protected tree.

The validation body contains only the execution protocol version. It accepts no
configuration value, secret, source, path, command, executable, parser flag, URL,
or environment. Declared parameter zones are server-owned catalogue metadata
shown beside the source; they are not substitutions into the parser input.

Exact source retrieval is process-free and available in preview and operator
modes. Parser-only validation is available only after explicit loopback
`start:execute` startup; public preview and the hosted relay remain unable to
spawn a process.

Real Python behavior is available only through a registered catalogue operation
in local operator mode. The server rebuilds the plan, checks declared inputs and
risk, and invokes an allowlisted shipped wrapper. The two operations have
different controls and evidence labels.

---

## The live-execution boundary

The browser is never the authority for an operation. It sends only the selected
sample ID, that sample's declared values, transient declared secrets, and a
fresh acknowledgement. The server rejects unknown keys and independently
validates the configuration, rechecks risk, and rebuilds the plan from its own
catalogue. A browser cannot supply a plan, command, URL, executable, header set,
script, or file path.

The local executor supports all five catalogue step types:

| Step | Execution |
| --- | --- |
| `artifact` | Writes generated content into `.runs/<run-id>/` only |
| `azure-cli` | Runs registered `az` operations with argument arrays and no shell |
| `http` | Sends catalogue-built HTTPS requests with bounded redirects, time, size, and concurrency |
| `library` | Runs a registered shipped Python wrapper after import preflight |
| `assertion` | Evaluates the sample's expected behavior from captured evidence |

Each local run streams bounded NDJSON lifecycle events and then a final typed
result. The UI can show the run ID, workspace, active step, completed step state,
and whether bounded evidence is available before the full run finishes. The
partial-event reducer does not retain raw evidence, commands, source, secret
updates, or artifact paths. The final typed result carries redacted evidence,
assertions, generated artifacts, and discovered configuration updates. JSON-only
clients retain that final-result contract.

Cancellation targets the exact active run ID. It requests termination; it does
not claim that an external effect already completed has been rolled back.
Generated artifacts must be declared by catalogue steps, bounded, and contained
under `.runs/<run-id>/`.

Public discoveries can update later forms. A newly minted gateway key can update
only the current browser's in-memory secret store; it never enters rendered
evidence, logs, exported configuration, or persistent storage.

Protection is enforced at the execution boundary:

- local execution is loopback-only and preview mode remains the default;
- state-changing calls require same-origin JSON requests;
- executable and sample/step operations are allowlisted;
- subprocesses use `shell: false`, bounded output, timeout, and cancellation;
- HTTP is HTTPS-only, does not follow redirects, and cannot become an arbitrary proxy;
- generated paths are contained in a per-run workspace under `CitadelSamples`;
- known secrets and credential-shaped output are redacted before a result leaves
  the executor;
- state-changing, load-generating, and destructive recipes require fresh
  acknowledgement, and burst/cleanup samples require non-production confirmation.

The external relay is a separate, narrow hosted boundary. It rebuilds only
eligible allowlisted plans and executes HTTP and assertion steps. Its image and
import graph deliberately omit Python, Azure CLI, process transports, arbitrary
files, workspaces, and artifact writers. It must remain HTTP/assertion-only.
The deployed direct `/execute` path uses process-local atomic nonce consumption
and request admission, so each active revision is fixed at one replica and
horizontal scale-out is prohibited until one shared atomic adapter backs both
controls. Revision transitions and restarts replace that local replay history, so
operators must drain the acknowledgement validity window before rollout.
Separate managed run primitives use owner-bound nonce/idempotency, distributed
concurrency and active-job capacity, dispatcher lease recovery, polling,
cancellation, and timeouts when a durable shared store is injected. That managed
path is proved offline but is not wired by the hosted entrypoint or Bicep.

Future hosted process execution is a different capability, not a relay feature.
One run must create one fresh immutable, no-ingress isolated job with no compute
or writable-volume reuse. Identity must be capability-scoped and distinct from
the relay, egress enforced outside the workload, state durable and owner-bound,
limits platform-enforced, cancellation verified against the actual job, and
outputs quarantined as owner-only bounded artifacts. Until those controls pass
live integration tests and independent security review, hosted Python and Azure
CLI execution remain disabled and unproven.

---

## Where the per-sample guides live

Each recipe carries its own guide **inside the catalogue**, rendered in the app's
Guide tab. There is no parallel Markdown copy to drift out of date. Every recipe
supplies:

- **Purpose** — why you would run it;
- **What it does** — several paragraphs of mechanism, not restatement;
- **Flow** — the numbered operations, in order;
- **Prerequisites** — each with detail, a how-to and an authoritative Microsoft
  Learn link;
- **Risk** — level, effect, blast radius, reversibility, acknowledgement prompt;
- **Source and deviations** — the notebook cells it comes from, what those cells
  do, and every point where this playground behaves differently.

The deviations are the part worth reading. Several are corrections of real
weaknesses in the source, all disclosed rather than silently applied:

| Recipe | Disclosed deviation |
| --- | --- |
| A2A message/send | The notebook records a pass from the HTTP status alone, so a JSON-RPC `error` inside an HTTP 200 counts as success. This fails it. |
| Enable Foundry A2A | The notebook as published sends `"Authorization": f"******"` — a redaction artefact. Run verbatim, its PATCH would be rejected. |
| Verify Key Vault secrets | The notebook's roll-up is computed from the endpoint secrets alone, so a missing api-key secret still reads as a pass. This requires both, and checks the key's length rather than printing it. |
| Usage metrics | The notebook's KQL has no time filter, so it reports cumulative totals. This adds an explicit lookback window and reports an empty window inside the ingestion delay as inconclusive. |
| Circuit breaker | Cell 25's heading claims the A2A backend is checked; cell 26 only iterates `mcp-existing` assets. The gap is exposed as an opt-in. |
| API Management discovery | The notebook's helper resolves one instance without reporting how many candidates it saw. This lists first and refuses to select silently. |
| Cleanup | The notebook's cleanup cell references variables defined only in cell 17, so running it standalone raises `NameError`. It also leaves seven things behind, each listed here with the command that removes it. |
| Burst recipes | The notebook bursts a live gateway with no confirmation. Both require an explicit non-production confirmation and a per-run acknowledgement. |

---

## Design

The Control Plane visual world is **reproduced locally, not imported**. Nothing
under `playground/` reads, links or modifies `CitadelUI`; a test asserts it.

The surface is a per-recipe Signed Run Dossier wizard using Azure deployment
conventions. A grouped recipe directory occupies the left rail on wide screens
and becomes one drawer or full-height picker on compact screens. Wide layouts
add a compact step rail beside a centered task surface; compact layouts replace
it with a current-step selector. Sticky footer actions expose one contextual
primary action. Protected source, guide content, provenance, and diagnostics
open as secondary inspectors. Only Output uses internal tabs.

At 768–1199px the directory becomes a drawer and the dossier becomes one column.
At 767px and below, the recipe picker fills the available height and the action
dock respects the safe area. The 320x480 and 200% zoom layouts avoid page-level
horizontal overflow and keep focused controls clear of sticky regions.

Deep Azure-blue masthead, bright paper sheet, cool chrome rails; Fluent blue for
action and current position, cloud teal for values sourced outside the page,
semantic status hues; hairline rules, recessed control wells, Segoe UI Variable
for prose and Cascadia Mono for every identifier, endpoint and value. No
gradients, no glass, no same-size card grid, no nested cards, or fake dashboard
metrics. The only modal is the native destructive confirmation that protects an
irreversible target.

Accessibility targets WCAG 2.2 AA: landmarks, a skip link, programmatic labels,
Output-only roving tabs, `aria-invalid` and `aria-describedby` on every control
that needs them, a bounded `role="log"`, visible focus everywhere, forced-colors
support, and honoured `prefers-reduced-motion`. A required field the user has
not reached yet reads as *needed*, not as an *error* — the user has not made a
mistake, they have not arrived.

---

## Tests

```
npm test                 872/872 pass, node --test, no dependencies
npm run check            136 modules, 0 dependencies, nothing outside scope
npm run smoke            22/22 headless-browser interaction checks
npm run acceptance:dossier  113/113 browser checks, 15 screenshots
npm run verify           all three, in order
```

These totals were verified for the per-recipe wizard. The browser acceptance
matrix covers desktop, tablet, 390px, 320x480, true 200% zoom, reduced motion,
forced colors, protected source, concise acquisition help, approval invalidation,
and exact active-run isolation. The Impeccable detector returned no findings.

| File | Covers |
| --- | --- |
| `catalogue.test.mjs` | 19 unique recipes, group distribution, notebook hash and shape, complete code-cell coverage, provenance agreement, stated exclusions |
| `guides.test.mjs` | Guides, prerequisites, typed schemas, expected results, disclosed deviations, https authoritative links |
| `plans.test.mjs` | Every recipe compiles; determinism; binding order; plus golden plans for MCP, publish, access contract, Key Vault, weather, bursts, cleanup, metrics, circuit breaker |
| `validation.test.mjs` | Required/conditional matrices, type and range rules, derived-warns-not-blocks, acknowledgement guards, `mustEqual` confirmations |
| `endpoints.test.mjs` | Asset-type prefix, `/mcp` suffix, deployed-endpoint precedence, Foundry and ARM URL shapes |
| `protocol.test.mjs` | MCP session binding, numeric JSON-RPC ids, JSON and SSE parsing (including data folding), JSON-RPC error under HTTP 200 |
| `secrets.test.mjs` | No secret in any plan, preview or view model; memory-only state; no storage/cookie/URL/log paths; no credential-shaped literals |
| `executor.test.mjs` | Executor dispatch, progress forwarding, relay wire shape, allow-list and same-origin constraints |
| `sourceview.test.mjs` | Exact server-selected cited cells, full-notebook digest, per-cell bytes and hashes, and immutable parameter zones |
| `recipeRequest.test.mjs` | Exact source-validation schema: protocol version only; value/code/path/command members refused |
| `codevalidation.test.mjs` | Real compile-only Python across protected cells, limits, cancellation, cleanup, artifact report, and offline-only evidence |
| `execution-guardrails.test.mjs` | Fixed Azure CLI/Python operation shapes, child environment allowlist, output bounds, and process-tree timeout handling |
| `runProgress.test.mjs` | Ordered bounded partial state, terminal-state monotonicity, identifier/path refusal, and no raw evidence retention |
| `viewmodels.test.mjs` | Directory, protected Code, declared zones, configure, review, output, environment, and evidence models |
| `browser-acceptance.test.mjs` | Protected-source contracts and real Chromium flows for all 19 scenarios, validation gating, execution state, keyboard order, responsive layout, and redaction |
| `markup.test.mjs` | Wizard direction contract, landmarks, dynamic step wiring, component states, no gradients/nested cards/pixel tracks, responsive shape change |
| `requirements.test.mjs` | Exact relevant fields and mandatory/conditional/optional/generated/secret manifests for all 19 samples |
| `execution.test.mjs` | Allowlisted CLI/HTTP/Python/artifact/assertion execution with fake transports, bindings, redaction, limits, and cancellation |
| `runmanager.test.mjs` | Server reconstruction, risk gates, concurrency, run IDs, workspaces, updates, and secret handling |
| `server.test.mjs` | Preview/operator modes, loopback restriction, same-origin JSON guard, body limits, capability, and vendored runtime closure |
| `selftest.test.mjs` | `/api/self-test` exact-schema validation and the five offline checks it runs, including that it never contacts Azure or the network |

`scripts/smoke.mjs` and the wizard browser acceptance harness drive headless
Chromium over the DevTools Protocol using Node built-ins—no Playwright,
Puppeteer, or dependency. They cover recipe and step URL state, dynamic identity
tasks, exact protected source, configuration copy/download, validation focus,
risk approval invalidation, secret redaction, active-run navigation and
cancellation isolation, keyboard order, mobile and 200% layouts, reduced motion,
forced colors, and the offline self-test through the real server.

---

## Current limitations

- **Nothing has been executed against Azure.** No live endpoint, subscription,
  gateway key or Foundry project was available. Every assertion in the catalogue
  is derived from the notebook and the accelerator's own sample files, not from
  an observed response.
- **No live Azure result is proven yet.** Local execution and its failure modes
  are tested with injected transports, but no real subscription, gateway,
  Foundry project, Key Vault, burst, or cleanup was used during development.
- **Offline source validation is not sample execution.** Parser and contract
  success proves protected-source integrity and syntax only.
- **Operator prerequisites remain the operator's responsibility.** The server
  probes local `az`, Python imports, and the vendored bundle. It does not sign
  in, install packages, grant roles, or contact customer endpoints at startup.
- **Hosted process execution is not available.** The relay remains
  HTTP/assertion-only; per-run no-ingress jobs are a future, separately gated
  architecture.
- **Run history and artifact retrieval are not durable services.** Local
  workspaces are not an owner-authorized evidence store and do not yet provide a
  redacted immutable run manifest, authorized download endpoint, retention
  deletion, or hosted artifact quarantine.
- **Runtime discoveries last only for the current browser session.** Secrets
  remain memory-only and generated run workspaces remain local.
- **Browser evidence is Chromium-only.** Firefox, Safari, and a real
  NVDA/JAWS/VoiceOver pass remain outstanding.
