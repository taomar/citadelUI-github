import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { h, mount } from '../web/js/dom.mjs';

const source = await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, `Missing application section: ${start}`);
  return source.slice(first, last);
}

// Exercise the actual shell handlers without booting authentication or adding
// production test exports to the self-starting application module.
const handlers = [
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
  section('function areaButton(', 'async function restoreContract('),
  section('function openCreateContract()', 'async function loadContract('),
  section('async function selectContract(', '/* ------------------------------------------------------------------- policy */'),
].join('\n');
const root = 'bicep/infra/citadel-access-contracts';
const parameter = (name) => `${root}/contracts/${name}/main.bicepparam`;
const file = (path) => ({ path, name: path.split('/').at(-1) });
const entry = (id, path) => ({ id, name: id, paramFile: path, dir: path.slice(0, path.lastIndexOf('/')), paramCount: 1, hasPolicy: true });

async function fixture({ failure = null, pauseCatalog = null, cancelSelection = false } = {}) {
  const dom = await loadDialogModule();
  const sidebar = dom.node('nav'), rail = dom.node('aside');
  dom.root.append(sidebar, rail);
  const sourceFiles = [
    file('bicep/infra/main.bicepparam'), file('bicep/infra/llm-backend-onboarding/main.bicepparam'),
    file(`${root}/main.bicepparam`), file(parameter('finance')), file(parameter('research')),
  ];
  const sourceContracts = [
    { ...entry('__template', `${root}/main.bicepparam`), isTemplate: true },
    entry('contracts/finance', parameter('finance')), entry('contracts/research', parameter('research')),
  ];
  const catalog = () => ({ files: [...sourceFiles] });
  const contracts = () => ({ root, parent: 'contracts', contracts: [...sourceContracts] });
  const state = {
    areas: [
      { id: 'deployment', title: 'Azure Deployment', path: sourceFiles[0].path },
      { id: 'onboarding', title: 'LLM Onboarding', path: sourceFiles[1].path },
      { id: 'access', title: 'Access Contracts', kind: 'contracts', path: `${root}/contracts` },
    ],
    area: 'access', catalog: catalog(), contracts: contracts(), contractId: 'contracts/finance',
    current: { path: parameter('finance') }, filter: '/contracts/', showAll: true,
    operations: [{ op: 'set', path: ['label'], value: 'retained draft' }],
    policyChanges: { retained: true }, open: new Map([['retained', true]]), status: null,
  };
  const retained = { areas: state.areas, operations: state.operations, policyChanges: state.policyChanges, open: state.open };
  const calls = [], selections = [], statuses = [];
  let view;
  const render = () => { view.renderSidebar(); mount(rail, view.contractList()); };
  const setStatus = (message, tone) => {
    state.status = message ? { message, tone } : null;
    if (message) statuses.push({ message, tone });
  };
  const api = {
    async createContract({ name }) {
      calls.push(`create:${name}`);
      if (failure === 'create') throw new Error('Create transaction refused.');
      const id = `contracts/${name}`, path = parameter(name);
      if (sourceContracts.some((contract) => contract.id === id)) throw new Error('Contract already exists.');
      sourceFiles.push(file(path));
      sourceContracts.push(entry(id, path));
      return { id, dir: `${root}/contracts/${name}` };
    },
    async contracts() {
      calls.push('contracts');
      if (failure === 'contracts') throw new Error('Contract discovery unavailable.');
      return contracts();
    },
    async deployments() {
      calls.push('catalog');
      if (pauseCatalog) await pauseCatalog;
      if (failure === 'catalog') throw new Error('Parameter discovery unavailable.');
      return catalog();
    },
  };
  view = runInNewContext(`${handlers}\n({ openCreateContract, renderSidebar, contractList });`, {
    state, api, h, mount, render, COMPACT_NAV: { matches: false }, els: { sidebar },
    requestAnimationFrame: (fn) => fn(), selectArea() {}, openOther() {},
    showModal: dom.showDialog, closeModal: dom.closeDialog,
    writeContextNode: () => h('p', {}, 'Synthetic local workspace'),
    setStatus, choosePendingNavigation: async () => 'keep',
    applyPendingNavigation: async () => !cancelSelection,
    async loadContract(id) {
      for (const [key, value] of Object.entries(retained)) assert.equal(state[key], value, key);
      assert.equal(state.filter, '/contracts/');
      assert.equal(state.showAll, true);
      assert.equal(state.area, 'access');
      assert(state.contracts.contracts.some((contract) => contract.id === id));
      if (failure === 'load') {
        setStatus('Contract could not be opened.', 'error');
        return false;
      }
      selections.push(id);
      state.contractId = id;
      state.current = { path: parameter(id.split('/').at(-1)) };
      render();
      return true;
    },
  });
  render();
  const action = (label) => dom.modal.querySelectorAll('button').find((button) => readText(button) === label);
  const press = async (label) => {
    const button = action(label);
    assert(button && !button.disabled, label);
    for (const handler of button.listeners.get('click') || []) await handler({ target: button, currentTarget: button });
  };
  const open = (name) => {
    view.openCreateContract();
    const input = dom.modal.querySelectorAll('input').find((node) => node.id === 'new-contract-name');
    input.value = name;
    input.dispatch('input');
  };
  const count = () => readText(sidebar.querySelector('.all-deployments').querySelector('summary'));
  const paths = () => sidebar.querySelectorAll('.nav-meta').map(readText);
  return { dom, state, calls, selections, statuses, sourceFiles, sourceContracts, retained, open, press, count, paths };
}

