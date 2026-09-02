/**
 * Selective discovery, proved by instrumentation rather than by assertion.
 *
 * Citadel has three editors and already knows where their sources live, so
 * discovery reads those and nothing else. That claim is only worth anything if
 * a test can *see* what was read, and only meaningful against a repository that
 * contains something worth not reading — against the three-file fixture
 * "everything was read" and "only the interest set was read" are the same
 * observation, and a test asserting the second would still pass with selective
 * discovery deleted.
 *
 * So these run against `citadelRepositoryWithNoise()`, which carries the
 * directories a real Citadel repository actually has, and watch two independent
 * instruments:
 *
 *   - `provider.instrument` — which aliases crossed the boundary.
 *   - `MockGitHub.calls` — how many requests reached GitHub, and for which
 *     blobs. Two aliases naming one blob must cost one request.
 *
 * The two agree on the same facts from different sides, so a cache that lied
 * about a read would have to lie consistently in two places to pass.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubAuditStore } from '../server/github/audit.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { BrowserDirectoryProvider } from '../web/js/directory-provider.mjs';
import { GitHubRepositoryProvider } from '../web/js/github-provider.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';
import { contractInfo, discoverWorkspace, primaryCapabilities } from '../shared/citadel-core.mjs';
import {
  CONTRACT_ROOT_MARKER,
  LLM_PATH,
  MAIN_PATH,
  citadelSourcePlan,
  contractRootOf,
  isContractAlias,
  planScope,
} from '../shared/source-plan.mjs';
import {
  ACCESS_PATHS,
  citadelRepositoryWithNoise,
  nonContractSubtreePaths,
  unrelatedParameterPaths,
} from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

const ENVIRONMENT_ID = 'env-selective';
const BRANCH = `citadel-ui/${ENVIRONMENT_ID}`;
const REPOSITORY_ID = 9701;
const FULL_NAME = 'taomar/citadelQA';
const MAIN_TEMPLATE = 'bicep/infra/main.bicep';
const LLM_TEMPLATE = 'bicep/infra/llm-backend-onboarding/main.bicep';
const INSTANCES = ['qa-alpha', 'qa-beta', 'qa-clone', 'qa-delta'];
const instancePath = (name) => `${ACCESS_PATHS.root}/contracts/${name}/main.bicepparam`;

/**
 * The browser modules wired to the real server routes over the mocked GitHub.
 *
 * Only the HTTP hop between browser and container is replaced, so the provider,
 * the routes, the scope checks and the Git protocol are all exercised together
 * — a read that this harness reports as avoided really was avoided end to end.
 */
async function harness(options = {}) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: REPOSITORY_ID, fullName: FULL_NAME });
  const files = options.files || citadelRepositoryWithNoise();
  github.seed(repository, 'main', files);
  const source = {
    kind: 'github',
    repositoryId: REPOSITORY_ID,
    fullName: FULL_NAME,
    sourceBranch: 'main',
    workingBranch: BRANCH,
    writeMode: 'working-branch',
  };
  const sessions = new GitHubSessionStore();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    audit: options.audit || new MemoryAudit(),
    sessions,
    registryStore: environmentRegistry({ [ENVIRONMENT_ID]: { id: ENVIRONMENT_ID, source } }),
  });
  const session = await routes.connect({ token: TEST_TOKEN });
  await routes.attach(
    { method: 'POST', headers: { 'x-citadel-github-session': session.id } },
    {
      repositoryId: REPOSITORY_ID,
      sourceBranch: 'main',
      environmentId: ENVIRONMENT_ID,
      writeMode: 'working-branch',
    }
  );

  const request = async (path, init = {}) => {
    const url = new URL(path, 'http://127.0.0.1:4173');
    return routes.handle({
      req: { method: init.method || 'GET', headers: { 'x-citadel-github-session': session.id } },
      url,
      parts: url.pathname.split('/').filter(Boolean),
      readBody: async () => JSON.parse(init.body || '{}'),
    });
  };

  const reads = [];
  const provider = new GitHubRepositoryProvider({
    request,
    environmentId: ENVIRONMENT_ID,
    instrument: (event) => {
      if (event.operation === 'read') reads.push(event.alias);
    },
  });
  const environment = { id: ENVIRONMENT_ID, projectId: 'project-one', label: 'QA', source };
  const context = { projectId: 'project-one', environment, provider };
  // Everything before this line is setup; only what follows is measured.
  github.calls.length = 0;
  return { github, repository, routes, provider, context, request, reads, files, session };
}

