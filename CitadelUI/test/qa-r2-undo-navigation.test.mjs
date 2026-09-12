import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { h, mount, clear } from '../web/js/dom.mjs';
import { renderValue } from '../web/js/fields.mjs';
import { guardedHandler } from '../web/js/single-flight.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { createDocumentActions } from '../web/js/document-action.mjs';
import { historyEntry } from '../web/js/history-entry.mjs';
import { environmentSourceOf } from '../web/js/registry.mjs';
import { saveStatusLine } from '../web/js/save-resolution.mjs';
import { mutationComplete } from '../shared/mutation-outcome.mjs';
import * as edits from '../web/js/contract-edit-state.mjs';

const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const handlers = [
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
  section('function matchesFilter(', '/* ---------------------------------------------------------------- contracts */'),
  section('function contractList()', 'async function restoreContract('),
  section('function renderContextRail()', '/**\n * Keep the rail'),
  section('async function openHistory()', 'async function openEnvironmentCompare('),
].join('\n');
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function fixture(t, { holdResult = false } = {}) {
  const local = await nativeLocalFixture({
    environmentId: 'r2-02-undo-owner',
    configuration: createConfiguration('bicep'),
    onlyFiles: Object.fromEntries(Object.entries(citadelRepositoryFiles()).filter(([, value]) => typeof value === 'string')),
  });
  t.after(local.close);
  const beta = await local.service.createContract({ name: 'beta' });
  const created = await local.service.createContract({ name: 'undo-created' });
  const contract = await local.service.contract(created.id);
  const dom = await loadDialogModule(), calls = [], delivered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const originalBytes = new Map(local.root.allFiles().map(({ path, bytes }) => [path, bytes.slice()]));
  const els = { shell: dom.node(), workspace: dom.node('main'), sidebar: dom.node('nav'), contextRail: dom.node('aside') };
  dom.root.append(els.workspace, els.sidebar, els.contextRail);
  const state = {
    current: contract.param, contract, contractId: created.id, documentGeneration: 1,
    contracts: await local.service.contracts(), catalog: await local.service.deployments(),
    operations: [], parameterInputs: {}, inputScope: {}, policyChanges: {}, policyRaw: null, quarantinedDrafts: new Map(),
    area: 'access-contracts', areas: [{ id: 'access-contracts', kind: 'contracts', title: 'Access contracts' }],
    tab: 'params', filter: '', showAll: true,
  };
  const viewStates = new WorkspaceViewState(() => state);
  viewStates.activate(local.context);
  const navigate = async (id) => {
    const next = await local.service.contract(id);
    state.current = next.param;
    state.contract = next;
    state.contractId = id;
    state.documentGeneration += 1;
    scope.renderSidebar();
    scope.renderContextRail();
    return true;
  };
  const scope = {
    structuredClone, Map, h, mount, clear, guardedHandler, ...edits, state, viewStates, els,
    historyEntry, environmentSourceOf, saveStatusLine, mutationComplete,
    COMPACT_NAV: { matches: false }, SECTIONS_IN_RAIL: { matches: false },
    areaButton: () => h('button', {}, 'Access contracts'), railDoc: () => state.current,
    openCreateContract() { assert.fail('Undo must not open creation'); },
    activeWorkspace: () => local.context, captureDialogStatus: dom.captureDialogStatus,
    showModal: dom.showDialog, closeModal: dom.closeDialog, confirmDialog: async () => true,
    writeContextNode: () => h('p', {}, 'Synthetic Undo source'), transactionTone: () => 'ok',
    humanAction: () => 'Create contract', formatTimestamp: () => h('span'),
    reportClientError: (error) => calls.push(['error', error.message]),
    setStatus: (message, tone) => { state.status = message ? { message, tone } : null; },
    selectContract: async (id) => { calls.push(['fallback', id]); return navigate(id); },
    api: {
      history: async () => ({ transactions: (await local.store.history(local.environment.id))
        .filter(row => row.transactionId === created.transactionId) }),
      restoreTransaction: async (id) => {
        calls.push(['restore', id]);
        const result = await local.service.restoreTransaction(id);
        delivered.resolve(result);
        if (holdResult) await release.promise;
        return result;
      },
      contracts: () => { calls.push(['contracts']); return local.service.contracts(); },
      deployments: () => { calls.push(['catalog']); return local.service.deployments(); },
    },
  };
  scope.documentActions = createDocumentActions({
    views: viewStates, currentOwner: () => scope.state, setStatus: scope.setStatus,
  });
  vm.runInNewContext(handlers, scope);
  for (const [method, kind] of [['renderSidebar', 'sidebar'], ['renderContextRail', 'rail']]) {
    const render = scope[method];
    scope[method] = () => { calls.push([kind]); return render(); };
    scope[method]();
  }
  calls.length = 0;
  local.root.owner.trace.length = 0;
  const undo = async () => {
    await scope.openHistory();
    const button = dom.modal.querySelectorAll('button').find(node => readText(node) === 'Undo creation');
    assert(button);
    for (const handler of button.listeners.get('click') || []) await handler({ target: button, currentTarget: button });
  };
  const assertRemoved = async () => {
    const remaining = local.root.allFiles(), aliases = remaining.map(row => row.path);
    for (const alias of created.created) assert(!aliases.includes(alias), `Created source removed: ${alias}`);
    assert(aliases.includes(`${beta.dir}/main.bicepparam`));
    assert.equal(remaining.length, originalBytes.size - created.created.length);
    for (const file of remaining) assert.deepEqual(file.bytes, originalBytes.get(file.path), `Untouched source: ${file.path}`);
    assert.equal((await local.store.getTransaction(local.environment.id, created.transactionId)).status, 'rolled_back');
    assert.equal(calls.filter(([kind]) => kind === 'restore').length, 1);
    assert.equal(local.root.owner.trace.some(({ operation }) => ['createWritable', 'write', 'close'].includes(operation)), false);
  };
  const assertRemovedAndRefreshed = async () => {
    await assertRemoved();
    assert(!state.catalog.files.some(row => row.path.startsWith(`${created.dir}/`)));
    assert(!state.contracts.contracts.some(row => row.id === created.id));
    assert.deepEqual(state.catalog.files.map(row => row.path), (await local.service.deployments()).files.map(row => row.path));
    assert.deepEqual(state.contracts.contracts.map(row => row.id), (await local.service.contracts()).contracts.map(row => row.id));
    assert.equal(readText(els.sidebar.querySelectorAll('summary')[1]), `All parameter files (${state.catalog.files.length})`);
    assert(!readText(els.sidebar).includes(created.dir));
    const renderedDirectories = els.contextRail.querySelectorAll('.contract-name').map(node => node.getAttribute('title'));
    assert.deepEqual(renderedDirectories, state.contracts.contracts.map(row => row.dir));
    assert(!renderedDirectories.includes(created.dir));
    assert(renderedDirectories.includes(beta.dir));
    assert(calls.some(([kind]) => kind === 'sidebar'));
    assert(calls.some(([kind]) => kind === 'rail'));
    assert.equal(calls.filter(([kind]) => kind === 'contracts').length, 1);
    assert.equal(calls.filter(([kind]) => kind === 'catalog').length, 1);
  };
  const editBeta = () => {
    const path = ['productTerms'];
    state.operations = [{ op: 'set', path, value: 'newer Beta draft' }];
    const view = renderValue('newer Beta draft', path, {
      inputOwner: state.inputScope,
      inputDraft: at => edits.parameterInput(state, at),
      onInputDraft: (at, input) => edits.setParameterInput(state, at, input),
      onChange() { assert.fail('Undo must not commit the unblurred Beta field'); },
    }, { type: 'string', name: 'productTerms' });
    els.workspace.append(view);
    const input = view.matches('input, textarea') ? view : view.querySelector('input, textarea');
    input.focus();
    input.value = 'unblurred Beta draft';
    input.setSelectionRange(3, 10, 'backward');
    input.dispatch('input');
    return input;
  };
  return { ...local, beta, created, state, scope, dom, els, calls, originalBytes, undo, navigate, editBeta,
    delivered, release, assertRemoved, assertRemovedAndRefreshed };
}

