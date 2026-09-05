import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHostedServer } from '../src/hosted/server.mjs';
import { createMicrosoftAuth } from '../src/hosted/auth.mjs';
import { createDeviceAuth } from '../src/hosted/deviceAuth.mjs';
import { createSessions } from '../src/hosted/sessions.mjs';
import { authMethods, readHostedConfig } from '../src/hosted/config.mjs';
import { hostedConfig, deviceClientId, clientId, oid, operatorClaims } from './helpers/hostedFixtures.mjs';
import { createHttpsIdentityFixture } from './helpers/hostedIdentityHttps.mjs';
import { testTls, httpsTestRequest } from './helpers/hostedTls.mjs';

const tls = testTls();
after(tls.clean);
const root = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(operation, predicate) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (predicate(result)) return result;
    await pause(30);
  }
  assert.fail('Synthetic device flow did not reach expected state.');
}
async function setup(t, overrides = {}) {
  const config = hostedConfig({ authMethodIds: ['browser', 'device-code'], deviceClientId, deviceAuthIssues: [], ...overrides });
  const identity = await createHttpsIdentityFixture(config, tls);
  const auth = createMicrosoftAuth(config, { fetchImpl: identity.fetchHttps });
  const server = createHostedServer({ config, tls, root, auth, testVerificationUris: [`${identity.origin}/device`] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.sessions.close();
    await server.closeDevice();
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await identity.close();
  });
  let cookie, csrf;
  async function caps() {
    const result = await httpsTestRequest(server, tls, { path: '/api/capabilities', headers: cookie ? { Cookie: cookie } : {} });
    csrf = result.json().auth.csrf;
    if (!cookie) cookie = result.headers['set-cookie'][0].split(';')[0];
    return result.json();
  }
  async function post(action, extra = {}, headers = {}) {
    const result = await httpsTestRequest(server, tls, { path: `/api/auth/device/${action}`, method: 'POST',
      headers: { Cookie: cookie, Origin: config.origin, 'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json', 'X-Citadel-CSRF': csrf, ...headers },
      body: { protocolVersion: 2, deviceFlowVersion: 1, ...extra } });
    const sessionCookie = result.headers['set-cookie']?.find((value) => value.startsWith('__Host-citadel='));
    if (sessionCookie) cookie = sessionCookie.split(';')[0];
    if (result.json().csrf) csrf = result.json().csrf;
    return result;
  }
  async function start(purpose = 'signin') {
    await caps();
    const result = await post('start', { purpose });
    assert.equal(result.status, 202);
    return result.json().flowId;
  }
  const status = async (flowId) => (await post('status', { flowId })).json();
  async function accept(flowId) {
    const pending = await until(() => status(flowId), (value) => value.state === 'pending');
    identity.acceptDevice(pending.userCode);
    return until(() => status(flowId), (value) => value.state === 'ready');
  }
  return { config, identity, auth, server, caps, post, start, status, accept,
    session: () => server.sessions.get(cookie?.split('=')[1]) };
}

test('real MSAL device grant over verified HTTPS has no nonce; browser-owned completion rotates and public ARM refresh outlives flow', async (t) => {
  const app = await setup(t);
  const id = await app.start();
  const owner = app.session();
  const pending = await until(() => app.status(id), (value) => value.state === 'pending');
  const caps = await app.caps();
  assert.equal(caps.auth.available, true);
  assert.equal(caps.auth.deviceFlow.flowId, id);
  assert.equal(JSON.stringify(caps).includes(pending.userCode), false);
  const before = app.identity.requests.length;
  for (let i = 0; i < 10; i++) await app.status(id);
  assert.equal(app.identity.requests.length, before, 'status performs no identity calls');
  app.identity.acceptDevice(pending.userCode);
  await until(() => app.status(id), (value) => value.state === 'ready');
  assert.equal((await app.caps()).auth.signedIn, false);
  assert.equal((await app.post('complete', { flowId: id })).status, 200);
  assert.notEqual(app.session().id, owner.id);
  assert.equal(app.session().claims.nonce, undefined);
  assert.equal((await app.post('complete', { flowId: id })).status, 404);
  app.config.transactionMs = 2200;
  const azure = await app.start('azure');
  await app.accept(azure);
  assert.equal((await app.post('complete', { flowId: azure })).status, 200);
  const session = app.session(), grant = session.credentials.azure;
  assert.equal(grant.clientKind, 'public');
  assert.equal(grant.clientId, deviceClientId);
  assert.equal(typeof grant.cache, 'string');
  const snapshot = JSON.parse(grant.cache);
  snapshot.AccessToken = {};
  grant.cache = JSON.stringify(snapshot);
  await pause(2300);
  assert.equal(await app.auth.token(session), 'synthetic-delegated-arm-token');
  assert.ok(app.identity.requests.some((item) => item.path.endsWith('/devicecode')));
  assert.ok(app.identity.requests.some((item) => item.path.endsWith('/keys')));
  assert.ok(app.identity.requests.every((item) => ['TLSv1.2', 'TLSv1.3'].includes(item.protocol)));
});

