import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHostedServer } from '../src/hosted/server.mjs';
import { createStagedRuntime } from '../src/hosted/stagedRuntime.mjs';
import { createSessions } from '../src/hosted/sessions.mjs';
import { createSqliteRunStore } from '../src/hosted/sqliteRunStore.mjs';
import { storageRecord } from './helpers/stagedStoreProcess.mjs';
import { digest } from '../src/hosted/request.mjs';
import { RESOURCE_PURPOSES } from '../src/hosted/credentialPurposes.mjs';
import { hostedConfig, operatorClaims, oid, tenantId, subscriptionId, runPayload } from './helpers/hostedFixtures.mjs';
import { testTls, httpsTestRequest } from './helpers/hostedTls.mjs';

const enabled = process.platform === 'linux' && Boolean(process.env.CITADEL_STAGED_TEST_ROOT);
const diskTest = enabled ? test : test.skip;
const tls = enabled ? testTls() : null;
if (tls) after(tls.clean);
const directories = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const root = fileURLToPath(new URL('..', import.meta.url));
const target = { resourceId: `/subscriptions/${subscriptionId}/resourceGroups/w1-fixture/providers/Microsoft.ApiManagement/service/staged-fixture`,
  origin: 'https://management.azure.com' };
const readOperation = { id: 'read-target', method: 'GET', url: `${target.origin}${target.resourceId}?api-version=fixture`,
  purpose: 'azure', effect: 'read' };
const base = { protocolVersion: 2, hostedFlowVersion: 1 };
const headers = (session) => ({ Cookie: `__Host-citadel=${session.id}`, Origin: 'https://localhost',
  'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Citadel-CSRF': session.csrf });
const cookies = (response, name) => response.headers['set-cookie'].find((value) => value.startsWith(`${name}=`)).split(';')[0];