test('R2-02 corrective: same-view actual creation Undo still removes source, refreshes catalogs and selects the template', async (t) => {
  const f = await fixture(t);
  await f.undo();
  await f.assertRemovedAndRefreshed();
  assert.equal(f.state.contractId, '__template');
  assert.equal(f.calls.filter(([kind]) => kind === 'fallback').length, 1);
});

test('R2-02 corrective: held actual Undo receipt cannot navigate Beta back to the template', async (t) => {
  const f = await fixture(t, { holdResult: true });
  const undo = f.undo();
  const result = await f.delivered.promise;
  assert.equal(result.applied, true);
  assert.equal(result.outcome, 'applied');
  assert(f.created.created.every(alias => !f.root.allFiles().some(row => row.path === alias)));
  f.dom.closeDialog();
  await f.navigate(f.beta.id);
  const document = f.state.current, contract = f.state.contract, generation = f.state.documentGeneration;
  const input = f.editBeta(), operations = f.state.operations, inputs = f.state.parameterInputs;
  f.release.resolve();
  await undo;
  await f.assertRemovedAndRefreshed();
  assert.equal(f.state.current, document, 'A completed Undo may not replace the subsequently selected document');
  assert.equal(f.state.contract, contract);
  assert.equal(f.state.contractId, f.beta.id);
  assert.equal(f.state.documentGeneration, generation);
  assert.equal(f.state.operations, operations);
  assert.equal(f.state.parameterInputs, inputs);
  assert.equal(edits.editorPendingCount(f.state), 1, 'Queued and unblurred versions of one field count once.');
  assert.equal(globalThis.document.activeElement, input);
  assert.equal(input.isConnected, true);
  assert.equal(input.value, 'unblurred Beta draft');
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [3, 10, 'backward']);
  assert.equal(readText(f.els.contextRail.querySelector('summary')), `Contract: ${contract.name}`);
  assert.equal(f.calls.some(([kind]) => kind === 'fallback'), false);
});

