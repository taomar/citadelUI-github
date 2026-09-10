import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCitadelServer } from '../server/index.mjs';

export function diagnosticClock() {
  let wall = Date.parse('2026-09-09T12:00:00.000Z');
  let mono = 0;
  const timers = new Map();
  const options = {
    now: () => wall,
    monotonic: () => mono,
    setTimer(fn, delay) {
      const id = { unref() {} };
      timers.set(id, { fn, due: mono + delay, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  };
  return {
    options, timers,
    advance(ms) { wall += ms; mono += ms; },
    wallBy(ms) { wall += ms; },
    monoBy(ms) { mono += ms; },
    async runDue() {
      const due = [...timers].filter(([, timer]) => timer.due <= mono);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        await timer.fn();
      }
    },
  };
}

export async function diagnosticServer(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-diagnostics-'));
  const host = '127.0.0.1:45281';
  const origin = `http://${host}`;
  const clock = diagnosticClock();
  const created = await createCitadelServer({
    dataRoot: root, allowedHost: host, allowedOrigin: origin,
    registryNamespace: 'citadel-diagnostics-fixture', testRuntime: true,
    ownerOptions: { cost: { N: 4, r: 8, p: 1 }, failedDelayMs: 0 },
    diagnosticOptions: clock.options, ...options,
  });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  const port = created.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let token = null;
  const call = (path, { method = 'GET', payload, bytes, headers = {}, authenticated = true } = {}) =>
    new Promise((resolve, reject) => {
      const body = bytes ?? (payload === undefined ? null : JSON.stringify(payload));
      const req = request({
        hostname: '127.0.0.1', port, path, method,
        headers: {
          Host: host, 'Sec-Fetch-Site': 'same-origin',
          ...(authenticated && token ? { 'X-Citadel-Session': token } : {}),
          ...(method === 'GET' || method === 'HEAD' ? {} : { Origin: origin }),
          ...(body !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'),
          json() { return JSON.parse(this.text); },
        }));
      });
      req.on('error', reject);
      if (body !== null) req.write(body);
      req.end();
    });
  return {
    ...created, root, host, origin, clock, call,
    async claim() {
      const response = await call('/api/owner/claim', {
        method: 'POST', payload: { username: 'synthetic-owner', password: 'synthetic-debug-fixture-password' },
      });
      assert.equal(response.status, 201);
      token = response.json().sessionToken;
      return token;
    },
    async enable(expectedCaptureId = null) {
      const response = await call('/api/diagnostics/capture', { method: 'POST', payload: { enabled: true, expectedCaptureId } });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}
