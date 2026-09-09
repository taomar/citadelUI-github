/**
 * Property contract, not a name-conversion algorithm. Evidence paths refer to
 * the immutable upstream revision below; no runtime upstream download occurs.
 * Derived schema/default facts: Copyright (c) Microsoft Corporation, MIT.
 * See terraform-NOTICE.txt for the upstream license.
 */
export const TERRAFORM_CONTRACT = Object.freeze({
  version: 'citadel-terraform-export-v1',
  repository: 'Azure/terraform-ai-gateway-landing-zone',
  revision: 'b54f121b7df912da61cb0302a63b9f870841ac2c',
  sourceRevision: '03f4d4293550fcef3ec852eeeacd67355fc66557',
});

export const EXPORT_AREAS = Object.freeze([
  { id: 'deployment', label: 'Azure Deployment', path: 'bicep/infra/main.bicepparam' },
  { id: 'llm', label: 'LLM Onboarding', path: 'bicep/infra/llm-backend-onboarding/main.bicepparam' },
  { id: 'access', label: 'Access Contracts', path: null },
]);

const d = (source, target, type, service, extra = {}) => ({ source, target: [target], type, service, ...extra });
const x = (source, targets, type, service, rule, extra = {}) => ({ source, target: targets, type, service, rule, ...extra });
const generated = (source, service, property, gate, extra = {}) => x(source, [property], 'string', service, 'generated', {
  evidence: service === 'Identity' ? 'main.tf' : 'main.tf; modules/' + ({ Networking: 'networking', Monitoring: 'monitoring', 'Logic App': 'logic-app', 'API Center': 'apic', Redis: 'redis', Foundry: 'foundry', 'Key Vault': 'security', Cosmos: 'cosmosdb', 'Event Hub': 'eventhub', APIM: 'apim' }[service]) + '/main.tf',
  gate,
  ...extra,
});