async function fixture(t, { purpose = 'azure', auth: suppliedAuth, config: overrides = {}, execute,
  id = 'foundry-enable-a2a', resolve: resolveAdapter, resolvePurposes = ['azure'], generatedFields = [], additionalAdapters = [] } = {}) {
  const directory = await mkdtemp(join(process.env.CITADEL_STAGED_TEST_ROOT, 'citadel-staged-w1-96518acf-api-'));
  directories.push(directory);
  const config = hostedConfig({ stagedEnabled: true, stagedDirectory: directory, resourcePurposes: RESOURCE_PURPOSES, ...overrides });
  const calls = [], tokenCalls = [];
  let etag = 'original', failure = false, release = null, hold = false, confirmed = false;
  const effect = { id: 'fixed-effect', method: 'PATCH', url: purpose === 'azure' ? readOperation.url : 'https://resource.example.invalid/fixed?api-version=fixture',
    purpose, effect: 'write', body: '{"fixture":true}' };
  const adapter = {
    id, version: 'w1-test-1', policyId: 'synthetic-fixed-target', resolvePurposes, generatedFields,
    resolve: resolveAdapter ?? (async ({ read }) => {
      const response = await read(readOperation);
      return { targets: [target], preconditions: [{ request: readOperation, digest: digest(await response.json()) }], operations: [effect] };
    }),
    authorizeRequest: ({ request, phase }) => phase === 'execute'
      ? request.id === effect.id && request.url === effect.url && request.purpose === effect.purpose
      : request.id === readOperation.id && request.url === readOperation.url && request.purpose === 'azure',
    execute: execute ?? (async ({ resolution, send, confirmEffect }) => {
      const response = await send(resolution.operations[0]);
      if (!response.ok) return { state: 'inconclusive' };
      await response.json();
      confirmEffect('fixed-effect');
      return { state: 'completed' };
    }),
    async reconcile({ effects, read }) {
      const response = await read(readOperation), data = await response.json();
      return effects.map((effect) => ({ id: effect.id, confirmed: data.confirmed === true }));
    },
  };
  const auth = suppliedAuth ?? {
    token: async (_, resource) => { tokenCalls.push(resource); return `synthetic-${resource}-token`; },
    client: () => ({}), start: async (tx) => `https://login.example.invalid/authorize?state=${tx.state}`,
    finish: async () => ({ claims: operatorClaims(), account: { localAccountId: oid, tenantId }, cache: {}, azure: false }),
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET', authorization: options.headers.Authorization,
      generatedKeyUsed: options.headers['api-key'] === 'SYNTHETIC-GENERATED-HANDOFF' });
    if (options.method === 'PATCH' && hold) await new Promise((resolve) => { release = resolve; });
    return Response.json({ etag, confirmed }, { status: options.method === 'PATCH' && failure ? 503 : 200 });
  };
  const server = createHostedServer({ config, auth, tls, root, fetchImpl, testAdapters: [adapter, ...additionalAdapters] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const session = server.sessions.create();
  Object.assign(session, { claims: operatorClaims(), account: { localAccountId: oid, tenantId }, azure: true,
    subscription: { id: subscriptionId }, credentials: { azure: { account: { localAccountId: oid, tenantId }, cache: {}, grantGeneration: 1 } } });
  t.after(async () => {
    release?.();
    server.sessions.close();
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await server.closeStaged();
  });
  const payload = () => {
    const { acknowledgement, ...request } = runPayload(adapter.id, session);
    return { ...request, hostedFlowVersion: 1 };
  };
  const post = (path, body, owner = session, extra = {}) => httpsTestRequest(server, tls, {
    path: `/api/${path}`, method: 'POST', headers: { ...headers(owner), ...extra }, body,
  });
  const resolve = () => post('hosted/resolve', payload());
  const review = (resolution) => post('hosted/review', { ...base, resolutionId: resolution.resolutionId,
    contextVersion: session.contextVersion, reviewDigest: resolution.preview.reviewDigest,
    acknowledgement: { accepted: true, sampleId: adapter.id } });
  const run = (resolution, review) => post('hosted/run', { ...base, resolutionId: resolution.resolutionId,
    contextVersion: session.contextVersion, reviewDigest: resolution.preview.reviewDigest, runNonce: review.runNonce });
  async function terminal(runId) {
    for (let count = 0; count < 100; count++) {
      const response = await post('hosted/status', { ...base, runId });
      if (!['accepted', 'running'].includes(response.json().state)) return response;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Staged fixture deadline exceeded');
  }
  return { config, directory, server, session, adapter, auth, fetchImpl, calls, tokenCalls, post, payload, resolve, review, run, terminal,
    drift: () => { etag = 'changed'; }, fail: () => { failure = true; }, confirm: () => { confirmed = true; },
    hold: () => { hold = true; }, release: () => release?.() };
}

diskTest('staged API is explicit: local readiness/review/status make no provider calls; durable admission precedes fixed dispatch', async (t) => {
  const f = await fixture(t);
  const caps = await httpsTestRequest(f.server, tls, { path: '/api/capabilities', headers: headers(f.session) });
  assert.equal(caps.json().executor.allowedSampleIds.length, 7);
  assert.equal(f.calls.length, 0);
  const { secrets, ...contextRequest } = f.payload();
  const { contextVersion, ...contextBody } = contextRequest;
  assert.equal((await f.post('execution-context', contextBody)).status, 200);
  assert.equal(f.calls.length, 0);
  const resolution = (await f.resolve()).json();
  assert.equal(resolution.state, 'ready');
  assert.equal(f.calls.length, 1);
  const review = (await f.review(resolution)).json();
  assert.ok(Object.isFrozen(f.session.stagedResolution));
  assert.throws(() => { f.session.stagedResolution.operations = []; }, TypeError);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.run(resolution, { ...review, runNonce: 'x'.repeat(43) })).status, 409);
  const accepted = await f.run(resolution, review);
  assert.equal(accepted.status, 202);
  const result = await f.terminal(accepted.json().runId);
  assert.equal(result.json().state, 'completed');
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 1);
  const count = f.calls.length;
  await f.post('hosted/status', { ...base, runId: accepted.json().runId });
  const other = f.server.sessions.create();
  other.claims = { ...operatorClaims(), oid: '44444444-4444-4444-4444-444444444444' };
  for (const endpoint of ['status', 'cancel', 'reconcile']) {
    const body = { ...base, runId: accepted.json().runId, ...(endpoint === 'reconcile' ? { contextVersion: other.contextVersion } : {}) };
    assert.equal((await f.post(`hosted/${endpoint}`, body, other)).status, 404);
  }
  assert.equal(f.calls.length, count);
  assert.notEqual((await f.run(resolution, review)).status, 202);
  assert.equal(f.calls.length, count);
});

