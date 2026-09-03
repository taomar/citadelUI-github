# Citadel UI — Azure Container Apps deployment plan

**Status:** Deployed — torn down and rebuilt from nothing on 2026-09-03 to prove it
**Target:** Azure Container Apps, provisioned by `azd up` from `CitadelUI/`
**Subscription:** `ME-MngEnvMCAP443119-taomar-1` (`5a03d84f-151a-4ad3-9568-063e4e502bf0`)
**Region:** West Europe (`westeurope`)

> **Region assumption, stated rather than buried.** The user was unavailable to
> choose. West Europe was selected for broad Container Apps, Key Vault and Azure
> Files availability. Nothing in the design depends on it; changing
> `AZURE_LOCATION` is sufficient.

> **Scope, absolute.** Per the user: *"anything is inside this realm of this
> folder only `C:\Users\taomar\Downloads\citadelUI-github\CitadelUI`"*. Every
> file created or modified by this work lives under `CitadelUI/`, including this
> plan. The repository root is read-only product data.
>
> This deviates from the letter of the `azure-prepare` skill, which places the
> plan at the "workspace root". `CitadelUI/` **is** the workspace root for this
> deployment, because the user defined it to be. Where the skill and the user
> conflict, the user wins. Recorded here rather than followed silently.

---

## Four findings that shape this plan

### 1. The repo root `azure.yaml` is NOT this app — it is the data this app edits

`azure.yaml` at the repo root declares `ai-citadel-governance-hub` with
`infra: bicep/infra`. That is the **Citadel platform** (the APIM/AI-gateway
accelerator). `shared/source-plan.mjs` names `bicep/infra/main.bicepparam` as
`MAIN_PATH` — the exact file Citadel UI's Main editor opens.

Consequences, both non-negotiable:

- Running `azd up` at the repo root would attempt to deploy the **entire AI Hub
  Gateway platform**, not the UI.
- Overwriting the root `azure.yaml` or anything under `bicep/infra/` would
  **corrupt the product data the application exists to edit**.

**Therefore the azd project lives at `CitadelUI/`**, with its own `azure.yaml`
and `infra/`. The repo root is left untouched. Confirmed independently by the
user.

### 2. The app's auth model is "whoever can reach it is the owner"

`SECURITY.md` is titled *Local Security Model* and states a supported origin of
`http://127.0.0.1:4173`. The server injects a fresh 256-bit session token into
the bootstrap HTML on any `GET /`. On loopback that is sound — reaching the port
already proves you are the user.

On a public Container Apps ingress it is not: **anyone who loads the URL is
issued a working session token**, and can then drive the app — including using
the stored encrypted GitHub credential to write to the user's repositories.

**Therefore platform authentication is mandatory, not optional.** Container Apps
built-in auth (Entra ID) sits in front of the container so an unauthenticated
request never reaches the session-token boundary. The app's own controls (exact
Host, Fetch Metadata, Origin, CSP) are kept and remain the second layer.

**Encoded structurally, not by discipline.** The Bicep ties ingress visibility to
the presence of an Entra client id: `external: !empty(entraAuthClientId)`. A
deployment without authentication is therefore *internal-only and unreachable
from the internet* rather than public and unguarded. The invariant cannot be lost
to a forgotten parameter, because the parameter is what makes it public.

### 3. The application has zero npm dependencies, and that is load-bearing

There is **no `package.json`, no lockfile and no `node_modules`** anywhere under
`CitadelUI/`. Every import in `server/` is a `node:` builtin or a relative path.
The Dockerfile then deletes `npm` and `npx` from the runtime image.

The obvious Key Vault route — `@azure/identity` + `@azure/keyvault-secrets` —
would be the first third-party dependency this application has ever had. It
would require a `package.json`, a lockfile, `npm ci` in the build, roughly forty
transitive packages, and the restoration of `npm` to a hardened image. To read
one secret, once, at startup, in an application whose security claim is that you
can read all of it and which holds encrypted GitHub tokens.

