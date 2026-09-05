targetScope = 'resourceGroup'

@description('Azure region for the user-assigned identities and Container Apps.')
param location string = resourceGroup().location

@description('Trusted Azure cloud profile. Must match the ARM cloud running this deployment.')
@allowed([
  'AzureCloud'
  'AzureUSGovernment'
  'AzureChinaCloud'
])
param azureCloud string

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

@description('Exact app-role value required for hosted playground operators. Define and assign this role on the playground app registration before deployment.')
@minLength(1)
@maxLength(120)
param hostedOperatorRequiredAppRole string = 'Citadel.Operator'

@description('Optional Microsoft Entra user or service-principal object IDs allowed to operate the hosted playground without the app role.')
param hostedOperatorAllowedPrincipalIds array = []

@description('Optional Microsoft Entra group object IDs allowed to operate the hosted playground without the app role.')
param hostedOperatorAllowedGroupIds array = []

@description('Optional Microsoft Entra user or service-principal object IDs enforced by Easy Auth as an additional outer restriction before server authorization.')
param hostedOperatorPlatformAllowedPrincipalIds array = []

@description('Optional Microsoft Entra group object IDs enforced by Easy Auth as an additional outer restriction before server authorization.')
param hostedOperatorPlatformAllowedGroupIds array = []

@description('Application (client) ID registered for the internal relay.')
param relayEntraClientId string

@description('Application ID URI requested from managed identity for the relay resource app, exactly api://<relay-app-id>.')
param relayTokenResource string

@description('Access-token version required on the existing relay resource app registration. Only Microsoft Entra v2 tokens are supported.')
@allowed([
  2
])
param relayRequestedAccessTokenVersion int

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

@description('Maximum HTTP requests that one relay run may make, including a bounded burst.')
@minValue(1)
@maxValue(64)
param relayMaxRequestsPerRun int = 12

@description('Maximum accepted relay request body size in bytes.')
@minValue(1024)
@maxValue(1048576)
param relayBodyLimitBytes int = 262144

@description('Maximum total relay run time in milliseconds.')
@minValue(1000)
@maxValue(300000)
param relayRunTimeoutMs int = 60000

@description('Requested maximum duration of one outbound HTTP request in milliseconds. The effective value is capped at relayRunTimeoutMs.')
@minValue(100)
@maxValue(60000)
param relayRequestTimeoutMs int = 10000

var relayEffectiveRequestTimeoutMs = min(relayRequestTimeoutMs, relayRunTimeoutMs)
var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var managedEnvironmentName = last(split(managedEnvironmentId, '/'))
var azureCloudProfiles = {
  AzureCloud: {
    // These are trust anchors checked against environment(), not deployable endpoints inferred from it.
    #disable-next-line no-hardcoded-env-urls
    authority: 'https://login.microsoftonline.com'
    #disable-next-line no-hardcoded-env-urls
    resourceManager: 'https://management.azure.com/'
    #disable-next-line no-hardcoded-env-urls
    keyVaultResource: 'https://vault.azure.net'
    #disable-next-line no-hardcoded-env-urls
    keyVaultDnsSuffix: '.vault.azure.net'
  }
  AzureUSGovernment: {
    authority: 'https://login.microsoftonline.us'
    resourceManager: 'https://management.usgovcloudapi.net/'
    keyVaultResource: 'https://vault.usgovcloudapi.net'
    keyVaultDnsSuffix: '.vault.usgovcloudapi.net'
  }
  AzureChinaCloud: {
    authority: 'https://login.chinacloudapi.cn'
    resourceManager: 'https://management.chinacloudapi.cn'
    keyVaultResource: 'https://vault.azure.cn'
    keyVaultDnsSuffix: '.vault.azure.cn'
  }
}
var azureCloudProfile = azureCloudProfiles[azureCloud]
var relayTokenIssuer = '${azureCloudProfile.authority}/${entraTenantId}/v2.0'
var hasHostedOperatorPlatformAllowlist = length(hostedOperatorPlatformAllowedPrincipalIds) > 0 || length(hostedOperatorPlatformAllowedGroupIds) > 0

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: managedEnvironmentName
}

