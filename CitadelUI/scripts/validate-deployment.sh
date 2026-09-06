#!/bin/sh
# Read-only counterpart of validate-deployment.ps1. Azure CLI performs JSON
# selection so this preflight needs neither Node nor jq. No keys are fetched.
set -eu

fail() {
  printf '%s\n' "Deployment preflight: $*" >&2
  exit 1
}

# Reject accidental whitespace without silently changing what Bicep receives.
check_input() {
  case "$2" in
    [[:space:]]*|*[[:space:]]) fail "$1 must not have leading or trailing whitespace." ;;
  esac
}
check_input AZURE_RESOURCE_GROUP "${AZURE_RESOURCE_GROUP:-}"
check_input AZURE_ENV_NAME "${AZURE_ENV_NAME:-}"
check_input AZURE_LOCATION "${AZURE_LOCATION:-}"
check_input AZURE_SUBSCRIPTION_ID "${AZURE_SUBSCRIPTION_ID:-}"
check_input AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME "${AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME:-}"
check_input AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP "${AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP:-}"
check_input AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME "${AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME:-}"
check_input AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP "${AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP:-}"
check_input AZURE_EXISTING_CONTAINER_REGISTRY_NAME "${AZURE_EXISTING_CONTAINER_REGISTRY_NAME:-}"
check_input AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP "${AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP:-}"
check_input AZURE_EXISTING_STORAGE_ACCOUNT_NAME "${AZURE_EXISTING_STORAGE_ACCOUNT_NAME:-}"
check_input AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP "${AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP:-}"
check_input AZURE_EXISTING_FILE_SHARE_NAME "${AZURE_EXISTING_FILE_SHARE_NAME:-}"
check_input AZURE_EXISTING_MANAGED_IDENTITY_NAME "${AZURE_EXISTING_MANAGED_IDENTITY_NAME:-}"
check_input AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP "${AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP:-}"
check_input CITADEL_PRIVATE_DEPLOYMENT "${CITADEL_PRIVATE_DEPLOYMENT:-}"
check_input AZURE_PRINCIPAL_TYPE "${AZURE_PRINCIPAL_TYPE:-}"
check_input AZURE_INFRASTRUCTURE_SUBNET_ID "${AZURE_INFRASTRUCTURE_SUBNET_ID:-}"
check_input AZURE_KEY_VAULT_NAME "${AZURE_KEY_VAULT_NAME:-}"
check_input AZURE_KEY_VAULT_RESOURCE_GROUP "${AZURE_KEY_VAULT_RESOURCE_GROUP:-}"

existing_environment=${AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME:-}
environment_group=${AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP:-}
existing_workspace=${AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME:-}
workspace_group=${AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP:-}
existing_registry=${AZURE_EXISTING_CONTAINER_REGISTRY_NAME:-}
registry_group=${AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP:-}
existing_storage=${AZURE_EXISTING_STORAGE_ACCOUNT_NAME:-}
storage_group=${AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP:-}
existing_share=${AZURE_EXISTING_FILE_SHARE_NAME:-}
existing_identity=${AZURE_EXISTING_MANAGED_IDENTITY_NAME:-}
identity_group=${AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP:-}
private_deployment=${CITADEL_PRIVATE_DEPLOYMENT:-false}

if [ -n "$environment_group" ] && [ -z "$existing_environment" ]; then
  fail 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP requires AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME.'
fi
if [ -n "$workspace_group" ] && [ -z "$existing_workspace" ]; then
  fail 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP requires AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME.'
fi
if [ -n "$registry_group" ] && [ -z "$existing_registry" ]; then
  fail 'AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP requires AZURE_EXISTING_CONTAINER_REGISTRY_NAME.'
fi
if [ -n "$storage_group" ] && [ -z "$existing_storage" ]; then
  fail 'AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME.'
fi
if [ -n "$existing_share" ] && [ -z "$existing_storage" ]; then
  fail 'AZURE_EXISTING_FILE_SHARE_NAME requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME.'
fi
if [ -n "$identity_group" ] && [ -z "$existing_identity" ]; then
  fail 'AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP requires AZURE_EXISTING_MANAGED_IDENTITY_NAME.'
fi
case "$private_deployment" in
  true|false) ;;
  *) fail 'CITADEL_PRIVATE_DEPLOYMENT must be true or false.' ;;
