# Repository migration inventory

## Scope and decision boundary

This inventory covers only `CitadelSamples/` at commit
`72f896554d7ebcfcdd4bd478976f78ed672d54d2`. It maps the imported notebook,
the current playground, its hosted relay and deployment assets, and the paused
source-tab prototype. No Azure resource, live endpoint, policy burst, cleanup
operation, or credential was used.

The source notebook remains the authority:

| Property | Value |
| --- | --- |
| File | `CitadelSamples/citadel-publish-contract-tests.ipynb` |
| Upstream | `Azure-Samples/AI-Hub-Gateway-Solution-Accelerator`, `validation/citadel-publish-contract-tests.ipynb` |
| Upstream commit | `ede33909b10800700bc1a5394af84efbe2add892` |
| Bytes | 66,241 |
| SHA-256 | `ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb` |
| Shape | 36 cells: 17 Markdown, 19 code, no outputs or attachments |
| Line endings | LF, protected by `CitadelSamples/.gitattributes` on Windows |

The redesign decision is to retain the server-authoritative catalogue and typed,
allowlisted executor. Notebook code is visible and immutable. Users edit only
declared parameters, configuration, and transient secrets; they review the
operation, acknowledge its risk when required, and then execute. A
general-purpose editable notebook kernel is outside the intended trust boundary.

## Repository shape

The current inventory is 139 files:

| Area | Files | Approximate bytes | Role |
| --- | ---: | ---: | --- |
| `CitadelSamples/` root | 7 | 153,159 | Imported notebook and product/handover documents |
| `playground/src/catalogue/` | 10 | 327,435 | All 19 identities, guides, fields, provenance, risks, and builders |
| `playground/src/core/` | 13 | 84,332 | Plans, validation, configuration, secrets, endpoints, parsing, capability |
| `playground/src/server/` | 9 | 109,447 | Local run reconstruction, execution, transports, assertions, workspaces |
| `playground/src/relay/` | 15 | 182,560 | Narrow hosted HTTP/assertion relay |
| `playground/runtime/accelerator/` | 23 | 115,270 | Pinned Bicep, policy, OpenAPI, and provenance bundle |
| `playground/runtime/python/` | 3 | 9,397 | Registered Python wrappers for live recipes |
| `playground/web/` | 9 | 107,387 | Zero-build browser UI |
| `playground/infra/` | 3 | 15,559 | Container Apps deployment template and parameters |
| `playground/test/` | 19 | 257,875 | Catalogue, local runtime, UI model, server, and protocol tests |
| `playground/test/relay/` | 16 | 211,974 | Relay security, policy, deadline, identity, and orchestration tests |
| `playground/scripts/` | 2 | 44,021 | Static verification and Chromium/CDP smoke tests |

The product has four execution surfaces today:

1. Preview mode builds deterministic plans and executes nothing.
2. Loopback operator mode rebuilds plans server-side and runs registered local
   artifact, Azure CLI, HTTPS, Python-wrapper, and assertion steps.
3. The hosted relay rebuilds a smaller allowlisted plan and supports only
   read-only HTTP/assertion recipes.
4. The offline self-test checks fixed checkout invariants and always labels its
   result `azureContacted: false` and `liveEvidence: false`.

## Nineteen-scenario traceability

The catalogue IDs below are the stable join keys between navigation,
configuration, plans, results, tests, and source provenance. Source references
use the notebook's zero-based cell indexes.

