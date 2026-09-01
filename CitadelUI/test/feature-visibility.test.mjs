import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  deploymentPresentation,
  FEATURE_GROUPS,
  PARAMETER_VISIBILITY,
  parameterVisible,
} from '../web/js/paramview.mjs';

const group = (params) => ({ label: null, blocks: [], params });
const section = (id, title, params) => ({
  id,
  title,
  params,
  groups: [group(params)],
  blocks: [],
});

const sections = [
  section('basic', 'BASIC PARAMETERS', [
    'environmentName',
    'apicLocation',
  ]),
  section('resources', 'RESOURCE NAMES - Assign custom names', [
    'resourceGroupName',
    'apicServiceName',
    'redisCacheName',
    'apimApplicationInsightsDashboardName',
    'funcApplicationInsightsDashboardName',
    'foundryApplicationInsightsDashboardName',
    'apimApplicationInsightsName',
    'funcApplicationInsightsName',
    'foundryApplicationInsightsName',
  ]),
  section('monitoring', 'MONITORING - Log Analytics configuration', [
    'useExistingLogAnalytics',
    'logAnalyticsName',
    'existingLogAnalyticsName',
    'existingLogAnalyticsRG',
    'existingLogAnalyticsSubscriptionId',
  ]),
  section('networking', 'NETWORKING PARAMETERS - Network configuration', [
    'vnetName',
    'useExistingVnet',
    'existingVnetRG',
    'apimSubnetName',
    'privateEndpointSubnetName',
    'functionAppSubnetName',
    'agentSubnetName',
    'vnetAddressPrefix',
    'apimSubnetPrefix',
    'privateEndpointSubnetPrefix',
    'functionAppSubnetPrefix',
    'agentSubnetPrefix',
    'apimNsgName',
    'privateEndpointNsgName',
    'functionAppNsgName',
    'agentSubnetNsgName',
    'apimRouteTableName',
    'dnsZoneRG',
    'dnsSubscriptionId',
    'existingPrivateDnsZones',
    'apimNetworkType',
    'apimV2UsePrivateEndpoint',
    'apimV2PublicNetworkAccess',
    'apimV2PrivateEndpointName',
    'cosmosDbPublicAccess',
    'cosmosDbPrivateEndpointName',
    'eventHubNetworkAccess',
    'eventHubPrivateEndpointName',
    'aiFoundryExternalNetworkAccess',
    'aiFoundryPrivateEndpointName',
    'keyVaultExternalNetworkAccess',
    'keyVaultPrivateEndpointName',
    'useAzureMonitorPrivateLinkScope',
    'redisPublicNetworkAccess',
    'redisPrivateEndpointName',
  ]),
  section('features', 'FEATURE FLAGS - Deploy specific capabilities', [
    'createAppInsightsDashboards',
    'enableAIModelInference',
    'enableDocumentIntelligence',
    'enableAzureAISearch',
    'enableAIGatewayPiiRedaction',
    'enableOpenAIRealtime',
    'entraAuth',
    'enableAPICenter',
    'enableManagedRedis',
    'enableUnifiedAiApi',
  ]),
  section('compute', 'COMPUTE SKU & SIZE', [
    'apimSku',
    'apimSkuUnits',
    'apicSku',
    'redisSkuName',
    'redisSkuCapacity',
    'redisHighAvailability',
  ]),
  section('accelerator', 'ACCELERATOR SPECIFIC PARAMETERS', [
    'aiSearchInstances',
    'aiFoundryInstances',
  ]),
  section('entra', 'ENTRA ID AUTHENTICATION', [
    'entraTenantId',
    'entraClientId',
    'entraAudience',
    'entraClientSecret',
  ]),
];

const baseline = {
  createAppInsightsDashboards: false,
  enableAIModelInference: true,
  enableDocumentIntelligence: false,
  enableAzureAISearch: false,
  enableAIGatewayPiiRedaction: true,
  enableOpenAIRealtime: true,
  entraAuth: false,
  enableAPICenter: false,
  enableManagedRedis: false,
  enableUnifiedAiApi: true,
  useExistingLogAnalytics: true,
  useAzureMonitorPrivateLinkScope: false,
  useExistingVnet: false,
  apimSku: 'StandardV2',
  apimV2UsePrivateEndpoint: true,
  apimV2PublicNetworkAccess: true,
};

function presentation(overrides = {}, pending = []) {
  const values = { ...baseline, ...overrides };
  const dirty = new Set(pending);
  return deploymentPresentation(
    {
      path: 'bicep/infra/main.bicepparam',
      outline: { sections },
    },
    {
      paramValue: (name) => values[name],
      pendingFor: (name) => dirty.has(name),
    }
  );
}

