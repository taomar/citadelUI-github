import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { githubWorkspaceFixture } from './_github-workspace-fixture.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { h } from '../web/js/dom.mjs';
import { guardedHandler, mutations } from '../web/js/single-flight.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { createCompareSession } from '../web/js/compare-session.mjs';
import { historyEntry } from '../web/js/history-entry.mjs';
import { environmentSourceOf, environmentLocation } from '../web/js/registry.mjs';
import { describeCreatedBranch, saveStatusLine } from '../web/js/save-resolution.mjs';
import { mutationComplete } from '../shared/mutation-outcome.mjs';
import { configurationOf, createConfiguration } from '../shared/workspace-configuration.mjs';
import { GitHubCommitCoordinator } from '../web/js/github-coordinator.mjs';
import { localRecoveryFailure } from '../web/js/mutation-coordinator.mjs';
import { refNameProblem } from '../shared/git-refs.mjs';
import * as edits from '../web/js/contract-edit-state.mjs';

const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const apiSource = await readFile(new URL('../web/js/api.mjs', import.meta.url), 'utf8');
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
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function apiFor(workspace) {
  const scope = { workspace };
  vm.runInNewContext(apiSource.slice(apiSource.indexOf('export const api =')).replace('export const api =', 'globalThis.api ='), scope);
  return scope.api;
}

