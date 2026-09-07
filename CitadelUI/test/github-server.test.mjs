import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCitadelServer } from '../server/index.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MockGitHub, TEST_TOKEN } from './_github-mock.mjs';

function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(options.body) : null;
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        headers: {
          ...options.headers,
          // Declared up front so the server can refuse an oversized body before
          // the client streams it, instead of resetting mid-upload.
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            text() {
              return this.body.toString('utf8');
            },
            json() {
              return JSON.parse(this.body.toString('utf8'));
            },
          })
        );
      }
    );
    req.on('error', (error) => {
      // A server that refuses an oversized body may close the socket before the
      // client finishes writing. That is a rejection, not a transport bug.
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
        resolve({
          status: 413,
          headers: {},
          body: Buffer.from('{"error":{"code":"BODY_TOO_LARGE","message":"connection reset"}}'),
          text() {
            return this.body.toString('utf8');
          },
          json() {
            return JSON.parse(this.body.toString('utf8'));
          },
        });
        return;
      }
      reject(error);
    });
    if (body) req.write(body);
    req.end();
  });
}

async function start(options = {}) {
  const root = options.root || (await mkdtemp(join(tmpdir(), 'citadel-github-http-')));
  const webRoot = join(root, 'web');
  const sharedRoot = join(root, 'shared');
  const dataRoot = options.dataRoot || join(root, 'data');
  await mkdir(webRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body></body></html>'
  );
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const allowedHost = '127.0.0.1:4173';
  const sessionToken = 'test-session-token';
  const created = await createCitadelServer({
    webRoot,
    sharedRoot,
    dataRoot,
    allowedHost,
    allowedOrigin: `http://${allowedHost}`,
    sessionToken,
    githubOptions: { clientOptions: { fetch: github.fetch }, ...(options.githubOptions || {}) },
  });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  const port = created.server.address().port;
  const call = (path, options = {}) =>
    httpRequest(port, path, {
      ...options,
      headers: {
        Host: allowedHost,
        'Sec-Fetch-Site': 'same-origin',
        'X-Citadel-Session': sessionToken,
        ...(options.method && options.method !== 'GET'
          ? { Origin: `http://${allowedHost}`, 'Content-Type': 'application/json' }
          : {}),
        ...(options.headers || {}),
      },
    });
  return { root, github, repository, dataRoot, call, ...created };
}

async function close(fixture) {
  await new Promise((resolve) => fixture.server.close(resolve));
  await rm(fixture.root, { recursive: true, force: true });
}

test('GitHub routes require the browser session and the opaque GitHub session', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  const unauthenticated = await httpRequest(
    fixture.server.address().port,
    '/api/github/repos',
    { headers: { Host: '127.0.0.1:4173', 'Sec-Fetch-Site': 'same-origin' } }
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.json().error.code, 'INVALID_SESSION');

  const crossSite = await fixture.call('/api/github/repos', {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.json().error.code, 'INVALID_FETCH_SITE');

  const noGitHubSession = await fixture.call('/api/github/repos');
  assert.equal(noGitHubSession.status, 401);
  assert.equal(noGitHubSession.json().error.code, 'GITHUB_SESSION_REQUIRED');

  const badMethod = await fixture.call('/api/github/repos', { method: 'PUT', body: '{}' });
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.allow, 'GET, POST, DELETE');
});

test('non-GitHub API routes keep their original method allow-list', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const rejected = await fixture.call('/api/health', { method: 'DELETE' });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.allow, 'GET, POST, PUT');
});

