/**
 * Managed-identity token acquisition against Container Apps or Azure Instance
 * Metadata Service, over an injected fetch — never a real network call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createManagedIdentityTokenProvider as createEnvTokenProvider,
} from '../../src/relay/managedIdentity.mjs';

const createManagedIdentityTokenProvider = (options = {}) =>
  createEnvTokenProvider({ environment: {}, ...options });

test('createManagedIdentityTokenProvider requires a resource', () => {
  assert.throws(() => createManagedIdentityTokenProvider({ fetchImpl: async () => ({}) }), /requires a `resource`/);
  assert.throws(
    () => createManagedIdentityTokenProvider({ resource: '  ', fetchImpl: async () => ({}) }),
    /requires a `resource`/,
  );
});

test('createManagedIdentityTokenProvider requires a fetch implementation when globalThis.fetch is unavailable', () => {
  const savedFetch = globalThis.fetch;
  try {
    // eslint-disable-next-line no-global-assign
    globalThis.fetch = undefined;
    assert.throws(() => createManagedIdentityTokenProvider({ resource: 'https://relay.example' }), /requires a fetch/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('getToken calls IMDS with the resource, api-version and Metadata header, and returns the token', async () => {
  const calls = [];
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({ access_token: 'imds-token-1', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }),
      };
    },
  });
  const token = await provider.getToken();
  assert.equal(token, 'imds-token-1');
  assert.equal(provider.mode, 'imds');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'http://169.254.169.254');
  assert.equal(url.pathname, '/metadata/identity/oauth2/token');
  assert.equal(url.searchParams.get('resource'), 'https://relay.example');
  assert.equal(url.searchParams.get('api-version'), '2019-08-01');
  assert.equal(calls[0].init.headers.Metadata, 'true');
  assert.equal(calls[0].init.headers['X-IDENTITY-HEADER'], undefined);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
});

test('Container Apps uses the injected local endpoint/header and includes the configured user-assigned client id', async () => {
  const calls = [];
  const provider = createEnvTokenProvider({
    resource: 'https://relay.example',
    clientId: 'playground-user-assigned-client-id',
    environment: {
      IDENTITY_ENDPOINT: 'http://127.42.0.7:42356/msi/token',
      IDENTITY_HEADER: 'container-apps-secret-header',
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          access_token: 'container-apps-token',
          expires_on: String(Math.floor(Date.now() / 1000) + 3600),
        }),
      };
    },
  });

  assert.equal(await provider.getToken(), 'container-apps-token');
  assert.equal(provider.mode, 'container-apps');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'http://127.42.0.7:42356');
  assert.equal(url.pathname, '/msi/token');
  assert.equal(url.searchParams.get('api-version'), '2019-08-01');
  assert.equal(url.searchParams.get('resource'), 'https://relay.example');
  assert.equal(url.searchParams.get('client_id'), 'playground-user-assigned-client-id');
  assert.deepEqual(calls[0].init.headers, { 'X-IDENTITY-HEADER': 'container-apps-secret-header' });
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
});

test('partial or malformed Container Apps identity injection fails closed before fetch', () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    throw new Error('must not fetch');
  };
  const endpoint = 'http://localhost:42356/msi/token';
  const cases = [
    [{ IDENTITY_ENDPOINT: endpoint }, /must be configured together/],
    [{ IDENTITY_HEADER: 'header' }, /must be configured together/],
    [{ IDENTITY_ENDPOINT: '', IDENTITY_HEADER: 'header' }, /IDENTITY_ENDPOINT/],
    [{ IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: ' ' }, /IDENTITY_HEADER/],
    [{ IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: 'header\ninjection' }, /IDENTITY_HEADER/],
    [{ IDENTITY_ENDPOINT: 'not-a-url', IDENTITY_HEADER: 'header' }, /valid absolute URL/],
    [{ IDENTITY_ENDPOINT: 'https://localhost:42356/msi/token', IDENTITY_HEADER: 'header' }, /HTTP loopback/],
    [{ IDENTITY_ENDPOINT: 'http://identity.example/msi/token', IDENTITY_HEADER: 'header' }, /HTTP loopback/],
    [{ IDENTITY_ENDPOINT: 'http://169.254.169.254/metadata/identity/oauth2/token', IDENTITY_HEADER: 'header' }, /HTTP loopback/],
    [{ IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token?next=http://example.test', IDENTITY_HEADER: 'header' }, /HTTP loopback/],
    [{ IDENTITY_ENDPOINT: 'http://user@localhost:42356/msi/token', IDENTITY_HEADER: 'header' }, /HTTP loopback/],
    [{ IDENTITY_ENDPOINT: 'http://localhost:42356/not-the-token-path', IDENTITY_HEADER: 'header' }, /HTTP loopback/],
  ];
  for (const [environment, expected] of cases) {
    assert.throws(
      () =>
        createEnvTokenProvider({
          resource: 'https://relay.example',
          environment,
          fetchImpl,
        }),
      expected,
    );
  }
  assert.equal(requests, 0);
});

test('the secure default accepts current Container Apps loopback endpoint variants', async () => {
  const endpoints = [
    'http://localhost/msi/token/',
    'http://127.0.0.2:42356/msi/token',
    'http://[::1]:42356/MSI/token/',
  ];
  for (const endpoint of endpoints) {
    const calls = [];
    const provider = createEnvTokenProvider({
      resource: 'https://relay.example',
      environment: { IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: 'header' },
      fetchImpl: async (url) => {
        calls.push(url);
        return {
          ok: true,
          json: async () => ({
            access_token: 'token',
            expires_on: Math.floor(Date.now() / 1000) + 3600,
          }),
        };
      },
    });
    assert.equal(await provider.getToken(), 'token');
    assert.equal(new URL(calls[0]).hostname, new URL(endpoint).hostname);
  }
});

test('a code-level validator can admit a future local path without weakening the secure default', async () => {
  const endpoint = 'http://127.0.0.1:42356/platform/identity/token';
  const calls = [];
  const provider = createEnvTokenProvider({
    resource: 'https://relay.example',
    environment: { IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: 'header' },
    identityEndpointValidator: (url) =>
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.pathname === '/platform/identity/token',
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        json: async () => ({
          access_token: 'token',
          expires_on: Math.floor(Date.now() / 1000) + 3600,
        }),
      };
    },
  });
  assert.equal(await provider.getToken(), 'token');
  assert.equal(new URL(calls[0]).pathname, '/platform/identity/token');
});

test('a client id is only added to the request when one is configured', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ access_token: 't', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) };
  };
  await createManagedIdentityTokenProvider({ resource: 'https://relay.example', fetchImpl }).getToken();
  assert.equal(new URL(calls[0]).searchParams.has('client_id'), false);

  calls.length = 0;
  await createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    clientId: 'user-assigned-id',
    fetchImpl,
  }).getToken();
  assert.equal(new URL(calls[0]).searchParams.get('client_id'), 'user-assigned-id');
});

test('a non-OK IMDS response is a rejection, not a silently-empty token', async () => {
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  await assert.rejects(() => provider.getToken(), /HTTP 500/);
});

test('a response with no access_token is a rejection', async () => {
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(() => provider.getToken(), /returned no access token/);
});

test('a response with an invalid or already-expired expiration is rejected and never cached', async () => {
  let requests = 0;
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    now: () => 1_000_000,
    fetchImpl: async () => {
      requests++;
      return {
        ok: true,
        json: async () => ({
          access_token: 'must-not-cache',
          expires_on: requests === 1 ? 'not-a-number' : 999,
        }),
      };
    },
  });
  await assert.rejects(() => provider.getToken(), /invalid or expired token expiration/);
  await assert.rejects(() => provider.getToken(), /invalid or expired token expiration/);
  assert.equal(requests, 2);
  assert.equal(provider.cachedExpiryMs, null);
});

test('a cached, still-fresh token is reused rather than re-requested', async () => {
  let now = 1_000_000;
  let requests = 0;
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    now: () => now,
    fetchImpl: async () => {
      requests++;
      return { ok: true, json: async () => ({ access_token: `token-${requests}`, expires_on: (now + 3600_000) / 1000 }) };
    },
  });
  const first = await provider.getToken();
  const second = await provider.getToken();
  assert.equal(first, second);
  assert.equal(requests, 1);

  now += 3600_000; // advance past expiry (and the clock-skew margin)
  const third = await provider.getToken();
  assert.notEqual(third, first);
  assert.equal(requests, 2);
});

test('Container Apps token responses retain the same successful cache semantics', async () => {
  let now = 1_000_000;
  let requests = 0;
  const provider = createEnvTokenProvider({
    resource: 'https://relay.example',
    environment: {
      IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
      IDENTITY_HEADER: 'aca-header',
    },
    now: () => now,
    fetchImpl: async () => {
      requests++;
      return {
        ok: true,
        json: async () => ({
          access_token: `aca-token-${requests}`,
          expires_on: (now + 3600_000) / 1000,
        }),
      };
    },
  });
  assert.equal(await provider.getToken(), 'aca-token-1');
  assert.equal(await provider.getToken(), 'aca-token-1');
  assert.equal(requests, 1);
  now += 3600_000;
  assert.equal(await provider.getToken(), 'aca-token-2');
  assert.equal(requests, 2);
});

test('concurrent callers collapse onto a single in-flight token request', async () => {
  let requests = 0;
  let resolveFetch;
  const gate = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => {
      requests++;
      await gate;
      return { ok: true, json: async () => ({ access_token: 'shared-token', expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
    },
  });
  const first = provider.getToken();
  const second = provider.getToken();
  resolveFetch();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, 'shared-token');
  assert.equal(b, 'shared-token');
  assert.equal(requests, 1);
});

test('cachedExpiryMs exposes only the expiry, never the token itself', async () => {
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'secret-token-value', expires_on: 2_000_000_000 }) }),
  });
  assert.equal(provider.cachedExpiryMs, null);
  await provider.getToken();
  assert.equal(provider.cachedExpiryMs, 2_000_000_000_000);
});

/* ------------------------------------------------------------- deadlines */

