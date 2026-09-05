# Citadel Publish Playground

This directory contains the zero-build application that turns the imported
Citadel publish-contract notebook into a guided, executable product. The source
notebook remains at `../citadel-publish-contract-tests.ipynb` and is never
modified.

## Product boundary

The playground is notebook-like, not a general-purpose notebook.

- Repository-owned Markdown and Python cells are visible and read-only.
- Users edit only the selected sample's declared, typed inputs.
- The browser sends sample identity, declared values, transient declared
  secrets, and acknowledgement; it cannot send code, commands, executables,
  plans, URLs, headers, scripts, or paths.
- The server owns provenance, source selection, validation, plan reconstruction,
  operation registration, and execution.

This fixed-code design trades automatic notebook flexibility for a maintained
product. Any upstream change must be reviewed across provenance, catalogue
metadata, builders, allowlists, assertions, and tests. In return, every visible
operation is attributable, bounded, and explainable before it runs.

## Docker: ordinary application-owned sign-in

The Docker image starts `hosted-server.mjs`, not the workstation executor. Open
the deployment's ordinary stable HTTPS URL, choose **Sign in with Microsoft**,
and return to the application. New browsers, expired sessions and restarts use
that same flow. No terminal, bootstrap URL, Copilot session, device code, Azure
CLI cache or server-side WAM is involved.

For Azure context check and APIM discovery, **Connect Azure** requests delegated
Azure Service Management consent for the same user, then **Load subscriptions**
and **Use subscription** select an enabled deployment-permitted target. The
backend really reads ARM as that user. It does not substitute a managed identity.
The entered non-secret Subscription ID and selected recipe survive sign-in.

The five gateway recipes require the application operator session and a
transient access-contract key, but no ARM consent or subscription. The gateway
key, not Microsoft user identity, authorizes the data-plane request. Keys are
never saved across navigation; the application explains when re-entry is needed.

### One-time deployment-owner configuration

End-user authentication is entirely in-app. Initial infrastructure, trusted TLS,
Entra registration and operator enrollment require the deployment owner's
authorization, not anonymous browser enrollment. No real IDs, credentials,
certificate, registration or permission grant is supplied by this repository.

Use Node 24 (the image is digest-pinned), one replica, and `npm ci` when running
the hosted entrypoint outside its image. MSAL Node `6.0.0` and JOSE `6.2.12` are
the only approved direct runtime dependencies; the lockfile pins their closure.
The browser remains zero-build and receives no auth SDK, token or client secret.

| Setting | Required deployment value |
| --- | --- |
| `CITADEL_PLAYGROUND_PUBLIC_ORIGIN` | Exact stable HTTPS origin, without path or trailing slash |
| `CITADEL_PLAYGROUND_AZURE_CLOUD` | Explicit `AzureCloud`, `AzureUSGovernment` or `AzureChinaCloud` |
| `CITADEL_PLAYGROUND_ENTRA_TENANT_ID`, `CITADEL_PLAYGROUND_ENTRA_CLIENT_ID` | Owner-approved tenant and confidential Web application GUIDs |
| Registered Web redirect URIs | Register **both** the exact public origin plus `/auth/callback` (sign-in) and the exact public origin plus `/` (post-logout return); code flow, no implicit grant |
| `CITADEL_ENTRA_CLIENT_SECRET_FILE` | Absolute read-only regular-file mount containing the confidential client credential; never an image layer, JS value or user-entered form |
| `CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE` | `Citadel.Operator`, assigned to intended operators on this app registration |
| `CITADEL_PLAYGROUND_OPERATOR_ALLOWED_PRINCIPAL_IDS`, `CITADEL_PLAYGROUND_OPERATOR_ALLOWED_GROUP_IDS` | Optional explicit JSON allowlists; role OR configured principal/group is required, never tenant membership alone |
| `CITADEL_HOSTED_SUBSCRIPTION_IDS` | JSON array of permitted subscription GUIDs; `[]` explicitly disables ARM recipes |
| `CITADEL_HOSTED_GATEWAY_POLICY_FILE` | Absolute mounted JSON file with `origins` and exact per-recipe/per-step `samples` URL/header policies |
| `CITADEL_TLS_CERT_FILE`, `CITADEL_TLS_KEY_FILE` | Read-only mounted certificate chain and matching unencrypted private key, readable only by authorized deployment identities |
| `NODE_EXTRA_CA_CERTS` | Optional mounted PEM trust bundle for private PKI, trusted by Node including its encrypted health check; browsers need independently managed trust |

