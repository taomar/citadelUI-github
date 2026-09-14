import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { createWorkspaceActivation, createWorkspaceReattachment, withSourceUnavailable } from '../web/js/workspace-activation.mjs';
import { migrationSnapshotPresentation } from '../web/js/migration-snapshot.mjs';
import { nativeConfiguration } from './_native-fixture.mjs';
import { installDom, readText } from './_dom-stub.mjs';
import { presentWorkspaceCatalog, runAddWorkspace, workspaceRecovery, workspaceStatus } from '../web/js/workspace-catalog.mjs';
import { RepositorySelection } from '../web/js/github-selection.mjs';
import { closeDialog, dismissDialog } from '../web/js/dialog.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const source = {
  kind: 'github', connectionProfileId: 'removed-profile', repositoryId: 41, fullName: 'synthetic/retained',
  sourceBranch: 'main', workingBranch: 'review/work', writeMode: 'working-branch', branchChoice: 'adopted',
  lastKnownHead: 'a'.repeat(40), capabilities: ['Main deployment'], validatedAt: '2026-01-01T00:00:00.000Z',
};
const original = {
  id: 'retained-workspace', projectId: 'project-one', label: 'Retained workspace',
  source, compatibility: 'supported', permission: 'granted',
};
const profile = { id: 'replacement-profile', name: 'Replacement account', accountId: 51, accountLogin: 'synthetic', status: 'session' };

function reattachmentFixture(configuration) {
  const state = {
    local: structuredClone({ ...original, ...(configuration ? { configuration } : {}) }),
    remote: structuredClone({ ...original, ...(configuration ? { configuration } : {}) }),
    profile: { ...profile }, generation: 1,
    account: { connected: true, profileId: profile.id, accountId: profile.accountId, login: profile.accountLogin },
    repository: { id: source.repositoryId, fullName: source.fullName, canPush: true },
    heads: new Map([['main', 'a'.repeat(40)], ['review/work', 'b'.repeat(40)]]),
    supported: true, updates: 0, mirrors: 0, reads: [], histories: [{ id: 'history-one' }], drafts: new Map([['file', 'unsaved bytes']]),
  };
  const recovery = createWorkspaceReattachment({
    registry: {
      async getEnvironment(id) { assert.equal(id, original.id); return state.local; },
      async updateEnvironment(id, patch) { assert.equal(id, original.id); state.updates++; return state.local = { ...state.local, ...patch }; },
    },
    sync: {
      async establishRegistryAuthority() { return { environments: [state.remote] }; },
      async syncRegistryMetadata(removals, scope) {
        assert.deepEqual(removals, {});
        assert.deepEqual(scope, { projectIds: [], environmentIds: [original.id] });
        state.mirrors++;
        state.remote = structuredClone(state.local);
        if (state.failMirror) { state.failMirror = false; throw new Error('Synthetic accepted mirror response lost'); }
        return { environments: [structuredClone(state.remote)] };
      },
    },
    connections: {
      status: async () => ({ ...state.account }),
      list: async () => ({ profiles: [state.profile] }),
      generation: () => state.generation,
      isCurrent: (generation) => generation === state.generation,
    },
    repositories: {
      async get(id) { state.reads.push(['repository', id]); return state.repository; },
      async check(id, branch, selected) {
        assert.deepEqual(selected, configuration);
        state.reads.push(['ref', id, branch]);
        await state.beforeCheck?.(branch);
        if (state.readError) throw state.readError;
        return { repositoryId: id, fullName: source.fullName, branch, supported: state.supported, head: state.heads.get(branch) };
      },
    },
    now: () => '2026-09-12T13:00:00.000Z',
  });
  return { state, recovery };
}

