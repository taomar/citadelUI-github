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

Node 20.6 or newer. There is nothing to install.

```bash
cd CitadelSamples/playground

npm start          # serves http://127.0.0.1:4173/
npm test           # 182 assertions across 11 files, via node --test
npm run check      # static: imports resolve, zero dependencies, scope
npm run smoke      # 54 headless-browser interaction checks
npm run verify     # check + test + smoke, in that order
```

Environment variables, all optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CITADEL_PLAYGROUND_PORT` | `4173` | Listening port |
| `CITADEL_PLAYGROUND_HOST` | `127.0.0.1` | Bind address — loopback by default |
| `CITADEL_PLAYGROUND_RELAY_URL` | *(unset)* | Attach an approved execution relay |
| `CITADEL_PLAYGROUND_RELAY_TOKEN` | *(unset)* | Bearer token for that relay |

The relay URL and token are read by the server and are **never** sent to the
browser. `GET /api/capabilities` reports only whether a relay is configured.

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
    server.mjs            loopback static server, capability probe, relay seam
    src/
      core/               types, endpoints, validation, secrets, parsing,
                          mcp, bicep, plan, preview, state, executor
      catalogue/
        profiles.mjs      the five shared profiles + every reference link
        index.mjs         the single source of truth
        samples/          discover, prepare, publish, exercise, observe,
                          policy, lifecycle
      view/models.mjs     pure view models — no DOM, fully testable in Node
    web/
      index.html          the direction contract and the four landmarks
      css/                world.css (foundation), workbench.css (components)
      js/                 main.mjs + render/{dom,directory,panels,context}
    test/                 11 files, run with node --test
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

**The shipped executor cannot run anything, and says so.**

`createUnavailableExecutor()` returns `blocked` for every plan, with the step
types a capable adapter would need. `blocked` is not a failure and it is never a
pass: nothing was attempted, so nothing is claimed. `passed` is not a state an
executor can return at all.

Why the notebook cannot simply be replayed with `fetch`:

- Nine recipes need `az` or the Python management SDK — a browser has neither.
- The MCP handshake needs the `Mcp-Session-Id` **response** header, which a
  cross-origin gateway must explicitly expose via CORS.
- The A2A and MCP calls need a live contract key; putting one in the browser to
  reach a gateway that did not opt into CORS would not work anyway.
- Two recipes generate deliberate load, and one deletes a live product.

The optional relay seam is narrow on purpose. The browser posts
`{ protocolVersion, sampleId, inputs, secretRefs }` to one same-origin path,
`/api/execute`. It cannot supply a URL, headers or a raw request, so the
endpoint can never be used as a general proxy. The sample id is checked against
the catalogue before anything is sent, secret *values* are not transmitted — the
relay is expected to hold its own credentials for the refs it is told about —
and an unrecognised relay answer becomes `inconclusive`, never a pass.

Two other adapters can implement the same three-method contract without touching
the UI or the builders: an Azure management adapter for `azure-cli` steps, and a
Python runner for `library` steps.

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
npm test                 182 assertions, node --test, no dependencies
npm run check            static: imports resolve, 0 deps, nothing outside scope
npm run smoke            54 headless-browser interaction checks
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

`scripts/smoke.mjs` drives headless Chromium over the DevTools Protocol using
Node's built-in `WebSocket` — no Playwright, no Puppeteer, no dependency. It
covers selection, tab keyboard navigation, form filling by label, inline
validation appearing and clearing, the acknowledgement gate and its
invalidation, secret redaction in the live preview, directory search, and
rendering at 320px and at 200% zoom.

---

## Current limitations

- **Nothing has been executed against Azure.** No live endpoint, subscription,
  gateway key or Foundry project was available. Every assertion in the catalogue
  is derived from the notebook and the accelerator's own sample files, not from
  an observed response.
- **The default executor cannot run any recipe.** All 19 report `blocked`. That
  is the intended shipping state, not a defect.
- **Prerequisites are not probed.** The context rail lists them as `manual`;
  this page never contacts your environment to check one.
- **Nine recipes need a runtime a browser cannot provide** — `az` for seven,
  Python for two.
- **Discovered values are user-supplied here.** Deployment outputs such as the
  APIM name, gateway URL, published endpoints and Key Vault secret names are
  entered by hand, and the product id itself depends on which LLM APIs exist on
  the target gateway.