esac
case "${AZURE_PRINCIPAL_TYPE:-User}" in
  User|ServicePrincipal|Group) ;;
  *) fail 'AZURE_PRINCIPAL_TYPE must be User, ServicePrincipal or Group.' ;;
esac
if [ -n "$existing_environment" ] && [ -n "${AZURE_INFRASTRUCTURE_SUBNET_ID:-}" ]; then
  fail 'AZURE_INFRASTRUCTURE_SUBNET_ID cannot be combined with an existing Container Apps environment; validate its subnet separately and omit this input.'
fi
if [ -n "$existing_environment" ] && [ -n "$existing_workspace" ]; then
  fail 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME cannot be combined with an existing Container Apps environment; validate its logging separately and omit both workspace inputs.'
fi
[ -n "${AZURE_LOCATION:-}" ] || fail 'AZURE_LOCATION is not set.'
deployment_group=${AZURE_RESOURCE_GROUP:-}
if [ -z "$deployment_group" ]; then
  [ -n "${AZURE_ENV_NAME:-}" ] || fail 'Neither AZURE_RESOURCE_GROUP nor AZURE_ENV_NAME is set.'
  deployment_group="rg-$AZURE_ENV_NAME"
fi
environment_group=${environment_group:-$deployment_group}
workspace_group=${workspace_group:-$deployment_group}
registry_group=${registry_group:-$deployment_group}
storage_group=${storage_group:-$deployment_group}
identity_group=${identity_group:-$deployment_group}
vault_group=${AZURE_KEY_VAULT_RESOURCE_GROUP:-$deployment_group}

read_existing_resource() {
  # $1=type $2=name $3=group $4=API version $5=JMESPath projection.
  resource_type=$1
  resource_name=$2
  resource_group=$3
  set -- resource show --resource-type "$1" --name "$2" --resource-group "$3" \
    --api-version "$4" --query "$5" --only-show-errors --output tsv
  if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then
    set -- "$@" --subscription "$AZURE_SUBSCRIPTION_ID"
  fi
  if ! az "$@"; then
    fail "Cannot read existing $resource_type '$resource_name' in resource group '$resource_group'. Check the selected subscription, name, group and management-plane read permission."
  fi
}

read_existing_resource_id() {
  # $1=absolute ARM ID $2=API version $3=JMESPath projection.
  # Git Bash must not translate an ARM resource ID into a Windows file path.
  if ! MSYS_NO_PATHCONV=1 az resource show --ids "$1" --api-version "$2" --query "$3" --only-show-errors --output tsv; then
    fail "Cannot read existing resource '$1'. Check its ID and management-plane read permission."
  fi
}

subscription=${AZURE_SUBSCRIPTION_ID:-}
if [ -z "$subscription" ] && { [ -n "${AZURE_INFRASTRUCTURE_SUBNET_ID:-}" ] || [ -n "$existing_share" ]; }; then
  if ! subscription=$(az account show --query id --only-show-errors --output tsv); then
    fail 'Set AZURE_SUBSCRIPTION_ID or select an Azure CLI subscription before resource reuse.'
  fi
  subscription=$(printf '%s' "$subscription" | tr -d '\r')
  [ -n "$subscription" ] || fail 'Set AZURE_SUBSCRIPTION_ID or select an Azure CLI subscription before resource reuse.'
fi

