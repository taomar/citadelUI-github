targetScope = 'resourceGroup'
param runnerPrincipalId string

// This group is precreated by the stage operator. No subscription Owner,
// subscription Contributor, RG creation elsewhere or platform Contributor.
var contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, runnerPrincipalId, contributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributor)
    principalId: runnerPrincipalId
    principalType: 'ServicePrincipal'
  }
}
