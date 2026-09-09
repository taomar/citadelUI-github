import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_REPOSITORY_SOURCE } from '../shared/repository-source.mjs';
import { validateLocalSnapshot } from '../shared/repository-snapshot.mjs';
import { GitHubApiClient } from '../server/github/api.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { localSourceHttpFixture, publicSourceFixture } from './_local-source-fixture.mjs';

test('local source: complete realistic snapshot uses anonymous pinned raw bytes, not a GitHub write token', async () => {
  const extras = {
    LICENSE: 'Synthetic license fixture\r\n',
    'empty.txt': '',
    'assets/binary.pbix': Buffer.alloc(2_022_353, 0xfe),
    '.github/ISSUE_TEMPLATE.md': '# Template\n',
    '.env.template': 'AZURE_ENV_NAME=example\n',
  };
  for (let i = 0; i < 350; i++) extras[`samples/file-${i}.txt`] = `Sample ${i}\r\n`;
  for (let i = 0; i < 40; i++) extras[`assets/binary-${i}.bin`] = Buffer.alloc(450_000, i + 1);
  const fixture = publicSourceFixture({ files: citadelRepositoryFiles(extras) });
  const operation = await fixture.prepare();
  assert.equal(operation.state, 'ready', JSON.stringify(operation.error));
  assert.equal(operation.source.ref, 'citadel-v1');
  assert.equal(operation.source.commit, fixture.github.sourceHead);
  assert.equal(operation.source.fileCount, 403);
  assert(operation.source.totalBytes > 20_000_000);
  const manifest = fixture.service.manifest(operation.id);
  const snapshot = validateLocalSnapshot(manifest);
  assert.equal(snapshot.files.length, 403);
  for (const file of fixture.github.snapshot(fixture.github.source, 'citadel-v1')) {
    const blob = fixture.service.blob(operation.id, file.sha);
    assert.deepEqual(Buffer.from(blob.content, 'base64'), file.bytes, file.path);
  }
  assert.equal(fixture.calls.filter((call) => call.host === 'api.github.com').length, 3, 'REST budget is metadata, commit, complete tree');
  assert(fixture.calls.filter((call) => call.host === 'raw.githubusercontent.com').length > 350);
  assert(fixture.calls.filter((call) => call.host === 'raw.githubusercontent.com')
    .every((call) => call.path.includes(`/${fixture.github.sourceHead}/`)));
  assert.equal(fixture.github.repos.size, 1);
  assert(!snapshot.files.some((file) => file.path === 'branch.txt'), 'must not use main');
  fixture.unavailable = true;
  assert.equal(fixture.service.manifest(operation.id).entries.length, manifest.entries.length);
  fixture.service.blob(operation.id, snapshot.files[0].sha);
});

