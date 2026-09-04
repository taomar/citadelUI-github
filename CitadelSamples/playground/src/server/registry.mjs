/**
 * The operation registry.
 *
 * Two allowlists, both keyed by the catalogue's own sample and step ids:
 *
 *   AZ_OPERATIONS     which `az` verb chains may be spawned, and how each one's
 *                     stdout maps onto the outputs its plan step declares;
 *   PYTHON_WRAPPERS   which shipped script may be run for a `library` step, and
 *                     which validated inputs become its parameters.
 *
 * The plan is already rebuilt server-side, so its arguments are trusted. This
 * registry is a deliberate *second* gate: a future catalogue edit cannot
 * introduce `az vm delete` or a new Python snippet without also being added
 * here, in review, by hand.
 *
 * Nothing here ever executes a string. `az` receives an argument array with
 * `shell: false`, and a `library` step runs a fixed file from
 * `runtime/python/`, never generated source.
 */

/** Trailing `-3` becomes `-*` so repeated steps share one registry entry. */
export function normaliseStepId(stepId) {
  return String(stepId).replace(/-\d+$/, '-*');
}

export function registryKey(sampleId, stepId) {
  return `${sampleId}/${normaliseStepId(stepId)}`;
}

const json = (text) => {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  return JSON.parse(trimmed);
};
const tsv = (text) => String(text ?? '').trim();

