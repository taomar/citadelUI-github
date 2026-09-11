import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { guardedHandler, mutations } from '../web/js/single-flight.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { createCompareSession } from '../web/js/compare-session.mjs';
import { historyEntry } from '../web/js/history-entry.mjs';
import { environmentSourceOf, environmentLocation } from '../web/js/registry.mjs';
import { describeCreatedBranch, saveStatusLine } from '../web/js/save-resolution.mjs';
import { mutationComplete } from '../shared/mutation-outcome.mjs';
import { configurationOf } from '../shared/workspace-configuration.mjs';
import { refNameProblem } from '../shared/git-refs.mjs';
import * as edits from '../web/js/contract-edit-state.mjs';

const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const handlers = [
  section('function createEditorState()', 'const viewStates ='),
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
  section('function openCreateContract()', 'async function loadContract('),
  section('function showPolicyReview(', '/* -------------------------------------------------------------- review/save */'),
  section('async function commitSave(', '/* --------------------------------------------------------------------- modal */'),
  section('async function openHistory()', '/**\n * Ask which source a new environment comes from.'),
].join('\n');
const MAIN = 'bicep/infra/main.bicepparam', ROOT = 'bicep/infra/citadel-access-contracts';
const pending = () => ({
  applied: false, outcome: 'pending', changed: false, transactionId: 'pending-transaction', commit: 'a'.repeat(40),
  unresolved: { kind: 'branch-moved', commit: 'a'.repeat(40), intendedBranch: 'citadel-ui/source', suggestedBranch: 'operator/keep-change' },
});
const applied = () => ({
  applied: true, outcome: 'applied', changed: true, path: MAIN, archived: 'b'.repeat(40), commit: 'b'.repeat(40),
  transactionId: 'confirmed-transaction', id: 'contracts/new-contract', dir: `${ROOT}/contracts/new-contract`,
  created: [`${ROOT}/contracts/new-contract/main.bicepparam`],
});
const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(initial, { local = false } = {}) {
  const dom = await loadDialogModule(), calls = [], statuses = [], sessions = [];
  let outcome = initial;
  const environment = (id, branch) => ({ id, projectId: 'synthetic-project', label: id,
    source: local ? { kind: 'local', folderName: id } :
      { kind: 'github', repositoryId: id === 'caller-source' ? 7 : 8, fullName: `synthetic/${id}`, workingBranch: branch, sourceBranch: 'main' } });
  const context = { projectId: 'synthetic-project', environment: environment('caller-source', 'citadel-ui/source') };
  const target = environment('caller-target', 'citadel-ui/destination');
  const domH = (...args) => {
    const node = h(...args), matches = node.matches.bind(node);
    node.matches = (selector) => /^input\[data-copy\](?::checked)?$/.test(selector)
      ? node.tagName === 'INPUT' && node.dataset.copy === 'true' && (!selector.endsWith(':checked') || node.checked)
      : matches(selector);
    if (node.tagName === 'SELECT' && !node.value) node.value = node.querySelector('option')?.value || '';
    if (node.tagName === 'INPUT') {
      node.setCustomValidity = (message) => { node.validationMessage = message; };
      node.reportValidity = () => !node.validationMessage;
    }
    return node;
  };
  const scope = { structuredClone, Map, h: domH, guardedHandler, ...edits, mutationComplete,
    captureDialogStatus: dom.captureDialogStatus,
    environmentSourceOf, environmentLocation, configurationOf, describeCreatedBranch, saveStatusLine, refNameProblem, historyEntry,
    activeWorkspace: () => context, requestAnimationFrame() {}, render() { calls.push(['render']); },
    reportClientError(error) { calls.push(['error', error.message]); }, writeContextNode: () => domH('p', {}, 'Synthetic context'),
    currentWriteContext: () => ({}), transactionTone: () => 'ok', humanAction: () => 'Synthetic prior edit', formatTimestamp: () => domH('span'),
    showModal: dom.showDialog, showDialog: dom.showDialog, closeModal: dom.closeDialog, dismissDialog: dom.dismissDialog,
    confirmDialog: async () => true, renderDiff: () => ({ node: domH('div'), stats: { added: 1, removed: 1 } }),
    withLocalConflict: async (_review, action) => action(),
    workspaceRegistry: { removeDraft: async (...args) => calls.push(['removeDraft', ...args]) },
    createCompareSession() {
      const session = createCompareSession(), release = session.release;
      session.release = () => { calls.push(['release-copy']); release(); };
      sessions.push(session); return session;
    },
    async loadDocument(...args) { calls.push(['loadDocument', ...args]); return true; },
    async loadContract(...args) { calls.push(['loadContract', ...args]); return true; },
    async selectContract(...args) { calls.push(['selectContract', ...args]); return true; },
  };
  scope.setStatus = (message, tone) => {
    scope.state.status = message ? { message, tone } : null;
    if (message) statuses.push({ message, tone });
  };
  const mutate = async (kind, ...args) => {
    calls.push([kind, ...args]);
    if (outcome instanceof Error) throw outcome;
    return typeof outcome === 'function' ? outcome() : clone(outcome);
  };
  scope.api = {
    createContract: (...args) => mutate('create', ...args), save: (...args) => mutate('parameter', ...args),
    savePolicy: (...args) => mutate('policy', ...args), copyParameters: (...args) => mutate('copy', ...args),
    restoreTransaction: (...args) => mutate('restore', ...args),
    contracts: async () => { calls.push(['contracts']); return { root: ROOT, parent: 'contracts', contracts: [] }; },
    deployments: async () => { calls.push(['catalog']); return { files: [] }; },
    history: async () => ({ transactions: [{ transactionId: 'prior-transaction', status: 'committed',
      targetLabel: 'parameter-edit', files: [{ alias: MAIN, existed: true }] }] }),
    createCommitBranch: async (...args) => {
      calls.push(['branch', ...args]);
      return { created: true, branch: args[1], commit: args[0] };
    },
    compareEnvironment: async () => ({
      source: { schema: { parameters: { label: { secure: false }, key: { secure: true } } } },
      parameters: [{ name: 'label', status: 'different', source: 'new', target: 'old' },
        { name: 'key', status: 'different', source: null, target: null }],
    }),
    previewCopy: async () => ({ before: 'old', after: 'new', sourceHash: 'source-hash', targetHash: 'target-hash',
      targetLabel: target.label, targetAlias: MAIN }),
  };
  vm.runInNewContext(handlers, scope);
  scope.viewStates = new WorkspaceViewState(scope.createEditorState);
  scope.state = scope.viewStates.activate(context);
  Object.assign(scope.state, {
    area: 'access-contracts', current: { path: MAIN, hash: 'source-hash' }, contractId: 'current-contract',
    contracts: { root: ROOT, parent: 'contracts', contracts: [] }, catalog: { files: [{ path: MAIN }] },
    contract: { policy: { path: `${ROOT}/current.xml`, name: 'current.xml', hash: 'policy-hash' } },
    operations: [{ op: 'set', path: ['label'], value: 'retained-parameter-draft' }],
    policyChanges: { variables: { jwtRequired: true } }, policyRaw: null, reviewEpoch: 4,
  });
  const action = (label) => dom.modal.querySelectorAll('button').find((node) => readText(node) === label);
  const press = async (nodeOrLabel) => {
    const node = typeof nodeOrLabel === 'string' ? action(nodeOrLabel) : nodeOrLabel;
    assert(node && !node.disabled, typeof nodeOrLabel === 'string' ? nodeOrLabel : 'enabled mutation control');
    for (const listener of node.listeners.get('click') || []) await listener({ target: node, currentTarget: node });
  };
  return { dom, scope, state: scope.state, context, target, calls, statuses, sessions, action, press,
    set outcome(value) { outcome = value; },
    async begin(kind) {
      if (kind === 'create') {
        scope.openCreateContract();
        dom.modal.querySelectorAll('input').find((node) => node.id === 'new-contract-name').value = 'new-contract';
        return action('Create');
      }
      if (kind === 'copy') {
        await scope.openEnvironmentCompare([context.environment, target]);
        await press('Review selected copy');
        return action('Back up target & copy');
      }
      if (kind === 'restore') {
        await scope.openHistory(); return action('Restore prior');
      }
      const review = { owner: scope.state, document: scope.state.current, context, operations: clone(scope.state.operations),
        ticket: scope.viewStates.ticket(), epoch: scope.state.reviewEpoch };
      if (kind === 'parameter') {
        dom.showDialog('Review parameters', domH('div'), [
          domH('button', { onclick: guardedHandler(() => scope.commitSave(review)) }, 'Save changes'),
        ]);
        return action('Save changes');
      }
      scope.showPolicyReview({ ...review, policy: scope.state.contract.policy, raw: scope.state.policyRaw,
        payload: { path: scope.state.contract.policy.path, expectedHash: 'policy-hash', changes: clone(scope.state.policyChanges) } },
      { before: '<policies />', after: '<policies><inbound /></policies>' });
      return action('Save policy');
    },
  };
}

