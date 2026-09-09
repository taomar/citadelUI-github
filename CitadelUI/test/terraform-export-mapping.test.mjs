import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SOURCE_MAPPING, TARGET_SHAPES, TERRAFORM_CONTRACT, EXPORT_AREAS, MONITOR_DEFAULTS, INSIGHTS_DEFAULTS,
  MAIN_INPUTS, MAIN_UNUSED, targetVariablesProblems,
} from '../shared/terraform-contract.mjs';
import { projectTerraformExport } from '../shared/terraform-export.mjs';
import { readBicepParameters } from '../shared/migration-input.mjs';
import { readMigrationSchema } from '../shared/migration-schema.mjs';
import { readTerraformSource } from '../web/js/terraform-export-session.mjs';
import { exportFixture, fixtureFiles, fixtureValues, fixtureChoices, FIXTURE_ACCESS_PATH, FIXTURE_POLICY, FIXTURE_POLICY_PATH } from './_terraform-export-fixture.mjs';

async function project(area, mutate = () => {}, choicesMutate = () => {}) {
  const values = fixtureValues();
  mutate(values[area], values);
  const fixture = exportFixture(fixtureFiles(values));
  const choices = fixtureChoices(values)[area];
  choicesMutate(choices);
  const path = EXPORT_AREAS.find((entry) => entry.id === area).path || FIXTURE_ACCESS_PATH;
  return projectTerraformExport(area, await readTerraformSource(fixture.provider, path), choices);
}

test('pinned explicit contract accounts for every checked-in source field and template declaration', async () => {
  const assigned = { deployment: 98, llm: 8, access: 17 };
  const declarations = { deployment: 100, llm: 13, access: 18 };
  const targets = { deployment: 113, llm: 11, access: 10 };
  assert.equal(TERRAFORM_CONTRACT.revision, 'b54f121b7df912da61cb0302a63b9f870841ac2c');
  assert.equal(TERRAFORM_CONTRACT.version, 'citadel-terraform-export-v1');
  for (const area of EXPORT_AREAS) {
    const path = area.path || 'bicep/infra/citadel-access-contracts/main.bicepparam';
    const text = await readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
    const schemaText = await readFile(new URL(`../../${path.replace(/\.bicepparam$/, '.bicep')}`, import.meta.url), 'utf8');
    const source = readBicepParameters(text);
    const schema = readMigrationSchema(schemaText);
    const mapped = SOURCE_MAPPING[area.id].map((entry) => entry.source);
    assert.equal(source.parameters.length, assigned[area.id]);
    assert.equal(schema.definitions.length, declarations[area.id]);
    assert.equal(mapped.length, declarations[area.id]);
    assert.equal(new Set(mapped).size, mapped.length);
    assert.deepEqual(new Set(schema.definitions.map((entry) => entry.name)), new Set(mapped));
    assert(source.parameters.every((entry) => mapped.includes(entry.name)));
    assert.equal(Object.keys(TARGET_SHAPES[area.id]).length, targets[area.id]);
    const projection = projectTerraformExport(area.id, { path, text, templateText: schemaText });
    assert.equal(projection.text, null);
    assert(projection.blockers.length > 0, 'Expression-heavy actual source must not receive invented environment fallbacks');
  }
});

test('reverse Main inventory is explicitly mapped, unused, or a visible export-only choice', () => {
  const used = new Set(SOURCE_MAPPING.deployment.flatMap((entry) => entry.target));
  for (const variable of Object.keys(TARGET_SHAPES.deployment)) {
    assert(used.has(variable) || MAIN_UNUSED.includes(variable) || MAIN_INPUTS.some((entry) => entry.name === variable),
      `No reverse decision for ${variable}`);
  }
});

test('compatible realistic fixtures produce all three independent target configurations', async () => {
  for (const area of EXPORT_AREAS) {
    const result = await project(area.id);
    assert.equal(result.blockers.length, 0, JSON.stringify(result.blockers));
    assert.equal(typeof result.text, 'string');
    assert.equal(result.rows.length, SOURCE_MAPPING[area.id].length);
    assert.deepEqual(targetVariablesProblems(area.id, result.output), []);
    assert(!result.text.includes('file('));
  }
});

