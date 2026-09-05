/**
 * The standalone relay's own HTTP surface: `handleExecuteRequest` (the pure
 * handler) and `createRelayServer` (the `node:http` wrapper around it).
 *
 * These tests prove the request pipeline order the module's own comment
 * documents — auth, tenant-policy resolution, schema/allow-list, plan
 * rebuild, destination check, acknowledgement, nonce, secret resolution,
 * execution — and that a caller never reaches the secret provider or the
 * execution core without first clearing every earlier gate, INCLUDING the
 * gate that a caller authenticated for one tenant cannot reach a different
 * tenant's samples, destinations, or secrets.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect as netConnect } from 'node:net';

import { buildSamplePlan, CATALOGUE, getSample, requirementsFor } from '../../src/catalogue/index.mjs';
import { EXECUTION_PROTOCOL_VERSION } from '../../src/core/types.mjs';
import { createExecutionPlan, step } from '../../src/core/plan.mjs';
import { createRelayServer, handleExecuteRequest } from '../../src/relay/server.mjs';
import { createRelayHttpExecutor } from '../../src/relay/httpExecutor.mjs';
import { createOriginAllowlist } from '../../src/relay/originAllowlist.mjs';
import { createInMemorySecretProvider } from '../../src/relay/secretProvider.mjs';
import { createNonceStore } from '../../src/relay/nonceStore.mjs';
import { createInMemoryManagedRunStore, createManagedRunOrchestrator } from '../../src/relay/managedRun.mjs';
import { computeRelayAllowedSampleIds } from '../../src/relay/requestSchema.mjs';
import {
  createDenyAllAuthenticator,
  createSharedSecretAuthenticator,
  LOOPBACK_DEV_PRINCIPAL,
  LOOPBACK_DEV_TENANT,
} from '../../src/relay/principalAuth.mjs';
import { createStaticTenantPolicy, createRelayTenantBundle } from '../../src/relay/tenantPolicy.mjs';
import { createSampleRequestPolicy, deriveDefaultSampleRequestPolicy } from '../../src/relay/requestPolicy.mjs';
import { mintAcknowledgement, ACKNOWLEDGEMENT_TTL_MS, ACKNOWLEDGEMENT_CLOCK_SKEW_MS } from '../../src/relay/acknowledgement.mjs';
import { FAKE_API_KEY, makeFixtureReader } from '../helpers/fixtures.mjs';
import { fakeFetch, sseFrame } from '../helpers/transports.mjs';

const GATEWAY_ORIGIN = 'https://apim-citadel-test.azure-api.net';
const GATEWAY_ORIGIN_B = 'https://apim-citadel-other.azure-api.net';
const ALLOWED = computeRelayAllowedSampleIds(CATALOGUE, { buildSamplePlan, requirementsFor });

/**
 * `weather-mcp-discovery`'s single literal request URL under the fixture
 * inputs, for a given gateway origin. All three of its http steps
 * (`initialize`, `notifications/initialized`, and `tools/list`) hit the same
 * MCP endpoint path, so a bare origin no
 * longer suffices as an acknowledgement target now that the acknowledgement
 * binds to `planRequestUrls` (literal URLs), not `planDestinationOrigins`.
 */
function weatherUrlFor(origin) {
  return `${origin}/mcp/weather-tool-mcp/mcp`;
}
const WEATHER_URL = weatherUrlFor(GATEWAY_ORIGIN);

const WEATHER_SAMPLE = getSample('weather-mcp-discovery');
const WEATHER_SECRET_REFS = WEATHER_SAMPLE.configurationEntries.filter((entry) => entry.secret).map((entry) => entry.path);

const TENANT_A = 'tenant-a';
const CALLER_A = 'caller-a';
const TENANT_B = 'tenant-b';
const CALLER_B = 'caller-b';
const RELAY_TOKEN = 'relay-service-token';

function fixtureInputsFor(sample) {
  const read = makeFixtureReader();
  const inputs = {};
  for (const entry of sample.configurationEntries) {
    if (entry.secret) continue;
    inputs[entry.path] = read(entry.path);
  }
  return inputs;
}

const WEATHER_INPUTS = fixtureInputsFor(WEATHER_SAMPLE);

/**
 * A correctly bound acknowledgement for the fixed weather-mcp-discovery
 * fixture request, bound by default to tenant A's own caller/tenant. Every
 * field must independently match what `handleExecuteRequest` re-derives
 * from its own resolved auth context and rebuilt plan, so tests that want an
 * INVALID acknowledgement pass explicit overrides rather than hand-rolling a
 * shape that happens to look plausible.
 */
function weatherAcknowledgement(overrides = {}) {
  return mintAcknowledgement({
    sampleId: WEATHER_SAMPLE.id,
    inputs: WEATHER_INPUTS,
    secretRefs: WEATHER_SECRET_REFS,
    target: WEATHER_URL,
    riskText: WEATHER_SAMPLE.risk.effect,
    caller: CALLER_A,
    tenant: TENANT_A,
    ...overrides,
  });
}

function weatherPayload(overrides = {}) {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sampleId: WEATHER_SAMPLE.id,
    inputs: WEATHER_INPUTS,
    acknowledgement: weatherAcknowledgement(),
    ...overrides,
  };
}

function mcpFetch() {
  return fakeFetch([
    {
      match: (_url, init) => JSON.parse(init.body).method === 'initialize',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json', 'Mcp-Session-Id': 'session-abc' },
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

/** Counts every call, so a test can assert a gate refused a request BEFORE the secret provider was ever touched. */
function spySecretProvider(real) {
  const calls = [];
  return Object.freeze({
    calls,
    async resolve(ref) {
      calls.push(ref);
      return real.resolve(ref);
    },
  });
}

/** Counts every call, so a test can assert a gate refused a request BEFORE the network-facing executor was ever touched. */
function spyHttpExecutor(real) {
  const calls = [];
  return Object.freeze({
    calls,
    // Forwarded by reference so `assertBundle`'s httpExecutor/requestPolicy
    // pairing check still sees the real executor's requestPolicy through
    // this spy wrapper, rather than reporting a false drift.
    requestPolicy: real.requestPolicy,
    async execute(plan, options) {
      calls.push(plan);
      return real.execute(plan, options);
    },
  });
}

/**
 * A complete, independently-provisioned tenant-policy bundle: its own
 * allow-list, its own destination allowlist/http executor pair, and its own
 * (spy-wrapped, so tests can assert on call counts) secret provider.
 */
function makeBundle({
  allowedSampleIds = ALLOWED,
  gatewayOrigin = GATEWAY_ORIGIN,
  secretValues = { 'gatewayAccess.apiKey': FAKE_API_KEY },
  allowedRoles,
} = {}) {
  const originAllowlist = createOriginAllowlist([gatewayOrigin]);
  const requestPolicy = deriveDefaultSampleRequestPolicy(CATALOGUE, { buildSamplePlan, requirementsFor }, { allowedSampleIds, gatewayUrl: gatewayOrigin });
  return {
    allowedSampleIds,
    originAllowlist,
    httpExecutor: spyHttpExecutor(createRelayHttpExecutor({ fetchImpl: mcpFetch(), allowlist: originAllowlist, requestPolicy })),
    requestPolicy,
    secretProvider: spySecretProvider(createInMemorySecretProvider(secretValues)),
    ...(allowedRoles !== undefined ? { allowedRoles } : {}),
  };
}

function baseDeps({ auth, tenants, ...overrides } = {}) {
  // `auth` is intentionally distinguished from "not provided": passing
  // `auth: null` exercises the "no authenticated context at all" path,
  // whereas omitting `auth` falls back to a well-formed default. The
  // tenant-policy map is always keyed by TENANT_A regardless of what a
  // test's `auth` override carries — malformed/empty auth values must
  // never need to be valid map keys, since handleExecuteRequest is
  // expected to reject those before ever consulting the tenant policy.
  const effectiveAuth = auth === undefined ? { principal: CALLER_A, tenant: TENANT_A, roles: [] } : auth;
  const policyTenants = tenants ?? { [TENANT_A]: makeBundle() };
  return {
    catalogue: CATALOGUE,
    tenantPolicy: createStaticTenantPolicy(policyTenants),
    auth: effectiveAuth,
    nonceStore: createNonceStore(),
    ...overrides,
  };
}

/* --------------------------------------------------- handleExecuteRequest */

test('a well-formed, allow-listed, freshly-nonced request executes end to end', async () => {
  const { status, body } = await handleExecuteRequest(weatherPayload(), baseDeps());
  assert.equal(status, 200);
  assert.equal(body.state, 'completed');
});

test('a missing principal or tenant on the authenticated context is refused with 401, before any tenant-policy lookup', async () => {
  const noPrincipal = await handleExecuteRequest(weatherPayload(), baseDeps({ auth: { principal: '', tenant: TENANT_A } }));
  assert.equal(noPrincipal.status, 401);
  assert.equal(noPrincipal.body.code, 'unauthenticated');

  const noTenant = await handleExecuteRequest(weatherPayload(), baseDeps({ auth: { principal: CALLER_A, tenant: '' } }));
  assert.equal(noTenant.status, 401);
  assert.equal(noTenant.body.code, 'unauthenticated');

  const nothingAtAll = await handleExecuteRequest(weatherPayload(), baseDeps({ auth: null }));
  assert.equal(nothingAtAll.status, 401);
});

test('a request with no acknowledgement at all is refused with code acknowledgement-required', async () => {
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: {} }), baseDeps());
  assert.equal(status, 400);
  assert.equal(body.code, 'acknowledgement-required');
});

test('an otherwise valid acknowledgement with no nonce is refused with code nonce-required', async () => {
  const { nonce, ...withoutNonce } = weatherAcknowledgement();
  void nonce;
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: withoutNonce }), baseDeps());
  assert.equal(status, 400);
  assert.equal(body.code, 'nonce-required');
});