test('UI workspace recovery: reattachment explicitly reviews account, both refs and retained identity before a metadata-only commit', async () => {
  const { state, recovery } = reattachmentFixture();
  const initial = structuredClone(state.local);
  const history = state.histories, drafts = state.drafts;
  const review = await recovery.review(initial, profile.id);
  assert.equal(review.accountId, profile.accountId);
  assert.equal(review.profileId, profile.id);
  assert.deepEqual(review.refs, [{ branch: 'main', head: 'a'.repeat(40) }, { branch: 'review/work', head: 'b'.repeat(40) }]);
  assert.equal(state.updates, 0, 'source review is read-only');
  assert.equal(state.mirrors, 0);
  const updated = await recovery.commit(review);
  assert.equal(updated.id, initial.id);
  assert.equal(updated.projectId, initial.projectId);
  const { connectionProfileId, validatedAt, ...rest } = updated.source;
  const { connectionProfileId: oldProfile, validatedAt: oldValidation, ...oldRest } = initial.source;
  assert.deepEqual(rest, oldRest);
  assert.notEqual(connectionProfileId, oldProfile);
  assert.notEqual(validatedAt, oldValidation);
  assert.equal(state.histories, history);
  assert.equal(state.drafts, drafts);
  assert.deepEqual([...drafts], [['file', 'unsaved bytes']]);
  assert.equal(state.mirrors, 1);
  assert.equal(state.reads.filter(([kind]) => kind === 'ref').length, 4, 'both refs are rechecked on confirmation');
  assert.deepEqual(initial, original, 'the caller source is never mutated');
  await assert.rejects(recovery.commit(review), /Review this workspace/);
});

test('UI workspace recovery: no implicit selection, forged review or account mismatch can rebind a workspace', async () => {
  const { state, recovery } = reattachmentFixture();
  await assert.rejects(recovery.review(original, null), /Explicitly choose/);
  state.account.profileId = 'another-profile';
  await assert.rejects(recovery.review(original, profile.id), (error) => error.sourceUnavailable.kind === 'connection');
  state.account.profileId = profile.id;
  const review = await recovery.review(original, profile.id);
  await assert.rejects(recovery.commit(structuredClone(review)), /Review this workspace/);
  state.account.accountId = 52;
  state.profile.accountId = 52;
  await assert.rejects(recovery.commit(review), /reviewed account or repository ref moved/);
  assert.equal(state.updates, 0);
});

for (const change of ['repository-id', 'repository-name', 'read-only', 'archived', 'unsupported', 'missing-write-ref']) {
  test(`UI workspace recovery: ${change} is refused without rewriting source metadata`, async () => {
    const { state, recovery } = reattachmentFixture();
    if (change === 'repository-id') state.repository.id = 42;
    if (change === 'repository-name') state.repository.fullName = 'other/retained';
    if (change === 'read-only') state.repository.canPush = false;
    if (change === 'archived') state.repository.archived = true;
    if (change === 'unsupported') state.supported = false;
    if (change === 'missing-write-ref') state.heads.delete('review/work');
    await assert.rejects(recovery.review(original, profile.id), (error) => {
      assert.equal(error.sourceUnavailable.kind, 'unavailable');
      return true;
    });
    assert.equal(state.updates, 0);
    assert.deepEqual(state.local, original);
  });
}

test('UI workspace recovery: stale review, source retarget and changed connection are rejected before metadata publication', async () => {
  for (const change of ['head', 'source', 'connection', 'unassigned']) {
    const { state, recovery } = reattachmentFixture();
    const review = await recovery.review(original, profile.id);
    if (change === 'head') state.heads.set('main', 'c'.repeat(40));
    if (change === 'source') state.local.source.workingBranch = 'other-ref';
    if (change === 'connection') state.local.source.connectionProfileId = 'other-profile';
    if (change === 'unassigned') state.local.source.connectionProfileId = null;
    await assert.rejects(recovery.commit(review));
    assert.equal(state.updates, 0, change);
  }
});

