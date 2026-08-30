/**
 * Knowledge layer for the LLM backend onboarding parameter.
 *
 * `llmBackendConfig` is an untyped `array` in Bicep, so the compiler offers the
 * UI nothing: no allowed values, no per-provider requirements, no model names.
 * Everything a user needs to fill it in correctly lives in prose -- a 52 KB
 * README, a metadata block on the parameter, and a derivation expression buried
 * in a module. This file is that prose turned into data.
 *
 * Every entry below is traceable to source. Citations are given as
 * `file:line` relative to `bicep/infra/llm-backend-onboarding/`.
 *
 * The catalogue is a starting point, never a constraint: every dropdown in the
 * UI it feeds also accepts free text, because a model list in a repository is
 * stale the week after it is written.
 */

/* ------------------------------------------------------------------ auth */

/**
 * Auth types, verbatim from the `authType` line of the `llmBackendConfig`
 * metadata block (main.bicep:38) and the README table (README.md:117).
 */
export const AUTH_TYPES = [
  {
    id: 'managed-identity',
    label: 'Managed identity',
    summary: "APIM's user-assigned identity authenticates to the resource. No secret is stored.",
    needsAuthConfig: false,
    note: 'Grant the identity "Cognitive Services OpenAI User" for Azure OpenAI, or "Cognitive Services User" for Foundry, FLUX and MAI.',
  },
  {
    id: 'aws-sigv4',
    label: 'AWS SigV4',
    summary: 'Requests are signed with AWS Signature v4 using IAM keys held as APIM named values.',
    needsAuthConfig: false,
    note: 'Requires the awsAccessKey, awsSecretKey and awsRegion parameters to be supplied at deployment time.',
  },
  {
    id: 'api-key-bearer',
    label: 'API key — Bearer',
    summary: 'Sends `Authorization: Bearer <key>`.',
    needsAuthConfig: true,
  },
  {
    id: 'api-key-header',
    label: 'API key — header',
    summary: 'Sends the key in a provider-specific header (e.g. `api-key`).',
    needsAuthConfig: true,
  },
  {
    id: 'api-key-gemini',
    label: 'API key — Gemini',
    summary: 'Sends the key in the `x-goog-api-key` header expected by the native Gemini API.',
    needsAuthConfig: true,
  },
  {
    id: 'api-key-anthropic',
    label: 'API key — Anthropic',
    summary: 'Sends `x-api-key` plus the pinned `anthropic-version` header.',
    needsAuthConfig: true,
    note: 'The version comes from the anthropicVersion parameter (default 2023-06-01).',
  },
  {
    id: 'none',
    label: 'None',
    summary: 'No credential is attached. The backend is reached anonymously.',
    needsAuthConfig: false,
  },
];

/* -------------------------------------------------------------- providers */

/**
 * Backend types.
 *
 * The enum is the README's (README.md:115) because it is the current one: the
 * metadata block on the parameter (main.bicep:35) predates the image providers
 * and omits `azure-flux` / `azure-mai`.
 *
 * `defaultAuthType` mirrors the derivation expression in
 * `modules/llm-backends.bicep:84`, which is the only authority on what happens
 * when `authType` is omitted.
 */
