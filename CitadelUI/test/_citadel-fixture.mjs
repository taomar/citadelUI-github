import { primaryCapabilities } from '../shared/citadel-core.mjs';

const ACCESS_ROOT = 'bicep/infra/citadel-access-contracts';
const ACCESS_PARAM = `${ACCESS_ROOT}/main.bicepparam`;
const ACCESS_TEMPLATE = `${ACCESS_ROOT}/main.bicep`;
const ACCESS_POLICY = `${ACCESS_ROOT}/policies/default-ai-product-policy.xml`;

function namesWithFillers(signature, minimum, prefix) {
  const names = [...signature];
  for (let index = 1; names.length < minimum; index += 1) {
    names.push(`${prefix}${String(index).padStart(3, '0')}`);
  }
  return names;
}

function parameterType(name) {
  if (/Units$|Count$|Capacity$|Index$/.test(name)) return 'int';
  if (/^(enable|use|configure|is)[A-Z]/.test(name)) return 'bool';
  if (/Instances$|Config$|Defaults$|Aliases$|Mapping$|services$/i.test(name)) return 'array';
  if (['apim', 'apimManagedIdentity', 'keyVault', 'useCase', 'foundry'].includes(name)) return 'object';
  return 'string';
}

function parameterValue(name, values = {}) {
  if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
  if (name === 'environmentName') return "'dev'";
  if (name === 'location') return "'westeurope'";
  if (name === 'apimSku') return "'Developer'";
  const type = parameterType(name);
  if (type === 'int') return '1';
  if (type === 'bool') return 'false';
  if (type === 'array') return '[]';
  if (type === 'object') return '{}';
  return "'fixture'";
}

function bicepParamText(using, names, values) {
  return [`using '${using}'`, '', ...names.map((name) => `param ${name} = ${parameterValue(name, values)}`), ''].join('\n');
}

function bicepTemplateText(names) {
  return [
    "targetScope = 'subscription'",
    '',
    ...names.map((name) => `param ${name} ${parameterType(name)}`),
    '',
  ].join('\n');
}

const mainNames = namesWithFillers(
  primaryCapabilities.mainSignature,
  primaryCapabilities.mainMinimumParameters,
  'fixtureMain'
);
const llmNames = [...primaryCapabilities.llmSignature];
const accessNames = namesWithFillers(
  primaryCapabilities.accessSignature,
  primaryCapabilities.accessMinimumParameters,
  'fixtureAccess'
);

export function citadelRepositoryFiles(overrides = {}) {
  return {
    [primaryCapabilities.mainPath]: bicepParamText('./main.bicep', mainNames),
    'bicep/infra/main.bicep': bicepTemplateText(mainNames),
    [primaryCapabilities.llmPath]: bicepParamText('./main.bicep', llmNames),
    'bicep/infra/llm-backend-onboarding/main.bicep': bicepTemplateText(llmNames),
    [ACCESS_PARAM]: bicepParamText('main.bicep', accessNames),
    [ACCESS_TEMPLATE]: bicepTemplateText(accessNames),
    [ACCESS_POLICY]: '<policies><inbound><base /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>\n',
    'scripts/deploy.sh': { content: '#!/bin/sh\necho deploy\n', mode: '100755' },
    ...overrides,
  };
}

export function incompatibleRepositoryFiles() {
  return {
    'README.md': '# Ordinary repository\n',
    'infra/example.bicepparam': "using 'example.bicep'\nparam name = 'ordinary'\n",
    'infra/example.bicep': 'param name string\n',
  };
}

/**
 * Parameter files Citadel is not interested in, shaped like the real repository.
 *
 * `citadelRepositoryFiles()` has three parameter files, all of them in the
 * interest set — so against it "only the interest set was read" and "everything
 * was read" are the same observation, and a test asserting the first would pass
 * even with selective discovery removed entirely.
 *
 * These are the directories a real Citadel repository actually carries:
 * gateway upgrades, alert rules, Cosmos sync, publish contracts, and a
 * `foundry-integration/samples` folder whose whole purpose is to hold many
 * example parameter files. Each one gets its own template, so a scan that walks
 * the repository pays two reads for every entry here.
 */
