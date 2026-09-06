<#
.SYNOPSIS
  Loads evaluated Bicep parameter-file inputs into the selected azd environment.
  Called before the resource-group hook so preflight and Bicep use the same values.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$parameterFile = Join-Path $root 'infra/main.bicepparam'
$mappingFile = Join-Path $root 'infra/main.parameters.json'

if (-not $env:AZURE_ENV_NAME -or -not $env:AZURE_LOCATION) {
    throw 'Select an azd environment with a subscription and location before loading deployment parameters.'
}
$compiledText = az bicep build-params --file $parameterFile --stdout --only-show-errors
if ($LASTEXITCODE -ne 0) {
    throw 'Could not compile infra/main.bicepparam. No environment values or Azure resources were changed.'
}
$compiled = ($compiledText | Out-String) | ConvertFrom-Json
if ($compiled.parametersJson) {
    $compiled = $compiled.parametersJson | ConvertFrom-Json
}
if (-not $compiled.parameters) {
    throw 'Bicep did not return evaluated deployment parameters. No environment values were changed.'
}
$parameters = $compiled.parameters
if ($parameters.environmentName.value -cne $env:AZURE_ENV_NAME -or
    $parameters.location.value -cne $env:AZURE_LOCATION) {
    throw 'Leave environmentName and location bound to azd in main.bicepparam; select the deployment context with azd env instead.'
}

$mapping = Get-Content -LiteralPath $mappingFile -Raw | ConvertFrom-Json
$managed = @('environmentName', 'location', 'principalId', 'citadelUiImageName', 'entraAuthClientId', 'entraAuthClientSecret')
$updates = [System.Collections.Generic.List[object]]::new()
foreach ($entry in $mapping.parameters.PSObject.Properties) {
    if ($entry.Name -in $managed) { continue }
    $match = [regex]::Match([string]$entry.Value.value, '^\$\{([A-Z][A-Z0-9_]*)(?:=[^}]*)?\}$')
    $parameter = $parameters.PSObject.Properties[$entry.Name]
    if (-not $match.Success -or $null -eq $parameter -or
        $null -eq $parameter.Value.PSObject.Properties['value']) {
        throw "No supported environment mapping for Bicep parameter '$($entry.Name)'."
    }
    $value = $parameter.Value.value
    if ($value -is [bool]) {
        $value = $value.ToString().ToLowerInvariant()
    } elseif ($value -isnot [string]) {
        throw "Bicep parameter '$($entry.Name)' must evaluate to a string or Boolean."
    }
    $name = $match.Groups[1].Value
    if ([Environment]::GetEnvironmentVariable($name) -cne $value) {
        $updates.Add([pscustomobject]@{ Name = $name; Value = $value })
    }
}

foreach ($update in $updates) {
    azd env set $update.Name $update.Value --environment $env:AZURE_ENV_NAME
    if ($LASTEXITCODE -ne 0) {
        throw "Could not record $($update.Name) in the selected azd environment. No Azure resource changes were attempted."
    }
    [Environment]::SetEnvironmentVariable($update.Name, $update.Value, 'Process')
}
Write-Host "Loaded infra/main.bicepparam into azd environment '$($env:AZURE_ENV_NAME)'."
