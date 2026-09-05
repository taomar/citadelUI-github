import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeviceSignIn, updateDeviceSignIn } from '../web/js/deviceSignIn.mjs';

const pending = () => ({ flowId: 'owning-flow', purpose: 'signin', state: 'pending', settled: false,
  deadlineAt: Date.now() + 300000, expiresAt: Date.now() + 300000, retryAfterMs: 0 });
const timeout = () => Object.assign(new Error('Synthetic request timeout'), { name: 'TimeoutError' });
const missing = () => Object.assign(new Error('Synthetic flow missing'), { status: 404 });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function render(snapshot, busy = false) {
  const nodes = new Map();
  const panel = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', removeAttribute() {} });
    return nodes.get(selector);
  } };
  updateDeviceSignIn({ querySelector: () => panel }, snapshot, { busy });
  return { panel, nodes };
}

async function setup(t, { cancel = () => { throw timeout(); }, status = () => pending(),
  capabilities = () => ({ deviceFlow: pending() }) } = {}) {
  const calls = [];
  let refreshes = 0;
  const controller = createDeviceSignIn({
    changed() {},
    async refresh() {
      if (++refreshes > 1) controller.reconcile(await capabilities());
    },
    async post(action, payload) {
      calls.push(action);
      if (action === 'start') return pending();
      assert.equal(payload.flowId, 'owning-flow');
      if (action === 'cancel') return cancel();
      if (action === 'status') return status();
      assert.fail('Recovery must never automatically complete a sign-in.');
    },
  });
  t.after(() => controller.dispose());
  await controller.start('signin');
  return { controller, calls, refreshes: () => refreshes };
}

test('confirmed cancel remains a control: settled Retry, no unnecessary status read', async (t) => {
  const app = await setup(t, { cancel: () => ({ ...pending(), state: 'cancelled', settled: true }) });
  await app.controller.cancel();
  assert.equal(app.controller.snapshot().state, 'cancelled');
  assert.equal(render(app.controller.snapshot()).nodes.get('#device-retry').disabled, false);
  assert.deepEqual(app.calls, ['start', 'cancel']);
  assert.equal(app.refreshes(), 2);
});

test('cancel 404 with authoritative gone capability clears the panel, not a newer flow', async (t) => {
  const app = await setup(t, { cancel: () => { throw missing(); }, capabilities: () => ({ deviceFlow: null }) });
  await app.controller.cancel();
  assert.equal(app.controller.snapshot(), null);
  assert.equal(render(app.controller.snapshot()).panel.hidden, true);
  assert.deepEqual(app.calls, ['start', 'cancel']);
});

for (const [state, settled] of [['pending', false], ['ready', true], ['cancelling', false],
  ['expired', false], ['cancelled', true]]) {
  test(`cancel timeout reads same-handle ${state}/${settled} and preserves cancellation intent`, async (t) => {
    const app = await setup(t, { status: () => ({ ...pending(), state, settled,
      userCode: 'SYNTHETIC', verificationUri: 'https://microsoft.com/devicelogin' }) });
    await app.controller.cancel();
    const snapshot = app.controller.snapshot();
    assert.equal(snapshot.state, state);
    assert.equal(snapshot.settled, settled);
    assert.equal(snapshot.cancellationRequested, true);
    assert.equal(snapshot.userCode, undefined);
    assert.equal(snapshot.verificationUri, undefined);
    const ui = render(snapshot).nodes;
    assert.equal(ui.get('#device-complete').hidden, true);
    assert.equal(ui.get('#device-retry').disabled, state !== 'cancelled');
    await app.controller.complete();
    assert.deepEqual(app.calls, ['start', 'cancel', 'status']);
  });
}