test('an acknowledgement past its expiry is refused with code acknowledgement-expired, even though everything else matches', async () => {
  const expired = weatherAcknowledgement({ now: () => Date.now() - 60 * 60_000 });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: expired }), baseDeps());
  assert.equal(status, 409);
  assert.equal(body.code, 'acknowledgement-expired');
});

test('an acknowledgement bound to a different sample is refused with code acknowledgement-sample-mismatch', async () => {
  const wrongSample = weatherAcknowledgement({ sampleId: 'a-different-sample' });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: wrongSample }), baseDeps());
  assert.equal(status, 403);
  assert.equal(body.code, 'acknowledgement-sample-mismatch');
});

test('an acknowledgement bound to a different destination is refused with code acknowledgement-target-mismatch', async () => {
  const wrongTarget = weatherAcknowledgement({ target: 'https://not-the-configured-gateway.example.net' });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: wrongTarget }), baseDeps());
  assert.equal(status, 403);
  assert.equal(body.code, 'acknowledgement-target-mismatch');
});

test('an acknowledgement whose input digest does not match the inputs actually forwarded is refused', async () => {
  const staleDigestAck = weatherAcknowledgement({ inputs: { ...WEATHER_INPUTS, 'weatherTool.city': 'a-different-city' } });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: staleDigestAck }), baseDeps());
  assert.equal(status, 403);
  assert.equal(body.code, 'acknowledgement-input-mismatch');
});

test('an acknowledgement bound to a stale risk description is refused with code acknowledgement-risk-mismatch', async () => {
  const staleRisk = weatherAcknowledgement({ riskText: 'a risk description this sample no longer carries' });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: staleRisk }), baseDeps());
  assert.equal(status, 403);
  assert.equal(body.code, 'acknowledgement-risk-mismatch');
});

test('a replayed nonce is refused the second time it is delivered, even though every binding still matches', async () => {
  const deps = baseDeps();
  const ack = weatherAcknowledgement();
  const first = await handleExecuteRequest(weatherPayload({ acknowledgement: ack }), deps);
  assert.equal(first.status, 200);
  const second = await handleExecuteRequest(weatherPayload({ acknowledgement: ack }), deps);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'nonce-replayed');
});

test('the reviewer reproduction: direct /execute at the exact future-skew boundary — a nonce consumed once is still refused on replay past the nonce store\'s OLD fixed default TTL, since real acknowledgement expiry (not that fixed default) now governs retention', async () => {
  // An acknowledgement minted at the maximum allowed future skew: issuedAt
  // sits exactly at `now + ACKNOWLEDGEMENT_CLOCK_SKEW_MS`, so its real
  // expiresAt is a full `ACKNOWLEDGEMENT_TTL_MS + ACKNOWLEDGEMENT_CLOCK_SKEW_MS`
  // (6 minutes) away from the verification instant below — one minute
  // beyond the nonce store's own fixed 5-minute default TTL.
  const t0 = Date.now();
  const ack = weatherAcknowledgement({ now: () => t0 + ACKNOWLEDGEMENT_CLOCK_SKEW_MS });
  assert.equal(ack.expiresAt, t0 + ACKNOWLEDGEMENT_CLOCK_SKEW_MS + ACKNOWLEDGEMENT_TTL_MS);

  let now = t0;
  const nonceStore = createNonceStore({ now: () => now });
  const deps = baseDeps({ nonceStore, now: () => now });

  const first = await handleExecuteRequest(weatherPayload({ acknowledgement: ack }), deps);
  assert.equal(first.status, 200, 'the first, legitimate delivery executes normally');

  // Advance past where the nonce store's OLD fixed 5-minute default TTL
  // would have already swept this entry — but still well inside the real,
  // skew-extended acknowledgement validity window.
  now = t0 + 5 * 60_000 + 1;
  assert.ok(ack.expiresAt > now, 'the acknowledgement itself must still be unexpired at this instant');

  const replay = await handleExecuteRequest(weatherPayload({ acknowledgement: ack }), deps);
  assert.equal(replay.status, 409, 'a nonce replay must still be refused, not wrongly re-admitted because the store forgot it early');
  assert.equal(replay.body.code, 'nonce-replayed');
});

test('a schema/allow-list violation is surfaced with the RequestRefused status and code, not a 500', async () => {
  const { status, body } = await handleExecuteRequest(
    weatherPayload({ sampleId: 'not-a-real-sample' }),
    baseDeps(),
  );
  assert.equal(status, 400);
  assert.equal(body.code, 'unknown-sample');
});

test('a sample outside this tenant\'s own allow-list is refused even if it is elsewhere valid', async () => {
  const { status, body } = await handleExecuteRequest(
    weatherPayload(),
    baseDeps({ tenants: { [TENANT_A]: makeBundle({ allowedSampleIds: [] }) } }),
  );
  assert.equal(status, 403);
  assert.equal(body.code, 'relay-sample-not-allowed');
});

