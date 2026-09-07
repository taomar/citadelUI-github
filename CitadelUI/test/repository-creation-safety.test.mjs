import assert from 'node:assert/strict';
import { mkdir, rename, rm } from 'node:fs/promises';
import test from 'node:test';
import { repositoryHttpFixture } from './_repository-http-fixture.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';
import { SOURCE_URL, gitHash } from './_repository-import-mock.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';

const writes = (fixture) => fixture.github.calls.filter((call) => call.method !== 'GET');
const input = (name = 'safe-copy', sourceUrl = SOURCE_URL) => ({ name, sourceUrl, operationKey: `operation-${name}` });
const barrier = () => {
  let entered, release;
  const reached = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  return { reached, release, block: async () => { entered(); await waiting; } };
};

async function setup(t, options = {}) {
  const fixture = await repositoryHttpFixture(options);
  t.after(() => fixture.close());
  const issue = () => {
    const descriptor = fixture.githubRoutes.sessions.create(TEST_TOKEN, fixture.github.identity);
    return { id: descriptor.id, value: fixture.githubRoutes.sessions.resolve(descriptor.id) };
  };
  return { ...fixture, issue, credential: issue() };
}

async function ready(fixture, body = input()) {
  const op = await fixture.creations.prepare(fixture.credential.value, body);
  await fixture.creations.settled();
  const result = await fixture.creations.status(fixture.credential.value, op.id);
  assert.equal(result.state, 'ready', JSON.stringify(result.error));
  return result;
}

async function finish(fixture, op) {
  await fixture.creations.start(fixture.credential.value, op.id);
  await fixture.creations.settled();
  return fixture.creations.status(fixture.credential.value, op.id);
}

test('repository creation safety: failed pre-pin overrides retain canonical source URLs in every DTO', async (t) => {
  const fixture = await setup(t);
  const sourceUrl = 'https://github.com/fixture-upstream/source/tree/release+review';
  const prepared = await fixture.creations.prepare(fixture.credential.value, input('source-roundtrip', sourceUrl));
  assert.equal(prepared.sourceUrl, sourceUrl);
  await fixture.creations.settled();
  const status = await fixture.creations.status(fixture.credential.value, prepared.id);
  assert.equal(status.state, 'failed');
  assert.equal(status.source, null);
  assert.equal(status.sourceUrl, sourceUrl);
  const listed = await fixture.creations.list(fixture.credential.value);
  assert.equal(listed.operations[0].sourceUrl, sourceUrl);
  const edited = await fixture.creations.prepare(fixture.credential.value, {
    ...input('source-roundtrip'), operationKey: 'edited-source-roundtrip',
  });
  await fixture.creations.settled();
  assert.equal((await fixture.creations.status(fixture.credential.value, edited.id)).state, 'ready');
  assert.equal(writes(fixture).length, 0);
});

test('repository creation safety: async default-branch rename reconciles without ref deletion', async (t) => {
  const fixture = await setup(t, { bootstrapBranch: 'master' });
  fixture.github.renameDelay = 100;
  const op = await ready(fixture);
  const pending = await finish(fixture, op);
  assert.equal(pending.state, 'paused');
  assert.equal(pending.error.code, 'IMPORT_RENAME_PENDING');
  assert.equal(writes(fixture).some((call) => call.method === 'DELETE'), false);
  fixture.github.pendingRenames[0].remaining = 1;
  await fixture.creations.resume(fixture.credential.value, op.id);
  await fixture.creations.settled();
  assert.equal((await fixture.creations.status(fixture.credential.value, op.id)).state, 'complete');
  const repository = fixture.github.repos.get('fixture-owner/safe-copy');
  assert.equal(repository.default_branch, 'main');
  assert.deepEqual([...repository.refs.keys()], ['main']);
  assert.equal(writes(fixture).filter((call) => call.path.endsWith('/branches/master/rename')).length, 1);
});

test('repository creation safety: a commit racing branch rename is preserved, never deleted or overwritten', async (t) => {
  const fixture = await setup(t, { bootstrapBranch: 'master' });
  const op = await ready(fixture);
  let externalHead;
  fixture.github.before = (call) => {
    if (call.path.endsWith('/branches/master/rename') && call.method === 'POST') {
      const repository = fixture.github.repos.get('fixture-owner/safe-copy');
      externalHead = fixture.github.seed(repository, 'master', { 'user-work': 'Keep my concurrent commit.\n' }, [repository.refs.get('master')]);
    }
  };
  const result = await finish(fixture, op);
  assert.equal(result.state, 'paused');
  assert.equal(result.error.code, 'IMPORT_DESTINATION_CHANGED');
  const repository = fixture.github.repos.get('fixture-owner/safe-copy');
  assert.equal(repository.refs.get('main'), externalHead);
  assert.equal(fixture.github.snapshot(repository)[0].bytes.toString(), 'Keep my concurrent commit.\n');
  assert.equal(writes(fixture).some((call) => call.method === 'DELETE'), false);
});