for (const [name, files, code] of [
  ['symlink', citadelRepositoryFiles({ link: { content: 'LICENSE', mode: '120000' } }), 'IMPORT_UNSUPPORTED_MODE'],
  ['submodule', citadelRepositoryFiles({ linked: { content: 'gitlink', mode: '160000' } }), 'IMPORT_UNSUPPORTED_MODE'],
  ['LFS', citadelRepositoryFiles({ asset: 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n' }), 'IMPORT_LFS_UNSUPPORTED'],
  ['unsupported Citadel layout', { 'README.md': 'ordinary' }, 'IMPORT_SOURCE_UNSUPPORTED'],
  ['dot-git', citadelRepositoryFiles({ '.git/config': 'unsafe' }), 'IMPORT_UNSAFE_PATH'],
  ['traversal', citadelRepositoryFiles({ '../outside.txt': 'unsafe' }), 'IMPORT_UNSAFE_PATH'],
  ['reserved name', citadelRepositoryFiles({ 'NUL.txt': 'unsafe' }), 'LOCAL_IMPORT_UNSAFE_PATH'],
  ['console device name', citadelRepositoryFiles({ 'CONOUT$': 'unsafe' }), 'LOCAL_IMPORT_UNSAFE_PATH'],
  ['device stem with spaces', citadelRepositoryFiles({ 'CON .txt': 'unsafe' }), 'LOCAL_IMPORT_UNSAFE_PATH'],
  ['alternate stream', citadelRepositoryFiles({ 'file:stream': 'unsafe' }), 'LOCAL_IMPORT_UNSAFE_PATH'],
  ['trailing dot', citadelRepositoryFiles({ 'folder./name': 'unsafe' }), 'LOCAL_IMPORT_UNSAFE_PATH'],
  ['case collision', citadelRepositoryFiles({ 'Name.txt': 'one', 'name.txt': 'two' }), 'LOCAL_IMPORT_PATH_COLLISION'],
  ['Unicode collision', citadelRepositoryFiles({ 'caf\u00e9.txt': 'one', 'cafe\u0301.txt': 'two' }), 'LOCAL_IMPORT_PATH_COLLISION'],
  ['Unicode case collision', citadelRepositoryFiles({ '\u03c3.txt': 'one', '\u03c2.txt': 'two' }), 'LOCAL_IMPORT_PATH_COLLISION'],
]) {
  test(`local source: refuses ${name} before exposing a copyable snapshot`, async () => {
    const fixture = publicSourceFixture({ files });
    const operation = await fixture.prepare();
    assert.equal(operation.state, 'failed');
    assert.equal(operation.error.code, code, JSON.stringify(operation.error));
    assert.throws(() => fixture.service.manifest(operation.id), { code: 'LOCAL_IMPORT_NOT_READY' });
  });
}

test('local source: cancellation and retry keep the exact commit even when the branch moves', async () => {
  const fixture = publicSourceFixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const beginning = new Promise((resolve) => { started = resolve; });
  fixture.before = async (call) => {
    if (call.host === 'raw.githubusercontent.com') { started(); await gate; }
  };
  const op = fixture.service.prepare({ operationKey: randomUUID() });
  await beginning;
  const cancelled = fixture.service.cancel(op.id);
  release();
  await cancelled;
  assert.equal(fixture.service.find(op.id).state, 'cancelled');
  assert.equal(fixture.service.find(op.id).source.commit, fixture.github.sourceHead);
  fixture.github.seed(fixture.github.source, 'citadel-v1', { 'WRONG.txt': 'new branch' });
  fixture.before = null;
  fixture.service.start(fixture.service.find(op.id));
  await fixture.service.settled();
  assert.equal(fixture.service.find(op.id).state, 'ready');
  assert.equal(fixture.service.manifest(op.id).source.commit, fixture.github.sourceHead);
  assert.equal(fixture.calls.filter((call) => /\/commits\/citadel-v1$/.test(call.path)).length, 1);
});

test('local source: changed hashes and truncated trees never become ready', async () => {
  const fixture = publicSourceFixture();
  fixture.github.recursiveTruncated = true;
  fixture.github.nonrecursiveTruncated = true;
  const incomplete = await fixture.prepare();
  assert.equal(incomplete.error.code, 'IMPORT_TRUNCATED');
  await fixture.service.cancel(incomplete.id, true);
  fixture.github.recursiveTruncated = false;
  fixture.github.nonrecursiveTruncated = false;
  fixture.after = (call, response) => call.host === 'raw.githubusercontent.com' ? new Response('wrong bytes') : response;
  const corrupt = await fixture.prepare();
  assert.equal(corrupt.error.code, 'IMPORT_HASH_MISMATCH');
});

test('local source: limits and anonymous rate failures are explicit and resumable', async () => {
  const tooLarge = publicSourceFixture({ serviceOptions: { limits: { blobBytes: 1 } } });
  assert.equal((await tooLarge.prepare()).error.code, 'IMPORT_LIMIT');
  let now = 10_000;
  const fixture = publicSourceFixture({ serviceOptions: { now: () => now } });
  fixture.before = () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
  const operation = await fixture.prepare();
  assert.equal(operation.error.code, 'LOCAL_IMPORT_RATE_LIMIT');
  assert.throws(() => fixture.service.start(fixture.service.find(operation.id)), { code: 'LOCAL_IMPORT_RATE_LIMIT' });
  now = operation.retryAt;
  fixture.before = null;
  fixture.service.start(fixture.service.find(operation.id));
  await fixture.service.settled();
  assert.equal(fixture.service.find(operation.id).state, 'ready');
});

test('local source: actual anonymous rate reset and retry-after values are retained', async () => {
  const now = Date.parse('2026-06-01T12:00:00Z');
  const fixture = publicSourceFixture({ serviceOptions: { now: () => now } });
  fixture.before = () => new Response(null, {
    status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((now + 3_600_000) / 1000), 'retry-after': '120' },
  });
  const operation = await fixture.prepare();
  assert.equal(operation.error.code, 'LOCAL_IMPORT_RATE_LIMIT');
  assert.equal(operation.retryAt, now + 3_600_000);
});

test('local source: raw transport rejects redirects, oversize streams and unpinned or unsafe targets', async () => {
  let calls = 0;
  const client = new GitHubApiClient({ fetch: async () => { calls++; return new Response(null, { status: 302 }); } });
  for (const [name, ref, path] of [
    ['fixture/source', 'citadel-v1', 'README.md'],
    ['fixture/source', 'a'.repeat(40), '../outside'],
    ['fixture/source?secret=x', 'a'.repeat(40), 'README.md'],
  ]) await assert.rejects(client.publicFile(name, ref, path));
  assert.equal(calls, 0);
  await assert.rejects(client.publicFile('fixture/source', 'a'.repeat(40), 'README.md'), { code: 'GITHUB_REDIRECT' });
  const big = new GitHubApiClient({ fetch: async () => new Response(Buffer.alloc(10)) });
  await assert.rejects(big.publicFile('fixture/source', 'a'.repeat(40), 'README.md', { limit: 1 }), { code: 'GITHUB_RESPONSE_TOO_LARGE' });
});

test('local source: protected HTTP accepts no PAT or destination path and makes no registry or remote writes', async (t) => {
  const fixture = await localSourceHttpFixture();
  t.after(() => fixture.close());
  const base = '/api/github/local-imports';
  const key = randomUUID();
  const before = await fixture.call('/api/registry');
  assert.equal((await fixture.call(base, { method: 'POST', body: { operationKey: key }, headers: { 'X-Citadel-Session': 'wrong' } })).status, 401);
  assert.equal((await fixture.call(base, { method: 'POST', body: { operationKey: key }, headers: { Origin: 'http://foreign.invalid' } })).status, 403);
  for (const extra of [{ localPath: 'C:\\private' }, { handle: {} }, { token: 'not-a-token' }]) {
    assert.equal((await fixture.call(base, { method: 'POST', body: { operationKey: key, ...extra } })).status, 400);
  }
  const prepared = await fixture.call(base, { method: 'POST', body: { operationKey: key, sourceUrl: DEFAULT_REPOSITORY_SOURCE } });
  assert.equal(prepared.status, 200);
  assert.equal((await fixture.call(base, { method: 'POST', body: { operationKey: key, sourceUrl: DEFAULT_REPOSITORY_SOURCE } })).body.id, key);
  assert.equal((await fixture.call(base, { method: 'POST', body: { operationKey: randomUUID() } })).status, 409);
  await fixture.service.settled();
  const status = await fixture.call(`${base}/${key}`);
  assert.equal(status.body.state, 'ready', JSON.stringify(status.body));
  const manifest = await fixture.call(`${base}/${key}/manifest`);
  assert.equal(manifest.status, 200);
  assert.equal((await fixture.call(`${base}/${key}/blobs/${validateLocalSnapshot(manifest.body).files[0].sha}`)).status, 200);
  assert.equal((await fixture.call(`${base}/${key}/blobs/${'0'.repeat(40)}`)).status, 404);
  assert.deepEqual((await fixture.call('/api/registry')).body, before.body);
  assert.equal(fixture.github.repos.size, 1);
  assert.equal((await fixture.call(`${base}/${key}`, { method: 'DELETE' })).body.released, true);
  assert.equal((await fixture.call(`${base}/${key}`)).status, 404);
});
