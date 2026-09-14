import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticCapture } from '../server/diagnostics.mjs';
import { DiagnosticsClient, startDiagnostics } from '../web/js/diagnostics-client.mjs';
import { clientDiagnostic, diagnosticResource, DIAGNOSTICS_LIMITS as L } from '../shared/diagnostics.mjs';
import { diagnosticClock } from './_diagnostics-fixture.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const origin = 'http://127.0.0.1:45281';

function harness(t) {
  const clock = diagnosticClock();
  const store = new DiagnosticCapture(clock.options);
  const calls = [];
  const channels = new Set();
  const state = { failStatus: false, failEvents: false, invalidStatus: false, calls, store, clock };
  const channelFactory = () => {
    const channel = new EventTarget();
    channel.postMessage = (data) => {
      for (const peer of channels) if (peer !== channel) peer.dispatchEvent(Object.assign(new Event('message'), { data }));
    };
    channel.close = () => channels.delete(channel);
    channels.add(channel);
    return channel;
  };
  const fetchImpl = async (path, options) => {
    assert(path.startsWith('/api/diagnostics/'));
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Citadel-Session'], 'synthetic-owner-token');
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, payload });
    const action = path.split('/').at(-1);
    if (state.failStatus && ['status', 'report'].includes(action)) throw new Error('FAKE_STATUS_SECRET');
    if (state.failEvents && action === 'events') throw new Error('FAKE_DELIVERY_SECRET');
    let result;
    if (action === 'status') result = state.invalidStatus ? { raw: 'FAKE_RESPONSE_SECRET' } : store.status();
    if (action === 'report' || action === 'download') result = store.report();
    if (action === 'capture') result = store.setEnabled(payload.enabled, payload.expectedCaptureId);
    if (action === 'clear') result = store.clear(payload.expectedCaptureId);
    if (action === 'events') result = store.ingest(payload.captureId, payload.events, payload.clientQueueOmitted);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const clients = [];
  const create = (options = {}) => {
    const target = new EventTarget();
    target.location = { origin };
    const doc = new EventTarget();
    doc.visibilityState = 'visible';
    const client = new DiagnosticsClient({
      token: 'synthetic-owner-token', fetchImpl, window: target, document: doc,
      channelFactory, ...clock.options, ...options,
    });
    clients.push(client);
    return { client, target, doc };
  };
  t.after(() => { clients.forEach((client) => client.stop()); store.shutdown(); });
  return { ...state, state, create, fetchImpl, channelFactory };
}

test('diagnostics: browser hooks are off and non-inspecting until authoritative activation reaches each tab', async (t) => {
  const f = harness(t);
  const a = f.create();
  const b = f.create({ channelFactory: () => null });
  const debug = f.create({ includeReport: true, captureErrors: false });
  await a.client.start();
  await b.client.start();
  await debug.client.start();
  const hostile = new Proxy({}, { get() { assert.fail('Off capture must not read an error'); } });
  assert.equal(a.client.record(hostile), false);
  a.target.dispatchEvent(Object.assign(new Event('error'), { error: hostile }));
  await a.client.flush();
  assert.equal(f.calls.filter((entry) => entry.path.endsWith('/events')).length, 0);
  assert.equal(f.clock.timers.size, 3, 'off tabs only poll, with no event flush timer');
  await debug.client.setEnabled(true);
  await settle();
  assert(a.client.collecting(), 'same-profile hints fetch authoritative state');
  assert.equal(b.client.collecting(), false, 'a separate profile has not polled yet');
  f.clock.advance(L.pollMs);
  await f.clock.runDue();
  assert(b.client.collecting());
  assert.equal(f.store.report().events.length, 0, 'activation does not manufacture a test error');
  debug.client.stop();
  a.client.record(new TypeError('not stored'), 'app.action');
  await a.client.flush();
  assert.equal(f.store.report().events.length, 1, 'closing debug does not stop the server or application collector');
});

