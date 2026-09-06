// -----------------------------------------------------------------------------
// Citadel UI on Azure Container Apps, provisioned by `azd up`.
//
// Where this template lives, and why it lives there
// ------------------------------------------------
// This file is under CitadelUI/, not at the repository root. The root
// azure.yaml declares a different product (the AI Citadel governance hub) and
// bicep/infra/main.bicepparam is the *data file this application edits*.
// Deploying from the root would either deploy the wrong product or overwrite the
// user's data. Nothing in this template reads or writes anything above this
// folder.
//
// AVM modules vs. raw resources
// -----------------------------
// AVM is used for the plumbing, where the module is a thin wrapper over a
// resource whose defaults are either right or cheap to override, and where its
// secure outputs save this template from handling keys by hand:
//   avm/res/operational-insights/workspace  0.16.1  (Log Analytics)
//   avm/res/container-registry/registry     0.13.0  (ACR)
//   avm/res/key-vault/vault                 0.14.0  (only on the create path)
//   avm/res/storage/storage-account         0.33.0  (+ the Azure Files share)
// Versions are pinned. An unpinned module turns a redeploy of unchanged source
// into an unreviewed change of infrastructure.
//
// The Container Apps environment, the container app, its Azure Files binding
// and its auth config are raw resources on purpose. Three rules in this
// deployment are load-bearing, and all three must be legible in one screen
// rather than inferred from a module's parameter list:
//   1. internet ingress requires Entra or explicit public-owner opt-in, and an
//      environment that actually permits public traffic (see `ingress`);
//   2. the exact Host and Origin the server enforces are derived from the
//      environment's default domain *before* the app exists;
//   3. the health probes have to send that same Host or the server answers 421.
// A module wrapper would hide all three behind flags, and a reviewer would have
// to take them on trust.
//
// The managed identity is raw for a mechanical reason given at its declaration,
// and the two role assignments are small local modules for a mechanical reason
// given in each file. Neither is a stylistic choice.
// -----------------------------------------------------------------------------

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@minLength(1)
@maxLength(64)
@description('Name of the azd environment (AZURE_ENV_NAME). Seeds resource names and tags every resource so a whole environment can be found, and deleted, as a unit.')
param environmentName string

@minLength(1)
@description('Region for resources created here (AZURE_LOCATION). Must match an existing Container Apps environment when one is selected.')
param location string = resourceGroup().location

@description('Object id of the deploying principal (AZURE_PRINCIPAL_ID). Grants push/build permissions on the selected registry and Secrets Officer on a newly created vault only. If omitted, the operator must arrange those permissions separately.')
param principalId string = ''

@description('Mount /data on Azure Files so workspaces, connection profiles, the activity log and the sealed credential envelopes survive a restart. Requires shared-key access on the storage account, which some tenants deny by policy -- see the resource group preprovision hook. Set false to run with an ephemeral /data: the app boots and works, but forgets everything on a restart, a scale to zero, or a new revision.')
param persistData bool = true

@description('Publish the app on the public internet with only its own owner sign-in in front of it, and no Entra authentication. Off by default. The app does defend itself: an anonymous visitor is issued no session token and every data route refuses one, so this is not the open door it would have been before the owner gate existed. What it does not defend is the *claim* -- a container nobody has claimed yet belongs to whoever reaches it first, which on a public ingress means whoever finds the URL first. Set this true when you intend to publish and will claim it yourself immediately. Prefer setting entraAuthClientId, which puts Entra in front of the claim as well.')
param allowPublicIngressWithoutAuth bool = false

@description('Type of the principal above. azd running as a human leaves this as User; in a pipeline running as a service principal, set it to ServicePrincipal or the assignment fails validation.')
@allowed([
  'User'
  'ServicePrincipal'
  'Group'
])
param principalType string = 'User'

@description('Fully qualified image reference. Empty on the very first `azd up`, because the registry this template creates is still empty and referencing a tag that does not exist yet fails the deployment. azd fills it in after it builds and pushes -- see `containerImage` below.')
param citadelUiImageName string = ''

@description('Name of an existing Key Vault to reuse. Empty creates a new one. Reuse provisions no vault at all; it only adds a role assignment to the vault you named.')
param keyVaultName string = ''

@description('Resource group of the existing vault, when it is not this one. Ignored when a vault is being created.')
param keyVaultResourceGroup string = ''

@description('Name of an existing Container Apps environment in this subscription. Empty creates a new environment. Reuse preserves its networking, logging, tags and workload profiles; only the Azure Files storage binding for this UI is added. Its region must match location.')
param existingContainerAppsEnvironmentName string = ''

@description('Resource group of the existing Container Apps environment. Defaults to the UI deployment resource group. Requires existingContainerAppsEnvironmentName.')
param existingContainerAppsEnvironmentResourceGroup string = ''

@description('Name of an existing Log Analytics workspace in this subscription, for a NEW environment only. Reads its customerId/shared key without changing the workspace. Empty creates a workspace only for a new environment. When reusing an environment, validate its logging separately and omit both workspace selectors; its logging remains unchanged.')
param existingLogAnalyticsWorkspaceName string = ''

@description('Resource group of the existing Log Analytics workspace. Defaults to the UI deployment resource group. Requires existingLogAnalyticsWorkspaceName.')
param existingLogAnalyticsWorkspaceResourceGroup string = ''

@description('Name of an existing Azure Container Registry in this subscription. Empty creates a registry. Reuse reads its endpoint and RBAC/ABAC permission mode; only app pull and deployer push/build role assignments are added. Registry settings are never changed.')
param existingContainerRegistryName string = ''

@description('Resource group of the existing registry. Defaults to the UI deployment resource group. Requires existingContainerRegistryName.')
param existingContainerRegistryResourceGroup string = ''

@description('Create a new private VNet and dedicated Container Apps subnet when no existing environment or subnet is selected. Existing subnets are reused without changes. An existing environment selected with true must already use an internal load balancer.')
param privateDeployment bool = false

@description('Name of an existing storage account in this subscription. Empty creates the original generated account. Reuse never changes account tags, networking, SKU or shared-key policy; Azure Files SMB/shared-key access must already be usable.')
param existingStorageAccountName string = ''

@description('Resource group of the existing storage account. Defaults to the UI deployment group. Requires existingStorageAccountName.')
param existingStorageAccountResourceGroup string = ''

@description('Name of an existing SMB Azure Files share in the selected existing account. Requires existingStorageAccountName. The share and its data are never recreated or modified by this template. Empty creates a UI-specific share in an existing account, or the original citadel-data share in a new account. Preserve this selection and the credential key when retaining UI state.')
param existingFileShareName string = ''

@description('Name of an existing user-assigned managed identity in this subscription. Empty creates the original generated identity. Reuse changes no identity properties; only the required registry and vault role assignments are added.')
param existingManagedIdentityName string = ''