if [ -n "${AZURE_INFRASTRUCTURE_SUBNET_ID:-}" ]; then
  subnet=$AZURE_INFRASTRUCTURE_SUBNET_ID
  printf '%s\n' "$subnet" | grep -Eiq '^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft\.Network/virtualNetworks/[^/]+/subnets/[^/]+$' ||
    fail 'AZURE_INFRASTRUCTURE_SUBNET_ID must be a complete subnet resource ID.'
  subnet_subscription=$(printf '%s' "$subnet" | cut -d/ -f3 | tr '[:upper:]' '[:lower:]')
  selected_subscription=$(printf '%s' "$subscription" | tr '[:upper:]' '[:lower:]')
  [ "$subnet_subscription" = "$selected_subscription" ] || fail 'AZURE_INFRASTRUCTURE_SUBNET_ID must be in the deployment subscription.'
  network_id=$(printf '%s' "$subnet" | cut -d/ -f1-9)
  actual_location=$(read_existing_resource_id "$network_id" 2024-05-01 location)
  actual_location=$(printf '%s' "$actual_location" | tr -d ' \r' | tr '[:upper:]' '[:lower:]')
  requested_location=$(printf '%s' "$AZURE_LOCATION" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
  [ "$actual_location" = "$requested_location" ] || fail 'AZURE_LOCATION must match the existing subnet VNet region.'
  query="[properties.provisioningState, properties.addressPrefix || properties.addressPrefixes[0], length(properties.addressPrefixes || \`[]\`), length(properties.delegations[?properties.serviceName=='Microsoft.App/environments' || serviceName=='Microsoft.App/environments'] || \`[]\`), length(properties.delegations || \`[]\`), length(properties.serviceAssociationLinks || \`[]\`), length(properties.ipConfigurations || \`[]\`), length(properties.privateEndpoints || \`[]\`)]"
  details=$(read_existing_resource_id "$subnet" 2024-05-01 "$query")
  state=$(printf '%s\n' "$details" | sed -n '1p' | tr -d '\r')
  [ "$state" = Succeeded ] || fail 'The existing subnet must be Succeeded.'
  # Existing-environment/subnet combinations were rejected above. These checks
  # apply only when creating a new environment in the selected existing subnet.
  if [ -z "$existing_environment" ]; then
    prefix=$(printf '%s\n' "$details" | sed -n '2p' | tr -d '\r')
    prefix_count=$(printf '%s\n' "$details" | sed -n '3p' | tr -d '\r')
    delegated=$(printf '%s\n' "$details" | sed -n '4p' | tr -d '\r')
    delegation_count=$(printf '%s\n' "$details" | sed -n '5p' | tr -d '\r')
    associations=$(printf '%s\n' "$details" | sed -n '6p' | tr -d '\r')
    ip_configurations=$(printf '%s\n' "$details" | sed -n '7p' | tr -d '\r')
    private_endpoints=$(printf '%s\n' "$details" | sed -n '8p' | tr -d '\r')
    for count in "$prefix_count" "$delegated" "$delegation_count" "$associations" "$ip_configurations" "$private_endpoints"; do
      case "$count" in ''|*[!0-9]*) fail 'Azure CLI returned an invalid subnet response.' ;; esac
    done
    [ "$prefix_count" -le 1 ] &&
      printf '%s\n' "$prefix" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' &&
      printf '%s\n' "$prefix" | awk -F '[./]' '{ for (i=1;i<=4;i++) if ($i>255) exit 1; if ($5>27) exit 1 }' ||
      fail 'The existing subnet must have one IPv4 prefix of /27 or larger.'
    [ "$delegated" -eq 1 ] && [ "$delegation_count" -eq 1 ] ||
      fail 'The existing subnet must already be delegated only to Microsoft.App/environments. No delegation will be changed.'
    [ "$associations" -eq 0 ] && [ "$ip_configurations" -eq 0 ] && [ "$private_endpoints" -eq 0 ] ||
      fail 'The existing subnet must be dedicated and unused by another environment or workload. Select the existing environment instead of reusing its occupied subnet.'
    printf '%s\n' 'Warning: Existing subnet/VNet configuration is unchanged. Provide private DNS for the new environment domain plus client connectivity and required outbound network access; no DNS, peering or firewall changes are made to this VNet.' >&2
  fi
fi

