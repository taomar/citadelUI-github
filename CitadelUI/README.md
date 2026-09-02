# Citadel UI

A fully local, containerized editor for user-selected Citadel repositories.
Citadel UI presents `.bicepparam` files and their associated APIM policy XML as
explained forms and writes surgical changes without disturbing unrelated
comments or formatting.

One container manages any number of user-labeled environments. Microsoft Edge
or Google Chrome grants repository access through the File System Access API;
the container never receives a source mount, Docker socket, cloud
credential, or broad host filesystem access. Citadel UI never contacts Azure,
authenticates, deploys, sends telemetry, or checks for updates.

---

## Run the supported container

Requirements:

- Docker Desktop/Engine 29 or newer with Compose.
- Microsoft Edge or Google Chrome desktop.
- A user-owned directory for durable Citadel UI data.

From PowerShell:

```powershell
cd CitadelUI
Copy-Item container.env.example container.env
.\scripts\start.ps1
```

Open <http://127.0.0.1:4173>. The origin and port are fixed because retained
directory handles are origin-bound. If the port is occupied, stop the conflicting
process rather than changing ports.

On first use, create a project, enter an environment label and display-only
**Local path**, and choose the exact Citadel repository through the in-app folder
picker. Repeat from **Settings** for Development, Test, Production, or any other
labels. Labels, folder names, and Local paths are informational. Normal attachment
requires the Main deployment,
LLM onboarding, and Access Contracts template paths and signatures; an incomplete
tree is rejected with the missing capability names and is never activated.

Directory handles remain in the browser profile because they cannot be moved
into a container. Non-sensitive project and environment metadata, including the
user-entered display-only Local path, is mirrored to
`/data/settings/registry.json`. After a container restart, retained browser
handles reopen normally. After browser-profile loss, labels and fingerprints
remain visible with their Local paths and each profile asks the user to reconnect
its folder.

Use `scripts\status.ps1`, `scripts\logs.ps1`, and `scripts\stop.ps1` for local
operation. Direct `node server/index.mjs` execution is developer-only.

---

## What it can access

The browser traverses only a directory explicitly selected by the user. The
source scope is:

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

## GitHub repositories

An environment can be a selected local folder or a GitHub repository. The GitHub
source is chosen on the landing page next to **Local folder**:

1. Paste a **fine-grained personal access token** scoped to only the intended
   repositories, with `Contents: Read and write` (and `Metadata: Read-only`,
   which GitHub adds automatically). Classic tokens are refused, and no Pull
   requests permission is needed — Citadel only opens a compare URL that
   github.com's own session authorises.
2. Citadel UI validates it, keeps it **only in server memory**, and hands the
   browser an opaque session id. The token is never written to disk, browser
   storage, a log, an audit record, or a response. Connecting reports its real
   stages — validating, authenticating, loading repositories — and any failure
   appears beside the token field, not only in the status bar.
3. Pick a repository from the list the credential can actually reach, then pick a
   branch. You never type an owner/repository path, and **no branch is chosen for
   you**: the branch decides which tree Citadel edits, so it has to be selected.
4. Citadel UI checks that the selected repository and branch really are a Citadel
   workspace, using the same discovery the local folder editor is judged by, and
   names the capabilities it found. **Attach stays disabled until that check
   passes**, and the server repeats it against the exact branch head immediately
   before it creates anything — so a repository that is not a Citadel repository
   never gets a working branch or a registry record.
5. Citadel UI creates or reuses the working branch `citadel-ui/<environment-id>`
   from the branch you chose, and every save commits there. Direct writes to the
   selected branch are an explicit opt-in.

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

GitHub credentials are cleared when the container restarts, so GitHub
environments stay listed and show **Reconnect GitHub** until a new session is
established.

If a save's branch update fails in transport, Citadel UI asks GitHub what
actually happened rather than guessing. A commit that is the branch head or an
ancestor of it is reported as applied; a branch that is readable and provably
does not contain the commit is a real failure you can retry; and a branch that
cannot be read either is reported as **indeterminate**, with the commit SHA and
an instruction to reload rather than retry — because a blind retry would
duplicate a commit that had already landed.

### 1. Main deployment