for (const failure of ['capabilities', 'status']) {
  test(`failed ${failure} readback offers explicit read-only recovery without replay`, async (t) => {
    let fail = true;
    const app = await setup(t, {
      capabilities() { if (fail && failure === 'capabilities') throw timeout(); return { deviceFlow: pending() }; },
      status() { if (fail && failure === 'status') throw missing(); return { ...pending(), state: 'cancelled', settled: true }; },
    });
    await app.controller.cancel();
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = app.controller.snapshot();
      assert.equal(snapshot.state, 'cancelling');
      assert.equal(snapshot.settled, false);
      assert.equal(snapshot.statusUnavailable, true);
      const ui = render(snapshot).nodes;
      assert.equal(ui.get('#device-check-status').hidden, false);
      assert.equal(ui.get('#device-check-status').disabled, false);
      assert.equal(render(snapshot, true).nodes.get('#device-check-status').disabled, true);
      assert.equal(ui.get('#device-retry').disabled, true);
      assert.equal(ui.get('#device-complete').disabled, true);
      await app.controller.checkStatus();
    }
    fail = false;
    await app.controller.checkStatus();
    assert.equal(app.controller.snapshot().state, 'cancelled');
    assert.equal(app.controller.snapshot().settled, true);
    assert.equal(render(app.controller.snapshot()).nodes.get('#device-check-status').hidden, true);
    assert.equal(render(app.controller.snapshot()).nodes.get('#device-retry').disabled, false);
    assert.equal(app.calls.filter((action) => action === 'start').length, 1);
    assert.equal(app.calls.filter((action) => action === 'cancel').length, 1);
    assert.ok(app.calls.slice(2).every((action) => action === 'status'));
  });
}

test('a gone flow during explicit recovery clears the panel after a failed readback', async (t) => {
  let fail = true;
  const app = await setup(t, {
    capabilities() { if (fail) throw timeout(); return { deviceFlow: null }; },
  });
  await app.controller.cancel();
  fail = false;
  await app.controller.checkStatus();
  assert.equal(app.controller.snapshot(), null);
  assert.deepEqual(app.calls, ['start', 'cancel']);
});

for (const error of [missing, timeout]) {
  test(`old cancel ${error().name}/${error().status ?? 'no-status'} cannot clear a newer admission`, async (t) => {
    const cancellation = deferred();
    let starts = 0, refreshes = 0;
    const calls = [];
    const controller = createDeviceSignIn({ changed() {}, refresh: async () => { refreshes++; },
      post(action) {
        calls.push(action);
        if (action === 'start') return Promise.resolve({ ...pending(), flowId: `flow-${++starts}` });
        if (action === 'cancel') return cancellation.promise;
        assert.fail('Old cancel failure must not initiate recovery for the newer flow.');
      } });
    t.after(() => controller.dispose());
    await controller.start('signin');
    const cancelling = controller.cancel();
    await controller.start('signin');
    cancellation.reject(error());
    await cancelling;
    assert.equal(controller.snapshot().flowId, 'flow-2');
    assert.equal(controller.snapshot().state, 'pending');
    assert.equal(controller.snapshot().cancellationRequested, undefined);
    assert.equal(refreshes, 2);
    assert.deepEqual(calls, ['start', 'cancel', 'start']);
  });
}

for (const lateRead of ['capabilities', 'status']) {
  test(`late failed ${lateRead} recovery cannot mutate a newer owning flow`, async (t) => {
    const read = deferred(), entered = deferred();
    let starts = 0, refreshes = 0;
    const calls = [];
    const controller = createDeviceSignIn({ changed() {},
      async refresh() {
        if (++refreshes === 2 && lateRead === 'capabilities') { entered.resolve(); await read.promise; }
      },
      async post(action) {
        calls.push(action);
        if (action === 'start') return { ...pending(), flowId: `flow-${++starts}` };
        if (action === 'cancel') throw timeout();
        if (action === 'status') { entered.resolve(); return read.promise; }
        assert.fail('Unexpected sign-in mutation.');
      } });
    t.after(() => controller.dispose());
    await controller.start('signin');
    const cancelling = controller.cancel();
    await entered.promise;
    await controller.start('signin');
    read.reject(missing());
    await cancelling;
    assert.equal(controller.snapshot().flowId, 'flow-2');
    assert.equal(controller.snapshot().state, 'pending');
    assert.equal(controller.snapshot().statusUnavailable, undefined);
    assert.equal(calls.filter((action) => action === 'cancel').length, 1);
    assert.equal(calls.filter((action) => action === 'status').length, lateRead === 'status' ? 1 : 0);
  });
}

test('Check status is wired as its own read-only action, not the new-code Retry action', async () => {
  const main = await readFile(new URL('../web/js/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /onDeviceCheckStatus: \(\) => hostedAction\(\(\) => deviceSignIn\.checkStatus\(\)\)/);
  const shell = await readFile(new URL('../web/js/render/shell.mjs', import.meta.url), 'utf8');
  assert.match(shell, /action\('device-check-status', 'Check status', callbacks\.onDeviceCheckStatus\)/);
});
