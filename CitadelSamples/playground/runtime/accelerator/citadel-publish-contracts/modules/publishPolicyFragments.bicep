/**
 * @module publishPolicyFragments
 * @description Idempotently ensures the publish-contract usage fragments (mcp-usage, a2a-usage) exist
 * on the target APIM. These are also registered by the primary gateway's policy-fragments module; this
 * module lets the citadel-publish-contracts deployment run standalone against an existing gateway.
 * The XML is loaded from the canonical gateway policies directory so there is a single source of truth.
 */

param apimServiceName string

resource apimService 'Microsoft.ApiManagement/service@2024-06-01-preview' existing = {
  name: apimServiceName
}

resource mcpUsageFragment 'Microsoft.ApiManagement/service/policyFragments@2024-06-01-preview' = {
  parent: apimService
  name: 'mcp-usage'
  properties: {
    description: 'Tracks usage of published Tools (MCP) as App Insights custom metrics (mcp-usage namespace)'
    value: loadTextContent('../../modules/apim/policies/frag-mcp-usage.xml')
    format: 'rawxml'
  }
}

resource a2aUsageFragment 'Microsoft.ApiManagement/service/policyFragments@2024-06-01-preview' = {
  parent: apimService
  name: 'a2a-usage'
  properties: {
    description: 'Tracks usage of published Agents (A2A) as App Insights custom metrics (a2a-usage namespace)'
    value: loadTextContent('../../modules/apim/policies/frag-a2a-usage.xml')
    format: 'rawxml'
  }
}

output mcpUsageFragmentName string = mcpUsageFragment.name
output a2aUsageFragmentName string = a2aUsageFragment.name
