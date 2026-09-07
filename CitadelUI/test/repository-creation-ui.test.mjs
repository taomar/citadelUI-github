import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom, readText } from './_dom-stub.mjs';
import { TEST_TOKEN } from './_github-mock.mjs';
import { RepositorySelection } from '../web/js/github-selection.mjs';

installDom();
const { runAddWorkspace } = await import('../web/js/workspace-catalog.mjs');
const { closeDialog } = await import('../web/js/dialog.mjs');
const SOURCE = 'https://github.com/mohamedsaif/ai-hub-gateway-solution-accelerator/blob/citadel-v1/';
const profile = { id: 'profile-1', accountId: 4242, accountLogin: 'octo-dev', name: 'Personal', status: 'session' };
const account = { accountId: 4242, login: 'octo-dev', profileId: profile.id, profile };
const repository = { id: 9003, fullName: 'octo-dev/new-citadel', visibility: 'private', canPush: true };

function operation(overrides = {}) {
  return {
    id: 'creation-one',
    state: 'ready',
    stage: 'Source checked',
    sourceUrl: SOURCE,
    source: {
      fullName: 'mohamedsaif/ai-hub-gateway-solution-accelerator',
      ref: 'citadel-v1', commit: 'a'.repeat(40), tree: 'b'.repeat(40),
      fileCount: 363, totalBytes: 20_303_635, hasWorkflows: false,
    },
    destination: { name: 'new-citadel', fullName: repository.fullName, repositoryId: null, private: true, branch: 'main' },
    created: false,
    canStart: true,
    canResume: false,
    canPause: false,
    progress: { completed: 363, total: 363, unit: 'files' },
    error: null,
    ...overrides,
  };
}

function complete() {
  return operation({
    state: 'complete', stage: 'Repository ready', created: true, canStart: false,
    destination: { name: 'new-citadel', fullName: repository.fullName, repositoryId: repository.id, private: true, branch: 'main' },
  });
}

function nodes(node = document.getElementById('modal')) {
  return [node, ...node.children.flatMap((child) => nodes(child))];
}

function control(id) {
  const found = nodes().filter((node) => node.getAttribute('id') === id);
  assert.equal(found.length, 1, `${id} must appear once`);
  return found[0];
}