function params(result) {
  return result.flatMap((item) => item.params);
}

function paramsIn(result, id) {
  return result.find((item) => item.id === id)?.params || [];
}

function expectVisible(result, names) {
  const visible = new Set(params(result));
  for (const name of names) assert(visible.has(name), `${name} should be visible`);
}

function expectHidden(result, names) {
  const visible = new Set(params(result));
  for (const name of names) assert(!visible.has(name), `${name} should be hidden`);
}

const disabled = presentation();
assert.deepEqual(disabled.map((item) => item.id), [
  'basic',
  'features',
  'resources',
  'monitoring',
  'networking',
  'compute',
  'accelerator',
]);

const feature = disabled.find((item) => item.id === 'features');
assert.deepEqual(
  feature.groups.map((item) => item.label),
  FEATURE_GROUPS.map((item) => item.label)
);
assert.deepEqual(feature.groups.map((item) => item.params), [
  [
    'enableAIModelInference',
    'enableDocumentIntelligence',
    'enableOpenAIRealtime',
    'enableUnifiedAiApi',
  ],
  [
    'enableAzureAISearch',
    'enableManagedRedis',
    'enableAIGatewayPiiRedaction',
    'enableAPICenter',
  ],
  [
    'entraAuth',
    'createAppInsightsDashboards',
    'useExistingLogAnalytics',
    'useAzureMonitorPrivateLinkScope',
  ],
  [
    'useExistingVnet',
    'apimV2UsePrivateEndpoint',
    'apimV2PublicNetworkAccess',
  ],
]);

for (const moved of [
  'useExistingLogAnalytics',
  'useExistingVnet',
  'useAzureMonitorPrivateLinkScope',
  'apimV2UsePrivateEndpoint',
  'apimV2PublicNetworkAccess',
]) {
  assert(feature.params.includes(moved), `${moved} was not moved into Feature Flags`);
  assert.equal(
    disabled.filter((item) => item.id !== 'features').some((item) => item.params.includes(moved)),
    false,
    `${moved} is duplicated outside Feature Flags`
  );
}
assert.equal(params(disabled).length, new Set(params(disabled)).size, 'visible parameters are duplicated');

expectHidden(disabled, [
  'apicLocation',
  'apicServiceName',
  'apicSku',
  'redisCacheName',
  'redisPrivateEndpointName',
  'redisPublicNetworkAccess',
  'redisSkuName',
  'redisSkuCapacity',
  'redisHighAvailability',
  'entraTenantId',
  'entraClientId',
  'entraAudience',
  'entraClientSecret',
  'aiSearchInstances',
  'apimApplicationInsightsDashboardName',
  'funcApplicationInsightsDashboardName',
  'foundryApplicationInsightsDashboardName',
  'logAnalyticsName',
  'existingVnetRG',
  'dnsZoneRG',
  'dnsSubscriptionId',
  'existingPrivateDnsZones',
  'apimNetworkType',
]);
expectVisible(disabled, [
  'existingLogAnalyticsName',
  'existingLogAnalyticsRG',
  'existingLogAnalyticsSubscriptionId',
  'vnetAddressPrefix',
  'apimSubnetPrefix',
  'privateEndpointSubnetPrefix',
  'functionAppSubnetPrefix',
  'agentSubnetPrefix',
  'apimNsgName',
  'privateEndpointNsgName',
  'functionAppNsgName',
  'agentSubnetNsgName',
  'apimRouteTableName',
  'apimV2PrivateEndpointName',
]);

// These fields are shared or independently meaningful and must never follow a
// similarly named feature/public-access selector by guesswork.
expectVisible(disabled, [
  'resourceGroupName',
  'apimApplicationInsightsName',
  'funcApplicationInsightsName',
  'foundryApplicationInsightsName',
  'vnetName',
  'apimSubnetName',
  'privateEndpointSubnetName',
  'functionAppSubnetName',
  'agentSubnetName',
  'cosmosDbPublicAccess',
  'cosmosDbPrivateEndpointName',
  'eventHubNetworkAccess',
  'eventHubPrivateEndpointName',
  'aiFoundryExternalNetworkAccess',
  'aiFoundryPrivateEndpointName',
  'keyVaultExternalNetworkAccess',
  'keyVaultPrivateEndpointName',
  'aiFoundryInstances',
]);

