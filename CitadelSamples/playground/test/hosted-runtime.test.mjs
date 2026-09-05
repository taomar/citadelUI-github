import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE } from '../src/catalogue/index.mjs';
import { createHostedRuntime } from '../src/hosted/runtime.mjs';
import { createSessions, randomToken } from '../src/hosted/sessions.mjs';
import { createMicrosoftAuth } from '../src/hosted/auth.mjs';
import { GATEWAY_RECIPES, HOSTED_RECIPES } from '../src/hosted/config.mjs';
import { hostedConfig, operatorClaims, runPayload, fixtureResourceResponse, subscriptionId, oid,
  createIdentityFixture } from './helpers/hostedFixtures.mjs';
import { saveHostedResume, consumeHostedResume } from '../web/js/hostedResume.mjs';
import { getAzureCloudProfile } from '../src/relay/azureCloud.mjs';

function runtimeFixture() {
  const config = hostedConfig();
  const sessions = createSessions(config);
  const session = sessions.create();
  Object.assign(session, { claims: operatorClaims(), azure: true });
  const calls = [], tokenOwners = [];
  const runtime = createHostedRuntime(config, sessions, { token: async (owner) => { tokenOwners.push(owner.claims.oid); return 'synthetic-delegated-arm-token'; } },
    { fetchImpl: async (url, options) => { calls.push({ url, options }); return fixtureResourceResponse(url, options); } });
  const run = (payload) => runtime.run(session, { ...payload, ...runtime.review(session, payload) });
  return { config, sessions, session, runtime, calls, tokenOwners, run };
}

test('real MSAL orchestration exchanges PKCE once, validates signed OIDC and selects the exact cached user', async () => {
  const config = hostedConfig();
  const fixture = await createIdentityFixture(config);
  const auth = createMicrosoftAuth(config, { fetchImpl: fixture.fetchImpl });
  const sessions = createSessions(config);
  const session = sessions.create();
  const tx = sessions.begin(session, 'signin', auth.client());
  const authorizationUrl = await auth.start(tx, session);
  assert.equal(new URL(authorizationUrl).searchParams.get('scope').includes('management.azure.com'), false);
  const callback = new URL(fixture.authorize(authorizationUrl));
  Object.assign(session, await auth.finish(tx, callback.searchParams.get('code')));
  assert.equal(sessions.authorized(session), true);
  assert.equal(session.account.localAccountId, oid);
  await assert.rejects(auth.finish(tx, callback.searchParams.get('code')));
  const badPkce = sessions.begin(sessions.create(), 'signin', auth.client());
  const badCallback = new URL(fixture.authorize(await auth.start(badPkce, session)));
  badPkce.verifier = randomToken();
  await assert.rejects(auth.finish(badPkce, badCallback.searchParams.get('code')));
  const azure = sessions.begin(sessions.create(), 'azure', auth.client());
  azure.expectedOid = oid;
  const azureUrl = await auth.start(azure, session);
  const azureCallback = new URL(fixture.authorize(azureUrl));
  Object.assign(session, await auth.finish(azure, azureCallback.searchParams.get('code')));
  assert.equal(await auth.token(session), 'synthetic-delegated-arm-token');
  assert.ok(fixture.calls.some((call) => call.url.endsWith('/discovery/v2.0/keys')));
  sessions.close();
});

test('MSAL national-cloud authority and ARM scope selection remain inside the explicit cloud', async () => {
  for (const cloud of ['AzureUSGovernment', 'AzureChinaCloud']) {
    const config = hostedConfig({ cloud: getAzureCloudProfile(cloud) });
    const fixture = await createIdentityFixture(config);
    const auth = createMicrosoftAuth(config, { fetchImpl: fixture.fetchImpl });
    const sessions = createSessions(config), session = sessions.create();
    session.claims = operatorClaims();
    const tx = sessions.begin(session, 'azure', auth.client());
    const url = await auth.start(tx, session);
    const requestedScopes = new URL(url).searchParams.get('scope');
    assert.ok(requestedScopes.includes(config.cloud.resourceManager.replace(/\/?$/, '/') + '.default'));
    const callback = new URL(fixture.authorize(url));
    Object.assign(session, await auth.finish(tx, callback.searchParams.get('code')));
    assert.equal(await auth.token(session), 'synthetic-delegated-arm-token');
    assert.ok(fixture.calls.every((call) => new URL(call.url).origin === config.cloud.loginEndpoint));
    sessions.close();
  }
});

