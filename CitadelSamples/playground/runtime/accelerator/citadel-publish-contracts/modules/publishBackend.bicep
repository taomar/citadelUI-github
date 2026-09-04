/**
 * @module publishBackend
 * @description Creates a single APIM backend for a published asset (native MCP server or A2A agent).
 *
 * Mirrors the resiliency patterns of llm-backend-onboarding: a native circuit breaker plus
 * credential injection driven by authType. Each published asset owns its own backend (backends are
 * NOT shared across assets). API->MCP assets do not use this module — they reuse the source API's
 * backend.
 *
 * Supported authType values:
 *  - none              : no credentials (e.g. a public remote MCP server)
 *  - managed-identity  : APIM system/user MI bearer token. `authConfig.resource` selects the audience
 *                        (default https://cognitiveservices.azure.com; use https://ai.azure.com for
 *                        Foundry-hosted A2A agents).
 *  - api-key-header    : static header injected from a named value. The named value must hold the RAW
 *                        key; `authConfig.headerName` sets the header (default 'api-key').
 *  - api-key-bearer    : Authorization header injected from a named value. The named value must hold
 *                        the COMPLETE value (e.g. 'Bearer sk-...').
 */

// ------------------
//    PARAMETERS
// ------------------

@description('Name of the API Management service')
param apimServiceName string

@description('Backend resource name (e.g. "<asset>-backend")')
param backendName string

@description('Backend description')
param backendDescription string = ''

@description('Backend base URL')
param backendUrl string

@description('Authentication type: none | managed-identity | api-key-header | api-key-bearer')
@allowed([
  'none'
  'managed-identity'
  'api-key-header'
  'api-key-bearer'
])
param authType string = 'none'

@description('Auth configuration. Shape: { resource?, clientId?, headerName?, namedValueKey?, keyVaultSecretUri?, secretValue? }')
param authConfig object = {}

@description('User-assigned managed identity client ID (required when authType=managed-identity and a specific UAMI is used)')
param managedIdentityClientId string = ''

@description('Master toggle for the circuit breaker on this backend')
param configureCircuitBreaker bool = true

@description('Circuit breaker settings (shallow-merged over defaults by the caller). Shape: { failureCount, failureInterval, tripDuration, acceptRetryAfter, errorReasons, statusCodeRanges, enabled? }')
param circuitBreaker object = {
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

// ------------------
//    VARIABLES
// ------------------

var namedValueKey = authConfig.?namedValueKey ?? ''
var needsNamedValue = (authType == 'api-key-header' || authType == 'api-key-bearer') && !empty(namedValueKey)
var miResource = authConfig.?resource ?? 'https://cognitiveservices.azure.com'
var headerName = authConfig.?headerName ?? 'api-key'
var cbEnabled = configureCircuitBreaker && (circuitBreaker.?enabled ?? true)
// Conditional dependency: only depend on the named value when one is actually created. Built as a
// resourceId-string ternary (not a symbolic reference) so Bicep preserves the condition — a symbolic
// reference would compile to an UNCONDITIONAL dependsOn with an empty name for authType 'none'.
var backendDependsOn = needsNamedValue ? [ resourceId('Microsoft.ApiManagement/service/namedValues', apimServiceName, namedValueKey) ] : []

// ------------------
//    RESOURCES
// ------------------

resource apimService 'Microsoft.ApiManagement/service@2024-06-01-preview' existing = {
  name: apimServiceName
}

// Named value holding the API key (created only for api-key-* auth). Prefers a Key Vault reference
// (rotatable, auditable); falls back to an inline secret value for testing.
resource apiKeyNamedValue 'Microsoft.ApiManagement/service/namedValues@2024-06-01-preview' = if (needsNamedValue) {
  name: namedValueKey
  parent: apimService
  properties: {
    displayName: namedValueKey
    secret: true
    keyVault: !empty(authConfig.?keyVaultSecretUri ?? '') ? {
      secretIdentifier: authConfig.keyVaultSecretUri
    } : null
    value: empty(authConfig.?keyVaultSecretUri ?? '') ? (authConfig.?secretValue ?? 'NOT_CONFIGURED') : null
  }
}

resource backend 'Microsoft.ApiManagement/service/backends@2024-06-01-preview' = {
  name: backendName
  parent: apimService
  dependsOn: backendDependsOn
  properties: {
    description: empty(backendDescription) ? 'Published asset backend: ${backendName}' : backendDescription
    url: backendUrl
    protocol: 'http'

    circuitBreaker: cbEnabled ? {
      rules: [
        {
          failureCondition: {
            count: circuitBreaker.failureCount
            errorReasons: circuitBreaker.errorReasons
            interval: circuitBreaker.failureInterval
            statusCodeRanges: circuitBreaker.statusCodeRanges
          }
          name: '${backendName}-breaker-rule'
          tripDuration: circuitBreaker.tripDuration
          acceptRetryAfter: circuitBreaker.acceptRetryAfter
        }
      ]
    } : null

    credentials: {
      #disable-next-line BCP037
      managedIdentity: authType == 'managed-identity' ? {
        clientId: empty(managedIdentityClientId) ? null : managedIdentityClientId
        resource: miResource
      } : null
      header: authType == 'managed-identity' && !empty(managedIdentityClientId) ? {
        'x-ms-client-id': [managedIdentityClientId]
      } : authType == 'api-key-bearer' ? {
        Authorization: ['{{${namedValueKey}}}']
      } : authType == 'api-key-header' ? {
        '${headerName}': ['{{${namedValueKey}}}']
      } : {}
    }

    tls: {
      validateCertificateChain: true
      validateCertificateName: true
    }
  }
}

// ------------------
//    OUTPUTS
// ------------------

output backendName string = backend.name
output backendUrl string = backendUrl
