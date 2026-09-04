/**
 * Server-authoritative execution identity vocabulary.
 *
 * This module performs no I/O. It classifies every catalogue sample and keeps
 * the response enums shared by the server, tests, and a future UI integration.
 */

export const EXECUTION_CONTEXT_KINDS = Object.freeze([
  'azure-cli-management',
  'azure-cli-python-management',
  'azure-cli-foundry-token',
  'gateway-key',
  'offline-python',
  'hosted-relay',
]);

export const EXECUTION_CONTEXT_STATES = Object.freeze([
  'ready',
  'unavailable',
  'signed-out',
  'subscription-mismatch',
  'missing-key',
  'deferred',
]);

const AZURE_CLI_MANAGEMENT = Object.freeze({
  kind: 'azure-cli-management',
  label: 'Local Azure CLI user',
  authorityType: 'azure-cli-user',
  subscriptionSource: 'hub',
  summary:
    'Azure management operations run as the user or service principal in the local Azure CLI session. No token is returned to the browser.',
});

const AZURE_CLI_PYTHON_MANAGEMENT = Object.freeze({
  kind: 'azure-cli-python-management',
  label: 'Python using the local Azure CLI user',
  authorityType: 'azure-cli-user',
  subscriptionSource: 'hub',
  summary:
    'The shipped Python management wrapper uses AzureCliCredential and therefore inherits the same local Azure CLI user, tenant, and active subscription.',
});

const AZURE_CLI_FOUNDRY_TOKEN = Object.freeze({
  kind: 'azure-cli-foundry-token',
  label: 'Foundry token from the local Azure CLI user',
  authorityType: 'azure-cli-user',
  subscriptionSource: 'hub',
  summary:
    'The local executor obtains a Foundry audience token for the signed-in Azure CLI user. The token remains server-side and is never returned.',
});

const GATEWAY_KEY = Object.freeze({
  kind: 'gateway-key',
  label: 'Memory-only API Management subscription key',
  authorityType: 'apim-subscription-key',
  subscriptionSource: null,
  summary:
    'The gateway request uses the memory-only API Management subscription key under the configured header name. Only key presence is reported.',
});

const SAMPLE_EXECUTION_CONTEXTS = Object.freeze({
  'azure-context-check': AZURE_CLI_MANAGEMENT,
  'apim-discovery': AZURE_CLI_MANAGEMENT,
  'foundry-enable-a2a': AZURE_CLI_FOUNDRY_TOKEN,
  'apim-foundry-grant': AZURE_CLI_MANAGEMENT,
  'weather-api-ensure': AZURE_CLI_PYTHON_MANAGEMENT,
  'publish-assets': AZURE_CLI_MANAGEMENT,
  'access-contract-deploy': Object.freeze({
    ...AZURE_CLI_MANAGEMENT,
    summary:
      'The deployment runs as the local Azure CLI user. Its documented Python key fallback uses AzureCliCredential and inherits that same session.',
  }),
  'access-contract-kv-verify': Object.freeze({
    ...AZURE_CLI_MANAGEMENT,
    subscriptionSource: 'key-vault',
  }),
  'weather-mcp-discovery': GATEWAY_KEY,
  'learn-mcp-discovery': GATEWAY_KEY,
  'a2a-agent-card': GATEWAY_KEY,
  'a2a-message-send': GATEWAY_KEY,
  'agent-framework-hr-question': Object.freeze({
    ...GATEWAY_KEY,
    summary:
      'The shipped Python client calls the gateway with the memory-only API Management subscription key. It does not use AzureCliCredential.',
  }),
  'weather-tools-call': GATEWAY_KEY,
  'usage-metrics': AZURE_CLI_MANAGEMENT,
  'circuit-breaker-check': AZURE_CLI_MANAGEMENT,
  'tool-rate-limit-burst': GATEWAY_KEY,
  'agent-rate-limit-burst': GATEWAY_KEY,
  cleanup: AZURE_CLI_MANAGEMENT,
});

