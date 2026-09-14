import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertGitHubRequestBudget } from '../shared/github-request-budget.mjs';
import { MAX_GITHUB_COMMIT_REQUEST_BYTES as LIMIT, MAX_SOURCE_BYTES } from '../shared/source-scope.mjs';
import { normalizeChangeSet, commitChangeSet } from '../server/github/workspace.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { githubWorkspaceFixture } from './_github-workspace-fixture.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const TEMPLATE = 'bicep/infra/citadel-access-contracts/main.bicepparam';
const POLICY = 'bicep/infra/citadel-access-contracts/policies/default-ai-product-policy.xml';
const header = () => ({
  action: 'contract-create', expectedHead: 'a'.repeat(40), transactionId: 'b'.repeat(36),
  files: [
    { alias: 'bicep/infra/contract/main.bicepparam', create: true, blobSha: null, beforeHash: null, after: '' },
    { alias: 'bicep/infra/contract/policy.xml', create: true, blobSha: null, beforeHash: null, after: '' },
  ],
});
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const rejected = (error) => error.code === 'GITHUB_REQUEST_TOO_LARGE' && error.status === 413 &&
  error.encodedBytes > error.limit && /base64.*metadata.*No GitHub mutation was submitted/.test(error.message);

test('request budget: exact encoded JSON boundary counts file pairs, UTF-8 framing and review metadata', () => {
  const body = header();
  body.nativeProof = { note: 'quoted "value", backslash \\ and \u00e9', dependencies: [{ alias: 'variables.tf', hash: 'c'.repeat(64) }] };
  body.nativeIdentity = { configuration: '{"profileId":"synthetic"}', hash: 'd'.repeat(64) };
  const firstSize = 5 * 1024 * 1024, firstEncoded = 4 * Math.ceil(firstSize / 3);
  const secondSize = Math.floor((LIMIT - jsonBytes(body) - firstEncoded) / 4) * 3;
  const extra = LIMIT - jsonBytes(body) - firstEncoded - 4 * Math.ceil(secondSize / 3);
  body.transactionId += 'b'.repeat(extra);
  const virtual = assertGitHubRequestBudget(body, firstEncoded + 4 * Math.ceil(secondSize / 3));
  assert.equal(virtual.encodedBytes, LIMIT);
  body.files[0].after = Buffer.alloc(firstSize, 32).toString('base64');
  body.files[1].after = Buffer.alloc(secondSize, 32).toString('base64');
  assert.equal(jsonBytes(body), LIMIT);
  assert.equal(assertGitHubRequestBudget(body).encodedBytes, LIMIT);
  assert.equal(normalizeChangeSet(body.files, { requestBody: body }).length, 2);
  body.transactionId += 'b';
  assert.equal(jsonBytes(body), LIMIT + 1);
  assert.throws(() => assertGitHubRequestBudget(body), rejected);
  assert.throws(() => normalizeChangeSet(body.files, { requestBody: body }), rejected);
});

test('request budget: two individually legal 5 MiB files fail before normalization allocates decoded buffers', (t) => {
  const files = ['one', 'two'].map((name) => ({
    alias: `bicep/infra/${name}.bicepparam`, create: true, after: Buffer.alloc(5 * 1024 * 1024, 32).toString('base64'),
  }));
  const from = Buffer.from, decoded = [];
  const spy = t.mock.method(Buffer, 'from', function (value, encoding, ...args) {
    if (encoding === 'base64') decoded.push(value.length);
    return from.call(this, value, encoding, ...args);
  });
  assert.throws(() => normalizeChangeSet(files), rejected);
  assert.deepEqual(decoded, [], 'Aggregate refusal must precede any decoded file allocation.');
  spy.mock.restore();
  assert.equal(normalizeChangeSet(files, { requestBudget: false }).length, 2, 'internal inverse commits send restored blobs individually, not as an HTTP aggregate');
});

function coordinator() {
  const calls = [], head = 'a'.repeat(40), entry = { sha: 'b'.repeat(40), mode: '100644' };
  const context = { environment: { id: 'budget', source: { kind: 'github', workingBranch: 'main' } },
    provider: { workspaceHead: async () => head, entry: async () => entry, reset() {} } };
  return { calls, context, value: new GitHubCommitCoordinator({ contextProvider: () => context,
    request: async (path, init) => { calls.push({ path, body: JSON.parse(init.body) }); return { applied: true, commit: 'c'.repeat(40) }; } }) };
}