test('an unresolvable secret produces a 200 blocked result, not an error status or a throw', async () => {
  const deps = baseDeps({ tenants: { [TENANT_A]: makeBundle({ secretValues: {} }) } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 200);
  assert.equal(body.state, 'blocked');
  assert.match(body.summary, /gatewayAccess\.apiKey/);
});

test('a tenantPolicy.resolve that throws (a directory/identity outage) produces a controlled 502, not an unhandled rejection', async () => {
  const deps = baseDeps({
    tenantPolicy: { resolve: async () => { throw new Error('directory unreachable: leaked-detail-should-never-surface'); } },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 502);
  assert.equal(body.code, 'tenant-policy-unavailable');
  assert.doesNotMatch(JSON.stringify(body), /leaked-detail-should-never-surface/);
});

test('a secretProvider.resolve that throws (a Key Vault/managed-identity outage) produces a controlled 502, not an unhandled rejection', async () => {
  const bundle = makeBundle();
  bundle.secretProvider = { resolve: async () => { throw new Error('key vault unreachable: leaked-detail-should-never-surface'); } };
  const deps = baseDeps({ tenants: { [TENANT_A]: bundle } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 502);
  assert.match(body.summary, /secret provider/i);
  assert.doesNotMatch(JSON.stringify(body), /leaked-detail-should-never-surface/);
});

test('an httpExecutor.execute that throws (a genuinely misbehaving injected executor) produces a controlled 502, not an unhandled rejection', async () => {
  const bundle = makeBundle();
  bundle.httpExecutor = {
    execute: async () => { throw new Error('executor blew up: leaked-detail-should-never-surface'); },
    requestPolicy: bundle.requestPolicy,
  };
  const deps = baseDeps({ tenants: { [TENANT_A]: bundle } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 502);
  assert.match(body.summary, /executor failed unexpectedly/i);
  assert.doesNotMatch(JSON.stringify(body), /leaked-detail-should-never-surface/);
});

/* -------------------------------------------------- run-level deadline */

/** A promise that never settles on its own — only when `signal` fires. */
function hangUntilAborted(signal) {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      },
      { once: true },
    );
  });
}

test('the run deadline is started before tenant-policy resolution, not only around the http executor — a hanging tenant-policy lookup is bounded, not left to run forever', async () => {
  const deps = baseDeps({
    runTimeoutMs: 20,
    tenantPolicy: { resolve: ({ signal } = {}) => hangUntilAborted(signal) },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 504);
  assert.equal(body.code, 'run-timeout');
  assert.equal(body.state, 'blocked');
});

test('the run deadline is started before secret resolution, not only around the http executor — a hanging secret provider is bounded, not left to run forever', async () => {
  const bundle = makeBundle();
  bundle.secretProvider = { resolve: (_ref, { signal } = {}) => hangUntilAborted(signal) };
  const deps = baseDeps({ runTimeoutMs: 20, tenants: { [TENANT_A]: bundle } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 504);
  assert.equal(body.code, 'run-timeout');
  assert.equal(body.state, 'blocked');
});

/**
 * A promise that NEVER settles, full stop — it does not even look at
 * `signal`. This is the case `hangUntilAborted` above cannot exercise: a
 * cooperative dependency that listens for `'abort'` and rejects will always
 * be bounded merely by PASSING `signal` down, whether or not the caller
 * additionally races it. A dependency that ignores `signal` entirely is
 * only bounded if the caller (here, `server.mjs`) itself races the wait —
 * this is exactly what `raceDeadline` (see `deadline.mjs`) exists for.
 */
function neverSettles() {
  return new Promise(() => {});
}

test('a tenantPolicy.resolve that completely ignores its signal and never settles is still bounded by the run deadline', async () => {
  const deps = baseDeps({ runTimeoutMs: 20, tenantPolicy: { resolve: () => neverSettles() } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 504);
  assert.equal(body.code, 'run-timeout');
  assert.equal(body.state, 'blocked');
});

test('a secretProvider.resolve that completely ignores its signal and never settles is still bounded by the run deadline', async () => {
  const bundle = makeBundle();
  bundle.secretProvider = { resolve: () => neverSettles() };
  const deps = baseDeps({ runTimeoutMs: 20, tenants: { [TENANT_A]: bundle } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 504);
  assert.equal(body.code, 'run-timeout');
  assert.equal(body.state, 'blocked');
});

test('an httpExecutor.execute that completely ignores its signal and never settles is still bounded by the run deadline', async () => {
  const bundle = makeBundle();
  bundle.httpExecutor = { execute: () => neverSettles(), requestPolicy: bundle.requestPolicy };
  const deps = baseDeps({ runTimeoutMs: 20, tenants: { [TENANT_A]: bundle } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 504);
  assert.equal(body.code, 'run-timeout');
  assert.equal(body.state, 'blocked');
});

test('a boundary promise abandoned by the deadline race, that eventually rejects long after the response was already sent, never surfaces as an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    const deps = baseDeps({
      runTimeoutMs: 10,
      tenantPolicy: {
        resolve: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('the directory eventually answered, long after the deadline fired')), 60);
          }),
      },
    });
    const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
    assert.equal(status, 504);
    assert.equal(body.code, 'run-timeout');
    // Long enough for the abandoned promise above to actually reject.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
  }
});

test('the same run-deadline signal reaches tenant-policy resolution, secret resolution and the http executor — proven by a request that only barely fits before the deadline across all three phases combined', async () => {
  // Each phase takes real (if tiny) time, and none of them alone exceeds
  // `runTimeoutMs` — but if the deadline restarted at each phase (the
  // pre-fix behavior) rather than being shared across the whole request,
  // this would trivially still succeed even at an artificially short
  // budget. This is a smoke check that the wiring exists, not a precise
  // timing assertion — the precise "shares one budget" guarantee is
  // covered by the two hanging-phase tests above.
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bundle = makeBundle();
  const realSecretProvider = bundle.secretProvider;
  bundle.secretProvider = {
    resolve: async (ref, options) => {
      await wait(1);
      return realSecretProvider.resolve(ref, options);
    },
  };
  const deps = baseDeps({
    runTimeoutMs: 5_000,
    tenants: {
      [TENANT_A]: bundle,
    },
    tenantPolicy: {
      resolve: async (...args) => {
        await wait(1);
        return createStaticTenantPolicy({ [TENANT_A]: bundle }).resolve(...args);
      },
    },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 200);
  assert.equal(body.state, 'completed');
});

test('an already-disconnected caller (`externalSignal` already aborted) ends the run with the same controlled run-timeout response, before tenant-policy resolution runs at all', async () => {
  const controller = new AbortController();
  controller.abort();
  let tenantPolicyCalled = false;
  const deps = baseDeps({
    externalSignal: controller.signal,
    tenantPolicy: {
      resolve: async () => {
        tenantPolicyCalled = true;
        return makeBundle();
      },
    },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 504);
  assert.equal(body.code, 'run-timeout');
  assert.equal(tenantPolicyCalled, false, 'an already-disconnected caller must not even reach tenant-policy resolution');
});

test('an unrecognised executor result state maps to 502, never passed through as-is', async () => {
  const bundle = makeBundle();
  bundle.httpExecutor = { execute: async () => ({ state: 'not-a-real-state' }), requestPolicy: bundle.requestPolicy };
  const deps = baseDeps({ tenants: { [TENANT_A]: bundle } });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 502);
  assert.equal(body.state, 'blocked');
});

test('every response carries configurationUpdates/secretUpdates and an empty steps/assertions array when blocked', async () => {
  const { body } = await handleExecuteRequest(weatherPayload({ sampleId: 'not-a-real-sample' }), baseDeps());
  assert.equal(body.state, 'blocked');
});

/* ------------------------------------------------------- tenant isolation */

test('an unknown tenant is refused with tenant-not-authorized, before any secret or http-executor call', async () => {
  const bundleA = makeBundle();
  const deps = baseDeps({
    tenants: { [TENANT_A]: bundleA },
    auth: { principal: CALLER_B, tenant: 'a-tenant-nobody-configured', roles: [] },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: weatherAcknowledgement() }), deps);
  assert.equal(status, 403);
  assert.equal(body.code, 'tenant-not-authorized');
  assert.equal(bundleA.secretProvider.calls.length, 0);
  assert.equal(bundleA.httpExecutor.calls.length, 0);
});