test('UI workspace recovery: native connection identity remains immutable and original workspace work remains retained', async () => {
  const { state, recovery } = reattachmentFixture(nativeConfiguration(['deployment']));
  const before = structuredClone(state.local);
  await assert.rejects(recovery.review(before, profile.id), { code: 'NATIVE_SOURCE_RETARGET' });
  assert.deepEqual(state.local, before);
  assert.equal(state.updates, 0);
  assert.deepEqual(state.reads, []);
  const next = workspaceRecovery(before, { connections: [] });
  assert.equal(next.actionLabel, 'Review recovery');
  assert.match(next.guidance, /cannot be transferred/);
});

test('UI workspace recovery: changed credential generation during validation cannot publish a review', async () => {
  const { state, recovery } = reattachmentFixture();
  state.beforeCheck = async (branch) => { if (branch === 'review/work') state.generation++; };
  await assert.rejects(recovery.review(original, profile.id), { code: 'CONNECTION_MISMATCH' });
  assert.equal(state.updates, 0);
});

test('UI workspace recovery: one validation or confirmation runs at a time', async () => {
  const { state, recovery } = reattachmentFixture();
  const entered = deferred(), release = deferred();
  state.beforeCheck = async () => { entered.resolve(); await release.promise; };
  const pending = recovery.review(original, profile.id);
  await entered.promise;
  await assert.rejects(recovery.review(original, profile.id), /already in progress/);
  await assert.rejects(recovery.commit({}), /already in progress/);
  release.resolve();
  const review = await pending;
  state.beforeCheck = null;
  await recovery.commit(review);
  assert.equal(state.updates, 1);
});

test('UI workspace recovery: an accepted but unconfirmed mirror retries the same metadata identity without source writes', async () => {
  const { state, recovery } = reattachmentFixture();
  const review = await recovery.review(original, profile.id);
  state.failMirror = true;
  await assert.rejects(recovery.commit(review), (error) => {
    assert.equal(error.code, 'REATTACH_SYNC_PENDING');
    assert.match(error.cause.message, /response lost/);
    assert.match(error.message, /not confirmed/);
    assert.equal(error.sourceUnavailable, undefined, 'uncertain metadata mirroring is not a missing-source claim');
    return true;
  });
  assert.equal(state.local.id, original.id);
  assert.equal(state.remote.source.connectionProfileId, profile.id);
  await recovery.commit(review);
  assert.equal(state.mirrors, 1, 'fresh authoritative agreement confirms the lost reply without a duplicate publication');
  assert.equal(state.updates, 1, 'retry does not stage the same metadata again');
  assert.equal(state.remote.source.workingBranch, source.workingBranch);
  assert.deepEqual([...state.drafts], [['file', 'unsaved bytes']]);
});

test('UI workspace recovery: pending confirmation can revalidate moved refs without abandoning staged identity or accepting another account', async () => {
  const { state, recovery } = reattachmentFixture();
  const review = await recovery.review(original, profile.id);
  state.failMirror = true;
  await assert.rejects(recovery.commit(review), { code: 'REATTACH_SYNC_PENDING' });
  state.heads.set('main', 'c'.repeat(40));
  await assert.rejects(recovery.commit(review), { code: 'REATTACH_REVIEW_STALE' });
  const refreshed = await recovery.revalidate(review);
  assert.equal(refreshed.refs[0].head, 'c'.repeat(40));
  assert.equal(state.updates, 1, 'revalidation alone makes no additional metadata change');
  await assert.rejects(recovery.commit(review), /Review this workspace/);
  state.account.accountId = state.profile.accountId = 52;
  await assert.rejects(recovery.revalidate(refreshed), { code: 'CONNECTION_MISMATCH' });
  state.account.accountId = state.profile.accountId = profile.accountId;
  await recovery.commit(refreshed);
  assert.equal(state.local.source.connectionProfileId, profile.id);
  assert.equal(state.local.source.workingBranch, original.source.workingBranch);
});

test('UI workspace recovery: pending mirror recovery will not overwrite a later server-side connection change', async () => {
  const { state, recovery } = reattachmentFixture();
  const review = await recovery.review(original, profile.id);
  state.failMirror = true;
  await assert.rejects(recovery.commit(review), { code: 'REATTACH_SYNC_PENDING' });
  state.remote.source.connectionProfileId = 'later-profile';
  await assert.rejects(recovery.commit(review), /saved workspace changed elsewhere/);
  assert.equal(state.updates, 1);
  assert.equal(state.remote.source.connectionProfileId, 'later-profile');
});