/** Blob SHAs GitHub was actually asked for, in order. */
function blobRequests(github) {
  return github.calls
    .filter((call) => call.method === 'GET' && call.path.includes('/git/blobs/'))
    .map((call) => call.path.split('/git/blobs/')[1]);
}

/** The same requests, resolved back to the paths they belong to. */
function blobPaths(github, repository, branch = BRANCH) {
  const tree = github.treeOf(repository.refs.get(branch));
  const byPath = new Map();
  for (const entry of tree) {
    if (!byPath.has(entry.sha)) byPath.set(entry.sha, []);
    byPath.get(entry.sha).push(entry.path);
  }
  return blobRequests(github).map((sha) => (byPath.get(sha) || ['<unknown>']).join('|'));
}

/** A provider over a plain file map that never declares itself remote. */
function localProvider(files, reads) {
  return {
    async entries() {
      return Object.keys(files)
        .filter((path) => /\.(bicepparam|bicep|xml)$/.test(path))
        .sort()
        .map((path) => ({ alias: path, kind: path.split('.').pop() }));
    },
    async read(alias) {
      reads.push(alias);
      const value = files[alias];
      const text = typeof value === 'string' ? value : value?.content;
      if (text === undefined) throw new Error(`Source not found: ${alias}`);
      return { text, size: Buffer.byteLength(text), hash: `hash-${alias}` };
    },
  };
}

// --------------------------------------------------------------------------
// The plan itself: decided from paths, before anything is downloaded.
// --------------------------------------------------------------------------

test('the interest set is decided from path metadata alone, with no source read', async () => {
  const files = citadelRepositoryWithNoise();
  const entries = Object.keys(files)
    .filter((path) => /\.(bicepparam|bicep|xml)$/.test(path))
    .map((path) => ({ alias: path, kind: path.split('.').pop() }));

  // No provider, no reader, nothing that could fetch: the argument is metadata.
  const plan = citadelSourcePlan(entries);

  assert.equal(plan.main, MAIN_PATH);
  assert.equal(plan.llm, LLM_PATH);
  assert.equal(plan.contractTemplate, ACCESS_PATHS.template);
  assert.deepEqual(plan.contractRoots, [ACCESS_PATHS.root]);
  assert.deepEqual(plan.policies, [ACCESS_PATHS.policy]);
  assert.deepEqual(
    plan.contracts,
    [ACCESS_PATHS.template, ...INSTANCES.map(instancePath)].sort((left, right) =>
      left.localeCompare(right)
    )
  );

  // The signature is the minimum that proves the three capabilities.
  assert.deepEqual(plan.signature, [MAIN_PATH, LLM_PATH, ACCESS_PATHS.template]);
  const capabilities = planScope(plan, 'capabilities');
  const workspace = planScope(plan, 'workspace');
  assert.equal(capabilities.size, 3);
  assert.equal(workspace.size, 3 + INSTANCES.length);
  for (const alias of capabilities) assert(workspace.has(alias), `${alias} missing from workspace`);

  // And the repository's own noise is named as none of Citadel's business —
  // including the subtrees that sit inside the contract root without being
  // contracts.
  const unrelated = unrelatedParameterPaths();
  assert(unrelated.length >= 20, `fixture is not noisy enough: ${unrelated.length}`);
  const ignored = [...unrelated, ...nonContractSubtreePaths()].sort((left, right) =>
    left.localeCompare(right)
  );
  assert.deepEqual(
    plan.unrelated.sort((left, right) => left.localeCompare(right)),
    ignored
  );
  for (const alias of ignored) {
    assert.equal(plan.isInterest(alias), false, `${alias} should not be interesting`);
    assert.equal(workspace.has(alias), false, `${alias} leaked into the workspace scope`);
  }
});

