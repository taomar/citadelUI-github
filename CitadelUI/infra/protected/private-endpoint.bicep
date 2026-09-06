targetScope = 'resourceGroup'
param name string
param location string
param tags object
param subnetId string
param privateLinkServiceId string
param groupId string
param zoneIds array

resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: privateLinkServiceId
          groupIds: [groupId]
        }
      }
    ]
  }
}
// Azure maintains ALL records (including ACR login + regional data endpoints).
resource zoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [for (id, i) in zoneIds: {
      name: 'zone-${i}'
      properties: {
        privateDnsZoneId: id
      }
    }]
  }
}
