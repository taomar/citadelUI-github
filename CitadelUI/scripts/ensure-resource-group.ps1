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
$environment   = $env:AZURE_ENV_NAME

if ([string]::IsNullOrWhiteSpace($resourceGroup)) {
  # Fall back to the name azd would have chosen anyway.
  #
  # azd names resource groups `rg-<env-name>`
  # (`${abbrs.resourcesResourceGroups}${environmentName}` in its own templates),
  # so deriving the same name here cannot disagree with the group azd targets.
  # That agreement is the whole point: a name known only to this script would
  # tag one group while azd deployed into another, and the mistake would not
  # surface until the storage account was refused its shared key and the
  # container exited 1 on a missing /data.
  #
  # The value is written back to the environment file rather than only held in
  # this process, because a child process cannot change its parent's
  # environment. Whether azd re-reads the file in time to use it for *this*
  # run is not documented and has not been proven here; if it does not, the
  # run fails exactly as it did before, the value is now recorded, and the next
  # `azd up` succeeds. So the worst case is one empty tagged group and a second
  # run -- strictly better than the previous behaviour of refusing to start.
  if ([string]::IsNullOrWhiteSpace($environment)) {
    Write-Host 'Neither AZURE_RESOURCE_GROUP nor AZURE_ENV_NAME is set, so the resource group cannot be named.'
    Write-Host 'Set it with: azd env set AZURE_RESOURCE_GROUP <name>'
    exit 1
  }

  $resourceGroup = "rg-$environment"
  Write-Host "AZURE_RESOURCE_GROUP was not set; using azd's own convention: '$resourceGroup'."

  azd env set AZURE_RESOURCE_GROUP $resourceGroup
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Could not record AZURE_RESOURCE_GROUP on the environment."
    Write-Host "Set it by hand with: azd env set AZURE_RESOURCE_GROUP $resourceGroup"
    exit $LASTEXITCODE
  }

  $env:AZURE_RESOURCE_GROUP = $resourceGroup
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
