#requires -Version 7.4
<#
.SYNOPSIS
  Approved private-network provision/build/push/deploy, executed on the Linux VM.
.DESCRIPTION
  Called by protected-transfer.ps1 -Execute -Deploy after source SHA verification.
  Uses only the VM's dedicated managed identity. No cloud credentials are copied
  in, no Entra container-login is configured, and no shared setting is repaired.
  The existing azd postprovision hook preserves/initializes the KV credential key.
  azd up/remoteBuild alone is NOT a supported private-ACR build path.

  azd 1.33.0 deploy --from-package accepts a fully qualified remote image; its
  service graph skips packaging, and containerAppTarget.Publish skips pushing.
  See Azure/azure-dev tag azure-dev-cli_1.33.0, internal/cmd/service_graph.go and
  pkg/project/service_target_containerapp.go. Use the immutable digest, not a tag.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceDirectory,
  [Parameter(Mandatory)][string]$ContractPath,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$SourceSha256
)
. (Join-Path $PSScriptRoot 'protected-common.ps1')
if (-not $IsLinux) { throw 'The protected runner operation must run on the staged Linux VM.' }
if ((Invoke-ProtectedNative id @('-u') 'Check runner user') -ne '0') { throw 'The private build operation requires root.' }
$root = '/var/lib/citadel-protected'
$expectedSource = "$root/sources/$SourceSha256/CitadelUI"
$expectedContract = "$root/transfers/$SourceSha256/contract.json"
if ($SourceDirectory -cne $expectedSource -or $ContractPath -cne $expectedContract) {
  throw 'Use the content-addressed source/contract paths produced by protected-transfer.ps1.'
}
$contract = [IO.File]::ReadAllText($ContractPath) | ConvertFrom-Json
Assert-ProtectedContract $contract
$s = $contract.selectors
$manifest = [IO.File]::ReadAllText("$root/transfers/$SourceSha256/source-manifest.json") | ConvertFrom-Json
if ($manifest.sourceSha256 -cne $SourceSha256) { throw 'Unexpected source manifest.' }
foreach ($file in $manifest.files) {
  if ($file.path -cnotmatch '^CitadelUI/(Dockerfile|\.dockerignore|README\.md|azure\.yaml|(?:server|shared|web|infra|scripts)/[A-Za-z0-9_./-]+)$' -or
      $file.path.Split('/') -contains '..') { throw 'Unsafe source manifest path.' }
  $path = "$root/sources/$SourceSha256/$($file.path)"
  if ((Get-Item -LiteralPath $path -Force).LinkType -or
      (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) {
    throw 'The transferred source has changed; refusing provision/build.'
  }
}

# A single writer to azd state and the existing Azure Files share.
$lock = [IO.File]::Open("$root/deploy.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$dockerConfig = $null
try {
  $env:HOME = "$root/home"
  $env:AZURE_CONFIG_DIR = "$root/azure-cli"
  $env:AZD_CONFIG_DIR = "$root/azd-config"
  $env:AZD_BICEP_TOOL_PATH = '/usr/local/bin/bicep'
  $env:AZURE_CORE_COLLECT_TELEMETRY = 'no'
  $env:AZURE_DEV_COLLECT_TELEMETRY = 'no'
  $env:AZD_COLLECT_TELEMETRY = 'no'
  $env:AZD_NON_INTERACTIVE = 'true'
  $env:AZURE_CORE_ONLY_SHOW_ERRORS = 'true'
  $env:DOCKER_BUILDKIT = '1'
  foreach ($directory in @($env:HOME, $env:AZURE_CONFIG_DIR, $env:AZD_CONFIG_DIR, "$root/state")) {
    [void][IO.Directory]::CreateDirectory($directory)
    $null = Invoke-ProtectedNative chmod @('700', $directory) 'Restrict private deployment state'
  }
  $null = Invoke-ProtectedNative az @(
    'login', '--identity', '--client-id', $contract.runnerClientId, '--output', 'none', '--only-show-errors'
  ) 'Sign in with runner managed identity'
  $null = Invoke-ProtectedNative az @('account', 'set', '--subscription', $s.AZURE_SUBSCRIPTION_ID) 'Select protected subscription'
  # The source-controlled parameter hook uses az bicep; azd uses its own tool
  # override. Point BOTH at the reviewed compiler installed by bootstrap.
  $null = Invoke-ProtectedNative az @('config', 'set', 'bicep.use_binary_from_path=true', '--only-show-errors') 'Select pinned Azure CLI Bicep'
  $account = (Invoke-ProtectedNative az @('account', 'show', '--output', 'json', '--only-show-errors') 'Verify runner subscription') | ConvertFrom-Json
  if ($account.id -ne $s.AZURE_SUBSCRIPTION_ID -or $account.environmentName -ne 'AzureCloud') { throw 'Unexpected runner subscription/cloud.' }
  $null = Invoke-ProtectedNative azd @('config', 'set', 'auth.useAzCliAuth', 'true') 'Delegate azd authentication to Azure CLI'
  if ((Invoke-ProtectedNative azd @('version') 'Check azd') -notlike 'azd version 1.33.0 *') { throw 'Use the reviewed azd 1.33.0 toolchain.' }

  # Group existence is a prerequisite, not permission to create arbitrary groups.
  $platform = (Invoke-ProtectedNative az @(
    'group', 'show', '--name', $contract.platformResourceGroup, '--output', 'json', '--only-show-errors'
  ) 'Read platform ownership marker') | ConvertFrom-Json -AsHashtable
  if ($platform.tags['citadel-protected-stage'] -cne $s.AZURE_ENV_NAME -or
      $platform.tags['citadel-ui-target'] -cne $s.AZURE_RESOURCE_GROUP) { throw 'The platform ownership marker does not match this UI target.' }
  $group = (Invoke-ProtectedNative az @(
    'group', 'show', '--name', $s.AZURE_RESOURCE_GROUP, '--output', 'json', '--only-show-errors'
  ) 'Verify precreated UI target group') | ConvertFrom-Json -AsHashtable
  if ($group.location -cne $s.AZURE_LOCATION -or $group.tags.SecurityControl -cne 'Ignore') {
    throw 'The UI target group must be precreated with the approved location and SMB policy prerequisite.'
  }

  function Read-ProtectedResource([string]$Type, [string]$Name, [string]$ApiVersion) {
    return ((Invoke-ProtectedNative az @(
      'resource', 'show', '--resource-type', $Type, '--name', $Name,
      '--resource-group', $contract.platformResourceGroup, '--subscription', $s.AZURE_SUBSCRIPTION_ID,
      '--api-version', $ApiVersion, '--output', 'json', '--only-show-errors'
    ) 'Read protected service baseline') | ConvertFrom-Json)
  }
  $registryState = (Read-ProtectedResource 'Microsoft.ContainerRegistry/registries' $s.AZURE_EXISTING_CONTAINER_REGISTRY_NAME '2025-11-01').properties
  if ($registryState.publicNetworkAccess -cne 'Disabled' -or $registryState.networkRuleSet.defaultAction -cne 'Deny' -or
      $registryState.networkRuleBypassOptions -cne 'None' -or $registryState.adminUserEnabled -ne $false -or
      $registryState.roleAssignmentMode -cne 'LegacyRegistryPermissions' -or
      $registryState.policies.azureADAuthenticationAsArmPolicy.status -cne 'enabled') {
    throw 'The registry no longer matches the approved protected baseline. No settings will be repaired.'
  }
  $vaultState = (Read-ProtectedResource 'Microsoft.KeyVault/vaults' $s.AZURE_KEY_VAULT_NAME '2023-07-01').properties
  if ($vaultState.publicNetworkAccess -cne 'Disabled' -or $vaultState.networkAcls.defaultAction -cne 'Deny' -or
      $vaultState.networkAcls.bypass -cne 'None' -or $vaultState.enableRbacAuthorization -ne $true) {
    throw 'The vault no longer matches the approved protected baseline. No settings will be repaired.'
  }
  $storageState = (Read-ProtectedResource 'Microsoft.Storage/storageAccounts' $s.AZURE_EXISTING_STORAGE_ACCOUNT_NAME '2023-05-01').properties
  if ($storageState.publicNetworkAccess -cne 'Disabled' -or $storageState.networkAcls.defaultAction -cne 'Deny' -or
      $storageState.networkAcls.bypass -cne 'None' -or $storageState.allowSharedKeyAccess -ne $true -or
      $storageState.allowBlobPublicAccess -ne $false) {
    throw 'The storage account no longer matches the approved private SMB baseline. No settings/keys will be repaired.'
  }
  $environmentState = (Read-ProtectedResource 'Microsoft.App/managedEnvironments' $s.AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME '2025-07-01').properties
  if ($environmentState.vnetConfiguration.internal -ne $true -or $environmentState.publicNetworkAccess -cne 'Disabled' -or
      $environmentState.appLogsConfiguration.destination -cne 'azure-monitor') {
    throw 'The environment no longer matches the internal/azure-monitor baseline. Its network/logging will not be changed.'
  }
  $workspaceName = $contract.workspaceResourceId.Split('/')[-1]
  $workspaceState = (Read-ProtectedResource 'Microsoft.OperationalInsights/workspaces' $workspaceName '2023-09-01').properties
  if ($workspaceState.publicNetworkAccessForIngestion -cne 'Disabled' -or $workspaceState.publicNetworkAccessForQuery -cne 'Disabled') {
    throw 'The Log Analytics workspace no longer has public ingestion/query disabled. No settings will be repaired.'
  }

  # Tiny fail-closed connectivity check, not an acceptance/test harness.
  function Assert-PrivateDns([string]$HostName) {
    $addresses = @([Net.Dns]::GetHostAddresses($HostName))
    if (-not $addresses.Count) { throw 'Private DNS lookup returned no addresses.' }
    foreach ($address in $addresses) {
      $bytes = $address.GetAddressBytes()
      if ($bytes.Length -ne 4 -or -not (
          $bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
          ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) {
        throw "A protected endpoint resolved outside RFC1918 space: $HostName. Do not enable public access."
      }
    }
  }
  foreach ($hostname in @(
    $contract.registryLoginServer,
    "$($s.AZURE_EXISTING_CONTAINER_REGISTRY_NAME).$($s.AZURE_LOCATION).data.azurecr.io",
    "$($s.AZURE_KEY_VAULT_NAME).vault.azure.net",
    "$($s.AZURE_EXISTING_STORAGE_ACCOUNT_NAME).file.core.windows.net",
    'api.loganalytics.io'
  )) { Assert-PrivateDns $hostname }
  if ($contract.evidenceContainerName) { Assert-PrivateDns "$($s.AZURE_EXISTING_STORAGE_ACCOUNT_NAME).blob.core.windows.net" }

  Set-Location -LiteralPath $SourceDirectory
  $forbidden = @(
    'AZURE_INFRASTRUCTURE_SUBNET_ID', 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME',
    'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP', 'AZURE_AUTH_CLIENT_ID', 'AZURE_AUTH_CLIENT_SECRET'
  )
  foreach ($key in $forbidden) {
    if ([Environment]::GetEnvironmentVariable($key)) { throw "Remove forbidden inherited input $key before this private deployment." }
  }
  foreach ($property in $s.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, $property.Value) }
  # Keep azd state (including the prior immutable image) across source releases.
  $state = "$root/state/$($s.AZURE_ENV_NAME)"
  [void][IO.Directory]::CreateDirectory("$state/.azure")
  $azdLink = Join-Path $SourceDirectory '.azure'
  if (Test-Path -LiteralPath $azdLink) {
    if ((Get-Item -LiteralPath $azdLink -Force).Target -cne "$state/.azure") { throw 'Unexpected azd state path; refusing to replace it.' }
  } else {
    $null = New-Item -ItemType SymbolicLink -Path $azdLink -Target "$state/.azure"
  }
  if (Test-Path -LiteralPath "$state/.azure/$($s.AZURE_ENV_NAME)/.env") {
    $null = Invoke-ProtectedNative azd @('env', 'select', $s.AZURE_ENV_NAME, '--no-prompt') 'Select existing private azd state'
    $existing = (Invoke-ProtectedNative azd @('env', 'get-values', '--output', 'json') 'Read existing azd input metadata') | ConvertFrom-Json -AsHashtable
    foreach ($key in $forbidden) { if ($existing[$key]) { throw "Existing azd state contains forbidden override $key." } }
    foreach ($property in $s.PSObject.Properties) {
      if ($existing[$property.Name] -and $existing[$property.Name] -cne $property.Value) {
        throw "Existing azd selector $($property.Name) differs; refusing a change of shared resource/state ownership."
      }
    }
  } else {
    $null = Invoke-ProtectedNative azd @(
      'env', 'new', $s.AZURE_ENV_NAME, '--subscription', $s.AZURE_SUBSCRIPTION_ID, '--location', $s.AZURE_LOCATION, '--no-prompt'
    ) 'Create private azd environment state'
  }
  foreach ($property in $s.PSObject.Properties) {
    $null = Invoke-ProtectedNative azd @('env', 'set', $property.Name, $property.Value) "Record $($property.Name)"
  }

  # A source-controlled main.bicepparam can override environment values. Inspect
  # the evaluated file BEFORE its parent-owned preprovision hook synchronizes it,
  # so a literal override cannot turn this path into fresh/public provisioning.
  if (Test-Path -LiteralPath 'infra/main.bicepparam') {
    $saved = (Invoke-ProtectedNative azd @('env', 'get-values', '--output', 'json') 'Read private azd deployment context') | ConvertFrom-Json -AsHashtable
    [Environment]::SetEnvironmentVariable('SERVICE_CITADELUI_IMAGE_NAME', [string]$saved['SERVICE_CITADELUI_IMAGE_NAME'])
    $evaluated = (Invoke-ProtectedNative az @(
      'bicep', 'build-params', '--file', 'infra/main.bicepparam', '--stdout', '--only-show-errors'
    ) 'Evaluate protected source-controlled parameters') | ConvertFrom-Json -AsHashtable
    if ($evaluated.Contains('parametersJson')) { $evaluated = $evaluated.parametersJson | ConvertFrom-Json -AsHashtable }
    $mapping = [IO.File]::ReadAllText((Join-Path $SourceDirectory 'infra/main.parameters.json')) | ConvertFrom-Json -AsHashtable
    foreach ($name in $mapping.parameters.Keys) {
      $match = [regex]::Match($mapping.parameters[$name].value, '^\$\{([A-Z][A-Z0-9_]*)(?:=[^}]*)?\}$')
      if (-not $match.Success -or -not $evaluated.parameters.Contains($name)) { throw "Unrecognized parameter mapping for $name." }
      $key = $match.Groups[1].Value
      $expected = if ($key -in $forbidden) { '' } else { [Environment]::GetEnvironmentVariable($key) }
      $value = $evaluated.parameters[$name].value
      if ($value -is [bool]) { $value = $value.ToString().ToLowerInvariant() }
      if ([string]$value -cne [string]$expected) {
        throw "infra/main.bicepparam overrides protected selector $key. Keep it bound to the staged environment."
      }
    }
  }

  Write-Host 'Provisioning UI-only resources; the automatic postprovision hook preserves/initializes the credential key.'
  $null = Invoke-ProtectedNative azd @('provision', '--environment', $s.AZURE_ENV_NAME, '--no-prompt') 'Provision private existing-resource UI and credential-key posthook'

  $registry = $s.AZURE_EXISTING_CONTAINER_REGISTRY_NAME
  $repositoryTag = "citadelui:src-$SourceSha256"
  $taggedImage = "$($contract.registryLoginServer)/$repositoryTag"
  $dockerConfig = "$root/docker-auth-$([Guid]::NewGuid().ToString('N'))"
  [void][IO.Directory]::CreateDirectory($dockerConfig)
  $null = Invoke-ProtectedNative chmod @('700', $dockerConfig) 'Restrict short-lived registry auth'
  $env:DOCKER_CONFIG = $dockerConfig
  Write-Host 'Building locally on the private runner (not hosted ACR Tasks).'
  $null = Invoke-ProtectedNative docker @(
    'build', '--platform', 'linux/amd64', '--pull', '--file', 'Dockerfile', '--tag', $taggedImage, '.'
  ) 'Local Docker build using the existing pinned Node image'

  $token = Invoke-ProtectedNative az @(
    'acr', 'login', '--name', $registry, '--subscription', $s.AZURE_SUBSCRIPTION_ID,
    '--expose-token', '--query', 'accessToken', '--output', 'tsv', '--only-show-errors'
  ) 'Get managed-identity registry token'
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'No managed-identity registry token was returned.' }
  try {
    $null = @($token | docker login $contract.registryLoginServer --username '00000000-0000-0000-0000-000000000000' --password-stdin 2>&1)
    if ($LASTEXITCODE -ne 0) { throw 'Private registry Docker login failed. No public-access/admin fallback is allowed.' }
  } finally { Remove-Variable token }
  $null = Invoke-ProtectedNative docker @('push', $taggedImage) 'Push local image to private ACR'
  $digest = Invoke-ProtectedNative az @(
    'acr', 'repository', 'show', '--name', $registry, '--image', $repositoryTag,
    '--subscription', $s.AZURE_SUBSCRIPTION_ID, '--query', 'digest', '--output', 'tsv', '--only-show-errors'
  ) 'Resolve pushed registry digest'
  if ($digest -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'Registry returned an invalid immutable image digest.' }
  $immutableImage = "$($contract.registryLoginServer)/citadelui@$digest"
  # Record BEFORE deploy, so the next provision cannot restore the bootstrap.
  $null = Invoke-ProtectedNative azd @('env', 'set', 'SERVICE_CITADELUI_IMAGE_NAME', $immutableImage) 'Record immutable UI image'
  $null = Invoke-ProtectedNative azd @(
    'deploy', 'citadelui', '--from-package', $immutableImage, '--environment', $s.AZURE_ENV_NAME, '--no-prompt'
  ) 'Deploy immutable prebuilt image without remoteBuild'
  $recorded = Invoke-ProtectedNative azd @('env', 'get-value', 'SERVICE_CITADELUI_IMAGE_NAME') 'Verify recorded image'
  if ($recorded -cne $immutableImage) { throw 'azd did not retain the immutable image selection.' }
  Write-ProtectedJson "$state/last-deployment.json" @{
    sourceSha256 = $SourceSha256
    image = $immutableImage
    uiResourceGroup = $s.AZURE_RESOURCE_GROUP
    completedUtc = [DateTimeOffset]::UtcNow.ToString('O')
  }
  Write-Host "Private deployment completed: $immutableImage"
  Write-Host 'HTTP/state/key preservation, private DNS, diagnostic delivery and before/after baseline acceptance are not yet claimed.'
} finally {
  if ($dockerConfig -and (Test-Path -LiteralPath $dockerConfig)) {
    # Only our per-invocation, root-only token directory; not shared Docker state.
    Remove-Item -LiteralPath $dockerConfig -Recurse -Force
  }
  Remove-Item Env:DOCKER_CONFIG -ErrorAction SilentlyContinue
  $lock.Dispose()
}