for (const reset of ['published head', 'confirmed default']) {
  test(`repository creation safety: a ${reset} rollback is not silently reapplied on resume`, async (t) => {
    const fixture = await setup(t, { bootstrapBranch: reset === 'confirmed default' ? 'master' : 'main' });
    const op = await ready(fixture);
    assert.equal((await finish(fixture, op)).state, 'complete');
    const record = fixture.creations.records.get(op.id);
    assert.equal(record.mainPublished, true);
    assert.equal(record.defaultSet, true);
    await fixture.creations.checkpoint(record, { state: 'paused' });
    const repository = fixture.github.repos.get('fixture-owner/safe-copy');
    if (reset === 'published head') repository.refs.set('main', record.bootstrap.head);
    else {
      repository.refs.set('master', record.bootstrap.head);
      repository.default_branch = 'master';
    }
    const count = writes(fixture).length;
    await fixture.creations.resume(fixture.credential.value, op.id);
    await fixture.creations.settled();
    const result = await fixture.creations.status(fixture.credential.value, op.id);
    assert.equal(result.state, 'paused');
    assert.equal(result.error.code, 'IMPORT_DESTINATION_CHANGED');
    assert.equal(writes(fixture).length, count, 'confirmed old values are external changes, not replay targets');
  });
}

test('repository creation safety: fatal journal I/O halts requests, stays observable, and resumes after storage repair', async (t) => {
  const fixture = await setup(t);
  const op = await ready(fixture);
  const path = fixture.creations.path;
  const saved = `${path}.saved`;
  let blocked = false;
  fixture.github.after = async (call) => {
    if (call.method === 'POST' && call.path === '/user/repos' && !blocked) {
      blocked = true;
      await rename(path, saved);
      await mkdir(path);
    }
  };
  await fixture.creations.start(fixture.credential.value, op.id);
  await assert.rejects(fixture.creations.settled(), { code: 'IMPORT_STORAGE_UNAVAILABLE' });
  await assert.rejects(fixture.creations.settled(), { code: 'IMPORT_STORAGE_UNAVAILABLE' });
  const result = await fixture.creations.status(fixture.credential.value, op.id);
  assert.equal(result.state, 'paused');
  assert.equal(result.error.code, 'IMPORT_STORAGE_UNAVAILABLE');
  assert.equal(result.created, true);
  assert.equal(result.canResume, true);
  assert.equal(result.canPause, false);
  assert.equal(fixture.creations.isScheduled(op.id), false);
  const count = writes(fixture).length;
  await assert.rejects(fixture.creations.prepare(fixture.credential.value, input('no-new-work')), { code: 'IMPORT_STORAGE_UNAVAILABLE' });
  assert.equal(writes(fixture).length, count);
  await rm(path, { recursive: true });
  await rename(saved, path);
  fixture.github.after = null;
  await fixture.creations.resume(fixture.credential.value, op.id);
  await fixture.creations.settled();
  assert.equal((await fixture.creations.status(fixture.credential.value, op.id)).state, 'complete');
  assert.equal(writes(fixture).filter((call) => call.path === '/user/repos').length, 1);
});

for (const expiry of ['idle', 'absolute']) {
  test(`repository creation safety: passive ${expiry} expiry stops background reads without a status request`, async (t) => {
    let clock = 0;
    const fixture = await setup(t, {
      sessionOptions: { now: () => clock, idleTimeoutMs: expiry === 'idle' ? 10 : 1000, absoluteTimeoutMs: expiry === 'absolute' ? 10 : 1000 },
    });
    const gate = barrier();
    let blocked = false;
    fixture.github.before = async () => { if (!blocked) { blocked = true; await gate.block(); } };
    const op = await fixture.creations.prepare(fixture.credential.value, input(`expiry-${expiry}`));
    await gate.reached;
    const calls = fixture.github.calls.length;
    clock = 11;
    gate.release();
    await fixture.creations.settled();
    assert.equal(fixture.github.calls.length, calls, 'no next request after the session expires');
    assert.equal(fixture.credential.value.token, null);
    const current = await fixture.creations.status(fixture.issue().value, op.id);
    assert.equal(current.state, 'paused');
    assert.equal(current.error.code, 'IMPORT_AUTH_REQUIRED');
  });
}

