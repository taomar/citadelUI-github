$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = if ($env:CITADEL_DATA_PATH) { $env:CITADEL_DATA_PATH } else { Join-Path $root '.data' }
New-Item -ItemType Directory -Force -Path $data | Out-Null
$envFile = Join-Path $root 'container.env'
$compose = @('compose', '--project-directory', $root, '--file', (Join-Path $root 'compose.yaml'))
if (Test-Path $envFile) { $compose += @('--env-file', $envFile) }
docker @compose up --detach --build
Write-Host 'Citadel UI is available at http://127.0.0.1:4173'
