# Citadel UI

A browser-mediated editor for user-selected Citadel repositories, packaged for
Windows and macOS, run in a local container, or hosted on Azure Container Apps.
Citadel UI presents independent Bicep/Citadel and native Terraform workspaces.
It edits `.bicepparam` and associated APIM XML, or explicitly selected native
`.tfvars` / `.tfvars.json` inputs, using the shared typed controls. Ordinary
field edits preserve unrelated comments and formatting. Neither format is
automatically converted into, or synchronized with, the other.

One installation manages user-labeled workspaces, grouped into projects. Some
Settings and storage fields call a workspace an environment; it is an editing
profile, not a deployed environment or Terraform CLI/state workspace.
Desktop Microsoft Edge, Google Chrome or Electron grants Local repository access through
the File System Access API in a secure context (HTTPS or supported loopback);
the container never receives a source mount, Docker socket, operator cloud
credential, or broad host filesystem access. Citadel UI does not deploy the
gateway or send telemetry to external services. An Azure-hosted instance uses
its managed identity only to read the optional credential-encryption key from
Key Vault.

For task procedures, start with the [user guide](../guides/using-the-control-plane.md).
This reference holds the format, storage, transport and parser boundaries.

Region fields accept identifiers absent from the suggestion list as ordinary
values, including nested and expression-backed fields. Region-only enum lists
do not block saving or mark the entry unsupported. This is source editing, not
a promise of Azure availability; template decorators/validation blocks are not
silently changed. Other type, enum and sensitive-value safeguards still apply.

All region controls share the 69-entry documented Azure region catalog in
`shared/azure-regions.mjs` (public, China and Government/DoD). Names are suggestions
checked against Microsoft documentation, not a service or subscription allowlist.

GitHub.com Enterprise Managed User logins such as `name_company` are supported.
Connection ownership still uses the immutable numeric GitHub account ID, and
enterprise repository access/policy remains enforced by GitHub.

