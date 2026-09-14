import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DiagnosticCapture } from '../server/diagnostics.mjs';
import {
  DIAGNOSTICS_LIMITS as L, clientDiagnostic, copyDiagnosticReport, diagnosticFilename,
  diagnosticLocation, diagnosticResource, diagnosticRoute, validClientDiagnostic,
} from '../shared/diagnostics.mjs';
import { diagnosticGuidance } from '../shared/diagnostics-guidance.mjs';
import { diagnosticClock } from './_diagnostics-fixture.mjs';

const record = (context = {}) => clientDiagnostic(Object.assign(new TypeError('not retained'), { code: 'INVALID_CONTENT' }), 'app.action', 'handled', context);
const fixture = (t) => {
  const clock = diagnosticClock();
  const store = new DiagnosticCapture(clock.options);
  t.after(() => store.shutdown());
  return { clock, store };
};

test('diagnostics: starts off, collects no history, duplicate ON never renews, manual OFF retains the report', (t) => {
  const { clock, store } = fixture(t);
  store.recordRequest('api.registry', 500, 'INTERNAL_ERROR', 'Error', randomUUID());
  assert.equal(store.ingest(randomUUID(), [record()], 0).accepted, false);
  assert.equal(store.report().kind, 'empty');
  assert.equal(store.report().counts.received, 0);
  const first = store.setEnabled(true, null);
  assert.equal(Date.parse(first.capture.deadlineAt) - Date.parse(first.capture.startedAt), 1800000);
  assert.equal(clock.timers.size, 1);
  store.ingest(first.capture.id, [record()], 0);
  clock.advance(29999);
  const duplicate = store.setEnabled(true, null);
  assert.equal(duplicate.capture.id, first.capture.id);
  assert.equal(duplicate.capture.deadlineAt, first.capture.deadlineAt);
  assert.equal(duplicate.capture.remainingMs, 1770001, '29,999 ms is not 30 minutes');
  const stopped = store.setEnabled(false, first.capture.id);
  assert.equal(stopped.capture.stopReason, 'manual');
  assert.equal(stopped.capture.stoppedAt, '2026-09-09T12:00:29.999Z');
  assert.equal(clock.timers.size, 0);
  assert.equal(store.ingest(first.capture.id, [record()], 0).accepted, false);
  store.recordRequest('api.registry', 500, 'INTERNAL_ERROR', 'Error', randomUUID());
  assert.equal(store.report().kind, 'final');
  assert.equal(store.report().events.length, 1);
  assert.equal(store.report().counts.received, 1);
});

test('diagnostics: the exact 29:59.999 / 30:00 boundary is enforced without a timer callback', (t) => {
  const { clock, store } = fixture(t);
  const { capture } = store.setEnabled(true, null);
  clock.advance(1799999);
  assert.equal(store.status().capture.remainingMs, 1);
  assert(store.ingest(capture.id, [record()], 0).accepted);
  clock.advance(1);
  assert.equal(store.ingest(capture.id, [record()], 0).accepted, false);
  const report = store.report();
  assert.equal(report.capture.active, false);
  assert.equal(report.capture.stopReason, 'expired');
  assert.equal(report.capture.stoppedAt, capture.deadlineAt);
  assert.equal(report.events[0].firstAt, '2026-09-09T12:29:59.999Z');
  assert.equal(report.counts.received, 1);
});

test('diagnostics: status, report/download, ingestion and request records each enforce delayed expiry', async (t) => {
  for (const action of ['status', 'report', 'ingest', 'recordRequest']) await t.test(action, () => {
    const clock = diagnosticClock();
    const store = new DiagnosticCapture(clock.options);
    const { capture } = store.setEnabled(true, null);
    clock.advance(L.durationMs + 60000);
    if (action === 'ingest') assert.equal(store.ingest(capture.id, [record()], 0).accepted, false);
    else if (action === 'recordRequest') store.recordRequest('api.other', 500, 'INTERNAL_ERROR', 'Error', randomUUID());
    else store[action]();
    const report = store.report();
    assert.equal(report.capture.stopReason, 'expired');
    assert.equal(report.capture.stoppedAt, capture.deadlineAt);
    assert.equal(report.capture.stopObservedAt, '2026-09-09T12:31:00.000Z');
    assert.equal(report.counts.received, 0);
    assert.equal(clock.timers.size, 0);
    store.shutdown();
  });
});