test('request budget: a legal 8 MiB single file fits, while both file and aggregate limits remain enforced', async () => {
  const f = await githubWorkspaceFixture();
  const single = [{ alias: 'bicep/infra/eight-mib.bicepparam', create: true, after: new Uint8Array(MAX_SOURCE_BYTES).fill(32) }];
  const budget = await f.coordinator.validateRequest(single);
  assert(budget.encodedBytes < LIMIT);
  await assert.rejects(f.coordinator.validateRequest([{ ...single[0], after: new Uint8Array(MAX_SOURCE_BYTES + 1) }]),
    (error) => error.code === 'SOURCE_TOO_LARGE');
  const pair = [MAIN, POLICY].map((alias) => ({ alias, beforeHash: 'd'.repeat(64), after: new Uint8Array(5 * 1024 * 1024) }));
  const mutationsBefore = f.github.calls.filter((call) => call.method !== 'GET');
  await assert.rejects(f.coordinator.validateRequest(pair), rejected);
  await assert.rejects(f.coordinator.commit(pair), rejected);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  assert.deepEqual(f.github.calls.filter((call) => call.method !== 'GET'), mutationsBefore);
  await assert.rejects(f.request(`/api/github/workspaces/${f.environment.id}/commits`, { method: 'POST', body: JSON.stringify({
    action: 'parameter-edit', expectedHead: await f.provider.workspaceHead(), transactionId: 'oversized-source',
    files: [{ alias: single[0].alias, create: true, after: Buffer.alloc(MAX_SOURCE_BYTES + 1, 32).toString('base64') }],
  }) }), { code: 'SOURCE_TOO_LARGE', status: 413 });
  assert.deepEqual(f.github.calls.filter((call) => call.method !== 'GET'), mutationsBefore);
  const result = await f.coordinator.commit(single);
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(f.raw(single[0].alias), single[0].after);
  const sent = f.calls.filter((call) => call.method === 'POST').at(-1);
  assert.equal(Buffer.byteLength(sent.body), budget.encodedBytes);
  assert.equal(assertGitHubRequestBudget(sent.body).encodedBytes, budget.encodedBytes);
  assert.equal(normalizeChangeSet(JSON.parse(sent.body).files, { requestBody: JSON.parse(sent.body) })[0].after.length, MAX_SOURCE_BYTES);
});

test('request budget: actual commit serialization matches preview accounting including BOM and native proof', async () => {
  const c = coordinator();
  const files = [MAIN, POLICY].map((alias, index) => ({
    alias, beforeHash: 'd'.repeat(64), before: new Uint8Array(5 * 1024 * 1024).fill(32 + index),
    after: new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 13, 10, 32 + index]),
  }));
  const options = { nativeProof: { configuration: { profileId: 'synthetic-\u00e9' }, dependencies: [{ alias: 'variables.tf', hash: 'e'.repeat(64) }] },
    nativeIdentity: { configuration: '{"profileId":"synthetic-\u6f22"}', hash: 'f'.repeat(64) } };
  const preview = await c.value.validateRequest(files, options);
  await c.value.commit(files, options);
  assert.equal(c.calls.length, 1); assert.equal(jsonBytes(c.calls[0].body), preview.encodedBytes);
  const body = c.calls[0].body;
  assert(jsonBytes(body) > JSON.stringify(body).length, 'Multibyte metadata counts UTF-8 bytes, not JS string length.');
  assert.deepEqual(body.nativeProof, options.nativeProof); assert.deepEqual(body.nativeIdentity, options.nativeIdentity);
  assert.deepEqual(body.files.map((file) => Object.keys(file)), files.map(() => ['alias', 'create', 'blobSha', 'beforeHash', 'mode', 'after']));
  for (const [index, file] of body.files.entries()) {
    assert.equal(file.beforeHash, files[index].beforeHash);
    assert.deepEqual(Buffer.from(file.after, 'base64'), Buffer.from(files[index].after));
  }
  assert.equal(preview.encodedBytes, jsonBytes({ ...body, files: body.files.map((file) => ({ ...file, after: '' })) }) +
    body.files.reduce((sum, file) => sum + file.after.length, 0), 'Both after payloads and all framing count; Git parents supply before bytes.');
  assert.equal(normalizeChangeSet(body.files, { requestBody: body }).length, 2);
  await assert.rejects(c.value.validateRequest(files, { ...options, nativeProof: { note: 'x'.repeat(LIMIT) } }), rejected);
  await assert.rejects(c.value.validateRequest(files, { nativeIdentity: { note: 'x'.repeat(LIMIT) } }), rejected);
  assert.equal(c.calls.length, 1);
});