export const MAIN_MAPPING = [
  d('environmentName', 'environment_name', 'string', 'Basics', { environment: true }),
  d('location', 'location', 'string', 'Basics'),
  d('apicLocation', 'apic_location', 'string', 'API Center', { gate: ['enableAPICenter', true] }),
  d('tags', 'tags', 'object', 'Basics', { shape: 'string-map' }),
  d('resourceGroupName', 'resource_group_name', 'string', 'Basics', { naming: true }),
  generated('apimIdentityName', 'Identity', 'azurerm_user_assigned_identity.apim.name'),
  generated('usageLogicAppIdentityName', 'Identity', 'azurerm_user_assigned_identity.usage.name'),
  d('apimServiceName', 'apim_service_name', 'string', 'APIM', { naming: true }),
  d('logAnalyticsName', 'log_analytics_name', 'string', 'Monitoring', { naming: true, gate: ['useExistingLogAnalytics', false] }),
  generated('apimApplicationInsightsDashboardName', 'Monitoring', 'azurerm_portal_dashboard.app_insights["apim"].name', ['createAppInsightsDashboards', true]),
  generated('funcApplicationInsightsDashboardName', 'Monitoring', 'azurerm_portal_dashboard.app_insights["logic"].name', ['createAppInsightsDashboards', true]),
  generated('foundryApplicationInsightsDashboardName', 'Monitoring', 'azurerm_portal_dashboard.app_insights["foundry"].name', ['createAppInsightsDashboards', true]),
  generated('apimApplicationInsightsName', 'Monitoring', 'azurerm_application_insights.apim.name'),
  generated('funcApplicationInsightsName', 'Monitoring', 'azurerm_application_insights.logic_app.name'),
  generated('foundryApplicationInsightsName', 'Monitoring', 'azurerm_application_insights.foundry.name'),
  d('eventHubNamespaceName', 'eventhub_namespace_name', 'string', 'Event Hub', { naming: true }),
  d('cosmosDbAccountName', 'cosmos_db_account_name', 'string', 'Cosmos', { naming: true }),
  generated('usageProcessingLogicAppName', 'Logic App', 'azurerm_logic_app_standard.usage_ingestion.name'),
  generated('storageAccountName', 'Logic App', 'azurerm_storage_account.logic_app.name'),
  generated('apicServiceName', 'API Center', 'azapi_resource.api_center.name', ['enableAPICenter', true]),
  x('aiFoundryResourceName', ['ai_foundry_instances[*].name'], 'string', 'Foundry', 'foundry-name'),
  d('keyVaultName', 'key_vault_name', 'string', 'Key Vault', { naming: true }),
  generated('redisCacheName', 'Redis', 'module.redis.name', ['enableManagedRedis', true]),
  d('useExistingLogAnalytics', 'use_existing_log_analytics', 'bool', 'Monitoring'),
  x('existingLogAnalyticsName', ['existing_log_analytics_id'], 'string', 'Monitoring', 'workspace-id', { gate: ['useExistingLogAnalytics', true] }),
  x('existingLogAnalyticsRG', ['existing_log_analytics_id'], 'string', 'Monitoring', 'workspace-id', { gate: ['useExistingLogAnalytics', true] }),
  x('existingLogAnalyticsSubscriptionId', ['existing_log_analytics_subscription_id', 'existing_log_analytics_id'], 'string', 'Monitoring', 'workspace-id', { gate: ['useExistingLogAnalytics', true] }),
  d('vnetName', 'vnet_name', 'string', 'Networking', { naming: true }),
  d('useExistingVnet', 'use_existing_vnet', 'bool', 'Networking'),
  d('existingVnetRG', 'existing_vnet_rg', 'string', 'Networking', { gate: ['useExistingVnet', true] }),
  d('apimSubnetName', 'apim_subnet_name', 'string', 'Networking', { subnet: true }),
  d('privateEndpointSubnetName', 'private_endpoint_subnet_name', 'string', 'Networking', { subnet: true }),
  d('functionAppSubnetName', 'logic_app_subnet_name', 'string', 'Networking', { subnet: true }),
  d('agentSubnetName', 'agent_subnet_name', 'string', 'Networking', { gate: ['foundryNetworkInjectionEnabled', true], subnet: true }),
  generated('apimNsgName', 'Networking', 'azurerm_network_security_group.apim.name', ['useExistingVnet', false]),
  x('privateEndpointNsgName', ['private endpoint NSG + subnet association (not implemented)'], 'string', 'Networking', 'missing-nsg', { gate: ['useExistingVnet', false] }),
  x('functionAppNsgName', ['Logic App NSG + subnet association (not implemented)'], 'string', 'Networking', 'missing-nsg', { gate: ['useExistingVnet', false] }),
  generated('agentSubnetNsgName', 'Networking', 'azurerm_network_security_group.agent.name', ['foundryNetworkInjectionEnabled', true], { newNetworkOnly: true }),
  generated('apimRouteTableName', 'Networking', 'azurerm_route_table.apim.name', ['useExistingVnet', false]),
  d('vnetAddressPrefix', 'vnet_address_prefix', 'string', 'Networking', { gate: ['useExistingVnet', false] }),
  d('apimSubnetPrefix', 'apim_subnet_prefix', 'string', 'Networking', { gate: ['useExistingVnet', false] }),
  d('privateEndpointSubnetPrefix', 'private_endpoint_subnet_prefix', 'string', 'Networking', { gate: ['useExistingVnet', false] }),
  d('functionAppSubnetPrefix', 'logic_app_subnet_prefix', 'string', 'Networking', { gate: ['useExistingVnet', false] }),
  d('agentSubnetPrefix', 'agent_subnet_prefix', 'string', 'Networking', { gate: ['foundryNetworkInjectionEnabled', true], newNetworkOnly: true }),
  d('dnsZoneRG', 'dns_zone_rg', 'string', 'Networking'),
  d('dnsSubscriptionId', 'dns_subscription_id', 'string', 'Networking'),
  d('existingPrivateDnsZones', 'existing_private_dns_zones', 'object', 'Networking', { shape: 'string-map' }),
  generated('storageBlobPrivateEndpointName', 'Logic App', 'azurerm_private_endpoint.storage_blob.name'),
  generated('storageFilePrivateEndpointName', 'Logic App', 'azurerm_private_endpoint.storage_file.name'),
  generated('storageTablePrivateEndpointName', 'Logic App', 'azurerm_private_endpoint.storage_table.name'),
  generated('storageQueuePrivateEndpointName', 'Logic App', 'azurerm_private_endpoint.storage_queue.name'),
  generated('cosmosDbPrivateEndpointName', 'Cosmos', 'azurerm_private_endpoint.cosmos.name'),
  generated('eventHubPrivateEndpointName', 'Event Hub', 'azurerm_private_endpoint.eventhub.name'),
  generated('apimV2PrivateEndpointName', 'APIM', 'azurerm_private_endpoint.apim.name', ['apimV2UsePrivateEndpoint', true], { apimGeneration: 'v2' }),
  generated('aiFoundryPrivateEndpointName', 'Foundry', 'azurerm_private_endpoint.foundry[*].name'),
  generated('keyVaultPrivateEndpointName', 'Key Vault', 'azurerm_private_endpoint.key_vault.name'),
  generated('redisPrivateEndpointName', 'Redis', 'azurerm_private_endpoint.redis.name', ['enableManagedRedis', true]),
  d('apimNetworkType', 'apim_network_type', 'string', 'APIM', { enum: ['External', 'Internal'], apimGeneration: 'classic' }),
  d('apimV2UsePrivateEndpoint', 'apim_v2_use_private_endpoint', 'bool', 'APIM', { apimGeneration: 'v2' }),
  d('apimV2PublicNetworkAccess', 'apim_v2_public_network_access', 'bool', 'APIM', { apimGeneration: 'v2' }),
  d('cosmosDbPublicAccess', 'cosmos_db_public_access', 'string', 'Cosmos', { enum: ['Enabled', 'Disabled'] }),
  d('eventHubNetworkAccess', 'eventhub_network_access', 'string', 'Event Hub', { enum: ['Enabled', 'Disabled'] }),
  x('aiFoundryExternalNetworkAccess', ['ai_foundry_external_access'], 'string', 'Foundry', 'enabled-bool', { enum: ['Enabled', 'Disabled'] }),
  x('keyVaultExternalNetworkAccess', ['kv_public_network_access_enabled', 'network_acl_default_action'], 'string', 'Key Vault', 'vault-network', { enum: ['Enabled', 'Disabled'] }),
  d('useAzureMonitorPrivateLinkScope', 'use_azure_monitor_private_link_scope', 'bool', 'Monitoring'),
  d('redisPublicNetworkAccess', 'redis_public_network_access', 'string', 'Redis', { gate: ['enableManagedRedis', true], enum: ['Enabled', 'Disabled'] }),
  d('createAppInsightsDashboards', 'create_app_insights_dashboards', 'bool', 'Monitoring'),
  d('enableAIModelInference', 'enable_ai_model_inference', 'bool', 'APIM'),
  d('enableDocumentIntelligence', 'enable_document_intelligence', 'bool', 'APIM'),
  d('enableAzureAISearch', 'enable_azure_ai_search', 'bool', 'AI Search'),
  d('enableAIGatewayPiiRedaction', 'enable_pii_anonymization', 'bool', 'APIM'),
  d('enableOpenAIRealtime', 'enable_openai_realtime', 'bool', 'APIM'),
  d('entraAuth', 'entra_auth_enabled', 'bool', 'Identity'),
  d('enableAPICenter', 'enable_api_center', 'bool', 'API Center'),
  x('enableManagedRedis', ['enable_redis_cache', 'enable_embeddings_backend'], 'bool', 'Redis', 'redis-toggle'),
  d('enableUnifiedAiApi', 'enable_unified_ai_api', 'bool', 'APIM'),
  x('azureMonitorLogSettings', ['module.apim.*.azure_monitor_log_settings'], 'object', 'Monitoring', 'monitor-logs'),
  x('appInsightsLogSettings', ['module.apim.*.app_insights_log_settings'], 'object', 'Monitoring', 'insights-logs'),
  d('apimSku', 'apim_sku', 'string', 'APIM', { enum: ['Developer', 'StandardV2', 'Premium', 'PremiumV2'] }),
  d('apimSkuUnits', 'apim_sku_units', 'int', 'APIM', { min: 1 }),
  d('eventHubCapacityUnits', 'eventhub_capacity_units', 'int', 'Event Hub', { min: 1 }),
  d('cosmosDbRUs', 'cosmos_db_rus', 'int', 'Cosmos', { min: 400 }),
  d('logicAppsSkuName', 'logic_app_sku_size', 'string', 'Logic App', { enum: ['WS1', 'WS2', 'WS3'] }),
  x('logicAppsSkuCapacityUnits', ['azurerm_logic_app_standard.usage_ingestion.site_config.elastic_instance_minimum'], 'int', 'Logic App', 'logic-capacity'),
  d('apicSku', 'api_center_sku', 'string', 'API Center', { gate: ['enableAPICenter', true], enum: ['Free', 'Standard'] }),
  d('keyVaultSkuName', 'key_vault_sku', 'string', 'Key Vault', { enum: ['standard', 'premium'] }),
  d('redisSkuName', 'redis_sku_name', 'string', 'Redis', { gate: ['enableManagedRedis', true] }),
  d('redisSkuCapacity', 'redis_sku_capacity', 'int', 'Redis', { gate: ['enableManagedRedis', true], min: 1 }),
  x('redisHighAvailability', ['module.redis.azapi_resource.redis.body.properties.highAvailability (not wired)'], 'string', 'Redis', 'redis-ha', { gate: ['enableManagedRedis', true] }),
  d('logicContentShareName', 'logic_content_share_name', 'string', 'Logic App'),
  x('aiSearchInstances', ['ai_search_instances'], 'array', 'AI Search', 'search', { gate: ['enableAzureAISearch', true] }),
  x('aiFoundryInstances', ['ai_foundry_instances'], 'array', 'Foundry', 'foundries'),
  x('aiFoundryModelsConfig', ['ai_foundry_models'], 'array', 'Foundry', 'foundry-models'),
  x('primaryFoundryEmbeddingModelName', ['embeddings_backend_url'], 'string', 'Redis', 'embeddings', { gate: ['enableManagedRedis', true] }),
  d('entraTenantId', 'entra_tenant_id', 'string', 'Identity', { gate: ['entraAuth', true] }),
  d('entraClientId', 'entra_client_id', 'string', 'Identity', { gate: ['entraAuth', true] }),
  d('entraAudience', 'entra_audience', 'string', 'Identity', { gate: ['entraAuth', true] }),
  x('entraClientSecret', ['entra_client_secret (unused; supplied-secret persistence not wired)'], 'string', 'Identity', 'secret', { gate: ['entraAuth', true] }),
  x('foundryNetworkInjectionEnabled', ['foundry_network_injection_enabled', 'enable_agent_subnet'], 'bool', 'Foundry', 'injection'),
  d('redisMinimumTlsVersion', 'redis_minimum_tls_version', 'string', 'Redis', { gate: ['enableManagedRedis', true], enum: ['1.2'] }),
];