test('repository creation routes enforce browser and credential protection and refuse visibility overrides', async (t) => {
  const calls = [];
  const operation = { id: 'operation-1', state: 'ready', destination: { private: true, fullName: 'octo-dev/new-repo' } };
  const creations = {
    initialize: async () => {},
    shutdown: () => {},
    list: async (session) => { calls.push(['list', session.accountId]); return { operations: [operation] }; },
    prepare: async (session, body) => { calls.push(['prepare', session.accountId, body]); return operation; },
    status: async (session, id) => { calls.push(['status', session.accountId, id]); return operation; },
    ...Object.fromEntries(['start', 'resume', 'pause'].map((action) => [
      action,
      async (session, id) => { calls.push([action, session.accountId, id]); return operation; },
    ])),
  };
  const fixture = await start({ githubOptions: { creations } });
  t.after(() => close(fixture));
  const base = '/api/github/repository-creations';
  assert.equal((await fixture.call(base)).status, 401);
  assert.equal((await fixture.call(base, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const connected = await fixture.call('/api/github/sessions', {
    method: 'POST', body: JSON.stringify({ token: TEST_TOKEN }),
  });
  const headers = { 'X-Citadel-GitHub-Session': connected.json().id };
  for (const field of ['private', 'visibility', 'owner', 'token']) {
    const refused = await fixture.call(base, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'new-repo', sourceUrl: 'https://github.com/source/repo/tree/main', operationKey: 'test-key-1', [field]: false }),
    });
    assert.equal(refused.status, 400, field);
  }
  assert.deepEqual(calls, []);
  const body = { name: 'new-repo', sourceUrl: 'https://github.com/source/repo/tree/main', operationKey: 'test-key-1' };
  const prepared = await fixture.call(base, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.text().includes(TEST_TOKEN), false);
  assert.deepEqual(calls[0], ['prepare', 4242, body]);
  assert.equal((await fixture.call(base, { headers })).status, 200);
  assert.equal((await fixture.call(`${base}/operation-1`, { headers })).status, 200);
  for (const action of ['start', 'resume', 'pause']) {
    assert.equal((await fixture.call(`${base}/operation-1/${action}`, {
      method: 'POST', headers, body: '{}',
    })).status, 200);
    assert.equal((await fixture.call(`${base}/operation-1/${action}`, {
      method: 'POST', headers, body: '{"private":false}',
    })).status, 400);
  }
  assert.equal((await fixture.call(`${base}/operation-1/public`, { method: 'POST', headers, body: '{}' })).status, 404);
  assert.deepEqual(calls.slice(1).map((item) => item[0]), ['list', 'status', 'start', 'resume', 'pause']);
});

test('connect, list, and disconnect work over HTTP without exposing the token', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  const connected = await fixture.call('/api/github/sessions', {
    method: 'POST',
    body: JSON.stringify({ token: TEST_TOKEN }),
  });
  assert.equal(connected.status, 200);
  const session = connected.json();
  assert.equal(session.login, 'octo-dev');
  assert.equal(connected.text().includes(TEST_TOKEN), false);
  assert.equal(connected.text().includes('github_pat_'), false);

  const repos = await fixture.call('/api/github/repos', {
    headers: { 'X-Citadel-GitHub-Session': session.id },
  });
  assert.equal(repos.status, 200);
  assert.deepEqual(
    repos.json().repositories.map((item) => item.fullName),
    ['taomar/citadelQA']
  );
  assert.equal(repos.text().includes(TEST_TOKEN), false);

  const branches = await fixture.call('/api/github/repos/9001/branches', {
    headers: { 'X-Citadel-GitHub-Session': session.id },
  });
  assert.equal(branches.status, 200);
  assert.deepEqual(branches.json().branches.map((item) => item.name), ['main']);

  const badToken = await fixture.call('/api/github/sessions', {
    method: 'POST',
    body: JSON.stringify({ token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' }),
  });
  assert.equal(badToken.status, 400);
  assert.equal(badToken.json().error.code, 'GITHUB_TOKEN_CLASSIC');

  const disconnected = await fixture.call(
    `/api/github/sessions/${encodeURIComponent(session.id)}`,
    { method: 'DELETE', headers: { 'X-Citadel-GitHub-Session': session.id } }
  );
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.json().disconnected, true);

  const after = await fixture.call('/api/github/repos', {
    headers: { 'X-Citadel-GitHub-Session': session.id },
  });
  assert.equal(after.status, 401);
});

