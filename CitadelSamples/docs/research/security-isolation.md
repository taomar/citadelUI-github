# Playground security and isolation model

## Decision

The current hosted relay must remain an HTTP-and-assertion executor. It is safe
only because process creation, Python, Azure CLI, arbitrary files, and arbitrary
destinations are structurally absent from its image and import graph.

The product boundary is:

- preview and configuration in the browser;
- visible but non-editable, repository-owned sample code;
- editable, schema-validated parameter and configuration values only;
- catalogue-owned execution through the existing loopback local runner;
- safe offline syntax and contract validation that never executes the sample;
- the hosted relay limited to explicitly allowlisted read-only HTTP samples; and
- any future hosted process execution delegated to a fresh per-run job.

Arbitrary Python source, arbitrary CLI, user-selected dependencies, and editable
sample code are explicit non-goals. The arbitrary-code analysis below is a
negative security case: it explains why those fields must stay out of the
contract. Even protected code needs a separate one-run sandbox when hosted,
because a compromised image, dependency, sample bug, or malicious parameter can
still exercise process, filesystem, identity, and network authority. It must
never run inside the public playground process or long-lived relay process.

## Scope and evidence

This model covers `CitadelSamples/playground`, including the browser client,
local server and executor, relay, managed-run scaffold, container images, Bicep,
tests, and current documentation. It threat-models arbitrary Python and CLI as
an abuse case, not a planned feature. The planned surface shows protected sample
code and accepts only its declared parameters, configuration, and secret refs.

The conclusions are based on source and offline tests only. No Azure resource,
live endpoint, credential, tenant policy, or destructive sample was used.

## Current security posture

| Surface | Current control | Security meaning | Boundary or gap |
| --- | --- | --- | --- |
| Browser | Restrictive CSP; no browser storage; in-memory secret map; same-origin API paths | Reduces script injection and accidental persistence | Browser content and all user input remain untrusted |
| `/api/run` | Preview by default; execution only with `--execute`; boot refuses a non-loopback bind | Keeps the process-capable runner off a remote listener | Loopback is machine-wide, not user authentication; any local process may call it |
| Run request | Exact schema; server rebuilds plans from its own catalogue | Browser cannot submit code, a command, plan, script, URL member, path, executable, or environment | Preserve this invariant; arbitrary source and CLI fields are prohibited |
| Local process runner | `az` and Python allowlists; registered sample/step operations; `shell: false`; bounded output and time | Suitable for trusted catalogue operations on an operator workstation | It is not an OS sandbox and must not execute untrusted code |
| Local filesystem | Per-run `.runs/<id>` workspace; path normalization and containment; copied accelerator bundle | Keeps catalogue-generated artifacts in a predictable tree | `cwd` containment does not stop arbitrary code reading the rest of the host; symlink and child-process behavior are not sandboxed |
| Local HTTP | HTTPS-only, no redirects, response and burst bounds | Avoids several proxy and resource-exhaustion cases | There is no destination allowlist; trusted local configuration can target private or loopback HTTPS services |
| Local credentials | Existing Azure CLI login and inherited process environment | Convenient for a trusted operator | Arbitrary code would inherit host authority, token caches, files, and network reachability |
| Public playground | Container Apps Entra authentication and a dedicated user-assigned identity | Authenticates users and gives the proxy a service identity | Relay calls identify the shared playground identity, not the initiating end user |
| Relay | Separate non-root image with no process/filesystem executor imports | Strong structural separation from code execution | Non-root in a long-lived container is not sufficient isolation for hostile code |
| Relay authorization | Entra principal, tenant bundle, sample allowlist, exact URL and secret-header policy, bound acknowledgement, nonce | Restricts the current HTTP operation to server-approved capabilities | Any arbitrary socket or process API would bypass these JavaScript-level checks |
| Relay secrets | Server-side logical ref to Key Vault mapping; managed identity; no caller-selected vault or secret name | Keeps secret location and value out of the browser request | The relay identity can read configured vault secrets; hostile code in that process could request or exfiltrate them |
| Relay output | Fixed public projection that excludes all upstream-derived evidence | Treats a compromised backend response as an exfiltration channel | Arbitrary stdout, files, exit status, timing, and artifact shape are equally attacker-controlled channels |
| Managed runs | Owner and tenant binding, unguessable IDs, idempotency, concurrency controls, leases, polling, cancellation, safe step projection | Useful protocol and state-machine groundwork | It is not wired by `relay-server.mjs` or the Bicep; the default store is in-memory and no hosted job adapter exists |
| Deployment | Public authenticated playground; internal authenticated relay; separate identities; immutable image parameters | Separates UI and narrow relay authority | No per-run compute, durable queue/store, egress control, run identity, artifact store, or orphan reaper is deployed |

