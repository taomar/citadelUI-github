import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RepositoryCreationService } from '../server/github/repository-creation.mjs';
import { githubError } from '../server/github/api.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { ImportGitHub, IMPORT_SESSION, SOURCE_URL, gitHash } from './_repository-import-mock.mjs';

const creation = (name = 'private-copy', extra = {}) => ({ name, sourceUrl: SOURCE_URL, operationKey: `key-${name}-0001`, ...extra });
const destination = (mock, name = 'private-copy') => mock.repos.get(`fixture-owner/${name}`);
const writes = (mock) => mock.calls.filter((call) => call.method !== 'GET');
const lost = () => githubError(504, 'GITHUB_TIMEOUT', 'Fixture response lost.');
const barrier = () => {
  let release, entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  return { release, reached, block: async () => { entered(); await waiting; } };
};

async function context(t, options = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'citadel-import-'));
  const mock = new ImportGitHub(options);
  const session = { ...IMPORT_SESSION };
  let clock = Date.parse('2026-09-07T10:00:00Z');
  const notes = [];
  const config = {
    dataRoot, client: mock, note: (entry) => notes.push(entry),
    now: () => clock, wait: async (ms) => { clock += ms; },
    limits: { writeIntervalMs: 0, ...options.limits },
  };
  const service = new RepositoryCreationService(config);
  await service.initialize();
  t.after(async () => { service.shutdown(); await service.settled(); await rm(dataRoot, { recursive: true, force: true }); });
  return { dataRoot, mock, service, session, config, notes, advance: (ms) => { clock += ms; } };
}

async function ready(cx, input = creation()) {
  const op = await cx.service.prepare(cx.session, input);
  await cx.service.settled();
  const current = await cx.service.status(cx.session, op.id);
  assert.equal(current.state, 'ready', JSON.stringify(current.error));
  assert.equal(current.canStart, true);
  return current;
}

async function finish(cx, op) {
  await cx.service.start(cx.session, op.id);
  await cx.service.settled();
  return cx.service.status(cx.session, op.id);
}

test('repository creation: strict Git object model has known real SHA-1 blob and tree hashes', () => {
  assert.equal(gitHash('blob', ''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitHash('blob', 'hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(gitHash('tree', ''), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const mock = new ImportGitHub();
  const empty = mock.repository('fixture-owner/empty');
  assert.throws(() => mock.dispatch('/repos/fixture-owner/empty/git/refs', 'POST', {
    ref: 'refs/heads/main', sha: mock.sourceHead,
  }), /empty repository/);
  assert.equal(empty.blobs.size, 0);
  assert.throws(() => mock.dispatch('/repos/fixture-owner/empty/git/trees', 'POST', {
    tree: [{ path: 'stolen', mode: '100644', type: 'blob', sha: mock.source.blobs.keys().next().value }],
  }), /not source/);
});

test('repository creation: read-only prepare pins citadel-v1 and full snapshot preserves bytes, modes, license and dotfiles', async (t) => {
  const files = citadelRepositoryFiles({
    'LICENSE': 'MIT fixture license\nKeep exactly.\n',
    '.env.template': '# keep this dotfile\r\n',
    '.github/ISSUE_TEMPLATE.md': 'issue template\n',
    'bytes.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 1, 2]),
    'report.pbix': Buffer.alloc(1024 * 1024 + 123, 0xfe),
    'nul.txt': Buffer.from('a\0b'),
    'invalid.txt': Buffer.from([0xc3, 0x28]),
    'crlf.txt': 'first\r\nsecond\r\n',
    'bom.txt': '\ufeffkeep the BOM\n',
    'empty': '',
    '.gitattributes': '* -text\n',
    'z./ü.txt': 'UTF-8 path\n',
  });
  const cx = await context(t, { files });
  const op = await ready(cx);
  assert.equal(writes(cx.mock).length, 0);
  assert.equal(op.created, false);
  assert.equal(op.source.commit, cx.mock.sourceHead);
  assert.equal(op.source.ref, 'citadel-v1');
  assert.equal(op.source.fileCount, Object.keys(files).length);
  assert.equal(op.source.hasWorkflows, false);
  const completed = await finish(cx, op);
  assert.equal(completed.state, 'complete', JSON.stringify(completed.error));
  const repo = destination(cx.mock);
  assert.equal(repo.private, true);
  assert.equal(repo.default_branch, 'main');
  assert.deepEqual(cx.mock.snapshot(repo), cx.mock.snapshot(cx.mock.source, 'citadel-v1'));
  assert(!cx.mock.snapshot(repo).some((item) => item.path === 'README.md'), 'no bootstrap leftovers');
  const blobWrites = writes(cx.mock).filter((call) => call.path.endsWith('/git/blobs'));
  assert.equal(blobWrites.length, 4, 'only binary/NUL/non-UTF8 blobs use base64 writes');
  const inline = writes(cx.mock).filter((call) => call.path.endsWith('/git/trees')).flatMap((call) => call.body.tree);
  assert(inline.some((entry) => entry.path === 'bom.txt' && entry.content === '\ufeffkeep the BOM\n'));
  assert(inline.some((entry) => entry.path === 'deploy.sh' && entry.mode === '100755'));
  assert.equal(cx.notes.at(-1).outcome, 'ok');
});

test('repository creation: root URL visibly resolves actual default branch, slash refs are never treated as folders', async (t) => {
  const cx = await context(t, { defaultBranch: 'citadel-v1' });
  const root = await ready(cx, creation('root-copy', { sourceUrl: 'https://github.com/fixture-upstream/source' }));
  assert.equal(root.source.ref, 'citadel-v1');
  assert.equal(root.source.commit, cx.mock.sourceHead);
  cx.mock.seed(cx.mock.source, 'release/next', citadelRepositoryFiles({ 'exact.txt': 'slash ref' }));
  const slash = await ready(cx, creation('slash-copy', { sourceUrl: 'https://github.com/fixture-upstream/source/tree/release/next' }));
  assert.equal(slash.source.ref, 'release/next');
  const bad = await cx.service.prepare(cx.session, creation('folder-copy', { sourceUrl: `${SOURCE_URL}/subdir` }));
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, bad.id)).state, 'failed');
  assert.equal(writes(cx.mock).length, 0);
});

