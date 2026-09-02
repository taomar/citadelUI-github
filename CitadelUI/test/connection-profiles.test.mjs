/**
 * Connection ownership: named profiles, registry v4, and the rule that a
 * credential is never silently rebound to a different account.
 *
 * These run against the real HTTP server on a real temporary `/data`, because
 * the guarantees being checked are durability guarantees. A test that stubbed
 * the store would prove the code paths run, not that a container restart finds
 * what it should.
 */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCitadelServer } from '../server/index.mjs';
import { RegistryStore, REGISTRY_VERSION } from '../server/registry-store.mjs';
import { ConnectionProfileStore, nameKey, profileName } from '../server/connections.mjs';
import { RepositorySelection } from '../web/js/github-selection.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MockGitHub, TEST_TOKEN } from './_github-mock.mjs';

const OTHER_TOKEN = 'github_pat_11ZZZZZZZ0zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(options.body) : null;
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method || 'GET',
        // No pooling and no keep-alive: a lingering socket keeps `server.close`
        // from resolving, and a test that hangs on shutdown is indistinguishable
        // from a product that does.
        agent: false,
        headers: {
          Connection: 'close',
          ...options.headers,
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
            text: () => Buffer.concat(chunks).toString('utf8'),
            json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
        );
      }
    );
    // A request that never answers must fail the test rather than stall it.
    req.setTimeout(15_000, () => req.destroy(new Error(`Timed out: ${options.method || 'GET'} ${path}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function start(options = {}) {
  const root = options.root || (await mkdtemp(join(tmpdir(), 'citadel-connections-')));
  const webRoot = join(root, 'web');
  const dataRoot = options.dataRoot || join(root, 'data');
  await mkdir(webRoot, { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head><body></body></html>'
  );
  const github =
    options.github ||
    (() => {
      const mock = new MockGitHub();
      const repository = mock.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
      mock.seed(repository, 'main', citadelRepositoryFiles());
      mock.seed(repository, 'release', citadelRepositoryFiles());
      return mock;
    })();
  const allowedHost = '127.0.0.1:4173';
  const sessionToken = 'test-session-token';
  const created = await createCitadelServer({
    webRoot,
    sharedRoot: join(root, 'shared'),
    dataRoot,
    allowedHost,
    allowedOrigin: `http://${allowedHost}`,
    sessionToken,
    credentialKeyFile: options.credentialKeyFile ?? null,
    githubOptions: { clientOptions: { fetch: github.fetch } },
  });
  await new Promise((resolve, reject) => {
    created.server.once('error', reject);
    created.server.listen(0, '127.0.0.1', resolve);
  });
  const port = created.server.address().port;
  const call = (path, init = {}) =>
    httpRequest(port, path, {
      ...init,
      headers: {
        Host: allowedHost,
        'Sec-Fetch-Site': 'same-origin',
        'X-Citadel-Session': sessionToken,
        ...(init.method && init.method !== 'GET'
          ? { Origin: `http://${allowedHost}`, 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers || {}),
      },
    });
  const post = (path, body, headers) =>
    call(path, { method: 'POST', body: JSON.stringify(body ?? {}), headers });
  return { root, dataRoot, github, call, post, ...created };
}

async function close(fixture, { keep = false } = {}) {
  await new Promise((resolve) => fixture.server.close(resolve));
  // Activity is recorded fire-and-forget so it can never fail the operation it
  // describes, which means a write can still be in flight after the response.
  // In production that is exactly right; here it races the teardown and leaves
  // a temporary behind, so the queue is drained before the directory goes.
  await fixture.activityStore?.settled?.();
  if (!keep) await rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * A restart scenario: two server processes over one `/data`, torn down in the
 * only order Windows tolerates.
 *
 * Removing the directory while a server still holds a descriptor makes `fs.rm`
 * retry until it gives up, which reads as a hung test rather than a failing one.
 * So every server is closed first, and the directory goes last, from one hook.
 */
function restartScope(t) {
  const fixtures = [];
  let root = null;
  t.after(async () => {
    for (const fixture of fixtures.reverse()) {
      await new Promise((resolve) => fixture.server.close(resolve));
      await fixture.activityStore?.settled?.();
    }
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return {
    async boot(options) {
      const fixture = await start({ ...options, root: root || options?.root });
      root = fixture.root;
      fixtures.push(fixture);
      return fixture;
    },
    async halt(fixture) {
      await new Promise((resolve) => fixture.server.close(resolve));
      await fixture.activityStore?.settled?.();
      const index = fixtures.indexOf(fixture);
      if (index !== -1) fixtures.splice(index, 1);
    },
  };
}

async function keyFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'citadel-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'credential.key');
  await writeFile(path, randomBytes(32));
  return path;
}

// ---------------------------------------------------------------- profiles --

test('a connection is named before it is created, and names stay unique', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));

  const unnamed = await fixture.post('/api/github/connections', { name: '  ', token: TEST_TOKEN });
  assert.equal(unnamed.status, 400);
  assert.equal(unnamed.json().error.code, 'INVALID_CONNECTION_NAME');

  const created = await fixture.post('/api/github/connections', {
    name: 'Work account',
    token: TEST_TOKEN,
  });
  assert.equal(created.status, 200);
  const { profile, session } = created.json();
  assert.equal(profile.name, 'Work account');
  assert.equal(profile.accountLogin, 'octo-dev');
  assert.equal(profile.accountId, 4242);
  assert.equal(profile.status, 'session');
  assert.equal(profile.persisted, false);
  assert.match(session.id, /^[A-Za-z0-9_-]{16,128}$/);
  // No credential, in any shape, reaches the browser.
  assert.equal(created.text().includes(TEST_TOKEN), false);
  assert.equal(created.text().includes('github_pat_'), false);

  // The same account under a second name is refused rather than duplicated.
  const again = await fixture.post('/api/github/connections', {
    name: 'Second name',
    token: TEST_TOKEN,
  });
  assert.equal(again.status, 409);
  assert.equal(again.json().error.code, 'CONNECTION_ACCOUNT_TAKEN');
  assert.equal(again.json().error.profileId, profile.id);
});

