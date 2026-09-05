import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessions, randomToken } from '../src/hosted/sessions.mjs';
import { createMicrosoftAuth } from '../src/hosted/auth.mjs';
import { RESOURCE_PURPOSES, purposeScopes, purposeStates } from '../src/hosted/credentialPurposes.mjs';
import { createSecretSlots } from '../src/hosted/secretSlots.mjs';
import { digest } from '../src/hosted/request.mjs';
import { readHostedConfig } from '../src/hosted/config.mjs';
import { createAdapterRegistry } from '../src/hosted/adapters/index.mjs';
import { hostedConfig, createIdentityFixture, oid, tenantId, operatorClaims } from './helpers/hostedFixtures.mjs';
import { startStagedConsent } from '../web/js/hostedClient.mjs';

function intentFor(session, purpose, now) {
  const resolutionId = randomToken(), consentIntentId = randomToken();
  session.stagedResolution = { id: resolutionId };
  const intent = { consentIntentId, resolutionId, purpose, contextVersion: session.contextVersion, expiresAt: now() + 60000 };
  session.consentIntents.set(consentIntentId, intent);
  return intent;
}
async function connect(sessions, auth, fixture, session, purpose, options = {}) {
  const intent = RESOURCE_PURPOSES.includes(purpose) ? intentFor(session, purpose, sessions.now) : null;
  const tx = sessions.begin(session, purpose, auth.client(), undefined, intent);
  sessions.invalidateContext(session);
  sessions.bindPendingContext(tx, session);
  session.authPending = true;
  const location = await auth.start(tx, session);
  const callback = new URL(fixture.authorize(location, options));
  sessions.consume(tx.state, tx.correlation);
  return { next: sessions.finish(session, await auth.finish(tx, callback.searchParams.get('code')), tx), location };
}

test('W1 production configuration enables neither new resource scopes nor executable adapters; default needs no volume', () => {
  const config = readHostedConfig({ CITADEL_PLAYGROUND_PUBLIC_ORIGIN: 'https://localhost' });
  assert.equal(config.stagedEnabled, false);
  assert.equal(config.stagedDirectory, null);
  assert.deepEqual(config.resourcePurposes, []);
  assert.deepEqual(createAdapterRegistry().ids, []);
  for (const purpose of RESOURCE_PURPOSES) assert.throws(() => purposeScopes(config, purpose), /not verified/);
  for (const purpose of ['https://evil.invalid/.default', 'graph', 'managed-identity', 'cli']) assert.throws(() => purposeScopes(config, purpose), /not verified/);
  assert.throws(() => readHostedConfig({ CITADEL_PLAYGROUND_PUBLIC_ORIGIN: 'https://localhost', CITADEL_HOSTED_STAGED_MODE: '1' }), /dedicated local state/);
});

test('signed MSAL resource consents preserve the same operator and independent ARM/resource caches, never on account switch', async (t) => {
  const config = hostedConfig({ stagedEnabled: true, resourcePurposes: RESOURCE_PURPOSES });
  const fixture = await createIdentityFixture(config), auth = createMicrosoftAuth(config, { fetchImpl: fixture.fetchImpl });
  let clock = Date.now();
  const sessions = createSessions(config, { now: () => clock }); t.after(sessions.close);
  let session = sessions.create();
  session = (await connect(sessions, auth, fixture, session, 'signin')).next;
  session = (await connect(sessions, auth, fixture, session, 'azure')).next;
  const arm = session.credentials.azure.cache;
  for (const purpose of RESOURCE_PURPOSES) {
    clock += 60001;
    const result = await connect(sessions, auth, fixture, session, purpose);
    session = result.next;
    assert.ok(new URL(result.location).searchParams.get('scope').includes(purposeScopes(config, purpose)[0]));
    assert.equal(session.claims.oid, oid);
    assert.equal(session.credentials.azure.cache, arm);
    assert.equal(session.azure, true);
    assert.equal(await auth.token(session, purpose), 'synthetic-delegated-arm-token');
  }
  assert.deepEqual(Object.keys(session.credentials).sort(), ['azure', ...RESOURCE_PURPOSES].sort());
  assert.equal(await auth.token(session), 'synthetic-delegated-arm-token');
  clock += 60001;
  const switched = (await connect(sessions, auth, fixture, session, 'signin', { objectId: '44444444-4444-4444-4444-444444444444' })).next;
  assert.equal(switched.azure, false);
  assert.deepEqual(switched.credentials, {});
  assert.equal(switched.claims.oid, '44444444-4444-4444-4444-444444444444');
});

