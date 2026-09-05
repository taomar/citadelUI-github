import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { createMicrosoftAuth } from '../src/hosted/auth.mjs';
import { createSessions, entitled, sameToken, cookieValue, randomToken } from '../src/hosted/sessions.mjs';
import { getAzureCloudProfile } from '../src/relay/azureCloud.mjs';
import { createHostedServer } from '../src/hosted/server.mjs';
import { readHostedConfig, readTls } from '../src/hosted/config.mjs';
import { createHttpsTransport, publicAddress } from '../src/hosted/httpsTransport.mjs';
import { testTls, httpsTestRequest } from './helpers/hostedTls.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const tenantId = '11111111-1111-1111-1111-111111111111';
const clientId = '22222222-2222-2222-2222-222222222222';
const oid = '33333333-3333-3333-3333-333333333333';
const config = {
  origin: 'https://localhost', callback: 'https://localhost/auth/callback',
  cloud: getAzureCloudProfile('AzureCloud'), tenantId, clientId, clientSecret: 'synthetic-test-secret',
  policy: { requiredRole: 'Citadel.Operator', allowedPrincipalIds: [], allowedGroupIds: [] },
  authIssues: [], issues: [], subscriptionIds: [], gatewayPolicy: null,
  idleMs: 1800000, absoluteMs: 28800000, transactionMs: 300000, maxSessions: 10, maxTransactions: 5,
};
const tls = testTls();
after(tls.clean);
const keyPair = await generateKeyPair('RS256');
const now = Math.floor(Date.now() / 1000);
const claims = { tid: tenantId, oid, roles: ['Citadel.Operator'], preferred_username: 'test@example.invalid', exp: now + 3600 };
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
async function signed(nonce, overrides = {}) {
  return new SignJWT({ ...claims, nonce, ...overrides }).setProtectedHeader({ alg: 'RS256' })
    .setSubject(oid).setIssuer(issuer).setAudience(clientId).setIssuedAt().setNotBefore(now - 1).sign(keyPair.privateKey);
}

test('session rotation, idle/absolute expiry, nonce transactions and role policy are independent', () => {
  let clock = 1000;
  const store = createSessions(config, { now: () => clock });
  const session = store.create();
  assert.equal(store.authorized(session), false);
  session.claims = { ...claims, exp: 999999 };
  assert.equal(store.authorized(session), true);
  const tx = store.begin(session, 'signin', {});
  assert.throws(() => store.consume(tx.state, randomToken()), /correlation/);
  assert.equal(store.consume(tx.state, tx.correlation), tx);
  assert.throws(() => store.consume(tx.state, tx.correlation), /expired/);
  store.revoke(session);
  assert.equal(store.get(session.id), null);
  assert.equal(session.controller.signal.aborted, true);
  const second = store.create();
  assert.notEqual(second.id, session.id);
  clock += config.idleMs;
  assert.equal(store.get(second.id), null);
  assert.equal(entitled({ ...claims, roles: [] }, config.policy), false);
  assert.equal(entitled({ ...claims, roles: [] }, { ...config.policy, allowedPrincipalIds: [oid] }), true);
  assert.equal(entitled({ ...claims, roles: [], groups: ['44444444-4444-4444-4444-444444444444'] },
    { ...config.policy, allowedGroupIds: ['44444444-4444-4444-4444-444444444444'] }), true);
});

test('cookie and CSRF token comparisons reject duplicates and malformed values', () => {
  const token = randomToken();
  assert.equal(sameToken(token, token), true);
  assert.equal(sameToken(token, token + 'x'), false);
  assert.equal(cookieValue({ headers: { cookie: 'x=a; x=b' } }, 'x'), null);
});

test('absolute expiry, expired transactions and current entitlement policy fail closed', () => {
  let clock = Date.now();
  const store = createSessions(config, { now: () => clock });
  const session = store.create();
  session.claims = { ...claims, exp: Math.floor(clock / 1000) + 100000 };
  const tx = store.begin(session, 'signin', {});
  clock += config.transactionMs;
  assert.throws(() => store.consume(tx.state, tx.correlation), /expired/);
  for (let elapsed = config.transactionMs; elapsed < config.absoluteMs; elapsed += 60000) {
    store.get(session.id);
    clock += 60000;
  }
  assert.equal(store.authorized(session), false);
  const next = store.create();
  next.claims = { ...claims, exp: Math.floor(clock / 1000) + 100000 };
  assert.equal(store.authorized(next), true);
  next.claims = { ...next.claims, roles: [] };
  assert.equal(store.authorized(next), false);
  store.close();
});

