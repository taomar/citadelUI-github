/**
 * @module publishMcpExisting
 * @description Publishes an existing/remote MCP server through the gateway. The backend is created
 * separately by publishBackend.bicep and passed in by name. Applies the publish-contract baseline
 * MCP policy unless a custom policy is supplied.
 */

// ------------------
//    PARAMETERS
// ------------------

param apimServiceName string
param appInsightsLoggerName string = 'appinsights-logger'

@description('Name of the backend (created by publishBackend.bicep) that points at the remote MCP server')
param backendName string

param mcpName string
param mcpDisplayName string
param mcpDescription string
param mcpPath string

@description('MCP transport type')
param mcpTransportType string = 'streamable'

@description('Whether a subscription key is required to reach the published MCP server')
param mcpSubscriptionRequired bool = true

@description('Header name callers use to present the subscription (API) key. Accepts the LLM-style "api-key" or the APIM-native "Ocp-Apim-Subscription-Key".')
@allowed([
  'api-key'
  'Ocp-Apim-Subscription-Key'
])
param subscriptionKeyHeaderName string = 'api-key'

param mcpProtocols array = [
  'https'
]

@description('Custom rawxml policy. When empty, the baseline MCP policy is applied.')
param mcpPolicyXml string = ''

// ------------------
//    VARIABLES
// ------------------

var defaultPolicyXml = loadTextContent('../policies/baseline-mcp-policy.xml')
var effectivePolicyXml = empty(mcpPolicyXml) ? defaultPolicyXml : mcpPolicyXml

// Query-string key name mirrors the header: the APIM-native header uses the 'subscription-key' query param,
// the LLM-style 'api-key' header uses an 'api-key' query param.
var subscriptionKeyQueryName = subscriptionKeyHeaderName == 'Ocp-Apim-Subscription-Key' ? 'subscription-key' : 'api-key'

// ------------------
//    RESOURCES
// ------------------

resource apim 'Microsoft.ApiManagement/service@2024-06-01-preview' existing = {
  name: apimServiceName
}

resource mcp 'Microsoft.ApiManagement/service/apis@2024-06-01-preview' = {
  parent: apim
  name: mcpName
  properties: {
    type: 'mcp'
    displayName: mcpDisplayName
    description: mcpDescription
    subscriptionRequired: mcpSubscriptionRequired
    path: mcpPath
    protocols: mcpProtocols
    subscriptionKeyParameterNames: {
      header: subscriptionKeyHeaderName
      query: subscriptionKeyQueryName
    }
    // backendId + mcpPropperties are MCP preview properties not yet in the APIM bicep type definitions; suppress BCP037.
    #disable-next-line BCP037
    backendId: backendName
    #disable-next-line BCP037
    mcpPropperties: {
      transportType: mcpTransportType
    }
  }
}

resource mcpInsights 'Microsoft.ApiManagement/service/apis/diagnostics@2022-08-01' = {
  name: 'applicationinsights'
  parent: mcp
  properties: {
    alwaysLog: 'allErrors'
    httpCorrelationProtocol: 'W3C'
    logClientIp: true
    loggerId: resourceId(resourceGroup().name, 'Microsoft.ApiManagement/service/loggers', apimServiceName, appInsightsLoggerName)
    metrics: true
    verbosity: 'information'
    sampling: {
      samplingType: 'fixed'
      percentage: 100
    }
    // Do NOT log request/response bodies for MCP: buffering breaks the streaming (SSE) transport.
  }
}

resource policy 'Microsoft.ApiManagement/service/apis/policies@2021-12-01-preview' = {
  parent: mcp
  name: 'policy'
  properties: {
    value: effectivePolicyXml
    format: 'rawxml'
  }
}

// ------------------
//    OUTPUTS
// ------------------

output name string = mcp.name
output path string = mcpPath
// Native/remote MCP servers are served at the path as-is (APIM does NOT append /mcp).
output endpoint string = '${apim.properties.gatewayUrl}/${mcpPath}'
