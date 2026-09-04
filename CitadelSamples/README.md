# Citadel Publish Playground

A guided, selector-driven companion to the Citadel publish-contract validation
notebook. Select one sample, read what it does and what it needs, fill only the
inputs that sample requires, inspect the exact operation that would run, and see
an honest result.

Nothing here fabricates a response, and nothing here runs against Azure unless
an approved execution adapter is deliberately attached.

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

---

## Quick start

Node 20.6 or newer is required. The web application has no package dependencies,
and preview mode needs no installation.

```bash
cd CitadelSamples/playground

npm start
```

Open `http://127.0.0.1:4173/`. Preview mode lets you select all 19 samples,
complete their configuration, export JSON or `.env.example`, and inspect the
exact generated plan. It executes nothing.

The masthead also carries an **Offline self-test** — a fixed, local
demonstration that needs no Azure subscription, no credential, and no network.
It runs a handful of deterministic checks against this exact checkout (imported
notebook provenance, the catalogue's fixed size, the vendored offline bundle,
workspace isolation, and the same-origin guard itself) through the real
`/api/self-test` route, in both preview and operator mode. Its result always
reports `azureContacted: false` and `liveEvidence: false` and can never be
mistaken for a live scenario outcome.

To execute samples from this machine:

```bash
az login

# Required only by samples whose Runtime section names Python modules.
python -m pip install -r runtime/requirements.txt

npm run start:execute
```

Operator mode is deliberately separate from ordinary startup. It probes only
local runtimes at boot; it does not contact Azure or a gateway until **Run this
plan** is selected. Local execution is refused unless the server binds to
loopback.

Available commands:

| Command | Purpose |
| --- | --- |
| `npm start` | Safe preview-only server |
| `npm run start:execute` | Loopback-only local execution |
| `npm test` | 563 assertions across 15 test files |
| `npm run check` | Static imports, zero dependencies, and isolation checks |
| `npm run smoke` | 88 browser interaction and responsive checks |
| `npm run verify` | Check, unit/integration tests, then browser smoke |

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CITADEL_PLAYGROUND_PORT` | `4173` | Listening port |
| `CITADEL_PLAYGROUND_HOST` | `127.0.0.1` | Bind address; local execution accepts loopback only |
| `CITADEL_PLAYGROUND_PYTHON` | `python` on Windows, `python3` elsewhere | Approved Python interpreter |
| `CITADEL_PLAYGROUND_RELAY_URL` | *(unset)* | Approved external execution relay |
| `CITADEL_PLAYGROUND_RELAY_TOKEN` | *(unset)* | Bearer token for that relay |

The relay URL and token are never returned to browser code.

---

## Configure and generate

Every sample declares its configuration explicitly. The Configure tab renders
only fields that sample uses and groups them by execution meaning:

| Group | Meaning |
| --- | --- |
| **Mandatory** | Must be supplied before the sample can run |
| **Conditional** | Mandatory only while the stated condition is true |
| **Optional** | Pre-filled from the notebook; blank uses the documented fallback |
| **Generated / override** | Produced by discovery or an earlier recipe; may be overridden |
| **Secrets** | Required only for samples that present a credential; memory-only |

The summary names missing values and runtime dependencies before Run can be
enabled. **Copy configuration (JSON)** and **Download configuration** produce a
deterministic manifest containing source cells, prerequisites, grouped inputs,
risk, runtime requirements, missing values, and generated operations.
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
      python/             registered Python wrappers
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
      server/             reconstruction, operation registry, transports,
                          assertions, workspaces and run manager
      view/models.mjs     pure view models — no DOM, fully testable in Node
    web/
      index.html          the direction contract and the four landmarks
      css/                world.css (foundation), workbench.css (components)
      js/                 main.mjs + render/{dom,directory,panels,context}
    test/                 14 test files, run with node --test
    scripts/              check.mjs (static), smoke.mjs (headless browser)
```

**The catalogue is the single source of truth.** Navigation, forms, validation,
guides, risk, provenance and builder dispatch all read it; nothing else owns
sample identity.

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

Each run reports every step, duration, safe evidence, assertions, generated
artifacts, and discovered configuration updates. Public discoveries can update
later forms. A newly minted gateway key can update only the current browser's
in-memory secret store; it never enters rendered evidence, logs, exported
configuration, or persistent storage.

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

The external relay remains available for a future remote or container-hosted
playground. It uses a fixed same-origin browser endpoint and never discloses the
relay address or bearer token.

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

The surface is an operations workbench: a grouped, searchable recipe directory
on the left, one selected sample in the centre under Guide / Configure / Request
/ Response tabs, and a compact readiness and provenance rail on the right. Only
one sample is rendered at a time.

