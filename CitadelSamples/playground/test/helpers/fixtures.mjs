/**
 * Test fixtures.
 *
 * A fully populated, entirely fictional configuration. No value here is a real
 * Azure identifier, endpoint or credential, and the "api-key" is an obvious
 * placeholder string that the redaction tests search for.
 */

import { CATALOGUE } from '../../src/catalogue/index.mjs';

/** The one fake secret. Tests assert it never appears in plans or previews. */
export const FAKE_API_KEY = 'FAKE-CONTRACT-KEY-do-not-use-0000';

export const FIXTURE_SECRETS = Object.freeze({ 'gatewayAccess.apiKey': FAKE_API_KEY });

/** Non-secret values, keyed by dotted path. Defaults fill in the rest. */
export const FIXTURE_VALUES = Object.freeze({
  'hub.subscriptionId': '00000000-1111-2222-3333-444444444444',
  'hub.resourceGroupName': 'rg-citadel-hub-test',
  'hub.location': 'swedencentral',
  'hub.apimName': 'apim-citadel-test',
  'hub.gatewayUrl': 'https://apim-citadel-test.azure-api.net',

  'foundry.accountName': 'aif-citadel-test',
  'foundry.projectName': 'proj-citadel-test',
  'foundry.agentName': 'HR-ChatAgent',
  'foundry.apimIdentityPrincipalId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'foundry.apimIdentityClientId': '11111111-2222-3333-4444-555555555555',
  'foundry.accountResourceId':
    '/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/aif-citadel-test',

  'keyVault.name': 'kv-citadel-test',
  'keyVault.keySecretName': 'MULTI-Governance-PublishedAssets-DEV-PUBLISHED-ASSETS-KEY',
  'keyVault.endpointSecretNames': [
    'MULTI-Governance-PublishedAssets-DEV-universal-llm-api-endpoint',
    'MULTI-Governance-PublishedAssets-DEV-weather-tool-endpoint',
    'MULTI-Governance-PublishedAssets-DEV-ms-learn-tool-endpoint',
    'MULTI-Governance-PublishedAssets-DEV-hr-chat-agent-endpoint',
  ],

  'samples.access-contract-deploy.existingLlmApis': ['universal-llm-api'],
  'samples.tool-rate-limit-burst.confirmNonProduction': true,
  'samples.agent-rate-limit-burst.confirmNonProduction': true,
  'samples.cleanup.confirmNonProduction': true,
});

/**
 * A reader over defaults + fixture values + optional overrides.
 * Mirrors what `state.read` does at runtime, without any UI.
 */
export function makeFixtureReader(overrides = {}, { secrets = FIXTURE_SECRETS } = {}) {
  const merged = { ...CATALOGUE.defaultValues, ...FIXTURE_VALUES, ...overrides };
  return (path) => {
    if (CATALOGUE.secretFieldPaths.includes(path)) return secrets[path] ?? '';
    return merged[path];
  };
}

/** A reader with nothing supplied beyond the catalogue defaults. */
export function makeEmptyReader(overrides = {}) {
  const merged = { ...CATALOGUE.defaultValues, ...overrides };
  return (path) => merged[path];
}