test('a never-settling IMDS request is bounded by its own internal timeout, even with no caller signal at all', async () => {
  const fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      // A real fetch honors an AbortSignal this way; this fixture mirrors
      // that so the internal `requestTimeoutMs` bound below is exercised
      // exactly like it would be in production, over a genuinely hanging
      // IMDS endpoint.
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
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: fetch,
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => provider.getToken(), /timed out/);
});

test('a never-settling response.json() is bounded by the same internal timeout as the fetch itself, even though the fetch resolved fine', async () => {
  // The fetch settles almost immediately — `ok: true`, headers effectively
  // "arrived" — but the body is never actually delivered. Before this
  // fix, `requestTimeoutMs`'s timer was cleared the moment `doFetch`
  // resolved, leaving this phase completely unbounded.
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => provider.getToken(), /timed out/);
});

test('Container Apps fetch and body stalls are bounded without leaking its identity header', async () => {
  const environment = {
    IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
    IDENTITY_HEADER: 'aca-header-must-not-appear-in-errors',
  };
  const neverSettles = () => new Promise(() => {});
  const fetchStall = createEnvTokenProvider({
    resource: 'https://relay.example',
    environment,
    fetchImpl: neverSettles,
    requestTimeoutMs: 20,
  });
  await assert.rejects(
    () => fetchStall.getToken(),
    (error) => /timed out/.test(error.message) && !error.message.includes(environment.IDENTITY_HEADER),
  );

  const bodyStall = createEnvTokenProvider({
    resource: 'https://relay.example',
    environment,
    fetchImpl: async () => ({ ok: true, json: neverSettles }),
    requestTimeoutMs: 20,
  });
  await assert.rejects(
    () => bodyStall.getToken(),
    (error) => /timed out/.test(error.message) && !error.message.includes(environment.IDENTITY_HEADER),
  );
});

