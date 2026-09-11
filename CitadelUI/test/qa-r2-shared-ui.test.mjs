import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { guardedHandler } from '../web/js/single-flight.mjs';
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
const statusSource = section('async function withStatus(', '/* -------------------------------------------------------------- operations */');
const historySource = section('async function openHistory()', 'async function openEnvironmentCompare(');

test('R2-06 PR comparisons require two actual distinct branches and retain proper branch encoding', () => {
  const scope = { environmentSourceOf };
  vm.runInNewContext(section('function pullRequestUrl(', 'import { createEnvironmentOperation'), scope);
  const environment = (sourceBranch, workingBranch) => ({ source: {
    kind: 'github', fullName: 'synthetic/repository', sourceBranch, workingBranch,
  } });
  assert.equal(scope.pullRequestUrl(environment('main', 'main')), null);
  assert.equal(scope.pullRequestUrl(environment('review', 'review')), null);
  assert.equal(scope.pullRequestUrl(environment('main', undefined)), null);
  assert.equal(scope.pullRequestUrl(environment(undefined, 'review')), null);
  assert.equal(scope.pullRequestUrl(environment('main', 'review/ui')),
    'https://github.com/synthetic/repository/compare/main...review%2Fui?expand=1');
});

async function fixture() {
  const dom = await loadDialogModule(), calls = [], statuses = [], ticket = {};
  const environment = { id: 'qa-history', source: { kind: 'local', folderName: 'synthetic' } };
  const context = { environment };
  const oldContracts = { contracts: [{ id: 'created-contract' }] }, oldCatalog = { files: ['before'] };
  const nextContracts = { contracts: [{ id: 'template', isTemplate: true }] }, nextCatalog = { files: ['template'] };
  const state = {
    workspaceKey: 'qa-history', current: { path: 'contracts/created/main.bicepparam', hash: 'before' },
    operations: [], policyChanges: {}, policyRaw: null, quarantinedDrafts: new Map(),
    contracts: oldContracts, catalog: oldCatalog,
  };
  const scope = {
    structuredClone, ...edits, h, guardedHandler, historyEntry, environmentSourceOf, saveStatusLine, mutationComplete,
    state, activeWorkspace: () => context,
    captureDialogStatus: dom.captureDialogStatus,
    viewStates: { ticket: () => ticket, isCurrent: (value) => value === ticket },
    showModal: dom.showDialog, closeModal: dom.closeDialog, confirmDialog: async () => true,
    writeContextNode: () => h('p', {}, 'Synthetic contract write context'),
    transactionTone: () => 'ok', humanAction: () => 'Created contract', formatTimestamp: () => h('span'),
    setStatus: (message, tone) => { state.status = message ? { message, tone } : null; statuses.push({ message, tone }); },
    reportClientError: (error) => calls.push(['error', error.message]),
    renderSidebar: () => calls.push(['sidebar', state.contracts, state.catalog]),
    renderContextRail: () => calls.push(['rail', state.contracts, state.catalog]),
    selectContract: async (id) => calls.push(['select', id]),
    api: {
      history: async () => ({ transactions: [{
        transactionId: 'created', status: 'committed', action: 'contract-create',
        files: [{ alias: 'contracts/created/main.bicepparam', existed: false }],
      }] }),
      restoreTransaction: async () => ({ applied: true, outcome: 'applied', changed: true, transactionId: 'removed' }),
      contracts: async () => { calls.push(['contracts']); return nextContracts; },
      deployments: async () => { calls.push(['catalog']); return nextCatalog; },
    },
  };
  vm.runInNewContext(statusSource + '\n' + historySource, scope);
  const undo = async () => {
    await scope.openHistory();
    const button = dom.modal.querySelectorAll('button').find((node) => readText(node) === 'Undo creation');
    assert(button);
    for (const handler of button.listeners.get('click') || []) {
      await handler({ target: button, currentTarget: button });
    }
  };
  return { dom, scope, state, calls, statuses, oldContracts, oldCatalog, nextContracts, nextCatalog, undo };
}

test('R2-02 applied History creation undo refreshes both catalogs and both navigation views', async () => {
  const f = await fixture();
  await f.undo();
  assert.equal(f.state.contracts, f.nextContracts);
  assert.equal(f.state.catalog, f.nextCatalog);
  assert.deepEqual(f.calls.filter(([kind]) => ['contracts', 'catalog'].includes(kind)).map(([kind]) => kind),
    ['contracts', 'catalog']);
  for (const kind of ['sidebar', 'rail']) {
    const paint = f.calls.find(([name]) => name === kind);
    assert.equal(paint[1], f.nextContracts);
    assert.equal(paint[2], f.nextCatalog);
  }
});

test('R2-02 an unconfirmed undo must not refresh catalogs or change the selected source', async () => {
  const f = await fixture();
  f.scope.api.restoreTransaction = async () => ({ applied: false, outcome: 'unconfirmed', changed: false });
  await f.undo();
  assert.equal(f.state.contracts, f.oldContracts);
  assert.equal(f.state.catalog, f.oldCatalog);
  assert.equal(f.calls.some(([kind]) => ['contracts', 'catalog', 'select'].includes(kind)), false);
});

test('R2-02 a second catalog read failure keeps both old lists and reports the completed removal honestly', async () => {
  const f = await fixture();
  f.scope.api.deployments = async () => { throw new Error('Synthetic catalog read failed'); };
  await f.undo();
  assert.equal(f.state.contracts, f.oldContracts);
  assert.equal(f.state.catalog, f.oldCatalog);
  assert(f.statuses.some(({ message }) => message?.includes('Removed the committed contract creation') &&
    message.includes('do not repeat the removal')));
  assert.equal(f.calls.some(([kind]) => kind === 'select'), false);
});

test('R2-02 late catalog refresh does not replace a subsequently selected document', async () => {
  const f = await fixture();
  const nextDocument = { path: 'another.bicepparam', hash: 'another' };
  f.scope.api.deployments = async () => { f.state.current = nextDocument; return f.nextCatalog; };
  await f.undo();
  assert.equal(f.state.current, nextDocument);
  assert.equal(f.state.catalog, f.nextCatalog);
  assert.equal(f.calls.some(([kind]) => kind === 'select'), false);
});

test('R2-05 withStatus exposes a failed save in its original modal while leaving the retry action intact', async () => {
  const f = await fixture();
  const retry = h('button', {}, 'Save changes');
  f.dom.showDialog('Review changes', h('p', {}, 'Synthetic write context'), [retry]);
  assert.equal(await f.scope.withStatus('Saving', async () => { throw new Error('Synthetic pre-write failure'); }), undefined);
  const notice = f.dom.modal.querySelector('.modal-status');
  assert.equal(notice.hidden, false);
  assert.match(readText(notice), /Synthetic pre-write failure/);
  assert.equal(f.dom.modal.open, true);
  assert.equal(retry.isConnected, true);
  f.dom.closeDialog();
});