test('a wrong cached account invalidates Azure context; transient token service failure does not masquerade as consent', async () => {
  const auth = createMicrosoftAuth(config, { verifyKey: keyPair.publicKey });
  const session = { azure: true, account: { localAccountId: oid, tenantId }, claims,
    contextVersion: 4, subscription: { id: clientId }, cache: {
      acquireTokenSilent: async () => ({ account: { localAccountId: clientId, tenantId }, accessToken: 'synthetic',
        expiresOn: new Date(Date.now() + 60000) }),
    } };
  await assert.rejects(auth.token(session), (error) => error.code === 'azure-consent-required');
  assert.equal(session.azure, false);
  assert.equal(session.contextVersion, 5);
  assert.equal(session.subscription, null);
  session.azure = true;
  session.cache = { acquireTokenSilent: async () => { throw new Error('synthetic transport outage'); } };
  await assert.rejects(auth.token(session), (error) => error.code === 'azure-token-unavailable' && error.status === 503);
  assert.equal(session.azure, true);
});

test('Microsoft auth binds S256 PKCE, nonce, issuer, audience and exact cached account', async () => {
  const auth = createMicrosoftAuth(config, { verifyKey: keyPair.publicKey, fetchImpl: () => { throw new Error('No live network'); } });
  let requested;
  const tx = { state: randomToken(), nonce: randomToken(), verifier: randomToken(), purpose: 'signin', expectedOid: null,
    client: { getAuthCodeUrl: async (request) => { requested = request; return `${config.cloud.loginEndpoint}/authorize`; } } };
  await auth.start(tx, {});
  assert.equal(requested.codeChallenge, createHash('sha256').update(tx.verifier).digest('base64url'));
  assert.equal(requested.nonce, tx.nonce);
  assert.equal(requested.responseMode, 'query');
  assert.equal(requested.prompt, 'select_account');
  assert.equal(requested.scopes.includes('https://management.azure.com/.default'), false);
  const token = await signed(tx.nonce);
  tx.client.acquireTokenByCode = async (request) => {
    assert.equal(request.codeVerifier, tx.verifier);
    assert.equal(request.redirectUri, config.callback);
    return { idToken: token, account: { localAccountId: oid, tenantId } };
  };
  const result = await auth.finish(tx, 'synthetic-code');
  assert.equal(result.claims.oid, oid);
  assert.equal(result.azure, false);
  tx.nonce = randomToken();
  await assert.rejects(auth.finish(tx, 'synthetic-code'), /identity/);
  tx.client.acquireTokenByCode = async () => ({ idToken: await signed(tx.nonce, { tid: clientId }), account: { localAccountId: oid, tenantId } });
  await assert.rejects(auth.finish(tx, 'code'), /identity/);
});

test('signed token failures do not create an application identity', async () => {
  const auth = createMicrosoftAuth(config, { verifyKey: keyPair.publicKey });
  const tx = { nonce: randomToken(), verifier: randomToken(), purpose: 'signin', client: {} };
  for (const token of [
    await new SignJWT({ ...claims, nonce: tx.nonce }).setProtectedHeader({ alg: 'RS256' }).setSubject(oid).setIssuer(issuer).setAudience(oid).setIssuedAt().setNotBefore(now - 1).sign(keyPair.privateKey),
    await signed(tx.nonce, { exp: now - 10 }),
    await new SignJWT({ ...claims, nonce: tx.nonce }).setProtectedHeader({ alg: 'RS256' }).setSubject(oid).setIssuer('https://attacker.invalid').setAudience(clientId).setIssuedAt().setNotBefore(now - 1).sign(keyPair.privateKey),
    await new SignJWT({ ...claims, nonce: tx.nonce }).setProtectedHeader({ alg: 'RS256' }).setSubject(oid).setIssuer(issuer).setAudience(clientId).setIssuedAt(now + 3600).setNotBefore(now - 1).sign(keyPair.privateKey),
    `${(await signed(tx.nonce)).split('.').slice(0, 2).join('.')}.invalid`,
  ]) {
    tx.client.acquireTokenByCode = async () => ({ idToken: token, account: { localAccountId: oid, tenantId } });
    await assert.rejects(auth.finish(tx, 'synthetic-code'));
  }
});