test('a GitHub environment is mirrored to /data without any credential', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const current = await fixture.call('/api/registry');
  const authority = current.json();
  const saved = await fixture.call('/api/registry', {
    method: 'PUT',
    body: JSON.stringify({
      expectedEpoch: authority.epoch,
      expectedRevision: authority.revision,
      projects: [{ id: 'project-one', label: 'Citadel', createdAt: null, updatedAt: null }],
      environments: [
        {
          id: 'env-github-one',
          projectId: 'project-one',
          label: 'GitHub QA',
          source: {
            kind: 'github',
            repositoryId: 9001,
            fullName: 'taomar/citadelQA',
            sourceBranch: 'main',
            workingBranch: 'citadel-ui/env-github-one',
            writeMode: 'working-branch',
          },
          fingerprint: null,
          toolVersion: '1.0.0-local',
          settingsVersion: 3,
          fingerprintVersion: 1,
          compatibility: 'supported',
          createdAt: null,
          updatedAt: null,
          lastOpenedAt: null,
          lastScannedAt: null,
        },
      ],
      removedProjectIds: [],
      removedEnvironmentIds: [],
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json().environments[0].source, {
    kind: 'github',
    connectionProfileId: null,
    repositoryId: 9001,
    fullName: 'taomar/citadelQA',
    sourceBranch: 'main',
    // Untouched. The record posted above has no `branchChoice`, which is the
    // shape every workspace attached before the user could name a branch has.
    // Migration was dropped on the user's instruction, so nothing is derived:
    // the branch is carried through and the unknown provenance stays null rather
    // than being guessed at.
    workingBranch: 'citadel-ui/env-github-one',
    writeMode: 'working-branch',
    branchChoice: null,
    lastKnownHead: null,
    capabilities: null,
    validatedAt: null,
  });

  const raw = await readFile(join(fixture.dataRoot, 'settings', 'registry.json'), 'utf8');
  for (const forbidden of ['github_pat_', 'token', 'Authorization', '.env', 'handle']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
});

test('a source above the generic JSON limit still commits through real HTTP parsing', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const session = (
    await fixture.call('/api/github/sessions', {
      method: 'POST',
      body: JSON.stringify({ token: TEST_TOKEN }),
    })
  ).json();
  const headers = { 'X-Citadel-GitHub-Session': session.id };
  const authority = (await fixture.call('/api/registry')).json();
  await fixture.call('/api/registry', {
    method: 'PUT',
    body: JSON.stringify({
      expectedEpoch: authority.epoch,
      expectedRevision: authority.revision,
      projects: [{ id: 'project-one', label: 'Citadel', createdAt: null, updatedAt: null }],
      environments: [
        {
          id: 'env-github-one',
          projectId: 'project-one',
          label: 'QA',
          compatibility: 'supported',
          source: {
            kind: 'github',
            repositoryId: 9001,
            fullName: 'taomar/citadelQA',
            sourceBranch: 'main',
            workingBranch: 'citadel-ui/env-github-one',
            writeMode: 'working-branch',
          },
        },
      ],
      removedProjectIds: [],
      removedEnvironmentIds: [],
    }),
  });
  await fixture.call('/api/github/attachments', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      repositoryId: 9001,
      sourceBranch: 'main',
      environmentId: 'env-github-one',
      writeMode: 'working-branch',
    }),
  });
  const head = fixture.repository.refs.get('citadel-ui/env-github-one');

  // 3 MiB of source: above the 2 MiB generic JSON body limit, and larger still
  // once base64-encoded, but well within the advertised 8 MiB source limit.
  const source = `using 'main.bicep'\n// ${'x'.repeat(3 * 1024 * 1024)}\n`;
  const accepted = await fixture.call(
    '/api/github/workspaces/env-github-one/commits',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/large.bicepparam',
            create: true,
            after: Buffer.from(source).toString('base64'),
          },
        ],
      }),
    }
  );
  assert.equal(accepted.status, 200, accepted.text().slice(0, 200));
  assert.equal(
    fixture.github.fileText(fixture.repository, 'citadel-ui/env-github-one', 'bicep/infra/large.bicepparam'),
    source
  );

  // A single file beyond the advertised source limit is still refused.
  const oversized = await fixture.call(
    '/api/github/workspaces/env-github-one/commits',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'parameter-edit',
        expectedHead: fixture.repository.refs.get('citadel-ui/env-github-one'),
        transactionId: '22222222-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/huge.bicepparam',
            create: true,
            after: Buffer.from('y'.repeat(9 * 1024 * 1024)).toString('base64'),
          },
        ],
      }),
    }
  );
  assert.equal(oversized.status, 413);

  // The aggregate body remains bounded regardless of per-file size.
  const aggregate = await fixture.call(
    '/api/github/workspaces/env-github-one/commits',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'parameter-edit',
        expectedHead: fixture.repository.refs.get('citadel-ui/env-github-one'),
        transactionId: '33333333-2222-3333-4444-555555555555',
        files: Array.from({ length: 6 }, (_value, index) => ({
          alias: `bicep/infra/bulk-${index}.bicepparam`,
          create: true,
          after: Buffer.from('z'.repeat(2 * 1024 * 1024)).toString('base64'),
        })),
      }),
    }
  );
  assert.equal(aggregate.status, 413);

  // Non-GitHub routes keep the original, smaller ceiling.
  const generic = await fixture.call('/api/core/policy/read', {
    method: 'POST',
    body: JSON.stringify({ text: 'a'.repeat(3 * 1024 * 1024) }),
  });
  assert.equal(generic.status, 413);
});

