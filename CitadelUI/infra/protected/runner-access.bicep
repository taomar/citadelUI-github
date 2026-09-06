// The stage operator creates these grants. The runner cannot edit networking,
// firewalls, the shared environment, identities, account policies or keys.
targetScope = 'resourceGroup'

param runnerPrincipalId string
param appPrincipalId string
param environmentName string
param registryName string
param vaultName string
param storageName string
param appIdentityName string
param workspaceName string
param enableEvidenceBlob bool

resource env 'Microsoft.App/managedEnvironments@2025-07-01' existing = {
  name: environmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageName
}
resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: appIdentityName
}
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}
resource evidence 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = if (enableEvidenceBlob) {
  name: '${storageName}/default/private-evidence'
}

var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPush = '8311e382-0749-4cb8-b61a-304f252e45ec'
var acrTasks = 'fb382eab-e894-4461-af04-94435c366c3f'
var secretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var secretsOfficer = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var reader = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var identityOperator = 'f1a07417-d97a-45cb-824c-7a7467783830'
var logReader = '73c42c96-874c-492b-b04d-ab87d138a893'
var blobContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// Custom definitions have a canonical subscription roleDefinitionId even
// though their assignableScopes and deployment scope are just this group.
// Cross-RG modules in the EXISTING main.bicep create ARM deployment records in
// this platform group. Resource-scoped grants alone do not permit those records.
resource deploymentRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'protected-nested-deployments')
  properties: {
    roleName: 'Citadel protected nested deployments ${uniqueString(resourceGroup().id)}'
    description: 'ARM deployment records only; permission on each deployed resource is still required.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Resources/subscriptions/resourceGroups/read'
          'Microsoft.Resources/deployments/*'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}
resource deploymentGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, runnerPrincipalId, deploymentRole.id)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', deploymentRole.name)
  }
}

resource bindingRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'protected-env-bindings')
  properties: {
    roleName: 'Citadel protected environment bindings ${uniqueString(resourceGroup().id)}'
    description: 'Join the selected environment with a UI app; create/update only its Azure Files storage children.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.App/managedEnvironments/read'
          'Microsoft.App/managedEnvironments/join/action'
          'Microsoft.App/managedEnvironments/storages/read'
          'Microsoft.App/managedEnvironments/storages/write'
        ]
      }
    ]
  }
}
resource bindingGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: env
  name: guid(env.id, runnerPrincipalId, bindingRole.id)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', bindingRole.name)
  }
}

// NOT Storage Account Key Operator: that role also permits key regeneration.
resource storageRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'protected-storage-read-keys')
  properties: {
    roleName: 'Citadel protected storage read keys ${uniqueString(resourceGroup().id)}'
    description: 'Read existing classic SMB share metadata and account keys, never regenerate or write settings.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Storage/storageAccounts/read'
          'Microsoft.Storage/storageAccounts/fileServices/read'
          'Microsoft.Storage/storageAccounts/fileServices/shares/read'
          'Microsoft.Storage/storageAccounts/listKeys/action'
        ]
      }
    ]
  }
}
resource storageGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, runnerPrincipalId, storageRole.id)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageRole.name)
  }
}

resource assignmentRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'protected-assignment-writer')
  properties: {
    roleName: 'Citadel protected assignment writer ${uniqueString(resourceGroup().id)}'
    description: 'Role assignment read/write only. Every grant of this role MUST have a role/principal condition.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [
      {
        actions: [
          'Microsoft.Authorization/roleAssignments/read'
          'Microsoft.Authorization/roleAssignments/write'
          'Microsoft.Authorization/roleDefinitions/read'
        ]
      }
    ]
  }
}
// Main creates app AcrPull and runner AcrPush/TasksContributor assignments.
// Tasks permission is compatibility with main, NOT permission to bypass the
// private registry network. No hosted task is invoked by the private path.
var appPullCondition = '@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] GuidEquals ${acrPull} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] GuidEquals ${appPrincipalId}'
var runnerPushCondition = '@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${acrPush}, ${acrTasks}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] GuidEquals ${runnerPrincipalId}'
var appSecretCondition = '@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] GuidEquals ${secretsUser} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] GuidEquals ${appPrincipalId}'
var notAssignmentWrite = '!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})'
var registryCondition = '(${notAssignmentWrite} OR ((${appPullCondition}) OR (${runnerPushCondition})))'
var vaultCondition = '(${notAssignmentWrite} OR (${appSecretCondition}))'
resource registryDelegation 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, runnerPrincipalId, assignmentRole.id)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', assignmentRole.name)
    conditionVersion: '2.0'
    condition: registryCondition
  }
}
resource vaultDelegation 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, runnerPrincipalId, assignmentRole.id)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', assignmentRole.name)
    conditionVersion: '2.0'
    condition: vaultCondition
  }
}

// The AcrPush name seed EXACTLY matches main's registry-role-assignment module.
resource registryGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [reader, acrPush]: {
  scope: registry
  name: guid(registry.id, runnerPrincipalId, role)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
  }
}]
resource vaultGrants 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for role in [reader, secretsOfficer]: {
  scope: vault
  name: guid(vault.id, runnerPrincipalId, role)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', role)
  }
}]
resource identityGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appIdentity
  name: guid(appIdentity.id, runnerPrincipalId, identityOperator)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', identityOperator)
  }
}
resource logsGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: workspace
  name: guid(workspace.id, runnerPrincipalId, logReader)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', logReader)
  }
}
resource evidenceGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableEvidenceBlob) {
  scope: evidence
  name: guid(evidence.id, runnerPrincipalId, blobContributor)
  properties: {
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributor)
  }
}