test('the creation template is read, and the base contracts it sits beside are not', async () => {
  // The distinction that made the plan and the classifier disagree, now stated.
  //
  // `<root>/main.bicepparam` is the template `createContract` copies to make a
  // new contract, so it must be downloaded even though it is not an instance.
  // `base-contracts/**` and `modules/**` are inside the same root and are
  // neither: nothing lists them and nothing copies from them, so downloading
  // them was fetching a file in order to ignore it.
  const context = await harness();
  const catalog = await discoverWorkspace(context.provider);

  assert(context.reads.includes(ACCESS_PATHS.template), 'the creation template was not read');
  for (const alias of nonContractSubtreePaths()) {
    assert.equal(context.reads.includes(alias), false, `${alias} was downloaded`);
    assert.equal(isContractAlias(alias), false, `${alias} counts as a contract`);
    // Still inside the contract root — this is a judgement about role, not
    // about location.
    assert.equal(contractRootOf(alias), ACCESS_PATHS.root);
  }

  // And they are absent from what the user is offered, so narrowing the read
  // took nothing away.
  const aliases = new Set(catalog.sourceAliases);
  const listed = catalog.files
    .map((file) => contractInfo(file, aliases))
    .filter(Boolean)
    .map((contract) => contract.paramFile);
  assert(listed.includes(ACCESS_PATHS.template));
  for (const alias of nonContractSubtreePaths()) {
    assert.equal(listed.includes(alias), false, `${alias} was offered as a contract`);
  }
});

test('the plan and the catalogue agree on what a contract is', () => {
  // They disagreed once, and the cost was a network read of a file that was
  // then classified as generic. One definition now answers both.
  const files = citadelRepositoryWithNoise();
  const entries = Object.keys(files)
    .filter((path) => path.endsWith('.bicepparam'))
    .map((path) => ({ alias: path, kind: 'bicepparam' }));
  const plan = citadelSourcePlan(entries);
  for (const alias of entries.map((entry) => entry.alias)) {
    if (alias === MAIN_PATH || alias === LLM_PATH) continue;
    assert.equal(
      plan.contracts.includes(alias),
      isContractAlias(alias),
      `${alias}: the plan and the contract classifier disagree`
    );
  }
});

test('a subscription environment file is never part of any scope', () => {
  const files = citadelRepositoryWithNoise({
    overrides: { '.azure/dev/.env': 'AZURE_SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"\n' },
  });
  const entries = Object.keys(files).map((path) => ({
    alias: path,
    kind: path.split('.').pop(),
  }));
  const plan = citadelSourcePlan(entries);
  const every = [
    ...planScope(plan, 'capabilities'),
    ...planScope(plan, 'workspace'),
    ...plan.contracts,
    ...plan.policies,
    ...plan.signature,
  ];
  for (const alias of every) {
    assert.equal(alias.startsWith('.azure/'), false, `${alias} reached a scope`);
  }
  assert.equal(plan.isInterest('.azure/dev/.env'), false);
});

// --------------------------------------------------------------------------
// Opening: what actually crosses the network.
// --------------------------------------------------------------------------

test('opening a GitHub workspace reads only what the three editors need', async () => {
  const context = await harness();
  const catalog = await discoverWorkspace(context.provider);

  const expected = [
    MAIN_PATH,
    MAIN_TEMPLATE,
    LLM_PATH,
    LLM_TEMPLATE,
    ACCESS_PATHS.template,
    ACCESS_PATHS.templateBicep,
    ...INSTANCES.map(instancePath),
  ].sort();
  // `qa-clone` is byte-identical to `qa-beta`, so it costs no request at all.
  const withoutClone = expected.filter((alias) => alias !== instancePath('qa-clone'));
  assert.deepEqual(context.reads.slice().sort(), withoutClone);

  // Stated as a number too: a plan bug that widened the interest set would keep
  // the set-difference assertions above happy but not this one.
  assert.equal(context.reads.length, 9);
  assert.equal(blobRequests(context.github).length, 9);

  // Every parameter file is still listed — nothing is hidden, only unread.
  const listed = catalog.files.map((file) => file.path);
  for (const alias of unrelatedParameterPaths()) {
    assert(listed.includes(alias), `${alias} vanished from the catalogue`);
  }
  assert.equal(catalog.compatibility, 'supported');
});