diskTest('unknown fields, cross-origin/CSRF/owner, stale resolution/acknowledgement and subscription mismatch are blocked before effects', async (t) => {
  const f = await fixture(t);
  for (const field of ['plan', 'commands', 'url', 'scope', 'audience']) {
    assert.equal((await f.post('hosted/resolve', { ...f.payload(), [field]: 'forbidden' })).status, 400);
  }
  assert.equal((await f.post('hosted/resolve', f.payload(), f.session, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.post('hosted/resolve', f.payload(), f.session, { 'X-Citadel-CSRF': 'invalid' })).status, 401);
  const badSubscription = { ...f.payload(), inputs: { ...f.payload().inputs, 'hub.subscriptionId': tenantId } };
  assert.equal((await f.post('hosted/resolve', badSubscription)).status, 409);
  const original = (await f.resolve()).json(), newer = (await f.resolve()).json();
  assert.equal((await f.review(original)).status, 409);
  const noAck = await f.post('hosted/review', { ...base, resolutionId: newer.resolutionId,
    contextVersion: f.session.contextVersion, reviewDigest: newer.preview.reviewDigest, acknowledgement: null });
  assert.equal(noAck.status, 409);
  const other = f.server.sessions.create();
  other.claims = { ...operatorClaims(), oid: '44444444-4444-4444-4444-444444444444' };
  assert.equal((await f.post('hosted/review', { ...base, resolutionId: newer.resolutionId,
    contextVersion: other.contextVersion, reviewDigest: newer.preview.reviewDigest, acknowledgement: null }, other)).status, 409);
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 0);
});

diskTest('run-time drift and context changes never silently re-resolve or write', async (t) => {
  const f = await fixture(t);
  const resolution = (await f.resolve()).json(), review = (await f.review(resolution)).json();
  f.drift();
  const run = await f.run(resolution, review), result = await f.terminal(run.json().runId);
  assert.equal(result.json().state, 'blocked');
  assert.equal(result.json().result.meta.code, 'review-required');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 0);
  const next = (await f.resolve()).json();
  f.server.sessions.invalidateContext(f.session);
  assert.equal((await f.review(next)).status, 409);
});

diskTest('unconfirmed effects retain targets across runtime reopen/new sessions and require explicit owner readback', async (t) => {
  const f = await fixture(t);
  f.fail();
  const resolution = (await f.resolve()).json(), review = (await f.review(resolution)).json();
  const accepted = await f.run(resolution, review), runId = accepted.json().runId;
  assert.equal((await f.terminal(runId)).json().state, 'inconclusive');
  await f.server.runtime.staged.close();
  const sessions = createSessions(f.config), session = sessions.create();
  Object.assign(session, { claims: operatorClaims(), account: { localAccountId: oid, tenantId }, azure: true, subscription: { id: subscriptionId } });
  const reopened = createStagedRuntime(f.config, sessions, f.auth, { fetchImpl: f.fetchImpl, testAdapters: [f.adapter] });
  t.after(async () => { sessions.close(); await reopened.close(); });
  const recoverable = reopened.recoverable(session, { ...base, contextVersion: session.contextVersion });
  assert.ok(recoverable.runs.some((run) => run.id === runId));
  assert.throws(() => reopened.status(session, { ...base, runId }), /reconcile/);
  const payload = { ...f.payload(), contextVersion: session.contextVersion };
  const second = await reopened.resolve(session, payload);
  const ticket = reopened.review(session, { ...base, contextVersion: session.contextVersion, resolutionId: second.resolutionId,
    reviewDigest: second.preview.reviewDigest, acknowledgement: { accepted: true, sampleId: f.adapter.id } });
  assert.throws(() => reopened.run(session, { ...base, contextVersion: session.contextVersion, resolutionId: second.resolutionId,
    reviewDigest: second.preview.reviewDigest, runNonce: ticket.runNonce }), /target/i);
  f.confirm();
  const count = f.calls.filter((call) => call.method === 'PATCH').length;
  const reconciled = await reopened.reconcile(session, { ...base, runId, contextVersion: session.contextVersion });
  assert.equal(reconciled.recovery, null);
  assert.deepEqual(reopened.recoverable(session, { ...base, contextVersion: session.contextVersion }), { runs: [] });
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, count);
});

