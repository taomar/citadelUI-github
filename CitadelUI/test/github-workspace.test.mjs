import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient, assertApiPath, redactSecrets } from '../server/github/api.mjs';
import { GitHubSessionStore, classifyToken, sameOpaqueId } from '../server/github/sessions.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import {
  filterSourceTree,
  isLfsPointer,
  validateBranchName,
  validateRepositoryId,
  workingBranchName,
} from '../server/github/repositories.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

const ENVIRONMENT_ID = 'env-github-one';

function fixture(options = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9001, fullName: 'taomar/citadelQA' });
  github.addRepository({
    id: 9002,
    fullName: 'taomar/ai-hub-gateway-solution-accelerator',
  });
  github.seed(repository, 'main', {
    ...citadelRepositoryFiles(options.files || {}),
  });
  const client = new GitHubApiClient({ fetch: github.fetch });
  const sessions = new GitHubSessionStore(options.sessionOptions);
  const registryStore = environmentRegistry({
    [ENVIRONMENT_ID]: {
      id: ENVIRONMENT_ID,
      source: {
        kind: 'github',
        repositoryId: 9001,
        fullName: 'taomar/citadelQA',
        sourceBranch: 'main',
        workingBranch: 'citadel-ui/env-github-one',
        writeMode: 'working-branch',
      },
    },
    'env-local-one': { id: 'env-local-one', source: { kind: 'local', folderName: 'citadel' } },
  });
  const audit = new MemoryAudit();
  const routes = new GitHubRoutes({ client, sessions, registryStore, audit });
  return { github, repository, client, sessions, routes, registryStore, audit };
}

function request(sessionId, options = {}) {
  return {
    method: options.method || 'GET',
    headers: sessionId ? { 'x-citadel-github-session': sessionId } : {},
  };
}

async function connected(context) {
  const session = await context.routes.connect({ token: TEST_TOKEN });
  return session.id;
}

async function attached(context) {
  const id = await connected(context);
  await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
  });
  return id;
}

function url(search = '') {
  return new URL(`http://127.0.0.1:4173/api/github/workspaces/x/y${search}`);
}

test('egress is fixed to api.github.com and never follows a redirect', async () => {
  for (const path of [
    'https://evil.example/user',
    '//evil.example/user',
    '/repos/o/r/../../../admin',
    '/repos/o/r\\..\\admin',
    'user',
  ]) {
    assert.throws(() => assertApiPath(path), (error) => error.code === 'INVALID_GITHUB_PATH', path);
  }
  assert.equal(assertApiPath('/user').href, 'https://api.github.com/user');

  const client = new GitHubApiClient({
    fetch: async () => ({
      status: 302,
      ok: false,
      headers: new Headers({ location: 'https://evil.example/token' }),
      body: null,
      arrayBuffer: async () => Buffer.alloc(0),
    }),
  });
  await assert.rejects(
    client.request('/user', { token: TEST_TOKEN }),
    (error) => error.code === 'GITHUB_REDIRECT'
  );
});

test('oversized GitHub responses are refused before parsing', async () => {
  const payload = Buffer.alloc(4096, 0x41);
  const client = new GitHubApiClient({
    fetch: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-length': String(payload.length) }),
      body: (async function* () {
        yield payload;
      })(),
      arrayBuffer: async () => payload,
    }),
    jsonLimit: 512,
  });
  await assert.rejects(
    client.request('/user', { token: TEST_TOKEN }),
    (error) => error.code === 'GITHUB_RESPONSE_TOO_LARGE'
  );
});

test('classic tokens are refused and malformed tokens never reach GitHub', () => {
  assert.equal(classifyToken(TEST_TOKEN).kind, 'fine-grained');
  assert.throws(
    () => classifyToken('ghp_0123456789abcdefghijklmnopqrstuvwxyz'),
    (error) => error.code === 'GITHUB_TOKEN_CLASSIC'
  );
  assert.equal(
    classifyToken('ghp_0123456789abcdefghijklmnopqrstuvwxyz', { allowClassic: true }).kind,
    'classic'
  );
  for (const value of ['', 'short', 'github_pat_with space', 'x'.repeat(600)]) {
    assert.throws(() => classifyToken(value), /token/i, JSON.stringify(value));
  }
});

test('a credential session returns an opaque id and never the token', async () => {
  const context = fixture();
  const session = await context.routes.connect({ token: TEST_TOKEN });
  const serialized = JSON.stringify(session);
  assert.equal(serialized.includes(TEST_TOKEN), false);
  assert.equal(serialized.includes('github_pat_'), false);
  assert.match(session.id, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(session.login, 'octo-dev');
  assert.equal(session.tokenKind, 'fine-grained');
  assert.equal('token' in session, false);

  const status = context.sessions.status(session.id);
  assert.equal(status.connected, true);
  assert.equal(JSON.stringify(status).includes(TEST_TOKEN), false);

  assert.equal(context.sessions.destroy(session.id), true);
  assert.equal(context.sessions.status(session.id).connected, false);
  assert.equal(context.sessions.size, 0);
});

test('sessions expire on idle and absolute limits and are isolated from each other', async () => {
  let now = 1_000_000;
  const store = new GitHubSessionStore({ now: () => now });
  const first = store.create('token-a', { login: 'a', id: 1, type: 'User' });
  const second = store.create('token-b', { login: 'b', id: 2, type: 'User' });
  assert.equal(store.resolve(first.id).token, 'token-a');
  assert.equal(store.resolve(second.id).token, 'token-b');

  now += 31 * 60 * 1000;
  assert.throws(() => store.resolve(first.id), (error) => error.code === 'GITHUB_SESSION_EXPIRED');

  now = 1_000_000;
  const third = store.create('token-c', { login: 'c', id: 3, type: 'User' });
  for (let step = 0; step < 20; step += 1) {
    now += 25 * 60 * 1000;
    if (now - 1_000_000 < 8 * 60 * 60 * 1000) store.resolve(third.id);
  }
  assert.throws(() => store.resolve(third.id), (error) => error.code === 'GITHUB_SESSION_EXPIRED');
  assert.equal(sameOpaqueId(first.id, first.id), true);
  assert.equal(sameOpaqueId(first.id, second.id), false);
  assert.equal(sameOpaqueId(first.id, `${first.id}x`), false);
});

test('credential submissions are rate limited per browser session', async () => {
  const context = fixture({ sessionOptions: { maxLoginAttempts: 3 } });
  await context.routes.connect({ token: TEST_TOKEN });
  await context.routes.connect({ token: TEST_TOKEN });
  await context.routes.connect({ token: TEST_TOKEN });
  await assert.rejects(
    context.routes.connect({ token: TEST_TOKEN }),
    (error) => error.code === 'GITHUB_LOGIN_THROTTLED'
  );
});

test('repository and branch discovery uses the credential list, not a typed path', async () => {
  const context = fixture();
  const id = await connected(context);
  const repos = await context.routes.handle({
    req: request(id),
    url: url(),
    parts: ['api', 'github', 'repos'],
    readBody: async () => ({}),
  });
  assert.deepEqual(
    repos.repositories.map((item) => item.fullName),
    ['taomar/ai-hub-gateway-solution-accelerator', 'taomar/citadelQA']
  );
  const branches = await context.routes.handle({
    req: request(id),
    url: url(),
    parts: ['api', 'github', 'repos', '9001', 'branches'],
    readBody: async () => ({}),
  });
  assert.deepEqual(branches.branches.map((item) => item.name), ['main']);
  assert.equal(branches.repository.fullName, 'taomar/citadelQA');
});

test('attach creates the Citadel working branch and never moves the source branch', async () => {
  const context = fixture();
  const id = await connected(context);
  const before = context.repository.refs.get('main');
  const result = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
  });
  assert.equal(result.source.workingBranch, 'citadel-ui/env-github-one');
  assert.equal(result.createdWorkingBranch, true);
  assert.equal(context.repository.refs.get('main'), before);
  assert.equal(context.repository.refs.get('citadel-ui/env-github-one'), before);

  const again = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
  });
  assert.equal(again.createdWorkingBranch, false);
});