test('repository creation: truncated recursion walks all directories, still-truncated nonrecursive response fails closed', async (t) => {
  const cx = await context(t);
  cx.mock.recursiveTruncated = true;
  const op = await ready(cx);
  assert.equal(op.source.fileCount, Object.keys(citadelRepositoryFiles()).length);
  assert(cx.mock.calls.some((call) => /\/git\/trees\/[a-f0-9]{40}$/.test(call.path)));
  cx.mock.nonrecursiveTruncated = true;
  const bad = await cx.service.prepare(cx.session, creation('truncated-copy'));
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, bad.id)).error.code, 'IMPORT_TRUNCATED');
  assert.equal(writes(cx.mock).length, 0);
});

for (const [label, options, code] of [
  ['blob size', { files: citadelRepositoryFiles({ 'huge': 'x'.repeat(100_001) }), limits: { blobBytes: 100_000 } }, 'IMPORT_LIMIT'],
  ['total size', { limits: { totalBytes: 1 } }, 'IMPORT_LIMIT'],
  ['file count', { limits: { files: 1 } }, 'IMPORT_LIMIT'],
  ['manifest count', { limits: { entries: 1 } }, 'IMPORT_LIMIT'],
  ['wire tree size', { files: citadelRepositoryFiles({ 'large-text': 'x'.repeat(200_000) }), limits: { treeBytes: 100_000 } }, 'IMPORT_LIMIT'],
  ['symlink', { files: citadelRepositoryFiles({ 'link': { content: 'target', mode: '120000' } }) }, 'IMPORT_UNSUPPORTED_MODE'],
  ['gitlink', { files: citadelRepositoryFiles({ 'module': { content: 'unused', mode: '160000' } }) }, 'IMPORT_UNSUPPORTED_MODE'],
  ['LFS', { files: citadelRepositoryFiles({ 'large.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:fixture\nsize 123\n' }) }, 'IMPORT_LFS_UNSUPPORTED'],
  ['compatibility', { files: { 'LICENSE': 'MIT fixture\n' } }, 'IMPORT_SOURCE_UNSUPPORTED'],
]) {
  test(`repository creation: rejects ${label} during preflight before creation`, async (t) => {
    const cx = await context(t, options);
    const op = await cx.service.prepare(cx.session, creation());
    await cx.service.settled();
    const current = await cx.service.status(cx.session, op.id);
    assert.equal(current.state, 'failed');
    assert.equal(current.error.code, code);
    assert.equal(writes(cx.mock).length, 0);
  });
}

for (const corruption of ['base64', 'size', 'hash', 'tree', 'unsafe path', 'missing directory']) {
  test(`repository creation: strict preflight rejects ${corruption} corruption`, async (t) => {
    const cx = await context(t);
    let applied = false;
    cx.mock.after = (call, response) => {
      if (applied || !call.path.startsWith('/repos/fixture-upstream/')) return;
      if (['base64', 'size', 'hash'].includes(corruption) && call.path.includes('/git/blobs/')) {
        applied = true;
        if (corruption === 'base64') response.data.content = '%%%invalid';
        if (corruption === 'size') response.data.size += 1;
        if (corruption === 'hash') response.data.content = Buffer.alloc(response.data.size, 0x41).toString('base64');
      }
      if (['tree', 'unsafe path', 'missing directory'].includes(corruption) && call.path.includes('?recursive=1')) {
        applied = true;
        if (corruption === 'tree') response.data.tree[0].sha = 'f'.repeat(40);
        if (corruption === 'unsafe path') response.data.tree[0].path = '../escape';
        if (corruption === 'missing directory') response.data.tree = response.data.tree.filter((entry) => entry.path !== 'bicep');
      }
    };
    const op = await cx.service.prepare(cx.session, creation());
    await cx.service.settled();
    assert.equal((await cx.service.status(cx.session, op.id)).state, 'failed');
    assert.equal(writes(cx.mock).length, 0);
  });
}

test('repository creation: input shape rejects owner/public overrides and no caller secrets are journaled', async (t) => {
  const cx = await context(t);
  for (const extra of [{ owner: 'someone' }, { private: false }, { public: true }, { token: 'not-accepted' }]) {
    await assert.rejects(cx.service.prepare(cx.session, creation('bad', extra)), { code: 'IMPORT_INVALID_INPUT' });
  }
  await assert.rejects(cx.service.prepare(cx.session, creation('../bad')), { code: 'IMPORT_INVALID_INPUT' });
  await assert.rejects(cx.service.prepare(cx.session, creation('bad', { sourceUrl: 'https://evil.example/source' })), { code: 'IMPORT_INVALID_INPUT' });
  const op = await ready(cx);
  await finish(cx, op);
  const paths = await readdir(cx.dataRoot);
  assert.deepEqual(paths, ['repository-creations.json']);
  const journal = await readFile(join(cx.dataRoot, paths[0]), 'utf8');
  assert(!journal.includes(cx.session.token));
  assert(!journal.includes('key-private-copy-0001'), 'only operation key hash persists');
  assert(!journal.includes('"token"'));
  assert(!journal.includes('"session"'));
  assert(!journal.includes('fixtureMain'), 'no source contents persisted');
  assert(!JSON.stringify(await cx.service.list(cx.session)).includes(cx.session.token));
});

test('repository creation: duplicate operation keys and concurrent destination reservations are serialized', async (t) => {
  const cx = await context(t);
  const results = await Promise.all([cx.service.prepare(cx.session, creation()), cx.service.prepare(cx.session, creation())]);
  assert.equal(results[0].id, results[1].id);
  await assert.rejects(cx.service.prepare(cx.session, creation('different', { operationKey: creation().operationKey })), { code: 'IMPORT_KEY_CONFLICT' });
  await assert.rejects(cx.service.prepare(cx.session, creation('PRIVATE-COPY', { operationKey: 'another-operation-key' })), { code: 'IMPORT_DESTINATION_RESERVED' });
  await cx.service.settled();
  await Promise.all([cx.service.start(cx.session, results[0].id), cx.service.start(cx.session, results[0].id)]);
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, results[0].id)).state, 'complete');
  assert.equal(writes(cx.mock).filter((call) => call.path === '/user/repos').length, 1);
});

