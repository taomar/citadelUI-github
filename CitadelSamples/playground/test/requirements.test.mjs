/**
 * The per-sample configuration contract.
 *
 * The important test here is `manifest completeness`. It proves — without
 * reading a builder's source, and without trusting UI copy — that each recipe's
 * declaration names exactly the fields that recipe actually uses:
 *
 *   perturbing a field changes the generated plan  ⇒  the sample declares it
 *
 * The converse is not asserted, because a few declared entries are legitimately
 * invisible in the plan text: a guard the executor checks, and a value that
 * happens to equal its own perturbation-resistant default. Those are listed
 * explicitly below rather than waved away.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CATALOGUE, buildSamplePlan, fieldByPath, getSample, requirementsFor } from '../src/catalogue/index.mjs';
import { serializePlan } from '../src/core/plan.mjs';
import { REQUIREMENT_GROUPS, REQUIREMENT_LEVELS } from '../src/core/types.mjs';
import { FIXTURE_SECRETS, makeFixtureReader } from './helpers/fixtures.mjs';

/** A value guaranteed to differ from whatever the field currently holds. */
function perturb(field, current) {
  switch (field.type) {
    case 'boolean':
      return current === true ? false : true;
    case 'enum':
      return field.options?.find((option) => option.value !== current)?.value ?? 'zzz-perturbation-probe';
    case 'integer':
      return typeof current === 'number' && current === 4242 ? 9191 : 4242;
    case 'string-list':
      return ['zzz-perturbation-probe'];
    case 'url':
      return 'https://perturbation-probe.invalid';
    case 'secret':
      return 'PERTURBED-KEY-not-a-credential';
    default:
      return 'zzz-perturbation-probe';
  }
}

/** Every field path in the catalogue: profiles first, then every sample. */
function allFieldPaths() {
  const paths = [];
  for (const profile of CATALOGUE.profiles) {
    for (const field of profile.fields) paths.push(`${profile.id}.${field.name}`);
  }
  for (const sample of CATALOGUE.samples) {
    for (const field of sample.fields) paths.push(field.path);
  }
  return paths;
}

/**
 * Declared entries that deliberately do not appear in the plan text.
 * Each one is a precondition the executor evaluates, not a value it renders.
 */
const EXECUTOR_ONLY = new Set([
  'tool-rate-limit-burst/samples.tool-rate-limit-burst.confirmNonProduction',
  'agent-rate-limit-burst/samples.agent-rate-limit-burst.confirmNonProduction',
  'cleanup/samples.cleanup.confirmNonProduction',
  'weather-api-ensure/hub.subscriptionId',
]);

test('every recipe declares a configuration contract and a runtime contract', () => {
  for (const sample of CATALOGUE.samples) {
    assert.ok(Array.isArray(sample.configuration), `${sample.id} has no configuration declaration`);
    assert.ok(sample.configurationEntries.length > 0, `${sample.id} declares no configuration at all`);
    assert.ok(sample.runtime, `${sample.id} has no runtime declaration`);
    assert.ok(Array.isArray(sample.runtime.dependencies), `${sample.id} declares no runtime dependencies`);
    assert.ok(sample.runtime.note, `${sample.id} does not explain its runtime`);
  }
});

test('every declared entry names a real field, a requirement level and a reason', () => {
  for (const sample of CATALOGUE.samples) {
    for (const entry of sample.configurationEntries) {
      assert.ok(fieldByPath(entry.path), `${sample.id} declares unknown field ${entry.path}`);
      assert.ok(REQUIREMENT_LEVELS.includes(entry.requirement), `${sample.id}/${entry.path} has a bad requirement`);
      assert.ok(entry.reason.length > 20, `${sample.id}/${entry.path} has no useful reason`);
      if (entry.requirement === 'conditional') {
        assert.ok(entry.condition, `${sample.id}/${entry.path} is conditional without a stated condition`);
        assert.ok(entry.requiredWhen, `${sample.id}/${entry.path} is conditional without a machine condition`);
      }
      if (entry.requirement === 'optional' || entry.requirement === 'generated') {
        assert.ok(entry.fallback, `${sample.id}/${entry.path} does not name its fallback`);
      }
    }
  }
});

test('manifest completeness: perturbing a field changes the plan only when the sample declares it', () => {
  const paths = allFieldPaths();
  for (const sample of CATALOGUE.samples) {
    const declared = new Set(sample.configurationEntries.map((entry) => entry.path));
    const baseline = serializePlan(buildSamplePlan(sample, makeFixtureReader()).plan);

    for (const path of paths) {
      if (declared.has(path)) continue;
      const field = fieldByPath(path);
      const reader = makeFixtureReader();
      const overrides = { [path]: perturb(field, reader(path)) };
      const secrets =
        field.classification === 'secret'
          ? { ...FIXTURE_SECRETS, [path]: perturb(field, '') }
          : FIXTURE_SECRETS;
      const { plan } = buildSamplePlan(sample, makeFixtureReader(overrides, { secrets }), { requireValid: false });
      assert.ok(plan, `${sample.id} produced no plan while perturbing ${path}`);
      assert.equal(
        serializePlan(plan),
        baseline,
        `${sample.id} changes when ${path} changes, but does not declare it. Add it to the sample's configuration contract.`,
      );
    }
  }
});