| # | Catalogue ID and title | Group / catalogue file | Source cells | Declared configuration zones | Current typed execution and evidence |
| ---: | --- | --- | --- | --- | --- |
| 1 | `azure-context-check` — Azure context check | Discover; `samples/discover.mjs` | 3, **4** | Mandatory subscription ID | `azure-cli`, assertion; local CLI profile and subscription match |
| 2 | `apim-discovery` — API Management discovery | Discover; `samples/discover.mjs` | 5, **6** | Mandatory hub resource group; optional APIM override | `azure-cli`, assertion; deliberate APIM selection, URL, SKU, location |
| 3 | `foundry-enable-a2a` — Enable incoming A2A on the Foundry agent | Prepare; `samples/prepare.mjs` | 7, **8** | Mandatory Foundry account/project/agent; optional API/card/skill fields | `azure-cli`, HTTPS, assertion; token acquisition, PATCH response, read-back |
| 4 | `apim-foundry-grant` — Grant the APIM identity Foundry access | Prepare; `samples/prepare.mjs` | 9, **10** | Mandatory APIM and Foundry coordinates; generated principal/client/resource IDs; optional role/type | `azure-cli`, assertion; identity selection and exact role/scope verification |
| 5 | `weather-api-ensure` — Ensure the `weather-api` source API exists | Prepare; `samples/prepare.mjs` | 11, **12** | Mandatory subscription/APIM; optional API, operation, header, spec, and policy fields | Registered Python wrapper, assertion; APIM SDK result and operation shape |
| 6 | `publish-assets` — Publish the three assets | Publish and grant; `samples/publish.mjs` | 13, **14, 15** | Mandatory subscription/APIM/location; conditional Foundry fields; optional asset names, paths, headers, deployment, and circuit breaker | Artifact, `azure-cli`, assertion; generated parameter file, deployment output, published assets |
| 7 | `access-contract-deploy` — Deploy the mixed access contract | Publish and grant; `samples/publish.mjs` | 16, **17** | Mandatory subscription/APIM/location; optional policy/assets; conditional Key Vault; generated LLM API list | `azure-cli`, artifact, optional Python fallback, assertion; policy/parameters, deployment, key update |
| 8 | `access-contract-kv-verify` — Verify the Key Vault secrets | Publish and grant; `samples/publish.mjs` | **18** | Mandatory vault; generated key and endpoint secret names; optional reveal switch | `azure-cli`, assertion; non-empty secret evidence without returning the key |
| 9 | `weather-mcp-discovery` — Weather tool: MCP handshake and tools/list | Exercise; `samples/exercise.mjs` | 19, **20** | Conditional gateway; secret contract key; optional header/path; generated endpoint | HTTPS, assertion; JSON/SSE MCP handshake, session binding, `get-weather` inventory |
| 10 | `learn-mcp-discovery` — Microsoft Learn tool: MCP handshake and tools/list | Exercise; `samples/exercise.mjs` | 19, **20** | Conditional gateway; secret contract key; optional header/path; generated endpoint | HTTPS, assertion; JSON/SSE MCP handshake and dynamic non-empty inventory |
| 11 | `a2a-agent-card` — A2A agent card | Exercise; `samples/exercise.mjs` | 21, **22** | Mandatory gateway; secret contract key; optional path/header; generated path | HTTPS, assertion; card fields and gateway-only transport URLs |
| 12 | `a2a-message-send` — A2A message/send through the gateway | Exercise; `samples/exercise.mjs` | 21, **22** | Mandatory gateway; secret contract key; optional question/message/version/path | HTTPS, assertion; JSON-RPC result, no `error`, non-empty returned text |
| 13 | `agent-framework-hr-question` — Agent Framework: ask the HR agent | Exercise; `samples/exercise.mjs` | 27, **28** | Mandatory gateway; secret contract key; optional question/timeout/path; generated path | Registered Python wrapper, assertion; client-library result and gateway card URLs |
| 14 | `weather-tools-call` — Weather tool: direct tools/call | Exercise; `samples/exercise.mjs` | **29** | Conditional gateway; secret contract key; optional tool/city/header/path; generated endpoint | HTTPS, assertion; MCP session, weather schema, temperature unit |
| 15 | `usage-metrics` — Usage metrics in Application Insights | Observe; `samples/observe.mjs` | 23, **24** | Mandatory hub resource group; generated component; optional lookback/metrics/ingestion delay | `azure-cli`, assertion; bounded KQL rows or explicitly inconclusive ingestion window |
| 16 | `circuit-breaker-check` — Circuit breaker on the published backend | Observe; `samples/observe.mjs` | 25, **26** | Mandatory subscription/APIM; optional backend list, agent inclusion, API version, expected rule values | `azure-cli`, assertion; backend REST response and circuit-breaker rule values |
| 17 | `tool-rate-limit-burst` — Tool rate-limit burst | Policy; `samples/policy.mjs` | 30, **31** | Mandatory non-production confirmation; conditional gateway; secret key; optional endpoint/count/concurrency/timeout | Bounded HTTPS burst, assertion; status counts and at least one 429 |
| 18 | `agent-rate-limit-burst` — Agent rate-limit burst | Policy; `samples/policy.mjs` | 30, **31** | Mandatory non-production confirmation and gateway; secret key; optional message/endpoint/count/concurrency/timeout | Bounded HTTPS burst, assertion; status counts and at least one 429 |
| 19 | `cleanup` — Cleanup | Lifecycle; `samples/lifecycle.mjs` | 34, **35** | Mandatory non-production confirmation/APIM; explicit delete switches; conditional cross-recipe asset and policy values | Conditional `azure-cli` deletes plus assertion/residue report; no switch means no deletion |

