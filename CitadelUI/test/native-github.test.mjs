import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubApiClient } from '../server/github/api.mjs';
import { GitHubRoutes } from '../server/github/routes.mjs';
import { GitHubSessionStore } from '../server/github/sessions.mjs';
import { GitHubRepositoryProvider } from '../web/js/github-provider.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';
import { MemoryAudit, MockGitHub, TEST_TOKEN } from './_github-mock.mjs';
import { nativeConfiguration, NATIVE_FILES } from './_native-fixture.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { exactNumber } from '../shared/terraform/parser.mjs';
import { notifyGitHubHead } from '../web/js/github-head-state.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';

async function fixture(files = { ...citadelRepositoryFiles(), ...NATIVE_FILES }) {
  const github = new MockGitHub();
  const repository = github.addRepository({ id: 9601, fullName: 'synthetic/native-gateway' });
  github.seed(repository, 'main', { ...files,
    'terraform.tfstate': '{"synthetic":"excluded"}', '.terraform/cache.tfvars': 'name = "excluded"' });
  const sessions = new GitHubSessionStore(), records = new Map(), audit = new MemoryAudit();
  const registryStore = { getEnvironment: async (id) => records.get(id) || null,
    read: async () => ({ environments: [...records.values()] }) };
  const routes = new GitHubRoutes({ client: new GitHubApiClient({ fetch: github.fetch }), sessions, registryStore, audit });
  const session = await routes.connect({ token: TEST_TOKEN });
  const headers = { 'x-citadel-github-session': session.id };
  const request = async (input, init = {}) => {
    const url = new URL(input, 'http://native-github.invalid');
    return routes.handle({ req: { method: init.method || 'GET', headers }, url,
      parts: url.pathname.split('/').filter(Boolean), readBody: async () => JSON.parse(init.body || '{}') });
  };
  const attach = async (configuration, id, branch = 'main') => {
    const result = await routes.attach({ method: 'POST', headers }, {
      repositoryId: repository.id, sourceBranch: branch, workingBranch: branch,
      environmentId: id, writeMode: 'direct', expectedHead: repository.refs.get(branch),
      ...(configuration ? { configuration } : {}),
    });
    const environment = { id, projectId: 'synthetic-project', label: id,
      ...(configuration ? { configuration } : {}),
      source: { kind: 'github', repositoryId: repository.id, fullName: repository.full_name,
        sourceBranch: branch, workingBranch: branch, writeMode: 'direct', connectionProfileId: result.connectionProfileId || null } };
    records.set(id, environment);
    const provider = new GitHubRepositoryProvider({ request, environmentId: id, configuration, source: environment.source });
    const context = { projectId: environment.projectId, environment, provider };
    const coordinator = new GitHubCommitCoordinator({ request, contextProvider: () => context });
    return { result, context, provider, coordinator, service: new WorkspaceService({ request, coordinator, contextProvider: () => context }) };
  };
  return { github, repository, sessions, records, routes, headers, audit, request, attach };
}

for (const area of ['llm', 'access']) test(`GitHub ${area} native unit attaches and saves without any Bicep or Deployment source`, async () => {
  const configuration = nativeConfiguration([area]), unit = configuration.units[0];
  const f = await fixture(Object.fromEntries(Object.entries(NATIVE_FILES).filter(([alias]) => alias.startsWith(`${unit.rootAlias}/`))));
  const native = await f.attach(configuration, 'standalone');
  assert.equal((await native.service.focus()).areas.length, 1);
  const document = await native.service.deployment(unit.valueAlias);
  const path = area === 'llm' ? ['llm_backend_config', 0, 'backend_id'] : ['services', 0, 'code'];
  await native.service.save(document.path, [{ op: 'set', path, value: 'standalone-native' }], document.hash, document.nativeIdentity);
  assert.match((await native.provider.read(document.path)).text, /standalone-native/);
  await assert.rejects(native.provider.read('variables.tf'), { code: 'NATIVE_SOURCE_SCOPE' });
});

