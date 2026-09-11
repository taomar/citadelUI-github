import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { GitHubApiClient } from '../server/github/api.mjs';
import * as reader from '../server/github/git-reader.mjs';
import * as workspace from '../server/github/workspace.mjs';
import * as scan from '../server/github/scan-provider.mjs';
import { githubScanProvider as scanFacade } from '../server/github/compatibility.mjs';
import { MAX_TREE_ENTRIES } from '../server/github/repositories.mjs';
import { MAX_SOURCE_BYTES } from '../shared/source-scope.mjs';
import { nativeDocument } from '../shared/terraform/workspace.mjs';
import { nativeTransactionProof } from '../shared/terraform/review.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN } from './_github-mock.mjs';
import { nativeConfiguration, NATIVE_FILES } from './_native-fixture.mjs';

const TREE_RESPONSE_LIMIT = 24 * 1024 * 1024;
const blobResponseLimit = (bytes = MAX_SOURCE_BYTES) => Math.ceil(bytes * 1.4) + 4096;

function fixture(files = {}, options = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9701, fullName: 'synthetic/git-reader' });
  const branch = options.branch || 'main';
  const head = github.seed(repository, branch, files);
  const requests = [], transport = [], events = [];
  const client = new GitHubApiClient({
    fetch: async (href, init) => {
      const url = new URL(href);
      assert.equal(url.origin, 'https://api.github.com');
      const call = {
        method: init.method, path: url.pathname + url.search,
        body: init.body === undefined ? null : JSON.parse(init.body),
        redirect: init.redirect, cache: init.cache,
      };
      transport.push(call);
      events.push({ kind: 'request', ...call });
      return options.respond ? options.respond(href, init, github) : github.fetch(href, init);
    },
  });
  const request = client.request.bind(client);
  client.request = (path, requestOptions) => {
    requests.push({ path, ...requestOptions });
    return request(path, requestOptions);
  };
  return {
    github, repository, branch, head, treeSha: github.commits.get(head).tree,
    client, requests, transport, events, options,
    args: [client, TEST_TOKEN, repository.full_name],
    base: `/repos/${repository.full_name}/git`,
  };
}

function clearTrace(f) {
  f.requests.length = 0;
  f.transport.length = 0;
  f.events.length = 0;
}

function get(f, suffix, limit) {
  return { path: `${f.base}/${suffix}`, token: TEST_TOKEN, ...(limit === undefined ? {} : { limit }) };
}

function treeReads(f) {
  return [get(f, `commits/${f.head}`), get(f, `trees/${f.treeSha}?recursive=1`, TREE_RESPONSE_LIMIT)];
}

function assertReads(f, expected) {
  assert.deepEqual(f.requests, expected);
  assert.deepEqual(f.transport, expected.map(({ path }) => ({
    method: 'GET', path, body: null, redirect: 'manual', cache: 'no-store',
  })));
}

function entryAt(f, alias) {
  return f.github.flatten(f.treeSha).find((entry) => entry.path === alias);
}

function objectState(f) {
  return {
    blobs: f.github.blobs.size, trees: f.github.trees.size, commits: f.github.commits.size,
    refs: [...f.repository.refs],
  };
}

test('H4 Git reader: facades retain the same functions and private helpers stay private', () => {
  const signatures = {
    branchHead: 4, requireBranchHead: 4, loadTree: 4, treeIndex: 4,
    resolveEntry: 6, readBlob: 4, readSourceBlob: 7, lookupPath: 5,
  };
  assert.deepEqual(Object.keys(reader).sort(), [...Object.keys(signatures), 'encodePath'].sort());
  for (const [name, arity] of Object.entries(signatures)) {
    assert.equal(workspace[name], reader[name], name);
    assert.equal(reader[name].length, arity, name);
  }
  assert.deepEqual(Object.keys(scan), ['githubScanProvider']);
  assert.equal(scanFacade, scan.githubScanProvider);
  assert.equal(scan.githubScanProvider.length, 4);
});

test('H4 Git reader: branch heads are re-read and path segments keep their exact encoding', async () => {
  const branch = 'review/\u03a9#100%';
  const f = fixture({ 'main.bicepparam': 'param value = 1\n' }, { branch });
  const encoded = 'review/%CE%A9%23100%25';
  assert.equal(reader.encodePath(branch), encoded);
  assert.equal(await reader.branchHead(...f.args, ` ${branch} `), f.head);
  const moved = f.github.seed(f.repository, branch, { 'main.bicepparam': 'param value = 2\n' }, { parents: [f.head] });
  assert.equal(await reader.requireBranchHead(...f.args, branch), moved);
  assert.equal(await reader.branchHead(...f.args, branch), moved);
  assertReads(f, Array.from({ length: 3 }, () => get(f, `ref/heads/${encoded}`)));
});