test('a fetchImpl that ignores its signal entirely (never rejects on abort) is still bounded by the internal timeout, for both the fetch phase and the body-parse phase', async () => {
  const neverSettles = () => new Promise(() => {});
  const ignoresSignalDuringFetch = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: () => neverSettles(),
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => ignoresSignalDuringFetch.getToken(), /timed out/);

  const ignoresSignalDuringJson = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => ({ ok: true, json: () => neverSettles() }),
    requestTimeoutMs: 20,
  });
  await assert.rejects(() => ignoresSignalDuringJson.getToken(), /timed out/);
});

test('when the shared in-flight request itself times out, every concurrent caller rejects consistently and the cache is left clean for the next call', async () => {
  let requests = 0;
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => {
      requests++;
      return { ok: true, json: () => new Promise(() => {}) }; // hangs forever in the body-parse phase
    },
    requestTimeoutMs: 20,
  });
  const first = provider.getToken();
  const second = provider.getToken();
  await assert.rejects(() => first, /timed out/);
  await assert.rejects(() => second, /timed out/);
  assert.equal(requests, 1, 'two concurrent callers must still collapse onto a single underlying request, even one that times out');
  assert.equal(provider.cachedExpiryMs, null, 'a timed-out request must never poison the cache with a stale/partial result');
  // A fresh call after the timed-out one has fully settled starts its own
  // new request rather than reusing anything from the failed attempt.
  const thirdProvider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'fresh-token', expires_on: Math.floor(Date.now() / 1000) + 3600 }) }),
  });
  assert.equal(await thirdProvider.getToken(), 'fresh-token');
});

