# Citadel UI desktop

This directory packages the existing Citadel Control Panel as a Windows desktop
application. It embeds the existing Node server and Chromium UI; it does not
copy repository access into Electron's main process.

## Install the release

The current package is
[Citadel UI Desktop v1.0.0](https://github.com/taomar/citadelUI-github/releases/tag/citadel-ui-desktop-v1.0.0).
Download the
[Windows installer](https://github.com/taomar/citadelUI-github/releases/latest/download/CitadelUISetup.exe)
or
[portable ZIP](https://github.com/taomar/citadelUI-github/releases/latest/download/CitadelUIPortable.zip),
then verify it with
[SHA256SUMS.txt](https://github.com/taomar/citadelUI-github/releases/latest/download/SHA256SUMS.txt).
The first release is unsigned.

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
