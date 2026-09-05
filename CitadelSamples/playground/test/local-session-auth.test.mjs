import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createPlaygroundServer } from '../server.mjs';
import {
  LOCAL_SESSION_BOOTSTRAP_HEADER,
  LOCAL_SESSION_CLAIM_PATH,
  LOCAL_SESSION_PROTOCOL_VERSION,
} from '../src/core/localSession.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../src/core/types.mjs';
import {
  claimLocalSession,
  createAuthenticatedFetch,
  TEST_BOOTSTRAP_CAPABILITY,
} from './helpers/localSession.mjs';

const OTHER_BOOTSTRAP_CAPABILITY = 'B'.repeat(43);

async function startServer(options = {}) {
  const server = createPlaygroundServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    baseUrl,
    rawCall: (path, init = {}) => fetch(new URL(path, baseUrl), init),
    async close() {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    },
  };
}

function claimRequest(baseUrl, capability, { path = LOCAL_SESSION_CLAIM_PATH, body, headers = {} } = {}) {
  return fetch(new URL(path, baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: baseUrl,
      'Sec-Fetch-Site': 'same-origin',
      [LOCAL_SESSION_BOOTSTRAP_HEADER]: capability,
      ...headers,
    },
    body: body ?? JSON.stringify({ protocolVersion: LOCAL_SESSION_PROTOCOL_VERSION }),
  });
}

function runBody() {
  return JSON.stringify({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId: 'azure-context-check',
    inputs: {},
  });
}

test('plain loopback URLs stay read-only and advertise the secure launch requirement', async () => {
  const local = await startServer({
    mode: 'execute',
    testBootstrapCapability: TEST_BOOTSTRAP_CAPABILITY,
    runManager: { start: async () => assert.fail('an unclaimed request reached the manager'), cancelAll() {} },
  });
  try {
    const capabilitiesResponse = await local.rawCall('/api/capabilities');
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json();
    assert.deepEqual(capabilities.sessionAuth, {
      required: true,
      state: 'unclaimed',
      claimEndpoint: LOCAL_SESSION_CLAIM_PATH,
      message: 'Open the secure launch URL shown in the terminal.',
    });
    assert.equal(capabilities.executor.canExecute, false);
    assert.equal(capabilities.executor.endpoint, null);
    assert.equal(capabilities.selfTest.available, false);
    assert.equal(capabilities.sourceValidation.available, false);
    assert.equal(capabilities.executionContext.endpoint, null);
    assert.equal(JSON.stringify(capabilities).includes(TEST_BOOTSTRAP_CAPABILITY), false);

    assert.equal((await local.rawCall('/')).status, 200);
    assert.equal((await local.rawCall('/api/source/azure-context-check')).status, 200);

    const run = await local.rawCall('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: local.baseUrl },
      body: runBody(),
    });
    assert.equal(run.status, 401);
    assert.deepEqual(await run.json(), {
      state: 'blocked',
      summary: 'Open the secure launch URL shown in the terminal.',
      code: 'local-session-required',
    });
  } finally {
    await local.close();
  }
});

test('a valid bootstrap claim returns only a strict HttpOnly cookie and enables the browser path', async () => {
  let starts = 0;
  const manager = {
    async start() {
      starts += 1;
      return { runId: 'session-run-0001', state: 'completed', summary: 'ok', steps: [], assertions: [] };
    },
    cancel: () => ({ cancelled: false }),
    cancelAll() {},
    activeCount: 0,
    listActive: () => [],
  };
  const local = await startServer({
    mode: 'execute',
    runManager: manager,
    testBootstrapCapability: TEST_BOOTSTRAP_CAPABILITY,
  });
  try {
    const claim = await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY);
    assert.equal(claim.status, 204);
    assert.equal(await claim.text(), '');
    const setCookie = claim.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /^citadel_playground_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /; HttpOnly(?:;|$)/);
    assert.match(setCookie, /; SameSite=Strict(?:;|$)/);
    assert.match(setCookie, /; Path=\/(?:;|$)/);
    assert.doesNotMatch(setCookie, /; Secure(?:;|$)/);
    assert.doesNotMatch(setCookie, /(?:Expires|Max-Age|Domain)=/i);

    const cookie = setCookie.split(';', 1)[0];
    const call = createAuthenticatedFetch(local.baseUrl, cookie);
    const capabilities = await (await call('/api/capabilities')).json();
    assert.equal(capabilities.sessionAuth.state, 'claimed');
    assert.equal(capabilities.executor.kind, 'local');
    assert.equal(capabilities.executionContext.endpoint, '/api/execution-context');

    const run = await call('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: runBody(),
    });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).runId, 'session-run-0001');
    assert.equal(starts, 1);
  } finally {
    await local.close();
  }
});

