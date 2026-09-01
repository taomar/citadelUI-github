param(
  [string]$OutputDirectory,
  [string]$Image = 'citadel-ui:local',
  [string]$SigningKey
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $root '.release' }
New-Item -ItemType Directory -Force -Path $output | Out-Null

$metadata = Join-Path $output 'build-metadata.json'
docker buildx build `
  --load `
  --provenance=mode=max `
  --sbom=true `
  --metadata-file $metadata `
  --tag $Image `
  $root

$descriptor = [ordered]@{
  image = $Image
  imageId = docker image inspect $Image --format '{{.Id}}'
  baseImage = 'node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
}
$descriptorPath = Join-Path $output 'release-descriptor.json'
$descriptor | ConvertTo-Json | Set-Content -Encoding utf8NoBOM $descriptorPath

$archive = Join-Path $output 'citadel-ui-local.tar'
docker save --output $archive $Image
$archiveHash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
"$archiveHash  citadel-ui-local.tar" | Set-Content -Encoding ascii (Join-Path $output 'SHA256SUMS.txt')

try {
  docker scout sbom $Image --format spdx --output (Join-Path $output 'sbom.spdx.json')
} catch {
  Write-Warning 'docker scout sbom is unavailable; use the BuildKit SBOM attestation recorded in build metadata.'
}

if ($SigningKey) {
  node (Join-Path $PSScriptRoot 'sign-release.mjs') `
    $descriptorPath `
    $SigningKey `
    (Join-Path $output 'release-descriptor.sig') `
    (Join-Path $output 'release-public-key.pem')
}

Write-Host "Release artifacts written to $output"