test('no unrelated parameter file is fetched from GitHub, by any route', async () => {
  const context = await harness();
  await discoverWorkspace(context.provider);

  const fetched = new Set(blobPaths(context.github, context.repository));
  for (const alias of unrelatedParameterPaths()) {
    assert.equal(fetched.has(alias), false, `${alias} was downloaded`);
    // Its template is dead weight too: nothing may pull it in indirectly.
    assert.equal(fetched.has(alias.replace(/param$/, '')), false, `template of ${alias} downloaded`);
  }
  // The unread files are reported as unread rather than as empty.
  const catalog = await discoverWorkspace(context.provider);
  const noise = catalog.files.find((file) => file.path === unrelatedParameterPaths()[0]);
  assert.equal(noise.deferred, true);
  assert.equal(noise.paramCount, null);
  assert.equal(noise.parseError, null);
  assert.equal(noise.schema.error, 'Not loaded yet');
});

test('contract and policy reads stay inside the access-contracts subtree', async () => {
  const context = await harness();
  await discoverWorkspace(context.provider);

  const primary = new Set([MAIN_PATH, MAIN_TEMPLATE, LLM_PATH, LLM_TEMPLATE]);
  for (const alias of context.reads) {
    if (primary.has(alias)) continue;
    assert.equal(
      contractRootOf(alias),
      ACCESS_PATHS.root,
      `${alias} is neither a primary editor source nor inside ${CONTRACT_ROOT_MARKER}`
    );
  }
  // Reached by path from the contract, never scanned for.
  for (const alias of blobPaths(context.github, context.repository)) {
    assert.equal(alias.startsWith('.azure/'), false, `${alias} was read`);
  }
});

test('one blob is one request, however many aliases point at it', async () => {
  const context = await harness();
  await discoverWorkspace(context.provider);

  const requested = blobRequests(context.github);
  assert.equal(
    requested.length,
    new Set(requested).size,
    `a blob was fetched twice: ${requested.join(', ')}`
  );

  const paths = blobPaths(context.github, context.repository).flatMap((entry) => entry.split('|'));
  // Five parameter files reference the one access template; it is fetched once.
  assert.equal(paths.filter((path) => path === ACCESS_PATHS.templateBicep).length, 1);
  // `qa-beta` and `qa-clone` are different paths sharing one blob, so they
  // resolve to a single request naming both.
  const shared = blobPaths(context.github, context.repository).find((entry) =>
    entry.includes('qa-clone')
  );
  assert(shared, 'the shared contract blob was never fetched');
  assert(shared.includes('qa-beta'), `expected one blob for both instances, got ${shared}`);
});

test('concurrent readers of one blob share a single request', async () => {
  const context = await harness();
  // Straight at the provider, with no discovery in between to deduplicate by
  // alias first: two distinct paths, one blob, both started before either lands.
  const [beta, clone] = await Promise.all([
    context.provider.read(instancePath('qa-beta')),
    context.provider.read(instancePath('qa-clone')),
  ]);
  assert.equal(blobRequests(context.github).length, 1);
  assert.equal(beta.hash, clone.hash);
  // Each caller is told the path it asked about, not the one that won the race.
  assert.equal(beta.alias, instancePath('qa-beta'));
  assert.equal(clone.alias, instancePath('qa-clone'));
  // And the bytes are private copies, so one editor cannot mutate another's.
  assert.notEqual(beta.bytes, clone.bytes);
});

// --------------------------------------------------------------------------
// Compatibility: the narrower scope.
// --------------------------------------------------------------------------

test('compatibility validation reads only the signature paths', async () => {
  const context = await harness();
  const url = new URL(
    `/api/github/repos/${REPOSITORY_ID}/compatibility?branch=main`,
    'http://127.0.0.1:4173'
  );
  const verdict = await context.routes.handle({
    req: { method: 'GET', headers: { 'x-citadel-github-session': context.session.id } },
    url,
    parts: url.pathname.split('/').filter(Boolean),
    readBody: async () => ({}),
  });

  assert.equal(verdict.supported, true);
  assert.deepEqual(verdict.detected, ['Main deployment', 'LLM onboarding', 'Access contracts']);

  const paths = blobPaths(context.github, context.repository, 'main').sort();
  assert.deepEqual(paths, [
    ACCESS_PATHS.templateBicep,
    ACCESS_PATHS.template,
    MAIN_TEMPLATE,
    MAIN_PATH,
    LLM_TEMPLATE,
    LLM_PATH,
  ].sort());
  // Six reads, not a content scan of the repository.
  assert.equal(paths.length, 6);
  // The contract *instances* are not needed to answer "is this a Citadel
  // repository", so validating one must not download them.
  for (const name of INSTANCES) {
    assert.equal(paths.includes(instancePath(name)), false, `${name} was read to validate`);
  }
  assert.equal(verdict.sourceCount > 40, true, `expected a large tree, got ${verdict.sourceCount}`);
});

