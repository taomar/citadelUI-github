targetScope = 'resourceGroup'

@description('Azure region for the user-assigned identities and Container Apps.')
param location string = resourceGroup().location

@description('Existing Container Apps managed environment resource ID.')
param managedEnvironmentId string

@description('Existing Azure Container Registry name in this resource group.')
param containerRegistryName string

@description('Existing Key Vault name in this resource group.')
param keyVaultName string

@description('Public Container App name for the browser playground.')
param playgroundName string = 'citadel-playground'

@description('Internal Container App name for the hardened relay.')
param relayName string = 'citadel-relay'

@description('Immutable image reference for the browser playground.')
param playgroundImage string

@description('Immutable image reference for the HTTP/assertion-only relay.')
param relayImage string

@description('Microsoft Entra tenant allowed to access both apps.')
param entraTenantId string

@description('Application (client) ID registered for the public playground.')
param playgroundEntraClientId string

@description('Application (client) ID registered for the internal relay.')
param relayEntraClientId string

@description('Application ID URI used as the relay managed-identity token audience, for example api://<relay-app-id>.')
param relayTokenAudience string

@description('Exact HTTPS origins the relay may contact. Values are policy, not user input.')
param relayAllowedOrigins array

@description('Exact catalogue sample IDs this tenant may execute through the relay.')
param relayAllowedSampleIds array

@description('Exact tenant-owned per-sample/per-step URL and secret-header policy map.')
param relayRequestPolicy object

@description('Logical relay refs mapped to Key Vault secret names. Secret values are never deployment parameters.')
param relayLogicalRefMappings object

@description('Maximum concurrent relay runs.')
@minValue(1)
@maxValue(32)
param relayMaxConcurrentRequests int = 4

@description('Maximum HTTP requests that one relay run may make.')
@minValue(1)
@maxValue(64)
param relayMaxRequestsPerRun int = 12

var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource playgroundIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${playgroundName}-identity'
  location: location
}

resource relayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${relayName}-identity'
  location: location
}

resource playgroundAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, playgroundIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: playgroundIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource relayAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, relayIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: relayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource relayKeyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, relayIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: relayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource relay 'Microsoft.App/containerApps@2024-03-01' = {
  name: relayName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${relayIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: registry.properties.loginServer
          identity: relayIdentity.id
        }
      ]
      ingress: {
        external: false
        targetPort: 8080
        transport: 'http'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'relay'
          image: relayImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 8080
              }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
          env: [
            // Container Apps injects IDENTITY_ENDPOINT and IDENTITY_HEADER for relayIdentity.
            { name: 'CITADEL_RELAY_PORT', value: '8080' }
            { name: 'CITADEL_RELAY_HOST', value: '0.0.0.0' }
            { name: 'CITADEL_RELAY_ENTRA_AUTHENTICATED', value: 'true' }
            { name: 'CITADEL_RELAY_TENANT_ID', value: entraTenantId }
            { name: 'CITADEL_RELAY_ALLOWED_PRINCIPAL_ID', value: playgroundIdentity.properties.principalId }
            { name: 'CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID', value: relayIdentity.properties.clientId }
            { name: 'CITADEL_RELAY_KEY_VAULT_URI', value: vault.properties.vaultUri }
            { name: 'CITADEL_RELAY_ALLOWED_ORIGINS', value: string(relayAllowedOrigins) }
            { name: 'CITADEL_RELAY_ALLOWED_SAMPLE_IDS', value: string(relayAllowedSampleIds) }
            { name: 'CITADEL_RELAY_REQUEST_POLICY', value: string(relayRequestPolicy) }
            { name: 'CITADEL_RELAY_SECRET_MAPPINGS', value: string(relayLogicalRefMappings) }
            { name: 'CITADEL_RELAY_MAX_CONCURRENT_REQUESTS', value: string(relayMaxConcurrentRequests) }
            { name: 'CITADEL_RELAY_MAX_REQUESTS_PER_RUN', value: string(relayMaxRequestsPerRun) }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

resource relayAuth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: relay
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'Return401'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: relayEntraClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            relayTokenAudience
          ]
        }
      }
    }
  }
}

resource playground 'Microsoft.App/containerApps@2024-03-01' = {
  name: playgroundName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${playgroundIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [
        {
          server: registry.properties.loginServer
          identity: playgroundIdentity.id
        }
      ]
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'playground'
          image: playgroundImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/health'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/health'
                port: 8080
              }
              initialDelaySeconds: 3
              periodSeconds: 10
            }
          ]
          env: [
            // Container Apps injects IDENTITY_ENDPOINT and IDENTITY_HEADER for playgroundIdentity.
            { name: 'CITADEL_PLAYGROUND_PORT', value: '8080' }
            { name: 'CITADEL_PLAYGROUND_HOST', value: '0.0.0.0' }
            { name: 'CITADEL_PLAYGROUND_ENTRA_AUTHENTICATED', value: 'true' }
            { name: 'CITADEL_PLAYGROUND_ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'CITADEL_PLAYGROUND_RELAY_URL', value: 'https://${relay.properties.configuration.ingress.fqdn}/execute' }
            { name: 'CITADEL_PLAYGROUND_RELAY_RESOURCE', value: relayTokenAudience }
            { name: 'CITADEL_PLAYGROUND_RELAY_CLIENT_ID', value: playgroundIdentity.properties.clientId }
            { name: 'CITADEL_PLAYGROUND_RELAY_CALLER_PRINCIPAL', value: playgroundIdentity.properties.principalId }
            { name: 'CITADEL_PLAYGROUND_RELAY_TENANT', value: entraTenantId }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

resource playgroundAuth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: playground
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: playgroundEntraClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            'api://${playgroundEntraClientId}'
          ]
        }
      }
    }
  }
}

output playgroundUrl string = 'https://${playground.properties.configuration.ingress.fqdn}'
output relayInternalUrl string = 'https://${relay.properties.configuration.ingress.fqdn}/execute'