@description('Resource group of the existing managed identity. Defaults to the UI deployment group. Requires existingManagedIdentityName.')
param existingManagedIdentityResourceGroup string = ''

@description('Name of the credential key-encryption secret (CITADEL_CREDENTIAL_SECRET_NAME). Defaults to citadel-credential-key. Choose a UI-specific name before first deployment when sharing a vault, then keep it stable with the encrypted data. The app reads the key at startup; this template never creates or rotates secret material.')
param credentialSecretName string = 'citadel-credential-key'

@description('Entra application (client) id for Container Apps built-in authentication. Prefer a secret-backed Web app registration for hybrid sign-in. Without a client secret, built-in authentication uses implicit ID-token flow, not SPA/PKCE. Requests external ingress, but never enables a disabled public network. Leave empty for owner-only sign-in; public exposure then requires allowPublicIngressWithoutAuth.')
param entraAuthClientId string = ''

@description('Existing subnet ID in this subscription and region, for a NEW internal environment only. It must be dedicated, unused, delegated to Microsoft.App/environments and at least a /27. When reusing an environment, validate its subnet separately and omit this input. Empty plus privateDeployment creates a VNet/subnet only when no existing environment is selected.')
param infrastructureSubnetId string = ''

@secure()
@description('Optional Entra Web app client secret, stored as a container app secret. Supplying it selects hybrid flow; omitting it uses implicit ID-token flow and requires ID token issuance enabled in the registration. Neither option configures a SPA/PKCE client.')
param entraAuthClientSecret string = ''

// ---------------------------------------------------------------------------
// Naming and shared values
// ---------------------------------------------------------------------------

// Hashing the subscription, environment and region gives names that are stable
// across redeploys of the same environment and unique across different ones,
// which matters for the globally unique names (registry, storage, vault).
// Mirror the preprovision checks for callers using Bicep directly. These
// parameter-only constraints are evaluated while resource names are computed,
// not after any resource has been created. No shared setting is silently ignored.
var reuseInputError = !empty(existingContainerAppsEnvironmentResourceGroup) && empty(existingContainerAppsEnvironmentName)
  ? 'AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP requires AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME.'
  : !empty(existingLogAnalyticsWorkspaceResourceGroup) && empty(existingLogAnalyticsWorkspaceName)
    ? 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_RESOURCE_GROUP requires AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME.'
    : !empty(existingContainerAppsEnvironmentName) && !empty(infrastructureSubnetId)
      ? 'AZURE_INFRASTRUCTURE_SUBNET_ID cannot be combined with an existing Container Apps environment; validate its subnet separately and omit this input.'
      : !empty(existingContainerAppsEnvironmentName) && !empty(existingLogAnalyticsWorkspaceName)
        ? 'AZURE_EXISTING_LOG_ANALYTICS_WORKSPACE_NAME cannot be combined with an existing Container Apps environment; validate its logging separately and omit both workspace inputs.'
        : !empty(existingContainerRegistryResourceGroup) && empty(existingContainerRegistryName)
          ? 'AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP requires AZURE_EXISTING_CONTAINER_REGISTRY_NAME.'
          : !empty(existingStorageAccountResourceGroup) && empty(existingStorageAccountName)
            ? 'AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME.'
            : !empty(existingFileShareName) && empty(existingStorageAccountName)
              ? 'AZURE_EXISTING_FILE_SHARE_NAME requires AZURE_EXISTING_STORAGE_ACCOUNT_NAME.'
              : !empty(existingManagedIdentityResourceGroup) && empty(existingManagedIdentityName)
                ? 'AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP requires AZURE_EXISTING_MANAGED_IDENTITY_NAME.'
                : !empty(infrastructureSubnetId) && !startsWith(toLower(infrastructureSubnetId), toLower('/subscriptions/${subscription().subscriptionId}/'))
                  ? 'AZURE_INFRASTRUCTURE_SUBNET_ID must be in the deployment subscription.'
                  : ''
var resourceToken = empty(reuseInputError)
  ? toLower(uniqueString(subscription().id, environmentName, location))
  : fail(reuseInputError)

// This flag describes only the NEW environment path. An existing environment
// can have a subnet AND an external load balancer; its actual internal property
// is read below instead of guessing its exposure from VNet integration.
var vnetInjected = privateDeployment || !empty(infrastructureSubnetId)
var createContainerAppsEnvironment = empty(existingContainerAppsEnvironmentName)
var createPrivateNetwork = createContainerAppsEnvironment && privateDeployment && empty(infrastructureSubnetId)
var privateVirtualNetworkName = 'vnet-citadelui-${resourceToken}'
var privateSubnetName = 'snet-containerapps'
var effectiveInfrastructureSubnetId = createPrivateNetwork
  ? resourceId('Microsoft.Network/virtualNetworks/subnets', privateVirtualNetworkName, privateSubnetName)
  : infrastructureSubnetId
var effectiveContainerAppsEnvironmentName = createContainerAppsEnvironment
  ? 'cae-citadelui-${resourceToken}'
  : existingContainerAppsEnvironmentName
var effectiveContainerAppsEnvironmentResourceGroup = empty(existingContainerAppsEnvironmentResourceGroup)
  ? resourceGroup().name
  : existingContainerAppsEnvironmentResourceGroup
var createLogAnalytics = createContainerAppsEnvironment && empty(existingLogAnalyticsWorkspaceName)
var effectiveLogAnalyticsWorkspaceName = createLogAnalytics ? 'log-citadelui-${resourceToken}' : existingLogAnalyticsWorkspaceName
var effectiveLogAnalyticsWorkspaceResourceGroup = empty(existingLogAnalyticsWorkspaceResourceGroup)
  ? resourceGroup().name
  : existingLogAnalyticsWorkspaceResourceGroup
var createRegistry = empty(existingContainerRegistryName)
var effectiveRegistryName = createRegistry ? 'crcitadelui${resourceToken}' : existingContainerRegistryName
var effectiveRegistryResourceGroup = empty(existingContainerRegistryResourceGroup)
  ? resourceGroup().name
  : existingContainerRegistryResourceGroup
var createStorage = empty(existingStorageAccountName)
var effectiveStorageAccountName = createStorage ? 'stcitadelui${resourceToken}' : existingStorageAccountName
var effectiveStorageAccountResourceGroup = empty(existingStorageAccountResourceGroup)
  ? resourceGroup().name
  : existingStorageAccountResourceGroup
var createIdentity = empty(existingManagedIdentityName)
var effectiveIdentityName = createIdentity ? 'id-citadelui-${resourceToken}' : existingManagedIdentityName
var effectiveIdentityResourceGroup = empty(existingManagedIdentityResourceGroup)
  ? resourceGroup().name
  : existingManagedIdentityResourceGroup

// Every resource carries this so `azd down`, the portal and a cost report can
// all see one environment as one thing.
var tags = {
  'azd-env-name': environmentName
}