test('diagnostics: server timer, sleep and clock rollback cannot renew a fixed interval', async (t) => {
  const { clock, store } = fixture(t);
  const first = store.setEnabled(true, null);
  clock.advance(60000);
  clock.wallBy(-3600000);
  assert.equal(store.status().capture.remainingMs, L.durationMs - 60000);
  clock.monoBy(L.durationMs - 60000);
  await clock.runDue();
  assert.equal(store.status().capture.stopReason, 'expired');
  assert.equal(store.status().capture.stoppedAt, first.capture.deadlineAt);
  const second = store.setEnabled(true, first.capture.id);
  clock.wallBy(L.durationMs);
  assert.equal(store.report().capture.stopReason, 'expired', 'wall time catches a sleeping monotonic clock');
  assert.equal(store.report().capture.stoppedAt, second.capture.deadlineAt);
});

test('diagnostics: stale tab commands cannot clear/replace/stop a newer report and restart is OFF', (t) => {
  const { clock, store } = fixture(t);
  const a = store.setEnabled(true, null);
  assert.throws(() => store.clear(a.capture.id), { code: 'DIAGNOSTICS_ACTIVE' });
  store.setEnabled(false, a.capture.id);
  const b = store.setEnabled(true, a.capture.id);
  assert.notEqual(a.capture.id, b.capture.id);
  assert.equal(store.report().events.length, 0);
  assert.throws(() => store.setEnabled(false, a.capture.id), { code: 'DIAGNOSTICS_CHANGED' });
  clock.advance(L.durationMs);
  assert.throws(() => store.setEnabled(true, a.capture.id), { code: 'DIAGNOSTICS_CHANGED' });
  assert.throws(() => store.clear(a.capture.id), { code: 'DIAGNOSTICS_CHANGED' });
  store.clear(b.capture.id);
  assert.equal(store.report().capture, null);
  store.setEnabled(true, null);
  store.shutdown();
  const restarted = new DiagnosticCapture(clock.options);
  assert.equal(restarted.report().kind, 'empty');
  assert.equal(restarted.status().capture, null);
  assert.equal(clock.timers.size, 0);
  restarted.shutdown();
});

