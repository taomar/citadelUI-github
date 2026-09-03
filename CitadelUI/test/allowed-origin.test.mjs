/**
 * The one origin a state-changing request may carry.
 *
 * This control used to have no configuration because it needed none: the server
 * only ever ran on loopback, so the origin was `http://` plus the host it
 * already enforced. Putting the product behind a TLS-terminating ingress breaks
 * that derivation — the browser sends `https://<fqdn>`, the derived value still
 * says `http://`, and every write is refused while the page itself loads
 * perfectly and the health probe stays green.
 *
 * So these tests hold two lines at once. The first is that nothing moved: with
 * no configuration the value is byte-identical to what it has always been. The
 * second is the one that actually matters, and it is a negative — making the
 * control *able* to express `https` must not have made it *accept* `https`. An
 * https origin is refused unless it was configured, and a configured origin is
 * still compared as an exact string, with no scheme-agnostic or prefix match
 * hiding underneath.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCitadelServer, resolveAllowedOrigin } from '../server/index.mjs';

const SESSION = 'test-session-token';

function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path, method: options.method || 'GET', headers: options.headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            json() {
              try {
                return JSON.parse(this.body);
              } catch {
                return null;
              }
            },
          })
        );
      }
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function start(t, { allowedHost = '127.0.0.1:4173', ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-origin-'));
  const webRoot = join(root, 'web');
  const sharedRoot = join(root, 'shared');
  await mkdir(webRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body></body></html>'
  );
  const created = await createCitadelServer({
    webRoot,
    sharedRoot,
    dataRoot: join(root, 'data'),
    allowedHost,
    sessionToken: SESSION,
    githubRoutes: null,
    ...options,
  });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await created.activityStore?.settled?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const port = created.server.address().port;
  return {
    ...created,
    post(origin) {
      return httpRequest(port, '/api/activity', {
        method: 'POST',
        headers: {
          Host: allowedHost,
          'Sec-Fetch-Site': 'same-origin',
          'X-Citadel-Session': SESSION,
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ action: 'environment.open' }),
      });
    },
  };
}

test('with nothing configured the origin is exactly what it has always been', () => {
  // Byte-identical to the expression this replaced. Local deployments and the
  // rest of the suite must not be able to tell that anything changed.
  for (const host of ['127.0.0.1:4173', '127.0.0.1:45173', 'localhost:8080', 'citadel.internal']) {
    assert.equal(resolveAllowedOrigin(undefined, host, {}), `http://${host}`);
    assert.equal(resolveAllowedOrigin('', host, {}), `http://${host}`);
    assert.equal(resolveAllowedOrigin(null, host, {}), `http://${host}`);
    assert.equal(resolveAllowedOrigin(undefined, host, { CITADEL_ALLOWED_ORIGIN: '' }), `http://${host}`);
  }
});

test('configuration is read from the environment, and an explicit value outranks it', () => {
  const env = { CITADEL_ALLOWED_ORIGIN: 'https://citadel.azurecontainerapps.io' };
  assert.equal(
    resolveAllowedOrigin(undefined, '127.0.0.1:4173', env),
    'https://citadel.azurecontainerapps.io'
  );
  assert.equal(
    resolveAllowedOrigin('https://explicit.example.net', '127.0.0.1:4173', env),
    'https://explicit.example.net'
  );
  // A trailing slash is the one forgiving case: `new URL` already tells us the
  // origin, and an operator writing it meant the same thing. Everything else
  // below is refused rather than repaired.
  assert.equal(resolveAllowedOrigin('https://citadel.example.net/', 'h', {}), 'https://citadel.example.net');
});

test('an origin that could never match is refused at startup, not at save time', () => {
  for (const hostile of [
    'https://citadel.example.net/app',
    'https://citadel.example.net/?x=1',
    'https://citadel.example.net/#f',
    'https://user:pass@citadel.example.net',
    'ftp://citadel.example.net',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'citadel.example.net',
    'not a url',
    '://missing-scheme',
  ]) {
    // Loud and early beats a 403 on every write from a container that reports
    // itself healthy. This is the failure mode the whole change exists to avoid.
    assert.throws(() => resolveAllowedOrigin(hostile, '127.0.0.1:4173', {}), /Invalid Citadel allowed origin/);
  }
});

test('a server refuses to start rather than serve an unmatchable origin', async (t) => {
  await assert.rejects(
    start(t, { allowedOrigin: 'https://citadel.example.net/app' }),
    /Invalid Citadel allowed origin/
  );
});

test('an https origin is rejected when it was not configured', async (t) => {
  const fixture = await start(t);

  // The negative that proves nothing became permissive. This server was given no
  // origin, so it enforces `http://127.0.0.1:4173` and must refuse the https
  // form of its own host as firmly as it refuses a stranger.
  for (const origin of [
    'https://127.0.0.1:4173',
    'http://127.0.0.1:4174',
    'http://evil.example.com',
    'https://127.0.0.1:4173.evil.example.com',
    'null',
  ]) {
    const response = await fixture.post(origin);
    assert.equal(response.status, 403, origin);
    assert.equal(response.json()?.error?.code, 'INVALID_ORIGIN', origin);
  }

  // A missing Origin on a write is not a pass either.
  const absent = await fixture.post(null);
  assert.equal(absent.status, 403);
  assert.equal(absent.json()?.error?.code, 'INVALID_ORIGIN');

  // And the value it does enforce still works, unchanged.
  const allowed = await fixture.post('http://127.0.0.1:4173');
  assert.notEqual(allowed.json()?.error?.code, 'INVALID_ORIGIN');
});

test('a configured https origin is accepted, and only that exact string', async (t) => {
  const allowedHost = 'citadel.happysea-1234.westeurope.azurecontainerapps.io';
  const fixture = await start(t, {
    allowedHost,
    allowedOrigin: `https://${allowedHost}`,
  });

  const accepted = await fixture.post(`https://${allowedHost}`);
  assert.notEqual(accepted.json()?.error?.code, 'INVALID_ORIGIN');

  for (const origin of [
    // The scheme downgrade: the whole reason the derived value was wrong.
    `http://${allowedHost}`,
    // A prefix, a suffix, and a subdomain. If any of these passed, the exact
    // match had quietly become a "starts with" or a "contains".
    `https://${allowedHost}.evil.example.com`,
    `https://evil.${allowedHost}`,
    `https://${allowedHost}:443`,
    `https://${allowedHost}/`,
    'HTTPS://CITADEL.HAPPYSEA-1234.WESTEUROPE.AZURECONTAINERAPPS.IO',
  ]) {
    const response = await fixture.post(origin);
    assert.equal(response.status, 403, origin);
    assert.equal(response.json()?.error?.code, 'INVALID_ORIGIN', origin);
  }

  // Surrounding whitespace is deliberately absent from that list. HTTP strips
  // optional whitespace around a field value before the application is handed
  // it, so `Origin: <space>https://host<space>` and `Origin: https://host` are
  // the same request by the time this code runs. Asserting a rejection here
  // would be asserting something the transport already made impossible.
  const padded = await fixture.post(`  https://${allowedHost}  `);
  assert.notEqual(padded.json()?.error?.code, 'INVALID_ORIGIN');
});

test('the environment variable actually reaches a running server', async (t) => {
  // The unit tests above use an injected env, which proves the logic and not the
  // wiring. Azure depends on the wiring, so exercise the real `process.env` path
  // once rather than discovering it is unconnected after a deployment.
  const previous = process.env.CITADEL_ALLOWED_ORIGIN;
  const allowedHost = 'citadel.example.net';
  process.env.CITADEL_ALLOWED_ORIGIN = `https://${allowedHost}`;
  t.after(() => {
    if (previous === undefined) delete process.env.CITADEL_ALLOWED_ORIGIN;
    else process.env.CITADEL_ALLOWED_ORIGIN = previous;
  });

  const fixture = await start(t, { allowedHost });
  const accepted = await fixture.post(`https://${allowedHost}`);
  assert.notEqual(accepted.json()?.error?.code, 'INVALID_ORIGIN');

  const refused = await fixture.post(`http://${allowedHost}`);
  assert.equal(refused.status, 403);
  assert.equal(refused.json()?.error?.code, 'INVALID_ORIGIN');
});
