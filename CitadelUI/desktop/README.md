# Citadel UI desktop

This directory packages the existing Citadel Control Panel for Windows and
macOS. It embeds the existing Node server and Chromium UI; it does not copy
repository access into Electron's main process.

## Install the release

The current package is
[Citadel UI Desktop v1.1.4](https://github.com/taomar/citadelUI-github/releases/tag/citadel-ui-desktop-v1.1.4).
Download the
[Windows installer](https://github.com/taomar/citadelUI-github/releases/latest/download/CitadelUISetup.exe)
or
[portable ZIP](https://github.com/taomar/citadelUI-github/releases/latest/download/CitadelUIPortable.zip),
or a macOS
[Apple Silicon DMG](https://github.com/taomar/citadelUI-github/releases/latest/download/CitadelUI-macOS-arm64.dmg)
or
[Intel DMG](https://github.com/taomar/citadelUI-github/releases/latest/download/CitadelUI-macOS-x64.dmg).
Then verify it with
[SHA256SUMS.txt](https://github.com/taomar/citadelUI-github/releases/latest/download/SHA256SUMS.txt).
Packages are unsigned and the macOS packages are not notarized until signing
credentials are configured.

Use the Apple Silicon download for M-series Macs and the Intel download for
Intel Macs. On the first unsigned macOS launch, right-click the application in
Finder, choose **Open**, and confirm **Open** only after verifying its checksum.
The
[combined desktop deployment guide](../../guides/deployment.md#windows-and-macos-desktop-release)
also covers local-folder access and GitHub PAT requirements.

## Development

```powershell
Set-Location CitadelUI\desktop
npm ci
npm start
```

The desktop application uses the fixed origin `http://127.0.0.1:4174`.
Application state is stored under Electron's `userData` directory, normally
`%APPDATA%\Citadel UI`. Browser directory handles are kept in the persistent
`citadel-ui-desktop` Electron session and are separate from handles retained by
Chrome or Edge. Packaged tests on Windows and both Mac architectures grant
read access to a real restricted operating-system directory handle. A separate
writable acceptance workspace in Electron's persistent File System Access
storage attaches and reopens an existing environment, rejects a duplicate,
attaches a second environment, saves one Bicep value, and reads the changed
bytes through an independent retained handle. Native directory pickers are not
automated in CI.

## Source identity

Version v1.1.4 combines the current application from `taomar-citadel-orchestrator`
at `5791d4358f2696c1f4ec2805bd6bcfc2c7d729e8` with this branch's Windows/macOS
Electron fixes. Earlier desktop packages through v1.1.3 used the September 7
application and did not include the later modularization, native Terraform and UI
fixes.

Build from `taomar-electron-desktop-packaging`, not an older `main` checkout.
`application-source.json` pins the reviewed application commit. Forge compares
all `server`, `shared` and `web` files with it, then verifies the copied files
against `resources/desktop-build.json`. Release staging rejects dirty builds.
The title bar and a small lower-left label show the version and source commit
(for example `v1.1.4 | 5791d43`); each release also attaches
`CitadelUI-build-<platform>-<arch>.json` with source/release revisions and hashes.

The packaged test uses the real owner form and Add workspace dialog, checks both
formats and all four sources, runs the vendored Terraform parser and opens the
same-origin Diagnostics window. Its screenshot is retained as a CI artifact.
To check a downloaded Windows ZIP with the same runner, extract it and use
`node run-packaged-smoke.mjs --package-root="<absolute-extracted-directory>"`.

Quit an older instance before starting an update; the single-instance behavior
otherwise focuses the already-running application. Replace the complete portable
folder or `.app` and preserve the existing `userData` profile.

## Update control

**Check for updates** is directly beneath the version label. Release builds
check on startup and every four hours, notifying once per newer version per
launch. The check reads only public metadata for stable desktop tags in this
repository. OS notifications supplement the inline status; failures stay
visible with a retry action.

macOS is deliberately notification-only, including signed builds. Portable
Windows is also notification-only. In-place updating requires an installed
Windows x64 build with its accessible Squirrel `Update.exe`, a clean build, and
the release's verified `RELEASES` / `.nupkg` assets. The feed is tied to the
selected tag, checksum-verified against GitHub metadata and validated before
the native updater runs.

The user first approves downloading/staging, then separately approves a restart.
Nothing is downloaded by automatic checks. A full update package may be needed.
The updater does not reset `userData`. This release must be installed once
before later Windows releases can be applied from inside the app.

The sandbox preload exposes only update-state/check/prepare/restart/release-view
methods. Main-process IPC validates the exact main window, its top frame and
the desktop origin. It exposes no filesystem, command execution or credential
primitive. `updates.mjs` owns the testable policy/state machine;
`electron-updates.mjs` owns native integration and `update-ui.mjs` the footer.

## Windows release package

```powershell
npm run release:win
```

Publishable assets are staged at:

```text
CitadelUI\desktop\out\release\CitadelUISetup.exe
CitadelUI\desktop\out\release\CitadelUIPortable.zip
CitadelUI\desktop\out\release\SHA256SUMS.txt
```

Local builds are unsigned. Public distribution requires a Windows code-signing
certificate configured outside the repository.

## macOS release packages

Run each command on its matching Mac architecture:

```bash
npm run release:mac:arm64
npm run release:mac:x64
```

The staged assets are named `CitadelUI-macOS-arm64.dmg`,
`CitadelUI-macOS-arm64.zip`, `CitadelUI-macOS-x64.dmg`, and
`CitadelUI-macOS-x64.zip`. GitHub Actions builds both architectures on native
macOS runners.

Unsigned local packages are suitable only for evaluation. For production,
install an Apple Developer ID Application certificate, set
`CITADEL_MACOS_SIGN=true`, and supply either the documented Apple ID or App Store
Connect API notarization environment values before building.
