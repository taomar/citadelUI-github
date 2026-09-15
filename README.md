![Citadel](./assets/citadel-logo-v2.PNG)

# Citadel Control Plane

A browser-based configuration editor for Citadel AI Hub Gateway: edit native
**Bicep / Citadel** or **Terraform** inputs, review the changes, and save to a
selected local folder or GitHub working branch. Citadel edits configuration;
it does not deploy the gateway or manage Terraform state.

[User guide](./guides/using-the-control-plane.md) |
[Deployment](./guides/deployment.md) |
[Troubleshooting](./CitadelUI/DIAGNOSTICS.md)

## Install a desktop release

The packaged Electron application needs no Docker, Node.js, or source checkout.
The current desktop release is
[Citadel UI Desktop v1.1.6](https://github.com/taomar/citadelUI-github/releases/tag/citadel-ui-desktop-v1.1.6).
Download:

- [Windows installer](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUISetup.exe)
- [Portable Windows ZIP](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUIPortable.zip)
- [macOS Apple Silicon DMG](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUI-macOS-arm64.dmg)
- [macOS Intel DMG](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/CitadelUI-macOS-x64.dmg)
- [SHA-256 checksums](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.6/SHA256SUMS.txt)

See the
[combined Windows and macOS deployment guide](guides/deployment.md#windows-and-macos-desktop-release)
for Mac architecture selection, first launch, local-folder access, and GitHub
PAT guidance.

ZIP packages for both Mac architectures are also attached to the release.
Verify the downloaded file against `SHA256SUMS.txt` before opening it. Packages
are unsigned and the macOS builds are not notarized until Apple credentials are
configured. The desktop app listens only on `127.0.0.1:4174`, stores its state
in the current user's application-data directory, and keeps local repository
handles in its own Electron profile.

**Exact desktop build:** use tag
[`citadel-ui-desktop-v1.1.6`](https://github.com/taomar/citadelUI-github/tree/citadel-ui-desktop-v1.1.6).
This is the full application plus Electron wrapper, fixes and update controls.
The embedded `server`, `shared` and `web` application baseline is
[`0bc50b8c0c27002695cf9a8b47c0e1cd5e42037d`](https://github.com/taomar/citadelUI-github/tree/0bc50b8c0c27002695cf9a8b47c0e1cd5e42037d).
It includes native Terraform, modularization and the current UI, plus unlisted
region entry without special flags and managed GitHub account logins such as
`name_company`. The full build retains the Electron
Windows/macOS local-folder fixes and updater. Versions through v1.1.3 packaged
the older September 7 application. The lower-left version label, window title
and attached `CitadelUI-build-*.json`
identify the actual version and source; startup alone is not release verification.
Version 1.1.6 also adds organization-first repository creation with explicit
Personal/Organization identity, actionable errors and bounded read retries,
clear import progress, and 69 documented Azure region suggestions.
See the [current release details](./CitadelUI/RELEASE.md#desktop-v116-import-owners-and-progress)
for the native Windows/Mac evidence and exact artifact identity. These download
links are pinned to v1.1.6, rather than following a future `latest` release.

Quit the older application before upgrading. Replace the whole portable folder
or macOS `.app`, not just its executable, and retain the existing application-data
profile. See the combined guide for the update procedure.

**Updates:** use **Check for updates** below the version label. The app also
checks at startup and every four hours. macOS and portable Windows copies
notify only, with a **View release** link. Supported installed Windows builds
offer **Update to v...** and, after preparation, **Restart to update**. Both
actions require confirmation; automatic checks never download or restart.
Install this updater-enabled release once to use future in-place Windows updates.

## Start with a clone

These instructions run **Citadel UI only**, not the gateway or sample apps.
To get the exact source used for the published desktop build, clone its tag:

```text
git clone --branch citadel-ui-desktop-v1.1.6 --single-branch https://github.com/taomar/citadelUI-github.git
cd citadelUI-github
git rev-parse HEAD
```

Compare the returned commit with `releaseRevision` in the release's
`CitadelUI-build-*.json`.
A detached HEAD is normal when checking out a release tag. Do not substitute
`main` or a moving branch when you need this exact release:
`taomar-electron-desktop-packaging` can advance with later documentation or work,
and `taomar-citadel-orchestrator` is an earlier UI baseline, not this complete
desktop release.

The downloadable packages are the exact tested binaries. Rebuilding the same
source may produce different archive hashes because of packaging timestamps
and platform/signing inputs. Documentation-only follow-ups do not move the
release tag or replace its published assets.

Publishing source does not update an existing container or Azure deployment. See
[release and offline operation](./CitadelUI/RELEASE.md).

The application and its deployment live in **`CitadelUI/`**. Never run `azd up`
at the repository root: its `azure.yaml` belongs to the gateway.

## Run locally from source

Install Docker Desktop or Docker Engine 29+ with Compose, start Docker, and use
desktop Microsoft Edge or Google Chrome. From the repository, choose one shell:

### PowerShell

```powershell
Set-Location .\CitadelUI
if (-not (Test-Path container.env)) { Copy-Item container.env.example container.env }
.\scripts\start.ps1
```

### Bash

```bash
cd CitadelUI
if [ ! -f container.env ]; then cp container.env.example container.env; fi
# Linux Docker Engine: prepare storage for the container's non-root user.
if [ "$(uname -s)" = "Linux" ]; then
  sudo install -d -m 0700 -o 10001 -g 10001 .data
fi
bash scripts/start.sh
```

The launcher builds from this checkout and waits for a healthy container.
Open <http://127.0.0.1:4173>, create the owner account on first use, then
[attach a workspace](./guides/using-the-control-plane.md#workspaces).
Returning users sign in with the existing owner. There is no password reset.

Keep the same origin, port and browser profile for local folder access. Durable
application state defaults to `CitadelUI/.data`; it is not the editable source
folder. For a custom `CITADEL_DATA_PATH`, prepare that directory instead.
For an existing installation, use the
[local image-only update procedure](./guides/deployment.md#update-an-existing-local-container)
and retain its original data, Compose overrides and any credential-key mount.

## Overview

Choose the workflow by the files you want to change:

| Task | Use | Result |
| --- | --- | --- |
| Edit existing Bicep parameters and APIM policy XML | **Bicep / Citadel**, then **Local** or **Existing GitHub Repo** | Reviewed edits to the selected source |
| Add, edit or remove literal Bicep resource tags | **Azure Deployment > tags** | Source-defined entries staged for normal review/save |
| Edit Terraform operator inputs | **Terraform (native)**, then **Local** or **Existing GitHub Repo** | Edits to explicitly selected `.tfvars` or `.tfvars.json` files |
| Produce Terraform inputs from saved Bicep values | **Tools > Export Terraform inputs** (Experimental) in a Bicep workspace | A downloaded ZIP; neither repository is changed |
| Bring older values into current Bicep templates | **Tools > Migrate configuration** (Experimental) | Reviewed local apply, or preview/sanitized export for GitHub destinations |
| Start a local Bicep/Citadel project | **Create local from Citadel source** | A verified source snapshot in a new folder, without Git history |
| Start a private GitHub Bicep/Citadel project | **New GitHub Repo** | A new private snapshot repository, followed by workspace attachment |

Configuration **format** and source **transport** are separate choices.
A Citadel workspace is a saved editing profile, not a Terraform CLI/state
workspace. GitHub connections can serve both formats; each Local workspace
needs its own folder. Formats are not automatically converted or synchronized.

## How it completes the Citadel AI Hub

The [Citadel AI Hub Gateway](https://github.com/mohamedsaif/ai-hub-gateway-solution-accelerator/tree/citadel-v1)
defines infrastructure, model backends and access policy as source files.
The Control Plane presents those inputs as guided forms between deployments.
Its three areas are **Azure Deployment**, **LLM Onboarding** and **Access Contracts**.
Native LLM or Access units can be opened without a Deployment unit or Bicep files.

The header identifies the workspace; the contextual command bar identifies the
document, source and write destination. **Review & save** stays in the same
place, separate from **History**, **Discard** and the **Tools** menu.
The workspace explorer selects an area/file; the document's **Parameters**,
**Raw file** and category tabs keep its source context visible.

The forms use source comments and schema information where available. Supported
edits splice the selected values rather than reformatting the whole file.
Validation helps catch supported type, scope and dependency problems; it does
not prove Terraform/provider behavior, deployment readiness or runtime parity.

## What it edits

Bicep workspaces edit `.bicepparam` and associated APIM policy XML, with referenced
Bicep templates supplying schema. Native Terraform workspaces edit only the
operator value files explicitly selected during attachment. Their `variables.tf`,
bounded configuration/module dependencies and shared default policy are read-only.
Examples are templates, not active input selections.

Local Save writes the original file on the **browser's machine**. GitHub Save
creates a reviewed commit on the workspace's **actual working branch**.
The container has no source mount, Docker socket or broad host filesystem access.
It retains application state and Local backups under `/data`.

Known secret-bearing native operator or dependency files are blocked even when
the requested edit is nonsecret: hiding a field would not make a whole-file
backup safe. For parser, policy and recovery boundaries, read
[native workspaces](./guides/using-the-control-plane.md#native-terraform-workspaces).

## What it looks like

Screenshots use synthetic data, not user repositories or deployed environments.
The format selector leaves Local and GitHub as independent source choices:

![Terraform format selected, with Local and Existing GitHub Repo available and Bicep starter-copy options disabled](./docs/images/60-native-format-loading.png)

Native inputs use the shared typed controls. Here, a declared-but-unconsumed
input remains an advisory; Save does not establish a runtime effect:

![Synthetic native Deployment draft showing an unconsumed-input advisory beside optional_note](./docs/images/61-native-deployment.png)

For a literal Bicep `tags` object, edit existing values or use **Tag name**,
**Tag value** and **Add tag** to stage a new entry, including from an empty
object. Names come from the source or your explicit input, not a fixed tag list.
The example below retains the source-shaped `azd-env-name` and `SecurityControl`
keys; `cost-center` is an explicitly added demonstration tag, not a default.
See [resource tags](./guides/using-the-control-plane.md#resource-tags) for
validation, save and History restore.

![Synthetic Bicep tags with cost-center explicitly added to the draft before Review & save](./docs/images/64-resource-tags.png)

## Deploy to Azure

Run all UI deployment commands from `CitadelUI/`. Operator inputs are in
`CitadelUI/infra/main.bicepparam`; azd reads them and the hook synchronizes
nonsecret settings before provisioning.

| Deployment path | Instructions |
| --- | --- |
| New private VNet | [Fresh deployment: private mode](./guides/deployment.md#fresh-azure-deployment) |
| New public endpoint | [Fresh deployment: public mode](./guides/deployment.md#fresh-azure-deployment) |
| Existing subnet or named resources | [Resource reuse](./guides/deployment.md#deploy-on-an-existing-subnet-and-resources) |
| Local PowerShell | [Complete local commands](./guides/deployment.md#local-deployment---powershell) |
| Local Bash | [Complete local commands](./guides/deployment.md#local-deployment---bash) |
| Existing Azure UI instance | [Image-only redeployment](./guides/deployment.md#redeploy-an-existing-citadel-ui-container-app) |

Hosted instances use owner sign-in and retain the credential-encryption key in
Key Vault. Normal redeployment preserves that key. The guide records which Azure
paths have live evidence; local native-editor acceptance is not Azure deployment
evidence.

## Guides

- [Using Citadel Control Plane](./guides/using-the-control-plane.md): choose a flow,
  attach/open a workspace, edit, review and save.
- [Deployment guide](./guides/deployment.md): install the desktop release, deploy,
  update and roll back without replacing application state.

## Reference

[Application reference](./CitadelUI/README.md) |
[Security model](./CitadelUI/SECURITY.md) |
[Backup and recovery](./CitadelUI/BACKUP-RECOVERY.md) |
[Timed diagnostic capture](./CitadelUI/DIAGNOSTICS.md)

## License

See [LICENSE](./LICENSE).
