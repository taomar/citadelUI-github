/**
 * Publish and grant — cells 14/15, 17 and 18.
 *
 * The three recipes that actually publish the assets, grant a consumer access
 * to all three asset types under one product, and verify the minted secrets.
 */

import { step, createExecutionPlan } from '../../core/plan.mjs';
import { bicepValue } from '../../core/bicep.mjs';
import { secretRef } from '../../core/secrets.mjs';
import {
  foundryAgentCardBackendUrl,
  foundryAgentJsonRpcBackendUrl,
} from '../../core/endpoints.mjs';
import { isBlank } from '../../core/validation.mjs';
import { conditional, generated, mandatory, optional } from '../requirements.mjs';
import { LINKS } from '../profiles.mjs';

/** Machine form of "the A2A asset is switched on", shared by three recipes. */
const WHEN_A2A_ON = { field: 'foundry.enableA2aAsset', equals: true };

/**
 * The asset definitions cell 14 builds.
 *
 * Three recipes call `buildPublishAssets`, but they read different parts of the
 * result, so the declarations are split rather than shared wholesale. The
 * publish contract serialises every attribute; the access contract classifies
 * by asset *name* and type; cleanup deletes by name. Declaring the full set
 * everywhere would put a Foundry account name on the access-contract form that
 * nothing in its plan reads.
 */
export const PUBLISHED_ASSET_NAME_NEEDS = Object.freeze([
  optional(
    'foundry.enableA2aAsset',
    'Decides whether the A2A asset is part of the published set at all, and therefore whether the contract mixes asset types.',
    'Falls back to on, matching the notebook.',
  ),
  optional('publish-assets:weatherToolName', 'API id of the published Weather tool.', 'Falls back to `weather-tool`.'),
  optional('publish-assets:learnToolName', 'API id of the published Learn tool.', 'Falls back to `ms-learn-tool`.'),
  optional('publish-assets:agentAssetName', 'API id of the published agent.', 'Falls back to `hr-chat-agent`.'),
]);

/** Everything else the publish contract itself writes into its parameter file. */
export const PUBLISH_ASSET_NEEDS = Object.freeze([
  ...PUBLISHED_ASSET_NAME_NEEDS,
  optional(
    'gatewayAccess.weatherSourceKeyHeader',
    'Written into the Weather tool as `sourceSubscriptionKeyHeaderName`, so the forwarded key survives the internal hop.',
    'Falls back to `x-mcp-sub-key`.',
  ),
  optional(
    'gatewayAccess.subscriptionKeyHeader',
    'Written into the A2A asset as `subscriptionKeyHeaderName`.',
    'Falls back to `api-key`, the gateway default.',
  ),
  conditional(
    'foundry.accountName',
    'Composes the Foundry agent-card and JSON-RPC backend URLs for the A2A asset.',
    'Publish the A2A asset is on.',
    WHEN_A2A_ON,
  ),
  conditional(
    'foundry.projectName',
    'Second segment of the Foundry data-plane backend URLs.',
    'Publish the A2A asset is on.',
    WHEN_A2A_ON,
  ),
  conditional('foundry.agentName', 'Named as the asset`s `agentId` and in its backend URLs.', 'Publish the A2A asset is on.', WHEN_A2A_ON),
  optional('publish-assets:weatherToolPath', 'Gateway path of the published Weather tool.', 'Falls back to `weather-tool-mcp`.'),
  optional('publish-assets:weatherSourceApiName', 'Source API the Weather tool is generated from.', 'Falls back to `weather-api`.'),
  optional('publish-assets:weatherOperationName', 'The single operation exposed as a tool.', 'Falls back to `get-weather`.'),
  optional('publish-assets:learnToolPath', 'Gateway path of the published Learn tool.', 'Falls back to `ms-learn-tool-mcp`.'),
  optional('publish-assets:learnBackendUrl', 'Remote MCP server the Learn tool proxies.', 'Falls back to the public Microsoft Learn MCP endpoint.'),
  optional('publish-assets:agentPath', 'Gateway path of the published agent.', 'Falls back to `hr-chat-agent`.'),
  optional('publish-assets:agentCardPath', 'Where the gateway re-exposes the agent card.', 'Falls back to `/.well-known/agent.json`.'),
  optional(
    'publish-assets:publishToApiCenter',
    'Whether each asset is registered with API Center.',
    'Falls back to off, as all three assets do in the notebook.',
  ),
]);

/**
 * Rebuild the notebook's `assets` list (cell 14) from the current inputs.
 *
 * Reads through `fromSample` rather than `self`, because the access-contract
 * and cleanup recipes call this too and must see the same asset definitions
 * the publish contract used.
 */
export function buildPublishAssets(ctx) {
  const own = (name) => ctx.fromSample('publish-assets', name);
  const weatherKeyHeader = ctx.get('gatewayAccess.weatherSourceKeyHeader');
  const assets = [
    {
      assetType: 'mcp-from-api',
      name: own('weatherToolName'),
      displayName: 'Weather Tool (MCP)',
      description: 'Weather data operations, published as an MCP tool server.',
      path: own('weatherToolPath'),
      metadata: { version: '1.0.0', owner: 'Platform Engineering', classification: 'internal' },
      sourceApiName: own('weatherSourceApiName'),
      operationNames: [own('weatherOperationName')],
      forwardSubscriptionKeyToSource: true,
      sourceSubscriptionKeyHeaderName: weatherKeyHeader,
      publishToApiCenter: own('publishToApiCenter'),
    },
    {
      assetType: 'mcp-existing',
      name: own('learnToolName'),
      displayName: 'Microsoft Learn Tool (MCP)',
      description: 'Microsoft Learn MCP server published through the gateway.',
      path: own('learnToolPath'),
      transportType: 'streamable',
      subscriptionRequired: true,
      metadata: { version: '1.0.0', owner: 'Knowledge Mgmt', classification: 'public' },
      backend: { url: own('learnBackendUrl'), authType: 'none' },
      publishToApiCenter: own('publishToApiCenter'),
    },
  ];
  if (ctx.get('foundry.enableA2aAsset')) {
    const coords = {
      accountName: ctx.get('foundry.accountName'),
      projectName: ctx.get('foundry.projectName'),
      agentName: ctx.get('foundry.agentName'),
    };
    assets.push({
      assetType: 'a2a',
      name: own('agentAssetName'),
      displayName: 'HR Chat Agent (A2A)',
      description: 'HR assistant published via A2A.',
      path: own('agentPath'),
      agentId: coords.agentName,
      subscriptionRequired: true,
      subscriptionKeyHeaderName: ctx.get('gatewayAccess.subscriptionKeyHeader'),
      agentCardPath: own('agentCardPath'),
      agentCardBackendUrl: foundryAgentCardBackendUrl(coords),
      jsonRpcPath: '/',
      metadata: { version: '1.0.0', owner: 'HR Digital', classification: 'confidential' },
      backend: {
        url: foundryAgentJsonRpcBackendUrl(coords),
        authType: 'managed-identity',
        authConfig: { resource: 'https://ai.azure.com' },
      },
      publishToApiCenter: own('publishToApiCenter'),
    });
  }
  return assets;
}