var containerAppName = 'ca-citadelui-${resourceToken}'
var containerPort = 4173
var dataMountPath = '/data'
// The share and in-container volume keep their original names. The environment
// binding is shared by all apps in an environment, so on reuse it must identify
// this deployment (including its RG), not overwrite another UI's citadel-data.
// Keep the original binding name on the create path for redeploy compatibility.
var dataVolumeName = 'citadel-data'
var fileShareName = 'citadel-data'
var effectiveFileShareName = !empty(existingFileShareName)
  ? existingFileShareName
  : (createStorage ? fileShareName : 'citadel-data-${uniqueString(resourceGroup().id, containerAppName)}')
var createShareInExistingAccount = persistData && !createStorage && empty(existingFileShareName)
var environmentStorageName = createContainerAppsEnvironment
  ? dataVolumeName
  : 'citadel-data-${uniqueString(resourceGroup().id, containerAppName)}'

// Role definition GUIDs. Written out rather than looked up so a reader can
// check them against the docs without deploying anything.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'
// ABAC-enabled registries do not honor AcrPull/AcrPush. These roles grant
// repository read/write without delete or catalog listing. Assignments remain
// registry-scoped (all repositories); no existing ABAC conditions are rewritten.
var acrRepositoryReaderRoleId = 'b93aa761-3e63-49ed-ac28-beffa264f7ac'
var acrRepositoryWriterRoleId = '2a1e307c-b015-4ebd-883e-5b7698a07328'
// Push permission is NOT permission to schedule an ACR remote build.
var acrTasksContributorRoleId = 'fb382eab-e894-4461-af04-94435c366c3f'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

// ---------------------------------------------------------------------------
// Log Analytics -- create or read an existing workspace for a NEW environment.
// An existing environment keeps its own logging configuration unchanged, and
// requires neither a new workspace nor permission to read its workspace keys.
// ---------------------------------------------------------------------------

module logAnalytics 'br/public:avm/res/operational-insights/workspace:0.16.1' = if (createLogAnalytics) {
  name: 'log-analytics'
  params: {
    name: effectiveLogAnalyticsWorkspaceName
    location: location
    tags: tags
    skuName: 'PerGB2018'
    // 30 days is the longest retention that is included in the per-GB price;
    // beyond it you pay for storage as well as ingestion.
    dataRetention: 30
    // A single-user app produces a trickle of logs. The cap is not there to
    // shape cost so much as to bound the damage if something starts looping.
    // (The module takes this as a string so that fractions of a GB are
    // expressible; '-1' is its no-limit sentinel.)
    dailyQuotaGb: '1'
  }
}

resource existingLogAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (createContainerAppsEnvironment && !createLogAnalytics) {
  name: existingLogAnalyticsWorkspaceName
  scope: resourceGroup(effectiveLogAnalyticsWorkspaceResourceGroup)
}

// ---------------------------------------------------------------------------
// Identity -- one identity for both ACR pull and Key Vault read
// ---------------------------------------------------------------------------

// User-assigned rather than system-assigned because the identity has to exist,
// and be granted registry read access, *before* the app pulls its first image.
// A system-assigned identity is created with the app, which is one ordering
// problem too late.
//
// Written as a raw resource rather than avm/res/managed-identity/user-assigned-identity,
// and the reason is not taste: the container app's `identity` block is a map
// keyed by the identity's resource id, and ARM has to know that key before the
// deployment starts. A module output is only known after the module has run, so
// the AVM version compiles and then fails validation (BCP120). A plain resource
// has an id that is computable up front. The module also adds nothing here --
// there are no defaults worth inheriting on a resource with three properties.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (createIdentity) {
  name: effectiveIdentityName
  location: location
  tags: tags
}

resource existingIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!createIdentity) {
  name: existingManagedIdentityName
  scope: resourceGroup(effectiveIdentityResourceGroup)
}

// IDs in the identity map must be known before deployment starts. Resource IDs
// remain computable from names/scopes; only client/principal IDs are read at runtime.
var effectiveIdentityId = createIdentity ? identity.id : existingIdentity.id
var effectiveIdentityClientId = createIdentity ? identity!.properties.clientId : existingIdentity!.properties.clientId
var effectiveIdentityPrincipalId = createIdentity ? identity!.properties.principalId : existingIdentity!.properties.principalId

// ---------------------------------------------------------------------------
// Container registry -- create or reuse, including a different resource group.
// ---------------------------------------------------------------------------

// This read API includes roleAssignmentMode; older stable APIs omit it and
// would incorrectly select AcrPull/AcrPush for an ABAC-enabled registry.
resource existingRegistry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = if (!createRegistry) {
  name: existingContainerRegistryName
  scope: resourceGroup(effectiveRegistryResourceGroup)
}

module registry 'br/public:avm/res/container-registry/registry:0.13.0' = if (createRegistry) {
  name: 'registry'
  params: {
    name: effectiveRegistryName
    location: location
    tags: tags
    // Basic is enough for one image and one puller, and it is a fifth of the
    // price of Standard. It has no geo-replication and no private endpoints,
    // neither of which this deployment uses.
    acrSku: 'Basic'
    // No admin user. The admin account is a username and password that would
    // have to be stored somewhere, and the whole point of the identity above is
    // that there is nothing to store.
    acrAdminUserEnabled: false
    // New registries use the established AcrPull/AcrPush permission model.
    // Existing registries retain their own mode, including ABAC.
    roleAssignmentMode: 'LegacyRegistryPermissions'
    // Container Apps managed-identity image pull requires ARM audience tokens.
    // AVM defaults this to disabled; set the required policy on CREATE only.
    // Reuse preflight checks it, but never changes an existing registry policy.
    azureADAuthenticationAsArmPolicyStatus: 'enabled'
    publicNetworkAccess: 'Enabled'
    // AVM emits a `networkRuleSet` whenever public access is Enabled and the
    // default action is Deny, and Deny is its default. ACR Basic cannot accept
    // one at all -- network rules are a Premium feature -- so the deployment
    // fails with `NetworkRuleNotSupported` before anything is created.
    //
    // Setting this to Allow suppresses the block rather than loosening it:
    // Basic has no rule engine to relax. Access is controlled where it actually
    // is for this registry -- AcrPull granted to the one managed identity, with
    // the admin account disabled above, so there is no key to leak and no
    // anonymous pull. A registry that must be network-restricted needs Premium
    // and a private endpoint, which is the same conclusion the Key Vault ACL
    // above reaches for the same reason.
    networkRuleSetDefaultAction: 'Allow'
  }
}

var registryEndpoint = createRegistry ? registry!.outputs.loginServer : existingRegistry!.properties.loginServer
var registryRoleAssignmentMode = createRegistry
  ? 'LegacyRegistryPermissions'
  : (existingRegistry!.properties.?roleAssignmentMode ?? 'LegacyRegistryPermissions')