test('UI workspace recovery: source errors retain their identity and expose only additive plain-data recovery guidance', async () => {
  for (const [name, code, kind] of [
    ['NotFoundError', '', 'missing-file'], ['NotAllowedError', '', 'permission'],
    ['Error', 'GITHUB_SESSION_EXPIRED', 'connection'], ['Error', 'BRANCH_NOT_FOUND', 'unavailable'],
  ]) {
    const cause = new Error('Original source cause');
    const error = Object.assign(new Error('Original source message', { cause }), { name, code, alias: 'bicep/infra/main.bicepparam' });
    assert.equal(withSourceUnavailable(error, original), error);
    assert.equal(error.cause, cause);
    assert.equal(error.message, 'Original source message');
    assert.equal(error.sourceUnavailable.kind, kind);
    assert.equal(error.sourceUnavailable.path, error.alias);
    assert.deepEqual(Object.keys(error.sourceUnavailable).sort(), ['guidance', 'kind', 'message', 'path']);
    assert(Object.values(error.sourceUnavailable).every((value) => typeof value === 'string'));
    assert.equal(JSON.stringify(error.sourceUnavailable).includes('<'), false);
  }
  const { state, recovery } = reattachmentFixture();
  const originalError = Object.assign(new Error('Source missing'), { name: 'NotFoundError', alias: 'bicep/infra/main.bicepparam' });
  state.readError = originalError;
  await assert.rejects(recovery.review(original, profile.id), (error) => error === originalError && error.sourceUnavailable.kind === 'missing-file');
  assert.equal(state.updates, 0);
});

test('UI workspace recovery: missing connection, credentials, folder, permission and incompatible sources have distinct next actions', () => {
  assert.equal(workspaceRecovery({ ...original, compatibility: 'invalid-citadel-root' }, { connections: [] }).label, 'Missing connection');
  assert.equal(workspaceRecovery(original, { connections: [{ ...profile, id: source.connectionProfileId, status: 'reconnect' }] }).label, 'Needs credentials');
  const local = { ...original, source: { kind: 'local', folderName: 'original-folder' } };
  assert.equal(workspaceRecovery(local, { hasHandle: false }).label, 'Unavailable folder');
  assert.equal(workspaceRecovery({ ...local, permission: 'prompt' }, { hasHandle: true }).label, 'Folder permission needed');
  assert.equal(workspaceRecovery({ ...local, compatibility: 'invalid-citadel-root' }, { hasHandle: true }).actionLabel, 'Retry source check');
  assert.equal(workspaceStatus({ ...local, compatibility: 'unavailable' }, { hasHandle: true }), 'unavailable');
});

test('UI workspace recovery: incompatible GitHub activation keeps repository guidance and never publishes source success', async () => {
  const activation = createWorkspaceActivation({
    registry: { updateEnvironment: () => assert.fail('Unsupported source must not be accepted') },
    sync: { syncRegistryMetadata: () => assert.fail('Unsupported source must not be mirrored') },
    providers: { create: async () => ({}) },
    connections: { restore: async () => ({ profileId: source.connectionProfileId }) },
    scan: async () => ({ compatibility: 'invalid-citadel-root', catalog: { missingCapabilities: ['Main deployment'] } }),
  });
  await assert.rejects(activation.openEnvironment(original), (error) => {
    assert.equal(error.sourceUnavailable.kind, 'unavailable');
    assert.match(error.sourceUnavailable.guidance, /exact repository and retained refs/);
    assert.doesNotMatch(error.sourceUnavailable.guidance, /source folder/);
    return true;
  });
});