test('diagnostics: repeated browser records, count capacity, bytes and event rate are bounded and disclosed', async (t) => {
  await t.test('deduplicated', () => {
    const { store, clock } = fixture(t);
    const { capture } = store.setEnabled(true, null);
    store.ingest(capture.id, [record()], 0);
    clock.advance(1000);
    store.ingest(capture.id, [record(), record()], 7);
    const report = store.report();
    assert.equal(report.counts.received, 3);
    assert.equal(report.counts.stored, 1);
    assert.equal(report.counts.deduplicated, 2);
    assert.equal(report.counts.clientQueueOmitted, 7);
    assert.equal(report.events[0].occurrences, 3);
    assert.equal(report.events[0].lastAt, '2026-09-09T12:00:01.000Z');
    assert.equal(report.counts.eventBytes, Buffer.byteLength(JSON.stringify(report.events)));
  });
  await t.test('count capacity', () => {
    const { store } = fixture(t);
    const { capture } = store.setEnabled(true, null);
    for (let n = 0; n <= L.records; n++) {
      store.ingest(capture.id, [clientDiagnostic({ code: n < 400 ? 'UNKNOWN' : 'HTTP_ERROR', name: 'Error' },
        'app.action', n < 200 ? 'handled' : 'request', { status: 400 + n % 200 })], 0);
    }
    const report = store.report();
    assert.equal(report.counts.stored, L.records);
    assert.equal(report.counts.omittedByCapacity, 1);
    assert.equal(report.counts.received, L.records + 1);
  });
  await t.test('byte capacity', () => {
    const { store } = fixture(t);
    const { capture } = store.setEnabled(true, null);
    for (let n = 1; n <= L.records + 1; n++) {
      store.ingest(capture.id, [clientDiagnostic({ code: 'DURABLE_BACKUP_VERIFICATION_FAILED', name: 'TransactionInactiveError' },
        'api.github.repository-creations', 'unhandled-rejection',
        { module: '/js/migration-github-connection.mjs', line: n, column: 10000, status: 599 })], 0);
    }
    const report = store.report();
    assert(report.counts.stored < L.records);
    assert(report.counts.eventBytes <= L.eventBytes);
    assert.equal(report.counts.eventBytes, Buffer.byteLength(JSON.stringify(report.events)));
    assert.equal(report.counts.omittedByCapacity, report.counts.received - report.counts.stored);
  });
  await t.test('event rate', () => {
    const { store, clock } = fixture(t);
    const { capture } = store.setEnabled(true, null);
    for (let n = 0; n <= L.eventsPerMinute; n++) store.ingest(capture.id, [record()], 0);
    assert.equal(store.report().counts.omittedByRate, 1);
    assert.equal(store.report().events[0].occurrences, L.eventsPerMinute);
    clock.advance(60000);
    store.ingest(capture.id, [record()], 0);
    assert.equal(store.report().events[0].occurrences, L.eventsPerMinute + 1);
  });
});

test('diagnostics: read, control, ingestion and download rates have independent fixed windows', (t) => {
  const { store, clock } = fixture(t);
  for (const [kind, max] of Object.entries({
    read: L.readRequestsPerMinute, control: L.controlRequestsPerMinute,
    ingest: L.ingestRequestsPerMinute, download: L.downloadRequestsPerMinute,
  })) {
    for (let n = 0; n < max; n++) store.limitRequest(kind);
    assert.throws(() => store.limitRequest(kind), { code: 'DIAGNOSTICS_RATE_LIMITED' });
  }
  clock.monoBy(60000);
  for (const kind of ['read', 'control', 'ingest', 'download']) assert.doesNotThrow(() => store.limitRequest(kind));
});