/**
 * Values that make a `requiredWhen` clause true, so a conditional entry can be
 * perturbed in the state where it actually matters.
 */
function activate(condition, into = {}) {
  if (!condition) return into;
  for (const clause of condition.all ?? condition.any ?? []) activate(clause, into);
  if (condition.field && Object.prototype.hasOwnProperty.call(condition, 'equals')) {
    into[condition.field] = condition.equals;
  }
  return into;
}

/**
 * Extra state a few entries need before their effect is observable.
 *
 * `candidateLlmApis` and `existingLlmApis` decide how many asset *types* the
 * contract mixes, and the contract code only changes when that count crosses
 * 1. With the default fixture the agent asset already pushes the count to two,
 * so removing the LLM APIs leaves the code at `MULTI` either way. Dropping the
 * agent asset makes the dependency visible, which is the state a tool-only
 * gateway is actually in.
 */
const CONDITION_PROBES = new Map([
  ['cleanup/hub.resourceGroupName', { 'samples.cleanup.deleteWeatherSourceApi': true }],
  ['cleanup/hub.apimName', { 'samples.cleanup.deleteWeatherSourceApi': true }],
  ['cleanup/policy.candidateLlmApis', { 'foundry.enableA2aAsset': false }],
  ['cleanup/samples.access-contract-deploy.existingLlmApis', { 'foundry.enableA2aAsset': false }],
]);

test('every declared entry is either used by the plan or an executor-checked guard', () => {
  const unused = [];
  for (const sample of CATALOGUE.samples) {
    for (const entry of sample.configurationEntries) {
      if (EXECUTOR_ONLY.has(`${sample.id}/${entry.path}`)) continue;
      // A conditional entry is only meant to matter while its condition holds,
      // so it is perturbed from that state rather than from the defaults.
      const activation = {
        ...(entry.requirement === 'conditional' ? activate(entry.requiredWhen) : {}),
        ...(CONDITION_PROBES.get(`${sample.id}/${entry.path}`) ?? {}),
      };
      const built = buildSamplePlan(sample, makeFixtureReader(activation), { requireValid: false }).plan;
      // A secret's VALUE never enters a plan — the plan carries an inert
      // `SecretRef` instead. So "is it used?" is answered by the ref list, not
      // by perturbing the value.
      if (entry.secret) {
        if (!built.secretRefs.includes(entry.path)) {
          unused.push(`${sample.id} declares the secret ${entry.path}, which its plan never references`);
        }
        continue;
      }
      const field = fieldByPath(entry.path);
      const reader = makeFixtureReader(activation);
      const overrides = { ...activation, [entry.path]: perturb(field, reader(entry.path)) };
      const { plan } = buildSamplePlan(sample, makeFixtureReader(overrides), { requireValid: false });
      if (serializePlan(plan) === serializePlan(built)) {
        unused.push(`${sample.id} declares ${entry.path}, which nothing in its plan reads`);
      }
    }
  }
  assert.deepEqual(unused, [], unused.join('\n'));
});

test('a manifest groups entries in the documented order and counts them', () => {
  const sample = getSample('weather-mcp-discovery');
  const manifest = requirementsFor(sample, makeFixtureReader(), { hasSecret: () => true });
  const ids = manifest.groups.map((group) => group.id);
  const expectedOrder = REQUIREMENT_GROUPS.map((group) => group.id).filter((id) => ids.includes(id));
  assert.deepEqual(ids, expectedOrder);
  const total = manifest.groups.reduce((sum, group) => sum + group.count, 0);
  assert.equal(total, sample.configurationEntries.length);
});

test('a blank mandatory value blocks; a blank optional or generated value does not', () => {
  const sample = getSample('apim-discovery');
  const blocked = requirementsFor(sample, makeFixtureReader({ 'hub.resourceGroupName': '' }));
  assert.equal(blocked.satisfied, false);
  assert.deepEqual(blocked.blockingPaths, ['hub.resourceGroupName']);

  const optionalBlank = requirementsFor(
    sample,
    makeFixtureReader({ 'samples.apim-discovery.apimNameOverride': '' }),
  );
  assert.equal(optionalBlank.satisfied, true, 'a blank optional value must not block execution');
});