test('request budget: the public commit route cannot opt out of the aggregate budget', async () => {
  const f = await githubWorkspaceFixture(), head = await f.provider.workspaceHead();
  const writes = f.github.calls.filter((call) => call.method !== 'GET'), refs = [...f.repository.refs];
  await assert.rejects(f.request(`/api/github/workspaces/${f.environment.id}/commits`, { method: 'POST', body: JSON.stringify({
    ...header(), expectedHead: head, requestBudget: false,
    files: [{ alias: 'bicep/infra/small.bicepparam', create: true, after: 'IA==' }],
  }) }), { code: 'INVALID_CONTENT', status: 400 });
  assert.equal(f.audit.commits.length, 0);
  assert.deepEqual(f.github.calls.filter((call) => call.method !== 'GET'), writes);
  assert.deepEqual([...f.repository.refs], refs);
});

test('request budget: route and direct service entry include nativeIdentity even without nativeProof before GitHub writes', async () => {
  const f = await githubWorkspaceFixture(), head = await f.provider.workspaceHead();
  const body = { ...header(), expectedHead: head, files: [{ alias: 'bicep/infra/small.bicepparam', create: true, after: 'IA==' }],
    nativeIdentity: { note: 'x'.repeat(LIMIT) } };
  const writes = () => f.github.calls.filter((call) => call.method !== 'GET').length;
  const before = writes();
  await assert.rejects(f.request(`/api/github/workspaces/${f.environment.id}/commits`, { method: 'POST', body: JSON.stringify(body) }), rejected);
  await assert.rejects(commitChangeSet(f.client, TEST_TOKEN, {
    ...body, fullName: f.repository.full_name, branch: f.environment.source.workingBranch,
    environmentId: f.environment.id, repositoryId: f.repository.id, audit: f.audit,
  }), rejected);
  assert.equal(writes(), before); assert.equal(f.audit.commits.length, 0);
});

test('request budget: an oversized template parameter/policy creation fails before the browser submits a mutation', async () => {
  const files = citadelRepositoryFiles(), size = 5 * 1024 * 1024;
  assert.equal(typeof files[TEMPLATE], 'string'); assert.equal(typeof files[POLICY], 'string');
  files[TEMPLATE] += `\n// ${'x'.repeat(size - Buffer.byteLength(files[TEMPLATE]) - 4)}`;
  files[POLICY] += `\n<!--${' '.repeat(size - Buffer.byteLength(files[POLICY]) - 8)}-->`;
  const f = await githubWorkspaceFixture({ files });
  const before = [...f.repository.refs], calls = f.calls.length;
  await assert.rejects(f.service.createContract({ name: 'too-large-pair' }), rejected);
  assert.equal(f.calls.slice(calls).some((call) => call.method === 'POST'), false);
  assert.equal(f.audit.commits.length, 0); assert.deepEqual([...f.repository.refs], before);
});

test('request budget: parameter and policy preview surfaces use the same coordinator budget as commit', async () => {
  const f = await githubWorkspaceFixture(), observed = [];
  const validate = f.coordinator.validateRequest.bind(f.coordinator);
  f.coordinator.validateRequest = async (files, options) => {
    const result = await validate(files, options); observed.push({ action: options.action, result }); return result;
  };
  const parameter = await f.provider.read(MAIN), policy = await f.provider.read(POLICY);
  await f.service.preview(MAIN, [{ op: 'set', path: ['environmentName'], value: 'reviewed' }], parameter.hash);
  await f.service.previewPolicy(POLICY, { variables: { jwtRequired: true } }, null, policy.hash);
  assert.deepEqual(observed.map((item) => item.action), ['parameter-edit', 'policy-edit']);
  assert(observed.every((item) => item.result.limit === LIMIT));
  assert.equal(f.calls.some((call) => call.method === 'POST' && call.path.endsWith('/commits')), false);
  await f.service.savePolicy({ path: POLICY, expectedHash: policy.hash, changes: { variables: { jwtRequired: true } } });
  const sent = f.calls.find((call) => call.method === 'POST' && call.path.endsWith('/commits'));
  assert.equal(Buffer.byteLength(sent.body), observed[1].result.encodedBytes);
});