The managed-run implementation deserves one explicit documentation correction:
its durable `work` record currently includes the canonical non-secret payload,
authenticated owner context, and acknowledgement envelope. It excludes secret
values and public output, but a future durable adapter must classify, protect,
expire, and delete that record rather than relying on a claim that no request or
acknowledgement data is stored.

The hosted limit contract is now exact and startup-validated. It explicitly maps
`maxConcurrentRequests` to both direct `/execute` admission and burst
`maxConcurrency`, maps `maxRequestsPerRun` to the executor's total and per-burst
request ceilings, and maps `requestTimeoutMs` to `stepTimeoutMs`. Body size and
run duration use the same validated object. Excess direct requests fail closed
with HTTP 429. That admission and the direct nonce store remain process-local, so
the Bicep fixes each active revision at one replica and horizontal scale-out is
prohibited until one actually shared atomic adapter backs both controls. Revision
transitions and restarts replace the process-local replay history; operators must
drain the acknowledgement validity window before rollout, and cross-restart replay
protection remains an explicit limitation until the shared adapter exists.

## Assets, actors, and security objectives

### Assets

- the operator's local files, environment, processes, browser state, Azure CLI
  token cache, and signed-in Azure authority;
- tenant resources reachable through HTTP, Azure Resource Manager, data-plane
  endpoints, managed identity, or injected credentials;
- sample source, generated parameter files, run inputs, outputs, artifacts, and
  provenance;
- Key Vault values, access tokens, subscription keys, and authentication
  headers;
- identities, role assignments, quota, compute budget, network capacity, and
  audit records;
- other users' runs, artifacts, configuration, secrets, and timing information.

### Actors

- an authenticated, well-intentioned operator;
- a malicious or compromised browser session;
- a malicious authenticated tenant user;
- malicious Python, CLI arguments, dependency packages, or generated files;
- a compromised allowed backend that sees a request containing a credential;
- a malicious neighboring tenant or run;
- a compromised image, registry tag, dependency index, build pipeline, relay,
  worker, or state store;
- an unauthenticated remote caller, cross-site page, replay client, or local
  process.

### Security objectives

1. A browser may select only reviewed sample code and supply its declared typed
   values, never ambient executor authority.
2. One principal cannot observe, control, consume quota for, or impersonate
   another principal's run.
3. a hosted sample, compromised dependency, or malicious input cannot escape its
   one-run compute boundary.
4. A run receives only the identity, secrets, files, network, time, and compute
   explicitly approved for that run.
5. Secrets are not made public by logs, output, artifacts, errors, timing, or
   transformed encodings.
6. Cancellation and timeout stop the actual workload, not only its HTTP request
   or visible state.
7. Sample code and runtime dependencies are attributable to an immutable,
   reviewed build.
8. Every state-changing decision is attributable to an authenticated principal
   and the exact code, inputs, identity, destination, and risk approved.

## Trust boundaries and data flow

### Local execution

```text
Untrusted browser values
  -> loopback HTTP server and exact-schema validation
  -> server-owned catalogue and plan reconstruction
  -> registered operation
  -> local child process / local filesystem / operator network
  -> redacted result
  -> same browser tab
```

The security boundary is the server-owned catalogue and registry. The child
process is inside the operator's trust domain. It is intentionally able to use
the operator's Azure CLI login and network. Therefore local execution is safe
only for reviewed, immutable operations that the operator chose to run.

Calling the server "loopback-only" does not make hostile code safe. `cwd` is not
a filesystem boundary, environment redaction is not secret isolation, and
`child.kill()` is not a cross-platform proof that every descendant stopped. On
a shared workstation, loopback does not even prove that the caller is the same
OS user.

### Future protected-code hosted execution

```text
Authenticated browser
  -> public control plane
  -> authorization, schema, policy, approval, quota, idempotency
  -> durable non-secret run descriptor
  -> trusted dispatcher
  -> one ephemeral, no-ingress execution sandbox
  -> quarantined output/artifacts and fixed safe status
  -> owner-authorized retrieval
  -> verified termination and deletion
```

There are at least six independent boundaries:

1. browser to public control plane;
2. control plane to durable run state;
3. dispatcher to execution platform;
4. sandbox to identity and secret broker;
5. sandbox to network destinations;
6. sandbox output to evidence and artifact retrieval.

No single bearer token, container setting, redactor, destination check, or
approval can replace these boundaries.

## Why the HTTP-only relay cannot become a public code executor

The relay's present properties do not extend to arbitrary code:

| Present relay property | What arbitrary code changes |
| --- | --- |
| There is no process-spawn or filesystem execution path | Adding one removes the strongest structural control |
| Exact HTTP URLs and secret-bearing header names are checked immediately before `fetch` | Python can open sockets, resolve DNS, invoke subprocesses, or use its own HTTP stack and bypass the checks |
| Only read-only, HTTP/assertion plans are eligible | A CLI can reach management planes and mutate any resource allowed by its identity |
| Secret values exist only in relay memory and approved request headers | Code in the same process or container can read memory-adjacent state, environment, metadata endpoints, token caches, and files |
| The relay identity is shared and can read configured Key Vault secrets | Any hosted code with access to that identity inherits cross-run and cross-user authority |
| Public results contain no upstream-derived data | Arbitrary code controls stdout, stderr, exit code, duration, network behavior, filenames, file sizes, and artifact bytes |
| A request deadline aborts cooperative fetches | Code can fork, ignore signals, daemonize, busy-loop, fill disk, or keep a platform job alive |
| The relay is non-root | Non-root does not provide per-run tenant separation, read-only files, network confinement, syscall confinement, or resource quotas |
| Two long-lived relay replicas serve requests | Code would execute in reusable processes that retain caches and state across users |
| URL and sample policy are selected from the authenticated tenant bundle | The relay currently authenticates the shared playground service identity, not the browser user who initiated the request |

Running code in the relay would turn a narrow capability service into a remote
code execution service with the relay's network and managed identity. A defect
would affect every tenant and every later request handled by that replica.
Redaction cannot repair this: code that can read a secret can encode it into
many requests, timing, output lengths, status choices, or encrypted artifacts.

## Safety invariants

### Common invariants

1. **Default deny:** unknown principal, tenant, capability, field, destination,
   secret ref, identity, image digest, dependency, artifact type, or state is
   refused before dispatch.
2. **Server authority:** the browser cannot provide an executable path, shell
   string, job image, identity, vault, secret name, storage location, network
   rule, callback URL, or evidence classification.
3. **Exact binding:** authorization and approval bind to owner, tenant, sample or
   capability, immutable code/image digest, canonical inputs, secret-ref names,
   identity, exact destinations, risk text, expiry, and one-use nonce.
4. **No authority by redaction:** no workload receives a credential that policy
   would forbid it from disclosing. Redaction is defense in depth only.
5. **No success by transport:** accepted, queued, started, timed out, cancelled,
   failed, inconclusive, and completed are distinct states. HTTP 2xx is not a
   successful run.
6. **No implicit reuse:** compute, writable files, token caches, processes,
   environment, DNS state, and secrets are not reused across runs.
7. **No unbounded input or output:** source, parameters, files, body, logs,
   artifacts, processes, sockets, CPU, memory, disk, inodes, wall time, and
   network bytes have server-owned limits.
8. **Ownership everywhere:** create, status, cancel, evidence, and artifact
   operations independently authorize the same owner and tenant.
9. **Termination is observable:** visible cancellation or timeout is not
   terminal until the platform workload is stopped or quarantined and its
   capacity remains charged against the caller.
10. **Immutable execution basis:** every run records and verifies an image digest,
    source digest, dependency lock/SBOM digest, and policy version.

### Local runner invariants

1. Preview remains the default; process execution requires an explicit operator
   start mode.
2. The server binds loopback and is documented as single-user workstation
   software, not a local multi-user service.
3. The shipped runner executes only server-owned catalogue operations:
   registered `az` verbs and registered Python files. Browser-supplied arbitrary
   source or CLI is refused.
4. The local API has no arbitrary-code or arbitrary-CLI mode. The source pane is
   read-only, and neither source text nor a command line appears in a run
   request.
5. Child environments are built from an allowlist, not `{ ...process.env }`.
   `HOME`, `USERPROFILE`, `AZURE_CONFIG_DIR`, temporary directories, package
   configuration, proxy variables, and cloud credentials are isolated per run.
6. Azure CLI uses the operator's existing login for immutable registered
   commands. A separately gated, per-launch loopback capability may run exact
   `az login` for the claimed browser session; any short-code fallback is
   aborted without projection. The app never installs credentials or accepts
   browser-selected login arguments.
7. A whole process tree is terminated and verified on cancel/timeout on every
   supported OS. Failure to prove termination is reported and blocks another run
   from consuming the released slot.
8. Workspaces are created with restrictive permissions, are not followed through
   symlinks or junctions, and are deleted by run ID after the retention period.
9. Local HTTP targets remain operator-trusted. The UI must not describe
   HTTPS-only validation as SSRF isolation.

### Hosted executor invariants