test('diagnostics: handled, uncaught and unhandled-rejection boundaries sanitize before queue and transport', async (t) => {
  const f = harness(t);
  const { client, target } = f.create();
  f.store.setEnabled(true, null);
  await client.start();
  const secret = 'FAKE_BROWSER_SECRET_16QX';
  const error = Object.assign(new TypeError(secret), {
    name: secret, code: secret, stack: `${secret} at C:\\private\\${secret}`, filename: secret,
    headers: { authorization: secret }, body: secret, source: secret,
  });
  const consoleLines = [];
  const previousLog = console.error;
  console.error = (...args) => consoleLines.push(args);
  t.after(() => { console.error = previousLog; });
  client.record(error, 'app.action', 'handled', { module: '/js/app.mjs', ignored: secret });
  const uncaught = Object.assign(new Event('error', { cancelable: true }), {
    error, message: secret, filename: `${origin}/js/app.mjs`, lineno: 123, colno: 7,
  });
  target.dispatchEvent(uncaught);
  const rejected = Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason: secret });
  target.dispatchEvent(rejected);
  target.dispatchEvent(Object.assign(new Event('error'), {
    error, filename: `${origin}/js/app.mjs?key=${secret}#${secret}`, lineno: 123, colno: 7,
  }));
  client.recordApi({ code: 'INVALID_CONTENT', message: secret, name: secret, sourceAlias: secret },
    `/api/github/workspaces/${secret}/read?alias=${secret}`, 409);
  await client.flush();
  const sent = f.calls.filter((entry) => entry.path.endsWith('/events'));
  assert.equal(sent.length, 1);
  assert(!JSON.stringify(sent).includes(secret));
  assert(!JSON.stringify(f.store.report()).includes(secret));
  assert.equal(consoleLines.length, 0, 'diagnostics never writes error content to console');
  assert.equal(uncaught.defaultPrevented, false);
  assert.equal(rejected.defaultPrevented, false, 'normal error propagation is not suppressed');
  const events = f.store.report().events;
  assert(events.some((entry) => entry.category === 'uncaught' && entry.module === '/js/app.mjs' && entry.line === 123 && entry.column === 7));
  assert(events.some((entry) => entry.category === 'unhandled-rejection' && entry.exception === 'UnknownError'));
  assert(events.some((entry) => entry.code === 'INVALID_CONTENT' && entry.operation === 'api.github.workspaces'));
  assert(events.every((entry) => entry.correlationId === null));
});

test('diagnostics: native codes and bundled resources retain no operator aliases, values or dynamic identities', async (t) => {
  const f = harness(t);
  const { client } = f.create();
  f.store.setEnabled(true, null);
  await client.start();
  const sentinel = 'SYNTHETIC_NATIVE_PRIVATE_VALUE';
  const error = Object.assign(new Error(sentinel), {
    code: 'NATIVE_SENSITIVE_FILE', alias: `environments/${sentinel}.tfvars`,
    profileId: sentinel, unitId: sentinel, value: sentinel, sourceText: sentinel,
    cause: new Error(sentinel),
  });
  client.record(error, 'app.action', 'handled', { module: '/shared/terraform/parser.mjs', alias: error.alias });
  client.recordApi(error, `/api/github/repos/${sentinel}/native-inventory?value=${sentinel}`, 400, 'GET');
  await client.flush();
  const report = f.store.report();
  assert(report.events.some((entry) => entry.code === 'NATIVE_SENSITIVE_FILE' && entry.module === '/shared/terraform/parser.mjs'));
  assert(report.events.some((entry) => entry.resource === '/api/github/repos/:repositoryId/native-inventory'));
  assert(!JSON.stringify({ calls: f.calls, report }).includes(sentinel));
  assert.equal(diagnosticResource('/shared/terraform/vendor/hcl.wasm'), '/shared/terraform/vendor/hcl.wasm');
  assert.equal(diagnosticResource(`/shared/terraform/vendor/${sentinel}.wasm`), null);
  assert.equal(clientDiagnostic({ code: `NATIVE_${sentinel}` }).code, 'UNKNOWN');
});

test('diagnostics: missed polls and exact expiry stop client collection without timers; late batches cannot cross captures', async (t) => {
  const f = harness(t);
  const { client } = f.create();
  const first = f.store.setEnabled(true, null);
  await client.start();
  client.record(new Error('before disconnect'));
  f.clock.advance(L.clientLeaseMs);
  assert.equal(client.collecting(), false);
  assert.equal(client.record(new Error('must not queue')), false);
  await client.flush();
  assert.equal(f.store.report().counts.received, 0);
  assert(client.issues.includes('delivery-failed'));
  f.clock.advance(L.durationMs - L.clientLeaseMs - 1);
  await client.refresh();
  assert.equal(client.remainingMs(), 1);
  client.record(new Error('at the boundary'));
  f.clock.advance(1);
  await client.flush();
  assert.equal(client.collecting(), false);
  assert.equal(f.calls.filter((entry) => entry.path.endsWith('/events')).length, 0);
  assert.equal(f.store.report().capture.stopReason, 'expired');
  const next = f.store.setEnabled(true, first.capture.id);
  await client.refresh();
  await client.flush();
  assert.equal(next.counts.received, 0, 'a new interval never receives the previous queue');
});