/** `az` operations this playground may run, and what their output means. */
export const AZ_OPERATIONS = Object.freeze({
  'azure-context-check/account-show': {
    verbs: ['account', 'show'],
    parse: 'json',
    summary: 'Read the signed-in Azure CLI account.',
    map: (data) => ({
      outputs: {
        subscriptionId: data?.id ?? '',
        subscriptionName: data?.name ?? '',
        userName: data?.user?.name ?? '',
        tenantId: data?.tenantId ?? '',
      },
      evidence: {
        subscriptionId: data?.id ?? '',
        subscriptionName: data?.name ?? '',
        user: data?.user?.name ?? '',
        tenantId: data?.tenantId ?? '',
      },
    }),
  },

  'apim-discovery/list-services': {
    verbs: ['apim', 'list'],
    parse: 'json',
    summary: 'List API Management services in the resource group.',
    map: (data) => {
      const services = Array.isArray(data) ? data : [];
      return {
        outputs: { services, serviceCount: services.length },
        evidence: { serviceCount: services.length, names: services.map((service) => service?.name ?? '') },
      };
    },
  },

  'apim-discovery/show-service': {
    verbs: ['apim', 'show'],
    parse: 'json',
    summary: 'Read the selected API Management service.',
    map: (data) => ({
      outputs: { apimName: data?.name ?? '', gatewayUrl: data?.gatewayUrl ?? '', sku: data?.sku ?? '' },
      evidence: { name: data?.name ?? '', gatewayUrl: data?.gatewayUrl ?? '', sku: data?.sku ?? '' },
      configurationUpdates: {
        'hub.apimName': data?.name ?? '',
        'hub.gatewayUrl': data?.gatewayUrl ?? '',
      },
    }),
  },

  'foundry-enable-a2a/acquire-token': {
    verbs: ['account', 'get-access-token'],
    parse: 'tsv',
    credential: true,
    summary: 'Mint a Foundry data-plane token.',
    map: (text) => ({
      outputs: { accessToken: text },
      // Length only. The token itself never reaches evidence, a log, or a result.
      evidence: { tokenAcquired: text.length > 0, tokenLength: text.length },
    }),
  },

  'apim-foundry-grant/read-identity': {
    verbs: ['apim', 'show'],
    parse: 'json',
    summary: 'Read the API Management identity block.',
    map: (data) => ({
      outputs: { identity: data ?? null },
      evidence: {
        type: data?.type ?? '(none)',
        userAssigned: Object.keys(data?.userAssignedIdentities ?? {}).length,
        hasSystemAssigned: Boolean(data?.principalId),
      },
    }),
  },

  'apim-foundry-grant/find-account': {
    verbs: ['cognitiveservices', 'account', 'list'],
    parse: 'tsv',
    summary: 'Resolve the Foundry account resource id.',
    map: (text) => {
      const ids = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return {
        outputs: { accountResourceId: ids.length === 1 ? ids[0] : '' },
        evidence: { matches: ids.length, accountResourceId: ids.length === 1 ? ids[0] : '' },
        configurationUpdates: ids.length === 1 ? { 'foundry.accountResourceId': ids[0] } : {},
      };
    },
  },

  'apim-foundry-grant/assign-role': {
    verbs: ['role', 'assignment', 'create'],
    parse: 'json',
    summary: 'Create the role assignment.',
    map: (data) => ({
      outputs: { assignmentId: data?.id ?? '' },
      evidence: { assignmentId: data?.id ?? '', role: data?.roleDefinitionName ?? '', scope: data?.scope ?? '' },
    }),
  },

  'apim-foundry-grant/verify-assignment': {
    verbs: ['role', 'assignment', 'list'],
    parse: 'json',
    summary: 'Read the assignment back at the same scope.',
    map: (data) => {
      const assignments = Array.isArray(data) ? data : [];
      return { outputs: { assignments }, evidence: { count: assignments.length, assignments } };
    },
  },

  'weather-api-ensure/*': null, // Python-backed; see PYTHON_WRAPPERS.

  'publish-assets/deploy': {
    verbs: ['deployment', 'sub', 'create'],
    parse: 'json',
    summary: 'Deploy the publish contract at subscription scope.',
    map: (data) => {
      const outputs = data?.properties?.outputs ?? {};
      const published = outputs?.publishedAssets?.value ?? [];
      const updates = {};
      for (const asset of Array.isArray(published) ? published : []) {
        if (asset?.name === 'weather-tool' && asset?.endpoint) {
          updates['samples.weather-mcp-discovery.deployedEndpoint'] = asset.endpoint;
          updates['samples.weather-tools-call.deployedEndpoint'] = asset.endpoint;
          updates['samples.tool-rate-limit-burst.deployedEndpoint'] = asset.endpoint;
        }
        if (asset?.name === 'ms-learn-tool' && asset?.endpoint) {
          updates['samples.learn-mcp-discovery.deployedEndpoint'] = asset.endpoint;
        }
        if (asset?.name === 'hr-chat-agent' && asset?.path) {
          updates['samples.a2a-agent-card.deployedPath'] = asset.path;
          updates['samples.a2a-message-send.deployedPath'] = asset.path;
          updates['samples.agent-framework-hr-question.deployedPath'] = asset.path;
          updates['samples.agent-rate-limit-burst.deployedPath'] = asset.path;
        }
      }
      return {
        outputs: { provisioningState: data?.properties?.provisioningState ?? '', publishedAssets: published },
        evidence: { provisioningState: data?.properties?.provisioningState ?? '', publishedAssets: published },
        configurationUpdates: updates,
      };
    },
  },

  'access-contract-deploy/list-apis': {
    verbs: ['apim', 'api', 'list'],
    parse: 'json',
    summary: 'List the APIs on the gateway.',
    map: (data, { inputs } = {}) => {
      const names = Array.isArray(data) ? data.filter((name) => typeof name === 'string') : [];
      const candidates = inputs?.['policy.candidateLlmApis'] ?? [];
      const existingLlm = candidates.filter((candidate) => names.includes(candidate));
      return {
        outputs: { existingApis: names },
        evidence: { apiCount: names.length, llmApisFound: existingLlm },
        configurationUpdates: { 'samples.access-contract-deploy.existingLlmApis': existingLlm },
      };
    },
  },

  'access-contract-deploy/deploy': {
    verbs: ['deployment', 'sub', 'create'],
    parse: 'json',
    credential: true, // the outputs carry the minted api-key
    summary: 'Deploy the access contract at subscription scope.',
    map: (data) => {
      const outputs = data?.properties?.outputs ?? {};
      const endpoints = outputs?.endpoints?.value ?? [];
      const subscriptions = outputs?.subscriptions?.value ?? [];
      const first = Array.isArray(subscriptions) ? subscriptions[0] : null;
      const mintedKey = Array.isArray(endpoints) ? endpoints[0]?.apiKey : null;
      return {
        outputs: { provisioningState: data?.properties?.provisioningState ?? '', endpoints, subscriptions },
        // Endpoint entries carry the api-key, so only the shape is evidence.
        evidence: {
          provisioningState: data?.properties?.provisioningState ?? '',
          endpointCount: Array.isArray(endpoints) ? endpoints.length : 0,
          keyReturned: typeof mintedKey === 'string' && mintedKey.length > 0,
          keySecretName: first?.keyVaultApiKeySecretName ?? '',
          endpointSecretNames: first?.keyVaultEndpointSecretNames ?? [],
        },
        configurationUpdates: {
          ...(first?.keyVaultApiKeySecretName ? { 'keyVault.keySecretName': first.keyVaultApiKeySecretName } : {}),
          ...(Array.isArray(first?.keyVaultEndpointSecretNames)
            ? { 'keyVault.endpointSecretNames': first.keyVaultEndpointSecretNames }
            : {}),
        },
        // Handed to the requesting browser as an explicitly-marked secret so the
        // in-memory store can use it. It never enters evidence or a log.
        secretUpdates: typeof mintedKey === 'string' && mintedKey.length > 0 ? { 'gatewayAccess.apiKey': mintedKey } : {},
      };
    },
  },

  'access-contract-kv-verify/read-key-secret': {
    verbs: ['keyvault', 'secret', 'show'],
    parse: 'tsv',
    summary: 'Prove the shared api-key secret exists, by length only.',
    map: (text) => ({
      outputs: { keySecretLength: Number.parseInt(text, 10) || 0 },
      evidence: { keySecretLength: Number.parseInt(text, 10) || 0 },
    }),
  },

  'access-contract-kv-verify/read-endpoint-*': {
    verbs: ['keyvault', 'secret', 'show'],
    parse: 'tsv',
    summary: 'Read one endpoint secret.',
    map: (text) => ({ outputs: { endpointValue: text }, evidence: { value: text } }),
  },

  'usage-metrics/list-components': {
    verbs: ['resource', 'list'],
    parse: 'json',
    summary: 'List Application Insights components.',
    map: (data) => {
      const names = Array.isArray(data) ? data.filter((name) => typeof name === 'string') : [];
      return { outputs: { components: names }, evidence: { components: names } };
    },
  },

  'usage-metrics/query-metrics': {
    verbs: ['monitor', 'app-insights', 'query'],
    parse: 'json',
    summary: 'Run the bounded usage query.',
    map: (data) => {
      const rows = data?.tables?.[0]?.rows ?? [];
      return { outputs: { rows }, evidence: { rowCount: rows.length, rows: rows.slice(0, 20) } };
    },
  },

  'circuit-breaker-check/read-backend-*': {
    verbs: ['rest'],
    rest: { methods: ['get'] },
    parse: 'json',
    summary: 'Read one backend and its circuit breaker.',
    map: (data) => ({
      outputs: { backend: data ?? null, circuitBreaker: data?.properties?.circuitBreaker ?? null },
      evidence: { name: data?.name ?? '', circuitBreaker: data?.properties?.circuitBreaker ?? null },
    }),
  },

  'cleanup/delete-subscription': {
    verbs: ['rest'],
    rest: { methods: ['delete'] },
    parse: 'none',
    summary: 'Delete the APIM subscription.',
    map: () => ({ outputs: { subscriptionDeleted: true }, evidence: { deleted: true } }),
  },
  'cleanup/delete-product': {
    verbs: ['apim', 'product', 'delete'],
    parse: 'none',
    summary: 'Delete the access-contract product.',
    map: () => ({ outputs: { productDeleted: true }, evidence: { deleted: true } }),
  },
  'cleanup/delete-api-*': {
    verbs: ['apim', 'api', 'delete'],
    parse: 'none',
    summary: 'Delete one published API.',
    map: () => ({ outputs: { apiDeleted: true }, evidence: { deleted: true } }),
  },
  'cleanup/delete-backend-*': {
    verbs: ['rest'],
    rest: { methods: ['delete'] },
    parse: 'none',
    summary: 'Delete one published backend.',
    map: () => ({ outputs: { backendDeleted: true }, evidence: { deleted: true } }),
  },
  'cleanup/delete-source-api': {
    verbs: ['apim', 'api', 'delete'],
    parse: 'none',
    summary: 'Delete the `weather-api` source API.',
    map: () => ({ outputs: { sourceApiDeleted: true }, evidence: { deleted: true } }),
  },
});