test('archived and read-only repositories cannot be attached for editing', async () => {
  const context = fixture();
  const archived = context.github.addRepository({ id: 9100, fullName: 'taomar/archived', archived: true });
  context.github.seed(archived, 'main', { 'a.bicepparam': 'x\n' });
  const readOnly = context.github.addRepository({ id: 9101, fullName: 'taomar/readonly', canPush: false });
  context.github.seed(readOnly, 'main', { 'a.bicepparam': 'x\n' });
  const id = await connected(context);
  await assert.rejects(
    context.routes.attach(request(id, { method: 'POST' }), {
      repositoryId: 9100,
      sourceBranch: 'main',
      environmentId: ENVIRONMENT_ID,
    }),
    (error) => error.code === 'REPOSITORY_ARCHIVED'
  );
  await assert.rejects(
    context.routes.attach(request(id, { method: 'POST' }), {
      repositoryId: 9101,
      sourceBranch: 'main',
      environmentId: ENVIRONMENT_ID,
    }),
    (error) => error.code === 'REPOSITORY_READ_ONLY'
  );
});

test('a renamed repository is detected by immutable id instead of being followed', async () => {
  const context = fixture();
  const id = await attached(context);
  context.repository.full_name = 'taomar/citadelQA-renamed';
  await assert.rejects(
    context.routes.workspace({
      req: request(id),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'tree',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'REPOSITORY_RENAMED'
  );
});

test('tree filtering rejects symlinks, submodules, oversized blobs, and unsupported modes', () => {
  const { files, rejected } = filterSourceTree([
    { path: 'bicep/infra/main.bicepparam', type: 'blob', mode: '100644', sha: 'a'.repeat(40), size: 10 },
    { path: 'bicep/infra/link.bicepparam', type: 'blob', mode: '120000', sha: 'b'.repeat(40), size: 10 },
    { path: 'vendor', type: 'commit', mode: '160000', sha: 'c'.repeat(40), size: 0 },
    { path: 'bicep/huge.bicepparam', type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: 9 * 1024 * 1024 },
    { path: 'bicep/odd.bicepparam', type: 'blob', mode: '100777', sha: 'e'.repeat(40), size: 10 },
    { path: '.azure/dev/.env', type: 'blob', mode: '100644', sha: 'f'.repeat(40), size: 10 },
    { path: 'node_modules/thing/a.bicepparam', type: 'blob', mode: '100644', sha: '1'.repeat(40), size: 10 },
    { path: 'CitadelUI/web/app.xml', type: 'blob', mode: '100644', sha: '2'.repeat(40), size: 10 },
    { path: 'docs/readme.md', type: 'blob', mode: '100644', sha: '3'.repeat(40), size: 10 },
    { path: '../escape.bicepparam', type: 'blob', mode: '100644', sha: '4'.repeat(40), size: 10 },
  ]);
  assert.deepEqual(files.map((file) => file.alias), ['bicep/infra/main.bicepparam']);
  assert.deepEqual(
    rejected.map((item) => [item.path, item.reason]).sort(),
    [
      ['../escape.bicepparam', 'unsafe-path'],
      ['bicep/huge.bicepparam', 'too-large'],
      ['bicep/infra/link.bicepparam', 'symlink'],
      ['bicep/odd.bicepparam', 'unsupported-mode'],
      ['vendor', 'submodule'],
    ]
  );
  assert.equal(isLfsPointer('version https://git-lfs.github.com/spec/v1\noid sha256:abc\n'), true);
  assert.equal(isLfsPointer("using 'main.bicep'\n"), false);
});

test('Git LFS pointers are refused instead of edited', async () => {
  const context = fixture({
    files: {
      'bicep/infra/lfs.bicepparam':
        'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n',
    },
  });
  const id = await attached(context);
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const pointer = tree.files.find((file) => file.alias === 'bicep/infra/lfs.bicepparam');
  await assert.rejects(
    context.routes.workspace({
      req: request(id),
      url: url(`?alias=${encodeURIComponent(pointer.alias)}&sha=${pointer.sha}`),
      environmentId: ENVIRONMENT_ID,
      operation: 'blob',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'LFS_POINTER'
  );
});

test('a blob can only be read through an in-scope alias, never by SHA alone', async () => {
  const secret = [
    'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"',
    'AZURE_CLIENT_SECRET="SUPER-SECRET-VALUE"',
    '',
  ].join('\n');
  const context = fixture({
    files: {
      '.azure/dev/.env': secret,
      'scripts/notes.txt': 'operational runbook\n',
    },
  });
  const id = await attached(context);

  // The bridge legitimately reports the blob SHA for concurrency control.
  const bridge = await context.routes.workspace({
    req: request(id),
    url: url('?environmentName=dev'),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({}),
  });
  assert.match(bridge.blobSha, /^[0-9a-f]{40}$/);

  // Holding that SHA must not grant a raw read of the file, with or without a
  // truthful alias, and an out-of-scope path is refused before any lookup.
  for (const search of [
    `?sha=${bridge.blobSha}`,
    `?alias=${encodeURIComponent('.azure/dev/.env')}&sha=${bridge.blobSha}`,
    `?alias=${encodeURIComponent('scripts/notes.txt')}`,
    `?alias=${encodeURIComponent('../escape.bicepparam')}`,
  ]) {
    await assert.rejects(
      context.routes.workspace({
        req: request(id),
        url: url(search),
        environmentId: ENVIRONMENT_ID,
        operation: 'blob',
        readBody: async () => ({}),
      }),
      (error) => {
        assert.equal(String(error.message).includes('SUPER-SECRET-VALUE'), false);
        return true;
      },
      search
    );
  }

  // Substituting another file's SHA under an in-scope alias is a conflict.
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const main = tree.files.find((file) => file.alias === 'bicep/infra/main.bicepparam');
  await assert.rejects(
    context.routes.workspace({
      req: request(id),
      url: url(`?alias=${encodeURIComponent(main.alias)}&sha=${bridge.blobSha}`),
      environmentId: ENVIRONMENT_ID,
      operation: 'blob',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'STALE_SOURCE'
  );

  const allowed = await context.routes.workspace({
    req: request(id),
    url: url(`?alias=${encodeURIComponent(main.alias)}&sha=${main.sha}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'blob',
    readBody: async () => ({}),
  });
  assert.match(Buffer.from(allowed.content, 'base64').toString('utf8'), /environmentName/);
});

test('branch, repository id, and working branch inputs are validated', () => {
  assert.equal(validateBranchName('feature/one'), 'feature/one');
  for (const value of [
    '',
    '-lead',
    'has space',
    'a..b',
    'a//b',
    'trailing/',
    'ends.lock',
    'ref@{0}',
    '.hidden',
    'back\\slash',
    'tilde~1',
  ]) {
    assert.throws(() => validateBranchName(value), (error) => error.code === 'INVALID_BRANCH', value);
  }
  assert.equal(validateRepositoryId('42'), 42);
  for (const value of ['0', '-1', 'abc', '1.5', '']) {
    assert.throws(() => validateRepositoryId(value), (error) => error.code === 'INVALID_REPOSITORY_ID');
  }
  assert.equal(workingBranchName('env-1'), 'citadel-ui/env-1');
  assert.throws(() => workingBranchName('../evil'), (error) => error.code === 'INVALID_ENVIRONMENT');
});

test('a multi-file save is exactly one commit with the reviewed parent', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  const result = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'contract-create',
      expectedHead: head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: 'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam',
          create: true,
          after: Buffer.from("using '../../main.bicep'\n").toString('base64'),
        },
        {
          alias: 'bicep/infra/citadel-access-contracts/contracts/one/ai-product-policy.xml',
          create: true,
          after: Buffer.from('<policies/>\n').toString('base64'),
        },
      ],
    }),
  });
  assert.equal(result.baseCommit, head);
  assert.equal(context.repository.refs.get(branch), result.commit);
  const commit = context.github.commits.get(result.commit);
  assert.deepEqual(commit.parents, [head]);
  assert.match(commit.message, /Citadel-Action: contract-create/);
  assert.match(commit.message, new RegExp(`Citadel-Environment: ${ENVIRONMENT_ID}`));
  assert.equal(
    context.github.fileText(context.repository, branch, 'bicep/infra/citadel-access-contracts/contracts/one/ai-product-policy.xml'),
    '<policies/>\n'
  );
  // The source branch is untouched by a working-branch save.
  assert.equal(
    context.github
      .treeOf(context.repository.refs.get('main'))
      .some((entry) => entry.path.includes('/contracts/one/')),
    false
  );
});

test('a branch that moved after review is rejected and leaves the branch unchanged', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const stale = context.repository.refs.get(branch);
  context.github.seed(context.repository, branch, { 'bicep/infra/main.bicepparam': 'moved\n' });
  const moved = context.repository.refs.get(branch);
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: stale,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [{ alias: 'bicep/infra/new.bicepparam', create: true, after: Buffer.from('x\n').toString('base64') }],
      }),
    }),
    (error) => error.code === 'STALE_WORKSPACE'
  );
  assert.equal(context.repository.refs.get(branch), moved);
});

test('a non-fast-forward ref update never forces, and rescues the commit instead', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  context.github.failNextRefUpdate = true;
  const result = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [{ alias: 'bicep/infra/new.bicepparam', create: true, after: Buffer.from('x\n').toString('base64') }],
    }),
  });
  // The commit exists and is reachable; it simply is not on the working branch.
  assert.equal(result.resolution.kind, 'branch-moved');
  assert.equal(result.branch, result.resolution.branch);
  assert.equal(context.repository.refs.get(result.resolution.branch), result.commit);
  // The original guarantees still hold: the branch is untouched and no update
  // was ever forced.
  assert.equal(context.repository.refs.get(branch), head);
  assert.equal(
    context.github.calls.some((call) => call.method === 'PATCH' && call.path.includes('force')),
    false
  );
});

test('a protected branch keeps the change on a branch the user can open a PR from', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  context.github.protectedBranches.add(branch);
  const head = context.repository.refs.get(branch);
  const result = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [{ alias: 'bicep/infra/new.bicepparam', create: true, after: Buffer.from('x\n').toString('base64') }],
    }),
  });
  assert.equal(result.resolution.kind, 'branch-protected');
  // The old advice was "open a pull request from <branch>" — from a branch that
  // did not contain the change. The branch named now actually does.
  assert.equal(context.repository.refs.get(result.resolution.branch), result.commit);
  assert(
    context.github
      .treeOf(result.commit)
      .some((entry) => entry.path === 'bicep/infra/new.bicepparam')
  );
  assert.equal(context.repository.refs.get(branch), head);
});

test('a source edited after review is rejected by its reviewed hash', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const file = tree.files.find((item) => item.alias === 'bicep/infra/main.bicepparam');
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: tree.head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/main.bicepparam',
            blobSha: file.sha,
            beforeHash: 'f'.repeat(64),
            mode: file.mode,
            after: Buffer.from('changed\n').toString('base64'),
          },
        ],
      }),
    }),
    (error) => error.code === 'STALE_SOURCE'
  );
  assert.equal(context.repository.refs.get(branch), tree.head);
});

test('undo creates an inverse commit and never rewrites the branch', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  const created = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'contract-create',
      expectedHead: head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: 'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam',
          create: true,
          after: Buffer.from('a\n').toString('base64'),
        },
      ],
    }),
  });

  const history = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'history',
    readBody: async () => ({}),
  });
  assert.equal(history.transactions[0].commit, created.commit);
  assert.equal(history.transactions[0].action, 'contract-create');

  const undone = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'reverts',
    readBody: async () => ({
      commit: created.commit,
      transactionId: '99999999-2222-3333-4444-555555555555',
    }),
  });
  assert.notEqual(undone.commit, created.commit);
  assert.equal(context.repository.refs.get(branch), undone.commit);
  assert.equal(context.github.commits.get(undone.commit).parents[0], created.commit);
  assert.equal(
    context.github.fileText(
      context.repository,
      branch,
      'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam'
    ),
    null
  );
  // The original commit still exists: history is appended, never rewritten.
  assert.equal(context.github.commits.has(created.commit), true);
});

test('undo is refused when the created file changed afterwards', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  const created = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'contract-create',
      expectedHead: head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: 'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam',
          create: true,
          after: Buffer.from('a\n').toString('base64'),
        },
      ],
    }),
  });
  const tree = context.github.treeOf(created.commit).map((entry) => ({ ...entry }));
  const target = tree.find((entry) => entry.path.endsWith('contracts/one/main.bicepparam'));
  target.sha = context.github.writeBlob(Buffer.from('edited by someone else\n'));
  const newTree = context.github.writeTree(tree);
  context.repository.refs.set(branch, context.github.writeCommit(newTree, [created.commit], 'external'));

  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'reverts',
      readBody: async () => ({
        commit: created.commit,
        transactionId: '99999999-2222-3333-4444-555555555555',
      }),
    }),
    (error) => error.code === 'STALE_SOURCE'
  );
});

test('the subscription bridge exposes only AZURE_SUBSCRIPTION_ID and preserves other bytes', async () => {
  const original = [
    '# azd environment',
    'AZURE_ENV_NAME="dev"',
    'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"',
    'AZURE_SECRET_THING="do-not-leak"',
    '',
  ].join('\n');
  const context = fixture({ files: { '.azure/dev/.env': original } });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';

  const before = await context.routes.workspace({
    req: request(id),
    url: url('?environmentName=dev'),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({}),
  });
  const serialized = JSON.stringify(before);
  assert.equal(serialized.includes('do-not-leak'), false);
  assert.equal(serialized.includes('AZURE_ENV_NAME'), false);
  assert.equal(before.value, '00000000-0000-0000-0000-000000000000');
  assert.equal(before.key, 'AZURE_SUBSCRIPTION_ID');

  const saved = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({
      environmentName: 'dev',
      value: '11111111-2222-3333-4444-555555555555',
      expectedHead: context.repository.refs.get(branch),
      expectedHash: before.hash,
      transactionId: '11111111-2222-3333-4444-555555555555',
    }),
  });
  assert.equal(saved.changed, true);
  assert.equal(JSON.stringify(saved).includes('do-not-leak'), false);
  const after = context.github.fileText(context.repository, branch, '.azure/dev/.env');
  assert.equal(
    after,
    original.replace(
      '00000000-0000-0000-0000-000000000000',
      '11111111-2222-3333-4444-555555555555'
    )
  );
});

test('the subscription bridge rejects a stale reviewed blob', async () => {
  const context = fixture({ files: { '.azure/dev/.env': 'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"\n' } });
  const id = await attached(context);
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'subscription',
      readBody: async () => ({
        environmentName: 'dev',
        value: '11111111-2222-3333-4444-555555555555',
        expectedHead: context.repository.refs.get('citadel-ui/env-github-one'),
        expectedHash: 'a'.repeat(64),
        transactionId: '11111111-2222-3333-4444-555555555555',
      }),
    }),
    (error) => error.code === 'STALE_SOURCE'
  );
});

test('a subscription edit can be undone even though .env is outside the browsable scope', async () => {
  const original = 'AZURE_ENV_NAME="dev"\nAZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"\n';
  const context = fixture({ files: { '.azure/dev/.env': original } });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const before = await context.routes.workspace({
    req: request(id),
    url: url('?environmentName=dev'),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({}),
  });
  const saved = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({
      environmentName: 'dev',
      value: '11111111-2222-3333-4444-555555555555',
      expectedHead: context.repository.refs.get(branch),
      expectedHash: before.hash,
      transactionId: '11111111-2222-3333-4444-555555555555',
    }),
  });

  // Enumeration deliberately excludes .env, so History must not depend on it.
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  assert.equal(tree.files.some((file) => file.alias === '.azure/dev/.env'), false);

  const inspected = await context.routes.workspace({
    req: request(id),
    url: url(`?sha=${saved.commit}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({}),
  });
  assert.equal(inspected.transaction.canRevert, true);

  const undone = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'reverts',
    readBody: async () => ({
      commit: saved.commit,
      transactionId: '99999999-2222-3333-4444-555555555555',
    }),
  });
  assert.equal(context.repository.refs.get(branch), undone.commit);
  assert.equal(context.github.fileText(context.repository, branch, '.azure/dev/.env'), original);
});

test('workspace routes refuse an unknown, local, or unauthenticated environment', async () => {
  const context = fixture();
  const id = await attached(context);
  await assert.rejects(
    context.routes.workspace({
      req: request(id),
      url: url(),
      environmentId: 'env-local-one',
      operation: 'tree',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'NOT_GITHUB_ENVIRONMENT'
  );
  await assert.rejects(
    context.routes.workspace({
      req: request(id),
      url: url(),
      environmentId: 'env-missing',
      operation: 'tree',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'UNKNOWN_ENVIRONMENT'
  );
  await assert.rejects(
    context.routes.workspace({
      req: request(null),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'tree',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'GITHUB_SESSION_REQUIRED'
  );
  await assert.rejects(
    context.routes.workspace({
      req: request('a'.repeat(40)),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'tree',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'GITHUB_SESSION_EXPIRED'
  );
});

test('change sets are bounded and reject out-of-scope aliases', async () => {
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get('citadel-ui/env-github-one');
  const send = (files) =>
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files,
      }),
    });
  const payload = { create: true, after: Buffer.from('x\n').toString('base64') };
  await assert.rejects(send([{ alias: '../escape.bicepparam', ...payload }]), /Unsafe workspace alias/);
  await assert.rejects(send([{ alias: '.azure/dev/.env', ...payload }]), /never accesses/);
  await assert.rejects(send([{ alias: 'notes.md', ...payload }]), /Unsupported source type/);
  await assert.rejects(send([]), (error) => error.code === 'INVALID_CHANGE_SET');
  await assert.rejects(
    send([
      { alias: 'a.bicepparam', ...payload },
      { alias: 'a.bicepparam', ...payload },
    ]),
    (error) => error.code === 'INVALID_CHANGE_SET'
  );
  await assert.rejects(
    send(Array.from({ length: 65 }, (_value, index) => ({ alias: `f${index}.bicepparam`, ...payload }))),
    (error) => error.code === 'INVALID_CHANGE_SET'
  );
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'delete-everything',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [{ alias: 'a.bicepparam', ...payload }],
      }),
    }),
    (error) => error.code === 'INVALID_ACTION'
  );
});

test('no GitHub call, response, or error carries the credential', async () => {
  const context = fixture();
  const id = await attached(context);
  const responses = [];
  responses.push(
    await context.routes.workspace({
      req: request(id),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'tree',
      readBody: async () => ({}),
    })
  );
  responses.push(context.sessions.status(id));
  try {
    await context.routes.connect({ token: 'github_pat_' + 'z'.repeat(40) });
  } catch (error) {
    responses.push({ message: error.message });
  }
  for (const response of responses) {
    const text = JSON.stringify(response);
    assert.equal(text.includes(TEST_TOKEN), false);
    assert.equal(/github_pat_[A-Za-z0-9_]{16,}/.test(text), false);
    assert.equal(text.toLowerCase().includes('authorization'), false);
  }
  // The credential travels only in the Authorization header of the fixed host.
  assert.equal(
    context.github.calls.every(
      (call) => !call.path.includes('github_pat_') && !call.path.includes('token=')
    ),
    true
  );
  assert.equal(
    redactSecrets(`failed for Bearer ${TEST_TOKEN} and ${TEST_TOKEN}`).includes(TEST_TOKEN),
    false
  );
});

test('an out-of-scope alias is a client error, not a server error', async () => {
  const context = fixture({ files: { '.azure/dev/.env': 'AZURE_SUBSCRIPTION_ID="x"\n' } });
  const id = await attached(context);
  for (const alias of ['.azure/dev/.env', '../escape.bicepparam', 'notes.md', '']) {
    await assert.rejects(
      context.routes.workspace({
        req: request(id),
        url: url(`?alias=${encodeURIComponent(alias)}`),
        environmentId: ENVIRONMENT_ID,
        operation: 'blob',
        readBody: async () => ({}),
      }),
      (error) => {
        // A bare Error would be sanitized into a 500 and hide the reason.
        assert.equal(error.status, 400, `${alias} -> ${error.status}`);
        assert.equal(error.code, 'INVALID_ALIAS');
        return true;
      },
      alias
    );
  }
});

test('the generic commit endpoint cannot replace or delete an environment file', async () => {
  const secret = [
    'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"',
    'AZURE_CLIENT_SECRET="SUPER-SECRET-VALUE"',
    '',
  ].join('\n');
  const context = fixture({ files: { '.azure/dev/.env': secret } });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  const bridge = await context.routes.workspace({
    req: request(id),
    url: url('?environmentName=dev'),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({}),
  });

  const send = (files) =>
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files,
      }),
    });

  // Full-file replacement, with and without the forged capability flag.
  for (const attempt of [
    {
      alias: '.azure/dev/.env',
      subscription: true,
      blobSha: bridge.blobSha,
      beforeHash: bridge.hash,
      after: Buffer.from('AZURE_CLIENT_SECRET="stolen"\n').toString('base64'),
    },
    {
      alias: '.azure/dev/.env',
      blobSha: bridge.blobSha,
      beforeHash: bridge.hash,
      after: Buffer.from('overwritten\n').toString('base64'),
    },
    // Deletion of the environment file.
    { alias: '.azure/dev/.env', subscription: true, remove: true, blobSha: bridge.blobSha, beforeHash: bridge.hash },
    { alias: '.azure/dev/.env', remove: true, blobSha: bridge.blobSha, beforeHash: bridge.hash },
  ]) {
    await assert.rejects(
      send([attempt]),
      (error) =>
        error.code === 'SUBSCRIPTION_NOT_ALLOWED' || error.code === 'INVALID_ALIAS',
      JSON.stringify(attempt.subscription ?? false)
    );
  }

  assert.equal(context.repository.refs.get(branch), head);
  assert.equal(
    context.github.fileText(context.repository, branch, '.azure/dev/.env'),
    secret
  );
});

