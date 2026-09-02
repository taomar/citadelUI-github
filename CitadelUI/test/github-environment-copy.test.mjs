import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { GitHubRepositoryProvider } from '../web/js/github-provider.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { SourceMutationCoordinator } from '../web/js/source-factory.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';
import { primaryCapabilities } from '../shared/citadel-core.mjs';
import { sha256 } from '../shared/source-scope.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN, environmentRegistry } from './_github-mock.mjs';

const MAIN = 'bicep/infra/main.bicepparam';
const TEMPLATE = 'bicep/infra/main.bicep';

function paramText(values) {
  const remaining = citadelRepositoryFiles()[MAIN]
    .split('\n')
    .filter((line) =>
      line.startsWith('param ') &&
      !/^param (environmentName|location|apimSkuUnits)\b/.test(line)
    );
  return [
    `using 'main.bicep'`,
    '',
    '// Environment identity. Comments must survive a copy.',
    `param environmentName = '${values.environmentName}'`,
    `param location = '${values.location}'`,
    `param apimSkuUnits = ${values.apimSkuUnits}`,
    ...remaining,
    '',
  ].join('\n');
}

const TEMPLATE_TEXT = citadelRepositoryFiles()[TEMPLATE];

/**
 * A local folder provider backed by an in-memory file map.
 *
 * Implements the same `RepositoryProvider` surface the browser folder provider
 * exposes, so a copy can be driven between a local and a GitHub environment
 * without a real File System Access handle.
 */
class MemoryLocalProvider {
  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.writes = [];
  }

  async permission() {
    return 'granted';
  }

  async assertWritable() {}

  async entries() {
    return [...this.files.keys()]
      .map((alias) => ({ alias, kind: alias.split('.').at(-1) }))
      .sort((left, right) => left.alias.localeCompare(right.alias));
  }

  async missingDirectories() {
    return [];
  }

  async read(alias) {
    if (!this.files.has(alias)) {
      throw Object.assign(new Error(`Source not found: ${alias}`), { name: 'NotFoundError' });
    }
    const bytes = new TextEncoder().encode(this.files.get(alias));
    return {
      alias,
      bytes,
      text: this.files.get(alias),
      size: bytes.byteLength,
      lastModified: 1,
      hash: await sha256(bytes),
      version: await sha256(bytes),
      workspaceHead: null,
    };
  }

  async write(alias, bytes) {
    this.files.set(alias, new TextDecoder().decode(bytes));
    this.writes.push(alias);
    return this.read(alias);
  }

  async remove(alias) {
    this.files.delete(alias);
  }
}

/**
 * Two GitHub environments in different repositories plus one local environment,
 * all inside one project, wired through the real routes and coordinators.
 */