for (const purpose of RESOURCE_PURPOSES) {
  diskTest(`${purpose}: exact consent intents fence stale tabs/purposes/late callbacks without charging a new start`, async (t) => {
    let starts = 0, release, entered;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const auth = {
      token: async () => 'synthetic-arm-token', client: () => ({}),
      start: async (tx) => { starts++; return `https://login.example.invalid/authorize?state=${tx.state}`; },
      finish: async () => new Promise((resolve) => {
        release = () => resolve({ claims: operatorClaims(), account: { localAccountId: oid, tenantId }, cache: {} });
        entered();
      }),
    };
    const f = await fixture(t, { purpose, auth });
    const old = (await f.resolve()).json(), current = (await f.resolve()).json();
    assert.equal(current.state, 'consent-required');
    const startBody = (intent) => ({ ...base, purpose, resolutionId: intent.resolutionId,
      contextVersion: intent.contextVersion, consentIntentId: intent.consentIntentId, targetDigest: intent.targetDigest });
    const version = f.session.contextVersion;
    for (const body of [
      startBody(old.requiredConsents[0]),
      { ...startBody(current.requiredConsents[0]), targetDigest: digest('different-target') },
      { ...startBody(current.requiredConsents[0]), purpose: RESOURCE_PURPOSES.find((item) => item !== purpose) },
      { ...startBody(current.requiredConsents[0]), scope: 'https://evil.invalid/.default' },
    ]) assert.notEqual((await f.post('auth/start', body)).status, 200);
    assert.equal(starts, 0);
    assert.equal(f.session.contextVersion, version);
    const intent = f.session.consentIntents.get(current.requiredConsents[0].consentIntentId);
    f.session.consentIntents.set(intent.consentIntentId, { ...intent, expiresAt: Date.now() - 1 });
    assert.equal((await f.post('auth/start', startBody(current.requiredConsents[0]))).status, 409);
    assert.equal(starts, 0);
    f.session.consentIntents.set(intent.consentIntentId, intent);
    const started = await f.post('auth/start', startBody(current.requiredConsents[0]));
    assert.equal(started.status, 200);
    assert.equal((await f.post('auth/start', startBody(current.requiredConsents[0]))).status, 409);
    assert.equal(starts, 1);
    const state = new URL(started.json().url).searchParams.get('state');
    const callback = httpsTestRequest(f.server, tls, { path: `/auth/callback?state=${state}&code=synthetic`,
      headers: { Cookie: cookies(started, '__Host-citadel-login') } });
    await waiting;
    await f.post('auth/cancel', {});
    f.session.subscription = { id: subscriptionId };
    const newer = (await f.resolve()).json();
    const next = await f.post('auth/start', startBody(newer.requiredConsents[0]));
    assert.equal(next.status, 200);
    release();
    const finished = await callback;
    assert.equal(finished.headers.location, '/?signin=failed');
    assert.equal(finished.headers['set-cookie'], undefined);
    assert.equal(f.session.authPending, true);
    assert.equal(f.session.credentials[purpose], undefined);
    assert.equal(starts, 2);
  });
  for (const outcome of ['start-failed', 'declined', 'mismatched', 'cancelled']) {
    diskTest(`${purpose}: ${outcome} retains only the verified operator and unrelated ARM cache`, async (t) => {
      const auth = {
        token: async () => 'synthetic-arm-token', client: () => ({}),
        start: async (tx) => {
          if (outcome === 'start-failed') throw new Error('Synthetic start failure');
          return `https://login.example.invalid/authorize?state=${tx.state}`;
        },
        finish: async () => ({ claims: { ...operatorClaims(), oid: '44444444-4444-4444-4444-444444444444' },
          account: { localAccountId: '44444444-4444-4444-4444-444444444444', tenantId }, cache: {} }),
      };
      const f = await fixture(t, { purpose, auth }), arm = f.session.credentials.azure;
      const resolution = (await f.resolve()).json(), intent = resolution.requiredConsents[0];
      const started = await f.post('auth/start', { ...base, purpose, resolutionId: intent.resolutionId,
        contextVersion: intent.contextVersion, consentIntentId: intent.consentIntentId, targetDigest: intent.targetDigest });
      if (outcome === 'start-failed') assert.equal(started.status, 503);
      else if (outcome === 'cancelled') assert.equal((await f.post('auth/cancel', {})).status, 200);
      else {
        const state = new URL(started.json().url).searchParams.get('state');
        const query = outcome === 'declined' ? 'error=access_denied' : 'code=synthetic';
        const callback = await httpsTestRequest(f.server, tls, { path: `/auth/callback?state=${state}&${query}`,
          headers: { Cookie: cookies(started, '__Host-citadel-login') } });
        assert.equal(callback.headers.location, '/?signin=failed');
      }
      assert.equal(f.server.sessions.authorized(f.session), true);
      assert.equal(f.session.authPending, false);
      assert.equal(f.session.credentials.azure, arm);
      assert.equal(f.session.credentials[purpose], undefined);
      assert.equal(f.session.stagedResolution, null);
      assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 0);
    });
  }
}