The registration needs delegated Azure Service Management permission and
owner-approved tenant consent policy for the two ARM recipes. Users still need
Azure RBAC. There is no Graph permission requirement merely to sign in. A client
secret is the implemented confidential-credential mechanism; certificate client
authentication is not claimed. Rotate the secret through the owner's secret
store and restart the single replica before expiration.

The post-logout return is fixed, not a user-supplied destination. Entra requires
it to match a registered redirect URI; see [Send a sign-out request](https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc#send-a-sign-out-request).
Group-only allowlists fail closed when Entra emits group-claim overage indicators
instead of a `groups` array. Prefer an assigned `Citadel.Operator` application
role or explicit principal allowlist for these operators. No Graph permission,
overage URL retrieval or group lookup is implemented.

Gateway policy uses the existing relay's exact request-policy schema, but the
new adapter accepts only declared ephemeral keys and does not alter the relay
wire contract. For example, the `weather-tools-call` entry needs
`mcp-initialize`, `mcp-initialized`, and `tools-call`, each with `urls` naming
the approved full `https://.../mcp/weather-tool-mcp/mcp` URL and
`headerNames: ["api-key"]`. Other recipes must be explicitly added with the
step IDs and routes in their catalogue plans. No wildcard routes are accepted.
Private, loopback, link-local and reserved DNS destinations are refused, all
resolved addresses are checked, the chosen address is pinned for the request,
and redirects are refused. This phase therefore does not support private-IP
gateways; an externally enforced egress policy is also a deployment prerequisite.

Missing auth or target configuration is reported as named, non-secret readiness
issues inside the application and execution fails closed. Public origin and TLS
material are listener prerequisites: without valid matching material no listener
starts. No anonymous endpoint can configure credentials, targets or operators.

### Disabled staged foundation (W1)

The default hosted mode still exposes the existing seven adapters and requires
no new state volume. W1 adds a separately gated Resolve/Review/Run foundation,
not the eleven remaining adapter implementations. Its production registry and
new Foundry/Key Vault/Insights consent enablement lists are empty. Agent Framework
remains separately blocked: the future scope is eighteen process-free adapters
plus one excluded execution model, not nineteen completed scenarios.

`CITADEL_HOSTED_STAGED_MODE=1` requires an existing, owner-only absolute
`CITADEL_HOSTED_STATE_DIRECTORY` on a dedicated persistent **local Linux volume**.
Do not enable this merely to obtain more recipes: none are added yet.
SQLite state and target reservations survive restart; credentials do not.
One instance owns the volume through an actual SQLite exclusive lock. There is
no network-filesystem, multi-replica, Windows, tmpfs or writable-layer durability
claim. Unknown outcomes require explicit owner readback, never automatic retry.

The frozen [W1 staged interface contract](src/hosted/STAGED-CONTRACT.md) describes
the strict payloads, credential slots, recovery boundary, synchronous-storage
limits and interfaces reserved for later independently reviewed work.

### TLS and lifecycle

The application listens only on HTTPS, port 8443 by default, with TLS 1.2 minimum.
Publish no HTTP port and use no downgrade/redirect fallback. A reverse proxy must
verify and re-encrypt its upstream connection to this listener, preserving the
configured Host; untrusted forwarded headers never broaden authorization.
Mount keys read-only, never bake them into an image or disable certificate
verification. The image's health check verifies HTTPS and hostname against the
same configured origin while connecting directly to the application listener.
Browser trust is mandatory; a self-signed certificate without managed trust is
not a working deployment.

Monitor certificate expiry and atomically rotate mounted files, then restart the
replica: certificates are loaded at startup, not hot-reloaded. Expired or
hostname/key-mismatched certificates fail closed. Restart revokes all sessions;
users recover by signing in from the normal URL, not by reading container logs.
The existing Container Apps relay Bicep is not an all-HTTPS deployment of this
new image. Edge TLS alone and HTTP managed-identity metadata do not qualify.
Relay activation is disabled in BFF mode pending a separately reviewed all-HTTPS
credential and transport topology.

Sessions, MSAL caches and one-use code transactions live only in server memory,
partitioned by exact account/session. Cookies are Secure, HttpOnly and host-only;
API requests also require exact Origin/Host and a session CSRF value. Idle expiry
is 30 minutes, absolute expiry is 8 hours, and ID-token expiry may require earlier
reauthentication. Transactions expire after 5 minutes; review tickets after one
minute and one use. Context/account changes cancel owned work and invalidate
reviews. Already-sent calls may have completed and are never automatically retried.
Entra role removal is not instantaneous: reauthentication/ID-token expiry or the
absolute session bound refreshes claims; current deployment entitlement policy
is checked on every privileged request and dispatch.

Public capability reads allocate no server session. A short-lived HttpOnly
pre-auth cookie and matching response CSRF value bind a same-origin start;
only an admitted authentication attempt allocates separately bounded pending
state. The operator-session pool is populated after verified operator sign-in,
never by anonymous discovery or unentitled tenant members. Rejected duplicate
starts do not spend login allowance. Anonymous starts are limited to three per
minute and two outstanding transactions per direct socket address; verified
operators use a separate principal-bound client budget. Starts are limited to
thirty globally per minute; the client-rate map is capped at
1024 entries and expires after one minute. Forwarded IP headers are not trusted.
Shared NAT/proxy addresses share that limit; distributed denial of service still
requires deployment ingress controls. Pending auth is capped independently by
the configured transaction limit. Rotation replaces an existing operator slot
atomically without evicting other operators.

Declining, cancelling or failing Azure consent retains a still-valid application
operator and its previously verified cache, but cancels owned work and invalidates
the reviewed/selected target. Unverified identities/caches never replace it.
An unsuccessful account switch likewise retains a valid prior operator; successful
switching rotates the session. Explicit Sign out always revokes it.
Consumed callbacks still occupy their admission slot while token validation is
in flight. Cancellation/expiry prevents a late result from committing, clearing a
newer correlation cookie, or cancelling a subsequent consent attempt.
An explicit Sign in click refreshes read-only capability/CSRF state before starting
authentication, so an expired pre-auth cookie does not require reloading the page.
If that refresh fails, the application offers Retry without starting authentication.
Resource, review and run operations are not retried.

`CITADEL_SESSION_IDLE_SECONDS`, `CITADEL_SESSION_ABSOLUTE_SECONDS` and
`CITADEL_AUTH_TRANSACTION_SECONDS` may reduce, not increase, those time bounds.
Default limits are 500 sessions, 100 auth transactions, 8 concurrent runs and
30 sign-in starts/minute. Configurable session/transaction/run maxima are
2000/500/32. Scale-out requires a separately reviewed atomic shared store.

### Recipe support and evidence

This is a seven-recipe phase, not completion of the nineteen-recipe objective.
Supported adapters are `azure-context-check`, `apim-discovery`,
`weather-mcp-discovery`, `learn-mcp-discovery`, `a2a-agent-card`,
`a2a-message-send`, and `weather-tools-call`. Their previews identify the actual
HTTP operations; protected notebook source is unchanged. Weather output exposes
only bounded, typed, redacted weather fields. Raw upstream bodies and tokens are
not published. Select **Evidence** and read **Step evidence** to inspect the returned
weather payload; the default Transcript is the execution log.

The remaining twelve stay visibly unsupported: `foundry-enable-a2a`,
`apim-foundry-grant`, `weather-api-ensure`, `publish-assets`,
`access-contract-deploy`, `access-contract-kv-verify`,
`agent-framework-hr-question`, `usage-metrics`, `circuit-breaker-check`,
`tool-rate-limit-burst`, `agent-rate-limit-burst`, and `cleanup`.
They require a separate protected adapter/process-isolation decision. Successful
sign-in does not authorize arbitrary remote Python, CLI or command execution.

No live Microsoft, Azure, gateway, deployment or end-user aesthetic acceptance
is implied by offline signed-fixture/HTTPS browser evidence. All seven external
release gates remain open.

### Scoped offline acceptance

Run focused Node cases from this directory:

```powershell
node --test test\hosted-auth.test.mjs test\hosted-runtime.test.mjs test\hosted-boundaries.test.mjs test\hosted-corrections.test.mjs
```

The existing CDP-pipe browser harness is reused by
`scripts/hosted-browser-acceptance.mjs`. Its pinned Chromium container installs
only a synthetic CA inside that disposable container's NSS database, then runs
with `--network none`, no published ports and no host browser/profile mount.
Native pointer hit-testing, text entry, Tab/ShiftTab and Enter drive the UI;
trusted keypress/click/focus events and beforeunload dialogs are recorded.
Unexpected dialogs are rejected, not blanket-accepted. Real MSAL/JOSE requests
cross certificate-verified HTTPS metadata/token/JWKS services on a distinct
test identity hostname. The explicit test-only connector pins that hostname to
loopback with its private CA; it does not exercise external DNS/egress. Production
DNS/IP/TLS defaults are unchanged. ARM/gateway resource responses remain labelled
in-process synthetic fixtures, not live service/RBAC evidence. From `CitadelSamples`:

```powershell
docker build --file playground\test\Dockerfile.hosted-browser --tag citadel-auth-v4-8ea0cc0f:browser .
docker run --rm --network none --name citadel-auth-v4-8ea0cc0f-browser --shm-size 256m citadel-auth-v4-8ea0cc0f:browser
```

The actual application image has a separate opt-in
`test/hosted-container.test.mjs`, requiring a locally built
`citadel-auth-v4-8ea0cc0f:app` image and
`CITADEL_RUN_HOSTED_CONTAINER_TEST=1`. It uses read-only synthetic secret mounts,
the non-root production entrypoint, certificate-verified health checks and a
restart, then removes its container. No certificate-validation bypass or shared
OS trust-store installation is used.

Older smoke/dossier network drivers are not HTTPS acceptance of this candidate.
The shared browser launcher now refuses a plaintext server before listening;
those older drivers require their own TLS-fixture migration before reuse. The
focused executor transport test has been migrated to verified HTTPS. Historical
counts remain attributable only to their original commits.

## Legacy workstation compatibility (not the Docker route)

The separately launched workstation preview/local executor retains its private
CLI identity boundary. It is not the deployment's end-user sign-in procedure.
New command-line launches also require `CITADEL_TLS_CERT_FILE` and
`CITADEL_TLS_KEY_FILE`. The trusted certificate must cover the generated
`citadel-<random>.localhost` name (for example a deployment-owned private-CA
wildcard for `*.localhost`). No trust bypass is provided. The legacy injectable
server factory retains its old test transport for existing non-migrated tests;
neither shipped application entrypoint selects plaintext serving.

```powershell
npm start
```

Open the **secure launch URL** printed in the terminal. It contains a one-time
bootstrap capability in the URL fragment. The browser removes the fragment
immediately, exchanges it for an HttpOnly session cookie, and never stores either
value in browser storage. Local startup selects a cryptographically unique
`*.localhost` browser hostname and a fresh loopback port for each launch. The
host-only session cookie therefore cannot be delivered to another loopback
service or an older service worker. The plain bind-address URL remains read-only:
source and plans can be inspected, but state-changing APIs are unavailable.

To attach the trusted-workstation local executor:

```powershell
npm run start:execute
```

System Azure sign-in and Azure CLI subscription switching remain disabled in
that mode. Opt in for one server launch with:

```powershell
npm run start:execute:system-login
```

Execution-capable startup is loopback-only. Each launch creates an empty,
randomly named, restrictive Azure CLI profile under the operating-system
temporary directory. It never copies tokens from the user's default Azure CLI
profile, so the launch starts signed out and another terminal cannot switch its
account or subscription. Every registered `az` process and every shipped Python
wrapper that uses `AzureCliCredential` receives that same private
`AZURE_CONFIG_DIR`. Optional registered Python dependencies still come from the
operator's machine; this is not a hostile-code sandbox.

The private profile path is never returned to the browser, written to a result,
or printed for terminal use. Graceful shutdown removes it after child processes
drain. A crash can leave credential-cache residue in the operating-system
temporary directory. A later launch reaps only old, app-marked directories that
have the expected owner and no live server or recorded child process group;
recent residue or a reused process ID is deliberately left for a later attempt
rather than deleted aggressively.

The launch capability and browser session also rotate on every server restart,
and only a browser opened from the current terminal URL can invoke local
execution, validation, self-test, or Azure account operations. Hosted
deployments use the BFF flow above, never this local cookie or private CLI profile.

## Execution identity contract

Every catalogue sample has one server-owned execution-context classification.
The browser may report only safe configuration facts; it cannot choose an
identity, command, executable, argument, token, or credential value.

| Context | Authority |
| --- | --- |
| Azure CLI management | The user or service principal signed in to this Citadel private Azure CLI session |
| Python management | `AzureCliCredential`, inheriting that same launch-private Azure CLI session |
| Foundry REST | A `https://ai.azure.com` audience token minted for that launch-private Azure CLI principal; the token is never returned |
| Gateway REST, MCP, and A2A | The memory-only APIM subscription key under the configured header; only presence and header name are reported |
| Offline source validation | The local Python parser, with no Azure identity or network |
| Hosted HTTP relay | Easy Auth authenticates the caller, the server requires `Citadel.Operator` or an explicit allowlist, and the relay uses tenant-scoped managed identity plus a Key Vault key mapping |
| Future hosted process run | Deferred and unproven: one no-ingress job and one managed identity per run |

`POST /api/execution-context` accepts exactly:

```json
{
  "protocolVersion": 2,
  "sampleId": "weather-mcp-discovery",
  "configuredSubscriptionId": null,
  "gateway": {
    "keyPresent": true,
    "headerName": "Ocp-Apim-Subscription-Key"
  }
}
```

`gateway` is `null` for non-gateway samples. `configuredSubscriptionId` is the
current sample subscription or `null`. The response separates the signed-in
account, execution credential, active CLI subscription, intended target, and
`Authorization Not Checked` status. A valid local context is `Ready to Attempt`,
not proof that Azure authorization will succeed. Key presence/header name and
the fixed `tokensExposed: false` and
`credentialsPersistedInApplicationState: false` guarantees remain safe
projections. Azure contexts also report the launch-temporary private CLI cache
and honest crash-residue possibility. Preview returns `state: "unavailable"`
without probing Azure CLI or contacting a network.

Local Azure CLI sign-in is explicit. A sample failure never starts it. The
browser offers account switching only when the loopback server advertises a
launch-gated system-browser capability. The UI models disabled, signed-out,
starting, waiting for system UI, verifying, status-unknown, cancelled, failed,
timed-out, ready, and subscription-mismatch states without exposing a sign-in
URL, short code, token, command argument, or process output.

| Endpoint | Exact JSON request |
| --- | --- |
| `POST /api/azure-auth/start` | `{ "protocolVersion": 2 }` |
| `POST /api/azure-auth/status` | `{ "protocolVersion": 2, "loginId": "azure-system-login" }` |
| `POST /api/azure-auth/cancel` | `{ "protocolVersion": 2, "loginId": "azure-system-login" }` |
| `POST /api/azure-subscriptions/list` | `{ "protocolVersion": 2 }` |
| `POST /api/azure-subscriptions/activate` | `{ "protocolVersion": 2, "subscriptionId": "00000000-1111-2222-3333-444444444444" }` |

The browser adapter in `web/js/executionContextClient.mjs` exposes
`getContext`, `startSystemAzureLogin`, `getSystemAzureLogin`,
`cancelSystemAzureLogin`, `listAzureSubscriptions`, and
`activateAzureSubscription`. It also exports
`azureAuthCapabilityFromPayload`, `buildExecutionContextProjection`, and
`reconcileAzureContextCurrent` for the wizard's stable identity boundary.

These endpoints are same-origin, JSON-only, and available only from the
loopback execute server after the browser claims its per-launch session and the
server starts with `--allow-system-azure-login`. Start invokes exactly `az
login`, with no shell or browser-supplied arguments, and child overrides
`AZURE_CORE_LOGIN_EXPERIENCE_V2=off`, `AZURE_CORE_NO_COLOR=true`, and
`AZURE_CORE_OUTPUT=none`. Windows uses its supported account UI; other platforms
use the Azure CLI system-browser flow. The dedicated system-browser process
profile preserves reviewed desktop-session variables such as `DISPLAY`,
`WAYLAND_DISPLAY`, and the desktop bus address, but never inherits a `BROWSER`
command override. One login may be in flight.

If Azure CLI falls back to a short-code flow, the server aborts it immediately,
returns `device-fallback-blocked`, and observes the bounded stream without
retaining stdout or stderr. It never returns, logs, persists, or copies the URL,
code, private profile path, or raw output into application state. There is no
terminal fallback because exposing the profile path would defeat the isolation
boundary; system-browser/WAM sign-in must be available for this launch. Other
states are `login-disabled`, `starting`, `waiting-system-ui`, `verifying`,
`status-unknown`, `cancel-requested`, `cancelled`, `failed`, `timed-out`, and
`ready`.

Subscription listing executes one fixed `az account list` query and returns only
Enabled records matching the current principal and tenant. Activation accepts
one GUID, refreshes the list, executes fixed `az account set --subscription
<id>`, and verifies the result with `az account show`. Changing it updates only
this playground launch. Runs hold an identity lease for their complete
lifecycle: sign-in and subscription changes are refused while a run is reserved
or active, and new runs are refused while either Azure CLI mutation is in
flight. Admission records the reviewed principal name/type, tenant, and active
subscription. The server re-probes that fingerprint in the same private profile
immediately before each registered Azure CLI operation, Azure-backed HTTP
effect, and `AzureCliCredential` wrapper; drift or an unverifiable account stops
the run before the next effect.

When launch permission is unavailable, account switching fails closed and the
interface explains that this private session cannot be authenticated from a
terminal. Gateway key recipes do not show Azure account controls. A
server-enumerated subscription selector requires a fixed **Set Active** action
and explains that it changes only this launch.

## What the interface shows

One of the 19 catalogue samples is selected at a time. Its Signed Run Dossier is
a task-focused wizard whose steps are derived from that recipe:

1. Azure account and target, gateway connection, or hosted context when applicable;
2. required and active conditional inputs;
3. ephemeral credentials plus optional, generated, and advanced values when present;
4. a decision-first review of identity, target, authorization, effect, blast
   radius, reversibility, and the deterministic operation; and
5. streamed progress, final assertions, evidence, artifacts, and recommended next recipe.

Inapplicable steps are skipped and the step count is renumbered. Back and
Continue preserve safe in-memory state, validation focuses the first blocker,
and the URL owns the current recipe and step without containing secret values.

Source remains fixed. Configuration controls are the only editable surface.
Protected source and guide content open as secondary inspectors and never
precede blockers on compact layouts. Risk acknowledgement and destructive
confirmation are fresh per run and are invalidated when an input or execution
context changes. Recipe and step navigation lock while a run is active so
progress, cancellation, updates, and results remain bound to the originating
recipe and run. Output alone uses internal Transcript, Evidence, and Artifacts
tabs.

## Runner and evidence meanings

| Runner badge | Meaning |
| --- | --- |
| **PREVIEW ONLY** | Generate and inspect without execution |
| **OFFLINE SELF-TEST** | Run the fixed local checkout checks |
| **LOCAL OPERATOR** | Run registered operations on this machine |
| **HOSTED RELAY** | Run eligible HTTP/assertion work through the narrow relay |

| Evidence badge | Meaning |
| --- | --- |
| **NOT RUN** | No execution evidence exists |
| **LOCAL CHECKOUT EVIDENCE** | Protected source, parser, or fixed self-test evidence; Azure was not contacted |
| **LIVE TARGET EVIDENCE** | The approved target was contacted and the result derives from that run |

Local checkout evidence always reports `azureContacted: false` and
`liveEvidence: false`. A **LOCAL OPERATOR** run can produce
**LIVE TARGET EVIDENCE**, so runner and evidence facts are reported
independently.

Python source validation and Python sample execution are separate operations:

- validation loads server-selected protected source, verifies its digest, and
  parses it without imports, top-level execution, package installation, network,
  credentials, or source edits; its request carries only the protocol version
  and no configuration values;
- execution invokes only a registered wrapper or operation from the
  server-authoritative plan and may use operator authority after all gates pass.

Exact protected source is available in preview and operator modes. Parser-only
validation is available only in explicit loopback operator mode so public
preview and the hosted relay keep their process-free boundary.

## Runs, progress, cancellation, and artifacts

Local execution streams bounded NDJSON lifecycle events while preserving the
final typed result. Before completion, the UI can show the run ID, workspace,
active step, completed step state, and whether bounded evidence is available.
Partial events do not retain raw evidence, commands, source, secret updates, or
artifact paths. Redacted evidence, assertions, generated artifacts, and
configuration updates arrive in the final typed result.

Cancellation targets the exact active run ID. A cancellation request is not a
claim that every external effect was rolled back. Generated artifacts are
declared by catalogue steps, path-contained under `.runs/<run-id>/`, bounded,
redacted where applicable, and ignored by Git.

The current local workspace is not a durable, owner-authorized evidence store.
Redacted immutable run manifests, authorized artifact downloads, retention
deletion, and hosted quarantine remain future capabilities.

## Hosted boundary

The existing hosted relay is intentionally limited to allowlisted HTTP and
assertion work. Its image and import graph must remain free of Python, Azure CLI,
process transports, arbitrary files, and artifact writers.

Hosted sign-in is not hosted authorization. The public Container App accepts only
the configured tenant and client audience, then the server requires the exact
`Citadel.Operator` app role or an explicit deployment-owned principal/group
allowlist before any privileged POST route runs. A tenant user without that
entitlement receives 403 and the relay is not called. The UI reports **Signed
in** and **Authorized to operate** separately without exposing the principal ID
or raw claims. See `infra/README.md` for the exact app-role definition,
assignment, direct group-claim prerequisite, optional constrained platform
allowlist, export, and offline preflight steps.

One deployment-owned JSON array configures the allowed sample IDs in both the
playground and relay. The browser capability response and executor expose only
that subset; a disabled sample is rejected by the playground before it calls the
relay. Missing configuration never expands to every structurally eligible sample,
and malformed, duplicate, unknown, or ineligible IDs fail startup.

On a non-loopback bind, every state-changing JSON route requires the exact
canonical HTTPS origin in `CITADEL_PLAYGROUND_PUBLIC_ORIGIN`. The Container Apps
Bicep derives it from the playground app name and managed-environment default
domain. It does not infer trust from `Host`, `Forwarded`, or `X-Forwarded-*`
headers. Local loopback HTTP origins remain available for workstation use.

Each Container App acquires tokens only through its own platform-injected
`IDENTITY_ENDPOINT` and `IDENTITY_HEADER`, with the deployment-owned
user-assigned client ID. Partial or malformed injection fails closed; the secret
identity header is never forwarded to the other app, VM IMDS, or Key Vault.
Hosted deployment selects one fixed Azure cloud profile: public, US Government,
or China. Relay startup cross-checks that profile with the actual ARM cloud,
tenant-specific Entra issuer, fixed Key Vault audience/DNS suffix, and vault
host before requesting a token. Retired Microsoft Cloud Germany endpoints and
caller-supplied audiences are rejected.
The deployed direct `/execute` path uses process-local atomic nonce consumption
and request admission, so each active Container Apps revision is fixed at one
replica and horizontal scale-out is prohibited until one actually shared atomic
adapter backs both controls. Revision transitions and process restarts replace
that local state; operators must drain the acknowledgement validity window before
a rollout, and cross-restart replay protection remains unproven without the shared
adapter. The separate managed-run primitives support replica-safe
nonce/idempotency, distributed concurrency, dispatcher lease recovery, polling,
cancellation, and timeouts when a durable shared store is injected, but that path
is not wired by the hosted entrypoint or Bicep. These claims are based on offline
tests only; the relay has not been deployed or integration-tested.

Future hosted process execution is a different capability. It may be enabled
only as one immutable, no-ingress, per-run isolated job with no compute or
writable-volume reuse, dedicated least-privilege identity, externally enforced
egress, durable owner-bound state, quotas, verified cancellation and cleanup,
and quarantined owner-only artifacts. It must never run inside the public
playground or long-lived relay process.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Start preview-only mode |
| `npm run start:execute` | Start loopback local execution mode |
| `npm test` | Run the recursive Node test suite |
| `npm run check` | Check imports, dependency closure, and repository isolation |
| `npm run smoke` | Run Chromium/CDP interaction and responsive checks |
| `npm run verify` | Run static checks, tests, and browser smoke checks |

No command above proves live Azure behavior unless an operator deliberately
runs a registered sample against an approved non-production environment.
