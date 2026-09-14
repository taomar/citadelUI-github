import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCitadelServer } from '../server/index.mjs';

export async function isolatedSnapshotApp(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-offline-source-'));
  const host = 'migration-snapshot.test';
  const origin = `http://${host}`;
  let app;
  let token;
  const calls = [];
  const call = (path, init = {}) => new Promise((resolve, reject) => {
    const body = init.body;
    const req = httpRequest({
      hostname: '127.0.0.1', port: app.server.address().port, path, method: init.method || 'GET',
      headers: {
        Host: host, Origin: origin, 'Sec-Fetch-Site': 'same-origin',
        ...(token ? { 'X-Citadel-Session': token } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...init.headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  const request = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET' });
    const response = await call(path, init);
    assert.equal(response.headers['cache-control'], 'no-store');
    if (response.status >= 400) {
      const error = JSON.parse(response.bytes).error;
      throw Object.assign(new Error(error.message), { code: error.code, status: response.status });
    }
    return init.responseType === 'bytes'
      ? { bytes: new Uint8Array(response.bytes), hash: response.headers['x-citadel-content-sha256'] }
      : JSON.parse(response.bytes);
  };
  const start = async (claim) => {
    app = await createCitadelServer({
      dataRoot: root, allowedHost: host, allowedOrigin: origin, githubRoutes: null,
      registryNamespace: 'synthetic-offline-migration', testRuntime: true,
      ownerOptions: { cost: { N: 4, r: 8, p: 1 }, failedDelayMs: 0 },
      ...options,
    });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    token = null;
    const signedIn = await request(`/api/owner/${claim ? 'claim' : 'session'}`, {
      method: 'POST', body: JSON.stringify({ username: 'synthetic-owner', password: 'synthetic local owner passphrase' }),
    });
    token = signedIn.sessionToken;
  };
  const stop = async () => {
    if (app?.server.listening) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.server.close(resolve));
    }
  };
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await start(true);
  return {
    root, request, call, calls,
    get store() { return app.snapshotStore; },
    async restart() {
      const old = token;
      await stop();
      await start(false);
      assert.notEqual(token, old, 'restart requires a fresh owner session, not source credentials');
    },
  };
}