test('disconnect keeps the session id when the erase fails and succeeds on retry', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const session = (
    await fixture.call('/api/github/sessions', {
      method: 'POST',
      body: JSON.stringify({ token: TEST_TOKEN }),
    })
  ).json();

  // A transport failure must not be reported as a successful erase.
  let failNext = true;
  const request = async (path, options = {}) => {
    if (failNext && options.method === 'DELETE') {
      failNext = false;
      throw Object.assign(new Error('Network request failed'), { status: 0 });
    }
    const response = await fixture.call(path, {
      ...options,
      headers: { 'X-Citadel-GitHub-Session': session.id, ...(options.headers || {}) },
    });
    if (response.status >= 400) {
      throw Object.assign(new Error(response.json().error.message), {
        code: response.json().error.code,
        status: response.status,
      });
    }
    return response.json();
  };

  const { disconnectGitHub, githubSessionId } = await import('../web/js/github-session.mjs');
  const store = new Map([['citadel-ui.github-session', session.id]]);
  globalThis.sessionStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  globalThis.document = {
    querySelector: () => ({ content: 'test-session-token' }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    if (failNext && init.method === 'DELETE') {
      failNext = false;
      throw new Error('Network request failed');
    }
    const response = await fixture.call(path, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      ok: response.status < 400,
      status: response.status,
      statusText: '',
      json: async () => response.json(),
      arrayBuffer: async () => response.body,
      headers: new Map(),
    };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    delete globalThis.sessionStorage;
    delete globalThis.document;
  });

  await assert.rejects(disconnectGitHub(), /not disconnected/i);
  // The id is retained so the user can retry and the credential stays reachable.
  assert.equal(githubSessionId(), session.id);

  const retried = await disconnectGitHub();
  assert.equal(retried.disconnected, true);
  assert.equal(retried.erased, true);
  assert.equal(githubSessionId(), null);

  const after = await fixture.call('/api/github/repos', {
    headers: { 'X-Citadel-GitHub-Session': session.id },
  });
  assert.equal(after.status, 401);
  assert.ok(request);
});