1. The public playground and relay never load or execute submitted code.
2. One run maps to one ephemeral execution sandbox. A sandbox handles no second
   user or run.
3. The worker has no ingress, no Docker or container-runtime socket, no host
   mount, no privileged mode, no added Linux capabilities, no writable shared
   volume, and no access to control-plane credentials.
4. The worker runs as a non-root, run-unique user where supported. The root
   filesystem and sample-code mount are read-only.
5. Only designated parameter, scratch, and output mounts are writable. They are
   empty at start, size-limited, and destroyed after the run.
6. The platform enforces CPU, memory, process/PID, disk, inode, wall-clock, log,
   artifact, network, and concurrency limits outside the workload.
7. Egress is deny-by-default and enforced outside the container. DNS, direct IP,
   alternate ports, redirects, private address ranges, link-local metadata, and
   control-plane endpoints cannot bypass it.
8. A worker has no managed identity by default. If a capability requires one, it
   receives a dedicated least-privilege identity or a brokered, run-scoped token
   for only the approved tenant, target, audience, and operation.
9. The relay's Key Vault-reading identity is never attached to a code-running
   job. A job cannot enumerate a shared vault.
10. Secrets are resolved after admission, exposed only to the sandbox that needs
    them, never placed in job arguments or durable state, and revoked or expired
    at run end.
11. Arbitrary code with a secret is assumed able to disclose it. Such a run is
    allowed only when egress and destination authority make disclosure
    acceptable; otherwise the operation must use a broker instead of raw secret
    injection.
12. Status and cancellation use an unguessable run ID plus owner and tenant.
    Cancellation invokes platform termination and the controller verifies a
    terminal platform state.
13. Retries never rerun a non-idempotent workload silently. One idempotency key
    and request digest identify one logical run.
14. Public status is a fixed safe projection. Raw logs and artifacts are
    quarantined, owner-only, size-limited, retention-limited, and never embedded
    into a public response.
15. A reaper detects queued, running, cancelled, and timed-out orphans and keeps
    their quota reserved until termination is confirmed.
16. If Container Apps Jobs or another candidate platform cannot demonstrate any
    invariant above, that platform is not approved for protected-code
    multi-tenant execution.

## Protected and writable zones

| Zone | Contents | Access in a run | Persistence |
| --- | --- | --- | --- |
| Sample code | Reviewed Python, wrappers, templates, policies, notebook-derived logic | Read-only; digest verified before start | Versioned in the signed image |
| Runtime | Interpreter, Azure CLI if approved, system libraries, locked dependencies | Read-only; no package manager mutation | Versioned in the signed image |
| Parameters | Schema-validated values and secret-reference names | Read-only after dispatch | Canonical non-secret copy may be retained with TTL |
| Secrets | Run-scoped material or broker handle | Read-only to the intended process; never returned | Memory or ephemeral secret mount only |
| Scratch | Temporary files, isolated home, CLI cache, temp directory | Read/write; no cross-run mount | Deleted with sandbox |
| Artifacts | Explicit allowlisted outputs | Write-only during execution where practical; read during quarantine | Owner-only, bounded TTL |
| Evidence | Fixed status, reviewed metrics, hashes, timestamps, policy version | Worker submits through a narrow schema | Append-only audit store |

Parameter editing must never modify sample code in place. The source surface is
a read-only, notebook-like view of the reviewed sample and its provenance. There
is no code-editing mode. The server chooses the source by catalogue sample ID and
verifies its digest; source text is never accepted from the browser.

### Safe offline Python validation

Offline validation proves that the protected source is present, attributable,
syntactically valid, and consistent with its declared input contract. It does not
prove runtime behavior and must not import or execute the sample.

- The browser requests validation by sample ID and expected source digest, not by
  posting source.
- The server loads the protected repository or image copy and verifies its
  provenance digest before validation.
- Python syntax validation uses a bounded parser-only operation such as
  `ast.parse` in an isolated child with `-I`, an empty allowlisted environment,
  no secrets, no Azure CLI profile, no network, a read-only source file, bounded
  input/output, and a short timeout.
- Validation does not import the sample, resolve dependencies, run top-level
  code, invoke a package manager, contact Azure, or write bytecode into the
  protected tree.
- Contract validation separately checks that every editable field is declared,
  typed, bounded, and used through a context-appropriate builder. It rejects
  undeclared values rather than treating them as source substitutions.
- The UI reports "syntax/contract validated offline", never "safe", "executed",
  or "verified against Azure".

## Identity, Azure CLI, and secrets

### Authentication and authorization

- The public entry point validates issuer, audience, tenant, expiry, and
  principal. It must be unreachable except through the trusted authentication
  proxy whose principal headers it consumes.