test('repository creation: existing destination and create collision are never adopted or overwritten', async (t) => {
  const cx = await context(t);
  const existing = cx.mock.repository('fixture-owner/private-copy');
  cx.mock.seed(existing, 'main', { 'precious': 'never overwrite\n' });
  const before = cx.mock.snapshot(existing);
  const op = await ready(cx);
  const result = await finish(cx, op);
  assert.equal(result.error.code, 'IMPORT_DESTINATION_EXISTS');
  assert.equal(writes(cx.mock).length, 0);
  assert.deepEqual(cx.mock.snapshot(existing), before);
  const second = await ready(cx, creation('racing-copy'));
  cx.mock.before = (call) => {
    if (call.path === '/user/repos') cx.mock.repository('fixture-owner/racing-copy');
  };
  const collision = await finish(cx, second);
  assert.equal(collision.state, 'failed');
  cx.mock.before = null;
  await cx.service.resume(cx.session, second.id);
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, second.id)).error.code, 'IMPORT_DESTINATION_CHANGED');
  assert.equal(writes(cx.mock).filter((call) => call.path === '/user/repos').length, 1);
});

test('repository creation: lost create response adopts only nonce-proven private owner and reuses the original operation', async (t) => {
  const cx = await context(t);
  const op = await ready(cx);
  cx.mock.after = (call) => { if (call.path === '/user/repos') throw lost(); };
  const first = await finish(cx, op);
  assert.equal(first.state, 'failed');
  assert.equal(first.created, false, 'ambiguous create is not claimed as proven');
  assert(destination(cx.mock));
  cx.mock.after = null;
  const again = await cx.service.prepare(cx.session, creation());
  assert.equal(again.id, op.id);
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  const complete = await cx.service.status(cx.session, op.id);
  assert.equal(complete.state, 'complete', JSON.stringify(complete.error));
  assert.equal(writes(cx.mock).filter((call) => call.path === '/user/repos').length, 1);
  assert.deepEqual(cx.mock.snapshot(destination(cx.mock)), cx.mock.snapshot(cx.mock.source, 'citadel-v1'));
});

for (const change of ['owner', 'privacy', 'nonce', 'id', 'renamed']) {
  test(`repository creation: destination ${change} mismatch refuses all source writes`, async (t) => {
    const cx = await context(t);
    const op = await ready(cx);
    cx.mock.after = (call, response) => {
      if (call.path !== '/user/repos') return;
      const repo = destination(cx.mock);
      if (change === 'owner') repo.owner.id = 303;
      if (change === 'privacy') repo.private = false;
      if (change === 'nonce') repo.description = 'unrelated';
      if (change === 'id') repo.id += 1;
      if (change === 'renamed') repo.full_name = 'fixture-owner/renamed';
      if (change !== 'id') response.data = cx.mock.metadata(repo);
    };
    const result = await finish(cx, op);
    assert.equal(result.state, 'paused');
    assert.equal(result.error.code, 'IMPORT_DESTINATION_CHANGED');
    assert.equal(writes(cx.mock).length, 1);
  });
}

test('repository creation: wrong live GitHub identity and wrong session account are refused', async (t) => {
  const cx = await context(t);
  const op = await ready(cx);
  await assert.rejects(cx.service.start({ ...cx.session, accountId: 999 }, op.id), { status: 404 });
  assert.deepEqual(await cx.service.list({ ...cx.session, accountId: 999 }), { operations: [] });
  cx.mock.identity.id = 999;
  const current = await finish(cx, op);
  assert.equal(current.error.code, 'IMPORT_WRONG_ACCOUNT');
  assert.equal(writes(cx.mock).length, 0);
});

test('repository creation: prepare and start return promptly, pause checkpoints already-sent writes', async (t) => {
  const cx = await context(t);
  const preflight = barrier();
  cx.mock.before = async (call) => { if (call.path === '/repos/fixture-upstream/source') await preflight.block(); };
  const op = await cx.service.prepare(cx.session, creation());
  assert.equal(op.state, 'preparing');
  await preflight.reached;
  const pausing = await cx.service.pause(cx.session, op.id);
  assert.equal(pausing.stage, 'Pausing after the current request finishes.');
  preflight.release();
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, op.id)).state, 'paused');
  assert.equal(writes(cx.mock).length, 0);
  cx.mock.before = null;
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, op.id)).state, 'ready');
  const sent = barrier();
  cx.mock.after = async (call) => { if (call.path === '/user/repos') await sent.block(); };
  const starting = await cx.service.start(cx.session, op.id);
  assert.notEqual(starting.state, 'complete');
  await sent.reached;
  await cx.service.pause(cx.session, op.id);
  sent.release();
  await cx.service.settled();
  const paused = await cx.service.status(cx.session, op.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.created, true, 'already-created result was checkpointed');
  assert.equal(writes(cx.mock).length, 1);
});

test('repository creation: clearing mutable session token stops every subsequent outward operation', async (t) => {
  const cx = await context(t);
  const op = await ready(cx);
  cx.mock.after = (call) => { if (call.path === '/user/repos') cx.session.token = null; };
  await cx.service.start(cx.session, op.id);
  await cx.service.settled();
  assert.equal(writes(cx.mock).length, 1);
  assert.equal(cx.mock.calls.at(-1).path, '/user/repos');
  const reconnected = { ...IMPORT_SESSION };
  const paused = await cx.service.status(reconnected, op.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.error.code, 'IMPORT_AUTH_REQUIRED');
  assert.equal(paused.created, true);
});

test('repository creation: restart resumes pinned source but never authorizes a read-only preparation', async (t) => {
  const cx = await context(t);
  const op = await ready(cx);
  await cx.service.shutdown();
  const restarted = new RepositoryCreationService(cx.config);
  await restarted.initialize();
  t.after(() => restarted.shutdown());
  assert.equal((await restarted.status(cx.session, op.id)).state, 'paused');
  cx.mock.seed(cx.mock.source, 'citadel-v1', citadelRepositoryFiles({ 'new-not-pinned': 'changed\n' }));
  await restarted.resume({ ...IMPORT_SESSION }, op.id);
  await restarted.settled();
  const checked = await restarted.status(cx.session, op.id);
  assert.equal(checked.state, 'ready');
  assert.equal(checked.source.commit, op.source.commit);
  assert.equal(writes(cx.mock).length, 0);
  await restarted.start(cx.session, op.id);
  await restarted.settled();
  assert.equal((await restarted.status(cx.session, op.id)).state, 'complete');
  assert(!cx.mock.snapshot(destination(cx.mock)).some((entry) => entry.path === 'new-not-pinned'));
});