test('exact owner, CSRF, reload cancellation and SDK interval drain retain admission', async (t) => {
  const app = await setup(t);
  app.identity.setDeviceBehavior({ interval: 2 });
  const id = await app.start();
  await until(() => app.status(id), (value) => value.state === 'pending');
  await until(async () => app.identity.requests.length, () => app.identity.requests.some((item) => item.path.endsWith('/token')));
  assert.equal((await app.post('status', { flowId: id }, { Cookie: '', 'X-Citadel-CSRF': 'wrong' })).status, 401);
  assert.equal((await app.post('cancel', { flowId: id }, { Origin: 'https://attacker.invalid' })).status, 403);
  const reload = await app.caps();
  assert.equal(reload.auth.deviceFlow.flowId, id);
  assert.equal(reload.auth.deviceFlow.userCode, undefined);
  const cancel = await app.post('cancel', { flowId: id });
  assert.equal(cancel.json().state, 'cancelling');
  assert.equal((await app.post('start', { purpose: 'signin' })).status, 409);
  await until(() => app.status(id), (value) => value.state === 'cancelled' && value.settled);
  assert.equal((await app.post('complete', { flowId: id })).status, 409);
  const next = await app.start();
  assert.notEqual(next, id);
  assert.equal((await app.post('cancel', { flowId: id })).status, 404);
  assert.equal(app.session().authPending, true);
});

for (const [error, expected] of [['slow_down', 'failed'], ['authorization_declined', 'declined'], ['expired_token', 'expired']]) {
  test(`real MSAL ${error} stops without fallback or automatic new code`, async (t) => {
    const app = await setup(t);
    app.identity.setDeviceBehavior({ error });
    const id = await app.start();
    const state = await until(() => app.status(id), (value) => value.state === expected && value.settled);
    assert.equal(state.userCode, undefined);
    assert.equal((await app.caps()).auth.signedIn, false);
    assert.equal(app.identity.requests.filter((item) => item.path.endsWith('/devicecode')).length, 1);
    if (error === 'slow_down') {
      assert.equal(state.code, 'device-rate-limited');
      assert.ok(state.retryAfterMs > 0);
      assert.equal((await app.post('start', { purpose: 'signin' })).status, 429);
    }
  });
}

for (const behavior of [{ audience: clientId }, { issuer: 'https://attacker.invalid' },
  { claims: { tid: clientId } }, { claims: { exp: 1 } }, { claims: { oid: 'invalid' } }]) {
  test('signed but invalid device identity never becomes an operator', async (t) => {
    const app = await setup(t);
    app.identity.setDeviceBehavior(behavior);
    const id = await app.start();
    const pending = await until(() => app.status(id), (value) => value.state === 'pending');
    app.identity.acceptDevice(pending.userCode);
    await until(() => app.status(id), (value) => value.state === 'failed');
    assert.equal((await app.caps()).auth.authorized, false);
    assert.equal((await app.post('complete', { flowId: id })).status, 409);
  });
}

test('device consent retains the original operator and unrelated grants but refuses another account', async (t) => {
  const app = await setup(t);
  const id = await app.start();
  await app.accept(id);
  await app.post('complete', { flowId: id });
  const original = app.session(), unrelated = { cache: {}, account: original.account };
  original.credentials.foundry = unrelated;
  app.identity.setDeviceBehavior({ claims: { roles: [] } });
  const azure = await app.start('azure');
  await app.accept(azure);
  await app.post('complete', { flowId: azure });
  assert.equal(app.session().credentials.foundry, unrelated);
  assert.deepEqual(app.session().claims.roles, ['Citadel.Operator']);
  app.identity.setDeviceBehavior({ claims: { oid: clientId } });
  const wrong = await app.start('azure');
  const pending = await until(() => app.status(wrong), (value) => value.state === 'pending');
  app.identity.acceptDevice(pending.userCode);
  await until(() => app.status(wrong), (value) => value.state === 'failed');
  assert.equal(app.session().claims.oid, oid);
  assert.equal(app.session().credentials.foundry, unrelated);
});

test('device config is optional and mixed registration/unknown methods are unavailable', () => {
  const base = hostedConfig();
  assert.equal(authMethods(base)[0].available, true);
  assert.equal(authMethods(base)[1].available, false);
  const config = readHostedConfig({ CITADEL_PLAYGROUND_PUBLIC_ORIGIN: 'https://example.invalid',
    CITADEL_HOSTED_AUTH_METHODS: '["browser","device-code"]', CITADEL_PLAYGROUND_ENTRA_CLIENT_ID: clientId,
    CITADEL_PLAYGROUND_ENTRA_DEVICE_CLIENT_ID: clientId });
  assert.ok(config.deviceAuthIssues.some((issue) => /distinct/.test(issue)));
});