const noCompletionEffects = (f) => {
  assert.equal(f.calls.some(([kind]) => ['removeDraft', 'loadDocument', 'loadContract', 'selectContract', 'contracts', 'catalog', 'release-copy'].includes(kind)), false);
};

for (const kind of ['create', 'copy', 'restore', 'parameter', 'policy']) {
  for (const result of [pending(), { applied: null, outcome: 'indeterminate', indeterminate: true, warnings: ['Synthetic unanswered response.'] },
    { applied: null, outcome: 'recovery-required', recoveryRequired: true, warnings: ['Source bytes were retained.'] }]) {
    test(`mutation callers: ${kind} retains drafts, selection and action for ${result.outcome}`, async () => {
      const f = await fixture(result), before = edits.captureContractEdits(f.state);
      const current = f.state.current, catalog = f.state.catalog, contracts = f.state.contracts;
      const button = await f.begin(kind), work = f.press(button);
      if (result.unresolved) { await tick(); await f.press('Leave it for now'); }
      await work;
      assert.deepEqual(edits.captureContractEdits(f.state), before);
      assert.equal(f.state.current, current); assert.equal(f.state.catalog, catalog); assert.equal(f.state.contracts, contracts);
      noCompletionEffects(f); assert.equal(f.dom.modal.open, true);
      assert.equal(f.state.status.tone, 'warn'); assert.doesNotMatch(f.state.status.message, /^(?:Created|Copied|Restored|Saved) /);
      assert.equal(f.calls.some(([type]) => type === 'branch'), false);
      if (kind === 'copy') assert.equal(f.sessions[0].locked, true);
      assert.deepEqual(mutations.active(), []);
    });
  }
}