test('request budget: the HTTP commit cap is the same unchanged shared 12 MiB bound', async () => {
  const server = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.equal(LIMIT, 12 * 1024 * 1024);
  assert.match(server, /MAX_GITHUB_COMMIT_REQUEST_BYTES as GITHUB_COMMIT_BODY_LIMIT/);
  assert.match(server, /githubCommitBodyLimit: options\.githubCommitBodyLimit \?\? GITHUB_COMMIT_BODY_LIMIT/);
});

test('C1 Git request budget: preview, serialized pair and public server agree at 12582912 bytes and refuse byte 12582913', async () => {
  const f = await githubWorkspaceFixture(), head = await f.provider.workspaceHead();
  const files = ['boundary-one', 'boundary-two'].map((name) => ({
    alias: `bicep/infra/${name}.bicepparam`, create: true, after: new Uint8Array(),
  }));
  const options = {
    action: 'contract-create',
    nativeProof: { note: 'UTF-8 \u00e9, quote " and slash \\', padding: '' },
    nativeIdentity: { configuration: '\u6f22\ud83d\ude80', hash: 'e'.repeat(64) },
  };
  files[0].after = new Uint8Array(5 * 1024 * 1024).fill(32);
  files[0].after.set([0xef, 0xbb, 0xbf, 0x2f, 0x2f, 0xc3, 0xa9, 13, 10]);
  const first = await f.coordinator.validateRequest(files, options);
  files[1].after = new Uint8Array(Math.floor((LIMIT - first.encodedBytes) / 4) * 3).fill(32);
  options.nativeProof.padding = 'x'.repeat(LIMIT - (await f.coordinator.validateRequest(files, options)).encodedBytes);
  assert.deepEqual(await f.coordinator.validateRequest(files, options), { encodedBytes: 12582912, limit: 12582912 });
  const { body } = await f.coordinator.prepareRequest(files, options);
  body.files.forEach((file, index) => { file.after = Buffer.from(files[index].after).toString('base64'); });
  const over = { ...body, nativeProof: { ...body.nativeProof, padding: `${body.nativeProof.padding}x` } };
  assert.equal(jsonBytes(body), 12582912); assert.equal(jsonBytes(over), 12582913);
  const rejectedExactly = (error) => rejected(error) && error.encodedBytes === 12582913 && error.limit === 12582912;
  const writes = f.github.calls.filter((call) => call.method !== 'GET'), refs = [...f.repository.refs];
  const overOptions = { ...options, nativeProof: over.nativeProof, requestBudget: false };
  await assert.rejects(f.coordinator.validateRequest(files, overOptions), rejectedExactly);
  await assert.rejects(f.coordinator.commit(files, overOptions), rejectedExactly);
  await assert.rejects(f.request(`/api/github/workspaces/${f.environment.id}/commits`,
    { method: 'POST', body: JSON.stringify(over) }), rejectedExactly);
  assert.deepEqual(f.github.calls.filter((call) => call.method !== 'GET'), writes);
  assert.deepEqual([...f.repository.refs], refs); assert.equal(f.audit.commits.length, 0);
  for (const file of files) assert.equal(f.raw(file.alias), null);
  const applied = await f.coordinator.commit(files, options);
  assert.equal(applied.outcome, 'applied'); assert.equal(applied.applied, true);
  const sent = f.calls.filter((call) => call.method === 'POST').at(-1);
  assert.equal(Buffer.byteLength(sent.body), 12582912);
  assert.equal(sent.body, JSON.stringify({ ...body, transactionId: applied.transactionId }));
  assert.deepEqual(f.github.commits.get(applied.commit).parents, [head]);
  for (const file of files) assert.deepEqual(f.raw(file.alias), file.after);
  assert.equal(f.audit.commits.length, 1);
});

