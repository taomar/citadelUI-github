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

## Start

Node.js 20.6 or newer is required. There are no package dependencies.

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
deployments continue to use their trusted proxy and Entra boundary instead of
this local cookie or private CLI profile.

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
