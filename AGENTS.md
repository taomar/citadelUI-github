# Agent notes

Working knowledge for anyone — human or agent — picking this repository up. It
records what is here, the traps that cost real time, and what is deliberately
unfinished. Read it before changing anything.

---

## What this repository actually is

Three separate things share one tree. Confusing them is the most expensive
mistake available here.

| Path | What it is | Treat as |
| --- | --- | --- |
| `bicep/`, `src/`, `assets/`, `validation/`, `shared/`, `scripts/`, `azure.yaml`, `.env.template` | A fork of the [Citadel AI Hub Gateway accelerator](https://github.com/mohamedsaif/ai-hub-gateway-solution-accelerator/tree/citadel-v1) | **Product data.** These are the files the Control Plane edits. Do not restructure or reformat them. |
| `CitadelUI/` | Citadel Control Plane — the application this repository is about | Source |
| `CitadelSamples/` | Citadel Publish Playground — a separate zero-dependency app with its own tests | Source, experimental |
| `guides/`, `docs/`, `README.md` | Documentation for the Control Plane | Source |

### The scope rule

Everything for the Control Plane lives under `CitadelUI/`. The repository root has
its own `azure.yaml`, and it belongs to the gateway platform, not to this
application: it declares `ai-citadel-governance-hub` with `infra: bicep/infra`, and
`CitadelUI/shared/source-plan.mjs` names `bicep/infra/main.bicepparam` as the exact
file the Azure Deployment editor opens.

Running `azd up` at the root deploys the wrong product. Generating infrastructure
there overwrites the data this application exists to edit.

---

## Running the tests

**Read this before concluding anything from a test run.**

```
cd CitadelUI
node --test "test/*.test.mjs"
```

It must be that glob, run from `CitadelUI/`. There is no `package.json`. Running a
single test file directly leaves `NODE_TEST_CONTEXT` unset, which disables a
production-data-root guard in `server/index.mjs` and produces a **phantom** failure
in `security.test.mjs`. If you see `security.test.mjs` fail, you ran it wrong.

| Suite | Command | Baseline |
| --- | --- | --- |
| Control Plane | `cd CitadelUI; node --test "test/*.test.mjs"` | **490 tests, 489 pass** |
| Publish Playground | `cd CitadelSamples/playground; node --test "test/*.test.mjs"` | **181 tests, 180 pass** |

Known failures, both pre-existing and neither yours to fix unless asked:

- `CitadelUI/test/primary-editors.test.mjs` — has failed since the fork.
- `CitadelSamples/playground` — `golden: the publish contract writes the notebook's
  exact parameter file`. It writes `runtime/accelerator/...` where the notebook says
  `../bicep/infra/...`. Which is correct is an ownership decision, not a bug fix.

Known flake: `CitadelUI/test/connection-profiles.test.mjs` fails roughly one run in
four (`no credential or key material appears anywhere under /data`). Pre-existing
and undiagnosed. Re-run before concluding anything from it.

---

## Traps that cost real time

### `**/test` in `.gitignore` silently swallows test directories

Line ~412 of `.gitignore`, inherited from the accelerator, is `**/test`. It excludes
every test directory in the repository **without any warning**. `git add` reports
success and the tests simply are not there.

Explicit exceptions exist for `CitadelUI/test/` and
`CitadelSamples/playground/test/`. **Any new application added here needs its own
exception or it will be committed without its test suite.** This has already
happened once.

### The git credential helper is additive

`credential.helper` is additive, and the system-level Git Credential Manager
resolves `github.com` to `taomar_microsoft`, an account that cannot see this
repository. The result is a misleading `Repository not found`. Push with:

```powershell
$env:GH_TOKEN=""
$env:CIT_TOKEN = (gh auth token -u taomar)
$h = '!f() { echo username=x-access-token; echo "password=$CIT_TOKEN"; }; f'
git -c credential.helper= -c credential.helper="$h" push origin main
```

### The checked-out branch is not always `main`

Work has been done on `citadel-samples-playground`. Check `git rev-parse
--abbrev-ref HEAD` before assuming a commit went to `main`, and before reading a
`push` result — pushing `main` while HEAD is elsewhere reports "Everything
up-to-date" while your commit sits unpushed on another branch.

### More than one session may be editing this tree

Files under `CitadelSamples/playground/src/` have been modified by a concurrent
session mid-keystroke, leaving syntax errors on disk. Before committing work you
did not write, run `node --check` on it and re-run the suite. Do not commit a
broken intermediate state because someone said "commit all".

---

## Azure deployment

The azd project is `CitadelUI/`. `azd up` provisions seven resources: Container
Apps environment, container app, container registry, storage account, Key Vault,
user-assigned managed identity, Log Analytics workspace.

Resource names derive from `uniqueString(subscription, environmentName, location)`,
so **a new environment name is sufficient to get an entirely new set of names**.
This was proven by a full `azd down` / `azd up` cycle into a fresh resource group.

### The five deployment types

Documented in [`guides/deployment.md`](guides/deployment.md). In short: private
inside an existing VNet (`AZURE_INFRASTRUCTURE_SUBNET_ID`), public behind Entra
(`entraAuthClientId`), public behind owner sign-in
(`ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH`), environment-only, or local.

The exposure invariant in `infra/main.bicep` is `external:
reachableBeyondEnvironment`. Note that `external: true` does **not** mean "on the
internet" — on a VNet-injected environment the same flag publishes on an internal
load balancer. `publicIngress` means the internet specifically and excludes the
VNet case. `SERVICE_CITADELUI_NETWORK` reports which of `vnet` / `internet` /
`environment` a deployment landed on.

### Tenant policy collisions

Four instances of the same pattern — a secure-by-default that this deployment
cannot express:

1. Key Vault `networkAcls` default `Deny` — there is no VNet, so the egress address
   is unnameable.
2. ACR `networkRuleSet` — the Basic SKU **cannot accept** network rules at all
   (`NetworkRuleNotSupported`).
3. Storage `allowSharedKeyAccess` — forced `false` by tenant policy, **silently**:
   the write is accepted, returns 200, and the value reads back `false`.
4. Storage `networkAcls.defaultAction` `Deny` — refuses every address.

The shared-key one is the dangerous one. Container Apps mounts Azure Files over SMB
with the account key, so with shared key denied the mount is refused with
`mount error(13)` and the container exits 1 — and **`/data` is required to boot, not
merely to persist**, so it presents as a crash loop rather than a storage problem.

The escape hatch is a resource group tagged `SecurityControl: Ignore`, applied by
`CitadelUI/scripts/ensure-resource-group.ps1` as a `preprovision` hook. The hook
**reads the tag back**, because the entire reason it exists is a setting that
accepts a value and discards it.

### azd quirks

- azd's own token expires separately from `az`. `azd config set auth.useAzCliAuth true`.
- `AzureCLICredential: exit status 1` is intermittent — `az` takes 4–7s against the
  Go SDK's ~10s timeout. Retry before believing it.
- ACR push 401 from a local Docker: fixed by `remoteBuild: true` in `azure.yaml`,
  which also avoids Docker Desktop's proxy dropping the large base layer.
- The Bicep grants the app identity `AcrPull`; the *deploying* principal needs
  `AcrPush` separately.
- `principalId` is passed by azd as a deployment parameter and does **not** appear
  in `azd env get-values`. Its absence is not a missing role assignment.
- `azd down` without `--purge` leaves the Key Vault soft-deleted and its name
  reserved.

---

## Application facts worth knowing

- **The browser owns repository access.** Directory handles live in the browser
  profile via the File System Access API and cannot be moved into a container. The
  container receives no source mount, no Docker socket, no cloud credential.
  A consequence: automation cannot attach a local folder, because directory pickers
  cannot be driven by Playwright or CDP.
- **The server-side editor is gone.** `config`, `contracts`, `discovery`, `focus`,
  `save`, `bicep` and `access-targets` under `server/` were the pre-browser
  filesystem implementation and were deleted. `server/doclayer.mjs` and
  `server/bicepparam/*` are one-line re-export shims over `shared/`, deliberately,
  not drifted copies.
- **Owner sign-in.** A container is claimed once; there is no second account and no
  password reset. `GET /` carries no session token — only a claim or a sign-in
  issues one. The claim window is open: on a public address the first visitor owns
  it. Deliberate, and listed in `CitadelUI/SECURITY.md`.
- **`atomicJson` cannot provide exclusivity.** It ends in `rename()`, which
  overwrites; its `wx` guards the temporary file. The owner claim needed its own
  `open(path, 'wx', 0o600)`.
- **Modals render in the browser top layer.** `dialog.showModal()` paints above
  every `z-index`, so a fixed status toast is invisible during a save. Progress has
  to live on the clicked element.
- **Non-browser clients get 403, not 401**, on data routes: the transport checks
  (Host, Origin, `Sec-Fetch-Site`) run before the token check. Stricter, not weaker.

---

## History

| Commit | What |
| --- | --- |
| `8f7b4ae` | Selective discovery made real — 82 to 22 GitHub requests, 26 to 6 source reads |
| `dea523c` | Loading animation |
| `951c89a` | Save-once (single-flight) plus already-applied reconcile |
| `a017c0e` | Branch choice; `rescueCommit` deleted |
| `19c460f` | Progress visible in dialogs and startup stages |
| `30d4048` | Titleblock 78px to 48px |
| `d548542` | Azure Container Apps deployment |
| `134d310` | Owner credential sign-in |
| `61bee38` | Storage network ACL fix |
| `1c32af4` | `SERVICE_CITADELUI_PUBLIC` reported the wrong fact; stale threat model corrected |
| `dcc1ce8` | Resource group names itself, so a first `azd up` no longer fails once |
| `92295d1` | Seven obsolete server modules removed |
| `e1d6570` | README rewritten; 22 accelerator guides replaced by two; screenshots; VNet deployment added |
| `1033f3c` | Deployment guide leads with the five deployment types |
| `46bff50` | Citadel Publish Playground (on `citadel-samples-playground`) |

---

## Open items

- **The VNet deployment path has never been provisioned.** It is proven by
  `az bicep build` and `az bicep lint` (exit 0) and by the generated ARM carrying
  `vnetConfiguration`, not by a live deployment into a real subnet. Verify before
  relying on it.
- **26 files under `bicep/` and `.env.template` link to the deleted `guides/`.**
  Left alone because `bicep/` is product data. Fixing those links means editing the
  accelerator fork.
- **The claim window is open** on any public deployment until someone claims it.
- **Region West Europe was an assumption**, made while the user was unavailable, and
  has never been confirmed.
- **`minReplicas`** was once set to 1 by hand on a deployment while the Bicep said
  0. The rebuild took the codified value; if you set it by hand again, codify it.
- **The playground's `golden` test** disagrees with the notebook about the parameter
  file path. Nobody has decided which is right.

---

## Conventions

- Commit messages are short human sentences, not conventional-commit slogans:
  "fix: let the container reach the storage it boots from". The body explains the
  *why*, and states plainly what was **not** proven.
- Documentation here is plain markdown. No raw HTML — it renders as literal text in
  some editors — and no emoji.
- Say what is verified and what is not. A containment fix is not a resolution, and
  an unproven path should be labelled as one.
