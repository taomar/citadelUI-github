$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'sync-deployment-parameters.ps1')
if (-not $?) { exit 1 }
& (Join-Path $PSScriptRoot 'ensure-resource-group.ps1')
if (-not $?) { exit 1 }
