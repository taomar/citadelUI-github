#Requires -Version 7.4
param([string]$ImageReference)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path -Parent $PSScriptRoot

function Get-DeploymentValue([string]$Name) {
    $value = azd env get-value $Name --cwd $root
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($value | Out-String))) {
        throw "Missing $Name. Select or refresh the original azd environment first."
    }
    return ($value | Out-String).Trim()
}

$subscription = Get-DeploymentValue 'AZURE_SUBSCRIPTION_ID'
$resourceGroup = Get-DeploymentValue 'AZURE_RESOURCE_GROUP'
$registryName = Get-DeploymentValue 'AZURE_CONTAINER_REGISTRY_NAME'
$registryGroup = Get-DeploymentValue 'AZURE_CONTAINER_REGISTRY_RESOURCE_GROUP'
$registry = az acr show --subscription $subscription --resource-group $registryGroup --name $registryName --output json --only-show-errors | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($registry.loginServer)) {
    throw 'The selected registry did not return a login server.'
}
$apps = @(az containerapp list --subscription $subscription --resource-group $resourceGroup --output json --only-show-errors |
    ConvertFrom-Json | Where-Object { $_.tags.'azd-service-name' -eq 'citadelui' })
if ($apps.Count -ne 1) { throw 'Expected exactly one Citadel UI app in the selected azd resource group.' }
$app = $apps[0]
$containers = @($app.properties.template.containers | Where-Object { $_.name -eq 'citadelui' })
if ($containers.Count -ne 1 -or $containers[0].env.name -notcontains 'CITADEL_DATA_ROOT' -or
    $app.properties.configuration.registries.server -notcontains $registry.loginServer) {
    throw 'The selected app is not a Citadel UI deployment configured for this registry.'
}

if (-not $ImageReference) {
    if ($registry.publicNetworkAccess -eq 'Disabled' -or $registry.networkRuleSet.defaultAction -eq 'Deny') {
        throw 'This registry requires a connected private build host. Build and push there, then pass -ImageReference with its image digest.'
    }
    $commit = git -C $root rev-parse --short HEAD
    $tag = "citadelui:$commit-$(Get-Date -AsUTC -Format yyyyMMddHHmmss)"
    $buildArguments = @(
        'acr', 'build', '--subscription', $subscription, '--resource-group', $registryGroup,
        '--registry', $registryName, '--image', $tag, '--file', 'Dockerfile'
    )
    if ($registry.roleAssignmentMode -eq 'AbacRepositoryPermissions') {
        $buildArguments += @('--source-acr-auth-id', '[caller]')
    } elseif ($registry.roleAssignmentMode -ne 'LegacyRegistryPermissions') {
        throw 'Unrecognized registry permission mode; no image was built or deployed.'
    }
    $buildArguments += $root
    az @buildArguments
    $ImageReference = "$($registry.loginServer)/$tag"
}
if (-not $ImageReference.StartsWith("$($registry.loginServer)/", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The image reference must belong to the selected registry.'
}
azd env set SERVICE_CITADELUI_IMAGE_NAME $ImageReference --cwd $root
az containerapp update --subscription $subscription --resource-group $resourceGroup --name $app.name `
    --container-name citadelui --image $ImageReference --output none --only-show-errors
Write-Host "Deployed the Citadel UI image without reprovisioning its state: https://$($app.properties.configuration.ingress.fqdn)"
