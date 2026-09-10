import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticCapture } from '../server/diagnostics.mjs';
import { clientDiagnostic, copyDiagnosticReport } from '../shared/diagnostics.mjs';
import { mountDebugPage, downloadDebugReport } from '../web/js/debug-page.mjs';
import { installDom, readText } from './_dom-stub.mjs';
import { diagnosticClock } from './_diagnostics-fixture.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const button = (root, label) => root.querySelectorAll('button').find((node) => readText(node) === label);

function pageFixture(t, options = {}) {
  const dom = installDom();
  const clock = diagnosticClock();
  const store = new DiagnosticCapture(clock.options);
  const listeners = new Set();
  let failure = false;
  const calls = [];
  const client = {
    get state() { return store.status(); },
    get report() { return store.report(); },
    connected: true, issues: [],
    remainingMs: () => store.status().capture?.remainingMs || 0,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async refresh() { listeners.forEach((fn) => fn()); },
    async setEnabled(enabled, id) {
      calls.push(['capture', enabled, id]);
      if (failure) throw new Error('FAKE_UI_FAILURE_SECRET');
      store.setEnabled(enabled, id);
      listeners.forEach((fn) => fn());
    },
    async clear(id) {
      calls.push(['clear', id]);
      store.clear(id);
      listeners.forEach((fn) => fn());
    },
    async download() {
      if (failure) throw new Error('FAKE_DOWNLOAD_SECRET');
      return store.report();
    },
  };
  const container = dom.node('main');
  dom.root.append(container);
  const confirmations = [];
  const downloads = [];
  const ui = mountDebugPage(container, {
    client, setTimer: clock.options.setTimer, clearTimer: clock.options.clearTimer,
    confirm: async (choice) => { confirmations.push(choice); return true; },
    download: async (report) => downloads.push(copyDiagnosticReport(report)), ...options,
  });
  t.after(() => { ui.dispose(); store.shutdown(); });
  return { ...dom, ui, store, clock, client, calls, confirmations, downloads, fail() { failure = true; } };
}

test('diagnostics: page starts off, has an accessible switch, safe readable errors, final download and guarded clear', async (t) => {
  const f = pageFixture(t);
  const toggle = f.ui.root.querySelector('input');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.getAttribute('aria-label'), 'Instance-wide debugging');
  assert.equal(toggle.checked, false);
  assert.equal(button(f.ui.root, 'Download debug report').disabled, true);
  assert.match(readText(f.ui.root), /No capture yet/);
  toggle.checked = true;
  toggle.dispatch('change');
  await settle();
  assert.equal(f.store.status().capture.active, true);
  assert.match(readText(f.ui.root), /30:00 remaining/);
  assert.match(readText(f.ui.root), /No errors recorded in this capture/);
  assert.equal(button(f.ui.root, 'Clear report').disabled, true);
  const secret = 'FAKE_UI_SOURCE_SECRET_385CQ';
  f.store.ingest(f.store.status().capture.id, [clientDiagnostic(Object.assign(new TypeError(secret), {
    code: 'INVALID_CONTENT', stack: secret, filename: secret,
  }), 'app.action', 'handled', { module: '/js/app.mjs', line: 41, column: 2 })], 0);
  await f.client.refresh();
  assert.match(readText(f.ui.root), /INVALID_CONTENT/);
  assert.match(readText(f.ui.root), /request did not match the expected input/);
  assert.match(readText(f.ui.root), /Suggested next step/);
  assert.match(readText(f.ui.root), /\/js\/app.mjs:41:2/);
  assert(!readText(f.ui.root).includes(secret));
  assert.equal(f.ui.root.querySelectorAll('tr').length, 2);
  toggle.checked = false;
  toggle.dispatch('change');
  await settle();
  assert.match(readText(f.ui.root), /manual stop/);
  button(f.ui.root, 'Download debug report').click();
  await settle();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].kind, 'final');
  assert.match(readText(f.ui.root), /Report download requested/);
  button(f.ui.root, 'Clear report').click();
  await settle();
  assert.equal(f.confirmations[0].title, 'Clear the captured report?');
  assert.equal(f.store.status().capture, null);
  assert.equal(f.ui.root.querySelectorAll('tr').length, 1);
});