test('UI workspace recovery: an explicit folder-permission refusal retains its error and distinct next action', async () => {
  const failure = new Error('Read/write folder permission is required. Reconnect the environment.');
  const activation = createWorkspaceActivation({
    registry: { updateEnvironment: () => assert.fail('Permission refusal must not be accepted') },
    sync: { syncRegistryMetadata: () => assert.fail('Permission refusal must not be mirrored') },
    providers: { create: async () => ({ assertWritable: async () => { throw failure; } }) },
    connections: {},
    scan: async () => assert.fail('Permission refusal must not trigger a source read'),
  });
  await assert.rejects(activation.openEnvironment({ ...original, source: { kind: 'local', folderName: 'original' } }), (error) => {
    assert.equal(error, failure);
    assert.equal(error.sourceUnavailable.kind, 'permission');
    assert.match(error.sourceUnavailable.guidance, /original browser-selected folder/);
    return true;
  });
});

test('UI workspace recovery: equal-time snapshot choices show file count, ref/revision and collision-safe capture identity', () => {
  const snapshots = [1, 2].map((index) => ({
    id: `12345678-1111-4111-8111-00000000000${index}`, createdAt: '2026-09-12T11:12:13.123Z', files: 4, status: 'complete',
    source: { kind: 'public-github', label: 'Same donor', provenance: { repository: 'synthetic/donor', ref: 'main', commit: 'a'.repeat(40) } },
  }));
  const before = structuredClone(snapshots);
  const [first, second] = snapshots.map((snapshot) => migrationSnapshotPresentation(snapshot, snapshots));
  assert.equal(first.label, 'Same donor');
  assert.notEqual(first.detail, second.detail);
  assert(first.detail.includes(snapshots[0].id));
  assert.match(first.detail, /4 files/);
  assert.match(first.detail, /synthetic\/donor @ main \(aaaaaaaaaaaa\)/);
  assert.match(first.detail, /123/);
  assert.deepEqual(snapshots, before);
});

const dom = installDom();
let frames = [];
const flush = () => { for (const callback of frames.splice(0)) callback(); };
const all = (root) => [root, ...root.children.flatMap(all)];
const button = (root, name) => all(root).find((node) => node.tagName === 'BUTTON' && readText(node) === name);
beforeEach(() => {
  closeDialog();
  dom.root.replaceChildren(dom.modal);
  document.activeElement = dom.root;
  frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
});

async function catalog(overrides = {}) {
  const container = dom.node('main');
  dom.root.append(container);
  const state = { profiles: [{ ...profile, id: source.connectionProfileId }], rows: [structuredClone(original)] };
  let refresh;
  const actions = {
    listProjects: async () => [{ id: original.projectId, label: 'Retained project' }],
    listEnvironments: async () => state.rows,
    listConnections: async () => ({ profiles: state.profiles, vault: { available: false } }),
    listActivity: async () => [],
    hasHandle: async () => false,
    ...overrides,
  };
  presentWorkspaceCatalog({ container, actions, sessions: { subscribe(callback) { refresh = callback; } } });
  await turn();
  return { container, state, actions, refresh };
}

test('UI workspace recovery: every catalog sort restores its current button and puts aria-sort on the column header', async () => {
  const { container } = await catalog();
  for (const key of ['label', 'source', 'status', 'opened']) {
    for (let direction = 0; direction < 2; direction++) {
      const id = `catalog-sort-${key}`;
      const control = document.getElementById(id);
      control.focus();
      control.click();
      assert.equal(document.activeElement, document.getElementById(id));
      assert.equal(document.activeElement.isConnected, true);
      assert.equal(document.activeElement.parentElement.tagName, 'TH');
      assert.match(document.activeElement.parentElement.getAttribute('aria-sort'), /ascending|descending/);
      assert.equal(document.activeElement.getAttribute('aria-sort'), null);
    }
  }
  assert.match(readText(container), /1 of 1/);
});