diskTest('generated access output hands off only a target-bound slot to an existing entered-key field', async (t) => {
  const field = 'gatewayAccess.apiKey';
  const credentialTarget = { resourceId: `${target.resourceId}/subscriptions/fixture-contract`,
    origin: 'https://gateway.example.invalid', routes: ['/a2a/fixture'], headerName: 'api-key' };
  const producerEffect = { id: 'fixed-effect', method: 'PATCH', url: readOperation.url, purpose: 'azure', effect: 'write', body: '{"fixture":true}' };
  const consumerEffect = { id: 'use-bound-key', method: 'POST', url: `${credentialTarget.origin}${credentialTarget.routes[0]}`,
    purpose: 'gateway-key', effect: 'paid', keyField: field, body: '{"fixture":true}' };
  const consumer = { id: 'a2a-message-send', version: 'w1-test-1', policyId: 'synthetic-key-target', resolvePurposes: [],
    resolve: async () => ({ targets: [{ resourceId: credentialTarget.resourceId, origin: credentialTarget.origin }],
      preconditions: [], operations: [consumerEffect], credentialTargets: { [field]: credentialTarget } }),
    authorizeRequest: ({ phase, request }) => phase === 'execute' && digest(request) === digest(consumerEffect),
    execute: async ({ resolution, send, confirmEffect }) => {
      const response = await send(resolution.operations[0]); await response.json(); confirmEffect(consumerEffect.id); return { state: 'completed' };
    }, reconcile: async () => [] };
  const f = await fixture(t, { id: 'access-contract-deploy', generatedFields: [field], additionalAdapters: [consumer],
    resolve: async () => ({ targets: [target], preconditions: [], operations: [producerEffect], credentialTargets: { [field]: credentialTarget } }),
    execute: async ({ resolution, send, confirmEffect, putGenerated }) => {
      const response = await send(resolution.operations[0]); await response.json(); confirmEffect(producerEffect.id);
      putGenerated({ field, value: 'SYNTHETIC-GENERATED-HANDOFF', target: credentialTarget }); return { state: 'completed' };
    } });
  const producer = (await f.resolve()).json(), producerReview = (await f.review(producer)).json();
  const accepted = await f.run(producer, producerReview), output = (await f.terminal(accepted.json().runId)).json();
  assert.equal(output.state, 'completed');
  assert.ok(!JSON.stringify(output).includes('SYNTHETIC-GENERATED-HANDOFF'));
  const { slotId, generation } = output.secretBindings[field];
  const { acknowledgement, ...request } = runPayload(consumer.id, f.session);
  const payload = { ...request, hostedFlowVersion: 1, secretBindings: { [field]: { slotId, generation } } };
  assert.equal((await f.post('hosted/resolve', payload)).status, 400);
  delete payload.secrets;
  const resolved = (await f.post('hosted/resolve', payload)).json();
  assert.equal(resolved.state, 'ready', JSON.stringify(resolved));
  const reviewed = (await f.post('hosted/review', { ...base, resolutionId: resolved.resolutionId,
    contextVersion: f.session.contextVersion, reviewDigest: resolved.preview.reviewDigest, acknowledgement })).json();
  const consumed = await f.run(resolved, reviewed);
  assert.equal((await f.terminal(consumed.json().runId)).json().state, 'completed');
  assert.equal(f.calls.filter((call) => call.generatedKeyUsed).length, 1);
  for (const name of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, name));
    assert.equal(bytes.includes(Buffer.from('SYNTHETIC-GENERATED-HANDOFF')), false);
  }
  assert.equal((await f.post('hosted/secret', { ...base, slotId })).status, 404);
  f.server.sessions.invalidateContext(f.session);
  assert.throws(() => f.server.runtime.staged.slots.describe(f.session, field, { slotId, generation }), /unavailable/);
});

