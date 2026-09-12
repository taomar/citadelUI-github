import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CredentialVault } from '../server/credentials.mjs';
import { createCitadelServer } from '../server/index.mjs';
import { GitHubApiClient } from '../server/github/api.mjs';
import * as reader from '../server/github/git-reader.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import * as workspace from '../server/github/workspace.mjs';
import { createWorkspaceRoutes } from '../server/github/workspace-routes.mjs';
import { MAX_GITHUB_COMMIT_REQUEST_BYTES, sha256 } from '../shared/source-scope.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';
import { nativeConfiguration } from './_native-fixture.mjs';

const ALIAS = 'bicep/infra/main.bicepparam';
const OPERATIONS = [
  ['GET', 'tree'], ['GET', 'blob'], ['GET', 'history'], ['GET', 'commits'],
  ['GET', 'subscription'], ['POST', 'commits'], ['POST', 'commit-branches'],
  ['POST', 'subscription'], ['POST', 'reverts'],
];

function fixture(settings = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9901, fullName: 'synthetic/a5-routes' });
  const environment = {
    id: 'a5-routes',
    source: {
      kind: 'github', repositoryId: repository.id, fullName: repository.full_name,
      connectionProfileId: 'profile-a5', sourceBranch: 'main',
      workingBranch: 'citadel-ui/a5-routes', writeMode: 'working-branch',
    },
  };
  const head = github.seed(repository, environment.source.workingBranch, citadelRepositoryFiles(settings.files || {}));
  const events = [], requests = [];
  const client = new GitHubApiClient({
    fetch: async (href, init) => {
      const url = new URL(href);
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(init.headers.Authorization, `Bearer ${TEST_TOKEN}`);
      const call = {
        kind: 'request', method: init.method, path: url.pathname + url.search,
        body: init.body === undefined ? null : JSON.parse(init.body),
      };
      events.push(call);
      requests.push(call);
      return settings.respond ? settings.respond(href, init, github) : github.fetch(href, init);
    },
  });
  const sessions = new GitHubSessionStore();
  const session = sessions.create(TEST_TOKEN, github.user, { profileId: environment.source.connectionProfileId });
  const resolve = sessions.resolve.bind(sessions);
  sessions.resolve = (id) => { events.push({ kind: 'session.resolve' }); return resolve(id); };
  const registry = environmentRegistry({ [environment.id]: environment });
  const registryStore = {
    getEnvironment: (id) => { events.push({ kind: 'registry', id }); return registry.getEnvironment(id); },
  };
  const audit = new MemoryAudit();
  const routes = new GitHubRoutes({ client, sessions, registryStore, audit });
  const req = (method) => ({ method, headers: { 'x-citadel-github-session': session.id } });
  const reset = () => { events.length = 0; requests.length = 0; };
  const call = (operation, method = 'GET', body = {}, query = {}) => {
    const url = new URL(`http://127.0.0.1/api/github/workspaces/${environment.id}/${operation}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return routes.workspace({
      req: req(method), url, environmentId: environment.id, operation,
      readBody: async () => { events.push({ kind: 'body' }); return body; },
    });
  };
  return { github, repository, environment, head, events, requests, client, sessions, session, audit, routes, req, reset, call, settings };
}

function adapter(f, overrides = {}) {
  const validation = [];
  const ports = {
    client: f.client, audit: f.audit,
    tree: (...args) => f.routes.tree(...args),
    blob: (...args) => f.routes.blob(...args),
    ...reader,
    ...workspace,
    // These spies characterize the private facade validators' port contracts.
    // Invalid input is exercised through the real facade in the tests below.
    assertKeys: (body, allowed) => { validation.push({ body, allowed: [...allowed] }); },
    transactionIdOf: (value) => value,
    ...overrides,
  };
  return { value: createWorkspaceRoutes(ports), validation, ports };
}

test('A5 Git routes: every workspace operation resolves connection ownership before body or adapter access', async () => {
  const f = fixture();
  f.environment.source.connectionProfileId = 'another-profile';
  let entered = 0;
  const original = f.routes.workspaceRoutes.workspace.bind(f.routes.workspaceRoutes);
  f.routes.workspaceRoutes.workspace = (...args) => { entered += 1; return original(...args); };
  for (const [method, operation] of OPERATIONS) {
    f.reset();
    await assert.rejects(f.call(operation, method, { unsupported: true }), {
      status: 409, code: 'CONNECTION_MISMATCH',
    });
    assert.deepEqual(f.events, [
      { kind: 'session.resolve' }, { kind: 'registry', id: f.environment.id },
    ], `${method} ${operation}`);
  }
  assert.equal(entered, 0);
  assert.deepEqual(f.audit.commits, []);
});

test('A5 Git routes: donors and local sources do not acquire editable workspace authority', async () => {
  const f = fixture();
  for (const kind of ['local', 'public-donor', 'migration-source']) {
    f.environment.source.kind = kind;
    f.reset();
    await assert.rejects(f.call('commits', 'POST'), { status: 400, code: 'NOT_GITHUB_ENVIRONMENT' });
    assert.deepEqual(f.events.map((event) => event.kind), ['session.resolve', 'registry']);
  }
  f.environment.source.kind = 'github';
  f.session.id = 'not-a-live-session-id';
  f.reset();
  await assert.rejects(f.call('tree'), { status: 401, code: 'GITHUB_SESSION_EXPIRED' });
  assert.deepEqual(f.events.map((event) => event.kind), ['session.resolve']);
});

test('A5 Git routes: repository IDs are re-resolved and query or body identities cannot retarget them', async () => {
  const f = fixture();
  const tree = await f.call('tree', 'GET', {}, {
    repositoryId: '7777', fullName: 'someone/else', branch: 'elsewhere', workingBranch: 'elsewhere',
  });
  assert.equal(tree.repository.id, f.repository.id);
  assert.equal(tree.repository.fullName, f.repository.full_name);
  assert.equal(tree.branch, f.environment.source.workingBranch);
  assert.equal(tree.head, f.head);
  assert.deepEqual(f.requests.slice(0, 2).map((call) => [call.method, call.path, call.body]), [
    ['GET', '/repositories/9901', null],
    ['GET', `/repos/${f.repository.full_name}/git/ref/heads/${f.environment.source.workingBranch}`, null],
  ]);
  const firstTree = f.routes.treeCache.values().next().value;
  f.reset();
  await f.call('tree');
  assert.deepEqual(f.requests.map((call) => call.path), [
    '/repositories/9901',
    `/repos/${f.repository.full_name}/git/ref/heads/${f.environment.source.workingBranch}`,
  ]);
  assert.equal(f.routes.treeCache.values().next().value, firstTree);
  const entry = tree.files.find((file) => file.alias === ALIAS);
  const bytes = Buffer.from(f.github.blobs.get(entry.sha), 'base64');
  f.reset();
  const blob = await f.call('blob', 'GET', {}, { alias: ALIAS, sha: entry.sha });
  assert.deepEqual(blob, {
    alias: ALIAS, sha: entry.sha, size: bytes.byteLength,
    hash: await sha256(bytes), content: bytes.toString('base64'),
  });
  assert.deepEqual(f.requests.map((call) => call.path), [
    '/repositories/9901',
    `/repos/${f.repository.full_name}/git/ref/heads/${f.environment.source.workingBranch}`,
    `/repos/${f.repository.full_name}/git/blobs/${entry.sha}`,
  ]);
  const firstBlob = f.routes.blobCache.values().next().value;
  f.reset();
  assert.deepEqual(await f.call('blob', 'GET', {}, { alias: ALIAS, sha: entry.sha }), blob);
  assert.deepEqual(f.requests.map((call) => call.path), [
    '/repositories/9901',
    `/repos/${f.repository.full_name}/git/ref/heads/${f.environment.source.workingBranch}`,
  ]);
  assert.equal(f.routes.blobCache.values().next().value, firstBlob);
  f.repository.full_name = 'synthetic/renamed';
  f.reset();
  await assert.rejects(f.call('commits', 'POST', { fullName: 'synthetic/a5-routes' }), {
    status: 409, code: 'REPOSITORY_RENAMED',
  });
  assert.deepEqual(f.events.map((event) => event.kind), ['session.resolve', 'registry', 'request']);
  assert.deepEqual(f.requests.map((call) => call.path), ['/repositories/9901']);
});

for (const operation of ['commits', 'reverts']) {
  test(`A5 Git routes: public ${operation} cannot supply mutation authority or a budget opt-out`, async () => {
    const f = fixture();
    const body = operation === 'commits' ? {
      action: 'parameter-edit', expectedHead: f.head, transactionId: 'a5-prohibited-change',
      files: [{ alias: 'bicep/infra/a5-new.bicepparam', create: true, after: 'IA==' }],
    } : { commit: f.head, transactionId: 'a5-prohibited-change' };
    for (const key of ['repositoryId', 'fullName', 'branch', 'workingBranch', 'connectionProfileId', 'requestBudget', 'subscriptionAlias', 'nativeHistory', 'authorName']) {
      f.reset();
      await assert.rejects(f.call(operation, 'POST', {
        ...body, [key]: false,
      }), { status: 400, code: 'INVALID_CONTENT' });
      assert.deepEqual(f.events.map((event) => event.kind), ['session.resolve', 'registry', 'request', 'body']);
      assert.deepEqual(f.requests.map((call) => [call.method, call.path]), [['GET', '/repositories/9901']]);
    }
    assert.deepEqual(f.audit.commits, []);
    assert.equal(f.repository.refs.get(f.environment.source.workingBranch), f.head);
  });
}

test('A5 Git routes: commit validation preserves head, action and transaction error ordering', async () => {
  const f = fixture();
  for (const [body, code] of [
    [{ expectedHead: 'invalid', action: 'bad', transactionId: 'bad', files: [] }, 'INVALID_SHA'],
    [{ expectedHead: f.head, action: 'bad', transactionId: 'bad', files: [] }, 'INVALID_ACTION'],
    [{ expectedHead: f.head, action: 'parameter-edit', transactionId: 'bad', files: [] }, 'INVALID_TRANSACTION'],
    [{ expectedHead: f.head, action: 'parameter-edit', transactionId: 'a5-valid-change', files: [] }, 'INVALID_CHANGE_SET'],
  ]) {
    f.reset();
    await assert.rejects(f.call('commits', 'POST', body), { status: 400, code });
    assert.deepEqual(f.requests.map((call) => [call.method, call.path]), [['GET', '/repositories/9901']]);
  }
  f.environment.configuration = nativeConfiguration(['deployment']);
  for (const method of ['GET', 'POST']) {
    f.reset();
    await assert.rejects(f.call('subscription', method, { invalid: true }), { status: 400, code: 'NATIVE_NO_SUBSCRIPTION_BRIDGE' });
    assert.equal(f.events.some((event) => event.kind === 'body'), false);
    assert.deepEqual(f.requests.map((call) => call.path), ['/repositories/9901']);
  }
});

for (const outcome of ['applied', 'unchanged', 'pending', 'indeterminate']) {
  test(`A5 Git routes: the commit adapter preserves ${outcome} with the resolved authority and exact request body`, async () => {
    const f = fixture();
    const resolved = await f.routes.resolve(f.req('POST'), f.environment.id);
    const answer = Object.freeze({
      outcome, applied: outcome === 'indeterminate' ? null : outcome === 'applied',
      changed: outcome === 'applied', commit: outcome === 'unchanged' ? null : 'b'.repeat(40),
      transactionId: 'a5-result-change', warnings: ['Synthetic warning'],
      ...(outcome === 'unchanged' ? { equivalentCommit: f.head, proposedCommit: 'b'.repeat(40) } : {}),
      ...(['pending', 'indeterminate'].includes(outcome) ? { unresolved: { intendedBranch: resolved.source.workingBranch } } : {}),
    });
    const writes = [];
    const a = adapter(f, { commitChangeSet: (...args) => { writes.push(args); return answer; } });
    const body = {
      action: 'parameter-edit', expectedHead: f.head, transactionId: 'a5-reviewed-change',
      files: [{ alias: 'bicep/infra/created.bicepparam', create: true, after: 'IA==' }],
      nativeProof: { note: 'review metadata' }, nativeIdentity: { note: 'identity metadata' },
    };
    let reads = 0;
    f.reset();
    const result = await a.value.workspace(resolved, {
      req: f.req('POST'), url: new URL('http://127.0.0.1/?branch=other'), environmentId: f.environment.id,
      operation: 'commits', readBody: async () => { reads += 1; return body; },
    });
    assert.equal(result, answer);
    assert.equal(reads, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][0], f.client);
    assert.equal(writes[0][1], TEST_TOKEN);
    assert.deepEqual(writes[0][2], {
      fullName: resolved.repository.fullName, branch: resolved.source.workingBranch,
      requestBody: body, repositoryId: resolved.repository.id, expectedHead: f.head,
      files: body.files, action: body.action, environmentId: f.environment.id,
      transactionId: body.transactionId, audit: f.audit, configuration: resolved.source.configuration,
      nativeProof: body.nativeProof, nativeIdentity: body.nativeIdentity,
    });
    assert.equal(writes[0][2].requestBody, body);
    assert.equal(writes[0][2].configuration, resolved.source.configuration);
    assert.deepEqual(a.validation, [{
      body, allowed: ['action', 'expectedHead', 'transactionId', 'files', 'nativeProof', 'nativeIdentity'],
    }]);
    assert.deepEqual(f.requests, []);
  });
}

test('A5 Git routes: History adapters keep the audit tuple, envelopes and inverse writer arguments', async () => {
  const f = fixture();
  const resolved = await f.routes.resolve(f.req('GET'), f.environment.id);
  const record = { commit: f.head, repositoryId: f.repository.id, environmentId: f.environment.id, branch: resolved.source.workingBranch };
  const auditQueries = [], historyCalls = [], inspectCalls = [], inverseCalls = [], branchCalls = [];
  const rows = [{ commit: f.head }], transaction = { commit: f.head, canRevert: false };
  const pending = { outcome: 'pending', applied: false, commit: 'b'.repeat(40), warnings: ['Keep this draft'] };
  const a = adapter(f, {
    audit: { find: async (query) => { auditQueries.push(query); return record; } },
    loadHistory: (...args) => { historyCalls.push(args); return rows; },
    inspectCommit: (...args) => { inspectCalls.push(args); return transaction; },
    revertCommit: (...args) => { inverseCalls.push(args); return pending; },
    createCommitBranch: (...args) => { branchCalls.push(args); return pending; },
  });
  const invoke = (method, operation, body = {}) => a.value.workspace(resolved, {
    req: f.req(method), url: new URL(`http://127.0.0.1/?sha=${f.head}`),
    environmentId: f.environment.id, operation, readBody: async () => body,
  });
  assert.deepEqual(await invoke('GET', 'history'), { transactions: rows });
  assert.deepEqual(historyCalls, [[f.client, TEST_TOKEN, resolved.repository.fullName, resolved.source.workingBranch,
    f.environment.id, { audit: a.ports.audit, configuration: resolved.source.configuration }]]);
  assert.deepEqual(await invoke('GET', 'commits'), { transaction });
  assert.deepEqual(auditQueries, [{
    commit: f.head, repositoryId: f.repository.id, environmentId: f.environment.id, branch: resolved.source.workingBranch,
  }]);
  assert.deepEqual(inspectCalls, [[f.client, TEST_TOKEN, resolved.repository.fullName, resolved.source.workingBranch,
    f.head, { record, configuration: resolved.source.configuration }]]);
  assert.equal(await invoke('POST', 'reverts', { commit: f.head, transactionId: 'a5-inverse-change' }), pending);
  assert.deepEqual(inverseCalls, [[f.client, TEST_TOKEN, {
    fullName: resolved.repository.fullName, branch: resolved.source.workingBranch, repositoryId: f.repository.id,
    commitSha: f.head, environmentId: f.environment.id, transactionId: 'a5-inverse-change',
    audit: a.ports.audit, configuration: resolved.source.configuration,
  }]]);
  assert.equal(await invoke('POST', 'commit-branches', { commit: f.head, branch: 'citadel-ui/explicit-choice' }), pending);
  assert.deepEqual(branchCalls, [[f.client, TEST_TOKEN, {
    fullName: resolved.repository.fullName, commitSha: f.head, branch: 'citadel-ui/explicit-choice',
    intendedBranch: resolved.source.workingBranch, configuration: resolved.source.configuration,
    environmentId: f.environment.id, repositoryId: f.repository.id, audit: a.ports.audit,
  }]]);
  assert.deepEqual(a.validation.map((entry) => entry.allowed), [['commit', 'transactionId'], ['commit', 'branch']]);
});