Bold cell numbers are code cells. Cells 2 and 33 are the only notebook code
cells that are not recipes: cell 2 supplies shared profile variables and cell 33
prints an incomplete results roll-up. `playground/provenance.json`,
`catalogue.test.mjs`, and `citedCodeCells()` jointly enforce that every code cell
is either cited or deliberately classified.

## Exact source-byte manifest

For this inventory, a cell's visible source bytes are
`Buffer.from(cell.source.join(''), 'utf8')`; no trimming, newline conversion, or
syntax rewriting is applied. The hashes below let a future source API prove that
the text shown is the text represented by the imported notebook. Shared cells
are intentionally repeated by multiple recipes.

| Recipe | Exact cited cell source |
| --- | --- |
| `azure-context-check` | 3 Markdown: 70 B, `f480964bcb4f0ca2fc0a8a36c8263879f47ae8af5ab7d088b78aff0ea866310a`; 4 code: 566 B, `1c2a7d1a5a9206ec06e5bd802d843bda600709652a48c496611bef5cf4365ebf` |
| `apim-discovery` | 5 Markdown: 112 B, `1ed8908cb65aadfff343f9bccb4cdbb576cba712c4f0cddf3259524a5fe57ac0`; 6 code: 279 B, `8881b49b4fb2a91104d7cfff09a628e30e409d1f81533c348c349f3e88536b8c` |
| `foundry-enable-a2a` | 7 Markdown: 614 B, `6ac1559acd3b69dee42b2bd377f7a2848afb00868ef54231daf76b07d1494edf`; 8 code: 1,607 B, `70178e3e04f831609f40368d1233b1e7b0bcd66bd9e54c60aadf645746067a13` |
| `apim-foundry-grant` | 9 Markdown: 864 B, `5eb5d0ded1773601bf2860a2e5881d7db71175d0781051f7f7ecfd9c9f3ab0e2`; 10 code: 2,444 B, `7267342ccd5200a7d33ef1037eccc4ec0ca5e967d5f55ac8e1568fbfc6580461` |
| `weather-api-ensure` | 11 Markdown: 1,592 B, `496955727ec362cf7ccc5e499425c154e193324b9003348b1dd590725d373067`; 12 code: 2,585 B, `5f977b9555a302559e4588a5dca58c061e4ea16048206630087707cab4e33a9d` |
| `publish-assets` | 13 Markdown: 263 B, `fd7e106f560482ccf7fa64228a8f69448a393f8a3ee96ffbccc8adb2298b4793`; 14 code: 3,823 B, `834c5d5cd3e264b82134603caf23bb879afc8249b700026625c20eac69f8b6f6`; 15 code: 805 B, `a8b2f7e21a57953b02b6740ed94656b9496ecd0cbe50f7eef0a9b3053dfb8f4b` |
| `access-contract-deploy` | 16 Markdown: 2,014 B, `ba135c91fa8c7f6f885e9a7565eb11a1a44de22c975f6e31090e54c2c12e53d6`; 17 code: 8,791 B, `93fca3f232c60966f62d5b5c416d3518f6e31aba6bfe149b0bc9db1aa586030b` |
| `access-contract-kv-verify` | 18 code: 1,514 B, `eb6760a1a4cd7bc5ee8a558eb67a106e20e4b542185c63f82c212feb7fcfdcb7` |
| `weather-mcp-discovery`, `learn-mcp-discovery` | 19 Markdown: 835 B, `95a6ae4636139b10faae5e5234bd246e2903d34c8aacd68a01dbfbce33f04032`; 20 code: 3,143 B, `ee61e401ebc668c5551c043d7906e6fa03e680ffd0193decd5e258bea8c51b74` |
| `a2a-agent-card`, `a2a-message-send` | 21 Markdown: 257 B, `c2b0ac9f097f4a05cc7cdd000eb2928ac84baa1593b32e9ae3542be857d0fc06`; 22 code: 1,689 B, `b7a92dbabc7c388c41da1099460679fe6c57ff7d90a14fc1ca9615c6c494e45f` |
| `agent-framework-hr-question` | 27 Markdown: 705 B, `ad63dcdd652235b41b6985d88ff026742a27ac85b7d74fac575384200341cd38`; 28 code: 1,988 B, `2dcef35175886f6166ee6972ca09e83ca76504c2e9d6fe38581024188b297d3f` |
| `weather-tools-call` | 29 code: 1,087 B, `4b110ff2742209e69254ce06ef02af29d280f65a00e7ca9b83993b5ba7c20732` |
| `usage-metrics` | 23 Markdown: 311 B, `e43917afd64f08f08165ae4fee5569f873cd2f6cac90e722d6164c1cffe81bc9`; 24 code: 1,256 B, `f4f130a5091448f1b8a99ba71c3e952486c29973f1fc23e68bc1a21e7ff301a3` |
| `circuit-breaker-check` | 25 Markdown: 172 B, `e633659e4d188d0a1ca2cd335c6fa8eb163c9466a76545dfda4e79f43c200925`; 26 code: 815 B, `063fa073ab39c498fa0c989629f0b658e4d3973e50e3744fb7c5d180403913d2` |
| `tool-rate-limit-burst`, `agent-rate-limit-burst` | 30 Markdown: 502 B, `12136db1b374f6effe3a573396fdb5c8f806eb2aec9b46c51d685d9984d5b350`; 31 code: 2,389 B, `6fc9ec14f103fdbf77f34dc399283a443030d3023a8239c767a7deb12bbad090` |
| `cleanup` | 34 Markdown: 178 B, `72ab1dd4acde9bc778bdaea76221d3f486def155f1f3fe0e0ff0a112dbc59f50`; 35 code: 1,251 B, `a57edc5507f989ede4e9dbd1187584393d3e315b5c231131fb747d9e5319b880` |