diskTest('an adapter cannot report completion merely because HTTP succeeded without explicit effect confirmation', async (t) => {
  const f = await fixture(t, { execute: async ({ resolution, send }) => {
    await send(resolution.operations[0]); return { state: 'completed' };
  } });
  const resolution = (await f.resolve()).json(), review = (await f.review(resolution)).json();
  const accepted = await f.run(resolution, review), output = (await f.terminal(accepted.json().runId)).json();
  assert.equal(output.state, 'inconclusive');
  assert.equal(output.result.state, 'inconclusive');
  assert.equal(output.recovery, 'explicit-readback-required');
  assert.equal(f.calls.filter((call) => call.method === 'PATCH').length, 1);
});

diskTest('all-off cleanup can use the empty fixed foundation without Azure, target reads or acknowledgement', async (t) => {
  const f = await fixture(t, { id: 'cleanup', resolvePurposes: [],
    resolve: async () => ({ targets: [], preconditions: [], operations: [] }),
    execute: async () => ({ state: 'completed' }) });
  f.session.azure = false; f.session.credentials = {}; f.session.subscription = null;
  const payload = f.payload();
  for (const name of ['confirmNonProduction', 'deleteAccessContract', 'deletePublishedAssets', 'deleteWeatherSourceApi']) {
    payload.inputs[`samples.cleanup.${name}`] = 'false';
  }
  payload.inputs['hub.subscriptionId'] = '';
  const resolved = (await f.post('hosted/resolve', payload)).json();
  assert.equal(resolved.state, 'ready', JSON.stringify(resolved));
  const review = (await f.post('hosted/review', { ...base, resolutionId: resolved.resolutionId,
    contextVersion: f.session.contextVersion, reviewDigest: resolved.preview.reviewDigest, acknowledgement: null })).json();
  const accepted = await f.run(resolved, review);
  assert.equal((await f.terminal(accepted.json().runId)).json().state, 'completed');
  assert.equal(f.calls.length, 0);
  assert.equal(f.tokenCalls.length, 0);
});

diskTest('context changes during explicit resolution fence the response without installing a preview', async (t) => {
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { resolve: async () => {
    await new Promise((resolve) => { release = resolve; entered(); });
    return { targets: [target], preconditions: [], operations: [] };
  } });
  const pending = f.resolve();
  await waiting;
  f.server.sessions.invalidateContext(f.session);
  release();
  assert.equal((await pending).status, 409);
  assert.equal(f.session.stagedResolution, null);
  assert.equal(f.calls.length, 0);
});

