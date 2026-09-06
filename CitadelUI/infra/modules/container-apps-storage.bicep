// The storage binding belongs to the environment's resource group, which need
// not be the app's resource group. This module writes ONLY that child resource:
// the shared environment's networking, logging, profiles and tags are untouched.
targetScope = 'resourceGroup'

param environmentName string
param storageName string
param accountName string
param shareName string

@secure()
@description('Azure Files account key, used only by the managed environment. Never returned as an output or injected into the application.')
param accountKey string

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource storage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: managedEnvironment
  name: storageName
  properties: {
    azureFile: {
      accountName: accountName
      accountKey: accountKey
      shareName: shareName
      accessMode: 'ReadWrite'
    }
  }
}