No current production route returns this source text and no current panel renders
it. The current UI renders citations and a notebook hash, while plan previews
show generated typed operations. Exact visible source is therefore a real
migration gap, not a relabelling of an existing panel.

## Source fidelity and disclosed deviations

The catalogue preserves traceability but deliberately corrects or exposes places
where verbatim execution would be wrong:

| Scenario | Notebook/runtime distinction |
| --- | --- |
| `foundry-enable-a2a` | Cell 8 contains a published redaction artefact, `"Authorization": "******"`. The typed plan binds a real token from a preceding registered CLI step. |
| MCP recipes | The runtime captures and reuses `Mcp-Session-Id`, parses JSON and SSE, and rejects JSON-RPC `error` even when HTTP is 200. |
| `a2a-message-send` | Cell 22 records success from HTTP status alone; the assertion also requires a JSON-RPC result and no JSON-RPC error. |
| `access-contract-kv-verify` | Cell 18's roll-up can pass with a missing API-key secret. The runtime verifies the key separately without returning its value. |
| `usage-metrics` | Cell 24 has no time filter. The runtime adds a bounded lookback and reports an empty ingestion window as inconclusive. |
| `circuit-breaker-check` | Cell 26 iterates only `mcp-existing`; the catalogue exposes optional agent-backend coverage instead of hiding the gap. |
| `apim-discovery` | The notebook helper resolves one APIM instance without reporting ambiguity; the runtime lists first and refuses silent selection. |
| Burst recipes | Cell 31 has no environment confirmation; the catalogue requires both non-production confirmation and fresh acknowledgement. |
| `cleanup` | Cell 35 depends on names created in cell 17 and fails standalone. The catalogue makes cross-recipe references explicit and reports seven residue classes. |