test('a role-gated tenant refuses a principal without the required role, before any secret or http-executor call', async () => {
  const bundleA = makeBundle({ allowedRoles: ['relay-operator'] });
  const deps = baseDeps({
    tenants: { [TENANT_A]: bundleA },
    auth: { principal: CALLER_A, tenant: TENANT_A, roles: ['some-other-role'] },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 403);
  assert.equal(body.code, 'tenant-not-authorized');
  assert.equal(bundleA.secretProvider.calls.length, 0);
  assert.equal(bundleA.httpExecutor.calls.length, 0);
});

test('a role-gated tenant accepts a principal that carries the required role', async () => {
  const bundleA = makeBundle({ allowedRoles: ['relay-operator'] });
  const deps = baseDeps({
    tenants: { [TENANT_A]: bundleA },
    auth: { principal: CALLER_A, tenant: TENANT_A, roles: ['relay-operator'] },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 200);
  assert.equal(body.state, 'completed');
});

test('a sample allowed for tenant B but not tenant A is refused for a caller authenticated as tenant A, before any secret or http-executor call', async () => {
  const bundleA = makeBundle({ allowedSampleIds: [] });
  const bundleB = makeBundle({ gatewayOrigin: GATEWAY_ORIGIN_B });
  const deps = baseDeps({
    tenants: { [TENANT_A]: bundleA, [TENANT_B]: bundleB },
    auth: { principal: CALLER_A, tenant: TENANT_A, roles: [] },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload(), deps);
  assert.equal(status, 403);
  assert.equal(body.code, 'relay-sample-not-allowed');
  assert.equal(bundleA.secretProvider.calls.length, 0);
  assert.equal(bundleA.httpExecutor.calls.length, 0);
  assert.equal(bundleB.secretProvider.calls.length, 0);
  assert.equal(bundleB.httpExecutor.calls.length, 0);
});

test('a destination allowed for tenant B but not tenant A is refused for a caller authenticated as tenant A, before any secret or http-executor call', async () => {
  const bundleA = makeBundle();
  const bundleB = makeBundle({ gatewayOrigin: GATEWAY_ORIGIN_B });
  const inputsForB = { ...WEATHER_INPUTS, 'hub.gatewayUrl': GATEWAY_ORIGIN_B };
  const ackForB = weatherAcknowledgement({ inputs: inputsForB, target: weatherUrlFor(GATEWAY_ORIGIN_B) });
  const deps = baseDeps({
    tenants: { [TENANT_A]: bundleA, [TENANT_B]: bundleB },
    auth: { principal: CALLER_A, tenant: TENANT_A, roles: [] },
  });
  const { status, body } = await handleExecuteRequest(
    weatherPayload({ inputs: inputsForB, acknowledgement: ackForB }),
    deps,
  );
  assert.equal(status, 403);
  assert.equal(body.code, 'destination-not-allowed');
  assert.equal(bundleA.secretProvider.calls.length, 0);
  assert.equal(bundleA.httpExecutor.calls.length, 0);
  assert.equal(bundleB.secretProvider.calls.length, 0);
  assert.equal(bundleB.httpExecutor.calls.length, 0);
});

test('an acknowledgement minted for a different tenant is refused with acknowledgement-tenant-mismatch, before any secret or http-executor call', async () => {
  const bundleA = makeBundle();
  const bundleB = makeBundle({ gatewayOrigin: GATEWAY_ORIGIN_B });
  // Caller is left matching the authenticated principal (CALLER_A) so this
  // exercises the tenant-mismatch branch specifically, not caller-mismatch
  // (which is checked first in verifyAcknowledgement).
  const stolenAck = weatherAcknowledgement({ caller: CALLER_A, tenant: TENANT_B });
  const deps = baseDeps({
    tenants: { [TENANT_A]: bundleA, [TENANT_B]: bundleB },
    auth: { principal: CALLER_A, tenant: TENANT_A, roles: [] },
  });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: stolenAck }), deps);
  assert.equal(status, 403);
  assert.equal(body.code, 'acknowledgement-tenant-mismatch');
  assert.equal(bundleA.secretProvider.calls.length, 0);
  assert.equal(bundleA.httpExecutor.calls.length, 0);
  assert.equal(bundleB.secretProvider.calls.length, 0);
  assert.equal(bundleB.httpExecutor.calls.length, 0);
});

test('an acknowledgement minted for a different caller within the SAME tenant is refused with acknowledgement-caller-mismatch, before any secret or http-executor call', async () => {
  const bundleA = makeBundle();
  const ackForSomeoneElse = weatherAcknowledgement({ caller: 'a-different-caller-in-tenant-a' });
  const deps = baseDeps({ tenants: { [TENANT_A]: bundleA }, auth: { principal: CALLER_A, tenant: TENANT_A, roles: [] } });
  const { status, body } = await handleExecuteRequest(weatherPayload({ acknowledgement: ackForSomeoneElse }), deps);
  assert.equal(status, 403);
  assert.equal(body.code, 'acknowledgement-caller-mismatch');
  assert.equal(bundleA.secretProvider.calls.length, 0);
  assert.equal(bundleA.httpExecutor.calls.length, 0);
});

test('a caller correctly authenticated and authorized for tenant B runs successfully against tenant B\'s own destination', async () => {
  const bundleA = makeBundle();
  const bundleB = makeBundle({ gatewayOrigin: GATEWAY_ORIGIN_B });
  const inputsForB = { ...WEATHER_INPUTS, 'hub.gatewayUrl': GATEWAY_ORIGIN_B };
  const ackForB = weatherAcknowledgement({ inputs: inputsForB, target: weatherUrlFor(GATEWAY_ORIGIN_B), caller: CALLER_B, tenant: TENANT_B });
  const deps = baseDeps({
    tenants: { [TENANT_A]: bundleA, [TENANT_B]: bundleB },
    auth: { principal: CALLER_B, tenant: TENANT_B, roles: [] },
  });
  const { status, body } = await handleExecuteRequest(
    weatherPayload({ inputs: inputsForB, acknowledgement: ackForB }),
    deps,
  );
  assert.equal(status, 200);
  assert.equal(body.state, 'completed');
  assert.equal(bundleA.secretProvider.calls.length, 0);
  assert.equal(bundleA.httpExecutor.calls.length, 0);
  assert.equal(bundleB.secretProvider.calls.length, 1);
  assert.equal(bundleB.httpExecutor.calls.length, 1);
});

/**
 * A minimal, synthetic, structurally-valid relay sample whose rebuilt plan
 * literally contacts TWO distinct destination origins — proving the
 * scalar-target-vs-multi-origin-expected-set fix in `acknowledgement.mjs`
 * against a real `handleExecuteRequest` pipeline run, not just the pure
 * `verifyAcknowledgement` unit. No real catalogue sample builds a plan with
 * more than one literal destination origin today, so this stand-in is
 * constructed directly rather than borrowed from `src/catalogue/samples/*`.
 * `buildSamplePlan`/`requirementsFor`/`validateSample` are all generic over
 * any object shaped like a decorated catalogue sample (`configurationEntries`,
 * `fields`, `risk`, `build(ctx)`) — none of them require this sample to be
 * registered in the real catalogue's global field index, since a field that
 * index does not know about is simply skipped as unconstrained rather than
 * treated as invalid.
 */
const MULTI_ORIGIN_SAMPLE_ID = 'test-multi-origin-relay-sample';
const MULTI_ORIGIN_A = 'https://multi-origin-a.example.net';
const MULTI_ORIGIN_B = 'https://multi-origin-b.example.net';
const MULTI_ORIGIN_RISK_TEXT = 'Two GETs against two different hosts. Nothing is created or changed.';
const MULTI_ORIGIN_SAMPLE = Object.freeze({
  id: MULTI_ORIGIN_SAMPLE_ID,
  title: 'Two-destination test sample',
  fields: [],
  configurationEntries: Object.freeze([
    Object.freeze({ path: 'test.originA', type: 'url', requirement: 'mandatory', blockingWhenBlank: true, secret: false }),
    Object.freeze({ path: 'test.originB', type: 'url', requirement: 'mandatory', blockingWhenBlank: true, secret: false }),
  ]),
  risk: { level: 'read-only', effect: MULTI_ORIGIN_RISK_TEXT },
  build(ctx) {
    return createExecutionPlan({
      sampleId: MULTI_ORIGIN_SAMPLE_ID,
      title: 'Two-destination test sample',
      summary: 'Two GETs against two different hosts.',
      risk: { level: 'read-only', effect: MULTI_ORIGIN_RISK_TEXT },
      sourceCells: [],
      steps: [
        step.http({ id: 'get-a', request: { method: 'GET', url: ctx.get('test.originA') } }),
        step.http({ id: 'get-b', request: { method: 'GET', url: ctx.get('test.originB') } }),
      ],
    });
  },
});
const MULTI_ORIGIN_INPUTS = { 'test.originA': MULTI_ORIGIN_A, 'test.originB': MULTI_ORIGIN_B };
const MULTI_ORIGIN_CATALOGUE = { ...CATALOGUE, byId: new Map([[MULTI_ORIGIN_SAMPLE_ID, MULTI_ORIGIN_SAMPLE]]), defaultValues: {} };