test('a second account becomes a separate connection, and both are listed', async (t) => {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const fixture = await start({ github });
  t.after(() => close(fixture));

  const first = (
    await fixture.post('/api/github/connections', { name: 'Personal', token: TEST_TOKEN })
  ).json();

  // A different credential for a different account.
  github.token = OTHER_TOKEN;
  github.user = { login: 'octo-org-admin', id: 8484, type: 'User' };
  const second = (
    await fixture.post('/api/github/connections', { name: 'Org admin', token: OTHER_TOKEN })
  ).json();

  assert.notEqual(first.profile.id, second.profile.id);
  const listed = (await fixture.call('/api/github/connections')).json();
  assert.deepEqual(
    listed.profiles.map((item) => [item.name, item.accountLogin]).sort(),
    [
      ['Org admin', 'octo-org-admin'],
      ['Personal', 'octo-dev'],
    ]
  );
  // Both are live; the first is not evicted by the second.
  assert.deepEqual(
    listed.profiles.map((item) => item.status).sort(),
    ['session', 'session']
  );
});

test('reconnecting with a token for another account is refused, never rebound', async (t) => {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const fixture = await start({ github });
  t.after(() => close(fixture));

  const { profile } = (
    await fixture.post('/api/github/connections', { name: 'Personal', token: TEST_TOKEN })
  ).json();

  github.token = OTHER_TOKEN;
  github.user = { login: 'someone-else', id: 9999, type: 'User' };
  const wrong = await fixture.post(
    `/api/github/connections/${profile.id}/reconnect`,
    { token: OTHER_TOKEN }
  );
  assert.equal(wrong.status, 409);
  assert.equal(wrong.json().error.code, 'CONNECTION_ACCOUNT_MISMATCH');
  assert.match(wrong.json().error.message, /someone-else/);
  assert.match(wrong.json().error.message, /octo-dev/);

  // The profile is untouched: still bound to the original account.
  const listed = (await fixture.call('/api/github/connections')).json();
  assert.equal(listed.profiles[0].accountId, 4242);
  assert.equal(listed.profiles[0].accountLogin, 'octo-dev');
});