for (const kind of ['create', 'copy', 'restore', 'parameter', 'policy']) {
  test(`mutation callers: ${kind} uses only the explicit branch decision and retains the original draft`, async () => {
    const f = await fixture(pending()), before = edits.captureContractEdits(f.state);
    const button = await f.begin(kind), work = f.press(button);
    await tick();
    domInput(f.dom, 'unsaved-branch-name').value = 'operator/explicit-choice';
    await f.press('Create branch'); await work;
    const call = f.calls.find(([type]) => type === 'branch');
    assert.equal(call[1], 'a'.repeat(40)); assert.equal(call[2], 'operator/explicit-choice');
    assert.equal(call[3].environment.id, kind === 'copy' ? f.target.id : f.context.environment.id);
    assert.equal(f.context.environment.source.workingBranch, 'citadel-ui/source');
    assert.deepEqual(edits.captureContractEdits(f.state), before);
    noCompletionEffects(f); assert.match(f.state.status.message, /pending action are retained/);
    assert.equal(f.dom.modal.open, true);
  });
}

function domInput(dom, id) { return dom.modal.querySelectorAll('input').find((node) => node.id === id); }

for (const kind of ['create', 'copy', 'restore']) {
  test(`mutation callers: ${kind} can retry a refused action without earlier false completion`, async () => {
    const f = await fixture(pending()), button = await f.begin(kind);
    const first = f.press(button); await tick(); await f.press('Leave it for now'); await first;
    noCompletionEffects(f);
    f.outcome = applied(); await f.press(button);
    assert.equal(f.calls.filter(([type]) => type === kind).length, 2);
    assert.equal(f.dom.modal.open, false);
    assert.match(f.state.status.message, kind === 'create' ? /^Created / : kind === 'copy' ? /^Copied / : /^Restored /);
    assert.equal(f.state.operations[0].value, 'retained-parameter-draft');
    if (kind === 'copy') assert.equal(f.sessions[0].locked, false);
    if (kind === 'restore') assert.deepEqual(f.calls.find(([type]) => type === 'loadContract')[2].operations, f.state.operations);
  });
}