The runtime bundle under `playground/runtime/accelerator/` is a pinned, closed
copy of the Bicep, XML, OpenAPI, and policy inputs used by relevant notebook
cells. Its own provenance file is 5,449 bytes with SHA-256
`33fe7876c86c33fc2ef31454409c9dd13aaef6c2188e9b2c5af1df328146f7e5`.
It should remain data, not become editable code.

## Configuration, validation, and security inventory

### Catalogue and configuration

- `src/catalogue/index.mjs` is the only owner of sample identity. It decorates
  the seven sample modules, builds a catalogue-wide field index, normalises each
  recipe's configuration contract, validates it, and dispatches pure builders.
- `src/catalogue/profiles.mjs` defines the shared Hub, Gateway access, Foundry,
  Key Vault, and Policy fields.
- `src/catalogue/requirements.mjs` separates mandatory, conditional,
  optional/defaulted, generated/override, and secret requirements per recipe.
- `src/core/configuration.mjs` builds deterministic, redacted JSON and
  `.env.example` exports. Secret values are structurally excluded.
- `src/core/plan.mjs` freezes typed plans and validates producer/consumer order.
- `src/core/capability.mjs` reports runtime readiness per selected sample instead
  of treating a missing optional runtime as a global failure.

### Validation and approval

- `src/core/validation.mjs` owns type coercion, conditional requirements,
  `mustEqual` non-production confirmations, and risk acknowledgement checks.
- `src/server/runRequest.mjs` accepts a catalogue sample ID, declared inputs,
  declared transient secrets, and acknowledgement. It rejects unknown members,
  keys, plans, commands, URLs, executables, scripts, headers, and paths, then
  rebuilds the plan from the server catalogue.
- `server.mjs` applies same-origin/fetch-metadata and JSON content-type checks to
  state-changing routes. Preview mode refuses `/api/run`; execute mode refuses
  non-loopback binding.
- Editing any value clears the current acknowledgement. State-changing,
  load-generating, and destructive operations require fresh consent; bursts and
  cleanup also require the typed non-production confirmation.

### Secrets and result safety

- `src/core/secrets.mjs` represents credentials as inert `SecretRef` objects in
  plans and previews.
- `src/server/redaction.mjs` redacts known values and credential-shaped output
  before evidence leaves the executor.
- The browser keeps entered or newly minted secrets in memory only. They do not
  enter configuration exports, URLs, cookies, browser storage, fixtures, or
  generated plans.
- `src/server/workspace.mjs` rejects absolute paths, drive paths, NUL bytes, and
  traversal, and rechecks containment after resolving each generated path.

## Execution and evidence paths

### Preview

`npm start` serves the catalogue and deterministic plan previews. The unavailable
executor returns `blocked`; it cannot construct a passing result. This is honest
planning evidence, not runtime evidence.

### Loopback local execution

`npm run start:execute` attaches `src/server/runManager.mjs` and
`src/server/localExecutor.mjs`. The server:

1. validates the browser's catalogue-shaped request;
2. rebuilds the plan;
3. allocates `.runs/<run-id>/`;
4. executes only registered `artifact`, `azure-cli`, `http`, `library`, and
   `assertion` steps;
5. reports step state, duration, redacted evidence, assertions, artifacts, and
   public or memory-only secret updates.

