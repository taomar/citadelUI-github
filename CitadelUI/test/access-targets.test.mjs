import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { aggregateAccessContractTargets } from '../server/access-targets.mjs';

const mainText = `
using './main.bicep'
param subscriptionId = readEnvironmentVariable('AZURE_SUBSCRIPTION_ID', 'sub-1')
param resourceGroupName = readEnvironmentVariable('AZURE_RESOURCE_GROUP', 'rg-main')
param apimServiceName = readEnvironmentVariable('APIM_SERVICE_NAME', 'apim-main')
param keyVaultName = readEnvironmentVariable('KEY_VAULT_NAME', 'kv-main')
param aiFoundryInstances = [
  {
    name: readEnvironmentVariable('AI_FOUNDRY_RESOURCE_NAME', 'foundry-main')
    location: 'eastus'
    defaultProjectName: 'project-main'
  }
  {
    name: readEnvironmentVariable('AI_FOUNDRY_RESOURCE_NAME', 'foundry-main')
    location: 'eastus'
    defaultProjectName: 'project-main'
  }
  {
    name: ''
    location: 'westeurope'
    defaultProjectName: ''
  }
]
`;

const onboardingText = `
using './main.bicep'
param llmBackendConfig = [
  {
    backendId: 'main'
    backendType: 'ai-foundry'
    endpoint: 'https://foundry-main.cognitiveservices.azure.com/'
    supportedModels: [{ name: 'gpt-4.1' }]
  }
  {
    backendId: 'other'
    backendType: 'ai-foundry'
    endpoint: 'https://unmatched.cognitiveservices.azure.com/'
    supportedModels: [{ name: 'phi-4' }]
  }
  {
    backendId: 'ignored'
    backendType: 'azure-openai'
    endpoint: 'https://ignored.openai.azure.com/'
    supportedModels: []
  }
]
`;

const resolved = aggregateAccessContractTargets({ mainText, onboardingText });
assert.deepEqual(
  {
    subscriptionId: resolved.apim.subscriptionId,
    resourceGroupName: resolved.apim.resourceGroupName,
    name: resolved.apim.name,
  },
  { subscriptionId: 'sub-1', resourceGroupName: 'rg-main', name: 'apim-main' }
);
assert.equal(resolved.apim.ready, true);
assert.equal(resolved.keyVault.ready, true);
assert.equal(
  resolved.foundries.length,
  2,
  'duplicate complete coordinates should collapse while incomplete candidates remain'
);
assert.deepEqual(resolved.foundries[0].indices, [0, 1]);
assert.equal(resolved.foundries[0].provenance[0].backendId, 'main');
assert.equal(resolved.foundries[1].ready, false);
assert.deepEqual(resolved.foundries[1].missing, ['accountName', 'projectName']);
assert.deepEqual(resolved.partialFoundries.map((entry) => entry.backendId), ['other']);
assert.equal(resolved.environment, null);
assert.equal(resolved.environmentFile, null);

const fallbackOnly = aggregateAccessContractTargets({
  mainText: mainText.replaceAll("'sub-1'", "''").replaceAll("'rg-main'", "''").replaceAll("'apim-main'", "''"),
  onboardingText,
});
assert.equal(fallbackOnly.apim.ready, false);
assert.deepEqual(fallbackOnly.apim.missingLocal, [
  'subscriptionId fallback',
  'resourceGroupName fallback',
  'apimServiceName fallback',
]);

const implementation = readFileSync(new URL('../server/access-targets.mjs', import.meta.url), 'utf8');
assert.equal(implementation.includes("node:fs"), false);
assert.equal(implementation.includes("envlayer"), false);
assert.equal(implementation.includes(".azure"), false);
assert.equal(implementation.includes(".env"), false);

console.log('Pure access target aggregation checks passed.');
