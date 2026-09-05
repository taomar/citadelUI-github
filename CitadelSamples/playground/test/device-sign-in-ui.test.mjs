import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeviceSignIn, updateDeviceSignIn } from '../web/js/deviceSignIn.mjs';
import { saveHostedResume, discardHostedResume, consumeHostedResume } from '../web/js/hostedResume.mjs';
import { CATALOGUE } from '../src/catalogue/index.mjs';

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const flow = { flowId: 'owned-flow', purpose: 'signin', state: 'pending', expiresAt: Date.now() + 300000 };
test('reload keeps exact cancellation handle without restoring transient code', async () => {
  const calls = [];
  const controller = createDeviceSignIn({ intervalMs: 5, changed() {}, refresh: async () => {},
    post: async (action, payload) => {
      calls.push({ action, payload });
      return { ...flow, state: action === 'cancel' ? 'cancelled' : 'pending', settled: action === 'cancel',
        userCode: 'SYNTHETIC', verificationUri: 'https://microsoft.com/devicelogin' };
    } });
  controller.reconcile({ deviceFlow: flow });
  await wait();
  assert.equal(controller.snapshot().userCode, undefined);
  await controller.cancel();
  assert.equal(calls.find((call) => call.action === 'cancel').payload.flowId, flow.flowId);
  controller.dispose();
});

test('late status cannot resurrect a cancelled flow or start completion', async () => {
  let release;
  const controller = createDeviceSignIn({ intervalMs: 5, changed() {}, refresh: async () => {},
    post: (action) => action === 'status' ? new Promise((resolve) => { release = resolve; })
      : Promise.resolve({ ...flow, state: action === 'cancel' ? 'cancelled' : 'pending', settled: action === 'cancel' }) });
  await controller.start('signin');
  await wait();
  await controller.cancel();
  release({ ...flow, state: 'ready' });
  await wait();
  assert.equal(controller.snapshot().state, 'cancelled');
  controller.dispose();
});

test('completion requires an intentional action and uncertain response reconciles without replay', async () => {
  let completions = 0, refreshes = 0;
  const controller = createDeviceSignIn({ intervalMs: 5, changed() {}, refresh: async () => { refreshes++; },
    post: async (action) => {
      if (action === 'complete') { completions++; throw new Error('Lost response'); }
      return { ...flow, state: 'ready' };
    } });
  await controller.start('signin');
  await wait();
  assert.equal(completions, 0);
  await controller.complete();
  await controller.complete();
  assert.equal(completions, 1);
  assert.ok(refreshes >= 2);
  assert.equal(controller.snapshot().completionAttempted, true);
  controller.dispose();
});

test('failed start makes no status or completion calls', async () => {
  const calls = [];
  const controller = createDeviceSignIn({ intervalMs: 5, changed() {}, refresh: async () => {},
    post: async (action) => { calls.push(action); throw new Error('Unavailable'); } });
  await assert.rejects(controller.start('signin'), /Unavailable/);
  await wait();
  assert.deepEqual(calls, ['start']);
  controller.dispose();
});

test('expired status keeps polling until actual SDK settlement enables retry', async () => {
  let polls = 0, starts = 0;
  const controller = createDeviceSignIn({ intervalMs: 5, changed() {}, refresh: async () => {},
    post: async (action) => action === 'start' ? (starts++, { ...flow, settled: false }) :
      { ...flow, state: 'expired', settled: ++polls >= 2 } });
  await controller.start('signin');
  await wait(60);
  assert.equal(controller.snapshot().state, 'expired');
  assert.equal(controller.snapshot().settled, true);
  assert.equal(polls, 2);
  assert.equal(starts, 1);
  controller.dispose();
});

test('busy status and expiry ticks update existing nodes without focus calls', () => {
  let focusCalls = 0;
  const nodes = new Map();
  const panel = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', removeAttribute() {},
      focus() { focusCalls++; } });
    return nodes.get(selector);
  } };
  const root = { querySelector: () => panel };
  updateDeviceSignIn(root, { ...flow, state: 'expired', settled: false });
  assert.equal(nodes.get('#device-retry').disabled, true);
  updateDeviceSignIn(root, { ...flow, state: 'expired', settled: true });
  assert.equal(nodes.get('#device-retry').disabled, false);
  updateDeviceSignIn(root, { ...flow, state: 'expired', settled: true }, { busy: true });
  assert.equal(nodes.get('#device-retry').disabled, true);
  assert.equal(nodes.get('#device-complete').disabled, true);
  assert.equal(nodes.get('#device-cancel').disabled, true);
  updateDeviceSignIn(root, { ...flow, state: 'ready', settled: true }, { busy: true });
  assert.equal(nodes.get('#device-complete').disabled, true);
  updateDeviceSignIn(root, { ...flow, state: 'ready', settled: true }, { busy: false });
  assert.equal(nodes.get('#device-complete').disabled, false);
  assert.equal(nodes.get('#device-retry').disabled, true);
  assert.equal(focusCalls, 0);
});

