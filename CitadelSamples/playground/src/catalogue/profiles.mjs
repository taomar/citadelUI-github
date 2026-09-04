/**
 * Shared profiles.
 *
 * Cell 2 of the notebook is one long block of module-level variables that every
 * later cell reads. Rather than turn it into a runnable recipe, it becomes five
 * profiles the user fills in once. Each field declares how it is sourced:
 *
 *   required        must be typed before any dependent plan is generated
 *   conditional     required only when `requiredWhen` holds
 *   derived         produced by an earlier recipe; typeable as an override
 *   sample-default  the notebook hard-codes it; pre-filled and editable
 *   secret          memory only, never persisted, previewed or copied
 */

export const LINKS = Object.freeze({
  azAccountShow: {
    label: 'az account show',
    href: 'https://learn.microsoft.com/en-us/cli/azure/account#az-account-show',
  },
  azAccountSet: {
    label: 'az account set',
    href: 'https://learn.microsoft.com/en-us/cli/azure/account#az-account-set',
  },
  azLogin: { label: 'Sign in with the Azure CLI', href: 'https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli' },
  azApimShow: { label: 'az apim show', href: 'https://learn.microsoft.com/en-us/cli/azure/apim#az-apim-show' },
  azApimList: { label: 'az apim list', href: 'https://learn.microsoft.com/en-us/cli/azure/apim#az-apim-list' },
  azRest: { label: 'az rest', href: 'https://learn.microsoft.com/en-us/cli/azure/reference-index#az-rest' },
  azDeploymentSub: {
    label: 'az deployment sub create',
    href: 'https://learn.microsoft.com/en-us/cli/azure/deployment/sub#az-deployment-sub-create',
  },
  bicepParamFiles: {
    label: 'Bicep parameter files (.bicepparam)',
    href: 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/parameter-files',
  },
  azRoleAssignmentCreate: {
    label: 'az role assignment create',
    href: 'https://learn.microsoft.com/en-us/cli/azure/role/assignment#az-role-assignment-create',
  },
  foundryRbac: {
    label: 'Azure AI Foundry role-based access control',
    href: 'https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/rbac-azure-ai-foundry',
  },
  foundryA2a: {
    label: 'Enable the agent-to-agent (A2A) endpoint on a Foundry agent',
    href: 'https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/enable-agent-to-agent-endpoint',
  },
  apimManagedIdentity: {
    label: 'Use managed identities in Azure API Management',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-managed-service-identity',
  },
  apimSubscriptions: {
    label: 'Subscriptions in Azure API Management',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions',
  },
  apimMcp: {
    label: 'Expose APIs as MCP servers in API Management',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/export-rest-mcp-server',
  },
  apimMcpOverview: {
    label: 'MCP server support in API Management',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/mcp-server-overview',
  },
  apimCircuitBreaker: {
    label: 'Backend circuit breaker in API Management',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/backends',
  },
  apimRateLimitByKey: {
    label: 'rate-limit-by-key policy',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/rate-limit-by-key-policy',
  },
  apimQuotaByKey: {
    label: 'quota-by-key policy',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/quota-by-key-policy',
  },
  apimLlmTokenLimit: {
    label: 'llm-token-limit policy',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/llm-token-limit-policy',
  },
  apimTiers: {
    label: 'API Management feature availability by tier',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/api-management-features',
  },
  apimImportOpenApi: {
    label: 'Import an OpenAPI specification into API Management',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/import-api-from-oas',
  },
  apimPythonSdk: {
    label: 'azure-mgmt-apimanagement Python SDK',
    href: 'https://learn.microsoft.com/en-us/python/api/overview/azure/mgmt-apimanagement-readme',
  },
  azKeyVaultSecretShow: {
    label: 'az keyvault secret show',
    href: 'https://learn.microsoft.com/en-us/cli/azure/keyvault/secret#az-keyvault-secret-show',
  },
  keyVaultRbac: {
    label: 'Key Vault built-in roles (Secrets Officer / Secrets User)',
    href: 'https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#key-vault-secrets-officer',
  },
  appInsightsQuery: {
    label: 'az monitor app-insights query',
    href: 'https://learn.microsoft.com/en-us/cli/azure/monitor/app-insights#az-monitor-app-insights-query',
  },
  appInsightsCustomMetrics: {
    label: 'Application Insights custom metrics',
    href: 'https://learn.microsoft.com/en-us/azure/azure-monitor/app/api-custom-events-metrics',
  },
  monitorIngestionTime: {
    label: 'Log data ingestion time in Azure Monitor',
    href: 'https://learn.microsoft.com/en-us/azure/azure-monitor/logs/data-ingestion-time',
  },
  kqlAgo: {
    label: 'KQL ago() function',
    href: 'https://learn.microsoft.com/en-us/kusto/query/ago-function',
  },
  agentFramework: {
    label: 'Microsoft Agent Framework',
    href: 'https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview',
  },
  learnMcpServer: {
    label: 'Microsoft Learn MCP server',
    href: 'https://learn.microsoft.com/en-us/training/support/mcp',
  },
  learnMcpRepo: {
    label: 'MicrosoftDocs/mcp — the Microsoft Learn MCP server',
    href: 'https://github.com/MicrosoftDocs/mcp',
  },
  mcpSpec: {
    label: 'Model Context Protocol specification 2025-06-18',
    href: 'https://modelcontextprotocol.io/specification/2025-06-18',
  },
  azdEnv: {
    label: 'azd env get-values',
    href: 'https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/reference#azd-env-get-values',
  },
  apimDeleteApi: {
    label: 'az apim api delete',
    href: 'https://learn.microsoft.com/en-us/cli/azure/apim/api#az-apim-api-delete',
  },
  apimProduct: {
    label: 'Products in Azure API Management',
    href: 'https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-add-products',
  },
  deploymentHistory: {
    label: 'Azure deployment history and quota',
    href: 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deployment-history-deletions',
  },
});

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const PROFILES = Object.freeze([
  Object.freeze({
    id: 'hub',
    title: 'Hub',
    summary: 'Which subscription, resource group and API Management instance the run targets.',
    sourceCells: [2, 4, 6],
    fields: Object.freeze([
      {
        name: 'subscriptionId',
        label: 'Subscription ID',
        type: 'string',
        classification: 'required',
        width: 'id',
        pattern: GUID,
        patternMessage: 'Subscription ID must be a GUID.',
        help: 'The subscription that hosts the Citadel Governance Hub. Every deployment in this catalogue is scoped to it.',
        howToObtain:
          'Run `az account show --query id -o tsv`, or read AZURE_SUBSCRIPTION_ID from `azd env get-values`. The Discover › Azure context check recipe prints it for you.',
        links: [LINKS.azAccountShow, LINKS.azdEnv],
        notebookRef: 'cell 2 `subscription_id`, confirmed in cell 4',
      },
      {
        name: 'resourceGroupName',
        label: 'Governance hub resource group',
        type: 'string',
        classification: 'required',
        width: 'id',
        help: 'Resource group holding the deployed hub: API Management, Application Insights, Cosmos DB and the usage Logic Apps.',
        howToObtain:
          'Read AZURE_RESOURCE_GROUP (or GOVERNANCE_HUB_RESOURCE_GROUP) from `azd env get-values`, or list groups with `az group list -o table`.',
        links: [LINKS.azdEnv],
        notebookRef: 'cell 2 `governance_hub_resource_group`',
      },
      {
        name: 'location',
        label: 'Location',
        type: 'string',
        classification: 'required',
        width: 'short',
        placeholder: 'swedencentral',
        help: 'Azure region used as the deployment location for subscription-scoped deployments. It sets where deployment metadata is stored, not where the hub already lives.',
        howToObtain: 'Run `az account list-locations --query "[].name" -o tsv`, or read AZURE_LOCATION from your azd environment.',
        links: [LINKS.azDeploymentSub],
        notebookRef: 'cell 2 `location`',
      },
      {
        name: 'apimName',
        label: 'API Management service name',
        type: 'string',
        classification: 'derived',
        width: 'id',
        derivedFrom: 'Produced by Discover › API Management discovery (cell 6).',
        help: 'Name of the APIM instance in the hub resource group. Every gateway call and every management call in this catalogue names it.',
        howToObtain:
          'Run the API Management discovery recipe, or `az apim list -g <rg> --query "[].name" -o tsv`. If more than one service exists you must choose one deliberately.',
        links: [LINKS.azApimList],
        notebookRef: 'cell 6 `apimClientTool.apim_resource_name`',
      },
      {
        name: 'gatewayUrl',
        label: 'Gateway URL',
        type: 'url',
        classification: 'derived',
        width: 'long',
        derivedFrom: 'Produced by Discover › API Management discovery (cell 6).',
        placeholder: 'https://apim-citadel.azure-api.net',
        help: 'Base URL every published asset hangs off. Tools are served under `/mcp/…`, agents under `/agent/…`.',
        howToObtain:
          'Run the API Management discovery recipe, or `az apim show -g <rg> -n <apim> --query gatewayUrl -o tsv`. Use the custom domain if the hub has one, because the published endpoints follow it.',
        links: [LINKS.azApimShow],
        notebookRef: 'cell 6 `apim_resource_gateway_url`',
      },
    ]),
  }),

  Object.freeze({
    id: 'gatewayAccess',
    title: 'Gateway access',
    summary: 'The contract key the consumer presents, and the path/header conventions the publish contract applies.',
    sourceCells: [12, 14, 17, 20, 22],
    fields: Object.freeze([
      {
        name: 'apiKey',
        label: 'Access-contract api-key',
        type: 'secret',
        classification: 'secret',
        width: 'id',
        help: 'The single subscription key minted by the mixed access contract. It authorises the LLM APIs, both MCP tools, the A2A agent and the protected `weather-api` source.',
        howToObtain:
          'Deploy the access contract (Publish and grant › Deploy the mixed access contract) and read `endpoints[0].apiKey` from its outputs, or read the `PUBLISHED-ASSETS-KEY` secret from Key Vault. As a fallback the notebook calls `subscription.list_secrets` on the APIM subscription.',
        links: [LINKS.apimSubscriptions, LINKS.azKeyVaultSecretShow],
        notebookRef: 'cell 17 `api_key`',
        secretNote: 'Held in memory for this browser tab only. It is never stored, logged, put in a URL, or copied.',
      },
      {
        name: 'subscriptionKeyHeader',
        label: 'Subscription key header',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'api-key',
        help: 'Header the gateway reads the contract key from. The publish contract sets it for the A2A asset and the MCP servers inherit the gateway default.',
        howToObtain: 'Fixed by the notebook. Change it only if your APIM instance renames the subscription key header.',
        links: [LINKS.apimSubscriptions],
        notebookRef: 'cell 14 `subscriptionKeyHeaderName`',
      },
      {
        name: 'weatherSourceKeyHeader',
        label: 'Weather source key header',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'x-mcp-sub-key',
        help: 'Non-standard header the protected `weather-api` reads its key from. APIM strips `api-key` and `Ocp-Apim-Subscription-Key` before the internal tools/call hop, so a custom name is required for the forwarded key to survive.',
        howToObtain: 'Fixed by the notebook (cell 12). It must match on the source API and on the published tool.',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 12 `weather_source_key_header`',
      },
      {
        name: 'useAssetTypePathPrefix',
        label: 'Use asset-type path prefix',
        type: 'boolean',
        classification: 'sample-default',
        default: true,
        help: 'When on (the publish-contract default) tools are published under `mcp/` and agents under `agent/`. Turning it off restores legacy un-prefixed paths.',
        howToObtain: 'Fixed by the notebook. It must match the `useAssetTypePathPrefix` value the publish contract was deployed with.',
        links: [LINKS.apimMcpOverview],
        notebookRef: 'cell 14 `useAssetTypePathPrefix`',
      },
    ]),
  }),

  Object.freeze({
    id: 'foundry',
    title: 'Foundry',
    summary: 'The Foundry prompt agent republished as an A2A asset, and the APIM identity that reaches it.',
    sourceCells: [2, 8, 10],
    fields: Object.freeze([
      {
        name: 'enableA2aAsset',
        label: 'Publish the A2A asset',
        type: 'boolean',
        classification: 'sample-default',
        default: true,
        help: 'Master switch. With it off the notebook skips every A2A step, and so does this playground.',
        howToObtain: 'Fixed by the notebook (cell 2 `enable_a2a_asset`).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 2 `enable_a2a_asset`',
      },
      {
        name: 'accountName',
        label: 'Foundry account name',
        type: 'string',
        classification: 'conditional',
        width: 'id',
        placeholder: 'aif-citadel-agent-08',
        pattern: /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/,
        patternMessage: 'Foundry account name must be a 2-63 character lowercase Azure DNS label.',
        requiredWhen: { field: 'foundry.enableA2aAsset', equals: true },
        help: 'The Azure AI Foundry (Cognitive Services) account hosting the project. Its data plane is `https://<account>.services.ai.azure.com`.',
        howToObtain:
          'Run `az cognitiveservices account list --query "[].name" -o tsv`, or read the first entry of AI_FOUNDRY_SERVICES from `azd env get-values` — that is what cell 2 does.',
        links: [LINKS.foundryRbac, LINKS.azdEnv],
        notebookRef: 'cell 2 `foundry_account_name`',
      },
      {
        name: 'projectName',
        label: 'Foundry project name',
        type: 'string',
        classification: 'conditional',
        width: 'id',
        placeholder: 'proj-citadel-agent-08',
        requiredWhen: { field: 'foundry.enableA2aAsset', equals: true },
        help: 'Project inside the Foundry account. Role assignments are made at project scope, not account scope.',
        howToObtain:
          'Take the segment after `/projects/` in the project endpoint shown in the Foundry portal, which is exactly how cell 2 parses it out of `foundryProjectEndpoint`.',
        links: [LINKS.foundryRbac],
        notebookRef: 'cell 2 `foundry_project_name`',
      },
      {
        name: 'agentName',
        label: 'Foundry agent name',
        type: 'string',
        classification: 'conditional',
        width: 'id',
        placeholder: 'HR-ChatAgent',
        requiredWhen: { field: 'foundry.enableA2aAsset', equals: true },
        help: 'The existing prompt agent to republish over A2A. This playground never creates an agent.',
        howToObtain:
          'Create or find a prompt agent in the Foundry portal. The accelerator ships `citadel-agent-frameworks-tests.ipynb` to create one.',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 2 `foundry_agent_name`',
      },
      {
        name: 'role',
        label: 'Foundry role to grant',
        type: 'enum',
        classification: 'sample-default',
        default: 'Foundry Agent Consumer',
        options: [
          { value: 'Foundry Agent Consumer', label: 'Foundry Agent Consumer (least privilege)' },
          { value: 'Azure AI User', label: 'Azure AI User (broader data-plane access)' },
        ],
        help: 'Data-plane role granted to the APIM identity on the Foundry project so the published A2A backend can call the agent without keys.',
        howToObtain:
          'Both roles are built-in. Assigning either needs Owner or User Access Administrator on the project. If the name is unavailable in your tenant, assign it in the portal instead.',
        links: [LINKS.foundryRbac, LINKS.azRoleAssignmentCreate],
        notebookRef: 'cell 10 `foundry_role`',
      },
      {
        name: 'apimIdentityPrincipalId',
        label: 'APIM identity principal ID',
        type: 'string',
        classification: 'derived',
        width: 'id',
        derivedFrom: 'Produced by Prepare › Grant the APIM identity Foundry access (cell 10).',
        help: 'Object ID of the APIM managed identity that receives the Foundry role. A user-assigned identity is preferred; the system-assigned one is the fallback.',
        howToObtain: 'Run `az apim show -g <rg> -n <apim> --query identity -o json` and read `userAssignedIdentities[*].principalId` or `principalId`.',
        links: [LINKS.apimManagedIdentity],
        notebookRef: 'cell 10 `apim_mi_principal_id`',
      },
      {
        name: 'apimIdentityClientId',
        label: 'APIM identity client ID',
        type: 'string',
        classification: 'derived',
        width: 'id',
        derivedFrom: 'Produced by Prepare › Grant the APIM identity Foundry access (cell 10).',
        help: 'Client ID of the user-assigned identity, passed to the publish contract as `managedIdentityClientId` so the A2A backend authenticates as that specific identity. Leave empty to use the system-assigned identity.',
        howToObtain: 'Same `az apim show --query identity` call; read `userAssignedIdentities[*].clientId`.',
        links: [LINKS.apimManagedIdentity],
        notebookRef: 'cell 10 `apim_mi_client_id`',
      },
      {
        name: 'accountResourceId',
        label: 'Foundry account resource ID',
        type: 'string',
        classification: 'derived',
        width: 'long',
        derivedFrom: 'Produced by Prepare › Grant the APIM identity Foundry access (cell 10).',
        help: 'ARM id of the Foundry account. The project scope used for the role assignment is this id plus `/projects/<project>`.',
        howToObtain:
          "Run `az cognitiveservices account list --query \"[?name=='<account>'].id\" -o tsv`. The account may live in a different resource group from the hub.",
        links: [LINKS.foundryRbac],
        notebookRef: 'cell 10 `account_id`',
      },
    ]),
  }),

  Object.freeze({
    id: 'keyVault',
    title: 'Key Vault',
    summary: 'Where the access contract publishes the shared key and one endpoint secret per granted asset.',
    sourceCells: [2, 17, 18],
    fields: Object.freeze([
      {
        name: 'useAccessContractKv',
        label: 'Publish contract secrets to Key Vault',
        type: 'boolean',
        classification: 'sample-default',
        default: true,
        help: 'When on, the access contract writes the shared api-key plus one endpoint secret per asset to Key Vault. When off, credentials are returned as deployment outputs only.',
        howToObtain: 'Fixed by the notebook (cell 2 `use_access_contract_kv`).',
        links: [LINKS.keyVaultRbac],
        notebookRef: 'cell 2 `use_access_contract_kv`',
      },
      {
        name: 'name',
        label: 'Key Vault name',
        type: 'string',
        classification: 'conditional',
        width: 'id',
        requiredWhen: { field: 'keyVault.useAccessContractKv', equals: true },
        help: 'Target vault. Cell 2 degrades gracefully to direct output when this cannot be resolved; the playground asks for it instead of silently disabling the feature.',
        howToObtain:
          'Read AZURE_KEY_VAULT_NAME from `azd env get-values`, or run `az keyvault list -g <rg> --query "[].name" -o tsv`.',
        links: [LINKS.azKeyVaultSecretShow, LINKS.azdEnv],
        notebookRef: 'cell 2 `access_contract_kv_name`',
      },
      {
        name: 'subscriptionId',
        label: 'Key Vault subscription (override)',
        type: 'string',
        classification: 'sample-default',
        width: 'id',
        default: '',
        pattern: GUID,
        patternMessage: 'Key Vault subscription must be a GUID, or empty to use the hub subscription.',
        help: 'Leave empty to use the hub subscription. Set it to publish to a vault in a different subscription.',
        howToObtain:
          'Only needed for an external vault. The deploying identity needs Key Vault Secrets Officer on the target vault.',
        links: [LINKS.keyVaultRbac],
        notebookRef: 'cell 2 `access_contract_kv_subscription_id`',
      },
      {
        name: 'resourceGroupName',
        label: 'Key Vault resource group (override)',
        type: 'string',
        classification: 'sample-default',
        width: 'id',
        default: '',
        help: 'Leave empty to use the hub resource group. Set it to publish to a vault in a different group.',
        howToObtain: 'Only needed for an external vault.',
        links: [LINKS.keyVaultRbac],
        notebookRef: 'cell 2 `access_contract_kv_resource_group`',
      },
      {
        name: 'apiKeySecretName',
        label: 'Requested api-key secret name',
        type: 'string',
        classification: 'sample-default',
        width: 'id',
        default: 'PUBLISHED-ASSETS-KEY',
        help: 'The `apiKeySecretName` the access contract is asked to use for the shared key.',
        howToObtain: 'Fixed by the notebook (cell 17).',
        links: [LINKS.azKeyVaultSecretShow],
        notebookRef: 'cell 17 `apiKeySecretName`',
      },
      {
        name: 'keySecretName',
        label: 'Actual key secret name',
        type: 'string',
        classification: 'derived',
        width: 'id',
        derivedFrom: 'Produced by Publish and grant › Deploy the mixed access contract (cell 17).',
        help: 'The secret name the deployment actually reported in `subscriptions[0].keyVaultApiKeySecretName`. Verify this one, not the requested name.',
        howToObtain: 'Read it from the access-contract deployment outputs.',
        links: [LINKS.azKeyVaultSecretShow],
        notebookRef: 'cell 17 `access_contract_key_secret_name`',
      },
      {
        name: 'endpointSecretNames',
        label: 'Endpoint secret names',
        type: 'string-list',
        classification: 'derived',
        width: 'long',
        derivedFrom: 'Produced by Publish and grant › Deploy the mixed access contract (cell 17).',
        help: 'One auto-named endpoint secret per granted asset, in the form `<code>-<bu>-<useCase>-<env>-<apiName>-endpoint`. Distinct LLM front doors get distinct names so they cannot collide.',
        howToObtain: 'Read `subscriptions[0].keyVaultEndpointSecretNames` from the access-contract deployment outputs.',
        links: [LINKS.azKeyVaultSecretShow],
        notebookRef: 'cell 17 `access_contract_endpoint_secret_names`',
      },
    ]),
  }),

  Object.freeze({
    id: 'policy',
    title: 'Policy',
    summary: 'Access-contract identity and the per-asset-type limits the product policy applies.',
    sourceCells: [17, 31],
    fields: Object.freeze([
      {
        name: 'businessUnit',
        label: 'Business unit',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'Governance',
        help: 'First segment of the access-contract product id, `<code>-<bu>-<useCase>-<env>`.',
        howToObtain: 'Fixed by the notebook (cell 17 `biz_unit`).',
        links: [LINKS.apimProduct],
        notebookRef: 'cell 17 `biz_unit`',
      },
      {
        name: 'useCaseName',
        label: 'Use case',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'PublishedAssets',
        help: 'Second segment of the access-contract product id.',
        howToObtain: 'Fixed by the notebook (cell 17 `use_case_name`).',
        links: [LINKS.apimProduct],
        notebookRef: 'cell 17 `use_case_name`',
      },
      {
        name: 'environment',
        label: 'Environment',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'DEV',
        help: 'Third segment of the access-contract product id, and the folder the contract is written to.',
        howToObtain: 'Fixed by the notebook (cell 17 `env`).',
        links: [LINKS.apimProduct],
        notebookRef: 'cell 17 `env`',
      },
      {
        name: 'toolCallsPerMinute',
        label: 'Tool calls per minute',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 20,
        min: 1,
        max: 10000,
        help: 'Request-based `rate-limit-by-key` applied to the Tool branch of the product policy. Kept deliberately low so the burst test can trip it.',
        howToObtain: 'Fixed by the notebook (cell 17 `TOOL_CALLS_PER_MIN`). It must match what the deployed contract uses.',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 17 `TOOL_CALLS_PER_MIN`',
      },
      {
        name: 'agentCallsPerMinute',
        label: 'Agent calls per minute',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 10,
        min: 1,
        max: 10000,
        help: 'Request-based `rate-limit-by-key` applied to the Agent branch of the product policy.',
        howToObtain: 'Fixed by the notebook (cell 17 `AGENT_CALLS_PER_MIN`).',
        links: [LINKS.apimRateLimitByKey],
        notebookRef: 'cell 17 `AGENT_CALLS_PER_MIN`',
      },
      {
        name: 'allowedModels',
        label: 'Allowed models',
        type: 'string-list',
        classification: 'sample-default',
        width: 'long',
        default: ['gpt-4.1', 'gpt-5.4-mini'],
        help: 'Model RBAC list applied by `validate-model-access` on the LLM branch. Not exercised by any recipe in this catalogue — the notebook validates LLM token limits best-effort only.',
        howToObtain: 'Fixed by the notebook (cell 17 `allowed_models_csv`).',
        links: [LINKS.apimLlmTokenLimit],
        notebookRef: 'cell 17 `allowed_models_csv`',
      },
      {
        name: 'llmTokensPerMinute',
        label: 'LLM tokens per minute',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 10000,
        min: 1,
        help: 'TPM ceiling written into the LLM branch of the generated product policy.',
        howToObtain: 'Fixed by the notebook (cell 17 `llm-token-limit`).',
        links: [LINKS.apimLlmTokenLimit],
        notebookRef: 'cell 17 policy XML',
      },
      {
        name: 'llmTokenQuota',
        label: 'LLM monthly token quota',
        type: 'integer',
        classification: 'sample-default',
        width: 'num',
        default: 1000000,
        min: 1,
        help: 'Monthly token quota written into the LLM branch of the generated product policy.',
        howToObtain: 'Fixed by the notebook (cell 17 `llm-token-limit`).',
        links: [LINKS.apimLlmTokenLimit],
        notebookRef: 'cell 17 policy XML',
      },
      {
        name: 'candidateLlmApis',
        label: 'Candidate LLM APIs',
        type: 'string-list',
        classification: 'sample-default',
        width: 'long',
        default: ['universal-llm-api', 'azure-openai-api', 'unified-ai-api'],
        help: 'APIs the contract looks for on the gateway. Only the ones that already exist are granted, and `universal-llm-api` is preferred as the Foundry front door.',
        howToObtain: 'Fixed by the notebook (cell 17 `_candidate_llm`). Confirm with `az apim api list -g <rg> -n <apim> --query "[].name"`.',
        links: [LINKS.apimProduct],
        notebookRef: 'cell 17 `_candidate_llm`',
      },
    ]),
  }),
]);

export const PROFILE_BY_ID = new Map(PROFILES.map((profile) => [profile.id, profile]));

function profileFieldPath(profileId, fieldName) {
  return `${profileId}.${fieldName}`;
}
/** Every secret-classified path across all profiles. */
export function collectProfileSecretPaths() {
  const paths = [];
  for (const profile of PROFILES) {
    for (const field of profile.fields) {
      if (field.classification === 'secret') paths.push(profileFieldPath(profile.id, field.name));
    }
  }
  return paths;
}

/** Default values for every profile field that declares one. */
export function collectProfileDefaults() {
  const defaults = {};
  for (const profile of PROFILES) {
    for (const field of profile.fields) {
      if (Object.prototype.hasOwnProperty.call(field, 'default')) {
        defaults[profileFieldPath(profile.id, field.name)] = field.default;
      }
    }
  }
  return defaults;
}