export const PARSERS = Object.freeze({ json, tsv, none: () => null });

/**
 * Validate one rebuilt `azure-cli` step against the registry.
 * Throws rather than returning a soft failure: an unknown operation is a
 * programming error, not a runtime condition.
 */
export function resolveAzOperation(sampleId, step) {
  const entry = AZ_OPERATIONS[registryKey(sampleId, step.id)];
  if (!entry) {
    throw new Error(`No approved az operation is registered for ${sampleId}/${step.id}.`);
  }
  const command = step.command ?? {};
  if (command.executable !== 'az') {
    throw new Error(`${sampleId}/${step.id} names executable "${command.executable}", but only \`az\` is approved here.`);
  }
  const args = command.args ?? [];
  const verbs = entry.verbs;
  const prefix = args.slice(0, verbs.length);
  if (prefix.join(' ') !== verbs.join(' ')) {
    throw new Error(
      `${sampleId}/${step.id} would run \`az ${prefix.join(' ')}\`, but only \`az ${verbs.join(' ')}\` is approved for it.`,
    );
  }
  if (entry.rest) {
    const methodIndex = args.indexOf('--method');
    const method = methodIndex >= 0 ? String(args[methodIndex + 1]).toLowerCase() : '';
    if (!entry.rest.methods.includes(method)) {
      throw new Error(`${sampleId}/${step.id} uses \`az rest --method ${method || '(none)'}\`, which is not approved.`);
    }
    const uriIndex = args.indexOf('--uri');
    const uri = uriIndex >= 0 ? String(args[uriIndex + 1]) : '';
    if (!uri.startsWith('/subscriptions/')) {
      throw new Error(`${sampleId}/${step.id} would call \`az rest\` on "${uri}", which is not an ARM resource path.`);
    }
  }
  return entry;
}

