<#
.SYNOPSIS
  Read-only checks for Citadel UI deployment inputs and existing resources.

.DESCRIPTION
  Called before ensure-resource-group.ps1 creates or tags anything. Uses only
  Azure CLI management-plane reads; never changes a shared resource, requests
  workspace/storage keys or registry credentials, or needs Node. For a standalone check, export the
  AZURE_* inputs into the process first; azd does that for the hook automatically.
#>
$ErrorActionPreference = 'Stop'

function Stop-Preflight([string] $Message) {
  Write-Error "Deployment preflight: $Message" -ErrorAction Continue
  exit 1
}

function Get-Input([string] $Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $value) { return '' }
  if ($value -ne $value.Trim()) {
    Stop-Preflight "$Name must not have leading or trailing whitespace."
  }
  return $value
}

$deploymentGroup = Get-Input 'AZURE_RESOURCE_GROUP'
$environmentName = Get-Input 'AZURE_ENV_NAME'
$location = Get-Input 'AZURE_LOCATION'
$subscription = Get-Input 'AZURE_SUBSCRIPTION_ID'
$existingEnvironment = Get-Input 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME'
$environmentGroup = Get-Input 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP'
$existingWorkspace = Get-Input 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME'
$workspaceGroup = Get-Input 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP'
$existingRegistry = Get-Input 'AZURE_EXISTING_CONTAINER_REGISTRY_NAME'
$registryGroup = Get-Input 'AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP'
$existingStorage = Get-Input 'AZURE_EXISTING_STORAGE_ACCOUNT_NAME'
$storageGroup = Get-Input 'AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP'
$existingShare = Get-Input 'AZURE_EXISTING_FILE_SHARE_NAME'
$existingIdentity = Get-Input 'AZURE_EXISTING_MANAGED_IDENTITY_NAME'
$identityGroup = Get-Input 'AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP'
$privateDeployment = Get-Input 'CITADEL_PRIVATE_DEPLOYMENT'
if (-not $privateDeployment) { $privateDeployment = 'false' }
$principalType = Get-Input 'AZURE_PRINCIPAL_TYPE'
$subnet = Get-Input 'AZURE_INFRASTRUCTURE_SUBNET_ID'
$vault = Get-Input 'AZURE_KEY_VAULT_NAME'
$vaultGroup = Get-Input 'AZURE_KEY_VAULT_RESOURCE_GROUP'

# Reject conflicts locally, even before azd records a default resource group.
if ($environmentGroup -and -not $existingEnvironment) {
  Stop-Preflight 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP requires AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME.'
}
if ($workspaceGroup -and -not $existingWorkspace) {
  Stop-Preflight 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP requires AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME.'
}
if ($registryGroup -and -not $existingRegistry) {
  Stop-Preflight 'AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP requires AZURE_EXISTING_CONTAINER_REGISTRY_NAME.'
}
if ($storageGroup -and -not $existingStorage) {
  Stop-Preflight 'AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME.'
}
if ($existingShare -and -not $existingStorage) {
  Stop-Preflight 'AZURE_EXISTING_FILE_SHARE_NAME requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME.'
}
if ($identityGroup -and -not $existingIdentity) {
  Stop-Preflight 'AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP requires AZURE_EXISTING_MANAGED_IDENTITY_NAME.'
}
if (@('true', 'false') -cnotcontains $privateDeployment) {
  Stop-Preflight 'CITADEL_PRIVATE_DEPLOYMENT must be true or false.'
}
if ($principalType -and @('User', 'ServicePrincipal', 'Group') -cnotcontains $principalType) {
  Stop-Preflight 'AZURE_PRINCIPAL_TYPE must be User, ServicePrincipal or Group.'
}
if ($existingEnvironment -and $subnet) {
  Stop-Preflight 'AZURE_INFRASTRUCTURE_SUBNET_ID cannot be combined with an existing Container Apps environment; validate its subnet separately and omit this input.'
}
if ($existingEnvironment -and $existingWorkspace) {
  Stop-Preflight 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME cannot be combined with an existing Container Apps environment; validate its logging separately and omit both workspace inputs.'
}
if (-not $location) { Stop-Preflight 'AZURE_LOCATION is not set.' }
if (-not $deploymentGroup) {
  if (-not $environmentName) {
    Stop-Preflight 'Neither AZURE_RESOURCE_GROUP nor AZURE_ENV_NAME is set.'
  }
  $deploymentGroup = "rg-$environmentName"
}
if (-not $environmentGroup) { $environmentGroup = $deploymentGroup }
if (-not $workspaceGroup) { $workspaceGroup = $deploymentGroup }
if (-not $registryGroup) { $registryGroup = $deploymentGroup }
if (-not $storageGroup) { $storageGroup = $deploymentGroup }
if (-not $identityGroup) { $identityGroup = $deploymentGroup }
if (-not $vaultGroup) { $vaultGroup = $deploymentGroup }

