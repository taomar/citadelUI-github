# Citadel UI desktop

This directory packages the existing Citadel Control Panel for Windows and
macOS. It embeds the existing Node server and Chromium UI; it does not copy
repository access into Electron's main process.

## Install the release

The current package is
[Citadel UI Desktop v1.1.0](https://github.com/taomar/citadelUI-github/releases/tag/citadel-ui-desktop-v1.1.0).
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
Chrome or Edge.

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