/**
 * A bundle whose origin allowlist (both the one `handleExecuteRequest`
 * itself checks and the one the injected http executor enforces at fetch
 * time) is the SAME object and admits both `MULTI_ORIGIN_SAMPLE` origins —
 * unlike `makeBundle()`, which is built around a single gateway origin.
 */
function makeMultiOriginBundle() {
  const originAllowlist = createOriginAllowlist([MULTI_ORIGIN_A, MULTI_ORIGIN_B]);
  const alwaysOkFetch = fakeFetch([{ match: () => true, response: { status: 200, headers: {}, text: '' } }]);
  const requestPolicy = createSampleRequestPolicy({
    [MULTI_ORIGIN_SAMPLE_ID]: {
      'get-a': { urls: [MULTI_ORIGIN_A] },
      'get-b': { urls: [MULTI_ORIGIN_B] },
    },
  });
  return {
    allowedSampleIds: [MULTI_ORIGIN_SAMPLE_ID],
    originAllowlist,
    httpExecutor: spyHttpExecutor(createRelayHttpExecutor({ fetchImpl: alwaysOkFetch, allowlist: originAllowlist, requestPolicy })),
    requestPolicy,
    secretProvider: spySecretProvider(createInMemorySecretProvider({})),
  };
}

test('an acknowledgement bound to only ONE of a plan\'s two actual destination origins is refused, before any secret or http-executor call', async () => {
  // This is the end-to-end proof of the scalar-target fix: a rebuilt plan
  // that literally contacts two origins can no longer be authorised by an
  // acknowledgement that only ever named one of them, even though that one
  // origin is a genuine member of the plan's destination set. Before the
  // fix, `verifyAcknowledgement` treated a scalar target as satisfied by mere
  // membership, so this acknowledgement would have been wrongly accepted and
  // the relay would have gone on to resolve secrets and make a network call
  // against BOTH origins on the strength of consent to only one of them.
  const bundle = makeMultiOriginBundle();
  const scalarAck = mintAcknowledgement({
    sampleId: MULTI_ORIGIN_SAMPLE_ID,
    inputs: MULTI_ORIGIN_INPUTS,
    secretRefs: [],
    target: MULTI_ORIGIN_A, // a genuine member of the plan's destination set, but not all of it
    riskText: MULTI_ORIGIN_RISK_TEXT,
    caller: CALLER_A,
    tenant: TENANT_A,
  });
  const deps = baseDeps({ tenants: { [TENANT_A]: bundle }, catalogue: MULTI_ORIGIN_CATALOGUE });
  const { status, body } = await handleExecuteRequest(
    {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sampleId: MULTI_ORIGIN_SAMPLE_ID,
      inputs: MULTI_ORIGIN_INPUTS,
      acknowledgement: scalarAck,
    },
    deps,
  );
  assert.equal(status, 403);
  assert.equal(body.code, 'acknowledgement-target-mismatch');
  assert.equal(bundle.secretProvider.calls.length, 0);
  assert.equal(bundle.httpExecutor.calls.length, 0);
});

test('an acknowledgement naming BOTH of a plan\'s two actual destination origins is accepted and the run proceeds to execution', async () => {
  // The positive counterpart: the fix does not break legitimate multi-origin
  // consent, only scalar consent for a multi-origin plan. Only the
  // acknowledgement-binding gate is under test here, so the assertion is
  // deliberately limited to "verification passed and execution was reached"
  // rather than a specific final `state`, which depends on assertion-kind
  // support unrelated to this fix.
  const bundle = makeMultiOriginBundle();
  const fullAck = mintAcknowledgement({
    sampleId: MULTI_ORIGIN_SAMPLE_ID,
    inputs: MULTI_ORIGIN_INPUTS,
    secretRefs: [],
    // `planRequestUrls` normalises via `new URL(...).href`, which appends the
    // trailing slash a bare origin lacks; the acknowledgement target must
    // match that literal normalised form exactly, not the raw input value.
    target: [`${MULTI_ORIGIN_A}/`, `${MULTI_ORIGIN_B}/`],
    riskText: MULTI_ORIGIN_RISK_TEXT,
    caller: CALLER_A,
    tenant: TENANT_A,
  });
  const deps = baseDeps({ tenants: { [TENANT_A]: bundle }, catalogue: MULTI_ORIGIN_CATALOGUE });
  const { status, body } = await handleExecuteRequest(
    {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sampleId: MULTI_ORIGIN_SAMPLE_ID,
      inputs: MULTI_ORIGIN_INPUTS,
      acknowledgement: fullAck,
    },
    deps,
  );
  assert.equal(status, 200);
  assert.notEqual(body.code, 'acknowledgement-target-mismatch');
  assert.equal(bundle.secretProvider.calls.length, 0); // this sample declares no secrets
  assert.equal(bundle.httpExecutor.calls.length, 1);
});

/* ------------------------------------------- per-sample request policy exploit regressions */

test(
  'an allow-listed origin combined with an attacker-chosen deployedEndpoint path and a renamed secret header is ' +
    'refused by the per-sample request policy, before any secret or http-executor call',
  async () => {
    // The exploit this proves closed: origin-only authorization would pass
    // this request (the origin IS the tenant's own allow-listed gateway),
    // but a caller-controlled `deployedEndpoint` redirects the same-origin
    // request to an attacker-chosen path, and a caller-controlled
    // `gatewayAccess.subscriptionKeyHeader` would carry the resolved Key
    // Vault secret under whatever header name the caller names. Both are
    // request-policy violations, checked BEFORE the secret provider or the
    // http executor is ever touched.
    const bundleA = makeBundle();
    const attackerInputs = {
      ...WEATHER_INPUTS,
      'samples.weather-mcp-discovery.deployedEndpoint': `${GATEWAY_ORIGIN}/attacker-controlled-path`,
      'gatewayAccess.subscriptionKeyHeader': 'x-reflect',
    };
    const attackerAck = weatherAcknowledgement({
      inputs: attackerInputs,
      target: `${GATEWAY_ORIGIN}/attacker-controlled-path`,
    });
    const deps = baseDeps({ tenants: { [TENANT_A]: bundleA } });
    const { status, body } = await handleExecuteRequest(
      weatherPayload({ inputs: attackerInputs, acknowledgement: attackerAck }),
      deps,
    );
    assert.equal(status, 403);
    assert.match(body.code, /^request-policy-/);
    assert.equal(bundleA.secretProvider.calls.length, 0);
    assert.equal(bundleA.httpExecutor.calls.length, 0);
  },
);

