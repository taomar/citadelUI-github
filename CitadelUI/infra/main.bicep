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
//   1. public ingress exists only if Entra authentication exists (see `ingress`);
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
@description('Region for every resource (AZURE_LOCATION). West Europe for this deployment.')
param location string = resourceGroup().location

@description('Object id of whoever is running azd (AZURE_PRINCIPAL_ID). Only used to grant that person write access to a vault this template creates -- see the Secrets Officer assignment below.')
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

@description('Name of the secret holding the credential key-encryption key. The app reads the key from the vault at startup; this template deliberately does not create the secret, because generating key material in a deployment would put it in the deployment history in plain text.')
param credentialSecretName string = 'citadel-credential-key'

@description('Entra application (client) id for Container Apps built-in authentication. Supplying it publishes the app with Entra in front of it -- see the ingress block. Leave it empty and the app is on internal ingress, unreachable from the internet, unless allowPublicIngressWithoutAuth is also set.')
param entraAuthClientId string = ''

@secure()
@description('Optional client secret for the Entra app registration, stored as a container app secret. Leave empty and the secretless form is used, which is what a SPA-style app registration (no secret, PKCE) wants. Supply it only if your registration is a confidential web client and the login redirect fails without it.')
param entraAuthClientSecret string = ''

// ---------------------------------------------------------------------------
// Naming and shared values
// ---------------------------------------------------------------------------

// Hashing the subscription, environment and region gives names that are stable
// across redeploys of the same environment and unique across different ones,
// which matters for the globally unique names (registry, storage, vault).
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

// Every resource carries this so `azd down`, the portal and a cost report can
// all see one environment as one thing.
var tags = {
  'azd-env-name': environmentName
}

var containerAppName = 'ca-citadelui-${resourceToken}'
var containerPort = 4173
var dataMountPath = '/data'
// Three names have to line up before /data exists inside the container: the
// Azure Files share, the environment's binding to that share, and the volume the
// container mounts. They are deliberately the same string. A mismatch is not
// caught at deploy time -- the deployment succeeds and the replica then fails to
// start, which is a much more expensive way to find out.
var dataVolumeName = 'citadel-data'
var fileShareName = 'citadel-data'

// Role definition GUIDs. Written out rather than looked up so a reader can
// check them against the docs without deploying anything.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

// ---------------------------------------------------------------------------
// Log Analytics -- required by the Container Apps environment
// ---------------------------------------------------------------------------

