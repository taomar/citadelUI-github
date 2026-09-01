# Local Release and Offline Operation

The base Node image is pinned by digest in `Dockerfile`, `compose.yaml`, and
`container.env.example`.

## Build and inspect

```powershell
docker compose build --pull
docker image inspect citadel-ui:local
docker compose config
```

`scripts\release.ps1` builds with BuildKit provenance and SBOM attestations,
exports an offline Docker archive and checksums, and optionally signs the release
descriptor with an Ed25519 `-SigningKey <user-owned-private-key>`. Distribute the
generated public key through an independently trusted channel.

## Offline archive

After building and verifying the image:

```powershell
New-Item -ItemType Directory -Force .release | Out-Null
docker save --output .release\citadel-ui-local.tar citadel-ui:local
Get-FileHash .release\citadel-ui-local.tar -Algorithm SHA256 |
  Format-List | Out-File .release\SHA256SUMS.txt
```

On an offline workstation:

```powershell
Get-FileHash .\citadel-ui-local.tar -Algorithm SHA256
docker load --input .\citadel-ui-local.tar
docker compose up --detach --no-build
```

Runtime operation needs no registry or Internet access. The browser communicates
only with `127.0.0.1:4173`; the application has no outbound runtime integration.

Store archives, signatures, attestations, SBOMs, and checksums outside the source
repository. Never package `/data`, browser profiles, Citadel repositories,
credentials, or local logs.
