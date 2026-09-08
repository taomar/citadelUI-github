import { serializeValue } from '../shared/bicepparam/serialize.mjs';

export const JOURNEY_MAIN = 'bicep/infra/main.bicepparam';
export const JOURNEY_LLM = 'bicep/infra/llm-backend-onboarding/main.bicepparam';
export const JOURNEY_ACCESS = 'bicep/infra/citadel-access-contracts';
export const JOURNEY_FINANCE = `${JOURNEY_ACCESS}/finance/main.bicepparam`;
export const JOURNEY_SUPPORT = `${JOURNEY_ACCESS}/support/main.bicepparam`;
export const oldAlias = (alias) => `archive/${alias}`;
export const JOURNEY_OLD_SECOND = 'archive/bicep/infra/resources.bicepparam';
const model = (name, capacity, extra = {}) => ({ name, capacity, modelVersion: '2026', modelFormat: 'OpenAI', ...extra });
const backend = (id, models, extra = {}) => ({
  backendId: id, backendType: 'ai-foundry', endpoint: `https://${id}.example.invalid/`,
  authType: 'managed-identity', priority: 1, weight: 100, supportedModels: models, ...extra,
});
export const journeyNewBackends = [
  backend('new-other', [model('chat', 7)]),
  backend('aaif-new', [model('target-only', 5), model('chat', 50, { timeout: 30, targetNote: 'keep' })], { targetExtra: true }),
];
export const journeyOldBackends = [
  backend('aif-old', [model('old-only', 20), model('chat', 90, { modelVersion: '2025' })]),
  backend('old-other', [model('chat', 999)]),
];
const llmText = (backends) => `using './main.bicep'\n// Preserve new backend order, endpoints and model identity.\nparam llmBackendConfig = ${serializeValue(backends)}\n`;
const accessText = (name, label) => `using '../main.bicep'\n// Existing ${name} contract, not a new instance.\nparam useCase = { name: '${name}' }\nparam productName = '${label}'\nparam subscriptionRequired = true\n`;
const accessSchema = 'param useCase object\nparam productName string\nparam subscriptionRequired bool\n';

/** Deliberately synthetic resolved old values; never claimed as runtime data. */
export const journeyTargetFiles = {
  [JOURNEY_MAIN]: "using './main.bicep'\n// ============================================================================\n// BASIC PARAMETERS\n// ============================================================================\nparam environmentName = 'new-environment'\nparam location = 'westus2'\nparam tags = { 'azd-env-name': 'new-environment' SecurityControl: 'Ignore' }\n// ============================================================================\n// FEATURE FLAGS - Deploy specific capabilities\n// ============================================================================\nparam enableAIModelInference = false\nparam enableAzureAISearch = false\n// ============================================================================\n// RESOURCE NAMES\n// ============================================================================\nparam aiFoundryInstances = readEnvironmentVariable('SYNTHETIC_UNRESOLVED_INSTANCES')\nparam aiFoundryModelsConfig = [{ aiserviceIndex: 0 }]\n",
  'bicep/infra/main.bicep': 'param environmentName string\nparam location string\nparam tags object\nparam enableAIModelInference bool\nparam enableAzureAISearch bool\nparam aiFoundryInstances array\nparam aiFoundryModelsConfig array\n',
  [JOURNEY_LLM]: llmText(journeyNewBackends),
  'bicep/infra/llm-backend-onboarding/main.bicep': 'param llmBackendConfig array\n',
  [JOURNEY_FINANCE]: accessText('finance', 'finance-new'),
  [JOURNEY_SUPPORT]: accessText('support', 'support-new'),
  [`${JOURNEY_ACCESS}/main.bicep`]: accessSchema,
};
export const journeySourceFiles = {
  [oldAlias(JOURNEY_MAIN)]: "using './main.bicep'\nparam environmentName = 'resolved-old'\nparam location = 'eastus2'\nparam enableAIModelInference = true\n",
  [oldAlias('bicep/infra/main.bicep')]: 'param environmentName string\nparam location string\nparam enableAIModelInference bool\n',
  [JOURNEY_OLD_SECOND]: "param environmentName = 'other-resolved-old'\nparam location = 'eastus2'\n",
  [oldAlias(JOURNEY_LLM)]: llmText(journeyOldBackends),
  [oldAlias('bicep/infra/llm-backend-onboarding/main.bicep')]: 'param llmBackendConfig array\n',
  [oldAlias(JOURNEY_FINANCE)]: accessText('finance', 'finance-old'),
  [oldAlias(JOURNEY_SUPPORT)]: accessText('support', 'support-old'),
  [oldAlias(`${JOURNEY_ACCESS}/main.bicep`)]: accessSchema,
  'ordinary.json': '{"not":"parameters"}',
  '.env': 'NEVER_READ_OR_UPLOAD',
};
