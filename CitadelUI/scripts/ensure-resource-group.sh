#!/bin/sh
# Creates the deployment's resource group, tagged so the subscription's security
# baseline permits shared-key storage access. POSIX counterpart of
# ensure-resource-group.ps1; see that file for why this exists.
#
# In short: this tenant enforces allowSharedKeyAccess=false on storage accounts,
# silently -- the request succeeds and the value stays false. Container Apps
# mounts Azure Files over SMB using the account key, so the mount is refused and
# the container exits 1 at startup, because /data is required to boot. Tagging
# the resource group SecurityControl=Ignore exempts it, and the tag has to exist
# before the storage account is evaluated.

set -eu

if [ -z "${AZURE_RESOURCE_GROUP:-}" ]; then
  # Fall back to the name azd would have chosen anyway: it names resource groups
  # rg-<env-name> in its own templates, so deriving the same name here cannot
  # disagree with the group azd targets. That agreement is the point -- a name
  # known only to this script would tag one group while azd deployed into
  # another, and the mistake would not surface until the storage account was
  # refused its shared key and the container exited 1 on a missing /data.
  #
  # The value is written back to the environment file rather than only exported,
  # because a child process cannot change its parent's environment. Whether azd
  # re-reads it in time for *this* run is not documented and is not proven here;
  # if it does not, the run fails as it did before, the value is now recorded,
  # and the next `azd up` succeeds. Worst case is one empty tagged group and a
  # second run, which still beats refusing to start.
  if [ -z "${AZURE_ENV_NAME:-}" ]; then
    echo "Neither AZURE_RESOURCE_GROUP nor AZURE_ENV_NAME is set, so the resource group cannot be named."
    echo "Set it with: azd env set AZURE_RESOURCE_GROUP <name>"
    exit 1
  fi

  AZURE_RESOURCE_GROUP="rg-${AZURE_ENV_NAME}"
  export AZURE_RESOURCE_GROUP
  echo "AZURE_RESOURCE_GROUP was not set; using azd's own convention: '$AZURE_RESOURCE_GROUP'."

  if ! azd env set AZURE_RESOURCE_GROUP "$AZURE_RESOURCE_GROUP"; then
    echo "Could not record AZURE_RESOURCE_GROUP on the environment."
    echo "Set it by hand with: azd env set AZURE_RESOURCE_GROUP $AZURE_RESOURCE_GROUP"
    exit 1
  fi
fi

if [ -z "${AZURE_LOCATION:-}" ]; then
  echo "AZURE_LOCATION is not set."
  exit 1
fi

set -- group create --name "$AZURE_RESOURCE_GROUP" --location "$AZURE_LOCATION" --tags SecurityControl=Ignore
if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then
  set -- "$@" --subscription "$AZURE_SUBSCRIPTION_ID"
fi

echo "Ensuring resource group '$AZURE_RESOURCE_GROUP' in '$AZURE_LOCATION' with SecurityControl=Ignore"
az "$@" --only-show-errors --output none

# Read the tag back rather than trusting the write: the reason this script exists
# is a setting that accepts a value and does not keep it.
set -- group show --name "$AZURE_RESOURCE_GROUP" --query tags.SecurityControl --output tsv
if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then
  set -- "$@" --subscription "$AZURE_SUBSCRIPTION_ID"
fi
applied=$(az "$@" --only-show-errors)

if [ "$applied" != "Ignore" ]; then
  echo "SecurityControl tag did not persist (read back: '$applied')."
  echo "Shared-key storage will stay disabled and the /data mount will fail at startup."
  exit 1
fi

echo "Resource group ready, SecurityControl=Ignore confirmed."
