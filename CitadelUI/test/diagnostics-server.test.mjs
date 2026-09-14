import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { clientDiagnostic, DIAGNOSTICS_LIMITS as L } from '../shared/diagnostics.mjs';
import { diagnosticServer } from './_diagnostics-fixture.mjs';

const prefix = '/api/diagnostics';
const event = () => clientDiagnostic(Object.assign(new TypeError('never transport this'), { code: 'INVALID_CONTENT' }), 'app.action');
const batch = (id, events = [event()]) => ({ captureId: id, events, clientQueueOmitted: 0 });
const stateChange = (enabled, expectedCaptureId = null) => ({ enabled, expectedCaptureId });

test('diagnostics: the shell entry reaches the public owner bootstrap and shares existing CSS/CSP', async (t) => {
  const f = await diagnosticServer(t);
  const page = await f.call('/debug', { authenticated: false });
  assert.equal(page.status, 200);
  assert.match(page.text, /name="citadel-auth" content="unclaimed"/);
  assert(!page.text.includes(f.sessionToken));
  assert(!page.text.includes('correlationId'));
  assert.match(page.text, /class="titleblock"/);
  assert.match(page.text, /href="\/css\/app.css"/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert(!page.headers['content-security-policy'].includes('unsafe-inline'));
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  const normal = await f.call('/');
  assert.equal(normal.status, 200);
  const header = normal.text.match(/<header\b[^>]*>[\s\S]*?<\/header>/)?.[0];
  assert.ok(header, 'the public application bootstrap includes its header');
  const entries = [...header.matchAll(/<a\b[^>]*\bhref=(["'])(\/debug(?:\.html)?)\1[^>]*>[\s\S]*?<\/a>/g)];
  assert.equal(entries.length, 1, 'the header has one supported Diagnostics entry');
  const entry = entries[0][0];
  assert.match(entry, />\s*Diagnostics\s*<\/a>$/);
  assert.match(entry, /\baria-label=(["'])Diagnostics \(opens in a new tab\)\1/);
  assert.match(entry, /\btarget=(["'])_blank\1/);
  const rel = entry.match(/\brel=(["'])([^"']*)\1/)?.[2].split(/\s+/) || [];
  assert.ok(rel.includes('noopener'));
  assert.ok(rel.includes('noreferrer'));
  const destination = new URL(entries[0][2], f.origin);
  assert.equal(destination.origin, f.origin);
  const linkedPage = await f.call(destination.pathname, { authenticated: false });
  assert.equal(linkedPage.status, 200);
  assert.equal(linkedPage.text, page.text, 'the entry exposes the same public owner bootstrap, not diagnostic data');
  assert.equal(linkedPage.headers['content-security-policy'], page.headers['content-security-policy']);
  assert.equal(linkedPage.headers['cache-control'], 'no-store');
  assert.equal(linkedPage.headers['access-control-allow-origin'], undefined);
  for (const asset of ['/js/debug.mjs', '/js/debug-page.mjs', '/js/diagnostics-client.mjs', '/shared/diagnostics.mjs', '/css/debug.css']) {
    assert.equal((await f.call(asset, { authenticated: false })).status, 200);
  }
  assert.equal((await f.call('/healthz', { authenticated: false })).status, 200);
  assert.equal(f.diagnostics.status().capture, null, 'neither bootstrap nor assets enable capture');
  const token = await f.claim();
  assert.match((await f.call('/debug')).text, /name="citadel-auth" content="claimed"/);
  const claimed = await f.call(destination.pathname, { authenticated: false });
  assert.equal(claimed.status, 200);
  assert.match(claimed.text, /name="citadel-auth" content="claimed"/);
  assert(!claimed.text.includes(token));
  assert(!claimed.text.includes('correlationId'));
  assert.equal(f.diagnostics.status().capture, null);
});

test('diagnostics: every report/control/ingest route requires owner and browser transport; methods stay narrow', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  const routes = [
    ['status', 'GET'], ['report', 'GET'], ['download', 'GET'],
    ['capture', 'POST', stateChange(true)], ['clear', 'POST', { expectedCaptureId: null }],
    ['events', 'POST', batch(randomUUID())],
  ];
  for (const [action, method, payload] of routes) {
    const path = `${prefix}/${action}`;
    assert.equal((await f.call(path, { method, payload, authenticated: false })).status, 401);
    assert.equal((await f.call(path, { method, payload, headers: { Host: 'wrong.invalid' } })).status, 421);
    assert.equal((await f.call(path, { method, payload, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.call(path, { method, payload, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
    const denied = await f.call(path, { method: method === 'GET' ? 'POST' : 'GET', payload: method === 'GET' ? {} : undefined });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.allow, method);
  }
  assert.equal(f.diagnostics.status().capture, null);
  for (const method of ['HEAD', 'OPTIONS', 'PATCH', 'DELETE', 'PUT']) {
    assert.equal((await f.call(`${prefix}/report`, { method, payload: method === 'HEAD' ? undefined : {} })).status, 405);
  }
  assert.equal((await f.call(`${prefix}/capture?enabled=true`)).status, 400);
  assert.equal((await f.call(`${prefix}/clock`, { method: 'POST', payload: { ttl: 1 } })).status, 400);
  assert.equal(f.diagnostics.status().capture, null);
});

test('diagnostics: real API errors, concurrent tabs, snapshots, final download and clean replacement', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  await f.call('/api/content/bicepparam/parse', { method: 'POST', payload: {} });
  const [a, b] = await Promise.all([f.enable(), f.enable()]);
  assert.equal(a.capture.id, b.capture.id);
  assert.equal(f.diagnostics.report().counts.received, 0, 'no historical server failure');
  const failure = await f.call('/api/content/bicepparam/parse', { method: 'POST', payload: { alias: 'synthetic', text: null } });
  assert.equal(failure.status, 400);
  assert.equal(failure.json().error.code, 'INVALID_CONTENT');
  const ingested = await f.call(`${prefix}/events`, { method: 'POST', payload: batch(a.capture.id) });
  assert.equal(ingested.status, 200);
  assert.equal(ingested.json().accepted, true);
  const snapshot = await f.call(`${prefix}/download`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers['content-type'], 'application/json; charset=utf-8');
  assert.match(snapshot.headers['content-disposition'], /^attachment; filename="citadel-debug-[a-zA-Z0-9-]+\.json"$/);
  assert.equal(snapshot.headers['cache-control'], 'no-store');
  const parsed = JSON.parse(Buffer.from(snapshot.text, 'utf8').toString('utf8'));
  assert.equal(parsed.kind, 'snapshot');
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].source, 'server');
  assert.equal(parsed.events[0].correlationId, failure.json().error.correlationId);
  assert.equal(parsed.events[0].operation, 'api.bicep.parse');
  assert.equal(parsed.events[0].resource, '/api/content/bicepparam/parse');
  assert.equal(parsed.events[0].method, 'POST');
  assert.equal(parsed.events[1].source, 'client');
  const stopped = await f.call(`${prefix}/capture`, { method: 'POST', payload: stateChange(false, a.capture.id) });
  assert.equal(stopped.json().capture.stopReason, 'manual');
  assert.equal((await f.call(`${prefix}/download`)).json().kind, 'final');
  const late = await f.call(`${prefix}/events`, { method: 'POST', payload: batch(a.capture.id) });
  assert.equal(late.json().accepted, false);
  const next = await f.enable(a.capture.id);
  assert.notEqual(next.capture.id, a.capture.id);
  assert.equal(next.counts.stored, 0);
  const staleStop = await f.call(`${prefix}/capture`, { method: 'POST', payload: stateChange(false, a.capture.id) });
  assert.equal(staleStop.status, 409);
  assert.equal(f.diagnostics.status().capture.id, next.capture.id);
  assert.equal(f.diagnostics.status().capture.active, true);
});

test('diagnostics: host failures are safe and busy support/health requests cannot become captured storms', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  await f.enable();
  const denied = await f.call('/api/registry', { headers: { Host: 'FAKE_PRIVATE_HOST.invalid' } });
  assert.equal(denied.status, 421);
  assert.equal(f.diagnostics.report().events[0].code, 'INVALID_HOST');
  assert(!JSON.stringify(f.diagnostics.report()).includes('FAKE_PRIVATE_HOST'));

  const busy = await diagnosticServer(t, { maxConcurrency: 0 });
  busy.diagnostics.setEnabled(true, null);
  for (const path of ['/healthz', '/debug', '/api/diagnostics/report', '/js/diagnostics-client.mjs', '/css/debug.css']) {
    assert.equal((await busy.call(path)).status, 503);
  }
  assert.equal(busy.diagnostics.report().counts.received, 0);
  assert.equal((await busy.call('/api/registry')).status, 503);
  assert.equal(busy.diagnostics.report().events[0].code, 'SERVER_BUSY');
  assert.equal(busy.diagnostics.report().counts.received, 1);
});

test('diagnostics: expiry survives a late HTTP batch and download without the scheduled callback', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  const { capture } = await f.enable();
  f.clock.advance(1799999);
  assert.equal((await f.call(`${prefix}/status`)).json().capture.remainingMs, 1);
  f.clock.advance(1);
  const late = await f.call(`${prefix}/events`, { method: 'POST', payload: batch(capture.id) });
  assert.equal(late.json().accepted, false);
  const report = (await f.call(`${prefix}/download`)).json();
  assert.equal(report.kind, 'final');
  assert.equal(report.capture.stoppedAt, capture.deadlineAt);
  assert.equal(report.counts.received, 0);
  assert.equal(report.events.length, 0);
});

test('diagnostics: malicious ingress, body/depth/count/rate limits and rejected batches never recurse', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  const { capture } = await f.enable();
  const secret = 'FAKE_INGRESS_SECRET_629RK';
  const invalids = [
    { ...batch(capture.id), token: secret },
    { ...batch(capture.id), events: [{ ...event(), message: secret, headers: { authorization: secret } }] },
    { ...batch(capture.id), events: [{ ...event(), code: secret }] },
    { ...batch(capture.id), events: [{ ...event(), exception: secret }] },
    { ...batch(capture.id), events: [{ ...event(), module: `C:\\${secret}\\app.mjs` }] },
    { ...batch(capture.id), events: [{ ...event(), status: 200 }] },
    { ...batch(capture.id), events: [{ ...event(), line: 1 }] },
    { ...batch(capture.id), events: [JSON.parse(`{"message":${'['.repeat(40)}"${secret}"${']'.repeat(40)}}`)] },
    { ...batch(capture.id), events: Array(L.batchEvents + 1).fill(event()) },
    { ...batch(capture.id), clientQueueOmitted: 1001 },
  ];
  for (const payload of invalids) {
    const response = await f.call(`${prefix}/events`, { method: 'POST', payload });
    assert.equal(response.status, 400);
    assert(!response.text.includes(secret));
  }
  const tooBig = await f.call(`${prefix}/events`, { method: 'POST', bytes: JSON.stringify({ value: secret.repeat(L.bodyBytes) }) });
  assert.equal(tooBig.status, 413);
  assert.equal((await f.call(`${prefix}/events`, { method: 'POST', bytes: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.call(`${prefix}/events`, { method: 'POST', payload: batch(capture.id), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const report = f.diagnostics.report();
  assert.equal(report.events.length, 0);
  assert.equal(report.counts.received, 0);
  assert.equal(report.counts.rejectedBatches, invalids.length + 3);
  assert(!JSON.stringify(report).includes(secret));
  for (let n = 0; n < L.controlRequestsPerMinute - 1; n++) {
    assert.equal((await f.call(`${prefix}/capture`, { method: 'POST', payload: stateChange(true, capture.id) })).status, 200);
  }
  const limited = await f.call(`${prefix}/capture`, { method: 'POST', payload: stateChange(true, capture.id) });
  assert.equal(limited.status, 429);
  assert.equal(f.diagnostics.report().events.length, 0);
  f.clock.advance(60000);
  assert.equal((await f.call(`${prefix}/capture`, { method: 'POST', payload: stateChange(false, capture.id) })).status, 200);
});

async function diskText(root) {
  let text = '';
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    text += entry.isDirectory() ? await diskText(path) : await readFile(path, 'utf8');
  }
  return text;
}

test('diagnostics: fake secrets in server errors, URLs, headers, bodies and correlations never reach reports, logs or disk', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  const secret = 'FAKE_SERVER_SECRET_725NB';
  const beforeDisk = await diskText(f.root);
  await f.enable();
  const logs = [];
  const priorLog = console.error;
  console.error = (line) => logs.push(line);
  t.after(() => { console.error = priorLog; });
  const priorRead = f.registryStore.read;
  f.registryStore.read = async () => {
    throw Object.assign(new Error(`${secret} C:\\private\\${secret}`), {
      name: secret, code: secret, stack: `${secret}\nhttps://${secret}.invalid/?key=${secret}`,
      constructor: { name: secret },
    });
  };
  const failure = await f.call(`/api/registry?source=${secret}`, {
    headers: { 'X-Correlation-ID': secret, Authorization: secret, Cookie: `secret=${secret}` },
  });
  assert.equal(failure.status, 500);
  assert.equal(failure.json().error.message, 'Internal server error.');
  assert.equal(failure.json().error.correlationId, secret, 'normal response correlation contract is unchanged');
  f.registryStore.read = priorRead;
  await f.call(`/api/github/workspaces/${secret}/not-a-real-operation?alias=${secret}`);
  await f.call('/api/content/bicepparam/parse', { method: 'POST', payload: { alias: secret, text: { secret } } });
  const stored = JSON.stringify(f.diagnostics.report());
  const downloaded = (await f.call(`${prefix}/download`)).text;
  assert(!stored.includes(secret));
  assert(!downloaded.includes(secret));
  assert(!logs.join('\n').includes(secret));
  const first = f.diagnostics.report().events[0];
  assert.equal(first.code, 'UNKNOWN');
  assert.equal(first.exception, 'UnknownError');
  assert.match(first.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(logs[0]).correlationId, first.correlationId);
  assert.equal(await diskText(f.root), beforeDisk, 'capture never writes report or raw diagnostics under dataRoot');
});

test('diagnostics: report and serialization failures remain errors and never become capture events', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  await f.enable();
  const secret = 'FAKE_REPORT_FAILURE_834VX';
  const logs = [];
  const priorLog = console.error;
  console.error = (line) => logs.push(line);
  t.after(() => { console.error = priorLog; });
  const realReport = f.diagnostics.report.bind(f.diagnostics);
  f.diagnostics.report = () => { throw Object.assign(new Error(secret), { name: secret }); };
  for (const action of ['report', 'download']) {
    const response = await f.call(`${prefix}/${action}`);
    assert.equal(response.status, 500);
    assert(!response.text.includes(secret));
    assert.equal(response.headers['content-disposition'], undefined);
  }
  f.diagnostics.report = () => ({ ...realReport(), raw: { secret } });
  for (const action of ['report', 'download']) {
    const invalid = await f.call(`${prefix}/${action}`);
    assert.equal(invalid.status, 500);
    assert(!invalid.text.includes(secret));
  }
  f.diagnostics.report = realReport;
  assert.equal(f.diagnostics.report().events.length, 0);
  assert(!logs.join('\n').includes(secret));
  assert.equal((await f.call(`${prefix}/download`)).status, 200);
});

test('diagnostics: known assets and route templates add context without reflecting dynamic request names', async (t) => {
  const f = await diagnosticServer(t);
  await f.claim();
  await f.enable();
  const secret = 'FAKE_RESOURCE_NAME_SECRET_823VP';
  await f.call('/.well-known/appspecific/com.chrome.devtools.json');
  await f.call('/favicon.ico');
  await f.call(`/private-${secret}.css`);
  await f.call(`/api/github/workspaces/${secret}/blob?alias=${secret}`);
  const events = f.diagnostics.report().events;
  assert.equal(events.length, 4, 'unknown 404s are retained rather than discarded');
  assert.equal(events[0].resource, '/.well-known/appspecific/com.chrome.devtools.json');
  assert.equal(events[1].resource, '/favicon.ico');
  assert.equal(events[2].resource, null);
  assert.equal(events[2].status, 404);
  assert.equal(events[3].resource, '/api/github/workspaces/:environmentId/blob');
  assert(events.every((entry) => entry.method === 'GET'));
  assert(!JSON.stringify(events).includes(secret));
});