function Read-ExistingResource([string] $Type, [string] $Name, [string] $Group, [string] $ApiVersion) {
  $cliArgs = @(
    'resource', 'show', '--resource-type', $Type, '--name', $Name,
    '--resource-group', $Group, '--api-version', $ApiVersion,
    '--only-show-errors', '--output', 'json'
  )
  if ($subscription) { $cliArgs += @('--subscription', $subscription) }
  $result = az @cliArgs
  if ($LASTEXITCODE -ne 0) {
    Stop-Preflight "Cannot read existing $Type '$Name' in resource group '$Group'. Check the selected subscription, name, group and management-plane read permission."
  }
  try { return ($result | ConvertFrom-Json) }
  catch { Stop-Preflight "Azure CLI returned an invalid resource response for $Type '$Name'." }
}

function Read-ExistingResourceById([string] $ResourceId, [string] $ApiVersion) {
  $result = az resource show --ids $ResourceId --api-version $ApiVersion --only-show-errors --output json
  if ($LASTEXITCODE -ne 0) {
    Stop-Preflight "Cannot read existing resource '$ResourceId'. Check its ID and management-plane read permission."
  }
  try { return ($result | ConvertFrom-Json) }
  catch { Stop-Preflight 'Azure CLI returned an invalid resource response.' }
}

# Resolve only when an absolute child-resource ID needs the subscription. azd
# normally supplies it. This fallback reads CLI context; it does not change it.
if (-not $subscription -and ($subnet -or $existingShare)) {
  $subscription = az account show --query id --only-show-errors --output tsv
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($subscription)) {
    Stop-Preflight 'Set AZURE_SUBSCRIPTION_ID or select an Azure CLI subscription before resource reuse.'
  }
}

if ($subnet) {
  $subnetMatch = [regex]::Match($subnet, '(?i)^(/subscriptions/([0-9a-f-]{36})/resourceGroups/[^/]+/providers/Microsoft\.Network/virtualNetworks/[^/]+)/subnets/[^/]+$')
  if (-not $subnetMatch.Success) {
    Stop-Preflight 'AZURE_INFRASTRUCTURE_SUBNET_ID must be a complete subnet resource ID.'
  }
  if ($subnetMatch.Groups[2].Value -ne $subscription) {
    Stop-Preflight 'AZURE_INFRASTRUCTURE_SUBNET_ID must be in the deployment subscription.'
  }
  $network = Read-ExistingResourceById $subnetMatch.Groups[1].Value '2024-05-01'
  if (([string]$network.location).Replace(' ', '').ToLowerInvariant() -ne $location.Replace(' ', '').ToLowerInvariant()) {
    Stop-Preflight 'AZURE_LOCATION must match the existing subnet VNet region.'
  }
  $resource = Read-ExistingResourceById $subnet '2024-05-01'
  if ($resource.properties.provisioningState -ne 'Succeeded') {
    Stop-Preflight 'The existing subnet must be Succeeded.'
  }
  # Existing-environment/subnet combinations were rejected above. These checks
  # apply only when creating a new environment in the selected existing subnet.
  if (-not $existingEnvironment) {
    $prefixes = @($resource.properties.addressPrefixes | Where-Object { $_ })
    if ($resource.properties.addressPrefix) { $prefixes += $resource.properties.addressPrefix }
    if ($prefixes.Count -ne 1) {
      Stop-Preflight 'The existing subnet must have one IPv4 prefix of /27 or larger.'
    }
    $prefix = [string]$prefixes[0]
    $address = $null
    if ($prefix -notmatch '^(\d{1,3}\.){3}\d{1,3}/\d{1,2}$' -or
        -not [Net.IPAddress]::TryParse($prefix.Split('/')[0], [ref]$address) -or
        [int]$prefix.Split('/')[1] -gt 27) {
      Stop-Preflight 'The existing subnet must have one IPv4 prefix of /27 or larger.'
    }
    $delegations = @($resource.properties.delegations | Where-Object { $null -ne $_ })
    if ($delegations.Count -ne 1 -or -not ($delegations | Where-Object {
        $_.properties.serviceName -eq 'Microsoft.App/environments' -or $_.serviceName -eq 'Microsoft.App/environments'
      })) {
      Stop-Preflight 'The existing subnet must already be delegated only to Microsoft.App/environments. No delegation will be changed.'
    }
    if (@($resource.properties.serviceAssociationLinks | Where-Object { $null -ne $_ }).Count -or
        @($resource.properties.ipConfigurations | Where-Object { $null -ne $_ }).Count -or
        @($resource.properties.privateEndpoints | Where-Object { $null -ne $_ }).Count) {
      Stop-Preflight 'The existing subnet must be dedicated and unused by another environment or workload. Select the existing environment instead of reusing its occupied subnet.'
    }
    Write-Warning 'Existing subnet/VNet configuration is unchanged. Provide private DNS for the new environment domain plus client connectivity and required outbound network access; no DNS, peering or firewall changes are made to this VNet.'
  }
}