test('C1 Git request budget: the 64-file cap is independent of the encoded byte cap', async () => {
  const c = coordinator();
  const files = Array.from({ length: 64 }, (_, index) => ({
    alias: `bicep/infra/tiny-${index}.bicepparam`, create: true, after: new Uint8Array([32]),
  }));
  const preview = await c.value.validateRequest(files);
  assert(preview.encodedBytes < LIMIT);
  await c.value.commit(files);
  const body = c.calls[0].body;
  assert.equal(body.files.length, 64); assert.equal(jsonBytes(body), preview.encodedBytes);
  assert.equal(normalizeChangeSet(body.files, { requestBody: body }).length, 64);
  const extra = { ...files[0], alias: 'bicep/infra/tiny-64.bicepparam' };
  await assert.rejects(c.value.validateRequest([...files, extra]), /1 to 64 files/);
  await assert.rejects(c.value.commit([...files, extra]), /1 to 64 files/);
  assert.equal(c.calls.length, 1);
  const oversized = [...body.files, { ...body.files[0], alias: extra.alias }];
  assert(jsonBytes({ files: oversized }) < LIMIT);
  assert.throws(() => normalizeChangeSet(oversized), { code: 'INVALID_CHANGE_SET', status: 400 });
});

test('C1 Git request budget: History restores two 5 MiB parents using individual blobs, never a public budget bypass', async () => {
  const aliases = ['bicep/infra/large-one.bicepparam', 'bicep/infra/large-two.bicepparam'];
  const originals = aliases.map((_, index) => Buffer.alloc(5 * 1024 * 1024, 32 + index));
  const f = await githubWorkspaceFixture({ files: Object.fromEntries(aliases.map((alias, index) => [alias, { content: originals[index] }])) });
  const changes = await Promise.all(aliases.map(async (alias, index) => ({
    alias, before: originals[index], beforeHash: (await f.provider.read(alias)).hash, after: new Uint8Array([32, index + 48, 10]),
  })));
  const saved = await f.coordinator.commit(changes);
  const head = await f.provider.workspaceHead(), body = {
    action: 'history-undo', expectedHead: head, transactionId: 'budget-inverse',
    files: await Promise.all(changes.map(async (file, index) => ({
      alias: file.alias, blobSha: (await f.provider.entry(file.alias)).sha, mode: '100644',
      beforeHash: (await f.provider.read(file.alias)).hash, after: originals[index].toString('base64'),
    }))),
  };
  const writes = f.github.calls.filter((call) => call.method !== 'GET').length;
  await assert.rejects(f.request(`/api/github/workspaces/${f.environment.id}/commits`,
    { method: 'POST', body: JSON.stringify(body) }), rejected);
  assert.equal(f.github.calls.filter((call) => call.method !== 'GET').length, writes);
  const start = f.calls.length, githubStart = f.github.calls.length;
  const restored = await f.service.restoreTransaction(saved.commit);
  assert.equal(restored.outcome, 'applied');
  const submissions = f.calls.slice(start).filter((call) => call.method === 'POST');
  assert.equal(submissions.length, 1); assert.match(submissions[0].path, /\/reverts$/);
  assert.deepEqual(JSON.parse(submissions[0].body), { commit: saved.commit, transactionId: restored.transactionId });
  assert(Buffer.byteLength(submissions[0].body) < LIMIT);
  assert.deepEqual(f.github.calls.slice(githubStart).filter((call) => call.method !== 'GET').map((call) => [call.method, call.path]), [
    ['POST', '/repos/synthetic/review/git/blobs'], ['POST', '/repos/synthetic/review/git/blobs'],
    ['POST', '/repos/synthetic/review/git/trees'], ['POST', '/repos/synthetic/review/git/commits'],
    ['PATCH', `/repos/synthetic/review/git/refs/heads/${f.environment.source.workingBranch}`],
  ]);
  for (const [index, alias] of aliases.entries()) assert.deepEqual(Buffer.from(f.raw(alias)), originals[index]);
  assert.deepEqual(f.github.commits.get(restored.commit).parents, [saved.commit]);
});