test('HTTPS browser entry, correlation callback, CSRF, entitlement and restart recovery', async (t) => {
  const auth = createMicrosoftAuth(config, { verifyKey: keyPair.publicKey });
  const fakeAuth = { ...auth, client: () => ({
    getAuthCodeUrl: async (request) => { fakeAuth.request = request; return `${config.cloud.loginEndpoint}/authorize?state=${request.state}`; },
    acquireTokenByCode: async () => ({ idToken: await signed(fakeAuth.request.nonce), account: { localAccountId: oid, tenantId } }),
  }) };
  const server = createHostedServer({ config, tls, auth: fakeAuth, root: fileURLToPath(new URL('..', import.meta.url)) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const home = await httpsTestRequest(server, tls);
  assert.equal(home.status, 200);
  const caps = await httpsTestRequest(server, tls, { path: '/api/capabilities' });
  assert.equal(caps.json().auth.available, true);
  assert.equal(caps.json().auth.signedIn, false);
  const cookie = caps.headers['set-cookie'][0].split(';')[0];
  assert.match(caps.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/);
  const headers = { Cookie: cookie, Origin: config.origin, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json', 'X-Citadel-CSRF': caps.json().auth.csrf };
  const start = await httpsTestRequest(server, tls, { path: '/api/auth/start', method: 'POST', headers, body: { purpose: 'signin' } });
  assert.equal(start.status, 200);
  const correlationCookie = start.headers['set-cookie'].find((value) => value.startsWith('__Host-citadel-login='));
  assert.match(correlationCookie, /SameSite=Lax/);
  const correlation = correlationCookie.split(';')[0];
  const callback = await httpsTestRequest(server, tls, {
    path: `/auth/callback?state=${fakeAuth.request.state}&code=synthetic-code`, headers: { Cookie: correlation },
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location, '/');
  const operatorCookie = callback.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(operatorCookie, cookie);
  const signedCaps = await httpsTestRequest(server, tls, { path: '/api/capabilities', headers: { Cookie: operatorCookie } });
  assert.equal(signedCaps.json().auth.authorized, true);
  assert.equal(signedCaps.json().auth.azureConnected, false);
  assert.equal(JSON.stringify(signedCaps.json()).includes('synthetic-test-secret'), false);
  const replay = await httpsTestRequest(server, tls, { path: `/auth/callback?state=${fakeAuth.request.state}&code=synthetic-code`, headers: { Cookie: correlation } });
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.location, '/?signin=failed');
  const wrongOrigin = await httpsTestRequest(server, tls, { path: '/api/hosted/run', method: 'POST',
    headers: { ...headers, Cookie: operatorCookie, Origin: 'https://attacker.invalid' }, body: {} });
  assert.equal(wrongOrigin.status, 403);
  const forgedHeader = await httpsTestRequest(server, tls, { path: '/api/hosted/run', method: 'POST',
    headers: { Origin: config.origin, 'Content-Type': 'application/json', 'X-Ms-Client-Principal': 'forged' }, body: {} });
  assert.equal(forgedHeader.status, 401);
  assert.equal((await httpsTestRequest(server, tls, { headers: { Host: 'attacker.invalid' } })).status, 403);
  assert.equal((await httpsTestRequest(server, tls, { path: '/src/server/transports.mjs' })).status, 404);
  server.sessions.close();
  assert.equal((await httpsTestRequest(server, tls, { path: '/api/capabilities', headers: { Cookie: operatorCookie } })).json().auth.signedIn, false);
});

test('TLS trust and hostname validation remain enabled and DNS rebinding/private addresses are refused', async (t) => {
  const server = createHostedServer({ config: { ...config, authIssues: ['missing auth'] }, tls,
    root: fileURLToPath(new URL('..', import.meta.url)) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(httpsTestRequest(server, tls, { ca: [] }));
  await assert.rejects(httpsTestRequest(server, tls, { host: 'wrong.invalid' }), /Hostname|altnames|certificate/i);
  const secureFetch = createHttpsTransport({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(secureFetch('https://gateway.example.invalid'), /DNS/);
  await assert.rejects(secureFetch('http://gateway.example.invalid'), /HTTPS/);
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  const env = { CITADEL_TLS_CERT_FILE: join(tls.directory, 'server.pem'), CITADEL_TLS_KEY_FILE: join(tls.directory, 'server.key') };
  assert.equal(readTls(env, 'https://localhost').minVersion, 'TLSv1.2');
  assert.throws(() => readTls(env, 'https://wrong.invalid'), /match/);
  const missing = readHostedConfig({ CITADEL_PLAYGROUND_PUBLIC_ORIGIN: 'https://localhost' });
  assert.ok(missing.authIssues.length >= 4);
  assert.equal(missing.issues.some((issue) => issue.includes(tls.directory)), false);
});