export const LLM_MAPPING = [
  x('apim', ['subscription_id', 'resource_group_name', 'apim_name'], 'object', 'APIM', 'llm-apim'),
  x('apimManagedIdentity', ['managed_identity_client_id'], 'object', 'Managed identity', 'client-id'),
  x('llmBackendConfig', ['llm_backend_config'], 'array', 'Backends', 'backends'),
  d('configureCircuitBreaker', 'configure_circuit_breaker', 'bool', 'Circuit breaker'),
  x('circuitBreakerDefaults', ['azapi_resource.llm_backend.body.properties.circuitBreaker.rules'], 'object', 'Circuit breaker', 'breaker'),
  x('configureSessionAffinity', ['APIM pool.sessionAffinity (not wired)'], 'bool', 'Session affinity', 'affinity'),
  x('sessionAffinityDefaults', ['APIM pool.sessionAffinity (not wired)'], 'object', 'Session affinity', 'affinity'),
  x('modelAliases', ['model_aliases'], 'array', 'Model aliases', 'aliases'),
  x('awsAccessKey', ['aws_access_key'], 'string', 'Backends', 'secret'),
  x('awsSecretKey', ['aws_secret_key'], 'string', 'Backends', 'secret'),
  d('awsRegion', 'aws_region', 'string', 'Backends'),
  x('anthropicVersion', ['anthropic-version header (not wired)'], 'string', 'Backends', 'anthropic'),
  x('keyVaultName', ['key_vault_name (unused)'], 'string', 'Backends', 'llm-vault'),
];