/**
 * `library` steps, mapped onto shipped Python wrappers.
 *
 * Each wrapper is a file in `runtime/python/`. Parameters are built from the
 * inputs the server already validated, so the generated Python source in the
 * plan is a *preview* and is never the thing that runs.
 */
export const PYTHON_WRAPPERS = Object.freeze({
  'weather-api-ensure/upsert-api': {
    script: 'apim_weather_api.py',
    modules: ['azure.mgmt.apimanagement', 'azure.identity'],
    summary: 'Upsert `weather-api` and its mock policy through the management SDK.',
    params: ({ inputs }) => ({
      action: 'upsert',
      subscriptionId: inputs['hub.subscriptionId'] ?? '',
      resourceGroup: inputs['hub.resourceGroupName'],
      serviceName: inputs['hub.apimName'],
      apiId: inputs['samples.weather-api-ensure.apiId'],
      apiPath: inputs['samples.weather-api-ensure.apiPath'],
      displayName: inputs['samples.weather-api-ensure.displayName'],
      keyHeader: inputs['gatewayAccess.weatherSourceKeyHeader'],
      specPath: inputs['samples.weather-api-ensure.specPath'],
      policyPath: inputs['samples.weather-api-ensure.policyPath'],
    }),
    workspacePaths: ['specPath', 'policyPath'],
    map: (data) => ({ outputs: { apiId: data?.apiId ?? '' }, evidence: { apiId: data?.apiId ?? '' } }),
  },

  'weather-api-ensure/list-operations': {
    script: 'apim_weather_api.py',
    modules: ['azure.mgmt.apimanagement', 'azure.identity'],
    summary: 'List the API`s operations.',
    params: ({ inputs }) => ({
      action: 'list-operations',
      subscriptionId: inputs['hub.subscriptionId'] ?? '',
      resourceGroup: inputs['hub.resourceGroupName'],
      serviceName: inputs['hub.apimName'],
      apiId: inputs['samples.weather-api-ensure.apiId'],
    }),
    map: (data) => ({
      outputs: { operationNames: data?.operationNames ?? [] },
      evidence: { operationNames: data?.operationNames ?? [] },
    }),
  },

  'access-contract-deploy/key-fallback': {
    script: 'apim_subscription_key.py',
    modules: ['azure.mgmt.apimanagement', 'azure.identity'],
    credential: true,
    summary: 'Read the subscription primary key, only when the deployment returned none.',
    skipWhen: ({ outputs }) => Boolean(outputs.get('deploy.__keyReturned')),
    skipReason: 'The deployment outputs already carried an api-key, so the documented fallback was not needed.',
    params: ({ inputs, contract }) => ({
      subscriptionId: inputs['hub.subscriptionId'] ?? '',
      resourceGroup: inputs['hub.resourceGroupName'],
      serviceName: inputs['hub.apimName'],
      subscriptionName: contract?.subscriptionName ?? '',
    }),
    map: (data) => ({
      outputs: { apiKey: data?.apiKey ?? '' },
      evidence: { keyRead: Boolean(data?.apiKey) },
      secretUpdates: data?.apiKey ? { 'gatewayAccess.apiKey': data.apiKey } : {},
    }),
  },

  'agent-framework-hr-question/ask-agent': {
    script: 'agent_framework_ask.py',
    modules: ['httpx', 'nest_asyncio', 'a2a.client', 'agent_framework.a2a'],
    summary: 'Resolve the published card and run one agent turn.',
    secretEnv: { CITADEL_GATEWAY_ACCESS_API_KEY: 'gatewayAccess.apiKey' },
    // The URL comes from the plan the SERVER rebuilt — the assertion step
    // records the endpoint the builder derived — never from the request and
    // never by parsing the generated Python preview.
    params: ({ inputs, plan }) => ({
      agentUrl: plan?.steps?.find((step) => step.id === 'assert-answer')?.assertion?.endpoint ?? '',
      apiKeyHeader: inputs['gatewayAccess.subscriptionKeyHeader'],
      cardPath: '/.well-known/agent.json',
      question: inputs['samples.agent-framework-hr-question.question'],
      timeoutSeconds: inputs['samples.agent-framework-hr-question.timeoutSeconds'],
    }),
    map: (data) => ({
      outputs: { answer: data?.answer ?? '', card: data?.card ?? null },
      evidence: { answerLength: (data?.answer ?? '').length, cardName: data?.card?.name ?? '' },
    }),
  },
});

export function resolvePythonWrapper(sampleId, step) {
  const wrapper = PYTHON_WRAPPERS[registryKey(sampleId, step.id)];
  if (!wrapper) {
    throw new Error(`No approved Python wrapper is registered for ${sampleId}/${step.id}.`);
  }
  return wrapper;
}
