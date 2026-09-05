import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createCapabilityFreshness, beginHostedCapabilityRead, isHostedCapabilityReadCurrent,
  setHostedCapabilities, hostedAuth, hostedDevicePost, hostedPost,
} from '../web/js/hostedClient.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const snapshot = (name) => ({ auth: { mode: 'bff', csrf: `${name}-csrf`, account: { objectId: name } } });

test('capability GET sequence rejects an older response in either completion order', async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const freshness = createCapabilityFreshness(), reads = [deferred(), deferred()];
    const tickets = reads.map(() => freshness.beginRead());
    let adopted;
    const tasks = reads.map((read, index) => read.promise.then(() => {
      if (freshness.isCurrent(tickets[index])) adopted = index;
    }));
    for (const index of order) { reads[index].resolve(); await tasks[index]; }
    assert.equal(adopted, 1);
  }
});

test('mutation start AND settlement invalidate snapshots independently of GET sequence', () => {
  const freshness = createCapabilityFreshness();
  const before = freshness.beginRead(), settle = freshness.beginMutation();
  assert.equal(freshness.isCurrent(before), false);
  const latestButDuringMutation = freshness.beginRead();
  assert.equal(freshness.isCurrent(latestButDuringMutation), false);
  settle();
  assert.equal(freshness.isCurrent(latestButDuringMutation), false);
  const current = freshness.beginRead();
  assert.equal(freshness.isCurrent(current), true);
  settle();
  assert.equal(freshness.isCurrent(current), true);
});

test('admitted device start protects new CSRF and account from deferred old capabilities', async () => {
  const originalFetch = globalThis.fetch, admission = deferred(), oldResponse = deferred();
  let requests = 0;
  try {
    setHostedCapabilities(snapshot('old'));
    const oldTicket = beginHostedCapabilityRead();
    const oldRead = oldResponse.promise.then((value) => setHostedCapabilities(value, oldTicket));
    globalThis.fetch = async () => { requests++; return admission.promise; };
    const starting = hostedDevicePost('start', { purpose: 'signin' });
    admission.resolve(new Response(JSON.stringify({ flowId: 'new-flow', csrf: 'new-csrf' }), { status: 202 }));
    await starting;
    assert.equal(hostedAuth().csrf, 'new-csrf');
    const newTicket = beginHostedCapabilityRead();
    assert.equal(setHostedCapabilities(snapshot('new'), newTicket), true);
    oldResponse.resolve(snapshot('old'));
    assert.equal(await oldRead, false);
    assert.equal(hostedAuth().csrf, 'new-csrf');
    assert.equal(hostedAuth().account.objectId, 'new');
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; setHostedCapabilities(null); }
});

test('latest GET captured during each auth mutation cannot overwrite settled state', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const path of ['/api/auth/device/start', '/api/auth/device/cancel', '/api/auth/device/complete',
      '/api/auth/start', '/api/auth/cancel', '/api/auth/logout']) {
      setHostedCapabilities(snapshot('current'));
      const response = deferred();
      globalThis.fetch = async () => response.promise;
      const mutation = hostedPost(path, {});
      const latestTicket = beginHostedCapabilityRead();
      response.resolve(new Response('{}'));
      await mutation;
      assert.equal(setHostedCapabilities(snapshot('stale'), latestTicket), false, path);
      assert.equal(hostedAuth().account.objectId, 'current');
      assert.equal(isHostedCapabilityReadCurrent(beginHostedCapabilityRead()), true);
    }
  } finally { globalThis.fetch = originalFetch; setHostedCapabilities(null); }
});

test('status observation is not a mutation and failed admission does not poison later reads', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}');
    const ticket = beginHostedCapabilityRead();
    await hostedDevicePost('status', { flowId: 'owned' });
    assert.equal(isHostedCapabilityReadCurrent(ticket), true);
    globalThis.fetch = async () => new Response('{"summary":"Synthetic refusal"}', { status: 401 });
    await assert.rejects(hostedDevicePost('start', { purpose: 'signin' }), /Synthetic refusal/);
    const after = beginHostedCapabilityRead();
    assert.equal(setHostedCapabilities({ auth: { mode: 'bff', csrf: 'fresh-preauth', account: null,
      authorized: false, deviceFlow: null } }, after), true);
    assert.equal(hostedAuth().account, null);
    assert.equal(hostedAuth().authorized, false);
  } finally { globalThis.fetch = originalFetch; setHostedCapabilities(null); }
});

test('current external session expiry is adopted rather than preserving a stale operator', () => {
  setHostedCapabilities(snapshot('operator'));
  const current = beginHostedCapabilityRead();
  assert.equal(setHostedCapabilities({ auth: { mode: 'bff', authorized: false,
    account: null, deviceFlow: null, csrf: 'new-preauth' } }, current), true);
  assert.equal(hostedAuth().account, null);
  assert.equal(hostedAuth().csrf, 'new-preauth');
  setHostedCapabilities(null);
});

test('main gates both capability adoption and failure before mutating application state', async () => {
  const main = await readFile(new URL('../web/js/main.mjs', import.meta.url), 'utf8');
  const body = main.slice(main.indexOf('async function fetchCapabilities'), main.indexOf('async function refreshExecutionContext'));
  assert.match(body, /const ticket = beginHostedCapabilityRead\(\)/);
  assert.ok(body.indexOf('setHostedCapabilities(next, ticket)') < body.indexOf('state.capabilities = next'));
  assert.match(body, /catch \(error\) \{\s*if \(!isHostedCapabilityReadCurrent\(ticket\)\)/);
});