test('writes are refused in skipped directories such as .github', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  for (const alias of [
    '.github/private.xml',
    '.github/workflows/deploy.bicepparam',
    'node_modules/pkg/a.bicepparam',
    'CitadelUI/web/app.xml',
    '.git/config.xml',
  ]) {
    await assert.rejects(
      context.routes.workspace({
        req: request(id, { method: 'POST' }),
        url: url(),
        environmentId: ENVIRONMENT_ID,
        operation: 'commits',
        readBody: async () => ({
          action: 'parameter-edit',
          expectedHead: head,
          transactionId: '11111111-2222-3333-4444-555555555555',
          files: [{ alias, create: true, after: Buffer.from('x\n').toString('base64') }],
        }),
      }),
      (error) => error.code === 'INVALID_ALIAS',
      alias
    );
  }
  assert.equal(context.repository.refs.get(branch), head);
});

test('a creation cannot overwrite an existing source and needs a reviewed head', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const alias = 'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam';
  const commit = (body) =>
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => body,
    });

  const first = await commit({
    action: 'contract-create',
    expectedHead: context.repository.refs.get(branch),
    transactionId: '11111111-2222-3333-4444-555555555555',
    files: [{ alias, create: true, after: Buffer.from('a\n').toString('base64') }],
  });
  assert.ok(first.commit);

  // A second creation of the same contract must not silently overwrite it.
  await assert.rejects(
    commit({
      action: 'contract-create',
      expectedHead: context.repository.refs.get(branch),
      transactionId: '22222222-2222-3333-4444-555555555555',
      files: [{ alias, create: true, after: Buffer.from('b\n').toString('base64') }],
    }),
    (error) => error.code === 'SOURCE_EXISTS'
  );
  assert.equal(context.github.fileText(context.repository, branch, alias), 'a\n');

  // A reviewed head is mandatory.
  await assert.rejects(
    commit({
      action: 'parameter-edit',
      expectedHead: null,
      transactionId: '33333333-2222-3333-4444-555555555555',
      files: [{ alias: 'bicep/infra/new.bicepparam', create: true, after: Buffer.from('x\n').toString('base64') }],
    }),
    (error) => error.code === 'EXPECTED_HEAD_REQUIRED'
  );
});