module logAnalytics 'br/public:avm/res/operational-insights/workspace:0.16.1' = {
  name: 'log-analytics'
  params: {
    name: 'log-citadelui-${resourceToken}'
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

// ---------------------------------------------------------------------------
// Identity -- one identity for both ACR pull and Key Vault read
// ---------------------------------------------------------------------------

// User-assigned rather than system-assigned because the identity has to exist,
// and be granted AcrPull, *before* the container app can pull its first image.
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
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-citadelui-${resourceToken}'
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// Container registry
// ---------------------------------------------------------------------------

module registry 'br/public:avm/res/container-registry/registry:0.13.0' = {
  name: 'registry'
  params: {
    name: 'crcitadelui${resourceToken}'
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

module acrPull 'modules/registry-role-assignment.bicep' = {
  name: 'rbac-acr-pull'
  params: {
    registryName: registry.outputs.name
    principalId: identity.properties.principalId
    subjectId: identity.id
    roleDefinitionId: acrPullRoleId
    principalType: 'ServicePrincipal'
  }
}

// The identity above can PULL, which is what the running app needs. Nothing was
// granted PUSH, and the deployment cannot complete without it: `azd deploy`
// builds the image locally and pushes it as the signed-in user, and with the
// admin account deliberately disabled there is no fallback credential. The
// symptom is a 401 from the registry's token exchange at the publish step,
// after every resource has provisioned successfully -- which reads as a broken
// registry rather than a missing grant.
//
// Scoped to this registry, and only when a principal is known: `principalId` is
// empty in unattended contexts that have no interactive user to grant.
module acrPush 'modules/registry-role-assignment.bicep' = if (!empty(principalId)) {
  name: 'rbac-acr-push'
  params: {
    registryName: registry.outputs.name
    principalId: principalId
    subjectId: principalId
    roleDefinitionId: acrPushRoleId
    principalType: 'User'
  }
}

// ---------------------------------------------------------------------------
// Key Vault -- create or reuse
// ---------------------------------------------------------------------------

var createKeyVault = empty(keyVaultName)
var effectiveKeyVaultName = createKeyVault ? 'kv-citadel-${resourceToken}' : keyVaultName
var effectiveKeyVaultResourceGroup = empty(keyVaultResourceGroup) ? resourceGroup().name : keyVaultResourceGroup

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
    principalId: identity.properties.principalId
    subjectId: identity.id
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
module storage 'br/public:avm/res/storage/storage-account:0.33.0' = {
  name: 'storage'
  params: {
    name: 'stcitadelui${resourceToken}'
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
          name: fileShareName
          // 5 GiB. Azure Files on a standard account bills for what is used,
          // not for the quota, so this is a guard rail rather than a purchase.
          shareQuota: 5
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Container Apps environment
// ---------------------------------------------------------------------------

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-citadelui-${resourceToken}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        // The environment authenticates to the workspace with its shared key --
        // there is no managed-identity option for this hop today. The key is
        // taken from the module's secure output, so ARM resolves it at deploy
        // time, masks it in the deployment history, and it never exists in
        // source control, in the azd .env, or anywhere the application can read
        // it.
        customerId: logAnalytics.outputs.logAnalyticsWorkspaceId
        sharedKey: logAnalytics.outputs.primarySharedKey
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
  }
}

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
resource dataStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = if (persistData) {
  parent: containerAppsEnvironment
  name: dataVolumeName
  properties: {
    azureFile: {
      accountName: storage.outputs.name
      accountKey: storage.outputs.primaryAccessKey
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

// Two independent decisions, kept apart so neither happens by accident.
// `authConfigured` means Entra is in front of the app. `publicIngress` means
// the app is on the internet, by either route. See the ingress block below.
var authConfigured = !empty(entraAuthClientId)
var publicIngress = authConfigured || allowPublicIngressWithoutAuth
var authClientSecretConfigured = authConfigured && !empty(entraAuthClientSecret)
var authClientSecretName = 'entra-client-secret'

// Container Apps publishes an external app at `<name>.<defaultDomain>` and an
// internal one at `<name>.internal.<defaultDomain>`, and the server compares the
// Host header byte for byte. Deriving the name from the environment's default
// domain is what lets the app be told its own address before it exists; getting
// it wrong is not a degraded deployment, it is 421 on every request including
// the probes, which looks exactly like a broken image.
var appFqdn = publicIngress
  ? '${containerAppName}.${containerAppsEnvironment.properties.defaultDomain}'
  : '${containerAppName}.internal.${containerAppsEnvironment.properties.defaultDomain}'

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
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      // ---------------------------------------------------------------------
      // `external: publicIngress` is the exposure invariant of this template,
      // expressed as code so that it cannot be got wrong by editing a boolean:
      // the app reaches the internet only because someone decided it should,
      // never as a side effect of another setting.
      //
      // There are two such decisions and they are deliberately separate.
      // Supplying `entraAuthClientId` publishes the app with Entra in front of
      // it. Setting `allowPublicIngressWithoutAuth` publishes it with only the
      // app's own owner sign-in in front -- a real control, since an anonymous
      // visitor is issued no session token and every data route refuses one,
      // but a weaker one than Entra, because a container nobody has claimed yet
      // belongs to whoever reaches it first.
      //
      // Neither default is public. With both unset the app still deploys and
      // still works: it is reachable from inside the environment, and simply
      // not on the internet.
      // ---------------------------------------------------------------------
      ingress: {
        external: publicIngress
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
      // Identity-based pull. No admin credentials exist on the registry to put
      // here even if somebody wanted to.
      registries: [
        {
          server: registry.outputs.loginServer
          identity: identity.id
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
              value: identity.properties.clientId
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
              storageName: dataVolumeName
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
  // first; and the AcrPull grant is on the registry, not on the app, so the app
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
        // No client secret unless one was supplied. A registration configured
        // as a single-page application authenticates with PKCE and has no
        // secret to leak or rotate. Supply entraAuthClientSecret only if the
        // registration is a confidential web client, in which case the value is
        // stored as a container app secret and referenced by name -- never
        // inlined here.
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
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer

@description('Registry name.')
output AZURE_CONTAINER_REGISTRY_NAME string = registry.outputs.name

@description('Resource id of the Container Apps environment.')
output AZURE_CONTAINER_APP_ENVIRONMENT_ID string = containerAppsEnvironment.id

@description('Name of the Container Apps environment.')
output AZURE_CONTAINER_APP_ENVIRONMENT_NAME string = containerAppsEnvironment.name

@description('Resource group the deployment landed in.')
output AZURE_RESOURCE_GROUP string = resourceGroup().name

@description('Public URL of the app. Read back from the platform rather than recomputed, so that if it ever disagrees with CITADEL_ALLOWED_HOST below, the disagreement is visible instead of silent. On a deployment that is neither Entra-authenticated nor explicitly published this is the internal address and is not reachable from the internet -- that is the intent, not a fault.')
output SERVICE_CITADELUI_URI string = 'https://${containerApp.properties.configuration.ingress.fqdn}'

@description('Whether the app is reachable from the internet. This mirrors the `external` flag on the ingress exactly, so it can be trusted to answer "is this exposed?". It is true by either route -- an Entra client id, or allowPublicIngressWithoutAuth -- so read SERVICE_CITADELUI_ENTRA_AUTH to find out which.')
output SERVICE_CITADELUI_PUBLIC bool = publicIngress

@description('Whether Container Apps built-in Entra authentication is in front of the app. False while SERVICE_CITADELUI_PUBLIC is true means the app is on the internet behind its own owner sign-in rather than behind Entra.')
output SERVICE_CITADELUI_ENTRA_AUTH bool = authConfigured

@description('Reply URL to register on the Entra application, before setting entraAuthClientId. This is deliberately the address the app will have *once it is published*, not necessarily the address it has now: on an internal deployment the two differ, because the internal address carries an `.internal.` segment. Registering that one would produce a redirect loop that is genuinely hard to read. So the intended order is: provision once with no client id, take this value, register it, then set the client id and provision again.')
output AZURE_AUTH_REDIRECT_URI string = 'https://${containerAppName}.${containerAppsEnvironment.properties.defaultDomain}/.auth/login/aad/callback'

@description('Name of the vault in use, whether created here or reused.')
output AZURE_KEY_VAULT_NAME string = effectiveKeyVaultName

@description('URI of the vault in use.')
output AZURE_KEY_VAULT_URI string = keyVaultUri

@description('Name of the secret the app expects to find the credential key in. Create it with: az keyvault secret set --vault-name <name> --name <this> --value <base64 32 random bytes>')
output CITADEL_CREDENTIAL_SECRET_NAME string = credentialSecretName

@description('Client id of the user-assigned identity. The app needs this to ask the Container Apps identity endpoint for the right token.')
output AZURE_CLIENT_ID string = identity.properties.clientId

@description('Exact Host header the server will accept.')
output CITADEL_ALLOWED_HOST string = appFqdn

@description('Exact Origin the server will accept on state-changing requests.')
output CITADEL_ALLOWED_ORIGIN string = 'https://${appFqdn}'

@description('Storage account backing /data.')
output AZURE_STORAGE_ACCOUNT_NAME string = storage.outputs.name