test('contract creation refreshes the full catalog and count immediately after each of five creates', async () => {
  const f = await fixture();
  const names = ['qa-sales', 'qa-helpdesk', 'qa-engineering', 'qa-research', 'qa-operations'];
  assert.equal(f.count(), 'All parameter files (5)');
  for (const [index, name] of names.entries()) {
    f.open(name);
    await f.press('Create');
    assert.equal(f.dom.modal.open, false);
    assert.equal(f.count(), `All parameter files (${6 + index})`);
    assert.deepEqual(f.state.catalog.files.map((item) => item.path), f.sourceFiles.map((item) => item.path));
    assert.deepEqual(f.paths(), f.sourceFiles.filter((item) => item.path.includes('/contracts/')).map((item) => item.path));
    assert.equal(new Set(f.paths()).size, f.paths().length);
    assert.equal(f.state.contractId, `contracts/${name}`);
    assert.equal(f.state.current.path, parameter(name));
  }
  assert.deepEqual(f.calls, names.flatMap((name) => [`create:${name}`, 'contracts', 'catalog']));
  assert.deepEqual(f.selections, names.map((name) => `contracts/${name}`));
  assert.equal(f.state.catalog.files.length, 10);
  assert.equal(f.state.contracts.contracts.length, 8);
});

test('cancelling or leaving a blank contract name never changes catalog entries or count', async () => {
  const f = await fixture();
  const catalog = f.state.catalog, contracts = f.state.contracts;
  f.open('cancelled');
  await f.press('Cancel');
  assert.equal(f.dom.modal.open, false);
  f.open('   ');
  await f.press('Create');
  assert.equal(f.dom.modal.open, true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.catalog, catalog);
  assert.equal(f.state.contracts, contracts);
  assert.equal(f.count(), 'All parameter files (5)');
});

test('failed contract creation preserves the catalog, current selection and error', async () => {
  const f = await fixture({ failure: 'create' });
  const catalog = f.state.catalog, contracts = f.state.contracts;
  f.open('failed');
  await f.press('Create');
  assert.deepEqual(f.calls, ['create:failed']);
  assert.equal(f.state.catalog, catalog);
  assert.equal(f.state.contracts, contracts);
  assert.equal(f.state.contractId, 'contracts/finance');
  assert.equal(f.count(), 'All parameter files (5)');
  assert.equal(f.state.status.tone, 'error');
  assert.equal(f.state.status.message, 'Create transaction refused.');
});

for (const failure of ['contracts', 'catalog']) {
  test(`${failure} refresh failure reports already-created files without a false success or partial list update`, async () => {
    const f = await fixture({ failure });
    const catalog = f.state.catalog, contracts = f.state.contracts;
    f.open('created-but-unlisted');
    await f.press('Create');
    assert.equal(f.dom.modal.open, false);
    assert.equal(f.sourceFiles.length, 6, 'creation succeeded; refresh failure must not remove its files');
    assert.equal(f.state.catalog, catalog);
    assert.equal(f.state.contracts, contracts);
    assert.equal(f.count(), 'All parameter files (5)');
    assert.deepEqual(f.selections, []);
    assert.equal(f.state.status.tone, 'error');
    assert.match(f.state.status.message, /Created .*created-but-unlisted.*could not refresh/i);
    assert.match(f.state.status.message, /discovery unavailable/);
    assert.match(f.state.status.message, /reopen.*workspace.*do not create.*again/i);
    assert.equal(f.statuses.some((status) => status.tone === 'ok'), false);
  });
}

test('contract and parameter catalogs publish together only after the existing discovery reads finish', async () => {
  let finish;
  const pauseCatalog = new Promise((resolve) => { finish = resolve; });
  const f = await fixture({ pauseCatalog });
  const catalog = f.state.catalog, contracts = f.state.contracts;
  f.open('delayed');
  const pending = f.press('Create');
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ['create:delayed', 'contracts', 'catalog']);
  assert.equal(f.state.catalog, catalog);
  assert.equal(f.state.contracts, contracts);
  assert.deepEqual(f.selections, []);
  finish();
  await pending;
  assert.equal(f.count(), 'All parameter files (6)');
  assert.equal(f.state.contractId, 'contracts/delayed');
});

for (const options of [{ cancelSelection: true }, { failure: 'load' }]) {
  test(`the refreshed count and list render even when opening the new contract ${options.cancelSelection ? 'is cancelled' : 'fails'}`, async () => {
    const f = await fixture(options);
    f.open('created-not-opened');
    await f.press('Create');
    assert.equal(f.count(), 'All parameter files (6)');
    assert(f.paths().includes(parameter('created-not-opened')));
    assert.equal(f.state.contractId, 'contracts/finance');
    assert.equal(f.state.current.path, parameter('finance'));
    for (const [key, value] of Object.entries(f.retained)) assert.equal(f.state[key], value, key);
    assert.deepEqual(f.selections, []);
    assert.equal(f.statuses.some((status) => status.tone === 'ok'), false);
    if (options.failure) assert.equal(f.state.status.message, 'Contract could not be opened.');
  });
}