diskTest('admission disconnect before the dispatch turn leaves a durable cancelled run with zero provider effects', async (t) => {
  const f = await fixture(t);
  const resolution = (await f.resolve()).json(), review = (await f.review(resolution)).json();
  const controller = new AbortController();
  const accepted = f.server.runtime.staged.run(f.session, { ...base, resolutionId: resolution.resolutionId,
    contextVersion: f.session.contextVersion, reviewDigest: resolution.preview.reviewDigest, runNonce: review.runNonce },
  { signal: controller.signal });
  controller.abort();
  const result = (await f.terminal(accepted.runId)).json();
  assert.equal(result.state, 'cancelled');
  assert.equal(result.recovery, null);
  assert.equal(f.calls.length, 1);
});

diskTest('HTTPS cancel stays responsive while an admitted provider request is held; no later effect is sent', async (t) => {
  const f = await fixture(t);
  f.hold();
  const resolution = (await f.resolve()).json(), review = (await f.review(resolution)).json();
  const accepted = await f.run(resolution, review);
  for (let count = 0; count < 100 && !f.calls.some((call) => call.method === 'PATCH'); count++) await new Promise((resolve) => setTimeout(resolve, 5));
  const start = performance.now();
  assert.equal((await f.post('hosted/cancel', { ...base, runId: accepted.json().runId })).status, 200);
  const cancelMs = performance.now() - start;
  f.release();
  assert.equal((await f.terminal(accepted.json().runId)).json().state, 'inconclusive');
  assert.ok(cancelMs < 1000);
  t.diagnostic(JSON.stringify({ cancelMs, note: 'Synthetic held provider; observation, not an SLA.' }));
});

diskTest('HTTPS auth and cancel latency is observed during synchronous commits, checkpoints and guard contention', async (t) => {
  const f = await fixture(t);
  f.hold();
  const resolution = (await f.resolve()).json(), review = (await f.review(resolution)).json();
  const accepted = await f.run(resolution, review);
  for (let count = 0; count < 100 && !f.calls.some((call) => call.method === 'PATCH'); count++) await new Promise((resolve) => setTimeout(resolve, 5));
  const directory = await mkdtemp(join(process.env.CITADEL_STAGED_TEST_ROOT, 'citadel-staged-w1-96518acf-contention-'));
  directories.push(directory);
  const load = createSqliteRunStore({ directory }); t.after(load.close);
  const other = f.server.sessions.create();
  other.claims = { ...operatorClaims(), oid: '44444444-4444-4444-4444-444444444444' };
  const started = performance.now();
  const authentication = f.post('auth/start', { purpose: 'azure' }, other).then((response) => ({ response, ms: performance.now() - started }));
  const cancellation = f.post('hosted/cancel', { ...base, runId: accepted.json().runId }).then((response) => ({ response, ms: performance.now() - started }));
  let contentionMs = 0;
  for (let index = 0; index < 30; index++) {
    const { run } = load.claim(storageRecord(`latency-${index}`));
    load.finish(run.id, 'completed');
    if (index % 10 === 0) {
      load.checkpoint();
      const start = performance.now();
      assert.throws(() => createSqliteRunStore({ directory }), (error) => error.status === 503);
      contentionMs = Math.max(contentionMs, performance.now() - start);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [authResult, cancelResult] = await Promise.all([authentication, cancellation]);
  f.release();
  assert.equal(authResult.response.status, 200);
  assert.equal(cancelResult.response.status, 200);
  assert.ok(authResult.ms < 2000 && cancelResult.ms < 2000);
  assert.equal((await f.terminal(accepted.json().runId)).json().state, 'inconclusive');
  t.diagnostic(JSON.stringify({ ...load.diagnostics(), contentionMs, authMs: authResult.ms, cancelMs: cancelResult.ms,
    note: 'One isolated local-volume observation under synthetic concurrent load; not an SLA.' }));
});
