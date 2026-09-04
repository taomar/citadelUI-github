# Citadel Publish Playground Continuation Plan

This document is the complete plan and operator runbook for finishing validation
of the Citadel Publish Playground and evolving its execution boundary for Azure
Container Apps.

Do not execute live scenarios until an isolated non-production Azure environment
has been selected and its owner has approved the intended operations.

All PowerShell examples are portable. Run them from the repository root unless
the example changes into `CitadelSamples\playground`. No command depends on a
specific Windows username, drive, or local checkout path.

## Current checkpoint

| Item | Value |
| --- | --- |
| Branch | `citadel-samples-playground` |
| Pushed commit | `1fd4326341329db0e2a6b6c39252bcf164ef4b5b` |
| Repository | `taomar/citadelUI-github` |
| Main handover | `CitadelSamples/AGENT_PROGRESS.md` |
| Automated baseline | 279/279 tests and 81/81 browser checks |
| Live Azure validation | Not performed |

### Authoritative execution queue

This queue governs continuation work. Hosted development and offline verification
do not require Azure authentication. Every live item remains blocked until an
isolated non-production environment is selected and its owner approves the
intended operations.

| Order | Work item | Status | Exit condition |
| ---: | --- | --- | --- |
| 1 | Preserve fresh-checkout invariants | Complete | Notebook bytes remain exact on Windows and `.runs/` is ignored |
| 2 | Independent offline QA | Complete | Catalogue, security, accessibility, responsive, and automated baselines pass without Azure |
| 3 | Trace and threat-model the external relay | Complete | Protocol, trust boundaries, deployment shape, and required controls are documented |
| 4 | Harden the relay protocol and proxy; implement an HTTP/assertion-only relay | Complete | Server-authoritative validation, authentication, target allowlists, acknowledgement binding, limits, cancellation, and redaction pass offline tests |
| 5 | Add a zero-setup offline self-test | In progress | A user can run a clearly labelled local demonstration through the real UI/server path without Azure; its result cannot be mistaken for live evidence |
| 6 | Add managed run state and hosted job orchestration | Pending | Run ownership, polling, cancellation, idempotency, concurrency, timeout, and partial-failure behavior are deterministic |
| 7 | Add Container Apps, managed identity, Key Vault, and least-privilege deployment assets | Complete | Bicep, container, and static checks prove the intended topology without provisioning Azure |
| 8 | Run relay security, protocol, deployment-static, and local end-to-end tests | Pending | Required abuse cases fail closed and no process executor is reachable remotely |
| 9 | Update operator documentation and handover | Pending | Local, hosted, security, deployment, and remaining-unproven behavior agree |
| 10 | Firefox, Safari, and real screen-reader validation | Pending | Release evidence covers the outstanding browser and assistive-technology matrix |
| 11 | Select and approve an isolated non-production environment | Blocked | Environment owner records approval, rollback, target IDs, permissions, and cost boundary |
| 12 | Run live scenarios 1-16 and verify `a2aProperties` | Blocked by item 11 | Every baseline scenario has redacted evidence and the BCP089/API-version behavior is resolved |
| 13 | Record redacted golden live fixtures | Blocked by item 12 | Fixtures contain evidence but no secret or credential material |
| 14 | Run Policy bursts, then Lifecycle cleanup | Blocked by items 12-13 | Load and cleanup outcomes, cost, rollback, and residue are independently verified |
| 15 | Deploy and integration-test the hosted relay | Blocked by items 6-8 and 11 | Identity, authorization, rotation, cancellation, timeout, retry, and partial failure pass live |
| 16 | Push, review, and merge | Pending | All applicable release gates pass and unproven gates remain explicitly labelled |

The imported source remains:

```text
CitadelSamples/citadel-publish-contract-tests.ipynb
```

Expected SHA-256:

```text
EE706B4DAC2978D4F35885EA5F77A7D6A12ADD337E7F959690550BE28D4523BB
```

## Non-negotiable boundaries

1. Work only inside `CitadelSamples`.
2. Do not modify the imported notebook.
3. Do not target a production subscription, gateway, Foundry project, or vault.
4. Never persist gateway keys, Foundry tokens, GitHub PATs, or other credentials
   in source, fixtures, exports, logs, screenshots, URLs, job arguments, or run
   results.
5. Keep ordinary startup preview-only.
6. Keep the local process executor restricted to loopback.
7. Never expose the local process executor directly from Container Apps.
8. Do not run Policy bursts or Lifecycle cleanup until scenarios 1-16 pass in
   the same isolated environment.
