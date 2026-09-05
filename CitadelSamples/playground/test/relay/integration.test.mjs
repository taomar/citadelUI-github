/**
 * A genuine loopback integration test: the REAL playground proxy
 * (`createPlaygroundServer`) talking to the REAL standalone relay
 * (`createRelayServer`) over REAL sockets, on two separate ephemeral ports.
 *
 * Every other test in this suite drives one side or the other in isolation,
 * with the other side faked (`fakeRelay()` in `test/server.test.mjs`;
 * `handleExecuteRequest` called directly in `test/relay/server.test.mjs`).
 * That is deliberate and cheap, but it leaves one question unanswered: does
 * a request that actually crosses both hops — browser to proxy, proxy to
 * relay — survive the full production pipeline end to end? This file
 * answers that, using only production code on both sides:
 *
 *   - the proxy's own `checkStateChangingRequest`/`authenticatePrincipal`
 *     loopback guard, `validateExecuteRequest`, `rebuildRelayPlan`,
 *     `planDestinationOrigins`, and `mintAcknowledgement`
 *   - a real HTTP POST from the proxy to the relay, carrying a real
 *     `Authorization: Bearer <token>` header and a real JSON body
 *   - the relay's own `authenticatePrincipal`/`createSharedSecretAuthenticator`,
 *     `createStaticTenantPolicy`, `validateExecuteRequest`, `rebuildRelayPlan`,
 *     the destination-allowlist check, `verifyAcknowledgement`, the real
 *     `nonceStore`, and `createRelayHttpExecutor`
 *
 * The only things mocked are the two external boundaries neither this
 * playground nor its tests can reach for real: the identity/Key-Vault-shaped
 * secret provider (`createInMemorySecretProvider`, standing in for managed
 * identity + Key Vault) and the outbound call the relay's http executor
 * makes to the gateway/MCP server itself (`fakeFetch`, standing in for a
 * real APIM/MCP endpoint) — exactly the same substitutions
 * `test/relay/server.test.mjs` already makes for the relay in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { createPlaygroundServer } from '../../server.mjs';
import { createRelayServer } from '../../src/relay/server.mjs';
import { createOriginAllowlist } from '../../src/relay/originAllowlist.mjs';
import { createInMemorySecretProvider } from '../../src/relay/secretProvider.mjs';
import { createNonceStore } from '../../src/relay/nonceStore.mjs';
import { createStaticTenantPolicy, createRelayTenantBundle } from '../../src/relay/tenantPolicy.mjs';
import { deriveDefaultSampleRequestPolicy } from '../../src/relay/requestPolicy.mjs';
import { createSharedSecretAuthenticator, createDenyAllAuthenticator } from '../../src/relay/principalAuth.mjs';
import { computeRelayAllowedSampleIds } from '../../src/relay/requestSchema.mjs';
import { buildSamplePlan, CATALOGUE, requirementsFor } from '../../src/catalogue/index.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../../src/core/types.mjs';
import { FAKE_API_KEY } from '../helpers/fixtures.mjs';
import { fakeFetch, sseFrame } from '../helpers/transports.mjs';

const GATEWAY_ORIGIN = 'https://apim-citadel-test.azure-api.net';
const RELAY_TENANT = 'integration-tenant';
const RELAY_CALLER = 'citadel-playground-proxy-integration';
const RELAY_SHARED_TOKEN = 'integration-relay-token-do-not-use-elsewhere';
const ALLOWED_SAMPLE_IDS = Object.freeze(computeRelayAllowedSampleIds(CATALOGUE, { buildSamplePlan, requirementsFor }));

/** The relay's canned answer for the three MCP requests `weather-mcp-discovery` makes. */
function gatewayFetch() {
  return fakeFetch([
    {
      match: (_url, init) => JSON.parse(init.body).method === 'initialize',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'session-integration' },
        text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }),
      },
    },
    {
      match: (_url, init) => JSON.parse(init.body).method === 'notifications/initialized',
      response: {
        status: 204,
        headers: {},
        text: '',
      },
    },
    {
      match: (_url, init) => JSON.parse(init.body).method === 'tools/list',
      response: {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        text: sseFrame({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get-weather' }] } }),
      },
    },
  ]);
}