test('H4 Git reader: absent refs differ from invalid names and required missing branches', async () => {
  const f = fixture();
  assert.equal(await reader.branchHead(...f.args, 'missing'), null);
  await assert.rejects(reader.requireBranchHead(...f.args, 'missing'), {
    status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch missing no longer exists.',
  });
  await assert.rejects(reader.branchHead(...f.args, '../main'), { status: 400, code: 'INVALID_BRANCH' });
  assertReads(f, [get(f, 'ref/heads/missing'), get(f, 'ref/heads/missing')]);
});

for (const failure of [
  { name: 'non-commit ref', status: 200, data: { object: { type: 'tree', sha: 'a'.repeat(40) } },
    expected: { status: 409, code: 'AMBIGUOUS_REF', message: 'That branch does not resolve to a commit.' } },
  { name: 'malformed commit SHA', status: 200, data: { object: { type: 'commit', sha: 'short' } },
    expected: { status: 400, code: 'INVALID_SHA', message: 'A full commit SHA is required.' } },
  { name: 'permission refusal', status: 403, data: { message: 'Forbidden' },
    expected: { status: 403, code: 'GITHUB_REQUEST_FAILED', message: 'GitHub denied the request. Check the token repository permissions.' } },
  { name: 'rate limit', status: 429, data: { message: 'Rate limit' },
    expected: { status: 429, code: 'GITHUB_RATE_LIMITED', retryAfterSeconds: null, rateResetAt: null } },
  { name: 'upstream failure', status: 500, data: { message: 'Unavailable' },
    expected: { status: 502, code: 'GITHUB_REQUEST_FAILED', message: 'GitHub is unavailable. Try again later.' } },
]) {
  test(`H4 Git reader: ${failure.name} is propagated without retry or a false absent result`, async () => {
    const f = fixture({}, { respond: (_href, _init, github) => github.json(failure.status, failure.data) });
    await assert.rejects(reader.branchHead(...f.args, 'main'), { ...failure.expected, github: true });
    assertReads(f, [get(f, 'ref/heads/main')]);
  });
}

function mixedTree() {
  return {
    '.azure/dev/.env': 'SYNTHETIC_SETTING="untouched"\n',
    '.github/hidden.xml': '<hidden />\n',
    'README.md': '# Not an editor source\n',
    'bicep/main.bicepparam': { content: 'param value = 1\n', mode: '100755' },
    'bicep/linked.xml': { content: '../README.md', mode: '120000' },
    'bicep/vendor.bicepparam': { content: 'synthetic submodule', mode: '160000' },
    'bicep/odd.xml': { content: '<odd />\n', mode: '100600' },
    'bicep/occupied.bicepparam/inner.xml': '<inner />\n',
  };
}

test('H4 Git reader: enumeration, regular-blob indexes and complete occupancy stay distinct', async () => {
  const f = fixture(mixedTree()), state = objectState(f);
  const snapshot = await reader.loadTree(...f.args, f.head);
  assert.deepEqual(snapshot.files.map(({ alias, mode }) => ({ alias, mode })), [
    { alias: 'bicep/main.bicepparam', mode: '100755' },
    { alias: 'bicep/occupied.bicepparam/inner.xml', mode: '100644' },
  ]);
  assert.deepEqual(snapshot.rejected, [
    { path: 'bicep/linked.xml', reason: 'symlink' },
    { path: 'bicep/odd.xml', reason: 'unsupported-mode' },
    { path: 'bicep/vendor.bicepparam', reason: 'submodule' },
  ]);
  assert.equal(snapshot.commit, f.head);
  assert.equal(snapshot.treeSha, f.treeSha);
  assert.equal(snapshot.truncated, false);
  const regular = await reader.treeIndex(...f.args, f.head);
  assert.deepEqual([...regular.keys()].sort(), [
    '.azure/dev/.env', '.github/hidden.xml', 'README.md',
    'bicep/main.bicepparam', 'bicep/occupied.bicepparam/inner.xml',
  ]);
  const allBlobs = await reader.treeIndex(...f.args, f.head, { includeAll: true });
  assert.equal(allBlobs.get('bicep/linked.xml').mode, '120000');
  assert.equal(allBlobs.get('bicep/odd.xml').mode, '100600');
  assert.equal(allBlobs.has('bicep/vendor.bicepparam'), false);
  const complete = await reader.treeIndex(...f.args, f.head, { complete: true });
  for (const [alias, type, mode] of [
    ['bicep/occupied.bicepparam', 'tree', '040000'],
    ['bicep/vendor.bicepparam', 'commit', '160000'],
    ['bicep/linked.xml', 'blob', '120000'],
  ]) {
    const resolved = await reader.resolveEntry(...f.args, f.head, alias, complete);
    assert.deepEqual(resolved, { sha: entryAt(f, alias).sha, mode, size: entryAt(f, alias).size || 0, type });
  }
  assert.equal(await reader.resolveEntry(...f.args, f.head, 'bicep/absent.xml', complete), null);
  assertReads(f, [...treeReads(f), ...treeReads(f), ...treeReads(f), ...treeReads(f)]);
  assert.deepEqual(objectState(f), state);
});