test('an update precondition is bound to the target path, not just to a blob', async () => {
  const context = fixture({ files: { 'bicep/infra/other.bicepparam': "using 'main.bicep'\n// other\n" } });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const main = tree.files.find((file) => file.alias === 'bicep/infra/main.bicepparam');
  const other = tree.files.find((file) => file.alias === 'bicep/infra/other.bicepparam');
  const mainBlob = await context.routes.workspace({
    req: request(id),
    url: url(`?alias=${encodeURIComponent(main.alias)}&sha=${main.sha}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'blob',
    readBody: async () => ({}),
  });

  // A blob that exists, but not at the named path, is refused.
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: tree.head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: other.alias,
            blobSha: main.sha,
            beforeHash: mainBlob.hash,
            mode: other.mode,
            after: Buffer.from('x\n').toString('base64'),
          },
        ],
      }),
    }),
    (error) => error.code === 'STALE_SOURCE'
  );

  // A missing reviewed hash is refused outright.
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: tree.head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: main.alias,
            blobSha: main.sha,
            mode: main.mode,
            after: Buffer.from('x\n').toString('base64'),
          },
        ],
      }),
    }),
    (error) => error.code === 'INVALID_CHANGE_SET'
  );

  // Updating a path that does not exist is refused rather than creating it.
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: tree.head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/absent.bicepparam',
            blobSha: main.sha,
            beforeHash: mainBlob.hash,
            mode: main.mode,
            after: Buffer.from('x\n').toString('base64'),
          },
        ],
      }),
    }),
    (error) => error.code === 'STALE_SOURCE'
  );
});

test('an executable source keeps its mode through an edit and an undo', async () => {
  const executable = 'bicep/infra/tooling.bicepparam';
  const context = fixture({
    files: { [executable]: { content: "using 'main.bicep'\n// v1\n", mode: '100755' } },
  });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const entry = tree.files.find((file) => file.alias === executable);
  assert.equal(entry.mode, '100755');
  const blob = await context.routes.workspace({
    req: request(id),
    url: url(`?alias=${encodeURIComponent(executable)}&sha=${entry.sha}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'blob',
    readBody: async () => ({}),
  });

  const edited = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: tree.head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: executable,
          blobSha: entry.sha,
          beforeHash: blob.hash,
          mode: entry.mode,
          after: Buffer.from("using 'main.bicep'\n// v2\n").toString('base64'),
        },
      ],
    }),
  });
  const afterEdit = context.github
    .treeOf(edited.commit)
    .find((item) => item.path === executable);
  assert.equal(afterEdit.mode, '100755');

  const undone = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'reverts',
    readBody: async () => ({
      commit: edited.commit,
      transactionId: '99999999-2222-3333-4444-555555555555',
    }),
  });
  const afterUndo = context.github
    .treeOf(undone.commit)
    .find((item) => item.path === executable);
  assert.equal(afterUndo.mode, '100755');
  assert.equal(context.github.fileText(context.repository, branch, executable), "using 'main.bicep'\n// v1\n");
});

