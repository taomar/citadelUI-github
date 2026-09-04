/**
 * @module citadel-publish-contracts / main
 * @description Onboards and publishes centrally protected AI assets through the AI Hub Gateway:
 *   - Tools (MCP): from an existing onboarded API (API->MCP) or a remote/native MCP server
 *   - Agents (A2A): native APIM A2A endpoints (e.g. Foundry-hosted agents)
 *
 * Each asset provisions its own backend (for remote MCP / A2A), endpoint, and baseline policy, and can
 * optionally be registered into Azure API Center. Products/subscriptions (governed access) are NOT
 * created here — that is Access Contract scope (phase 2).
 *
 * Deploy (subscription scope):
 *   az deployment sub create \
 *     --name citadel-publish-contracts \
 *     --location <region> \
 *     --template-file bicep/infra/citadel-publish-contracts/main.bicep \
 *     --parameters bicep/infra/citadel-publish-contracts/main.bicepparam
 */

targetScope = 'subscription'

// ============================================================================
// PARAMETERS
// ============================================================================

@description('APIM resource coordinates: { subscriptionId, resourceGroupName, name }')
param apim object

@description('Application Insights logger name on the APIM service (used for asset diagnostics)')
param appInsightsLoggerName string = 'appinsights-logger'

@description('User-assigned managed identity client id used by managed-identity backends (e.g. Foundry A2A). Leave empty to use the APIM system-assigned identity.')
param managedIdentityClientId string = ''

@description('Master toggle for backend circuit breakers')
param configureCircuitBreaker bool = true

@description('Default circuit breaker settings; per-asset overrides are shallow-merged over these')
param circuitBreakerDefaults object = {
  failureCount: 3
  failureInterval: 'PT5M'
  tripDuration: 'PT1M'
  acceptRetryAfter: true
  errorReasons: [
    'Server errors'
  ]
  statusCodeRanges: [
    {
      min: 429
      max: 429
    }
    {
      min: 500
      max: 503
    }
  ]
}

@description('Ensure the mcp-usage / a2a-usage policy fragments exist on the gateway before publishing')
param ensureUsageFragments bool = true

@description('Prefix each published asset\'s gateway path with its asset-type segment (mcp/ for Tools, agent/ for Agents), so tools are served under {gateway}/mcp/... and agents under {gateway}/agent/.... Set false to keep legacy un-prefixed paths. Per-asset override: set the asset\'s pathPrefix (e.g. \'\' to opt a single asset out, or a custom segment).')
param useAssetTypePathPrefix bool = true

@description('Optional Azure API Center coordinates for asset registration: { subscriptionId, resourceGroupName, serviceName, workspaceName }. Required only if any asset sets publishToApiCenter=true.')
param apiCenter object = {
  subscriptionId: ''
  resourceGroupName: ''
  serviceName: ''
  workspaceName: 'default'
}

@description('''Assets to publish. Each item:
{
  assetType: 'mcp-from-api' | 'mcp-existing' | 'a2a'
  name: string                 // APIM API name (also the backend name prefix)
  displayName: string
  description: string
  path: string                 // gateway path segment
  pathPrefix?: string          // override the auto asset-type prefix (mcp/agent); '' opts this asset out
  metadata?: { version, owner, contactEmail, compliance: [], classification }

  // mcp-from-api
  sourceApiName?: string
  operationNames?: [ string ]
  forwardSubscriptionKeyToSource?: bool    // opt-in: forward caller key to a subscription-protected source API (default false)
  sourceSubscriptionKeyHeaderName?: string // custom header the source API reads the forwarded key from (default 'x-mcp-sub-key')

  // mcp-existing
  transportType?: 'streamable'
  subscriptionRequired?: bool
  subscriptionKeyHeaderName?: string   // 'api-key' (default) or 'Ocp-Apim-Subscription-Key' (mcp-from-api, mcp-existing, a2a)

  // a2a
  agentId?: string
  agentCardPath?: string           // default '/.well-known/agent.json'
  agentCardBackendUrl?: string
  jsonRpcPath?: string             // default '/'
  subscriptionRequired?: bool
  subscriptionKeyHeaderName?: string   // 'api-key' (default) or 'Ocp-Apim-Subscription-Key'

  // backend (mcp-existing + a2a)
  backend?: {
    url: string
    authType?: 'none' | 'managed-identity' | 'api-key-header' | 'api-key-bearer'
    authConfig?: { resource?, headerName?, namedValueKey?, keyVaultSecretUri?, secretValue? }
    circuitBreaker?: object
  }

  policyXml?: string               // optional rawxml override for the baseline policy

  publishToApiCenter?: bool        // default false
  apiCenter?: {
    environmentName, lifecycleStage?, versionName?, versionDisplayName?, customProperties?, documentationUrl?, contacts?
  }
}''')
param publishAssets array