test('H4 Git reader: truncated fallback skips enumeration paths but exact lookup still sees occupied paths', async () => {
  const f = fixture(mixedTree());
  f.github.truncateTrees = true;
  const bicep = entryAt(f, 'bicep').sha;
  const occupied = entryAt(f, 'bicep/occupied.bicepparam').sha;
  const fallback = [...treeReads(f), get(f, `trees/${f.treeSha}`), get(f, `trees/${bicep}`), get(f, `trees/${occupied}`)];
  const snapshot = await reader.loadTree(...f.args, f.head);
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.files.map((file) => file.alias), ['bicep/main.bicepparam', 'bicep/occupied.bicepparam/inner.xml']);
  const index = await reader.treeIndex(...f.args, f.head, { complete: true });
  assert.equal(index.truncated, true);
  assert.equal(index.has('.azure/dev/.env'), false);
  assert.equal(index.has('.github/hidden.xml'), false);
  assert.equal(index.has('bicep/occupied.bicepparam'), false);
  assertReads(f, [...fallback, ...fallback]);
  clearTrace(f);

  const alias = '.azure/dev/.env';
  assert.deepEqual(await reader.resolveEntry(...f.args, f.head, alias, index), entryAt(f, alias));
  assertReads(f, [
    get(f, `commits/${f.head}`), get(f, `trees/${f.treeSha}`),
    get(f, `trees/${entryAt(f, '.azure').sha}`), get(f, `trees/${entryAt(f, '.azure/dev').sha}`),
  ]);
  clearTrace(f);
  assert.deepEqual(await reader.resolveEntry(...f.args, f.head, 'bicep/occupied.bicepparam', index), {
    ...entryAt(f, 'bicep/occupied.bicepparam'), size: 0,
  });
  assertReads(f, [get(f, `commits/${f.head}`), get(f, `trees/${f.treeSha}`), get(f, `trees/${bicep}`)]);
});

test('H4 Git reader: native inventory does not grant authority over unselected value files', async () => {
  const configuration = nativeConfiguration(['llm']);
  const unselected = 'llm-backend-onboarding/unselected.tfvars';
  const f = fixture({
    ...NATIVE_FILES, [unselected]: 'apim_name = "unselected"\n',
    'terraform.tfstate': '{}\n', '.terraform/cache.tfvars': 'name = "excluded"\n',
    'main.bicepparam': 'param value = 1\n',
  });
  const selected = await reader.loadTree(...f.args, f.head, configuration);
  assert.deepEqual(selected.files.map((file) => file.alias), [
    'llm-backend-onboarding/main.tf',
    'llm-backend-onboarding/operator.tfvars',
    'llm-backend-onboarding/variables.tf',
  ]);
  const inventory = await reader.loadTree(...f.args, f.head, undefined, { nativeInventory: true });
  assert.deepEqual(inventory.files.map((file) => file.alias).sort(), [...Object.keys(NATIVE_FILES), unselected].sort());
  assertReads(f, [...treeReads(f), ...treeReads(f)]);
  clearTrace(f);
  await assert.rejects(reader.readSourceBlob(...f.args, f.head, unselected, entryAt(f, unselected).sha, inventory, configuration), {
    status: 400, code: 'NATIVE_SOURCE_SCOPE',
  });
  const provider = scan.githubScanProvider(...f.args, inventory, configuration);
  await assert.rejects(provider.read(unselected), { status: 400, code: 'NATIVE_SOURCE_SCOPE' });
  assertReads(f, []);
});

test('H4 Git reader: literal lookup stops at absent entries and non-tree intermediates', async () => {
  const f = fixture({ 'main.bicepparam': 'param value = 1\n' });
  assert.equal(await reader.lookupPath(...f.args, 'not-a-sha', ''), null);
  assertReads(f, []);
  assert.equal(await reader.lookupPath(...f.args, f.head, 'missing/child.xml'), null);
  assert.equal(await reader.lookupPath(...f.args, f.head, 'main.bicepparam/child.xml'), null);
  assertReads(f, [
    get(f, `commits/${f.head}`), get(f, `trees/${f.treeSha}`),
    get(f, `commits/${f.head}`), get(f, `trees/${f.treeSha}`),
  ]);
});

for (const count of [MAX_TREE_ENTRIES, MAX_TREE_ENTRIES + 1]) {
  test(`H4 Git reader: recursive enumeration applies the exact ${count}-entry boundary`, async () => {
    const f = fixture();
    f.options.respond = (href, init, github) => new URL(href).searchParams.has('recursive')
      ? github.json(200, { tree: Array.from({ length: count }, () => ({ path: 'directory', type: 'tree' })), truncated: false })
      : github.fetch(href, init);
    if (count === MAX_TREE_ENTRIES) {
      const snapshot = await reader.loadTree(...f.args, f.head);
      assert.deepEqual(snapshot.files, []);
      assert.deepEqual(snapshot.rejected, []);
    } else {
      await assert.rejects(reader.loadTree(...f.args, f.head), {
        status: 413, code: 'TREE_TOO_LARGE', message: 'This repository tree is too large for Citadel UI.',
      });
    }
    assertReads(f, treeReads(f));
  });
}