9. Preserve fresh acknowledgement and non-production confirmation for every
   state-changing, load-generating, or destructive operation.
10. Treat blocked, failed, inconclusive, cancelled, and completed as different
    states. Never convert missing evidence into success.

## Execution models

### Preview mode

Use for documentation, configuration, and request generation:

```powershell
Set-Location .\CitadelSamples\playground
npm start
```

Open:

```text
http://127.0.0.1:4173/
```

Preview mode supports:

- selecting all 19 samples;
- reading sample guides and prerequisites;
- entering mandatory, conditional, optional, generated, and secret values;
- generating and downloading JSON configuration;
- generating and downloading `.env.example`;
- inspecting the exact redacted execution plan.

Preview mode executes nothing.

### Local operator mode

Use for controlled testing from a trusted workstation:

```powershell
Set-Location .\CitadelSamples\playground
npm run start:execute
```

The server:

- binds to loopback;
- probes local Azure CLI and Python availability;
- reports readiness per sample;
- validates inputs and acknowledgement again on the server;
- rebuilds the selected plan from the server catalogue;
- executes only registered operations;
- writes generated files under ignored `.runs/<run-id>/` workspaces;
- redacts credentials before returning results;
- supports cancellation of an identified active run.

### Container Apps relay

Use for hosted execution. This is the recommended production architecture.

Do not expose the local operator process executor remotely. Implement the
existing relay contract with managed identity, Key Vault, destination
allowlists, and asynchronous run state.

### Browser-direct execution

Use only as an optional convenience for selected data-plane MCP or A2A calls.
It is not suitable for Azure management operations, Python recipes, deployments,
role assignments, bursts, or cleanup.

Browser-direct execution requires:

- restricted APIM CORS origins;
- `POST` and `OPTIONS`;
- `Content-Type`, the subscription-key header, `Authorization` where used, and
  `Mcp-Session-Id` in allowed headers;
- `Mcp-Session-Id` exposed in response headers;
- explicit acceptance that the gateway key exists in browser memory.

The server-side relay is preferred because it avoids browser CORS and credential
exposure constraints.

### Manual export

Use when automated execution is unavailable or an operator requires an approval
step outside the application. Download the configuration, generated Bicep or
policy artifacts, and command preview, then execute them in a controlled
terminal.

## Phase 1: independent offline QA

### Restore the checkpoint

```powershell
git clone https://github.com/taomar/citadelUI-github.git
Set-Location .\citadelUI-github
git switch citadel-samples-playground
git pull --ff-only origin citadel-samples-playground
git rev-parse HEAD
git status --short
```

The expected pushed commit is:

```text
2a88d4bc646e296b2195f9fb00155c5f5b00f0e8
```

### Run the existing validation

```powershell
Set-Location .\CitadelSamples\playground
npm run verify
Get-FileHash ..\citadel-publish-contract-tests.ipynb -Algorithm SHA256
```

### Independently verify

Do not rely only on the existing automated suite. Confirm:

1. All 19 samples are present and grouped correctly.
2. Each Configure view renders only fields used by that sample.
3. Mandatory values block execution when blank.
4. Conditional values block only while their condition is active.
5. Optional values show their notebook-derived fallback.
6. Generated values show which earlier recipe or runtime step produces them.
7. Secrets are required only for samples that present a credential.
8. JSON configuration exports are deterministic and parse successfully.
9. `.env.example` contains empty placeholders, not values.
10. Preview mode cannot reach an executor.
11. Operator mode refuses non-loopback binding.
12. `/api/run`, `/api/run/cancel`, and `/api/execute` require same-origin JSON
    requests.
13. Client-supplied plans, commands, executables, URLs, headers, scripts, paths,
    unknown values, and unknown secrets are rejected.
14. Active runs expose an ID before completion and can be cancelled.
15. Cancellation stops only the identified run.
16. Azure CLI is launched without a shell on Windows.
17. HTTP requests are HTTPS-only, do not follow redirects, and stop reading at
    the configured response-size limit.
18. Generated artifacts remain under the run workspace.
19. Failed or inconclusive dependencies stop later effects.
20. No credential appears in errors, evidence, logs, clipboard data, downloads,
    or browser persistence.
21. Keyboard tabs, labels, focus, status announcements, reduced motion, 320px,
    tablet, desktop, and 200 percent zoom remain usable.
22. No file outside `CitadelSamples` changes.

## Phase 2: prepare an isolated non-production environment

### Required local tools

