# Local Release and Offline Operation

This documentation describes application source
`4379522cdf0dbc8048bf45e0dbe0db2aa42cd358`, including native Bicep/Terraform
workspaces and timed `/debug` capture. At this documentation revision these
changes are accepted locally, not published on GitHub `main`. An older clone,
the image's `1.0.0-local` label, or a reused image tag does not identify that
source. Obtain a reviewed checkout or immutable image from the release operator.

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