for (const count of [2000, 2001]) {
  test(`H4 Git reader: truncated traversal preserves the ${count}-visit boundary`, async () => {
    const f = fixture();
    let visits = 0;
    f.options.respond = (href, init, github) => {
      const url = new URL(href);
      if (!url.pathname.includes('/git/trees/')) return github.fetch(href, init);
      if (url.searchParams.has('recursive')) return github.json(200, { tree: [], truncated: true });
      visits += 1;
      return github.json(200, { tree: visits < count ? [{ path: 'nested', type: 'tree', mode: '040000', sha: f.treeSha }] : [] });
    };
    if (count === 2000) assert.deepEqual((await reader.loadTree(...f.args, f.head)).files, []);
    else await assert.rejects(reader.loadTree(...f.args, f.head), {
      status: 413, code: 'TREE_TOO_LARGE', message: 'This repository tree is too large for Citadel UI to enumerate.',
    });
    assert.equal(visits, 2000);
    assertReads(f, [...treeReads(f), ...Array.from({ length: 2000 }, () => get(f, `trees/${f.treeSha}`))]);
  });
}

test('H4 Git reader: commit and tree response errors retain their shape and request boundary', async () => {
  const f = fixture();
  await assert.rejects(reader.loadTree(...f.args, 'short'), { status: 400, code: 'INVALID_SHA' });
  assertReads(f, []);
  f.options.respond = (_href, _init, github) => github.json(200, {});
  await assert.rejects(reader.loadTree(...f.args, f.head), {
    status: 502, code: 'GITHUB_INVALID_RESPONSE', message: 'GitHub returned no tree for the commit.',
  });
  assertReads(f, [get(f, `commits/${f.head}`)]);
  clearTrace(f);
  f.options.respond = (_href, _init, github) => github.json(200, { tree: { sha: 'short' } });
  await assert.rejects(reader.treeIndex(...f.args, f.head), {
    status: 400, code: 'INVALID_SHA', message: 'A full tree SHA is required.',
  });
  assertReads(f, [get(f, `commits/${f.head}`)]);
});

