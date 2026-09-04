/**
 * `createStaticTenantPolicy`: the injected server-side authorization
 * resolver mapping an AUTHENTICATED (tenant, principal, roles) context to
 * the exact, pre-provisioned bundle of resources that context may reach.
 *
 * These tests cover the resolver in isolation. Its role in the end-to-end
 * pipeline — refusing an authenticated tenant-A caller access to tenant B's
 * samples, destinations, and secrets before any secret or http-executor
 * call — is covered by `test/relay/server.test.mjs`'s tenant-isolation
 * section.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStaticTenantPolicy, createRelayTenantBundle } from '../../src/relay/tenantPolicy.mjs';
import { createOriginAllowlist } from '../../src/relay/originAllowlist.mjs';
import { createRelayHttpExecutor } from '../../src/relay/httpExecutor.mjs';
import { createSampleRequestPolicy } from '../../src/relay/requestPolicy.mjs';
import { createInMemorySecretProvider } from '../../src/relay/secretProvider.mjs';

const GATEWAY_ORIGIN = 'https://apim-citadel-test.azure-api.net';

function makeRequestPolicy() {
  return createSampleRequestPolicy({
    'weather-mcp-discovery': {
      'mcp-initialize': { urls: [`${GATEWAY_ORIGIN}/mcp/weather-tool-mcp/mcp`], headerNames: ['api-key'] },
      'tools-list': { urls: [`${GATEWAY_ORIGIN}/mcp/weather-tool-mcp/mcp`], headerNames: ['api-key'] },
    },
  });
}

/**
 * A correctly-paired bundle: `httpExecutor` is built FROM the exact same
 * `requestPolicy` object the bundle itself carries, as `assertBundle`
 * requires (see `tenantPolicy.mjs`'s doc comment on the drift this closes).
 * `overrides` are applied last, so a test asserting on a deliberately
 * mismatched/missing field can still override either half individually.
 */
function makeBundle(overrides = {}) {
  const originAllowlist = createOriginAllowlist([GATEWAY_ORIGIN]);
  const requestPolicy = makeRequestPolicy();
  return {
    allowedSampleIds: ['weather-mcp-discovery'],
    originAllowlist,
    httpExecutor: createRelayHttpExecutor({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
      allowlist: originAllowlist,
      requestPolicy,
    }),
    requestPolicy,
    secretProvider: createInMemorySecretProvider({}),
    ...overrides,
  };
}


test('createStaticTenantPolicy requires at least one tenant', () => {
  assert.throws(() => createStaticTenantPolicy({}), TypeError);
  assert.throws(() => createStaticTenantPolicy(new Map()), TypeError);
  assert.throws(() => createStaticTenantPolicy(null), TypeError);
});

test('every tenant key must be a non-empty string', () => {
  assert.throws(() => createStaticTenantPolicy({ '': makeBundle() }), /non-empty string/);
});

test('a tenant bundle missing allowedSampleIds is refused at construction, not at first use', () => {
  const { allowedSampleIds, ...rest } = makeBundle();
  void allowedSampleIds;
  assert.throws(() => createStaticTenantPolicy({ 'tenant-a': rest }), /allowedSampleIds/);
});

test('a tenant bundle missing a usable originAllowlist is refused at construction', () => {
  assert.throws(
    () => createStaticTenantPolicy({ 'tenant-a': makeBundle({ originAllowlist: {} }) }),
    /originAllowlist/,
  );
  assert.throws(
    () => createStaticTenantPolicy({ 'tenant-a': makeBundle({ originAllowlist: undefined }) }),
    /originAllowlist/,
  );
});

test('a tenant bundle missing a usable httpExecutor is refused at construction', () => {
  assert.throws(() => createStaticTenantPolicy({ 'tenant-a': makeBundle({ httpExecutor: {} }) }), /httpExecutor/);
});

test('a tenant bundle missing a usable requestPolicy is refused at construction', () => {
  assert.throws(() => createStaticTenantPolicy({ 'tenant-a': makeBundle({ requestPolicy: undefined }) }), /requestPolicy/);
  assert.throws(() => createStaticTenantPolicy({ 'tenant-a': makeBundle({ requestPolicy: {} }) }), /requestPolicy/);
  assert.throws(
    () => createStaticTenantPolicy({ 'tenant-a': makeBundle({ requestPolicy: { authorizeStaticPlan: () => {} } }) }),
    /requestPolicy/,
  );
});

test(
  'a tenant bundle whose httpExecutor was built from a DIFFERENT requestPolicy object than the one the bundle ' +
    'carries is refused at construction, even though each half is independently well-formed',
  () => {
    const originAllowlist = createOriginAllowlist([GATEWAY_ORIGIN]);
    const bundleRequestPolicy = makeRequestPolicy();
    const unrelatedRequestPolicy = makeRequestPolicy(); // a second, independently-built (but equally valid) policy
    const drifted = makeBundle({
      originAllowlist,
      httpExecutor: createRelayHttpExecutor({
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
        allowlist: originAllowlist,
        requestPolicy: unrelatedRequestPolicy,
      }),
      requestPolicy: bundleRequestPolicy,
    });
    assert.throws(() => createStaticTenantPolicy({ 'tenant-a': drifted }), /must be built from this exact same requestPolicy/);
  },
);

