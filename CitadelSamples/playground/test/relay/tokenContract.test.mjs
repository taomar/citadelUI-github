import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readRelayTokenContract,
  RELAY_TOKEN_CONFIGURATION_ERROR,
  validateRelayAppRegistrationManifest,
  validateRelayTokenContract,
} from '../../src/relay/tokenContract.mjs';
import {
  checkRelayAppRegistration,
  decodeManifestText,
  parseRelayAppRegistrationArgs,
} from '../../scripts/check-relay-app-registration.mjs';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const RESOURCE = `api://${CLIENT_ID}`;
const AUDIENCE = CLIENT_ID;
const CLOUD = 'AzureCloud';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

function contract(overrides = {}) {
  return {
    cloud: CLOUD,
    version: 2,
    issuer: ISSUER,
    resource: RESOURCE,
    audience: AUDIENCE,
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    ...overrides,
  };
}

function manifest(overrides = {}) {
  return {
    appId: CLIENT_ID,
    identifierUris: [RESOURCE],
    api: { requestedAccessTokenVersion: 2 },
    ...overrides,
  };
}

test('the relay token contract separates the managed-identity resource from the v2 aud claim', () => {
  assert.deepEqual(validateRelayTokenContract(contract()), contract());
  for (const version of [undefined, null, 1, '1', '2.0']) {
    assert.throws(
      () => validateRelayTokenContract(contract({ version })),
      (error) => error.code === RELAY_TOKEN_CONFIGURATION_ERROR && /exactly 2/.test(error.message),
    );
  }
  assert.throws(
    () => validateRelayTokenContract(contract({ issuer: `https://login.microsoftonline.com/${TENANT_ID}/v1.0` })),
    /must be exactly .*\/v2\.0/,
  );
  assert.throws(
    () =>
      validateRelayTokenContract(
        contract({ issuer: 'https://login.microsoftonline.com/33333333-3333-4333-8333-333333333333/v2.0' }),
      ),
    /must be exactly/,
  );
  assert.throws(
    () => validateRelayTokenContract(contract({ tenantId: 'COMMON' })),
    /canonical lowercase Microsoft Entra GUID/,
  );
  assert.throws(
    () => validateRelayTokenContract(contract({ resource: CLIENT_ID })),
    new RegExp(`must be exactly api://${CLIENT_ID}`),
  );
  assert.throws(
    () => validateRelayTokenContract(contract({ audience: RESOURCE })),
    new RegExp(`must be exactly ${CLIENT_ID}`),
  );
  assert.throws(
    () => validateRelayTokenContract(contract({ clientId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' })),
    /canonical lowercase Microsoft Entra GUID/,
  );
});

test('the token issuer is pinned to the selected active Azure cloud and Germany is rejected', () => {
  for (const [cloud, tokenIssuerBase] of [
    ['AzureCloud', 'https://login.microsoftonline.com'],
    ['AzureUSGovernment', 'https://login.microsoftonline.us'],
    ['AzureChinaCloud', 'https://login.partner.microsoftonline.cn'],
  ]) {
    const expected = contract({ cloud, issuer: `${tokenIssuerBase}/${TENANT_ID}/v2.0` });
    assert.deepEqual(validateRelayTokenContract(expected), expected);
  }
  assert.throws(
    () =>
      validateRelayTokenContract(
        contract({
          cloud: 'AzureUSGovernment',
          issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
        }),
      ),
    /login\.microsoftonline\.us/,
  );
  assert.throws(
    () =>
      validateRelayTokenContract(
        contract({
          cloud: 'AzureGermanCloud',
          issuer: `https://login.microsoftonline.de/${TENANT_ID}/v2.0`,
        }),
      ),
    /must be exactly one of/,
  );
});

test('the Azure China relay verifier requires the partner issuer, exact tenant, cloud, and audience', () => {
  const chinaContract = contract({
    cloud: 'AzureChinaCloud',
    issuer: `https://login.partner.microsoftonline.cn/${TENANT_ID}/v2.0`,
  });
  assert.deepEqual(validateRelayTokenContract(chinaContract), chinaContract);
  for (const issuer of [
    `https://login.chinacloudapi.cn/${TENANT_ID}/v2.0`,
    `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    'https://login.partner.microsoftonline.cn/33333333-3333-4333-8333-333333333333/v2.0',
  ]) {
    assert.throws(
      () => validateRelayTokenContract({ ...chinaContract, issuer }),
      /login\.partner\.microsoftonline\.cn/,
    );
  }
  assert.throws(
    () => validateRelayTokenContract({ ...chinaContract, cloud: 'AzureCloud' }),
    /login\.microsoftonline\.com/,
  );
  assert.throws(
    () => validateRelayTokenContract({ ...chinaContract, audience: TENANT_ID }),
    new RegExp(`must be exactly ${CLIENT_ID}`),
  );
});

test('the offline manifest preflight rejects null/default and v1 app registrations before deployment', () => {
  for (const requestedAccessTokenVersion of [undefined, null, 1, '2']) {
    assert.throws(
      () =>
        validateRelayAppRegistrationManifest(
          manifest({ api: { requestedAccessTokenVersion } }),
          contract(),
        ),
      /api\.requestedAccessTokenVersion must be the number 2/,
    );
  }
  assert.equal(validateRelayAppRegistrationManifest(manifest(), contract()).requestedAccessTokenVersion, 2);
  assert.throws(
    () => validateRelayAppRegistrationManifest(manifest({ appId: TENANT_ID }), contract()),
    /manifest appId must be exactly/,
  );
  assert.throws(
    () => validateRelayAppRegistrationManifest(manifest({ identifierUris: ['api://wrong'] }), contract()),
    /manifest identifierUris must include exactly/,
  );
});

test('runtime environment validation names the missing or incompatible setting', () => {
  const names = {
    cloud: 'CLOUD',
    version: 'VERSION',
    issuer: 'ISSUER',
    resource: 'RESOURCE',
    audience: 'AUDIENCE',
    tenantId: 'TENANT',
    clientId: 'CLIENT',
  };
  const environment = {
    CLOUD,
    VERSION: '2',
    ISSUER,
    RESOURCE,
    AUDIENCE,
    TENANT: TENANT_ID,
    CLIENT: CLIENT_ID,
  };
  assert.deepEqual(readRelayTokenContract(environment, names), contract());
  for (const name of Object.values(names)) {
    const incomplete = { ...environment };
    delete incomplete[name];
    assert.throws(
      () => readRelayTokenContract(incomplete, names),
      (error) => error.code === RELAY_TOKEN_CONFIGURATION_ERROR && error.message.includes(name),
    );
  }
});

test('the offline checker validates a supplied manifest without any Azure or Graph call', async () => {
  const args = [
    '--manifest',
    '.\\relay-app.json',
    '--cloud',
    CLOUD,
    '--tenant-id',
    TENANT_ID,
    '--client-id',
    CLIENT_ID,
    '--resource',
    RESOURCE,
    '--audience',
    AUDIENCE,
    '--issuer',
    ISSUER,
  ];
  assert.equal(parseRelayAppRegistrationArgs(args).manifest, '.\\relay-app.json');
  let readPath = '';
  const result = await checkRelayAppRegistration(args, {
    read: async (path) => {
      readPath = path;
      return JSON.stringify(manifest());
    },
  });
  assert.match(readPath, /relay-app\.json$/);
  assert.equal(result.version, 2);
  assert.throws(() => parseRelayAppRegistrationArgs([...args, '--extra', 'value']), /Unknown option/);
});

test('the offline manifest checker accepts only the exact Azure China v2 issuer', async () => {
  const args = [
    '--manifest',
    '.\\relay-app.json',
    '--cloud',
    'AzureChinaCloud',
    '--tenant-id',
    TENANT_ID,
    '--client-id',
    CLIENT_ID,
    '--resource',
    RESOURCE,
    '--audience',
    AUDIENCE,
    '--issuer',
    `https://login.partner.microsoftonline.cn/${TENANT_ID}/v2.0`,
  ];
  const options = { read: async () => JSON.stringify(manifest()) };
  assert.equal((await checkRelayAppRegistration(args, options)).issuer, args.at(-1));
  await assert.rejects(
    checkRelayAppRegistration(
      args.with(-1, `https://login.chinacloudapi.cn/${TENANT_ID}/v2.0`),
      options,
    ),
    /login\.partner\.microsoftonline\.cn/,
  );
});

test('the offline checker decodes UTF-8 BOM and Windows PowerShell UTF-16 manifests', () => {
  const json = JSON.stringify(manifest());
  assert.equal(decodeManifestText(Buffer.from(`\uFEFF${json}`, 'utf8')), json);
  assert.equal(
    decodeManifestText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')])),
    json,
  );
});