test('whitespace-preserving fields keep their exact value in manifests and exports', () => {
  const productTerms = "\n  Owner's terms  \n";
  const manifest = requirementsFor(
    getSample('access-contract-deploy'),
    makeFixtureReader({ 'samples.access-contract-deploy.productTerms': productTerms }),
  );
  assert.equal(manifest.byPath.get('samples.access-contract-deploy.productTerms').preview, productTerms);
});

test('a conditional entry blocks only while its condition holds', () => {
  const sample = getSample('access-contract-deploy');
  const withKv = requirementsFor(sample, makeFixtureReader({ 'keyVault.name': '' }));
  assert.ok(withKv.blockingPaths.includes('keyVault.name'), 'Key Vault name must block while KV publishing is on');

  const withoutKv = requirementsFor(
    sample,
    makeFixtureReader({ 'keyVault.name': '', 'keyVault.useAccessContractKv': false }),
  );
  assert.ok(
    !withoutKv.blockingPaths.includes('keyVault.name'),
    'Key Vault name must stop blocking once publishing is off',
  );
});

test('a secret is mandatory only for the samples that actually present it', () => {
  const noSecret = { hasSecret: () => false };
  const gatewayCall = requirementsFor(getSample('weather-mcp-discovery'), makeFixtureReader({}, { secrets: {} }), noSecret);
  assert.ok(
    gatewayCall.blockingPaths.includes('gatewayAccess.apiKey'),
    'a gateway call must be blocked without the contract key',
  );

  const discovery = requirementsFor(getSample('apim-discovery'), makeFixtureReader({}, { secrets: {} }), noSecret);
  assert.ok(
    !discovery.entries.some((entry) => entry.secret),
    'API Management discovery never presents a gateway key, so it must not ask for one',
  );
});

test('the gateway URL is conditional for tool calls and mandatory for agent calls', () => {
  const tool = getSample('weather-mcp-discovery').configurationEntries.find((e) => e.path === 'hub.gatewayUrl');
  assert.equal(tool.requirement, 'conditional');
  assert.match(tool.condition, /deployed endpoint/i);

  const agent = getSample('a2a-message-send').configurationEntries.find((e) => e.path === 'hub.gatewayUrl');
  assert.equal(agent.requirement, 'mandatory');

  // A recorded deployed endpoint lifts the tool's requirement.
  const stillBlocked = requirementsFor(
    getSample('weather-mcp-discovery'),
    makeFixtureReader({ 'hub.gatewayUrl': '' }),
  );
  assert.ok(stillBlocked.blockingPaths.includes('hub.gatewayUrl'));

  const satisfied = requirementsFor(
    getSample('weather-mcp-discovery'),
    makeFixtureReader({
      'hub.gatewayUrl': '',
      'samples.weather-mcp-discovery.deployedEndpoint': 'https://gw.example.net/mcp/weather-tool-mcp/mcp',
    }),
  );
  assert.ok(!satisfied.blockingPaths.includes('hub.gatewayUrl'));
});

test('no recipe asks for a field it does not use — the shared profiles are filtered per sample', () => {
  // Key Vault verification uses an explicit override when supplied, otherwise
  // it needs the hub subscription as the validated fallback.
  const kvVerify = getSample('access-contract-kv-verify');
  const keyVaultSubscription = kvVerify.configurationEntries.find((entry) => entry.path === 'keyVault.subscriptionId');
  const hubSubscription = kvVerify.configurationEntries.find((entry) => entry.path === 'hub.subscriptionId');
  assert.equal(keyVaultSubscription?.requirement, 'optional');
  assert.equal(hubSubscription?.requirement, 'conditional');
  assert.deepEqual(hubSubscription?.requiredWhen, { field: 'keyVault.subscriptionId', blank: true });

  // The A2A card recipe declares no Foundry coordinates: the gateway, not the
  // caller, reaches Foundry.
  const card = getSample('a2a-agent-card');
  assert.ok(
    !card.configurationEntries.some((entry) => entry.path.startsWith('foundry.')),
    'the agent-card recipe must not ask for Foundry coordinates',
  );
});

test('every sample declares runtime dependencies that match the step types it compiles to', () => {
  for (const sample of CATALOGUE.samples) {
    const { plan } = buildSamplePlan(sample, makeFixtureReader());
    const declared = new Set(sample.runtime.dependencies);
    if (plan.requiredStepTypes.includes('azure-cli')) {
      assert.ok(declared.has('azure-cli'), `${sample.id} compiles an azure-cli step but does not declare the CLI`);
    }
    if (plan.requiredStepTypes.includes('library')) {
      assert.ok(declared.has('python'), `${sample.id} compiles a library step but does not declare Python`);
      assert.ok(sample.runtime.python?.modules?.length, `${sample.id} declares Python without the modules to import`);
    }
    if (plan.requiredStepTypes.includes('artifact')) {
      assert.ok(
        declared.has('accelerator'),
        `${sample.id} writes an artifact for a template but does not declare the accelerator bundle`,
      );
    }
  }
});
