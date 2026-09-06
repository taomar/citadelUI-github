// PRESTAGING ONLY. The approved operator, not azd/the runner, owns this template.
// Deploy incrementally into a NEW, dedicated protected-platform resource group.
// The separate UI target group must already exist. Never target production.
targetScope = 'resourceGroup'

@minLength(3)
@maxLength(40)
param environmentName string

param location string = 'westeurope'

@description('Precreated, separate resource group in this subscription. The runner receives Contributor only here.')
@minLength(1)
param uiResourceGroupName string

@secure()
@description('Public SSH key only. No SSH ingress is permitted; VM administration uses the Azure agent.')
param runnerSshPublicKey string

@minLength(1)
@description('Configurable x64, Generation 2-compatible SKU. The staging default is Standard_D2as_v6; confirm subscription/region restrictions, capacity and standardDav6Family quota before deployment. No automatic fallback.')
param runnerVmSize string = 'Standard_D2as_v6'

param runnerAdminUsername string = 'citadelrunner'
param enableEvidenceBlob bool = false
param fileShareName string = 'citadel-data'
param credentialSecretName string = 'citadel-credential-key'

@description('Choose nonoverlapping ranges before creating the environment; do not change on reuse.')
param vnetPrefix string = '10.84.0.0/16'
param acaSubnetPrefix string = '10.84.0.0/23'
param privateEndpointSubnetPrefix string = '10.84.2.0/24'
param runnerSubnetPrefix string = '10.84.3.0/24'

// The live approval names one exact platform/UI pair, not a general live-* prefix.
var approvedLivePair = resourceGroup().name == 'rg-citadel-live-private-20260906' && uiResourceGroupName == 'rg-citadel-live-reuse-20260906'
var protectedPrefixPair = startsWith(resourceGroup().name, 'rg-citadel-protected-') && startsWith(uiResourceGroupName, 'rg-citadel-protected-')
var token = !approvedLivePair && !protectedPrefixPair
  ? fail('Use dedicated rg-citadel-protected- groups or the exact approved live platform/UI pair. Production/fresh-public groups are forbidden.')
  : toLower(resourceGroup().name) == toLower(uiResourceGroupName)
    ? fail('The platform and UI target resource groups must be different.')
    : uniqueString(subscription().id, resourceGroup().id, environmentName, location)
// Deliberately NOT azd-env-name: azd down on the UI must not select the platform.
var tags = {
  'citadel-protected-stage': environmentName
  'citadel-role': 'shared-platform'
}

module network 'network.bicep' = {
  name: 'protected-network'
  params: {
    token: token
    location: location
    tags: tags
    vnetPrefix: vnetPrefix
    acaSubnetPrefix: acaSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    runnerSubnetPrefix: runnerSubnetPrefix
  }
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-citadel-app-${token}'
  location: location
  tags: tags
}

resource runnerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-citadel-runner-${token}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'crprotected${token}'
  location: location
  tags: tags
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    dataEndpointEnabled: true
    roleAssignmentMode: 'LegacyRegistryPermissions'
    publicNetworkAccess: 'Disabled'
    networkRuleBypassOptions: 'None'
    networkRuleSet: {
      defaultAction: 'Deny'
      ipRules: []
    }
    policies: {
      azureADAuthenticationAsArmPolicy: {
        status: 'enabled'
      }
    }
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-prot-${token}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    // Azure rejects explicitly disabling this setting. Deleted stage vaults
    // retain their names/keys for the configured seven-day recovery period.
    enablePurgeProtection: true
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
    accessPolicies: []
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stprotected${token}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Classic AzureFile mounts require account-key SMB auth. No rotation here.
    allowSharedKeyAccess: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        file: {
          enabled: true
          keyType: 'Account'
        }
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    enabledProtocols: 'SMB'
    shareQuota: 5
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (enableEvidenceBlob) {
  parent: storage
  name: 'default'
}

resource evidence 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableEvidenceBlob) {
  parent: blobService
  name: 'private-evidence'
  properties: {
    publicAccess: 'None'
  }
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-protected-${token}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: 1
    }
    publicNetworkAccessForIngestion: 'Disabled'
    publicNetworkAccessForQuery: 'Disabled'
  }
}

resource monitorScope 'Microsoft.Insights/privateLinkScopes@2021-09-01' = {
  name: 'ampls-protected-${token}'
  location: 'global'
  tags: tags
  properties: {
    accessModeSettings: {
      ingestionAccessMode: 'PrivateOnly'
      queryAccessMode: 'PrivateOnly'
      exclusions: []
    }
  }
}

resource workspaceLink 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-09-01' = {
  parent: monitorScope
  name: 'workspace'
  properties: {
    linkedResourceId: workspace.id
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: 'cae-protected-${token}'
  location: location
  tags: tags
  properties: {
    publicNetworkAccess: 'Disabled'
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: network.outputs.acaSubnetId
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
    // Direct Container Apps -> private LA logging is unsupported. The approved
    // exception is Microsoft's private service-to-service diagnostic delivery,
    // NOT the customer's PE. Private query uses AMPLS; no public LA endpoint.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
  }
}

// Microsoft.Insights must be registered BEFORE deploying (protected-stage.ps1).
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'protected-console-system'
  scope: managedEnvironment
  properties: {
    workspaceId: workspace.id
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
      }
    ]
  }
}

