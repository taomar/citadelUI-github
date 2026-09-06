targetScope = 'resourceGroup'

param token string
param location string
param tags object
param vnetPrefix string
param acaSubnetPrefix string
param privateEndpointSubnetPrefix string
param runnerSubnetPrefix string

// This PIP belongs ONLY to NAT (outbound), never to a VM NIC/load balancer.
resource egressIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-egress-${token}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}
resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: 'nat-protected-${token}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [
      {
        id: egressIp.id
      }
    ]
  }
}

// No Azure Firewall appliance. NSGs cannot filter package/CDN FQDNs. TLS egress
// to Internet is explicit and necessary for Ubuntu, Docker Hub, Microsoft's
// package feeds, MCR and GitHub release assets. This is NOT an air-gapped VM.
resource runnerNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-protected-runner-${token}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'deny-all-inbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'private-services-and-ui'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRanges: ['443', '445']
          sourceAddressPrefix: '*'
          destinationAddressPrefixes: [acaSubnetPrefix, privateEndpointSubnetPrefix]
        }
      }
      // Azure DNS and IMDS bypass ordinary NSG rules. Their special platform
      // tags support Deny only; do not add those Deny rules or invalid Allows.
      {
        name: 'azure-agent'
        properties: {
          priority: 120
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRanges: ['80', '32526']
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '168.63.129.16'
        }
      }
      {
        name: 'explicit-https-egress'
        properties: {
          priority: 140
          direction: 'Outbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: 'Internet'
        }
      }
      {
        name: 'deny-other-egress'
        properties: {
          priority: 4096
          direction: 'Outbound'
          access: 'Deny'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-protected-${token}'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [vnetPrefix]
    }
    subnets: [
      {
        name: 'aca'
        properties: {
          addressPrefix: acaSubnetPrefix
          natGateway: {
            id: nat.id
          }
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'runner'
        properties: {
          addressPrefix: runnerSubnetPrefix
          defaultOutboundAccess: false
          natGateway: {
            id: nat.id
          }
          networkSecurityGroup: {
            id: runnerNsg.id
          }
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output acaSubnetId string = '${vnet.id}/subnets/aca'
output privateEndpointSubnetId string = '${vnet.id}/subnets/private-endpoints'
output runnerSubnetId string = '${vnet.id}/subnets/runner'