test('missing, wrong, duplicate, and oversized cookies are denied before a manager runs', async () => {
  let starts = 0;
  const manager = {
    async start() {
      starts += 1;
      return { state: 'completed' };
    },
    cancelAll() {},
  };
  const local = await startServer({
    mode: 'execute',
    runManager: manager,
    testBootstrapCapability: TEST_BOOTSTRAP_CAPABILITY,
  });
  try {
    const { cookie } = await claimLocalSession(local.baseUrl);
    for (const cookieHeader of [
      '',
      `citadel_playground_session=${OTHER_BOOTSTRAP_CAPABILITY}`,
      `${cookie}; ${cookie}`,
      `padding=${'x'.repeat(5000)}; ${cookie}`,
    ]) {
      const response = await local.rawCall('/api/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: local.baseUrl,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: runBody(),
      });
      assert.equal(response.status, 401);
    }
    assert.equal(starts, 0);
  } finally {
    await local.close();
  }
});

test('a valid cookie still requires an exact same-origin browser request', async () => {
  let starts = 0;
  const local = await startServer({
    mode: 'execute',
    runManager: {
      async start() {
        starts += 1;
        return { state: 'completed' };
      },
      cancelAll() {},
    },
    testBootstrapCapability: TEST_BOOTSTRAP_CAPABILITY,
  });
  try {
    const { cookie } = await claimLocalSession(local.baseUrl);
    const omittedOrigin = await local.rawCall('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: runBody(),
    });
    assert.equal(omittedOrigin.status, 403);

    const crossOrigin = await local.rawCall('/api/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'https://evil.example.test',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: runBody(),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(starts, 0);
  } finally {
    await local.close();
  }
});