- Node.js 20.6 or newer
- Azure CLI
- Python 3.10 or newer for Python-backed samples

### Required Azure services

- non-production Citadel Governance Hub;
- API Management;
- Application Insights connected to APIM;
- RBAC-enabled Key Vault;
- Foundry account, project, and prompt agent for A2A tests;
- usage pipeline expected by the source notebook.

### Required permissions

Use least privilege and confirm the exact scope before assigning anything.

| Operation | Typical permission |
| --- | --- |
| Read subscription context and resources | Reader or equivalent |
| Deploy subscription-scoped Bicep | Deployment permission plus required resource write roles |
| Create/update APIM APIs, products, subscriptions, policies, and backends | API Management Service Contributor or narrower equivalent |
| Assign the APIM identity to the Foundry project | Owner or User Access Administrator at the intended scope |
| Enable A2A on the Foundry agent | Foundry data-plane permission appropriate for agent update |
| Write contract secrets | Key Vault Secrets Officer |
| Verify contract secrets | Key Vault Secrets User |
| Query Application Insights | Monitoring Reader or equivalent |

### Authenticate and select the environment

```powershell
az login
az account set --subscription <NON_PRODUCTION_SUBSCRIPTION_ID>
az account show --output table
```

Confirm:

- subscription ID;
- tenant ID;
- signed-in principal;
- resource group;
- APIM name;
- Foundry account/project/agent;
- Key Vault name;
- that the environment is disposable or has a documented rollback.

### Install optional Python dependencies

The application never installs packages automatically.

```powershell
Set-Location .\CitadelSamples\playground
python -m pip install -r runtime\requirements.txt
```

The Python-backed scenarios are:

- Ensure Weather API;
- access-contract subscription-key fallback;
- Agent Framework HR question.

### Start operator mode

```powershell
npm run start:execute
```

Confirm the masthead and per-sample Runtime section accurately report what is
ready and what remains missing.

## Phase 3: live scenario runbook

Run the scenarios in catalogue order.

### 1. Azure context check

Purpose:

- verify that Azure CLI is signed in;
- ensure the active subscription matches the configured non-production
  subscription.

Mandatory configuration:

- subscription ID.

Success:

- `az account show` returns successfully;
- active and configured subscription IDs match;
- signed-in principal and tenant are the intended ones.

Do not continue on a mismatch.

### 2. API Management discovery

Purpose:

- find the target APIM instance;
- capture gateway URL, SKU, and location.

Mandatory configuration:

- governance hub resource group.

Generated or override:

- APIM service name.

Success:

- one service is selected deliberately;
- gateway URL is HTTPS;
- APIM name and gateway URL populate later samples.

If several services exist, enter the intended name and rerun. Never choose the
first service implicitly.

### 3. Enable Foundry A2A

Purpose:

- enable incoming A2A on the selected Foundry prompt agent;
- publish the intended card metadata and protocols.

Mandatory configuration:

- Foundry account name;
- Foundry project name;
- Foundry agent name.

Optional configuration:

- API version;
- card description and version;
- skill ID, name, and description.

Authentication:

- Foundry data-plane token acquired through Azure authentication.

Success:

- PATCH returns a successful status;
- agent configuration includes A2A;
- derived card and JSON-RPC backend paths are correct.

### 4. Grant the APIM identity Foundry access

Purpose:

- identify the APIM managed identity;
- assign the required Foundry role at project scope;
- verify the exact role and scope.

Mandatory configuration:

- APIM resource group and service;
- Foundry account and project.

Generated or override:

- identity principal ID;
- identity client ID;
- Foundry account resource ID.

Success:

- exactly one intended identity is selected;
- multiple user-assigned identities require an explicit choice;
- project scope ends in `/projects/<project>`;
- role assignment exists at that exact scope;
- principal/client IDs populate later samples.

Allow for role-assignment propagation before diagnosing a later 403.

### 5. Ensure the Weather API

Purpose:

- create or update the protected `weather-api`;
- apply the vendored mock policy;
- verify the `get-weather` operation.

Mandatory configuration:

- subscription ID;
- APIM resource group;
- APIM service.

Optional configuration:

- custom subscription-key header;
- API ID, path, display name, and operation name;
- vendored spec and policy paths.

Runtime:

- Python;
- `azure-mgmt-apimanagement`;
- `azure-identity`;
- vendored weather OpenAPI and policy.

Success:

- API exists at the expected path;
- subscription protection is enabled;
- custom key header/query configuration is correct;
- mock policy is applied;
- `get-weather` exists.