test('R2-02 corrective: a newer view generation retires fallback even when the document object is reused', async (t) => {
  const f = await fixture(t, { holdResult: true });
  const undo = f.undo();
  await f.delivered.promise;
  f.state.documentGeneration += 1;
  const document = f.state.current;
  f.release.resolve();
  await undo;
  await f.assertRemovedAndRefreshed();
  assert.equal(f.state.current, document);
  assert.equal(f.calls.some(([kind]) => kind === 'fallback'), false);
});

test('C1 UI: creation Undo captures document ownership before its delayed confirmation', async (t) => {
  const f = await fixture(t), entered = deferred(), confirmation = deferred();
  t.after(() => confirmation.resolve(false));
  f.scope.confirmDialog = () => { entered.resolve(); return confirmation.promise; };
  const undo = f.undo();
  await entered.promise;
  assert.equal(f.calls.some(([kind]) => kind === 'restore'), false);
  f.dom.closeDialog();
  await f.navigate(f.beta.id);
  const input = f.editBeta(), snapshot = edits.captureContractEdits(f.state), current = f.state.current;
  confirmation.resolve(true);
  await undo;
  await f.assertRemovedAndRefreshed();
  assert.equal(f.state.current, current);
  assert.deepEqual(edits.captureContractEdits(f.state), snapshot);
  assert.equal(document.activeElement, input);
  assert.equal(input.isConnected, true);
  assert.equal(input.value, 'unblurred Beta draft');
  assert.equal(f.calls.some(([kind]) => kind === 'fallback'), false);
});

test('C1 UI: creation Undo refuses changed source without deletion, catalog refresh or a second mutation', async (t) => {
  const f = await fixture(t), alias = f.created.created[0];
  const file = await f.provider.fileHandle(alias);
  file.change(new Uint8Array([...file.bytes, 10]));
  const before = f.root.allFiles().map(({ path, bytes }) => ({ path, bytes: bytes.slice() }));
  const current = f.state.current, catalog = f.state.catalog, contracts = f.state.contracts;
  await f.undo();
  assert.deepEqual(f.root.allFiles(), before);
  assert.equal(f.state.current, current);
  assert.equal(f.state.catalog, catalog);
  assert.equal(f.state.contracts, contracts);
  assert.equal(f.calls.filter(([kind]) => kind === 'restore').length, 1);
  assert.equal(f.calls.some(([kind]) => ['catalog', 'contracts', 'fallback'].includes(kind)), false);
  assert.equal(f.root.owner.trace.some(({ operation }) => operation === 'removeEntry'), false);
  assert.equal((await f.store.getTransaction(f.environment.id, f.created.transactionId)).status, 'committed');
  assert.equal(f.dom.modal.open, true);
  assert.equal(f.dom.modal.querySelector('.modal-status').hidden, false);
  assert.match(readText(f.dom.modal.querySelector('.modal-status')), /changed|match/i);
});

test('C1 UI: a lost actual Undo result reports to its old document without retrying or stealing Beta input', async (t) => {
  const f = await fixture(t, { holdResult: true });
  const undo = f.undo();
  await f.delivered.promise;
  const originalPath = f.state.current.path;
  f.dom.closeDialog();
  await f.navigate(f.beta.id);
  const input = f.editBeta(), snapshot = edits.captureContractEdits(f.state);
  const catalog = f.state.catalog, contracts = f.state.contracts;
  f.release.reject(new Error('Synthetic Undo result delivery failed after deletion'));
  await undo;
  await f.assertRemoved();
  assert.deepEqual(edits.captureContractEdits(f.state), snapshot);
  assert.equal(f.state.contractId, f.beta.id);
  assert.equal(document.activeElement, input);
  assert.equal(input.isConnected, true);
  assert.equal(input.value, 'unblurred Beta draft');
  assert.equal(f.state.catalog, catalog, 'An undelivered outcome does not authorize a completion refresh.');
  assert.equal(f.state.contracts, contracts);
  assert.equal(f.calls.some(([kind]) => ['catalog', 'contracts', 'fallback'].includes(kind)), false);
  assert.match(f.state.documentNotices.get(originalPath).message, /result delivery failed after deletion/);
});