var registryUsesAbac = registryRoleAssignmentMode == 'AbacRepositoryPermissions'
  ? true
  : (registryRoleAssignmentMode == 'LegacyRegistryPermissions' ? false : fail('Unsupported registry roleAssignmentMode. Expected LegacyRegistryPermissions or AbacRepositoryPermissions.'))

module acrPull 'modules/registry-role-assignment.bicep' = {
  name: 'rbac-acr-pull-${uniqueString(resourceGroup().id, containerAppName)}'
  scope: resourceGroup(effectiveRegistryResourceGroup)
  params: {
    registryName: effectiveRegistryName
    principalId: effectiveIdentityPrincipalId
    subjectId: effectiveIdentityId
    roleDefinitionId: registryUsesAbac ? acrRepositoryReaderRoleId : acrPullRoleId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    registry
  ]
}

// The app only pulls. The deploying principal separately needs image push and
// task execution for azure.yaml's remoteBuild. All grants target this registry,
// never its whole RG/subscription, and do not permit registry reconfiguration.
// A caller omitting principalId must arrange its own build/push permissions.
module acrPush 'modules/registry-role-assignment.bicep' = if (!empty(principalId)) {
  name: 'rbac-acr-push-${uniqueString(resourceGroup().id, containerAppName)}'
  scope: resourceGroup(effectiveRegistryResourceGroup)
  params: {
    registryName: effectiveRegistryName
    principalId: principalId
    subjectId: principalId
    roleDefinitionId: registryUsesAbac ? acrRepositoryWriterRoleId : acrPushRoleId
    principalType: principalType
  }
  dependsOn: [
    registry
  ]
}

// ABAC quick builds additionally require caller source authentication
// (`az acr build --source-acr-auth-id "[caller]"`). A role assignment alone
// cannot add that setting to an azd version whose remote builder omits it.
module acrBuild 'modules/registry-role-assignment.bicep' = if (!empty(principalId)) {
  name: 'rbac-acr-build-${uniqueString(resourceGroup().id, containerAppName)}'
  scope: resourceGroup(effectiveRegistryResourceGroup)
  params: {
    registryName: effectiveRegistryName
    principalId: principalId
    subjectId: principalId
    roleDefinitionId: acrTasksContributorRoleId
    principalType: principalType
  }
  dependsOn: [
    registry
  ]
}

// ---------------------------------------------------------------------------
// Key Vault -- create or reuse
// ---------------------------------------------------------------------------

var createKeyVault = empty(keyVaultName)
var effectiveKeyVaultName = createKeyVault ? 'kv-citadel-${resourceToken}' : keyVaultName
var effectiveKeyVaultResourceGroup = createKeyVault || empty(keyVaultResourceGroup) ? resourceGroup().name : keyVaultResourceGroup