async function project(options = {}) {
  const github = new MockGitHub();
  const alpha = github.addRepository({ id: 701, fullName: 'octo/alpha', defaultBranch: 'main' });
  const beta = github.addRepository({ id: 702, fullName: 'octo/beta', defaultBranch: 'release' });
  github.seed(alpha, 'main', citadelRepositoryFiles({
    [MAIN]: paramText({ environmentName: 'alpha', location: 'westeurope', apimSkuUnits: 1 }),
    [TEMPLATE]: TEMPLATE_TEXT,
  }));
  github.seed(beta, 'release', citadelRepositoryFiles({
    [MAIN]: paramText({ environmentName: 'beta', location: 'northeurope', apimSkuUnits: 4 }),
    [TEMPLATE]: TEMPLATE_TEXT,
  }));

  const environments = {
    'env-alpha': {
      id: 'env-alpha',
      projectId: 'project-one',
      label: 'Alpha',
      source: {
        kind: 'github',
        repositoryId: 701,
        fullName: 'octo/alpha',
        sourceBranch: 'main',
        workingBranch: 'citadel-ui/env-alpha',
        writeMode: 'working-branch',
      },
    },
    'env-beta': {
      id: 'env-beta',
      projectId: 'project-one',
      label: 'Beta',
      source: {
        kind: 'github',
        repositoryId: 702,
        fullName: 'octo/beta',
        sourceBranch: 'release',
        workingBranch: 'citadel-ui/env-beta',
        writeMode: 'working-branch',
      },
    },
    'env-local': {
      id: 'env-local',
      projectId: 'project-one',
      label: 'Local',
      source: { kind: 'local', folderName: 'citadel', localPath: 'C:\\citadel' },
    },
  };

  const sessions = new GitHubSessionStore();
  const audit = new MemoryAudit();
  const routes = new GitHubRoutes({
    client: new GitHubApiClient({ fetch: github.fetch }),
    audit,
    sessions,
    registryStore: environmentRegistry(environments),
  });
  const session = await routes.connect({ token: TEST_TOKEN });
  for (const id of ['env-alpha', 'env-beta']) {
    await routes.attach(
      { method: 'POST', headers: { 'x-citadel-github-session': session.id } },
      {
        repositoryId: environments[id].source.repositoryId,
        sourceBranch: environments[id].source.sourceBranch,
        environmentId: id,
        writeMode: 'working-branch',
      }
    );
  }

  const request = async (path, init = {}) => {
    const url = new URL(path, 'http://127.0.0.1:4173');
    return routes.handle({
      req: { method: init.method || 'GET', headers: { 'x-citadel-github-session': session.id } },
      url,
      parts: url.pathname.split('/').filter(Boolean),
      readBody: async () => JSON.parse(init.body || '{}'),
    });
  };

  const local = new MemoryLocalProvider({
    ...citadelRepositoryFiles({
      [MAIN]: paramText({ environmentName: 'local', location: 'uksouth', apimSkuUnits: 2 }),
      [TEMPLATE]: TEMPLATE_TEXT,
    }),
  });
  const providers = {
    'env-alpha': new GitHubRepositoryProvider({ request, environmentId: 'env-alpha' }),
    'env-beta': new GitHubRepositoryProvider({ request, environmentId: 'env-beta' }),
    'env-local': local,
  };

  const registry = {
    async listEnvironments() {
      return Object.values(environments);
    },
    async getHandle() {
      return null;
    },
  };

  const localCommits = [];
  const service = new WorkspaceService({
    request,
    registry,
    createProvider: async (environment) => providers[environment.id],
    coordinator: new SourceMutationCoordinator({
      contextProvider: () => active,
      github: new GitHubCommitCoordinator({ request, contextProvider: () => active }),
      local: {
        async commit(files, commitOptions) {
          const provider = commitOptions.context.provider;
          for (const file of files) await provider.write(file.alias, file.after);
          localCommits.push({
            action: commitOptions.action,
            environmentId: commitOptions.context.environment.id,
            aliases: files.map((file) => file.alias),
          });
          return { transactionId: 'local-1', files: files.map((f) => ({ alias: f.alias })) };
        },
      },
    }),
    contextProvider: () => active,
  });

  let active = {
    projectId: 'project-one',
    environment: environments[options.active || 'env-alpha'],
    provider: providers[options.active || 'env-alpha'],
  };
  const use = (id) => {
    active = { projectId: 'project-one', environment: environments[id], provider: providers[id] };
    service.reset();
    return active;
  };

  return { github, alpha, beta, environments, providers, service, use, localCommits, local };
}

test('compare works between two GitHub environments in different repositories', async () => {
  const context = await project();
  const comparison = await context.service.compareEnvironment('env-beta', MAIN);
  assert.equal(comparison.targetAlias, MAIN);
  assert.equal(comparison.target.environment.id, 'env-beta');
  const byName = new Map(comparison.parameters.map((item) => [item.name, item]));
  assert.equal(byName.get('environmentName').status, 'different');
  assert.equal(byName.get('location').source, 'westeurope');
  assert.equal(byName.get('location').target, 'northeurope');
  assert.equal(byName.get('apimSkuUnits').status, 'different');
});

