import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHostedServer } from '../src/hosted/server.mjs';
import { createSessions } from '../src/hosted/sessions.mjs';
import { createMicrosoftAuth } from '../src/hosted/auth.mjs';
import { createHostedRuntime } from '../src/hosted/runtime.mjs';
import { createHttpsTransport } from '../src/hosted/httpsTransport.mjs';
import { readHostedConfig } from '../src/hosted/config.mjs';
import { CATALOGUE } from '../src/catalogue/index.mjs';
import { buildDossierModel } from '../src/view/dossierModels.mjs';
import { makeFixtureReader } from './helpers/fixtures.mjs';
import { hostedConfig, operatorClaims, subscriptionId, oid, runPayload } from './helpers/hostedFixtures.mjs';
import { createHttpsIdentityFixture } from './helpers/hostedIdentityHttps.mjs';
import { testTls, httpsTestRequest } from './helpers/hostedTls.mjs';

const tls = testTls();
after(tls.clean);
const root = fileURLToPath(new URL('..', import.meta.url));
const cookie = (response, name) => response.headers['set-cookie'].find((value) => value.startsWith(`${name}=`)).split(';')[0];
const requestHeaders = (session) => ({ Cookie: `__Host-citadel=${session.id}`, Origin: 'https://localhost',
  'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Citadel-CSRF': session.csrf });
async function listen(server, t) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}