for (const kind of ['parameter', 'policy']) {
  test(`mutation callers: confirmed ${kind} saves retain newer same-document edits and the other editor's draft`, async () => {
    let finish;
    const f = await fixture(() => new Promise((resolve) => { finish = resolve; }));
    const work = f.press(await f.begin(kind)); await tick();
    f.state.operations = [{ op: 'set', path: ['label'], value: 'newer-parameter-draft' }];
    f.state.policyChanges = { variables: { jwtRequired: false } };
    finish(applied()); await work;
    const preserved = f.calls.find(([type]) => type === 'loadContract')[2];
    assert.equal(preserved.operations[0].value, 'newer-parameter-draft');
    assert.equal(preserved.policyChanges.variables.jwtRequired, false);
    assert.equal(f.state.quarantinedDraft.operations[0].value, 'newer-parameter-draft');
    assert.equal(f.state.quarantinedDraft.policyChanges.variables.jwtRequired, false);
    assert.equal(f.calls.some(([type]) => type === 'removeDraft'), false);
  });

  test(`mutation callers: a confirmed ${kind} response cannot clear another document's identical-looking draft`, async () => {
    let finish;
    const f = await fixture(() => new Promise((resolve) => { finish = resolve; }));
    const work = f.press(await f.begin(kind)); await tick();
    const next = { path: 'bicep/infra/other.bicepparam', hash: 'other-hash' };
    f.state.current = next;
    f.state.contractId = 'other';
    f.state.contract = { policy: { path: `${ROOT}/other.xml`, hash: 'other-policy-hash' } };
    const before = edits.captureContractEdits(f.state);
    finish(applied()); await work;
    assert.equal(f.state.current, next);
    assert.deepEqual(edits.captureContractEdits(f.state), before);
    noCompletionEffects(f);
  });
}

test('mutation callers: a confirmed History restore reloads with the latest retained draft rather than its starting snapshot', async () => {
  let finish;
  const f = await fixture(() => new Promise((resolve) => { finish = resolve; }));
  const work = f.press(await f.begin('restore')); await tick();
  f.state.operations = [{ op: 'set', path: ['label'], value: 'latest-parameter' }];
  f.state.policyChanges = { variables: { jwtRequired: false } };
  finish(applied()); await work;
  const preserved = f.calls.find(([type]) => type === 'loadContract')[2];
  assert.equal(preserved.operations[0].value, 'latest-parameter');
  assert.equal(preserved.policyChanges.variables.jwtRequired, false);
});

