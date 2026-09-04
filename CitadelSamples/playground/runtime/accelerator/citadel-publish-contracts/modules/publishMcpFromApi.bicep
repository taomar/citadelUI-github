/**
 * @module publishMcpFromApi
 * @description Publishes an existing onboarded REST API as an MCP (Tool) server by wrapping selected
 * operations as MCP tools. Reuses the source API's backend/auth — no new backend is created here.
 * Applies the publish-contract baseline MCP policy unless a custom policy is supplied.
 */

// ------------------
//    PARAMETERS
// ------------------

param apimServiceName string
param appInsightsLoggerName string = 'appinsights-logger'

@description('Name of the existing onboarded API to expose as MCP')
param sourceApiName string

@description('Operation names on the source API to expose as MCP tools')
param operationNames array

param mcpName string
param mcpDisplayName string
param mcpDescription string
param mcpPath string

@description('Whether a subscription key is required to reach the published MCP server')
param mcpSubscriptionRequired bool = true

@description('Header name callers use to present the subscription (API) key. Accepts the LLM-style "api-key" or the APIM-native "Ocp-Apim-Subscription-Key".')
@allowed([
  'api-key'
  'Ocp-Apim-Subscription-Key'
])
param subscriptionKeyHeaderName string = 'api-key'

@description('Custom rawxml policy. When empty, the baseline MCP policy is applied.')
param mcpPolicyXml string = ''

@description('''Opt-in: forward the caller's APIM subscription key to the SOURCE API on the internal tools/call hop.
Lets the source API stay subscription-protected (no anonymous direct access) while the SAME contract key reaches
both the MCP tool and the raw API underneath. Requires: (1) the source API onboarded with subscriptionRequired=true
reading its key from sourceSubscriptionKeyHeaderName, and (2) the source API added to the same access-contract product.
Ignored when a custom mcpPolicyXml is supplied. See publish-contract-guide.md.''')
param forwardSubscriptionKeyToSource bool = false

@description('Custom (non-standard) header the source API reads its subscription key from when forwardSubscriptionKeyToSource is true. Must NOT be a standard subscription header (api-key / Ocp-Apim-Subscription-Key) — APIM strips those before the backend hop, so they would not survive.')
param sourceSubscriptionKeyHeaderName string = 'x-mcp-sub-key'

// ------------------
//    VARIABLES
// ------------------

var defaultPolicyXml = loadTextContent('../policies/baseline-mcp-policy.xml')
// Opt-in key forwarding: inject a set-header that copies the caller's subscription key into a custom
// header the source API reads, so the internal tools/call -> source-API hop passes the source API's
// subscription gate (standard subscription headers are stripped by APIM before that hop).
var forwardKeySnippet = '        <set-header name="${sourceSubscriptionKeyHeaderName}" exists-action="override">\n            <value>@(context.Subscription?.Key ?? "")</value>\n        </set-header>\n'
var baselineWithForward = replace(defaultPolicyXml, '    </inbound>', '${forwardKeySnippet}    </inbound>')
var effectivePolicyXml = !empty(mcpPolicyXml) ? mcpPolicyXml : (forwardSubscriptionKeyToSource ? baselineWithForward : defaultPolicyXml)

// Query-string key name mirrors the header: the APIM-native header uses the 'subscription-key' query param,
// the LLM-style 'api-key' header uses an 'api-key' query param.
var subscriptionKeyQueryName = subscriptionKeyHeaderName == 'Ocp-Apim-Subscription-Key' ? 'subscription-key' : 'api-key'

// ------------------
//    RESOURCES
// ------------------

resource apim 'Microsoft.ApiManagement/service@2024-06-01-preview' existing = {
  name: apimServiceName
}

resource api 'Microsoft.ApiManagement/service/apis@2024-06-01-preview' existing = {
  parent: apim
  name: sourceApiName
}

resource operations 'Microsoft.ApiManagement/service/apis/operations@2024-06-01-preview' existing = [for operationName in operationNames: {
  parent: api
  name: operationName
}]

resource mcp 'Microsoft.ApiManagement/service/apis@2024-06-01-preview' = {
  parent: apim
  name: mcpName
  properties: {
    type: 'mcp'
    displayName: mcpDisplayName
    description: mcpDescription
    subscriptionRequired: mcpSubscriptionRequired
    path: mcpPath
    protocols: [
      'https'
    ]
    subscriptionKeyParameterNames: {
      header: subscriptionKeyHeaderName
      query: subscriptionKeyQueryName
    }
    // mcpTools is an MCP preview property not yet in the APIM bicep type definitions; suppress BCP037.
    #disable-next-line BCP037
    mcpTools: [for (operationName, i) in operationNames: {
      name: operations[i].name
      operationId: operations[i].id
      description: operations[i].properties.description
    }]
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
// API->MCP tools are served at {path}/mcp (APIM appends /mcp).
output endpoint string = '${apim.properties.gatewayUrl}/${mcpPath}/mcp'