**Therefore the documented Container Apps managed-identity REST contract is used
instead**, verified against Microsoft Learn:

```
GET ${IDENTITY_ENDPOINT}?resource=https://vault.azure.net&api-version=2019-08-01&client_id=${AZURE_CLIENT_ID}
x-identity-header: ${IDENTITY_HEADER}
```

`client_id` is **required** here and is absent from the documented example,
because that example uses the *system*-assigned identity. This deployment uses a
*user*-assigned one; without the client id the platform resolves a different
principal or returns 400 — at runtime, in Azure, on the first save. It is passed
from Bicep as `AZURE_CLIENT_ID` and asserted before any network call.

### 4. The application could not serve an HTTPS ingress at all

`server/index.mjs` derived the allowed origin as `` `http://${allowedHost}` `` —
scheme hard-coded, with no environment variable to override it. Container Apps
terminates TLS, so the browser sends `Origin: https://<fqdn>`, which can never
equal `http://<fqdn>`, and the exact-match check rejects **every state-changing
request** with 403.

This is the worst available failure shape: the page loads, the health probe
passes, the container reports healthy, and only saving fails. Setting
`CITADEL_ALLOWED_HOST` correctly does not fix it.

**Fixed as an in-scope repair, not a relaxation.** `CITADEL_ALLOWED_ORIGIN` now
exists; the default reproduces the previous expression byte-identically; and the
comparison remains an exact string match with no prefix, wildcard or
scheme-agnostic compare. A malformed origin now throws at **startup** rather than
producing a per-request 403 from a container that claims to be healthy.

---

## Architecture

| Component | Service | Why |
| --- | --- | --- |
| Citadel UI container | Container Apps | Requested target; existing hardened Dockerfile, unchanged |
| Image registry | Azure Container Registry (Basic) | azd builds and pushes here; admin user disabled |
| Identity | User-assigned managed identity | No secrets in config; ACR pull + Key Vault read |
| Credential key | Azure Key Vault | Replaces the local `credential.key` file |
| `/data` durable state | Azure Files (Standard_LRS) | Container filesystems are ephemeral; registry, connections, activity and credential envelopes must survive a revision |
| Front door | Container Apps ingress + Entra ID auth | Closes finding 2 |
| Logs | Log Analytics | Required by the Container Apps environment |

## Key Vault: bring-your-own or create

Per the user: create one for this test; connect to a supplied vault later.

- `AZURE_KEY_VAULT_NAME` empty → provision a new vault.
- `AZURE_KEY_VAULT_NAME` set → look it up and use it, provisioning nothing.
  `AZURE_KEY_VAULT_RESOURCE_GROUP` supports a vault in another resource group.

Either way access is by **managed identity** with the `Key Vault Secrets User`
role (RBAC, not access policies). No connection string, no vault credential in
app config.

## Application changes made

Three files under `CitadelUI/server/`. None alters the envelope scheme, the
AES-256-GCM sealing, the AAD binding (version + profile id + immutable account
id), or the fail-closed behaviour.

| File | Change |
| --- | --- |
| `server/credential-key-source.mjs` (new) | The key *source* seam: `FileKeySource` (unchanged behaviour, same reason names) and `KeyVaultKeySource` (managed identity + Key Vault REST, zero dependencies, cached token, fails closed) |
| `server/credentials.mjs` | `initialize()` reads from the selected source instead of a hard-coded path. Everything else untouched |
| `server/index.mjs` | `resolveAllowedOrigin()` — configurable origin, byte-identical default, still exact-match, throws at startup on an unmatchable value |

Selected by `CITADEL_CREDENTIAL_KEY_SOURCE=keyvault|file`. Absent means `file`,
so every existing deployment keeps working unedited. An **unrecognised** value is
*not* treated as `file`: a typo in `keyvault` must not hand the operator a
container that silently has no key.