export const ACCESS_MAPPING = [
  x('apim', ['apim'], 'object', 'APIM', 'coordinates'),
  d('useTargetAzureKeyVault', 'use_target_key_vault', 'bool', 'Key Vault'),
  x('keyVault', ['key_vault'], 'object', 'Key Vault', 'coordinates', { gate: ['useTargetAzureKeyVault', true] }),
  x('useCase', ['use_case'], 'object', 'Use case', 'use-case'),
  d('apiNameMapping', 'api_name_mapping', 'object', 'Services', { shape: 'api-map' }),
  x('services', ['services'], 'array', 'Services', 'services'),
  d('productTerms', 'product_terms', 'string', 'Use case'),
  d('useTargetFoundry', 'use_target_foundry', 'bool', 'Foundry'),
  x('foundry', ['foundry'], 'object', 'Foundry', 'foundry-coordinates', { gate: ['useTargetFoundry', true] }),
  x('foundryConfig', ['foundry_config'], 'object', 'Foundry', 'foundry-config', { gate: ['useTargetFoundry', true] }),
  x('globalGatewayUrl', ['gateway_url (fixed primary APIM)'], 'string', 'Resiliency', 'empty-only'),
  x('additionalApimGateways', ['APIM product/subscription replication (not wired)'], 'array', 'Resiliency', 'empty-only'),
  x('additionalKeyVaults', ['Key Vault replication (not wired)'], 'array', 'Resiliency', 'empty-only'),
  x('additionalFoundries', ['Foundry replication (not wired)'], 'array', 'Resiliency', 'empty-only'),
  x('usePrimaryKey', ['azurerm_api_management_subscription.service.primary_key'], 'bool', 'Key rotation', 'primary-key'),
  x('keyRotationEnabled', ['APIM key rotation (not implemented)'], 'bool', 'Key rotation', 'rotation'),
  x('rotationKeyOverride', ['APIM key rotation (not implemented)'], 'string', 'Key rotation', 'secret', { gate: ['keyRotationEnabled', true] }),
  x('rotationKeySeed', ['APIM key rotation seed (not implemented)'], 'string', 'Key rotation', 'rotation-seed'),
];