test('H4 Git reader: blob bytes, whitespace base64 and response limits are unchanged without a reader cache', async () => {
  const bytes = Buffer.from('\uFEFFparam value = "\u03a9"\r\n');
  const f = fixture({ 'main.bicepparam': { content: bytes } });
  const sha = entryAt(f, 'main.bicepparam').sha;
  f.options.respond = (_href, _init, github) => github.json(200, {
    encoding: 'base64', size: bytes.length, content: bytes.toString('base64').replace(/(.{4})/g, '$1 \r\n'),
  });
  for (const options of [{}, { maxBytes: bytes.length }]) {
    assert.deepEqual(await reader.readBlob(...f.args, sha, options), {
      sha, bytes, text: bytes.toString('utf8'), size: bytes.length,
      hash: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  assertReads(f, [get(f, `blobs/${sha}`, blobResponseLimit()), get(f, `blobs/${sha}`, blobResponseLimit(bytes.length))]);
});

for (const failure of [
  { name: 'unsupported encoding', data: { encoding: 'utf-8', size: 1, content: 'f' }, code: 'UNSUPPORTED_BLOB', status: 415 },
  { name: 'invalid base64 alphabet', data: { encoding: 'base64', size: 1, content: '$g==' }, code: 'GITHUB_INVALID_BLOB', status: 502 },
  { name: 'noncanonical base64 bits', data: { encoding: 'base64', size: 1, content: 'Zh==' }, code: 'GITHUB_INVALID_BLOB', status: 502 },
  { name: 'mismatched declared size', data: { encoding: 'base64', size: 2, content: 'Zg==' }, code: 'GITHUB_INVALID_BLOB', status: 502 },
  { name: 'negative declared size', data: { encoding: 'base64', size: -1, content: '' }, code: 'SOURCE_TOO_LARGE', status: 413 },
  { name: 'nonnumeric declared size', data: { encoding: 'base64', size: 'unknown', content: '' }, code: 'SOURCE_TOO_LARGE', status: 413 },
  { name: '8 MiB plus one declared byte', data: { encoding: 'base64', size: MAX_SOURCE_BYTES + 1, content: '' }, code: 'SOURCE_TOO_LARGE', status: 413 },
]) {
  test(`H4 Git reader: ${failure.name} is refused after one bounded GET`, async () => {
    const f = fixture({}, { respond: (_href, _init, github) => github.json(200, failure.data) });
    await assert.rejects(reader.readBlob(...f.args, 'a'.repeat(40)), { code: failure.code, status: failure.status, github: true });
    assertReads(f, [get(f, `blobs/${'a'.repeat(40)}`, blobResponseLimit())]);
  });
}

test('H4 Git reader: unpadded base64, empty blobs and explicit LFS reads keep the existing contract', async () => {
  const f = fixture();
  for (const [content, size, expected] of [['Zg', 1, 'f'], ['', 0, '']]) {
    f.options.respond = (_href, _init, github) => github.json(200, { encoding: 'base64', size, content });
    assert.equal((await reader.readBlob(...f.args, 'a'.repeat(40))).text, expected);
  }
  const pointer = 'version https://git-lfs.github.com/spec/v1\r\noid sha256:synthetic\r\nsize 1\r\n';
  f.options.respond = (_href, _init, github) => github.json(200, {
    encoding: 'base64', size: Buffer.byteLength(pointer), content: Buffer.from(pointer).toString('base64'),
  });
  await assert.rejects(reader.readBlob(...f.args, 'a'.repeat(40)), { status: 415, code: 'LFS_POINTER' });
  assert.equal((await reader.readBlob(...f.args, 'a'.repeat(40), { allowLfs: true })).text, pointer);
  assertReads(f, Array.from({ length: 4 }, () => get(f, `blobs/${'a'.repeat(40)}`, blobResponseLimit())));
});

test('H4 Git reader: source reads bind the alias and reviewed SHA before requesting bytes', async () => {
  const f = fixture({ 'main.bicepparam': 'param value = 1\n', '.azure/dev/.env': 'SYNTHETIC_SETTING="untouched"\n' });
  const snapshot = await reader.loadTree(...f.args, f.head);
  const sha = entryAt(f, 'main.bicepparam').sha;
  clearTrace(f);
  await assert.rejects(reader.readSourceBlob(...f.args, f.head, '.azure/dev/.env', sha, snapshot), {
    status: 400, code: 'INVALID_ALIAS',
  });
  await assert.rejects(reader.readSourceBlob(...f.args, f.head, 'missing.bicepparam', sha, snapshot), {
    status: 404, code: 'SOURCE_NOT_FOUND', message: 'Source not found: missing.bicepparam',
  });
  await assert.rejects(reader.readSourceBlob(...f.args, f.head, 'main.bicepparam', 'a'.repeat(40), snapshot), {
    status: 409, code: 'STALE_SOURCE', message: 'File changed outside Citadel UI. Reload before saving.',
  });
  await assert.rejects(reader.readSourceBlob(...f.args, f.head, 'main.bicepparam', 'short', snapshot), {
    status: 400, code: 'INVALID_SHA',
  });
  assertReads(f, []);
  assert.equal((await reader.readSourceBlob(...f.args, f.head, 'main.bicepparam', sha, snapshot)).text, 'param value = 1\n');
  assertReads(f, [get(f, `blobs/${sha}`, blobResponseLimit())]);
  clearTrace(f);
  f.github.seed(f.repository, 'main', { 'main.bicepparam': 'param value = 2\n' }, { parents: [f.head] });
  assert.equal((await reader.readSourceBlob(...f.args, f.head, 'main.bicepparam', sha)).text, 'param value = 1\n');
  assertReads(f, [...treeReads(f), get(f, `blobs/${sha}`, blobResponseLimit())]);
});

test('H4 Git scan: only read capabilities are exposed and ordinary alias caching is per snapshot provider', async () => {
  const bytes = Buffer.from('\uFEFFparam value = "\u03a9"\r\n');
  const f = fixture({ 'a.bicepparam': { content: bytes }, 'b.bicepparam': { content: bytes } });
  const state = objectState(f), snapshot = await reader.loadTree(...f.args, f.head);
  const provider = scan.githubScanProvider(...f.args, snapshot);
  assert.deepEqual(Object.keys(provider).sort(), ['configuration', 'entries', 'read', 'remote', 'workspaceHead']);
  assert.equal(provider.remote, true);
  assert.equal(provider.configuration, undefined);
  clearTrace(f);
  assert.equal(await provider.workspaceHead(), f.head);
  assert.deepEqual(await provider.entries(), [{ alias: 'a.bicepparam', kind: 'bicepparam' }, { alias: 'b.bicepparam', kind: 'bicepparam' }]);
  assertReads(f, []);
  const first = await provider.read('a.bicepparam'), second = await provider.read('b.bicepparam');
  assert.deepEqual(first, {
    alias: 'a.bicepparam', bytes, text: 'param value = "\u03a9"\r\n', bom: true,
    hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, workspaceHead: f.head,
  });
  assert.deepEqual(second, { ...first, alias: 'b.bicepparam' });
  await provider.read('a.bicepparam');
  const sha = entryAt(f, 'a.bicepparam').sha;
  assertReads(f, [get(f, `blobs/${sha}`, blobResponseLimit())]);
  await scan.githubScanProvider(...f.args, snapshot).read('a.bicepparam');
  assertReads(f, [get(f, `blobs/${sha}`, blobResponseLimit()), get(f, `blobs/${sha}`, blobResponseLimit())]);
  assert.deepEqual(objectState(f), state);
});

test('H4 Git scan: the 400-read allowance counts uncached requests, not entries or cached aliases', async () => {
  const aliases = Array.from({ length: 401 }, (_, index) => `source-${String(index).padStart(3, '0')}.bicepparam`);
  const files = Object.fromEntries(aliases.map((alias, index) => [alias, `param value = ${index}\n`]));
  files['clone.bicepparam'] = files[aliases[0]];
  const f = fixture(files), state = objectState(f), snapshot = await reader.loadTree(...f.args, f.head);
  const provider = scan.githubScanProvider(...f.args, snapshot);
  clearTrace(f);
  assert.equal((await provider.entries()).length, 402);
  for (const alias of aliases.slice(0, 400)) await provider.read(alias);
  assert.equal((await provider.read('clone.bicepparam')).alias, 'clone.bicepparam');
  await assert.rejects(provider.read(aliases[400]), {
    status: 413, code: 'REPOSITORY_TOO_LARGE', message: 'This repository has too many Citadel sources to validate.',
  });
  assertReads(f, aliases.slice(0, 400).map((alias) => get(f, `blobs/${entryAt(f, alias).sha}`, blobResponseLimit())));
  await scan.githubScanProvider(...f.args, snapshot).read(aliases[400]);
  assert.equal(f.requests.length, 401);
  assert.deepEqual(objectState(f), state);
});

test('H4 Git scan: scope and absence fail without GETs; failed reads are not cached or automatically retried', async () => {
  const f = fixture({ 'main.bicepparam': 'param value = 1\n' });
  const snapshot = await reader.loadTree(...f.args, f.head), provider = scan.githubScanProvider(...f.args, snapshot);
  clearTrace(f);
  await assert.rejects(provider.read('.azure/dev/.env'), { code: 'INVALID_ALIAS' });
  await assert.rejects(provider.read('missing.bicepparam'), { code: 'SOURCE_NOT_FOUND', status: 404 });
  assertReads(f, []);
  f.options.respond = (_href, _init, github) => github.json(500, { message: 'Unavailable' });
  await assert.rejects(provider.read('main.bicepparam'), { code: 'GITHUB_REQUEST_FAILED', status: 502 });
  assert.equal(f.requests.length, 1);
  delete f.options.respond;
  assert.equal((await provider.read('main.bicepparam')).text, 'param value = 1\n');
  await provider.read('main.bicepparam');
  assertReads(f, Array.from({ length: 2 }, () => get(f, `blobs/${entryAt(f, 'main.bicepparam').sha}`, blobResponseLimit())));
});

test('H4 Git scan: failed source attempts also consume the 400-read allowance', async () => {
  const aliases = Array.from({ length: 400 }, (_, index) => `source-${String(index).padStart(3, '0')}.bicepparam`);
  const f = fixture(Object.fromEntries(aliases.map((alias, index) => [alias, `param value = ${index}\n`])));
  const snapshot = await reader.loadTree(...f.args, f.head), provider = scan.githubScanProvider(...f.args, snapshot);
  clearTrace(f);
  f.options.respond = (_href, _init, github) => github.json(500, { message: 'Unavailable' });
  await assert.rejects(provider.read(aliases[0]), { status: 502, code: 'GITHUB_REQUEST_FAILED' });
  delete f.options.respond;
  for (const alias of aliases.slice(0, 399)) await provider.read(alias);
  await assert.rejects(provider.read(aliases[399]), { status: 413, code: 'REPOSITORY_TOO_LARGE' });
  assertReads(f, [aliases[0], ...aliases.slice(0, 399)].map((alias) =>
    get(f, `blobs/${entryAt(f, alias).sha}`, blobResponseLimit())));
});

test('H4 Git scan: concurrent uncached aliases retain the scan cache boundary rather than browser single-flight behavior', async () => {
  const f = fixture({ 'a.bicepparam': 'param value = 1\n', 'b.bicepparam': 'param value = 1\n' });
  const snapshot = await reader.loadTree(...f.args, f.head), provider = scan.githubScanProvider(...f.args, snapshot);
  const gate = Promise.withResolvers();
  f.options.respond = async (href, init, github) => { await gate.promise; return github.fetch(href, init); };
  clearTrace(f);
  const pending = [provider.read('a.bicepparam'), provider.read('b.bicepparam')];
  try { assert.equal(f.requests.length, 2); } finally { gate.resolve(); }
  const records = await Promise.all(pending);
  assert.deepEqual(records.map((record) => record.alias), ['a.bicepparam', 'b.bicepparam']);
  await provider.read('a.bicepparam');
  assertReads(f, Array.from({ length: 2 }, () => get(f, `blobs/${entryAt(f, 'a.bicepparam').sha}`, blobResponseLimit())));
});

test('H4 Git scan: ordinary malformed UTF-8 is refused without converting or caching the source', async () => {
  const bytes = Buffer.from([0xff]);
  const f = fixture({ 'main.bicepparam': { content: bytes } });
  const snapshot = await reader.loadTree(...f.args, f.head), provider = scan.githubScanProvider(...f.args, snapshot);
  clearTrace(f);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(provider.read('main.bicepparam'), { code: 'SOURCE_ENCODING_UNSUPPORTED' });
  }
  assertReads(f, Array.from({ length: 2 }, () => get(f, `blobs/${entryAt(f, 'main.bicepparam').sha}`, blobResponseLimit())));
  assert.deepEqual(Buffer.from(f.github.blobs.get(entryAt(f, 'main.bicepparam').sha), 'base64'), bytes);
});

test('H4 Git scan: native equal blobs are checked against each alias schema and failed values are not cached', async () => {
  const configuration = nativeConfiguration(['deployment', 'llm']);
  const deployment = configuration.units[0].valueAlias, llm = configuration.units[1].valueAlias;
  const f = fixture({
    ...NATIVE_FILES, [llm]: NATIVE_FILES[deployment],
    'llm-backend-onboarding/variables.tf': NATIVE_FILES['llm-backend-onboarding/variables.tf'] +
      '\nvariable "environment_name" {\n type = string\n sensitive = true\n default = null\n}\n',
  });
  const snapshot = await reader.loadTree(...f.args, f.head, configuration);
  const provider = scan.githubScanProvider(...f.args, snapshot, configuration);
  clearTrace(f);
  const allowed = await provider.read(deployment);
  assert.equal(allowed.text, NATIVE_FILES[deployment]);
  assert.equal(Object.hasOwn(allowed, 'bom'), false);
  await assert.rejects(provider.read(llm), { status: 422, code: 'NATIVE_SENSITIVE_FILE' });
  await assert.rejects(provider.read(llm), { status: 422, code: 'NATIVE_SENSITIVE_FILE' });
  assertReads(f, [
    deployment, 'variables.tf', 'main.tf', llm,
    'llm-backend-onboarding/variables.tf', 'llm-backend-onboarding/main.tf', llm,
  ].map((alias) => get(f, `blobs/${entryAt(f, alias).sha}`, blobResponseLimit())));
});

for (const rejection of [
  { name: 'BOM', content: `\uFEFF${NATIVE_FILES['llm-backend-onboarding/operator.tfvars']}`, code: 'NATIVE_SYNTAX', schema: false },
  { name: 'malformed UTF-8', content: Buffer.from([0xff]), code: 'NATIVE_SYNTAX', schema: false },
  { name: 'whole-file sensitivity', content: NATIVE_FILES['llm-backend-onboarding/operator.tfvars'].replace('secret_value = null', 'secret_value = "synthetic-sensitive"'), code: 'NATIVE_SENSITIVE_FILE', schema: true },
  { name: '512 KiB parser limit', content: `#${' '.repeat(512 * 1024)}\n${NATIVE_FILES['llm-backend-onboarding/operator.tfvars']}`, code: 'NATIVE_LIMIT', schema: true },
]) {
  test(`H4 Git scan: native ${rejection.name} is refused before returning source bytes`, async () => {
    const configuration = nativeConfiguration(['llm']), alias = configuration.units[0].valueAlias;
    const f = fixture({ ...NATIVE_FILES, [alias]: { content: rejection.content } });
    const state = objectState(f), snapshot = await reader.loadTree(...f.args, f.head, configuration);
    const provider = scan.githubScanProvider(...f.args, snapshot, configuration);
    clearTrace(f);
    await assert.rejects(provider.read(alias), { status: 422, code: rejection.code });
    const aliases = [alias, ...(rejection.schema ? ['llm-backend-onboarding/variables.tf', 'llm-backend-onboarding/main.tf'] : [])];
    assertReads(f, aliases.map((path) => get(f, `blobs/${entryAt(f, path).sha}`, blobResponseLimit())));
    assert.deepEqual(objectState(f), state);
  });
}

test('H4 Git scan: native dependency sensitivity is checked before caching or returning it', async () => {
  const configuration = nativeConfiguration(['deployment']);
  const f = fixture({ ...NATIVE_FILES, 'main.tf': `${NATIVE_FILES['main.tf']}\nlocals { password = "synthetic-sensitive" }\n` });
  const snapshot = await reader.loadTree(...f.args, f.head, configuration);
  const provider = scan.githubScanProvider(...f.args, snapshot, configuration);
  clearTrace(f);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(provider.read('main.tf'), { status: 422, code: 'NATIVE_SENSITIVE_FILE' });
  }
  assertReads(f, Array.from({ length: 2 }, () => get(f, `blobs/${entryAt(f, 'main.tf').sha}`, blobResponseLimit())));
});

for (const scenario of ['missing proof', 'stale identity', 'sensitive after', 'valid']) {
  test(`H4 Git reader: native ${scenario} preserves validation and audit order before publication`, async () => {
    const configuration = nativeConfiguration(['llm']), unit = configuration.units[0], alias = unit.valueAlias;
    const branch = 'review/native#100%', encodedBranch = 'review/native%23100%25';
    const f = fixture(NATIVE_FILES, { branch });
    const snapshot = await reader.loadTree(...f.args, f.head, configuration);
    const provider = scan.githubScanProvider(...f.args, snapshot, configuration);
    const document = await nativeDocument(provider, configuration, unit);
    const after = scenario === 'sensitive after'
      ? document.text.replace('secret_value = null', 'secret_value = "synthetic-sensitive"')
      : document.text.replace('synthetic-gateway', 'reviewed-gateway');
    const audit = new MemoryAudit(), state = objectState(f);
    const record = audit.record.bind(audit);
    audit.record = async (entry) => { await record(entry); f.events.push({ kind: 'audit', commit: entry.commit }); };
    const options = {
      fullName: f.repository.full_name, repositoryId: f.repository.id, branch, expectedHead: f.head,
      environmentId: 'h4-native-reader', transactionId: 'h4-native-reader-transaction', action: 'parameter-edit',
      authorName: 'Synthetic reviewer', configuration, audit,
      nativeProof: scenario === 'missing proof' ? undefined : nativeTransactionProof(configuration, document),
      nativeIdentity: scenario === 'stale identity' ? { ...document.nativeIdentity, hash: '0'.repeat(64) } : document.nativeIdentity,
      files: [{ alias, blobSha: entryAt(f, alias).sha, beforeHash: document.hash, mode: '100644', after: Buffer.from(after).toString('base64') }],
    };
    clearTrace(f);
    const prefix = [get(f, `ref/heads/${encodedBranch}`), ...treeReads(f)];
    const nativeReads = ['llm-backend-onboarding/variables.tf', 'llm-backend-onboarding/main.tf', alias]
      .map((path) => get(f, `blobs/${entryAt(f, path).sha}`, blobResponseLimit()));
    if (scenario !== 'valid') {
      const code = { 'missing proof': 'NATIVE_PROOF_REQUIRED', 'stale identity': 'NATIVE_REVIEW_STALE', 'sensitive after': 'NATIVE_SENSITIVE_FILE' }[scenario];
      await assert.rejects(workspace.commitChangeSet(f.client, TEST_TOKEN, options), { status: 422, code });
      assertReads(f, scenario === 'missing proof' ? prefix : [...prefix, ...nativeReads]);
      assert.deepEqual(objectState(f), state);
      assert.deepEqual(audit.commits, []);
      return;
    }
    const result = await workspace.commitChangeSet(f.client, TEST_TOKEN, options);
    assert.equal(result.outcome, 'applied');
    assert.equal(result.author, 'Synthetic reviewer');
    assert.equal(result.baseCommit, f.head);
    assert.equal(result.branch, branch);
    assert.deepEqual(result.warnings, []);
    const changed = f.github.treeOf(result.commit).find((entry) => entry.path === alias);
    const createdTree = f.github.commits.get(result.commit).tree;
    const writes = [
      { method: 'POST', path: `${f.base}/blobs`, body: { content: Buffer.from(after).toString('base64'), encoding: 'base64' } },
      { method: 'POST', path: `${f.base}/trees`, body: {
        base_tree: f.treeSha, tree: [{ path: alias, mode: '100644', type: 'blob', sha: changed.sha }],
      } },
      { method: 'POST', path: `${f.base}/commits`, body: {
        message: 'Citadel parameter-edit: operator.tfvars\n\nCitadel-Action: parameter-edit\nCitadel-Environment: h4-native-reader\nCitadel-Transaction: h4-native-reader-transaction',
        tree: createdTree, parents: [f.head],
      } },
      { method: 'PATCH', path: `${f.base}/refs/heads/${encodedBranch}`, body: { sha: result.commit, force: false } },
    ];
    const beforeWrites = [...prefix, ...nativeReads, get(f, `commits/${f.head}`), ...treeReads(f),
      get(f, `blobs/${entryAt(f, alias).sha}`, blobResponseLimit())];
    assert.deepEqual(f.requests, [
      ...beforeWrites, ...writes.map((call) => ({ ...call, token: TEST_TOKEN })), get(f, `ref/heads/${encodedBranch}`),
    ]);
    assert.deepEqual(f.transport, [
      ...beforeWrites.map(({ path }) => ({ method: 'GET', path, body: null })),
      ...writes, { method: 'GET', path: `${f.base}/ref/heads/${encodedBranch}`, body: null },
    ].map((call) => ({ ...call, redirect: 'manual', cache: 'no-store' })));
    assert.deepEqual(f.events.slice(-3).map(({ kind, method }) => kind === 'audit' ? kind : method), ['audit', 'PATCH', 'GET']);
    assert.equal(audit.commits.length, 1);
    assert.equal(audit.commits[0].commit, result.commit);
    assert.equal(f.repository.refs.get(branch), result.commit);
    assert.equal(f.repository.refs.size, 1);
    assert.equal(f.github.fileText(f.repository, branch, alias), after);
    for (const entry of f.github.treeOf(result.commit).filter((entry) => entry.path !== alias)) {
      assert.equal(entry.sha, entryAt(f, entry.path).sha, entry.path);
    }
  });
}