for (const kind of ['create', 'copy', 'restore', 'parameter', 'policy']) {
  test(`mutation callers: confirmed Local ${kind} surfaces the receipt warning rather than losing it`, async () => {
    const warning = 'The receipt response failed, but the committed journal confirms this save.';
    const f = await fixture({ ...applied(), warnings: [warning] }, { local: true });
    await f.press(await f.begin(kind));
    assert.equal(f.state.status.tone, 'warn'); assert(f.state.status.message.includes(warning));
    assert.equal(f.dom.modal.open, false);
  });
}

test('mutation callers: Local recovery errors leave the original action and bytes-recovery message visible', async () => {
  const error = Object.assign(new Error('The save receipt is not confirmed. Source bytes were retained; inspect History recovery.'), {
    code: 'LOCAL_RECOVERY_REQUIRED', applied: null, recoveryRequired: true, transactionId: 'retained-local',
  });
  const f = await fixture(error, { local: true }), before = edits.captureContractEdits(f.state);
  await f.press(await f.begin('create'));
  noCompletionEffects(f); assert.equal(f.dom.modal.open, true);
  assert.deepEqual(edits.captureContractEdits(f.state), before);
  assert.match(f.state.status.message, /Source bytes were retained; inspect History recovery/);
});

test('mutation callers: an explicit current-equivalence no-op refreshes real state without inventing creation', async () => {
  const f = await fixture({ ...applied(), outcome: 'unchanged', applied: false, changed: false, commit: null, created: [],
    equivalentCommit: 'c'.repeat(40), warnings: ['No Citadel commit was applied; the current tree already matches.'] });
  await f.press(await f.begin('create'));
  assert.equal(f.dom.modal.open, false);
  assert.match(f.state.status.message, /already matches/); assert.doesNotMatch(f.state.status.message, /^Created /);
  assert.equal(f.calls.filter(([type]) => type === 'catalog').length, 1);
});

test('mutation callers: branch audit failure remains a visible warning with the pending original-target action', async () => {
  const f = await fixture(pending()), before = edits.captureContractEdits(f.state);
  f.scope.api.createCommitBranch = async (commit, branch) => ({ commit, branch, created: true, unlogged: true });
  const work = f.press(await f.begin('create')); await tick();
  domInput(f.dom, 'unsaved-branch-name').value = 'operator/audit-warning';
  await f.press('Create branch'); await work;
  assert.equal(f.state.status.tone, 'warn');
  assert.match(f.state.status.message, /branch exists.*History audit record could not be written/);
  assert.deepEqual(edits.captureContractEdits(f.state), before);
  noCompletionEffects(f);
});

test('mutation callers: an unconfirmed branch response does not invent a branch confirmation', async () => {
  const f = await fixture(pending());
  f.scope.api.createCommitBranch = async () => ({});
  const work = f.press(await f.begin('create')); await tick();
  domInput(f.dom, 'unsaved-branch-name').value = 'operator/unknown';
  await f.press('Create branch');
  assert.match(f.state.status.message, /branch outcome is not confirmed/);
  noCompletionEffects(f);
  await f.press('Leave it for now'); await work;
  assert.equal(f.dom.modal.open, true);
});

for (const kind of ['create', 'copy', 'restore']) {
  test(`mutation callers: a late ${kind} result cannot publish under a different workspace`, async () => {
    let finish;
    const f = await fixture(() => new Promise((resolve) => { finish = resolve; }));
    const button = await f.begin(kind), work = f.press(button); await tick();
    assert.equal(typeof finish, 'function');
    const original = f.state, next = { ...f.context, environment: { ...f.context.environment, id: 'new-owner' } };
    f.scope.state = f.scope.viewStates.activate(next);
    const current = f.scope.state; current.status = { message: 'New workspace', tone: 'info' };
    finish(pending()); await work;
    assert.equal(f.scope.state, current); assert.equal(current.status.message, 'New workspace');
    assert.equal(original.status.tone, 'warn');
    assert.equal(f.action('Create branch'), undefined);
    noCompletionEffects(f);
  });
}