`src/server/transports.mjs` uses argument arrays and `shell: false`. Output is
bounded; the local executor has 180-second step and 900-second run defaults,
bounded HTTP response/artifact sizes, and an `onProgress` hook for step start and
completion. `runManager.cancel(runId)` aborts only the identified active run.

The current HTTP response is completed as one JSON result. Process stdout and
stderr are captured incrementally inside the transport, but they are not emitted
as a live browser stream. The progress hook is the correct seam for a future SSE
or streaming response; changing the existing live-run wire format is
cross-cutting and should remain separate from the protected-source slice.

### Hosted relay

`relay-server.mjs`, `src/relay/`, `Dockerfile.relay`, and `infra/main.bicep`
implement and test a separate trust boundary. It authenticates the principal,
resolves a tenant-owned allowlist, rebuilds the request, verifies a short-lived
acknowledgement and one-use nonce, resolves secrets server-side, and exposes only
sanitised results.

The relay is structurally HTTP/assertion-only. Its image omits the local
executor, process transports, workspace, Azure CLI, Python, and artifact
writers. This is a useful future live boundary, but it cannot provide the local
offline Python proof without weakening that separation. Hosted CLI/Bicep/Python
work belongs in a separately allowlisted job/executor, not in the HTTP relay.

Managed-run and nonce stores are in-memory prototypes. The Bicep defines separate
playground and relay identities, Container Apps, registry pulls, Key Vault
secret-read access for the relay identity, health probes, and Entra
authentication. These deployment assets were inspected and statically tested;
nothing was provisioned.

### Offline self-test

`src/server/selfTest.mjs` checks the notebook hash, catalogue count, vendored
bundle, `.runs` ignore rule, and same-origin guard. It makes no subprocess or
network call. It is useful checkout evidence but does not prove that one
selected notebook cell is valid Python or that exact cell source can travel
through the browser/server path.

## Windows and local-runtime constraints

- Node.js 20.6 or newer is required; the application has zero package
  dependencies and no build step.
- Windows defaults `CITADEL_PLAYGROUND_PYTHON` to `python`; other platforms use
  `python3`.
- The Windows transport resolves the official `az.cmd` launcher to the Azure
  CLI's bundled Python entry point without enabling a shell. POSIX children use
  their own process group; Windows cancellation remains handle/PID scoped.
- All execution-capable local modes must bind to `127.0.0.1`, `::1`, or
  `localhost`. The container-facing playground binds broadly only in preview or
  relay mode.
- Path containment normalises Windows separators and rejects drive-qualified
  paths before writes.
- Optional live wrappers require packages from `runtime/requirements.txt`;
  package installation is never automatic. Offline source compilation should
  use only the Python standard library.
- Browser smoke coverage is Chromium/CDP only. Firefox, Safari, and a real
  screen-reader pass remain unproven.

## Current test baseline

Verified on this checkout without Azure:

| Command | Result | Meaning |
| --- | --- | --- |
| `node --test "test/*.test.mjs"` | 319/319 pass | Direct files only; PowerShell/Node glob does not include `test/relay/` |
| `npm test` (`node --test`) | 579/579 pass | Recursive package baseline, including all 16 relay test files |
| `npm run check` | 93 modules, 0 dependencies, `ok` | Import closure and CitadelSamples-only isolation |
| `npm run smoke` | 88/88 pass | Loopback Chromium/CDP interaction and responsive checks |
| `node --check` | 56 checked `.mjs` entry/source files, 0 syntax errors | `src/`, `web/js/`, and both server entry points |

The older 181-total/180-pass handover baseline predates the current relay and
self-test work and is not the baseline of commit `72f8965`.

## Paused source-tab prototype

The branch `taomar-samples-source-tab-offline-contract` points to `72f8965`; it
has no additional commit. All prototype work is only in the named
`stash@{0}`. The stash was inspected read-only and was not applied.

Selectively reusable ideas:

- a fifth fixed tab and matching `tabpanel`;
- per-sample source/cache state in `web/js/main.mjs`;
- pure source and offline-result view models;
- a `<pre>` per raw notebook cell, labelled with the zero-based notebook cell
  index;