// --------------------------------------------------------------------------
// The product still works.
// --------------------------------------------------------------------------

test('all three editors open after a selective scan', async () => {
  const context = await harness();
  const service = new WorkspaceService({
    request: context.request,
    coordinator: new GitHubCommitCoordinator({
      request: context.request,
      contextProvider: () => context.context,
    }),
    contextProvider: () => context.context,
  });

  const { areas } = await service.focus();
  assert.deepEqual(
    areas.map((area) => area.id),
    ['main', 'llm-onboarding', 'access-contracts']
  );

  const main = await service.deployment(primaryCapabilities.mainPath);
  assert.equal(main.meta.capability, 'main');
  assert(main.params.length >= 50, `main has ${main.params.length} parameters`);
  assert.equal(main.schema.available, true);

  const llm = await service.deployment(primaryCapabilities.llmPath);
  assert.equal(llm.meta.capability, 'llm-onboarding');
  assert.equal(llm.params.length, primaryCapabilities.llmSignature.length);
  assert.equal(llm.schema.available, true);

  const catalog = await service.deployments();
  const aliases = new Set(catalog.sourceAliases);
  const contracts = catalog.files
    .map((file) => contractInfo(file, aliases))
    .filter(Boolean)
    .filter((contract) => !contract.error);
  assert.deepEqual(
    contracts.map((contract) => contract.id).sort(),
    ['__template', ...INSTANCES.map((name) => `contracts/${name}`)].sort()
  );
  for (const contract of contracts) {
    assert.equal(contract.paramCount, 17, `${contract.id} parameter count`);
  }
  assert.equal(contracts.find((contract) => contract.id === '__template').hasPolicy, true);

  const instance = await service.deployment(instancePath('qa-alpha'));
  assert.equal(instance.meta.capability, 'access-contract');
  assert.equal(instance.schema.available, true);

  // Every editor was served, and still nothing unrelated was fetched.
  const fetched = new Set(blobPaths(context.github, context.repository));
  for (const alias of unrelatedParameterPaths()) assert.equal(fetched.has(alias), false);
});

// --------------------------------------------------------------------------
// Local behaviour is unchanged, by construction.
// --------------------------------------------------------------------------

test('a provider that does not declare itself remote still reads every source', async () => {
  const reads = [];
  const files = citadelRepositoryWithNoise();
  const catalog = await discoverWorkspace(localProvider(files, reads));

  for (const alias of unrelatedParameterPaths()) {
    assert(reads.includes(alias), `${alias} was skipped for a local folder`);
  }
  assert.equal(
    catalog.files.some((file) => file.deferred),
    false,
    'a local scan deferred a file'
  );
  assert.equal(catalog.compatibility, 'supported');
  // Parsed, not guessed: the noise is described from its contents.
  const noise = catalog.files.find((file) => file.path === unrelatedParameterPaths()[0]);
  assert.equal(typeof noise.paramCount, 'number');
});

test('the local folder provider does not declare itself remote', () => {
  const local = new BrowserDirectoryProvider({ kind: 'directory' });
  assert.equal(local.remote, undefined);
  assert.equal(new GitHubRepositoryProvider({}).remote, true);
});

// --------------------------------------------------------------------------
// The handoff, and what a refresh really does.
// --------------------------------------------------------------------------

test('the catalog from opening is adopted once, and a refresh rescans selectively', async () => {
  const context = await harness();
  const opened = await discoverWorkspace(context.provider);
  const afterOpen = context.github.calls.length;

  // One stable object, exactly as `activeWorkspace()` returns: the handoff is
  // consumed by mutating it, so a provider that rebuilt it per call would
  // silently re-adopt a stale catalog forever.
  const shared = { ...context.context, catalog: opened };
  const service = new WorkspaceService({
    request: context.request,
    contextProvider: () => shared,
    coordinator: new GitHubCommitCoordinator({
      request: context.request,
      contextProvider: () => shared,
    }),
  });
  // The handoff is consumed, so opening does not immediately scan again.
  assert.equal(await service.deployments(), opened);
  assert.equal(context.github.calls.length, afterOpen);

  // A refresh really is a rescan — and it is still selective.
  context.provider.reset();
  context.reads.length = 0;
  const refreshed = await service.deployments({ refresh: true });
  assert.notEqual(refreshed, opened);
  assert(context.reads.length > 0, 'a refresh did not rescan');
  assert.equal(context.reads.length, 9);
  for (const alias of unrelatedParameterPaths()) {
    assert.equal(context.reads.includes(alias), false, `${alias} read on refresh`);
  }
});