test('undo of a deletion restores the file as a checked creation', async () => {
  const target = 'bicep/infra/removable.bicepparam';
  const context = fixture({ files: { [target]: "using 'main.bicep'\n// keep\n" } });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const entry = tree.files.find((file) => file.alias === target);
  const blob = await context.routes.workspace({
    req: request(id),
    url: url(`?alias=${encodeURIComponent(target)}&sha=${entry.sha}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'blob',
    readBody: async () => ({}),
  });

  const deleted = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'history-restore',
      expectedHead: tree.head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        { alias: target, remove: true, blobSha: entry.sha, beforeHash: blob.hash, mode: entry.mode },
      ],
    }),
  });
  assert.equal(context.github.fileText(context.repository, branch, target), null);

  // `sha: null` is not a blob, so undo must restore from the parent revision.
  const undone = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'reverts',
    readBody: async () => ({
      commit: deleted.commit,
      transactionId: '99999999-2222-3333-4444-555555555555',
    }),
  });
  assert.equal(
    context.github.fileText(context.repository, branch, target),
    "using 'main.bicep'\n// keep\n"
  );
  assert.equal(context.github.commits.get(undone.commit).parents[0], deleted.commit);
});

test('undo requires an audited, single-parent, reachable commit', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);

  // A commit with perfectly forged Citadel trailers, created outside Citadel UI.
  const forgedTree = context.github.writeNestedTree([
    ...context.github.treeOf(head),
    {
      path: 'bicep/infra/forged.bicepparam',
      mode: '100644',
      type: 'blob',
      sha: context.github.writeBlob(Buffer.from("using 'main.bicep'\n")),
      size: 20,
    },
  ]);
  const forged = context.github.writeCommit(
    forgedTree,
    [head],
    `Citadel parameter-edit: forged.bicepparam\n\nCitadel-Action: parameter-edit\nCitadel-Environment: ${ENVIRONMENT_ID}\nCitadel-Transaction: 11111111-2222-3333-4444-555555555555`
  );
  context.repository.refs.set(branch, forged);

  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'reverts',
      readBody: async () => ({
        commit: forged,
        transactionId: '99999999-2222-3333-4444-555555555555',
      }),
    }),
    (error) => error.code === 'UNAUDITED_COMMIT'
  );
  assert.equal(context.repository.refs.get(branch), forged);

  // A genuine Citadel commit made on a different branch is not undoable here.
  context.github.seed(context.repository, 'other-branch', {
    'bicep/infra/main.bicepparam': "using 'main.bicep'\n",
  });
  const otherHead = context.repository.refs.get('other-branch');
  context.audit.commits.push({
    repositoryId: 9001,
    fullName: 'taomar/citadelQA',
    environmentId: ENVIRONMENT_ID,
    branch,
    action: 'parameter-edit',
    transactionId: '55555555-2222-3333-4444-555555555555',
    baseCommit: head,
    commit: otherHead,
    aliases: ['bicep/infra/main.bicepparam'],
  });
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'reverts',
      readBody: async () => ({
        commit: otherHead,
        transactionId: '99999999-2222-3333-4444-555555555555',
      }),
    }),
    (error) => error.code === 'UNREACHABLE_COMMIT'
  );
});

test('History lists only audited commits and carries the UI contract', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  const saved = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'contract-create',
      expectedHead: head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: 'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam',
          create: true,
          after: Buffer.from('a\n').toString('base64'),
        },
      ],
    }),
  });

  // A forged-trailer commit pushed on top must not appear in History.
  const forged = context.github.writeCommit(
    context.github.commits.get(saved.commit).tree,
    [saved.commit],
    `Citadel parameter-edit: x\n\nCitadel-Action: parameter-edit\nCitadel-Environment: ${ENVIRONMENT_ID}\nCitadel-Transaction: 77777777-2222-3333-4444-555555555555`
  );
  context.repository.refs.set(branch, forged);

  const history = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'history',
    readBody: async () => ({}),
  });
  assert.equal(history.transactions.length, 1);
  const entry = history.transactions[0];
  assert.equal(entry.commit, saved.commit);
  assert.equal(entry.status, 'committed');
  assert.equal(entry.action, 'contract-create');
  assert.equal(entry.targetLabel, 'contract-create');
  assert.deepEqual(entry.aliases, [
    'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam',
  ]);
  assert.deepEqual(entry.files, [
    { alias: 'bicep/infra/citadel-access-contracts/contracts/one/main.bicepparam' },
  ]);
  assert.ok(entry.committedAt);
  assert.equal(entry.canUndo, true);
  assert.equal(entry.id, saved.commit);
});

test('a legitimate fast-forward right after saving is not reported as a failed save', async () => {
  const context = fixture();
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);

  // Someone else pushes immediately after our ref update succeeds.
  const original = context.client.fetch;
  let patched = false;
  context.client.fetch = async (href, init) => {
    const response = await original(href, init);
    if (!patched && init?.method === 'PATCH' && href.includes('/git/refs/heads/')) {
      patched = true;
      context.github.seed(
        context.repository,
        branch,
        { 'bicep/infra/unrelated.bicepparam': "using 'main.bicep'\n" },
        { parents: [context.repository.refs.get(branch)] }
      );
    }
    return response;
  };

  const result = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: 'bicep/infra/new.bicepparam',
          create: true,
          after: Buffer.from("using 'main.bicep'\n").toString('base64'),
        },
      ],
    }),
  });
  // The save landed; the later push is reported as a warning, not a failure.
  assert.ok(result.commit);
  assert.equal(result.movedAfterSave, true);
  assert.notEqual(result.head, result.commit);
});

test('the subscription bridge survives a truncated tree and refuses odd modes', async () => {
  const secret = 'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"\nAZURE_SECRET="keep"\n';
  const context = fixture({ files: { '.azure/dev/.env': secret } });
  const id = await attached(context);

  // A truncated recursive listing omits `.azure`, which must not be read as
  // "the file does not exist" and must never invite creating over it.
  context.github.truncateTrees = true;
  const found = await context.routes.workspace({
    req: request(id),
    url: url('?environmentName=dev'),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({}),
  });
  assert.equal(found.available, true);
  assert.equal(found.value, '00000000-0000-0000-0000-000000000000');
  context.github.truncateTrees = false;

  // A symlink at the environment path is refused rather than replaced.
  const linked = fixture({
    files: { '.azure/dev/.env': { content: '../elsewhere/.env', mode: '120000' } },
  });
  const linkedId = await attached(linked);
  await assert.rejects(
    linked.routes.workspace({
      req: request(linkedId),
      url: url('?environmentName=dev'),
      environmentId: ENVIRONMENT_ID,
      operation: 'subscription',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'UNSUPPORTED_ENV_ENTRY'
  );
});

test('a newly created working branch is removed when attachment is abandoned', async () => {
  const context = fixture();
  const id = await connected(context);
  const attach = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
  });
  assert.equal(attach.createdWorkingBranch, true);
  assert.equal(context.repository.refs.has('citadel-ui/env-github-one'), true);

  const removed = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: attach.operationId,
  });
  assert.equal(removed.removed, true);
  assert.equal(context.repository.refs.has('citadel-ui/env-github-one'), false);
  // The source branch is untouched.
  assert.equal(context.repository.refs.has('main'), true);
});

test('cleanup accepts only the server-issued operation and cannot target another branch', async () => {
  const context = fixture();
  const id = await connected(context);
  const attach = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
  });
  context.github.seed(context.repository, attach.source.workingBranch, {
    'bicep/infra/main.bicepparam': "using 'main.bicep'\n// work\n",
  });
  const moved = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: attach.operationId,
  });
  assert.equal(moved.removed, false);
  assert.equal(moved.reason, 'branch-moved');
  assert.equal(context.repository.refs.has(attach.source.workingBranch), true);

  // The operation is one-time, so a replayed cleanup cannot act again.
  await assert.rejects(
    context.routes.abandon(request(id, { method: 'POST' }), {
      operationId: attach.operationId,
    }),
    (error) => error.code === 'UNKNOWN_OPERATION'
  );

  // The request carries no repository, branch or head of its own, so a browser
  // cannot aim cleanup at another environment's working branch.
  const victim = 'citadel-ui/env-someone-else';
  context.github.seed(context.repository, victim, {
    'bicep/infra/main.bicepparam': "using 'main.bicep'\n",
  });
  for (const body of [
    { operationId: 'A'.repeat(43) },
    { operationId: attach.operationId, workingBranch: victim },
  ]) {
    await assert.rejects(
      context.routes.abandon(request(id, { method: 'POST' }), body),
      (error) =>
        error.code === 'UNKNOWN_OPERATION' ||
        error.code === 'INVALID_CONTENT' ||
        error.code === 'INVALID_OPERATION',
      JSON.stringify(body)
    );
  }
  assert.equal(context.repository.refs.has(victim), true);

  // An operation issued for one credential is not usable by another.
  const other = await context.routes.connect({ token: TEST_TOKEN });
  const second = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: 'env-second',
    writeMode: 'working-branch',
  });
  await assert.rejects(
    context.routes.abandon(request(other.id, { method: 'POST' }), {
      operationId: second.operationId,
    }),
    (error) => error.code === 'UNKNOWN_OPERATION'
  );
  assert.equal(context.repository.refs.has('citadel-ui/env-second'), true);
});

test('a lost attach response is recovered by retrying the same operation key', async () => {
  const context = fixture();
  const id = await connected(context);
  const payload = {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
    operationKey: 'attach-key-0001',
  };
  const first = await context.routes.attach(request(id, { method: 'POST' }), payload);
  assert.equal(first.createdWorkingBranch, true);

  // The response was lost; the browser retries with the same key.
  const retry = await context.routes.attach(request(id, { method: 'POST' }), payload);
  assert.deepEqual(retry, first);
  assert.equal(retry.operationId, first.operationId);

  // Exactly one branch exists, and the recovered provenance still cleans it up.
  const citadelBranches = [...context.repository.refs.keys()].filter((name) =>
    name.startsWith('citadel-ui/')
  );
  assert.deepEqual(citadelBranches, ['citadel-ui/env-github-one']);
  const cleanup = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: retry.operationId,
  });
  assert.equal(cleanup.removed, true);
  assert.equal(context.repository.refs.has('citadel-ui/env-github-one'), false);
});

test('a creation is refused when any Git object occupies the path', async () => {
  const context = fixture({
    files: {
      // A tree, a submodule and a symlink each occupy a path without being a
      // regular blob, so a blob-only index would report all three as absent.
      'bicep/infra/occupied/inner.bicepparam': "using '../main.bicep'\n",
      'bicep/infra/vendored': { content: 'x', mode: '160000' },
      'bicep/infra/linked.bicepparam': { content: '../main.bicepparam', mode: '120000' },
    },
  });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const head = context.repository.refs.get(branch);
  const create = (alias) =>
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'contract-create',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [{ alias, create: true, after: Buffer.from('x\n').toString('base64') }],
      }),
    });

  for (const alias of [
    'bicep/infra/occupied',
    'bicep/infra/vendored',
    'bicep/infra/linked.bicepparam',
  ]) {
    await assert.rejects(
      create(alias),
      (error) => error.code === 'SOURCE_EXISTS' || error.code === 'INVALID_ALIAS',
      alias
    );
  }
  assert.equal(context.repository.refs.get(branch), head);
});

test('an update must present the reviewed file mode', async () => {
  const executable = 'bicep/infra/tooling.bicepparam';
  const context = fixture({
    files: { [executable]: { content: "using 'main.bicep'\n// v1\n", mode: '100755' } },
  });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const entry = tree.files.find((file) => file.alias === executable);
  const blob = await context.routes.workspace({
    req: request(id),
    url: url(`?alias=${encodeURIComponent(executable)}&sha=${entry.sha}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'blob',
    readBody: async () => ({}),
  });
  const send = (mode) =>
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: tree.head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: executable,
            blobSha: entry.sha,
            beforeHash: blob.hash,
            ...(mode === undefined ? {} : { mode }),
            after: Buffer.from("using 'main.bicep'\n// v2\n").toString('base64'),
          },
        ],
      }),
    });

  // Omitting the mode is refused rather than defaulting.
  await assert.rejects(send(undefined), (error) => error.code === 'INVALID_CHANGE_SET');
  // Claiming the wrong mode is a conflict, not a silent downgrade.
  await assert.rejects(send('100644'), (error) => error.code === 'STALE_SOURCE');
  assert.equal(context.repository.refs.get(branch), tree.head);

  // The correct mode succeeds and the executable bit survives.
  const saved = await send('100755');
  const after = context.github.treeOf(saved.commit).find((item) => item.path === executable);
  assert.equal(after.mode, '100755');
});