test('Azure context and APIM discovery use the same user with an explicitly bound subscription and truthful HTTP plans', async () => {
  const f = runtimeFixture();
  await f.runtime.select(f.session, subscriptionId);
  for (const id of ['azure-context-check', 'apim-discovery']) {
    const payload = runPayload(id, f.session);
    const prepared = f.runtime.prepare(f.session, payload);
    assert.deepEqual([...prepared.plan.requiredStepTypes].sort(), ['assertion', 'http']);
    const result = await f.run(payload);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.meta.credentialType, 'delegated-user');
    assert.equal(result.meta.liveEvidence, true);
    if (id === 'apim-discovery') assert.equal(result.configurationUpdates['hub.apimName'], 'apim-citadel-test');
  }
  assert.ok(f.tokenOwners.every((value) => value === oid));
  assert.ok(f.calls.every(({ options }) => options.headers.Authorization === 'Bearer synthetic-delegated-arm-token'));
  await assert.rejects(f.runtime.select(f.session, oid), /not permitted/);
  f.sessions.close();
});

test('all five bounded gateway recipes use the entered key without ARM consent, token acquisition or subscription', async () => {
  const f = runtimeFixture();
  f.session.azure = false;
  for (const id of GATEWAY_RECIPES) {
    const result = await f.run(runPayload(id, f.session));
    assert.equal(result.state, 'completed', `${id}: ${JSON.stringify(result)}`);
    assert.equal(result.meta.azureContacted, false);
    assert.equal(result.meta.credentialType, 'apim-subscription-key');
    assert.equal(JSON.stringify(result).includes('FAKE-CONTRACT-KEY'), false);
  }
  assert.equal(f.tokenOwners.length, 0);
  assert.ok(f.calls.every(({ options }) => options.headers['api-key']?.startsWith('FAKE-CONTRACT-KEY')));
  assert.ok(f.calls.some(({ options }) => options.body?.includes('"tools/call"')));
  f.sessions.close();
});

test('twelve unsupported recipes, forged plans, wrong routes, stale reviews and cross-session replays are refused', async () => {
  const f = runtimeFixture();
  const unsupported = CATALOGUE.samples.filter((sample) => !HOSTED_RECIPES.includes(sample.id));
  assert.equal(unsupported.length, 12);
  for (const sample of unsupported) assert.throws(() => f.runtime.prepare(f.session, runPayload(sample.id, f.session)), /no enabled Docker adapter/);
  const payload = runPayload('weather-tools-call', f.session);
  assert.throws(() => f.runtime.prepare(f.session, { ...runPayload('a2a-message-send', f.session), acknowledgement: null }), /acknowledgement/);
  assert.throws(() => f.runtime.prepare(f.session, { ...payload, commands: ['evil'] }), /shape/);
  assert.throws(() => f.runtime.prepare(f.session, runPayload('weather-tools-call', f.session, { 'hub.gatewayUrl': 'https://evil.invalid' })), /policy/);
  const ticket = f.runtime.review(f.session, payload);
  const other = f.sessions.create();
  other.claims = operatorClaims();
  await assert.rejects(f.runtime.run(other, { ...payload, ...ticket }), /Review/);
  await f.runtime.run(f.session, { ...payload, ...ticket });
  await assert.rejects(f.runtime.run(f.session, { ...payload, ...ticket }), /Review/);
  const stale = f.runtime.review(f.session, payload);
  f.sessions.invalidateContext(f.session);
  await assert.rejects(f.runtime.run(f.session, { ...payload, ...stale }), /changed/);
  f.sessions.close();
});

test('sign-in resume preserves declared subscription/recipe but never secret or undeclared fields', () => {
  let stored;
  const storage = { setItem: (_, value) => { stored = value; }, getItem: () => stored, removeItem: () => { stored = null; } };
  saveHostedResume({ storage, sample: CATALOGUE.byId.get('azure-context-check'),
    inputs: { 'hub.subscriptionId': subscriptionId, 'gatewayAccess.apiKey': 'do-not-save', returnUrl: 'https://evil.invalid' } });
  assert.equal(stored.includes('do-not-save'), false);
  assert.equal(stored.includes('evil.invalid'), false);
  assert.deepEqual(consumeHostedResume({ storage, catalogue: CATALOGUE }), {
    recipeId: 'azure-context-check', inputs: { 'hub.subscriptionId': subscriptionId },
  });
  assert.equal(stored, null);
});