for (const purpose of RESOURCE_PURPOSES) {
  test(`${purpose}: signed wrong-account consent cannot transfer caches; failed preflight admits no auth start`, async (t) => {
    const config = hostedConfig({ stagedEnabled: true, resourcePurposes: [purpose] });
    const fixture = await createIdentityFixture(config), auth = createMicrosoftAuth(config, { fetchImpl: fixture.fetchImpl });
    const sessions = createSessions(config); t.after(sessions.close);
    let session = sessions.create();
    session = (await connect(sessions, auth, fixture, session, 'signin')).next;
    const original = session.cache;
    await assert.rejects(connect(sessions, auth, fixture, session, purpose, { objectId: '44444444-4444-4444-4444-444444444444' }), /identity/);
    assert.equal(session.cache, original);
    assert.equal(sessions.authorized(session), true);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (path) => {
      calls.push(path);
      return Response.json({ summary: 'synthetic preflight unavailable' }, { status: 503 });
    });
    await assert.rejects(startStagedConsent({ purpose }), /readiness/);
    assert.deepEqual(calls, ['/api/capabilities']);
  });

  test(`${purpose}: silent acquisition is account/context fenced; interaction expiry does not clear ARM`, async (t) => {
    const config = hostedConfig({ stagedEnabled: true, resourcePurposes: [purpose] });
    const auth = createMicrosoftAuth(config), sessions = createSessions(config); t.after(sessions.close);
    const session = sessions.create(), account = { localAccountId: oid, tenantId };
    session.claims = operatorClaims();
    session.account = account;
    session.azure = true;
    const arm = { account, cache: { marker: 'arm' }, grantGeneration: 1 };
    session.credentials.azure = arm;
    session.credentials[purpose] = { account, cache: { acquireTokenSilent: async () => { throw { errorCode: 'invalid_grant' }; } } };
    await assert.rejects(auth.token(session, purpose), (error) => error.code === 'resource-consent-required');
    assert.equal(session.credentials.azure, arm);
    assert.equal(session.azure, true);
    assert.equal(purposeStates(config, session)[purpose], 'consent-required');
    let release;
    session.credentials[purpose] = { account, cache: { acquireTokenSilent: () => new Promise((resolve) => { release = resolve; }) } };
    const pending = auth.token(session, purpose);
    session.invalidateContext();
    release({ account, accessToken: 'synthetic-late-token', expiresOn: new Date(Date.now() + 60000) });
    await assert.rejects(pending, (error) => error.code === 'context-changed');
    assert.equal(session.credentials.azure, arm);
  });
}

test('generated slots bind exact session, route, target and generation, and revoke without exposing values', (t) => {
  const sessions = createSessions(hostedConfig()); t.after(sessions.close);
  const owner = sessions.create(), other = sessions.create();
  owner.claims = operatorClaims(); other.claims = operatorClaims();
  const slots = createSecretSlots(sessions); t.after(slots.close);
  const target = { resourceId: `/subscriptions/${tenantId}/resourceGroups/test/providers/Microsoft.ApiManagement/service/example/subscriptions/contract`,
    origin: 'https://gateway.example.invalid', routes: ['/mcp/weather'], headerName: 'api-key' };
  const binding = slots.putGenerated(owner, { value: 'SYNTHETIC-GENERATED-KEY', target });
  assert.ok(!JSON.stringify(binding).includes('SYNTHETIC-GENERATED-KEY'));
  assert.equal(slots.resolveBinding(owner, 'gatewayAccess.apiKey', binding, target), 'SYNTHETIC-GENERATED-KEY');
  assert.throws(() => slots.resolveBinding(other, 'gatewayAccess.apiKey', binding, target), /expired/);
  assert.throws(() => slots.resolveBinding(owner, 'gatewayAccess.apiKey', { ...binding, generation: binding.generation + 1 }, target), /expired/);
  assert.throws(() => slots.resolveBinding(owner, 'gatewayAccess.apiKey', binding, { ...target, routes: ['/different'] }), /expired/);
  owner.stagedReview = { runNonce: 'old-review' };
  const replacement = slots.putGenerated(owner, { value: 'SYNTHETIC-REPLACEMENT', target });
  assert.equal(owner.stagedReview, null);
  assert.throws(() => slots.describe(owner, 'gatewayAccess.apiKey', binding), /unavailable/);
  assert.equal(slots.resolveBinding(owner, 'gatewayAccess.apiKey', replacement, target), 'SYNTHETIC-REPLACEMENT');
  sessions.invalidateContext(owner);
  assert.throws(() => slots.describe(owner, 'gatewayAccess.apiKey', binding), /unavailable/);
  assert.throws(() => slots.putGenerated(owner, { value: 'SYNTHETIC-KEY', target: { ...target, headerName: 'Authorization' } }), /target/);
  assert.notEqual(digest(target), digest({ ...target, routes: ['/different'] }));
});
