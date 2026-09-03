// -----------------------------------------------------------------------------
// AcrPull for the container app's identity, scoped to the one registry.
//
// This is a module rather than a plain resource in main.bicep for a reason that
// is easy to miss: the registry is created by an AVM module, so the only way to
// order this assignment after it is to pass the registry *name* in as a
// parameter. An `existing` reference to a name held in a variable compiles, and
// then races the registry it points at. Its Key Vault sibling has to be a module
// anyway (the vault may live in another resource group), so both are written the
// same way and read the same way.
// -----------------------------------------------------------------------------

@description('Name of the registry the assignment is scoped to. Must already exist.')
param registryName string

@description('Object (principal) id that receives the role.')
param principalId string

@description('Role definition GUID only, not a full resource id. AcrPull is 7f951dda-4ed3-4680-a7ca-43fe172d538d.')
param roleDefinitionId string

@description('Stable identifier for the subject, used only to seed the deterministic assignment name. The identity\'s ARM resource id is preferred over its object id: the resource id survives the identity being deleted and re-created, so a redeploy updates the same assignment in place instead of leaving an orphan behind under a different GUID.')
param subjectId string

@description('Type of the principal. Setting it explicitly avoids the intermittent "principal does not exist" failure caused by Entra replication lag on a freshly created identity.')
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
])
param principalType string = 'ServicePrincipal'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource assignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, subjectId, roleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalId: principalId
    principalType: principalType
  }
}

@description('Resource id of the created role assignment.')
output resourceId string = assignment.id