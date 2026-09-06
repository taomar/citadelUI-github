#requires -Version 7.4
<#
.SYNOPSIS
  Compile protected staging locally; create the metered platform ONLY with -Execute.
.DESCRIPTION
  Run as the separately approved stage operator (role-definition/assignment write
  and resource creation rights). NEVER run this with the private runner identity.
  OutputDirectory must be outside the worktree. Without -Execute there are NO
  Azure calls: only Bicep build/lint and a protected parameter artifact.

  -Execute registers the listed providers, creates two dedicated groups, reads
  back the policy-exemption tag, then deploys Incremental. It never touches the
  fresh-public or original production groups. After successful staging, freeze
  this platform: subsequent UI deployments use protected-transfer.ps1 instead.
  SecurityControl=Ignore is this tenant's prerequisite for classic shared-key SMB,
  not a request to remove service firewalls; all service ACLs still deny public.
  RunnerVmSize defaults to Standard_D2as_v6 and remains overridable with another
  x64/Generation 2-compatible SKU. Confirm subscription restrictions, capacity and
  the default's standardDav6Family quota before deployment.
  This script never substitutes another size when the selected SKU is unavailable.
  The exact approved live pair is platform rg-citadel-live-private-20260906 and
  UI target rg-citadel-live-reuse-20260906. No group cleanup is performed here.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,39}$')][string]$EnvironmentName,
  [Parameter(Mandatory)][guid]$SubscriptionId,
  [string]$Location = 'westeurope',
  [Parameter(Mandatory)][string]$PlatformResourceGroup,
  [Parameter(Mandatory)][string]$UiResourceGroup,
  [Parameter(Mandatory)][string]$SshPublicKeyPath,
  [Parameter(Mandatory)][string]$OutputDirectory,
  [ValidateNotNullOrEmpty()][string]$RunnerVmSize = 'Standard_D2as_v6',
  [string]$VnetPrefix = '10.84.0.0/16',
  [string]$AcaSubnetPrefix = '10.84.0.0/23',
  [string]$PrivateEndpointSubnetPrefix = '10.84.2.0/24',
  [string]$RunnerSubnetPrefix = '10.84.3.0/24',
  [ValidatePattern('^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')][string]$FileShareName = 'citadel-data',
  [ValidatePattern('^[A-Za-z0-9-]{1,127}$')][string]$CredentialSecretName = 'citadel-credential-key',
  [switch]$EnableEvidenceBlob,
  [switch]$Preview,
  [switch]$Execute
)
. (Join-Path $PSScriptRoot 'protected-common.ps1')
Assert-ProtectedGroupNames $PlatformResourceGroup $UiResourceGroup
if ($Location -cnotmatch '^[a-z]+[a-z0-9]*$') { throw 'Use an Azure location code, for example westeurope.' }
if ($AcaSubnetPrefix -notmatch '/23$') { throw 'The protected ACA subnet must use the planned /23.' }
$sshKey = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $SshPublicKeyPath)).Trim()
if ($sshKey -notmatch '^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$') {
  throw 'Supply an OpenSSH public key (.pub), never a private key or password.'
}
$artifacts = New-ProtectedArtifactDirectory $OutputDirectory
$template = Join-Path $PSScriptRoot '..\infra\protected\platform.bicep'
$compiled = Join-Path $artifacts 'platform.json'
$null = Invoke-ProtectedNative az @('bicep', 'build', '--file', $template, '--outfile', $compiled) 'Compile protected Bicep'
$null = Invoke-ProtectedNative az @('bicep', 'lint', '--file', $template) 'Lint protected Bicep'
$values = [ordered]@{
  environmentName = $EnvironmentName
  location = $Location
  uiResourceGroupName = $UiResourceGroup
  runnerSshPublicKey = $sshKey
  runnerVmSize = $RunnerVmSize
  enableEvidenceBlob = [bool]$EnableEvidenceBlob
  fileShareName = $FileShareName
  credentialSecretName = $CredentialSecretName
  vnetPrefix = $VnetPrefix
  acaSubnetPrefix = $AcaSubnetPrefix
  privateEndpointSubnetPrefix = $PrivateEndpointSubnetPrefix
  runnerSubnetPrefix = $RunnerSubnetPrefix
}
$parameters = [ordered]@{}
foreach ($key in $values.Keys) { $parameters[$key] = @{ value = $values[$key] } }
$parameterPath = Join-Path $artifacts 'platform.parameters.json'
Write-ProtectedJson $parameterPath @{
  '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters = $parameters
}
if (-not $Execute) {
  if ($Preview) { throw 'Azure preview requires -Execute because the two approved test resource groups must exist.' }
  Write-Host "Compiled only. No Azure calls or resource writes. Review artifacts at $artifacts"
  return
}