test('repository creation: partial write failure retains private repository and survives restart and resume', async (t) => {
  const cx = await context(t, { files: citadelRepositoryFiles({ 'binary': Buffer.from([0, 1, 255]) }) });
  const op = await ready(cx);
  let treeWrites = 0;
  cx.mock.before = (call) => { if (call.method === 'POST' && call.path.endsWith('/git/trees') && ++treeWrites === 2) throw lost(); };
  const failed = await finish(cx, op);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.created, true);
  assert(failed.error.message.includes('retained'));
  const repositoryId = failed.destination.repositoryId;
  await cx.service.shutdown();
  const restarted = new RepositoryCreationService(cx.config);
  await restarted.initialize();
  t.after(() => restarted.shutdown());
  cx.mock.before = null;
  await restarted.resume({ ...IMPORT_SESSION }, op.id);
  await restarted.settled();
  const result = await restarted.status(cx.session, op.id);
  assert.equal(result.state, 'complete', JSON.stringify(result.error));
  assert.equal(result.destination.repositoryId, repositoryId);
  assert.equal(writes(cx.mock).filter((call) => call.path === '/user/repos').length, 1);
  assert.deepEqual(cx.mock.snapshot(destination(cx.mock)), cx.mock.snapshot(cx.mock.source, 'citadel-v1'));
});

test('repository creation: non-main bootstrap publishes its snapshot then renames to main without deleting refs', async (t) => {
  const cx = await context(t, { bootstrapBranch: 'master' });
  const op = await ready(cx);
  const complete = await finish(cx, op);
  assert.equal(complete.state, 'complete', JSON.stringify(complete.error));
  const repo = destination(cx.mock);
  assert.equal(repo.default_branch, 'main');
  assert.deepEqual([...repo.refs.keys()], ['main']);
  assert.deepEqual(cx.mock.snapshot(repo), cx.mock.snapshot(cx.mock.source, 'citadel-v1'));
  const deletion = writes(cx.mock).filter((call) => call.method === 'DELETE');
  assert.deepEqual(deletion, []);
  assert.ok(writes(cx.mock).some((call) => call.path.endsWith('/git/refs/heads/master') && call.method === 'PATCH'));
  assert.ok(writes(cx.mock).some((call) => call.path.endsWith('/branches/master/rename') && call.body.new_name === 'main'));
});

for (const endpoint of ['/git/blobs', '/git/trees', '/git/commits', '/git/refs/heads/main', '/git/refs/heads/master', '/actions/permissions', '/branches/master/rename']) {
  test(`repository creation: lost ${endpoint} response reconciles deterministic writes without false success`, async (t) => {
    const workflows = endpoint === '/actions/permissions';
    const cx = await context(t, {
      bootstrapBranch: endpoint.includes('master') ? 'master' : 'main',
      files: citadelRepositoryFiles({
        ...(workflows ? { '.github/workflows/build.yml': 'on: push\njobs: {}\n' } : {}),
        ...(endpoint === '/git/blobs' ? { 'binary': Buffer.from([0, 0xff, 1]) } : {}),
      }),
    });
    const op = await ready(cx);
    let lostOnce = false;
    cx.mock.after = (call) => {
      const match = call.method !== 'GET' && call.path.endsWith(endpoint);
      if (match && !lostOnce) { lostOnce = true; throw lost(); }
    };
    const incomplete = await finish(cx, op);
    assert.equal(lostOnce, true);
    assert.notEqual(incomplete.state, 'complete');
    assert.equal(incomplete.created, true);
    cx.mock.after = null;
    await cx.service.resume(cx.session, op.id);
    await cx.service.settled();
    const complete = await cx.service.status(cx.session, op.id);
    assert.equal(complete.state, 'complete', JSON.stringify(complete.error));
    assert.deepEqual(cx.mock.snapshot(destination(cx.mock)), cx.mock.snapshot(cx.mock.source, 'citadel-v1'));
    if (endpoint === '/git/commits') {
      const requests = writes(cx.mock).filter((call) => call.path.endsWith('/git/commits'));
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[0].body, requests[1].body);
      assert.equal(destination(cx.mock).commits.size, 2, 'deterministic retry reuses commit');
    }
  });
}

for (const branch of ['main', 'master']) {
  test(`repository creation: externally advanced ${branch} is never overwritten or deleted`, async (t) => {
    const cx = await context(t, { bootstrapBranch: branch });
    const op = await ready(cx);
    let externalHead;
    cx.mock.after = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/git/commits')) {
        const repo = destination(cx.mock);
        externalHead = cx.mock.seed(repo, branch, { 'external': 'preserve me\n' }, [repo.refs.get(branch)]);
      }
    };
    const current = await finish(cx, op);
    assert.equal(current.state, 'paused');
    assert.equal(current.error.code, 'IMPORT_DESTINATION_CHANGED');
    assert.equal(destination(cx.mock).refs.get(branch), externalHead);
    assert(!writes(cx.mock).some((call) => call.method === 'DELETE'));
    assert(!writes(cx.mock).some((call) => call.path.endsWith('/git/refs/heads/main')));
  });
}

test('repository creation: workflow sources disable Actions before any source writes and leave them disabled', async (t) => {
  const cx = await context(t, { files: citadelRepositoryFiles({ '.github/workflows/ci.yml': 'on: push\njobs: {}\n' }) });
  const op = await ready(cx);
  assert.equal(op.source.hasWorkflows, true);
  assert.equal(op.actionsDisabled, false);
  const current = await finish(cx, op);
  assert.equal(current.state, 'complete', JSON.stringify(current.error));
  assert.equal(current.actionsDisabled, true);
  assert.equal(destination(cx.mock).actionsEnabled, false);
  const writeCalls = writes(cx.mock);
  assert.equal(writeCalls[1].path, '/repos/fixture-owner/private-copy/actions/permissions');
  assert.deepEqual(writeCalls[1].body, { enabled: false });
  assert(cx.mock.snapshot(destination(cx.mock)).some((file) => file.path === '.github/workflows/ci.yml'));
});