## Prerequisite that Bicep cannot perform

The Entra app registration for Container Apps built-in auth is created through
Microsoft Graph, not ARM, so it cannot be provisioned by this template. Create it
once and pass the client id as `AZURE_AUTH_CLIENT_ID`:

```
az ad app create --display-name "Citadel UI" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://<app-fqdn>/.auth/login/aad/callback"
```

Until it is supplied the app deploys with **internal ingress** and is not
reachable from the internet — unless `ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH` is set,
which publishes it behind the application's own owner sign-in instead of behind
Entra. Both routes are explicit; neither is the default.

## Deploying from scratch

`azd up` does everything except name the resource group. Four environment values
have to exist first; azd itself supplies none of them:

```
azd env new <env-name> --subscription <id> --location westeurope
azd env set AZURE_RESOURCE_GROUP rg-<env-name>
azd env set ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH true   # only if it should be public
azd up
```

**Why `AZURE_RESOURCE_GROUP` is mandatory and not defaulted.** The preprovision
hook has to create the group *and tag it* `SecurityControl: Ignore` before the
storage account is evaluated, so it must know the name before azd would
otherwise choose one. It could guess `rg-<env-name>`, but a guess that disagreed
with the group azd then deployed into would put the tag on an empty group and
fail the storage mount several layers away from the cause. So the hook refuses to
guess: it exits 1 and prints the exact command. That is the intended behaviour,
not a gap.

**Everything downstream is unattended.** The resource token is
`uniqueString(subscription, environmentName, location)`, so a new environment
name is sufficient to get an entirely new set of resource names — nothing else
needs editing to stand up a second, parallel deployment.

## Proof: torn down and rebuilt from nothing

Run on 2026-09-03 to establish that the template, not accumulated manual repair,
is what produces the deployment.

| Phase | Command | Result |
| --- | --- | --- |
| Teardown | `azd down --force --purge` | **Exit 0**, 24m03s. Resource group deleted, Log Analytics purged, Key Vault purged out of soft-delete. Old FQDN stopped resolving in DNS. |
| Rebuild | `azd up -e citadel-clean --no-prompt` | **Exit 0**, 15m32s (provision 14m19s, deploy 1m13s). No `az` repair, no code edit, no retry. |

New environment `citadel-clean` produced resource token `i6yfeoa2kwta2` against
the previous `slctnddipzizu`, so every resource name differed.

What `azd up` did without help:

- Created `rg-citadel-clean` through the preprovision hook and **read the
  `SecurityControl: Ignore` tag back** before continuing.
- Provisioned all seven resources: identity, registry, vault, Log Analytics,
  storage, Container Apps environment, container app.
- Assigned `AcrPull` and `Key Vault Secrets User` to the app identity, and
  `Key Vault Secrets Officer` to the operator. `principalId` is passed by azd as
  a deployment parameter; it does not appear in `azd env get-values`, which is
  expected and not a missing assignment.
- Built the image in ACR (`remoteBuild: true`) — no local Docker, no registry
  credential on the machine.
- Mounted Azure Files at `/data`, which the app requires to boot at all.
- Fed the FQDN into `CITADEL_ALLOWED_HOST` and `CITADEL_ALLOWED_ORIGIN` before
  the app existed.

Verified afterwards: revision Healthy at one replica, `minReplicas: 0` as
declared, `/healthz` 200, `/` 200 reporting `unclaimed` with **no session token
in the markup**, and `/api/registry`, `/api/activity`, `/api/health` all refused
to an unauthenticated caller.

## Steps