module keyVault 'br/public:avm/res/key-vault/vault:0.14.0' = if (createKeyVault) {
  name: 'key-vault'
  params: {
    name: effectiveKeyVaultName
    location: location
    tags: tags
    sku: 'standard'
    // RBAC, not access policies: the identity's grant is then one assignment
    // that can be listed, audited and removed like every other grant in the
    // subscription, instead of an entry in a list only the vault knows about.
    enableRbacAuthorization: true
    enableSoftDelete: true
    // The floor is 7 days. Purge protection is deliberately off: this is a test
    // deployment and the user has to be able to delete the vault and reuse the
    // name. Turn it on for anything holding a real key -- it cannot be turned
    // on and off again, so it is the one setting here that is a one-way door.
    softDeleteRetentionInDays: 7
    enablePurgeProtection: false
    publicNetworkAccess: 'Enabled'
    // AVM defaults the network ACL to Deny, which is the right default almost
    // everywhere and wrong here: the container app runs in a Microsoft-managed
    // environment with no VNet integration, so its egress is a public IP that no
    // rule list can name. Denying by default would fail the app at startup, when
    // it goes to read the credential key, and the failure would look like a
    // permissions problem rather than a networking one. A private endpoint is
    // the real answer and is out of scope for this iteration.
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

// Built from the name rather than read from the vault. The vault only exists on
// one of the two paths, and asking ARM for a property of a resource that the
// other path never created is the classic way a create-or-reuse template
// compiles cleanly and then fails at deploy time. The URI is a pure function of
// the name and the cloud, so there is nothing to look up.
var keyVaultUri = 'https://${effectiveKeyVaultName}${environment().suffixes.keyvaultDns}/'

// The app's grant. `scope` is what makes reuse work across resource groups; on
// the create path it resolves to this one. dependsOn rather than a reference to
// the module's output for the same reason as above -- the output does not exist
// on the reuse path, and a dependency on a module that was not deployed is
// simply ignored.
module keyVaultSecretsUser 'modules/keyvault-role-assignment.bicep' = {
  name: 'rbac-kv-secrets-user'
  scope: resourceGroup(effectiveKeyVaultResourceGroup)
  params: {
    keyVaultName: effectiveKeyVaultName
    principalId: effectiveIdentityPrincipalId
    subjectId: effectiveIdentityId
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    keyVault
  ]
}

// Creating an RBAC vault grants you nothing inside it: the person who just ran
// `azd up` would own a vault they cannot write the credential key into, and the
// first failure would be a 403 from `az keyvault secret set` several minutes
// after a successful deployment. Only on the create path -- an existing vault
// already has its own owners and this template has no business changing them.
module keyVaultSecretsOfficer 'modules/keyvault-role-assignment.bicep' = if (createKeyVault && !empty(principalId)) {
  name: 'rbac-kv-secrets-officer'
  params: {
    keyVaultName: effectiveKeyVaultName
    principalId: principalId
    subjectId: principalId
    roleDefinitionId: keyVaultSecretsOfficerRoleId
    principalType: principalType
  }
  dependsOn: [
    keyVault
  ]
}

// ---------------------------------------------------------------------------
// Durable state -- storage account and the Azure Files share behind /data
// ---------------------------------------------------------------------------

// A container's filesystem dies with its replica, and /data is not a cache: it
// holds the workspace registry, connection profiles, the activity log and the
// encrypted credential envelopes. Without this share a routine revision change
// -- which is what every `azd deploy` performs -- silently discards the user's
// work.
module storage 'br/public:avm/res/storage/storage-account:0.33.0' = if (createStorage) {
  name: 'storage'
  params: {
    name: effectiveStorageAccountName
    location: location
    tags: tags
    kind: 'StorageV2'
    // LRS: three copies in one datacentre. The data here is reconstructible and
    // the app is single-user; ZRS would double the price to protect against a
    // failure mode this deployment does not otherwise survive anyway.
    skuName: 'Standard_LRS'
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    // Shared key access stays on because it has to: the environment's Azure
    // Files binding below authenticates with the account key, and that is the
    // only auth the platform supports for this mount today. The key is read by
    // ARM and held in the environment's own configuration -- it never reaches
    // the application's environment, where a crash report or `docker inspect`
    // equivalent could surface it.
    allowSharedKeyAccess: true
    // AVM defaults the network ACL to Deny, and Deny with no rules means every
    // address is refused -- including the Container Apps environment, which is
    // Microsoft-managed, has no VNet integration here, and therefore reaches
    // this account from an address no rule list can name. `publicNetworkAccess:
    // Enabled` above is not enough on its own: it opens the door while this
    // leaves it bolted, and the SMB mount then fails with `mount error(13):
    // Permission denied`. The container exits 1 at startup, because /data is
    // required to boot, and the platform reports it as a crash loop rather than
    // as a storage rule -- the cause is four layers from the symptom.
    //
    // A private endpoint is the real answer and is out of scope for this
    // iteration; the account is still protected by requiring the key, HTTPS
    // only, and no public blob access.
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    fileServices: {
      shares: [
        {
          name: effectiveFileShareName
          // 5 GiB. Azure Files on a standard account bills for what is used,
          // not for the quota, so this is a guard rail rather than a purchase.
          shareQuota: 5
        }
      ]
    }
  }
}

resource existingStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (!createStorage) {
  name: existingStorageAccountName
  scope: resourceGroup(effectiveStorageAccountResourceGroup)
}

resource existingDataShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' existing = if (!empty(existingFileShareName)) {
  name: '${existingStorageAccountName}/default/${existingFileShareName}'
  scope: resourceGroup(effectiveStorageAccountResourceGroup)
}

// This deliberately NEW share has a deployment-specific name. Naming an
// existing share above instead suppresses this module entirely: no quota,
// protocol, metadata or data writes are sent for a selected existing share.
module newDataShare 'modules/storage-share.bicep' = if (createShareInExistingAccount) {
  name: 'storage-share-${uniqueString(resourceGroup().id, containerAppName)}'
  scope: resourceGroup(effectiveStorageAccountResourceGroup)
  params: {
    accountName: effectiveStorageAccountName
    shareName: effectiveFileShareName
    // Classic premium file shares require at least 100 GiB. Standard accounts
    // retain the small 5 GiB guardrail. Existing shares keep their own quotas.
    shareQuotaGiB: createShareInExistingAccount ? (existingStorageAccount!.sku.tier == 'Premium' ? 100 : 5) : 5
  }
}

// ---------------------------------------------------------------------------
// Container Apps environment
// ---------------------------------------------------------------------------

module privateNetwork 'modules/private-network.bicep' = if (createPrivateNetwork) {
  name: 'private-network'
  params: {
    name: privateVirtualNetworkName
    subnetName: privateSubnetName
    location: location
    tags: tags
  }
}

// The newer read API exposes publicNetworkAccess. The create resource retains
// its existing API/defaults; no PUT of an existing environment is emitted.
resource existingContainerAppsEnvironment 'Microsoft.App/managedEnvironments@2025-07-01' existing = if (!createContainerAppsEnvironment) {
  name: existingContainerAppsEnvironmentName
  scope: resourceGroup(effectiveContainerAppsEnvironmentResourceGroup)
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = if (createContainerAppsEnvironment) {
  name: effectiveContainerAppsEnvironmentName
  location: location
  tags: tags
  properties: union({
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        // The environment authenticates to the workspace with its shared key --
        // there is no managed-identity option for this hop today. The key is
        // taken from a secure AVM output or listKeys at the existing workspace's
        // scope. Neither is exposed as a deployment output or app environment
        // variable. Guard BOTH branches: ARM can evaluate reference/listKeys
        // expressions even on a resource with a false deployment condition.
        customerId: createLogAnalytics
          ? logAnalytics!.outputs.logAnalyticsWorkspaceId
          : (createContainerAppsEnvironment ? existingLogAnalyticsWorkspace!.properties.customerId : '')
        // The matching condition guards this access. A module null assertion
        // cannot be used here: secure outputs require a DIRECT module reference.
        sharedKey: createLogAnalytics
          #disable-next-line BCP318
          ? logAnalytics.outputs.primarySharedKey
          : (createContainerAppsEnvironment ? existingLogAnalyticsWorkspace!.listKeys().primarySharedKey : '')
      }
    }
    // Consumption only. A dedicated workload profile bills for a reserved
    // instance whether or not anything is running, which for an app that spends
    // most of its life at zero replicas is the entire bill.
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }, vnetInjected ? {
    // `internal: true` is what makes this the private topology: the environment
    // gets an internal load balancer in the supplied subnet and no public
    // endpoint at all. The subnet must be delegated to Microsoft.App/environments
    // and be at least a /27; Azure rejects the deployment otherwise rather than
    // degrading to a public environment.
    vnetConfiguration: {
      infrastructureSubnetId: effectiveInfrastructureSubnetId
      internal: true
    }
  } : {})
  dependsOn: [
    privateNetwork
  ]
}

// Fresh private networking includes resolution of the ILB environment hostname.
// Existing VNet/subnet DNS and connectivity remain operator-owned; no shared
// DNS zones, links, peerings, gateways or private endpoints are reconfigured.
module privateDns 'modules/private-environment-dns.bicep' = if (createPrivateNetwork) {
  name: 'private-environment-dns'
  params: {
    domainName: createPrivateNetwork ? containerAppsEnvironment!.properties.defaultDomain : ''
    staticIp: createPrivateNetwork ? containerAppsEnvironment!.properties.staticIp : ''
    virtualNetworkId: resourceId('Microsoft.Network/virtualNetworks', privateVirtualNetworkName)
    tags: tags
  }
  dependsOn: [
    privateNetwork
  ]
}

var effectiveContainerAppsEnvironmentId = createContainerAppsEnvironment
  ? containerAppsEnvironment.id
  : existingContainerAppsEnvironment.id
var containerAppsEnvironmentDefaultDomain = createContainerAppsEnvironment
  ? containerAppsEnvironment!.properties.defaultDomain
  : existingContainerAppsEnvironment!.properties.defaultDomain
var environmentIsInternal = createContainerAppsEnvironment
  ? vnetInjected
  : (privateDeployment && !(existingContainerAppsEnvironment!.properties.?vnetConfiguration.?internal ?? false)
      ? fail('CITADEL_PRIVATE_DEPLOYMENT=true requires an internal existing Container Apps environment; its network will not be changed.')
      : (existingContainerAppsEnvironment!.properties.?vnetConfiguration.?internal ?? false))
var environmentAllowsPublicNetwork = createContainerAppsEnvironment
  ? !vnetInjected
  : toLower(existingContainerAppsEnvironment!.properties.?publicNetworkAccess ?? 'Enabled') == 'enabled'
// Legacy consumption-only environments have no workloadProfiles. Omit a
// workload profile for those; a profiles environment must already have the
// Consumption profile (checked by preflight, never added to the shared env).
var environmentUsesWorkloadProfiles = createContainerAppsEnvironment
  ? true
  : !empty(existingContainerAppsEnvironment!.properties.?workloadProfiles)

