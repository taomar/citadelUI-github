$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'container.env'
$compose = @('compose', '--project-directory', $root, '--file', (Join-Path $root 'compose.yaml'))
if (Test-Path $envFile) { $compose += @('--env-file', $envFile) }
docker @compose up --detach --build --wait --wait-timeout 120
$composeStatus = $LASTEXITCODE
if ($composeStatus -ne 0) {
  Write-Error 'Citadel UI did not become healthy. See the Docker Compose error above.' -ErrorAction Continue
  exit $composeStatus
}
Write-Host 'Citadel UI is available at http://127.0.0.1:4173'
