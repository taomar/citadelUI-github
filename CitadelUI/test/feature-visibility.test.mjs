import assert from 'node:assert/strict';

import {
  deploymentPresentation,
  FEATURE_DEPENDENCIES,
} from '../web/js/paramview.mjs';

const sections = [
  {
    id: 'basic',
    title: 'BASIC PARAMETERS',
    params: ['environmentName', 'apicLocation'],
    groups: [{ params: ['environmentName', 'apicLocation'] }],
  },
  {
    id: 'resources',
    title: 'RESOURCE NAMES - Assign custom names',
    params: ['resourceGroupName', 'apicServiceName', 'redisCacheName'],
    groups: [{ params: ['resourceGroupName', 'apicServiceName', 'redisCacheName'] }],
  },
  {
    id: 'features',
    title: 'FEATURE FLAGS - Deploy specific capabilities',
    params: ['enableAPICenter', 'enableManagedRedis', 'entraAuth', 'enableAzureAISearch'],
    groups: [{
      params: ['enableAPICenter', 'enableManagedRedis', 'entraAuth', 'enableAzureAISearch'],
    }],
  },
  {
    id: 'entra',
    title: 'ENTRA ID AUTHENTICATION',
    params: ['entraTenantId', 'entraClientId', 'entraAudience', 'entraClientSecret'],
    groups: [{
      params: ['entraTenantId', 'entraClientId', 'entraAudience', 'entraClientSecret'],
    }],
  },
  {
    id: 'accelerator',
    title: 'ACCELERATOR SPECIFIC PARAMETERS',
    params: ['aiSearchInstances', 'aiFoundryInstances'],
    groups: [{ params: ['aiSearchInstances', 'aiFoundryInstances'] }],
  },
];

function presentation(values) {
  return deploymentPresentation(
    {
      path: 'bicep/infra/main.bicepparam',
      outline: { sections },
    },
    { paramValue: (name) => values[name], pendingFor: () => false }
  );
}

const disabled = presentation({
  enableAPICenter: false,
  enableManagedRedis: 'false',
  entraAuth: false,
  enableAzureAISearch: false,
});
assert.deepEqual(disabled.map((section) => section.id), [
  'basic',
  'features',
  'resources',
  'accelerator',
]);
assert.deepEqual(disabled.find((section) => section.id === 'basic').params, ['environmentName']);
assert.deepEqual(disabled.find((section) => section.id === 'resources').params, ['resourceGroupName']);
assert.equal(disabled.some((section) => section.id === 'entra'), false);
assert.deepEqual(disabled.find((section) => section.id === 'accelerator').params, ['aiFoundryInstances']);
const coveredSource = new Set(sections.flatMap((section) => section.params));
assert(coveredSource.has('apicLocation'));

const enabled = presentation({
  enableAPICenter: true,
  enableManagedRedis: true,
  entraAuth: true,
  enableAzureAISearch: true,
});
assert(enabled.find((section) => section.id === 'basic').params.includes('apicLocation'));
assert(enabled.find((section) => section.id === 'resources').params.includes('redisCacheName'));
assert.equal(enabled.find((section) => section.id === 'entra').params.length, 4);
assert(enabled.find((section) => section.id === 'accelerator').params.includes('aiSearchInstances'));
assert.equal(FEATURE_DEPENDENCIES.aiFoundryInstances, undefined);

console.log('Feature ordering and conditional visibility checks passed.');
