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
  echo "AZURE_RESOURCE_GROUP is not set; azd will create the group itself and the tag cannot be applied here."
  echo "Set it with: azd env set AZURE_RESOURCE_GROUP <name>"
  exit 1
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