test('UI workspace recovery: refresh preserves catalog search caret and does not steal a later user focus', async () => {
  const gate = deferred();
  const f = await catalog({ disconnectConnection: async () => gate.promise });
  const disconnect = button(f.container, 'Disconnect');
  disconnect.focus();
  disconnect.click();
  const search = document.getElementById('catalog-search');
  search.focus();
  search.value = 'Retained';
  search.setSelectionRange(2, 5, 'backward');
  search.dispatch('input');
  f.state.profiles[0].status = 'reconnect';
  gate.resolve();
  await turn();
  const current = document.getElementById('catalog-search');
  assert.equal(document.activeElement, current);
  assert.equal(current.value, 'Retained');
  assert.deepEqual([current.selectionStart, current.selectionEnd, current.selectionDirection], [2, 5, 'backward']);
});

test('UI workspace recovery: disconnect focuses the surviving connection recovery action', async () => {
  const f = await catalog();
  f.actions.disconnectConnection = async () => { f.state.profiles[0].status = 'reconnect'; };
  const id = `catalog-connection-${source.connectionProfileId}-primary`;
  document.getElementById(id).focus();
  document.getElementById(id).click();
  await turn();
  assert.equal(document.activeElement, document.getElementById(id));
  assert.equal(readText(document.activeElement), 'Reconnect');
  assert.equal(document.activeElement.disabled, false);
});

test('UI workspace recovery: failed connection inventory does not falsely orphan retained workspaces', async () => {
  const f = await catalog();
  f.actions.listConnections = async () => { throw new Error('Synthetic connection list unavailable'); };
  f.refresh();
  await turn();
  assert.match(readText(f.container), /catalogue could not be loaded: Synthetic connection list unavailable/);
  assert.match(readText(f.container), /Ready/);
  assert.doesNotMatch(readText(f.container), /Missing connection/);
});

test('UI workspace recovery: removed connections require explicit source consent and a reviewed confirmation; Escape cannot cancel an in-flight confirmation', async () => {
  const f = await catalog({ listConnections: async () => ({ profiles: [profile], vault: { available: false } }) });
  const gate = deferred();
  let validations = 0, commits = 0, connections = 0;
  const review = {
    profileName: profile.name, login: profile.accountLogin, accountId: profile.accountId,
    refs: [{ branch: 'main', head: 'a'.repeat(40) }, { branch: 'review/work', head: 'b'.repeat(40) }],
  };
  f.actions.useConnection = async () => { connections++; return { profileId: profile.id }; };
  f.actions.reviewReattachment = async (environment, id) => {
    assert.equal(environment.id, original.id); assert.equal(id, profile.id); validations++; return review;
  };
  f.actions.commitReattachment = async (supplied) => { assert.equal(supplied, review); commits++; await gate.promise; return original; };
  button(f.container, 'Reattach connection').focus();
  button(f.container, 'Reattach connection').click();
  flush();
  assert.equal(document.getElementById('workspace-reattach-connection').value, '');
  assert.equal(button(dom.modal, 'Validate connection and source').disabled, true);
  assert.equal(connections, 0);
  const select = document.getElementById('workspace-reattach-connection');
  select.value = profile.id;
  select.dispatch('change');
  const consent = document.getElementById('workspace-reattach-consent');
  consent.checked = true;
  consent.dispatch('change');
  button(dom.modal, 'Validate connection and source').click();
  await turn(); flush();
  assert.equal(validations, 1);
  assert.equal(commits, 0);
  assert.equal(document.activeElement.id, 'workspace-reattach-stage');
  assert.match(readText(dom.modal), /review\/work/);
  button(dom.modal, 'Back').click();
  assert.equal(document.getElementById('workspace-reattach-connection').value, profile.id);
  button(dom.modal, 'Validate connection and source').click();
  await turn(); flush();
  button(dom.modal, 'Reattach this workspace').click();
  dom.modal.dispatch('keydown', { key: 'Escape' });
  assert.equal(dom.modal.open, true);
  assert.equal(commits, 1);
  assert.equal(button(dom.modal, 'Confirming reattachment\u2026').disabled, true);
  gate.resolve();
  await turn(); flush();
  assert.match(readText(dom.modal), /server confirmed this workspace metadata/);
  assert.equal(commits, 1);
  dismissDialog(false);
  await turn(); flush();
});