test('copy between two GitHub repositories commits only to the target working branch', async () => {
  const context = await project();
  const source = await context.providers['env-alpha'].read(MAIN);
  const target = await context.providers['env-beta'].read(MAIN);
  const alphaHeadBefore = context.alpha.refs.get('citadel-ui/env-alpha');
  const betaHeadBefore = context.beta.refs.get('citadel-ui/env-beta');

  const preview = await context.service.previewCopy(
    'env-beta',
    MAIN,
    ['location', 'apimSkuUnits'],
    source.hash
  );
  assert.equal(preview.changed, true);
  assert.equal(preview.targetLabel, 'Beta');

  const result = await context.service.copyParameters(
    'env-beta',
    MAIN,
    ['location', 'apimSkuUnits'],
    source.hash,
    target.hash
  );
  assert.equal(result.branch, 'citadel-ui/env-beta');

  const after = context.github.fileText(context.beta, 'citadel-ui/env-beta', MAIN);
  assert.match(after, /location = 'westeurope'/);
  assert.match(after, /apimSkuUnits = 1/);
  // The target's own identity is not overwritten by a partial copy.
  assert.match(after, /environmentName = 'beta'/);
  // Comments survive byte-for-byte.
  assert.match(after, /\/\/ Environment identity\. Comments must survive a copy\./);

  // Exactly one commit, on the target only. The source repository is untouched.
  assert.equal(context.beta.refs.get('citadel-ui/env-beta'), result.commit);
  assert.equal(context.github.commits.get(result.commit).parents[0], betaHeadBefore);
  assert.equal(context.alpha.refs.get('citadel-ui/env-alpha'), alphaHeadBefore);
  assert.equal(context.github.commits.get(result.commit).message.includes('environment-copy'), true);
});

test('copy from a GitHub environment into a local environment writes only locally', async () => {
  const context = await project();
  const source = await context.providers['env-alpha'].read(MAIN);
  const target = await context.providers['env-local'].read(MAIN);
  const alphaHeadBefore = context.alpha.refs.get('citadel-ui/env-alpha');

  await context.service.copyParameters(
    'env-local',
    MAIN,
    ['location'],
    source.hash,
    target.hash
  );

  // Dispatch follows the target, so the local coordinator ran.
  assert.deepEqual(context.localCommits, [
    { action: 'environment-copy', environmentId: 'env-local', aliases: [MAIN] },
  ]);
  assert.match(context.local.files.get(MAIN), /location = 'westeurope'/);
  assert.match(context.local.files.get(MAIN), /environmentName = 'local'/);
  assert.equal(context.alpha.refs.get('citadel-ui/env-alpha'), alphaHeadBefore);
});

test('copy from a local environment into a GitHub environment commits once', async () => {
  const context = await project({ active: 'env-local' });
  const source = await context.providers['env-local'].read(MAIN);
  const target = await context.providers['env-alpha'].read(MAIN);
  const headBefore = context.alpha.refs.get('citadel-ui/env-alpha');

  const result = await context.service.copyParameters(
    'env-alpha',
    MAIN,
    ['location', 'apimSkuUnits'],
    source.hash,
    target.hash
  );

  assert.equal(context.localCommits.length, 0);
  assert.equal(context.alpha.refs.get('citadel-ui/env-alpha'), result.commit);
  assert.equal(context.github.commits.get(result.commit).parents[0], headBefore);
  const after = context.github.fileText(context.alpha, 'citadel-ui/env-alpha', MAIN);
  assert.match(after, /location = 'uksouth'/);
  assert.match(after, /apimSkuUnits = 2/);
  assert.match(after, /environmentName = 'alpha'/);
});

