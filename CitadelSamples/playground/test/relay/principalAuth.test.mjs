/**
 * Principal authentication for a non-loopback caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authenticatePrincipal,
  createContainerAppsEntraAuthenticator,
  createDenyAllAuthenticator,
  createSharedSecretAuthenticator,
  createTokenAuthenticator,
} from '../../src/relay/principalAuth.mjs';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID = '22222222-2222-2222-2222-222222222222';
const PRINCIPAL_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_PRINCIPAL_ID = '44444444-4444-4444-4444-444444444444';
const GROUP_ID = '55555555-5555-5555-5555-555555555555';
const ROLE_TYPE = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';

function requestWith(headers) {
  return { headers };
}

function clientPrincipal({
  tenantId = TENANT_ID,
  clientId = CLIENT_ID,
  principalId = PRINCIPAL_ID,
  roles = [],
  groups = [],
  claims = [],
  payload = {},
} = {}) {
  return Buffer.from(
    JSON.stringify({
      auth_typ: 'aad',
      name_typ: 'name',
      role_typ: ROLE_TYPE,
      claims: [
        { typ: 'tid', val: tenantId },
        { typ: 'aud', val: clientId },
        { typ: 'oid', val: principalId },
        ...roles.map((role) => ({ typ: ROLE_TYPE, val: role })),
        ...groups.map((group) => ({ typ: 'groups', val: group })),
        ...claims,
      ],
      ...payload,
    }),
  ).toString('base64');
}

test('createSharedSecretAuthenticator requires a non-empty token', () => {
  assert.throws(() => createSharedSecretAuthenticator({ token: '' }), /non-empty token/);
  assert.throws(() => createSharedSecretAuthenticator({}), /non-empty token/);
});

test('the shared-secret authenticator accepts an exact bearer match and rejects everything else', async () => {
  const auth = createSharedSecretAuthenticator({ token: 'operator-secret' });
  const ok = await auth.authenticate(requestWith({ authorization: 'Bearer operator-secret' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.principal, 'configured-caller');

  const wrong = await auth.authenticate(requestWith({ authorization: 'Bearer nope' }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'invalid-credential');

  const missing = await auth.authenticate(requestWith({}));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-or-malformed-authorization-header');

  const malformed = await auth.authenticate(requestWith({ authorization: 'operator-secret' }));
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'missing-or-malformed-authorization-header');
});

test('the shared-secret authenticator is case-insensitive on the Bearer scheme only', async () => {
  const auth = createSharedSecretAuthenticator({ token: 'operator-secret' });
  const result = await auth.authenticate(requestWith({ authorization: 'bearer operator-secret' }));
  assert.equal(result.ok, true);
});

test('the shared-secret authenticator refuses a token that is a prefix or suffix of the real one', async () => {
  const auth = createSharedSecretAuthenticator({ token: 'operator-secret' });
  assert.equal((await auth.authenticate(requestWith({ authorization: 'Bearer operator-secret-extra' }))).ok, false);
  assert.equal((await auth.authenticate(requestWith({ authorization: 'Bearer operator-secre' }))).ok, false);
});

test('createTokenAuthenticator refuses to build without a verify function', () => {
  assert.throws(() => createTokenAuthenticator({}), /requires a `verify/);
  assert.throws(() => createTokenAuthenticator({ verify: 'not-a-function' }), /requires a `verify/);
});

test('the token authenticator delegates to the injected verifier and nowhere else', async () => {
  const seen = [];
  const auth = createTokenAuthenticator({
    verify: async (token) => {
      seen.push(token);
      return token === 'good-token' ? { ok: true, principal: 'aad-principal' } : { ok: false, reason: 'bad-signature' };
    },
  });
  const good = await auth.authenticate(requestWith({ authorization: 'Bearer good-token' }));
  assert.deepEqual(good, { ok: true, principal: 'aad-principal' });
  const bad = await auth.authenticate(requestWith({ authorization: 'Bearer wrong-token' }));
  assert.equal(bad.ok, false);
  assert.deepEqual(seen, ['good-token', 'wrong-token']);

  const missing = await auth.authenticate(requestWith({}));
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-or-malformed-authorization-header');
});

test('the deny-all authenticator refuses every request, with no configuration required', async () => {
  const auth = createDenyAllAuthenticator();
  assert.equal((await auth.authenticate(requestWith({ authorization: 'Bearer anything' }))).ok, false);
  assert.equal((await auth.authenticate(requestWith({}))).ok, false);
});

test('Container Apps authentication requires an exact nonempty entitlement policy', () => {
  assert.throws(
    () => createContainerAppsEntraAuthenticator({ tenantId: TENANT_ID, clientId: CLIENT_ID }),
    /at least one required app role/,
  );
  assert.throws(
    () =>
      createContainerAppsEntraAuthenticator({
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        requiredRole: 'Citadel.Operator',
        allowedPrincipalIds: [PRINCIPAL_ID, PRINCIPAL_ID],
      }),
    /duplicate object GUIDs/,
  );
});

test('Container Apps authentication accepts the required app role and returns only safe authorization context', async () => {
  const auth = createContainerAppsEntraAuthenticator({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    requiredRole: 'Citadel.Operator',
  });
  assert.deepEqual(
    await auth.authenticate(requestWith({
      'x-ms-client-principal': clientPrincipal({
        roles: ['Unrelated.Role', 'Citadel.Operator'],
        claims: [{ typ: 'name', val: 'operator@example.test' }],
      }),
    })),
    {
      ok: true,
      principal: PRINCIPAL_ID,
      tenant: TENANT_ID,
      roles: ['Citadel.Operator'],
      authorization: { role: true, principal: false, group: false },
    },
  );
});

test('a tenant user without the required role is authenticated but forbidden', async () => {
  const auth = createContainerAppsEntraAuthenticator({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    requiredRole: 'Citadel.Operator',
  });
  assert.deepEqual(
    await auth.authenticate(requestWith({ 'x-ms-client-principal': clientPrincipal() })),
    {
      ok: false,
      status: 403,
      authenticated: true,
      reason: 'hosted-operator-entitlement-required',
    },
  );
});

test('explicit principal and group allowlists authorize without an app-role claim', async () => {
  const principalAuth = createContainerAppsEntraAuthenticator({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    allowedPrincipalIds: [PRINCIPAL_ID],
  });
  assert.equal(
    (await principalAuth.authenticate(requestWith({ 'x-ms-client-principal': clientPrincipal() }))).authorization
      .principal,
    true,
  );

  const groupAuth = createContainerAppsEntraAuthenticator({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    allowedGroupIds: [GROUP_ID],
  });
  assert.equal(
    (
      await groupAuth.authenticate(
        requestWith({ 'x-ms-client-principal': clientPrincipal({ groups: [GROUP_ID] }) }),
      )
    ).authorization.group,
    true,
  );
});

test('Container Apps authentication rejects wrong tenant, audience, principal, and malformed claims', async () => {
  const auth = createContainerAppsEntraAuthenticator({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    allowedPrincipalIds: [PRINCIPAL_ID],
  });
  for (const encoded of [
    clientPrincipal({ tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    clientPrincipal({ clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }),
    clientPrincipal({ principalId: OTHER_PRINCIPAL_ID }),
  ]) {
    const result = await auth.authenticate(requestWith({ 'x-ms-client-principal': encoded }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  }
  for (const encoded of [
    'not base64',
    clientPrincipal({ claims: [{ typ: 'tid', val: TENANT_ID }] }),
    clientPrincipal({ claims: [{ typ: 'aud', val: CLIENT_ID }] }),
    clientPrincipal({ claims: [{ typ: 'oid', val: PRINCIPAL_ID }] }),
    clientPrincipal({ claims: [{ typ: 'groups', val: 'not-a-guid' }] }),
    clientPrincipal({ payload: { auth_typ: 'github' } }),
  ]) {
    const result = await auth.authenticate(requestWith({ 'x-ms-client-principal': encoded }));
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  }
});

test('Container Apps authentication rejects duplicate and oversized principal headers', async () => {
  const auth = createContainerAppsEntraAuthenticator({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    requiredRole: 'Citadel.Operator',
    maxHeaderBytes: 1024,
  });
  const encoded = clientPrincipal({ roles: ['Citadel.Operator'] });
  assert.equal(
    (
      await auth.authenticate({
        headers: { 'x-ms-client-principal': encoded },
        rawHeaders: ['X-MS-CLIENT-PRINCIPAL', encoded, 'x-ms-client-principal', encoded],
      })
    ).reason,
    'duplicate-container-apps-principal-header',
  );
  const oversized = Buffer.from(
    JSON.stringify({
      auth_typ: 'aad',
      role_typ: ROLE_TYPE,
      claims: [{ typ: 'padding', val: 'x'.repeat(1200) }],
    }),
  ).toString('base64');
  const result = await auth.authenticate(requestWith({ 'x-ms-client-principal': oversized }));
  assert.equal(result.status, 431);
});

test('authenticatePrincipal trusts a loopback bind unconditionally, and defers to the authenticator otherwise', async () => {
  const isLoopbackHost = (host) => host === '127.0.0.1';
  const deny = createDenyAllAuthenticator();

  const loopback = await authenticatePrincipal(requestWith({}), { isLoopbackHost, host: '127.0.0.1', authenticator: deny });
  assert.equal(loopback.ok, true);
  assert.equal(loopback.principal, 'loopback-operator');

  const nonLoopback = await authenticatePrincipal(requestWith({}), {
    isLoopbackHost,
    host: 'playground.example.net',
    authenticator: deny,
  });
  assert.equal(nonLoopback.ok, false);
});

test('authenticatePrincipal never consults the authenticator for a loopback bind, even a misconfigured one', async () => {
  let called = false;
  const authenticator = {
    async authenticate() {
      called = true;
      return { ok: false };
    },
  };
  const result = await authenticatePrincipal(requestWith({}), {
    isLoopbackHost: () => true,
    host: '127.0.0.1',
    authenticator,
  });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

test('a spoofed Container Apps principal header is never trusted in loopback mode', async () => {
  const authenticator = createContainerAppsEntraAuthenticator({
    tenantId: TENANT_ID,
    clientId: CLIENT_ID,
    requiredRole: 'Citadel.Operator',
  });
  const result = await authenticatePrincipal(
    requestWith({
      'x-ms-client-principal': clientPrincipal({
        principalId: OTHER_PRINCIPAL_ID,
        roles: ['Citadel.Operator'],
      }),
    }),
    {
      isLoopbackHost: () => true,
      host: '127.0.0.1',
      authenticator,
    },
  );
  assert.equal(result.principal, 'loopback-operator');
  assert.equal(result.tenant, 'local-development');
});
