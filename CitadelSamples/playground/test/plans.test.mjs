/**
 * Plan generation: structural guarantees for every recipe, plus golden plans
 * for the ones whose exact output matters most.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SAMPLES, buildSamplePlan, getSample } from '../src/catalogue/index.mjs';
import { STEP_TYPES } from '../src/core/types.mjs';
import { serializePlan } from '../src/core/plan.mjs';
import { previewPlan, previewSteps } from '../src/core/preview.mjs';
import { FIXTURE_SECRETS, makeFixtureReader } from './helpers/fixtures.mjs';

const read = makeFixtureReader();

function planFor(id, overrides = {}) {
  const sample = getSample(id);
  const { plan, validation } = buildSamplePlan(sample, makeFixtureReader(overrides));
  assert.ok(plan, `${id} produced no plan: ${JSON.stringify(validation.issues)}`);
  return plan;
}

test('every recipe compiles to a plan from a complete configuration', () => {
  for (const sample of SAMPLES) {
    const { plan, validation } = buildSamplePlan(sample, read);
    assert.ok(plan, `${sample.id} produced no plan: ${JSON.stringify(validation.issues)}`);
    assert.equal(plan.sampleId, sample.id);
    assert.ok(plan.steps.length >= 2, `${sample.id} produced only ${plan.steps.length} step(s)`);
    assert.deepEqual(plan.sourceCells, [...sample.sourceCells]);
    assert.equal(plan.risk.level, sample.risk.level);
  }
});

test('every plan step is typed, identified and explained', () => {
  for (const sample of SAMPLES) {
    const { plan } = buildSamplePlan(sample, read);
    const ids = plan.steps.map((step) => step.id);
    assert.equal(new Set(ids).size, ids.length, `${sample.id} has duplicate step ids`);
    for (const step of plan.steps) {
      assert.ok(STEP_TYPES.includes(step.type), `${sample.id}/${step.id} has type ${step.type}`);
      assert.ok(step.title?.length > 5, `${sample.id}/${step.id} has no title`);
      assert.ok(step.detail?.length > 15, `${sample.id}/${step.id} has no detail`);
      assert.ok(Array.isArray(step.produces), `${sample.id}/${step.id} has no produces array`);
      assert.ok(Array.isArray(step.consumes), `${sample.id}/${step.id} has no consumes array`);
      const payload = step.request ?? step.command ?? step.artifact ?? step.library ?? step.assertion;
      assert.ok(payload, `${sample.id}/${step.id} carries no payload for its type`);
    }
  }
});

test('plans are deterministic: the same inputs always produce the same plan', () => {
  for (const sample of SAMPLES) {
    const first = serializePlan(buildSamplePlan(sample, read).plan);
    const second = serializePlan(buildSamplePlan(sample, makeFixtureReader()).plan);
    assert.equal(first, second, `${sample.id} is not deterministic`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(first), `${sample.id} embeds a timestamp`);
  }
});

test('every consumed binding is produced by an earlier step', () => {
  for (const sample of SAMPLES) {
    const { plan } = buildSamplePlan(sample, read);
    for (const [index, step] of plan.steps.entries()) {
      for (const consumed of step.consumes) {
        const [producerId, output] = consumed.split('.');
        const producerIndex = plan.steps.findIndex((candidate) => candidate.id === producerId);
        assert.ok(producerIndex >= 0, `${sample.id}/${step.id} consumes unknown step ${producerId}`);
        assert.ok(producerIndex < index, `${sample.id}/${step.id} consumes ${consumed} too early`);
        assert.ok(
          plan.steps[producerIndex].produces.includes(output),
          `${sample.id}/${step.id} consumes ${consumed}, which is not declared as an output`,
        );
      }
    }
  }
});

test('every plan previews without throwing, and per-step previews are non-empty', () => {
  for (const sample of SAMPLES) {
    const { plan } = buildSamplePlan(sample, read);
    const text = previewPlan(plan, { secrets: FIXTURE_SECRETS });
    assert.ok(text.includes(plan.title));
    assert.ok(text.includes(`notebook cells: ${plan.sourceCells.join(', ')}`));
    for (const step of previewSteps(plan, { secrets: FIXTURE_SECRETS })) {
      assert.ok(step.text.length > 0, `${sample.id}/${step.id} previewed as empty`);
    }
  }
});

test('required step types match the steps actually present', () => {
  for (const sample of SAMPLES) {
    const { plan } = buildSamplePlan(sample, read);
    const actual = [...new Set(plan.steps.map((step) => step.type))].sort();
    assert.deepEqual([...plan.requiredStepTypes].sort(), actual, `${sample.id} misreports its step types`);
  }
});

/* ------------------------------------------------------------- goldens */