const servicesOn = presentation({
  createAppInsightsDashboards: true,
  enableAzureAISearch: true,
  enableManagedRedis: true,
  enableAPICenter: true,
  entraAuth: true,
});
expectVisible(servicesOn, [
  'apicLocation',
  'apicServiceName',
  'apicSku',
  'redisCacheName',
  'redisPrivateEndpointName',
  'redisPublicNetworkAccess',
  'redisSkuName',
  'redisSkuCapacity',
  'redisHighAvailability',
  'entraTenantId',
  'entraClientId',
  'entraAudience',
  'entraClientSecret',
  'aiSearchInstances',
  'apimApplicationInsightsDashboardName',
  'funcApplicationInsightsDashboardName',
  'foundryApplicationInsightsDashboardName',
]);

const newLogAnalytics = presentation({ useExistingLogAnalytics: false });
expectVisible(newLogAnalytics, ['logAnalyticsName']);
expectHidden(newLogAnalytics, [
  'existingLogAnalyticsName',
  'existingLogAnalyticsRG',
  'existingLogAnalyticsSubscriptionId',
]);

const existingVnet = presentation({ useExistingVnet: true });
expectVisible(existingVnet, [
  'existingVnetRG',
  'dnsZoneRG',
  'dnsSubscriptionId',
  'existingPrivateDnsZones',
  'vnetName',
  'apimSubnetName',
  'privateEndpointSubnetName',
  'functionAppSubnetName',
  'agentSubnetName',
]);
expectHidden(existingVnet, [
  'vnetAddressPrefix',
  'apimSubnetPrefix',
  'privateEndpointSubnetPrefix',
  'functionAppSubnetPrefix',
  'agentSubnetPrefix',
  'apimNsgName',
  'privateEndpointNsgName',
  'functionAppNsgName',
  'agentSubnetNsgName',
  'apimRouteTableName',
]);

const classicApim = presentation({ apimSku: 'Developer' });
expectVisible(classicApim, ['apimNetworkType']);
expectHidden(classicApim, [
  'apimV2UsePrivateEndpoint',
  'apimV2PublicNetworkAccess',
  'apimV2PrivateEndpointName',
]);
assert.deepEqual(
  classicApim.find((item) => item.id === 'features').groups.at(-1).params,
  ['useExistingVnet']
);

const v2WithoutPrivateEndpoint = presentation({
  apimSku: 'PremiumV2',
  apimV2UsePrivateEndpoint: false,
});
expectVisible(v2WithoutPrivateEndpoint, [
  'apimV2UsePrivateEndpoint',
  'apimV2PublicNetworkAccess',
]);
expectHidden(v2WithoutPrivateEndpoint, ['apimNetworkType', 'apimV2PrivateEndpointName']);

for (const [name, overrides] of [
  ['apicLocation', { enableAPICenter: false }],
  ['redisSkuName', { enableManagedRedis: false }],
  ['existingVnetRG', { useExistingVnet: false }],
  ['vnetAddressPrefix', { useExistingVnet: true }],
  ['apimV2PrivateEndpointName', { apimV2UsePrivateEndpoint: false }],
  ['apimV2UsePrivateEndpoint', { apimSku: 'Developer' }],
]) {
  expectVisible(presentation(overrides, [name]), [name]);
}

// Compatibility fails open when an older repository has a dependent field but
// not the newer controller.
assert.equal(
  parameterVisible('redisCacheName', {
    paramValue: () => undefined,
    pendingFor: () => false,
  }),
  true
);

assert.equal(PARAMETER_VISIBILITY.redisMinimumTlsVersion, undefined);
assert.equal(PARAMETER_VISIBILITY.aiFoundryInstances, undefined);
assert(paramsIn(disabled, 'networking').includes('cosmosDbPublicAccess'));

const untouched = { path: 'other/main.bicepparam', outline: { sections } };
assert.equal(
  deploymentPresentation(untouched, {
    paramValue: () => false,
    pendingFor: () => false,
  }),
  sections
);

const viewSource = readFileSync(new URL('../web/js/paramview.mjs', import.meta.url), 'utf8');
const componentStyles = readFileSync(
  new URL('../web/css/components.css', import.meta.url),
  'utf8'
);
assert.match(viewSource, /isFeatureSection \? ' sec-features' : ''/);
assert.match(
  componentStyles,
  /\.sec-features \.sec-body\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/
);
assert.match(
  componentStyles,
  /@container \(max-width: 64rem\)\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/
);

console.log('Feature grouping, predicates, and conditional visibility checks passed.');
