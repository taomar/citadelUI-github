/**
 * Logical secret resolution for the relay.
 *
 * The relay never accepts a caller-selected vault or secret name — only a
 * logical ref. Every mapping is fixed by the operator at construction time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInMemorySecretProvider,
  createKeyVaultSecretProvider,
} from '../../src/relay/secretProvider.mjs';

test('the in-memory provider resolves a configured ref and returns null for anything else', async () => {
  const provider = createInMemorySecretProvider({ 'gatewayAccess.apiKey': 'fixture-value' });
  assert.equal(await provider.resolve('gatewayAccess.apiKey'), 'fixture-value');
  assert.equal(await provider.resolve('unknown.ref'), null);
  assert.equal(await provider.resolve('__proto__'), null);
});

test('the in-memory provider treats a blank or non-string mapped value as unresolved', async () => {
  const provider = createInMemorySecretProvider({ 'a.b': '', 'c.d': 42 });
  assert.equal(await provider.resolve('a.b'), null);
  assert.equal(await provider.resolve('c.d'), null);
});

test('createKeyVaultSecretProvider requires a mappings object', () => {
  assert.throws(() => createKeyVaultSecretProvider({}), /requires a `mappings`/);
  assert.throws(() => createKeyVaultSecretProvider({ mappings: [] }), /requires a `mappings`/);
  assert.throws(() => createKeyVaultSecretProvider({ mappings: 'nope' }), /requires a `mappings`/);
});

test('an unknown ref resolves to null — the caller never selects a vault or secret name', async () => {
  const provider = createKeyVaultSecretProvider({
    mappings: { 'gatewayAccess.apiKey': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'gateway-key' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: async () => {
      throw new Error('must not be called for an unmapped ref');
    },
  });
  assert.equal(await provider.resolve('caller.chosen.vault'), null);
  assert.equal(await provider.resolve('__proto__'), null);
});

test('a mapped ref is fetched from exactly its configured vault URL and secret name, nothing caller-derived', async () => {
  const calls = [];
  const provider = createKeyVaultSecretProvider({
    mappings: { 'gatewayAccess.apiKey': { vaultUrl: 'https://kv-test.vault.azure.net/', secretName: 'gateway key/v1' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ value: 'resolved-secret-value' }) };
    },
  });
  const value = await provider.resolve('gatewayAccess.apiKey');
  assert.equal(value, 'resolved-secret-value');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://kv-test.vault.azure.net/secrets/gateway%20key%2Fv1?api-version=7.4');
  assert.match(calls[0].init.headers.Authorization, /^Bearer /);
});

test('the Key Vault provider uses its own Container Apps identity environment without forwarding the identity header to Key Vault', async () => {
  const calls = [];
  const provider = createKeyVaultSecretProvider({
    mappings: { 'gatewayAccess.apiKey': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'gateway-key' } },
    clientId: 'relay-user-assigned-id',
    environment: {
      IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
      IDENTITY_HEADER: 'relay-identity-header',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (new URL(url).hostname === 'localhost') {
        return {
          ok: true,
          json: async () => ({
            access_token: 'relay-key-vault-token',
            expires_on: Math.floor(Date.now() / 1000) + 3600,
          }),
        };
      }
      return { ok: true, json: async () => ({ value: 'resolved-secret-value' }) };
    },
  });

  assert.equal(await provider.resolve('gatewayAccess.apiKey'), 'resolved-secret-value');
  assert.equal(calls.length, 2);
  const identityUrl = new URL(calls[0].url);
  assert.equal(identityUrl.hostname, 'localhost');
  assert.equal(identityUrl.searchParams.get('resource'), 'https://vault.azure.net');
  assert.equal(identityUrl.searchParams.get('client_id'), 'relay-user-assigned-id');
  assert.deepEqual(calls[0].init.headers, { 'X-IDENTITY-HEADER': 'relay-identity-header' });
  assert.equal(calls[1].url, 'https://kv-test.vault.azure.net/secrets/gateway-key?api-version=7.4');
  assert.equal(calls[1].init.headers['X-IDENTITY-HEADER'], undefined);
  assert.equal(calls[1].init.headers.Metadata, undefined);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer relay-key-vault-token');
});

test('a non-OK Key Vault response resolves to null rather than throwing or leaking detail', async () => {
  const provider = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) }),
  });
  assert.equal(await provider.resolve('a.b'), null);
});

test('a blank secret value from Key Vault resolves to null, never an empty credential', async () => {
  const provider = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ value: '' }) }),
  });
  assert.equal(await provider.resolve('a.b'), null);
});

test('createKeyVaultSecretProvider requires a fetch implementation when globalThis.fetch is unavailable', () => {
  const savedFetch = globalThis.fetch;
  try {
    // eslint-disable-next-line no-global-assign
    globalThis.fetch = undefined;
    assert.throws(
      () =>
        createKeyVaultSecretProvider({
          mappings: { 'a.b': { vaultUrl: 'https://kv.example', secretName: 'x' } },
          tokenProvider: { getToken: async () => 't' },
        }),
      /requires a fetch/,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

/* ------------------------------------------------------------- deadlines */