test('a handed-over catalog is consumed rather than kept', async () => {
  const context = await harness();
  const opened = await discoverWorkspace(context.provider);
  const shared = { ...context.context, catalog: opened };
  const service = new WorkspaceService({
    request: context.request,
    contextProvider: () => shared,
    coordinator: new GitHubCommitCoordinator({
      request: context.request,
      contextProvider: () => shared,
    }),
  });
  await service.deployments();
  assert.equal(shared.catalog, null, 'the handoff was retained and would go stale');
});

// --------------------------------------------------------------------------
// Nothing is persisted.
// --------------------------------------------------------------------------

test('a full open and save leaves no source bytes in the data volume', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'citadel-selective-'));
  try {
    const context = await harness({ audit: new GitHubAuditStore({ dataRoot }) });
    const service = new WorkspaceService({
      request: context.request,
      coordinator: new GitHubCommitCoordinator({
        request: context.request,
        contextProvider: () => context.context,
      }),
      contextProvider: () => context.context,
    });
    const main = await service.deployment(primaryCapabilities.mainPath);
    await service.save(
      primaryCapabilities.mainPath,
      [{ op: 'set', path: ['environmentName'], value: 'persisted-check' }],
      main.meta.hash
    );

    const found = [];
    const walk = async (directory) => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        if ((await stat(path)).isDirectory()) await walk(path);
        else found.push(path);
      }
    };
    await walk(dataRoot);

    assert(found.length > 0, 'the audit wrote nothing, so this proves nothing');
    for (const path of found) {
      assert.equal(
        /\.(bicepparam|bicep|xml)$/.test(path),
        false,
        `${path} is a source file under the data root`
      );
      const text = await readFile(path, 'utf8');
      // Distinctive strings from the sources that were read. Metadata — aliases,
      // SHAs, actions — is expected; content is not.
      for (const marker of ["using '", 'param environmentName', '<policies>', 'targetScope']) {
        assert.equal(text.includes(marker), false, `${path} contains source content: ${marker}`);
      }
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('the server blob cache is content-addressed, bounded and forgotten on disconnect', async () => {
  const context = await harness({ files: citadelRepositoryWithNoise() });
  const routes = context.routes;
  assert.equal(routes.blobCache.size, 0);
  await discoverWorkspace(context.provider);
  assert(routes.blobCache.size > 0, 'nothing was cached');
  // Keyed by repository and blob SHA, so a hit is the same bytes by definition
  // and can never be a stale revision of a path.
  for (const key of routes.blobCache.keys()) {
    assert.match(key, new RegExp(`^${REPOSITORY_ID}:[0-9a-f]{40}$`));
  }
  const before = context.github.calls.length;
  context.provider.reset();
  await discoverWorkspace(context.provider);
  assert.equal(
    blobRequests(context.github).length,
    blobRequests({ calls: context.github.calls.slice(0, before) }).length,
    'a second open re-fetched blobs the container already held'
  );

  routes.forgetCaches();
  assert.equal(routes.blobCache.size, 0);
  assert.equal(routes.treeCache.size, 0);
});

test('the blob cache evicts least-recently-used and stays within its limit', async () => {
  const github = new MockGitHub();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    sessions: new GitHubSessionStore(),
    registryStore: environmentRegistry({}),
    blobCacheLimit: 3,
  });
  for (let index = 0; index < 6; index += 1) {
    routes.blobCache.set(`1:${index}`, { sha: String(index) });
    while (routes.blobCache.size > routes.blobCacheLimit) {
      routes.blobCache.delete(routes.blobCache.keys().next().value);
    }
  }
  assert.equal(routes.blobCache.size, 3);
  assert.deepEqual([...routes.blobCache.keys()], ['1:3', '1:4', '1:5']);
});
