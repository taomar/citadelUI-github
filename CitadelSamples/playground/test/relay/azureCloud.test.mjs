import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AZURE_CLOUD_PROFILES,
  SUPPORTED_AZURE_CLOUDS,
  getAzureCloudProfile,
  validateKeyVaultUrl,
  validateRelayCloudConfiguration,
} from '../../src/relay/azureCloud.mjs';

const CASES = Object.freeze([
  {
    name: 'AzureCloud',
    authority: 'https://login.microsoftonline.com',
    resourceManager: 'https://management.azure.com/',
    keyVaultResource: 'https://vault.azure.net',
    keyVaultDnsSuffix: '.vault.azure.net',
    vaultUrl: 'https://public-test.vault.azure.net/',
  },
  {
    name: 'AzureUSGovernment',
    authority: 'https://login.microsoftonline.us',
    resourceManager: 'https://management.usgovcloudapi.net/',
    keyVaultResource: 'https://vault.usgovcloudapi.net',
    keyVaultDnsSuffix: '.vault.usgovcloudapi.net',
    vaultUrl: 'https://government-test.vault.usgovcloudapi.net/',
  },
  {
    name: 'AzureChinaCloud',
    authority: 'https://login.chinacloudapi.cn',
    resourceManager: 'https://management.chinacloudapi.cn',
    keyVaultResource: 'https://vault.azure.cn',
    keyVaultDnsSuffix: '.vault.azure.cn',
    vaultUrl: 'https://china-test.vault.azure.cn/',
  },
]);

function configuration(profile, overrides = {}) {
  return {
    cloud: profile.name,
    armCloud: profile.name,
    armEndpoint: profile.resourceManager,
    keyVaultResource: profile.keyVaultResource,
    keyVaultDnsSuffix: profile.keyVaultDnsSuffix,
    keyVaultUrl: profile.vaultUrl,
    ...overrides,
  };
}

test('the trusted cloud table contains exactly the three active Azure clouds', () => {
  assert.deepEqual(SUPPORTED_AZURE_CLOUDS, CASES.map(({ name }) => name));
  for (const expected of CASES) {
    assert.deepEqual(getAzureCloudProfile(expected.name), {
      name: expected.name,
      authority: expected.authority,
      resourceManager: expected.resourceManager,
      keyVaultResource: expected.keyVaultResource,
      keyVaultDnsSuffix: expected.keyVaultDnsSuffix,
    });
    assert.deepEqual(AZURE_CLOUD_PROFILES[expected.name], getAzureCloudProfile(expected.name));
  }
  assert.throws(() => getAzureCloudProfile('AzureGermanCloud'), /must be exactly one of/);
  assert.throws(() => getAzureCloudProfile('__proto__'), /must be exactly one of/);
});

test('relay cloud startup accepts each exact active-cloud tuple and canonicalizes its vault URI', () => {
  for (const expected of CASES) {
    const validated = validateRelayCloudConfiguration(configuration(expected));
    assert.equal(validated.name, expected.name);
    assert.equal(validated.keyVaultResource, expected.keyVaultResource);
    assert.equal(validated.vaultUrl, expected.vaultUrl.replace(/\/$/, ''));
  }
});

test('relay cloud startup rejects cross-cloud, attacker-controlled, and partial configuration', () => {
  const publicCloud = CASES[0];
  const mismatches = [
    ['armCloud', 'AzureChinaCloud'],
    ['armEndpoint', 'https://management.attacker.example/'],
    ['keyVaultResource', 'https://attacker.example'],
    ['keyVaultDnsSuffix', '.vault.azure.net.attacker.example'],
    ['keyVaultUrl', 'https://public-test.vault.azure.cn'],
    ['keyVaultUrl', 'https://public-test.vault.azure.net.attacker.example'],
    ['keyVaultUrl', 'https://public-test.vault.azure.net/secrets/attacker'],
  ];
  for (const [name, value] of mismatches) {
    assert.throws(() => validateRelayCloudConfiguration(configuration(publicCloud, { [name]: value })));
  }
  for (const name of [
    'cloud',
    'armCloud',
    'armEndpoint',
    'keyVaultResource',
    'keyVaultDnsSuffix',
    'keyVaultUrl',
  ]) {
    const partial = configuration(publicCloud);
    delete partial[name];
    assert.throws(() => validateRelayCloudConfiguration(partial), new RegExp(name === 'cloud' ? 'cloud profile' : 'must'));
  }
});

test('vault validation requires one unadorned host under the selected cloud suffix', () => {
  assert.equal(
    validateKeyVaultUrl('https://government-test.vault.usgovcloudapi.net/', 'AzureUSGovernment'),
    'https://government-test.vault.usgovcloudapi.net',
  );
  for (const value of [
    'http://public-test.vault.azure.net',
    'https://public-test.vault.azure.net:443',
    'https://user@public-test.vault.azure.net',
    'https://nested.public-test.vault.azure.net',
    'https://public-test.vault.azure.net?audience=https://attacker.example',
  ]) {
    assert.throws(() => validateKeyVaultUrl(value, 'AzureCloud'), /unadorned HTTPS vault host/);
  }
});
