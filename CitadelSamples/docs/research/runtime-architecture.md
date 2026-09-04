# Protected playground runtime architecture

Decision date: **2026-09-04**

Decision status: **Accepted for the local model. Candidate architecture only for
hosted process execution.**

## Decision

Extend the existing Citadel catalogue and executor. Do not adopt a general-purpose
notebook product, kernel, terminal, or user-programmable runtime.

The two execution models are deliberately different:

| Model | Decision |
| --- | --- |
| Local | Keep the explicit loopback-only executor for a trusted operator. It rebuilds a selected catalogue sample, runs only fixed registered operations, and uses the operator's installed Azure CLI, Python, credentials, files, and network. It is not a hostile-code sandbox. |
| Hosted | Keep the public preview/control plane and HTTP relay free of process execution. If hosted Python or Azure CLI is added, dispatch one approved run to one fresh, no-ingress worker such as an Azure Container Apps Job. The platform is a candidate only; it is not approved until its isolation, identity, network, quota, termination, and cleanup properties are demonstrated. |

Both models preserve the same product contract: users select protected source and
supply only declared typed values. They never submit source, a plan, command,
argument vector, executable, path, environment, image, URL, header set, vault, or
secret name.

This report consolidates the product comparison in
[`comparable-products.md`](comparable-products.md), the interaction contract in
[`product-ux.md`](product-ux.md), the source inventory in
[`repository-migration.md`](repository-migration.md), and the threat model in
[`security-isolation.md`](security-isolation.md).

## Immutable source and scenario boundary

The execution basis is the exact imported notebook:

| Property | Required value |
| --- | --- |
| Repository path | `CitadelSamples/citadel-publish-contract-tests.ipynb` |
| Upstream | `Azure-Samples/AI-Hub-Gateway-Solution-Accelerator` |
| Upstream commit | `ede33909b10800700bc1a5394af84efbe2add892` |
| Git blob SHA-1 | `e07fdb18607db6ea1b0f8eef6920f24a88cb7e73` |
| Imported SHA-256 | `ee706b4dac2978d4f35885ea5f77a7d6a12add337e7f959690550be28d4523bb` |
| Imported bytes | `66241` |
| Line endings | LF |
| Shape | 36 cells: 17 Markdown, 19 code, no saved outputs, no attachments |

The source file is data, not an editable workspace. Notebook view renders each
cell as `cell.source.join('')`; raw view serves or downloads the imported bytes.
Neither path trims, normalizes line endings, reformats, repairs, or rewrites the
source. The full-file digest and byte count are shown with the upstream commit.
Each cell keeps its zero-based notebook index, exact UTF-8 byte count, and
SHA-256. Syntax highlighting may add presentation spans but must not change the
copied text.

The catalogue remains exactly 19 selectable scenarios:

| Group | Scenario IDs |
| --- | --- |
| Discover | `azure-context-check`, `apim-discovery` |
| Prepare | `foundry-enable-a2a`, `apim-foundry-grant`, `weather-api-ensure` |
| Publish and grant | `publish-assets`, `access-contract-deploy`, `access-contract-kv-verify` |
| Exercise | `weather-mcp-discovery`, `learn-mcp-discovery`, `a2a-agent-card`, `a2a-message-send`, `agent-framework-hr-question`, `weather-tools-call` |
| Observe | `usage-metrics`, `circuit-breaker-check` |
| Policy | `tool-rate-limit-burst`, `agent-rate-limit-burst` |
| Lifecycle | `cleanup` |

Code cell 2 remains shared configuration and code cell 33 remains the notebook's
incomplete result roll-up; neither becomes an invented twentieth recipe. The
per-scenario cell and byte manifests in
[`repository-migration.md`](repository-migration.md) remain authoritative.

The browser may render inserted parameter, review, progress, and output cells, but
each is labelled as playground content and is excluded from the source-only view.
There is no source editor, arbitrary parameter field, terminal, or execute-text
control.

## Why not use a maintained notebook product

The evaluated products are maintained and useful, but they solve a different
authority problem.