// Container Apps assigns <app-name>.<environment-default-domain>. Deriving the
// external origin from the environment avoids trusting forwarded host headers
// or self-referencing the app resource while its revision is being created.
var playgroundPublicOrigin = 'https://${playgroundName}.${managedEnvironment.properties.defaultDomain}'

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
                path: '/livez'
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
            { name: 'CITADEL_RELAY_AZURE_CLOUD', value: azureCloud }
            { name: 'CITADEL_RELAY_ARM_CLOUD', value: environment().name }
            { name: 'CITADEL_RELAY_ARM_ENDPOINT', value: environment().resourceManager }
            { name: 'CITADEL_RELAY_KEY_VAULT_RESOURCE', value: azureCloudProfile.keyVaultResource }
            { name: 'CITADEL_RELAY_KEY_VAULT_DNS_SUFFIX', value: azureCloudProfile.keyVaultDnsSuffix }
            { name: 'CITADEL_RELAY_TOKEN_VERSION', value: string(relayRequestedAccessTokenVersion) }
            { name: 'CITADEL_RELAY_TOKEN_ISSUER', value: relayTokenIssuer }
            { name: 'CITADEL_RELAY_TOKEN_RESOURCE', value: relayTokenResource }
            { name: 'CITADEL_RELAY_TOKEN_AUDIENCE', value: relayEntraClientId }
            { name: 'CITADEL_RELAY_ENTRA_CLIENT_ID', value: relayEntraClientId }
            { name: 'CITADEL_RELAY_TENANT_ID', value: entraTenantId }
            { name: 'CITADEL_RELAY_ALLOWED_PRINCIPAL_ID', value: playgroundIdentity.properties.principalId }
            { name: 'CITADEL_RELAY_MANAGED_IDENTITY_CLIENT_ID', value: relayIdentity.properties.clientId }
            { name: 'CITADEL_RELAY_KEY_VAULT_URI', value: vault.properties.vaultUri }
            { name: 'CITADEL_RELAY_ALLOWED_ORIGINS', value: string(relayAllowedOrigins) }
            { name: 'CITADEL_RELAY_ALLOWED_SAMPLE_IDS', value: string(relayAllowedSampleIds) }
            { name: 'CITADEL_RELAY_REQUEST_POLICY', value: string(relayRequestPolicy) }
            { name: 'CITADEL_RELAY_SECRET_MAPPINGS', value: string(relayLogicalRefMappings) }
            { name: 'CITADEL_RELAY_BODY_LIMIT_BYTES', value: string(relayBodyLimitBytes) }
            { name: 'CITADEL_RELAY_RUN_TIMEOUT_MS', value: string(relayRunTimeoutMs) }
            { name: 'CITADEL_RELAY_HTTP_TIMEOUT_MS', value: string(relayEffectiveRequestTimeoutMs) }
            { name: 'CITADEL_RELAY_MAX_CONCURRENT_REQUESTS', value: string(relayMaxConcurrentRequests) }
            { name: 'CITADEL_RELAY_MAX_REQUESTS_PER_RUN', value: string(relayMaxRequestsPerRun) }
          ]
        }
      ]
      scale: {
        // Direct /execute uses process-local atomic nonce and admission state.
        // Scale-out is prohibited until both are backed by one shared adapter.
        minReplicas: 1
        maxReplicas: 1
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
          openIdIssuer: relayTokenIssuer
        }
        validation: {
          allowedAudiences: [
            relayEntraClientId
          ]
          defaultAuthorizationPolicy: {
            allowedApplications: [
              playgroundIdentity.properties.clientId
            ]
            allowedPrincipals: {
              identities: [
                playgroundIdentity.properties.principalId
              ]
            }
          }
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
                path: '/api/live'
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
            { name: 'CITADEL_PLAYGROUND_AZURE_CLOUD', value: azureCloud }
            { name: 'CITADEL_PLAYGROUND_ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'CITADEL_PLAYGROUND_ENTRA_CLIENT_ID', value: playgroundEntraClientId }
            { name: 'CITADEL_PLAYGROUND_OPERATOR_REQUIRED_APP_ROLE', value: hostedOperatorRequiredAppRole }
            { name: 'CITADEL_PLAYGROUND_OPERATOR_ALLOWED_PRINCIPAL_IDS', value: string(hostedOperatorAllowedPrincipalIds) }
            { name: 'CITADEL_PLAYGROUND_OPERATOR_ALLOWED_GROUP_IDS', value: string(hostedOperatorAllowedGroupIds) }
            { name: 'CITADEL_PLAYGROUND_PUBLIC_ORIGIN', value: playgroundPublicOrigin }
            { name: 'CITADEL_PLAYGROUND_RELAY_URL', value: 'https://${relay.properties.configuration.ingress.fqdn}/execute' }
            { name: 'CITADEL_PLAYGROUND_RELAY_RESOURCE', value: relayTokenResource }
            { name: 'CITADEL_PLAYGROUND_RELAY_AUDIENCE', value: relayEntraClientId }
            { name: 'CITADEL_PLAYGROUND_RELAY_TOKEN_VERSION', value: string(relayRequestedAccessTokenVersion) }
            { name: 'CITADEL_PLAYGROUND_RELAY_TOKEN_ISSUER', value: relayTokenIssuer }
            { name: 'CITADEL_PLAYGROUND_RELAY_ENTRA_CLIENT_ID', value: relayEntraClientId }
            { name: 'CITADEL_PLAYGROUND_RELAY_CLIENT_ID', value: playgroundIdentity.properties.clientId }
            { name: 'CITADEL_PLAYGROUND_RELAY_CALLER_PRINCIPAL', value: playgroundIdentity.properties.principalId }
            { name: 'CITADEL_PLAYGROUND_RELAY_TENANT', value: entraTenantId }
            { name: 'CITADEL_PLAYGROUND_RELAY_ALLOWED_SAMPLE_IDS', value: string(relayAllowedSampleIds) }
            { name: 'CITADEL_PLAYGROUND_RELAY_TIMEOUT_MS', value: string(relayRunTimeoutMs + 15000) }
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
          openIdIssuer: relayTokenIssuer
        }
        validation: union(
          {
            allowedAudiences: [
              playgroundEntraClientId
            ]
          },
          hasHostedOperatorPlatformAllowlist
            ? {
                defaultAuthorizationPolicy: {
                  allowedPrincipals: {
                    identities: hostedOperatorPlatformAllowedPrincipalIds
                    groups: hostedOperatorPlatformAllowedGroupIds
                  }
                }
              }
            : {}
        )
      }
    }
  }
}

output playgroundUrl string = 'https://${playground.properties.configuration.ingress.fqdn}'
output relayInternalUrl string = 'https://${relay.properties.configuration.ingress.fqdn}/execute'
