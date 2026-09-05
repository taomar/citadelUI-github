import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpsTransport } from '../src/hosted/httpsTransport.mjs';
import { createSessions, randomToken } from '../src/hosted/sessions.mjs';
import { createHostedServer } from '../src/hosted/server.mjs';
import { createHostedRuntime } from '../src/hosted/runtime.mjs';
import { readHostedConfig, readTls } from '../src/hosted/config.mjs';
import { createRunProgress, reduceRunProgress } from '../src/view/runProgress.mjs';
import { buildResponseModel, buildWorkbenchModel } from '../src/view/models.mjs';
import { CATALOGUE } from '../src/catalogue/index.mjs';
import { hostedConfig, operatorClaims, runPayload, fixtureResourceResponse, subscriptionId } from './helpers/hostedFixtures.mjs';
import { makeFixtureReader } from './helpers/fixtures.mjs';
import { testTls, httpsTestRequest } from './helpers/hostedTls.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tls = testTls();
after(tls.clean);
async function listen(server, t) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server;
}

test('transport pins approved DNS, refuses redirects/oversized responses, and aborts DNS on cancellation', async (t) => {
  let requests = 0, resolutions = 0;
  const server = await listen(createServer(tls, (request, response) => {
    requests++;
    if (request.url === '/redirect') response.writeHead(302, { Location: 'https://attacker.invalid' }).end();
    else if (request.url === '/large') response.end('x'.repeat(2 * 1024 * 1024 + 1));
    else response.end('{"ok":true}');
  }), t);
  const transport = createHttpsTransport({ ca: tls.ca,
    resolve: async () => { resolutions++; return [{ address: '127.0.0.1', family: 4 }]; },
    addressAllowed: (address) => address === '127.0.0.1' });
  const origin = `https://localhost:${server.address().port}`;
  assert.deepEqual(await (await transport(origin)).json(), { ok: true });
  assert.equal(resolutions, 1);
  await assert.rejects(transport(`${origin}/redirect`), /redirect/);
  assert.equal(requests, 2);
  await assert.rejects(transport(`${origin}/large`), /limit/);
  const mixedDns = createHttpsTransport({ resolve: async () => [
    { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
  ] });
  await assert.rejects(mixedDns(origin), /DNS/);
  assert.equal(requests, 3);
  const controller = new AbortController();
  const delayedDns = createHttpsTransport({ resolve: () => new Promise(() => {}) });
  const pending = delayedDns(origin, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

test('a plaintext request cannot reach the HTTPS application listener; expired TLS fails closed', async (t) => {
  const config = hostedConfig({ authIssues: ['not configured'] });
  const server = await listen(createHostedServer({ config, tls, root }), t);
  const plaintext = await new Promise((resolve, reject) => {
    const socket = connect(server.address().port, '127.0.0.1');
    let bytes = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('connect', () => socket.write('GET /api/live HTTP/1.1\r\nHost: localhost\r\n\r\n'));
    socket.on('data', (chunk) => { bytes += chunk; });
    socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => resolve(bytes));
  });
  assert.doesNotMatch(plaintext, /HTTP\/1\.1 200|status.*ok/);
  const expired = testTls({ expired: true });
  t.after(expired.clean);
  assert.throws(() => readTls({ CITADEL_TLS_CERT_FILE: resolve(expired.directory, 'server.pem'),
    CITADEL_TLS_KEY_FILE: resolve(expired.directory, 'server.key') }, 'https://localhost'), /not currently valid/);
  const expiredServer = await listen(createServer(expired, (_, response) => response.end('not reachable')), t);
  await assert.rejects(httpsTestRequest(expiredServer, expired), /expired/i);
});

test('unentitled members, forged headers, stale CSRF, wrong Host and encoded source traversal fail closed', async (t) => {
  const server = await listen(createHostedServer({ config: hostedConfig({ authIssues: ['not configured'] }), tls, root }), t);
  const caps = await httpsTestRequest(server, tls, { path: '/api/capabilities' });
  const session = server.sessions.create();
  session.claims = { ...operatorClaims(), roles: [] };
  const headers = { Cookie: `__Host-citadel=${session.id}`, Origin: 'https://localhost',
    'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Citadel-CSRF': session.csrf,
    'X-Ms-Client-Principal': 'forged-platform-principal' };
  const post = (extra = {}) => httpsTestRequest(server, tls, { path: '/api/hosted/run', method: 'POST',
    headers: { ...headers, ...extra }, body: {} });
  assert.equal((await post()).status, 403);
  assert.equal((await post({ 'X-Citadel-CSRF': randomToken() })).status, 401);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ Origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await post({ Host: 'attacker.invalid' })).status, 403);
  session.claims = operatorClaims();
  assert.equal((await httpsTestRequest(server, tls, { path: '/api/run', method: 'POST', headers, body: {} })).status, 404);
  assert.equal((await httpsTestRequest(server, tls, { path: '/api/auth/start', method: 'POST', headers,
    body: { purpose: 'signin', returnUrl: 'https://attacker.invalid' } })).status, 400);
  for (const path of ['/web/..%2fsrc/hosted/config.mjs', '/src/core/..%2fhosted/auth.mjs', '/node_modules/jose/package.json',
    '/api/azure/login', '/api/run', '/src/server/transports.mjs']) {
    assert.equal((await httpsTestRequest(server, tls, { path })).status, 404, path);
  }
});

test('current expiry and entitlement revoke dispatch, and context changes cancel only owned runs', async () => {
  let now = Date.now();
  const config = hostedConfig();
  const sessions = createSessions(config, { now: () => now });
  const operator = sessions.create(), other = sessions.create();
  operator.claims = operatorClaims();
  other.claims = operatorClaims();
  let dispatched = 0, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const runtime = createHostedRuntime(config, sessions, { token: async () => 'synthetic-token' }, {
    fetchImpl: async (_url, options) => {
      dispatched++;
      entered();
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    },
  });
  const payload = runPayload('weather-tools-call', operator);
  const pending = runtime.run(operator, { ...payload, ...runtime.review(operator, payload) });
  await ready;
  assert.equal(runtime.cancel(other).cancelled, false);
  assert.equal(operator.run.controller.signal.aborted, false);
  sessions.invalidateContext(operator);
  const result = await pending;
  assert.notEqual(result.state, 'completed');
  assert.equal(dispatched, 1);
  assert.equal(result.meta.liveEvidence, false);
  now += config.idleMs;
  assert.equal(sessions.authorized(operator), false);
  assert.throws(() => runtime.review(operator, runPayload('weather-tools-call', operator)), /authorized operator/);
  sessions.close();
});

test('APIM never picks a first ambiguous service or trusts a foreign returned resource ID', async () => {
  for (const scenario of ['ambiguous', 'foreign-id']) {
    const config = hostedConfig(), sessions = createSessions(config), session = sessions.create();
    Object.assign(session, { claims: operatorClaims(), azure: true, subscription: { id: subscriptionId } });
    let serviceReads = 0;
    const runtime = createHostedRuntime(config, sessions, { token: async () => 'synthetic-token' }, {
      fetchImpl: async (url, options) => {
        const data = await fixtureResourceResponse(url, options).json();
        if (new URL(url).pathname.endsWith('/service') && scenario === 'ambiguous') data.value.push({ ...data.value[0], name: 'another-service' });
        if (new URL(url).pathname.endsWith('/apim-citadel-test')) {
          serviceReads++;
          if (scenario === 'foreign-id') data.id = '/subscriptions/foreign/resource';
        }
        return Response.json(data);
      },
    });
    const payload = runPayload('apim-discovery', session);
    const result = await runtime.run(session, { ...payload, ...runtime.review(session, payload) });
    assert.notEqual(result.state, 'completed');
    if (scenario === 'ambiguous') assert.equal(serviceReads, 0);
    assert.deepEqual(result.configurationUpdates, {});
    sessions.close();
  }
});

test('hosted evidence and ARM presentation remain truthful after capability changes', () => {
  const sample = CATALOGUE.byId.get('azure-context-check');
  const capability = { kind: 'hosted-bff', canExecute: true, supportedStepTypes: ['http', 'assertion'], allowedSampleIds: [sample.id] };
  const model = buildWorkbenchModel({ sample, read: makeFixtureReader(), hasSecret: () => false, acknowledged: false,
    capability, runtimeProbe: { mode: 'hosted', hosted: { allowedSampleIds: [sample.id], resourceManager: 'https://management.azure.com/' } } });
  assert.match(model.guide.summary, /delegated/);
  assert.equal(model.configure.groups.flatMap((group) => group.fields).find((field) => field.path === 'hub.subscriptionId').hosted, true);
  assert.doesNotMatch(JSON.stringify(model.guide.prerequisites), /az login|az account/);
  const progress = createRunProgress({ sampleId: sample.id, mode: 'hosted', executorKind: 'hosted-bff' });
  const result = { state: 'completed', sampleId: sample.id, meta: { executor: 'hosted-bff', liveEvidence: true }, steps: [], assertions: [] };
  const final = reduceRunProgress(progress, { type: 'result', result });
  assert.equal(final.meta.evidenceClass, 'hosted-bff');
  const response = buildResponseModel({ sample, result: { ...result, meta: { ...result.meta, ...final.meta } },
    capability: { kind: 'unavailable', canExecute: false } });
  assert.equal(response.environment.mode, 'hosted-bff');
  const unconfigured = buildWorkbenchModel({ sample, read: makeFixtureReader(), hasSecret: () => false, capability,
    runtimeProbe: { mode: 'hosted', hosted: { allowedSampleIds: [] } } });
  assert.equal(unconfigured.request.available, false);
  assert.match(unconfigured.request.reason, /configure the Azure cloud/);
});

test('hosted entrypoint import closure cannot reach local process execution or plaintext listeners', async () => {
  const seen = new Set(), pending = [resolve(root, 'hosted-server.mjs')];
  while (pending.length) {
    const path = await realpath(pending.pop());
    if (seen.has(path)) continue;
    seen.add(path);
    assert.ok(path.startsWith(root.replace(/[\\/]$/, '') + sep));
    const text = await readFile(path, 'utf8');
    const imports = [...text.matchAll(/^\s*(?:import|export)\s+(?!async\b|function\b|class\b|const\b|let\b|var\b|default\b)(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.ok(!['node:child_process', 'child_process', 'node:http', 'http'].includes(specifier), `${path}: ${specifier}`);
      if (specifier.startsWith('.')) pending.push(resolve(dirname(path), specifier));
      else assert.ok(specifier.startsWith('node:') || ['jose', '@azure/msal-node'].includes(specifier), `${path}: ${specifier}`);
    }
  }
  assert.ok(seen.size > 20);
  assert.equal(readHostedConfig({ CITADEL_PLAYGROUND_PUBLIC_ORIGIN: 'https://localhost' }).cloud, null);
});