test('diagnostics: replacing a report requires consent, countdown converges on expiry and failed controls stay honest', async (t) => {
  const f = pageFixture(t);
  const initial = f.store.setEnabled(true, null);
  f.store.setEnabled(false, initial.capture.id);
  f.ui.render();
  const toggle = f.ui.root.querySelector('input');
  toggle.checked = true;
  toggle.dispatch('change');
  await settle();
  assert.equal(f.confirmations[0].title, 'Replace the previous debug report?');
  assert.deepEqual(f.calls[0], ['capture', true, initial.capture.id]);
  f.clock.advance(1800000);
  f.ui.render();
  assert.equal(toggle.checked, false);
  assert.match(readText(f.ui.root), /Off - stopped automatically/);
  assert.match(readText(f.ui.root), /Final report/);
  f.fail();
  toggle.checked = true;
  toggle.dispatch('change');
  await settle();
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.match(readText(f.ui.root), /Capture could not be changed/);
  button(f.ui.root, 'Download debug report').click();
  await settle();
  assert.match(readText(f.ui.root), /could not be downloaded/);
  assert(!readText(f.ui.root).includes('FAKE_'));
  f.client.issues = ['delivery-failed'];
  f.ui.render();
  assert.match(readText(f.ui.root), /Some browser diagnostics could not be delivered/);
});

test('diagnostics: actual failures precede optional browser probes, with static actionable context', async (t) => {
  const f = pageFixture(t);
  const { capture } = f.store.setEnabled(true, null);
  f.store.ingest(capture.id, [clientDiagnostic({ code: 'EIO', name: 'Error' }, 'api.registry', 'request',
    { status: 500, method: 'GET', resource: '/api/registry' })], 0);
  f.clock.advance(1000);
  f.store.ingest(capture.id, [clientDiagnostic({}, 'asset', 'request',
    { status: 404, method: 'GET', resource: '/favicon.ico' })], 0);
  await f.client.refresh();
  const rows = f.ui.root.querySelectorAll('tr');
  assert.match(readText(rows[1]), /server storage operation failed/);
  assert.match(readText(rows[1]), /GET \/api\/registry/);
  assert.match(readText(rows[1]), /Suggested next step/);
  assert.match(readText(rows[2]), /Informational \/ optional browser request/);
  Object.defineProperty(f.client, 'state', { get() {
    return { ...f.store.status(), counts: { ...f.store.status().counts, eventBytes: 'FAKE_STATE_SECRET' } };
  } });
  f.ui.render();
  assert.match(readText(f.ui.root), /report could not be displayed/);
  assert(!readText(f.ui.root).includes('FAKE_STATE_SECRET'));
});

test('diagnostics: cancelled replacement/clear keeps report; invalid display data produces only a safe failure', async (t) => {
  const f = pageFixture(t, { confirm: async () => false });
  const original = f.store.setEnabled(true, null);
  f.store.setEnabled(false, original.capture.id);
  f.ui.render();
  const toggle = f.ui.root.querySelector('input');
  toggle.checked = true;
  toggle.dispatch('change');
  await settle();
  button(f.ui.root, 'Clear report').click();
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.status().capture.id, original.capture.id);
  Object.defineProperty(f.client, 'report', { get() { return { ...f.store.report(), raw: 'FAKE_RENDER_SECRET' }; } });
  f.ui.render();
  assert.match(readText(f.ui.root), /report could not be displayed/);
  assert(!readText(f.ui.root).includes('FAKE_RENDER_SECRET'));
  assert.equal(button(f.ui.root, 'Download debug report').disabled, true);
});

test('diagnostics: downloaded Blob is validated UTF-8 JSON and serialization/click failures are not success', async (t) => {
  const dom = installDom();
  const clock = diagnosticClock();
  const store = new DiagnosticCapture(clock.options);
  const created = store.setEnabled(true, null);
  store.ingest(created.capture.id, [clientDiagnostic(new Error('FAKE_BLOB_SECRET'))], 0);
  store.setEnabled(false, created.capture.id);
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const previousTimeout = globalThis.setTimeout;
  let blob;
  const revoked = [];
  URL.createObjectURL = (value) => { blob = value; return 'blob:synthetic-debug-report'; };
  URL.revokeObjectURL = (url) => revoked.push(url);
  globalThis.setTimeout = () => 0;
  t.after(() => {
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    globalThis.setTimeout = previousTimeout;
    store.shutdown();
  });
  await downloadDebugReport(store.report());
  const text = await blob.text();
  assert.equal(JSON.parse(text).kind, 'final');
  assert(!text.includes('FAKE_BLOB_SECRET'));
  assert.equal(blob.type, 'application/json; charset=utf-8');
  assert.equal(dom.root.querySelectorAll('a').length, 0);
  const invalid = store.report();
  invalid.events[0].message = 'FAKE_DOWNLOAD_SECRET';
  await assert.rejects(downloadDebugReport(invalid), /Invalid diagnostic/);
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'a') node.click = () => { throw new Error('FAKE_CLICK_SECRET'); };
    return node;
  };
  await assert.rejects(downloadDebugReport(store.report()), /FAKE_CLICK_SECRET/);
  assert.deepEqual(revoked, ['blob:synthetic-debug-report']);
  assert.equal(dom.root.querySelectorAll('a').length, 0);
});