// AMPLS needs the blob zone even when the optional evidence container is off.
var zoneNames = [
  'privatelink.azurecr.io'
  'privatelink.vaultcore.azure.net'
  'privatelink.file.${environment().suffixes.storage}'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.monitor.azure.com'
  'privatelink.oms.opinsights.azure.com'
  'privatelink.ods.opinsights.azure.com'
  'privatelink.agentsvc.azure-automation.net'
]
resource zones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for name in zoneNames: {
  name: name
  location: 'global'
  tags: tags
}]
resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (name, i) in zoneNames: {
  parent: zones[i]
  name: 'protected-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: network.outputs.vnetId
    }
  }
}]
var endpointSpecs = concat([
  { name: 'acr', id: registry.id, group: 'registry', zoneIndexes: [0] }
  { name: 'vault', id: vault.id, group: 'vault', zoneIndexes: [1] }
  { name: 'file', id: storage.id, group: 'file', zoneIndexes: [2] }
  { name: 'monitor', id: monitorScope.id, group: 'azuremonitor', zoneIndexes: [3, 4, 5, 6, 7] }
], enableEvidenceBlob ? [
  { name: 'blob', id: storage.id, group: 'blob', zoneIndexes: [3] }
] : [])
module endpoints 'private-endpoint.bicep' = [for spec in endpointSpecs: {
  name: 'private-endpoint-${spec.name}'
  params: {
    name: 'pe-${spec.name}-${token}'
    location: location
    tags: tags
    subnetId: network.outputs.privateEndpointSubnetId
    privateLinkServiceId: spec.id
    groupId: spec.group
    zoneIds: [for i in spec.zoneIndexes: zones[i].id]
  }
  dependsOn: [
    workspaceLink
  ]
}]

// An internal ILB environment needs its defaultDomain wildcard, not an ACA PE.
module environmentDns '../modules/private-environment-dns.bicep' = {
  name: 'protected-environment-dns'
  params: {
    domainName: managedEnvironment.properties.defaultDomain
    staticIp: managedEnvironment.properties.staticIp
    virtualNetworkId: network.outputs.vnetId
    tags: tags
  }
}

resource runnerNic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nic-protected-${token}'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'private'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: network.outputs.runnerSubnetId
          }
          // No publicIPAddress and no inbound SSH/RDP.
        }
      }
    ]
  }
}

resource runner 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-protected-${token}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${runnerIdentity.id}': {}
    }
  }
  properties: {
    hardwareProfile: {
      vmSize: runnerVmSize
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: 64
        managedDisk: {
          storageAccountType: 'StandardSSD_LRS'
        }
        deleteOption: 'Delete'
      }
    }
    osProfile: {
      computerName: 'citadel-builder'
      adminUsername: runnerAdminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        provisionVMAgent: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${runnerAdminUsername}/.ssh/authorized_keys'
              keyData: runnerSshPublicKey
            }
          ]
        }
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: runnerNic.id
          properties: {
            primary: true
            deleteOption: 'Delete'
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

module runnerAccess 'runner-access.bicep' = {
  name: 'protected-runner-access'
  params: {
    runnerPrincipalId: runnerIdentity.properties.principalId
    appPrincipalId: appIdentity.properties.principalId
    environmentName: managedEnvironment.name
    registryName: registry.name
    vaultName: vault.name
    storageName: storage.name
    appIdentityName: appIdentity.name
    workspaceName: workspace.name
    enableEvidenceBlob: enableEvidenceBlob
  }
  dependsOn: [
    evidence
  ]
}
module uiAccess 'ui-access.bicep' = {
  name: 'protected-ui-access'
  scope: resourceGroup(uiResourceGroupName)
  params: {
    runnerPrincipalId: runnerIdentity.properties.principalId
  }
}

// Only nonsensitive selectors/IDs. No listKeys, password, token or key output.
output contract object = {
  version: 1
  platformResourceGroup: resourceGroup().name
  runnerName: runner.name
  runnerIdentityId: runnerIdentity.id
  runnerClientId: runnerIdentity.properties.clientId
  runnerPrincipalId: runnerIdentity.properties.principalId
  workspaceResourceId: workspace.id
  workspaceCustomerId: workspace.properties.customerId
  virtualNetworkId: network.outputs.vnetId
  environmentDomain: managedEnvironment.properties.defaultDomain
  registryLoginServer: registry.properties.loginServer
  evidenceContainerName: enableEvidenceBlob ? evidence!.name : ''
  selectors: {
    AZURE_SUBSCRIPTION_ID: subscription().subscriptionId
    AZURE_LOCATION: location
    AZURE_ENV_NAME: environmentName
    AZURE_RESOURCE_GROUP: uiResourceGroupName
    AZURE_PRINCIPAL_ID: runnerIdentity.properties.principalId
    AZURE_PRINCIPAL_TYPE: 'ServicePrincipal'
    AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_NAME: managedEnvironment.name
    AZURE_EXISTING_CONTAINER_APPS_ENVIRONMENT_RESOURCE_GROUP: resourceGroup().name
    AZURE_EXISTING_CONTAINER_REGISTRY_NAME: registry.name
    AZURE_EXISTING_CONTAINER_REGISTRY_RESOURCE_GROUP: resourceGroup().name
    AZURE_KEY_VAULT_NAME: vault.name
    AZURE_KEY_VAULT_RESOURCE_GROUP: resourceGroup().name
    AZURE_EXISTING_STORAGE_ACCOUNT_NAME: storage.name
    AZURE_EXISTING_STORAGE_ACCOUNT_RESOURCE_GROUP: resourceGroup().name
    AZURE_EXISTING_FILE_SHARE_NAME: share.name
    AZURE_EXISTING_MANAGED_IDENTITY_NAME: appIdentity.name
    AZURE_EXISTING_MANAGED_IDENTITY_RESOURCE_GROUP: resourceGroup().name
    CITADEL_CREDENTIAL_SECRET_NAME: credentialSecretName
    CITADEL_PRIVATE_DEPLOYMENT: 'true'
    ALLOW_PUBLIC_INGRESS_WITHOUT_AUTH: 'false'
    // No subnet or LA override: the selected environment owns both.
  }
}