if [ -n "$existing_environment" ]; then
  # A list of scalars is emitted one per line by Azure CLI TSV. Required fields
  # precede the always-present counts; no JSON or shell evaluation is involved.
  query="[location, properties.provisioningState, properties.defaultDomain, length(properties.workloadProfiles || \`[]\`), length(properties.workloadProfiles[?name=='Consumption' && workloadProfileType=='Consumption'] || \`[]\`), to_string(properties.vnetConfiguration.internal)]"
  details=$(read_existing_resource Microsoft.App/managedEnvironments "$existing_environment" "$environment_group" 2025-07-01 "$query")
  actual_location=$(printf '%s\n' "$details" | sed -n '1p' | tr -d ' \r' | tr '[:upper:]' '[:lower:]')
  requested_location=$(printf '%s' "$AZURE_LOCATION" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
  [ "$actual_location" = "$requested_location" ] || fail 'AZURE_LOCATION must match the existing Container Apps environment region.'
  state=$(printf '%s\n' "$details" | sed -n '2p' | tr -d '\r')
  domain=$(printf '%s\n' "$details" | sed -n '3p' | tr -d '\r')
  [ "$state" = Succeeded ] && [ -n "$domain" ] && [ "$domain" != None ] ||
    fail 'The existing Container Apps environment must be Succeeded and have a defaultDomain.'
  if [ "$private_deployment" = true ]; then
    internal=$(printf '%s\n' "$details" | sed -n '6p' | tr -d '\r')
    [ "$internal" = true ] ||
      fail 'CITADEL_PRIVATE_DEPLOYMENT=true requires an internal existing Container Apps environment; its network will not be changed.'
  fi
  profile_count=$(printf '%s\n' "$details" | sed -n '4p' | tr -d '\r')
  consumption_count=$(printf '%s\n' "$details" | sed -n '5p' | tr -d '\r')
  case "$profile_count:$consumption_count" in
    *[!0-9:]*|:*|*:) fail 'Azure CLI returned an invalid workload profile response.' ;;
  esac
  if [ "$profile_count" -ne 0 ] && [ "$consumption_count" -eq 0 ]; then
    fail 'The existing environment must have a Consumption workload profile named Consumption, or be a legacy consumption-only environment. No profiles will be added.'
  fi
fi

if [ -n "$existing_storage" ]; then
  details=$(read_existing_resource Microsoft.Storage/storageAccounts "$existing_storage" "$storage_group" 2023-05-01 \
    '[properties.provisioningState, kind, properties.primaryEndpoints.file, to_string(properties.allowSharedKeyAccess), to_string(properties.publicNetworkAccess), to_string(properties.networkAcls.defaultAction)]')
  state=$(printf '%s\n' "$details" | sed -n '1p' | tr -d '\r')
  kind=$(printf '%s\n' "$details" | sed -n '2p' | tr -d '\r')
  file_endpoint=$(printf '%s\n' "$details" | sed -n '3p' | tr -d '\r')
  [ "$state" = Succeeded ] && [ -n "$file_endpoint" ] && [ "$file_endpoint" != None ] ||
    fail 'The existing storage account must be Succeeded and support Azure Files SMB.'
  case "$kind" in
    Storage|StorageV2|FileStorage) ;;
    *) fail 'The existing storage account must be Succeeded and support Azure Files SMB.' ;;
  esac
  shared_key=$(printf '%s\n' "$details" | sed -n '4p' | tr -d '\r')
  [ "$shared_key" != false ] ||
    fail 'The existing storage account disables shared-key access required by the Azure Files mount. No account policy will be changed.'
  public_network=$(printf '%s\n' "$details" | sed -n '5p' | tr -d '\r')
  firewall_action=$(printf '%s\n' "$details" | sed -n '6p' | tr -d '\r')
  if [ "$public_network" = Disabled ] || [ "$firewall_action" = Deny ]; then
    printf '%s\n' 'Warning: Existing storage network restrictions are preserved. The Container Apps environment must already have DNS/SMB access; no firewall, private endpoint or policy bypass is configured.' >&2
  fi
  if [ -n "$existing_share" ]; then
    share_id="/subscriptions/$subscription/resourceGroups/$storage_group/providers/Microsoft.Storage/storageAccounts/$existing_storage/fileServices/default/shares/$existing_share"
    protocol=$(read_existing_resource_id "$share_id" 2023-05-01 'to_string(properties.enabledProtocols)')
    protocol=$(printf '%s' "$protocol" | tr -d '\r')
    case "$protocol" in
      SMB|null) ;;
      *) fail 'The existing Azure Files share must use SMB; NFS shares cannot use this key-based binding.' ;;
    esac
    printf '%s\n' 'Warning: Reusing the named share without changing its data or owner. It must be dedicated Citadel UI state with no concurrent writer; preserve the matching Key Vault credential-secret name and key.' >&2
  else
    printf '%s\n' 'Warning: No file-share selector: a new deterministic UI-specific share will be created in the existing account. Set AZURE_EXISTING_FILE_SHARE_NAME to retain an existing UI share and its owner/data.' >&2
  fi
fi

if [ -n "$existing_identity" ]; then
  details=$(read_existing_resource Microsoft.ManagedIdentity/userAssignedIdentities "$existing_identity" "$identity_group" 2023-01-31 \
    '[properties.clientId, properties.principalId]')
  client_id=$(printf '%s\n' "$details" | sed -n '1p' | tr -d '\r')
  principal_id=$(printf '%s\n' "$details" | sed -n '2p' | tr -d '\r')
  [ -n "$client_id" ] && [ "$client_id" != None ] && [ -n "$principal_id" ] && [ "$principal_id" != None ] ||
    fail 'The existing managed identity must have clientId and principalId. No identity will be recreated or reconfigured.'