test('A5 Git routes: subscription no-op and post-publication warnings preserve bytes and save attribution', async () => {
  const alias = '.azure/dev/.env';
  const value = '11111111-1111-4111-8111-111111111111';
  const nextValue = '22222222-2222-4222-8222-222222222222';
  const before = `AZURE_SUBSCRIPTION_ID=${value}\r\nOTHER=preserved\r\n`;
  const f = fixture({ files: { [alias]: before } });
  const body = { environmentName: 'dev', value, expectedHead: f.head, expectedHash: await sha256(Buffer.from(before)), transactionId: 'a5-subscription-change' };
  const unchanged = await f.call('subscription', 'POST', body);
  assert.equal(unchanged.changed, false);
  assert.equal(f.requests.some((call) => call.method !== 'GET'), false);
  assert.equal(f.audit.commits.length, 0);
  let published = false;
  f.settings.respond = async (href, init, github) => {
    if (published && new URL(href).pathname.includes('/git/commits/')) {
      return github.json(503, { message: 'Synthetic verification read failure' });
    }
    const response = await github.fetch(href, init);
    if (init.method === 'PATCH') published = true;
    return response;
  };
  f.reset();
  const changed = await f.call('subscription', 'POST', { ...body, value: nextValue });
  assert.equal(changed.changed, true);
  assert.equal(changed.verified, false);
  assert.equal(changed.commit, f.repository.refs.get(f.environment.source.workingBranch));
  assert(changed.warnings.some((warning) => warning.startsWith('The subscription was committed, but it could not be re-read:')));
  assert.equal(f.audit.commits.length, 1);
  assert.equal(f.github.fileText(f.repository, f.environment.source.workingBranch, alias), before.replace(value, nextValue));
  assert.equal(f.requests.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(JSON.stringify(changed).includes('OTHER=preserved'), false);
});

function httpCall(port, path, { method = 'POST', body = '{}', headers = {}, headersOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path, method, agent: false,
      headers: {
        Host: '127.0.0.1:4173', Origin: 'http://127.0.0.1:4173',
        'Sec-Fetch-Site': 'same-origin', 'X-Citadel-Session': 'a5-browser-session',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        Connection: 'close', ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Synthetic HTTP request timed out')));
    req.end(headersOnly ? undefined : body);
  });
}

async function httpFixture(t, handle, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'citadel-a5-route-http-'));
  const webRoot = join(root, 'web'), sharedRoot = join(root, 'shared'), dataRoot = join(root, 'data');
  let server;
  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.server.close(resolve));
      await server.activityStore?.settled?.();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await mkdir(webRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  server = await createCitadelServer({
    webRoot, sharedRoot, dataRoot, allowedHost: '127.0.0.1:4173',
    allowedOrigin: 'http://127.0.0.1:4173', sessionToken: 'a5-browser-session',
    credentialVault: new CredentialVault({
      dataRoot, keySource: { read: async () => ({ bytes: null, reason: 'synthetic-unavailable' }) },
    }),
    githubRoutes: { handle }, ...options,
  });
  await new Promise((resolve, reject) => {
    server.server.once('error', reject);
    server.server.listen(0, '127.0.0.1', resolve);
  });
  return (path, input) => httpCall(server.server.address().port, path, input);
}