| Reference | Scope |
| --- | --- |
| [Bicep resource tags](#literal-bicep-resource-tags) | Source-defined literal entries, explicit staging and save/restore |
| [Native Terraform](#native-terraform-workspaces) | Explicit input bindings, source safeguards and offline parser |
| [Terraform export](#export-to-terraform) | Bicep-to-Terraform ZIP mapping |
| [Configuration migration](#migrate-citadel-configuration) | Older values into current Bicep targets |
| [GitHub repositories](#github-repositories) | Connections, branch selection and save outcomes |
| [Backup and recovery](BACKUP-RECOVERY.md) | Local conflicts, interrupted saves and native creation |
| [Diagnostics](DIAGNOSTICS.md) | Timed capture procedure and exact report/API schema |
| [Security](SECURITY.md) | Owner, credentials and source trust boundaries |

---

## Run the supported container

Requirements:

- Docker Desktop/Engine 29 or newer with Compose.
- Microsoft Edge or Google Chrome desktop.
- A user-owned directory for durable Citadel UI data.

The examples pin `citadel-ui-desktop-v1.1.6`, including application revision
`0bc50b8c0c27002695cf9a8b47c0e1cd5e42037d`. Compare the complete build commit
with `releaseRevision` in the release's `CitadelUI-build-*.json`.
For an existing matching checkout, skip the clone and enter its `CitadelUI`
directory. Do not substitute an older `main` checkout or a moving branch.
Source publication does not replace
an existing image or installation. See
[release and offline operation](RELEASE.md).

### PowerShell

```powershell
git clone --branch citadel-ui-desktop-v1.1.6 --single-branch https://github.com/taomar/citadelUI-github.git
Set-Location .\citadelUI-github\CitadelUI
if (-not (Test-Path container.env)) { Copy-Item container.env.example container.env }
.\scripts\start.ps1
```

### Bash

```bash
git clone --branch citadel-ui-desktop-v1.1.6 --single-branch https://github.com/taomar/citadelUI-github.git
cd citadelUI-github/CitadelUI
if [ ! -f container.env ]; then cp container.env.example container.env; fi
# Docker Engine on Linux needs the bind directory writable by container UID 10001.
if [ "$(uname -s)" = "Linux" ]; then
  sudo install -d -m 0700 -o 10001 -g 10001 .data
fi
bash scripts/start.sh
```

Choose one shell, not both. For an existing checkout, skip the clone and enter
its `CitadelUI` directory. Both launchers wait for a healthy container before
reporting success. Compose reads `CITADEL_DATA_PATH` from `container.env` or the
shell; if you customize it on Linux, prepare that directory instead of `.data`.

Open <http://127.0.0.1:4173>. The origin and port are fixed because retained
directory handles are origin-bound. If the port is occupied, stop the conflicting
process you own rather than changing ports.

## Run the Windows or macOS desktop application

The Electron release runs the existing Control Panel without Docker, Node.js, or
a source checkout. The current version is
[Citadel UI Desktop v1.1.6](https://github.com/taomar/citadelUI-github/releases/tag/citadel-ui-desktop-v1.1.6).
Windows users can download the
[Windows installer](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUISetup.exe),
or
[portable ZIP](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUIPortable.zip),
while macOS users can download an
[Apple Silicon DMG](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUI-macOS-arm64.dmg)
or
[Intel DMG](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUI-macOS-x64.dmg).
Portable macOS ZIPs are attached to the same release. Verify packages using
[SHA-256 checksums](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/SHA256SUMS.txt).
Packages are unsigned and the macOS builds are not notarized until signing
credentials are configured. See the
[combined Windows and macOS guide](../guides/deployment.md#windows-and-macos-desktop-release)
for architecture selection, Gatekeeper opening steps, local-folder access, and
fine-grained GitHub PAT requirements.

To build or run Electron from source instead:

```powershell
git clone --branch citadel-ui-desktop-v1.1.6 --single-branch https://github.com/taomar/citadelUI-github.git
Set-Location .\citadelUI-github
Set-Location .\CitadelUI\desktop
npm ci
npm start
```

Build and stage the release assets with:

```powershell
npm run release:win
```

The publishable assets are written to `CitadelUI\desktop\out\release`.
The complete released build is pinned by tag `citadel-ui-desktop-v1.1.6`;
the [release details](RELEASE.md#desktop-v116-import-owners-and-progress) describe its
artifacts. Version v1.1.6 integrates application revision `0bc50b8` from
`taomar-electron-desktop-packaging`; versions through v1.1.3 contained the older
September 7 application. `desktop/application-source.json` pins the accepted
revision. Packaging refuses a different runtime tree and verifies the shipped
hashes; the lower-left version label, window title and `CitadelUI-build-*.json`
identify the installed code.
The packaged UI check exercises owner sign-in, both configuration formats, all
four source choices, the vendored Terraform parser and the Diagnostics window.

The desktop app uses the fixed origin `http://127.0.0.1:4174` and stores its
application data under Electron's `userData` directory, normally
`%APPDATA%\Citadel UI` on Windows or
`~/Library/Application Support/Citadel UI` on macOS. Directory handles retained
by another browser do not transfer to Electron, so existing local environments
must be reconnected once. The native package tests separately verify a real
restricted operating-system directory handle and a writable persistent
File System Access workspace inside Electron. The workspace acceptance attaches
and reopens an existing environment, rejects a duplicate attachment, attaches a
second environment, saves one Bicep value, and reads the saved bytes through an
independent retained handle. Native directory pickers are not automated in CI.

**Check for updates** appears beneath the version label. macOS is
notification-only; portable Windows also notifies without trying to install.
An accessible installed Windows Squirrel updater enables an in-place update
after download confirmation, with a separate restart confirmation. Owner data,
workspace records and the credential key remain in the existing profile.
Release builds check public GitHub metadata at startup and every four hours;
checks never download packages automatically and use no workspace PAT.
See [in-app update checks](../guides/deployment.md#in-app-update-checks).

## Deploy to Azure

The [deployment guide](../guides/deployment.md) contains complete commands for
fresh private-VNet and public deployments, deployment on an existing subnet with
named resource reuse, and separate local PowerShell and Bash paths. Unnamed
resources are created using defaults. Container Apps, networking, Key Vault, Log
Analytics, Container Registry, storage/Azure Files and managed identity can be
existing. A reused Container Apps environment retains its network and logging
configuration.

Hosted deployments use the UI's owner sign-in. The credential-encryption key is
kept in Key Vault: setup creates it only if absent, preserves it on redeployment,
and never prints it. An existing configured UI app can also be updated using the
guide's image-only procedure without replacing its persistent state.

Fresh public deployment, native Bicep parameter-file input, image-only updates
and protected-resource reuse passed live acceptance in West Europe. The protected
path kept service settings unchanged and retained its owner, data and key after
redeployment. Its temporary private VM is a build/test host, not the UI runtime.
Fresh private-network creation remains an unproven live path.

Run Azure deployment commands from **`CitadelUI/`**, never from the repository
root: the root `azure.yaml` deploys the gateway, not this UI.

Edit `infra/main.bicepparam` for deployment inputs. azd reads that file natively;
the preprovision hook synchronizes evaluated nonsecret settings into the selected
environment before validating resource reuse. Replace its environment-default
expressions with literals for explicit choices. Use `scripts\deploy-image.ps1`
for image-only updates instead of copying registry build/update commands.

## Signing in

The first time a container starts it has no owner, so it asks you to create one:
a username and a password of your choosing. That account is the only account this
container will ever have.

- There is no second user and no password reset. Keep the password somewhere
  safe. A fresh deployment is a separate identity, not recovery of this account
  or its existing state; do not delete state as a sign-in repair.
- The password is never stored, only an scrypt hash of it.
- Signing in is what issues the session token every other request uses, so
  reaching the URL is no longer enough on its own to use the application.
- The credential lives at `/data/settings/owner.json`, so it survives restarts
  only while `/data` is persistent. On ephemeral storage the container is
  claimable again after every restart.

If two people open a brand-new container at the same moment, exactly one becomes
the owner; the other is asked to sign in.

On first use, **Create local from Citadel source** can prepare the public
upstream `citadel-v1` snapshot without a GitHub token. Choose an empty parent
folder, enter the new project subfolder name, and review the exact destination
and pinned commit before copying. The named child becomes the workspace only
after full content verification and registration. This is not a Git clone and
does not run scripts. The same flow is in **Settings > New project**.
See the [local source walkthrough](../guides/using-the-control-plane.md#create-a-local-project-from-citadel-source)
for limits, concurrency guarantees, and partial-folder recovery.

To attach existing files instead, choose **Bicep / Citadel** or **Terraform (native)**
independently of **Local** or **Existing GitHub Repo**. Create a project, enter an environment label and display-only
**Local path**, and choose the exact Citadel repository through the in-app folder
picker. Repeat from **Settings** for Development, Test, Production, or any other
labels. Labels, folder names, and Local paths are informational. Normal attachment
for Bicep requires the Main deployment,
LLM onboarding, and Access Contracts template paths and signatures; an incomplete
tree is rejected with the missing capability names and is never activated.
Terraform instead admits one or more explicitly selected native units; LLM or
Access can stand alone without Main or a Bicep workspace.

Directory handles remain in the browser profile because they cannot be moved
into a container. Non-sensitive project and environment metadata, including the
user-entered display-only Local path, is mirrored to
`/data/settings/registry.json`. After a container restart, retained browser
handles reopen normally. After browser-profile loss, labels and fingerprints
remain visible with their Local paths. A native Local workspace must reconnect
its original retained handle. If that handle was lost, selecting the same folder
does not restore old draft/history identity. Preserve the old record. A new
workspace has a new identity and must use a folder allowed by the ownership
checks, such as a distinct operator-managed source copy. Identical or demonstrably
overlapping Local attachments are refused. See
[lost-handle limitations](BACKUP-RECOVERY.md#lost-native-folder-handles).

Use `scripts\status.ps1`, `scripts\logs.ps1`, and `scripts\stop.ps1` for local
operation in PowerShell. In Bash, use `docker compose --env-file container.env ps`,
`docker compose --env-file container.env logs --tail 200 --follow app`, and
`docker compose --env-file container.env down` from `CitadelUI/`.
Direct `node server/index.mjs` execution is developer-only.

## Troubleshooting with a timed debug report

Choose **Diagnostics** in the application header to open a new tab, or open
`/debug` on the same instance. The public bootstrap presents the normal owner
claim/sign-in flow. **Instance-wide debugging** is off by default; enabling it
starts a fixed 30-minute capture of safe server/API and connected browser error
metadata. Closing the page does not stop or extend that window. Already-open
browser profiles normally discover it within the 5-second polling interval.

Reproduce the problem, stop capture if needed, and select **Download debug
report**. Known codes, request templates and bundled locations have explanations
and suggested next steps; raw errors, source values, private paths and credentials
are excluded. Nothing is uploaded automatically. The latest report remains in
memory after stop/expiry until cleared, replaced or lost on server restart.
Downloads during capture are snapshots; missing/offline browser errors cannot
be recovered retrospectively. See [Timed diagnostic capture](DIAGNOSTICS.md) for
the exact schema, limits, coverage and privacy contract.

---

## What it can access

The browser traverses only a directory explicitly selected by the user. The
Bicep configuration editor's source scope is:

- `.bicepparam` files.
- Bicep templates referenced by those parameter files for editor schema.
- APIM policy XML associated with an access contract.

Generated and unrelated directories are ignored. Generic `.azure` and `.env`
access is denied before any file handle is requested. The sole exception is a
dedicated browser-only bridge for `AZURE_SUBSCRIPTION_ID` in the exact
`.azure/<environmentName>/.env` selected by Main deployment syntax. It returns
and rewrites only that key; every other byte stays opaque and never leaves the
browser. The browser sends
only relative aliases, hashes, sizes, transaction metadata, and backup bytes to
source and transaction APIs. The Local path string is accepted only by the
registry metadata API; it is never used to open, read, or write a repository.

Capability signatures, not folder names, identify the guided areas below.

The **New GitHub Repo** setup path is a separate, explicitly requested full-repository
copy. It reads the checked-in snapshot of a GitHub source and writes only to the
new private repository created for that operation. It does not widen the
Bicep/XML editor's read/write scope or access any local source folder.

**Create local from Citadel source** is also a separate, explicitly confirmed
full-snapshot copy. The server only reads public GitHub data, pins one commit,
and verifies the complete bounded source; it receives no destination path or
directory handle. Only the browser writes the named child of the granted empty
parent, including ordinary licenses, dotfiles and binary assets. Existing
children are not adopted and detected conflicts are never overwritten.
File System Access cannot provide OS-level concurrent-write exclusion or an
atomic no-replace directory operation: keep the destination untouched.
Partial folders are retained for explicit retry or manual handling, not deleted.
Preparation and retry ownership are memory-only, unlike migration's durable
**Prepared sources**. Neither full-copy workflow changes the editor scope.

## Native Terraform workspaces

Native loading and saving are separate from **Export to Terraform**. One named
GitHub connection can serve both formats and different repositories or branches.
Local folders are not reusable connections: each attachment has one workspace
owner, with any selected native units inside that folder.

| Native area | Schema/configuration root | Explicit input selection |
| --- | --- | --- |
| Azure Deployment | Repository root | `environments/<name>.tfvars` |
| LLM Onboarding | `llm-backend-onboarding/` | A named `.tfvars` in that root |
| Access Contracts | `citadel-access-contracts/` | One or more named `.tfvars` units in that root |

Each chosen root requires `variables.tf` and `main.tf` with the supported
native signature. LLM and Access may stand alone; no Deployment or Bicep
prerequisite is imposed. A workspace can bind up to 24 units.

Explicit `.tfvars.json` is also supported. Examples and `.auto.tfvars` are not
edit targets. **Choose native root and value files** takes an **Area** and an
**Operator value file (repository-relative)**. Select **Add native unit** for
each file, then **Validate native inputs**. The nonsecret confirmation is
required; selecting inventory alone never grants write authority.

Missing or Git-ignored inputs require choosing another file, using Local for a
file present only on disk, or explicitly checking **Create an empty operator
file if absent; never copy examples or defaults**. Opening the unit creates
nothing. The first reviewed save writes your supplied values, not an example
or every schema default. JSON files still need the appropriate explicit
`-var-file` selection in your own Terraform workflow.

Profile/unit IDs, format, native root, value alias and syntax are versioned and
immutable. Select a new workspace for different bindings.
Legacy records without a descriptor keep their existing Bicep identity.

Only the selected nonsecret operator inputs are writable. Known root schemas,
bounded module dependencies and the conventional Access policy source are
read-only; inventory is not permission to read unselected value files.
State, plan, credential and `.terraform` files are excluded. The azd subscription
bridge is Bicep-only. Native policy changes use a service's literal `policy_xml`
in its owning input file; shared XML is inspectable but not edited.

Known-sensitive whole operator and dependency files are blocked before ordinary
read/review/save, backup and history exposure, including edits to unrelated fields. Empty/null
slots are preserved. The pinned source's exact public PII placeholder is
recognized only as a schema default, not as an allowed operator secret value.
Detection does not prove arbitrary files secret-free and does not encrypt or
remove source secrets. Hiding a UI value would not make its whole-file backup
safe. Supply secrets outside this editor.

For a changed existing Local file, Review/Save offers **Cancel** or **Back up and
overwrite**. Explicit overwrite backs up the current external version and
replaces it with the reviewed contents; a further change requires fresh consent.
Cancel retains the draft. Backup failure prevents writing. There is no watcher,
automatic reload, merge or rebase. GitHub keeps its exact-head, non-forced atomic
commit rules.

Local creation uses absence/content/mtime/dependency checks and an exclusive
writable stream where supported, not OS-level exclusion or atomic create-if-absent.
Keep the folder untouched during creation: simultaneous same-path creation
cannot always be distinguished. Detected collisions are refused. Unconfirmed
creations are not adopted or removed merely because their bytes match a plan.
Receipt uncertainty and foreign changes retain explicit History recovery, not
permission to adopt matching bytes. Confirmed creation can offer **Undo creation**;
unconfirmed creation cannot be completed while a file is present. See
[native creation recovery](BACKUP-RECOVERY.md#native-file-creation).

The [native walkthrough](../guides/using-the-control-plane.md#native-terraform-workspaces)
describes controls, draft isolation, limitations and the synthetic screenshots.
Inputs are source configuration, not effective runtime state. No Terraform,
provider, state, source script, APIM expression or cloud reference is executed.
Unevaluated validations and declared-but-unconsumed inputs remain advisory after
editing; actual type/value, secret, scope and staleness errors remain blocking.
The same Bicepparam controls use native names/types/defaults, not Bicep semantics.
Missing, explicit null and inherited defaults are distinct.

### Offline native parser

The browser/server use pinned Tree-sitter CST assets: `web-tree-sitter@0.25.10`
(MIT), `@tree-sitter-grammars/tree-sitter-hcl@1.2.0` (Apache-2.0) and
`tree-sitter-json@0.24.8` (MIT). Exact package integrity is retained in
`tools/native-parser/package-lock.json`; asset hashes, provenance and licenses
are under `shared/terraform/vendor/`. Published prebuilt WASM is copied
byte-for-byte, not compiled or fetched by the running application.
The app's `.gitattributes` keeps vendored bytes unchanged across Git checkouts,
including Windows line-ending settings.

For a development asset rebuild only:

```powershell
Set-Location .\tools\native-parser
npm ci --ignore-scripts
npm run build
```

Normal parser operation uses local assets, with no npm runtime or CDN.
Assets come from the existing app origin; WASM is served as `application/wasm`.
CSP uses `script-src 'self' 'wasm-unsafe-eval'` for these assets, without
JavaScript `unsafe-eval` or additional script/connect origins. Owner sign-in
and origin/transport restrictions still apply.

The supported editor grammar is bounded literal HCL/JSON, not Terraform
evaluation. Duplicate/error/missing nodes and unsupported expressions are
refused. Exact number lexemes, supported heredocs, Unicode offsets, CRLF/LF and
untouched source spans are preserved. Valid HCL integer-mantissa exponents
such as `2e30` are a selected-grammar limitation: the document stays read-only,
unchanged, without normalization or JavaScript rounding. Decimal-mantissa
exponents and explicit JSON exponents are supported.
Leading-zero numeric spellings are also an explicit read-only literal-reader
limitation, not silently normalized values.

Limits are 512 KiB per parsed source, 64 literal nesting levels, 32 nested schema
type levels, 100,000 CST nodes, a 300 ms parser cancellation deadline, 1,000
operations and 1,024 characters per exact number. A native dependency inventory
is bounded to 150 files / 4 MiB. Literal `contains` validations are interpreted;
other Terraform validations are marked unevaluated. BOM files, unsupported
types/default expressions and untyped absent inputs are not silently rewritten.

## Export to Terraform

**Tools > Export Terraform inputs**, under **Experimental**, opens the
desktop-only, saved-source export workflow in a Bicep workspace. Bicep and policy XML remain its authoring files; normal
review/save and migration are unchanged. Save or deliberately discard ordinary
drafts before entering. Across Deployment, LLM Onboarding and Access Contracts,
the export screen uses the same Bicepparam controls and groups to display the
proposed Terraform values: switches, selects, number/text fields, Foundry records,
backend/model cards and service/policy inspection. Target names and mapping
status sit at the corresponding field; differing saved values are noted locally.
Mapped controls are read-only, while explicit export-only inputs remain editable.

Choose included areas and exactly one saved parameter configuration per root.
XML and Bicep templates are not configuration choices. An empty source list is
distinguished from several available Access contracts; reopen export after
creating a new saved configuration. Supply explicit export-only values and
review service-specific defaults. Unresolved inputs,
unknown fields and active unsupported wiring block the included configuration;
there is no partial-settings override. **Review ZIP** shows the generated bytes;
**Approve & export ZIP** rechecks source/template/policy hashes and downloads only:

| Area | Target-relative file |
| --- | --- |
| Azure Deployment | `environments/<environmentName>.tfvars` |
| LLM Onboarding | `llm-backend-onboarding/terraform.tfvars` |
| Access Contracts | `citadel-access-contracts/terraform.tfvars` |

The mapping contract is `citadel-terraform-export-v1`, targeting
`Azure/terraform-ai-gateway-landing-zone` at
`b54f121b7df912da61cb0302a63b9f870841ac2c`. It uses a checked-in property/type
contract, not repeated upstream downloads. No Terraform executable, provider,
state, environment-variable lookup, credential recovery or repository write is
part of export. The ZIP is not a deployment or resource-identity guarantee.
It has no wrapper directory and only the produced files: no reports, XML extras,
modules or target repository. Source XML is embedded as `policy_xml`, preserving
APIM expressions/named-value references with Terraform template markers escaped.
Separate Access configurations are never merged; choose one configuration per
Access output file. Multiple services within that configuration remain supported.

The environment identity is 3-24 lowercase letters, numbers or hyphens, excluding
reserved device names. Invalid names are rejected, not renamed. Limits are three
files, 8 MiB per file, 24 MiB total and 64 source dependencies. Export choices
are memory-only and are never written back to Bicep or the workspace registry.

LLM mapping follows the first exact-case model occurrence in Bicep. The pinned
Terraform root looks only in backend zero, then falls back to
`apiVersion = "2024-02-15-preview"`, `timeout = 120` and an empty
`inferenceApiVersion`. A model first present in a later backend blocks export
when those effective values differ; absent/default-equivalent metadata can
export. Later duplicate occurrences cannot override the first model's metadata.
Active session-aware routing and other unsupported target wiring remain blockers,
not editable runtime features of export.

See the [export walkthrough](../guides/using-the-control-plane.md#export-to-terraform)
for the review/download procedure.

## Migrate Citadel Configuration

Open the **current Bicep destination workspace** first, then choose
**Tools > Migrate configuration**, under **Experimental**. Migration is separate from workspace attachment: an older
donor does not have to pass the current Citadel compatibility signatures and
never becomes an editable workspace.

**Migration preview (Experimental)** uses the normal workspace shell, area rail, parameter
sections, typed fields, object tables and backend/model forms. It has its own
review/apply/export actions, not the editor's save or subscription bridge.
For a short walkthrough, see the
[operator guide](../guides/using-the-control-plane.md#migrate-citadel-configuration).

1. Choose a separate donor folder with **read-only** browser permission,
   explicitly select parameter files, or choose a GitHub donor using anonymous
   public access, a source PAT, or a saved connection. Local files are the files
   currently checked out on disk; local branch switching and access to
   unchecked-out branches are not supported. No host path is opened by the server
   or mounted into Docker. GitHub donors instead use an explicitly selected branch, tag or full
   commit SHA, as described below.
2. Prepare the old source once into a private, immutable application copy covering
   **Deployments**, **LLM Onboarding** and **Access Contracts**. A complete copy
   survives restart and loss of original access. Only explicit **Refresh old source**
   reacquires it; failed refresh keeps the existing copy and drafts.
   Navigate freely between areas. Every target, including multiple Access
   instances, keeps its own source selection, model choices, filters and preview.
   Select source configuration and explicitly choose **one current
   destination `.bicepparam` file**. No filename-based pairing or automatic merge
   occurs. Loose selected files without a recognizable layout/signature require
   an explicit area choice. **Other old parameter files** allows explicit selection
   of parsed, unfamiliar old layouts by matching the actual new-file names.
3. Check only values to import into parameters already assigned in the NEW file.
   The current schema validates values; it does not add editable targets.
   Matching uses exact, case-insensitive Bicep identifiers and preserves new spelling.
   The primary view is the complete projected target form. Only changed selected
   values are highlighted **Selected import - not saved**, with current/source
   values, file/backend/model provenance and **Undo import**. Equal and
   unselected fields have no import highlight. **Match source values** opens
   secondary matching controls for competing assignments and backend pairing.
   Matching starts with **Differences and unresolved matches**. Name search
   filters as you type without losing focus or text selection. Reopening
   matching, including from Review, preserves the search and chosen worklist;
   a field-specific action can reveal the relevant row.
   Expressions are not presented as runtime values. Edited matching rows stay
   visible until a new search, a worklist change or **Refresh view** reapplies
   the filter.
   Unchecking or undoing restores the current value. Discard is scoped to the named
   target; source replacement and exit protect pending choices in every target.
4. **Review migration** records the intent to import selected values and keep all
   others unchanged. The summary distinguishes changes, kept/already-same values,
   and items not imported. No-op previews say **Nothing will change** without an
   empty diff. Remote destinations offer **Export migration** only. Local **Apply
   selected values** requires confirmation and the validation/freshness safeguards.
   Downloaded sanitized drafts remain manual handoffs, not deployment-ready files.
   **Review another file** starts another explicit pairing without closing the
   wizard. Earlier per-file name reports remain visible and downloadable,
   including after an apply, until the wizard closes. These historical reports
   contain names, provenance, and statuses, not parameter values or reusable
   write plans.

`llmBackendConfig` uses backend/model review instead of whole-array acceptance.
Explicitly confirm `new backend <- old backend`, then select model fields within
that pair. Only exact model identities in the paired backend are compared;
FLUX routing paths, provider/version/format differences and duplicate identities
remain visible. Backend prefixes, array positions, pools and catalogue names are
not identity substitutions. New backend identity, endpoint/auth/routing settings,
new-only models/order and unselected fields are preserved. Unknown old items are
reported and excluded by the explicit keep-rest intent; no backends/models are
automatically added or removed. Sensitive or unresolved arrays remain withheld.

| Area | Existing current target |
| --- | --- |
| Deployments | `bicep/infra/main.bicepparam` |
| LLM Onboarding | `bicep/infra/llm-backend-onboarding/main.bicepparam` |
| Access Contracts | An explicitly selected existing contract instance underneath a `citadel-access-contracts` root |

Access root/base templates, upgrade and publish-contract files, validation/sample
fixtures, and `modules` and `policies` subtrees are not migration
targets. Similar names never select another contract automatically. Parameter
migration does not clone contracts, copy policy XML, or evaluate
`loadTextContent` references. Other infrastructure parameter files do not appear
in the migration inventory.

The destination workspace, project, folder/repository, actual GitHub branch
where supported, selected file and template are shown in the wizard. Browser
handle identity and containment checks reject the same folder under another
label, the same file through aliases, overlapping selections, and selections
whose distinctness cannot be demonstrated.

### Public GitHub donors: no PAT required

In **Source**, choose **GitHub repository**, then set **GitHub access** to
**Public repository (anonymous)**.
Enter a repository root URL such as `https://github.com/owner/repo`, or
`owner/repo`. Anonymous access supports only public repositories on **github.com**; private
repositories, GitHub Enterprise, arbitrary hosts, credential-bearing URLs, and
file/tree URLs are not accepted.

**Find repository** confirms repository access and loads its actual branches into
the **Source branch** dropdown. Listing uses at most five pages of 100 branches;
the UI reports the limit rather than pretending a partial list is complete.
Choose a branch explicitly, including slash-containing names. **Refresh branches**
or **Retry branches** reloads the list. The default branch is metadata only and is
never selected automatically. Changing repository, access mode, or ref type
clears the old ref selection.

**Tag** and **Full commit SHA** remain manually entered, explicit refs. After
choosing the ref, use **Prepare source and continue** beside the revision fields.
Repository lookup loads branches only; this second action captures the offline
copy and advances to configuration selection without changing the target.
The pinned source records the
immutable repository ID.
Lightweight and annotated tags are supported, with bounded tag
resolution. Select the donor parameter files from the resulting pinned tree.

For the supplied older sample, enter
`https://github.com/mohamedsaif/ai-hub-gateway-solution-accelerator` as the
repository root and choose the full commit
`9ef37ad75a47ca89c179a0db5a4123e60c4c720e`, the supplied snapshot of upstream
`main`. The application itself remains repository-agnostic. This pins the
selected older main revision; it does not switch to `citadel-v1` or automatically
follow the repository default branch. A `/tree/main` URL is not
accepted as a repository-root URL; use the root plus an explicit `main` ref,
or use the full commit above to remain pinned. Invalid input never falls back
to a different branch.

The wizard and report identify the public repository, ref kind/name, ref-object
SHA, pinned commit/tree and each selected file/template fingerprint.
Acquisition checks repository/ref identity and public visibility. A complete
prepared source then depends on its stored integrity, not continued public
access or an unchanged upstream branch. Only explicit refresh reacquires source;
failed refresh preserves the old copy and drafts. Current destination identity,
source/template hashes and branch context remain checked before applying.
Identical remote source/destination snapshots, even selected through different
ref names, are refused.

The browser uses an owner-gated, same-origin **GET-only** public-donor endpoint.
It reuses the app's fixed `api.github.com` transport with **no Authorization
header, PAT, saved GitHub session, cookie or credential fallback**. The normal
owner sign-in is still required; public access does not make the UI server an
open proxy. CSP remains `connect-src 'self'`; redirects and caller-supplied API
paths/hosts are refused. GitHub setup, editable provider scope and authentication
for already-selected destinations are unchanged.

Public and authenticated donors support `.bicepparam`, their relative `.bicep`
templates, and strict ARM deployment-parameters JSON. Automatic repository
discovery inspects JSON through a metadata-only classification route: ordinary
repository JSON does not become a parameter candidate or abort the scan.
Known module/policy/sample and usage-processing/reporting trees are excluded
before blob reads to preserve the anonymous request budget; other relocated
parameter JSON can still be recognized from its parameter signature.
Malformed parameter candidates are reported, and read/access failures still
stop discovery. Explicit JSON reads retain the strict envelope adapter;
arbitrary JSON is never returned as parameter values or imported.
The normal hidden/generated exclusions apply. Symlinks, submodules,
Git LFS pointers and oversized sources cannot supply values.

Additional public-read limits:

- A complete recursive tree is required: no truncated listing is interpreted as
  missing fields/templates, and no quota-heavy recursive fallback is attempted.
- At most 100,000 raw tree entries, a 24 MiB tree response, and 2,000 scoped
  file/exclusion entries. The ordinary per-file/plan limits below still apply.
- Acquisition readers keep up to eight temporary metadata selections for 30
  minutes. These are distinct from completed, durable prepared sources.
- Prepared sources use owner-only application storage: up to 8 copies, 256 MiB
  total, and 64 MiB / 256 files per copy. A staged or corrupt copy is never used
  as a complete source. Retention/deletion is explicit; active copies are not evicted.
- GitHub's anonymous quota applies during acquisition and explicit refresh,
  not subsequent mapping, navigation, preview or export. Rate-limit and read errors
  stop the operation explicitly; they never produce an empty successful mapping
  or prompt for a PAT solely to read a public donor.

This option is a **source only**. GitHub destinations remain preview/local-export
only, and applying public donor values to a local target still requires the
normal reviewed backup/authorization/rollback transaction.

### Private GitHub donors and source connections

Private repositories are supported through an explicitly selected fine-grained
source PAT or an existing GitHub connection. The token needs **Contents: Read**
for the selected repository; Metadata Read is automatic. Push, Contents Write,
administration, repository creation, and all-repository access are not required.
The existing classic-token policy is unchanged.

Under **GitHub access**, choose **Personal access token** and **Connect source**,
or select **Saved GitHub connection**, choose the profile, and use **Use source
connection**. Once connected, select the repository and an explicit ref, then
choose **Prepare source and continue**. **Token help** explains the read-only permissions
and links to GitHub's fine-grained token creation page.

Source credential sessions are separate from editable-workspace sessions.
Selecting a saved connection borrows its live or already encrypted credential
into a new source-only session. It never calls the ordinary reconnect/resume
operations that can revoke a destination session, changes the destination
connection, or replaces the saved credential.

A pasted source PAT is session-only. The UI clears it immediately after starting
submission and on every exit; it is not placed in URLs, reports, browser storage,
registry metadata, or logs. Existing encrypted persistence remains an explicit
Settings opt-in, not an implicit side effect of migration. The browser retains
only an opaque source session in memory. Source disconnect revokes only that
session and is retryable if erasure cannot be confirmed. A bounded cancellation
capability also cleans up late or lost login responses without needing to learn
a lost server-generated session ID.

All authenticated GitHub egress is fixed-host GET-only, including identification,
metadata, refs, trees, and selected blobs. Source authentication is carried in
the separate owner-gated `/api/github/migration-source` flow, never through the
destination's GitHub session manager. Missing, expired, wrong-account,
insufficient-access, rate-limited, and changed source contexts stop the operation
explicitly; none silently falls back to anonymous access or another credential.

Authenticated acquisition sessions inherit the existing 30-minute idle and
8-hour absolute bounds. A COMPLETE private source copy no longer depends on that
session or upstream authorization. Owner sign-in is required after app restart;
reconnecting the source PAT is not. Changing acquisition credentials does not
erase prepared copies or target drafts. Revoking upstream access cannot revoke
already-downloaded data: the owner must explicitly delete a retained copy.

### Supported inputs and conservative validation

- **Donor folders:** bounded `.bicepparam` or strict ARM parameter JSON inputs and
  referenced `.bicep` templates. Normal hidden/generated exclusions remain in force,
  including `.git`, `.azure`, `.env`, and `CitadelUI`. There is no subscription
  environment bridge for donors.
- **Explicit files:** `.bicepparam`, optionally selected sibling `.bicep`
  templates for donor secure metadata, and standard ARM
  `deploymentParameters.json` envelopes with `$schema`, `contentVersion` and
  `parameters[name].value`. Arbitrary JSON is rejected. JSON duplicate
  parameter keys become ambiguous candidates; duplicate envelope keys are
  rejected, and duplicate nested/value keys cannot be copied. Key Vault
  `reference` envelopes and ARM expressions remain unresolved.
  Unsupported control characters or unpaired Unicode surrogates in object keys
  are rejected as well as in values, including at nested levels; valid Unicode
  keys retain their exact encoding through the migration edit.
  Ambiguous selected donor templates and unreadable existing donor templates
  block planning rather than silently losing their secure metadata.
  Safe bounded ARM labels may contain periods even though current Bicep
  identifiers cannot. Such old-only labels are report metadata only, never
  aliases or generated declarations. A supplied but malformed donor schema
  leaves its candidates unsupported, not implicitly nonsecret.
- **Bicep values:** literals (strings, safe integers, booleans, arrays and
  objects). Calls, identifiers and interpolation, including inside collections,
  are never evaluated or copied, not even environment-variable fallbacks.
  Bicep inheritance, variables/imports in parameter files, scripts and syntax
  outside the bounded parameter grammar are not imported. Targets must also
  be understood by the existing surgical editor parser.
- **Current schema:** primitive parameter types, literal `@allowed` for scalar
  types, `@minLength`/`@maxLength` and `@minValue`/`@maxValue` where applicable,
  `@secure`, descriptions and literal defaults. Unions, nullable/typed arrays,
  user-defined or inline nested types, unknown decorators and dynamic
  constraints remain **unknown schema**, not compatibility proof.
  Bare `object`/`array` types have outer-type and supported decorator checks,
  plus available current Citadel feature/LLM validation; their nested semantics
  still require operator review. Metadata prose is guidance, not a nested type
  specification. Collection proposals are labelled semantic review, not full
  compatibility. Current LLM field definitions also check intrinsic field types,
  required fields and numeric bounds before allowing a replacement.
- **Limits:** UTF-8, 8 MiB per file, 16 MiB per plan including selected templates,
  at most 16 selected donor files, 1,000 parameters per file, and bounded
  tokens/nesting. No environment file, script or expression evaluation occurs.

The report distinguishes **compatible exact-name proposals**, **current fields
without donor assignments**, **removed/unrecognized donor fields**, **type/current-constraint
mismatches**, **ambiguous candidates**, **dynamic expressions/references**,
**feature/semantic review**, **unknown schema**, and **sensitive values**.
Even a same-name, same-type value requires semantic review. Unsafe replacements
cannot be accepted. Unreviewed candidate decisions, duplicate destination
declarations, invalid selected values and unavailable dependencies needed for
the selected change block local apply. Unrelated retained expressions/findings
are reported as unverified deployment readiness, not mistaken for missing data
or used to block an independent safe patch. No fallback is silently evaluated.
Removed donor fields do not block safe unrelated changes.
An explicitly allowed empty string remains valid when the current schema permits
it; that does not disable other constraints or the checks for unresolved required
values. Names in the current schema but omitted from the new parameter file are
not import targets and are never added. Missing required current-template
assignments remain a separate retained-destination check to address outside import.

### Privacy, freshness, and local apply

Migration decisions remain in the browser session, separate from editor drafts.
Supported configuration and referenced templates are copied through bounded,
owner-authenticated binary APIs into private `CITADEL_DATA_ROOT/migration-sources`
storage (0700 directories, 0600 files on supporting filesystems). A hashed
manifest records provenance and completeness; reads verify stored bytes without
original-source fallback. Raw configuration/comments are sensitive application
data, not guaranteed credential-free or encrypted by this feature. Connection
PATs, capability/session tokens, headers, `.env`, unrelated files and internal
candidate objects are never deliberately persisted in these copies or logs.
Local separation is proven before capture; the browser retains only the checked
target handle as an identity proof, not original-source handles. A different
target folder or lost browser proof requires explicit reacquisition.
Sensitive
names, `@secure` fields, nested credential material, credential-shaped strings
and credential-bearing URLs are withheld and cannot be copied. This conservative
screen can flag nonsecret values; it is not a guarantee of discovering secrets
hidden under arbitrary innocuous names. Do not select unreviewed private data.
Configure safe environment/Key Vault references outside migration; the
destination's existing placeholders/defaults are not replaced with plaintext
donor secrets.

The displayed diff is a **sanitized value projection**, not raw donor text or
destination comments. The downloadable `.bicepparam` draft is likewise a manual
handoff: it omits comments and sensitive/dynamic values, identifies omitted
fields, and retains inherited defaults rather than manufacturing overrides.
It is **not deployment-ready** and is not the byte stream used for local apply.
Old-only fields expose their names, provenance, categories, and value types,
never their unused values, even when those values do not match a sensitive-data
heuristic.

Local apply uses the existing `LocalTransactionCoordinator` and verified
prepare/backup/authorize/hash-check/write/receipt protocol, with normal
rollback and **Settings > History** undo/recovery. Only selected AST value edits
to existing parameters are written. Structured model choices use nested set or
explicit optional-property edits, never a replacement old backend array.
Original `using`, comments, unrelated structure, retained expressions and
unaccepted new defaults are preserved. As with a normal editor save, authorized
destination backup bytes go to transaction storage. Prepared source bytes live
in the separate immutable source store, never as destination transaction data.

Source/destination/provider/workspace/project identities, all selected parameter
and template fingerprints, and remote branch/head context bind every preview.
GitHub source identity also includes the immutable repository ID, selected
ref/ref-object SHA, pinned commit, tree and Git blob identities.
Original sources are read only during capture/explicit refresh. Thereafter,
source checks concern the stored copy's integrity. Current targets and templates
are still re-read before export/apply and at transaction boundaries. Target
failures revoke that preview's write authority while preserving its choices,
the old source and other target drafts. A changed target must be replanned.
Workspace changes
during asynchronous work cannot retarget a write. Repeated apply clicks share
one transaction. Existing pending editor work and a saved draft for the target
block migration rather than being overwritten.

**GitHub destinations are always preview/local-export-only in this wizard**,
even when normal editing has push permission. Migration never creates a remote
commit, switches a branch, runs a deployment, executes an upgrade command, or
infers resource-output handoffs between the supporting-services and APIM
upgrade templates.

### What has and has not been validated

Zero-dependency tests use synthetic legacy/current inputs, in-memory browser
handles, the real dialog wiring, and the existing local transaction protocol.
They exercise real upgrade-target discovery and synthetic population without
editing accelerator product data. Native OS folder/file pickers are not
automated by these tests.
Public donor tests use mocked GitHub API responses and an isolated HTTP server
to exercise owner/CSP/transport boundaries, anonymous headers, branch/tag/commit
pinning, rate/read errors, stale protection and the same mapping/local transaction
flow. No live or private GitHub repository was fetched for those tests.

Authenticated-source cases exercise the real source connection controller and
routes with synthetic GitHub responses, including Contents-read-only access,
saved-profile isolation, expiry, interrupted login cleanup, and local apply.
Desktop and mobile browser exercises use the original app styles and synthetic
files. They do not claim access to a user's private repository or token.

Historical parser-only evidence for the public upstream `main` sample is pinned to
`9ef37ad75a47ca89c179a0db5a4123e60c4c720e`. The five same-path file pairs contain
97 Deployment, 39 APIM Upgrade, 44 Supporting Services Upgrade, 8 LLM Onboarding,
and 17 Access root-template name matches: 205 per-file occurrences, not a merged
global name set. All five actual old-only lists are empty. The current-only
Deployment assignment `logicAppsSkuName` keeps its default; the current
`logicAppsSkuCapacityUnits` constraints must still be enforced.
The upgrade and root-template pairs remain parser fixtures, not selectable
configuration in the three-area migration workflow.

That sample has no standalone Access Contract instances. Its Deployment file
has 93 expression-containing assignments out of 97; these are not resolved
deployed environment values and are never executed. Sanitized name evidence is
kept in `test/migration-real-main-evidence.json`; synthetic nonidentical values,
removed names, and explicitly separate instances exercise actual edit behavior
without storing the public settings as fixtures. Name matches do not mean
accepted or copied values: accepted values already current generate no edits.

Legacy authentication/model shape changes, feature behavior changes, resource
IDs/output translations, service dependencies, and deployment correctness are
not certified by this sample. Current specialized LLM and Access checks are
reused, but unsupported nested transformations and unresolved feature
dependencies remain explicit. This is a reviewed, parameter-only migration
workflow, not a claim of semantic compatibility with a release.

## GitHub repositories

An environment can be a selected local folder or a GitHub repository. Both are
reached the same way: from **Saved workspaces** on the landing page, or through
**Add workspace** for a new one.

Choose **Existing GitHub Repo** for the current repository picker, **New GitHub Repo** to
initialize a private repository first, or **Local** for the existing folder flow.
New GitHub Repo discovers organization memberships and owners of readable
repositories, defaults to a discovered
Organization, and offers an explicit Personal/Organization owner choice. Handles
and numeric owner IDs distinguish alike display names. Access-policy failures
are visible; missing discovery rights do not imply that no organizations exist.
The source defaults to upstream `citadel-v1`; a complete fresh snapshot is created
on `main` in the selected owner. It then rejoins the normal repository,
explicit branch, details and attachment-review flow.

New GitHub Repo uses a temporary creation token scoped to the selected resource
owner with All repositories access,
Administration read/write and Contents read/write; Metadata read-only is
automatic. Workflows read/write is needed only for sources containing workflow
files, whose Actions are disabled before import and left disabled for review.
Read-only repository access can discover an organization even if the membership
list omits it. Explicit handle lookup can discover its profile without claiming
membership. Creation still requires active membership, checked with Members read
access; visibility never grants write permission.
The owner type and handle are shown beside policy/access status at each
decision point; a readable membership is not a guarantee that creation will pass.
The wizard groups connection identity, repository destination and source snapshot
separately. **Token help** opens a compact overlay; closing it or pressing Escape
returns to the same form without clearing credentials or other inputs.
Regular Existing GitHub Repo editing still needs only selected-repository Contents
read/write. Narrow or replace the creation token after setup.

Creation is private-only and refuses name collisions. Source preflight is
read-only; repository creation needs its own explicit confirmation. A non-`main`
bootstrap branch is renamed after the snapshot is published, never deleted.
Paused or interrupted operations retain any private repository already created;
the operation journal stores resumable metadata, never credentials or copied
file contents. **Previous setup
attempts** resumes the same operation after reconnecting the same account. See
[the creation guide](../guides/using-the-control-plane.md#create-a-new-private-github-repository)
for supported file modes, source-size limits and recovery behavior.

Progress shows owner/access, source reads, creation, copy and verification
separately. A timeout uses bounded retries for the same GET, not a new create
request. Safe error details identify the blocked action, selected owner and
GitHub HTTP status. The confirmed source cache is reused where possible instead
of downloading every file again for compatibility checks or transient-read
recovery; write ambiguity remains a same-attempt reconciliation state.

### Saved workspaces

The landing page is a catalogue, not a form. Every workspace you have attached is
listed with its source, repository or folder, branch, connection, detected
capabilities, status and when it was last opened, and each row opens in one
click. The list is searchable and filterable by source and status; only the
search text, filters and sort order are remembered, never the list itself.

The status and primary action describe the current opening or recovery need:

| Status | Meaning |
| --- | --- |
| Ready | Openable now. |
| Reconnect | Restore the named connection or retained folder permission first; the row names the required action. |
| Missing | Its folder handle, or the connection it was attached through, is gone. |
| Incompatible | The last validation found it is not a Citadel workspace. |
| Stale | Attached but never validated or scanned. |
| Unavailable | Source validation or access could not be completed; use the reported retry/recovery action. |
| Confirmation pending | Reattachment still needs confirmation or revalidation. Staged metadata is not permission to open. |

More specific labels, such as **Folder permission needed** or **Missing
connection**, explain the same recovery state. **Actions** holds secondary
workspace operations. Keep the original record when recovering; a native lost
handle cannot be repaired by transferring its identity to a different folder.

**Detach** removes Citadel's record of a workspace from this device. It never
deletes a branch, a commit or a file.

### GitHub connections

A connection is one GitHub account, under a name you choose. It can serve both
Bicep and Terraform workspaces and multiple repositories/branches. Each workspace
records its connection, repository and actual write branch independently.
A second credential does not bypass native file ownership on the same
repository/working branch.

Connections are managed in their own section, which shows the account, status,
when it was last connected, and the repository-and-branch workspaces it reaches.

1. Give the connection a **name**. The token field stays closed until you do: a
   nameless connection cannot be told apart later, and the name cannot be added
   afterwards without pasting the token again.
2. Paste a **fine-grained personal access token** scoped to only the intended
   repositories, with `Contents: Read and write` (and `Metadata: Read-only`,
   which GitHub adds automatically). Classic tokens are refused, and no Pull
   requests permission is needed — Citadel only opens a compare URL that
   github.com's own session authorises.
3. Citadel UI validates it, keeps it **only in server memory** unless you ask
   otherwise, and hands the browser an opaque session id. The token is never
   returned to the browser, and never written to a log, an audit record, the
   registry, or the activity log.

Reconnecting a connection requires a token for the **same GitHub account**. A
token for a different account is refused and you are offered a separate
connection instead — rebinding would silently point every workspace under that
connection at repositories you did not choose. Removing a connection deletes its
saved credential on the Citadel server; it revokes no token and deletes no branch, and
the workspaces that used it stay listed as **Reconnect**.

In **Settings > GitHub repository**, **How to create this token** opens stacked
help. **Close** and **Escape** return to the same unfinished form and help opener,
preserving the source choice, environment label and connection name. Help does
not submit the form or change credential persistence.

### Saving a connection on the server (optional)

One checkbox: **Save this connection on the Citadel server (encrypted)**,
unticked for a new connection. There is no passphrase, no unlock screen and no
key-rotation ceremony.

- **Unticked** - the credential lives only in server memory and is cleared on
  restart or disconnect. A restart requires reconnecting.
- **Ticked** - the credential is saved encrypted on this server and can be
  restored after restart. The token is never returned to the browser.

Saving requires a usable credential key: a mounted key file locally or the
configured Key Vault key on Azure. Without one, the checkbox explains why it is
disabled; session-only connections still work. While availability is unknown it
stays disabled, and lookup failures are visible. The storage description reflects
the selected connection's actual mode, not merely a previously requested option.
See **Encrypted credential persistence** in `SECURITY.md`.

### Attaching a repository

**Add workspace** is a guided sequence, because the decisions depend on each
other: source, then connection, then repository, then branch, then names, then
review.

1. Pick a repository from the list the credential can actually reach. You never
   type an owner/repository path.
2. Pick a branch. **No branch is chosen for you**: the branch decides which tree
   Citadel edits, so it has to be selected.
3. Citadel checks the selected format: Bicep uses the required Citadel
   capabilities; Terraform validates explicitly selected native roots/value
   files. **Attach stays disabled until that check passes**. The server repeats
   the format-specific check against the exact branch head before attachment
   can create its working branch or registry record.
4. Citadel UI creates or reuses the working branch `citadel-ui/<environment-id>`
   from the branch you chose, and every save commits there. Direct writes to the
   selected branch are an explicit opt-in.

Bicep attachment offers an existing workspace for the same repository/source
branch/connection in one project. Native units also enforce exclusive ownership
of writable files on the actual working branch across connections and projects.
Workspace names are unique inside their project.

### Workspace activity

Connection, attachment, validation and workspace-open events are recorded in a
bounded, redacted log under `/data/settings/activity.json` and shown in **Recent
activity** on the landing page. It holds an action, an outcome, an optional
reason from a fixed list, and the names you chose. It has no free-text field, so
it can never contain a token, a session id, a path, a parameter value, or file
contents. Git commit **History** is separate and unchanged.

Every Citadel operation is exactly one Git commit built from one tree:

| Operation | Result |
| --- | --- |
| Parameter save | one commit |
| Policy save | one commit |
| Environment copy | one commit |
| Contract creation | one commit containing both files |
| History undo | one inverse commit |

Refs are updated with `force: false`. If the branch moved after you loaded or
reviewed a file, the save is rejected, your edits stay intact, and the branch is
untouched. Nothing is ever reset, rebased, or force-pushed, and undo appends an
inverse commit instead of rewriting history. Commits carry `Citadel-Action`,
`Citadel-Environment`, and `Citadel-Transaction` trailers, and no values or file
contents.

Protected branches surface as an ordinary permission error with a link to open a
pull request from the working branch. Symlinks, submodules, Git LFS pointers,
oversized blobs, and unsupported file modes are refused rather than edited. The
container talks only to `https://api.github.com`, accepts no API base URL from
the user, and never follows a redirect.

GitHub credentials not saved with server-side encryption are cleared when the
container restarts, so those workspaces stay listed and show **Reconnect** until
a new session is established. A connection saved with the encrypted option is
restored by the server on the next start, with no user step.

**Create PR** opens GitHub's comparison page; it does not itself create a pull
request. **View PR** is used when an existing pull-request URL is known.
Always distinguish the original source branch from the actual working branch
shown as the write destination.

### When an attach loses its answer

Attaching runs six named steps — revalidating the branch, reserving the
attachment, creating or recovering the working branch, saving workspace
metadata, opening the workspace, ready — and the review screen shows which one is
running.

If the answer to the attach is lost in transport (a gateway error, a timeout, a
dropped connection), Citadel UI does **not** report a failure. The branch may
already exist. It reconciles instead: it asks the server what became of that
exact operation, and if the server has no record it replays the same request with
the same operation key, which the server answers from its original reservation.
Either way the result is one working branch and one workspace.

Only a definite rejection — an archived repository, no push access, a branch that
moved — abandons the attempt. If it still cannot be confirmed, the screen says
**GitHub may have completed this step; checking…** and offers a retry that
resumes the same attempt rather than starting a new one; the attempt survives a
reload. A failure while saving workspace metadata says so, and resumes at
metadata rather than re-creating the branch.

If a save's branch update fails in transport, Citadel UI asks GitHub what
actually happened rather than guessing. A commit that is the branch head or an
ancestor of it is reported as applied; a branch that is readable and provably
does not contain the commit is a real failure you can retry; and a branch that
cannot be read either is reported as **indeterminate**, with the commit SHA and
an instruction to reload rather than retry — because a blind retry would
duplicate a commit that had already landed.

### 1. Main deployment

These three area sections describe Bicep/Citadel. For native inputs, use
[Native Terraform workspaces](#native-terraform-workspaces).

The workspace chooser, **Diagnostics** and **Settings** are in the global
header. The contextual command bar keeps the owning document, source and write
destination alongside **History**, **Tools**, **Discard** and a stable
**Review & save** action. The explorer selects an area/file; the document strip
shows its full source path, **Parameters** / **Raw file** modes and category
tabs. Draft prompts name the document whose work needs attention.

`bicep/infra/main.bicepparam` configures the core gateway infrastructure:
naming, networking, API Management, observability and optional capabilities.

Sections come from the file itself. The authors already separate the file with
`====` banner comments and mark each block `REQUIRED:` or `OPTIONAL:`; the UI
reads those banners and turns them into sections, explanations, and badges. The
documentation you see is the documentation that is in the file — nothing is
duplicated into the UI, so it cannot drift.

For operation, every top-level boolean capability/mode control is presented once
under **Feature Flags**, grouped as Gateway APIs, Data/Safety/Governance,
Identity/Observability, or Network Topology. This is presentation only; the
`.bicepparam` order is unchanged. A disabled capability hides only inputs proven
exclusive to it by the Bicep module graph. Bidirectional choices such as existing
versus new VNet/Log Analytics and APIM classic versus v2 show the matching input
set, while shared settings and unsaved dependent edits remain visible.

New-VNet address fields are checked when the user leaves a control. The editor
shows field-level errors for malformed or noncanonical IPv4 CIDRs, Azure-
prohibited ranges, subnets outside the VNet, overlapping deployed subnets,
unsupported prefix sizes, and insufficient service/private-endpoint capacity.
Unused agent-subnet conflicts remain warnings until Microsoft.App network
injection is enabled. These checks follow Azure's
[IP planning](https://learn.microsoft.com/azure/networking/design-guide/ip-planning),
[VNet](https://learn.microsoft.com/azure/virtual-network/virtual-networks-faq),
[API Management](https://learn.microsoft.com/azure/api-management/virtual-network-injection-resources),
[Functions/App Service](https://learn.microsoft.com/azure/azure-functions/functions-networking-options),
and [Microsoft.App](https://learn.microsoft.com/azure/container-apps/custom-virtual-networks)
guidance.

### Literal Bicep resource tags

The top-level Bicep `tags` parameter has a key/value editor when its value is a
literal object, including `{}`. Existing keys and values come from the source.
There are no required/default `Owner` or `Purpose` entries; those remain valid
arbitrary names if explicitly chosen by the user.

Edit a value in its row. To add an entry, enter **Tag name** and **Tag value**,
then choose **Add tag** or press Enter in either new-entry field. Typing alone
retains an unfinished input, not a property addition; review cannot save it
until it is staged or both new-entry inputs are cleared. **Remove** stages
removal of that key. Rename by removing the old key and adding the new one.
Removing the last entry leaves an empty object rather than deleting `tags`.

Blank/whitespace-only names and exact duplicate names produce visible errors
without an addition. Valid spelling and case are preserved; empty string values
are allowed. The editor reserves `__proto__`, `__expr`, `__args` and `__tfNumber`
for its value/path representation. These are editor constraints, not Azure
tagging policy. Provider-specific tag rules are not validated or deployed here.

Use ordinary **Review & save**, inspect the exact file/diff, then **Save
changes**. Reload reads the saved entries. To undo a completed modification,
use **History > Restore prior**, then confirm **Back up and restore**; current
source and ownership must still permit the restore. Local restore is a new
verified transaction; GitHub restore appends an inverse commit.

This is not a whole-object expression evaluator, a generic object-key editor,
or the native Terraform map workflow. Existing expression-valued entries keep
their supported syntax controls; adding a neighboring key does not normalize
untouched expressions, comments or number spellings. Whole-object expressions
do not gain literal tag add/remove controls. Export's mapped source controls
remain read-only. See the [tag walkthrough](../guides/using-the-control-plane.md#resource-tags).

### 2. LLM onboarding

`bicep/infra/llm-backend-onboarding/main.bicepparam` — registers model providers
onto the gateway.

`llmBackendConfig` is an untyped array in Bicep, which means the compiler cannot
help you and neither can a generic form. This parameter gets a purpose-built
editor instead:

- **Provider picker** covering all ten supported backend types — Azure AI
  Foundry, Azure OpenAI, AWS Bedrock (native and Mantle), Gemini (native and
  OpenAI-compatible), Anthropic, Azure FLUX, Azure MAI, and generic external
  endpoints — grouped by vendor and described in place.
- **Credential handling that follows the provider.** Each backend type has a
  default authentication mode; the editor shows the derived default, lets you
  override it, and only asks for a named value or Key Vault URI when the chosen
  mode actually needs one. Plain-text secrets are flagged.
- **Model catalogue.** Adding a model offers the models known to work with that
  provider, pre-filled with the right format, version, SKU and API version — and
  still accepts any model id you type, because the catalogue is a shortcut, not
  a cage.
- **Validation the compiler cannot do**: duplicate backend ids, missing required
  fields, a FLUX model without its `modelPath`, out-of-range priorities and
  weights, and provider-specific parameters you have not set yet.
- **Routing preview.** A backend pool is only created when two or more backends
  of the same provider serve the same model. The preview replicates that rule so
  you can see which models will be load-balanced, which will route directly, and
  which will get sticky sessions — before you deploy.

### 3. Access contracts

`bicep/infra/citadel-access-contracts/` — one folder per contract.

Each contract has a `.bicepparam` and may own APIM policy XML. A contract using
the shared default reports that status, not an independently owned policy file.
New contracts are created from the fixed template pair at the module root:

- `citadel-access-contracts/main.bicepparam`
- `citadel-access-contracts/policies/default-ai-product-policy.xml`

---

## Verified saves, backup, and recovery

Local parameter/policy edits, creation, copies and restores use the journaled
backup-before-write protocol. GitHub instead uses its atomic commit protocol;
it does not copy source backups into `/data`.

1. The browser reads and hashes every current target.
2. The container creates a journal under `/data`.
3. Existing-file bytes are stored and hash-verified under `/data` before writing.
   If the operator confirmed **Back up and overwrite**, these are the current
   external bytes, not the stale version originally loaded.
4. The browser re-reads each target to detect external edits, writes through its
   retained directory handle, and verifies final SHA-256 hashes.
5. The container accepts a final receipt and appends a redacted hash-chained
   audit event.
6. A recoverable failure attempts rollback of attributable writes. Unknown
   ownership, foreign changes or uncertain receipts retain explicit recovery
   instead of overwriting or deleting an unrecognized file.

The subscription-only azd environment bridge is intentionally outside this
backup protocol: `.env` may contain unrelated sensitive values, so its bytes
never leave the browser. The browser uses the File System Access API's atomic
writable, rejects stale whole-file hashes, replaces only
`AZURE_SUBSCRIPTION_ID`, and verifies the resulting file and value locally.
If the exact `.azure/<environmentName>/.env` does not exist yet, entering a
valid subscription ID creates it with only that one key.

Local writes reach the original selected folder on the browser's machine.
The display-only Local path and `/data` are not substitutes for that handle.
Review/Save checks external changes; there is no filesystem watcher or automatic
merge/reload. Cancel retains the draft, backup failure prevents writing and a
further change requires renewed confirmation.

The UI previews proposed text before the write. **History** shows transaction state
without values or source content. Backups may contain sensitive configuration;
protect the host directory mounted at `/data` and exclude it from support
bundles. Native whole-file secret screening is an additional block, not
encryption for backups. See [Backup and recovery](BACKUP-RECOVERY.md) for
creation, interrupted receipts, dependency changes and lost-handle limits.

---

## The comment guarantee

Supported parameter edits use source spans rather than whole-file formatting.
Text outside the changed spans remains unchanged: comments, ordering, alignment
and line endings. An explicit whole-value replacement owns that value's span;
raw XML replacement owns the policy text. These guarantees do not mean comments
inside a replaced or removed span survive.

Native exact numbers avoid JavaScript rounding, and supported source splices
preserve CRLF/LF. Valid-but-unsupported syntax remains read-only instead of being
normalized into a different spelling. See [Offline native parser](#offline-native-parser).
Bicep literals and expressions have their own bounded parser/serializer rules.
Migration and generated ZIP files have separate output contracts.

Existing Bicep round-trip and focus tests can be selected from `CitadelUI/`:

```powershell
node --test "test/{roundtrip,focus}.test.mjs"
```

Use the test runner with a glob, not direct `node test/file.test.mjs` execution.
Historical file/parameter counts are not current release evidence.

---

## `readEnvironmentVariable` expressions

`readEnvironmentVariable('NAME', 'fallback')` is treated only as Bicepparam
syntax. Citadel UI may edit the fallback span in the selected `.bicepparam`.
The sole exception is `AZURE_SUBSCRIPTION_ID`: the Main editor may read and
replace that one value in `.azure/<environmentName>/.env`. Generic environment
file discovery remains disabled, no other key is parsed or returned, and the
environment file is never sent to the container, backed up, or logged.

---

## Code layout

```
CitadelUI/
  Dockerfile           hardened non-root OCI image
  compose.yaml         loopback-only, read-only runtime with /data
  server/
    index.mjs          hardened loopback API and static files
    atomic-json.mjs    one durable, 0600, rename-based JSON write
    registry-store.mjs durable non-sensitive project/environment metadata (v4)
    connections.mjs    named GitHub connection profiles, server-owned
    credentials.mjs    optional envelope-encrypted credential store
    activity.mjs       bounded, redacted governance activity log
    transactions.mjs   backup, journal, audit, retention, recovery
    transaction-manifest.mjs
                       pure validation, manifest projection and hash serialization
    diagnostics.mjs    fixed-window, bounded memory-only instance capture
    diagnostics-routes.mjs
                       owner-protected capture/report APIs
    github/
      api.mjs          fixed-host api.github.com client
      sessions.mjs     in-memory credential sessions, never persisted
      repositories.mjs repository/ref validation and source-tree filtering
      git-reader.mjs   read-only branch, tree, blob, path and reachability access
      scan-provider.mjs
                       pinned read-only discovery provider
      compatibility.mjs
                       structural compatibility and scan facade
      workspace.mjs    atomic commit, reconciliation and read/History facades
      history.mjs      audited History and inverse plans using the existing writer
      connection-lifecycle.mjs
                       connection lifecycle through live owner-store ports
      workspace-routes.mjs
                       workspace adapters receiving already-resolved authority
      routes.mjs       same-origin dispatch, source authority and cache ownership
  shared/
    citadel-core.mjs   provider-neutral discovery and document behavior
    source-scope.mjs   one definition of the editable source boundary
    label-key.mjs      shared label projection; validation stays with callers
    subscription-env.mjs
                       byte-preserving AZURE_SUBSCRIPTION_ID patcher
    policy.mjs         pure APIM policy parser/editor
    bicepparam/        lexer, parser, serializer, span editor
    workspace-configuration.mjs
                       format/unit identity and native source scope
    terraform/         native literal parser, schema, source review and drafts
    terraform-export.mjs
                       pinned Bicep-to-Terraform mapping and ZIP inputs
    diagnostics.mjs    finite diagnostic catalogs and exact report schema
  web/
    index.html
    css/               design tokens and component styles
    js/
      app.mjs          shell, projects/environments, routing, review and save
      api.mjs          explicit service context, registry and provider composition
      document-action.mjs
                       existing view ownership and per-document notice helpers
      editor-document-session.mjs
                       staged document loading through the shell's load gate
      workspace-service.mjs
                       source workflows, validation, byte assembly and budgets
      parameter-copy-plan.mjs
                       pure ordered selection and copy operations
      registry.mjs     IndexedDB labels, metadata, drafts, retained handles
      registry-sync.mjs
                       one registry bootstrap, authority and metadata mirror
      workspace-activation.mjs
                       retained/open/reconnect and the single active generation
      workspace-attachment.mjs
                       distinct Local and Git attachment/recovery protocols
      workspace-context.mjs
                       UI composition and existing workspace facades
      directory-provider.mjs
                       selected-folder I/O and exclusion boundary
      github-provider.mjs
                       read-only GitHub source provider
      mutation-coordinator.mjs
                       mutation contract and local transaction coordinator
      github-coordinator.mjs
                       one Git commit per Citadel operation
      source-factory.mjs
                       the only place that dispatches on source kind
      github-session.mjs
                       opaque session id, never a token
      github-connections.mjs
                       named connections: create, resume, persist, remove
      github-setup.mjs repository and branch selection panel
      workspace-catalog.mjs
                       saved-workspace catalogue and guided attach flow
      workspace-catalog-list.mjs
                       supplied-row catalogue rendering, without state ownership
      activity.mjs     browser half of the redacted activity log
      transaction-client.mjs
                       browser half of verified backup-before-write
      paramview.mjs    sections, parameter rows and presentation facade
      deployment-presentation.mjs
                       pure deployment grouping, visibility and section titles
      llmview.mjs      guided LLM backend editor
      llmschema.mjs    provider, model and validation knowledge
      policyview.mjs   APIM policy editor
      native-controls.mjs
                       shared fields bound to native names/types/defaults
      diagnostics-client.mjs
                       bounded signed-in browser capture and instance polling
      debug-page.mjs   header-linked /debug control/report surface
      fields.mjs       generic value controls
  test/
  scripts/             start, stop, status, and local logs
```

The production image has no package install or build step. It contains only the
application runtime and serves ES modules directly. It has no Azure CLI, Bicep
CLI, `azd`, Git, deployment tooling, or external telemetry exporters.
GitHub editing, repository initialization and migration acquisition use the
fixed GitHub API transport. Public local-source creation also reads verified
files from `raw.githubusercontent.com`. A configured hosted instance can read its
credential key from Key Vault through managed identity. Local source editing and
the vendored native parser need none of those outbound services.