export function unrelatedRepositoryFiles() {
  const files = {};
  const add = (directory, name, parameters) => {
    files[`${directory}/${name}.bicepparam`] = bicepParamText(`./${name}.bicep`, parameters);
    files[`${directory}/${name}.bicep`] = bicepTemplateText(parameters);
  };
  add('bicep/infra', 'resources', ['resourceGroupName', 'location']);
  for (const name of ['main', 'supporting-services']) {
    add('bicep/infra/apim-gateway-upgrade', name, ['apimServiceName', 'apimSku']);
  }
  add('bicep/infra/app-insights-alert', 'main', ['alertName', 'severity']);
  add('bicep/infra/citadel-cosmos-global-multi-master-sync', 'main', ['accountName', 'regions']);
  add('bicep/infra/citadel-publish-contracts', 'main', ['productName', 'apiName']);
  add('bicep/infra/foundry-integration', 'main', ['foundry', 'location']);
  for (const name of [
    'custom-auth',
    'custom-headers',
    'dynamic-discovery',
    'full-config',
    'static-models',
    'batch-inference',
    'content-safety',
    'embeddings-only',
    'private-endpoint',
    'regional-failover',
  ]) {
    add('bicep/infra/foundry-integration/samples', name, ['foundry', 'modelAliases']);
  }
  for (const name of ['east', 'west', 'north', 'south']) {
    add('bicep/regions', name, ['location', 'resourceGroupName']);
  }
  add('validation/publish-validation/contract', 'main', ['productName']);
  return files;
}

/**
 * A Citadel repository with realistic noise and several contract instances.
 *
 * Two dedupe shapes are deliberately present:
 *
 *   - Every contract instance references the *same* template alias, so a scan
 *     that does not deduplicate by alias fetches one template once per instance.
 *   - Two instances (`qa-beta` and `qa-clone`) are byte-identical, so they share
 *     one Git blob SHA. Alias-level deduplication cannot collapse those; only a
 *     content-addressed cache can.
 */
export function citadelRepositoryWithNoise(options = {}) {
  const instances = options.instances || ['qa-alpha', 'qa-beta', 'qa-clone', 'qa-delta'];
  const files = { ...citadelRepositoryFiles(), ...unrelatedRepositoryFiles() };
  for (const name of instances) {
    // `qa-clone` is a byte-for-byte copy of `qa-beta`; every other instance
    // differs by its use case so the blobs are distinct.
    const useCase = name === 'qa-clone' ? 'qa-beta' : name;
    files[`${ACCESS_ROOT}/contracts/${name}/main.bicepparam`] = bicepParamText(
      '../../main.bicep',
      accessNames,
      { useCase: `'${useCase}'` }
    );
  }
  // Inside the contract root but not contracts: shared modules and the base
  // contracts a repository keeps for reference. Citadel never lists these and
  // never copies from them — `createContract` copies the template at the root —
  // so they must not be downloaded either.
  files[`${ACCESS_ROOT}/base-contracts/common/main.bicepparam`] = bicepParamText(
    '../../main.bicep',
    accessNames,
    { useCase: "'base'" }
  );
  files[`${ACCESS_ROOT}/modules/shared/main.bicepparam`] = bicepParamText(
    '../../main.bicep',
    accessNames,
    { useCase: "'shared'" }
  );
  return { ...files, ...(options.overrides || {}) };
}

/** Paths inside the contract root that are not contracts and are never read. */
export function nonContractSubtreePaths() {
  return [
    `${ACCESS_ROOT}/base-contracts/common/main.bicepparam`,
    `${ACCESS_ROOT}/modules/shared/main.bicepparam`,
  ];
}

/** Paths in a noisy repository that Citadel must never read. */
export function unrelatedParameterPaths() {
  return Object.keys(unrelatedRepositoryFiles())
    .filter((path) => path.endsWith('.bicepparam'))
    .sort();
}

export const ACCESS_PATHS = Object.freeze({
  root: ACCESS_ROOT,
  template: ACCESS_PARAM,
  templateBicep: ACCESS_TEMPLATE,
  policy: ACCESS_POLICY,
});
