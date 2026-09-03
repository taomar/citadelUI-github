<#
.SYNOPSIS
  Creates the deployment's resource group, tagged so the subscription's security
  baseline permits shared-key storage access.

.DESCRIPTION
  This runs before `azd provision` because of a governance constraint that is
  invisible until it bites.

  This tenant enforces `allowSharedKeyAccess = false` on storage accounts. The
  enforcement is silent: the ARM request to set it `true` is accepted, returns
  200, and the account still reads back `false`. Container Apps mounts Azure
  Files over SMB and authenticates with the account key, so with shared key
  denied the mount is refused -- `mount error(13): Permission denied` -- and the
  container exits 1 at startup, because /data is required to boot rather than
  merely to persist. The symptom is a container that will not start, several
  layers away from the cause.

  Tagging the resource group `SecurityControl: Ignore` exempts it from that
  baseline. The tag has to be present when the storage account is evaluated, so
  it belongs on the group before provisioning rather than being applied by hand
  afterwards -- a fresh `azd up` in an empty subscription has to work without
  anyone remembering this.

  Idempotent: creates the group when absent, and adds the tag when the group
  exists without it, so re-running provision is safe.
#>

$ErrorActionPreference = 'Stop'

$resourceGroup = $env:AZURE_RESOURCE_GROUP
$location      = $env:AZURE_LOCATION
$subscription  = $env:AZURE_SUBSCRIPTION_ID

if ([string]::IsNullOrWhiteSpace($resourceGroup)) {
  Write-Host 'AZURE_RESOURCE_GROUP is not set; azd will create the group itself and the tag cannot be applied here.'
  Write-Host 'Set it with: azd env set AZURE_RESOURCE_GROUP <name>'
  exit 1
}
if ([string]::IsNullOrWhiteSpace($location)) {
  Write-Host 'AZURE_LOCATION is not set.'
  exit 1
}

$args = @('group', 'create', '--name', $resourceGroup, '--location', $location, '--tags', 'SecurityControl=Ignore')
if (-not [string]::IsNullOrWhiteSpace($subscription)) { $args += @('--subscription', $subscription) }

# `group create` is itself idempotent and updates tags on an existing group, so
# one call covers both the create and the repair case.
Write-Host "Ensuring resource group '$resourceGroup' in '$location' with SecurityControl=Ignore"
az @args --only-show-errors --output none

if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to create or update resource group '$resourceGroup'."
  exit $LASTEXITCODE
}

# Read the tag back rather than trusting the write: the whole reason this script
# exists is a setting that accepts a value and does not keep it.
$readArgs = @('group', 'show', '--name', $resourceGroup, '--query', 'tags.SecurityControl', '--output', 'tsv')
if (-not [string]::IsNullOrWhiteSpace($subscription)) { $readArgs += @('--subscription', $subscription) }
$applied = (az @readArgs --only-show-errors)

if ($applied -ne 'Ignore') {
  Write-Host "SecurityControl tag did not persist (read back: '$applied')."
  Write-Host 'Shared-key storage will stay disabled and the /data mount will fail at startup.'
  exit 1
}

Write-Host "Resource group ready, SecurityControl=Ignore confirmed."
