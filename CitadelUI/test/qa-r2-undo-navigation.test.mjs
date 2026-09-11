import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { citadelRepositoryFiles } from './_citadel-fixture.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { h } from '../web/js/dom.mjs';
import { guardedHandler } from '../web/js/single-flight.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
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
  section('async function openHistory()', 'async function openEnvironmentCompare('),
].join('\n');
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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
  const state = {
    current: contract.param, contract, contractId: created.id, documentGeneration: 1,
    contracts: await local.service.contracts(), catalog: await local.service.deployments(),
    operations: [], parameterInputs: {}, policyChanges: {}, policyRaw: null, quarantinedDrafts: new Map(),
  };
  const viewStates = new WorkspaceViewState(() => state);
  viewStates.activate(local.context);
  const navigate = async (id) => {
    const next = await local.service.contract(id);
    state.current = next.param;
    state.contract = next;
    state.contractId = id;
    state.documentGeneration += 1;
    return true;
  };
  const scope = {
    structuredClone, Map, h, guardedHandler, ...edits, state, viewStates,
    historyEntry, environmentSourceOf, saveStatusLine, mutationComplete,
    activeWorkspace: () => local.context, captureDialogStatus: dom.captureDialogStatus,
    showModal: dom.showDialog, closeModal: dom.closeDialog, confirmDialog: async () => true,
    writeContextNode: () => h('p', {}, 'Synthetic Undo source'), transactionTone: () => 'ok',
    humanAction: () => 'Create contract', formatTimestamp: () => h('span'),
    reportClientError: (error) => calls.push(['error', error.message]),
    setStatus: (message, tone) => { state.status = message ? { message, tone } : null; },
    renderSidebar: () => calls.push(['sidebar', state.catalog.files.map(row => row.path)]),
    renderContextRail: () => calls.push(['rail', state.contracts.contracts.map(row => row.id)]),
    selectContract: async (id) => { calls.push(['fallback', id]); return navigate(id); },
    api: {
      history: async () => ({ transactions: (await local.store.history(local.environment.id))
        .filter(row => row.transactionId === created.transactionId) }),
      restoreTransaction: async (id) => {
        const result = await local.service.restoreTransaction(id);
        delivered.resolve(result);
        if (holdResult) await release.promise;
        return result;
      },
      contracts: () => local.service.contracts(),
      deployments: () => local.service.deployments(),
    },
  };
  vm.runInNewContext(handlers, scope);
  const undo = async () => {
    await scope.openHistory();
    const button = dom.modal.querySelectorAll('button').find(node => readText(node) === 'Undo creation');
    assert(button);
    for (const handler of button.listeners.get('click') || []) await handler({ target: button, currentTarget: button });
  };
  const assertRemovedAndRefreshed = async () => {
    const aliases = local.root.allFiles().map(row => row.path);
    for (const alias of created.created) assert(!aliases.includes(alias), `Created source removed: ${alias}`);
    assert(aliases.includes(`${beta.dir}/main.bicepparam`));
    assert(!state.catalog.files.some(row => row.path.startsWith(`${created.dir}/`)));
    assert(!state.contracts.contracts.some(row => row.id === created.id));
    assert.equal(state.catalog.files.length, (await local.service.deployments()).files.length);
    assert(calls.some(([kind]) => kind === 'sidebar'));
    assert(calls.some(([kind]) => kind === 'rail'));
    assert.equal((await local.store.getTransaction(local.environment.id, created.transactionId)).status, 'rolled_back');
  };
  return { ...local, beta, created, state, scope, dom, calls, undo, navigate, delivered, release, assertRemovedAndRefreshed };
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
  const operations = f.state.operations = [{ op: 'set', path: ['productTerms'], value: 'newer Beta draft' }];
  const inputs = f.state.parameterInputs = { '["productTerms"]': { path: ['productTerms'], value: 'unblurred Beta draft' } };
  f.release.resolve();
  await undo;
  await f.assertRemovedAndRefreshed();
  assert.equal(f.state.current, document, 'A completed Undo may not replace the subsequently selected document');
  assert.equal(f.state.contract, contract);
  assert.equal(f.state.contractId, f.beta.id);
  assert.equal(f.state.documentGeneration, generation);
  assert.equal(f.state.operations, operations);
  assert.equal(f.state.parameterInputs, inputs);
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