test('undo is refused when a collaborator changed only the file mode', async () => {
  const executable = 'bicep/infra/tooling.bicepparam';
  const context = fixture({
    files: { [executable]: { content: "using 'main.bicep'\n// v1\n", mode: '100755' } },
  });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const entry = tree.files.find((file) => file.alias === executable);
  const blob = await context.routes.workspace({
    req: request(id),
    url: url(`?alias=${encodeURIComponent(executable)}&sha=${entry.sha}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'blob',
    readBody: async () => ({}),
  });
  const edited = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: tree.head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: executable,
          blobSha: entry.sha,
          beforeHash: blob.hash,
          mode: '100755',
          after: Buffer.from("using 'main.bicep'\n// v2\n").toString('base64'),
        },
      ],
    }),
  });

  // A collaborator drops the executable bit without changing a byte. The blob
  // SHA is identical, so a SHA-only comparison would call this unchanged and
  // undo would silently discard their edit.
  const current = context.github.treeOf(edited.commit).map((item) => ({ ...item }));
  current.find((item) => item.path === executable).mode = '100644';
  const moved = context.github.writeCommit(
    context.github.writeNestedTree(current),
    [edited.commit],
    'chore: drop executable bit'
  );
  context.repository.refs.set(branch, moved);

  const inspected = await context.routes.workspace({
    req: request(id),
    url: url(`?sha=${edited.commit}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({}),
  });
  assert.equal(inspected.transaction.canRevert, false);
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'reverts',
      readBody: async () => ({
        commit: edited.commit,
        transactionId: '99999999-2222-3333-4444-555555555555',
      }),
    }),
    (error) => error.code === 'STALE_SOURCE'
  );
  assert.equal(context.repository.refs.get(branch), moved);
});

test('a truncated tree cannot make an existing path look absent during a commit', async () => {
  const secret = 'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"\nAZURE_SECRET="keep"\n';
  const context = fixture({ files: { '.azure/dev/.env': secret } });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';

  // The recursive listing omits `.azure`, and the fallback walk skips it too.
  context.github.truncateTrees = true;
  const before = await context.routes.workspace({
    req: request(id),
    url: url('?environmentName=dev'),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({}),
  });
  assert.equal(before.available, true);

  // Saving must patch the existing file, not create over it.
  const saved = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({
      environmentName: 'dev',
      value: '11111111-2222-3333-4444-555555555555',
      expectedHead: context.repository.refs.get(branch),
      expectedHash: before.hash,
      transactionId: '11111111-2222-3333-4444-555555555555',
    }),
  });
  assert.equal(saved.changed, true);
  assert.equal(
    context.github.fileText(context.repository, branch, '.azure/dev/.env'),
    secret.replace('00000000-0000-0000-0000-000000000000', '11111111-2222-3333-4444-555555555555')
  );

  // Undo restores the original bytes rather than deleting the file.
  const undone = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'reverts',
    readBody: async () => ({
      commit: saved.commit,
      transactionId: '99999999-2222-3333-4444-555555555555',
    }),
  });
  assert.ok(undone.commit);
  assert.equal(context.github.fileText(context.repository, branch, '.azure/dev/.env'), secret);
  context.github.truncateTrees = false;
});