test('repository creation safety: queued sessions expire independently before their first network request', async (t) => {
  let clock = 0;
  const fixture = await setup(t, { sessionOptions: { now: () => clock, idleTimeoutMs: 10, absoluteTimeoutMs: 1000 } });
  const gate = barrier();
  const dispatches = [];
  let blocked = false;
  fixture.github.before = async () => {
    dispatches.push(fixture.creations.currentId);
    if (!blocked) { blocked = true; await gate.block(); }
  };
  await fixture.creations.prepare(fixture.credential.value, input('active-session'));
  await gate.reached;
  const queuedCredential = fixture.issue();
  const queued = await fixture.creations.prepare(queuedCredential.value, input('expired-queue'));
  clock = 5;
  fixture.githubRoutes.sessions.resolve(fixture.credential.id);
  clock = 11;
  gate.release();
  await fixture.creations.settled();
  assert.equal(dispatches.includes(queued.id), false);
  assert.equal(queuedCredential.value.token, null);
  const current = await fixture.creations.status(fixture.issue().value, queued.id);
  assert.equal(current.error.code, 'IMPORT_AUTH_REQUIRED');
});

test('repository creation safety: expiry during write pacing pauses before the next outbound request', async (t) => {
  let clock = 0;
  const fixture = await setup(t, {
    now: () => clock, wait: async (ms) => { clock += ms; },
    sessionOptions: { now: () => clock, idleTimeoutMs: 10, absoluteTimeoutMs: 1000 },
    limits: { writeIntervalMs: 20 },
  });
  const op = await ready(fixture);
  await fixture.creations.start(fixture.credential.value, op.id);
  await fixture.creations.settled();
  assert.equal(writes(fixture).length, 1, 'only repository creation preceded the pacing wait');
  const current = await fixture.creations.status(fixture.issue().value, op.id);
  assert.equal(current.created, true);
  assert.equal(current.error.code, 'IMPORT_AUTH_REQUIRED');
});

test('repository creation safety: real-default file mix copies 312 text and 51 binary files at exact byte scale', async (t) => {
  const files = citadelRepositoryFiles({ LICENSE: 'MIT fixture license preserved exactly.\n' });
  for (const [path, value] of Object.entries(files)) {
    if (typeof value === 'object' && !Buffer.isBuffer(value)) files[path] = { ...value, mode: '100644' };
  }
  const largest = '"'.repeat(36_849) + 'L'.repeat(1_144_364 - 36_849);
  assert.equal(Buffer.byteLength(JSON.stringify(largest)), 1_181_215);
  files['directory-00/large-text.txt'] = largest;
  const filler = [];
  while (Object.keys(files).length < 312) {
    const i = filler.length;
    const path = `directory-${String(i % 64).padStart(2, '0')}/text-${i}.txt`;
    const prefix = `Exact synthetic text ${i}\r\n`;
    files[path] = prefix + 't'.repeat(32_000 - Buffer.byteLength(prefix));
    filler.push(path);
  }
  const bytesOf = (value) => Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : value.content);
  const textBytes = Object.values(files).reduce((sum, value) => sum + bytesOf(value).length, 0);
  assert(textBytes < 11_169_347);
  files[filler.at(-1)] += 'p'.repeat(11_169_347 - textBytes);
  for (let i = 0; i < 51; i += 1) {
    const size = i === 0 ? 2_022_353 : i === 50 ? 9_134_288 - 2_022_353 - 49 * 140_000 : 140_000;
    const bytes = Buffer.alloc(size, 0xfe);
    bytes.writeUInt32LE(i);
    files[`directory-${String(i % 64).padStart(2, '0')}/asset-${i}.pbix`] = bytes;
  }
  const unique = () => new Set(Object.values(files).map((value) => gitHash('blob', bytesOf(value)))).size;
  const duplicates = unique() - 351;
  for (let i = 0; i < duplicates; i += 1) files[filler[i * 2 + 1]] = files[filler[i * 2]];
  assert.equal(unique(), 351);
  assert.equal(Object.keys(files).length, 363);
  assert.equal(Object.values(files).filter(Buffer.isBuffer).length, 51);
  assert.equal(Object.values(files).filter((value) => !Buffer.isBuffer(value)).reduce((sum, value) => sum + bytesOf(value).length, 0), 11_169_347);
  assert.equal(Object.values(files).filter(Buffer.isBuffer).reduce((sum, value) => sum + value.length, 0), 9_134_288);
  let clock = Date.parse('2026-09-07T10:00:00Z');
  const fixture = await setup(t, { files, now: () => clock, wait: async (ms) => { clock += ms; }, limits: { writeIntervalMs: 1100 } });
  const op = await ready(fixture);
  assert.equal(op.source.totalBytes, 20_303_635);
  assert.equal(op.source.fileCount, 363);
  assert.equal(fixture.github.flatten(fixture.github.source, op.source.tree).length, 433);
  assert.equal((await finish(fixture, op)).state, 'complete');
  const repo = fixture.github.repos.get('fixture-owner/safe-copy');
  assert.deepEqual(fixture.github.snapshot(repo), fixture.github.snapshot(fixture.github.source, 'citadel-v1'));
  assert.equal(writes(fixture).filter((call) => call.path.endsWith('/git/blobs')).length, 51);
  assert.ok(writes(fixture).length < 150, 'tree-inline text avoids 363 individual blob writes');
});