// ============================================================================
// EXISTING RESOURCES
// ============================================================================

resource apimRg 'Microsoft.Resources/resourceGroups@2022-09-01' existing = {
  scope: subscription(apim.subscriptionId)
  name: apim.resourceGroupName
}

resource apimSvc 'Microsoft.ApiManagement/service@2024-06-01-preview' existing = {
  scope: apimRg
  name: apim.name
}

var gatewayUrl = apimSvc.properties.gatewayUrl

// Default asset-type path prefix per asset type (Tools -> mcp, Agents -> agent).
var assetTypePrefixDefault = {
  'mcp-from-api': 'mcp'
  'mcp-existing': 'mcp'
  a2a: 'agent'
}

// Effective gateway path per asset (aligned to publishAssets order): the asset-type prefix (or a
// per-asset pathPrefix override) is prepended when useAssetTypePathPrefix is true. A pathPrefix of ''
// opts a single asset out even when the global toggle is on.
var effectivePaths = [
  for asset in publishAssets: (useAssetTypePathPrefix
    ? (empty(asset.?pathPrefix ?? assetTypePrefixDefault[asset.assetType])
        ? asset.path
        : '${asset.?pathPrefix ?? assetTypePrefixDefault[asset.assetType]}/${asset.path}')
    : (empty(asset.?pathPrefix ?? '') ? asset.path : '${asset.pathPrefix}/${asset.path}'))
]

// ============================================================================
// USAGE FRAGMENTS (idempotent, standalone-friendly)
// ============================================================================

module usageFragments 'modules/publishPolicyFragments.bicep' = if (ensureUsageFragments) {
  name: 'publish-usage-fragments'
  scope: apimRg
  params: {
    apimServiceName: apim.name
  }
}

// ============================================================================
// BACKENDS (per-asset, for remote MCP + A2A only)
// ============================================================================

module backends 'modules/publishBackend.bicep' = [for asset in publishAssets: if (asset.assetType == 'mcp-existing') {
  name: 'backend-${asset.name}'
  scope: apimRg
  params: {
    apimServiceName: apim.name
    backendName: '${asset.name}-backend'
    backendDescription: 'Published ${asset.assetType} backend: ${asset.name}'
    backendUrl: asset.backend.url
    authType: asset.backend.?authType ?? 'none'
    authConfig: asset.backend.?authConfig ?? {}
    managedIdentityClientId: managedIdentityClientId
    configureCircuitBreaker: configureCircuitBreaker
    circuitBreaker: union(circuitBreakerDefaults, asset.backend.?circuitBreaker ?? {})
  }
}]

// ============================================================================
// ENDPOINTS
// ============================================================================

// API -> MCP (reuses the source API's backend)
module mcpFromApi 'modules/publishMcpFromApi.bicep' = [for (asset, i) in publishAssets: if (asset.assetType == 'mcp-from-api') {
  name: 'mcp-from-api-${asset.name}'
  scope: apimRg
  params: {
    apimServiceName: apim.name
    appInsightsLoggerName: appInsightsLoggerName
    sourceApiName: asset.sourceApiName
    operationNames: asset.operationNames
    mcpName: asset.name
    mcpDisplayName: asset.displayName
    mcpDescription: asset.description
    mcpPath: effectivePaths[i]
    mcpSubscriptionRequired: asset.?subscriptionRequired ?? true
    subscriptionKeyHeaderName: asset.?subscriptionKeyHeaderName ?? 'api-key'
    forwardSubscriptionKeyToSource: asset.?forwardSubscriptionKeyToSource ?? false
    sourceSubscriptionKeyHeaderName: asset.?sourceSubscriptionKeyHeaderName ?? 'x-mcp-sub-key'
    mcpPolicyXml: asset.?policyXml ?? ''
  }
  dependsOn: [
    usageFragments
  ]
}]

// Remote / native MCP server
module mcpExisting 'modules/publishMcpExisting.bicep' = [for (asset, i) in publishAssets: if (asset.assetType == 'mcp-existing') {
  name: 'mcp-existing-${asset.name}'
  scope: apimRg
  params: {
    apimServiceName: apim.name
    appInsightsLoggerName: appInsightsLoggerName
    backendName: '${asset.name}-backend'
    mcpName: asset.name
    mcpDisplayName: asset.displayName
    mcpDescription: asset.description
    mcpPath: effectivePaths[i]
    mcpTransportType: asset.?transportType ?? 'streamable'
    mcpSubscriptionRequired: asset.?subscriptionRequired ?? true
    subscriptionKeyHeaderName: asset.?subscriptionKeyHeaderName ?? 'api-key'
    mcpPolicyXml: asset.?policyXml ?? ''
  }
  dependsOn: [
    backends
    usageFragments
  ]
}]