export const SOURCE_MAPPING = Object.freeze({ deployment: MAIN_MAPPING, llm: LLM_MAPPING, access: ACCESS_MAPPING });

export const BREAKER_DEFAULTS = Object.freeze({
  failureCount: 3, failureInterval: 'PT5M', tripDuration: 'PT1M', acceptRetryAfter: true,
  errorReasons: ['Server errors'], statusCodeRanges: [{ min: 429, max: 429 }, { min: 500, max: 503 }],
});
export const MONITOR_DEFAULTS = Object.freeze({
  frontend: { request: { headers: [], body: { bytes: 0 } }, response: { headers: [], body: { bytes: 0 } } },
  backend: { request: { headers: [], body: { bytes: 0 } }, response: { headers: [], body: { bytes: 0 } } },
  largeLanguageModel: { logs: 'enabled', requests: { messages: 'all', maxSizeInBytes: 262144 }, responses: { messages: 'all', maxSizeInBytes: 262144 } },
});
export const INSIGHTS_DEFAULTS = Object.freeze({
  headers: ['Content-type', 'User-agent', 'x-ms-region', 'x-ratelimit-remaining-tokens', 'x-ratelimit-remaining-requests'],
  body: { bytes: 0 },
});

export const COORDINATE_FIELDS = Object.freeze({ subscriptionId: 'subscription_id', resourceGroupName: 'resource_group_name', name: 'name' });
export const USE_CASE_FIELDS = Object.freeze({ businessUnit: 'business_unit', useCaseName: 'use_case_name', environment: 'environment' });
export const FOUNDRY_COORDINATES = Object.freeze({ subscriptionId: 'subscription_id', resourceGroupName: 'resource_group_name', accountName: 'account_name', projectName: 'project_name' });
export const FOUNDRY_CONFIG_FIELDS = Object.freeze({
  connectionNamePrefix: 'connection_name_prefix', connectionCategory: 'connection_category',
  deploymentInPath: 'deployment_in_path', isSharedToAll: 'is_shared_to_all',
  inferenceAPIVersion: 'inference_api_version', deploymentAPIVersion: 'deployment_api_version',
  staticModels: 'static_models', listModelsEndpoint: 'list_models_endpoint', getModelEndpoint: 'get_model_endpoint',
  deploymentProvider: 'deployment_provider', customHeaders: 'custom_headers', authConfig: 'auth_config',
});
export const MODEL_DEFAULTS = Object.freeze({
  sku: 'Standard', capacity: 100, modelFormat: 'OpenAI', modelVersion: '1',
  apiVersion: '2024-02-15-preview', timeout: 120, inferenceApiVersion: '', retirementDate: '',
});