| Product family | Useful capability | Why it is not the runtime |
| --- | --- | --- |
| JupyterLab and VS Code notebooks | Mature cells, rich output, kernels, interrupt, debugging, accessibility, extensions | Their normal model gives an editable notebook and broad kernel or terminal authority. Notebook trust protects rendered output; it does not make source immutable. |
| GitHub Codespaces and Azure Machine Learning notebooks | Reproducible hosted development, Azure CLI, managed compute, jobs, logs, networking | They are development workstations or code-first environments. Users control more source and terminal authority than the protected playground permits. |
| JupyterLite and Pyodide | Static delivery, browser execution, offline caching | Browser Python cannot faithfully provide the installed Azure CLI, native dependencies, managed identity, or server-side secret boundary required by these samples. |
| marimo and Voila | Strong app-like notebook presentation, reactive inputs, hidden editor | They are the closest presentation references, but still execute a Python app or kernel and do not provide Citadel's catalogue rebuild, operation allowlist, approval, and evidence contract. |
| Papermill | Declared parameters and repeatable output notebooks | It injects parameters and executes the notebook kernel. It is a batch tool, not a protected-source UI or authorization boundary. |
| Observable, Streamlit, and Runme | Excellent reactive controls, status, downloads, or executable documentation | They provide useful interaction patterns, but changing framework does not narrow Azure CLI, Python, filesystem, identity, or network authority. Runme intentionally exposes shell authority. |

Adopting any of these would still require custom source integrity, field schemas,
secret handling, server-side plan reconstruction, approval, operation
allowlisting, workspace containment, and evidence semantics. It would also add a
second execution authority beside the existing catalogue. The lower-risk design
is to borrow notebook interaction patterns while retaining one Citadel-owned
executor.

## Common request and validation contract

### Declared values only

The local run request remains:

```text
{ protocolVersion, sampleId, inputs, secrets, acknowledgement }
```

`inputs` may contain only paths declared by the selected sample. Values are
coerced through the declared type and bounded before plan construction. A
secret-marked field is refused in `inputs`; only the same sample's declared
secret path may appear in `secrets`. Unknown members and instruction-shaped
members are rejected rather than ignored.

Hosted requests are narrower: the browser sends declared non-secret inputs and
logical secret-reference names, never secret values. Tenant policy maps each
logical reference to an approved provider location after authorization.

In both cases, the server loads the sample from its own catalogue, applies
defaults, checks conditional requirements and risk gates, and rebuilds the typed
plan. Source text is never a plan input.

### Parser or compile-only source validation

Offline validation is a separate operation from execution:

1. The browser supplies only a catalogue sample ID and the expected imported
   notebook digest.
2. The server loads the protected notebook itself and verifies the exact
   full-file digest and byte count.
3. It extracts only the catalogue-cited code cells and sends their exact source
   through a fixed, bounded validator.
4. The validator uses Python's parser or built-in `compile` operation only. It
   never imports the notebook as a module, resolves its imports, invokes compiled
   code, runs top-level statements, writes bytecode, installs a package, contacts
   Azure, or opens the network.
5. The validator receives no secret, Azure CLI profile, cloud credential, caller
   path, parser flag, or arbitrary command. It has a short timeout and strict
   stdin/stdout limits, and any malformed or oversized input fails closed.
6. Contract validation separately proves that editable fields are declared,
   typed, bounded, and consumed by a catalogue builder.

The result vocabulary is exact: **syntax valid**, **contract valid**, **not
executed**, and **not verified against Azure**. Compile-only validation is not a
sandbox verdict and is not live evidence.

### Approval binding

Any approval used for hosted execution must be one-use, expiring, and bound to a
canonical digest covering:

- authenticated principal and tenant;
- sample and capability;
- notebook, source, image, dependency lock, and policy digests;
- canonical non-secret inputs and logical secret-reference names;
- exact target resources and egress destinations;
- worker identity and permission summary;
- risk text, limits, retention, cost class, and nonce.

Changing any bound value invalidates approval. Local UI acknowledgement continues
to prevent accidental effects, but its current `{ accepted, sampleId }` shape is
not a cryptographic approval envelope and must not be represented as equivalent
to hosted digest binding.

## Local runtime model

### Availability and trust

`npm start` is preview mode. It can inspect catalogue plans and self-tests but
returns a blocked result for `/api/run`.