test('A5 Git routes: real HTTP transport keeps guard order, method envelopes and exact encoded body caps', async (t) => {
  let calls = 0;
  const call = await httpFixture(t, async ({ readBody }) => {
    calls += 1;
    return { encodedBytes: Buffer.byteLength(JSON.stringify(await readBody())) };
  });
  const path = '/api/github/workspaces/a5/commits';
  for (const [headers, status, code] of [
    [{ Host: 'wrong.invalid', 'Sec-Fetch-Site': 'cross-site', 'X-Citadel-Session': 'wrong', Origin: 'wrong' }, 421, 'INVALID_HOST'],
    [{ 'Sec-Fetch-Site': 'cross-site', 'X-Citadel-Session': 'wrong', Origin: 'wrong' }, 403, 'INVALID_FETCH_SITE'],
    [{ 'X-Citadel-Session': 'wrong', Origin: 'wrong' }, 401, 'INVALID_SESSION'],
    [{ Origin: 'wrong' }, 403, 'INVALID_ORIGIN'],
  ]) {
    const result = await call(path, { headers, body: 'not json' });
    assert.equal(result.status, status);
    assert.deepEqual(Object.keys(result.body), ['error']);
    assert.equal(result.body.error.code, code);
    assert.equal(typeof result.body.error.correlationId, 'string');
  }
  const refusedMethod = await call(path, { method: 'PUT' });
  assert.equal(refusedMethod.status, 405);
  assert.equal(refusedMethod.headers.allow, 'GET, POST, DELETE');
  assert.equal(refusedMethod.body.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(calls, 0);
  const limit = MAX_GITHUB_COMMIT_REQUEST_BYTES;
  assert.equal(limit, 12582912);
  const padding = limit - Buffer.byteLength(JSON.stringify({ padding: '' }));
  const body = JSON.stringify({ padding: 'x'.repeat(padding) });
  const over = JSON.stringify({ padding: 'x'.repeat(padding + 1) });
  assert.equal(Buffer.byteLength(body), 12582912);
  assert.equal(Buffer.byteLength(over), 12582913);
  for (const operation of ['commits', 'reverts']) {
    const accepted = await call(`/api/github/workspaces/a5/${operation}`, { body });
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { encodedBytes: 12582912 });
    // Refusal is deliberately header-first; no reset is disguised as a 413.
    const refused = await call(`/api/github/workspaces/a5/${operation}`, { body: over, headersOnly: true });
    assert.equal(refused.status, 413);
    assert.equal(refused.body.error.code, 'BODY_TOO_LARGE');
  }
  const generic = await call('/api/github/connections', { body, headersOnly: true });
  assert.equal(generic.status, 413);
  assert.equal(generic.body.error.code, 'BODY_TOO_LARGE');
});

test('A5 Git routes: real HTTP concurrency admission still precedes transport and body guards', async (t) => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const call = await httpFixture(t, async () => {
    calls += 1;
    entered.resolve();
    await release.promise;
    return { released: true };
  }, { maxConcurrency: 1 });
  const first = call('/api/github/hold');
  await entered.promise;
  try {
    const refused = await call('/api/github/workspaces/a5/commits', {
      headers: { Host: 'wrong.invalid', 'X-Citadel-Session': 'wrong' }, body: 'not json',
    });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.code, 'SERVER_BUSY');
    assert.equal(refused.headers['retry-after'], '1');
    assert.equal(calls, 1);
  } finally {
    release.resolve();
  }
  assert.deepEqual((await first).body, { released: true });
});