test('repository creation: Actions re-enabled externally and final manifest corruption cannot report success', async (t) => {
  const cx = await context(t, { files: citadelRepositoryFiles({ '.github/workflows/ci.yml': 'on: push\n' }) });
  const op = await ready(cx);
  cx.mock.after = (call) => {
    if (call.method === 'POST' && call.path.endsWith('/git/trees')) destination(cx.mock).actionsEnabled = true;
  };
  const paused = await finish(cx, op);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.error.code, 'IMPORT_ACTIONS_ENABLED');
  assert.equal(writes(cx.mock).filter((call) => call.path.endsWith('/git/commits')).length, 0);
  cx.mock.after = null;
  destination(cx.mock).actionsEnabled = false;
  let corrupted = false;
  cx.mock.after = (call, response) => {
    if (call.path.startsWith('/repos/fixture-owner/') && call.path.includes('?recursive=1') &&
        destination(cx.mock).refs.get('main') !== [...destination(cx.mock).commits.keys()][0]) {
      response.data.tree.pop();
      corrupted = true;
    }
  };
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  assert(corrupted);
  assert.equal((await cx.service.status(cx.session, op.id)).state, 'failed');
  assert(!cx.notes.some((note) => note.outcome === 'ok'));
});

test('repository creation: durable rolling write budget and API retry metadata pause rather than sleeping for hours', async (t) => {
  const cx = await context(t, { limits: { writesPerMinute: 2, writesPerHour: 3 } });
  const op = await ready(cx);
  const limited = await finish(cx, op);
  assert.equal(limited.state, 'paused');
  assert.equal(limited.error.code, 'IMPORT_RATE_LIMITED');
  const count = writes(cx.mock).length;
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  assert.equal(writes(cx.mock).length, count);
  cx.advance(60_001);
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  assert.equal(writes(cx.mock).length, 3, 'hourly budget persists across minute windows');
  await cx.service.shutdown();
  const restarted = new RepositoryCreationService(cx.config);
  await restarted.initialize();
  t.after(() => restarted.shutdown());
  await restarted.resume(cx.session, op.id);
  await restarted.settled();
  assert.equal(writes(cx.mock).length, 3);
});

test('repository creation: secondary API limits preserve retry-after and block immediate resume', async (t) => {
  const cx = await context(t);
  const op = await ready(cx);
  cx.mock.before = (call) => {
    if (call.path === '/user/repos') throw githubError(403, 'GITHUB_RATE_LIMITED', 'fixture', {
      retryAfterSeconds: 120, rateResetAt: new Date(cx.config.now() + 180_000).toISOString(),
    });
  };
  const current = await finish(cx, op);
  assert.equal(current.state, 'paused');
  const count = cx.mock.calls.length;
  cx.advance(121_000);
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  assert.equal(cx.mock.calls.length, count);
  cx.advance(60_000);
  cx.mock.before = null;
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, op.id)).state, 'complete');
});

test('repository creation: multiple jobs use one runner and one bounded source cache', async (t) => {
  const cx = await context(t);
  let active = 0, maximum = 0;
  cx.mock.before = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  };
  const [first, second] = await Promise.all([
    cx.service.prepare(cx.session, creation('one')), cx.service.prepare(cx.session, creation('two')),
  ]);
  await cx.service.settled();
  assert.equal(maximum, 1);
  assert.equal(cx.service.cache.id, second.id);
  await Promise.all([cx.service.start(cx.session, first.id), cx.service.start(cx.session, second.id)]);
  await cx.service.settled();
  assert.equal(maximum, 1);
  assert.equal((await cx.service.status(cx.session, first.id)).state, 'complete');
  assert.equal((await cx.service.status(cx.session, second.id)).state, 'complete');
  assert.equal(cx.service.cache, null);
});

test('repository creation: checkpointed but garbage-collected objects are safely recreated on resume', async (t) => {
  const cx = await context(t, { files: citadelRepositoryFiles({ 'binary': Buffer.from([0, 0xff, 1]) }) });
  const op = await ready(cx);
  cx.mock.before = (call) => { if (call.method === 'PATCH' && call.path.endsWith('/git/refs/heads/main')) throw lost(); };
  const partial = await finish(cx, op);
  assert.equal(partial.state, 'failed');
  const repo = destination(cx.mock);
  const bootstrapHead = repo.refs.get('main');
  const bootstrapCommit = repo.commits.get(bootstrapHead);
  const bootstrapTree = repo.trees.get(bootstrapCommit.tree.sha);
  const bootstrapBlob = bootstrapTree[0].sha;
  const expectedCommit = [...repo.commits.keys()].find((value) => value !== bootstrapHead);
  // Model collection of every unreferenced imported object.
  repo.commits = new Map([[bootstrapHead, bootstrapCommit]]);
  repo.trees = new Map([[bootstrapCommit.tree.sha, bootstrapTree]]);
  repo.blobs = new Map([[bootstrapBlob, repo.blobs.get(bootstrapBlob)]]);
  cx.mock.before = null;
  await cx.service.resume(cx.session, op.id);
  await cx.service.settled();
  const complete = await cx.service.status(cx.session, op.id);
  assert.equal(complete.state, 'complete', JSON.stringify(complete.error));
  assert.equal(repo.refs.get('main'), expectedCommit);
  assert.deepEqual(cx.mock.snapshot(repo), cx.mock.snapshot(cx.mock.source, 'citadel-v1'));
});

test('repository creation: final privacy change is not reported as success or followed by writes', async (t) => {
  const cx = await context(t);
  const op = await ready(cx);
  let published = false, corrupted = false;
  cx.mock.after = (call) => {
    if (call.method === 'PATCH' && call.path.endsWith('/git/refs/heads/main')) published = true;
    if (published && call.method === 'GET' && call.path.includes('/git/blobs/') &&
        call.path.startsWith('/repos/fixture-owner/')) {
      destination(cx.mock).private = false;
      corrupted = true;
    }
  };
  const final = await finish(cx, op);
  assert(corrupted);
  assert.equal(final.state, 'paused');
  assert.equal(final.error.code, 'IMPORT_DESTINATION_CHANGED');
  assert(!cx.notes.some((note) => note.outcome === 'ok'));
  assert.equal(writes(cx.mock).at(-1).path, '/repos/fixture-owner/private-copy/git/refs/heads/main');
});

