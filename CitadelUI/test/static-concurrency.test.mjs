import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { diagnosticServer } from './_diagnostics-fixture.mjs';

async function occupiedServer(t, count = 1, options = {}) {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  let arrivals = 0;
  t.signal.addEventListener('abort', () => released.resolve(), { once: true });
  const fixture = await diagnosticServer(t, {
    ...options,
    ownerAccount: {
      async read() {
        arrivals += 1;
        if (arrivals === count) entered.resolve();
        await released.promise;
        return { state: 'claimed' };
      },
    },
  });
  const held = Array.from({ length: count }, () => fixture.call('/api/owner'));
  await entered.promise;
  return {
    ...fixture,
    async release() {
      released.resolve();
      await Promise.all(held);
    },
  };
}

function arriving(server, path) {
  const arrived = Promise.withResolvers();
  const listener = (req, res) => {
    if (req.url !== path) return;
    server.off('request', listener);
    arrived.resolve(res);
  };
  server.on('request', listener);
  return arrived.promise;
}

test('static module admission: startup fan-out waits without raising the 32-request processing limit', { timeout: 15000 }, async (t) => {
  const fixture = await occupiedServer(t, 32);
  const arrived = Promise.withResolvers();
  const paths = Array.from({ length: 97 }, (_, index) => `/shared/source-plan.mjs?module=${index}`);
  let arrivals = 0;
  fixture.server.on('request', (req) => {
    if (req.url.startsWith('/shared/source-plan.mjs?module=') && ++arrivals === paths.length) {
      arrived.resolve();
    }
  });
  const assets = paths.map((path) => fixture.call(path));
  try {
    await arrived.promise;
    const busy = await fixture.call('/api/owner');
    assert.equal(busy.status, 503);
    assert.equal(busy.json().error.code, 'SERVER_BUSY');
    await fixture.release();
    const responses = await Promise.all(assets);
    assert.deepEqual(responses.map((response) => response.status), Array(paths.length).fill(200));
    assert(responses.every((response) => response.headers['content-type'].startsWith('text/javascript')));
    assert(responses.every((response) => response.headers['cache-control'] === 'no-store'));
  } finally {
    await fixture.release();
    await Promise.all(assets);
  }
});

test('static module admission: queued assets are bounded and do not queue API or unsafe requests', { timeout: 15000 }, async (t) => {
  const fixture = await occupiedServer(t, 1, { maxConcurrency: 1, maxQueuedStaticRequests: 1 });
  let queued;
  try {
    for (const [path, options] of [
      ['/api/owner', {}],
      ['/api', {}],
      ['/healthz', {}],
      ['/shared/%2e%2e/api/owner', {}],
      ['/js/../api/owner', {}],
      ['/shared/source-plan.mjs', { method: 'POST' }],
      ['/shared/source-plan.mjs', { headers: { Host: 'wrong.invalid' } }],
    ]) {
      const response = await fixture.call(path, options);
      assert.equal(response.status, 503, path);
      assert.equal(response.json().error.code, 'SERVER_BUSY', path);
      assert.equal(response.headers['retry-after'], '1', path);
    }
    const path = '/shared/source-plan.mjs?queued';
    const arrival = arriving(fixture.server, path);
    queued = fixture.call(path, { method: 'HEAD' });
    await arrival;
    const overflow = await fixture.call('/shared/source-plan.mjs?overflow');
    assert.equal(overflow.status, 503);
    assert.equal(overflow.json().error.code, 'SERVER_BUSY');
    assert.equal(overflow.headers['retry-after'], '1');
    await fixture.release();
    const response = await queued;
    assert.equal(response.status, 200);
    assert.equal(response.text, '');
    assert.equal((await fixture.call('/shared/source-plan.mjs')).status, 200);
  } finally {
    await fixture.release();
    if (queued) await queued;
  }
});

test('static module admission: entry pages and other static paths share the bounded queue', { timeout: 15000 }, async (t) => {
  const fixture = await occupiedServer(t, 1, { maxConcurrency: 1, maxQueuedStaticRequests: 4 });
  const paths = ['/', '/debug', '/js/app.mjs', '/vendor/missing-parser.wasm'];
  const arrivals = paths.map((path) => arriving(fixture.server, path));
  const responses = paths.map((path) => fixture.call(path));
  try {
    await Promise.all(arrivals);
    await fixture.release();
    assert.deepEqual((await Promise.all(responses)).map((response) => response.status), [200, 200, 200, 404]);
  } finally {
    await fixture.release();
    await Promise.all(responses);
  }
});

test('static module admission: disconnecting a queued request releases its waiting slot', { timeout: 15000 }, async (t) => {
  const fixture = await occupiedServer(t, 1, { maxConcurrency: 1, maxQueuedStaticRequests: 1 });
  fixture.diagnostics.setEnabled(true, null);
  const path = '/shared/source-plan.mjs?aborted';
  const arrival = arriving(fixture.server, path);
  const client = request({
    hostname: '127.0.0.1',
    port: fixture.server.address().port,
    path,
    headers: { Host: fixture.host },
  });
  const clientError = once(client, 'error', { signal: t.signal });
  client.end();
  let replacement;
  try {
    const response = await arrival;
    const disconnected = once(response, 'close', { signal: t.signal });
    client.destroy();
    const [error] = await clientError;
    assert.equal(error.code, 'ECONNRESET');
    await disconnected;
    assert.equal(fixture.diagnostics.report().events[0].code, 'REQUEST_ABORTED');
    assert.equal(fixture.diagnostics.report().counts.received, 1);
    const nextPath = '/shared/source-plan.mjs?replacement';
    const nextArrival = arriving(fixture.server, nextPath);
    replacement = fixture.call(nextPath);
    await nextArrival;
    await fixture.release();
    assert.equal((await replacement).status, 200);
    assert.equal((await fixture.call('/healthz')).status, 200);
  } finally {
    client.destroy();
    await fixture.release();
    if (replacement) await replacement;
  }
});