- Tenant membership is not execution authorization. A dedicated role or
  entitlement authorizes each hosted capability.
- The initiating end-user identity is carried as verified context to admission,
  state, quota, audit, status, cancellation, and artifact retrieval. The shared
  playground managed identity is only a service-to-service identity.
- The dispatcher may launch only preconfigured job templates or immutable image
  digests. It cannot accept a caller-selected image, source, command, identity,
  or environment.
- Cross-tenant status returns the same not-found behavior as an unknown run to
  avoid disclosing existence.

### Managed identity and Azure CLI

- The UI identity, relay identity, dispatcher identity, and worker identity are
  distinct.
- The relay identity keeps only its narrow relay duties. It is never reused by a
  code worker.
- A worker identity is capability- and tenant-specific, with the smallest data
  actions and resource scopes possible. A shared subscription-level contributor
  identity is prohibited.
- If Azure CLI is present, the command path and verbs remain server-owned.
  `AZURE_CONFIG_DIR` and home are per-run ephemeral directories.
- Hosted login is non-interactive. Only `az login --identity` or equivalent
  workload identity is permitted, and only when the admitted capability requires
  it. Device code, service-principal secrets, cached developer login, and mounted
  host profiles are prohibited.
- Access tokens, refresh tokens, CLI caches, command debug output, and identity
  endpoint responses are secret material.

### Secret handling

- The browser sends secret-reference names, never values, to hosted execution.
- Mapping from logical ref to vault and secret name is tenant-owned server
  configuration.
- Secret resolution happens after authentication, authorization, approval,
  destination policy, quota reservation, and immutable-code verification.
- Secrets do not appear in source, image layers, environment declarations,
  durable descriptors, queue messages, command arguments, logs, errors,
  telemetry dimensions, screenshots, evidence, or artifact metadata.
- Environment variables are acceptable only for a protected sample already
  approved to receive the value. Prefer a broker that performs the approved
  operation without revealing the credential.
- Exact-string and shape redaction remain defense in depth. They cannot stop
  base64, encryption, timing, length, status, or multi-request exfiltration.

## Network and egress model

The current relay can enforce exact URLs because it owns every HTTP call.
Arbitrary code invalidates that design; egress must be enforced by infrastructure
outside the workload.

The hosted baseline is no egress. A capability may add:

- exact destination service classes, tenant/resource IDs, ports, and protocols;
- DNS through a controlled resolver;
- an authenticated egress proxy that revalidates destination and records a safe
  decision;
- explicit denial of loopback, link-local, RFC1918/private networks, platform
  metadata, control-plane endpoints, storage, registries, and package indexes
  unless the capability needs one;
- no redirects unless every hop is reauthorized;
- connection, request, byte, DNS, and destination-count limits.

Hostname allowlists alone are insufficient because of DNS rebinding, CNAME
changes, shared origins, direct IP use, alternate protocols, and application
libraries that ignore proxy settings. If the platform cannot force all egress
through the enforcement point, a job that receives secrets is not acceptable.

## Run lifecycle, quotas, cancellation, and cleanup

The required state machine is:

```text
admitted -> queued -> starting -> running -> completed
                              \-> failed
                              \-> cancellation-requested -> cancelled
                              \-> timeout-requested -> timed-out
                              \-> orphaned -> quarantined
```

Admission atomically reserves global, tenant, principal, and capability quota.
At minimum enforce:

- active and queued runs per principal and tenant;
- starts per minute and per day;
- cumulative CPU, memory-time, and wall-time budgets;
- source, input, request, log, scratch, and artifact bytes;
- process/PID, file, inode, socket, DNS, and outbound-byte limits;
- maximum queue age, startup time, run time, cancellation grace, and retention;
- bounded idempotency, nonce, audit, and status-store cardinality.

Rate limits must be distributed and atomic; in-memory maps are not sufficient
with multiple replicas. Limits must be keyed from verified identity, not IP
alone. Rejections return retry guidance without disclosing another user's load.

Cancellation is a three-part operation:

1. atomically mark cancellation requested and prevent an unstarted worker from
   crossing the execution boundary;
2. signal and terminate the actual process group, container, or platform job;
3. verify terminal state, quarantine partial output, release quota, and delete
   ephemeral state.

An API timeout that merely stops waiting is not cleanup. If the platform job
does not stop, the run remains charged and an orphan reaper escalates it. No run
ID, prefix, label, or wildcard may be used to terminate another run.

## Approvals and audit evidence

Read-only HTTP checks may be pre-authorized by tenant policy. Arbitrary code,
network expansion, secret access, managed identity, and state-changing CLI each
require an explicit approval policy.

