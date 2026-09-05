using './main.bicep'

// Populate environment-specific values through an operator-owned parameter file
// or CI secret store. No secret value belongs in this sample parameter file.
param location = 'westeurope'
param managedEnvironmentId = '/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.App/managedEnvironments/<environment-name>'
param containerRegistryName = '<registry-name>'
param keyVaultName = '<key-vault-name>'
param playgroundImage = '<registry-login-server>/citadel-playground:<immutable-tag>'
param relayImage = '<registry-login-server>/citadel-relay:<immutable-tag>'
param entraTenantId = '<tenant-id>'
param playgroundEntraClientId = '<playground-app-id>'
param relayEntraClientId = '<relay-app-id>'
param relayTokenAudience = 'api://<relay-app-id>'
param relayAllowedOrigins = [
  'https://<apim-gateway-host>'
]
param relayAllowedSampleIds = [
  'weather-mcp-discovery'
]
param relayRequestPolicy = {
  'weather-mcp-discovery': {
    initialize: {
      urls: [
        'https://<apim-gateway-host>/weather/mcp'
      ]
      headerNames: [
        'Ocp-Apim-Subscription-Key'
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