async function fixture(initial, { local = false, context: attachedContext = null, target: attachedTarget = null } = {}) {
  const dom = await loadDialogModule(), calls = [], statuses = [], sessions = [], results = [];
  let outcome = initial;
  const environment = (id, branch) => ({ id, projectId: 'synthetic-project', label: id,
    source: local ? { kind: 'local', folderName: id } :
      { kind: 'github', repositoryId: id === 'caller-source' ? 7 : 8, fullName: `synthetic/${id}`, workingBranch: branch, sourceBranch: 'main' } });
  const context = attachedContext || { projectId: 'synthetic-project', environment: environment('caller-source', 'citadel-ui/source') };
  const target = attachedTarget || environment('caller-target', 'citadel-ui/destination');
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
    reportClientError(error) { calls.push(['error', error.message, error]); }, writeContextNode: () => domH('p', {}, 'Synthetic context'),
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
    const result = typeof outcome === 'function' ? await outcome(kind, ...args) : clone(outcome);
    results.push({ kind, result, beforePresentation: clone(result) });
    return result;
  };
  scope.api = {
    createContract: (...args) => mutate('create', ...args), save: (...args) => mutate('parameter', ...args),
    savePolicy: (...args) => mutate('policy', ...args), copyParameters: (...args) => mutate('copy', ...args),
    restoreTransaction: (...args) => mutate('restore', ...args),
    recoverTransaction: (...args) => mutate('complete', ...args),
    inspectRecovery: async () => ({ canComplete: true, files: [{ alias: MAIN, state: 'final' }] }),
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
  return { dom, scope, state: scope.state, context, target, calls, statuses, sessions, results, action, press,
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
      if (kind === 'complete') {
        scope.api.history = async () => {
          calls.push(['history']);
          return { transactions: [{ transactionId: 'prior-transaction', status: 'committing', recoveryRequired: true,
            files: [{ alias: MAIN, existed: true }] }] };
        };
        await scope.openHistory();
        await press('Recover');
        return action('Complete');
      }
      const review = { owner: scope.state, document: scope.state.current, context, operations: clone(scope.state.operations),
        ticket: scope.viewStates.ticket(), epoch: scope.state.reviewEpoch, scope: scope.captureDocumentAction(),
        revision: scope.state.policyRevision };
      if (kind === 'parameter') {
        dom.showDialog('Review parameters', domH('div'), [
          domH('button', { onclick: guardedHandler(() => scope.commitSave(review)) }, 'Save changes'),
        ]);
        return action('Save changes');
      }
      scope.showPolicyReview({ ...review, policy: scope.state.contract.policy, raw: scope.state.policyRaw,
        payload: { path: scope.state.contract.policy.path, expectedHash: scope.state.contract.policy.hash, changes: clone(scope.state.policyChanges) } },
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

async function transportCaller(t, transport, kind, delivery) {
  const local = transport === 'Local';
  const build = async (environmentId, files = {}) => {
    if (!local) return githubWorkspaceFixture({ environmentId, files });
    const backend = await nativeLocalFixture({ environmentId, configuration: createConfiguration('bicep'),
      onlyFiles: Object.fromEntries(Object.entries(citadelRepositoryFiles(files)).filter(([, value]) => typeof value === 'string')) });
    t.after(backend.close);
    return backend;
  };
  const backend = await build('c1-caller-source');
  let destination = backend;
  if (kind === 'copy') {
    destination = await build('c1-caller-target', {
      [MAIN]: citadelRepositoryFiles()[MAIN].replace("environmentName = 'dev'", "environmentName = 'target'"),
    });
    backend.service.registry = {
      listEnvironments: async () => [backend.environment, destination.environment],
      getHandle: async () => local ? destination.root : null,
    };
    backend.service.createProvider = async () => destination.provider;
    if (local) backend.environments.set(destination.environment.id, destination.environment);
    else backend.service.coordinator = new GitHubCommitCoordinator({
      contextProvider: () => backend.context,
      request: (path, init) => path.includes(`/workspaces/${destination.environment.id}/`)
        ? destination.request(path, init) : backend.request(path, init),
    });
  }
  const api = apiFor(backend.service);
  if (kind === 'restore') {
    const before = await api.deployment(MAIN, backend.context);
    await api.save(MAIN, [{ op: 'set', path: ['environmentName'], value: 'before-undo' }], before.hash, null, backend.context);
  }
  const contract = kind === 'policy' ? await api.contract('__template', backend.context) : null;
  const document = contract?.param || await api.deployment(MAIN, backend.context);
  const methods = { parameter: 'save', policy: 'savePolicy', create: 'createContract', copy: 'copyParameters', restore: 'restoreTransaction' };
  const f = await fixture((operation, ...args) => api[methods[operation]](...args),
    { local, context: backend.context, target: destination.environment });
  Object.assign(f.state, {
    area: contract ? 'access-contracts' : 'other', current: document, contract, contractId: contract?.id || null,
    operations: [{ op: 'set', path: ['environmentName'], value: local && delivery === 'unchanged' ? 'dev' : 'reviewed-by-caller' }],
    policyChanges: kind === 'policy' && !(local && delivery === 'unchanged') ? { variables: { jwtRequired: true } } : {},
    contracts: await api.contracts(backend.context), catalog: await api.deployments(backend.context),
  });
  for (const [method, label] of [['contracts', 'contracts'], ['deployments', 'catalog'], ['history', 'history'],
    ['compareEnvironment', 'compare'], ['previewCopy', 'copy-preview']]) {
    f.scope.api[method] = (...args) => { f.calls.push([label, ...args]); return api[method](...args); };
  }
  const beforeBytes = (await backend.provider.read(MAIN)).bytes.slice();
  const branch = destination.environment.source.workingBranch;
  let committed = null, collaborator = null;
  if (local && delivery !== 'unchanged') {
    const receipt = backend.store.commitReceipt.bind(backend.store);
    backend.store.commitReceipt = async (...args) => {
      if (delivery === 'applied') await receipt(...args);
      throw new Error('C1 UI synthetic receipt response lost');
    };
  } else if (!local && delivery === 'pending') destination.github.failNextRefUpdate = true;
  else if (!local && delivery === 'indeterminate') {
    destination.hooks.afterRequest = (path, init, result) => {
      if (init.method === 'POST' && /\/(?:commits|reverts)$/.test(path)) {
        committed = result;
        throw new Error('C1 UI synthetic mutation response lost');
      }
    };
  } else if (!local && delivery === 'unchanged') {
    const fetch = destination.client.fetch;
    destination.client.fetch = async (href, init = {}) => {
      if (init.method === 'PATCH' && new URL(href).pathname.includes('/git/refs/heads/')) {
        const proposed = JSON.parse(init.body).sha, parent = destination.repository.refs.get(branch);
        collaborator = destination.github.writeCommit(destination.github.commits.get(proposed).tree, [parent], 'Synthetic independent equivalent change');
        destination.repository.refs.set(branch, collaborator);
        return destination.github.json(409, { message: 'Synthetic independent ref update' });
      }
      return fetch(href, init);
    };
  }
  if (local) backend.trace.length = 0;
  else { backend.calls.length = 0; destination.calls.length = 0; }
  return { ...f, backend, destination, beforeBytes, api, get committed() { return committed; }, get collaborator() { return collaborator; } };
}

for (const transport of ['Local', 'GitHub']) for (const kind of ['parameter', 'policy', 'create', 'copy', 'restore']) {
  const deliveries = transport === 'Local'
    ? ['applied', 'recovery-required', ...(['parameter', 'policy'].includes(kind) ? ['unchanged'] : [])]
    : ['applied', 'unchanged', 'pending', 'indeterminate'];
  for (const delivery of deliveries) {
    test(`C1 UI: ${transport} ${kind} presents real ${delivery} metadata without an implicit second mutation`, async (t) => {
      const f = await transportCaller(t, transport, kind, delivery);
      const before = edits.captureContractEdits(f.state), current = f.state.current;
      const catalog = f.state.catalog, contracts = f.state.contracts;
      const offered = deferred(), show = f.scope.showDialog;
      f.scope.showDialog = (...args) => { const result = show(...args); offered.resolve(args[0]); return result; };
      const work = f.press(await f.begin(kind));
      if (delivery === 'pending') {
        assert.equal(await offered.promise, 'This change needs somewhere to go');
        assert.match(readText(f.dom.modal), new RegExp(f.destination.environment.source.workingBranch));
        await f.press('Leave it for now');
      }
      await work;
      assert.equal(f.calls.filter(([type]) => type === kind).length, 1);
      assert.equal(f.calls.some(([type]) => type === 'branch'), false);
      assert.deepEqual(mutations.active(), []);
      const transportWrites = transport === 'Local'
        ? f.backend.trace.filter(entry => entry.action === 'prepare')
        : f.destination.calls.filter(entry => entry.method === 'POST' && /\/(?:commits|reverts)$/.test(entry.path));
      assert.equal(transportWrites.length, transport === 'Local' && delivery === 'unchanged' ? 0 : 1);
      if (kind === 'copy') assert.deepEqual((await f.backend.provider.read(MAIN)).bytes, f.beforeBytes);
      if (delivery === 'recovery-required') {
        assert.equal(f.results.length, 0, 'Local recovery is a thrown error, not a returned pending result.');
        const error = f.calls.find(([type]) => type === 'error')[2];
        assert.equal(error.code, 'LOCAL_RECOVERY_REQUIRED');
        assert.equal(error.applied, null);
        assert.equal(error.recoveryRequired, true);
        assert(error.transactionId);
        assert.match(f.state.status.message, /Source bytes were retained; inspect History recovery/);
        assert.match(readText(f.dom.modal.querySelector('.modal-status')), /Source bytes were retained/);
        const journal = await f.backend.store.getTransaction(f.destination.environment.id, error.transactionId);
        assert.equal(journal.status, 'failed');
        assert.equal(journal.recoveryRequired, true);
        for (const file of journal.files) assert.equal((await f.destination.provider.read(file.alias)).hash, file.finalHash);
      } else {
        assert.equal(f.results.length, 1);
        const { result, beforePresentation } = f.results[0];
        assert.deepEqual(clone(result), beforePresentation);
        assert.equal(result.outcome, delivery);
        assert.equal(result.applied, delivery === 'applied' ? true : delivery === 'indeterminate' ? null : false);
        assert.equal(result.changed, delivery === 'applied');
        for (const warning of result.warnings || []) assert(f.state.status.message.includes(warning), warning);
        if (delivery === 'applied') {
          assert(result.transactionId);
          assert(result.files.length > 0);
          for (const file of result.files) {
            if (transport === 'GitHub' && kind === 'restore') {
              const entry = await f.destination.provider.entry(file.alias);
              assert.equal(file.sha, entry.sha);
              assert.equal(file.mode, entry.mode);
              assert.equal(file.hash, undefined, 'History inverse receipts expose Git blob identity, not a fabricated SHA-256.');
            } else assert.equal((await f.destination.provider.read(file.alias)).hash, file.hash);
          }
          if (['parameter', 'policy'].includes(kind)) assert.equal(result.archived, result.commit || result.transactionId);
          if (kind === 'create') {
            assert.equal(result.id, 'contracts/new-contract');
            assert.deepEqual(result.created, result.files.map(file => file.alias));
            assert.equal(result.intended, undefined);
          }
          if (transport === 'Local') {
            assert.match(f.state.status.message, /committed journal confirms this save/);
            assert.equal(f.state.status.tone, 'warn');
          }
        } else if (delivery === 'unchanged') {
          assert.doesNotMatch(f.state.status.message, /^(?:Created|Copied|Restored|Saved) /);
          if (transport === 'GitHub') {
            assert.equal(result.commit, null);
            assert.equal(result.author, null);
            assert.equal(result.equivalentCommit, f.collaborator);
            assert.match(f.state.status.message, /No Citadel commit was applied/);
          }
          if (kind === 'create') assert.deepEqual(result.created, []);
          if (['parameter', 'policy'].includes(kind)) assert.equal(result.archived, null);
        } else {
          assert.deepEqual(result.files, []);
          assert.equal(result.hash, undefined);
          if (kind !== 'restore') {
            assert.equal(result.plannedFiles.length, kind === 'create' ? 2 : 1);
            assert(result.plannedFiles.every(file => file.alias && /^[a-f0-9]{64}$/.test(file.hash)));
          }
          if (kind === 'create') {
            assert.equal(result.id, undefined);
            assert.equal(result.created, undefined);
            assert.equal(result.intended.id, 'contracts/new-contract');
            assert(result.plannedFiles.every(file => file.alias.startsWith(`${result.intended.dir}/`)));
          }
          if (['parameter', 'policy'].includes(kind)) assert.equal(result.archived, null);
          if (delivery === 'pending') {
            assert.equal(result.unresolved.intendedBranch, f.destination.environment.source.workingBranch);
            assert.equal(result.unresolved.commit, result.commit);
          } else {
            assert.equal(result.transactionId, f.committed.transactionId);
            assert.equal(result.indeterminate, true);
            assert.match(f.state.status.message, /not confirmed.*History/);
          }
        }
      }
      if (['pending', 'indeterminate', 'recovery-required'].includes(delivery)) {
        assert.deepEqual(edits.captureContractEdits(f.state), before);
        assert.equal(f.state.current, current);
        assert.equal(f.state.catalog, catalog);
        assert.equal(f.state.contracts, contracts);
        assert.equal(f.dom.modal.open, true);
        noCompletionEffects(f);
        if (kind === 'copy') assert.equal(f.sessions[0].locked, true);
      } else {
        assert.equal(f.dom.modal.open, false);
        if (kind === 'parameter') {
          assert.equal(f.state.operations.length, 0);
          assert.equal(f.calls.filter(([type]) => type === 'removeDraft').length, 1);
        } else if (kind === 'policy') {
          assert.deepEqual(clone(f.state.policyChanges), {});
          assert.deepEqual(f.state.operations, before.operations);
        } else assert.deepEqual(edits.captureContractEdits(f.state), before);
        if (kind === 'copy') assert.equal(f.sessions[0].locked, false);
      }
    });
  }
}

for (const refresh of ['contracts', 'deployments']) {
  test(`C1 UI: confirmed creation followed by ${refresh} refresh failure forbids repeating creation`, async () => {
    const f = await fixture(applied(), { local: true });
    f.scope.api[refresh] = async () => { f.calls.push(['failed-refresh', refresh]); throw new Error(`Synthetic ${refresh} read failure`); };
    await f.press(await f.begin('create'));
    assert.equal(f.results[0].result.applied, true);
    assert.equal(f.results[0].result.outcome, 'applied');
    assert.equal(f.calls.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(f.calls.some(([kind]) => kind === 'selectContract'), false);
    assert.equal(f.dom.modal.open, false);
    assert.match(f.state.status.message, /contract.*is confirmed.*could not be refreshed/);
    assert.match(f.state.status.message, /do not create this contract again/);
    assert(f.state.status.message.includes(`Synthetic ${refresh} read failure`));
  });
}

test('C1 UI: History Complete keeps committed receipt metadata and warning visible when its refresh fails', async () => {
  const result = { applied: true, outcome: 'applied', status: 'committed', transactionId: 'prior-transaction',
    committedAt: '2026-09-11T00:00:00.000Z', warnings: ['The terminal audit is still pending. Inspect History before another change.'] };
  const f = await fixture(result, { local: true }), button = await f.begin('complete');
  const before = edits.captureContractEdits(f.state);
  f.scope.api.history = async () => { f.calls.push(['failed-history']); throw new Error('Synthetic History read failure'); };
  await f.press(button);
  assert.equal(f.calls.filter(([kind]) => kind === 'complete').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'failed-history').length, 1);
  assert.deepEqual(f.results[0].result, result);
  assert.deepEqual(edits.captureContractEdits(f.state), before);
  const status = f.dom.modal.querySelector('.modal-status');
  assert.equal(status.hidden, false);
  assert.match(readText(status), /Completed transaction prior-transaction/);
  assert.match(readText(status), /terminal audit is still pending/);
  assert.match(readText(status), /History could not be refreshed.*Synthetic History read failure/);
  assert.equal(f.state.documentNotices.get(MAIN).outcome, true);
});

test('C1 UI: History Complete exposes the production Local recovery error and preserves its review without retry', async () => {
  const error = localRecoveryFailure(new Error('Synthetic receipt unavailable'), 'prior-transaction',
    'Source bytes were retained; inspect History recovery.');
  const f = await fixture(error, { local: true }), button = await f.begin('complete');
  const before = edits.captureContractEdits(f.state);
  await f.press(button);
  assert.equal(f.results.length, 0);
  assert.equal(f.calls.find(([kind]) => kind === 'error')[2], error);
  assert.equal(f.calls.filter(([kind]) => kind === 'complete').length, 1);
  assert.equal(f.calls.filter(([kind]) => kind === 'history').length, 1);
  assert.deepEqual(edits.captureContractEdits(f.state), before);
  assert.equal(f.dom.modal.open, true);
  assert.equal(button.isConnected, true);
  assert.match(readText(f.dom.modal.querySelector('.modal-status')), /Source bytes were retained/);
  assert.doesNotMatch(readText(f.dom.modal.querySelector('.modal-status')), /Completed transaction/);
});

for (const kind of ['parameter', 'policy']) {
  test(`C1 UI: confirmed ${kind} save keeps its receipt but currently replaces reload-error feedback`, async () => {
    const f = await fixture(applied(), { local: true });
    f.scope.documentGeneration = f.state.documentGeneration;
    f.scope.withEditorLoad = (_message, action) => action();
    f.scope.api.contract = async () => {
      f.calls.push(['failed-contract-read']);
      throw new Error('Synthetic confirmed-save source reload failure');
    };
    f.scope.api.accessContractTargets = async () => ({});
    vm.runInNewContext(section('async function loadContract(', 'async function selectContract('), f.scope);
    const current = f.state.current;
    await f.press(await f.begin(kind));
    assert.equal(f.calls.filter(([type]) => type === kind).length, 1);
    assert.equal(f.calls.filter(([type]) => type === 'failed-contract-read').length, 1);
    assert.equal(f.results[0].result.applied, true);
    assert.equal(f.results[0].result.outcome, 'applied');
    assert.equal(f.state.current, current, 'The failed production load did not replace the old source document.');
    const failure = f.statuses.findIndex(status => status.message.includes('Synthetic confirmed-save source reload failure'));
    assert(failure >= 0, 'The load error is reported, rather than thrown out of the caller.');
    assert.equal(f.statuses[failure].tone, 'error');
    assert.equal(f.calls.filter(([type]) => type === 'error').length, 1);
    assert.match(f.state.status.message, /^Saved /);
    assert.doesNotMatch(f.state.status.message, /source reload failure/);
    assert.equal(f.state.documentNotices.get(MAIN).outcome, true);
    assert.match(f.state.documentNotices.get(MAIN).message, /^Saved /);
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
