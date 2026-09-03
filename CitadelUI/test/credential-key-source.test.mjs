/**
 * Where the credential key comes from, judged on the promise `credentials.mjs`
 * makes.
 *
 * That promise does not change because the key now arrives over the network. A
 * key is still 32 bytes or it is refused; an absent key still means the product
 * runs without persistence rather than without encryption; and every failure is
 * still one answer — no credential — rather than a degraded one.
 *
 * So these tests attack the *source* the way the vault tests attack the
 * envelope: no endpoint, no header, no client id, a refused token, a refused
 * secret, a 200 carrying something that is not a token, and a key that is too
 * short to be a key. Every one of them must fail closed, and none of them may
 * fall back to a file or to no encryption at all.
 *
 * The file source is tested alongside them for the reason that matters most:
 * adding the cloud must not have moved local behaviour by a single byte.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialVault } from '../server/credentials.mjs';
import {
  createKeySource,
  FileKeySource,
  KeyVaultKeySource,
  KEY_SOURCE_FILE,
  KEY_SOURCE_KEY_VAULT,
} from '../server/credential-key-source.mjs';

const SECRET = 'test-credential-payload-not-a-real-token';
const VAULT_URI = 'https://citadel-test-vault.vault.azure.net/';
const SECRET_NAME = 'citadel-credential-key';
const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const IDENTITY_ENDPOINT = 'http://169.254.255.2:8081/msi/token';
const IDENTITY_HEADER = '853b9a84-5bfa-4b22-a3f3-0b9a43d9ad8a';

async function dataRootFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-keysource-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  return { root, dataRoot };
}

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

/**
 * A stand-in for the two endpoints, recording what was actually asked of them.
 * The recording is the point: the client id is invisible in a happy-path
 * assertion and is exactly the thing that breaks in Azure and nowhere else.
 */
function azureStub({ token = 'eyJ0eXAi.stub', expiresOn = null, secretValue, tokenStatus = 200, secretStatus = 200, tokenBody, secretBody } = {}) {
  const calls = { token: [], secret: [] };
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin === new URL(IDENTITY_ENDPOINT).origin) {
      calls.token.push({ url: target, headers: init.headers || {} });
      if (tokenStatus !== 200) return jsonResponse(tokenStatus, { error: 'nope' });
      if (tokenBody !== undefined) return jsonResponse(200, tokenBody);
      return jsonResponse(200, {
        access_token: token,
        expires_on: String(expiresOn ?? Math.floor(Date.now() / 1000) + 3600),
        resource: 'https://vault.azure.net',
        token_type: 'Bearer',
        client_id: CLIENT_ID,
      });
    }
    calls.secret.push({ url: target, headers: init.headers || {} });
    if (secretStatus !== 200) return jsonResponse(secretStatus, { error: 'nope' });
    if (secretBody !== undefined) return jsonResponse(200, secretBody);
    return jsonResponse(200, { value: secretValue, id: `${VAULT_URI}secrets/${SECRET_NAME}/abc` });
  };
  return { fetchImpl, calls };
}

function keyVaultVault(dataRoot, stub, overrides = {}) {
  return new CredentialVault({
    dataRoot,
    keySourceKind: KEY_SOURCE_KEY_VAULT,
    vaultUri: VAULT_URI,
    secretName: SECRET_NAME,
    clientId: CLIENT_ID,
    identityEndpoint: IDENTITY_ENDPOINT,
    identityHeader: IDENTITY_HEADER,
    fetch: stub.fetchImpl,
    ...overrides,
  });
}

test('the source is chosen explicitly, and an unrecognised name is not "file"', () => {
  // No configuration at all is the existing deployment, and must stay the file.
  assert.ok(createKeySource({}, {}) instanceof FileKeySource);
  assert.equal(createKeySource({}, {}).kind, KEY_SOURCE_FILE);
  assert.ok(createKeySource({}, { CITADEL_CREDENTIAL_KEY_SOURCE: 'file' }) instanceof FileKeySource);

  const fromEnv = createKeySource({}, { CITADEL_CREDENTIAL_KEY_SOURCE: 'keyvault' });
  assert.ok(fromEnv instanceof KeyVaultKeySource);
  assert.equal(fromEnv.kind, KEY_SOURCE_KEY_VAULT);
  // Case and stray whitespace in configuration are a human, not an attacker.
  assert.ok(createKeySource({}, { CITADEL_CREDENTIAL_KEY_SOURCE: ' KeyVault ' }) instanceof KeyVaultKeySource);

  // A typo must not silently become "file": that would hand the operator a
  // container with no key while they believe they configured a vault.
  const typo = createKeySource({}, { CITADEL_CREDENTIAL_KEY_SOURCE: 'keyvualt' });
  assert.equal(typo.kind, 'unknown');
});