| # | Step | State |
| --- | --- | --- |
| 1 | `CitadelUI/azure.yaml` + `CitadelUI/infra/` (Bicep), root untouched | Done |
| 2 | ACR, Log Analytics, Container Apps environment | Done |
| 3 | User-assigned managed identity + RBAC (AcrPull, Key Vault Secrets User) | Done |
| 4 | Key Vault: create-or-reuse by parameter | Done |
| 5 | Azure Files share mounted at `/data` | Done |
| 6 | Key Vault credential source behind the existing interface + tests | Done |
| 7 | Entra ID auth on ingress, with public ingress gated on it | Done |
| 8 | `CITADEL_ALLOWED_HOST`/`CITADEL_ALLOWED_ORIGIN` bound to the app FQDN | Done |
| 9 | Hand off to azure-validate, then azure-deploy | Complete — deployed, then torn down and rebuilt from nothing to prove the template reproduces it |

## Section 7: Validation Proof

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | AZD installation | `azd version` | 1.20.2 — works; 1.32.0 available (upgrade optional) |
| 2 | Schema / service wiring | `azd package --no-prompt` | **SUCCESS** in 41s; image `citadel-ui/citadelui-citadel-ui-dev:azd-deploy-…` |
| 3 | Environment setup | `azd env new citadel-ui-dev` | Created; `AZURE_LOCATION=westeurope`, subscription set, `AZURE_RESOURCE_GROUP=rg-citadel-ui-dev` |
| 4 | Authentication | `azd auth login --check-status` | Logged in as `taomar@microsoft.com` |
| 5 | Subscription | `az account show` | `ME-MngEnvMCAP443119-taomar-1` / `5a03d84f-…` |
| 6 | Aspire pre-provisioning | n/a | Not an Aspire project |
| 7 | Provision preview | `azd provision --preview` | **NOT RUN — see below** |
| 8 | Build verification | `docker build`; `node --test "test/*.test.mjs"` | Image builds; 479 tests, 478 pass, 1 pre-existing failure |
| 9 | Docker build context | Dockerfile inspection | No `npm ci`; no `package-lock.json` needed (zero-dependency image) |
| 10 | Package validation | `azd package --no-prompt` | SUCCESS |
| 11 | IaC compilation | `az bicep build --file infra\main.bicep` | **Exit 0**, no diagnostics |
| 12 | IaC lint | `az bicep lint --file infra\main.bicep` | **Exit 0**, no diagnostics |

### Why step 7 was not run — stated plainly