The approval view shows and cryptographically binds:

- authenticated user and tenant;
- sample/capability and risk text;
- reviewed image, source, dependency, and policy digests;
- canonical non-secret inputs and secret-reference names;
- exact identity and permission summary;
- exact target resources and egress destinations;
- resource limits, timeout, retention, and estimated cost class;
- protected source identity and repository provenance;
- expiry and one-use nonce.

Changing any bound field invalidates approval. High-impact scopes require a
second authorized approver and separation of duties. Approval is not inferred
from a checkbox retained in browser state.

Audit records are append-only and contain decisions, not secrets:

- admission, denial reason code, policy version, and quota reservation;
- principal, tenant, run ID, idempotency digest, code/image/dependency digests;
- approved identity, target and egress policy identifiers;
- lifecycle transitions, worker identity, platform execution ID, cancellation,
  timeout, retry, and reaper actions;
- safe step classifications, artifact hashes, sizes, scan verdicts, and deletion
  timestamps.

Raw stdout, stderr, HTTP bodies, tokens, secret values, command debug output, and
workload-selected filenames are not audit dimensions. Evidence produced by a
hosted process is untrusted until schema validation and quarantine complete.

## Dependency and image supply chain

- Build runtime images in a trusted pipeline and deploy by digest, never mutable
  tag.
- Sign images and verify signature, provenance, vulnerability policy, and SBOM
  before admission.
- Pin interpreter, Azure CLI, OS packages, and Python dependencies with hashes.
- Disable `pip install`, `npm install`, `apt`, `apk`, and arbitrary download
  during a run.
- Offer a small reviewed set of prebuilt dependency profiles. User-provided
  requirements files are prohibited because package builds and install hooks
  execute arbitrary code.
- Keep build credentials out of runtime images and prevent workers from reaching
  the registry control plane.
- Treat generated archives and notebooks as hostile files; scan, size-limit,
  content-type verify, and serve downloads with attachment and nosniff headers.
- Never execute an artifact produced by one run in another run without a new
  build, review, digest, and approval.

## Abuse cases and required responses

| Abuse case | Impact | Required response | Residual risk |
| --- | --- | --- | --- |
| Cross-site page posts to loopback | Drives operator authority | Same-origin checks, JSON-only, explicit operator mode | Non-browser local malware can still call loopback |
| Malicious tenant user invokes hosted run | Uses shared service authority | User-level role, tenant and owner binding, per-user quota | Authorized users can abuse their granted capability |
| Browser submits `az role assignment create`, source text, or shell syntax | Privilege escalation | No browser source or command fields; only server-owned typed operations | A reviewed catalogue operation can still be over-privileged |
| Python reads parent environment or home | Credential theft | Fresh sandbox and allowlisted environment; no host mounts | Code can read any secret deliberately given to it |
| Code queries managed identity metadata | Cloud token theft | No worker identity by default; external network control; dedicated least privilege identity | Required identities remain usable by hostile code |
| Code targets internal HTTPS or metadata through DNS tricks | SSRF and lateral movement | External deny-by-default egress, controlled DNS/proxy, private/link-local denial | Allowed destinations can be compromised |
| Allowed backend reflects or encodes a secret | Secret exfiltration | Do not expose raw secret where a broker suffices; fixed public projection; egress limits | A backend receiving a credential can misuse it |
| Output encodes a secret in base64, timing, length, exit code, or filenames | Secret exfiltration | Treat all process output as tainted; quarantine and owner-only retrieval | A compromised protected sample may still use an allowed channel |
| Path traversal, symlink, junction, or hardlink reaches another zone | Host or tenant file access | Separate mounts, read-only code, no-follow/open-by-handle operations, platform isolation | Platform filesystem vulnerabilities |
| Fork bomb, busy loop, memory bomb, decompression bomb | Denial of service and cost | PID, CPU, memory, file, disk, inode, wall, output, and artifact limits | Distributed low-rate abuse |
| Child ignores cancellation or daemonizes | Orphan workload | Platform termination plus terminal-state verification and reaper | Platform outage can delay cleanup |
| Replayed or retried request runs twice | Duplicate mutation and cost | Bound one-use approval, nonce, idempotency key plus digest | Non-idempotent external effects may occur before failure |
| Caller polls or cancels another run | Cross-tenant disclosure or sabotage | Unguessable ID plus owner and tenant on every operation | Compromised owner token |
| Shared cache or writable volume crosses runs | Data disclosure and poisoning | No compute or writable-volume reuse; empty per-run storage | Provider-level isolation defect |
| Runtime installs a malicious package | Code execution and credential theft | Locked prebuilt dependencies; no package network access | Trusted dependency compromise |
| Mutable image tag is replaced | Supply-chain compromise | Digest pin, signature, provenance, SBOM verification | Trusted signer compromise |
| User edits protected sample code through parameter path | Bypasses review and approval | Distinct immutable code and schema-limited config zones | Catalogue builder defects |
| Approval describes different code, target, identity, or inputs | Consent bypass | Canonical digest binding and invalidation on every change | Misleading but correctly bound risk text |
| Massive unique nonces, IDs, status polls, or errors fill state/logs | Control-plane denial of service | Bounded distributed stores, rate limits, TTL, log sampling | Coordinated multi-account abuse |
| Direct access bypasses Container Apps auth headers | Authentication bypass | Private backend and trusted-proxy enforcement; reject absent/invalid platform principal | Authentication proxy compromise |
| Compromised dispatcher launches a privileged template | Tenant-wide compromise | Narrow dispatcher role, immutable template allowlist, audit and separation | Dispatcher or platform compromise |

