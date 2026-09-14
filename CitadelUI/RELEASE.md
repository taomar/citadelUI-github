# Local Release and Offline Operation

The reviewed desktop UI, literal Bicep tag editor, native Bicep/Terraform
workspaces and timed `/debug` capture were published on 13 September 2026 as
[`8e6fa18`](https://github.com/taomar/citadelUI-github/commit/8e6fa1859a5f1ae2ff786179a03ca6d897f67c9f).
This source delivery includes the updated user/reference documentation and all
twelve current UI screenshots. It is available on
[`taomar-citadel-orchestrator`](https://github.com/taomar/citadelUI-github/tree/taomar-citadel-orchestrator),
not merged into `main`. Follow the
[delivery-branch checkout](../README.md#start-with-a-clone) and record
`git rev-parse HEAD` before building. Use the published commit above to identify
this application baseline; later documentation-only commits can advance the
branch without changing application behavior. Internal handovers and detailed
review records are kept locally by the release operator, not published under
`guides/`.

Source publication does not build or distribute a container image, replace an
existing installation, or deploy Azure resources. An older clone, the image's
`1.0.0-local` label, or a reused image tag does not identify the delivered code.
Use a reviewed checkout or an immutable image from the release operator.

Local acceptance is not Terraform/provider/cloud deployment proof or a security
certification. The [deployment guide](../guides/deployment.md) records separate
Azure evidence and the paths that remain unproven.

## Build and inspect

Release builds use a dedicated, reviewed checkout and Docker build context
`CitadelUI/`, never the gateway's repository root. Record the source commit,
image ID/digest and chosen build inputs in the release record. Preserve an
existing installation's rollback image before reusing any tag.

The base Node image is pinned by digest in `Dockerfile`, `compose.yaml` and
`container.env.example`. The production image includes the application and
vendored native parser assets; it does not install npm dependencies at runtime.
`CitadelUI/README.md` is copied into the image, so a documentation-only change
can change future image bytes without changing application logic.

From the release checkout's `CitadelUI` directory, the existing release helper
requests BuildKit provenance and SBOM attestations and exports an archive,
descriptor and checksum. It requires PowerShell 7 for its file-encoding options:

```powershell
.\scripts\release.ps1 -OutputDirectory '<absolute-artifact-directory-outside-the-checkout>'
```

The helper accepts `-Image '<release-tag>'` and optional
`-SigningKey '<user-owned-private-key>'` for an Ed25519 descriptor signature.
Confirm the generated artifacts and image identity before distribution;
tool availability and successful attestation export must not be assumed from
the command alone. Distribute the public verification key through a separate
trusted channel.

Building a release does not authorize changing a running installation. Use the
[image-only update and rollback procedure](../guides/deployment.md#update-an-existing-local-container)
to activate a reviewed image. Keep the complete original ordered Compose
override list, environment files, data directory, origin and any existing
read-only credential-key mount. Do not enable a checked-in credentials overlay
just because the file exists.

## Offline archive

To archive an already reviewed image without rebuilding, replace both
placeholders below. Run in PowerShell; the manual archive commands also work in
Windows PowerShell 5.1:

```powershell
$Image = 'citadel-ui:<reviewed-immutable-tag>'
$ReleaseDirectory = '<absolute-artifact-directory-outside-the-checkout>'
New-Item -ItemType Directory -Force -Path $ReleaseDirectory | Out-Null
$Archive = Join-Path $ReleaseDirectory 'citadel-ui-local.tar'
docker save --output $Archive $Image
if ($LASTEXITCODE -ne 0) { throw 'Image archive was not created successfully.' }
Get-FileHash -LiteralPath $Archive -Algorithm SHA256
```

Record the checksum and image identity separately from the archive. On the
offline workstation, compare the archive hash with that trusted record before
loading it:

```powershell
Get-FileHash -LiteralPath .\citadel-ui-local.tar -Algorithm SHA256
# Compare the hash with the trusted release record before continuing.
docker load --input .\citadel-ui-local.tar
if ($LASTEXITCODE -ne 0) { throw 'Image archive could not be loaded.' }
```

Loading an image does not start it. For an existing installation, follow the
same no-build/no-pull update procedure and preserve its configuration. Rollback
changes application code, not stored data; an older image is not guaranteed to
understand newer state.

Local Bicep/native input editing and vendored parsing need no registry or Internet
access after the image is available. GitHub editing, new source acquisition and
repository creation still need GitHub connectivity. An Azure deployment using
Key Vault needs its configured managed-identity/key access. Completed migration
prepared sources can be used without reacquiring the original source; current
destination access remains necessary.

Store archives, signatures, attestations, SBOMs and checksums outside the source
repository. Never package `/data`, browser profiles, editable repositories,
credentials or raw local logs. Diagnostic reports are separate, explicit manual
downloads, not part of the application image or release archive.

## Windows and macOS desktop packages

Desktop v1.1.4 packages application revision
`5791d4358f2696c1f4ec2805bd6bcfc2c7d729e8` from the delivery branch, including the
latest modularization and fixes. It retains the Windows/macOS Electron fixes.
Desktop versions through v1.1.3 incorrectly used the September 7 application
baseline. Do not use a version label or a startup smoke check as source proof.

Build the Electron package from `taomar-electron-desktop-packaging`, separately
from the container. `desktop/application-source.json` pins the accepted runtime:

```powershell
Set-Location desktop
npm ci
npm test
npm run smoke
npm run release:win
```

The publishable installer, portable ZIP, and generated checksum file are staged
under `desktop\out\release` with stable asset names:

- `CitadelUISetup.exe`
- `CitadelUIPortable.zip`
- `SHA256SUMS.txt`
- `CitadelUI-build-win32-x64.json`
- `RELEASES` and `citadel_ui-<version>-full.nupkg` for installed Windows updates

Forge rejects `server`, `shared` or `web` files that differ from the pinned
application tree, including extra untracked files, and checks every packaged
runtime hash after copying. Each platform includes `desktop-build.json` in its
resources and publishes a corresponding `CitadelUI-build-*.json`. Release
staging requires a clean committed checkout. The window title and a small
lower-left label display the desktop version and application revision.

The first cross-platform release tag is `citadel-ui-desktop-v1.1.0`. A matching
tag triggers `.github/workflows/citadel-ui-desktop-release.yml`, which builds and
smoke-tests Windows x64, macOS Apple Silicon, and macOS Intel packages before
publishing one GitHub Release with combined checksums. The packaged smoke test
signs in through the actual owner form, opens Add workspace, checks Bicep and
Terraform plus all four source choices, exercises the bundled native parser,
and opens the Diagnostics window. Its screenshot is a separate CI artifact. It
also obtains read permission to a restricted local directory handle, so a
release cannot publish if that permission check fails. It then
uses two isolated persistent File System Access workspaces in the packaged
Electron profile to attach and reopen an existing environment, reject a
duplicate attachment, attach a second environment, write one Bicep value
through the production browser provider, and verify the saved bytes through an
independent retained handle. The workflow does not automate a native directory
picker or claim that it selected a specific runner filesystem path.

Windows staging validates the Squirrel feed's version, file sizes and package
hashes and publishes the referenced packages. The native Windows CI check
installs the checksum-pinned v1.1.3 fixture on a disposable runner, applies the
candidate feed with `Update.exe`, verifies the installed runtime identity, and
runs the current packaged acceptance from that installation. It never runs on
the operator's workstation or overwrites a pre-existing installation.

macOS updates remain notification-only by explicit product policy. Windows
in-place download/staging and restart each require confirmation; portable
builds fall back to notification. Automatic checks do not download packages.

For local macOS builds, run on the matching Mac:

```bash
npm run release:mac:arm64
npm run release:mac:x64
```

Unsigned macOS output is not notarized. Production signing requires a Developer
ID Application certificate. The workflow accepts a base64 PKCS#12 certificate
through `MACOS_CERTIFICATE` and its password through
`MACOS_CERTIFICATE_PASSWORD`. Add `APPLE_ID`, `APPLE_PASSWORD`, and
`APPLE_TEAM_ID` to notarize with an app-specific password. These values belong
in GitHub Actions secrets, never in the repository or release assets.

Publish a later version only after updating `desktop/package.json`, rebuilding
the assets, and committing the exact source used for the package.

Local output is unsigned. A distributed Windows release must configure a
user-owned code-signing certificate outside the repository and verify the
installed application's publisher before publication. Do not package Electron
profile data, the desktop `userData` directory, Citadel repositories, or
credentials.