function button(label) {
  const found = nodes().find((node) => node.tagName === 'BUTTON' && readText(node).startsWith(label));
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

async function click(label) {
  const found = button(label);
  assert.equal(found.disabled, false, `${label} is disabled`);
  assert.equal(found.hidden, false, `${label} is hidden`);
  for (const handler of found.listeners.get('click') || []) await handler({ target: found });
}

function input(id, value) {
  const node = control(id);
  assert.equal(node.disabled, false);
  node.value = value;
  node.dispatch('input');
}

const drain = () => new Promise((resolve) => setImmediate(resolve));

function harness(t, overrides = {}, connections = [profile]) {
  const calls = [];
  let current = operation();
  const selection = new RepositorySelection({
    listRepositories: async () => { calls.push(['listRepositories']); return { repositories: [] }; },
    listBranches: async (id) => {
      calls.push(['listBranches', id]);
      return { branches: [{ name: 'main', commit: 'c'.repeat(40) }] };
    },
    checkCompatibility: async () => ({ supported: true, head: 'c'.repeat(40) }),
  });
  const actions = {
    projects: [],
    createSelection: () => selection,
    useConnection: async () => account,
    createConnection: async () => account,
    reconnectConnection: async () => account,
    listRepositoryCreations: async () => ({ operations: [] }),
    prepareRepository: async (body) => { calls.push(['prepare', body]); return current; },
    repositoryCreationStatus: async (id) => { calls.push(['status', id]); return current; },
    startRepositoryCreation: async (id) => { calls.push(['start', id]); current = complete(); return current; },
    resumeRepositoryCreation: async (id) => { calls.push(['resume', id]); current = complete(); return current; },
    pauseRepositoryCreation: async (id) => {
      calls.push(['pause', id]);
      current = { ...current, state: 'paused', canStart: false, canResume: true, canPause: false };
      return current;
    },
    getRepository: async (id) => { calls.push(['getRepository', id]); return repository; },
    ...overrides,
  };
  const panel = runAddWorkspace({
    actions, connections, vault: { available: false }, rows: [], onDone: () => {},
  });
  t.after(() => { panel.dispose(); closeDialog(); });
  return { calls, selection };
}

async function openCreation() {
  await click('New GitHub Repo');
  await click('Continue');
  await drain();
  assert.match(readText(document.getElementById('modal')), /Create a private GitHub repository/);
}

test('repository creation UI: three choices preserve existing and local paths', async (t) => {
  const { calls } = harness(t);
  assert.deepEqual(nodes().filter((node) => node.tagName === 'STRONG').map((node) => readText(node)),
    ['Existing GitHub Repo', 'New GitHub Repo', 'Local']);
  await click('Existing GitHub Repo');
  await click('Continue');
  assert.match(readText(document.getElementById('modal')), /Choose a repository/);
  assert.deepEqual(calls, [['listRepositories']]);
  await click('Back');
  await click('Back');
  await click('Local');
  assert.match(readText(document.getElementById('modal')), /Name and choose the folder/);
  assert.deepEqual(calls, [['listRepositories']], 'local must not create or read a repository');
});

test('repository creation UI: new-token help explains temporary creation permissions without changing existing help', async (t) => {
  harness(t, {}, []);
  await click('New GitHub Repo');
  assert.equal(control('catalog-connection-token').disabled, true);
  await click('Token help');
  const text = readText(control('catalog-connection-token-help'));
  for (const term of ['All repositories', 'Administration: Read and write', 'Contents: Read and write',
    'Metadata: Read-only', 'Workflows: Read and write', 'disables Actions', 'personal account',
    'After setup, narrow the token', 'always private']) assert.ok(text.includes(term), term);
  assert.equal(control('catalog-connection-token').disabled, true);
  await click('Back');
  await click('Existing GitHub Repo');
  await click('Token help');
  const existing = readText(control('catalog-connection-token-help'));
  assert.match(existing, /Only select repositories/);
  assert.doesNotMatch(existing, /All repositories|Administration: Read and write/);
});

test('repository creation UI: live accounts can explicitly replace a token for creation', async (t) => {
  let submitted;
  harness(t, { reconnectConnection: async (id, value) => { submitted = { id, ...value }; return account; } });
  await click('New GitHub Repo');
  await click('Update token for repository creation');
  await click('Token help');
  assert.match(readText(control('catalog-connection-token-help')), /Administration: Read and write/);
  input('catalog-connection-token', TEST_TOKEN);
  await click('Reconnect and continue');
  await drain();
  assert.equal(submitted.id, profile.id);
  assert.equal(submitted.token, TEST_TOKEN);
  assert.match(readText(document.getElementById('modal')), /Create a private GitHub repository/);
});

test('repository creation UI: source preflight precedes one private creation and rejoins the ordinary picker', async (t) => {
  const { calls, selection } = harness(t);
  await openCreation();
  assert.equal(control('catalog-create-repository-source').value, SOURCE);
  assert.match(readText(document.getElementById('modal')), /personal account @octo-dev/);
  assert.equal(nodes().some((node) => node.getAttribute('type') === 'checkbox'), false, 'no public toggle');
  input('catalog-create-repository-name', 'new-citadel');
  await click('Check source');
  const prepare = calls.find((item) => item[0] === 'prepare')[1];
  assert.equal(prepare.sourceUrl, SOURCE);
  assert.equal(prepare.name, 'new-citadel');
  assert.deepEqual(Object.keys(prepare).sort(), ['name', 'operationKey', 'sourceUrl']);
  assert.match(prepare.operationKey, /^[A-Za-z0-9-]+$/);
  assert.equal(calls.some((item) => item[0] === 'start'), false);
  assert.match(readText(document.getElementById('modal')), /citadel-v1/);
  assert.match(readText(document.getElementById('modal')), /363 files/);
  await click('Create private repository');
  assert.equal(calls.filter((item) => item[0] === 'start').length, 1);
  await click('Continue to repository');
  assert.match(readText(document.getElementById('modal')), /Choose a repository/);
  assert.equal(selection.repository.id, repository.id);
  assert.equal(selection.branch, '', 'normal branch selection remains explicit');
  assert.ok(selection.repositories.some((item) => item.id === repository.id), 'created repo must appear even if listing omitted it');
});

test('repository creation UI: invalid names and unsafe sources never reach preparation', async (t) => {
  const { calls } = harness(t);
  await openCreation();
  input('catalog-create-repository-name', '../other');
  await click('Check source');
  assert.equal(calls.some((item) => item[0] === 'prepare'), false);
  input('catalog-create-repository-name', 'new-citadel');
  input('catalog-create-repository-source', 'https://attacker.example/source');
  await click('Check source');
  assert.equal(calls.some((item) => item[0] === 'prepare'), false);
  assert.equal(control('catalog-create-repository-name').value, 'new-citadel');
  assert.equal(control('catalog-create-repository-source').disabled, false);
});

test('repository creation UI: failed attempt discovery is visible and blocks accidental duplicate setup', async (t) => {
  harness(t, { listRepositoryCreations: async () => { throw new Error('Offline'); } });
  await openCreation();
  assert.match(readText(document.getElementById('modal')), /Previous setup attempts could not be loaded: Offline/);
  assert.equal(button('Check source').disabled, true);
  assert.equal(button('Refresh attempts').disabled, false);
});

test('repository creation UI: retained private jobs resume without preparing another repository', async (t) => {
  const prior = operation({
    state: 'paused', created: true, canStart: false, canResume: true,
    error: { message: 'Copy interrupted. Private repository retained.' },
  });
  let status = prior;
  const { calls } = harness(t, {
    listRepositoryCreations: async () => ({ operations: [prior] }),
    repositoryCreationStatus: async () => status,
    resumeRepositoryCreation: async (id) => { calls.push(['resume', id]); status = complete(); return status; },
  });
  await openCreation();
  await click('Open octo-dev/new-citadel');
  assert.match(readText(document.getElementById('modal')), /private repository has been created and is retained/i);
  assert.equal(button('Edit setup').hidden, true);
  await click('Resume this attempt');
  assert.deepEqual(calls, [['resume', prior.id]]);
  assert.equal(button('Continue to repository').hidden, false);
});

test('repository creation UI: double submission stays single-flight and active copying can pause', async (t) => {
  let resolveStart;
  let starts = 0;
  const copying = operation({ state: 'copying', created: true, canStart: false, canPause: true });
  harness(t, {
    startRepositoryCreation: () => { starts += 1; return new Promise((resolve) => { resolveStart = resolve; }); },
    pauseRepositoryCreation: async () => ({ ...copying, state: 'paused', canPause: false, canResume: true }),
  });
  await openCreation();
  input('catalog-create-repository-name', 'new-citadel');
  await click('Check source');
  const handler = button('Create private repository').listeners.get('click')[0];
  const pending = handler();
  await handler();
  assert.equal(starts, 1);
  assert.equal(button('Create private repository').disabled, true);
  resolveStart(copying);
  await pending;
  assert.equal(button('Back').disabled, true);
  await click('Pause setup');
  assert.equal(button('Back').disabled, false);
  assert.equal(button('Resume this attempt').hidden, false);
});

test('repository creation UI: workflow sources disclose disabled Actions before creation', async (t) => {
  harness(t, { prepareRepository: async () => operation({
    source: { ...operation().source, hasWorkflows: true },
  }) });
  await openCreation();
  input('catalog-create-repository-name', 'new-citadel');
  await click('Check source');
  const text = readText(document.getElementById('modal'));
  assert.match(text, /token also needs Workflows read\/write/);
  assert.match(text, /Actions will be disabled on the new repository before copying/);
  assert.equal(button('Create private repository').hidden, false);
});

for (const action of ['start', 'resume', 'pause']) {
  test(`repository creation UI: an ambiguous ${action} retains its attempt until status reconciliation`, async (t) => {
    const before = action === 'start' ? operation() : operation({
      state: action === 'resume' ? 'paused' : 'copying',
      created: true, canStart: false, canResume: action === 'resume', canPause: action === 'pause',
    });
    let serverState = before;
    const ids = [];
    const actionName = `${action}RepositoryCreation`;
    harness(t, {
      listRepositoryCreations: async () => ({ operations: [before] }),
      repositoryCreationStatus: async (id) => { ids.push(id); return serverState; },
      [actionName]: async (id) => {
        ids.push(id);
        serverState = {
          ...before, state: action === 'pause' ? 'paused' : 'copying',
          created: true, canStart: false, canResume: action === 'pause', canPause: action !== 'pause',
        };
        throw new Error('Response was lost after GitHub accepted the request.');
      },
    });
    await openCreation();
    await click(`Open ${repository.fullName}`);
    await click({ start: 'Create private repository', resume: 'Resume this attempt', pause: 'Pause setup' }[action]);
    assert.equal(button('Edit setup').hidden, true);
    assert.equal(button('Edit setup').disabled, true);
    assert.equal(button('Create private repository').hidden, true);
    assert.equal(button('Resume this attempt').hidden, true);
    assert.match(readText(document.getElementById('modal')), /may have created or updated the private repository/);
    assert.doesNotMatch(readText(document.getElementById('modal')), /Checking the source creates nothing on GitHub/);
    await button('Edit setup').listeners.get('click')[0]();
    assert.equal(button('Check source').hidden, true, 'an unknown write must not expose a new preparation');
    await click('Refresh status');
    assert.ok(ids.every((id) => id === before.id), 'all recovery addresses the same operation');
    assert.match(readText(document.getElementById('modal')), /private repository has been created and is retained/i);
    assert.equal(button('Edit setup').hidden, true, 'a confirmed created repository cannot be discarded either');
    assert.equal(button('Resume this attempt').hidden, action !== 'pause');
  });
}

test('repository creation UI: switching accounts resets only local creation state, retaining old account history', async (t) => {
  const otherProfile = { ...profile, id: 'profile-2', accountId: 8484, accountLogin: 'second-user', name: 'Second' };
  const otherAccount = { accountId: 8484, login: 'second-user', profileId: otherProfile.id, profile: otherProfile };
  let activeAccount = account;
  const original = complete();
  harness(t, {
    useConnection: async (id) => { activeAccount = id === otherProfile.id ? otherAccount : account; return activeAccount; },
    listRepositoryCreations: async () => ({ operations: activeAccount.accountId === account.accountId ? [original] : [] }),
    repositoryCreationStatus: async () => original,
  }, [profile, otherProfile]);
  await openCreation();
  await click(`Open ${repository.fullName}`);
  assert.equal(control('catalog-create-repository-name').value, 'new-citadel');
  await click('Back');
  const chooser = control('catalog-connection-select');
  chooser.value = otherProfile.id;
  chooser.dispatch('change');
  await click('Continue');
  await drain();
  assert.match(readText(document.getElementById('modal')), /personal account @second-user/);
  assert.equal(control('catalog-create-repository-name').value, '');
  assert.equal(control('catalog-create-repository-source').value, SOURCE);
  assert.equal(button('Check source').hidden, false);
  assert.equal(button('Check source').disabled, false);
  assert.doesNotMatch(readText(document.getElementById('modal')), /octo-dev\/new-citadel/);
  await click('Back');
  const backToOriginal = control('catalog-connection-select');
  backToOriginal.value = profile.id;
  backToOriginal.dispatch('change');
  await click('Continue');
  await drain();
  assert.ok(button(`Open ${repository.fullName}`), 'account A still has its server-owned attempt');
});

test('repository creation UI: same-account token replacement keeps the operation and does not prepare again', async (t) => {
  const ids = [];
  const original = complete();
  harness(t, {
    listRepositoryCreations: async () => ({ operations: [original] }),
    repositoryCreationStatus: async (id) => { ids.push(id); return original; },
    reconnectConnection: async () => account,
    prepareRepository: async () => { throw new Error('An existing operation must not be prepared again.'); },
  });
  await openCreation();
  await click(`Open ${repository.fullName}`);
  await click('Update connection token');
  input('catalog-connection-token', TEST_TOKEN);
  await click('Reconnect and continue');
  await drain();
  assert.equal(control('catalog-create-repository-name').value, original.destination.name);
  assert.equal(button('Check source').hidden, true);
  assert.equal(button('Continue to repository').hidden, false);
  assert.ok(ids.length >= 2);
  assert.ok(ids.every((id) => id === original.id));
});