This is state-changing and can overwrite an existing API with the same ID.

### 6. Publish assets

Purpose:

- generate the publish-contract parameter file;
- deploy Weather MCP, Microsoft Learn MCP, and optional HR A2A assets.

Mandatory configuration:

- subscription/APIM coordinates;
- deployment location;
- asset configuration;
- Foundry backend values when A2A is enabled.

Optional configuration:

- notebook defaults such as paths, names, metadata, circuit-breaker settings,
  and path-prefix behavior.

Success:

- generated parameter file is written under the run workspace;
- deployment state is `Succeeded`;
- every configured asset appears in `publishedAssets`;
- authoritative paths/endpoints populate later Exercise and Policy samples.

Record the exact APIM API version behavior for `a2aProperties`. The vendored
template currently compiles with BCP089 because the installed Bicep type
definition does not recognize that preview property.

### 7. Deploy the mixed access contract

Purpose:

- discover available LLM APIs;
- classify LLM, Tool, Agent, and forwarded source APIs;
- generate the product policy and parameter file;
- deploy the product and subscription;
- mint the shared contract key;
- publish secrets to Key Vault when enabled.

Important two-pass behavior:

1. The first run compares the live LLM API list with the configured list.
2. If they differ, it updates the form and stops before writing or deploying.
3. Review the updated classification and generated files.
4. Run again to deploy.

Success:

- classification matches the live gateway;
- product ID and contract code are correct;
- policy and parameter artifacts are generated together;
- deployment succeeds;
- shared key is captured only in browser memory;
- Key Vault secret names populate the verification sample.

Python is optional for the primary deployment path and required only if the
deployment output omits the key and the documented APIM subscription fallback
must run.

### 8. Verify Key Vault secrets

Purpose:

- verify the shared key secret without printing it;
- verify every endpoint secret.

Mandatory configuration:

- Key Vault name;
- key secret name returned by deployment;
- endpoint secret names returned by deployment.

Success:

- key secret length is greater than zero;
- every endpoint secret is nonempty;
- there is one endpoint secret per granted asset.

### 9. Weather MCP discovery

Purpose:

- verify the published Weather MCP handshake and tool inventory.

Mandatory configuration:

- authoritative endpoint or enough values to derive it;
- contract key.

Success:

- `initialize` returns JSON-RPC success;
- `Mcp-Session-Id` is captured;
- the session ID is sent on `tools/list`;
- JSON or SSE is parsed;
- inventory contains `get-weather`.

### 10. Microsoft Learn MCP discovery

Purpose:

- verify the remote Learn MCP backend through APIM.

Mandatory configuration:

- authoritative endpoint or enough values to derive it;
- contract key.

Success:

- MCP initialization succeeds;
- session chaining succeeds;
- dynamic tool inventory is nonempty.

Do not hard-code a specific tool list because the upstream server owns it.

### 11. A2A agent card

Purpose:

- retrieve the published agent card through APIM;
- verify card transport URLs do not bypass the gateway.

Mandatory configuration:

- gateway agent endpoint;
- contract key.

Success:

- card is valid JSON with name and description;
- all transport URLs point through APIM;
- no Foundry data-plane URL leaks into the card.

### 12. A2A message

Purpose:

- send a JSON-RPC `message/send` call through APIM.

Mandatory configuration:

- agent endpoint;
- contract key;
- message text.

Success:

- HTTP status is successful;
- body contains a JSON-RPC result;
- body contains no JSON-RPC error;
- returned text is nonempty.

An HTTP 200 containing a JSON-RPC error is a failure.

### 13. Agent Framework HR question

Purpose:

- prove an off-the-shelf A2A client can resolve the card and run an agent turn.

Mandatory configuration:

- gateway agent endpoint;
- contract key;
- question.

Runtime:

- Python;
- Agent Framework and A2A packages;
- `httpx`;
- `nest_asyncio`.

Success:

- card resolves from the gateway;
- answer is nonempty;
- card transport URLs remain gateway URLs;
- a corresponding A2A usage metric later corroborates gateway traversal.

### 14. Weather tools/call

Purpose:

- exercise the full MCP-to-protected-source path.

Mandatory configuration:

- Weather MCP endpoint;
- contract key;
- city.

Success:

- initialization and session chaining succeed;
- `tools/call` succeeds;
- payload contains city, temperature, temperature format, description,
  humidity, and wind speed;
- Seattle, New York City, and Los Angeles return Fahrenheit;
- other cities return Celsius.