test('UI workspace recovery: cancelling before validation performs no source reads, reattachment or workspace removal', async () => {
  const f = await catalog({
    listConnections: async () => ({ profiles: [], vault: { available: false } }),
    useConnection: () => assert.fail('No connection consent'),
    reviewReattachment: () => assert.fail('No source-read consent'),
    commitReattachment: () => assert.fail('No reattachment confirmation'),
    detachEnvironment: () => assert.fail('Retained workspace must not be removed'),
  });
  button(f.container, 'Reattach connection').click();
  flush();
  const choice = document.getElementById('workspace-reattach-connection');
  choice.value = 'new';
  choice.dispatch('change');
  const token = document.getElementById('workspace-reattach-token');
  token.value = 'synthetic-unsubmitted-token';
  dom.modal.dispatch('keydown', { key: 'Escape' });
  assert.equal(dom.modal.open, false);
  assert.equal(token.value, '');
  assert.deepEqual(f.state.rows, [original]);
});

test('UI workspace recovery: workspace Actions groups secondary controls and Escape returns to its named opener', async () => {
  const f = await catalog();
  const summary = document.getElementById(`catalog-workspace-${original.id}-actions`);
  assert.equal(summary.getAttribute('aria-label'), `Actions for ${original.label}`);
  const disclosure = summary.parentElement;
  assert.equal(disclosure.tagName, 'DETAILS');
  assert.equal(disclosure.open, false);
  disclosure.open = true;
  const rename = button(disclosure, 'Rename');
  assert.equal(rename.getAttribute('aria-label'), `Rename ${original.label}`);
  rename.focus();
  disclosure.dispatch('keydown', { key: 'Escape' });
  assert.equal(disclosure.open, false);
  assert.equal(document.activeElement, summary);
});

test('UI workspace recovery: catalog format icons decorate real Bicep and Terraform labels independently of source kind', async () => {
  const f = await catalog({
    listEnvironments: async () => [
      original,
      { ...original, id: 'native-local', label: 'Native local', source: { kind: 'local', folderName: 'native-local' },
        configuration: nativeConfiguration(['deployment']) },
    ],
  });
  const rows = all(f.container).filter((node) => node.classList.contains('catalog-row'));
  const icons = rows.map((row) => row.querySelector('img'));
  assert.deepEqual(icons.map((icon) => icon.getAttribute('src')).sort(), ['/icons/bicep.svg', '/icons/terraform.svg']);
  for (const [index, row] of rows.entries()) {
    const icon = icons[index];
    assert.equal(icon.getAttribute('alt'), '');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.draggable, false);
    assert.equal(icon.getAttribute('width'), '20');
    assert.equal(icon.getAttribute('height'), '20');
    assert.match(readText(icon.parentElement), /Bicep|Terraform/);
    assert.equal(row.children[1].querySelector('img'), null, 'source kind is not configuration format');
  }
});

test('UI workspace recovery: Add format icons follow the native select without changing its options or accessible name', () => {
  runAddWorkspace({
    connections: [], vault: { available: false }, rows: [], onDone() {},
    actions: { createSelection: () => new RepositorySelection({ listRepositories: async () => ({ repositories: [] }) }) },
  });
  for (const format of ['bicep', 'terraform', 'bicep']) {
    const select = all(dom.modal).find((node) => node.getAttribute('aria-label') === 'Configuration format');
    select.value = format;
    select.dispatch('change');
    const replacement = all(dom.modal).find((node) => node.getAttribute('aria-label') === 'Configuration format');
    assert.equal(replacement.tagName, 'SELECT');
    assert.equal(replacement.children.length, 2);
    assert(replacement.children.every((node) => node.tagName === 'OPTION' && !node.querySelector('img')));
    assert.equal(replacement.parentElement.querySelector('img').getAttribute('src'), `/icons/${format}.svg`);
  }
  dismissDialog(false);
});
