import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { aggregateAccessContractTargets } from '../server/access-targets.mjs';

const root = mkdtempSync(join(tmpdir(), 'citadel-targets-'));

try {
  mkdirSync(join(root, 'bicep', 'infra', 'llm-backend-onboarding'), { recursive: true });
  mkdirSync(join(root, '.azure', 'dev'), { recursive: true });
  writeFileSync(join(root, '.azure', 'dev', '.env'), [
    'AZURE_SUBSCRIPTION_ID="sub-1"',
    'AZURE_RESOURCE_GROUP="rg-main"',
    'APIM_SERVICE_NAME="apim-main"',
    'KEY_VAULT_NAME="kv-main"',
    'AI_FOUNDRY_RESOURCE_NAME="foundry-main"',
  ].join('\n'));
  writeFileSync(join(root, 'bicep', 'infra', 'main.bicepparam'), `
using './main.bicep'
param resourceGroupName = readEnvironmentVariable('AZURE_RESOURCE_GROUP', '')
param apimServiceName = readEnvironmentVariable('APIM_SERVICE_NAME', '')
param keyVaultName = readEnvironmentVariable('KEY_VAULT_NAME', '')
param aiFoundryInstances = [
  {
    name: readEnvironmentVariable('AI_FOUNDRY_RESOURCE_NAME', '')
    location: 'eastus'
    defaultProjectName: 'project-main'
  }
  {
    name: readEnvironmentVariable('AI_FOUNDRY_RESOURCE_NAME', '')
    location: 'eastus'
    defaultProjectName: 'project-main'
  }
  {
    name: ''
    location: 'westeurope'
    defaultProjectName: ''
  }
]
`);
  writeFileSync(join(root, 'bicep', 'infra', 'llm-backend-onboarding', 'main.bicepparam'), `
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
`);

  const resolved = aggregateAccessContractTargets({ repoRoot: root, environment: 'dev' });
  assert.deepEqual(
    { subscriptionId: resolved.apim.subscriptionId, resourceGroupName: resolved.apim.resourceGroupName, name: resolved.apim.name },
    { subscriptionId: 'sub-1', resourceGroupName: 'rg-main', name: 'apim-main' }
  );
  assert.equal(resolved.apim.ready, true);
  assert.equal(resolved.keyVault.ready, true);
  assert.equal(resolved.foundries.length, 2, 'duplicate complete coordinates should collapse while incomplete candidates remain');
  assert.deepEqual(resolved.foundries[0].indices, [0, 1]);
  assert.equal(resolved.foundries[0].provenance[0].backendId, 'main');
  assert.equal(resolved.foundries[1].ready, false);
  assert.deepEqual(resolved.foundries[1].missing, ['projectName']);
  assert.deepEqual(resolved.partialFoundries.map((entry) => entry.backendId), ['other']);

  const unresolved = aggregateAccessContractTargets({ repoRoot: root });
  assert.equal(unresolved.apim.ready, false);
  assert.deepEqual(unresolved.apim.missingLocal, [
    'AZURE_SUBSCRIPTION_ID',
    'resourceGroupName or AZURE_RESOURCE_GROUP',
    'apimServiceName or APIM_SERVICE_NAME',
  ]);
  console.log('Access target aggregation checks passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