`npm run start:execute` is the only local process-capable mode. Startup must
refuse any bind other than `127.0.0.1`, `::1`, or `localhost`. Loopback limits
remote exposure but does not authenticate the OS user and does not sandbox the
child. The operator intentionally lends the reviewed catalogue operations their
local Azure CLI login, installed dependencies, network, and workstation trust.

### Fixed execution path

The local sequence is:

```text
browser declared values
  -> loopback exact-schema request validation
  -> server-owned catalogue lookup and plan rebuild
  -> sample/step operation registry
  -> one per-run workspace
  -> fixed process, HTTPS, artifact, or assertion adapter
  -> bounded and redacted NDJSON progress
  -> bounded final result
```

Azure CLI execution is keyed by catalogue sample ID and step ID. The registry
validates the complete fixed argument shape before binding and validates all
resolved value positions again afterward. A resolved value cannot become an
option such as `--debug`. `spawn` receives a string array with `shell: false`;
there is no joined command string. On Windows, the known `az.cmd` launcher is
resolved to its bundled `python.exe -IBm azure.cli` invocation rather than
enabling `cmd.exe`.

Python-backed library steps run only the shipped files in
`playground/runtime/python/`:

- `apim_weather_api.py`;
- `apim_subscription_key.py`; and
- `agent_framework_ask.py`.

The registry chooses the file and constructs its validated parameter object.
Parameters travel as JSON on stdin. The browser cannot choose a wrapper, script
path, module, environment name, or generated Python source. The only explicit
secret environment currently allowed is the registry-owned
`CITADEL_GATEWAY_ACCESS_API_KEY`. Dependency preflight may import the wrapper's
declared installed modules; that is execution readiness and is not the
import-free source validator described above.

Child environments are built from an allowlist rather than inheriting all of
`process.env`. Fixed operation output is redacted before it becomes progress or
final evidence. Local HTTPS operations reject non-HTTPS URLs, inline
credentials, and redirects, but local destination configuration remains
operator-trusted; this is not SSRF isolation.

### Cancellation, timeouts, and bounds

The current local defaults are:

| Limit | Default | Hard ceiling |
| --- | ---: | ---: |
| Step time | 180 seconds | 300 seconds |
| Run time | 900 seconds | 900 seconds |
| Process output | 256 KiB per stream | 1 MiB per stream |
| HTTP response | 1 MiB | 4 MiB |
| Generated artifact | 512 KiB | 1 MiB |
| Burst requests | 200 | 500 |
| Burst concurrency | 16 | 32 |

Process stdin is capped at 1 MiB. Cancellation addresses the active run ID and
aborts its controller. POSIX children run in a separate process group and the
group is killed; Windows uses fixed `taskkill.exe /PID <pid> /T /F` with
`shell: false` and a handle-scoped fallback. The transport waits for its
termination helper before resolving.

This is a tested local containment mechanism, not a general proof of reaping.
Failure-path verification across every supported OS, privilege boundary, and
daemon behavior remains required before stronger claims are made.

The local server streams newline-delimited JSON when the client accepts
`application/x-ndjson`. It emits `run-start`, `step-start`, completed `step`, and
final `result` records. The browser reduces those untrusted records through a
pure immutable state function. It keeps first-seen order, prevents a terminal
step from regressing to running, bounds display text, rejects unsafe identifiers
and absolute workspace paths, and stores only an evidence-available flag rather
than raw evidence, commands, code, secret updates, or artifact paths.

### Workspace, artifacts, and reproducibility

Each local run receives
`CitadelSamples/playground/.runs/<sample-id>-<sequence>/`. Plan-declared
generated files are redirected under `artifacts/`. When a fixed operation needs
the vendored accelerator, the bundle is copied into the same run workspace so
its relative Bicep and policy references remain exact. Absolute paths, drive
paths, NUL bytes, and lexical traversal are refused, and containment is checked
again after resolution.

The next local runtime increment should add a redacted immutable run manifest
containing:

- run ID, sample ID, source cell indexes, and catalogue version;
- notebook, cited-cell, vendored-bundle, wrapper, and dependency digests;
- canonical non-secret inputs and secret-reference presence only;
- redacted plan digest, runner version, OS/runtime versions, and enforced limits;
- start/end times, step states, assertions, cancellation or timeout state;
- artifact relative path, type, byte count, SHA-256, and disposition.