Do not assert randomized weather values.

### 15. Usage metrics

Purpose:

- verify MCP and A2A custom metrics in Application Insights.

Mandatory configuration:

- hub resource group;
- lookback window.

Generated or override:

- Application Insights component name.

Success:

- component selection is deliberate;
- selected component feeds the query;
- query uses the bounded lookback window;
- rows identify metric and deployment.

Empty results within the configured ingestion delay are inconclusive. Wait and
rerun before calling them a failure.

### 16. Circuit breaker

Purpose:

- verify the published remote backend carries the expected native APIM circuit
  breaker.

Mandatory configuration:

- subscription/APIM coordinates;
- backend names.

Success:

- failure count is 3;
- interval is `PT5M`;
- trip duration is `PT1M`;
- status ranges include 429 and 500-503;
- `Retry-After` is accepted.

Consumption tier does not support this feature and must be reported as
unsupported, not misconfigured.

### 17. Tool rate-limit burst

Do not run until scenarios 1-16 pass.

Purpose:

- prove the Tool policy branch applies its independent request counter.

Required controls:

- isolated non-production confirmation;
- fresh per-run acknowledgement;
- contract key;
- Weather MCP endpoint.

Default run:

- policy limit 20/minute;
- 35 requests;
- concurrency 10.

Success:

- at least one response is HTTP 429;
- transport failures are reported separately.

### 18. Agent rate-limit burst

Do not run until scenarios 1-16 pass.

Purpose:

- prove the Agent policy branch uses an independent counter.

Required controls:

- isolated non-production confirmation;
- fresh per-run acknowledgement;
- contract key;
- agent endpoint.

Default run:

- policy limit 10/minute;
- 25 requests;
- concurrency 10.

Success:

- at least one response is HTTP 429;
- transport failures are reported separately.

### 19. Cleanup

Run only after exporting all required evidence.

Purpose:

- delete only explicitly selected resources;
- report each deletion independently;
- list everything the source notebook leaves behind.

Required controls:

- isolated non-production confirmation;
- fresh per-run acknowledgement;
- explicit deletion switches.

Before running:

1. export configuration and results;
2. record product/subscription/API/backend IDs;
3. review the residue list;
4. confirm whether Weather API removal is intended.

After running:

- verify each deletion separately;
- inspect APIM, Key Vault, Foundry role assignments, generated files, telemetry,
  and deployment history;
- remove remaining items only through an independently approved operation.

## Evidence to capture for every live scenario

Record only redacted evidence:

- sample ID and source cells;
- exported configuration;
- runtime and identity used;
- start and end time;
- safe per-step evidence;
- assertion results;
- public configuration updates;
- whether a secret was updated, never its value;
- API version and service tier;
- retries or reruns;
- failure and recovery behavior;
- rollback or residue state.

Store no gateway key, Foundry token, or PAT in the evidence.

## Phase 4: Container Apps architecture

### Security gates discovered during continuation

The original relay seam is not itself a safe hosted execution boundary. Before
deployment, the implementation must satisfy these additional gates:

1. Same-origin and fetch-metadata checks remain CSRF controls, not caller
   authentication. Authenticate the browser-facing API with Entra/OIDC and the
   service-to-service hop with managed identity. Validate issuer, audience,
   tenant, expiry, client, and operation role.
2. Never attach a gateway key or access token to a caller-selected URL. Resolve
   approved subscriptions, resources, gateway origins, Foundry audiences, vaults,
   and secret names from server-side tenant configuration. Reject redirects and
   unapproved primary or discovered secondary destinations.
3. Replace the relay v1 risk gate with a short-lived, one-use acknowledgement
   bound to caller, tenant, target, sample, canonical input digest, risk text,
   and expiry. Pair state-changing work with idempotency and owned run state.
4. Do not accept caller-selected Azure scopes, role-assignment principals, plans,
   commands, headers, scripts, paths, executables, or arbitrary secret references.
   Rebuild every plan from the pinned server catalogue and default-deny remote
   operation types.
5. Context-encode every generated XML, Bicep, ARM path, JSON, query, and header
   value. Validate final generated policies structurally so an identifier cannot
   introduce an APIM policy element.

### Recommended topology

1. **Playground UI/API Container App**
   - Entra-authenticated ingress;
   - serves the UI and validates user identity;
   - submits sample ID, declared values, secret references, and acknowledgement;
   - never accepts an arbitrary plan or command.