test('eight-slot anonymous exhaustion, invalid cookies and cross-site reads cannot consume operator or pending capacity', async (t) => {
  const config = hostedConfig({ maxSessions: 8, maxTransactions: 16 });
  const auth = { client: () => ({}), start: async (tx) => `https://login.example.invalid/authorize?state=${tx.state}`,
    finish: async () => ({ claims: operatorClaims(), account: { localAccountId: oid }, cache: {}, azure: false }) };
  const server = await listen(createHostedServer({ config, auth, tls, root }), t);
  const owner = server.sessions.create();
  owner.claims = operatorClaims();
  const start = async (extra = {}) => {
    const discovery = await httpsTestRequest(server, tls, { path: '/api/capabilities' });
    return httpsTestRequest(server, tls, { path: '/api/auth/start', method: 'POST',
      headers: { ...requestHeaders({ id: '', csrf: discovery.json().auth.csrf }),
        Cookie: cookie(discovery, '__Host-citadel-preauth'), ...extra }, body: { purpose: 'signin' } });
  };
  const legitimate = await start();
  assert.equal(legitimate.status, 200);
  const pendingCookie = cookie(legitimate, '__Host-citadel');
  const pending = server.sessions.get(pendingCookie.split('=')[1]);
  for (let index = 0; index < 40; index++) {
    for (const headers of [{}, { Cookie: '__Host-citadel=invalid' }, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://attacker.invalid' }]) {
      const response = await httpsTestRequest(server, tls, { path: '/api/capabilities', headers });
      assert.equal(response.status, 200);
      if (headers.Origin) { assert.equal(response.json().auth.csrf, null); assert.equal(response.headers['set-cookie'], undefined); }
    }
    assert.equal((await httpsTestRequest(server, tls, { path: '/api/auth/start', method: 'POST',
      headers: requestHeaders(pending), body: { purpose: 'signin' } })).status, 409);
  }
  assert.equal(server.sessions.authorized(owner), true);
  assert.equal(server.sessions.get(pending.id), pending);
  assert.equal((await start()).status, 200, 'a fresh visitor can still start');
  assert.equal((await start({ 'X-Forwarded-For': '192.0.2.1' })).status, 429, 'one address cannot occupy more than two pending slots');
  const state = new URL(legitimate.json().url).searchParams.get('state');
  const callback = await httpsTestRequest(server, tls, { path: `/auth/callback?state=${state}&code=synthetic`,
    headers: { Cookie: cookie(legitimate, '__Host-citadel-login') } });
  assert.equal(callback.headers.location, '/');
  assert.equal((await httpsTestRequest(server, tls, { path: '/api/capabilities',
    headers: { Cookie: cookie(callback, '__Host-citadel') } })).json().auth.authorized, true);
  assert.equal((await start({ 'X-Forwarded-For': '192.0.2.2' })).status, 200);
  assert.equal((await start({ 'X-Forwarded-For': '192.0.2.3' })).status, 429);
  for (let i = 0; i < 6; i++) server.sessions.create().claims = operatorClaims();
  assert.throws(() => server.sessions.create(), /capacity/, 'only actual operator/internal slots fill the eight-slot pool');
});

test('admission counters charge only admitted starts, and full operator rotation commits atomically', () => {
  const config = hostedConfig({ maxSessions: 8, maxTransactions: 100 });
  const sessions = createSessions(config);
  const owners = Array.from({ length: 8 }, () => Object.assign(sessions.create(), { claims: operatorClaims(), cache: {} }));
  const tx = sessions.begin(null, 'signin', {}, 'client-A');
  const pending = sessions.get(tx.sessionId);
  for (let i = 0; i < 100; i++) assert.throws(() => sessions.begin(pending, 'signin', {}, 'client-A'), /pending/);
  for (let i = 0; i < 29; i++) sessions.begin(null, 'signin', {}, `client-${i}`);
  assert.throws(() => sessions.begin(null, 'signin', {}, 'new-client'), /capacity/);
  assert.throws(() => sessions.finish(pending, { claims: operatorClaims() }), /capacity/);
  assert.ok(owners.every((owner) => sessions.authorized(owner)));
  const replacement = sessions.finish(owners[0], { claims: operatorClaims(), cache: {} });
  assert.equal(sessions.authorized(replacement), true);
  assert.equal(sessions.get(owners[0].id), null);
  assert.ok(owners.slice(1).every((owner) => sessions.authorized(owner)));
  sessions.close();
});

test('client admission survives cookie churn but expires; pending expiry releases an existing operator', () => {
  let now = Date.now();
  const config = hostedConfig();
  const sessions = createSessions(config, { now: () => now });
  for (let i = 0; i < 3; i++) {
    const tx = sessions.begin(null, 'signin', {}, 'same-socket');
    sessions.revoke(sessions.get(tx.sessionId));
  }
  assert.throws(() => sessions.begin(null, 'signin', {}, 'same-socket'), /sign-in limit/);
  assert.ok(sessions.begin(null, 'signin', {}, 'different-socket'));
  const owner = sessions.create();
  owner.claims = operatorClaims();
  const expiring = sessions.begin(owner, 'azure', {}, 'same-socket');
  sessions.consume(expiring.state, expiring.correlation);
  owner.authPending = true;
  now += config.transactionMs;
  sessions.sweep();
  assert.equal(owner.authPending, false);
  assert.equal(sessions.authorized(owner), true);
  const newer = sessions.begin(owner, 'azure', {}, 'same-socket');
  assert.throws(() => sessions.finish(owner, { claims: operatorClaims(), cache: {} }, expiring), /expired or was cancelled/);
  sessions.endAuth(owner, expiring);
  assert.equal(sessions.hasTransaction(newer), true);
  assert.ok(sessions.begin(null, 'signin', {}, 'same-socket'));
  sessions.close();
});

test('a cancelled in-flight callback cannot replace the operator or erase a newer pending consent', async (t) => {
  let release, entered;
  const verifying = new Promise((resolve) => { entered = resolve; });
  const auth = { client: () => ({}), start: async (tx) => `https://login.example.invalid/authorize?state=${tx.state}`,
    finish: async () => new Promise((resolve) => {
      release = () => resolve({ claims: operatorClaims(), account: { localAccountId: oid }, cache: { marker: 'new' }, azure: true });
      entered();
    }) };
  const server = await listen(createHostedServer({ config: hostedConfig(), auth, tls, root }), t);
  const session = server.sessions.create(), cache = { marker: 'original' };
  Object.assign(session, { claims: operatorClaims(), account: { localAccountId: oid }, cache });
  const headers = requestHeaders(session);
  const start = () => httpsTestRequest(server, tls, { path: '/api/auth/start', method: 'POST', headers, body: { purpose: 'azure' } });
  const first = await start();
  const state = new URL(first.json().url).searchParams.get('state');
  const callbackPromise = httpsTestRequest(server, tls, { path: `/auth/callback?state=${state}&code=synthetic`,
    headers: { Cookie: cookie(first, '__Host-citadel-login') } });
  await verifying;
  t.after(() => release());
  assert.equal((await start()).status, 409, 'consumed state still reserves its in-flight transaction');
  await httpsTestRequest(server, tls, { path: '/api/auth/cancel', method: 'POST', headers, body: {} });
  const newer = await start();
  assert.equal(newer.status, 200);
  release();
  const callback = await callbackPromise;
  assert.equal(callback.headers.location, '/?signin=failed');
  assert.equal(callback.headers['set-cookie'], undefined, 'an old callback cannot erase the new correlation cookie');
  assert.equal(session.cache, cache);
  assert.equal(session.authPending, true);
  const nextState = new URL(newer.json().url).searchParams.get('state');
  assert.ok(server.sessions.consume(nextState, cookie(newer, '__Host-citadel-login').split('=')[1]));
});

for (const mode of ['declined', 'start-failed', 'mismatched', 'cancelled']) {
  test(`Azure consent ${mode} preserves the verified application account but not stale review or target`, async (t) => {
    const auth = { client: () => ({}), start: async (tx) => {
      if (mode === 'start-failed') throw new Error('Synthetic identity outage');
      return `https://login.example.invalid/authorize?state=${tx.state}`;
    }, finish: async () => { throw new Error('Synthetic verified account mismatch'); } };
    const server = await listen(createHostedServer({ config: hostedConfig(), auth, tls, root }), t);
    const session = server.sessions.create(), cache = {};
    Object.assign(session, { claims: operatorClaims(), account: { localAccountId: oid }, cache,
      subscription: { id: subscriptionId }, review: { nonce: 'old' }, run: { controller: new AbortController() } });
    const headers = requestHeaders(session);
    const started = await httpsTestRequest(server, tls, { path: '/api/auth/start', method: 'POST', headers, body: { purpose: 'azure' } });
    if (mode === 'start-failed') assert.equal(started.status, 503);
    else if (mode === 'cancelled') {
      assert.equal((await httpsTestRequest(server, tls, { path: '/api/auth/cancel', method: 'POST', headers, body: {} })).status, 200);
    } else {
      const state = new URL(started.json().url).searchParams.get('state');
      const callback = await httpsTestRequest(server, tls, { path: `/auth/callback?state=${state}&${mode === 'declined' ? 'error=access_denied' : 'code=synthetic'}`,
        headers: { Cookie: cookie(started, '__Host-citadel-login') } });
      assert.equal(callback.headers.location, '/?signin=failed');
    }
    assert.equal(server.sessions.authorized(session), true);
    assert.equal(session.cache, cache);
    assert.equal(session.account.localAccountId, oid);
    assert.equal(session.authPending, false);
    assert.equal(session.subscription, null);
    assert.equal(session.review, null);
    assert.equal(session.run.controller.signal.aborted, true);
    assert.equal(server.runtime.context(session, { sampleId: 'weather-tools-call', gateway: { keyPresent: true } }).canExecute, true);
    await httpsTestRequest(server, tls, { path: '/api/auth/logout', method: 'POST', headers, body: {} });
    assert.equal(server.sessions.authorized(session), false);
  });
}

test('MSAL and JOSE use actual verified HTTPS metadata, token and JWKS connections', async (t) => {
  const config = hostedConfig();
  const identity = await createHttpsIdentityFixture(config, tls);
  t.after(identity.close);
  const auth = createMicrosoftAuth(config, { fetchImpl: identity.fetchHttps });
  const sessions = createSessions(config);
  t.after(sessions.close);
  const tx = sessions.begin(null, 'signin', auth.client());
  const prior = sessions.get(tx.sessionId);
  const callback = new URL(identity.authorize(await auth.start(tx, prior)));
  sessions.consume(tx.state, tx.correlation);
  const session = sessions.finish(prior, await auth.finish(tx, callback.searchParams.get('code')), tx);
  assert.equal(sessions.authorized(session), true);
  await assert.rejects(auth.finish(tx, callback.searchParams.get('code')));
  const azure = sessions.begin(session, 'azure', auth.client());
  const azureCallback = new URL(identity.authorize(await auth.start(azure, session)));
  sessions.consume(azure.state, azure.correlation);
  const connected = sessions.finish(session, await auth.finish(azure, azureCallback.searchParams.get('code')), azure);
  assert.equal(await auth.token(connected), 'synthetic-delegated-arm-token');
  for (const suffix of ['openid-configuration', '/token', '/keys']) assert.ok(identity.requests.some((request) => request.path.endsWith(suffix)));
  assert.ok(identity.requests.every((request) => ['TLSv1.2', 'TLSv1.3'].includes(request.protocol)));
  const untrusted = createHttpsTransport({ ca: [], resolve: async () => [{ address: '127.0.0.1', family: 4 }], addressAllowed: () => true });
  await assert.rejects(untrusted(`${identity.origin}/metadata`), /certificate/i);
  assert.throws(() => identity.fetchHttps('https://attacker.invalid'), /external/);
});

test('all nineteen hosted identities and normal descriptions are truthful; absent subscriptions never become ready', () => {
  const config = hostedConfig(), sessions = createSessions(config), session = sessions.create();
  Object.assign(session, { claims: operatorClaims(), azure: true });
  const runtime = createHostedRuntime(config, sessions, {});
  for (const configuredSubscriptionId of [undefined, null, '', 'invalid']) {
    assert.equal(runtime.context(session, { sampleId: 'azure-context-check', configuredSubscriptionId }).canExecute, false);
  }
  assert.throws(() => runtime.prepare(session, runPayload('azure-context-check', session)), /select the intended subscription/);
  session.subscription = { id: subscriptionId };
  assert.equal(runtime.context(session, { sampleId: 'azure-context-check' }).canExecute, false);
  assert.equal(runtime.context(session, { sampleId: 'azure-context-check', configuredSubscriptionId: subscriptionId }).canExecute, true);
  for (const sample of CATALOGUE.samples) {
    const context = runtime.context(session, { sampleId: sample.id, gateway: { keyPresent: true } });
    const model = buildDossierModel({ sample, read: makeFixtureReader(), hasSecret: () => true,
      capability: { kind: 'hosted-bff', canExecute: true, supportedStepTypes: ['http', 'assertion'], allowedSampleIds: runtime.allowed },
      runtimeProbe: { mode: 'hosted', hosted: { allowedSampleIds: runtime.allowed, resourceManager: config.cloud.resourceManager } },
      contextState: { status: 'ready', context } });
    assert.notEqual(model.identity.human, 'Not Signed In', sample.id);
    assert.doesNotMatch(JSON.stringify([model.identity, model.sample.summary, model.guide.purpose]), /private Azure CLI/i, sample.id);
    if (!runtime.allowed.includes(sample.id)) {
      assert.equal(model.identity.runsAs, 'Unavailable; Protected Adapter Required');
      assert.match(model.identity.credential, /Unavailable/);
      assert.equal(context.canExecute, false);
      assert.match(model.response.summary, /no Docker execution adapter/);
      if (model.request.available) assert.match(model.request.fullText, /^# Nonexecuted notebook reference only/);
    }
    for (const group of model.configure.groups) for (const field of group.fields) {
      assert.doesNotMatch(JSON.stringify([field.help, field.howToObtain, field.requirementReason]), /private Azure CLI/i, `${sample.id}/${field.path}`);
    }
  }
  sessions.close();
});

test('fixed sign-out return is a documented registered HTTPS URI and group overage remains fail-closed', async () => {
  const config = readHostedConfig({ CITADEL_PLAYGROUND_PUBLIC_ORIGIN: 'https://example.invalid' });
  assert.equal(config.logoutRedirect, 'https://example.invalid/');
  const auth = createMicrosoftAuth(hostedConfig());
  assert.equal(new URL(auth.logoutUrl).searchParams.get('post_logout_redirect_uri'), 'https://localhost/');
  assert.throws(() => createMicrosoftAuth(hostedConfig({ logoutRedirect: 'https://attacker.invalid/' })), /fixed application root/);
  const docs = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(docs, /Register \*\*both\*\*.*\/auth\/callback.*post-logout/);
  assert.match(docs, /group-claim overage/);
  const sessions = createSessions(hostedConfig({ policy: { requiredRole: '', allowedPrincipalIds: [], allowedGroupIds: [oid] } }));
  const session = sessions.create();
  session.claims = { ...operatorClaims(), roles: [], _claim_names: { groups: 'source' }, _claim_sources: { source: { endpoint: 'https://attacker.invalid' } } };
  assert.equal(sessions.authorized(session), false);
  sessions.close();
});