test('createRelayTenantBundle pairs httpExecutor and requestPolicy so the drift above cannot happen by construction', () => {
  const originAllowlist = createOriginAllowlist([GATEWAY_ORIGIN]);
  const requestPolicy = makeRequestPolicy();
  const bundle = createRelayTenantBundle({
    allowedSampleIds: ['weather-mcp-discovery'],
    originAllowlist,
    requestPolicy,
    secretProvider: createInMemorySecretProvider({}),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
  });
  assert.equal(bundle.httpExecutor.requestPolicy, requestPolicy);
  assert.doesNotThrow(() => createStaticTenantPolicy({ 'tenant-a': bundle }));
});


test('a tenant bundle missing a usable secretProvider is refused at construction', () => {
  assert.throws(() => createStaticTenantPolicy({ 'tenant-a': makeBundle({ secretProvider: {} }) }), /secretProvider/);
});

test('a non-array allowedRoles is refused at construction', () => {
  assert.throws(
    () => createStaticTenantPolicy({ 'tenant-a': makeBundle({ allowedRoles: 'relay-operator' }) }),
    /allowedRoles/,
  );
});

test('structuralAllowedSampleIds rejects a tenant bundle that allow-lists a sample outside the structural set', () => {
  assert.throws(
    () =>
      createStaticTenantPolicy(
        { 'tenant-a': makeBundle({ allowedSampleIds: ['weather-mcp-discovery', 'not-a-real-sample'] }) },
        { structuralAllowedSampleIds: ['weather-mcp-discovery'] },
      ),
    /not-a-real-sample/,
  );
});

test('structuralAllowedSampleIds accepts a tenant bundle whose allowedSampleIds is a subset', () => {
  assert.doesNotThrow(() =>
    createStaticTenantPolicy(
      { 'tenant-a': makeBundle({ allowedSampleIds: ['weather-mcp-discovery'] }) },
      { structuralAllowedSampleIds: ['weather-mcp-discovery', 'some-other-sample'] },
    ),
  );
});

test('resolve() returns the bundle for a known tenant with no role gate', async () => {
  const bundle = makeBundle();
  const policy = createStaticTenantPolicy({ 'tenant-a': bundle });
  const resolved = await policy.resolve({ tenant: 'tenant-a', principal: 'caller-a', roles: [] });
  assert.equal(resolved, bundle);
});

test('resolve() returns null for an unknown tenant', async () => {
  const policy = createStaticTenantPolicy({ 'tenant-a': makeBundle() });
  assert.equal(await policy.resolve({ tenant: 'tenant-nobody-configured', principal: 'caller-a', roles: [] }), null);
});

test('resolve() returns null for a missing, empty, or non-string tenant, never throwing', async () => {
  const policy = createStaticTenantPolicy({ 'tenant-a': makeBundle() });
  assert.equal(await policy.resolve({ tenant: '', principal: 'caller-a', roles: [] }), null);
  assert.equal(await policy.resolve({ tenant: undefined, principal: 'caller-a', roles: [] }), null);
  assert.equal(await policy.resolve({}), null);
});

test('resolve() gates a role-restricted tenant: no intersection is refused, any intersection is accepted', async () => {
  const bundle = makeBundle({ allowedRoles: ['relay-operator'] });
  const policy = createStaticTenantPolicy({ 'tenant-a': bundle });
  assert.equal(await policy.resolve({ tenant: 'tenant-a', principal: 'caller-a', roles: [] }), null);
  assert.equal(await policy.resolve({ tenant: 'tenant-a', principal: 'caller-a', roles: ['some-other-role'] }), null);
  assert.equal(
    await policy.resolve({ tenant: 'tenant-a', principal: 'caller-a', roles: ['some-other-role', 'relay-operator'] }),
    bundle,
  );
});

test('resolve() never consults the roles a caller presents when the bundle carries no allowedRoles gate', async () => {
  const bundle = makeBundle();
  const policy = createStaticTenantPolicy({ 'tenant-a': bundle });
  assert.equal(await policy.resolve({ tenant: 'tenant-a', principal: 'caller-a', roles: [] }), bundle);
  assert.equal(await policy.resolve({ tenant: 'tenant-a', principal: 'caller-a' }), bundle);
});

test('a Map of tenants works the same as a plain object', async () => {
  const bundle = makeBundle();
  const policy = createStaticTenantPolicy(new Map([['tenant-a', bundle]]));
  assert.equal(await policy.resolve({ tenant: 'tenant-a', principal: 'caller-a', roles: [] }), bundle);
});