test('a never-settling Key Vault fetch is bounded by its own internal timeout, even with no caller signal at all', async () => {
  const fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  const provider = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: fetch,
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => provider.resolve('a.b'), { name: 'AbortError' });
});

test('a never-settling response.json() is bounded by the same internal timeout as the Key Vault fetch itself, even though the fetch resolved fine', async () => {
  // Before this fix, `bound.dispose()` ran the instant the fetch settled,
  // leaving the body-parse phase completely unbounded even though the
  // fetch itself came back promptly.
  const provider = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => provider.resolve('a.b'), { name: 'AbortError' });
});

test('a Key Vault fetchImpl/response that ignores its signal entirely (never rejects on abort) is still bounded, for both the fetch phase and the body-parse phase', async () => {
  const neverSettles = () => new Promise(() => {});
  const ignoresSignalDuringFetch = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: () => neverSettles(),
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => ignoresSignalDuringFetch.resolve('a.b'), { name: 'AbortError' });

  const ignoresSignalDuringJson = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: async () => ({ ok: true, json: () => neverSettles() }),
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => ignoresSignalDuringJson.resolve('a.b'), { name: 'AbortError' });
});

test("a caller's own signal firing aborts only that caller's Key Vault fetch — this is safe here because, unlike the managed-identity token request, the fetch is never shared across callers", async () => {
  let fetchAborted = false;
  let fetchStarted;
  const fetchStartedPromise = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  const fetch = (_url, init) => {
    fetchStarted();
    return new Promise((_resolve, reject) => {
      if (init.signal?.aborted) {
        fetchAborted = true;
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
        return;
      }
      init.signal?.addEventListener(
        'abort',
        () => {
          fetchAborted = true;
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
  };
  const provider = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: fetch,
  });
  const controller = new AbortController();
  const pending = provider.resolve('a.b', { signal: controller.signal });
  // Abort only once the Key Vault fetch has genuinely started (mirroring a
  // real caller disconnecting/timing out mid-request) rather than racing
  // the `await provider.getToken()` step that precedes it.
  await fetchStartedPromise;
  controller.abort();
  await assert.rejects(() => pending, { name: 'AbortError' });
  assert.equal(fetchAborted, true, "the caller's own signal must reach — and abort — its own Key Vault fetch");
});

test('an already-aborted signal passed to resolve is honored by the Key Vault fetch without needing to wait for the internal timeout', async () => {
  const provider = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: { getToken: async () => 'kv-token' },
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => provider.resolve('a.b', { signal: controller.signal }), { name: 'AbortError' });
});

test("resolve's caller signal is also passed through to the managed-identity token request, so a slow/hanging token request is bounded by the same deadline", async () => {
  let tokenGetTokenSignal;
  const provider = createKeyVaultSecretProvider({
    mappings: { 'a.b': { vaultUrl: 'https://kv-test.vault.azure.net', secretName: 'x' } },
    tokenProvider: {
      getToken: async ({ signal } = {}) => {
        tokenGetTokenSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    },
    fetchImpl: async () => {
      throw new Error('must not be called — the token request itself never settled');
    },
  });
  const controller = new AbortController();
  const pending = provider.resolve('a.b', { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, { name: 'AbortError' });
  assert.equal(tokenGetTokenSignal, controller.signal, "resolve's signal must reach the token provider's getToken");
});