function publishParamText(ctx, assets) {
  const lines = [
    "using '../../../main.bicep'",
    '',
    'param apim = {',
    `  subscriptionId: '${ctx.get('hub.subscriptionId')}'`,
    `  resourceGroupName: '${ctx.get('hub.resourceGroupName')}'`,
    `  name: '${ctx.get('hub.apimName')}'`,
    '}',
    '',
    `param managedIdentityClientId = '${ctx.get('foundry.apimIdentityClientId') ?? ''}'`,
    `param configureCircuitBreaker = ${ctx.self('configureCircuitBreaker') ? 'true' : 'false'}`,
    `param useAssetTypePathPrefix = ${ctx.get('gatewayAccess.useAssetTypePathPrefix') ? 'true' : 'false'}`,
    '',
    `param publishAssets = ${bicepValue(assets)}`,
    '',
  ];
  return lines.join('\n');
}

/**
 * Classify the granted APIs exactly as cell 17 does.
 *
 * `existingLlmApis` is read from the access-contract recipe wherever this is
 * called, because cleanup needs the same product id the contract produced.
 */
export function classifyContract(ctx, assets) {
  const toolApis = assets.filter((a) => a.assetType === 'mcp-from-api' || a.assetType === 'mcp-existing').map((a) => a.name);
  const agentApis = assets.filter((a) => a.assetType === 'a2a').map((a) => a.name);
  const candidates = ctx.get('policy.candidateLlmApis') ?? [];
  const existing = ctx.fromSample('access-contract-deploy', 'existingLlmApis') ?? [];
  const llmApis = candidates.filter((name) => existing.includes(name));
  const grantedApis = [...llmApis, ...toolApis, ...agentApis];
  const sourceApis = [
    ...new Set(
      assets
        .filter((a) => a.assetType === 'mcp-from-api' && a.forwardSubscriptionKeyToSource && a.sourceApiName)
        .map((a) => a.sourceApiName),
    ),
  ];
  const productApis = [...grantedApis, ...sourceApis.filter((name) => !grantedApis.includes(name))];
  const typesPresent = (llmApis.length ? 1 : 0) + (toolApis.length ? 1 : 0) + (agentApis.length ? 1 : 0);
  const contractCode =
    typesPresent > 1 ? 'MULTI' : agentApis.length ? 'AGENT' : toolApis.length ? 'TOOL' : 'LLM';
  const businessUnit = ctx.get('policy.businessUnit');
  const useCaseName = ctx.get('policy.useCaseName');
  const environment = ctx.get('policy.environment');
  const productId = `${contractCode}-${businessUnit}-${useCaseName}-${environment}`;
  const foundryApiName = llmApis.includes('universal-llm-api')
    ? 'universal-llm-api'
    : llmApis[0] ?? grantedApis[0] ?? '';
  return {
    toolApis,
    agentApis,
    llmApis,
    grantedApis,
    sourceApis,
    productApis,
    contractCode,
    productId,
    subscriptionName: `${productId}-SUB-01`,
    foundryApiName,
    businessUnit,
    useCaseName,
    environment,
  };
}

function productPolicyXml(ctx, contract) {
  const allowedModels = (ctx.get('policy.allowedModels') ?? []).join(',');
  return `<policies>
    <inbound>
        <base />
        <!-- COMMON POLICIES (asset-agnostic): add opt-in content safety / custom alerting here. -->
        <set-variable name="contractToolApis" value="${contract.toolApis.join(',')}" />
        <set-variable name="contractAgentApis" value="${contract.agentApis.join(',')}" />
        <include-fragment fragment-id="set-asset-kind" />
        <choose>
            <when condition="@(context.Variables.GetValueOrDefault&lt;string&gt;(&quot;assetKind&quot;,&quot;llm&quot;) == &quot;llm&quot;)">
                <include-fragment fragment-id="set-llm-requested-model" />
                <set-variable name="allowedModels" value="${allowedModels}" />
                <include-fragment fragment-id="validate-model-access" />
                <llm-token-limit counter-key="@(context.Subscription.Id)" tokens-per-minute="${ctx.get('policy.llmTokensPerMinute')}" estimate-prompt-tokens="false" token-quota="${ctx.get('policy.llmTokenQuota')}" token-quota-period="Monthly" />
                <set-variable name="enableResponseHeaders" value="@(true)" />
            </when>
            <when condition="@(context.Variables.GetValueOrDefault&lt;string&gt;(&quot;assetKind&quot;,&quot;&quot;) == &quot;tool&quot;)">
                <rate-limit-by-key calls="${ctx.get('policy.toolCallsPerMinute')}" renewal-period="60" counter-key="@(context.Subscription.Id + &quot;:tool&quot;)" />
                <quota-by-key calls="100000" renewal-period="2592000" counter-key="@(context.Subscription.Id + &quot;:tool&quot;)" />
            </when>
            <when condition="@(context.Variables.GetValueOrDefault&lt;string&gt;(&quot;assetKind&quot;,&quot;&quot;) == &quot;agent&quot;)">
                <rate-limit-by-key calls="${ctx.get('policy.agentCallsPerMinute')}" renewal-period="60" counter-key="@(context.Subscription.Id + &quot;:agent&quot;)" />
                <quota-by-key calls="50000" renewal-period="2592000" counter-key="@(context.Subscription.Id + &quot;:agent&quot;)" />
            </when>
        </choose>
    </inbound>
    <backend><base /></backend>
    <outbound><base /></outbound>
    <on-error><base /></on-error>
</policies>`;
}

function accessParamText(ctx, contract) {
  const kvSubscriptionOverride = ctx.get('keyVault.subscriptionId');
  const kvResourceGroupOverride = ctx.get('keyVault.resourceGroupName');
  const kvSub = isBlank(kvSubscriptionOverride) ? ctx.get('hub.subscriptionId') : kvSubscriptionOverride;
  const kvRg = isBlank(kvResourceGroupOverride) ? ctx.get('hub.resourceGroupName') : kvResourceGroupOverride;
  const useKv = ctx.get('keyVault.useAccessContractKv');
  const kvName = useKv ? ctx.get('keyVault.name') : 'unused-kv';
  const apiList = `[${contract.productApis.map((name) => `'${name}'`).join(', ')}]`;
  const endpoints = contract.grantedApis.map((name) => `      { apiName: '${name}' }`).join('\n');
  return `using '../../../main.bicep'

param apim = {
  subscriptionId: '${ctx.get('hub.subscriptionId')}'
  resourceGroupName: '${ctx.get('hub.resourceGroupName')}'
  name: '${ctx.get('hub.apimName')}'
}
param keyVault = {
  subscriptionId: '${kvSub}'
  resourceGroupName: '${kvRg}'
  name: '${kvName}'
}
param useTargetAzureKeyVault = ${useKv ? 'true' : 'false'}
param useCase = {
  businessUnit: '${contract.businessUnit}'
  useCaseName: '${contract.useCaseName}'
  environment: '${contract.environment}'
}
param apiNameMapping = {
  ${contract.contractCode}: ${apiList}
}
param services = [
  {
    code: '${contract.contractCode}'
    apiKeySecretName: '${ctx.get('keyVault.apiKeySecretName')}'
    foundryApiName: '${contract.foundryApiName}'
    assetEndpoints: [
${endpoints}
    ]
    policyXml: loadTextContent('ai-product-policy.xml')
  }
]
param productTerms = '${ctx.self('productTerms')}'
param useTargetFoundry = false
`;
}