test('diagnostics: an old in-flight batch cannot revive a stopped capture or contaminate its replacement', async (t) => {
  for (const mode of ['replace-response', 'replace-failure', 'stop-response']) await t.test(mode, async (t) => {
    const f = harness(t);
    const first = f.store.setEnabled(true, null);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let hold = true;
    const { client } = f.create({
      fetchImpl: async (...args) => {
        const response = await f.fetchImpl(...args);
        if (args[0].endsWith('/events') && hold) {
          hold = false;
          await held;
          if (mode === 'replace-failure') throw new Error('FAKE_OLD_CAPTURE_DELIVERY_SECRET');
        }
        return response;
      },
    });
    await client.start();
    client.record(new TypeError('old capture'));
    const flight = client.flush();
    await settle();
    f.store.setEnabled(false, first.capture.id);
    const next = mode === 'stop-response' ? f.store.status() : f.store.setEnabled(true, first.capture.id);
    await client.refresh();
    if (next.capture.active) client.record(new RangeError('new capture'));
    release();
    await flight;
    assert.equal(client.state.capture.id, next.capture.id);
    assert.equal(client.collecting(), next.capture.active);
    assert(!client.issues.includes('delivery-failed'), 'old-window feedback cannot describe a newer state');
    if (next.capture.active) {
      await client.flush();
      assert.equal(f.store.report().counts.received, 1);
      assert.equal(f.store.report().counts.clientQueueOmitted, 0);
      assert.equal(f.store.report().events[0].exception, 'RangeError');
    }
  });
});

test('diagnostics: local deadline uses round trip and both clocks rather than browser clock agreement', async (t) => {
  const f = harness(t);
  f.store.setEnabled(true, null);
  const { client } = f.create({
    fetchImpl: async (...args) => {
      const response = await f.fetchImpl(...args);
      f.clock.monoBy(1000);
      return response;
    },
  });
  await client.start();
  assert.equal(client.remainingMs(), L.durationMs - 1000);
  f.clock.wallBy(-3600000);
  assert.equal(client.remainingMs(), L.durationMs - 1000);
  f.clock.monoBy(L.durationMs);
  assert.equal(client.collecting(), false);
  assert.equal(client.remainingMs(), 0);
});

test('diagnostics: queue and batch limits, delivery failure feedback, no retries and no diagnostic recursion', async (t) => {
  const f = harness(t);
  const a = f.create();
  const debug = f.create({ includeReport: true, captureErrors: false });
  f.store.setEnabled(true, null);
  await a.client.start();
  await debug.client.start();
  for (let n = 0; n < L.clientQueueEvents + 3; n++) a.client.record(new Error('not retained'));
  assert(a.client.issues.includes('client-overflow'));
  assert(debug.client.issues.includes('client-overflow'));
  await a.client.flush();
  assert.equal(f.calls.filter((entry) => entry.path.endsWith('/events'))[0].payload.events.length, L.batchEvents);
  assert.equal(f.store.report().counts.clientQueueOmitted, 3);
  f.state.failEvents = true;
  await a.client.flush();
  assert(debug.client.issues.includes('delivery-failed'));
  f.state.failEvents = false;
  await a.client.refresh();
  await a.client.flush();
  const batches = f.calls.filter((entry) => entry.path.endsWith('/events'));
  assert.equal(batches.at(-1).payload.events.length, 0, 'a failed batch is not retried');
  assert.equal(batches.at(-1).payload.clientQueueOmitted, L.batchEvents);
  assert.equal(a.client.recordApi(new Error('internal diagnostic failure'), '/api/diagnostics/report?token=unsafe', 500), false);
  a.target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('diagnostic module failure'), filename: `${origin}/js/diagnostics-client.mjs` }));
  await a.client.flush();
  assert.equal(f.calls.filter((entry) => entry.path.endsWith('/events')).length, batches.length);
  assert(!JSON.stringify(batches).includes('FAKE_DELIVERY_SECRET'));
});