test('repository creation: shutdown checkpoints queued and in-flight jobs without auto-restarting them', async (t) => {
  const cx = await context(t);
  const held = barrier();
  cx.mock.before = async (call) => { if (call.path === '/repos/fixture-upstream/source') await held.block(); };
  const first = await cx.service.prepare(cx.session, creation('shutdown-one'));
  const second = await cx.service.prepare(cx.session, creation('shutdown-two'));
  await held.reached;
  assert.equal(cx.service.shutdown(), undefined, 'shutdown cancellation is synchronous');
  held.release();
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, first.id)).state, 'paused');
  assert.equal((await cx.service.status(cx.session, second.id)).state, 'paused');
  assert.equal(cx.mock.calls.length, 1);
  assert.equal(cx.service.cache, null);
  const restarted = new RepositoryCreationService(cx.config);
  const before = cx.mock.calls.length;
  await restarted.initialize();
  await restarted.settled();
  t.after(() => restarted.shutdown());
  assert.equal(cx.mock.calls.length, before, 'initialize never resumes network work');
});

test('repository creation: synthetic baseline-scale 363 files and 20,303,635 bytes fit defaults without filtering', async (t) => {
  const files = citadelRepositoryFiles({ 'LICENSE': 'MIT fixture license preserved\n' });
  // Match the independently measured source mix, not its actual copyrighted
  // contents: 312 UTF-8 files, 51 binaries, 351 distinct blob hashes, 70 dirs.
  // Executable fidelity has separate coverage; the real default has no execs.
  files['scripts/deploy.sh'].mode = '100644';
  const textPaths = [];
  for (let i = 0; i < 303; i += 1) {
    const path = `directory-${String(i % 64).padStart(2, '0')}/file-${i}.txt`;
    textPaths.push(path);
    files[path] = i < 24 ? `Repeated text group ${i % 12}\n` : `Synthetic full snapshot file ${i}\r\n`;
  }
  // Its encoded JSON content exceeds 1 MiB but fits the service's 16 MiB
  // complete-tree bound, so this valid large file remains one exact inline blob.
  files[textPaths[24]] = 'L'.repeat(1_181_213);
  assert.equal(Buffer.byteLength(JSON.stringify(files[textPaths[24]])), 1_181_215);
  const bytesOf = (value) => Buffer.byteLength(typeof value === 'object' && !Buffer.isBuffer(value) ? value.content : value);
  let remainingText = 11_169_347 - Object.values(files).reduce((total, value) => total + bytesOf(value), 0);
  for (let i = 25; i < textPaths.length; i += 1) {
    const padding = Math.floor(remainingText / (textPaths.length - i));
    files[textPaths[i]] += 'x'.repeat(padding);
    remainingText -= padding;
  }
  assert.equal(remainingText, 0);
  assert.equal(Object.keys(files).length, 312);
  assert.equal(Object.values(files).reduce((total, value) => total + bytesOf(value), 0), 11_169_347);
  let remainingBinary = 9_134_288;
  for (let i = 0; i < 51; i += 1) {
    const size = i === 0 ? 3 * 1024 * 1024 : Math.floor(remainingBinary / (51 - i));
    const bytes = Buffer.alloc(size, i);
    bytes[0] = 0; // NUL ensures every one is classified as binary.
    files[`directory-${String(i % 64).padStart(2, '0')}/binary-${i}.${i === 0 ? 'pbix' : 'png'}`] = bytes;
    remainingBinary -= size;
  }
  assert.equal(remainingBinary, 0);
  assert.equal(Object.keys(files).length, 363);
  const cx = await context(t, { files, limits: { writeIntervalMs: 1100 } });
  const op = await ready(cx);
  assert.equal(op.source.totalBytes, 20_303_635);
  assert.equal(op.source.fileCount, 363);
  assert.equal(op.source.hasWorkflows, false);
  assert.equal(cx.mock.flatten(cx.mock.source, op.source.tree).length, 433);
  const sourceSnapshot = cx.mock.snapshot(cx.mock.source, 'citadel-v1');
  assert.equal(new Set(sourceSnapshot.map((entry) => entry.sha)).size, 351);
  assert(sourceSnapshot.every((entry) => entry.mode === '100644'));
  const complete = await finish(cx, op);
  assert.equal(complete.state, 'complete', JSON.stringify(complete.error));
  assert.equal(complete.source.tree, op.source.tree);
  assert.deepEqual(cx.mock.snapshot(destination(cx.mock)), sourceSnapshot);
  const writeCalls = writes(cx.mock);
  assert.equal(writeCalls.filter((call) => call.path.endsWith('/git/blobs')).length, 51);
  assert.equal(writeCalls.filter((call) => call.path.endsWith('/git/trees')).length, 71);
  assert(writeCalls.length < 150, '51 binary POSTs plus directory trees, not 363 blob POSTs');
  assert(writeCalls.filter((call) => call.path.endsWith('/git/trees')).some((call) =>
    call.body.tree.some((entry) => entry.content === files[textPaths[24]])));
});

test('repository creation: text above 1 MiB stays exact inline UTF-8 rather than a base64 blob write', async (t) => {
  const text = '\ufeff' + 'large XML-like text "with quotes"\r\n'.repeat(40_000);
  assert(Buffer.byteLength(text) > 1024 * 1024);
  const cx = await context(t, { files: citadelRepositoryFiles({ 'large.txt': text }) });
  const op = await ready(cx);
  const completed = await finish(cx, op);
  assert.equal(completed.state, 'complete', JSON.stringify(completed.error));
  assert.equal(writes(cx.mock).filter((call) => call.path.endsWith('/git/blobs')).length, 0);
  assert(cx.mock.snapshot(destination(cx.mock)).find((entry) => entry.path === 'large.txt').bytes.equals(Buffer.from(text)));
});

test('repository creation: unexpected commit metadata is rejected before updating main', async (t) => {
  const cx = await context(t);
  const op = await ready(cx);
  let importedSha;
  cx.mock.after = (call, response) => {
    if (call.method === 'POST' && call.path.endsWith('/git/commits')) importedSha = response.data.sha;
    if (importedSha && call.method === 'GET' && call.path.endsWith(`/git/commits/${importedSha}`)) {
      response.data.author.email = 'unexpected@example.invalid';
    }
  };
  const failed = await finish(cx, op);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'IMPORT_HASH_MISMATCH');
  assert.equal(failed.created, true);
  assert(!writes(cx.mock).some((call) => call.path.includes('/git/refs')));
});