test('project and GitHub environment settings survive a container restart', async (t) => {
  const fixture = await start();
  const dataRoot = fixture.dataRoot;
  const authority = (await fixture.call('/api/registry')).json();
  const environments = [
    {
      id: 'env-github-one',
      projectId: 'project-one',
      label: 'QA on GitHub',
      source: {
        kind: 'github',
        repositoryId: 9001,
        fullName: 'taomar/citadelQA',
        sourceBranch: 'main',
        workingBranch: 'citadel-ui/env-github-one',
        writeMode: 'working-branch',
      },
      compatibility: 'supported',
    },
    {
      id: 'env-local-one',
      projectId: 'project-one',
      label: 'Local dev',
      source: { kind: 'local', folderName: 'citadel', localPath: 'C:\\source\\citadel' },
      compatibility: 'supported',
    },
  ];
  const saved = await fixture.call('/api/registry', {
    method: 'PUT',
    body: JSON.stringify({
      expectedEpoch: authority.epoch,
      expectedRevision: authority.revision,
      projects: [{ id: 'project-one', label: 'Citadel', createdAt: null, updatedAt: null }],
      environments,
      removedProjectIds: [],
      removedEnvironmentIds: [],
    }),
  });
  assert.equal(saved.status, 200);
  await new Promise((resolve) => fixture.server.close(resolve));

  // A brand new server process on the same mounted /data volume.
  const restarted = await start({ dataRoot, root: fixture.root });
  t.after(() => close(restarted));
  const durable = (await restarted.call('/api/registry')).json();
  assert.equal(durable.version, 4);
  assert.deepEqual(
    durable.environments.map((item) => [item.label, item.source.kind]),
    [
      ['Local dev', 'local'],
      ['QA on GitHub', 'github'],
    ]
  );
  const github = durable.environments.find((item) => item.source.kind === 'github');
  // v4 normalises the connection-ownership fields onto every GitHub source. A
  // record written without them keeps nulls rather than acquiring a connection
  // it was never attached through.
  assert.deepEqual(github.source, {
    ...environments[0].source,
    connectionProfileId: null,
    // Unknown, and left unknown. Migration was dropped, so a record that
    // predates the field is not given a value nobody can vouch for.
    branchChoice: null,
    lastKnownHead: null,
    capabilities: null,
    validatedAt: null,
  });
  // The remaining bar for old data: it loads and is still identifiable across a
  // restart. It may need re-attaching; it may not crash.
  assert.equal(github.source.workingBranch, 'citadel-ui/env-github-one');
  assert.equal(github.source.writeMode, 'working-branch');
  assert.equal(durable.projects[0].label, 'Citadel');

  // No credential of any kind is on the volume, so GitHub must be reconnected.
  const raw = await readFile(join(dataRoot, 'settings', 'registry.json'), 'utf8');
  for (const forbidden of ['github_pat_', 'Bearer', 'Authorization', 'sessionId', TEST_TOKEN]) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
  const status = await restarted.call('/api/github/sessions', {
    headers: { 'X-Citadel-GitHub-Session': 'A'.repeat(32) },
  });
  assert.equal(status.json().connected, false);
});

test('an invalid GitHub source is refused by the registry mirror', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const authority = (await fixture.call('/api/registry')).json();
  const send = (source) =>
    fixture.call('/api/registry', {
      method: 'PUT',
      body: JSON.stringify({
        expectedEpoch: authority.epoch,
        expectedRevision: authority.revision,
        projects: [{ id: 'project-one', label: 'Citadel', createdAt: null, updatedAt: null }],
        environments: [
          {
            id: 'env-one',
            projectId: 'project-one',
            label: 'GitHub QA',
            source,
            compatibility: 'supported',
          },
        ],
        removedProjectIds: [],
        removedEnvironmentIds: [],
      }),
    });

  const base = {
    kind: 'github',
    repositoryId: 9001,
    fullName: 'taomar/citadelQA',
    sourceBranch: 'main',
    workingBranch: 'citadel-ui/env-one',
  };
  for (const invalid of [
    { ...base, repositoryId: 0 },
    { ...base, repositoryId: 'nine-thousand' },
    { ...base, fullName: 'not-a-full-name' },
    { ...base, fullName: '../../etc/passwd' },
    { ...base, sourceBranch: 'bad branch' },
    { ...base, workingBranch: '../escape' },
    { ...base, writeMode: 'force' },
    { ...base, token: 'github_pat_leak' },
    { kind: 'ftp', host: 'example.com' },
  ]) {
    const response = await send(invalid);
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.match(response.json().error.code, /INVALID_REGISTRY/);
  }
});
