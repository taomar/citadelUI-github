import { serializeValue } from '../shared/bicepparam/serialize.mjs';
import {
  SOURCE_MAPPING, EXPORT_AREAS, BREAKER_DEFAULTS, MONITOR_DEFAULTS, INSIGHTS_DEFAULTS,
} from '../shared/terraform-contract.mjs';
import { acceptedTerraformDefaults } from '../shared/terraform-export.mjs';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { LocalDirectory } from './_local-directory-fixture.mjs';

// Deliberately synthetic, never deployed. Every value is a literal or a local
// policy fixture reference; no environment/cloud credentials are consulted.
export const FIXTURE_SUBSCRIPTION = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_CLIENT_ID = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_ACCESS_PATH = 'bicep/infra/citadel-access-contracts/contracts/finance.bicepparam';
export const FIXTURE_SECOND_ACCESS_PATH = 'bicep/infra/citadel-access-contracts/contracts/research.bicepparam';
export const FIXTURE_POLICY_PATH = 'bicep/infra/citadel-access-contracts/policies/export-fixture.xml';
export const FIXTURE_POLICY = `<policies>
  <inbound>
    <base />
    <set-variable name="allowed-models" value="gpt-4.1,gpt-5.4-mini" />
    <set-variable name="literal-data" value="\${not_a_terraform_expression} %{not_a_directive} {{named-value}}" />
    <set-header name="x-synthetic-label" exists-action="override"><value>Café export</value></set-header>
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>
`;
const coordinate = { subscriptionId: FIXTURE_SUBSCRIPTION, resourceGroupName: 'rg-export-demo', name: 'apim-export-demo' };
const policyReference = { __expr: 'loadTextContent', raw: "loadTextContent('../policies/export-fixture.xml')" };