// The environment, not the app, owns the Azure Files binding; the app then
// mounts it by name. accessMode is ReadWrite because /data is written on every
// save, every commit and every activity entry.
//
// Conditional, because the binding authenticates with the storage account key
// and some tenants forbid that. Where `allowSharedKeyAccess` is denied by
// governance the account silently reports `false` however it is created, the
// CIFS mount is then refused with `mount error(13): Permission denied`, and the
// container exits 1 at startup -- /data is required to boot, not merely to
// persist. Rather than fail there, `persistData` selects an ephemeral volume so
// the app runs; see the volume declaration for what that costs.
module dataStorage 'modules/container-apps-storage.bicep' = if (persistData) {
  name: 'container-apps-storage-${uniqueString(resourceGroup().id, containerAppName)}'
  scope: resourceGroup(effectiveContainerAppsEnvironmentResourceGroup)
  params: {
    environmentName: effectiveContainerAppsEnvironmentName
    storageName: environmentStorageName
    accountName: effectiveStorageAccountName
    // Guard runtime key operations even when this module is not deployed.
    // Secure AVM outputs require a direct module reference, not storage!.
    accountKey: !persistData ? '' : (createStorage
      #disable-next-line BCP318
      ? storage.outputs.primaryAccessKey
      : existingStorageAccount!.listKeys().keys[0].value)
    shareName: effectiveFileShareName
  }
  dependsOn: [
    containerAppsEnvironment
    newDataShare
  ]
}

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

// Two independent decisions, kept apart so neither happens by accident.
// `authConfigured` means Entra is in front of the app. `publicIngress` means
// the app is on the internet, by either route. See the ingress block below.
//
// Only an INTERNAL environment has a private load balancer. VNet integration
// alone says nothing about internet exposure. Existing environments also retain
// their publicNetworkAccess setting: this template never enables it. On an
// external environment with public access disabled, keep this app environment-
// only, even when a public option is supplied; no private endpoint is provisioned.
var authConfigured = !empty(entraAuthClientId)
var publicIngress = !environmentIsInternal && environmentAllowsPublicNetwork && (authConfigured || allowPublicIngressWithoutAuth)
// True when the app is reachable beyond the Container Apps environment itself --
// on the internet when the environment is public, on the VNet's internal load
// balancer when it is injected. Container Apps spells both `external: true`; the
// difference is the environment, not the app.
var reachableBeyondEnvironment = environmentIsInternal || publicIngress
var authClientSecretConfigured = authConfigured && !empty(entraAuthClientSecret)
var authClientSecretName = 'entra-client-secret'

// Container Apps publishes an external app at `<name>.<defaultDomain>` and an
// internal one at `<name>.internal.<defaultDomain>`, and the server compares the
// Host header byte for byte. Deriving the name from the environment's default
// domain is what lets the app be told its own address before it exists; getting
// it wrong is not a degraded deployment, it is 421 on every request including
// the probes, which looks exactly like a broken image.
var appFqdn = reachableBeyondEnvironment
  ? '${containerAppName}.${containerAppsEnvironmentDefaultDomain}'
  : '${containerAppName}.internal.${containerAppsEnvironmentDefaultDomain}'
// A public-capable environment uses the future external URL to bootstrap
// registration before auth is configured. A disabled public network cannot
// publish this app, so its callback must retain the actual .internal. host.
var authRedirectFqdn = environmentIsInternal || environmentAllowsPublicNetwork
  ? '${containerAppName}.${containerAppsEnvironmentDefaultDomain}'
  : appFqdn

// First `azd up` has an empty registry, so the app is created against a public
// placeholder and azd replaces it the moment the build finishes. The placeholder
// is not the product: it serves on a different port and has no /healthz, which
// is why the probes below are only attached once a real image exists. Probing a
// stand-in against the product's health contract guarantees a failing first
// revision and an alarming, meaningless error.
var imageProvided = !empty(citadelUiImageName)
var containerImage = imageProvided ? citadelUiImageName : 'mcr.microsoft.com/k8se/quickstart:latest'

// The server checks Host before it routes, so /healthz is refused with 421
// unless the probe asks for the same host a browser would. Container Apps sends
// the replica address by default, which is never that host. This is the same
// problem the Dockerfile HEALTHCHECK solves by using node:http instead of fetch
// so it can set the header; here the platform sets it for us.
var healthProbeHttpGet = {
  path: '/healthz'
  port: containerPort
  scheme: 'HTTP'
  httpHeaders: [
    {
      name: 'Host'
      value: appFqdn
    }
  ]
}