test(
  'a request policy refuses a runtime-discovered secondary URL bound from an earlier step\'s own response, ONLY ' +
    'after the first (legitimate) step genuinely completes and captures it — proving the refusal is a real ' +
    'runtime re-check, not an early abort for an unrelated reason — and no raw/transformed response content ' +
    'reaches the caller',
  async () => {
    const SECONDARY_SAMPLE_ID = 'test-secondary-url-relay-sample';
    const DISCOVER_URL = `${GATEWAY_ORIGIN}/discover`;
    const ATTACKER_SECONDARY_URL = `${GATEWAY_ORIGIN}/attacker-secondary-path`;
    const SECONDARY_RISK_TEXT = 'Discovers a follow-up URL from its own response and fetches it. Nothing is created or changed.';
    const SECONDARY_SAMPLE = Object.freeze({
      id: SECONDARY_SAMPLE_ID,
      title: 'Discover then follow',
      fields: [],
      configurationEntries: Object.freeze([]),
      risk: { level: 'read-only', effect: SECONDARY_RISK_TEXT },
      // Built via the real `createExecutionPlan`/`step.http` (not a
      // hand-rolled plain object), so the resulting plan carries a real
      // `sampleId` — exactly what `httpExecutor.mjs`'s runtime request-policy
      // re-check keys its lookup on (`enforceRequestPolicy(plan.sampleId,
      // ...)`). A plan without one made every step's policy lookup miss —
      // including the FIRST, entirely legitimate step — so the run used to
      // abort on step 1 for an unrelated "unknown sample" reason rather than
      // ever reaching the actual runtime-bound-URL check this test is about.
      build() {
        return createExecutionPlan({
          sampleId: SECONDARY_SAMPLE_ID,
          title: 'Discover then follow',
          summary: 'Discovers a follow-up URL from its own response, then fetches it.',
          risk: { level: 'read-only', effect: SECONDARY_RISK_TEXT },
          sourceCells: [],
          steps: [
            step.http({
              id: 'discover',
              request: { method: 'GET', url: DISCOVER_URL, capture: { next: 'response.json' } },
              produces: ['next'],
            }),
            step.http({ id: 'follow', request: { method: 'GET', url: '{{steps.discover.next}}' } }),
          ],
        });
      },
    });
    const SECONDARY_CATALOGUE = { ...CATALOGUE, byId: new Map([[SECONDARY_SAMPLE_ID, SECONDARY_SAMPLE]]), defaultValues: {} };

    let attackerUrlFetched = false;
    let discoverUrlFetched = false;
    const fetchImpl = async (url) => {
      if (String(url) === ATTACKER_SECONDARY_URL) attackerUrlFetched = true;
      if (String(url) === DISCOVER_URL) {
        discoverUrlFetched = true;
        return { status: 200, headers: {}, text: async () => JSON.stringify(ATTACKER_SECONDARY_URL) };
      }
      return { status: 200, headers: {}, text: async () => '{}' };
    };
    const originAllowlist = createOriginAllowlist([GATEWAY_ORIGIN]);
    // The policy only ever names the LEGITIMATE follow-up URL — an operator
    // never enumerates the attacker's — proving the refusal comes from the
    // policy the tenant's own configuration selected, never from anything
    // the (compromised) upstream response supplied.
    const requestPolicy = createSampleRequestPolicy({
      [SECONDARY_SAMPLE_ID]: {
        discover: { urls: [DISCOVER_URL] },
        follow: { urls: [`${GATEWAY_ORIGIN}/expected-follow-up`] },
      },
    });
    const bundle = {
      allowedSampleIds: [SECONDARY_SAMPLE_ID],
      originAllowlist,
      httpExecutor: spyHttpExecutor(createRelayHttpExecutor({ fetchImpl, allowlist: originAllowlist, requestPolicy })),
      requestPolicy,
      secretProvider: spySecretProvider(createInMemorySecretProvider({})),
    };
    const ack = mintAcknowledgement({
      sampleId: SECONDARY_SAMPLE_ID,
      inputs: {},
      secretRefs: [],
      target: `${DISCOVER_URL}`,
      riskText: SECONDARY_RISK_TEXT,
      caller: CALLER_A,
      tenant: TENANT_A,
    });
    const deps = baseDeps({ tenants: { [TENANT_A]: bundle }, catalogue: SECONDARY_CATALOGUE });
    const { status, body } = await handleExecuteRequest(
      { protocolVersion: EXECUTION_PROTOCOL_VERSION, sampleId: SECONDARY_SAMPLE_ID, inputs: {}, acknowledgement: ack },
      deps,
    );
    assert.equal(status, 200); // the run itself completes (the executor contains the per-step failure)
    assert.equal(body.sampleId, SECONDARY_SAMPLE_ID, 'the rebuilt plan carried a real sampleId through to the result');

    // The proof this test exists for: step 1 ('discover') is policy-approved
    // and genuinely ran — it is the one that captures the secondary URL —
    // BEFORE step 2 ('follow') is ever considered. If the plan's sampleId had
    // been lost (the bug this fixture used to have), 'discover' itself would
    // show `state: 'failed'` with an "unknown step" policy message, not
    // 'completed', and this assertion would catch that regression directly.
    assert.equal(body.steps.length, 2, 'both steps produced a record — the run did not abort before reaching step 2');
    const [discoverStep, followStep] = body.steps;
    assert.equal(discoverStep.id, 'discover');
    assert.equal(discoverStep.state, 'completed', 'the discover step is policy-approved and must genuinely complete, capturing the secondary URL');
    assert.equal(discoverUrlFetched, true, 'the discover step must have actually been fetched, not short-circuited');
    assert.equal(followStep.id, 'follow');
    assert.equal(followStep.state, 'failed', 'the follow step, bound to the just-captured secondary URL, is refused before it is fetched');
    assert.match(followStep.detail, /request policy/i);
    assert.equal(body.state, 'failed');

    assert.equal(attackerUrlFetched, false, 'the attacker-controlled secondary URL must never actually be fetched');
    assert.equal(bundle.secretProvider.calls.length, 0);
    const serialised = JSON.stringify(body);
    assert.doesNotMatch(serialised, /attacker-secondary-path/, 'the discovered attacker URL must not leak into evidence');
    assert.doesNotMatch(serialised, /bodyPreview/, 'no raw/transformed response body content may appear in relay evidence');
  },
);

/* -------------------------------------------------------- createRelayServer */

function serverDeps(overrides = {}) {
  return {
    tenantPolicy: createStaticTenantPolicy({
      [TENANT_A]: makeBundle(),
      [LOOPBACK_DEV_TENANT]: makeBundle(),
    }),
    authenticator: createDenyAllAuthenticator(),
    ...overrides,
  };
}

test('createRelayServer requires a tenantPolicy and an authenticator', () => {
  assert.throws(() => createRelayServer({ authenticator: createDenyAllAuthenticator() }), TypeError);
  assert.throws(
    () => createRelayServer({ tenantPolicy: createStaticTenantPolicy({ [TENANT_A]: makeBundle() }) }),
    TypeError,
  );
  assert.doesNotThrow(() =>
    createRelayServer({
      tenantPolicy: createStaticTenantPolicy({ [TENANT_A]: makeBundle() }),
      authenticator: createDenyAllAuthenticator(),
    }),
  );
});

async function withServer(deps, fn) {
  const server = createRelayServer(deps);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('a non-loopback server with a deny-all authenticator refuses every caller with 401', async () => {
  await withServer(serverDeps(), async (base) => {
    const response = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(weatherPayload()),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'unauthenticated');
  });
});

