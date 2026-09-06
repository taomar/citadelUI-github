// A new private VNet needs DNS for its internal Container Apps load balancer.
// This module only owns a new zone for the newly-created environment's domain.
targetScope = 'resourceGroup'

param domainName string
param staticIp string
param virtualNetworkId string
param tags object

resource zone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: domainName
  location: 'global'
  tags: tags
}

resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: zone
  name: 'citadel-ui'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetworkId
    }
  }
}

resource wildcard 'Microsoft.Network/privateDnsZones/A@2020-06-01' = {
  parent: zone
  name: '*'
  properties: {
    ttl: 300
    aRecords: [
      {
        ipv4Address: staticIp
      }
    ]
  }
}