test('a save is refused when the change log cannot be written', async () => {
  const branch = 'citadel-ui/env-github-one';
  const context = fixture();
  const id = await attached(context);
  context.routes.audit = {
    record: async () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
    find: async () => null,
    listForEnvironment: async () => [],
  };
  const head = context.repository.refs.get(branch);
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/new.bicepparam',
            create: true,
            after: Buffer.from("using 'main.bicep'\n").toString('base64'),
          },
        ],
      }),
    }),
    (error) => {
      assert.equal(error.code, 'AUDIT_UNAVAILABLE');
      // A commit History cannot list and Undo must refuse is worse than no
      // commit, so the save is refused outright.
      assert.match(error.message, /was not applied/);
      return true;
    }
  );
  // The branch is untouched, so retrying cannot duplicate anything.
  assert.equal(context.repository.refs.get(branch), head);
  assert.equal(context.github.fileText(context.repository, branch, 'bicep/infra/new.bicepparam'), null);
});

test('an audit record for a commit that never landed cannot be reverted', async () => {
  const branch = 'citadel-ui/env-github-one';
  const context = fixture();
  const id = await attached(context);
  const head = context.repository.refs.get(branch);

  // The audit is written before the ref moves, so a ref update that then fails
  // leaves a record whose commit is not on the branch.
  const original = context.client.fetch;
  context.client.fetch = async (href, init) => {
    if (init?.method === 'PATCH' && href.includes('/git/refs/heads/')) {
      throw Object.assign(new Error('network down'), { status: 500 });
    }
    return original(href, init);
  };
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/new.bicepparam',
            create: true,
            after: Buffer.from("using 'main.bicep'\n").toString('base64'),
          },
        ],
      }),
    })
  );
  context.client.fetch = original;
  assert.equal(context.repository.refs.get(branch), head);

  // The record exists, but reachability — not the record — authorises an undo.
  const records = await context.routes.audit.listForEnvironment(ENVIRONMENT_ID, branch);
  assert.equal(records.length, 1);
  const orphan = records[0].commit;
  await assert.rejects(
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'reverts',
      readBody: async () => ({
        commit: orphan,
        transactionId: '99999999-2222-3333-4444-555555555555',
      }),
    }),
    (error) => error.code === 'UNREACHABLE_COMMIT'
  );

  // History lists commits on the branch, so it never shows the orphan either.
  const history = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'history',
    readBody: async () => ({}),
  });
  assert.equal(
    history.transactions.some((entry) => entry.commit === orphan),
    false
  );
});

test('nothing after a successful ref update can report the save as failed', async () => {
  const branch = 'citadel-ui/env-github-one';
  const send = (context, id, head) =>
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/new.bicepparam',
            create: true,
            after: Buffer.from("using 'main.bicep'\n").toString('base64'),
          },
        ],
      }),
    });

  // The confirming read of the branch head fails after the ref moved.
  const blind = fixture();
  const blindId = await attached(blind);
  const headB = blind.repository.refs.get(branch);
  const original = blind.client.fetch;
  let patched = false;
  blind.client.fetch = async (href, init) => {
    if (patched && href.includes('/git/ref/heads/')) throw new Error('network down');
    const response = await original(href, init);
    if (init?.method === 'PATCH' && href.includes('/git/refs/heads/')) patched = true;
    return response;
  };
  const savedB = await send(blind, blindId, headB);
  assert.ok(savedB.commit);
  assert.equal(blind.repository.refs.get(branch), savedB.commit);
  assert.equal(savedB.headUnknown, true);
  assert.match(savedB.warnings.join(' '), /could not be re-read/);
});

test('a failed subscription verification still reports the commit as applied', async () => {
  const context = fixture({
    files: { '.azure/dev/.env': 'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"\n' },
  });
  const id = await attached(context);
  const branch = 'citadel-ui/env-github-one';
  const before = await context.routes.workspace({
    req: request(id),
    url: url('?environmentName=dev'),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({}),
  });
  const original = context.client.fetch;
  let patched = false;
  context.client.fetch = async (href, init) => {
    if (patched && href.includes('/git/trees/')) throw new Error('verification read failed');
    const response = await original(href, init);
    if (init?.method === 'PATCH' && href.includes('/git/refs/heads/')) patched = true;
    return response;
  };
  const saved = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'subscription',
    readBody: async () => ({
      environmentName: 'dev',
      value: '11111111-2222-3333-4444-555555555555',
      expectedHead: context.repository.refs.get(branch),
      expectedHash: before.hash,
      transactionId: '11111111-2222-3333-4444-555555555555',
    }),
  });
  assert.equal(saved.changed, true);
  assert.ok(saved.commit);
  assert.equal(saved.verified, false);
  assert.match(saved.warnings.join(' '), /could not be re-read/);
  assert.equal(context.repository.refs.get(branch), saved.commit);
});

test('two identical attach requests racing produce one branch and one reservation', async () => {
  const context = fixture();
  const id = await connected(context);
  const payload = {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
    operationKey: 'attach-key-race',
  };
  // Both requests are in flight before either completes.
  const [first, second] = await Promise.all([
    context.routes.attach(request(id, { method: 'POST' }), { ...payload }),
    context.routes.attach(request(id, { method: 'POST' }), { ...payload }),
  ]);
  assert.equal(first.operationId, second.operationId);
  assert.deepEqual(first, second);
  assert.deepEqual(
    [...context.repository.refs.keys()].filter((name) => name.startsWith('citadel-ui/')),
    ['citadel-ui/env-github-one']
  );
  assert.equal(context.routes.attachments.size, 1);

  // One reservation means one cleanup, and it removes the single branch.
  const cleanup = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: first.operationId,
  });
  assert.equal(cleanup.removed, true);
  assert.equal(context.repository.refs.has('citadel-ui/env-github-one'), false);
});

test('a branch created by an ambiguous response is still cleanable', async () => {
  const context = fixture();
  const id = await connected(context);
  const branch = 'citadel-ui/env-github-one';
  const original = context.client.fetch;
  // GitHub creates the ref, then the response is lost.
  context.client.fetch = async (href, init) => {
    const response = await original(href, init);
    if (init?.method === 'POST' && href.endsWith('/git/refs')) {
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    return response;
  };
  const attach = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
  });
  context.client.fetch = original;
  // The reservation reconciled the ambiguity by asking what actually exists.
  assert.equal(context.repository.refs.has(branch), true);
  assert.equal(attach.createdWorkingBranch, true);
  assert.equal(attach.source.workingBranch, branch);

  const cleanup = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: attach.operationId,
  });
  assert.equal(cleanup.removed, true);
  assert.equal(context.repository.refs.has(branch), false);
});

test('a branch mutation that created nothing leaves no reservation behind', async () => {
  const context = fixture();
  const id = await connected(context);
  const original = context.client.fetch;
  context.client.fetch = async (href, init) => {
    if (init?.method === 'POST' && href.endsWith('/git/refs')) {
      return context.github.json(403, { message: 'Branch creation is not permitted.' });
    }
    return original(href, init);
  };
  await assert.rejects(
    context.routes.attach(request(id, { method: 'POST' }), {
      repositoryId: 9001,
      sourceBranch: 'main',
      environmentId: ENVIRONMENT_ID,
      writeMode: 'working-branch',
    }),
    (error) => error.status === 403
  );
  context.client.fetch = original;
  assert.equal(context.repository.refs.has('citadel-ui/env-github-one'), false);
  // Nothing was created, so no provenance is retained.
  assert.equal(context.routes.attachments.size, 0);
});

test('a transient cleanup failure keeps the operation so it can be retried', async () => {
  const context = fixture();
  const id = await connected(context);
  const branch = 'citadel-ui/env-github-one';
  const attach = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
  });

  // The lookup fails. The reservation must survive: it is the only thing that
  // can name this branch for cleanup.
  const original = context.client.fetch;
  context.client.fetch = async (href, init) => {
    if (href.includes('/git/ref/heads/citadel-ui')) throw new Error('network down');
    return original(href, init);
  };
  const lookupFailed = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: attach.operationId,
  });
  assert.equal(lookupFailed.removed, false);
  assert.equal(lookupFailed.reason, 'lookup-failed');
  assert.equal(lookupFailed.retryable, true);
  assert.equal(context.repository.refs.has(branch), true);

  // The delete fails next. Still retained.
  context.client.fetch = async (href, init) => {
    if (init?.method === 'DELETE' && href.includes('/git/refs/heads/citadel-ui')) {
      throw new Error('network down');
    }
    return original(href, init);
  };
  const deleteFailed = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: attach.operationId,
  });
  assert.equal(deleteFailed.removed, false);
  assert.equal(deleteFailed.reason, 'delete-failed');
  assert.equal(deleteFailed.retryable, true);
  assert.equal(context.repository.refs.has(branch), true);

  // Once the network recovers the same id still works.
  context.client.fetch = original;
  const cleanup = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: attach.operationId,
  });
  assert.equal(cleanup.removed, true);
  assert.equal(context.repository.refs.has(branch), false);

  // And only then is it retired.
  await assert.rejects(
    context.routes.abandon(request(id, { method: 'POST' }), { operationId: attach.operationId }),
    (error) => error.code === 'UNKNOWN_OPERATION'
  );
});