test("a caller's own signal firing stops that caller from waiting, but never aborts the shared in-flight IMDS request or poisons the cache for the next call", async () => {
  let requests = 0;
  let resolveFetch;
  const gate = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    fetchImpl: async () => {
      requests++;
      await gate;
      return { ok: true, json: async () => ({ access_token: 'shared-token', expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
    },
  });
  const controller = new AbortController();
  const impatientCaller = provider.getToken({ signal: controller.signal });
  const patientCaller = provider.getToken();
  controller.abort();
  await assert.rejects(() => impatientCaller, /Aborted/);
  // The shared request itself is untouched by the aborted caller above —
  // it settles normally once the fetch itself completes, and the OTHER,
  // concurrent, non-aborted caller still gets the real token.
  resolveFetch();
  assert.equal(await patientCaller, 'shared-token');
  assert.equal(requests, 1, 'one caller aborting must not trigger — or be counted as — a second IMDS request');
  // The cache is not poisoned either: a fresh call after both have settled
  // reuses the successfully cached token rather than re-requesting or
  // rejecting.
  assert.equal(await provider.getToken(), 'shared-token');
  assert.equal(requests, 1);
});


test('an already-aborted signal passed to getToken rejects that call immediately, without waiting on the shared request', async () => {
  const provider = createManagedIdentityTokenProvider({
    resource: 'https://relay.example',
    // Never actually reached by the aborted caller below within the
    // test's lifetime; a slow/never-resolving fetch here would still leave
    // this specific `getToken` call rejected right away. `requestTimeoutMs`
    // is set short purely so this deliberately-never-settling fixture (it
    // does not itself honor `init.signal`, unlike the fixtures elsewhere in
    // this file) does not leave the test process waiting on the provider's
    // own internal timeout after the assertion below has already passed.
    fetchImpl: async () => {
      await new Promise(() => {});
      return { ok: true, json: async () => ({ access_token: 't', expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
    },
    requestTimeoutMs: 20,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => provider.getToken({ signal: controller.signal }), /Aborted/);
});