test('cancel refresh and status callbacks cannot enable a dropped Retry activation', async () => {
  const nodes = new Map();
  const panel = { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { textContent: '', removeAttribute() {} });
    return nodes.get(selector);
  } };
  const root = { querySelector: () => panel };
  let busy = false, starts = 0, holdRefresh = false, releaseRefresh;
  const controller = createDeviceSignIn({ intervalMs: 1000,
    changed: (value) => updateDeviceSignIn(root, value, { busy }),
    refresh: async () => { if (holdRefresh) await new Promise((resolve) => { releaseRefresh = resolve; }); },
    post: async (action) => {
      if (action === 'start') starts++;
      return { ...flow, state: action === 'cancel' ? 'cancelled' : 'pending', settled: action === 'cancel' };
    } });
  await controller.start('signin');
  holdRefresh = true; busy = true;
  const cancellation = controller.cancel();
  await wait();
  updateDeviceSignIn(root, controller.snapshot(), { busy });
  assert.equal(nodes.get('#device-retry').disabled, true);
  assert.equal(starts, 1);
  releaseRefresh();
  await cancellation;
  holdRefresh = false; busy = false;
  updateDeviceSignIn(root, controller.snapshot(), { busy });
  assert.equal(nodes.get('#device-retry').disabled, false);
  if (!nodes.get('#device-retry').disabled) await controller.start('signin');
  assert.equal(starts, 2);
  controller.dispose();
});

test('local observation stops at its bounded deadline without admitting a new flow', async () => {
  let calls = 0;
  const controller = createDeviceSignIn({ intervalMs: 5, changed() {}, refresh: async () => {},
    post: async () => { calls++; } });
  controller.reconcile({ deviceFlow: { ...flow, state: 'expired', settled: false, deadlineAt: Date.now() - 80000 } });
  await wait();
  assert.equal(calls, 0);
  assert.match(controller.snapshot().message, /observation deadline/);
  controller.dispose();
});

test('device entry discards only the obsolete redirect draft and keeps browser restore semantics', async () => {
  const values = new Map([['unrelated-input', 'retained']]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key) };
  const sample = CATALOGUE.byId.get('azure-context-check');
  const inputs = { 'hub.subscriptionId': '00000000-1111-2222-3333-444444444444' };
  const save = () => saveHostedResume({ storage, sample, inputs });
  for (const terminal of ['ready', 'cancelled', 'expired']) {
    save(); // A previous browser preflight/start failure can leave this exact draft.
    discardHostedResume(storage);
    const controller = createDeviceSignIn({ intervalMs: 5, changed() {}, refresh: async () => {},
      post: async (action) => ({ ...flow, state: action === 'start' ? 'pending' : terminal, settled: true }) });
    await controller.start('signin');
    await wait();
    if (terminal === 'ready') await controller.complete();
    if (terminal === 'cancelled') await controller.cancel();
    assert.equal(consumeHostedResume({ storage, catalogue: CATALOGUE }), null);
    assert.equal(values.get('unrelated-input'), 'retained');
    controller.dispose();
  }
  save();
  assert.deepEqual(consumeHostedResume({ storage, catalogue: CATALOGUE }), { recipeId: sample.id, inputs });
  const main = await readFile(new URL('../web/js/main.mjs', import.meta.url), 'utf8');
  const deviceEntry = main.slice(main.indexOf('async function beginDeviceSignIn'), main.indexOf('async function hostedAction'));
  assert.match(deviceEntry, /hostedAction\(async \(\) => \{\s*discardHostedResume\(window.sessionStorage\)/);
  assert.doesNotMatch(deviceEntry, /saveSignInDraft|storage\.clear/);
  const browserEntry = main.slice(main.indexOf('async function beginHostedSignIn'), main.indexOf('async function signOutHosted'));
  assert.match(browserEntry, /saveSignInDraft\(\)/);
});