for (const order of ['native-first', 'bicep-first']) test(`${order}: one mocked GitHub credential independently opens both formats and saves native atomically`, async () => {
  const f = await fixture();
  const configuration = nativeConfiguration();
  let native, bicep;
  if (order === 'native-first') { native = await f.attach(configuration, 'native'); bicep = await f.attach(undefined, 'bicep'); }
  else { bicep = await f.attach(undefined, 'bicep'); native = await f.attach(configuration, 'native'); }
  assert.equal((await native.service.focus()).areas.length, 3);
  assert.equal((await bicep.service.focus()).areas.length, 3);
  const alias = configuration.units[1].valueAlias;
  const document = await native.service.deployment(alias);
  const head = f.repository.refs.get('main');
  const before = new Map(f.github.flatten(f.github.commits.get(head).tree).filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
  const result = await native.service.save(alias, [{ op: 'set', path: ['llm_backend_config', 0, 'priority'], value: exactNumber('2.5') }], document.hash, document.nativeIdentity);
  assert.ok(result.hash);
  const savedHead = f.repository.refs.get('main');
  assert.notEqual(savedHead, head);
  assert.deepEqual(f.github.commits.get(savedHead).parents, [head]);
  for (const entry of f.github.flatten(f.github.commits.get(savedHead).tree).filter((entry) => entry.type === 'blob' && entry.path !== alias)) assert.equal(entry.sha, before.get(entry.path));
  assert.match((await native.provider.read(alias)).text, /priority = 2\.5/);
  assert.equal((await native.coordinator.history()).transactions.length, 1);
  assert.equal((await bicep.coordinator.history()).transactions.length, 0);
  await native.coordinator.revert(savedHead);
  assert.equal((await native.provider.read(alias)).text, document.text);
});

test('native GitHub scope rejects unselected/cache aliases, state and whole-file sensitive sources', async () => {
  const f = await fixture(), native = await f.attach(nativeConfiguration(['llm']), 'native');
  const alias = 'llm-backend-onboarding/operator.tfvars';
  const document = await native.service.deployment(alias);
  const entry = await native.provider.entry(alias);
  for (const forbidden of ['environments/development.tfvars', 'terraform.tfstate', '.terraform/cache.tfvars', 'llm-backend-onboarding/../operator.tfvars']) {
    await assert.rejects(f.request(`${native.provider.base()}/blob?alias=${encodeURIComponent(forbidden)}&sha=${entry.sha}`), /scope|outside|unsafe|State|excluded/i);
  }
  const head = f.repository.refs.get('main');
  f.github.seed(f.repository, 'main', { ...citadelRepositoryFiles(), ...NATIVE_FILES,
    [alias]: document.text.replace('secret_value = null', 'secret_value = "synthetic-sensitive-marker"') }, { parents: [head] });
  native.provider.reset();
  await assert.rejects(native.provider.read(alias), { code: 'NATIVE_SENSITIVE_FILE' });
  assert.equal(f.audit.commits.length, 0);
});

test('disjoint native units share a branch, preserve drafts and reject old head approvals; overlapping ownership is refused', async () => {
  const f = await fixture();
  const first = await f.attach(nativeConfiguration(['deployment']), 'first');
  const second = await f.attach(nativeConfiguration(['llm']), 'second');
  const one = await first.service.deployment('environments/development.tfvars');
  const two = await second.service.deployment('llm-backend-onboarding/operator.tfvars');
  const operations = [{ op: 'set', path: ['apim_name'], value: 'retained-draft' }], retained = structuredClone(operations);
  await second.service.preview(two.path, operations, two.hash, two.nativeIdentity);
  await first.service.save(one.path, [{ op: 'set', path: ['environment_name'], value: 'saved-first' }], one.hash, one.nativeIdentity);
  await assert.rejects(second.service.save(two.path, operations, two.hash, two.nativeIdentity), { code: 'NATIVE_REVIEW_STALE' });
  assert.deepEqual(operations, retained);
  assert.equal((await second.provider.read(two.path)).text, two.text);
  await assert.rejects(f.attach(nativeConfiguration(['llm']), 'overlap'), /already|overlap|owner/i);
});

test('native GitHub schema changes reject before new blobs or audit records', async () => {
  const f = await fixture();
  const native = await f.attach(nativeConfiguration(['deployment']), 'native');
  const document = await native.service.deployment('environments/development.tfvars');
  const head = f.repository.refs.get('main');
  f.github.seed(f.repository, 'main', { ...citadelRepositoryFiles(), ...NATIVE_FILES, 'variables.tf': NATIVE_FILES['variables.tf'] + '\n' }, { parents: [head] });
  const count = f.github.blobs.size;
  await assert.rejects(native.service.save(document.path, [{ op: 'set', path: ['environment_name'], value: 'blocked' }], document.hash, document.nativeIdentity), { code: 'NATIVE_REVIEW_STALE' });
  assert.equal(f.github.blobs.size, count);
  assert.equal(f.audit.commits.length, 0);
});

test('native GitHub explicitly creates an absent HCL input, rejects a competing creation and undoes only its own bytes', async () => {
  const f = await fixture(), alias = 'environments/new.tfvars';
  const native = await f.attach(nativeConfiguration([{ area: 'deployment', valueAlias: alias, allowCreate: true }]), 'native');
  const document = await native.service.deployment(alias);
  const originalHead = f.repository.refs.get('main');
  await native.service.save(alias, [{ op: 'set', path: ['environment_name'], value: 'created-native' }], null, document.nativeIdentity);
  const createdCommit = f.repository.refs.get('main');
  assert.equal((await native.coordinator.history()).transactions[0].nativeCreation, true);
  assert.equal((await native.provider.read(alias)).text, 'environment_name = "created-native"\n');
  await native.coordinator.revert(createdCommit);
  await assert.rejects(native.provider.read(alias), { name: 'NotFoundError' });
  const absent = await native.service.deployment(alias);
  f.github.seed(f.repository, 'main', { ...citadelRepositoryFiles(), ...NATIVE_FILES, [alias]: 'environment_name = "foreign"\n' },
    { parents: [f.repository.refs.get('main')] });
  const count = f.audit.commits.length;
  await assert.rejects(native.service.save(alias, [{ op: 'set', path: ['environment_name'], value: 'blocked' }], null, absent.nativeIdentity), { code: 'NATIVE_REVIEW_STALE' });
  assert.equal(f.audit.commits.length, count);
  assert.notEqual(f.repository.refs.get('main'), originalHead);
});

test('native GitHub undo rejects changed schema dependencies and retargeted history authority', async () => {
  const f = await fixture(), configuration = nativeConfiguration(['deployment']);
  const native = await f.attach(configuration, 'native');
  const document = await native.service.deployment(configuration.units[0].valueAlias);
  await native.service.save(document.path, [{ op: 'set', path: ['environment_name'], value: 'changed' }], document.hash, document.nativeIdentity);
  const savedCommit = f.repository.refs.get('main');
  const savedText = (await native.provider.read(document.path)).text;
  f.github.seed(f.repository, 'main', { ...citadelRepositoryFiles(), ...NATIVE_FILES,
    [document.path]: savedText, 'variables.tf': NATIVE_FILES['variables.tf'] + '\n' },
    { parents: [f.repository.refs.get('main')] });
  await assert.rejects(native.coordinator.revert(savedCommit), { code: 'NATIVE_HISTORY_STALE' });
  f.records.set('native', { ...f.records.get('native'), configuration: nativeConfiguration(['deployment']) });
  assert.equal((await native.coordinator.history()).transactions.length, 0);
  await assert.rejects(native.coordinator.revert(savedCommit), { code: 'NATIVE_HISTORY_SCOPE' });
});

test('native GitHub cached equal blobs cannot bypass another unit schema or expose sensitive dependencies', async () => {
  const f = await fixture();
  const schema = NATIVE_FILES['llm-backend-onboarding/variables.tf'] +
    '\nvariable "environment_name" {\n type = string\n sensitive = true\n default = null\n}\n';
  f.github.seed(f.repository, 'main', { ...citadelRepositoryFiles(), ...NATIVE_FILES, 'llm-backend-onboarding/variables.tf': schema });
  const native = await f.attach(nativeConfiguration(['deployment', 'llm']), 'native');
  f.github.seed(f.repository, 'main', { ...citadelRepositoryFiles(), ...NATIVE_FILES,
    'llm-backend-onboarding/variables.tf': schema,
    'llm-backend-onboarding/operator.tfvars': NATIVE_FILES['environments/development.tfvars'] },
    { parents: [f.repository.refs.get('main')] });
  native.provider.reset();
  await native.provider.read('environments/development.tfvars');
  await assert.rejects(native.provider.read('llm-backend-onboarding/operator.tfvars'), { code: 'NATIVE_SENSITIVE_FILE' });
  f.github.seed(f.repository, 'main', { ...citadelRepositoryFiles(), ...NATIVE_FILES,
    'main.tf': NATIVE_FILES['main.tf'] + '\nlocals { password = "synthetic-sensitive" }\n' },
    { parents: [f.repository.refs.get('main')] });
  native.provider.reset();
  await assert.rejects(native.provider.read('main.tf'), { code: 'NATIVE_SENSITIVE_FILE' });
});

test('native refused commits stay off refs until an explicit scoped named-branch recovery', async () => {
  const f = await fixture(), configuration = nativeConfiguration(['deployment']);
  const native = await f.attach(configuration, 'native'), document = await native.service.deployment(configuration.units[0].valueAlias);
  const head = f.repository.refs.get('main');
  f.github.protectedBranches.add('main');
  const result = await native.service.save(document.path, [{ op: 'set', path: ['environment_name'], value: 'protected-draft' }], document.hash, document.nativeIdentity);
  assert.ok(result.unresolved);
  assert.equal(f.repository.refs.get('main'), head);
  assert.equal(f.repository.refs.size, 1);
  await native.service.createCommitBranch(result.unresolved.commit, 'review-native');
  assert.equal(f.repository.refs.get('review-native'), result.unresolved.commit);
  assert.equal(f.repository.refs.get('main'), head);
  assert.equal(f.records.get('native').source.workingBranch, 'main');
  f.records.set('native', { ...f.records.get('native'), configuration: nativeConfiguration(['deployment']) });
  await assert.rejects(native.coordinator.createCommitBranch(result.unresolved.commit, 'wrong-binding'), { code: 'NATIVE_HISTORY_SCOPE' });
  assert.equal(f.repository.refs.has('wrong-binding'), false);
});

test('Bicep policy saves retain the refused GitHub outcome for the independent policy draft', async () => {
  const f = await fixture(), bicep = await f.attach(createConfiguration('bicep'), 'bicep');
  const alias = 'bicep/infra/citadel-access-contracts/policies/default-ai-product-policy.xml';
  const source = await bicep.provider.read(alias), head = f.repository.refs.get('main');
  f.github.protectedBranches.add('main');
  const result = await bicep.service.savePolicy({
    path: alias, expectedHash: source.hash, text: '<policies><inbound><base /></inbound></policies>',
  });
  assert.ok(result.unresolved?.commit);
  assert.deepEqual(result.warnings, []);
  assert.equal(f.repository.refs.get('main'), head);
  await bicep.service.createCommitBranch(result.unresolved.commit, 'review-policy');
  assert.equal(f.repository.refs.get('review-policy'), result.unresolved.commit);
  assert.equal(f.records.get('bicep').source.workingBranch, 'main');
  assert.equal((await bicep.provider.read(alias)).text, source.text);
});

test('in-flight native reads cannot repopulate caches after refresh or a different workspace saves the shared branch', async () => {
  const f = await fixture();
  const native = await f.attach(nativeConfiguration(['deployment']), 'native');
  await native.provider.tree();
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const request = native.provider.request;
  native.provider.request = async (path) => {
    const result = await request(path);
    if (path.includes('/blob?') && path.includes('development.tfvars')) { started(); await gate; }
    return result;
  };
  const reading = native.provider.read('environments/development.tfvars');
  await ready;
  notifyGitHubHead({ id: 'other-workspace', source: native.context.environment.source }, 'synthetic-new-head');
  release();
  await assert.rejects(reading, { code: 'GITHUB_READ_SUPERSEDED' });
  assert.equal(native.provider.blobs.size, 0);
});
