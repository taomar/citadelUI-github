// Adds only a deliberately new UI-specific share to an existing account.
// This module is NOT invoked for an explicitly selected existing share.
targetScope = 'resourceGroup'

param accountName string
param shareName string
param shareQuotaGiB int = 5

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: accountName
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' existing = {
  parent: account
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    enabledProtocols: 'SMB'
    shareQuota: shareQuotaGiB
  }
}