export function fixtureValues() {
  return {
    deployment: {
      environmentName: 'export-demo', location: 'eastus2', apicLocation: 'eastus', tags: { purpose: 'synthetic-export', owner: 'example' },
      resourceGroupName: 'rg-export-demo', apimIdentityName: '', usageLogicAppIdentityName: '',
      apimServiceName: 'apim-export-demo', logAnalyticsName: 'law-export-demo',
      apimApplicationInsightsDashboardName: '', funcApplicationInsightsDashboardName: '', foundryApplicationInsightsDashboardName: '',
      apimApplicationInsightsName: '', funcApplicationInsightsName: '', foundryApplicationInsightsName: '',
      eventHubNamespaceName: 'eh-export-demo', cosmosDbAccountName: 'cosmos-export-demo',
      usageProcessingLogicAppName: '', storageAccountName: '', apicServiceName: '', aiFoundryResourceName: '',
      keyVaultName: 'kv-export-demo', redisCacheName: '', useExistingLogAnalytics: false,
      existingLogAnalyticsName: '', existingLogAnalyticsRG: '', existingLogAnalyticsSubscriptionId: '',
      vnetName: 'vnet-export-demo', useExistingVnet: true, existingVnetRG: 'rg-export-network',
      apimSubnetName: 'snet-apim', privateEndpointSubnetName: 'snet-pe', functionAppSubnetName: 'snet-logic',
      agentSubnetName: '', apimNsgName: '', privateEndpointNsgName: '', functionAppNsgName: '', agentSubnetNsgName: '', apimRouteTableName: '',
      vnetAddressPrefix: '10.80.0.0/16', apimSubnetPrefix: '10.80.0.0/24', privateEndpointSubnetPrefix: '10.80.1.0/24',
      functionAppSubnetPrefix: '10.80.2.0/24', agentSubnetPrefix: '', dnsZoneRG: '', dnsSubscriptionId: '',
      existingPrivateDnsZones: {}, storageBlobPrivateEndpointName: '', storageFilePrivateEndpointName: '',
      storageTablePrivateEndpointName: '', storageQueuePrivateEndpointName: '', cosmosDbPrivateEndpointName: '',
      eventHubPrivateEndpointName: '', apimV2PrivateEndpointName: '', aiFoundryPrivateEndpointName: '',
      keyVaultPrivateEndpointName: '', redisPrivateEndpointName: '',
      apimNetworkType: 'Internal', apimV2UsePrivateEndpoint: false, apimV2PublicNetworkAccess: false,
      cosmosDbPublicAccess: 'Disabled', eventHubNetworkAccess: 'Disabled', aiFoundryExternalNetworkAccess: 'Disabled',
      keyVaultExternalNetworkAccess: 'Disabled', useAzureMonitorPrivateLinkScope: true, redisPublicNetworkAccess: 'Disabled',
      createAppInsightsDashboards: false, enableAIModelInference: true, enableDocumentIntelligence: false,
      enableAzureAISearch: false, enableAIGatewayPiiRedaction: false, enableOpenAIRealtime: false, entraAuth: false,
      enableAPICenter: false, enableManagedRedis: false, enableUnifiedAiApi: true,
      azureMonitorLogSettings: structuredClone(MONITOR_DEFAULTS), appInsightsLogSettings: structuredClone(INSIGHTS_DEFAULTS),
      apimSku: 'Developer', apimSkuUnits: 1, eventHubCapacityUnits: 1, cosmosDbRUs: 400,
      logicAppsSkuName: 'WS1', logicAppsSkuCapacityUnits: 1, apicSku: 'Free', keyVaultSkuName: 'standard',
      redisSkuName: 'Balanced_B0', redisSkuCapacity: 2, redisHighAvailability: 'Enabled',
      logicContentShareName: 'synthetic-content', aiSearchInstances: [],
      aiFoundryInstances: [{ name: 'foundry-export-demo', location: 'eastus2', customSubDomainName: 'foundry-export-demo', defaultProjectName: 'export-project', networkInjectionEnabled: false }],
      aiFoundryModelsConfig: [{ name: 'gpt-4.1', publisher: 'OpenAI', version: '2025-04-14', sku: 'GlobalStandard', capacity: 100, aiserviceIndex: 0 }],
      primaryFoundryEmbeddingModelName: '', entraTenantId: '', entraClientId: '', entraAudience: '', entraClientSecret: '',
      foundryNetworkInjectionEnabled: false, redisMinimumTlsVersion: '1.2',
    },
    llm: {
      apim: structuredClone(coordinate),
      apimManagedIdentity: { ...coordinate, name: 'identity-export-demo' },
      llmBackendConfig: [{
        backendId: 'synthetic-east', backendType: 'azure-openai', endpoint: 'https://synthetic-east.openai.azure.com',
        authScheme: 'managedIdentity', authType: 'managed-identity', priority: 1, weight: 100,
        supportedModels: [{
          name: 'gpt-4.1', modelFormat: 'OpenAI', modelVersion: '2025-04-14', sku: 'GlobalStandard',
          capacity: 100, apiVersion: '2024-02-15-preview', timeout: 120,
          inferenceApiVersion: '', retirementDate: '', sessionAwareModel: false,
        }],
      }],
      configureCircuitBreaker: true, circuitBreakerDefaults: structuredClone(BREAKER_DEFAULTS),
      configureSessionAffinity: true, sessionAffinityDefaults: { cookieName: 'SessionAffinity', cookieLifetime: 'PT30M' },
      modelAliases: [{ name: 'assistant', models: ['gpt-4.1'], strategy: 'priority', weights: [] }],
      awsAccessKey: '', awsSecretKey: '', awsRegion: 'us-east-1', anthropicVersion: '2023-06-01', keyVaultName: '',
    },
    access: {
      apim: structuredClone(coordinate), useTargetAzureKeyVault: true,
      keyVault: { ...coordinate, name: 'kv-export-demo' },
      useCase: { businessUnit: 'finance', useCaseName: 'assistant', environment: 'demo' },
      apiNameMapping: { LLM: ['universal-llm-api', 'azure-openai-api'], SEARCH: ['ai-search-api'] },
      services: [{ code: 'LLM', endpointSecretName: 'FINANCE-LLM-ENDPOINT', apiKeySecretName: 'FINANCE-LLM-KEY', policyXml: policyReference }],
      productTerms: 'Synthetic example only. Not deployed.',
      useTargetFoundry: false, foundry: { subscriptionId: FIXTURE_SUBSCRIPTION, resourceGroupName: 'rg-export-demo', accountName: 'foundry-export-demo', projectName: 'export-project' },
      foundryConfig: {}, globalGatewayUrl: '', additionalApimGateways: [], additionalKeyVaults: [], additionalFoundries: [],
      usePrimaryKey: true, keyRotationEnabled: false, rotationKeyOverride: '', rotationKeySeed: '',
    },
  };
}

export function fixtureChoices(values = fixtureValues()) {
  const deployment = {
    ...acceptedTerraformDefaults(),
    'target:subscription_id': FIXTURE_SUBSCRIPTION,
    'target:apim_publisher_email': 'operator@example.invalid',
    'target:apim_publisher_name': 'Synthetic export',
    'target:use_existing_resource_group': true,
  };
  for (const entry of SOURCE_MAPPING.deployment) {
    if ((entry.rule === 'generated' || entry.naming) && values.deployment[entry.source] === '') deployment[`generated:${entry.source}`] = true;
  }
  return { deployment, llm: { 'target:managed_identity_client_id': FIXTURE_CLIENT_ID }, access: {} };
}