test('golden: the Weather MCP handshake binds the session header', () => {
  const plan = planFor('weather-mcp-discovery');
  assert.deepEqual(
    plan.steps.map((step) => [step.id, step.type]),
    [
      ['mcp-initialize', 'http'],
      ['tools-list', 'http'],
      ['assert-tools', 'assertion'],
    ],
  );

  const init = plan.steps[0];
  assert.equal(init.request.method, 'POST');
  assert.equal(init.request.url, 'https://apim-citadel-test.azure-api.net/mcp/weather-tool-mcp/mcp');
  assert.equal(init.request.headers.Accept, 'application/json, text/event-stream');
  assert.equal(init.request.body.jsonrpc, '2.0');
  assert.equal(init.request.body.id, 1);
  assert.equal(init.request.body.method, 'initialize');
  assert.equal(init.request.body.params.protocolVersion, '2025-06-18');
  assert.equal(init.request.capture.sessionId, "response.headers['Mcp-Session-Id']");
  assert.ok(init.produces.includes('sessionId'));

  const list = plan.steps[1];
  assert.equal(list.request.body.id, 2);
  assert.equal(list.request.body.method, 'tools/list');
  assert.equal(list.request.headers['Mcp-Session-Id'], '{{steps.mcp-initialize.sessionId}}');
  assert.deepEqual(list.consumes, ['mcp-initialize.sessionId']);
});

test('golden: the Learn MCP endpoint carries no trailing /mcp', () => {
  const plan = planFor('learn-mcp-discovery');
  assert.equal(plan.steps[0].request.url, 'https://apim-citadel-test.azure-api.net/mcp/ms-learn-tool-mcp');
});