test('diagnostics: allowlisting precedes storage; arbitrary errors, paths, names, codes and extra fields cannot escape', (t) => {
  const secret = 'FAKE_DIAGNOSTIC_SECRET_47AZ';
  const origin = 'http://127.0.0.1:45281';
  const poisoned = Object.assign(new Error(secret), { name: secret, code: secret, stack: secret, filename: secret, body: secret });
  const safe = clientDiagnostic(poisoned, secret, 'handled', { module: secret, line: secret, column: secret });
  assert(!JSON.stringify(safe).includes(secret));
  assert.equal(safe.code, 'UNKNOWN');
  assert.equal(safe.exception, 'UnknownError');
  assert.equal(safe.module, null);
  const opaque = new Proxy({}, { get() { throw new Error(secret); } });
  assert.doesNotThrow(() => clientDiagnostic(opaque));
  for (const filename of [
    `file:///C:/private/${secret}.mjs`, `${origin}/js/${secret}.mjs`,
    `${origin}/js/app.mjs?token=${secret}`, `${origin}/js/app.mjs#${secret}`,
    `https://${secret}.example/js/app.mjs`, `${origin}/js/%61pp.mjs`, `${origin}/js/../js/app.mjs`,
  ]) assert.deepEqual(diagnosticLocation(filename, origin, 1, 1), {});
  assert.deepEqual(diagnosticLocation(`${origin}/js/app.mjs`, origin, 42, 7), { module: '/js/app.mjs', line: 42, column: 7 });
  assert.deepEqual(diagnosticLocation(`${origin}/js/app.mjs`, origin, Infinity, 10001), { module: '/js/app.mjs', line: null, column: null });
  assert.equal(diagnosticRoute(`/api/github/workspaces/${secret}/read?path=${secret}`), 'api.github.workspaces');
  assert.equal(diagnosticRoute(`/api/${secret}`), 'api.other');
  assert.equal(diagnosticResource(`/api/github/workspaces/${secret}/blob?alias=${secret}#${secret}`),
    '/api/github/workspaces/:environmentId/blob');
  assert.equal(diagnosticResource(`/js/${secret}.mjs`), null);
  assert.equal(diagnosticResource(`https://${secret}.invalid/js/app.mjs`), null);
  assert.equal(diagnosticResource(`/js/app.mjs?key=${secret}`), '/js/app.mjs');
  for (const key of ['message', 'stack', 'headers', 'body', 'timestamp', 'correlationId', 'source', 'path', '__proto__']) {
    assert.equal(validClientDiagnostic({ ...safe, [key]: secret }), false);
  }
  assert.equal(validClientDiagnostic({ ...safe, operation: { toString: secret } }), false);
  assert.equal(validClientDiagnostic({ ...safe, code: secret }), false);
  assert.equal(validClientDiagnostic({ ...safe, method: secret }), false);
  assert.equal(validClientDiagnostic({ ...safe, resource: secret }), false);
  assert.equal(clientDiagnostic(poisoned, 'app.action', 'handled', { method: secret, resource: secret }).resource, null);
  const { store } = fixture(t);
  const { capture } = store.setEnabled(true, null);
  store.ingest(capture.id, [safe], 0);
  const snapshot = store.report();
  assert.equal(snapshot.kind, 'snapshot');
  assert.match(diagnosticFilename(snapshot), /^citadel-debug-20260909T120000000Z-[a-f0-9]{8}\.json$/);
  snapshot.events[0].code = secret;
  snapshot.capture.id = secret;
  assert(!JSON.stringify(store.report()).includes(secret), 'public snapshots cannot mutate retained state');
  assert.throws(() => copyDiagnosticReport(snapshot), /Invalid diagnostic/);
  assert.throws(() => copyDiagnosticReport({ ...store.report(), raw: secret }), /Invalid diagnostic/);
  const report = store.report();
  report.events[0].headers = { authorization: secret };
  assert.throws(() => copyDiagnosticReport(report), /Invalid diagnostic/);
  const wrongBytes = store.report();
  wrongBytes.counts.eventBytes--;
  assert.throws(() => copyDiagnosticReport(wrongBytes), /Invalid diagnostic byte count/);
});

test('diagnostics: explanations recognize optional probes but never dismiss an unknown 404', () => {
  const base = { ...record(), source: 'server', operation: 'asset', status: 404, method: 'GET', resource: null };
  const unknown = diagnosticGuidance(base);
  assert.equal(unknown.level, 'error');
  assert.match(unknown.meaning, /cause is not established/);
  const bundled = diagnosticGuidance({ ...base, resource: '/js/app.mjs' });
  assert.equal(bundled.level, 'error');
  assert.match(bundled.summary, /known application/);
  const probe = diagnosticGuidance({ ...base, resource: '/.well-known/appspecific/com.chrome.devtools.json' });
  assert.equal(probe.level, 'info');
  assert.match(probe.summary, /Chrome DevTools/);
  assert.equal(diagnosticGuidance({ ...base, resource: '/favicon.ico' }).level, 'info');
  assert.equal(diagnosticGuidance({ ...base, method: 'POST', resource: '/favicon.ico' }).level, 'error');
  assert.equal(diagnosticGuidance({ ...base, status: 500, resource: '/favicon.ico' }).level, 'error');
  const save = diagnosticGuidance({ ...base, operation: 'api.github.workspaces', status: 503, code: 'INDETERMINATE_SAVE' });
  assert.match(save.next, /before retrying/);
  assert(!JSON.stringify(save).includes('not retained'));
});