// A2A agent
module a2aAgent 'modules/publishA2aAgent.bicep' = [for (asset, i) in publishAssets: if (asset.assetType == 'a2a') {
  name: 'a2a-${asset.name}'
  scope: apimRg
  params: {
    apimServiceName: apim.name
    appInsightsLoggerName: appInsightsLoggerName
    agentName: asset.name
    agentId: asset.?agentId ?? ''
    agentDisplayName: asset.displayName
    agentDescription: asset.description
    agentPath: effectivePaths[i]
    agentCardPath: asset.?agentCardPath ?? '/.well-known/agent.json'
    agentCardBackendUrl: asset.agentCardBackendUrl
    jsonRpcBackendUrl: asset.backend.url
    jsonRpcPath: asset.?jsonRpcPath ?? '/'
    subscriptionRequired: asset.?subscriptionRequired ?? false
    subscriptionKeyHeaderName: asset.?subscriptionKeyHeaderName ?? 'api-key'
    managedIdentityClientId: managedIdentityClientId
    backendAuthResource: asset.backend.?authConfig.?resource ?? 'https://ai.azure.com'
    a2aPolicyXml: asset.?policyXml ?? ''
  }
  dependsOn: [
    usageFragments
  ]
}]

// ============================================================================
// OPTIONAL: API CENTER REGISTRATION
// ============================================================================

resource apicRg 'Microsoft.Resources/resourceGroups@2022-09-01' existing = if (!empty(apiCenter.?serviceName ?? '')) {
  scope: subscription(empty(apiCenter.?subscriptionId ?? '') ? apim.subscriptionId : apiCenter.subscriptionId)
  name: empty(apiCenter.?resourceGroupName ?? '') ? apim.resourceGroupName : apiCenter.resourceGroupName
}

module apicRegistration 'modules/publishApiCenter.bicep' = [for (asset, i) in publishAssets: if ((asset.?publishToApiCenter ?? false) && !empty(apiCenter.?serviceName ?? '')) {
  name: 'apic-reg-${asset.name}'
  scope: apicRg
  params: {
    apicServiceName: apiCenter.serviceName
    apicWorkspaceName: apiCenter.?workspaceName ?? 'default'
    environmentName: asset.apiCenter.environmentName
    apiName: asset.name
    apiDisplayName: asset.displayName
    apiDescription: asset.description
    apiKind: asset.assetType == 'a2a' ? 'a2a' : 'mcp'
    lifecycleStage: asset.apiCenter.?lifecycleStage ?? 'development'
    versionName: asset.apiCenter.?versionName ?? '1-0-0'
    versionDisplayName: asset.apiCenter.?versionDisplayName ?? '1.0.0'
    gatewayUrl: gatewayUrl
    // APIM appends /mcp to the path for API->MCP tools only; native/remote MCP and A2A use the path as-is.
    apiPath: asset.assetType == 'mcp-from-api' ? '${effectivePaths[i]}/mcp' : effectivePaths[i]
    customProperties: asset.apiCenter.?customProperties ?? {}
    documentationUrl: asset.apiCenter.?documentationUrl ?? ''
    contacts: asset.apiCenter.?contacts ?? []
  }
  dependsOn: [
    mcpFromApi
    mcpExisting
    a2aAgent
  ]
}]

// ============================================================================
// OUTPUTS
// ============================================================================

@description('Gateway base URL fronting all published assets')
output gatewayUrl string = gatewayUrl

@description('Summary of published assets and their gateway paths')
output publishedAssets array = [for (asset, i) in publishAssets: {
  name: asset.name
  assetType: asset.assetType
  path: effectivePaths[i]
  // API->MCP tools are served at {path}/mcp (APIM appends /mcp); native/remote MCP and A2A at {path}.
  endpoint: asset.assetType == 'mcp-from-api' ? '${gatewayUrl}/${effectivePaths[i]}/mcp' : '${gatewayUrl}/${effectivePaths[i]}'
  agentCard: asset.assetType == 'a2a' ? '${gatewayUrl}/${effectivePaths[i]}${asset.?agentCardPath ?? '/.well-known/agent.json'}' : ''
  publishedToApiCenter: asset.?publishToApiCenter ?? false
}]
