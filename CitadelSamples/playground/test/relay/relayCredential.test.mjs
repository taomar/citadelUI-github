/**
 * Local-proxy -> relay authentication.
 *
 * The credential THIS server presents TO the relay. Static-token is
 * development-only; managed-identity is the production path and never
 * touches IMDS directly here (a `tokenProvider` is injected instead).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createManagedIdentityCredentialProvider,
  createStaticTokenCredentialProvider,
} from '../../src/relay/relayCredential.mjs';

test('createStaticTokenCredentialProvider requires a non-empty token', () => {
  assert.throws(() => createStaticTokenCredentialProvider({ token: '' }), /non-empty token/);
  assert.throws(() => createStaticTokenCredentialProvider({}), /non-empty token/);
});

test('the static-token provider returns a bearer header carrying exactly the configured token', async () => {
  const provider = createStaticTokenCredentialProvider({ token: 'dev-only-secret' });
  assert.equal(provider.mode, 'static-token');
  const header = await provider.getAuthorizationHeader();
  assert.equal(header, `Bearer ${'dev-only-secret'}`);
});

test('the managed-identity provider wraps an injected token provider, never IMDS directly in a test', async () => {
  const calls = [];
  const controller = new AbortController();
  const tokenProvider = {
    getToken: async (options) => {
      calls.push(options);
      return 'aad-access-token';
    },
  };
  const provider = createManagedIdentityCredentialProvider({ resource: 'https://relay.example', tokenProvider });
  assert.equal(provider.mode, 'managed-identity');
  const header = await provider.getAuthorizationHeader({ signal: controller.signal });
  assert.equal(header, `Bearer ${'aad-access-token'}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, controller.signal);
});

test('the managed-identity provider forwards its environment to the Container Apps token path', async () => {
  const fetchCalls = [];
  const provider = createManagedIdentityCredentialProvider({
    resource: 'https://relay.example',
    clientId: 'user-assigned-id',
    environment: {
      IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
      IDENTITY_HEADER: 'playground-identity-header',
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => ({ access_token: 'built-token', expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
    },
  });
  const header = await provider.getAuthorizationHeader();
  assert.equal(header, `Bearer ${'built-token'}`);
  assert.equal(fetchCalls.length, 1);
  assert.equal(new URL(fetchCalls[0].url).searchParams.get('client_id'), 'user-assigned-id');
  assert.deepEqual(fetchCalls[0].init.headers, { 'X-IDENTITY-HEADER': 'playground-identity-header' });
});

test('both credential providers expose the same shape so a caller never needs to branch on mode', async () => {
  const shapes = [
    createStaticTokenCredentialProvider({ token: 'x' }),
    createManagedIdentityCredentialProvider({ resource: 'https://relay.example', tokenProvider: { getToken: async () => 'y' } }),
  ];
  for (const provider of shapes) {
    assert.equal(typeof provider.mode, 'string');
    assert.equal(typeof provider.getAuthorizationHeader, 'function');
    assert.match(await provider.getAuthorizationHeader(), /^Bearer /);
  }
});
