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

### 1. Main deployment

`bicep/main.bicepparam` — the core gateway infrastructure. Around 97 parameters
covering naming, networking, API Management, observability, and the optional
capabilities you can switch on.

Sections come from the file itself. The authors already separate the file with
`====` banner comments and mark each block `REQUIRED:` or `OPTIONAL:`; the UI
reads those banners and turns them into sections, explanations, and badges. The
documentation you see is the documentation that is in the file — nothing is
duplicated into the UI, so it cannot drift.

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
  shared/
    citadel-core.mjs   provider-neutral discovery and document behavior
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
CLI, `azd`, Git, deployment tooling, telemetry, or runtime Internet dependency.
