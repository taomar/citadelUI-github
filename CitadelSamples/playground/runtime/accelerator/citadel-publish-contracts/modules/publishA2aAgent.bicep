/**
 * @module publishA2aAgent
 * @description Publishes an Agent (A2A) endpoint through the gateway using APIM's native A2A API type.
 * APIM re-exposes the agent card at a well-known path and proxies JSON-RPC calls to the backend agent.
 * The gateway authenticates to the (Foundry) agent by attaching a managed-identity token in the policy
 * via <authentication-managed-identity> — the a2aProperties/jsonRpcProperties use full backend URLs, so
 * there is no APIM backend object in the request path (auth is done in policy, not on a backend).
 *
 * For Foundry-hosted agents:
 *  - agentCardBackendUrl -> https://{account}.services.ai.azure.com/api/projects/{project}/agents/{agent}/endpoint/protocols/a2a/agentCard/v1.0
 *  - jsonRpcBackendUrl   -> https://{account}.services.ai.azure.com/api/projects/{project}/agents/{agent}/endpoint/protocols/a2a
 *  - managedIdentityClientId must be a UAMI granted 'Foundry Agent Consumer' (or 'Azure AI User') on the project
 *  - incoming A2A must be enabled on the agent first (see the validation notebook / Learn guide)
 *
 * NOTE: Client auth is subscription (API) key based and configurable via subscriptionRequired +
 * subscriptionKeyHeaderName ('api-key' or 'Ocp-Apim-Subscription-Key'). Richer client auth (JWT, product
 * scoping) is layered on by the phase-2 Access Contract.
 */

// ------------------
//    PARAMETERS
// ------------------

param apimServiceName string
param appInsightsLoggerName string = 'appinsights-logger'

@description('Agent (A2A) API name')
param agentName string

@description('Logical agent id surfaced on the API resource')
param agentId string = ''

param agentDisplayName string
param agentDescription string = ''

@description('Gateway path the agent is published under')
param agentPath string

@description('Path APIM exposes the agent card at (bridged to the backend card URL)')
param agentCardPath string = '/.well-known/agent.json'

@description('Backend URL that serves the agent card (e.g. the Foundry agentCard/v1.0 URL)')
param agentCardBackendUrl string

@description('Backend base URL for JSON-RPC A2A interactions')
param jsonRpcBackendUrl string

@description('JSON-RPC path on the backend')
param jsonRpcPath string = '/'

@description('Whether a subscription (API) key is required to call the agent. When true, callers must present a valid subscription key in the configured header; when false the endpoint is anonymous at the gateway (client auth deferred to the phase-2 Access Contract).')
param subscriptionRequired bool = false

@description('Header name callers use to present the subscription (API) key. Accepts the LLM-style "api-key" or the APIM-native "Ocp-Apim-Subscription-Key".')
@allowed([
  'api-key'
  'Ocp-Apim-Subscription-Key'
])
param subscriptionKeyHeaderName string = 'api-key'

@description('Client id of the user-assigned managed identity used to authenticate to the agent backend (empty = system-assigned)')
param managedIdentityClientId string = ''

@description('Audience/resource the managed-identity token is issued for (Foundry = https://ai.azure.com)')
param backendAuthResource string = 'https://ai.azure.com'

@description('Custom rawxml policy. When empty, the baseline A2A policy is applied.')
param a2aPolicyXml string = ''

// ------------------
//    VARIABLES
// ------------------

// Managed-identity element injected into the baseline policy so the gateway attaches a Bearer token
// to the (Foundry) agent backend calls. client-id is included only for a user-assigned identity.
var backendAuthElement = empty(managedIdentityClientId)
  ? '<authentication-managed-identity resource="${backendAuthResource}" />'
  : '<authentication-managed-identity resource="${backendAuthResource}" client-id="${managedIdentityClientId}" />'

// Gateway A2A endpoint that clients should target, and the outbound card-rewrite element that replaces
// the backend (Foundry) transport URLs in the agent card with this gateway URL. Guarded to JSON responses
// (the card is JSON; Foundry incoming A2A is non-streaming) so it never buffers a streaming body.
var gatewayA2aUrl = '${apim.properties.gatewayUrl}/${agentPath}'
var cardRewriteElement = '<choose><when condition="@(context.Response.Headers.GetValueOrDefault(&quot;Content-Type&quot;,&quot;&quot;).Contains(&quot;json&quot;))"><find-and-replace from="${jsonRpcBackendUrl}" to="${gatewayA2aUrl}" /></when></choose>'

var defaultPolicyXml = replace(replace(loadTextContent('../policies/baseline-a2a-policy.xml'), '<!-- {backendAuth} -->', backendAuthElement), '<!-- {cardRewrite} -->', cardRewriteElement)
var effectivePolicyXml = empty(a2aPolicyXml) ? defaultPolicyXml : a2aPolicyXml
var effectiveAgentId = empty(agentId) ? agentName : agentId

// Query-string key name mirrors the header: APIM-native header uses the 'subscription-key' query param,
// the LLM-style 'api-key' header uses an 'api-key' query param.
var subscriptionKeyQueryName = subscriptionKeyHeaderName == 'Ocp-Apim-Subscription-Key' ? 'subscription-key' : 'api-key'

// ------------------
//    RESOURCES
// ------------------

resource apim 'Microsoft.ApiManagement/service@2025-09-01-preview' existing = {
  name: apimServiceName
}

resource agent 'Microsoft.ApiManagement/service/apis@2025-09-01-preview' = {
  parent: apim
  name: agentName
  properties: {
    displayName: agentDisplayName
    description: agentDescription
    type: 'a2a'
    // A2A preview properties are not yet in the APIM bicep type definitions; suppress BCP037.
    #disable-next-line BCP037
    agent: {
      id: effectiveAgentId
    }
    #disable-next-line BCP037
    isAgent: true
    #disable-next-line BCP037
    a2aProperties: {
      agentCardPath: agentCardPath
      agentCardBackendUrl: agentCardBackendUrl
    }
    #disable-next-line BCP037
    jsonRpcProperties: {
      backendUrl: jsonRpcBackendUrl
      path: jsonRpcPath
    }
    subscriptionRequired: subscriptionRequired
    path: agentPath
    protocols: [
      'https'
    ]
    subscriptionKeyParameterNames: {
      header: subscriptionKeyHeaderName
      query: subscriptionKeyQueryName
    }
    isCurrent: true
  }
}

resource agentInsights 'Microsoft.ApiManagement/service/apis/diagnostics@2022-08-01' = {
  name: 'applicationinsights'
  parent: agent
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
  }
}

resource policy 'Microsoft.ApiManagement/service/apis/policies@2021-12-01-preview' = {
  parent: agent
  name: 'policy'
  properties: {
    value: effectivePolicyXml
    format: 'rawxml'
  }
}

// ------------------
//    OUTPUTS
// ------------------

output name string = agent.name
output path string = agentPath
output agentCardEndpoint string = '${apim.properties.gatewayUrl}/${agentPath}${agentCardPath}'
output a2aEndpoint string = '${apim.properties.gatewayUrl}/${agentPath}'