export const BACKEND_TYPES = [
  {
    id: 'ai-foundry',
    usesDeploymentName: true,
    nameMeaning: 'Your DEPLOYMENT name, not the catalogue model name. The gateway routes to /deployments/{name}/, so it must match the deployment exactly as it appears in the Foundry resource.',
    label: 'Azure AI Foundry',
    group: 'Azure',
    summary: 'Microsoft Foundry project endpoints. Chat, embeddings and gpt-image.',
    endpointFormat: 'https://<resource>.cognitiveservices.azure.com/',
    endpointExample: 'https://aif-citadel-0.cognitiveservices.azure.com/',
    defaultAuthType: 'managed-identity',
    authTypes: ['managed-identity', 'api-key-header', 'api-key-bearer'],
    capabilities: ['chat', 'embeddings', 'image'],
    poolFamily: 'openai-compatible',
    notes: ['No URL rewriting is applied.'],
  },
  {
    id: 'azure-openai',
    usesDeploymentName: true,
    nameMeaning: 'Your DEPLOYMENT name, not the catalogue model name. The gateway rewrites the path to /deployments/{name}/, so it must match the deployment in the Azure OpenAI resource.',
    label: 'Azure OpenAI',
    group: 'Azure',
    summary: 'Azure OpenAI Service endpoints. The gateway rewrites the path to /deployments/{model}/.',
    endpointFormat: 'https://<resource>.openai.azure.com/',
    endpointExample: 'https://oai-citadel-0.openai.azure.com/',
    defaultAuthType: 'managed-identity',
    authTypes: ['managed-identity', 'api-key-header', 'api-key-bearer'],
    capabilities: ['chat', 'embeddings', 'image'],
    poolFamily: 'openai-compatible',
    notes: ['Automatic URL rewriting inserts /deployments/{model}/.'],
  },
  {
    id: 'azure-flux',
    nameMeaning: 'A label for this model. Routing uses modelPath (the Black Forest Labs slug), so the name is what clients send and what discovery reports.',
    label: 'Azure FLUX (Black Forest Labs)',
    group: 'Azure',
    summary: 'FLUX image models on a Foundry resource, reached over the native BFL surface.',
    endpointFormat: 'https://<resource>.services.ai.azure.com/',
    endpointExample: 'https://aif-citadel-0.services.ai.azure.com/',
    defaultAuthType: 'managed-identity',
    authTypes: ['managed-identity', 'api-key-header'],
    capabilities: ['image'],
    poolFamily: 'image',
    requiresModelPath: true,
    notes: [
      'Path is /providers/blackforestlabs/v1/{modelPath}?api-version=preview.',
      "Every model must set modelPath -- the BFL slug is not derivable from the model name.",
    ],
  },
  {
    id: 'azure-mai',
    nameMeaning: 'The MAI model id, sent in the request body. The path is fixed at /mai/v1/images/*, so this is not a deployment name.',
    label: 'Azure MAI (Microsoft)',
    group: 'Azure',
    summary: 'Microsoft MAI image models on a Foundry resource, over the native MAI surface.',
    endpointFormat: 'https://<resource>.services.ai.azure.com/',
    endpointExample: 'https://aif-citadel-0.services.ai.azure.com/',
    defaultAuthType: 'managed-identity',
    authTypes: ['managed-identity', 'api-key-header'],
    capabilities: ['image'],
    poolFamily: 'image',
    notes: ['Path is /mai/v1/images/generations and /mai/v1/images/edits; the model travels in the body.'],
  },
  {
    id: 'aws-bedrock',
    nameMeaning: 'The Bedrock model id, including its region prefix.',
    label: 'Amazon Bedrock (native)',
    group: 'Amazon',
    summary: 'Bedrock runtime over its native Converse API, signed with SigV4.',
    endpointFormat: 'https://bedrock-runtime.<aws-region>.amazonaws.com',
    endpointExample: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    defaultAuthType: 'aws-sigv4',
    authTypes: ['aws-sigv4'],
    capabilities: ['chat'],
    poolFamily: 'bedrock-native',
    requiredParams: ['awsAccessKey', 'awsSecretKey', 'awsRegion'],
    notes: [
      'Path is /model/{model-id}/converse.',
      'Without AWS credentials the named values are created as NOT_CONFIGURED and requests fail with 500 AWSCredentialsNotConfigured.',
    ],
  },
  {
    id: 'aws-bedrock-mantle',
    nameMeaning: 'The Bedrock model id served through the Mantle OpenAI-compatible surface.',
    label: 'Amazon Bedrock (OpenAI-compatible)',
    group: 'Amazon',
    summary: "Bedrock's OpenAI-compatible surface. Reachable from the unified chat API.",
    endpointFormat: 'https://bedrock-runtime.<aws-region>.amazonaws.com/openai/v1',
    endpointExample: 'https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1',
    defaultAuthType: 'api-key-bearer',
    authTypes: ['api-key-bearer', 'aws-sigv4'],
    capabilities: ['chat'],
    poolFamily: 'openai-compatible',
  },
  {
    id: 'gemini',
    nameMeaning: 'The Google model id.',
    label: 'Google Gemini (native)',
    group: 'Google',
    summary: 'Native Gemini generateContent API.',
    endpointFormat: 'https://generativelanguage.googleapis.com',
    endpointExample: 'https://generativelanguage.googleapis.com',
    defaultAuthType: 'api-key-gemini',
    authTypes: ['api-key-gemini'],
    capabilities: ['chat'],
    poolFamily: 'gemini-native',
  },
  {
    id: 'gemini-openai',
    nameMeaning: 'The Google model id, served through the OpenAI-compatible surface.',
    label: 'Google Gemini (OpenAI-compatible)',
    group: 'Google',
    summary: "Gemini's OpenAI-compatible surface. Reachable from the unified chat API.",
    endpointFormat: 'https://generativelanguage.googleapis.com/v1beta/openai',
    endpointExample: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultAuthType: 'api-key-bearer',
    authTypes: ['api-key-bearer'],
    capabilities: ['chat'],
    poolFamily: 'openai-compatible',
  },
  {
    id: 'anthropic',
    nameMeaning: 'The Anthropic API model id.',
    label: 'Anthropic (Messages API)',
    group: 'Anthropic',
    summary: 'Anthropic native Messages API, reached at /unified-ai/claude/v1/messages.',
    endpointFormat: 'https://api.anthropic.com',
    endpointExample: 'https://api.anthropic.com',
    defaultAuthType: 'api-key-anthropic',
    authTypes: ['api-key-anthropic'],
    capabilities: ['chat'],
    poolFamily: 'anthropic',
    requiredParams: ['anthropicVersion'],
  },
  {
    id: 'external',
    nameMeaning: 'Whatever id the endpoint advertises.',
    label: 'External / custom',
    group: 'Other',
    summary: 'Any other OpenAI-shaped endpoint. No URL rewriting, no derived credential.',
    endpointFormat: 'https://<host>/<base-path>',
    endpointExample: 'https://my-llm.example.com/v1',
    defaultAuthType: 'none',
    authTypes: ['none', 'api-key-bearer', 'api-key-header'],
    capabilities: ['chat', 'embeddings'],
    poolFamily: 'openai-compatible',
  },
];