test('an unrecognised source yields no key and says so', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  const vault = new CredentialVault({ dataRoot, keySourceKind: 'azure-key-vault' });
  await vault.initialize();
  assert.equal(vault.available, false);
  assert.equal(vault.status().reason, 'key-source-unknown');
  assert.equal(await vault.store('profile-a', 1, SECRET), false);
  assert.equal(await vault.load('profile-a', 1), null);
});

test('the file source is untouched by the existence of the cloud one', async (t) => {
  const { root, dataRoot } = await dataRootFor(t);
  const keyFile = join(root, 'credential.key');
  await writeFile(keyFile, randomBytes(32));

  // Exactly the call every existing deployment and every existing test makes,
  // with no Azure configuration present anywhere.
  const vault = new CredentialVault({ dataRoot, keyFile });
  await vault.initialize();
  assert.deepEqual(vault.status(), { available: true, reason: 'ready' });
  assert.equal(await vault.store('profile-a', 7, SECRET), true);
  assert.equal(await vault.load('profile-a', 7), SECRET);

  // And the reason names an operator already knows have not been renamed.
  const missing = new CredentialVault({ dataRoot, keyFile: join(root, 'absent.key') });
  await missing.initialize();
  assert.equal(missing.status().reason, 'key-file-unreadable');

  const short = join(root, 'short.key');
  await writeFile(short, randomBytes(8));
  const weak = new CredentialVault({ dataRoot, keyFile: short });
  await weak.initialize();
  assert.equal(weak.status().reason, 'key-file-invalid');
});

test('a key vault key opens the same envelope a key file would', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  const key = randomBytes(32);
  const stub = azureStub({ secretValue: key.toString('base64') });

  const vault = keyVaultVault(dataRoot, stub);
  await vault.initialize();
  assert.deepEqual(vault.status(), { available: true, reason: 'ready' });
  assert.equal(await vault.store('profile-a', 4242, SECRET), true);

  // The proof that the source is only a source: an envelope sealed under a key
  // fetched from a vault opens under the same key delivered from a file.
  const { root } = await dataRootFor(t);
  const keyFile = join(root, 'same.key');
  await writeFile(keyFile, key);
  const viaFile = new CredentialVault({ dataRoot, keyFile });
  await viaFile.initialize();
  assert.equal(await viaFile.load('profile-a', 4242), SECRET);
});

test('a hex-encoded secret is accepted and a short one is refused, not stretched', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  const hex = azureStub({ secretValue: randomBytes(32).toString('hex') });
  const good = keyVaultVault(dataRoot, hex);
  await good.initialize();
  assert.equal(good.available, true);

  // The whole point of `decodeMasterKey` is that a vault cannot talk the product
  // into a weak key any more than a file can.
  const tooShort = azureStub({ secretValue: randomBytes(8).toString('hex') });
  const weak = keyVaultVault(dataRoot, tooShort);
  await weak.initialize();
  assert.equal(weak.available, false);
  assert.equal(weak.status().reason, 'key-vault-invalid');
  assert.equal(await weak.store('profile-a', 1, SECRET), false);
});

test('the token request carries the user-assigned client id', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  const stub = azureStub({ secretValue: randomBytes(32).toString('base64') });
  const vault = keyVaultVault(dataRoot, stub);
  await vault.initialize();

  assert.equal(stub.calls.token.length, 1);
  const request = stub.calls.token[0];
  // Without this the platform resolves the system-assigned identity, or refuses.
  // It fails only in Azure, only on the first save, and only in production.
  assert.equal(request.url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(request.url.searchParams.get('resource'), 'https://vault.azure.net');
  assert.equal(request.url.searchParams.get('api-version'), '2019-08-01');
  assert.equal(request.headers['x-identity-header'], IDENTITY_HEADER);

  assert.equal(stub.calls.secret.length, 1);
  assert.equal(stub.calls.secret[0].headers.Authorization, 'Bearer eyJ0eXAi.stub');
  assert.match(stub.calls.secret[0].url.pathname, /^\/secrets\/citadel-credential-key$/);
});

test('a token is reused until it is close to expiry, then re-acquired', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  let clock = 1_700_000_000_000;
  const stub = azureStub({
    secretValue: randomBytes(32).toString('base64'),
    expiresOn: Math.floor(clock / 1000) + 3600,
  });
  const source = new KeyVaultKeySource({
    vaultUri: VAULT_URI,
    secretName: SECRET_NAME,
    clientId: CLIENT_ID,
    identityEndpoint: IDENTITY_ENDPOINT,
    identityHeader: IDENTITY_HEADER,
    fetch: stub.fetchImpl,
    now: () => clock,
  });

  await source.read();
  await source.read();
  await source.read();
  // Three secret reads, one token. Fetching per request would put an avoidable
  // dependency on the identity endpoint in the hot path.
  assert.equal(stub.calls.token.length, 1);
  assert.equal(stub.calls.secret.length, 3);

  // Inside the refresh margin the token is treated as already gone, so it is
  // never presented in the window where it might expire mid-call.
  clock += 3600 * 1000 - 60_000;
  await source.read();
  assert.equal(stub.calls.token.length, 2);
});