export const FUTURE_HOSTED_PROCESS_CONTEXT = Object.freeze({
  state: 'deferred',
  identity: 'per-run-managed-identity',
  isolation: 'no-ingress-job',
  proven: false,
});

export function sampleExecutionContext(sampleId) {
  const context = SAMPLE_EXECUTION_CONTEXTS[sampleId];
  if (!context) throw new Error(`Sample "${sampleId}" has no execution-context classification.`);
  return context;
}

export function classifiedSampleIds() {
  return Object.freeze(Object.keys(SAMPLE_EXECUTION_CONTEXTS));
}

export function configuredSubscriptionForSample(sampleId, inputs = {}) {
  const descriptor = sampleExecutionContext(sampleId);
  if (descriptor.subscriptionSource === 'key-vault') {
    return normaliseSubscription(inputs['keyVault.subscriptionId']) ?? normaliseSubscription(inputs['hub.subscriptionId']);
  }
  if (descriptor.subscriptionSource === 'hub') return normaliseSubscription(inputs['hub.subscriptionId']);
  return null;
}

export function isAzureCliContext(kind) {
  return kind === 'azure-cli-management' || kind === 'azure-cli-python-management' || kind === 'azure-cli-foundry-token';
}

export function offlinePythonContext({ available }) {
  return Object.freeze({
    kind: 'offline-python',
    label: 'Local Python parser',
    summary: available
      ? 'The server-selected Python interpreter parses protected notebook source locally. It uses no Azure identity and makes no network request.'
      : 'The local Python parser is unavailable, so protected source was not validated.',
    state: available ? 'ready' : 'unavailable',
    code: available ? null : 'preview-unavailable',
    canExecute: Boolean(available),
    authority: Object.freeze({
      type: 'local-python-parser',
      principalName: null,
      principalType: null,
      tenantId: null,
    }),
    subscription: emptySubscription(),
    gateway: null,
    hostedRelay: null,
    guarantees: guarantees(),
  });
}

export function hostedRelayContext({ available }) {
  return Object.freeze({
    kind: 'hosted-relay',
    label: 'Entra-authorized hosted relay',
    summary: available
      ? 'The authenticated Entra caller authorizes the request. The relay uses a tenant-scoped managed identity and resolves the APIM key through its Key Vault mapping.'
      : 'This sample is not allowlisted for the configured hosted relay.',
    state: available ? 'ready' : 'unavailable',
    code: available ? null : 'relay-sample-unavailable',
    canExecute: Boolean(available),
    authority: Object.freeze({
      type: 'entra-caller-and-managed-identity',
      principalName: null,
      principalType: null,
      tenantId: null,
    }),
    subscription: emptySubscription(),
    gateway: null,
    hostedRelay: Object.freeze({
      callerAuthorization: 'entra',
      relayIdentity: 'tenant-scoped-managed-identity',
      keySource: 'key-vault-mapping',
    }),
    guarantees: guarantees(),
  });
}

export function unavailableSampleContext(descriptor) {
  return Object.freeze({
    kind: descriptor.kind,
    label: descriptor.label,
    summary: descriptor.summary,
    state: 'unavailable',
    code: 'preview-unavailable',
    canExecute: false,
    authority: Object.freeze({
      type: descriptor.authorityType,
      principalName: null,
      principalType: null,
      tenantId: null,
    }),
    subscription: emptySubscription(),
    gateway: descriptor.kind === 'gateway-key' ? Object.freeze({ keyPresent: false, headerName: '' }) : null,
    hostedRelay: null,
    guarantees: guarantees(),
  });
}

export function guarantees() {
  return Object.freeze({
    tokensExposed: false,
    credentialsPersisted: false,
  });
}

export function emptySubscription() {
  return Object.freeze({
    activeId: null,
    activeName: null,
    configuredId: null,
    matches: null,
  });
}

function normaliseSubscription(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
