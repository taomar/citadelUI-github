import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubApiClient } from '../server/github/api.mjs';

test('import read deadlines may be extended per request without changing the shared client timeout', async () => {
  const client = new GitHubApiClient({
    timeoutMs: 5,
    fetch: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('{"ok":true}')), 25);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Timed out', 'AbortError'));
      }, { once: true });
    }),
  });
  assert.equal((await client.request('/user', { timeoutMs: 200 })).data.ok, true);
  assert.equal(client.timeoutMs, 5);
  await assert.rejects(client.request('/user'), { code: 'GITHUB_TIMEOUT' });
});

test('import read deadlines remain bounded and invalid values do not reach GitHub', async () => {
  let calls = 0;
  const client = new GitHubApiClient({ fetch: async () => { calls++; return new Response('{}'); } });
  for (const timeoutMs of [0, -1, 60_001, Infinity, '60000', 1.5]) {
    await assert.rejects(client.request('/user', { timeoutMs }), { code: 'INVALID_GITHUB_TIMEOUT' });
  }
  assert.equal(calls, 0);
});

test('GitHub upstream status is preserved without returning its raw failure body', async () => {
  const client = new GitHubApiClient({ fetch: async () => new Response('{"message":"secret diagnostic text"}', { status: 503 }) });
  await assert.rejects(client.request('/user'), (error) => {
    assert.equal(error.upstreamStatus, 503);
    assert.equal(error.status, 502);
    assert.equal(error.code, 'GITHUB_REQUEST_FAILED');
    assert.doesNotMatch(error.message, /secret diagnostic text/);
    return true;
  });
});