test('every way the vault can fail is the same answer: no credential', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  const goodKey = randomBytes(32).toString('base64');

  const cases = [
    ['no-key-vault', { vaultUri: '' }],
    ['no-key-vault', { secretName: '' }],
    // A secret name Key Vault itself would reject never reaches the network.
    ['no-key-vault', { secretName: 'not a valid name' }],
    // Configuration that could send a bearer token somewhere it must not go.
    ['no-key-vault', { vaultUri: 'http://citadel-test-vault.vault.azure.net/' }],
    ['no-key-vault', { vaultUri: 'https://attacker.example.com/' }],
    ['no-key-vault', { vaultUri: 'https://citadel-test-vault.vault.azure.net:8443/' }],
    // The identity is absent: this is a container that is not what it claims.
    ['no-managed-identity', { identityEndpoint: '' }],
    ['no-managed-identity', { identityHeader: '' }],
    ['no-managed-identity', { clientId: '' }],
  ];

  for (const [expected, overrides] of cases) {
    const stub = azureStub({ secretValue: goodKey });
    const vault = keyVaultVault(dataRoot, stub, overrides);
    await vault.initialize();
    assert.equal(vault.available, false, `${expected}: ${JSON.stringify(overrides)}`);
    assert.equal(vault.status().reason, expected, JSON.stringify(overrides));
    assert.equal(await vault.store('profile-x', 1, SECRET), false);
    assert.equal(await vault.load('profile-x', 1), null);
    // Nothing reached the network on a configuration refusal.
    assert.equal(stub.calls.secret.length, 0);
  }
});

test('a vault that answers badly is unreachable, not permissive', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  const goodKey = randomBytes(32).toString('base64');

  const responses = [
    azureStub({ secretValue: goodKey, tokenStatus: 500 }),
    azureStub({ secretValue: goodKey, tokenStatus: 400 }),
    azureStub({ secretValue: goodKey, secretStatus: 403 }),
    azureStub({ secretValue: goodKey, secretStatus: 404 }),
    azureStub({ secretValue: goodKey, secretStatus: 401 }),
    // A 200 carrying something that is not a token.
    azureStub({ secretValue: goodKey, tokenBody: { access_token: '' } }),
    azureStub({ secretValue: goodKey, tokenBody: { token: 'wrong-field' } }),
    azureStub({ secretValue: goodKey, tokenBody: null }),
    // A 200 carrying something that is not a secret.
    azureStub({ secretValue: goodKey, secretBody: { value: '' } }),
    azureStub({ secretValue: goodKey, secretBody: { value: 42 } }),
    azureStub({ secretValue: goodKey, secretBody: {} }),
    azureStub({ secretValue: goodKey, secretBody: null }),
  ];

  for (const stub of responses) {
    const vault = keyVaultVault(dataRoot, stub);
    await vault.initialize();
    assert.equal(vault.available, false);
    assert.equal(vault.status().reason, 'key-vault-unreadable');
    assert.equal(await vault.store('profile-x', 1, SECRET), false);
  }
});

test('a transport that throws is caught and fails closed', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  for (const boom of [
    async () => {
      throw new Error('ECONNREFUSED');
    },
    async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    },
    async () => ({ status: 200, json: async () => { throw new SyntaxError('not json'); } }),
  ]) {
    const vault = keyVaultVault(dataRoot, { fetchImpl: boom });
    await vault.initialize();
    assert.equal(vault.available, false);
    assert.equal(vault.status().reason, 'key-vault-unreadable');
  }
});

test('status never carries key material, a token, or the identity header', async (t) => {
  const { dataRoot } = await dataRootFor(t);
  const key = randomBytes(32);
  const stub = azureStub({ secretValue: key.toString('base64'), token: 'eyJ0eXAi.super.secret' });
  const vault = keyVaultVault(dataRoot, stub);
  await vault.initialize();

  const rendered = JSON.stringify(vault.status());
  assert.equal(rendered.includes(key.toString('base64')), false);
  assert.equal(rendered.includes(key.toString('hex')), false);
  assert.equal(rendered.includes('eyJ0eXAi'), false);
  assert.equal(rendered.includes(IDENTITY_HEADER), false);
  assert.equal(rendered.includes(SECRET_NAME), false);
  // A state name and a boolean. That is the whole surface.
  assert.deepEqual(Object.keys(vault.status()).sort(), ['available', 'reason']);
});
