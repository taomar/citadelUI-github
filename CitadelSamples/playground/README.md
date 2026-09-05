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

Open `http://127.0.0.1:4173/`. This is preview mode and executes no sample.

To attach the trusted-workstation local executor:

```powershell
npm run start:execute
```

Execution-capable startup is loopback-only. It uses the operator's local Azure
CLI and optional registered Python dependencies; it is not a hostile-code
sandbox.

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

Local Azure CLI sign-in is explicit. The server never starts it because a
sample failed:

| Endpoint | Exact JSON request |
| --- | --- |
| `POST /api/azure-login/start` | `{ "protocolVersion": 2 }` |
| `POST /api/azure-login/status` | `{ "protocolVersion": 2, "loginId": "azure-login-0001" }` |
| `POST /api/azure-login/cancel` | `{ "protocolVersion": 2, "loginId": "azure-login-0001" }` |

These endpoints are same-origin, JSON-only, and available only from the
loopback execute server. Start invokes exactly `az login --use-device-code`
with no shell and no browser-supplied arguments. One login may be in flight.
Status reports `starting`, `waiting-for-user`, `succeeded`, `failed`,
`cancelled`, or `timed-out`, plus a safely parsed verification URL and user
code. Success refreshes the safe Azure CLI account projection. Raw process
output and tokens are never returned or persisted.

## What the interface shows

One of the 19 catalogue samples is selected at a time. The notebook-like
workspace separates:

- guidance and prerequisites;
- declared configuration;
- exact protected source and provenance;
- the deterministic typed request plan; and
- streamed progress, final assertions, evidence, and artifacts.

Source remains fixed. Configuration controls are the only editable surface.
Risk acknowledgement is fresh per run and is invalidated when an input changes.

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
Each Container App acquires tokens only through its own platform-injected
`IDENTITY_ENDPOINT` and `IDENTITY_HEADER`, with the deployment-owned
user-assigned client ID. Partial or malformed injection fails closed; the secret
identity header is never forwarded to the other app, VM IMDS, or Key Vault.
Its owner-bound admission and managed run state are replica-safe for
nonce/idempotency, distributed concurrency, dispatcher lease recovery, polling,
cancellation, and timeouts. That claim is based on offline tests only; the relay
has not been deployed or integration-tested.

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