test('a transient lookup after an ambiguous create keeps the reservation', async () => {
  const context = fixture();
  const id = await connected(context);
  const branch = 'citadel-ui/env-github-one';
  const original = context.client.fetch;
  // The first lookup answers 404 as normal, the ref is then created and the
  // response lost, and only the *confirming* lookup fails. Neither created nor
  // absent is proven.
  let lookups = 0;
  context.client.fetch = async (href, init) => {
    if (href.includes('/git/ref/heads/citadel-ui')) {
      lookups += 1;
      if (lookups > 1) throw new Error('network down');
      return original(href, init);
    }
    const response = await original(href, init);
    if (init?.method === 'POST' && href.endsWith('/git/refs')) {
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    return response;
  };
  await assert.rejects(
    context.routes.attach(request(id, { method: 'POST' }), {
      repositoryId: 9001,
      sourceBranch: 'main',
      environmentId: ENVIRONMENT_ID,
      writeMode: 'working-branch',
      operationKey: 'attach-key-ambiguous',
    })
  );
  context.client.fetch = original;

  // The branch really was created, and the reservation survived to name it.
  assert.equal(context.repository.refs.has(branch), true);
  assert.equal(context.routes.attachments.size, 1);

  // The same operation key reconciles against what is actually there.
  const retry = await context.routes.attach(request(id, { method: 'POST' }), {
    repositoryId: 9001,
    sourceBranch: 'main',
    environmentId: ENVIRONMENT_ID,
    writeMode: 'working-branch',
    operationKey: 'attach-key-ambiguous',
  });
  assert.equal(retry.source.workingBranch, branch);
  assert.equal(retry.createdWorkingBranch, true);
  assert.deepEqual(
    [...context.repository.refs.keys()].filter((name) => name.startsWith('citadel-ui/')),
    [branch]
  );

  const cleanup = await context.routes.abandon(request(id, { method: 'POST' }), {
    operationId: retry.operationId,
  });
  assert.equal(cleanup.removed, true);
  assert.equal(context.repository.refs.has(branch), false);
});

test('a save that may have landed is reconciled against the branch', async () => {
  const branch = 'citadel-ui/env-github-one';
  const send = (context, id, head) =>
    context.routes.workspace({
      req: request(id, { method: 'POST' }),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'commits',
      readBody: async () => ({
        action: 'parameter-edit',
        expectedHead: head,
        transactionId: '11111111-2222-3333-4444-555555555555',
        files: [
          {
            alias: 'bicep/infra/new.bicepparam',
            create: true,
            after: Buffer.from("using 'main.bicep'\n").toString('base64'),
          },
        ],
      }),
    });

  // The PATCH applied, then the answer was lost. The branch says otherwise.
  const applied = fixture();
  const appliedId = await attached(applied);
  const appliedHead = applied.repository.refs.get(branch);
  const appliedFetch = applied.client.fetch;
  applied.client.fetch = async (href, init) => {
    const response = await appliedFetch(href, init);
    if (init?.method === 'PATCH' && href.includes('/git/refs/heads/')) {
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    return response;
  };
  const saved = await send(applied, appliedId, appliedHead);
  applied.client.fetch = appliedFetch;
  assert.ok(saved.commit);
  assert.equal(applied.repository.refs.get(branch), saved.commit);
  assert.match(saved.warnings.join(' '), /did not answer/);

  // The PATCH did not apply, and the branch proves it. That is a real failure.
  const missed = fixture();
  const missedId = await attached(missed);
  const missedHead = missed.repository.refs.get(branch);
  const missedFetch = missed.client.fetch;
  missed.client.fetch = async (href, init) => {
    if (init?.method === 'PATCH' && href.includes('/git/refs/heads/')) {
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    return missedFetch(href, init);
  };
  await assert.rejects(
    send(missed, missedId, missedHead),
    (error) => error.code === 'SAVE_NOT_APPLIED' && /were not applied/.test(error.message)
  );
  missed.client.fetch = missedFetch;
  assert.equal(missed.repository.refs.get(branch), missedHead);

  // Neither can be proven. Reporting "not applied" would invite a retry that
  // duplicates a commit that may already be on the branch.
  const blind = fixture();
  const blindId = await attached(blind);
  const blindHead = blind.repository.refs.get(branch);
  const blindFetch = blind.client.fetch;
  // Only after the PATCH is attempted does the branch become unreadable, so the
  // save gets as far as a real ambiguity.
  let patchAttempted = false;
  blind.client.fetch = async (href, init) => {
    if (init?.method === 'PATCH' && href.includes('/git/refs/heads/')) {
      patchAttempted = true;
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    if (patchAttempted && href.includes('/git/ref/heads/')) throw new Error('network down');
    return blindFetch(href, init);
  };
  await assert.rejects(send(blind, blindId, blindHead), (error) => {
    assert.equal(error.code, 'INDETERMINATE_SAVE');
    assert.equal(error.indeterminate, true);
    // The commit SHA is handed back so the user can find it themselves.
    assert.match(error.commit, /^[0-9a-f]{40}$/);
    assert.match(error.message, /Reload the environment before saving again/);
    return true;
  });
  blind.client.fetch = blindFetch;
});

test('an undo that may have landed is reconciled the same way', async () => {
  const branch = 'citadel-ui/env-github-one';
  const context = fixture();
  const id = await attached(context);
  const tree = await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  const entry = tree.files.find((file) => file.alias === 'bicep/infra/main.bicepparam');
  const blob = await context.routes.workspace({
    req: request(id),
    url: url(`?alias=${encodeURIComponent(entry.alias)}&sha=${entry.sha}`),
    environmentId: ENVIRONMENT_ID,
    operation: 'blob',
    readBody: async () => ({}),
  });
  const edited = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'commits',
    readBody: async () => ({
      action: 'parameter-edit',
      expectedHead: tree.head,
      transactionId: '11111111-2222-3333-4444-555555555555',
      files: [
        {
          alias: entry.alias,
          blobSha: entry.sha,
          beforeHash: blob.hash,
          mode: entry.mode,
          after: Buffer.from("using 'main.bicep'\n// v2\n").toString('base64'),
        },
      ],
    }),
  });

  // Undo builds an inverse commit through the same ref update, so it inherits
  // the same reconciliation.
  const original = context.client.fetch;
  context.client.fetch = async (href, init) => {
    const response = await original(href, init);
    if (init?.method === 'PATCH' && href.includes('/git/refs/heads/')) {
      throw Object.assign(new Error('socket hang up'), { status: 500 });
    }
    return response;
  };
  const undone = await context.routes.workspace({
    req: request(id, { method: 'POST' }),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'reverts',
    readBody: async () => ({
      commit: edited.commit,
      transactionId: '99999999-2222-3333-4444-555555555555',
    }),
  });
  context.client.fetch = original;
  assert.ok(undone.commit);
  assert.equal(context.repository.refs.get(branch), undone.commit);
  assert.match(undone.warnings.join(' '), /did not answer/);
  assert.equal(
    context.github.fileText(context.repository, branch, entry.alias),
    citadelRepositoryFiles()[entry.alias]
  );
});

test('disconnect erases the credential so later calls fail closed', async () => {
  const context = fixture();
  const id = await attached(context);
  await context.routes.workspace({
    req: request(id),
    url: url(),
    environmentId: ENVIRONMENT_ID,
    operation: 'tree',
    readBody: async () => ({}),
  });
  assert.ok(context.routes.treeCache.size > 0);
  const result = await context.routes.handle({
    req: request(id, { method: 'DELETE' }),
    url: url(),
    parts: ['api', 'github', 'sessions', id],
    readBody: async () => ({}),
  });
  assert.equal(result.disconnected, true);
  // Nothing read under that credential is retained after an explicit disconnect.
  assert.equal(context.routes.treeCache.size, 0);
  await assert.rejects(
    context.routes.workspace({
      req: request(id),
      url: url(),
      environmentId: ENVIRONMENT_ID,
      operation: 'tree',
      readBody: async () => ({}),
    }),
    (error) => error.code === 'GITHUB_SESSION_EXPIRED'
  );
});