`bicep/main.bicepparam` — the core gateway infrastructure. Around 97 parameters
covering naming, networking, API Management, observability, and the optional
capabilities you can switch on.

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

Each contract has two editable files: its `.bicepparam` and its APIM policy XML.
Both are shown, both can be changed. New contracts are created from the fixed
template pair at the module root:

- `citadel-access-contracts/main.bicepparam`
- `citadel-access-contracts/policies/default-ai-product-policy.xml`

---

## Verified saves, backup, and recovery

Every parameter edit, policy edit, contract creation, environment copy, and
restore uses one transaction protocol:

1. The browser reads and hashes every current target.
2. The container creates a journal under `/data`.
3. Original bytes are stored and hash-verified under `/data` before any source
   write is authorized.
4. The browser re-reads each target to detect external edits, writes through its
   retained directory handle, and verifies final SHA-256 hashes.
5. The container accepts a final receipt and appends a redacted hash-chained
   audit event.
6. A failed multi-file write restores completed targets from verified backup
   bytes and removes newly created targets.

The subscription-only azd environment bridge is intentionally outside this
backup protocol: `.env` may contain unrelated sensitive values, so its bytes
never leave the browser. The browser uses the File System Access API's atomic
writable, rejects stale whole-file hashes, replaces only
`AZURE_SUBSCRIPTION_ID`, and verifies the resulting file and value locally.
If the exact `.azure/<environmentName>/.env` does not exist yet, entering a
valid subscription ID creates it with only that one key.

The UI always previews the exact text first. **History** shows transaction state
without values or source content. Backups may contain sensitive configuration;
protect the host directory mounted at `/data` and exclude it from support
bundles.

---

## The comment guarantee

This is the constraint the whole design is built around.

The obvious way to edit a parameter file is to parse it, change the model, and
print it back out. That cannot be done here: `az bicep build-params` — and any
equivalent round-trip — **discards every comment**. These files carry over 1,300
comment lines, and that prose is the only documentation the parameters have.
Reformatting them would destroy more value than the editor adds.

So Citadel UI never reprints a file. It parses to a concrete syntax tree that
records the exact byte span of every value, and applies each change as a
surgical splice into the original text. Everything outside the spans you edited —
comments, blank lines, alignment, ordering, line endings — is byte-identical
afterwards.

This is enforced, not assumed:

```bash
cd CitadelUI
node test/roundtrip.test.mjs   # every .bicepparam in the repo, parsed and re-emitted byte-for-byte
node test/focus.test.mjs       # the three focus areas, their outlines and contract handling
```

The round-trip gate covers all 17 parameter files, 402 parameters and 1,320
comments.

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
    registry-store.mjs durable non-sensitive project/environment metadata
    transactions.mjs   backup, journal, audit, retention, recovery
    github/
      api.mjs          fixed-host api.github.com client, the only egress
      sessions.mjs     in-memory credential sessions, never persisted
      repositories.mjs repository/ref validation and source-tree filtering
      workspace.mjs    tree, blob, atomic commit, history, inverse commit
      routes.mjs       same-origin GitHub routes
  shared/
    citadel-core.mjs   provider-neutral discovery and document behavior
    source-scope.mjs   one definition of the editable source boundary
    subscription-env.mjs
                       byte-preserving AZURE_SUBSCRIPTION_ID patcher
    policy.mjs         pure APIM policy parser/editor
    bicepparam/        lexer, parser, serializer, span editor
  web/
    index.html
    css/               design tokens and component styles
    js/
      app.mjs          shell, projects/environments, routing, review and save
      registry.mjs     IndexedDB labels, metadata, drafts, retained handles
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
      github-setup.mjs repository and branch selection panel
      transaction-client.mjs
                       browser half of verified backup-before-write
      paramview.mjs    sections and parameter rows
      llmview.mjs      guided LLM backend editor
      llmschema.mjs    provider, model and validation knowledge
      policyview.mjs   APIM policy editor
      fields.mjs       generic value controls
  test/
  scripts/             start, stop, status, and local logs
```

The production image has no package install or build step. It contains only the
application runtime and serves ES modules directly. It has no Azure CLI, Bicep
CLI, `azd`, Git, deployment tooling, or telemetry. Its only outbound network
dependency is `https://api.github.com`, used exclusively by GitHub environments.