test('diagnostics: unavailable/invalid status is visible, non-collecting and cannot activate through a broadcast', async (t) => {
  const f = harness(t);
  const { client } = f.create();
  await client.start();
  f.state.invalidStatus = true;
  await client.refresh();
  assert(client.issues.includes('status-unavailable'));
  assert.equal(client.collecting(), false);
  assert.equal(client.connected, false);
  const foreign = f.channelFactory();
  foreign.postMessage({ type: 'refresh', enabled: true, report: { text: 'FAKE_RESPONSE_SECRET' } });
  assert.equal(client.collecting(), false);
  foreign.close();
  f.state.invalidStatus = false;
  f.state.failStatus = true;
  await client.refresh();
  assert(!JSON.stringify(client.issues).includes('FAKE_STATUS_SECRET'));
  f.state.failStatus = false;
  f.store.setEnabled(true, null);
  await client.refresh();
  assert(client.collecting());
});

test('diagnostics: default browser timers are called without an illegal class receiver', async (t) => {
  const f = harness(t);
  const previousSet = globalThis.setTimeout;
  const previousClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (...args) {
    assert.equal(this, undefined, 'WebIDL timers must not receive the DiagnosticsClient as this');
    return f.clock.options.setTimer(...args);
  };
  globalThis.clearTimeout = function (...args) {
    assert.equal(this, undefined);
    return f.clock.options.clearTimer(...args);
  };
  const client = new DiagnosticsClient({
    token: 'synthetic-owner-token', fetchImpl: f.fetchImpl, window: new EventTarget(),
    document: new EventTarget(), channelFactory: () => null,
    now: f.clock.options.now, monotonic: f.clock.options.monotonic,
  });
  try {
    await client.start();
    assert.equal(client.connected, true);
    assert.equal(client.issues.length, 0);
    client.stop();
  } finally {
    globalThis.setTimeout = previousSet;
    globalThis.clearTimeout = previousClear;
  }
});

test('diagnostics: localRequest and single-flight preserve original failures while reporting only safe metadata', async (t) => {
  const f = harness(t);
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const priorFetch = globalThis.fetch;
  const target = new EventTarget();
  target.location = { origin };
  target.localStorage = { getItem: () => 'synthetic-owner-token' };
  globalThis.window = target;
  globalThis.document = { querySelector: () => null };
  f.store.setEnabled(true, null);
  const current = startDiagnostics({
    token: 'synthetic-owner-token', fetchImpl: f.fetchImpl, window: target,
    document: new EventTarget(), channelFactory: () => null, ...f.clock.options,
  });
  t.after(() => {
    current.stop();
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
    globalThis.fetch = priorFetch;
  });
  await current.refresh();
  const { localRequest } = await import('../web/js/local-api.mjs');
  const { createSingleFlight } = await import('../web/js/single-flight.mjs');
  const secret = 'FAKE_LOCAL_API_SECRET_642JU';
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: secret, code: 'INVALID_CONTENT', correlationId: secret, body: secret, path: secret },
  }), { status: 409 });
  await assert.rejects(localRequest(`/api/registry?name=${secret}`, { method: 'POST', body: JSON.stringify({ secret }) }),
    (error) => error.code === 'INVALID_CONTENT' && error.status === 409 && error.message.includes(secret));
  const original = Object.assign(new TypeError(secret), { stack: secret });
  globalThis.fetch = async () => { throw original; };
  await assert.rejects(localRequest('/api/registry'), (error) => error === original);
  const flight = createSingleFlight();
  await assert.rejects(flight.run('synthetic-action', () => { throw original; }), (error) => error === original);
  assert.equal(flight.isBusy('synthetic-action'), false);
  await current.flush();
  const batches = f.calls.filter((entry) => entry.path.endsWith('/events'));
  assert(!JSON.stringify(batches).includes(secret));
  assert(f.store.report().events.some((entry) => entry.code === 'INVALID_CONTENT'));
  const rejected = f.store.report().events.find((entry) => entry.code === 'INVALID_CONTENT');
  assert.equal(rejected.method, 'POST');
  assert.equal(rejected.resource, '/api/registry');
  assert(f.store.report().events.some((entry) => entry.code === 'NETWORK_ERROR'));
  assert(f.store.report().events.some((entry) => entry.module === '/js/single-flight.mjs'));
});
