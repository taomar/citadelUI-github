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
value in browser storage. The plain `http://127.0.0.1:4173/` URL remains
read-only: source and plans can be inspected, but state-changing APIs are
unavailable.

To attach the trusted-workstation local executor:

```powershell
npm run start:execute
```

Execution-capable startup is loopback-only. It uses the operator's local Azure
CLI and optional registered Python dependencies; it is not a hostile-code
sandbox. The launch capability and session rotate on every server restart, and
only a browser opened from the current terminal URL can invoke local execution,
validation, self-test, or Azure account operations. Hosted deployments continue
to use their trusted proxy and Entra boundary instead of this local cookie.

## Execution identity contract

Every catalogue sample has one server-owned execution-context classification.
The browser may report only safe configuration facts; it cannot choose an
identity, command, executable, argument, token, or credential value.

| Context | Authority |
| --- | --- |
| Azure CLI management | The locally signed-in `az` user or service principal |
| Python management | `AzureCliCredential`, inheriting that same local Azure CLI session |
| Foundry REST | A `https://ai.azure.com` audience token minted for that same Azure CLI principal; the token is never returned |
| Gateway REST, MCP, and A2A | The memory-only APIM subscription key under the configured header; only presence and header name are reported |
| Offline source validation | The local Python parser, with no Azure identity or network |
| Hosted HTTP relay | The authenticated Entra caller authorizes the request; the relay uses tenant-scoped managed identity and a Key Vault key mapping |
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
current sample subscription or `null`. The response contains the sample's
`kind`, `state`, safe principal name/type, tenant, active and configured
subscription IDs/names, match status, key presence/header name, and the fixed
`tokensExposed: false` and `credentialsPersisted: false` guarantees. Preview
returns `state: "unavailable"` without probing Azure CLI or contacting a
network.

Local Azure CLI sign-in is explicit. A sample failure never starts it. The
browser offers account switching only when the loopback server advertises a
launch-gated system-browser capability. The UI models disabled, signed-out,
starting, waiting for system UI, verifying, status-unknown, cancelled, failed,
timed-out, ready, and subscription-mismatch states without exposing a sign-in
URL, short code, token, command argument, or process output.

When launch permission is unavailable, account switching fails closed and the
interface names terminal-only `az login` as an external prerequisite. Gateway
key recipes do not show Azure account controls. A server-enumerated subscription
selector requires a fixed **Set Active** action and warns that it changes the
shared Azure CLI default.

## What the interface shows

One of the 19 catalogue samples is selected at a time. Its Signed Run Dossier
keeps the operator path in one semantic document:

1. purpose, prerequisites, and the global execution context;
2. required, conditional, secret, defaulted, and generated inputs;
3. a decision-first review of identity, target, authorization, effect, blast
   radius, reversibility, and the deterministic operation; and
4. streamed progress, final assertions, evidence, and artifacts.

Source remains fixed. Configuration controls are the only editable surface.
Protected source and guide content open as secondary inspectors and never
precede blockers on compact layouts. Risk acknowledgement and destructive
confirmation are fresh per run and are invalidated when an input or execution
context changes. Output alone uses internal Transcript, Evidence, and Artifacts
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