## Residual risks

Even after all controls:

- protected sample code or a dependency that receives a credential can use it
  within the credential's allowed authority and can try to disclose it through
  any allowed output or destination;
- platform, hypervisor, kernel, identity, registry, dispatcher, and trusted build
  compromise remain outside application-level containment;
- allowed Azure management operations can have indirect effects beyond the
  apparent resource;
- distributed denial of service can consume the aggregate tenant budget while
  staying below individual limits;
- cancellation cannot undo external effects completed before termination;
- audit and artifact retention create privacy and data-residency obligations;
- no static test proves live network, identity, cancellation, or tenant isolation.

These risks require an explicit environment owner decision before hosted
protected-code process execution is enabled. Arbitrary user code remains
prohibited regardless of that decision.

## Testable acceptance criteria

### Browser and control plane

- **B1:** A request containing `command`, `args`, `script`, `code`, `path`,
  `image`, `identity`, `vault`, `secretName`, `env`, or an unknown field is
  rejected before state creation or dispatch.
- **B2:** Cross-origin, form-encoded, unauthenticated, wrong-issuer,
  wrong-audience, wrong-tenant, expired, and role-less calls are rejected.
- **B3:** Direct backend access without the trusted proxy principal header is
  rejected and the backend is not publicly routable.
- **B4:** Capability and status responses disclose no relay URL, token, secret
  location, internal platform ID, stack, path, or other user's run existence.
- **B5:** Editing any code, input, destination, identity, egress, dependency,
  limit, or risk text invalidates approval.
- **B6:** The source surface has no editable or submission control. DOM and API
  tests prove modified source text cannot enter a validation or run request.
- **B7:** The displayed source digest, server-loaded source digest, execution
  image digest, and approval digest must match; a mismatch blocks validation and
  execution.

### Offline source validation

- **V1:** Validation accepts only a catalogue sample ID and expected digest.
  Source text, a file path, parser flags, imports, or a command are rejected.
- **V2:** The validator loads the protected source itself, verifies provenance,
  and runs parser-only validation with no import or top-level execution.
- **V3:** A test sample containing top-level file, network, environment, process,
  Azure CLI, and import side effects produces no side effect during validation.
- **V4:** The parser process has a short timeout and input/output bound. Deep,
  malformed, and oversized source fails closed without affecting another run.
- **V5:** Validation writes no bytecode or source changes, receives no secret or
  cloud credential, and reports no host path or raw exception.
- **V6:** The UI distinguishes syntax valid, contract valid, not executed, and
  not live-verified states.

### Local execution

- **L1:** Preview mode cannot create a child process or write a run artifact.
- **L2:** Execution mode fails to start on a non-loopback bind.
- **L3:** Every catalogue CLI verb and Python file has a registry entry; every
  unregistered executable, verb chain, script, wrapper, and path is rejected.
- **L4:** Child processes receive an environment allowlist. Tests seed fake
  credentials in the parent environment and prove they are absent in the child.
- **L5:** Workspace tests cover absolute paths, `..`, NUL, symlinks, junctions,
  hardlinks, race replacement, and protected-source writes.
- **L6:** On Windows and POSIX, a test program creates descendants; cancellation
  proves all descendants are gone before quota is released.
- **L7:** Documentation and UI state that local execution uses operator authority
  and is not a hostile-code sandbox.

### Hosted isolation

- **H1:** Static import and image-content tests continue to prove the public
  playground and relay contain no process executor.
- **H2:** One submitted run creates one sandbox with a unique platform execution
  ID, empty writable storage, and no reuse after completion.
- **H3:** The sandbox runs non-root with read-only code/runtime/root filesystem,
  no privileged mode, capabilities, host mounts, runtime socket, or ingress.
