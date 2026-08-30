# Citadel UI

A local, browser-based editor for the Bicep parameter files in this repository.

Bicep parameter files are the real configuration surface of this accelerator, and
they are edited by hand. They are also long, densely commented, and unforgiving:
a mistyped provider name or a missing `modelPath` is not discovered until a
deployment fails. Citadel UI reads those files straight from the repository,
presents them as explained forms, and writes changes back **without disturbing a
single comment**.

It runs entirely on your machine. It never contacts Azure, never authenticates,
and never deploys anything.

---

## Running it

Requires **Node.js 20 or newer**. There are no dependencies to install — the
server and the frontend use only platform built-ins.

```bash
cd CitadelUI
node server/index.mjs
```

Then open <http://127.0.0.1:4173>.

Set `PORT` to use a different port. The server only binds to `127.0.0.1`.

---

## What it edits

The app scans the whole repository for `.bicepparam` files, but it puts three
deployments front and centre — the three you actually change.

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

> **Note.** The `contracts/` directory is listed in `.gitignore`. Contracts you
> create here are real files on disk, but Git will not track them unless that
> rule is changed. The UI says so where it matters.

---

## How saving works

Every save is **archive, then replace**:

1. The current file is copied to `CitadelUI/.backups/<original path>/<timestamp>`.
2. The new content is written to the original path.

Nothing is overwritten without a copy being kept first, and the file keeps its
original location and name so Bicep tooling is unaffected.

Before writing, the app shows you a line-by-line diff of exactly what will
change. Edits accumulate as a pending queue until you review them, so you can
change several parameters and commit them as one revision.

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

## Environment variables

Many parameters call `readEnvironmentVariable('NAME', 'fallback')`. The app
resolves those against your current environment and shows the effective value
next to the expression, so you can tell what a deployment would actually use —
and edit either the fallback or the reference itself.

---

## Code layout

```
CitadelUI/
  server/
    index.mjs          HTTP server, JSON API, static files
    discovery.mjs      finds and classifies .bicepparam files
    doclayer.mjs       turns banner comments into sections and prose
    contracts.mjs      access-contract discovery, creation, policy editing
    bicepparam/        lexer, parser, serializer, span editor
  web/
    index.html
    css/               design tokens and component styles
    js/
      app.mjs          shell, state, routing, review and save
      paramview.mjs    sections and parameter rows
      llmview.mjs      guided LLM backend editor
      llmschema.mjs    provider, model and validation knowledge
      policyview.mjs   APIM policy editor
      fields.mjs       generic value controls
  test/
  .backups/            archived revisions, created on first save
```

No build step. The browser loads the ES modules directly; edit a file and
reload.
