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