That manifest must never contain a secret value, token, authorization header,
ambient path, raw stderr, or credential-bearing argument. Reproduction means
rebuilding the same approved operation from those recorded versions and inputs;
it never means rerunning captured shell text.

The current workspace implementation does not yet provide a durable manifest,
artifact download authorization, restrictive creation permissions, symlink or
junction no-follow enforcement, retention deletion, or opaque user-bound run
IDs. Those are local hardening and hosted requirements, not proven properties.

## Hosted runtime model

### Keep preview and relay process-free

The hosted public surface must not execute Python, Azure CLI, Bicep, generated
files, or arbitrary code.

Preview mode remains an honest blocked executor: it can render source,
configuration, plans, and offline evidence but cannot shape a successful live
result. The current broad-bind playground image is protected by mode, not by a
minimal import graph; a production control-plane image should exclude the local
executor, registry, process transport, wrappers, and Azure CLI entirely.

The relay has the stronger structural boundary today. Its image and `src/relay/`
import graph omit `child_process`, filesystem execution, the local executor,
process transports, workspace, registry, Azure CLI, Python, and artifact
writers. It may execute only server-rebuilt, allowlisted HTTP and assertion
steps. Exact destination policy is checked before secret resolution, and public
results use a fixed safe projection.

Do not add a process API to that relay. Doing so would turn a narrow shared
capability service into remote code execution with the relay's long-lived
identity, network, memory, and cross-run state.

### Future fresh per-run worker

If hosted protected operations are approved, the control plane should:

1. authenticate the initiating principal and tenant;
2. authorize the capability and exact target;
3. verify source, image, dependency, and policy digests;
4. validate declared inputs and logical secret refs;
5. consume digest-bound approval and reserve distributed quota atomically;
6. write a durable non-secret run descriptor;
7. ask a narrow dispatcher to launch one immutable worker template;
8. observe the platform job until actual terminal state;
9. quarantine, scan, classify, and hash outputs;
10. release quota and delete ephemeral state only after termination is verified.

Azure Container Apps Jobs is a reasonable candidate because it can express
one-shot work, but the decision is capability-based, not product-based. Another
platform is acceptable only if it demonstrates the same controls.

Every run gets a fresh worker with:

- no ingress and no reuse for another run;
- non-root execution and no privileged mode or added capabilities;
- no host mount, container-runtime socket, control-plane credential, or shared
  writable volume;
- a read-only root filesystem, runtime, dependency set, wrappers, templates, and
  protected code;
- empty, size-limited, isolated writable mounts for parameters, scratch, home,
  Azure CLI cache, temp files, and approved artifacts;
- externally enforced CPU, memory, PID/process, disk, inode, log, artifact,
  socket, DNS, network-byte, startup, wall-time, and cancellation-grace limits.

### Egress, identity, quota, and termination

Hosted egress is denied by default outside the worker. A capability opens only
the required service class, tenant/resource IDs, protocol, port, and exact
destination policy through infrastructure or a mandatory authenticated proxy.
Controlled DNS, direct-IP denial, private and link-local denial, metadata denial,
redirect reauthorization, and request/byte/destination bounds prevent workload
code from bypassing a hostname check. Package indexes remain unreachable.

The public control plane, HTTP relay, dispatcher, and worker have distinct
identities. A worker has no cloud identity by default. A capability that needs
Azure receives a dedicated tenant- and capability-scoped least-privilege
identity, or a brokered run-scoped token, for only the approved audience,
resource, and operation. The relay's Key Vault reader is never attached to a
code-running worker.

Quota is distributed and atomic across replicas. It covers global, tenant,
principal, and capability concurrency; queue depth and age; starts per time
window; CPU, memory-time, and wall-time budget; input, output, artifact, network,
and state bytes; and nonce, idempotency, status, and audit cardinality. The
current in-memory local and managed-run limits are not hosted quota.