test('repository creation: edited ready inputs supersede read-only preparation without authorizing creation', async (t) => {
  const cx = await context(t);
  const original = await ready(cx);
  const editedInput = creation('private-copy', {
    sourceUrl: 'https://github.com/fixture-upstream/source/tree/main', operationKey: 'edited-ready-operation',
  });
  const edited = await ready(cx, editedInput);
  assert.notEqual(edited.id, original.id);
  assert.equal(edited.source.ref, 'main');
  assert.equal(edited.canStart, true);
  assert.equal(writes(cx.mock).length, 0);
  const replaced = await cx.service.status(cx.session, original.id);
  assert.equal(replaced.state, 'paused');
  assert.equal(replaced.stage, 'Replaced by a newer read-only preparation.');
  assert.equal(replaced.error.code, 'IMPORT_SUPERSEDED');
  assert.equal(replaced.canStart, false);
  assert.equal(replaced.canResume, false);
  await assert.rejects(cx.service.start(cx.session, original.id), { code: 'IMPORT_SUPERSEDED' });
  await assert.rejects(cx.service.resume(cx.session, original.id), { code: 'IMPORT_SUPERSEDED' });
  const duplicate = await cx.service.prepare(cx.session, creation());
  assert.equal(duplicate.id, original.id, 'retained history preserves original operation-key identity');
  assert.equal(duplicate.canResume, false);
  await assert.rejects(cx.service.prepare(cx.session, { ...editedInput, operationKey: creation().operationKey }), { code: 'IMPORT_KEY_CONFLICT' });
  const complete = await finish(cx, edited);
  assert.equal(complete.state, 'complete');
  assert.equal(writes(cx.mock).filter((call) => call.path === '/user/repos').length, 1);
  assert.deepEqual(cx.mock.snapshot(destination(cx.mock)), cx.mock.snapshot(cx.mock.source, 'main'));
});

test('repository creation: correcting a failed read-only source can reuse the destination name', async (t) => {
  const cx = await context(t);
  const failed = await cx.service.prepare(cx.session, creation('private-copy', { sourceUrl: `${SOURCE_URL}/nonexistent` }));
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, failed.id)).state, 'failed');
  const corrected = await ready(cx, creation('private-copy', { operationKey: 'corrected-source-operation' }));
  assert.equal(writes(cx.mock).length, 0);
  assert.equal((await cx.service.status(cx.session, failed.id)).error.code, 'IMPORT_SUPERSEDED');
  const complete = await finish(cx, corrected);
  assert.equal(complete.state, 'complete');
});

test('repository creation: superseded read-only jobs remain unstartable after restart', async (t) => {
  const cx = await context(t);
  const original = await ready(cx);
  const replacement = await ready(cx, creation('private-copy', { operationKey: 'restart-replacement-operation' }));
  cx.service.shutdown();
  await cx.service.settled();
  const restarted = new RepositoryCreationService(cx.config);
  await restarted.initialize();
  t.after(async () => { restarted.shutdown(); await restarted.settled(); });
  const previous = await restarted.status(cx.session, original.id);
  assert.equal(previous.error.code, 'IMPORT_SUPERSEDED');
  assert.equal(previous.canResume, false);
  await assert.rejects(restarted.resume(cx.session, original.id), { code: 'IMPORT_SUPERSEDED' });
  await restarted.resume(cx.session, replacement.id);
  await restarted.settled();
  assert.equal((await restarted.status(cx.session, replacement.id)).state, 'ready');
  assert.equal(writes(cx.mock).length, 0);
});

test('repository creation: serialized start wins over replacement and protects authorized recovery intent', async (t) => {
  const cx = await context(t);
  const original = await ready(cx);
  cx.mock.before = (call) => { if (call.path === '/user') throw lost(); };
  const [started, replacement] = await Promise.allSettled([
    cx.service.start(cx.session, original.id),
    cx.service.prepare(cx.session, creation('private-copy', { operationKey: 'racing-new-operation' })),
  ]);
  assert.equal(started.status, 'fulfilled');
  assert.equal(replacement.status, 'rejected');
  assert.equal(replacement.reason.code, 'IMPORT_DESTINATION_RESERVED');
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, original.id)).state, 'failed');
  assert.equal(writes(cx.mock).length, 0);
  await assert.rejects(cx.service.prepare(cx.session, creation('private-copy', { operationKey: 'another-new-operation' })), { code: 'IMPORT_DESTINATION_RESERVED' });
  cx.mock.before = null;
  await cx.service.resume(cx.session, original.id);
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, original.id)).state, 'complete');
  assert.equal(writes(cx.mock).filter((call) => call.path === '/user/repos').length, 1);
});

test('repository creation: serialized replacement wins over stale start without creating twice', async (t) => {
  const cx = await context(t);
  const original = await ready(cx);
  const [replacement, staleStart] = await Promise.allSettled([
    cx.service.prepare(cx.session, creation('private-copy', { operationKey: 'replacement-wins-operation' })),
    cx.service.start(cx.session, original.id),
  ]);
  assert.equal(replacement.status, 'fulfilled');
  assert.equal(staleStart.status, 'rejected');
  assert.equal(staleStart.reason.code, 'IMPORT_SUPERSEDED');
  await cx.service.settled();
  assert.equal(writes(cx.mock).length, 0);
  const completed = await finish(cx, replacement.value);
  assert.equal(completed.state, 'complete');
  assert.equal(writes(cx.mock).filter((call) => call.path === '/user/repos').length, 1);
});