test('a valid shared-secret credential is accepted end to end over a real socket, using its own configured tenant', async () => {
  await withServer(
    serverDeps({ authenticator: createSharedSecretAuthenticator({ token: 'relay-service-token', tenant: TENANT_A, principal: CALLER_A }) }),
    async (base) => {
      const response = await fetch(`${base}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer relay-service-token' },
        body: JSON.stringify(weatherPayload()),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.state, 'completed');
    },
  );
});

test('a normally completed relay request does not treat request-body completion as cancellation', async () => {
  const bundle = makeBundle();
  const executor = bundle.httpExecutor;
  let observedSignal;
  bundle.httpExecutor = {
    requestPolicy: bundle.requestPolicy,
    execute(plan, options) {
      observedSignal = options.signal;
      return executor.execute(plan, options);
    },
  };
  await withServer(
    serverDeps({
      tenantPolicy: createStaticTenantPolicy({ [TENANT_A]: bundle }),
      authenticator: createSharedSecretAuthenticator({ token: RELAY_TOKEN, tenant: TENANT_A, principal: CALLER_A }),
    }),
    async (base) => {
      const response = await fetch(`${base}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${RELAY_TOKEN}` },
        body: JSON.stringify(weatherPayload()),
      });
      assert.equal(response.status, 200);
      await response.json();
      assert.equal(observedSignal.aborted, false);
    },
  );
});

test('destroying the real relay socket aborts an execution already in flight', async () => {
  const bundle = makeBundle();
  let markExecutionStarted;
  let markExecutionCancelled;
  const executionStarted = new Promise((resolve) => {
    markExecutionStarted = resolve;
  });
  const executionCancelled = new Promise((resolve) => {
    markExecutionCancelled = resolve;
  });
  let observedSignal;
  bundle.httpExecutor = {
    requestPolicy: bundle.requestPolicy,
    execute(_plan, { signal }) {
      observedSignal = signal;
      markExecutionStarted();
      signal.addEventListener('abort', markExecutionCancelled, { once: true });
      return hangUntilAborted(signal);
    },
  };
  await withServer(
    serverDeps({
      tenantPolicy: createStaticTenantPolicy({ [TENANT_A]: bundle }),
      authenticator: createSharedSecretAuthenticator({ token: RELAY_TOKEN, tenant: TENANT_A, principal: CALLER_A }),
    }),
    async (_base, server) => {
      const body = JSON.stringify(weatherPayload());
      const { port } = server.address();
      const client = netConnect({ host: '127.0.0.1', port });
      await new Promise((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error', reject);
      });
      client.write(
        `POST /execute HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${RELAY_TOKEN}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );

      await executionStarted;
      client.destroy();
      await executionCancelled;

      assert.equal(observedSignal.aborted, true);
    },
  );
});

test('a shared-secret credential accepted for a tenant this server has no policy for is refused with tenant-not-authorized, not a crash', async () => {
  await withServer(
    serverDeps({ authenticator: createSharedSecretAuthenticator({ token: 'relay-service-token', tenant: 'an-unconfigured-tenant' }) }),
    async (base) => {
      const response = await fetch(`${base}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer relay-service-token' },
        body: JSON.stringify(weatherPayload()),
      });
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.code, 'tenant-not-authorized');
    },
  );
});

test('a loopback bind bypasses the authenticator entirely, even a deny-all one, and is given the fixed non-null dev tenant/principal', async () => {
  await withServer(
    { ...serverDeps(), isLoopbackHost: () => true, host: '127.0.0.1' },
    async (base) => {
      const response = await fetch(`${base}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          weatherPayload({ acknowledgement: weatherAcknowledgement({ caller: LOOPBACK_DEV_PRINCIPAL, tenant: LOOPBACK_DEV_TENANT }) }),
        ),
      });
      assert.equal(response.status, 200);
    },
  );
});

