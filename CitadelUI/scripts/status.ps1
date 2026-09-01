$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'container.env'
$compose = @('compose', '--project-directory', $root, '--file', (Join-Path $root 'compose.yaml'))
if (Test-Path $envFile) { $compose += @('--env-file', $envFile) }
docker @compose ps