/** Starts a real server on an ephemeral loopback port; returns its base URL and a teardown. */
async function listenLoopback(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * Builds the real relay, wired exactly like a deployed one: a static tenant
 * policy naming this one tenant's allow-list, destination allowlist,
 * http executor and secret provider, and a shared-secret authenticator
 * standing in for a real Entra/OIDC-verified token.
 */
function realRelayServer({ originAllowlist = createOriginAllowlist([GATEWAY_ORIGIN]), fetchImpl = gatewayFetch() } = {}) {
  const bundle = createRelayTenantBundle({
    allowedSampleIds: ALLOWED_SAMPLE_IDS,
    originAllowlist,
    fetchImpl,
    // Derived against the request's own GATEWAY_ORIGIN regardless of the
    // (possibly mismatched, for the destination-refusal test) originAllowlist
    // override above — the origin-allowlist check runs first and refuses
    // that case before the request policy is ever consulted.
    requestPolicy: deriveDefaultSampleRequestPolicy(
      CATALOGUE,
      { buildSamplePlan, requirementsFor },
      { allowedSampleIds: ALLOWED_SAMPLE_IDS, gatewayUrl: GATEWAY_ORIGIN },
    ),
    secretProvider: createInMemorySecretProvider({ 'gatewayAccess.apiKey': FAKE_API_KEY }),
  });
  return createRelayServer({
    tenantPolicy: createStaticTenantPolicy({ [RELAY_TENANT]: bundle }),
    authenticator: createSharedSecretAuthenticator({ token: RELAY_SHARED_TOKEN, tenant: RELAY_TENANT, principal: RELAY_CALLER }),
    nonceStore: createNonceStore(),
  });
}

/**
 * Builds the real proxy, configured to forward to `relayBase` with the
 * SAME caller/tenant identity the relay's authenticator above resolves for
 * this shared-secret token — exactly the operator-coordinated pairing
 * `buildRelayConfig`'s own doc comment describes. `fetchImpl` is
 * deliberately left unset so the proxy's real `fetch` performs a genuine
 * loopback HTTP request to the relay; nothing about this hop is faked.
 */
function realProxyServer(relayBase) {
  return createPlaygroundServer({
    mode: 'preview',
    relay: {
      enabled: true,
      url: `${relayBase}/execute`,
      fetchImpl: null,
      credentialProvider: { getAuthorizationHeader: async () => `Bearer ${RELAY_SHARED_TOKEN}` },
      authenticator: createDenyAllAuthenticator(),
      allowedSampleIds: ALLOWED_SAMPLE_IDS,
      callerPrincipal: RELAY_CALLER,
      tenant: RELAY_TENANT,
    },
  });
}

test('a real request round-trips proxy -> relay -> (mocked gateway) over real loopback sockets, through every production handler on both hops', async () => {
  const relay = await listenLoopback(realRelayServer());
  try {
    const proxy = await listenLoopback(realProxyServer(relay.base));
    try {
      // The test itself is the "browser": a loopback fetch straight to the
      // proxy's public surface, presenting nothing but the same-origin
      // guard headers a real browser would send.
      const response = await fetch(`${proxy.base}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sampleId: 'weather-mcp-discovery',
          inputs: { 'hub.gatewayUrl': GATEWAY_ORIGIN },
        }),
      });
      assert.equal(response.status, 200, `expected the full round trip to succeed: ${await response.clone().text()}`);
      const body = await response.json();
      assert.equal(body.state, 'completed');
      assert.ok(
        body.assertions?.some((assertion) => assertion.id === 'assert-tools' && assertion.status === 'passed'),
        'the relay actually ran the sample through its real assertion core and reported a passing result, not a stub',
      );
      assert.equal(body.steps?.length, 4, 'all three MCP requests and the assertion step ran for real');
    } finally {
      await proxy.close();
    }
  } finally {
    await relay.close();
  }
});

test('a request the relay refuses (wrong destination allowlisted for this tenant) still round-trips as a controlled non-200, never a hang', async () => {
  // The relay is wired with an allowlist for a DIFFERENT origin than the one
  // the request actually asks for, so its own destination check refuses the
  // request — proving a real cross-hop rejection surfaces to the proxy's
  // caller as an ordinary HTTP response, not a stalled connection.
  const relay = await listenLoopback(realRelayServer({ originAllowlist: createOriginAllowlist(['https://a-different-gateway.azure-api.net']) }));
  try {
    const proxy = await listenLoopback(realProxyServer(relay.base));
    try {
      const response = await fetch(`${proxy.base}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sampleId: 'weather-mcp-discovery',
          inputs: { 'hub.gatewayUrl': GATEWAY_ORIGIN },
        }),
      });
      assert.notEqual(response.status, 200);
      const body = await response.json();
      assert.equal(body.state, 'blocked');
    } finally {
      await proxy.close();
    }
  } finally {
    await relay.close();
  }
});

test('a shared-secret credential the relay does not recognise is refused before anything executes, and the refusal is visible through the proxy', async () => {
  const relay = await listenLoopback(realRelayServer());
  try {
    // A proxy configured with a token the relay's authenticator will not
    // accept — the relay must refuse it before any tenant policy, schema,
    // or acknowledgement check ever runs.
    const proxy = await listenLoopback(
      createPlaygroundServer({
        mode: 'preview',
        relay: {
          enabled: true,
          url: `${relay.base}/execute`,
          fetchImpl: null,
          credentialProvider: { getAuthorizationHeader: async () => 'Bearer not-the-configured-token' },
          authenticator: createDenyAllAuthenticator(),
          allowedSampleIds: ALLOWED_SAMPLE_IDS,
          callerPrincipal: RELAY_CALLER,
          tenant: RELAY_TENANT,
        },
      }),
    );
    try {
      const response = await fetch(`${proxy.base}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sampleId: 'weather-mcp-discovery',
          inputs: { 'hub.gatewayUrl': GATEWAY_ORIGIN },
        }),
      });
      // The proxy does not forward the relay's raw HTTP status verbatim —
      // any non-2xx upstream answer is remapped to 502 (see `handleExecute`'s
      // upstream-forwarding branch) — but it DOES forward the relay's own
      // JSON body unchanged, so the relay's `unauthenticated` refusal is
      // still visible to the proxy's own caller inside that body.
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.code, 'unauthenticated');
    } finally {
      await proxy.close();
    }
  } finally {
    await relay.close();
  }
});