const input = (name, service, value, reason, extra = {}) => ({
  name, service, default: value, type: Array.isArray(value) ? 'array' : value === null ? 'object' :
    ({ boolean: 'bool', number: 'int', object: 'object', string: 'string' })[typeof value],
  reason, ...extra,
});

// Every consumed target-only default is a visible decision, not an implicit
// fallback. Sensitive defaults are reported but never emitted.
export const MAIN_INPUTS = [
  input('subscription_id', 'Basics', '', 'Subscription context is not a Bicep parameter. Enter it explicitly.', { required: true, uuid: true }),
  input('purge_soft_delete_on_destroy', 'Basics', false, 'Terraform lifecycle choice; export never runs destroy.'),
  input('use_existing_resource_group', 'Basics', false, 'Choose existing resource-group ownership or creation; no state is imported.'),
  input('soft_delete_retention_days', 'Key Vault', 7, 'Key Vault retention default.', { min: 1, max: 90 }),
  input('purge_protection_enabled', 'Key Vault', true, 'Key Vault purge protection default.'),
  input('rbac_authorization_enabled', 'Key Vault', true, 'Key Vault uses RBAC authorization.'),
  input('kv_deployer_ip_rules', 'Key Vault', [], 'No bootstrap IP allowlist; no IP is discovered.', { fixed: true }),
  input('kv_auto_detect_deployer_ip', 'Key Vault', false, 'Automatic public-IP discovery is disabled for this experiment.', { fixed: true }),
  input('create_apim_gateway_key_secret', 'Key Vault', false, 'Do not create a placeholder gateway key.', { fixed: true }),
  input('apim_publisher_email', 'APIM', 'admin@contoso.com', 'Upstream example publisher email is not a source value; supply or explicitly accept it.'),
  input('apim_publisher_name', 'APIM', 'AI Citadel Admin', 'Publisher display name is target-only.'),
  input('eventhub_partition_count', 'Event Hub', 4, 'Explicit target Event Hub partition count.', { min: 1, max: 32 }),
  input('eventhub_disaster_recovery_config', 'Event Hub', null, 'No extra Event Hub disaster-recovery pairing.', { fixed: true }),
  input('logic_app_sku_tier', 'Logic App', 'WorkflowStandard', 'Workflow Standard tier.', { fixed: true }),
  input('enable_pii_redaction', 'APIM', true, 'Expose the primary Foundry endpoint for PII; separate from gateway anonymization.'),
  input('enable_content_safety', 'APIM', true, 'Expose the primary Foundry endpoint for content safety.'),
  input('llm_backend_config', 'Foundry', [], 'Keep Foundry-derived backends; no full override of source models.', { fixed: true }),
  input('extra_llm_backends', 'Foundry', [], 'Do not append target-only backends.', { fixed: true }),
  input('apim_log_verbosity', 'Monitoring', 'information', 'Coarse target logging; does not wire rich source diagnostic objects.', { enum: ['verbose', 'information', 'error'] }),
  input('apim_log_body_bytes', 'Monitoring', 8192, 'Coarse target body logging, independent of rich per-API defaults.', { min: 0, max: 8192 }),
  input('inference_api_type', 'APIM', 'OpenAIV1', 'Target inference API contract.', { enum: ['AzureOpenAI', 'AzureAI', 'OpenAI', 'OpenAIV1'] }),
  input('is_mcp_sample_deployed', 'APIM', false, 'No target-only MCP sample.', { fixed: true }),
  input('enable_logic_app_code_deploy', 'Logic App', false, 'No target code publication command; this ZIP contains values only.', { fixed: true }),
  input('logic_app_code_source_path', 'Logic App', '', 'Code deployment is disabled; no source path is read.', { fixed: true }),
  input('configure_circuit_breaker', 'APIM', true, 'Use the target fixed breaker behavior for derived Main backends.'),
  input('ms_learn_mcp_backend_url', 'APIM', 'https://learn.microsoft.com/api/mcp', 'Inactive because the MCP sample is disabled.', { fixed: true }),
  input('enable_jwt_auth', 'Identity', false, 'Separate JWT named-value workflow, not the source entraAuth flag.', { fixed: true }),
  input('jwt_tenant_id', 'Identity', '', 'Inactive target-only JWT named value.', { fixed: true }),
  input('jwt_app_registration_id', 'Identity', '', 'Inactive target-only JWT named value.', { fixed: true }),
  input('pii_service_key', 'APIM', '', 'Sensitive upstream key placeholder is not exported. Managed-identity wiring remains in the target.', { omit: true, fixed: true }),
  input('azure_login_endpoint', 'Identity', 'https://login.microsoftonline.com/', 'Explicit Azure public-cloud login endpoint.', { fixed: true }),
  input('enable_entra_id_setup', 'Identity', false, 'No target-only app registration or generated client secret.', { fixed: true }),
  input('entra_app_display_name_prefix', 'Identity', 'ai-citadel-gateway', 'Inactive because Entra setup is disabled.', { fixed: true }),
  input('entra_client_secret_name', 'Identity', 'ENTRA-APP-CLIENT-SECRET', 'Secret name only; inactive because Entra setup is disabled.', { fixed: true }),
  input('entra_client_secret_rotation_days', 'Identity', 730, 'Inactive because Entra setup is disabled.', { fixed: true }),
  input('enable_api_center_onboarding', 'API Center', false, 'No target-only API Center registration.', { fixed: true }),
  input('enable_foundry_apim_connection', 'Foundry', false, 'No target-only Main Foundry/APIM connection.', { fixed: true }),
];
export const MAIN_UNUSED = [
  'language_service_sku', 'content_safety_sku', 'enable_ai_gateway_pii_redaction',
  'azure_monitor_log_settings', 'app_insights_log_settings',
  'primary_foundry_embedding_model_name', 'entra_client_secret',
];