test('fresh generation matches branch-independent golden values and the pinned variable-file paths', async () => {
  const folder = new URL('./fixtures/terraform-export/', import.meta.url);
  const expected = JSON.parse(await readFile(new URL('expected-values.json', folder), 'utf8'));
  assert.deepEqual(expected.contract, TERRAFORM_CONTRACT);
  for (const area of EXPORT_AREAS) {
    const result = await project(area.id);
    const golden = expected.areas[area.id];
    assert.equal(result.path, golden.path);
    assert.deepEqual(JSON.parse(JSON.stringify(result.output)), golden.values);
    assert.deepEqual(targetVariablesProblems(area.id, golden.values), []);
    assert.equal(result.text, await readFile(new URL(golden.path, folder), 'utf8'));
  }
});

test('source literals are distinct from required export inputs; template defaults do not require count equality', async () => {
  const fixture = exportFixture();
  const source = await readTerraformSource(fixture.provider, EXPORT_AREAS[0].path);
  const raw = projectTerraformExport('deployment', source);
  assert(raw.extras.find((row) => row.source === 'subscription_id').status === 'input');
  assert.equal(raw.output.subscription_id, undefined);
  assert.equal(raw.rows.find((row) => row.source === 'foundryNetworkInjectionEnabled').origin, 'Source template default');
  const fewer = { ...source, text: source.text.replace(/param location = '[^']+'\n/, '') };
  const ready = projectTerraformExport('deployment', fewer, fixtureChoices().deployment);
  assert.equal(ready.blockers.length, 0);
  assert.equal(ready.output.location, 'eastus2');
});

test('unknown parameters and incompatible nested properties block, never disappear', async () => {
  const fixture = exportFixture();
  const source = await readTerraformSource(fixture.provider, EXPORT_AREAS[0].path);
  const extra = projectTerraformExport('deployment', {
    ...source, text: `${source.text}\nparam newActiveFeature = true\n`,
    templateText: `${source.templateText}\nparam newActiveFeature bool = false\n`,
  }, fixtureChoices().deployment);
  assert.equal(extra.rows.find((row) => row.source === 'newActiveFeature').status, 'change');
  assert.equal(extra.text, null);
  const nested = await project('llm', (values) => { values.llmBackendConfig[0].supportedModels[0].api_version = 'different'; });
  assert.match(JSON.stringify(nested.blockers), /api_version/);
  assert.equal(nested.text, null);
});

test('one-to-many and coordinate maps use consumed properties, not name similarity', async () => {
  const main = await project('deployment', (values) => {
    values.enableAIGatewayPiiRedaction = true;
    values.useExistingLogAnalytics = true;
    values.existingLogAnalyticsName = 'shared-law';
    values.existingLogAnalyticsRG = 'shared-monitoring';
  });
  assert.equal(main.output.enable_pii_anonymization, true);
  assert(!Object.hasOwn(main.output, 'enable_ai_gateway_pii_redaction'));
  assert.equal(main.output.enable_redis_cache, false);
  assert.equal(main.output.enable_embeddings_backend, false);
  assert.match(main.output.existing_log_analytics_id, /resourceGroups\/shared-monitoring\/providers\/Microsoft.OperationalInsights\/workspaces\/shared-law$/);
  assert.equal(main.rows.find((row) => row.source === 'existingLogAnalyticsName').sources.length, 3);
  const llm = await project('llm');
  assert.equal(llm.output.apim_name, 'apim-export-demo');
  assert.equal(llm.rows.find((row) => row.source === 'apim').targets.length, 3);
});

test('unresolved source leaves accept only explicit typed export-only literals, not fallbacks', async () => {
  const fixture = exportFixture();
  const source = await readTerraformSource(fixture.provider, EXPORT_AREAS[0].path);
  source.text = source.text.replace("param location = 'eastus2'", "param location = readEnvironmentVariable('AZURE_LOCATION', 'westus')");
  const first = projectTerraformExport('deployment', source, fixtureChoices().deployment);
  assert.equal(first.output.location, undefined);
  assert.equal(first.rows.find((row) => row.source === 'location').status, 'input');
  const choices = { ...fixtureChoices().deployment, 'source:["location"]': 'eastus2' };
  const second = projectTerraformExport('deployment', source, choices);
  assert.equal(second.text !== null, true);
  assert.equal(second.output.location, 'eastus2');
  assert.match(second.rows.find((row) => row.source === 'location').notes[0].reason, /export-only/);
  assert.match(source.text, /readEnvironmentVariable/);
});

for (const [name, mutate, source] of [
  ['custom unwired resource name', (v) => { v.storageAccountName = 'custom-storage'; }, 'storageAccountName'],
  ['new-network missing NSGs', (v) => { v.useExistingVnet = false; }, 'privateEndpointNsgName'],
  ['active Redis HA', (v) => { v.enableManagedRedis = true; }, 'redisHighAvailability'],
  ['rich App Insights body loss', (v) => { v.appInsightsLogSettings.body.bytes = 8192; }, 'appInsightsLogSettings'],
  ['rich Azure Monitor loss', (v) => { v.azureMonitorLogSettings.frontend.request.body.bytes = 512; }, 'azureMonitorLogSettings'],
  ['Logic App capacity loss', (v) => { v.logicAppsSkuCapacityUnits = 2; }, 'logicAppsSkuCapacityUnits'],
  ['per-instance injection loss', (v) => { v.foundryNetworkInjectionEnabled = true; }, 'aiFoundryInstances'],
  ['all-Foundries versus index zero', (v) => { delete v.aiFoundryModelsConfig[0].aiserviceIndex; }, 'aiFoundryModelsConfig'],
  ['model publisher metadata loss', (v) => { v.aiFoundryModelsConfig[0].publisher = 'Mistral AI'; }, 'aiFoundryModelsConfig'],
  ['model retirement metadata loss', (v) => { v.aiFoundryModelsConfig[0].retirementDate = '2030-01-01'; }, 'aiFoundryModelsConfig'],
]) {
  test(`Main blocks ${name}`, async () => {
    const result = await project('deployment', mutate);
    assert.equal(result.rows.find((row) => row.source === source).status, 'change');
    assert.equal(result.text, null);
  });
}

test('proven inactive overrides and equal fixed rich logging are explicit safe omissions', async () => {
  const result = await project('deployment', (values) => {
    values.redisCacheName = 'unused-custom-redis';
    values.apimNsgName = 'existing-network-does-not-use-this';
  });
  assert.equal(result.blockers.length, 0);
  assert(result.rows.find((row) => row.source === 'redisCacheName').inactive);
  assert(!Object.hasOwn(result.output, 'azure_monitor_log_settings'));
  assert(!Object.hasOwn(result.output, 'app_insights_log_settings'));
  assert.equal(result.rows.find((row) => row.source === 'azureMonitorLogSettings').status, 'transformed');
  assert.deepEqual(MONITOR_DEFAULTS.backend.response.body, { bytes: 0 });
  assert.equal(INSIGHTS_DEFAULTS.body.bytes, 0);
});

test('SKU/network conditionals omit inactive settings and preserve fixed Developer capacity', async () => {
  const classic = await project('deployment', (values) => {
    values.apimV2UsePrivateEndpoint = true;
    values.apimV2PrivateEndpointName = 'unused-classic-override';
    values.apimSkuUnits = 3;
    values.foundryNetworkInjectionEnabled = true;
    values.agentSubnetName = 'existing-agents';
    values.agentSubnetNsgName = 'unused-existing-nsg';
    values.aiFoundryInstances[0].networkInjectionEnabled = true;
  });
  assert.equal(classic.blockers.length, 0);
  assert.equal(classic.output.apim_sku_units, 1);
  assert(classic.rows.find((row) => row.source === 'agentSubnetNsgName').inactive);
  assert(classic.rows.find((row) => row.source === 'agentSubnetPrefix').inactive);
  assert(classic.rows.find((row) => row.source === 'apimV2PrivateEndpointName').inactive);
  assert(!Object.hasOwn(classic.output, 'apim_v2_use_private_endpoint'));
  const v2 = await project('deployment', (values) => { values.apimSku = 'StandardV2'; });
  assert.equal(v2.blockers.length, 0);
  assert(!Object.hasOwn(v2.output, 'apim_network_type'));
  assert.equal(v2.output.apim_v2_public_network_access, false);
});

test('legacy authScheme is not mistaken for the effective Bicep authentication behavior', async () => {
  const result = await project('llm', (values) => { values.llmBackendConfig[0].authScheme = 'apiKey'; });
  assert.equal(result.blockers.length, 0);
  assert.equal(result.output.llm_backend_config[0].auth_scheme, 'managedIdentity');
  assert.equal(result.output.llm_backend_config[0].auth_type, 'managed-identity');
});

test('LLM identity/model casing, auth consumer and equal breaker defaults survive', async () => {
  const result = await project('llm');
  const backend = result.output.llm_backend_config[0];
  assert.equal(backend.backend_id, 'synthetic-east');
  assert.equal(backend.auth_scheme, 'managedIdentity');
  assert.equal(backend.supported_models[0].modelFormat, 'OpenAI');
  assert.equal(backend.supported_models[0].apiVersion, '2024-02-15-preview');
  assert(!Object.hasOwn(backend.supported_models[0], 'model_format'));
  assert.equal(result.rows.find((row) => row.source === 'circuitBreakerDefaults').status, 'transformed');
  assert.equal(result.rows.find((row) => row.source === 'configureSessionAffinity').status, 'transformed');
});

for (const [name, mutate] of [
  ['active session-aware model', (v) => { v.llmBackendConfig[0].supportedModels[0].sessionAwareModel = true; }],
  ['custom breaker', (v) => { v.circuitBreakerDefaults.failureCount = 7; }],
  ['per-backend breaker', (v) => { v.llmBackendConfig[0].circuitBreaker = { enabled: true }; }],
  ['duplicate backend identity', (v) => { v.llmBackendConfig.push(structuredClone(v.llmBackendConfig[0])); }],
  ['unknown provider', (v) => { v.llmBackendConfig[0].backendType = 'aws-bedrock'; }],
  ['malformed alias', (v) => { v.modelAliases = [null]; }],
  ['wrong mixed-case model type', (v) => { v.llmBackendConfig[0].supportedModels[0].apiVersion = true; }],
]) {
  test(`LLM blocks ${name} without producing a file`, async () => {
    const result = await project('llm', mutate);
    assert.equal(result.text, null);
    assert(result.blockers.length);
  });
}

test('Access embeds exact Bicep XML and preserves template markers, service/API identities and one use case', async () => {
  const result = await project('access');
  assert.equal(result.output.services[0].policy_xml, FIXTURE_POLICY);
  assert.equal(result.output.services[0].code, 'LLM');
  assert.deepEqual(result.output.api_name_mapping.LLM, ['universal-llm-api', 'azure-openai-api']);
  assert.deepEqual(result.output.use_case, { business_unit: 'finance', use_case_name: 'assistant', environment: 'demo' });
  assert.match(result.text, /\$\$\{not_a_terraform_expression\}/);
  assert.match(result.text, /%%\{not_a_directive\}/);
  assert.match(result.text, /\{\{named-value\}\}/);
  assert.equal(result.path, 'citadel-access-contracts/terraform.tfvars');
});

test('Access missing policy uses the bound source default, not the different Terraform default', async () => {
  const result = await project('access', (values) => { delete values.services[0].policyXml; });
  assert.equal(result.blockers.length, 0);
  assert.equal(result.output.services[0].policy_xml, FIXTURE_POLICY);
  assert.match(result.output.services[0].policy_xml, /gpt-4\.1,gpt-5\.4-mini/);
});

test('case-sensitive service identity is preserved while source default-policy selection follows Bicep casing rules', async () => {
  const values = fixtureValues();
  values.access.services[0].code = 'multi';
  delete values.access.services[0].policyXml;
  values.access.apiNameMapping.multi = values.access.apiNameMapping.LLM;
  const files = fixtureFiles(values);
  const multiXml = FIXTURE_POLICY.replace('Caf\u00e9 export', 'Multi default policy');
  files['bicep/infra/citadel-access-contracts/policies/default-multi-product-policy.xml'] = multiXml;
  const fixture = exportFixture(files);
  const result = projectTerraformExport('access', await readTerraformSource(fixture.provider, FIXTURE_ACCESS_PATH));
  assert.equal(result.blockers.length, 0);
  assert.equal(result.output.services[0].code, 'multi');
  assert.equal(result.output.services[0].policy_xml, multiXml);
});

test('inactive rotation override is withheld but does not block an otherwise faithful contract', async () => {
  const sentinel = 'synthetic-inactive-secret';
  const result = await project('access', (values) => { values.rotationKeyOverride = sentinel; });
  assert.equal(result.blockers.length, 0);
  assert(result.rows.find((row) => row.source === 'rotationKeyOverride').inactive);
  assert(!JSON.stringify(result).includes(sentinel));
});

for (const [name, mutate] of [
  ['extra gateway', (v) => { v.additionalApimGateways = [{ ...v.apim, name: 'second-gateway' }]; }],
  ['global gateway', (v) => { v.globalGatewayUrl = 'https://synthetic.example.invalid'; }],
  ['secondary key selection', (v) => { v.usePrimaryKey = false; }],
  ['key rotation', (v) => { v.keyRotationEnabled = true; }],
  ['multi-asset publishing', (v) => { v.services[0].publishAllAssetEndpoints = true; }],
  ['per-asset endpoints', (v) => { v.services[0].assetEndpoints = [{ apiName: 'agent' }]; }],
  ['Foundry API selection mismatch', (v) => { v.useTargetFoundry = true; v.apiNameMapping.LLM.unshift('weather-tool'); }],
]) {
  test(`Access blocks ${name}`, async () => {
    const result = await project('access', mutate);
    assert.equal(result.text, null);
    assert(result.blockers.some((row) => row.status === 'change'));
  });
}

test('source and operator secrets are neither exported nor included in the public projection', async () => {
  const sentinel = 'sk-syntheticCredentialNotForExport123456';
  const result = await project('llm', (values) => {
    values.llmBackendConfig[0].authConfig = { namedValueKey: 'reference', secretValue: sentinel };
  });
  assert.equal(result.text, null);
  assert(!JSON.stringify(result).includes(sentinel));
  const entered = await project('llm', () => {}, (choices) => { choices['target:managed_identity_client_id'] = sentinel; });
  assert.equal(entered.text, null);
  assert(!JSON.stringify(entered).includes(sentinel));
});

test('missing/unknown fragment and malformed source XML stay actionable blockers', async () => {
  for (const xml of ['<policies><inbound></policies>', '<policies><inbound><include-fragment fragment-id="not-in-target" /></inbound></policies>']) {
    const fixture = exportFixture({ ...fixtureFiles(), [FIXTURE_POLICY_PATH]: xml });
    const source = await readTerraformSource(fixture.provider, FIXTURE_ACCESS_PATH);
    const result = projectTerraformExport('access', source);
    assert.equal(result.text, null);
    assert(result.rows.find((row) => row.source === 'services').notes.some((note) => /XML|fragment/.test(note.reason)));
  }
});

test('empty/no-map source and invalid environment identities cannot produce success-shaped output', async () => {
  const f = exportFixture();
  const source = await readTerraformSource(f.provider, EXPORT_AREAS[0].path);
  assert.throws(() => projectTerraformExport('deployment', { ...source, text: "using './main.bicep'\n" }), /no assigned/);
  for (const name of ['../escape', 'MixedCase', 'aux', 'export demo', 'x'.repeat(25)]) {
    const result = await project('deployment', (values) => { values.environmentName = name; });
    assert.equal(result.text, null);
  }
});
