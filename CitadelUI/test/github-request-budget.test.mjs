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

test('request budget: two individually legal 5 MiB files fail before normalization allocates decoded buffers', () => {
  const files = ['one', 'two'].map((name) => ({
    alias: `bicep/infra/${name}.bicepparam`, create: true, after: Buffer.alloc(5 * 1024 * 1024, 32).toString('base64'),
  }));
  assert.throws(() => normalizeChangeSet(files), rejected);
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
  const c = coordinator();
  const single = [{ alias: MAIN, beforeHash: 'd'.repeat(64), after: new Uint8Array(MAX_SOURCE_BYTES) }];
  const budget = await c.value.validateRequest(single);
  assert(budget.encodedBytes < LIMIT);
  await assert.rejects(c.value.validateRequest([{ ...single[0], after: new Uint8Array(MAX_SOURCE_BYTES + 1) }]),
    (error) => error.code === 'SOURCE_TOO_LARGE');
  const pair = [MAIN, POLICY].map((alias) => ({ alias, beforeHash: 'd'.repeat(64), after: new Uint8Array(5 * 1024 * 1024) }));
  await assert.rejects(c.value.validateRequest(pair), rejected);
  await assert.rejects(c.value.commit(pair), rejected);
  assert.equal(c.calls.length, 0);
});

test('request budget: actual commit serialization matches preview accounting including BOM and native proof', async () => {
  const c = coordinator();
  const files = [{ alias: MAIN, beforeHash: 'd'.repeat(64), after: new Uint8Array([0xef, 0xbb, 0xbf, 0xc3, 0xa9, 13, 10]) }];
  const options = { nativeProof: { configuration: { profileId: 'synthetic' }, dependencies: [{ alias: 'variables.tf', hash: 'e'.repeat(64) }] },
    nativeIdentity: { configuration: '{"profileId":"synthetic"}', hash: 'f'.repeat(64) } };
  const preview = await c.value.validateRequest(files, options);
  await c.value.commit(files, options);
  assert.equal(c.calls.length, 1); assert.equal(jsonBytes(c.calls[0].body), preview.encodedBytes);
  assert.deepEqual(Buffer.from(c.calls[0].body.files[0].after, 'base64'), Buffer.from(files[0].after));
  await assert.rejects(c.value.validateRequest(files, { ...options, nativeProof: { note: 'x'.repeat(LIMIT) } }), rejected);
  await assert.rejects(c.value.validateRequest(files, { nativeIdentity: { note: 'x'.repeat(LIMIT) } }), rejected);
  assert.equal(c.calls.length, 1);
});

test('request budget: the public commit route cannot opt out of the aggregate budget', async () => {
  const f = await githubWorkspaceFixture(), head = await f.provider.workspaceHead();
  await assert.rejects(f.request(`/api/github/workspaces/${f.environment.id}/commits`, { method: 'POST', body: JSON.stringify({
    ...header(), expectedHead: head, requestBudget: false,
    files: [{ alias: 'bicep/infra/small.bicepparam', create: true, after: 'IA==' }],
  }) }), (error) => error.status === 400);
  assert.equal(f.audit.commits.length, 0);
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