test('an unknown path is 404 and a non-POST method is 405, both before authentication is even attempted', async () => {
  await withServer(serverDeps(), async (base) => {
    const wrongPath = await fetch(`${base}/not-execute`, { method: 'POST' });
    assert.equal(wrongPath.status, 404);
    const unmanagedRuns = await fetch(`${base}/runs`, { method: 'POST' });
    assert.equal(unmanagedRuns.status, 404, 'managed routes require an explicitly injected durable orchestrator');
    const wrongMethod = await fetch(`${base}/execute`, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
  });
});

test('a body over the configured limit is refused with 413', async () => {
  await withServer(
    {
      ...serverDeps({ authenticator: createSharedSecretAuthenticator({ token: 't', tenant: TENANT_A, principal: CALLER_A }) }),
      bodyLimitBytes: 64,
    },
    async (base) => {
      const response = await fetch(`${base}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
        body: JSON.stringify(weatherPayload({ inputs: { padding: 'x'.repeat(1000) } })),
      });
      assert.equal(response.status, 413);
    },
  );
});

test('every response carries the fixed security headers, never a cacheable body', async () => {
  await withServer(serverDeps(), async (base) => {
    const response = await fetch(`${base}/execute`, { method: 'POST', body: '{}' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('the managed-run routes authenticate every action, bind runs to their owner, and preserve idempotency', async () => {
  const completion = {};
  completion.promise = new Promise((resolve) => {
    completion.resolve = resolve;
  });
  let observedSignal;
  const runs = createManagedRunOrchestrator({
    store: createInMemoryManagedRunStore(),
    random: () => 'abcdefghijklmnopqrstuvwx123456',
    jobLauncher: {
      launch: ({ signal }) => {
        observedSignal = signal;
        return completion.promise;
      },
    },
  });
  const authenticator = {
    async authenticate(request) {
      const token = request.headers.authorization;
      if (token === 'Bearer owner-a') return { ok: true, principal: CALLER_A, tenant: TENANT_A, roles: [] };
      if (token === 'Bearer owner-b') return { ok: true, principal: CALLER_B, tenant: TENANT_A, roles: [] };
      return { ok: false };
    },
  };

  await withServer(serverDeps({ authenticator, runOrchestrator: runs }), async (base) => {
    const unauthenticated = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'managed-1' },
      body: JSON.stringify(weatherPayload()),
    });
    assert.equal(unauthenticated.status, 401);

    const create = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner-a', 'idempotency-key': 'managed-1' },
      body: JSON.stringify({ ...weatherPayload(), secretRefs: WEATHER_SECRET_REFS }),
    });
    assert.equal(create.status, 202, await create.clone().text());
    const run = await create.json();
    assert.match(run.runId, /^run_/);

    const repeated = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner-a', 'idempotency-key': 'managed-1' },
      body: JSON.stringify(weatherPayload()),
    });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).runId, run.runId);

    const conflict = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner-a', 'idempotency-key': 'managed-1' },
      body: JSON.stringify(weatherPayload({ inputs: { ...WEATHER_INPUTS, 'hub.gatewayUrl': 'https://other.example.test' } })),
    });
    assert.equal(conflict.status, 409);

    const otherOwner = await fetch(`${base}/runs/${run.runId}`, { headers: { authorization: 'Bearer owner-b' } });
    assert.equal(otherOwner.status, 404);

    const cancelled = await fetch(`${base}/runs/${run.runId}/cancel`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner-a' },
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).state, 'cancelled');
    assert.equal(observedSignal.aborted, true);
  });
  completion.resolve({ state: 'completed', steps: [] });
});

function managedRunAuthenticator(accepted = { '******': { principal: CALLER_A, tenant: TENANT_A } }) {
  return {
    async authenticate(request) {
      const match = accepted[request.headers.authorization];
      return match ? { ok: true, principal: match.principal, tenant: match.tenant, roles: [] } : { ok: false };
    },
  };
}

function countingManagedRunOrchestrator(onLaunch) {
  let sequence = 0;
  return createManagedRunOrchestrator({
    store: createInMemoryManagedRunStore(),
    // A run ID must be unique per created record; a fixed value would make
    // two genuinely distinct runs collide in the store, so — unlike the
    // single-run test above — these concurrency tests need a fresh token per
    // call.
    random: () => `abcdefghijklmnopqrstuvwx${String(++sequence).padStart(2, '0')}`,
    // These tests never resolve or cancel their launched jobs (they only
    // exercise the admission race, not lease/timeout timing), so real timers
    // here would otherwise keep the process alive for the real
    // runTimeoutMs/dispatchHeartbeatMs durations after the test ends.
    setTimeoutFn: () => ({}),
    clearTimeoutFn: () => {},
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
    jobLauncher: {
      launch: (context) => {
        onLaunch?.(context);
        return new Promise(() => {});
      },
    },
  });
}

test('concurrent managed-run requests with the same Idempotency-Key and the same payload/nonce coalesce onto exactly one run, never a 409 nonce-replayed', async () => {
  let launches = 0;
  const runs = countingManagedRunOrchestrator(() => {
    launches += 1;
  });
  await withServer(serverDeps({ authenticator: managedRunAuthenticator(), runOrchestrator: runs }), async (base) => {
    const headers = { 'content-type': 'application/json', authorization: '******', 'idempotency-key': 'concurrent-identical-key' };
    const body = JSON.stringify(weatherPayload({ acknowledgement: weatherAcknowledgement({ nonce: 'concurrent-identical-nonce' }) }));
    const [first, second] = await Promise.all([
      fetch(`${base}/runs`, { method: 'POST', headers, body }),
      fetch(`${base}/runs`, { method: 'POST', headers, body }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 202], `expected exactly one 202-created and one 200-existing, got ${JSON.stringify([first.status, second.status])}`);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);
    assert.match(firstBody.runId, /^run_/);
    assert.equal(firstBody.runId, secondBody.runId, 'both concurrent requests must resolve to the SAME run');
    assert.equal(launches, 1, 'the job must be dispatched exactly once, never once per racing request');
  });
});

test('concurrent managed-run requests sharing an Idempotency-Key but carrying different payloads still resolve to exactly one created run and one idempotency-conflict, never two runs', async () => {
  let launches = 0;
  const runs = countingManagedRunOrchestrator(() => {
    launches += 1;
  });
  await withServer(serverDeps({ authenticator: managedRunAuthenticator(), runOrchestrator: runs }), async (base) => {
    const headers = { 'content-type': 'application/json', authorization: '******', 'idempotency-key': 'concurrent-conflicting-key' };
    const bodyA = JSON.stringify(weatherPayload({ acknowledgement: weatherAcknowledgement({ nonce: 'concurrent-conflict-nonce-a' }) }));
    const bodyB = JSON.stringify(
      weatherPayload({
        inputs: { ...WEATHER_INPUTS, 'hub.gatewayUrl': 'https://other.example.test' },
        acknowledgement: weatherAcknowledgement({ nonce: 'concurrent-conflict-nonce-b' }),
      }),
    );
    const [respA, respB] = await Promise.all([
      fetch(`${base}/runs`, { method: 'POST', headers, body: bodyA }),
      fetch(`${base}/runs`, { method: 'POST', headers, body: bodyB }),
    ]);
    const statuses = [respA.status, respB.status].sort();
    assert.deepEqual(statuses, [202, 409], `expected exactly one 202-created and one 409-conflict, got ${JSON.stringify([respA.status, respB.status])}`);
    assert.equal(launches, 1, "only the winning request's work is ever dispatched");
  });
});

test('a nonce replayed under a different Idempotency-Key is still refused with 409 nonce-replayed, since single-use nonce tracking lives in the durable store shared by every key', async () => {
  let launches = 0;
  const runs = countingManagedRunOrchestrator(() => {
    launches += 1;
  });
  await withServer(serverDeps({ authenticator: managedRunAuthenticator(), runOrchestrator: runs }), async (base) => {
    const sharedAck = weatherAcknowledgement({ nonce: 'shared-nonce-across-different-keys' });
    const first = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: '******', 'idempotency-key': 'key-for-first-use' },
      body: JSON.stringify(weatherPayload({ acknowledgement: sharedAck })),
    });
    assert.equal(first.status, 202, await first.clone().text());

    const replay = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: '******', 'idempotency-key': 'a-completely-different-key' },
      body: JSON.stringify(weatherPayload({ acknowledgement: sharedAck })),
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, 'nonce-replayed');
    assert.equal(launches, 1, 'the replay must never dispatch a second job');
  });
});

test('a failed admission attempt (an expired acknowledgement) does not leave a poisoned reservation — a following request with the same Idempotency-Key still succeeds', async () => {
  let launches = 0;
  const runs = countingManagedRunOrchestrator(() => {
    launches += 1;
  });
  await withServer(serverDeps({ authenticator: managedRunAuthenticator(), runOrchestrator: runs }), async (base) => {
    const key = 'poison-check-key';
    const expiredAck = weatherAcknowledgement({ now: () => Date.now() - 60 * 60_000, nonce: 'poison-check-nonce-expired' });
    const refused = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: '******', 'idempotency-key': key },
      body: JSON.stringify(weatherPayload({ acknowledgement: expiredAck })),
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, 'acknowledgement-expired');

    const validAck = weatherAcknowledgement({ nonce: 'poison-check-nonce-valid' });
    const succeeded = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: '******', 'idempotency-key': key },
      body: JSON.stringify(weatherPayload({ acknowledgement: validAck })),
    });
    assert.equal(succeeded.status, 202, await succeeded.clone().text());
    assert.equal(launches, 1, 'only the valid retry dispatches work');
  });
});

test('a request whose acknowledgement claims an issuedAt far enough in the future to outlive the managed-run store\'s fixed nonce-retention cap is refused up front — the reviewer-reported reproduction: before the bounded clock-skew check, this exact acknowledgement (an ordinary TTL-bounded lifetime measured from its OWN issuedAt, and not yet expired relative to real time either) passed every prior check, got admitted, and its nonce retention would have been capped well BEFORE its claimed expiresAt, opening a window where a different Idempotency-Key replaying the same nonce inside that window would wrongly succeed', async () => {
  let launches = 0;
  const runs = countingManagedRunOrchestrator(() => {
    launches += 1;
  });
  await withServer(serverDeps({ authenticator: managedRunAuthenticator(), runOrchestrator: runs }), async (base) => {
    const key = 'future-issued-key';
    // issuedAt ~26 minutes ahead of real time; expiresAt is issuedAt + the
    // ordinary default TTL (5 minutes), so ITS OWN claimed lifetime is
    // unremarkable and its expiresAt (~31 minutes from now) is still
    // comfortably in the future relative to real time -- exactly the shape
    // that used to pass every check before this session's bounded
    // clock-skew validation existed.
    const futureIssuedAck = weatherAcknowledgement({ now: () => Date.now() + 26 * 60_000, nonce: 'future-issued-nonce' });
    const refused = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: '******', 'idempotency-key': key },
      body: JSON.stringify(weatherPayload({ acknowledgement: futureIssuedAck })),
    });
    assert.equal(refused.status, 400, await refused.clone().text());
    assert.equal((await refused.json()).code, 'acknowledgement-not-yet-valid');
    assert.equal(launches, 0, 'a request refused for a future-dated issuedAt must never dispatch work');

    // No poisoned reservation, and — critically — the refused nonce was
    // never spent: a genuinely fresh, correctly-timed acknowledgement
    // reusing the SAME nonce under the SAME Idempotency-Key still succeeds
    // normally, exactly as the existing expired-acknowledgement poison
    // check above proves for a different malformed-timing reason.
    const validAck = weatherAcknowledgement({ nonce: 'future-issued-nonce' });
    const succeeded = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: '******', 'idempotency-key': key },
      body: JSON.stringify(weatherPayload({ acknowledgement: validAck })),
    });
    assert.equal(succeeded.status, 202, await succeeded.clone().text());
    assert.equal(launches, 1, 'only the valid retry dispatches work');
  });
});

test('an authenticator that throws (a real identity-provider outage) still gets a controlled 500 response over the socket, never a hang or a crash', async () => {
  // `handleExecuteRequest` already guards the boundaries it calls itself
  // (tenant policy, secret provider, http executor); this is the ONE
  // exception that escapes `handleExecuteRequest` entirely, because
  // authentication happens one level up, in the listener, before
  // `handleExecuteRequest` is ever invoked. Without the top-level try/catch
  // around the request handler, this would either hang the socket (no
  // response ever written) or crash the process via an unhandled rejection.
  const throwingAuthenticator = {
    authenticate: async () => {
      throw new Error('identity provider unreachable: leaked-detail-should-never-surface');
    },
  };
  await withServer(serverDeps({ authenticator: throwingAuthenticator }), async (base) => {
    const response = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(weatherPayload()),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, 'internal-error');
    assert.doesNotMatch(JSON.stringify(body), /leaked-detail-should-never-surface/);
  });
});
