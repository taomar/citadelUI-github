# Local Release and Offline Operation

The current packaged desktop delivery is
[Citadel UI Desktop v1.1.7](https://github.com/taomar/citadelUI-github/releases/tag/citadel-ui-desktop-v1.1.7).
Its full build source is the release tag target, recorded as `releaseRevision`
in the attached `CitadelUI-build-*.json`. It integrates the import and region fixes
with the current application, Electron Windows/macOS fixes, version and updater.
Follow the [pinned release checkout](../README.md#start-with-a-clone).
Internal handovers and detailed review records remain local-only.

## Desktop v1.1.7 read-only discovery and wizard

Released on 15 September 2026 from full build commit
[`4a0914c8343ba22dabae48ff615ab680fd62315e`](https://github.com/taomar/citadelUI-github/commit/4a0914c8343ba22dabae48ff615ab680fd62315e).
The [tagged native workflow](https://github.com/taomar/citadelUI-github/actions/runs/34991474149)
passed Windows x64, Intel Mac and Apple Silicon package gates, including the
preserving help overlay and a real installed Windows v1.1.6-to-v1.1.7 upgrade.
The expanded focused release gate contains 334 passing tests. All 12 public assets
were downloaded anonymously; each ZIP matched all 181 application files against
its recorded hashes and platform-specific Git checkout. The actual desktop
updater accepted the published v1.1.7 feed.

Application baseline:
[`772b49ff0a09a937a267c08c21f80c3247d6c1e6`](https://github.com/taomar/citadelUI-github/commit/772b49ff0a09a937a267c08c21f80c3247d6c1e6).
The lower-left label reads `v1.1.7 | 772b49f`.

This corrects a reproduced v1.1.6 gap: an organization could be visible through
readable repositories but absent from the membership list. Discovery now checks
both sources, deduplicates immutable owner IDs and keeps partial or denied
results visible. Read-only access can discover an owner; it does not grant
membership or permission to create. Explicit handle lookup can find a profile
without claiming membership, and creation still performs its strict checks.

The setup wizard separates connection identity, repository destination and source
snapshot. The authenticated GitHub user is no longer described as the token's
destination. Source and destination sit side by side on larger screens and stack
on narrow ones, with recovery actions kept separate.

Token help is a compact overlay with scope, permissions and connection steps.
Creation, editing, reconnection and read-only migration use the shared help.
Closing it or pressing Escape restores the unfinished form, its values, scroll
position and help-button focus. Opening help never submits or displays a token.

Read-only organization discovery was exercised through the real application HTTP
boundary with simulated GitHub responses and a ban on outbound write methods.
Browser checks covered organization selection, 1440px and 390px layouts, no
horizontal overflow, retained input values and restored focus. No client PAT was
collected, and the client's live organization was not modified or certified.
The final application suite recorded 2,675 entries: 2,631 passed, nine established
baseline failures, 35 skips and no cancellations.

The passed native release gates include the new discovery and help tests, packaged wizard
layout and overlay acceptance, and a real installed Windows v1.1.6-to-v1.1.7
upgrade. Existing directory permissions, update consent, region entry and source
integrity protections remain. Earlier releases and their binaries are unchanged.

## Desktop v1.1.6 import owners and progress

Released on 15 September 2026 from full build commit
[`4f1e4d27afe03c1d156236bcefaa7bc7390cd48c`](https://github.com/taomar/citadelUI-github/commit/4f1e4d27afe03c1d156236bcefaa7bc7390cd48c).
The [tagged native workflow](https://github.com/taomar/citadelUI-github/actions/runs/34976309629)
passed Windows x64, Intel Mac and Apple Silicon gates, including a real installed
Windows v1.1.5-to-v1.1.6 upgrade with retained state. All 12 public assets were
downloaded anonymously and checked. Each of the three ZIPs matched all 180
application files to its manifest and platform-specific Git checkout, accounting
for Windows CRLF checkout conversion. The actual desktop updater accepted the
published release and its verified Windows feed.

Application baseline:
[`0bc50b8c0c27002695cf9a8b47c0e1cd5e42037d`](https://github.com/taomar/citadelUI-github/commit/0bc50b8c0c27002695cf9a8b47c0e1cd5e42037d).
The lower-left label reads `v1.1.6 | 0bc50b8`. All previous desktop, directory
permission, update, managed-login and free-entry region fixes remain.

- New repository setup checks organization memberships first and defaults to an
  available Organization. Personal remains an explicit choice. Handles, owner
  types and numeric IDs distinguish similar display names. Missing discovery
  access is shown rather than interpreted as no organizations.
- Membership and policy checks report denied or not-yet-verified creation
  rights honestly. GitHub still enforces token, SSO and enterprise policy.
  Existing attempts keep their original immutable owner; resume reconciles
  that attempt instead of changing its namespace or overwriting a repository.
- Import errors identify the owner, action and available HTTP status. Transient
  reads use at most three attempts with bounded backoff. Lost write responses
  are reconciled, not blindly repeated. Verified source bytes can be reused
  within the same pinned operation after a temporary read failure.
- Repository and local imports show phase-specific progress, confirmed counts,
  elapsed time and retry/recheck reasons. Finishing the copy phase does not
  falsely report that verification or registration has finished.
- Every region picker offers the shared 69-entry documented Azure catalog,
  including sovereign regions. Additional template strings and manually typed
  regions remain normal entries, without custom/unsupported flags. Suggestions
  do not guarantee availability for a subscription, cloud or individual service.

Source preparation against the public `citadel-v1` snapshot verified 363 files
and 20,303,635 bytes in 21 seconds without GitHub writes. Browser acceptance used
the real application HTTP boundary with simulated GitHub organizations and
transient source errors; it did not mutate or certify a customer's organization.
The old generic error alone cannot establish that customer's original failure.

The full application suite is qualified, not entirely green: historical
failures remain, and an unchanged diagnostics case failed in the full run but
passed in its isolated rerun. Native release gates include owner, retry, local
progress, region, source-integrity and desktop regressions, plus organization
selection and the complete region catalog inside each packaged renderer.
All three native package jobs and the real installed Windows upgrade passed
before publication. Old release tags and binaries remain unchanged.

## Desktop v1.1.5 compatibility release

Released on 15 September 2026 from full build commit
[`8db9d56d3c48d63e6994167bd007c0b1281341b9`](https://github.com/taomar/citadelUI-github/commit/8db9d56d3c48d63e6994167bd007c0b1281341b9).
The [tagged release workflow](https://github.com/taomar/citadelUI-github/actions/runs/34957080437)
passed Windows x64, Intel Mac and Apple Silicon packaged checks, including
unlisted-region acceptance and retained local-folder permissions. Its real
installed Windows upgrade from v1.1.4 to v1.1.5 passed with retained state.
Downloaded Windows and both Mac ZIPs each matched all 175 application files
to the pinned source and their recorded hashes. The live Windows update feed
was verified after publication.

Application baseline:
[`128d269ca6f4dcd8a1d3ea011dc345dc8d153c3c`](https://github.com/taomar/citadelUI-github/commit/128d269ca6f4dcd8a1d3ea011dc345dc8d153c3c).
The release preserves the complete current UI and earlier Electron fixes.

- Region fields accept values absent from the dropdown as normal entries,
  including nested fields, expression fallbacks, native Terraform, migration
  and export. There is no unsupported/custom marker. Other type, enum, required
  and sensitive-value rules remain enforced. Underlying deployment templates
  are not silently rewritten and service availability is not certified.
- GitHub Enterprise Managed User logins such as `name_company` pass connection
  validation, registry metadata and source flows. Authentication, token scope
  and numeric-account ownership checks are unchanged.
- The lower-left label reads `v1.1.5 | 128d269`. Windows installed updates still
  need download and restart consent; macOS and portable Windows notify only.

The native workflow runs region and managed-login regressions on all three
targets, tests an unlisted region inside the packaged renderer, and verifies a
real installed Windows upgrade from v1.1.4. Package source/hash gates remain
required. Exact full-build identity and hashes are in the versioned artifacts,
not inferred from a moving branch. v1.1.4's historical record and assets below
are not modified.

## Desktop v1.1.4 release record

Published on 14 September 2026. The identities below describe the exact tested
and distributed build, rather than the current tip of a development branch.

| Identity | Value |
| --- | --- |
| Source tag | [`citadel-ui-desktop-v1.1.4`](https://github.com/taomar/citadelUI-github/tree/citadel-ui-desktop-v1.1.4) |
| Complete desktop build commit | [`bb6b7cae2f42ff5f4f3dac6dd9cfcd6aedcb7a9f`](https://github.com/taomar/citadelUI-github/commit/bb6b7cae2f42ff5f4f3dac6dd9cfcd6aedcb7a9f) |
| Embedded application baseline | [`5791d4358f2696c1f4ec2805bd6bcfc2c7d729e8`](https://github.com/taomar/citadelUI-github/commit/5791d4358f2696c1f4ec2805bd6bcfc2c7d729e8), for `server`, `shared` and `web` |
| Desktop version label | `v1.1.4 \| 5791d43` |
| Release branch | `taomar-electron-desktop-packaging`; later documentation commits can advance this branch |
| Per-platform build identity | `CitadelUI-build-win32-x64.json`, `CitadelUI-build-darwin-arm64.json`, `CitadelUI-build-darwin-x64.json` |
| Exact artifact checksums | [v1.1.4 SHA256SUMS.txt](https://github.com/taomar/citadelUI-github/releases/download/citadel-ui-desktop-v1.1.4/SHA256SUMS.txt) |

The application baseline alone does not include the complete Electron wrapper
and updater. Use the full build commit or tag to retrieve everything shipped.
Use the release downloads for the identical binaries: rebuilding the same source
can produce different hashes because of timestamps and platform/signing inputs.
Documentation-only follow-ups do not move this tag, rebuild these packages, or
replace published assets.

### Observed release evidence

GitHub-hosted evidence is recorded in the successful
[tagged release workflow](https://github.com/taomar/citadelUI-github/actions/runs/34866034370).
The [workflow definition](../.github/workflows/citadel-ui-desktop-release.yml)
requires the native jobs before publication; this is not a claim about required
merge checks or branch protection.

| Target | Observed result |
| --- | --- |
| Windows x64 | Packaged UI, version/update control, native parser, Diagnostics, folder-permission and persistent-workspace checks passed |
| Windows installed upgrade | Real Squirrel upgrade from v1.1.3 to v1.1.4 passed, with retained-state and installed-runtime verification |
| macOS Apple Silicon | Native packaged checks passed; in-place updates remained disabled |
| macOS Intel | Native packaged checks passed; in-place updates remained disabled |
| Downloaded ZIPs | Windows, Apple Silicon and Intel archives each contained 173 application files matching the pinned Git source and their recorded hashes |
| Published Windows update feed | The product checker verified the live v1.1.4 feed and its checksum after publication |

The implementation evidence is in
[source integrity](desktop/source-integrity.mjs),
[packaged acceptance](desktop/run-packaged-smoke.mjs), and the
[installed Windows upgrade check](desktop/test-windows-update.mjs).
The latter is restricted to disposable GitHub-hosted Windows runners.

The update-button smoke test uses a simulated newer release; it does not mean
v1.1.5 has been published. The real restricted-directory permission probe and
the writable origin-private filesystem workspace test are separate. Native
folder pickers, arbitrary user folders and macOS privacy prompts are not
automated. These release gates do not claim a fully green repository-wide
suite, cloud deployment proof or a security certification.

macOS and portable Windows updates are notification-only. Installed Windows
requires separate download/staging and restart consent. Packages are unsigned;
the Mac packages are not notarized. See the
[combined install/update guide](../guides/deployment.md#windows-and-macos-desktop-release).

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

Desktop v1.1.7 packages application revision
`772b49ff0a09a937a267c08c21f80c3247d6c1e6` from the delivery branch, including the
latest modularization and fixes. It retains the Windows/macOS Electron fixes.
Desktop versions through v1.1.3 incorrectly used the September 7 application
baseline. Do not use a version label or a startup smoke check as source proof.

To rebuild this release's source, use tag `citadel-ui-desktop-v1.1.7`, separately
from the container. The development branch can advance beyond the released
commit. `desktop/application-source.json` pins the embedded application baseline:

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
opens the Diagnostics window, checks the full region catalog and verifies
Organization-first/Personal owner options through isolated synthetic GitHub
ports. Its screenshot is a separate CI artifact. It
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
installs the checksum-pinned v1.1.6 fixture on a disposable runner, applies the
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