2. **Execution relay or Container Apps Job**
   - independently validates inputs;
   - rebuilds the plan from the server catalogue;
   - performs only registered operations;
   - returns redacted step state and evidence.

3. **User-assigned managed identity**
   - attached to relay/job;
   - used through `DefaultAzureCredential`;
   - receives only the roles required by enabled scenarios.

4. **Key Vault**
   - stores APIM contract keys;
   - stores a future GitHub PAT only if source synchronization is later added;
   - grants the relay identity Key Vault Secrets User;
   - never sends secret values to the browser.

5. **Managed non-secret run state**
   - stores user, sample, timestamps, state, step status, and redacted evidence;
   - does not store secret values, access tokens, request authorization headers,
     or secret-bearing job arguments.

### Hosted authentication

Replace local Azure CLI user authentication with managed identity:

- use `DefaultAzureCredential`;
- use Azure SDK clients or ARM REST for management operations;
- acquire Foundry tokens for the required audience through managed identity;
- retrieve APIM keys from Key Vault only when a sample requires one;
- keep secrets in executor memory for the duration of a run;
- do not return minted or retrieved keys to a hosted browser.

These 19 notebook scenarios do not require a GitHub PAT. If GitHub source sync is
added later:

1. store the PAT in Key Vault;
2. attach a user-assigned identity to the relay;
3. grant only secret-read permission on that vault;
4. resolve the PAT at run time;
5. never put it in a committed env file, image layer, browser payload, URL, log,
   queue message, or result.

### Hosted authorization

Define an explicit operation-to-role matrix. Examples:

- read-only discovery should use read-only roles;
- APIM mutation should use API Management-scoped write permission;
- Key Vault reads and writes should use separate data-plane roles;
- role-assignment creation should be disabled by default;
- enabling role-assignment creation requires deliberate User Access
  Administrator or Owner scope;
- cleanup should require a stronger application role than discovery or testing.

### Hosted networking

- prefer private ingress or Entra-authenticated restricted ingress;
- allow only trusted UI origins;
- allowlist ARM, APIM, Key Vault, Monitor, and Foundry destinations;
- reject arbitrary URLs and redirects;
- use private endpoints where the target environment requires them;
- apply egress controls compatible with the selected APIM/Foundry topology.

### Hosted execution

Use Container Apps Jobs for:

- Bicep deployments;
- Python-backed management operations;
- deliberate rate-limit bursts;
- cleanup;
- other operations that may outlive an HTTP request.

The relay should:

1. allocate a server-side run ID;
2. store non-secret pending state;
3. start the job;
4. expose polling or server-sent status;
5. support cancellation by the exact job/run ID;
6. enforce per-user and global concurrency;
7. enforce step and run timeouts;
8. redact telemetry and results;
9. report partial success explicitly.

### Hosted retries and idempotency

Do not apply generic automatic retries.

- Read-only discovery may use bounded retries for transient failures.
- MCP/A2A calls may retry only when the operation is safe and no duplicate
  externally visible effect can occur.
- Deployments should reuse deliberate deployment names and inspect deployment
  state before retrying.
- Role assignment should read before and after create.
- Bursts must never retry automatically.
- Cleanup must never retry automatically without reviewing partial results.

## Phase 5: release gates

Do not call the playground fully live-ready until:

1. independent offline QA passes;
2. scenarios 1-16 pass on one isolated non-production hub;
3. the APIM `a2aProperties` BCP089 warning is verified or corrected for the
   target API version;
4. redacted golden live fixtures are recorded;
5. Policy bursts pass only after baseline validation;
6. cleanup and residue are verified;
7. Firefox and Safari are tested;
8. NVDA, JAWS, or VoiceOver is tested;
9. the Container Apps relay is deployed with managed identity and Key Vault;
10. hosted cancellation, timeout, retry, partial failure, secret rotation, and
    authorization boundaries are integration-tested;
11. documentation and `AGENT_PROGRESS.md` are updated;
12. changes are committed, pushed, reviewed, and merged.

## Exact continuation instruction

Use this prompt in the continuation session:

```text
Read CitadelSamples/PRODUCT.md, PROJECT_BRIEF.md, README.md,
CONTINUATION-PLAN.md, and AGENT_PROGRESS.md. Work only inside CitadelSamples.
Continue from the pending independent-QA and isolated non-production
live-validation plan. Do not target production. Do not run Policy bursts or
Cleanup before scenarios 1-16 pass. Never persist secrets. Preserve the
server-authoritative local execution boundary and implement Container Apps
hosting through the external relay contract with managed identity and Key Vault.
```