fi

if [ -n "$existing_workspace" ]; then
  details=$(read_existing_resource Microsoft.OperationalInsights/workspaces "$existing_workspace" "$workspace_group" 2023-09-01 \
    '[properties.customerId, to_string(properties.features.disableLocalAuth)]')
  customer_id=$(printf '%s\n' "$details" | sed -n '1p' | tr -d '\r')
  [ -n "$customer_id" ] && [ "$customer_id" != None ] || fail 'The existing Log Analytics workspace must have a customerId.'
  local_auth_disabled=$(printf '%s\n' "$details" | sed -n '2p' | tr -d '\r')
  [ "$local_auth_disabled" != true ] ||
    fail 'The existing Log Analytics workspace disables shared-key authentication, which Container Apps log ingestion requires. Choose a compatible workspace; preflight will not change it.'
fi

if [ -n "$existing_registry" ]; then
  details=$(read_existing_resource Microsoft.ContainerRegistry/registries "$existing_registry" "$registry_group" 2025-11-01 \
    '[properties.provisioningState, properties.loginServer, to_string(properties.roleAssignmentMode), to_string(properties.policies.azureADAuthenticationAsArmPolicy.status), to_string(properties.publicNetworkAccess), to_string(properties.networkRuleSet.defaultAction)]')
  state=$(printf '%s\n' "$details" | sed -n '1p' | tr -d '\r')
  login_server=$(printf '%s\n' "$details" | sed -n '2p' | tr -d '\r')
  [ "$state" = Succeeded ] && [ -n "$login_server" ] && [ "$login_server" != None ] ||
    fail 'The existing registry must be Succeeded and have a loginServer.'
  registry_mode=$(printf '%s\n' "$details" | sed -n '3p' | tr -d '\r')
  case "$registry_mode" in
    null) registry_mode=LegacyRegistryPermissions ;;
    LegacyRegistryPermissions|AbacRepositoryPermissions) ;;
    *) fail 'Unsupported registry roleAssignmentMode. Expected LegacyRegistryPermissions or AbacRepositoryPermissions.' ;;
  esac
  arm_auth=$(printf '%s\n' "$details" | sed -n '4p' | tr -d '\r')
  [ "$arm_auth" = enabled ] ||
    fail 'The existing registry must allow ARM audience tokens (azureADAuthenticationAsArmPolicy.status=enabled) for Container Apps managed-identity image pull. Choose a compatible registry; preflight will not change its authentication policy.'
  if [ "$registry_mode" = AbacRepositoryPermissions ]; then
    printf '%s\n' 'Warning: ABAC registry: quick builds require az acr build --source-acr-auth-id "[caller]" and Repository Writer plus Tasks Contributor. Do not assume your azd remoteBuild version supplies caller source authentication; use the explicit CLI build/update flow when it does not.' >&2
  fi
  public_network=$(printf '%s\n' "$details" | sed -n '5p' | tr -d '\r')
  firewall_action=$(printf '%s\n' "$details" | sed -n '6p' | tr -d '\r')
  if [ "$public_network" = Disabled ] || [ "$firewall_action" = Deny ]; then
    printf '%s\n' 'Warning: Registry network restrictions are preserved. The operator, build worker and Container App need existing DNS/network access; no firewall, private endpoint, trusted-service bypass or admin-account changes are made.' >&2
  fi
fi

if [ -n "${AZURE_KEY_VAULT_NAME:-}" ]; then
  rbac=$(read_existing_resource Microsoft.KeyVault/vaults "$AZURE_KEY_VAULT_NAME" "$vault_group" 2023-07-01 \
    'to_string(properties.enableRbacAuthorization)')
  rbac=$(printf '%s' "$rbac" | tr -d '\r')
  [ "$rbac" = true ] ||
    fail 'The existing Key Vault must use Azure RBAC (enableRbacAuthorization=true). This deployment only adds the app Secrets User role; it never changes vault access policies or networking.'
fi

printf '%s\n' 'Deployment preflight passed. Existing resources were read, not modified; data-plane permissions and network reachability must also be provided.'
