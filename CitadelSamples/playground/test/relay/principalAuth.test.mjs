/**
 * Principal authentication for a non-loopback caller.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authenticatePrincipal,
  createDenyAllAuthenticator,
  createSharedSecretAuthenticator,
  createTokenAuthenticator,
} from '../../src/relay/principalAuth.mjs';

function requestWith(headers) {
  return { headers };
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