$sub = $SubscriptionId.ToString()
$account = (Invoke-ProtectedNative az @('account', 'show', '--subscription', $sub, '--output', 'json', '--only-show-errors') 'Read stage subscription') | ConvertFrom-Json
if ($account.id -ne $sub -or $account.environmentName -ne 'AzureCloud') { throw 'Unexpected Azure subscription/cloud.' }
function Read-StageGroup([string]$Name) {
  $exists = Invoke-ProtectedNative az @('group', 'exists', '--name', $Name, '--subscription', $sub, '--output', 'tsv', '--only-show-errors') 'Check stage group'
  if ($exists -eq 'false') { return $null }
  if ($exists -ne 'true') { throw 'Invalid group existence response.' }
  return ((Invoke-ProtectedNative az @('group', 'show', '--name', $Name, '--subscription', $sub, '--output', 'json', '--only-show-errors') 'Read stage group') | ConvertFrom-Json -AsHashtable)
}
$platform = Read-StageGroup $PlatformResourceGroup
$ui = Read-StageGroup $UiResourceGroup
if ($null -ne $platform) {
  if ($platform.tags['citadel-protected-stage'] -cne $EnvironmentName -or
      $platform.tags['citadel-ui-target'] -cne $UiResourceGroup) { throw 'Refusing to modify an unowned platform group.' }
}
if ($null -ne $ui -and $null -eq $platform) { throw 'The UI group already exists without the owned staging platform; refusing adoption.' }
foreach ($group in @($platform, $ui)) {
  if ($null -ne $group -and $group.location -cne $Location) { throw 'An existing stage group has a different location.' }
}

# Provider registration is an Azure WRITE and belongs exclusively behind Execute.
$providers = @(
  'Microsoft.Resources', 'Microsoft.Network', 'Microsoft.Compute', 'Microsoft.App',
  'Microsoft.ContainerRegistry', 'Microsoft.KeyVault', 'Microsoft.Storage',
  'Microsoft.ManagedIdentity', 'Microsoft.OperationalInsights', 'Microsoft.Insights'
)
foreach ($provider in $providers) {
  $state = Invoke-ProtectedNative az @('provider', 'show', '--namespace', $provider, '--subscription', $sub, '--query', 'registrationState', '--output', 'tsv', '--only-show-errors') "Read $provider registration"
  if ($state -ne 'Registered') {
    $null = Invoke-ProtectedNative az @('provider', 'register', '--namespace', $provider, '--subscription', $sub, '--wait', '--output', 'none', '--only-show-errors') "Register $provider"
  }
}
foreach ($name in @($PlatformResourceGroup, $UiResourceGroup)) {
  $group = if ($name -eq $PlatformResourceGroup) { $platform } else { $ui }
  if ($null -eq $group) {
    $null = Invoke-ProtectedNative az @(
      'group', 'create', '--name', $name, '--location', $Location, '--subscription', $sub,
      '--tags', 'SecurityControl=Ignore', "citadel-protected-stage=$EnvironmentName", "citadel-ui-target=$UiResourceGroup",
      '--output', 'none', '--only-show-errors'
    ) 'Create approved staging group'
  }
  $tag = Invoke-ProtectedNative az @('group', 'show', '--name', $name, '--subscription', $sub, '--query', 'tags.SecurityControl', '--output', 'tsv', '--only-show-errors') 'Verify SMB policy prerequisite'
  if ($tag -cne 'Ignore') { throw 'SecurityControl=Ignore did not persist. Stop; do not repair storage policy after creation.' }
}
if ($Preview) {
  $previewText = Invoke-ProtectedNative az @(
    'deployment', 'group', 'what-if', '--name', "protected-$EnvironmentName",
    '--resource-group', $PlatformResourceGroup, '--subscription', $sub,
    '--template-file', $compiled, '--parameters', "@$parameterPath",
    '--result-format', 'ResourceIdOnly', '--no-pretty-print', '--output', 'json', '--only-show-errors'
  ) 'Preview approved protected platform'
  Write-ProtectedJson (Join-Path $artifacts 'platform-preview.json') ($previewText | ConvertFrom-Json)
  Write-Host "Azure preview completed. Only the approved resource groups were prepared; platform resources were not deployed. Review $artifacts"
  return
}
$contractText = Invoke-ProtectedNative az @(
  'deployment', 'group', 'create', '--name', "protected-$EnvironmentName",
  '--resource-group', $PlatformResourceGroup, '--subscription', $sub, '--mode', 'Incremental',
  '--template-file', $compiled, '--parameters', "@$parameterPath",
  '--query', 'properties.outputs.contract.value', '--output', 'json', '--only-show-errors'
) 'Deploy approved protected platform'
$contract = $contractText | ConvertFrom-Json
Assert-ProtectedContract $contract
$contractPath = Join-Path $artifacts 'contract.json'
Write-ProtectedJson $contractPath $contract
Write-Host "Protected platform staged. Nonsensitive selectors: $contractPath"
Write-Host 'No UI image was built/deployed. Review the platform baseline before approving private source transfer.'