var healthProbes = [
  {
    type: 'Readiness'
    httpGet: healthProbeHttpGet
    initialDelaySeconds: 5
    periodSeconds: 10
    timeoutSeconds: 3
    successThreshold: 1
    failureThreshold: 3
  }
  {
    type: 'Liveness'
    httpGet: healthProbeHttpGet
    initialDelaySeconds: 15
    periodSeconds: 30
    timeoutSeconds: 3
    failureThreshold: 3
  }
]

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  // azd finds the app to deploy to by this tag. Renaming it silently detaches
  // the service in azure.yaml from the resource it is supposed to update.
  tags: union(tags, {
    'azd-service-name': 'citadelui'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${effectiveIdentityId}': {}
    }
  }
  properties: {
    environmentId: effectiveContainerAppsEnvironmentId
    workloadProfileName: environmentUsesWorkloadProfiles ? 'Consumption' : null
    configuration: {
      activeRevisionsMode: 'Single'
      // ---------------------------------------------------------------------
      // `external: reachableBeyondEnvironment` is the exposure invariant of this
      // template, expressed as code so that it cannot be got wrong by editing a
      // boolean: the app is reachable beyond its own environment only because
      // someone decided it should be, never as a side effect of another setting.
      //
      // What "beyond" means is decided by the environment, not by this flag.
      // On an internal environment there is no public load balancer, so this
      // publishes the app on the VNet's internal one -- a private address,
      // reachable from the Citadel AI Hub Gateway VNet and from whatever is
      // peered or connected to it, and from nowhere else.
      //
      // On a public environment there are two ways to reach this point, kept
      // deliberately separate. Supplying `entraAuthClientId` publishes the app
      // with Entra in front of it. Setting `allowPublicIngressWithoutAuth`
      // publishes it with only the app's own owner sign-in in front -- a real
      // control, since an anonymous visitor is issued no session token and every
      // data route refuses one, but a weaker one than Entra, because a container
      // nobody has claimed yet belongs to whoever reaches it first.
      //
      // With none of the three set the app still deploys and still works: it is
      // reachable from inside the environment, and simply not on any network
      // anyone else is on.
      // ---------------------------------------------------------------------
      ingress: {
        external: reachableBeyondEnvironment
        targetPort: containerPort
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      // Identity-based pull only. No registry credentials are fetched or
      // injected, even if an existing registry has its admin account enabled.
      registries: [
        {
          server: registryEndpoint
          identity: effectiveIdentityId
        }
      ]
      secrets: authClientSecretConfigured ? [
        {
          name: authClientSecretName
          value: entraAuthClientSecret
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'citadelui'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          // Every value here is public configuration. The one secret this app
          // has -- the credential key-encryption key -- is fetched at runtime
          // from Key Vault with the identity below, precisely so it is never an
          // environment value: an environment value shows up in a process
          // listing, in a crash report and in every diagnostic dump.
          env: [
            {
              name: 'CITADEL_DATA_ROOT'
              value: dataMountPath
            }
            {
              name: 'CITADEL_UI_PORT'
              value: string(containerPort)
            }
            {
              // Bind to all interfaces, not loopback: the ingress proxy reaches
              // the container over the pod network.
              name: 'CITADEL_UI_HOST'
              value: '0.0.0.0'
            }
            {
              // Host header form: no scheme, no trailing slash, and no port.
              // Container Apps terminates on 443 and browsers omit the default
              // port from Host, so adding :443 here would reject every request.
              name: 'CITADEL_ALLOWED_HOST'
              value: appFqdn
            }
            {
              // Origin form: scheme and host, no trailing slash, and https --
              // the server compares this to the browser's Origin header on
              // every state-changing request.
              name: 'CITADEL_ALLOWED_ORIGIN'
              value: 'https://${appFqdn}'
            }
            {
              name: 'CITADEL_CREDENTIAL_KEY_SOURCE'
              value: 'keyvault'
            }
            {
              name: 'CITADEL_KEY_VAULT_URI'
              value: keyVaultUri
            }
            {
              name: 'CITADEL_CREDENTIAL_SECRET_NAME'
              value: credentialSecretName
            }
            {
              // Not optional. The app gets its token from the Container Apps
              // identity endpoint, and with a user-assigned identity that
              // request must name the client id -- there is more than one
              // possible answer, so without it the endpoint either picks the
              // wrong principal or returns 400. It fails at runtime, on the
              // first vault read, long after a green deployment.
              name: 'AZURE_CLIENT_ID'
              value: effectiveIdentityClientId
            }
          ]
          volumeMounts: [
            {
              volumeName: dataVolumeName
              mountPath: dataMountPath
            }
          ]
          probes: imageProvided ? healthProbes : []
        }
      ]
      volumes: [
        persistData
          ? {
              name: dataVolumeName
              storageType: 'AzureFile'
              storageName: environmentStorageName
              // SMB has no POSIX ownership, so the mount decides it once for every
              // file on it. This image runs as UID 10001 and every store under /data
              // opens its files 0600 and its directories 0700; a mount owned by root
              // would fail the very first write, at startup, with a permission error
              // that looks nothing like a storage problem. Setting the modes here
              // also preserves the property the code is explicit about wanting --
              // nothing under /data is group- or world-readable -- which a per-file
              // chmod cannot deliver over SMB because the server ignores it.
              mountOptions: 'uid=10001,gid=10001,dir_mode=0700,file_mode=0600,mfsymlinks,nobrl'
            }
          : {
              // Ephemeral. The app boots and works, but /data lives only as long as
              // the replica: workspaces, connection profiles, the activity log and
              // the sealed credential envelopes are all lost on a restart, a scale
              // to zero, or a new revision. The credential KEY survives, because it
              // is in Key Vault -- what is lost is the sealed token, so the user
              // re-enters a PAT rather than losing anything unrecoverable.
              //
              // This is the honest fallback when the tenant forbids shared-key
              // storage: an app that runs and forgets is better than one that
              // cannot start, but it is NOT the intended production shape. Durable
              // state needs either shared-key access permitted on the account, or
              // Premium Files over NFS with VNet integration, which does not use an
              // account key at all.
              name: dataVolumeName
              storageType: 'EmptyDir'
            }
      ]
      scale: {
        // Scale to zero. This is the single largest cost decision here: a
        // single-user tool is idle almost all of the time, and idle replicas are
        // most of the bill. The trade is a cold start of a few seconds on the
        // first request after an idle period.
        minReplicas: 0
        // One replica, always. The app keeps session state in memory and writes
        // to /data over SMB; a second replica would be a second writer and a
        // second session store, and the app is not built for either. Capping at
        // one is what makes minReplicas 0 safe rather than merely cheap.
        maxReplicas: 1
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
  // Two orderings ARM cannot infer. The volume names the environment's storage
  // by string, not by reference, so nothing tells ARM the binding has to exist
  // first; and the pull grant is on the registry, not on the app, so the app
  // would otherwise be free to start pulling before it is allowed to. Both
  // failures land after a green deployment, on the replica, as "image pull
  // failed" or "volume mount failed".
  dependsOn: [
    dataStorage
    acrPull
  ]
}

// Container Apps built-in authentication. This sits in front of the container,
// so an unauthenticated request is redirected to Entra and never reaches the
// point where the server issues a session token. The app's own defences -- exact
// Host, Fetch Metadata, Origin, CSP -- are unchanged and remain the second
// layer; this is the one that makes public ingress defensible at all.
resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = if (authConfigured) {
  parent: containerApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      // Redirect rather than 401: this is a browser application, and the user
      // should land on a sign-in page, not on a JSON error.
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        // A secret-backed Web app registration uses hybrid flow. Without a
        // client secret, built-in auth uses implicit ID-token flow and the
        // registration must enable ID token issuance. Neither is SPA/PKCE.
        // A supplied client secret is stored as a container app secret and
        // referenced here by name, never inlined.
        registration: union({
          // environment() rather than a literal login.microsoftonline.com, so
          // the template is still correct in a sovereign cloud. The endpoint
          // already carries its trailing slash.
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
          clientId: entraAuthClientId
        }, authClientSecretConfigured ? {
          clientSecretSettingName: authClientSecretName
        } : {})
        validation: {
          // Only tokens minted for this application are accepted. Without this
          // any token from the tenant would pass.
          allowedAudiences: [
            entraAuthClientId
          ]
        }
      }
    }
    login: {
      // The app keeps state in the URL fragment; without this the fragment is
      // dropped across the login redirect and the user lands back on a reset view.
      preserveUrlFragmentsForLogins: true
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs -- azd writes these into the environment's .env
// ---------------------------------------------------------------------------

@description('Registry login server. azd pushes the built image here.')
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registryEndpoint

@description('Registry name.')
output AZURE_CONTAINER_REGISTRY_NAME string = effectiveRegistryName

@description('Resource group of the created or reused registry. Build and role-assignment operations must target this group, not assume AZURE_RESOURCE_GROUP.')
output AZURE_CONTAINER_REGISTRY_RESOURCE_GROUP string = effectiveRegistryResourceGroup

@description('Whether the registry was reused without reconfiguring it.')
output AZURE_CONTAINER_REGISTRY_REUSED bool = !createRegistry

@description('Actual registry permission mode: LegacyRegistryPermissions or AbacRepositoryPermissions. ABAC quick builds require explicit caller source authentication, not just a push role.')
output AZURE_CONTAINER_REGISTRY_ROLE_ASSIGNMENT_MODE string = registryRoleAssignmentMode

@description('Resource id of the Container Apps environment.')
output AZURE_CONTAINER_APP_ENVIRONMENT_ID string = effectiveContainerAppsEnvironmentId

@description('Name of the Container Apps environment.')
output AZURE_CONTAINER_APP_ENVIRONMENT_NAME string = effectiveContainerAppsEnvironmentName

@description('Resource group containing the created or reused Container Apps environment. May differ from AZURE_RESOURCE_GROUP.')
output AZURE_CONTAINER_APP_ENVIRONMENT_RESOURCE_GROUP string = effectiveContainerAppsEnvironmentResourceGroup

@description('True when the environment is reused without reconfiguring it. Only the storage binding for this UI is added.')
output AZURE_CONTAINER_APP_ENVIRONMENT_REUSED bool = !createContainerAppsEnvironment

@description('Subnet of the created environment, or the actual subnet of a reused environment. Empty for non-VNet environments. An output, not an override selector.')
output AZURE_CONTAINER_APP_ENVIRONMENT_SUBNET_ID string = createContainerAppsEnvironment
  ? effectiveInfrastructureSubnetId
  : (existingContainerAppsEnvironment!.properties.?vnetConfiguration.?infrastructureSubnetId ?? '')

@description('Environment DNS suffix, useful when configuring private DNS on an existing VNet.')
output AZURE_CONTAINER_APP_ENVIRONMENT_DEFAULT_DOMAIN string = containerAppsEnvironmentDefaultDomain

@description('Environment static IP. For an internal ILB environment, private DNS must resolve its default domain to this address.')
output AZURE_CONTAINER_APP_ENVIRONMENT_STATIC_IP string = createContainerAppsEnvironment
  ? containerAppsEnvironment!.properties.staticIp
  : (existingContainerAppsEnvironment!.properties.?staticIp ?? '')

@description('Workspace resource id for a NEW environment, whether created or reused. Empty for an existing environment, whose logging remains unchanged and whose workspace selectors must be omitted.')
output AZURE_LOG_ANALYTICS_WORKSPACE_RESOURCE_ID string = createContainerAppsEnvironment
  ? resourceId(effectiveLogAnalyticsWorkspaceResourceGroup, 'Microsoft.OperationalInsights/workspaces', effectiveLogAnalyticsWorkspaceName)
  : ''

@description('Resource group the deployment landed in.')
output AZURE_RESOURCE_GROUP string = resourceGroup().name

@description('URL of the app, read back from the platform. Reachability is reported separately by SERVICE_CITADELUI_NETWORK; a URL does not imply internet access.')
output SERVICE_CITADELUI_URI string = 'https://${containerApp.properties.configuration.ingress.fqdn}'

@description('Whether the app is reachable from the public internet. False while SERVICE_CITADELUI_NETWORK is `vnet` means it is reachable privately instead, not that it is unreachable.')
output SERVICE_CITADELUI_PUBLIC bool = publicIngress

@description('Which network the app is published on. `vnet` means an actual internal load balancer, not merely VNet integration. `internet` requires explicit publication and enabled public network access. `environment` means this app only accepts ingress from inside the environment, including external environments with public network access disabled.')
output SERVICE_CITADELUI_NETWORK string = environmentIsInternal ? 'vnet' : (publicIngress ? 'internet' : 'environment')

@description('Whether Container Apps built-in Entra authentication is in front of the app. False while SERVICE_CITADELUI_PUBLIC is true means the app is on the internet behind its own owner sign-in rather than behind Entra.')
output SERVICE_CITADELUI_ENTRA_AUTH bool = authConfigured

@description('Web reply URL to register before configuring Entra. Uses the future external-ingress URL for a public-capable or internal-ILB environment. On an external environment with public network access disabled, uses the actual environment-only host because this template does not enable public access.')
output AZURE_AUTH_REDIRECT_URI string = 'https://${authRedirectFqdn}/.auth/login/aad/callback'

@description('Name of the vault in use, whether created here or reused.')
output AZURE_KEY_VAULT_NAME string = effectiveKeyVaultName

@description('Resource group of the vault in use. Retains the existing AZURE_KEY_VAULT_RESOURCE_GROUP input contract on subsequent provisions.')
output AZURE_KEY_VAULT_RESOURCE_GROUP string = effectiveKeyVaultResourceGroup

@description('URI of the vault in use.')
output AZURE_KEY_VAULT_URI string = keyVaultUri

@description('Selected credential-secret name, also accepted as an azd input. Credential-key setup must preserve an existing key under this name. This output contains no key material; changing the name is not a migration of existing encrypted data.')
output CITADEL_CREDENTIAL_SECRET_NAME string = credentialSecretName

@description('Client id of the user-assigned identity. The app needs this to ask the Container Apps identity endpoint for the right token.')
output AZURE_CLIENT_ID string = effectiveIdentityClientId

@description('Resource ID of the created or reused user-assigned app identity.')
output AZURE_MANAGED_IDENTITY_ID string = effectiveIdentityId

@description('Name of the app identity.')
output AZURE_MANAGED_IDENTITY_NAME string = effectiveIdentityName

@description('Resource group of the app identity.')
output AZURE_MANAGED_IDENTITY_RESOURCE_GROUP string = effectiveIdentityResourceGroup

@description('Principal ID of the app identity receiving registry/vault roles, not the deploying principal.')
output AZURE_MANAGED_IDENTITY_PRINCIPAL_ID string = effectiveIdentityPrincipalId

@description('Exact Host header the server will accept.')
output CITADEL_ALLOWED_HOST string = appFqdn

@description('Exact Origin the server will accept on state-changing requests.')
output CITADEL_ALLOWED_ORIGIN string = 'https://${appFqdn}'

@description('Storage account backing /data.')
output AZURE_STORAGE_ACCOUNT_NAME string = effectiveStorageAccountName

@description('Resource group of the created or reused storage account.')
output AZURE_STORAGE_ACCOUNT_RESOURCE_GROUP string = effectiveStorageAccountResourceGroup

@description('Selected Azure Files share. Empty when persistence is explicitly disabled.')
output AZURE_FILE_SHARE_NAME string = persistData ? effectiveFileShareName : ''

@description('Selected Azure Files share resource ID. Existing shares are references only.')
output AZURE_FILE_SHARE_RESOURCE_ID string = !persistData ? '' : (!empty(existingFileShareName)
  ? existingDataShare.id
  : resourceId(effectiveStorageAccountResourceGroup, 'Microsoft.Storage/storageAccounts/fileServices/shares', effectiveStorageAccountName, 'default', effectiveFileShareName))