const obj = (properties, optional = []) => ({ kind: 'object', properties, optional });
const list = (item) => ({ kind: 'list', item });
const map = (item) => ({ kind: 'map', item });
const model = obj({ name: 'string', ...Object.fromEntries(Object.entries(MODEL_DEFAULTS).map(([key, value]) => [key, typeof value === 'number' ? 'number' : 'string'])) }, Object.keys(MODEL_DEFAULTS));
const backend = (standalone) => obj({
  backend_id: 'string', backend_type: 'string', endpoint: 'string', auth_scheme: 'string', auth_type: 'string',
  auth_config: obj({ named_value_key: 'string', ...(standalone ? { key_vault_secret_uri: 'string', secret_value: 'string' } : {}) }, standalone ? ['named_value_key', 'key_vault_secret_uri', 'secret_value'] : ['named_value_key']),
  supported_models: list(model), priority: 'number', weight: 'number',
}, ['auth_type', 'auth_config', 'priority', 'weight', ...(standalone ? ['auth_scheme'] : [])]);
const coordinates = obj({ subscription_id: 'string', resource_group_name: 'string', name: 'string' });
export const TARGET_SHAPES = {
  deployment: {
    ...Object.fromEntries(MAIN_MAPPING.filter((entry) => !entry.rule).map((entry) =>
      [entry.target[0], ({ string: 'string', bool: 'bool', int: 'number', object: map('string') })[entry.type]])),
    ...Object.fromEntries(MAIN_INPUTS.map((entry) => [entry.name,
      entry.type === 'bool' ? 'bool' : entry.type === 'int' ? 'number' :
        entry.type === 'array' ? list('string') : entry.type === 'object' ? 'any' : 'string'])),
    ...Object.fromEntries(MAIN_UNUSED.map((name) => [name, 'any'])),
    existing_log_analytics_id: 'string', existing_log_analytics_subscription_id: 'string',
    ai_foundry_external_access: 'bool', kv_public_network_access_enabled: 'bool', network_acl_default_action: 'string',
    enable_redis_cache: 'bool', enable_embeddings_backend: 'bool', embeddings_backend_url: 'string',
    foundry_network_injection_enabled: 'bool', enable_agent_subnet: 'bool',
    ai_search_instances: list(obj({ name: 'string', endpoint: 'string' })),
    ai_foundry_instances: list(obj({
      name: 'string', location: 'string', custom_subdomain: 'string', default_project_name: 'string', network_injection_enabled: 'bool',
    }, ['name', 'custom_subdomain', 'default_project_name', 'network_injection_enabled'])),
    ai_foundry_models: list(obj({
      name: 'string', publisher: 'string', version: 'string', sku: 'string', capacity: 'number', ai_service_index: 'number',
    }, ['publisher', 'sku', 'capacity', 'ai_service_index'])),
    llm_backend_config: list(backend(false)), extra_llm_backends: list(backend(false)),
    eventhub_disaster_recovery_config: { nullable: true, ...obj({ partner_namespace_id: 'string', alias: 'string' }, ['alias']) },
  },
  llm: {
    subscription_id: 'string', resource_group_name: 'string', apim_name: 'string', managed_identity_client_id: 'string',
    llm_backend_config: list(backend(true)), configure_circuit_breaker: 'bool',
    model_aliases: list(obj({ name: 'string', models: list('string'), strategy: 'string', weights: list('number') }, ['strategy', 'weights'])),
    aws_access_key: 'string', aws_secret_key: 'string', aws_region: 'string', key_vault_name: 'string',
  },
  access: {
    apim: coordinates, use_case: obj({ business_unit: 'string', use_case_name: 'string', environment: 'string' }),
    api_name_mapping: map(list('string')),
    services: list(obj({ code: 'string', endpoint_secret_name: 'string', api_key_secret_name: 'string', policy_xml: 'string' }, ['policy_xml'])),
    product_terms: 'string', use_target_key_vault: 'bool', key_vault: coordinates, use_target_foundry: 'bool',
    foundry: obj({ subscription_id: 'string', resource_group_name: 'string', account_name: 'string', project_name: 'string' }),
    foundry_config: obj({
      connection_name_prefix: 'string', connection_category: 'string', deployment_in_path: 'string', is_shared_to_all: 'bool',
      inference_api_version: 'string', deployment_api_version: 'string', static_models: list('any'),
      list_models_endpoint: 'string', get_model_endpoint: 'string', deployment_provider: 'string',
      custom_headers: map('string'), auth_config: map('string'),
    }, Object.values(FOUNDRY_CONFIG_FIELDS)),
  },
};