test('renaming keeps identity and refuses a name already taken', async (t) => {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const fixture = await start({ github });
  t.after(() => close(fixture));

  const first = (
    await fixture.post('/api/github/connections', { name: 'Personal', token: TEST_TOKEN })
  ).json().profile;
  github.token = OTHER_TOKEN;
  github.user = { login: 'other-dev', id: 5151, type: 'User' };
  const second = (
    await fixture.post('/api/github/connections', { name: 'Org', token: OTHER_TOKEN })
  ).json().profile;

  const renamed = await fixture.post(`/api/github/connections/${first.id}/rename`, {
    name: 'Home laptop',
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json().profile.name, 'Home laptop');
  assert.equal(renamed.json().profile.accountId, 4242);

  const clash = await fixture.post(`/api/github/connections/${second.id}/rename`, {
    // Compared case- and accent-insensitively, so "home laptop" is the same name.
    name: 'home laptop',
  });
  assert.equal(clash.status, 409);
  assert.equal(clash.json().error.code, 'CONNECTION_NAME_TAKEN');
});

test('removing a connection deletes its credential and never touches a branch', async (t) => {
  const key = await keyFile(t);
  const fixture = await start({ credentialKeyFile: key });
  t.after(() => close(fixture));

  const { profile } = (
    await fixture.post('/api/github/connections', {
      name: 'Work',
      token: TEST_TOKEN,
      persist: true,
    })
  ).json();
  const credentialDir = join(fixture.dataRoot, 'settings', 'credentials');
  assert.deepEqual(await readdir(credentialDir), [`${profile.id}.json`]);

  const removed = await fixture.call(`/api/github/connections/${profile.id}`, {
    method: 'DELETE',
    headers: { Origin: 'http://127.0.0.1:4173' },
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json().removed, true);
  assert.deepEqual(await readdir(credentialDir), []);
  assert.deepEqual((await fixture.call('/api/github/connections')).json().profiles, []);
  // The mock records every outbound call. None of them deletes a ref.
  assert.equal(
    fixture.github.calls.some((entry) => entry.method === 'DELETE'),
    false
  );
});

// ------------------------------------------------------- encrypted restore --

test('a persisted connection is restored automatically across a real restart', async (t) => {
  const key = await keyFile(t);
  const scope = restartScope(t);
  const first = await scope.boot({ credentialKeyFile: key });

  const created = await first.post('/api/github/connections', {
    name: 'Work account',
    token: TEST_TOKEN,
    persist: true,
  });
  assert.equal(created.status, 200);
  assert.equal(created.json().persisted, true);
  assert.equal(created.json().profile.status, 'persistent');
  await scope.halt(first);

  // A brand new process, the same mounted /data, the same mounted key.
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.seed(repository, 'main', citadelRepositoryFiles());
  const second = await scope.boot({
    dataRoot: first.dataRoot,
    credentialKeyFile: key,
    github,
  });

  const idle = (await second.call('/api/github/connections')).json();
  assert.equal(idle.vault.available, true);
  assert.equal(idle.profiles[0].status, 'persistent-idle');
  assert.equal(idle.profiles[0].connected, false);

  const resumed = await second.post(`/api/github/connections/${idle.profiles[0].id}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json().profile.status, 'persistent');
  assert.match(resumed.json().session.id, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(resumed.text().includes('github_pat_'), false);

  // The restored session is a working credential, not just a status word.
  const repos = await second.call('/api/github/repos', {
    headers: { 'X-Citadel-GitHub-Session': resumed.json().session.id },
  });
  assert.equal(repos.status, 200);
  assert.equal(repos.json().repositories[0].fullName, 'taomar/citadelQA');
});

test('a restart without the key leaves the connection unavailable, not connected', async (t) => {
  const key = await keyFile(t);
  const scope = restartScope(t);
  const first = await scope.boot({ credentialKeyFile: key });
  const { profile } = (
    await first.post('/api/github/connections', {
      name: 'Work account',
      token: TEST_TOKEN,
      persist: true,
    })
  ).json();
  await scope.halt(first);

  const second = await scope.boot({ dataRoot: first.dataRoot, credentialKeyFile: null });
  const listed = (await second.call('/api/github/connections')).json();
  assert.equal(listed.vault.available, false);
  assert.equal(listed.profiles[0].status, 'unavailable');

  const refused = await second.post(`/api/github/connections/${profile.id}/resume`);
  assert.equal(refused.status, 409);
  assert.equal(refused.json().error.code, 'CREDENTIAL_UNAVAILABLE');
});

test('the default deployment writes no vault and offers no persistence', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const created = await fixture.post('/api/github/connections', {
    name: 'Work',
    token: TEST_TOKEN,
    persist: true,
  });
  assert.equal(created.status, 200);
  // Asked for, refused, and said so — rather than reporting a durability the
  // deployment cannot provide.
  assert.equal(created.json().persisted, false);
  assert.equal(created.json().persistenceReason, 'persistence-unavailable');
  assert.equal(created.json().profile.status, 'session');
  await assert.rejects(readdir(join(fixture.dataRoot, 'settings', 'credentials')));

  const { profile } = created.json();
  const enable = await fixture.post(`/api/github/connections/${profile.id}/persistence`, {
    persist: true,
  });
  assert.equal(enable.status, 409);
  assert.equal(enable.json().error.code, 'PERSISTENCE_UNAVAILABLE');
});

test('unticking persistence deletes the encrypted credential immediately', async (t) => {
  const key = await keyFile(t);
  const fixture = await start({ credentialKeyFile: key });
  t.after(() => close(fixture));
  const { profile } = (
    await fixture.post('/api/github/connections', {
      name: 'Work',
      token: TEST_TOKEN,
      persist: true,
    })
  ).json();
  const dir = join(fixture.dataRoot, 'settings', 'credentials');
  assert.deepEqual(await readdir(dir), [`${profile.id}.json`]);

  const off = await fixture.post(`/api/github/connections/${profile.id}/persistence`, {
    persist: false,
  });
  assert.equal(off.status, 200);
  assert.equal(off.json().profile.persisted, false);
  assert.equal(off.json().profile.status, 'session');
  assert.deepEqual(await readdir(dir), []);

  // Ticking it again re-seals from the live session rather than asking again.
  const on = await fixture.post(`/api/github/connections/${profile.id}/persistence`, {
    persist: true,
  });
  assert.equal(on.status, 200);
  assert.deepEqual(await readdir(dir), [`${profile.id}.json`]);

  // Disconnecting first, then enabling, has nothing to encrypt and says so.
  await fixture.post(`/api/github/connections/${profile.id}/disconnect`);
  await fixture.post(`/api/github/connections/${profile.id}/persistence`, { persist: false });
  const idle = await fixture.post(`/api/github/connections/${profile.id}/persistence`, {
    persist: true,
  });
  assert.equal(idle.status, 409);
  assert.equal(idle.json().error.code, 'CONNECTION_NOT_LIVE');
});

test('no credential or key material appears anywhere under /data', async (t) => {
  const key = await keyFile(t);
  const fixture = await start({ credentialKeyFile: key });
  t.after(() => close(fixture));
  const keyBytes = await readFile(key);

  const { profile, session } = (
    await fixture.post('/api/github/connections', {
      name: 'Work',
      token: TEST_TOKEN,
      persist: true,
    })
  ).json();
  const authority = (await fixture.call('/api/registry')).json();
  await fixture.call('/api/registry', {
    method: 'PUT',
    body: JSON.stringify({
      expectedEpoch: authority.epoch,
      expectedRevision: authority.revision,
      projects: [{ id: 'project-one', label: 'Citadel' }],
      environments: [
        {
          id: 'env-one',
          projectId: 'project-one',
          label: 'QA',
          source: {
            kind: 'github',
            connectionProfileId: profile.id,
            repositoryId: 9001,
            fullName: 'taomar/citadelQA',
            sourceBranch: 'main',
            workingBranch: 'citadel-ui/env-one',
            writeMode: 'working-branch',
          },
        },
      ],
      removedProjectIds: [],
      removedEnvironmentIds: [],
    }),
  });

  const forbidden = [
    TEST_TOKEN,
    'github_pat_',
    keyBytes.toString('base64'),
    keyBytes.toString('hex'),
    session.id,
  ];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const text = await readFile(path, 'utf8');
      for (const needle of forbidden) {
        assert.equal(text.includes(needle), false, `${needle.slice(0, 12)} found in ${path}`);
      }
    }
  };
  await walk(fixture.dataRoot);
});

// ---------------------------------------------------------- registry rules --

test('a v3 registry migrates to v4 without inventing a connection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-v3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'settings'), { recursive: true });
  await writeFile(
    join(root, 'settings', 'registry.json'),
    `${JSON.stringify({
      version: 3,
      epoch: 'legacy-epoch',
      revision: 5,
      projects: [{ id: 'project-one', label: 'Citadel' }],
      environments: [
        {
          id: 'env-one',
          projectId: 'project-one',
          label: 'QA',
          source: {
            kind: 'github',
            repositoryId: 9001,
            fullName: 'taomar/citadelQA',
            sourceBranch: 'main',
            workingBranch: 'citadel-ui/env-one',
            writeMode: 'working-branch',
          },
        },
        // Two workspaces sharing a name inside one project. v4 makes labels
        // unique; refusing to start would strand the user's whole registry.
        {
          id: 'env-two',
          projectId: 'project-one',
          label: 'QA',
          source: { kind: 'local', folderName: 'citadel', localPath: 'C:\\source\\citadel' },
        },
      ],
    })}\n`
  );
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const current = await store.read();
  assert.equal(current.version, REGISTRY_VERSION);
  assert.equal(current.version, 4);
  assert.equal(current.epoch, 'legacy-epoch');
  assert.equal(current.revision, 5);

  const github = current.environments.find((item) => item.id === 'env-one');
  assert.equal(github.source.connectionProfileId, null);
  assert.equal(github.source.lastKnownHead, null);
  assert.equal(github.source.capabilities, null);
  assert.equal(github.source.validatedAt, null);
  // Untouched facts stay exactly as they were.
  assert.equal(github.source.sourceBranch, 'main');
  assert.equal(github.source.workingBranch, 'citadel-ui/env-one');

  const labels = current.environments.map((item) => item.label).sort();
  assert.deepEqual(labels, ['QA', 'QA (2)']);
});

test('reconcile refuses duplicate labels and duplicate repository attachments', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-v4-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const authority = async () => {
    const current = await store.read();
    return { expectedEpoch: current.epoch, expectedRevision: current.revision };
  };
  const project = { id: 'project-one', label: 'Citadel' };
  const source = (extra = {}) => ({
    kind: 'github',
    connectionProfileId: 'profile-a',
    repositoryId: 9001,
    fullName: 'taomar/citadelQA',
    sourceBranch: 'main',
    workingBranch: 'citadel-ui/env-one',
    writeMode: 'working-branch',
    ...extra,
  });

  await assert.rejects(
    store.reconcile({
      ...(await authority()),
      projects: [project],
      environments: [
        { id: 'env-one', projectId: 'project-one', label: 'QA', source: source() },
        { id: 'env-two', projectId: 'project-one', label: 'qa', source: { kind: 'local', folderName: 'x', localPath: '/x' } },
      ],
    }),
    (error) => error.code === 'DUPLICATE_ENVIRONMENT_LABEL'
  );

  await assert.rejects(
    store.reconcile({
      ...(await authority()),
      projects: [project],
      environments: [
        { id: 'env-one', projectId: 'project-one', label: 'QA', source: source() },
        {
          id: 'env-two',
          projectId: 'project-one',
          label: 'QA copy',
          source: source({ workingBranch: 'citadel-ui/env-two' }),
        },
      ],
    }),
    (error) => error.code === 'DUPLICATE_ENVIRONMENT_SOURCE'
  );

  // The same repository and branch through a *different* connection is a
  // legitimately different workspace and is accepted.
  const accepted = await store.reconcile({
    ...(await authority()),
    projects: [project],
    environments: [
      { id: 'env-one', projectId: 'project-one', label: 'QA', source: source() },
      {
        id: 'env-two',
        projectId: 'project-one',
        label: 'QA as org',
        source: source({ connectionProfileId: 'profile-b', workingBranch: 'citadel-ui/env-two' }),
      },
      // A different branch through the same connection is also distinct.
      {
        id: 'env-three',
        projectId: 'project-one',
        label: 'Release',
        source: source({ sourceBranch: 'release', workingBranch: 'citadel-ui/env-three' }),
      },
    ],
  });
  assert.equal(accepted.environments.length, 3);
});

test('a v4 source refuses an unknown field, a bad head and an oversized capability list', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-v4-shape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RegistryStore({ dataRoot: root });
  await store.initialize();
  const base = async (source) => {
    const current = await store.read();
    return {
      expectedEpoch: current.epoch,
      expectedRevision: current.revision,
      projects: [{ id: 'project-one', label: 'Citadel' }],
      environments: [{ id: 'env-one', projectId: 'project-one', label: 'QA', source }],
    };
  };
  const valid = {
    kind: 'github',
    connectionProfileId: 'profile-a',
    repositoryId: 9001,
    fullName: 'taomar/citadelQA',
    sourceBranch: 'main',
    workingBranch: 'citadel-ui/env-one',
    writeMode: 'working-branch',
  };
  await assert.rejects(
    store.reconcile(await base({ ...valid, token: 'github_pat_x' })),
    (error) => error.code === 'INVALID_REGISTRY_SOURCE'
  );
  await assert.rejects(
    store.reconcile(await base({ ...valid, lastKnownHead: 'not-a-sha' })),
    (error) => error.code === 'INVALID_REGISTRY_SOURCE'
  );
  await assert.rejects(
    store.reconcile(await base({ ...valid, capabilities: new Array(40).fill('x') })),
    (error) => error.code === 'INVALID_REGISTRY_SOURCE'
  );
  await assert.rejects(
    store.reconcile(await base({ ...valid, connectionProfileId: '../escape' })),
    (error) => error.code === 'INVALID_REGISTRY_ID'
  );
  const good = await store.reconcile(
    await base({
      ...valid,
      lastKnownHead: 'a'.repeat(40),
      capabilities: ['Main deployment'],
      validatedAt: '2026-01-01T00:00:00.000Z',
    })
  );
  assert.equal(good.environments[0].source.lastKnownHead, 'a'.repeat(40));
  assert.deepEqual(good.environments[0].source.capabilities, ['Main deployment']);
});

test('an attach records the connection that performed it, and the head it validated', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const { profile, session } = (
    await fixture.post('/api/github/connections', { name: 'Work', token: TEST_TOKEN })
  ).json();

  const attached = await fixture.post(
    '/api/github/attachments',
    { repositoryId: 9001, sourceBranch: 'main', environmentId: 'env-one' },
    { 'X-Citadel-GitHub-Session': session.id }
  );
  assert.equal(attached.status, 200);
  const source = attached.json().source;
  // Ownership comes from the credential, never from the request body.
  assert.equal(source.connectionProfileId, profile.id);
  assert.match(source.lastKnownHead, /^[a-f0-9]{40}$/);
  assert.ok(source.capabilities.includes('Main deployment'));
  assert.ok(!Number.isNaN(Date.parse(source.validatedAt)));

  // And it survives the round trip into /data unchanged.
  const authority = (await fixture.call('/api/registry')).json();
  const saved = await fixture.call('/api/registry', {
    method: 'PUT',
    body: JSON.stringify({
      expectedEpoch: authority.epoch,
      expectedRevision: authority.revision,
      projects: [{ id: 'project-one', label: 'Citadel' }],
      environments: [{ id: 'env-one', projectId: 'project-one', label: 'QA', source }],
      removedProjectIds: [],
      removedEnvironmentIds: [],
    }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json().environments[0].source, source);
});

test('a browser cannot claim an environment was attached through another connection', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const { session } = (
    await fixture.post('/api/github/connections', { name: 'Work', token: TEST_TOKEN })
  ).json();
  const forged = await fixture.post(
    '/api/github/attachments',
    {
      repositoryId: 9001,
      sourceBranch: 'main',
      environmentId: 'env-one',
      connectionProfileId: 'someone-elses-profile',
    },
    { 'X-Citadel-GitHub-Session': session.id }
  );
  assert.equal(forged.status, 400);
  assert.equal(forged.json().error.code, 'INVALID_CONTENT');
});

// ------------------------------------------------------------- store units --

test('a verdict from the real route enables Continue, and a branch change invalidates it', async (t) => {
  const fixture = await start();
  t.after(() => close(fixture));
  const { session } = (
    await fixture.post('/api/github/connections', { name: 'Work', token: TEST_TOKEN })
  ).json();

  const call = async (repositoryId, branch) => {
    const response = await fixture.call(
      `/api/github/repos/${repositoryId}/compatibility?branch=${encodeURIComponent(branch)}`,
      { headers: { 'X-Citadel-GitHub-Session': session.id } }
    );
    assert.equal(response.status, 200);
    return response.json();
  };

  // The verdict says what it is about. Without this the client has to re-derive
  // the pair from its own state, and a successful check can never be matched to
  // the selection that asked for it.
  const verdict = await call(9001, 'main');
  assert.equal(verdict.branch, 'main');
  assert.equal(verdict.fullName, 'taomar/citadelQA');
  assert.equal(verdict.supported, true);
  assert.match(verdict.head, /^[a-f0-9]{40}$/);

  const selection = new RepositorySelection({
    listRepositories: async () => ({
      repositories: [
        {
          id: 9001,
          fullName: 'taomar/citadelQA',
          visibility: 'private',
          archived: false,
          disabled: false,
          canPush: true,
          defaultBranch: 'main',
        },
      ],
    }),
    listBranches: async () => ({
      branches: [{ name: 'main' }, { name: 'release' }],
    }),
    checkCompatibility: (repositoryId, branch) => call(repositoryId, branch),
  });
  await selection.connect({ login: 'octo-dev' });
  await selection.selectRepository(9001);

  assert.equal(selection.canAttach(), false, 'attachable before a branch is chosen');
  selection.selectBranch('main');
  await selection.validate();
  // The whole point: a successful validation actually enables the control.
  assert.equal(selection.validating, false, 'still reporting "Checking"');
  assert.equal(selection.canAttach(), true, 'Continue never enabled after a good verdict');
  assert.equal(selection.attachment().sourceBranch, 'main');
  assert.match(selection.attachment().expectedHead, /^[a-f0-9]{40}$/);

  // Changing the branch invalidates the verdict immediately.
  selection.selectBranch('release');
  assert.equal(selection.canAttach(), false, 'a stale verdict still enabled Continue');
  await selection.validate();
  assert.equal(selection.canAttach(), true);
  assert.equal(selection.validation.branch, 'release');

  // A verdict for another pair can never enable the current one.
  selection.validation = { ...selection.validation, branch: 'main' };
  assert.equal(selection.canAttach(), false);
  selection.validation = { ...selection.validation, branch: 'release', repositoryId: 4242 };
  assert.equal(selection.canAttach(), false);
});

test('the profile store refuses a future schema and normalises names', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'settings'), { recursive: true });
  await writeFile(
    join(root, 'settings', 'connections.json'),
    JSON.stringify({ version: 99, profiles: [] })
  );
  const store = new ConnectionProfileStore({ dataRoot: root });
  await assert.rejects(store.list(), (error) => error.code === 'CONNECTIONS_VERSION_UNSUPPORTED');

  assert.equal(profileName('  Work   account  '), 'Work account');
  assert.throws(() => profileName(''), /INVALID_CONNECTION_NAME|name/);
  assert.throws(() => profileName('a'.repeat(81)));
  assert.throws(() => profileName('bad\u0000name'));
  assert.equal(nameKey('Wörk Account'), nameKey('work account'));
});

test('connection profiles never persist a token or a session id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'citadel-profiles-clean-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ConnectionProfileStore({ dataRoot: root });
  await store.initialize();
  const profile = await store.create({
    name: 'Work',
    accountId: 4242,
    accountLogin: 'octo-dev',
    accountType: 'User',
    credentialMode: 'persistent',
  });
  // Only known keys survive; an attempt to smuggle one in is dropped, not stored.
  assert.deepEqual(Object.keys(profile).sort(), [
    'accountId',
    'accountLogin',
    'accountType',
    'createdAt',
    'credentialMode',
    'id',
    'lastConnectedAt',
    'name',
    'provider',
    'updatedAt',
  ]);
  const raw = await readFile(join(root, 'settings', 'connections.json'), 'utf8');
  for (const forbidden of ['github_pat_', 'token', 'session']) {
    assert.equal(raw.toLowerCase().includes(forbidden), false, forbidden);
  }
  // Identity is not editable through update.
  const updated = await store.update(profile.id, {
    name: 'Home',
    accountId: 1,
    accountLogin: 'someone-else',
  });
  assert.equal(updated.accountId, 4242);
  assert.equal(updated.accountLogin, 'octo-dev');
  assert.equal(updated.name, 'Home');
});