export function fixtureFiles(values = fixtureValues()) {
  const files = {};
  const sections = {
    deployment: {
      environmentName: 'BASICS', resourceGroupName: 'RESOURCE NAMES', useExistingLogAnalytics: 'REUSE AND NETWORKING',
      storageBlobPrivateEndpointName: 'PRIVATE ENDPOINT NAMES', apimNetworkType: 'NETWORK ACCESS',
      createAppInsightsDashboards: 'FEATURES', azureMonitorLogSettings: 'LOGGING', apimSku: 'SKUS AND CAPACITY',
      logicContentShareName: 'STORAGE', aiSearchInstances: 'AI SEARCH', aiFoundryInstances: 'AI FOUNDRY',
      entraTenantId: 'ENTRA AUTHENTICATION',
    },
    llm: {
      apim: 'SHARED RESOURCES', llmBackendConfig: 'LLM BACKENDS', configureCircuitBreaker: 'CIRCUIT BREAKERS',
      configureSessionAffinity: 'SESSION AFFINITY', modelAliases: 'MODEL ALIASES',
    },
    access: {
      apim: 'SHARED RESOURCES', useCase: 'USE CASE AND SERVICES', useTargetFoundry: 'FOUNDRY',
      globalGatewayUrl: 'RESILIENCY', usePrimaryKey: 'KEY ROTATION',
    },
  };
  for (const area of EXPORT_AREAS) {
    const path = area.path || FIXTURE_ACCESS_PATH;
    const declarations = SOURCE_MAPPING[area.id];
    const count = { deployment: 98, llm: 8, access: 17 }[area.id];
    const using = area.id === 'access' ? '../main.bicep' : './main.bicep';
    const lines = [`// Synthetic export fixture, never deployed.`, `using '${using}'`, ''];
    for (const entry of declarations.slice(0, count)) {
      const section = sections[area.id][entry.source];
      if (section) lines.push(`// ============================================================================`, `// ${section}`, `// ============================================================================`);
      lines.push(`param ${entry.source} = ${serializeValue(values[area.id][entry.source])}`, '');
    }
    files[path] = lines.join('\n');
    const templatePath = area.id === 'access' ? 'bicep/infra/citadel-access-contracts/main.bicep' : path.replace(/\.bicepparam$/, '.bicep');
    files[templatePath] = declarations.map((entry) => {
      const value = entry.source === 'rotationKeySeed' ? 'newGuid()' : serializeValue(values[area.id][entry.source]);
      return `${entry.rule === 'secret' ? '@secure()\n' : ''}param ${entry.source} ${entry.type} = ${value}`;
    }).join('\n\n');
  }
  files['bicep/infra/citadel-access-contracts/main.bicep'] += `

var defaultProductPolicyXml = loadTextContent('./policies/default-ai-product-policy.xml')
var defaultMultiProductPolicyXml = loadTextContent('./policies/default-multi-product-policy.xml')
`;
  files[FIXTURE_POLICY_PATH] = FIXTURE_POLICY;
  files['bicep/infra/citadel-access-contracts/policies/default-ai-product-policy.xml'] = FIXTURE_POLICY;
  files['bicep/infra/citadel-access-contracts/policies/default-multi-product-policy.xml'] = FIXTURE_POLICY;
  files[FIXTURE_SECOND_ACCESS_PATH] = files[FIXTURE_ACCESS_PATH].replace("businessUnit: 'finance'", "businessUnit: 'research'");
  files['bicep/infra/citadel-access-contracts/main.bicepparam'] = files[FIXTURE_ACCESS_PATH]
    .replace("using '../main.bicep'", "using './main.bicep'")
    .replace("loadTextContent('../policies/export-fixture.xml')", "loadTextContent('./policies/export-fixture.xml')");
  return files;
}

export function exportFixture(files = fixtureFiles()) {
  const root = new LocalDirectory('synthetic-terraform-export');
  for (const [path, text] of Object.entries(files)) root.put(path, text);
  const provider = new BrowserDirectoryProvider(root);
  const context = {
    projectId: 'synthetic-project', environment: {
      id: 'synthetic-environment', name: 'Export demonstration',
      source: { type: 'local', folderName: root.name, localPath: null },
    }, provider,
  };
  return { root, provider, context, registry: { countDrafts: async () => 0 } };
}