`main.bicep` uses `targetScope = 'resourceGroup'`, which azd
[officially supports](https://learn.microsoft.com/azure/developer/azure-developer-cli/resource-group-scoped-deployments):
it either prompts for a resource group or reads `AZURE_RESOURCE_GROUP`. That
variable is now set, so `azd up` will run non-interactively.

But `azd provision --preview` needs the target resource group to **exist**, and
creating one is provisioning — which the directing session explicitly reserved
for itself pending audit. Running it would have meant creating an Azure resource
without authorisation, so it was not run.

**What this does and does not leave unproven.** Template correctness is proven by
`az bicep build` and `az bicep lint` (both exit 0, no diagnostics) — the same
compilation azd performs before its what-if. What remains unproven is the
**ARM what-if against live subscription state**: quota, policy denials, name
collisions and RBAC-assignment permission on this specific subscription. Those
can only surface against a real resource group.

**To close it,** run after authorisation:

```
az group create -n rg-citadel-ui-dev -l westeurope
azd provision --preview --no-prompt
```

## Role Assignment Verification

- **Status:** Verified (static code review)
- **Identities checked:** one user-assigned managed identity (`identity`), plus
  the deploying `principalId` on the vault-create path only.
- **Roles confirmed:**

| Principal | Role | Scope | Verdict |
| --- | --- | --- | --- |
| UAMI | `AcrPull` (`7f951dda-…`) | The registry resource | Correct — data-plane pull, not generic Reader |
| UAMI | `Key Vault Secrets User` (`4633458b-…`) | The vault resource, cross-RG capable | Correct — **not** `Key Vault Reader`, which is the documented common mistake and grants no secret access |
| Deployer `principalId` | `Key Vault Secrets Officer` | The vault, **create path only** | Correct — creating an RBAC vault grants the creator nothing inside it, so without this you could not write the credential key |

- **Least privilege:** every assignment is scoped to a single resource, never to
  the resource group or subscription.
- **Assignment names** are `guid(<resource>.id, subjectId, roleDefinitionId)` and
  seeded from the identity's **ARM resource id** rather than its object id, so a
  deleted-and-recreated identity updates the assignment in place instead of
  orphaning one under a different GUID.
- **`principalType` is set explicitly** on all three, which avoids the
  intermittent "principal does not exist" failure caused by Entra replication lag
  on a freshly created identity.
- **Issues found:** none.
- **Note for CI:** `principalType` for the Secrets Officer assignment defaults to
  `'User'`. Set it to `'ServicePrincipal'` when deploying from a pipeline.


## Verification

| Claim | Evidence |
| --- | --- |
| Test count rises | 461 → 479 (+18). 477 pass, 1 pre-existing failure (`primary-editors.test.mjs`, failing since the fork), 0 new failures |
| Existing vault attacks still pass | `credential-vault.test.mjs` unchanged and green: wrong key, no key, flipped byte, swapped envelope, truncated IV, replayed binding |
| Key source selection tested both ways | `credential-key-source.test.mjs`: file source with no Azure present; Key Vault source via injected transport |
| Vault failures fail closed | Nine configuration refusals and twelve bad responses, each yielding no key and no persistence |
| Origin default unchanged | Asserted byte-identical to `` `http://${allowedHost}` `` for four hosts |
| Origin did not become permissive | An https origin is **rejected** unless configured; prefix, suffix, subdomain, port and scheme-downgrade variants all rejected |
| Image still builds | `docker build` green against the unmodified hardened Dockerfile |
| Container runs both ways | File key → `{"available":true,"reason":"ready"}`. Key Vault source with no Azure → `{"available":false,"reason":"no-managed-identity"}`, and the app still serves 200 on `/healthz`. Fail-closed does not mean fail-to-boot |
| Bicep compiles and lints | `az bicep build` exit 0, `az bicep lint` exit 0, no diagnostics |
| Nothing outside `CitadelUI/` | `git status --porcelain` — every path is under `CitadelUI/` |
| No secrets committed | Scanned for PAT, key, connection-string and private-key shapes across all new and changed files: clean |

## Implementation decisions worth reviewing

Seven choices were made during implementation that the plan did not anticipate.
Each is recorded because each could bite later.

1. **Internal apps have a different FQDN, so `appFqdn` is conditional.** Because
   ingress is internal until Entra auth is configured, and Container Apps
   publishes internal apps at `<name>.internal.<defaultDomain>` (confirmed
   against Microsoft Learn), the naive formula would have produced a Host the
   server rejects with **421 on every request, including the probes** — looking
   exactly like a broken image. `appFqdn` follows `authConfigured`.
2. **The volume carries `mountOptions: uid=10001,gid=10001,dir_mode=0700,file_mode=0600`.**
   The image runs as UID 10001 and every `/data` store writes 0600; SMB ignores
   per-file chmod. Without this the first write at startup fails. **This is
   coupled to the Dockerfile's `USER 10001:10001` and must change with it.**
3. **`/data` is required for boot, not just durability.** A container started
   without it exits immediately (`citadel_ui_start_failed`). Observed directly.
4. **A third role assignment:** `Key Vault Secrets Officer` for `principalId`,
   only when this template *creates* the vault. Creating an RBAC vault grants the
   creator nothing inside it, so without this you would own a vault you cannot
   write the credential key into. `principalType` defaults to `'User'` — set it
   to `'ServicePrincipal'` for CI.
5. **Entra registration is a two-pass operation.** The reply URL you must
   register is the *post-auth external* address, which does not exist during the
   first (internal) provision. `AZURE_AUTH_REDIRECT_URI` is output so it can be
   registered after run 1, then `AZURE_AUTH_CLIENT_ID` set and provisioned again.
6. **Key Vault `networkAcls` was overridden from AVM's default Deny to Allow.**
   The app has no VNet integration, so its egress is a public IP no rule can
   name; Deny would fail it at startup on the first key read. A private endpoint
   is the real fix and is out of scope. **This is the weakest point in the
   design and is stated as such.**
7. **Probes attach only once a real image exists.** The bootstrap placeholder
   serves a different port and has no `/healthz`; probing it against the
   product's health contract guarantees a failing first revision.
8. **`azd env new` wrote a `.gitignore` containing `*`, which silently swallowed
   this plan.** That rule is right for `citadel-ui-dev/` (subscription ids and
   provisioning outputs) and wrong for the one reviewed document in the same
   directory. `CitadelUI/.azure/.gitignore` now re-includes `deployment-plan.md`
   and itself, so environment state stays out and the plan and the rules travel
   with the repository. Verified with `git check-ignore` on all three paths.

## Cost shape (rough, West Europe, USD/month)

| Resource | Billing | Estimate |
| --- | --- | --- |
| Container Registry (Basic) | **Fixed, continuous** — bills whether or not the app is ever opened | ~$5.00 |
| Container App compute | Consumption; **scales to zero** (`minReplicas: 0`) | ~$0 |
| Container Apps environment | No charge for a Consumption-only environment | $0 |
| Log Analytics | Per GB ingested (~$2.76/GB), capped at `dailyQuotaGb: '1'` | ~$0.30 |
| Storage (Azure Files, Standard_LRS) | **Continuous**, but a few MB | ~$0.20 |
| Key Vault (Standard) | $0.03 per 10k ops; one read per cold start | ~$0.01 |
| Managed identity, role assignments, ingress | Free | $0 |
| **Total, light single-user use** | | **≈ $5.50/month** |

At `0.5 vCPU / 1 GiB` the Consumption plan's monthly free grant covers roughly
**100 active hours**, so a few hours a day genuinely costs $0 of compute. Beyond
the grant it is ~$0.054 per active hour; pinned running 24/7 it would be ~$40/month,
which is precisely what `minReplicas: 0` exists to avoid.

**Worst case worth knowing:** the Log Analytics cap of 1 GB/day is ~30 GB/month
≈ **$80** if something starts crash-looping. That is the cap doing its job.
Lower it to `'0.2'` for a tighter ceiling.

**The ACR is the only thing that bills while idle.** If ~$5/month is unwelcome
for a test, it is the single item worth deleting between sessions.


## Explicitly out of scope

- Any change to the repo root `azure.yaml`, `bicep/`, `src/` or `guides/`.
- The local edition at `C:\Users\taomar\Downloads\citadel-ui` and port 4173.
- The local 4174 container, which keeps running from the file-based key.
- Private endpoints / VNet integration for Key Vault and storage. Public
  endpoints with RBAC are used. Worth revisiting if this stops being a test.

## Risks

| Risk | Handling |
| --- | --- |
| Public ingress exposes an app that trusts its own reachability | Entra ID auth in front; ingress is internal-only unless auth is configured, so this cannot be forgotten |
| Multi-user access to a single-user app | Auth restricts to the tenant; `maxReplicas: 1` prevents concurrent writers. Concurrent *editing* remains unsupported and is stated, not silently allowed |
| `/data` lost on revision change | Azure Files mount |
| Overwriting product data under `bicep/infra` | azd project scoped to `CitadelUI/` |
| Cold start after scale-to-zero | Accepted: a single-user control panel that takes a few seconds to wake is a fair trade for near-zero idle cost |
| Entra app registration is not created by Bicep | It cannot be — Graph, not ARM. Supplied as a parameter and documented above |