test('repository creation: bounded history evicts only inactive read-only intents, never retained repository recovery', async (t) => {
  const cx = await context(t, { limits: { operations: 2 } });
  const first = await cx.service.prepare(cx.session, creation('bad-one', { sourceUrl: `${SOURCE_URL}/missing` }));
  await cx.service.settled();
  const second = await cx.service.prepare(cx.session, creation('bad-two', { sourceUrl: `${SOURCE_URL}/missing` }));
  await cx.service.settled();
  const valid = await ready(cx, creation('valid-one'));
  assert.equal((await cx.service.list(cx.session)).operations.length, 2);
  await assert.rejects(cx.service.status(cx.session, first.id), { code: 'IMPORT_NOT_FOUND' });
  assert.equal((await cx.service.status(cx.session, second.id)).state, 'failed');
  cx.mock.before = (call) => { if (call.method === 'POST' && call.path.endsWith('/git/trees')) throw lost(); };
  const partial = await finish(cx, valid);
  assert.equal(partial.created, true);
  assert.equal(partial.state, 'failed');
  const next = await ready(cx, creation('valid-two'));
  await assert.rejects(cx.service.status(cx.session, second.id), { code: 'IMPORT_NOT_FOUND' });
  assert.equal((await cx.service.status(cx.session, valid.id)).destination.repositoryId, partial.destination.repositoryId);
  const last = await ready(cx, creation('valid-three'));
  await assert.rejects(cx.service.status(cx.session, next.id), { code: 'IMPORT_NOT_FOUND' });
  assert.equal((await cx.service.list(cx.session)).operations.length, 2);
  assert.equal((await cx.service.status(cx.session, last.id)).state, 'ready');
  cx.mock.before = null;
  await cx.service.resume(cx.session, valid.id);
  await cx.service.settled();
  assert.equal((await cx.service.status(cx.session, valid.id)).state, 'complete');
});

test('repository creation: synchronous shutdown clears default pacing timers and settled checkpoints the runner', async (t) => {
  const cx = await context(t);
  cx.service.wait = undefined; // Exercise the service-owned setTimeout path.
  cx.service.limits.writeIntervalMs = 1100;
  const reached = barrier();
  const pace = cx.service.pace.bind(cx.service);
  cx.service.pace = (ms) => {
    const pending = pace(ms);
    reached.release();
    return pending;
  };
  // This barrier's waiting promise is exposed through block().
  const pacingStarted = reached.block();
  const op = await ready(cx);
  await cx.service.start(cx.session, op.id);
  await pacingStarted;
  assert.equal(cx.service.pacingWaits.size, 1);
  assert.equal(cx.service.shutdown(), undefined);
  assert.equal(cx.service.stopping, true);
  assert.equal(cx.service.pacingWaits.size, 0, 'owned timer cancellation occurs synchronously');
  await cx.service.settled();
  const paused = await cx.service.status(cx.session, op.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.created, true);
  assert.equal(writes(cx.mock).length, 1, 'no write after shutdown while pacing');
  assert.equal(cx.service.cache, null);
});

test('repository creation: public stage labels are presentation-ready sentences', async (t) => {
  const cx = await context(t);
  const preparing = await cx.service.prepare(cx.session, creation());
  assert.match(preparing.stage, /^[A-Z].+\.$/);
  await cx.service.settled();
  const checked = await cx.service.status(cx.session, preparing.id);
  assert.equal(checked.stage, 'Source checked. Ready to create a private repository.');
  const complete = await finish(cx, checked);
  assert.equal(complete.stage, 'Private repository created and verified.');
});

test('repository creation: source commit identity is distinct from the requested canonical root tree', async (t) => {
  const cx = await context(t);
  const expectedCommit = cx.mock.sourceHead;
  const expectedTree = cx.mock.source.commits.get(expectedCommit).tree.sha;
  assert.notEqual(expectedCommit, expectedTree, 'a commit hash is not its root tree hash');
  const op = await ready(cx);
  assert.equal(op.source.commit, expectedCommit);
  assert.equal(op.source.tree, expectedTree);
  assert(cx.mock.calls.some((call) =>
    call.path === '/repos/fixture-upstream/source/commits/citadel-v1'));
  assert(cx.mock.calls.some((call) =>
    call.path === `/repos/fixture-upstream/source/git/trees/${expectedTree}?recursive=1`));
  assert(!cx.mock.calls.some((call) =>
    call.path.startsWith(`/repos/fixture-upstream/source/git/trees/${expectedCommit}`) ||
    call.path.startsWith('/repos/fixture-upstream/source/git/trees/citadel-v1')),
  'resolve commit.tree.sha first; never rely on the top-level sha of a named-ref tree response');
  assert.equal(writes(cx.mock).length, 0);
});

test('repository creation: normalized reviewed sourceUrl survives early failure and resumed preparation without source metadata', async (t) => {
  const cx = await context(t);
  cx.mock.before = (call) => {
    if (call.path === '/repos/fixture-upstream/source') throw lost();
  };
  const initial = await cx.service.prepare(cx.session, creation('reviewed-source', {
    sourceUrl: ' https://github.com/fixture-upstream/source/blob/citadel-v1/ ',
  }));
  assert.equal(initial.sourceUrl, SOURCE_URL);
  assert.equal(initial.source, null);
  await cx.service.settled();
  const failed = await cx.service.status(cx.session, initial.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.source, null);
  assert.equal(failed.sourceUrl, SOURCE_URL);
  assert.equal((await cx.service.list(cx.session)).operations[0].sourceUrl, SOURCE_URL);
  cx.service.shutdown();
  await cx.service.settled();

  const restarted = new RepositoryCreationService(cx.config);
  await restarted.initialize();
  t.after(async () => { restarted.shutdown(); await restarted.settled(); });
  const interrupted = await restarted.status(cx.session, initial.id);
  assert.equal(interrupted.state, 'paused');
  assert.equal(interrupted.source, null);
  assert.equal(interrupted.sourceUrl, SOURCE_URL);

  const held = barrier();
  cx.mock.before = async (call) => {
    if (call.path === '/repos/fixture-upstream/source') await held.block();
  };
  try {
    const resumed = await restarted.resume({ ...IMPORT_SESSION }, initial.id);
    assert.equal(resumed.sourceUrl, SOURCE_URL);
    assert.equal(resumed.source, null);
    await held.reached;
    const preparing = await restarted.status(cx.session, initial.id);
    assert.equal(preparing.state, 'preparing');
    assert.equal(preparing.source, null);
    assert.equal(preparing.sourceUrl, SOURCE_URL);
  } finally {
    held.release();
    await restarted.settled();
  }
  const checked = await restarted.status(cx.session, initial.id);
  assert.equal(checked.state, 'ready');
  assert.equal(checked.sourceUrl, SOURCE_URL);
  assert.equal(checked.source.ref, 'citadel-v1');
  assert.equal(writes(cx.mock).length, 0);
});