- **H4:** The platform, not workload code, enforces CPU, memory, PID, disk, inode,
  log, artifact, network, and wall-time limits.
- **H5:** A hostile test image attempts host file access, cross-run volume access,
  process escape, metadata access, direct IP egress, DNS rebinding, alternate
  ports, and proxy bypass; every attempt is denied and audited.
- **H6:** Relay, dispatcher, and worker identities are distinct. A worker with no
  approved cloud capability cannot obtain a cloud token.
- **H7:** A capability-scoped worker token fails against every resource,
  operation, tenant, and audience outside its approved set.
- **H8:** The production entry point wires a durable store, queue/dispatcher, job
  launcher, worker lease, and orphan reaper; restart tests prove recovery without
  duplicate execution.

### Secrets and output

- **S1:** Secret values never appear in browser requests, durable state, queue
  messages, job arguments, environment declarations, logs, telemetry, errors,
  evidence, status, or artifact metadata.
- **S2:** Unknown logical secret refs and caller-selected vault or secret names
  are rejected before identity or vault access.
- **S3:** A malicious workload emits raw, base64, reversed, split, compressed,
  timed, length-coded, filename-coded, and exit-code-coded secret material.
  Public status remains a fixed projection with none of those values.
- **S4:** Raw output and artifacts are quarantined, owner-only, bounded, scanned,
  TTL-deleted, and never automatically treated as trustworthy evidence.
- **S5:** Secret resolution occurs only after admission, quota reservation,
  approval, destination policy, and digest verification.

### Authorization, tenancy, and run state

- **A1:** Principal A cannot status, cancel, download, enumerate, or infer a run
  owned by principal B in the same or another tenant.
- **A2:** The authenticated end user, not only the playground service identity,
  is present in admission, quota, lifecycle, and audit records.
- **A3:** Reusing an idempotency key with the same digest returns the existing run;
  a different digest returns conflict and launches nothing.
- **A4:** A nonce or approval envelope is accepted once and is rejected after
  replay, expiry, owner change, tenant change, code change, target change, input
  change, identity change, or policy change.
- **A5:** State transitions reject regression and terminal-state overwrite.
  Accepted or queued never appears as completed.

### Limits, timeout, cancellation, and cleanup

- **R1:** Global, tenant, principal, and capability admission limits are atomic
  across at least two control-plane replicas.
- **R2:** Flood tests cover bodies, source, files, queued runs, active runs,
  polling, unique nonces, unique idempotency keys, stdout, stderr, artifacts,
  processes, sockets, DNS, network bytes, and cost budgets.
- **R3:** Queue, startup, step, run, cancellation-grace, and retention deadlines
  each have a distinct tested terminal outcome.
- **R4:** Cancel before dispatch launches nothing. Cancel during start cannot race
  into running. Cancel during execution terminates the platform job and all child
  processes.
- **R5:** Timeout or cancellation does not release concurrency or cost quota until
  actual workload termination is confirmed.
- **R6:** Crash and network-partition tests leave an orphan; the reaper finds,
  terminates, audits, and deletes it without touching another run.
- **R7:** Scratch, CLI cache, token cache, secret material, and writable mounts
  are absent after the deletion deadline.

### Supply chain and evidence

- **D1:** Mutable image tags, unsigned images, unknown digests, missing
  provenance, unacceptable vulnerability results, and mismatched SBOM or lock
  digests are refused before dispatch.
- **D2:** Runtime package installation and package-index egress are denied.
- **D3:** Changing protected sample code without updating its reviewed digest
  fails admission.
- **E1:** Every admission and lifecycle transition produces an append-only audit
  record with owner, tenant, run ID, policy and code digests, safe reason code,
  and timestamp.
- **E2:** Audit tests seed tokens, keys, paths, backend content, control
  characters, and high-cardinality filenames; none become audit dimensions or
  messages.
- **E3:** Artifact hashes, sizes, scan verdicts, access events, and deletion are
  attributable without storing artifact content in the audit log.

## Release gates

Arbitrary user code and arbitrary CLI remain disabled by design. Hosted
protected-code process execution also remains disabled until all hosted criteria
pass in an isolated non-production environment and an independent security
review confirms the implementation. Container Apps Jobs is a candidate, not an
approval: its actual identity, network, filesystem, cancellation, quota, and
cleanup behavior must be demonstrated.

Until then:

- keep the current relay HTTP/assertion-only;
- keep arbitrary source and CLI out of its request contract;
- keep sample code immutable and parameter/config editing schema-limited;
- use the loopback local runner only for reviewed catalogue operations;
- describe all hosted job work as future and unproven.
