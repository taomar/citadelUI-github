// -----------------------------------------------------------------------------
// A data-plane role assignment on a Key Vault, as a module so the caller can
// aim it at another resource group.
//
// The vault is create-or-reuse: a supplied vault may sit in a resource group
// this deployment does not own. A role assignment's scope has to be an
// `existing` reference to the vault, and an `existing` reference can only cross
// resource groups from inside a module deployed at that group's scope. Hence
// this file. It is also the reason the vault is never granted access through
// access policies -- RBAC assignments are additive and removable, and they do
// not require rewriting a policy list that belongs to somebody else's vault.
// -----------------------------------------------------------------------------

@description('Name of the vault the assignment is scoped to. Must already exist; this module provisions no vault.')
param keyVaultName string

@description('Object (principal) id that receives the role.')
param principalId string

@description('Role definition GUID only, not a full resource id. Key Vault Secrets User is 4633458b-17de-408a-b874-0445c86b69e6.')
param roleDefinitionId string

@description('Stable identifier for the subject, used only to seed the deterministic assignment name. For a managed identity this is its ARM resource id, which survives the identity being deleted and re-created; for a human it is simply their object id.')
param subjectId string

@description('Type of the principal. Setting it explicitly avoids the intermittent "principal does not exist" failure caused by Entra replication lag on a freshly created identity.')
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
])
param principalType string = 'ServicePrincipal'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource assignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, subjectId, roleDefinitionId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalId: principalId
    principalType: principalType
  }
}

@description('Resource id of the created role assignment.')
output resourceId string = assignment.id