test('distinct valid browser cannot see/cancel/complete a flow; pending operator cannot dispatch effects', async (t) => {
  const app = await setup(t);
  const id = await app.start();
  const other = app.server.sessions.create();
  for (const action of ['status', 'cancel', 'complete']) {
    assert.equal((await app.post(action, { flowId: id }, { Cookie: `__Host-citadel=${other.id}`, 'X-Citadel-CSRF': other.csrf })).status, 404);
  }
  await app.accept(id);
  await app.post('complete', { flowId: id });
  await app.start('azure');
  const current = app.session();
  const blocked = await httpsTestRequest(app.server, tls, { path: '/api/hosted/subscriptions', method: 'POST',
    headers: { Cookie: `__Host-citadel=${current.id}`, Origin: app.config.origin, 'X-Citadel-CSRF': current.csrf,
      'Content-Type': 'application/json' }, body: {} });
  assert.equal(blocked.status, 403);
});

test('real provider expiry is bounded by app deadline and cannot extend it', async (t) => {
  const app = await setup(t, { transactionMs: 1500 });
  app.identity.setDeviceBehavior({ expiresIn: 900 });
  const id = await app.start();
  const state = await until(() => app.status(id), (value) => value.state === 'pending');
  assert.equal(state.expiresAt, state.deadlineAt);
  await pause(1600);
  assert.equal((await app.caps()).auth.authorized, false);
  assert.notEqual((await app.post('complete', { flowId: id })).status, 200);
});

for (const invalidation of ['context', 'logout']) {
  test(`real in-flight HTTPS completion after ${invalidation} is fenced`, async (t) => {
    const app = await setup(t);
    const signin = await app.start();
    await app.accept(signin);
    await app.post('complete', { flowId: signin });
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    app.identity.setDeviceBehavior({ wait });
    const id = await app.start('azure');
    const pending = await until(() => app.status(id), (value) => value.state === 'pending');
    app.identity.acceptDevice(pending.userCode);
    await pause(1100);
    const owner = app.session();
    if (invalidation === 'context') app.server.sessions.invalidateContext(owner);
    else app.server.sessions.revoke(owner);
    release();
    await pause(100);
    assert.equal(owner.credentials.azure, undefined);
    const completion = await app.post('complete', { flowId: id });
    assert.notEqual(completion.status, 200);
    assert.equal(completion.headers['set-cookie'], undefined);
  });
}

test('device transaction consumption is method-specific, one-use and mandatory for finish', () => {
  const config = hostedConfig();
  const sessions = createSessions(config);
  const tx = sessions.begin(null, 'signin', null, 'test', null, 'device-code');
  const owner = sessions.get(tx.sessionId);
  sessions.bindPendingContext(tx, owner);
  const verified = { claims: operatorClaims(), account: { localAccountId: oid } };
  assert.throws(() => sessions.consume(tx.state, tx.correlation), /correlation/);
  assert.throws(() => sessions.finish(owner, verified, tx), /expired or was cancelled/);
  assert.throws(() => sessions.consumeDevice(owner, tx), /expired or no longer/);
  sessions.settleDevice(tx);
  sessions.consumeDevice(owner, tx);
  assert.throws(() => sessions.consumeDevice(owner, tx), /expired or no longer/);
  sessions.finish(owner, verified, tx);
  assert.throws(() => sessions.finish(owner, verified, tx), /expired or was cancelled/);
  sessions.close();
});

test('late in-flight successful result after cancellation cannot adopt tokens or free capacity early', async () => {
  const config = hostedConfig({ maxTransactions: 1, deviceClientId });
  const sessions = createSessions(config);
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const auth = { client: () => ({ acquireTokenByDeviceCode: async () => {
    entered();
    return new Promise((resolve) => { release = resolve; });
  } }), verifyDevice: () => { assert.fail('Cancelled result must not be verified.'); } };
  const device = createDeviceAuth(config, sessions, auth);
  const first = device.begin(null, 'signin', 'connection');
  device.start(first.session, first.flowId);
  await waiting;
  device.cancel(first.session, first.flowId);
  assert.throws(() => device.begin(null, 'signin', 'another'), /capacity/);
  release({ idToken: 'synthetic-not-adopted' });
  await until(() => device.status(first.session, first.flowId), (value) => value.settled);
  assert.equal(sessions.authorized(first.session), false);
  assert.throws(() => device.complete(first.session, first.flowId), /not ready/);
  await device.close();
  sessions.close();
});