Cancellation is not an HTTP response. The controller must mark cancellation,
prevent an unstarted worker from crossing the execution boundary, terminate the
specific platform job and all descendants, observe a terminal platform state,
quarantine partial outputs, and only then release quota. A durable orphan reaper
must find queued, starting, running, cancelled, and timed-out jobs after process
or network failure. It must target the immutable platform execution ID, never a
name prefix or wildcard.

### Output and dependency policy

All worker output is untrusted. Public status exposes only a fixed, bounded safe
projection. Raw logs and artifacts enter quarantine, remain owner- and
tenant-authorized, are size- and retention-limited, receive type verification and
malware/content scanning, and are served as attachments with safe headers only
after policy permits release. No output from one run is executed by another run.

Runtime images are built in a trusted pipeline and launched by immutable digest.
admission verifies signature, provenance, vulnerability policy, SBOM, source
digest, and dependency-lock digest. Interpreter, Azure CLI, OS packages, and
Python packages are version- and hash-pinned. Runtime package installation,
user-provided requirements, and package downloads are prohibited.

The current local `runtime/requirements.txt` lists package names without pinned
versions or hashes and expects the operator to install them manually. That is
acceptable only as a disclosed local prerequisite; it is not a hosted supply
chain.

## What is proved and what is not

No Azure resource was created or changed, and no live sample was run for this
decision.

| Area | Evidence in this branch | Honest conclusion |
| --- | --- | --- |
| Notebook and catalogue | Offline tests recompute the imported SHA-256 and byte count, assert 36/17/19 cell shape, and enforce exactly 19 recipes with complete code-cell classification. | Exact imported bytes and 19-scenario coverage are locally testable and preserved. |
| Protected source UI | View-model tests retain exact supplied cell text, force `editable: false`, and reject stale notebook digests or editable responses. Browser code requests source and validation by sample ID. | The immutable UI model is implemented. `server.mjs` does not yet implement `/api/source/<id>` or `/api/source/<id>/validate`, so real source delivery is not end-to-end. |
| Compile-only validation | The UI accepts only results marked offline, compile-only, not executed, no Azure, no network, and no live evidence. | The result boundary is tested, but the parser/compile-only server operation itself is not implemented or proved. |
| Streamed local runs | The server emits NDJSON lifecycle events, the client parses partial and malformed streams, and the pure reducer bounds and sanitizes view state. | Local progress plumbing and state projection are tested without contacting Azure. |
| Fixed local processes | Tests cover executable allowlists, absolute workspace cwd, ambient credential exclusion, complete Azure CLI argv shapes, post-binding validation, fixed Python wrapper paths, output clipping, and timeout tree termination. | The reviewed local executor controls are proved on the test host for synthetic commands and fakes, not for live Azure behavior or every OS failure mode. |
| Local workspaces | Offline tests place generated artifacts and staged accelerator files under one run root and reject basic traversal. | Basic lexical containment is proved; symlink races, permissions, cleanup, durable manifests, and principal authorization remain incomplete. |
| HTTP relay | Static tests reject process/filesystem imports and common process APIs. Relay tests cover its HTTP policy, identity, nonce, secret-provider, and safe result projection with fakes. | The relay is structurally process-free in source and image design. No deployed network, identity, or tenant boundary was exercised here. |
| Hosted process workers | Security requirements and candidate Bicep/job direction are documented only. | No per-run worker, durable queue/store, distributed quota, isolated egress, worker identity, output quarantine, digest admission, termination verification, or orphan reaper is implemented or live-proven. |

## Release gates

The local executor remains acceptable only for reviewed catalogue operations on a
trusted operator workstation. Arbitrary source, arbitrary CLI, arbitrary Python,
and arbitrary dependencies remain prohibited.

Hosted process execution remains disabled until an isolated non-production
deployment demonstrates all worker controls above with hostile tests, including
cross-run storage attempts, metadata and direct-IP egress, DNS rebinding, proxy
bypass, fork/daemon cancellation, worker crash, control-plane restart, quota
races across replicas, output exfiltration shapes, image tampering, and orphan
reaping. An independent security review must approve that evidence.

Until then, the supported hosted boundary is preview plus the existing
HTTP/assertion-only relay. A platform name, non-root container, redactor, request
timeout, or successful static Bicep test is not evidence that hosted protected
process execution is safe.
