// -----------------------------------------------------------------------------
// A single app pull or deployer push/build grant, scoped to the selected registry.
//
// A module lets main.bicep target an existing registry's own resource group.
// The caller supplies an explicit dependency on the conditional AVM create
// module. Reuse writes ONLY this role assignment, not the registry's settings.
// main.bicep selects data-plane roles according to the actual RBAC/ABAC mode.
// -----------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Name of the registry the assignment is scoped to. Must already exist.')
param registryName string

@description('Object (principal) id that receives the role.')
param principalId string

@description('Role definition GUID only, not a full resource id. AcrPull is 7f951dda-4ed3-4680-a7ca-43fe172d538d.')
param roleDefinitionId string

@description('Stable subject identifier used to seed the deterministic assignment name. Existing assignment-name seeds are retained for deployment compatibility; this module does not migrate or remove old role assignments.')
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