test('the bootstrap claim is exact, bounded, one-time, and race-safe', async () => {
  const local = await startServer({ testBootstrapCapability: TEST_BOOTSTRAP_CAPABILITY });
  try {
    assert.equal((await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY, { path: `${LOCAL_SESSION_CLAIM_PATH}/` })).status, 404);
    assert.equal((await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY, { path: `${LOCAL_SESSION_CLAIM_PATH}?again=1` })).status, 404);
    assert.equal(
      (
        await local.rawCall(LOCAL_SESSION_CLAIM_PATH, {
          method: 'GET',
          headers: { Origin: local.baseUrl },
        })
      ).status,
      405,
    );
    assert.equal((await claimRequest(local.baseUrl, OTHER_BOOTSTRAP_CAPABILITY)).status, 401);
    assert.equal(
      (
        await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY, {
          headers: { 'Content-Type': 'application/jsonp' },
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY, {
          body: JSON.stringify({ protocolVersion: LOCAL_SESSION_PROTOCOL_VERSION, capability: TEST_BOOTSTRAP_CAPABILITY }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY, {
          headers: { 'Content-Encoding': 'gzip' },
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY, {
          body: JSON.stringify({ protocolVersion: LOCAL_SESSION_PROTOCOL_VERSION, padding: 'x'.repeat(1100) }),
        })
      ).status,
      413,
    );

    const results = await Promise.all([
      claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY),
      claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort((a, b) => a - b),
      [204, 409],
    );
    assert.equal((await claimRequest(local.baseUrl, TEST_BOOTSTRAP_CAPABILITY)).status, 409);
  } finally {
    await local.close();
  }
});

test('a restart rotates both bootstrap admission and the session cookie', async () => {
  const first = await startServer();
  const firstLaunch = new URL(first.server.localSessionAuth.launchUrl(first.baseUrl));
  const firstBootstrap = new URLSearchParams(firstLaunch.hash.slice(1)).get('bootstrap');
  const firstClaim = await claimLocalSession(first.baseUrl, firstBootstrap);
  await first.close();

  const second = await startServer();
  try {
    const secondLaunch = new URL(second.server.localSessionAuth.launchUrl(second.baseUrl));
    const secondBootstrap = new URLSearchParams(secondLaunch.hash.slice(1)).get('bootstrap');
    assert.notEqual(secondBootstrap, firstBootstrap);
    assert.equal((await claimRequest(second.baseUrl, firstBootstrap)).status, 401);
    const secondClaim = await claimLocalSession(second.baseUrl, secondBootstrap);
    assert.notEqual(secondClaim.cookie, firstClaim.cookie);

    const staleSession = await second.rawCall('/api/self-test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: firstClaim.cookie,
        Origin: second.baseUrl,
      },
      body: JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION }),
    });
    assert.equal(staleSession.status, 401);
  } finally {
    await second.close();
  }
});

test('every privileged local POST is denied before managers, spawns, or relay credentials', async () => {
  const calls = [];
  const record = (name, value) => {
    calls.push(name);
    return value;
  };
  const local = await startServer({
    mode: 'execute',
    testBootstrapCapability: TEST_BOOTSTRAP_CAPABILITY,
    runManager: {
      start: async () => record('run.start', {}),
      cancel: () => record('run.cancel', {}),
      cancelAll() {},
    },
    codeValidationManager: {
      start: async () => record('validation.start', {}),
      cancel: () => record('validation.cancel', {}),
      cancelAll() {},
    },
    executionContextManager: {
      describe: async () => record('identity.describe', {}),
      startLogin: () => record('identity.startLogin', {}),
      statusLogin: () => record('identity.statusLogin', {}),
      cancelLogin: () => record('identity.cancelLogin', {}),
      cancelAll() {},
    },
    relay: {
      enabled: true,
      url: 'https://relay.example.test/execute',
      fetchImpl: async () => record('relay.fetch', {}),
      credentialProvider: {
        getAuthorizationHeader: async () => record('relay.credential', 'Bearer unreachable'),
      },
      authenticator: { authenticate: async () => record('relay.authenticate', { ok: true }) },
      allowedSampleIds: ['weather-mcp-discovery'],
      callerPrincipal: 'test-proxy',
      tenant: 'test-tenant',
    },
  });
  try {
    const requests = [
      ['/api/run', runBody()],
      ['/api/run/cancel', JSON.stringify({ runId: 'run-0001' })],
      [
        '/api/execution-context',
        JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sampleId: 'azure-context-check',
          configuredSubscriptionId: null,
          gateway: null,
        }),
      ],
      ['/api/azure-login/start', JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION })],
      ['/api/azure-login/status', JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, loginId: 'login-0001' })],
      ['/api/azure-login/cancel', JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION, loginId: 'login-0001' })],
      ['/api/execute', '{}'],
      ['/api/self-test', JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION })],
      ['/api/source/azure-context-check/validate', JSON.stringify({ protocolVersion: EXECUTION_PROTOCOL_VERSION })],
      ['/api/future-account/select', '{}'],
    ];
    for (const [path, body] of requests) {
      const response = await local.rawCall(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: local.baseUrl },
        body,
      });
      assert.equal(response.status, 401, `${path} must require the local session before dispatch`);
    }
    assert.deepEqual(calls, []);
  } finally {
    await local.close();
  }
});