test('a copy target changed after preview is rejected without committing', async () => {
  const context = await project();
  const source = await context.providers['env-alpha'].read(MAIN);
  const target = await context.providers['env-beta'].read(MAIN);

  // Someone else pushes to the target working branch after the review.
  context.github.seed(context.beta, 'citadel-ui/env-beta', citadelRepositoryFiles({
    [MAIN]: paramText({ environmentName: 'beta', location: 'eastus', apimSkuUnits: 9 }),
    [TEMPLATE]: TEMPLATE_TEXT,
  }));
  const moved = context.beta.refs.get('citadel-ui/env-beta');
  context.providers['env-beta'].reset();

  await assert.rejects(
    context.service.copyParameters('env-beta', MAIN, ['location'], source.hash, target.hash),
    /Reload before saving/
  );
  assert.equal(context.beta.refs.get('citadel-ui/env-beta'), moved);
});

test('secure and unknown parameters are never copied across sources', async () => {
  const context = await project();
  const source = await context.providers['env-alpha'].read(MAIN);
  const target = await context.providers['env-beta'].read(MAIN);
  for (const names of [['entraClientSecret'], ['notAParameter']]) {
    await assert.rejects(
      context.service.copyParameters('env-beta', MAIN, names, source.hash, target.hash),
      /Secure or untyped parameters cannot be copied/
    );
  }
  assert.equal(context.localCommits.length, 0);
});

test('copy refuses an environment outside the active project', async () => {
  const context = await project();
  const source = await context.providers['env-alpha'].read(MAIN);
  await assert.rejects(
    context.service.compareEnvironment('env-missing', MAIN),
    /Unknown target environment/
  );
  assert.ok(source.hash);
});

test('every planned operation stays available after attaching a GitHub repository', async () => {
  const context = await project();
  const service = context.service;

  // Discovery and document reads.
  const catalog = await service.deployments();
  assert(catalog.sourceAliases.includes(TEMPLATE));
  assert(catalog.sourceAliases.includes(MAIN));
  const document = await service.deployment(MAIN);
  assert.equal(document.schema.available, true);
  assert(document.params.length >= primaryCapabilities.mainMinimumParameters);

  // Preview and save.
  const preview = await service.preview(
    MAIN,
    [{ op: 'set', path: ['location'], value: 'swedencentral' }],
    document.hash
  );
  assert.equal(preview.changed, true);
  const saved = await service.save(
    MAIN,
    [{ op: 'set', path: ['location'], value: 'swedencentral' }],
    document.hash
  );
  assert.equal(saved.changed, true);
  assert.match(
    context.github.fileText(context.alpha, 'citadel-ui/env-alpha', MAIN),
    /location = 'swedencentral'/
  );

  // Focus areas, contracts listing, and access targets all resolve.
  assert.ok(Array.isArray((await service.focus()).areas));
  assert.ok(Array.isArray((await service.contracts()).contracts));
  assert.ok(await service.accessContractTargets());

  // History, inspection, and undo.
  const history = await service.history();
  assert.equal(history.transactions[0].action, 'parameter-edit');
  const inspected = await service.inspectRecovery(history.transactions[0].commit);
  assert.equal(inspected.canComplete, true);
  const undone = await service.restoreTransaction(history.transactions[0].commit);
  assert.match(
    context.github.fileText(context.alpha, 'citadel-ui/env-alpha', MAIN),
    /location = 'westeurope'/
  );
  assert.equal(context.alpha.refs.get('citadel-ui/env-alpha'), undone.commit);

  // Compare and copy across environments.
  const refreshed = await context.providers['env-alpha'].read(MAIN);
  const target = await context.providers['env-beta'].read(MAIN);
  assert.ok(await service.previewCopy('env-beta', MAIN, ['location'], refreshed.hash));
  assert.ok(
    await service.copyParameters('env-beta', MAIN, ['location'], refreshed.hash, target.hash)
  );

  // Subscription bridge.
  const subscription = await context.providers['env-alpha'].readSubscriptionId('dev');
  assert.equal(subscription.available, false);
  const created = await service.saveSubscriptionId(
    'dev',
    '11111111-2222-3333-4444-555555555555',
    null
  );
  assert.equal(created.changed, true);
});