export const POLICY_FRAGMENTS = Object.freeze([
  'set-backend-authorization', 'set-target-backend-pool', 'set-llm-usage', 'set-llm-requested-model',
  'validate-model-access', 'ai-usage', 'raise-throttling-events', 'throttling-events', 'security-handler',
  'entra-auth', 'aad-auth', 'aad-auth-custom', 'ai-foundry-deployments', 'llm-usage', 'openai-usage',
  'openai-usage-streaming', 'ai-foundry-compatibility', 'set-response-headers', 'responses-id-security',
  'responses-id-cache-store', 'strip-backend-headers', 'pii-anonymization', 'pii-deanonymization',
  'pii-state-saving', 'central-cache-manager', 'request-processor', 'path-builder',
  'set-backend-pools', 'get-available-models', 'metadata-config', 'resolve-model-alias',
]);

export function targetShapeProblems(value, shape, path = '') {
  if (shape === 'any') return [];
  if (value === null) return shape?.nullable ? [] : [`${path} cannot be null.`];
  if (typeof shape === 'string') {
    const valid = shape === 'bool' ? typeof value === 'boolean' :
      shape === 'number' ? Number.isSafeInteger(value) : typeof value === 'string';
    return valid ? [] : [`${path} requires ${shape}.`];
  }
  if (shape?.kind === 'list') {
    return Array.isArray(value) ? value.flatMap((item, index) => targetShapeProblems(item, shape.item, `${path}[${index}]`)) : [`${path} requires a list.`];
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' || !shape) return [`${path} requires an object.`];
  if (shape.kind === 'map') return Object.entries(value).flatMap(([key, item]) => targetShapeProblems(item, shape.item, `${path}.${key}`));
  return [
    ...Object.keys(value).filter((key) => !Object.hasOwn(shape.properties, key)).map((key) => `${path}.${key} is not a declared target property.`),
    ...Object.entries(shape.properties).flatMap(([key, child]) => {
      if (!Object.hasOwn(value, key)) return shape.optional.includes(key) ? [] : [`${path}.${key} is required.`];
      return targetShapeProblems(value[key], child, `${path}.${key}`);
    }),
  ];
}

export function targetVariablesProblems(area, values) {
  const shapes = TARGET_SHAPES[area];
  return Object.entries(values).flatMap(([name, value]) => Object.hasOwn(shapes, name)
    ? targetShapeProblems(value, shapes[name], name) : [`${name} is not a declared target variable.`]);
}