if ($existingEnvironment) {
  $resource = Read-ExistingResource 'Microsoft.App/managedEnvironments' $existingEnvironment $environmentGroup '2025-07-01'
  $actualLocation = ([string]$resource.location).Replace(' ', '').ToLowerInvariant()
  $requestedLocation = $location.Replace(' ', '').ToLowerInvariant()
  if ($actualLocation -ne $requestedLocation) {
    Stop-Preflight 'AZURE_LOCATION must match the existing Container Apps environment region.'
  }
  if ($resource.properties.provisioningState -ne 'Succeeded' -or
      [string]::IsNullOrWhiteSpace($resource.properties.defaultDomain)) {
    Stop-Preflight 'The existing Container Apps environment must be Succeeded and have a defaultDomain.'
  }
  if ($privateDeployment -eq 'true' -and $resource.properties.vnetConfiguration.internal -ne $true) {
    Stop-Preflight 'CITADEL_PRIVATE_DEPLOYMENT=true requires an internal existing Container Apps environment; its network will not be changed.'
  }
  $profiles = @($resource.properties.workloadProfiles | Where-Object { $null -ne $_ })
  if ($profiles.Count -gt 0 -and -not ($profiles | Where-Object {
      $_.name -eq 'Consumption' -and $_.workloadProfileType -eq 'Consumption'
    })) {
    Stop-Preflight 'The existing environment must have a Consumption workload profile named Consumption, or be a legacy consumption-only environment. No profiles will be added.'
  }
}

if ($existingStorage) {
  $resource = Read-ExistingResource 'Microsoft.Storage/storageAccounts' $existingStorage $storageGroup '2023-05-01'
  if ($resource.properties.provisioningState -ne 'Succeeded' -or
      @('Storage', 'StorageV2', 'FileStorage') -notcontains $resource.kind -or
      [string]::IsNullOrWhiteSpace($resource.properties.primaryEndpoints.file)) {
    Stop-Preflight 'The existing storage account must be Succeeded and support Azure Files SMB.'
  }
  if ($resource.properties.allowSharedKeyAccess -eq $false) {
    Stop-Preflight 'The existing storage account disables shared-key access required by the Azure Files mount. No account policy will be changed.'
  }
  if ($resource.properties.publicNetworkAccess -eq 'Disabled' -or $resource.properties.networkAcls.defaultAction -eq 'Deny') {
    Write-Warning 'Existing storage network restrictions are preserved. The Container Apps environment must already have DNS/SMB access; no firewall, private endpoint or policy bypass is configured.'
  }
  if ($existingShare) {
    $shareId = "/subscriptions/$subscription/resourceGroups/$storageGroup/providers/Microsoft.Storage/storageAccounts/$existingStorage/fileServices/default/shares/$existingShare"
    $share = Read-ExistingResourceById $shareId '2023-05-01'
    if ($share.properties.enabledProtocols -and $share.properties.enabledProtocols -ne 'SMB') {
      Stop-Preflight 'The existing Azure Files share must use SMB; NFS shares cannot use this key-based binding.'
    }
    Write-Warning 'Reusing the named share without changing its data or owner. It must be dedicated Citadel UI state with no concurrent writer; preserve the matching Key Vault credential-secret name and key.'
  } else {
    Write-Warning 'No file-share selector: a new deterministic UI-specific share will be created in the existing account. Set AZURE_EXISTING_FILE_SHARE_NAME to retain an existing UI share and its owner/data.'
  }
}

