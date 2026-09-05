using './main.bicep'

// Populate environment-specific values through an operator-owned parameter file
// or CI secret store. No secret value belongs in this sample parameter file.
param location = 'westeurope'
param azureCloud = 'AzureCloud'
param managedEnvironmentId = '/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.App/managedEnvironments/<environment-name>'
param containerRegistryName = '<registry-name>'
param keyVaultName = '<key-vault-name>'
param playgroundImage = '<registry-login-server>/citadel-playground:<immutable-tag>'
param relayImage = '<registry-login-server>/citadel-relay:<immutable-tag>'
param entraTenantId = '<tenant-id>'
param playgroundEntraClientId = '<playground-app-id>'
param hostedOperatorRequiredAppRole = 'Citadel.Operator'
param hostedOperatorAllowedPrincipalIds = []
param hostedOperatorAllowedGroupIds = []
param hostedOperatorPlatformAllowedPrincipalIds = []
param hostedOperatorPlatformAllowedGroupIds = []
param relayEntraClientId = '<relay-app-id>'
param relayTokenResource = 'api://<relay-app-id>'
param relayRequestedAccessTokenVersion = 2
param relayAllowedOrigins = [
  'https://<apim-gateway-host>'
]
param relayAllowedSampleIds = [
  'weather-mcp-discovery'
]
param relayRequestPolicy = {
  'weather-mcp-discovery': {
    'mcp-initialize': {
      urls: [
        'https://<apim-gateway-host>/mcp/weather-tool-mcp/mcp'
      ]
      headerNames: [
        'api-key'
      ]
    }
    'mcp-initialized': {
      urls: [
        'https://<apim-gateway-host>/mcp/weather-tool-mcp/mcp'
      ]
      headerNames: [
        'api-key'
      ]
    }
    'tools-list': {
      urls: [
        'https://<apim-gateway-host>/mcp/weather-tool-mcp/mcp'
      ]
      headerNames: [
        'api-key'
      ]
    }
  }
}
param relayLogicalRefMappings = {
  'gatewayAccess.apiKey': '<key-vault-secret-name>'
}
param relayBodyLimitBytes = 262144
param relayRunTimeoutMs = 60000
param relayRequestTimeoutMs = 10000
param relayMaxConcurrentRequests = 4
param relayMaxRequestsPerRun = 12