/* ---------------------------------------------------------------- models */

const AZURE_OPENAI_HOSTS = ['ai-foundry', 'azure-openai'];

/**
 * Concrete models offered as starting points, with sensible property values.
 *
 * These are catalogue ids as Microsoft Foundry publishes them ("Foundry Models
 * sold by Azure" and "Foundry Models from partners and community"), so they
 * match what you see on a model card.
 *
 * They are a starting point, not the answer. For Azure OpenAI and Foundry the
 * value the gateway needs is the *deployment* name, which is chosen when the
 * model is deployed and frequently differs from the catalogue id -- a `gpt-4o`
 * model is routinely deployed as `gpt-4o-prod` or `chat-default`. Picking a
 * catalogue entry pre-fills format, version, SKU and API version correctly and
 * leaves the name editable, which is the point: the metadata is the part worth
 * looking up, the name is the part only the deployer knows.
 *
 * `backendTypes` keeps a provider honest: a model is only offered for the
 * providers that actually serve it, so the MAI backend offers MAI models and
 * nothing else.
 *
 * Providers add and retire models continuously, and quota, version and
 * retirement values differ per resource. Every field stays editable and the
 * picker accepts any id typed by hand.
 */
export const MODEL_CATALOG = [
  // -- Azure OpenAI / Foundry: OpenAI-format chat
  // -- Azure OpenAI / Foundry: OpenAI-format chat. Ids as Microsoft Foundry
  //    publishes them; the value the gateway needs is your deployment name.
  { name: 'gpt-5.6', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.6-sol', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.6-terra', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.6-luna', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.5', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.4', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.4-mini', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.4-nano', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.4-pro', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.3-chat', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.3-codex', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.2', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.2-chat', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.2-codex', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.1', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.1-chat', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.1-codex', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.1-codex-max', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5.1-codex-mini', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5-chat', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5-codex', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5-mini', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5-nano', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-5-pro', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'gpt-chat-latest', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'codex-mini', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'computer-use-preview', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'model-router', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },

  // -- Azure OpenAI / Foundry: image generation
  { name: 'gpt-image-2', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 10, modelVersion: '1' },
  { name: 'gpt-image-1.5', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 10, modelVersion: '1' },
  { name: 'gpt-image-1', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 10, modelVersion: '1' },
  { name: 'gpt-image-1-mini', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 10, modelVersion: '1' },
  { name: 'dall-e-3', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'Standard', capacity: 2, modelVersion: '3.0' },

  // -- Microsoft MAI, served through Foundry as chat. The azure-mai backend
  //    type is the native image surface (/mai/v1/images/*) and cannot carry
  //    these, so they route as ordinary Foundry models.
  { name: 'MAI-Thinking-1', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'MAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'MAI-Code-1-Flash', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'MAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'MAI-DS-R1', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'MAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  // -- Azure OpenAI / Foundry: reasoning models
  { name: 'o3', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '2025-04-16', apiVersion: '2025-04-01-preview', timeout: 300 },
  { name: 'o3-mini', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '2025-01-31', apiVersion: '2025-04-01-preview', timeout: 300 },
  { name: 'o4-mini', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '2025-04-16', apiVersion: '2025-04-01-preview', timeout: 300 },
  { name: 'o1', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '2024-12-17', timeout: 300 },
  { name: 'o1-mini', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '2024-09-12', timeout: 300 },

  // -- Foundry: non-OpenAI formats. These need inferenceApiVersion rather than
  //    apiVersion, because the request is not OpenAI-shaped.
  { name: 'DeepSeek-V4-Pro', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'DeepSeek', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'DeepSeek-V4-Flash', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'DeepSeek', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'DeepSeek-V3.2', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'DeepSeek', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'DeepSeek-R1', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'DeepSeek', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', retirementDate: '2099-12-30', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'DeepSeek-V3-0324', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'DeepSeek', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Phi-4', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Microsoft', sku: 'GlobalStandard', capacity: 1, modelVersion: '3', retirementDate: '2099-12-30', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Phi-4-mini-instruct', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Microsoft', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Phi-4-multimodal-instruct', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Microsoft', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'gpt-oss-120b', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'gpt-oss-20b', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'model-router', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'Llama-3.3-70B-Instruct', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Meta', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Llama-4-Maverick-17B-128E-Instruct-FP8', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Meta', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Mistral-Large-3', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Mistral AI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'mistral-medium-3-5', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Mistral AI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'mistral-ocr-4-0', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Mistral AI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'mistral-large', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Mistral AI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Mistral-Large-2411', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Mistral AI', sku: 'GlobalStandard', capacity: 1, modelVersion: '2', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Mistral-Small-2503', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Mistral AI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'Cohere-command-r-plus-08-2024', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Cohere', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'grok-4.6', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'xAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'grok-4.3', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'xAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'grok-4.1-fast-reasoning', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'xAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'grok-4.1-fast-non-reasoning', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'xAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'grok-4', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'xAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },
  { name: 'grok-code-fast-1', kind: 'chat', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'xAI', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },

  // -- Azure OpenAI / Foundry: embeddings
  { name: 'text-embedding-3-large', kind: 'embeddings', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1', retirementDate: '2027-04-14' },
  { name: 'text-embedding-3-small', kind: 'embeddings', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 100, modelVersion: '1' },
  { name: 'text-embedding-ada-002', kind: 'embeddings', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'Standard', capacity: 100, modelVersion: '2' },
  { name: 'Cohere-embed-v3-multilingual', kind: 'embeddings', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'Cohere', sku: 'GlobalStandard', capacity: 1, modelVersion: '1', inferenceApiVersion: '2024-05-01-preview' },

  // -- Azure OpenAI / Foundry: image
  { name: 'gpt-image-1.5', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 10, modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'gpt-image-1', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'GlobalStandard', capacity: 10, modelVersion: '1' },
  { name: 'dall-e-3', kind: 'image', backendTypes: AZURE_OPENAI_HOSTS, modelFormat: 'OpenAI', sku: 'Standard', capacity: 2, modelVersion: '3.0' },

  // -- FLUX image models. modelPath is mandatory and is not derivable.
  { name: 'FLUX.2-pro', kind: 'image', backendTypes: ['azure-flux'], modelFormat: 'BlackForestLabs', modelPath: 'flux-2-pro', modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'FLUX.2-flex', kind: 'image', backendTypes: ['azure-flux'], modelFormat: 'BlackForestLabs', modelPath: 'flux-2-flex', modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'FLUX.1-Kontext-pro', kind: 'image', backendTypes: ['azure-flux'], modelFormat: 'BlackForestLabs', modelPath: 'flux-kontext-pro', modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'FLUX-1.1-pro', kind: 'image', backendTypes: ['azure-flux'], modelFormat: 'BlackForestLabs', modelPath: 'flux-pro-1.1', modelVersion: '1', retirementDate: '2099-12-30' },

  // -- Microsoft MAI image models, on the native MAI surface.
  { name: 'MAI-Image-2', kind: 'image', backendTypes: ['azure-mai'], modelFormat: 'MAI', modelVersion: '2', retirementDate: '2099-12-30' },
  { name: 'MAI-Image-2.5-Pro', kind: 'image', backendTypes: ['azure-mai'], modelFormat: 'MAI', modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'MAI-Image-2.5', kind: 'image', backendTypes: ['azure-mai'], modelFormat: 'MAI', modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'MAI-Image-2.5-Flash', kind: 'image', backendTypes: ['azure-mai'], modelFormat: 'MAI', modelVersion: '1', retirementDate: '2099-12-30' },

  // -- Amazon Bedrock, native Converse surface. Ids carry the region prefix.
  { name: 'us.anthropic.claude-opus-4-8-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.anthropic.claude-sonnet-5-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.anthropic.claude-haiku-4-5-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '2', retirementDate: '2099-12-30' },
  { name: 'us.anthropic.claude-3-5-haiku-20241022-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.anthropic.claude-sonnet-4-20250514-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.anthropic.claude-opus-4-20250514-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.amazon.nova-premier-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Amazon', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.amazon.nova-pro-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Amazon', sku: 'OnDemand', capacity: 1, modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'us.amazon.nova-lite-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Amazon', sku: 'OnDemand', capacity: 1, modelVersion: '1', retirementDate: '2099-12-30' },
  { name: 'us.amazon.nova-micro-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Amazon', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'us.meta.llama3-3-70b-instruct-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Meta', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'mistral.mistral-large-2407-v1:0', kind: 'chat', backendTypes: ['aws-bedrock'], modelFormat: 'Mistral AI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'cohere.embed-english-v3', kind: 'embeddings', backendTypes: ['aws-bedrock'], modelFormat: 'Cohere', sku: 'OnDemand', capacity: 1, modelVersion: '3' },
  { name: 'amazon.titan-embed-text-v2:0', kind: 'embeddings', backendTypes: ['aws-bedrock'], modelFormat: 'Amazon', sku: 'OnDemand', capacity: 1, modelVersion: '2' },

  // -- Amazon Bedrock, OpenAI-compatible surface.
  { name: 'openai.gpt-oss-120b', kind: 'chat', backendTypes: ['aws-bedrock-mantle'], modelFormat: 'OpenAI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'openai.gpt-oss-20b', kind: 'chat', backendTypes: ['aws-bedrock-mantle'], modelFormat: 'OpenAI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },

  // -- Google Gemini, on both the native and OpenAI-compatible surfaces.
  { name: 'gemini-3.7-flash', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-3.6-flash', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-3.5-flash', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-3.1-pro', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-3-pro', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-3-flash', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-2.5-pro', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-2.5-flash', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-2.5-flash-lite', kind: 'chat', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gemini-embedding-001', kind: 'embeddings', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'text-embedding-004', kind: 'embeddings', backendTypes: ['gemini', 'gemini-openai'], modelFormat: 'Google', sku: 'OnDemand', capacity: 1, modelVersion: '4' },

  // -- Anthropic direct, on the native Messages API.
  { name: 'claude-opus-4-8', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'claude-sonnet-5', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'claude-opus-4-7', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'claude-opus-4-6', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'claude-haiku-4-5', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'claude-sonnet-4-6', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'claude-sonnet-4-5-20250929', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'claude-opus-4-1-20250805', kind: 'chat', backendTypes: ['anthropic'], modelFormat: 'Anthropic', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  // -- External / self-hosted OpenAI-compatible endpoints (vLLM, Ollama,
  //    TGI, LiteLLM and similar). Ids are whatever the server advertises, so
  //    these are the common defaults rather than a fixed list.
  { name: 'llama-3.3-70b-instruct', kind: 'chat', backendTypes: ['external'], modelFormat: 'Meta', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'llama-3.1-8b-instruct', kind: 'chat', backendTypes: ['external'], modelFormat: 'Meta', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'qwen2.5-72b-instruct', kind: 'chat', backendTypes: ['external'], modelFormat: 'OpenAI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'qwen2.5-coder-32b-instruct', kind: 'chat', backendTypes: ['external'], modelFormat: 'OpenAI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'mixtral-8x7b-instruct', kind: 'chat', backendTypes: ['external'], modelFormat: 'Mistral AI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'mistral-7b-instruct', kind: 'chat', backendTypes: ['external'], modelFormat: 'Mistral AI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'deepseek-r1-distill-llama-70b', kind: 'chat', backendTypes: ['external'], modelFormat: 'DeepSeek', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'phi-4', kind: 'chat', backendTypes: ['external'], modelFormat: 'Microsoft', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'gpt-oss-120b', kind: 'chat', backendTypes: ['external'], modelFormat: 'OpenAI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'nomic-embed-text', kind: 'embeddings', backendTypes: ['external'], modelFormat: 'OpenAI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
  { name: 'bge-m3', kind: 'embeddings', backendTypes: ['external'], modelFormat: 'OpenAI', sku: 'OnDemand', capacity: 1, modelVersion: '1' },
];

/** Values seen across the repository and its providers, offered as suggestions. */
export const MODEL_FORMATS = ['OpenAI', 'Microsoft', 'DeepSeek', 'Anthropic', 'Amazon', 'Google', 'Meta', 'Mistral AI', 'Cohere', 'xAI', 'BlackForestLabs', 'MAI'];
export const MODEL_SKUS = ['GlobalStandard', 'Standard', 'OnDemand', 'ProvisionedManaged', 'DataZoneStandard'];

/* ------------------------------------------------------- field descriptors */

/** Optional properties of a backend entry, in the order the UI shows them. */
export const BACKEND_FIELDS = [
  { key: 'backendId', type: 'string', required: true, label: 'Backend ID', help: 'Unique across the deployment. Becomes the APIM backend resource name.' },
  { key: 'backendType', type: 'enum', required: true, label: 'Provider', enumSource: 'backendTypes' },
  { key: 'endpoint', type: 'string', required: true, label: 'Endpoint', help: 'Base URL. The gateway appends the provider-specific path.' },
  { key: 'authType', type: 'enum', required: false, label: 'Authentication', enumSource: 'authTypes', help: 'Omit to accept the provider default.' },
  { key: 'priority', type: 'number', required: false, label: 'Priority', min: 1, max: 5, default: 1, help: 'Lower wins. Backends at the same priority share traffic by weight.' },
  { key: 'weight', type: 'number', required: false, label: 'Weight', min: 1, max: 1000, default: 100, help: 'Relative share of traffic within a priority tier.' },
];

/** Properties of one entry in `supportedModels`. */
export const MODEL_FIELDS = [
  { key: 'name', type: 'string', required: true, label: 'Deployment name', help: 'The id clients send, and the value the gateway puts in the /deployments/{model}/ URL. For Azure OpenAI and Foundry this is your DEPLOYMENT name, which is chosen when the model is deployed and is often not the catalogue model name. Copy it from the deployment, not from the model card. For providers that address models directly (Bedrock, Gemini, Anthropic) it is the provider\u2019s own model id.' },
  { key: 'modelPath', type: 'string', required: false, label: 'Model path', appliesTo: ['azure-flux'], help: 'Provider slug used in the URL. Required for FLUX.' },
  { key: 'sku', type: 'enum', required: false, label: 'SKU', options: MODEL_SKUS, default: 'Standard' },
  { key: 'capacity', type: 'number', required: false, label: 'Capacity', default: 100, min: 1, help: 'TPM quota reported by the discovery endpoint.' },
  { key: 'modelFormat', type: 'enum', required: false, label: 'Format', options: MODEL_FORMATS, default: 'OpenAI' },
  { key: 'modelVersion', type: 'string', required: false, label: 'Version', default: '1' },
  { key: 'retirementDate', type: 'date', required: false, label: 'Retires', help: 'YYYY-MM-DD. Surfaced to clients so they can migrate ahead of time.' },
  { key: 'apiVersion', type: 'string', required: false, label: 'API version', default: '2024-02-15-preview', help: 'Used for OpenAI-shaped requests.' },
  { key: 'inferenceApiVersion', type: 'string', required: false, label: 'Inference API version', help: 'For non-OpenAI formats such as DeepSeek or Microsoft.' },
  { key: 'timeout', type: 'number', required: false, label: 'Timeout (s)', default: 120, min: 1 },
  { key: 'sessionAwareModel', type: 'boolean', required: false, label: 'Stateful model', default: false, help: 'Gives multi-backend pools for this model a sticky affinity cookie.' },
];

/** Circuit breaker override keys (shallow-merged over circuitBreakerDefaults). */
export const CIRCUIT_BREAKER_FIELDS = [
  { key: 'enabled', type: 'boolean', label: 'Enabled', default: true, help: 'Set false to opt this backend out entirely.' },
  { key: 'failureCount', type: 'number', label: 'Failure count', default: 3, min: 1 },
  { key: 'failureInterval', type: 'string', label: 'Failure interval', default: 'PT5M', help: 'ISO 8601 duration.' },
  { key: 'tripDuration', type: 'string', label: 'Trip duration', default: 'PT1M', help: 'ISO 8601 duration.' },
  { key: 'acceptRetryAfter', type: 'boolean', label: 'Honour Retry-After', default: true },
];

export const SESSION_AFFINITY_FIELDS = [
  { key: 'cookieName', type: 'string', label: 'Cookie name', default: 'ai-gateway-affinity' },
  { key: 'source', type: 'enum', label: 'Source', options: ['Cookie'], default: 'Cookie' },
];

/* ------------------------------------------------------------- derivation */

export function backendType(id) {
  return BACKEND_TYPES.find((b) => b.id === id) || null;
}

export function authTypeInfo(id) {
  return AUTH_TYPES.find((a) => a.id === id) || null;
}

/** The authType that applies when the property is omitted (llm-backends.bicep:84). */
export function effectiveAuthType(entry) {
  if (entry && entry.authType) return entry.authType;
  const type = backendType(entry && entry.backendType);
  return type ? type.defaultAuthType : 'managed-identity';
}

/** Models worth suggesting for a provider, most specific first. */
export function catalogFor(backendTypeId) {
  return MODEL_CATALOG.filter((m) => m.backendTypes.includes(backendTypeId));
}

/**
 * The catalogue entry a configured name corresponds to, if any.
 *
 * On the Azure surfaces the configured value is a deployment name, which is
 * free-form -- `gpt-4o` may well be deployed as `chat-prod`. Matching lets the
 * UI say which Foundry model a deployment refers to when the name still looks
 * like a catalogue id, and stay quiet rather than guess when it does not.
 */
/**
 * Models that can be deployed into an Azure AI Foundry resource.
 *
 * `aiFoundryModelsConfig` in the main deployment creates model deployments on a
 * Foundry resource, so the choice is not the whole gateway catalogue: AWS
 * Bedrock, Gemini, Anthropic and self-hosted endpoints are backends the gateway
 * *calls*, never things Foundry hosts. FLUX and MAI image models do belong --
 * the onboarding README describes both as "hosted on a Microsoft Foundry
 * resource", they simply answer on their own native surfaces once deployed.
 */
const FOUNDRY_HOSTS = ['ai-foundry', 'azure-flux', 'azure-mai'];

export function foundryCatalog() {
  const seen = new Set();
  const out = [];
  for (const host of FOUNDRY_HOSTS) {
    for (const model of catalogFor(host)) {
      if (seen.has(model.name)) continue;
      seen.add(model.name);
      out.push(model);
    }
  }
  return out;
}

export function catalogEntry(name, backendTypeId) {
  if (!name) return null;
  const wanted = String(name).toLowerCase();
  return (
    catalogFor(backendTypeId).find((m) => m.name.toLowerCase() === wanted) || null
  );
}

/**
 * A ready-to-write backend entry for a provider, using the provider's own
 * example values. Only required properties plus the two routing knobs are
 * included -- everything else is defaulted by the module, and writing defaults
 * explicitly is noise in a file that people read.
 */
export function backendTemplate(backendTypeId) {
  const type = backendType(backendTypeId);
  if (!type) return null;
  return {
    backendId: `${backendTypeId}-1`,
    backendType: type.id,
    endpoint: type.endpointExample,
    authType: type.defaultAuthType,
    supportedModels: [],
    priority: 1,
    weight: 100,
  };
}

/** A model object pre-filled from the catalogue, or a bare one for free text. */
export function modelTemplate(name, backendTypeId) {
  const known = MODEL_CATALOG.find(
    (m) => m.name === name && m.backendTypes.includes(backendTypeId)
  );
  if (!known) {
    const type = backendType(backendTypeId);
    const bare = { name, modelFormat: 'OpenAI', modelVersion: '1' };
    if (type && type.requiresModelPath) bare.modelPath = '';
    return bare;
  }
  const out = { name: known.name };
  if (known.modelPath) out.modelPath = known.modelPath;
  if (known.sku) out.sku = known.sku;
  if (known.capacity != null) out.capacity = known.capacity;
  out.modelFormat = known.modelFormat;
  out.modelVersion = known.modelVersion;
  if (known.retirementDate) out.retirementDate = known.retirementDate;
  if (known.apiVersion) out.apiVersion = known.apiVersion;
  if (known.inferenceApiVersion) out.inferenceApiVersion = known.inferenceApiVersion;
  if (known.timeout != null) out.timeout = known.timeout;
  return out;
}

/**
 * Problems the Bicep compiler cannot report, because the parameter is an
 * untyped array. Returned as advisory findings -- the UI shows them, it does
 * not block on them, because a half-filled backend is a legitimate
 * intermediate state while editing.
 */
export function validateBackends(entries) {
  const findings = [];
  const ids = new Map();

  entries.forEach((entry, index) => {
    const where = { index, backendId: entry.backendId || `#${index + 1}` };
    const type = backendType(entry.backendType);

    if (!entry.backendId) {
      findings.push({ ...where, level: 'error', field: 'backendId', message: 'A backend ID is required.' });
    } else {
      const seen = ids.get(entry.backendId);
      if (seen !== undefined) {
        findings.push({ ...where, level: 'error', field: 'backendId', message: `Duplicate backend ID, already used by entry ${seen + 1}.` });
      }
      ids.set(entry.backendId, index);
    }

    if (!entry.backendType) {
      findings.push({ ...where, level: 'error', field: 'backendType', message: 'A provider is required.' });
    } else if (!type) {
      findings.push({ ...where, level: 'error', field: 'backendType', message: `"${entry.backendType}" is not a known provider.` });
    }

    if (!entry.endpoint) {
      findings.push({ ...where, level: 'error', field: 'endpoint', message: 'An endpoint is required.' });
    }

    const auth = effectiveAuthType(entry);
    const authInfo = authTypeInfo(auth);
    if (authInfo && authInfo.needsAuthConfig) {
      const key = entry.authConfig && entry.authConfig.namedValueKey;
      if (!key) {
        findings.push({
          ...where,
          level: 'error',
          field: 'authConfig',
          message: `${authInfo.label} needs an authConfig with a namedValueKey.`,
        });
      } else if (entry.authConfig.secretValue) {
        findings.push({
          ...where,
          level: 'warn',
          field: 'authConfig',
          message: 'secretValue stores the key in plain text and is for short-lived testing only. Prefer keyVaultSecretUri.',
        });
      }
    }

    if (!Array.isArray(entry.supportedModels)) {
      findings.push({ ...where, level: 'error', field: 'supportedModels', message: 'supportedModels is required (it may be an empty list).' });
    } else {
      if (entry.supportedModels.length === 0) {
        findings.push({ ...where, level: 'warn', field: 'supportedModels', message: 'This backend serves no models, so nothing routes to it.' });
      }
      entry.supportedModels.forEach((model, mi) => {
        if (!model || !model.name) {
          findings.push({ ...where, level: 'error', field: `supportedModels[${mi}]`, message: 'Every model needs a name.' });
          return;
        }
        if (type && type.requiresModelPath && !model.modelPath) {
          findings.push({
            ...where,
            level: 'error',
            field: `supportedModels[${mi}]`,
            message: `${model.name}: ${type.label} requires modelPath (the provider slug).`,
          });
        }
      });
    }

    if (entry.priority != null && (entry.priority < 1 || entry.priority > 5)) {
      findings.push({ ...where, level: 'error', field: 'priority', message: 'Priority must be between 1 and 5.' });
    }
    if (entry.weight != null && (entry.weight < 1 || entry.weight > 1000)) {
      findings.push({ ...where, level: 'error', field: 'weight', message: 'Weight must be between 1 and 1000.' });
    }

    if (type && type.requiredParams) {
      findings.push({
        ...where,
        level: 'info',
        field: 'deployment',
        message: `${type.label} also needs these top-level parameters set: ${type.requiredParams.join(', ')}.`,
      });
    }
  });

  return findings;
}

/**
 * Pools the onboarding module will create, predicted from the same rule it
 * uses: a pool exists for every (model, backendType) pair served by two or
 * more backends (llm-backend-pools.bicep:98). Showing this makes the
 * consequence of adding a model visible at edit time instead of at deploy time.
 */
export function predictPools(entries) {
  const buckets = new Map();

  entries.forEach((entry) => {
    if (!entry || !Array.isArray(entry.supportedModels)) return;
    entry.supportedModels.forEach((model) => {
      if (!model || !model.name) return;
      const key = `${model.name}\u0000${entry.backendType}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          model: model.name,
          backendType: entry.backendType,
          backends: [],
          sessionAware: false,
        });
      }
      const bucket = buckets.get(key);
      bucket.backends.push({
        backendId: entry.backendId,
        priority: entry.priority ?? 1,
        weight: entry.weight ?? 100,
      });
      // Session affinity is ORed across the pool: one flagged member is enough.
      if (model.sessionAwareModel === true) bucket.sessionAware = true;
    });
  });

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      pooled: bucket.backends.length > 1,
      poolName: bucket.backends.length > 1 ? poolName(bucket.model, bucket.backendType) : null,
      sessionAffinity: bucket.backends.length > 1 && bucket.sessionAware,
    }))
    .sort((a, b) => a.model.localeCompare(b.model) || a.backendType.localeCompare(b.backendType));
}

/** APIM resource names allow only letters, digits and hyphens. */
function poolName(model, type) {
  const clean = (s) => String(s).replace(/[.:_/]/g, '');
  return `${clean(model)}-${clean(type)}-backend-pool`;
}

/** Everything the browser needs, in one payload. */
export function llmSchema() {
  return {
    backendTypes: BACKEND_TYPES,
    authTypes: AUTH_TYPES,
    modelCatalog: MODEL_CATALOG,
    modelFormats: MODEL_FORMATS,
    modelSkus: MODEL_SKUS,
    backendFields: BACKEND_FIELDS,
    modelFields: MODEL_FIELDS,
    circuitBreakerFields: CIRCUIT_BREAKER_FIELDS,
    sessionAffinityFields: SESSION_AFFINITY_FIELDS,
  };
}