export const PUBLISH_SAMPLES = [
  {
    id: 'publish-assets',
    group: 'publish-grant',
    title: 'Publish the three assets',
    shortTitle: 'Publish assets',
    summary: 'Generate the publish-contract `.bicepparam` and deploy it at subscription scope.',
    purpose:
      'This is the recipe the whole notebook exists to validate. It publishes three protected assets through one contract: an existing APIM API turned into an MCP tool server, a remote MCP server fronted by the gateway, and a Foundry agent exposed as a native A2A endpoint.',
    explanation: [
      'The contract is expressed as a parameter file, not as imperative calls. The file declares which APIM instance to target, which managed identity the A2A backend should authenticate as, whether circuit breakers are configured, whether asset-type path prefixes are applied, and then one object per asset.',
      'The three asset types behave differently. `mcp-from-api` takes an existing API (`sourceApiName`) plus a list of operations and exposes them as MCP tools — and with `forwardSubscriptionKeyToSource` it injects the caller`s key into the custom header the source API reads. `mcp-existing` puts the gateway in front of a remote MCP server and adds a backend. `a2a` fronts a Foundry agent, rewriting the agent card`s transport URLs to the gateway so clients route through it.',
      'Publishing is not granting. Nothing here mints a key or authorises a consumer; the assets exist but are unreachable until an access contract adds them to a product. That separation is deliberate and is why the next recipe exists.',
      'The parameter file is written into a source-controlled folder — `contracts/<contract-name>/<env>/main.bicepparam` — because the contract is meant to live in a repository, not in a notebook cell. Review it there before deploying.',
    ],
    flow: [
      'Compose the asset list from the Foundry coordinates, the source API and the remote MCP backend.',
      'Write `contracts/<contract>/<env>/main.bicepparam` next to the publish-contract module.',
      'Deploy `citadel-publish-contracts/main.bicep` at subscription scope with that parameter file.',
      'Read `publishedAssets` from the deployment outputs and record each asset`s authoritative endpoint.',
    ],
    prerequisites: [
      {
        id: 'source-api',
        title: '`weather-api` exists',
        detail: 'An `mcp-from-api` asset fails to deploy if its `sourceApiName` is not on the gateway.',
        howTo: 'Run Prepare › Ensure the `weather-api` source API exists first.',
        links: [LINKS.apimMcp],
      },
      {
        id: 'a2a-enabled',
        title: 'A2A is enabled on the Foundry agent',
        detail: 'The `a2a` asset references the agent card backend URL that only exists once A2A is activated.',
        howTo: 'Run Prepare › Enable incoming A2A on the Foundry agent, or turn the A2A asset off in the Foundry profile.',
        links: [LINKS.foundryA2a],
      },
      {
        id: 'identity-granted',
        title: 'The APIM identity can reach Foundry',
        detail: 'The deployment succeeds without the grant, but every A2A call afterwards fails at the backend.',
        howTo: 'Run Prepare › Grant the APIM identity Foundry access.',
        links: [LINKS.foundryRbac],
      },
      {
        id: 'deploy-rights',
        title: 'Subscription-scope deployment rights',
        detail: '`az deployment sub create` needs Contributor at subscription scope, plus rights on the APIM resource group.',
        howTo: 'Confirm with `az role assignment list --assignee <you> --scope /subscriptions/<id> -o table`.',
        links: [LINKS.azDeploymentSub],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'foundry'],
    fields: [
      {
        name: 'deploymentName',
        label: 'Deployment name',
        type: 'string',
        classification: 'sample-default',
        width: 'id',
        default: 'citadel-publish-contracts-validation',
        help: 'Name of the subscription-scoped deployment. Re-using a name overwrites that entry in the deployment history.',
        howToObtain: 'Fixed by the notebook (cell 2 `publish_deployment_name`).',
        links: [LINKS.azDeploymentSub],
        notebookRef: 'cell 2 `publish_deployment_name`',
      },
      {
        name: 'publishBicepDir',
        label: 'Publish-contract module directory',
        type: 'string',
        classification: 'sample-default',
        width: 'long',
        default: 'runtime/accelerator/citadel-publish-contracts',
        help: 'Folder holding `main.bicep` for the publish contract. The default is the vendored copy that ships inside `CitadelSamples`, so a local run needs nothing from the wider repository.',
        howToObtain:
          'Fixed by the notebook (cell 14 `publish_bicep_dir`), repointed at `runtime/accelerator/citadel-publish-contracts`. Change it only to deploy your own fork of the template.',
        links: [LINKS.bicepParamFiles],
        notebookRef: 'cell 14 `publish_bicep_dir`',
      },
      {
        name: 'contractName',
        label: 'Publish contract name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'sample-assets',
        help: 'Folder name under `contracts/`, mirroring the access-contract layout.',
        howToObtain: 'Fixed by the notebook (cell 14 `publish_contract_name`).',
        links: [LINKS.bicepParamFiles],
        notebookRef: 'cell 14 `publish_contract_name`',
      },
      {
        name: 'contractEnv',
        label: 'Publish contract environment',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'dev',
        help: 'Environment folder under the contract name.',
        howToObtain: 'Fixed by the notebook (cell 14 `publish_env`).',
        links: [LINKS.bicepParamFiles],
        notebookRef: 'cell 14 `publish_env`',
      },
      {
        name: 'configureCircuitBreaker',
        label: 'Configure circuit breakers',
        type: 'boolean',
        classification: 'sample-default',
        default: true,
        help: 'Attaches a native circuit breaker to each created backend. Not supported on the API Management Consumption tier.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.apimCircuitBreaker, LINKS.apimTiers],
        notebookRef: 'cell 14 `configureCircuitBreaker`',
      },
      {
        name: 'publishToApiCenter',
        label: 'Publish to API Center',
        type: 'boolean',
        classification: 'sample-default',
        default: false,
        help: 'Off in the notebook for all three assets, so no API Center registration happens.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.apimMcpOverview],
        notebookRef: 'cell 14 `publishToApiCenter`',
      },
      {
        name: 'weatherToolName',
        label: 'Weather tool asset name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'weather-tool',
        help: 'Asset name, which also becomes the created APIM API name.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 14 asset 1 `name`',
      },
      {
        name: 'weatherToolPath',
        label: 'Weather tool path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'weather-tool-mcp',
        help: 'Path suffix. With the asset-type prefix on, the server is served at `{gateway}/mcp/weather-tool-mcp/mcp`.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 14 asset 1 `path`',
      },
      {
        name: 'weatherSourceApiName',
        label: 'Weather source API name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'weather-api',
        help: 'Existing APIM API the MCP tools are generated from.',
        howToObtain: 'Fixed by the notebook (cell 14). Must match the API created by the Prepare recipe.',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 14 `sourceApiName`',
      },
      {
        name: 'weatherOperationName',
        label: 'Weather operation exposed',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'get-weather',
        help: 'The single source operation exposed as an MCP tool.',
        howToObtain: 'Fixed by the notebook (cell 14 `operationNames`).',
        links: [LINKS.apimMcp],
        notebookRef: 'cell 14 `operationNames`',
      },
      {
        name: 'learnToolName',
        label: 'Learn tool asset name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'ms-learn-tool',
        help: 'Asset name for the remote Microsoft Learn MCP server.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.learnMcpServer],
        notebookRef: 'cell 14 asset 2 `name`',
      },
      {
        name: 'learnToolPath',
        label: 'Learn tool path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'ms-learn-tool-mcp',
        help: 'Path suffix. A native MCP server gets no trailing `/mcp`, so it is served at `{gateway}/mcp/ms-learn-tool-mcp`.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.apimMcpOverview],
        notebookRef: 'cell 14 asset 2 `path`',
      },
      {
        name: 'learnBackendUrl',
        label: 'Learn MCP backend URL',
        type: 'url',
        classification: 'sample-default',
        width: 'long',
        default: 'https://learn.microsoft.com/api/mcp',
        help: 'The public Microsoft Learn MCP endpoint. Published with `authType: none` because it is unauthenticated.',
        howToObtain: 'Fixed by the notebook (cell 14). See the Microsoft Learn MCP server documentation.',
        links: [LINKS.learnMcpServer, LINKS.learnMcpRepo],
        notebookRef: 'cell 14 asset 2 `backend.url`',
      },
      {
        name: 'agentAssetName',
        label: 'Agent asset name',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'hr-chat-agent',
        help: 'Asset name for the A2A agent.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 14 asset 3 `name`',
      },
      {
        name: 'agentPath',
        label: 'Agent path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: 'hr-chat-agent',
        help: 'Path suffix. With the asset-type prefix on, the agent is served at `{gateway}/agent/hr-chat-agent`.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 14 asset 3 `path`',
      },
      {
        name: 'agentCardPath',
        label: 'Agent card path',
        type: 'string',
        classification: 'sample-default',
        width: 'short',
        default: '/.well-known/agent.json',
        help: 'Where the gateway re-exposes the agent card. A2A clients resolve this relative to the agent base URL.',
        howToObtain: 'Fixed by the notebook (cell 14).',
        links: [LINKS.foundryA2a],
        notebookRef: 'cell 14 `agentCardPath`',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'Written into the generated `.bicepparam` as the APIM subscription.'),
      mandatory('hub.resourceGroupName', 'Written into the generated `.bicepparam` as the APIM resource group.'),
      mandatory('hub.apimName', 'Names the API Management service the assets are published on.'),
      mandatory('hub.location', 'Deployment location for the subscription-scoped `az deployment sub create`.'),
      optional(
        'gatewayAccess.useAssetTypePathPrefix',
        'Written into the contract as `useAssetTypePathPrefix`, which decides whether tools land under `mcp/` and agents under `agent/`.',
        'Falls back to on, the publish-contract default.',
      ),
      generated(
        'foundry.apimIdentityClientId',
        'Passed as `managedIdentityClientId` so the A2A backend authenticates as a specific user-assigned identity.',
        'Left blank the contract uses the APIM system-assigned identity, exactly as the notebook does when no user-assigned identity exists.',
        'Produced by Prepare › Grant the APIM identity Foundry access.',
      ),
      ...PUBLISH_ASSET_NEEDS,
      optional('self:deploymentName', 'Name of the subscription-scoped deployment.', 'Falls back to `citadel-publish-contracts-validation`.'),
      optional(
        'self:publishBicepDir',
        'Folder holding the publish contract`s `main.bicep`.',
        'Falls back to the vendored bundle at `runtime/accelerator/citadel-publish-contracts`.',
      ),
      optional('self:contractName', 'Folder the generated parameter file is written under.', 'Falls back to `sample-assets`.'),
      optional('self:contractEnv', 'Environment folder for the generated parameter file.', 'Falls back to `dev`.'),
      optional(
        'self:configureCircuitBreaker',
        'Written into the contract as `configureCircuitBreaker`.',
        'Falls back to on, matching the notebook. The Observe recipe checks what this produced.',
      ),
    ],
    runtime: {
      dependencies: ['azure-cli', 'accelerator'],
      accelerator: ['citadel-publish-contracts'],
      note: 'Writes one `.bicepparam` into the run workspace, then deploys the vendored `citadel-publish-contracts/main.bicep` at subscription scope.',
    },
    risk: {
      level: 'state-changing',
      effect:
        'Deploys at subscription scope. Creates or updates APIM APIs, backends, policies and named values for three assets, and writes a parameter file to disk.',
      blastRadius:
        'The whole gateway: existing APIs with the same names are overwritten, and the deployment appears in the subscription`s deployment history.',
      reversibility:
        'Assets can be deleted with the Lifecycle recipe. The deployment history entry and the generated file are not removed.',
      acknowledgementPrompt:
        'This performs a subscription-scoped deployment that creates or overwrites APIs, backends and policies on a live gateway. Confirm this is a non-production environment you are allowed to deploy to.',
    },
    sourceCells: [13, 14, 15],
    sourceNote:
      'Cell 14 builds the asset list and writes `main.bicepparam`; cell 15 runs `az deployment sub create` and captures `publishedAssets`.',
    expectedResults: [
      {
        id: 'param-written',
        title: 'The parameter file is written',
        assertion: 'The file exists at `contracts/<contract>/<env>/main.bicepparam` and declares one object per asset.',
        evidence: 'The generated artefact shown in the Request tab.',
        whenNotRun: 'Not run — nothing is written.',
      },
      {
        id: 'deployment-succeeds',
        title: 'The deployment succeeds',
        assertion: '`az deployment sub create` exits 0 and `properties.provisioningState` is `Succeeded`.',
        evidence: 'The deployment output JSON.',
        whenNotRun: 'Not run — no assets are published.',
      },
      {
        id: 'assets-published',
        title: 'Every configured asset is reported',
        assertion:
          'The `publishedAssets` output holds one entry per configured asset, each with `assetType`, `name`, `path` and `endpoint`.',
        evidence: 'The `publishedAssets` output array.',
        whenNotRun: 'Not run — endpoints must be composed by hand from the path conventions.',
      },
      {
        id: 'endpoints-prefixed',
        title: 'Endpoints follow the asset-type conventions',
        assertion:
          'Tools are under `mcp/`, agents under `agent/`, and only an `mcp-from-api` endpoint carries a trailing `/mcp`.',
        evidence: 'The reported endpoints compared with the derived paths.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook writes the parameter file and deploys in two separate cells with no confirmation between them. This recipe keeps both steps but requires one acknowledgement before either runs.',
      'The notebook does not check `provisioningState`; it only checks the CLI exit code and reads outputs when present. This recipe asserts the provisioning state explicitly.',
    ],
    notes: [
      'The endpoint returned by the deployment is authoritative. Prefer it over any endpoint you compose yourself, which is exactly what the notebook`s `published_by_name` lookup does.',
      'The A2A asset is omitted entirely when `Publish the A2A asset` is off, and the generated parameter file changes shape accordingly.',
    ],
    build(ctx) {
      const assets = buildPublishAssets(ctx);
      const dir = `${ctx.self('publishBicepDir')}/contracts/${ctx.self('contractName')}/${ctx.self('contractEnv')}`;
      const paramPath = `${dir}/main.bicepparam`;
      return createExecutionPlan({
        sampleId: 'publish-assets',
        title: 'Publish the three assets',
        summary: 'Write the publish-contract parameter file and deploy it at subscription scope.',
        risk: ctx.risk,
        sourceCells: [13, 14, 15],
        steps: [
          step.artifact({
            id: 'write-param',
            title: 'Write the publish-contract parameter file',
            detail: 'The exact `.bicepparam` the notebook generates, ready to commit.',
            artifact: {
              path: paramPath,
              language: 'bicep-params',
              encoding: 'utf-8',
              content: publishParamText(ctx, assets),
            },
            produces: ['paramPath'],
          }),
          step.cli({
            id: 'deploy',
            title: 'Deploy the publish contract',
            detail: 'Subscription-scoped deployment of `citadel-publish-contracts/main.bicep`.',
            command: {
              executable: 'az',
              args: [
                'deployment',
                'sub',
                'create',
                '--name',
                ctx.self('deploymentName'),
                '--location',
                ctx.get('hub.location'),
                '--template-file',
                `${ctx.self('publishBicepDir')}/main.bicep`,
                '--parameters',
                paramPath,
                '--subscription',
                ctx.get('hub.subscriptionId'),
                '-o',
                'json',
              ],
              note: 'Targets the validated Hub profile subscription explicitly.',
            },
            produces: ['provisioningState', 'publishedAssets'],
          }),
          step.assertion({
            id: 'assert-published',
            title: 'Confirm every asset was published',
            detail: 'Records each asset`s authoritative endpoint for the Exercise recipes.',
            assertion: {
              kind: 'shape',
              source: '{{steps.deploy.publishedAssets}}',
              expectations: [
                '`provisioningState` is `Succeeded`.',
                `\`publishedAssets\` holds ${assets.length} entries.`,
                ...assets.map((asset) => `\`${asset.name}\` is present with assetType \`${asset.assetType}\`.`),
                'Every entry carries a non-empty `endpoint`.',
              ],
            },
            produces: ['publishedByName'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'access-contract-deploy',
    group: 'publish-grant',
    title: 'Deploy the mixed access contract',
    shortTitle: 'Mixed access contract',
    summary: 'Grant one consumer all three asset types under a single `MULTI-` product with asset-type-aware policies.',
    purpose:
      'Publishing does not grant access. This recipe deploys a real Citadel Access Contract that adds the LLM APIs, both MCP tools and the A2A agent to one product, applies different throttling to each asset kind, and mints the single `api-key` every later recipe presents.',
    explanation: [
      'The product policy branches on an `assetKind` variable set by the `set-asset-kind` fragment. The LLM branch applies model RBAC and `llm-token-limit`; the Tool branch and the Agent branch each apply a request-based `rate-limit-by-key` plus a `quota-by-key`, with different counters and different call ceilings. That branching is the thing the Policy group later proves by tripping the limits.',
      'The contract code is computed, not chosen. One asset type present gives `LLM-`, `TOOL-` or `AGENT-`; more than one gives `MULTI-`. Because the LLM set depends on which inference APIs actually exist on the gateway, the product id itself is a discovered value — the same inputs on a different gateway can legitimately produce a different product id, and therefore different Key Vault secret names.',
      'The product also has to include the source APIs behind any forwarding `mcp-from-api` tool. Without `weather-api` in the same product, the key that authorises the MCP tool would not authorise the internal hop to the protected source API, and `tools/call` would fail with 401 after a successful `tools/list`.',
      'When Key Vault publishing is on, the contract writes one shared api-key secret plus one endpoint secret per granted asset, each using the default auto-generated name `<code>-<bu>-<useCase>-<env>-<apiName>-endpoint`. Giving two LLM front doors the same secret name would silently collide, which is why the names are per-API rather than per-contract.',
    ],
    flow: [
      'List the APIs on the gateway and record which candidate LLM APIs exist.',
      'Classify the granted set into LLM, Tool, Agent and forwarded source APIs, and compute the contract code and product id.',
      'Write `ai-product-policy.xml` with the asset-type-aware branches.',
      'Write `contracts/<bu>-<usecase>/<env>/main.bicepparam` referencing that policy.',
      'Deploy the access contract at subscription scope.',
      'Read the minted api-key and the Key Vault secret names from the outputs, falling back to the APIM subscription secrets.',
    ],
    prerequisites: [
      {
        id: 'assets-published',
        title: 'The assets are published',
        detail: 'The product can only grant APIs that already exist on the gateway.',
        howTo: 'Run Publish and grant › Publish the three assets first.',
        links: [LINKS.apimProduct],
      },
      {
        id: 'fragments',
        title: 'The policy fragments exist on the gateway',
        detail:
          'The generated policy includes `set-asset-kind`, `set-llm-requested-model` and `validate-model-access`. Missing fragments make the product policy fail validation at deploy time.',
        howTo: 'Confirm with `az apim policy-fragment list -g <rg> -n <apim> --query "[].name" -o tsv`. They ship with the accelerator.',
        links: [LINKS.apimProduct],
      },
      {
        id: 'kv-writer',
        title: 'Key Vault Secrets Officer on the target vault',
        detail: 'Only when Key Vault publishing is on. The deploying identity writes the key and endpoint secrets.',
        howTo: 'Assign Key Vault Secrets Officer at the vault scope, including for a vault in another subscription.',
        links: [LINKS.keyVaultRbac],
      },
    ],
    usesProfiles: ['hub', 'gatewayAccess', 'foundry', 'keyVault', 'policy'],
    fields: [
      {
        name: 'existingLlmApis',
        label: 'LLM APIs present on this gateway',
        type: 'string-list',
        classification: 'derived',
        width: 'long',
        default: [],
        derivedFrom: 'Produced by the first step of this recipe, `az apim api list`.',
        help: 'Only candidates that actually exist are granted. This drives the contract code, the product id and therefore the Key Vault secret names.',
        howToObtain: 'Run `az apim api list -g <rg> -n <apim> --query "[].name" -o tsv` and keep the entries that appear in Candidate LLM APIs.',
        links: [LINKS.apimProduct],
        notebookRef: 'cell 17 `existing_apis` / `llm_apis`',
      },
      {
        name: 'accessBicepDir',
        label: 'Access-contract module directory',
        type: 'string',
        classification: 'sample-default',
        width: 'long',
        default: 'runtime/accelerator/citadel-access-contracts',
        help: 'Folder holding `main.bicep` for the access contract. The default is the vendored copy inside `CitadelSamples`.',
        howToObtain:
          'Fixed by the notebook (cell 17 `access_bicep_dir`), repointed at `runtime/accelerator/citadel-access-contracts`.',
        links: [LINKS.bicepParamFiles],
        notebookRef: 'cell 17 `access_bicep_dir`',
      },
      {
        name: 'deploymentNameSuffix',
        label: 'Deployment name suffix',
        type: 'string',
        classification: 'sample-default',
        width: 'num',
        default: '01',
        help: 'Suffix appended to `publish-access-contract-`. The notebook uses a wall-clock time here, which makes its deployment name non-reproducible.',
        howToObtain: 'Choose any short suffix. Re-using one overwrites that deployment-history entry.',
        links: [LINKS.azDeploymentSub],
        notebookRef: 'cell 17 `deploy_name`',
      },
      {
        name: 'productTerms',
        label: 'Product terms',
        type: 'string',
        classification: 'sample-default',
        width: 'long',
        default: 'Citadel Access Contract (mixed asset types) for publish-contract validation',
        help: 'Terms text attached to the generated product.',
        howToObtain: 'Fixed by the notebook (cell 17 `productTerms`).',
        links: [LINKS.apimProduct],
        notebookRef: 'cell 17 `productTerms`',
      },
    ],
    configuration: [
      mandatory('hub.subscriptionId', 'Written into the contract parameter file, and the default Key Vault subscription.'),
      mandatory('hub.resourceGroupName', 'Scopes the API listing and is written into the contract parameter file.'),
      mandatory('hub.apimName', 'The gateway whose APIs are listed and whose product the contract creates.'),
      mandatory('hub.location', 'Deployment location for the subscription-scoped `az deployment sub create`.'),
      ...PUBLISHED_ASSET_NAME_NEEDS,
      optional(
        'publish-assets:weatherSourceApiName',
        'A forwarding tool`s source API joins the same product, so the shared key authorises both the tool and the protected raw API.',
        'Falls back to `weather-api`.',
      ),
      optional(
        'policy.candidateLlmApis',
        'The APIs the contract looks for on the gateway; only the ones that exist are granted.',
        'Falls back to the notebook`s three candidates.',
      ),
      optional('policy.businessUnit', 'First segment of the product id.', 'Falls back to `Governance`.'),
      optional('policy.useCaseName', 'Second segment of the product id.', 'Falls back to `PublishedAssets`.'),
      optional('policy.environment', 'Third segment of the product id and the contract folder.', 'Falls back to `DEV`.'),
      optional('policy.toolCallsPerMinute', 'Written into the Tool branch of the generated product policy.', 'Falls back to 20, low enough for the burst recipe to trip it.'),
      optional('policy.agentCallsPerMinute', 'Written into the Agent branch of the generated product policy.', 'Falls back to 10.'),
      optional('policy.allowedModels', 'Written into the LLM branch as the model RBAC list.', 'Falls back to the notebook`s two models.'),
      optional('policy.llmTokensPerMinute', 'TPM ceiling in the LLM branch.', 'Falls back to 10 000.'),
      optional('policy.llmTokenQuota', 'Monthly token quota in the LLM branch.', 'Falls back to 1 000 000.'),
      optional(
        'keyVault.useAccessContractKv',
        'Decides whether the contract publishes the shared key and per-asset endpoints to Key Vault.',
        'Falls back to on. Turned off, credentials are returned as deployment outputs only.',
      ),
      conditional(
        'keyVault.name',
        'Target vault the shared key and endpoint secrets are written to.',
        'Publish contract secrets to Key Vault is on.',
        { field: 'keyVault.useAccessContractKv', equals: true },
      ),
      optional('keyVault.subscriptionId', 'Targets a vault in another subscription.', 'Left blank, the hub subscription is used.'),
      optional('keyVault.resourceGroupName', 'Targets a vault in another resource group.', 'Left blank, the hub resource group is used.'),
      optional('keyVault.apiKeySecretName', 'The `apiKeySecretName` requested for the shared key.', 'Falls back to `PUBLISHED-ASSETS-KEY`.'),
      generated(
        'self:existingLlmApis',
        'Which candidate LLM APIs actually exist on this gateway, which decides the contract code and the product id.',
        'Left blank the contract classifies as TOOL/AGENT/MULTI without any LLM API, which is a different product id from the one a gateway with LLM APIs produces.',
        'Produced by this recipe`s own API listing step.',
      ),
      optional(
        'self:accessBicepDir',
        'Folder holding the access contract`s `main.bicep`.',
        'Falls back to the vendored bundle at `runtime/accelerator/citadel-access-contracts`.',
      ),
      optional('self:deploymentNameSuffix', 'Suffix on the deployment name.', 'Falls back to `01`.'),
      optional('self:productTerms', 'Terms text attached to the generated product.', 'Falls back to the notebook`s text.'),
    ],
    runtime: {
      dependencies: ['azure-cli', 'accelerator', 'python'],
      accelerator: ['citadel-access-contracts'],
      python: {
        packages: ['azure-mgmt-apimanagement'],
        modules: ['azure.mgmt.apimanagement'],
        install: 'pip install azure-mgmt-apimanagement',
        optionalReason:
          'Python is needed only for the documented fallback that reads the subscription key when the deployment outputs carry none.',
      },
      note: 'Writes the product policy and the parameter file into the run workspace, then deploys the vendored access contract.',
    },
    risk: {
      level: 'state-changing',
      effect:
        'Deploys at subscription scope. Creates a product, a subscription and a product policy, mints an api-key, and writes secrets to Key Vault when enabled.',
      blastRadius:
        'A live product and a live credential. Anyone holding the minted key reaches every granted asset, including the LLM inference APIs.',
      reversibility:
        'The product and subscription can be deleted by the Lifecycle recipe. Key Vault secrets, the deployment history entry and the generated files are not removed.',
      acknowledgementPrompt:
        'This mints a working api-key and grants it access to every published asset, and may write secrets to Key Vault. Confirm this is a non-production environment.',
    },
    sourceCells: [16, 17],
    sourceNote:
      'Cell 17 classifies the assets, generates the product policy and parameter file, deploys the access contract, and captures the api-key plus Key Vault secret names.',
    expectedResults: [
      {
        id: 'classification',
        title: 'Asset kinds are classified',
        assertion:
          'Tools, Agents and existing LLM APIs are separated, the forwarded source API is added to the product, and the contract code follows the number of distinct types present.',
        evidence: 'The classification step`s output.',
        whenNotRun: 'Not run — the product id is unknown.',
      },
      {
        id: 'deployment-succeeds',
        title: 'The access contract deploys',
        assertion: '`provisioningState` is `Succeeded` and the product exists with the computed id.',
        evidence: 'The deployment output JSON.',
        whenNotRun: 'Not run — no key is minted.',
      },
      {
        id: 'key-minted',
        title: 'An api-key is available',
        assertion:
          'Either `endpoints[0].apiKey` is present in the outputs, or the APIM subscription`s primary key is readable as the documented fallback.',
        evidence: 'The deployment outputs, or the subscription secrets call.',
        whenNotRun: 'Not run — every Exercise and Policy recipe stays blocked.',
      },
      {
        id: 'kv-names',
        title: 'Key Vault secret names are reported',
        assertion:
          'When Key Vault publishing is on, `subscriptions[0].keyVaultApiKeySecretName` and `keyVaultEndpointSecretNames` are returned, with one endpoint name per granted asset.',
        evidence: 'The deployment outputs.',
        whenNotRun: 'Not run — the verification recipe has nothing to check.',
      },
    ],
    deviations: [
      'The notebook names the deployment with a wall-clock timestamp, so the same run is never reproducible. This recipe uses an explicit suffix so the generated plan is deterministic.',
      'The notebook discovers the existing LLM APIs inside the same cell that writes the parameter file. This recipe surfaces the discovered list as an input so the generated file is concrete and reviewable before anything is deployed.',
      'The notebook falls back to `client.subscription.list_secrets` silently. This recipe keeps the fallback but reports which of the two paths produced the key.',
    ],
    notes: [
      'The minted key is a secret. It is never written into the generated plan, the preview, or anything copied from this page; it is referenced by name only.',
      'The product id, and therefore every Key Vault secret name, depends on which LLM APIs exist on the gateway. Two gateways with the same inputs can produce different names.',
    ],
    build(ctx) {
      const assets = buildPublishAssets(ctx);
      const contract = classifyContract(ctx, assets);
      const dir = `${ctx.self('accessBicepDir')}/contracts/${contract.businessUnit.toLowerCase()}-${contract.useCaseName.toLowerCase()}/${contract.environment.toLowerCase()}`;
      const policyPath = `${dir}/ai-product-policy.xml`;
      const paramPath = `${dir}/main.bicepparam`;
      const deploymentName = `publish-access-contract-${ctx.self('deploymentNameSuffix')}`;
      return createExecutionPlan({
        sampleId: 'access-contract-deploy',
        title: 'Deploy the mixed access contract',
        summary: 'Classify the published assets, generate the contract, deploy it, and capture the minted key.',
        risk: ctx.risk,
        sourceCells: [16, 17],
        steps: [
          step.cli({
            id: 'list-apis',
            title: 'List the APIs on the gateway',
            detail: 'Establishes which candidate LLM APIs exist, which determines the contract code.',
            command: {
              executable: 'az',
              args: [
                'apim',
                'api',
                'list',
                '-g',
                ctx.get('hub.resourceGroupName'),
                '-n',
                ctx.get('hub.apimName'),
                '--query',
                '[].name',
                '--subscription',
                ctx.get('hub.subscriptionId'),
                '-o',
                'json',
              ],
            },
            produces: ['existingApis'],
          }),
          step.assertion({
            id: 'classify',
            title: 'Classify the granted set',
            detail: 'Mirrors cell 17`s classification, including adding forwarded source APIs to the product.',
            assertion: {
              kind: 'classification',
              source: '{{steps.list-apis.existingApis}}',
              candidateLlmApis: ctx.get('policy.candidateLlmApis'),
              configuredLlmApis: contract.llmApis,
              outputValues: {
                productId: contract.productId,
                contractCode: contract.contractCode,
              },
              expectations: [
                `LLM APIs: ${contract.llmApis.join(', ') || '(none found on this gateway)'}`,
                `Tools: ${contract.toolApis.join(', ')}`,
                `Agents: ${contract.agentApis.join(', ') || '(none — A2A asset disabled)'}`,
                `Forwarded source APIs added to the product: ${contract.sourceApis.join(', ') || '(none)'}`,
                `Contract code: ${contract.contractCode}; product id: ${contract.productId}`,
                `Foundry front door: ${contract.foundryApiName || '(none)'}`,
              ],
            },
            produces: ['productId', 'contractCode'],
          }),
          step.artifact({
            id: 'write-policy',
            title: 'Write the asset-type-aware product policy',
            detail: 'One policy, three branches, selected by the `set-asset-kind` fragment.',
            artifact: {
              path: policyPath,
              language: 'xml',
              encoding: 'utf-8',
              content: productPolicyXml(ctx, contract),
            },
            produces: ['policyPath'],
          }),
          step.artifact({
            id: 'write-param',
            title: 'Write the access-contract parameter file',
            detail: 'Loads the policy with `loadTextContent`, so both files must be committed together.',
            artifact: {
              path: paramPath,
              language: 'bicep-params',
              encoding: 'utf-8',
              content: accessParamText(ctx, contract),
            },
            produces: ['paramPath'],
          }),
          step.cli({
            id: 'deploy',
            title: 'Deploy the access contract',
            detail: 'Creates the product, the subscription, the product policy and the Key Vault secrets.',
            command: {
              executable: 'az',
              args: [
                'deployment',
                'sub',
                'create',
                '--name',
                deploymentName,
                '--location',
                ctx.get('hub.location'),
                '--template-file',
                `${ctx.self('accessBicepDir')}/main.bicep`,
                '--parameters',
                paramPath,
                '--subscription',
                ctx.get('hub.subscriptionId'),
                '-o',
                'json',
              ],
            },
            produces: ['provisioningState', 'endpoints', 'subscriptions'],
          }),
          step.library({
            id: 'key-fallback',
            title: 'Fallback: read the subscription primary key',
            detail:
              'Only when the deployment outputs carry no `apiKey`. Reported explicitly so it is clear which path produced the key.',
            library: {
              runtime: 'python>=3.10',
              packages: ['azure-mgmt-apimanagement'],
              entry: 'ApiManagementClient.subscription.list_secrets',
              code: `secrets = _client.subscription.list_secrets(${JSON.stringify(ctx.get('hub.resourceGroupName'))}, ${JSON.stringify(ctx.get('hub.apimName'))}, ${JSON.stringify(contract.subscriptionName)})\napi_key = secrets.primary_key  # credential — do not print`,
              producesCredential: true,
              condition: 'deployment outputs did not contain endpoints[0].apiKey',
            },
            produces: ['apiKey'],
          }),
          step.assertion({
            id: 'assert-contract',
            title: 'Confirm the contract and record the secret names',
            detail: 'The key is held in memory only; the secret names are recorded into the Key Vault profile.',
            assertion: {
              kind: 'shape',
              source: '{{steps.deploy.subscriptions}}',
              expectations: [
                '`provisioningState` is `Succeeded`.',
                `The product \`${contract.productId}\` exists with subscription \`${contract.subscriptionName}\`.`,
                'An api-key is available from the outputs or from the documented fallback.',
                ctx.get('keyVault.useAccessContractKv')
                  ? `Key Vault publishing is on: one key secret plus ${contract.grantedApis.length} endpoint secrets are reported.`
                  : 'Key Vault publishing is off: credentials are returned as deployment outputs only.',
              ],
              secretHandling: `The key is referenced as ${secretRef('gatewayAccess.apiKey').ref}; its value never enters this plan.`,
            },
            produces: ['keySecretName', 'endpointSecretNames'],
          }),
        ],
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },

  {
    id: 'access-contract-kv-verify',
    group: 'publish-grant',
    title: 'Verify the Key Vault secrets',
    shortTitle: 'Verify KV secrets',
    summary: 'Confirm the shared api-key secret and every per-asset endpoint secret landed in the vault.',
    purpose:
      'The access contract is the only thing that writes those secrets, and a partial write is silent: the deployment still succeeds. This recipe checks both halves — the shared key and one endpoint per granted asset — so a contract owner knows they hold everything needed to reach every asset they were granted.',
    explanation: [
      'Two kinds of secret are written. One api-key secret holds the single shared credential. One endpoint secret per granted asset holds the URL that asset is reachable at, named `<code>-<bu>-<useCase>-<env>-<apiName>-endpoint`. The per-API naming is what stops two LLM front doors from overwriting each other — `universal-llm-api` resolves to `/models` while `azure-openai-api` resolves to `/openai`, and a shared name would leave whichever wrote last.',
      'Both the key secret and endpoint secrets are checked by length only. Endpoint names are configurable inputs, so returning a raw value could disclose an unrelated vault secret if a name were changed. A positive length is enough to prove each expected secret is present without returning any value to the browser.',
      'Reading these secrets requires Key Vault Secrets User (or Secrets Officer) on the vault, and the vault may be in a different subscription from the hub. `az keyvault secret show` uses the data plane, so a role assignment on the resource group is not sufficient by itself.',
    ],
    flow: [
      'Read the shared api-key secret and confirm it is present and non-empty, without printing its value.',
      'Measure each endpoint secret and confirm it is non-empty without returning its value.',
      'Pass only when the key secret AND every endpoint secret are present.',
    ],
    prerequisites: [
      {
        id: 'contract-deployed',
        title: 'The access contract was deployed with Key Vault publishing on',
        detail: 'Without it there are no secrets to verify and this recipe has nothing to check.',
        howTo: 'Run Publish and grant › Deploy the mixed access contract with `Publish contract secrets to Key Vault` on.',
        links: [LINKS.keyVaultRbac],
      },
      {
        id: 'secret-names',
        title: 'The reported secret names',
        detail:
          'Verify the names the deployment actually reported, not the requested `apiKeySecretName`. They differ: the contract auto-generates the endpoint names.',
        howTo: 'Copy `keyVaultApiKeySecretName` and `keyVaultEndpointSecretNames` from the access-contract outputs into the Key Vault profile.',
        links: [LINKS.azKeyVaultSecretShow],
      },
      {
        id: 'kv-reader',
        title: 'Key Vault Secrets User on the vault',
        detail: 'A data-plane role. Management-plane access to the vault resource does not grant secret reads.',
        howTo: 'Assign Key Vault Secrets User at the vault scope.',
        links: [LINKS.keyVaultRbac],
      },
    ],
    usesProfiles: ['hub', 'keyVault'],
    fields: [],
    configuration: [
      mandatory('keyVault.name', 'The vault every `az keyvault secret show` in this recipe reads from.'),
      optional(
        'keyVault.subscriptionId',
        'Binds every secret read to an external Key Vault subscription when supplied.',
        'Left blank, the validated Hub profile subscription is used.',
      ),
      conditional(
        'hub.subscriptionId',
        'Provides the validated subscription binding when no external Key Vault subscription override is supplied.',
        'The Key Vault subscription override is blank.',
        { field: 'keyVault.subscriptionId', blank: true },
      ),
      generated(
        'keyVault.keySecretName',
        'The shared api-key secret whose presence is proved without printing its value.',
        'Left blank the plan shows a placeholder name and the run is blocked on that step rather than reading an invented secret.',
        'Produced by Publish and grant › Deploy the mixed access contract.',
      ),
      generated(
        'keyVault.endpointSecretNames',
        'One endpoint secret per granted asset; each becomes its own read step.',
        'Left empty the recipe reports inconclusive rather than passing on an empty set.',
        'Produced by Publish and grant › Deploy the mixed access contract.',
      ),
    ],
    runtime: {
      dependencies: ['azure-cli'],
      note: 'Key Vault data-plane reads. Needs Key Vault Secrets User on the vault, which management-plane access does not grant.',
    },
    risk: {
      level: 'read-only',
      effect: 'Reads Key Vault secrets. Nothing is written or deleted.',
      blastRadius: 'None, but the reads are recorded in the vault`s audit log.',
      reversibility: 'Not applicable.',
    },
    sourceCells: [18],
    sourceNote:
      'Cell 18 reads the key secret and each endpoint secret, then records a single boolean for the endpoint secrets only.',
    expectedResults: [
      {
        id: 'key-secret-present',
        title: 'The shared api-key secret exists and is non-empty',
        assertion: '`az keyvault secret show` for the reported key secret name returns a value of non-zero length.',
        evidence: 'The length of the secret value; never the value itself.',
        whenNotRun: 'Not run — the shared key`s presence in the vault is unknown.',
      },
      {
        id: 'endpoint-secrets-present',
        title: 'Every endpoint secret exists and is non-empty',
        assertion: 'One endpoint secret per granted asset returns a positive value length.',
        evidence: 'The endpoint value lengths; never the values.',
        whenNotRun: 'Not run.',
      },
      {
        id: 'both-required',
        title: 'The overall result requires both halves',
        assertion:
          'The recipe passes only when the key secret AND all endpoint secrets pass. A missing key secret with intact endpoints is a failure.',
        evidence: 'The combined assertion.',
        whenNotRun: 'Not run.',
      },
    ],
    deviations: [
      'The notebook prints the key secret`s status but excludes it from `results["access-contract-kv-secrets"]`, which is computed from the endpoint secrets alone. A run with a missing key secret and intact endpoints reads as a pass there. This recipe requires both.',
      'The notebook reads the api-key secret`s value with `--query value -o tsv`, printing a live credential to the terminal. This recipe asks for `length(value)` instead.',
      'The notebook re-reads every endpoint secret a second time to compute its boolean, doubling the number of vault calls. This recipe reads each secret once.',
    ],
    notes: [
      'When the reported endpoint secret names list is empty, this recipe reports `inconclusive` rather than passing on an empty set — the notebook`s `all()` over an empty list would otherwise be vacuously true if the leading `bool()` guard were removed.',
    ],
    build(ctx) {
      const vaultName = ctx.get('keyVault.name');
      const vaultSubscriptionOverride = ctx.get('keyVault.subscriptionId');
      const vaultSubscriptionId = isBlank(vaultSubscriptionOverride)
        ? ctx.get('hub.subscriptionId')
        : vaultSubscriptionOverride;
      const keySecretName = ctx.get('keyVault.keySecretName');
      const endpointNames = ctx.get('keyVault.endpointSecretNames') ?? [];
      const steps = [
        step.cli({
          id: 'read-key-secret',
          title: 'Confirm the shared api-key secret is present',
          detail: 'Asks for the length of the value, so a live credential is never printed.',
          command: {
            executable: 'az',
            args: [
              'keyvault',
              'secret',
              'show',
              '--vault-name',
              vaultName,
              '--name',
              keySecretName || '<keyVaultApiKeySecretName from the contract outputs>',
              '--subscription',
              vaultSubscriptionId,
              '--query',
              'length(value)',
              '-o',
              'tsv',
            ],
            note: 'Deliberately does not use `--query value`: presence is provable without disclosure.',
          },
          produces: ['keySecretLength'],
        }),
      ];
      for (const [index, name] of endpointNames.entries()) {
        steps.push(
          step.cli({
            id: `read-endpoint-${index + 1}`,
            title: `Read endpoint secret ${name}`,
            detail: 'Asks only for the value length so a changed secret name cannot disclose an unrelated secret.',
            command: {
              executable: 'az',
              args: [
                'keyvault',
                'secret',
                'show',
                '--vault-name',
                vaultName,
                '--name',
                name,
                '--subscription',
                vaultSubscriptionId,
                '--query',
                'length(value)',
                '-o',
                'tsv',
              ],
            },
            produces: ['endpointValue'],
          }),
        );
      }
      steps.push(
        step.assertion({
          id: 'assert-secrets',
          title: 'Require the key secret and every endpoint secret',
          detail: 'Both halves, unlike the notebook`s endpoint-only roll-up.',
          assertion: {
            kind: 'all',
            source: '{{steps.read-key-secret.keySecretLength}}',
            expectations: [
              'The api-key secret returns a length greater than zero.',
              endpointNames.length > 0
                ? `All ${endpointNames.length} endpoint secrets return a positive value length.`
                : 'No endpoint secret names are recorded yet — the result is inconclusive, not a pass.',
              'One endpoint secret exists per granted asset.',
            ],
          },
          produces: ['secretsVerified'],
        }),
      );
      return createExecutionPlan({
        sampleId: 'access-contract-kv-verify',
        title: 'Verify the Key Vault secrets',
        summary: 'Check the shared api-key secret and every per-asset endpoint secret.',
        risk: ctx.risk,
        sourceCells: [18],
        steps,
        expectedResults: ctx.expectedResults,
        notes: ctx.notes,
        deviations: ctx.deviations,
      });
    },
  },
];