Below ~66rem both rails are replaced rather than squeezed — a native `<select>`
for the directory and a disclosure for the context — so the layout changes shape
instead of shrinking. Verified with no horizontal overflow at 320px and at 200%
zoom.

Deep Azure-blue masthead, bright paper sheet, cool chrome rails; Fluent blue for
action and current position, cloud teal for values sourced outside the page,
semantic status hues; hairline rules, recessed control wells, Segoe UI Variable
for prose and Cascadia Mono for every identifier, endpoint and value. No
gradients, no glass, no same-size card grid, no nested cards, no modals, no fake
dashboard metrics — compact rows and progressive disclosure instead.

Accessibility targets WCAG 2.2 AA: landmarks, a skip link, programmatic labels,
roving-tabindex tabs with arrow/Home/End keys, `aria-invalid` and
`aria-describedby` on every control that needs them, an `aria-live` status
region, visible focus everywhere, and honoured `prefers-reduced-motion`. A
required field the user has not reached yet reads as *needed* in brand blue, not
as an *error* in red — the user has not made a mistake, they have not arrived.

---

## Tests

```
npm test                 563 assertions, node --test, no dependencies
npm run check            89 modules, 0 dependencies, nothing outside scope
npm run smoke            88 headless-browser interaction checks
npm run verify           all three, in order
```

| File | Covers |
| --- | --- |
| `catalogue.test.mjs` | 19 unique recipes, group distribution, notebook hash and shape, complete code-cell coverage, provenance agreement, stated exclusions |
| `guides.test.mjs` | Guides, prerequisites, typed schemas, expected results, disclosed deviations, https authoritative links |
| `plans.test.mjs` | Every recipe compiles; determinism; binding order; plus golden plans for MCP, publish, access contract, Key Vault, weather, bursts, cleanup, metrics, circuit breaker |
| `validation.test.mjs` | Required/conditional matrices, type and range rules, derived-warns-not-blocks, acknowledgement guards, `mustEqual` confirmations |
| `endpoints.test.mjs` | Asset-type prefix, `/mcp` suffix, deployed-endpoint precedence, Foundry and ARM URL shapes |
| `protocol.test.mjs` | MCP session binding, numeric JSON-RPC ids, JSON and SSE parsing (including data folding), JSON-RPC error under HTTP 200 |
| `secrets.test.mjs` | No secret in any plan, preview or view model; memory-only state; no storage/cookie/URL/log paths; no credential-shaped literals |
| `executor.test.mjs` | Unavailable executor never returns success; relay wire shape, allow-list and same-origin constraint; server headers, path traversal, capability disclosure |
| `viewmodels.test.mjs` | Directory, search, guide, configure, request, response and workbench models; not-run is never a pass |
| `markup.test.mjs` | Direction contract ≤150 words in five blocks, landmarks, tab wiring, component states, no gradients/nested cards/pixel tracks, responsive shape change |
| `requirements.test.mjs` | Exact relevant fields and mandatory/conditional/optional/generated/secret manifests for all 19 samples |
| `execution.test.mjs` | Allowlisted CLI/HTTP/Python/artifact/assertion execution with fake transports, bindings, redaction, limits, and cancellation |
| `runmanager.test.mjs` | Server reconstruction, risk gates, concurrency, run IDs, workspaces, updates, and secret handling |
| `server.test.mjs` | Preview/operator modes, loopback restriction, same-origin JSON guard, body limits, capability, and vendored runtime closure |
| `selftest.test.mjs` | `/api/self-test` exact-schema validation and the five offline checks it runs, including that it never contacts Azure or the network |

`scripts/smoke.mjs` drives headless Chromium over the DevTools Protocol using
Node's built-in `WebSocket` — no Playwright, Puppeteer, or dependency. It covers
selection, tabs, exact requirement groups, configuration copy/download,
validation, risk acknowledgement, secret redaction, run/cancel and step evidence
through a test-only executor seam, search, 320px layout, 200% zoom, and the
offline self-test card run end-to-end through the real server at both a normal
viewport and 320px.

---

## Current limitations

- **Nothing has been executed against Azure.** No live endpoint, subscription,
  gateway key or Foundry project was available. Every assertion in the catalogue
  is derived from the notebook and the accelerator's own sample files, not from
  an observed response.
- **No live Azure result is proven yet.** Local execution and its failure modes
  are tested with injected transports, but no real subscription, gateway,
  Foundry project, Key Vault, burst, or cleanup was used during development.
- **Operator prerequisites remain the operator's responsibility.** The server
  probes local `az`, Python imports, and the vendored bundle. It does not sign
  in, install packages, grant roles, or contact customer endpoints at startup.
- **Runtime discoveries last only for the current browser session.** Secrets
  remain memory-only and generated run workspaces remain local.
- **Browser evidence is Chromium-only.** Firefox, Safari, and a real
  NVDA/JAWS/VoiceOver pass remain outstanding.