- keyboard navigation, 320px layout, all-19 source sweep, and literal offline
  evidence assertions in smoke tests;
- same-origin bounded POST handlers.

The stash cannot be merged as-is:

- `server.mjs` imports `contractTest.mjs`, `recipeRequest.mjs`, and
  `sourceView.mjs`, but those files are absent from both the stash and base;
- the proposed handlers therefore cannot parse or run;
- the contract-test tone constant and focused unit tests are incomplete;
- it adds large handlers inline to the already large entry server;
- its checkout-only contract test does not run a real isolated Python
  subprocess.

The reusable unit is the additive protected-source presentation pattern, not the
old custom workbench as a whole and not its incomplete backend.

## Reuse, replace, and defer

### Reuse directly

- Catalogue identity, provenance, profiles, requirement manifests, validation,
  risk gates, pure plan builders, endpoint/parsing helpers, and structural
  `SecretRef` handling.
- `runRequest.mjs`'s exact-schema and forbidden-member posture.
- `workspace.mjs`, `transports.mjs`, redaction, assertion evaluators, run
  cancellation, and progress hooks.
- Existing tab/view-model/rendering conventions and the paused prototype's
  additive source-tab patterns.
- Notebook hash and catalogue coverage tests.

### Replace or tighten for the protected-source slice

- Add focused source/request/offline-validation modules rather than inline
  handlers in `server.mjs`.
- Read the notebook once per request or through an immutable cache, verify its
  recorded hash, and return unmodified joined cell source plus byte length and
  source hash.
- Use a real server-selected Python executable and server-owned validation
  script. Never accept code, a command, executable, path, URL, header, or secret
  from the browser.
- Make the validation workspace genuinely ephemeral. Existing live run
  workspaces intentionally retain generated artifacts; the offline validation
  path should return its report artifact and remove its `.runs` directory in a
  `finally` block.
- Label every result `offline`, `local`, `azureContacted: false`, and
  `liveEvidence: false`. A syntax pass is not a live recipe pass.

### Keep separate or defer

- Keep existing live execution unchanged.
- Keep the HTTP-only relay unable to spawn Python or Azure CLI.
- Defer a live stdout/stderr browser stream; expose progress through the existing
  callback seam without changing the current live result protocol.
- Do not connect the protected-source proof to Container Apps, managed identity,
  Key Vault, Policy bursts, Cleanup, or any credential.

## Smallest proving vertical slice

The smallest slice that proves the requested direction without widening the
trust boundary is:

1. Add an exact-schema source request containing only protocol version and a
   catalogue `sampleId`.
2. Parse the imported notebook, verify its full-file hash, select only that
   sample's cited cells, join each cell's `source` array without normalisation,
   and return text, cell type, UTF-8 length, and SHA-256.
3. Add a fifth protected **Code/Notebook** tab. Render exact source in read-only
   `<pre><code>` blocks with immutable/protected labels and links back to the
   selected recipe's declared Configure zones.
4. Add an offline validation request containing only protocol version,
   `sampleId`, and declared non-secret public inputs. Reject unknown or secret
   keys and every code/path/command-shaped member.
5. In a unique `.runs/<run-id>/` workspace, write the server-extracted code
   cells and invoke a shipped server-owned Python standard-library validator.
   Compile, but never execute, the cells. The browser cannot change the source.
6. Bound output and time, propagate cancellation through an `AbortSignal`, and
   clean the workspace in `finally`.
7. Return redacted stdout/stderr, per-cell compile results, a downloadable JSON
   report artifact, and fixed offline/local/live-evidence labels.
8. Add unit tests for byte fidelity and schemas, server integration tests for
   route guards/timeout/cancellation/no-network labels, view-model tests, and
   Chromium smoke coverage for all 19 recipes and the selected offline run.

This slice proves exact visible source, explicit editable zones, protected code,
review context, a real isolated Python subprocess, allowlisted process
selection, bounded evidence, cancellation/timeout seams, artifacts, and honest
evidence labels. It does not claim to prove Azure behavior.