if ($existingIdentity) {
  $resource = Read-ExistingResource 'Microsoft.ManagedIdentity/userAssignedIdentities' $existingIdentity $identityGroup '2023-01-31'
  if ([string]::IsNullOrWhiteSpace($resource.properties.clientId) -or
      [string]::IsNullOrWhiteSpace($resource.properties.principalId)) {
    Stop-Preflight 'The existing managed identity must have clientId and principalId. No identity will be recreated or reconfigured.'
  }
}

if ($existingWorkspace) {
  $resource = Read-ExistingResource 'Microsoft.OperationalInsights/workspaces' $existingWorkspace $workspaceGroup '2023-09-01'
  if ([string]::IsNullOrWhiteSpace($resource.properties.customerId)) {
    Stop-Preflight 'The existing Log Analytics workspace must have a customerId.'
  }
  if ($resource.properties.features.disableLocalAuth -eq $true) {
    Stop-Preflight 'The existing Log Analytics workspace disables shared-key authentication, which Container Apps log ingestion requires. Choose a compatible workspace; preflight will not change it.'
  }
  # New environments need keys later, not during preflight. Existing-environment
  # logging is owned externally and its workspace selectors must be omitted.
}

if ($existingRegistry) {
  $resource = Read-ExistingResource 'Microsoft.ContainerRegistry/registries' $existingRegistry $registryGroup '2025-11-01'
  if ($resource.properties.provisioningState -ne 'Succeeded' -or
      [string]::IsNullOrWhiteSpace($resource.properties.loginServer)) {
    Stop-Preflight 'The existing registry must be Succeeded and have a loginServer.'
  }
  $mode = $resource.properties.roleAssignmentMode
  if ($null -eq $mode) { $mode = 'LegacyRegistryPermissions' }
  if (@('LegacyRegistryPermissions', 'AbacRepositoryPermissions') -cnotcontains $mode) {
    Stop-Preflight 'Unsupported registry roleAssignmentMode. Expected LegacyRegistryPermissions or AbacRepositoryPermissions.'
  }
  if ($resource.properties.policies.azureADAuthenticationAsArmPolicy.status -ne 'enabled') {
    Stop-Preflight 'The existing registry must allow ARM audience tokens (azureADAuthenticationAsArmPolicy.status=enabled) for Container Apps managed-identity image pull. Choose a compatible registry; preflight will not change its authentication policy.'
  }
  if ($mode -eq 'AbacRepositoryPermissions') {
    Write-Warning 'ABAC registry: quick builds require az acr build --source-acr-auth-id "[caller]" and Repository Writer plus Tasks Contributor. Do not assume your azd remoteBuild version supplies caller source authentication; use the explicit CLI build/update flow when it does not.'
  }
  if ($resource.properties.publicNetworkAccess -eq 'Disabled' -or
      $resource.properties.networkRuleSet.defaultAction -eq 'Deny') {
    Write-Warning 'Registry network restrictions are preserved. The operator, build worker and Container App need existing DNS/network access; no firewall, private endpoint, trusted-service bypass or admin-account changes are made.'
  }
}

if ($vault) {
  $resource = Read-ExistingResource 'Microsoft.KeyVault/vaults' $vault $vaultGroup '2023-07-01'
  if ($resource.properties.enableRbacAuthorization -ne $true) {
    Stop-Preflight 'The existing Key Vault must use Azure RBAC (enableRbacAuthorization=true). This deployment only adds the app Secrets User role; it never changes vault access policies or networking.'
  }
}

Write-Host 'Deployment preflight passed. Existing resources were read, not modified; data-plane permissions and network reachability must also be provided.'
exit 0