test('golden: the publish contract writes the notebook`s exact parameter file', () => {
  const plan = planFor('publish-assets');
  const artifact = plan.steps.find((step) => step.type === 'artifact');
  assert.equal(
    artifact.artifact.path,
    '../bicep/infra/citadel-publish-contracts/contracts/sample-assets/dev/main.bicepparam',
  );
  const content = artifact.artifact.content;
  assert.ok(content.startsWith("using '../../../main.bicep'\n"));
  assert.match(content, /param managedIdentityClientId = '11111111-2222-3333-4444-555555555555'/);
  assert.match(content, /param configureCircuitBreaker = true/);
  assert.match(content, /param useAssetTypePathPrefix = true/);
  assert.match(content, /assetType: 'mcp-from-api'/);
  assert.match(content, /assetType: 'mcp-existing'/);
  assert.match(content, /assetType: 'a2a'/);
  assert.match(content, /forwardSubscriptionKeyToSource: true/);
  assert.match(content, /sourceSubscriptionKeyHeaderName: 'x-mcp-sub-key'/);
  assert.match(content, /authType: 'managed-identity'/);
  assert.match(content, /resource: 'https:\/\/ai\.azure\.com'/);
  // Two spaces of indentation per level, exactly like the notebook's `_bicep`.
  assert.match(content, /\n {2}\{\n {4}assetType: 'mcp-from-api'/);

  const deploy = plan.steps.find((step) => step.type === 'azure-cli');
  assert.deepEqual(deploy.command.args.slice(0, 5), [
    'deployment',
    'sub',
    'create',
    '--name',
    'citadel-publish-contracts-validation',
  ]);
});

test('golden: dropping the A2A asset removes it from the publish contract', () => {
  const plan = planFor('publish-assets', { 'foundry.enableA2aAsset': false });
  const content = plan.steps[0].artifact.content;
  assert.ok(!content.includes("assetType: 'a2a'"));
  assert.ok(content.includes("assetType: 'mcp-from-api'"));
  const assertion = plan.steps.find((step) => step.type === 'assertion');
  assert.ok(assertion.assertion.expectations.some((entry) => entry.includes('holds 2 entries')));
});

test('golden: the access contract classifies a mixed contract and generates both artefacts', () => {
  const plan = planFor('access-contract-deploy');
  const classify = plan.steps.find((step) => step.id === 'classify');
  const text = classify.assertion.expectations.join('\n');
  assert.match(text, /Contract code: MULTI/);
  assert.match(text, /product id: MULTI-Governance-PublishedAssets-DEV/);
  assert.match(text, /Forwarded source APIs added to the product: weather-api/);

  const policy = plan.steps.find((step) => step.id === 'write-policy');
  assert.match(policy.artifact.content, /rate-limit-by-key calls="20"[^>]*:tool/);
  assert.match(policy.artifact.content, /rate-limit-by-key calls="10"[^>]*:agent/);
  assert.match(policy.artifact.content, /llm-token-limit[^>]*tokens-per-minute="10000"/);
  assert.match(policy.artifact.content, /include-fragment fragment-id="set-asset-kind"/);

  const param = plan.steps.find((step) => step.id === 'write-param');
  assert.match(param.artifact.content, /MULTI: \['universal-llm-api', 'weather-tool', 'ms-learn-tool', 'hr-chat-agent', 'weather-api'\]/);
  assert.match(param.artifact.content, /foundryApiName: 'universal-llm-api'/);
  assert.match(param.artifact.content, /useTargetAzureKeyVault = true/);
});

test('golden: with no LLM API present the contract code degrades correctly', () => {
  const plan = planFor('access-contract-deploy', { 'samples.access-contract-deploy.existingLlmApis': [] });
  const classify = plan.steps.find((step) => step.id === 'classify');
  const text = classify.assertion.expectations.join('\n');
  assert.match(text, /Contract code: MULTI/); // tools + agents are still two types
  const agentless = planFor('access-contract-deploy', {
    'samples.access-contract-deploy.existingLlmApis': [],
    'foundry.enableA2aAsset': false,
  });
  const agentlessText = agentless.steps.find((step) => step.id === 'classify').assertion.expectations.join('\n');
  assert.match(agentlessText, /Contract code: TOOL/);
  assert.match(agentlessText, /product id: TOOL-Governance-PublishedAssets-DEV/);
});

test('golden: Key Vault verification checks the key without printing it, plus every endpoint', () => {
  const plan = planFor('access-contract-kv-verify');
  const key = plan.steps.find((step) => step.id === 'read-key-secret');
  assert.ok(key.command.args.includes('length(value)'), 'the api-key secret must not be printed');
  assert.ok(!key.command.args.includes('value'), 'the api-key secret must not be read as a raw value');

  const endpointSteps = plan.steps.filter((step) => step.id.startsWith('read-endpoint-'));
  assert.equal(endpointSteps.length, 4, 'one step per reported endpoint secret');

  const assertion = plan.steps.at(-1);
  const text = assertion.assertion.expectations.join(' ');
  assert.match(text, /api-key secret returns a length greater than zero/);
  assert.match(text, /endpoint secrets return a non-empty value/);
});

test('golden: an empty endpoint-secret list is inconclusive rather than vacuously true', () => {
  const plan = planFor('access-contract-kv-verify', { 'keyVault.endpointSecretNames': [] });
  assert.equal(plan.steps.filter((step) => step.id.startsWith('read-endpoint-')).length, 0);
  const text = plan.steps.at(-1).assertion.expectations.join(' ');
  assert.match(text, /inconclusive, not a pass/);
});

test('golden: the weather tool call asserts the unit branch per city', () => {
  const celsius = planFor('weather-tools-call');
  const call = celsius.steps.find((step) => step.id === 'tools-call');
  assert.equal(call.request.body.method, 'tools/call');
  assert.deepEqual(call.request.body.params, { name: 'get-weather', arguments: { city: 'London' } });
  const celsiusAssertion = celsius.steps.at(-1).assertion;
  assert.equal(celsiusAssertion.expectedUnit, 'Celsius');
  assert.deepEqual(celsiusAssertion.expectedFields, [
    'city',
    'temperature',
    'temperature_format',
    'description',
    'humidity',
    'wind_speed',
  ]);

  for (const city of ['Seattle', 'New York City', 'Los Angeles', 'seattle', 'LOS ANGELES']) {
    const plan = planFor('weather-tools-call', { 'samples.weather-tools-call.city': city });
    assert.equal(plan.steps.at(-1).assertion.expectedUnit, 'Fahrenheit', `${city} should report Fahrenheit`);
  }
  for (const city of ['London', 'Tokyo', 'New York']) {
    const plan = planFor('weather-tools-call', { 'samples.weather-tools-call.city': city });
    assert.equal(plan.steps.at(-1).assertion.expectedUnit, 'Celsius', `${city} should report Celsius`);
  }
});

test('golden: the burst plans carry a repeat descriptor sized from the policy limit', () => {
  const tool = planFor('tool-rate-limit-burst');
  const toolBurst = tool.steps.find((step) => step.id === 'burst');
  assert.deepEqual(toolBurst.request.repeat, { count: 35, concurrency: 10, timeoutSeconds: 30, identical: true });
  assert.match(tool.summary, /35 MCP initialize calls against a 20\/minute tool limit/);

  const agent = planFor('agent-rate-limit-burst');
  const agentBurst = agent.steps.find((step) => step.id === 'burst');
  assert.deepEqual(agentBurst.request.repeat, { count: 25, concurrency: 10, timeoutSeconds: 30, identical: true });
  assert.equal(agentBurst.request.headers['A2A-Version'], '1.0');
  assert.match(agent.summary, /25 A2A message\/send calls against a 10\/minute agent limit/);
});

test('golden: cleanup with both switches off deletes nothing but still reports residue', () => {
  const plan = planFor('cleanup');
  assert.equal(plan.steps.filter((step) => step.type === 'azure-cli').length, 0);
  assert.match(plan.summary, /nothing is deleted/);
  const residue = plan.steps.find((step) => step.id === 'report-residue');
  assert.equal(residue.assertion.residue.length, 7);
  assert.ok(residue.assertion.expectations.some((entry) => /role assignment/i.test(entry)));
});

test('golden: cleanup with both switches on deletes per asset and reports each independently', () => {
  const plan = planFor('cleanup', {
    'samples.cleanup.deleteAccessContract': true,
    'samples.cleanup.deletePublishedAssets': true,
  });
  const ids = plan.steps.map((step) => step.id);
  assert.ok(ids.includes('delete-subscription'));
  assert.ok(ids.includes('delete-product'));
  assert.equal(ids.filter((id) => id.startsWith('delete-api-')).length, 3);
  // Only mcp-existing and a2a assets have their own backend.
  assert.equal(ids.filter((id) => id.startsWith('delete-backend-')).length, 2);
  const report = plan.steps.find((step) => step.id === 'report-deletions');
  assert.ok(report.assertion.expectations.length >= 7, 'each deletion is reported on its own');
});

test('golden: the source API is only deleted when explicitly opted in', () => {
  const off = planFor('cleanup');
  assert.ok(!off.steps.some((step) => step.id === 'delete-source-api'));
  assert.ok(off.steps.at(-1).assertion.residue.some((entry) => entry.id === 'weather-api'));

  const on = planFor('cleanup', { 'samples.cleanup.deleteWeatherSourceApi': true });
  assert.ok(on.steps.some((step) => step.id === 'delete-source-api'));
  assert.ok(!on.steps.at(-1).assertion.residue.some((entry) => entry.id === 'weather-api'));
});

test('golden: the metrics query is bounded to a run window', () => {
  const plan = planFor('usage-metrics');
  const query = plan.steps.find((step) => step.id === 'query-metrics');
  const kql = query.command.args[query.command.args.indexOf('--analytics-query') + 1];
  assert.match(kql, /where timestamp > ago\(30m\)/);
  assert.match(kql, /name in \('McpRequests','A2ARequests'\)/);

  const wide = planFor('usage-metrics', { 'samples.usage-metrics.lookbackMinutes': 120 });
  const wideQuery = wide.steps.find((step) => step.id === 'query-metrics');
  assert.match(wideQuery.command.args[wideQuery.command.args.indexOf('--analytics-query') + 1], /ago\(120m\)/);
});

test('golden: circuit-breaker checks target the backend resource with the preview api-version', () => {
  const plan = planFor('circuit-breaker-check');
  const read1 = plan.steps.find((step) => step.id === 'read-backend-1');
  const uri = read1.command.args[read1.command.args.indexOf('--uri') + 1];
  assert.match(
    uri,
    /^\/subscriptions\/00000000-1111-2222-3333-444444444444\/resourceGroups\/rg-citadel-hub-test\/providers\/Microsoft\.ApiManagement\/service\/apim-citadel-test\/backends\/ms-learn-tool-backend\?api-version=2024-06-01-preview$/,
  );
  const expectations = plan.steps.at(-1).assertion.expectations.join(' ');
  assert.match(expectations, /Failure count is 3 over PT5M/);
  assert.match(expectations, /Trip duration is PT1M/);
  assert.match(expectations, /Status code ranges cover 429 and 500-503/);
  assert.match(expectations, /acceptRetryAfter` is true/);
  assert.match(expectations, /Consumption tier/);

  const withAgent = planFor('circuit-breaker-check', { 'samples.circuit-breaker-check.includeAgentBackend': true });
  assert.equal(withAgent.steps.filter((step) => step.id.startsWith('read-backend-')).length, 2);
});

test('golden: the Foundry PATCH sends a real bearer token bound from the token step', () => {
  const plan = planFor('foundry-enable-a2a');
  const patch = plan.steps.find((step) => step.id === 'patch-agent');
  assert.equal(patch.request.headers.Authorization, 'Bearer {{steps.acquire-token.accessToken}}');
  assert.deepEqual(patch.consumes, ['acquire-token.accessToken']);
  assert.equal(
    patch.request.url,
    'https://aif-citadel-test.services.ai.azure.com/api/projects/proj-citadel-test/agents/HR-ChatAgent?api-version=v1',
  );
  assert.deepEqual(Object.keys(patch.request.body.agent_endpoint.protocol_configuration), ['responses', 'a2a']);
});

test('golden: APIM discovery lists before it selects', () => {
  const plan = planFor('apim-discovery');
  assert.equal(plan.steps[0].id, 'list-services');
  assert.equal(plan.steps[1].id, 'select-service');
  const expectations = plan.steps[1].assertion.expectations.join(' ');
  assert.match(expectations, /exactly one service|explicit name/i);
  assert.ok(
    !plan.steps.some((step) => JSON.stringify(step).includes('[0]')),
    'discovery must never index into the candidate list',
  );
});
