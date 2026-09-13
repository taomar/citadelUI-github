import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { appSection, shellHarness } from './fixtures/ui-review/shell-harness.mjs';
import { readText } from './_dom-stub.mjs';
import { h, clear } from '../web/js/dom.mjs';
import { createDocumentActions } from '../web/js/document-action.mjs';

async function fixture() {
  const f = await shellHarness({ state: { catalog: { files: [
    { name: 'finance.bicepparam', path: 'synthetic/finance.bicepparam' },
    { name: 'research.bicepparam', path: 'synthetic/research.bicepparam' },
  ] } } });
  const timers = new Map(), listeners = new Map(), historyCalls = [];
  f.els.status = h('div');
  f.els.modal = f.dom.modal;
  f.dom.root.append(f.els.status);
  f.els.workspace.prepend = (...nodes) => {
    const previous = [...f.els.workspace.children];
    f.els.workspace.append(...nodes);
    f.els.workspace.children = [...nodes, ...previous];
  };
  Object.assign(f.scope, {
    clear, COMPACT_NAV: { matches: false },
    selectArea() {}, openOther() {}, openShellMenu: null, closeShellMenu() {},
    reportClientError: (error, ...details) => f.calls.push(['error', error?.code || error?.message || null, ...details]),
    setTimeout: (callback) => { const key = {}; timers.set(key, callback); return key; },
    clearTimeout: (key) => timers.delete(key),
    window: { addEventListener: (type, callback) => listeners.set(type, callback) },
    history: {
      state: { view: 'workspace' },
      replaceState: (...args) => historyCalls.push(['replace', ...args]),
      pushState: (...args) => historyCalls.push(['push', ...args]),
    },
  });
  document.querySelector = (selector) => f.dom.root.querySelector(selector);
  vm.runInContext([
    appSection('let pendingSince =', 'function currentWriteContext('),
    appSection('function areaButton(', 'function contractList('),
    appSection('function wireShellNavigation()', 'async function init()'),
  ].join('\n'), f.scope);
  f.scope.viewStates.createState = f.scope.createEditorState;
  f.scope.documentActions = createDocumentActions({
    views: f.scope.viewStates, currentOwner: () => f.scope.state, setStatus: f.scope.setStatus,
  });
  return { ...f, timers, listeners, historyCalls };
}

test('shell correction SH01: ordinary skip prevents only its native fragment action and retains the editor', async () => {
  const f = await fixture();
  const skip = h('a', { class: 'skip-link', href: '#workspace' }, 'Skip to workspace');
  f.dom.root.append(skip);
  f.owner.operations = [{ op: 'set', path: ['value'], value: 'retained draft' }];
  f.scope.wireShellNavigation();
  skip.focus();
  const event = skip.dispatch('click', { button: 0 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.activeElement, f.els.workspace);
  assert.equal(f.els.shell.dataset.workspace, 'active');
  assert.equal(f.owner.operations[0].value, 'retained draft');
  assert.deepEqual(f.historyCalls, []);
  assert.deepEqual(f.calls, []);
});

test('shell correction SH01: modified skip actions remain native and genuine history events still use the consent path', async () => {
  const f = await fixture(), destinations = [];
  const skip = h('a', { class: 'skip-link', href: '#workspace' }, 'Skip to workspace');
  f.dom.root.append(skip);
  f.scope.returnToSetup = () => { destinations.push('consent'); return false; };
  f.scope.wireShellNavigation();
  for (const variation of [{ button: 1 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    skip.focus();
    assert.equal(skip.dispatch('click', { button: 0, ...variation }).defaultPrevented, false);
    assert.equal(document.activeElement, skip);
  }
  skip.dispatch('click', { button: 0, defaultPrevented: true });
  assert.equal(document.activeElement, skip);
  assert.deepEqual(destinations, []);
  // These are independent history events, not invented defaults after a prevented click.
  f.listeners.get('popstate')({ state: { view: 'setup' } });
  f.listeners.get('popstate')({ state: null });
  assert.deepEqual(destinations, ['consent', 'consent']);
  assert.deepEqual(f.historyCalls, []);
});

test('shell correction SH02: composing search keeps its connected node and range until the native commit', async () => {
  const f = await fixture();
  f.scope.renderSidebar();
  const input = f.els.sidebar.querySelector('input');
  input.focus();
  input.dispatch('compositionstart');
  input.value = 'fin';
  input.setSelectionRange(3, 3);
  input.dispatch('input', { isComposing: true });
  f.scope.renderSidebar();
  assert.equal(f.els.sidebar.querySelector('input'), input);
  assert.equal(input.isConnected, true);
  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'fin');
  assert.equal(input.selectionStart, 3);
  assert.equal(f.owner.filter, 'fin');
  input.value = 'finance';
  input.setSelectionRange(7, 7);
  input.dispatch('compositionend');
  input.dispatch('input', { isComposing: false });
  assert.equal(f.owner.filter, 'finance');
  assert.equal(f.els.sidebar.querySelectorAll('.nav-item').length, 1);
  f.scope.renderSidebar();
  const committed = f.els.sidebar.querySelector('input');
  assert.equal(committed.value, 'finance');
  assert.equal(committed.selectionStart, 7);
  assert.equal(document.activeElement, committed);
});

for (const change of ['repaint', 'document', 'generation', 'workspace']) {
  test(`shell correction SH04: synthetic retired search and disclosure events cannot mutate the ${change} successor`, async () => {
    const f = await fixture();
    f.scope.renderSidebar();
    const old = f.els.sidebar.querySelector('input'), oldDisclosure = f.els.sidebar.querySelector('.all-deployments');
    if (change === 'document') f.owner.current = { path: 'synthetic/next.bicepparam' };
    if (change === 'generation') f.owner.documentGeneration++;
    if (change === 'workspace') {
      f.scope.state = f.scope.viewStates.activate({ projectId: 'next', environment: { id: 'next' } });
      f.scope.state.catalog = { files: [...f.owner.catalog.files] };
    }
    const successor = f.scope.state;
    successor.filter = 'finance';
    successor.showAll = true;
    f.scope.renderSidebar();
    const current = f.els.sidebar.querySelector('input');
    current.focus();
    current.setSelectionRange(1, 5, 'backward');
    const before = readText(f.els.sidebar);
    old.value = 'retired input';
    old.dispatch('compositionstart');
    old.dispatch('input', { isComposing: true });
    old.dispatch('compositionend');
    oldDisclosure.open = false;
    oldDisclosure.dispatch('toggle');
    assert.equal(old.isConnected, false);
    assert.equal(successor.filter, 'finance');
    assert.equal(successor.showAll, true);
    assert.equal(current.value, 'finance');
    assert.equal(current.selectionStart, 1);
    assert.equal(current.selectionEnd, 5);
    assert.equal(current.selectionDirection, 'backward');
    assert.equal(document.activeElement, current);
    assert.equal(readText(f.els.sidebar), before);
  });
}

test('shell correction SH02 SH04: an active composition cannot retain a retired document owner', async () => {
  const f = await fixture();
  f.scope.renderSidebar();
  const old = f.els.sidebar.querySelector('input');
  old.focus();
  old.dispatch('compositionstart');
  old.value = 'fin';
  old.dispatch('input', { isComposing: true });
  f.owner.documentGeneration++;
  f.owner.filter = 'research';
  f.scope.renderSidebar();
  const current = f.els.sidebar.querySelector('input');
  assert.notEqual(current, old);
  old.value = 'late finance';
  old.dispatch('compositionend');
  old.dispatch('input');
  assert.equal(f.owner.filter, 'research');
  assert.equal(current.value, 'research');
});

test('shell correction SH03: unrelated progress preserves the same live retained-notice control without stealing later focus', async () => {
  const f = await fixture();
  f.scope.setStatus('History failed', 'error', true, false, { operation: 'history' });
  f.scope.setStatus('Reading source', 'info', true, true, { operation: 'read' });
  const dismiss = f.els.status.querySelector('button');
  dismiss.focus();
  f.scope.setStatus('Still reading source', 'info', true, true, { operation: 'read' });
  assert.equal(dismiss.isConnected, true);
  assert.equal(document.activeElement, dismiss);
  assert.equal(f.els.status.querySelector('button'), dismiss);
  assert.match(readText(f.els.status), /History failed/);
  assert.equal(f.els.status.querySelectorAll('button').length, 1);
  for (const callback of f.timers.values()) callback();
  assert.equal(document.activeElement, dismiss);
  const outside = h('button', {}, 'Intervening user control');
  f.dom.root.append(outside);
  outside.focus();
  f.scope.setStatus('Another progress update', 'info', true, true, { operation: 'read' });
  assert.equal(document.activeElement, outside);
  const dialog = h('button', {}, 'Intervening dialog control');
  f.dom.modal.append(dialog);
  f.dom.modal.open = true;
  dialog.focus();
  f.scope.renderStatus();
  assert.equal(document.activeElement, dialog);
  dismiss.click();
  assert.doesNotMatch(readText(f.els.status), /History failed/);
  assert.match(readText(f.els.status), /Another progress update/);
});

test('shell correction SH03: a retired notice dismiss cannot remove a newer operation or another workspace notice', async () => {
  const f = await fixture();
  f.scope.setStatus('Original failure', 'error', true, false, { operation: 'same' });
  const old = f.els.status.querySelector('button');
  f.scope.setStatus('Newer failure', 'error', true, false, { operation: 'same' });
  old.click();
  assert.match(readText(f.els.status), /Newer failure/);
  const previousOwner = f.scope.state, retired = f.els.status.querySelector('button');
  f.scope.state = f.scope.viewStates.activate({ projectId: 'next', environment: { id: 'next' } });
  f.scope.setStatus('Other workspace failure', 'error', true, false, { operation: 'same' });
  retired.click();
  assert.equal(previousOwner.notifications.size, 0);
  assert.match(readText(f.els.status), /Other workspace failure/);
});

for (const change of ['provider', 'handle', 'ref']) {
  for (const kind of ['NotFoundError', 'Error']) {
    test(`shell correction SH05: obsolete ${change} ${kind} retains previous-source attribution and cannot be resolved by the replacement`, async () => {
      const f = await fixture();
      Object.assign(f.context, { provider: { id: 'original' }, handle: { name: 'original-handle' } });
      f.context.environment.source = { kind: 'github', fullName: 'synthetic/owned', repositoryId: 42,
        sourceBranch: 'main', workingBranch: 'original-ref' };
      f.owner.operations = [{ op: 'set', path: ['value'], value: 'exact retained draft' }];
      const draft = JSON.stringify(f.owner.operations), source = { context: f.context, path: f.owner.current.path };
      const captured = f.scope.captureSourceScope(source);
      f.scope.setStatus('Unrelated History failure', 'error', true, false, { operation: 'history' });
      let reject;
      const delayed = new Promise((_resolve, fail) => { reject = fail; });
      const work = f.scope.withStatus('Reading the source', () => f.scope.sourceOperation(source, () => delayed), source);
      if (change === 'ref') f.context.environment.source.workingBranch = 'replacement-ref';
      else f.context[change] = { name: `replacement-${change}` };
      reject(Object.assign(new Error('Original source operation failed'), { name: kind }));
      await work;
      assert.equal(f.scope.sourceScopeIsCurrent(captured), false);
      assert.equal(f.els.workspace.querySelector('.source-unavailable'), null);
      assert.match(readText(f.els.status), /Previous source/);
      assert.match(readText(f.els.status), /Original source operation failed/);
      assert.match(readText(f.els.status), /original-ref/);
      assert.match(readText(f.els.status), /Unrelated History failure/);
      const retained = [...f.owner.notifications.values()].find((notice) => /Previous source/.test(notice.message));
      assert(retained);
      assert.notEqual(retained.operation, 'Reading the source');
      assert.equal([...f.owner.notifications.values()].some((notice) => notice.pending), false);
      assert.equal((await f.scope.withStatus('Reading the source', async () => ({ readable: true }), source)).readable, true);
      assert.equal(f.owner.notifications.get(retained.key), retained);
      assert.match(readText(f.els.status), /Unrelated History failure/);
      assert.equal(JSON.stringify(f.owner.operations), draft);
    });
  }
}

test('shell correction SH05: an already visible failure is re-attributed rather than revived on a rebound source', async () => {
  const f = await fixture();
  f.context.handle = { name: 'original-handle' };
  const source = { context: f.context, path: f.owner.current.path };
  await f.scope.withStatus('Read saved source', () => f.scope.sourceOperation(source, async () => {
    throw Object.assign(new Error('Original source disappeared'), { name: 'NotFoundError' });
  }), source);
  const detail = f.owner.sourceUnavailable;
  assert(f.els.workspace.querySelector('.source-unavailable'));
  f.context.handle = { name: 'readable-replacement' };
  f.scope.renderSourceUnavailable();
  assert.equal(f.els.workspace.querySelector('.source-unavailable'), null);
  assert.match(readText(f.els.status), /Previous source/);
  assert.equal(f.owner.sourceUnavailable, detail);
  const retained = [...f.owner.notifications.values()].find((notice) => /Previous source/.test(notice.message));
  assert(retained);
  f.scope.removeStatusNotice(f.owner, retained);
  f.scope.renderSourceUnavailable();
  assert.equal(f.owner.notifications.has(retained.key), false, 'An ordinary repaint must not undo explicit dismissal.');
});

test('shell correction SH06: final display-label collisions get stable distinguishing suffixes without changing identities', async () => {
  const f = await fixture();
  const make = (file, name = 'contracts') => ({ id: file, paramFile: `bicep/infra/citadel-access-contracts/${file}`, name });
  const groups = [
    [make('contracts/finance-east.bicepparam'), make('contracts/finance_east.bicepparam')],
    [make('east/shared.bicepparam'), make('west/shared.bicepparam')],
    [make('contracts/finance-east.bicepparam'), make('contracts/custom.bicepparam', 'Finance East')],
    [make('east/main.bicepparam', 'Finance'), make('west/main.bicepparam', 'Finance')],
  ];
  for (const contracts of groups) {
    f.owner.contracts = { contracts };
    const original = JSON.stringify(contracts);
    const labels = contracts.map(f.scope.contractLabel);
    assert.equal(new Set(labels).size, contracts.length);
    assert(labels.every((label) => / \u2014 /.test(label)));
    const byId = new Map(contracts.map((contract, index) => [contract.id, labels[index]]));
    f.owner.contracts.contracts = [...contracts].reverse();
    for (const contract of contracts) assert.equal(f.scope.contractLabel(contract), byId.get(contract.id));
    assert.equal(JSON.stringify(contracts), original);
  }
  const contracts = [make('finance/main.bicepparam', 'Finance Enterprise'),
    make('research/main.bicepparam', 'Research'), make('contracts/unique-file.bicepparam')];
  f.owner.contracts = { contracts };
  assert.deepEqual(contracts.map(f.scope.contractLabel), ['Finance Enterprise', 'Research', 'Unique File']);
});

async function sourceNoticeFixture() {
  const f = await fixture(), errors = [];
  const report = f.scope.reportClientError;
  f.scope.reportClientError = (error, ...details) => {
    if (error) errors.push(error);
    report(error, ...details);
  };
  f.context.environment.source = {
    kind: 'github', fullName: 'synthetic/provenance', repositoryId: 73,
    sourceBranch: 'main', workingBranch: 'original-ref',
  };
  f.context.provider = { marker: 'ephemeral-provider-reference' };
  f.context.handle = { name: 'original-handle', marker: 'ephemeral-handle-reference' };
  f.owner.operations = [{ op: 'set', path: ['value'], value: 'exact draft ${literal}' }];
  f.owner.parameterInputs = { held: { path: ['held'], value: '1e-', composing: false } };
  f.owner.policyRaw = '\uFEFF<policies><!-- untouched &amp; entity -->\r\n</policies>';
  const source = { context: f.context, path: f.owner.current.path };
  const snapshot = () => JSON.stringify({
    document: f.owner.current, operations: f.owner.operations,
    inputs: f.owner.parameterInputs, policyRaw: f.owner.policyRaw,
  });
  return { ...f, source, snapshot, errors };
}

function replaceNoticeSource(f, kind) {
  if (kind === 'ref') f.context.environment.source.workingBranch = 'replacement-ref';
  else f.context[kind] = { name: `replacement-${kind}` };
}

for (const identity of ['provider', 'handle', 'ref']) {
  for (const kind of ['Error', 'NotFoundError']) {
    test(`shell correction SH05 final: visible ${kind} provenance survives ${identity} replacement before pending can overwrite it`, async () => {
      const f = await sourceNoticeFixture(), operation = 'Read captured source';
      const cause = new Error('Original cause object');
      const error = Object.assign(new Error('Original captured failure', { cause }), { name: kind, code: kind === 'Error' ? 'EIO' : 'ENOENT' });
      f.scope.setStatus('Unrelated History failure', 'error', true, false, { operation: 'history' });
      const history = f.owner.status, before = f.snapshot();
      await f.scope.withStatus(operation, () => f.scope.sourceOperation(f.source, async () => { throw error; }), f.source);
      const original = f.owner.status;
      const dismiss = f.els.status.children.find((node) => readText(node).includes(error.message)).querySelector('button');
      assert.equal(f.errors.at(-1), error);
      assert.equal(error.cause, cause);
      if (kind === 'Error') {
        assert.equal(error.sourceUnavailable, undefined);
        assert.equal(f.owner.sourceUnavailable, undefined);
      }
      replaceNoticeSource(f, identity);
      let complete;
      const work = f.scope.withStatus(operation, () => new Promise((resolve) => { complete = resolve; }), f.source);
      const previous = [...f.owner.notifications.values()].find((notice) => /Previous source/.test(notice.message));
      assert(previous, 'Attribution happens before the replacement operation finishes or renders a banner');
      assert.notEqual(previous, original);
      assert.notEqual(previous.operation, operation);
      assert.match(previous.message, /original-ref/);
      assert.equal(f.owner.notifications.get(history.key), history);
      assert.equal(f.owner.notifications.get(previous.key), previous);
      assert.equal([...f.owner.notifications.values()].filter((notice) => notice.pending).length, 1);
      assert.equal(f.els.workspace.querySelector('.source-unavailable'), null);
      dismiss.click();
      assert.equal(f.owner.notifications.get(previous.key), previous, 'A retired original dismiss cannot clear the attributed successor');
      complete('replacement operation result');
      assert.equal(await work, 'replacement operation result');
      assert.equal(f.owner.notifications.get(previous.key), previous);
      assert.equal(f.owner.documentNotices.get(f.owner.current.path).operation, previous.operation);
      assert.equal([...f.owner.notifications.values()].filter((notice) => notice.pending).length, 0);
      assert.equal([...f.owner.notifications.values()].filter((notice) => /Previous source/.test(notice.message)).length, 1);
      assert.equal(f.snapshot(), before);
      assert.equal(error.cause, cause);
      f.scope.removeStatusNotice(f.owner, previous);
      f.scope.renderSourceUnavailable();
      assert.equal(f.owner.notifications.has(previous.key), false);
    });
  }
}

for (const identity of ['provider', 'handle', 'ref']) {
  test(`shell correction SH05 final: ${identity} replacement during a pending retry is reattributed before success resolves its earlier error`, async () => {
    const f = await sourceNoticeFixture(), operation = 'Read current source';
    const error = Object.assign(new Error('Earlier generic failure'), { code: 'EIO' });
    await f.scope.withStatus(operation, async () => { throw error; }, f.source);
    const original = f.owner.status, before = f.snapshot();
    let complete;
    const work = f.scope.withStatus(operation, () => new Promise((resolve) => { complete = resolve; }), f.source);
    assert.equal(f.owner.status.previousError, original);
    replaceNoticeSource(f, identity);
    complete('completed retry');
    await work;
    const previous = [...f.owner.notifications.values()].find((notice) => /Previous source/.test(notice.message));
    assert(previous);
    assert.match(previous.message, /Earlier generic failure/);
    assert.match(previous.message, /original-ref/);
    assert.equal(f.owner.documentNotices.get(f.owner.current.path).operation, previous.operation);
    assert.equal([...f.owner.notifications.values()].some((notice) => notice.pending), false);
    assert.equal(f.owner.sourceUnavailable, undefined);
    assert.equal(f.snapshot(), before);
  });
}

test('shell correction SH05 final: same-source retry still resolves its error and leaves unrelated History evidence alone', async () => {
  const f = await sourceNoticeFixture(), operation = 'Read same source';
  f.scope.setStatus('Unrelated History failure', 'error', true, false, { operation: 'history' });
  const history = f.owner.status;
  const error = Object.assign(new Error('Temporary source failure'), { code: 'EIO' });
  await f.scope.withStatus(operation, async () => { throw error; }, f.source);
  await f.scope.withStatus(operation, async () => 'same-source result', f.source);
  assert.equal(f.owner.notifications.size, 1);
  assert.equal(f.owner.notifications.get(history.key), history);
  assert.equal(f.owner.documentNotices.size, 0);
  assert.doesNotMatch(readText(f.els.status), /Temporary source failure|Previous source/);
});

test('shell correction SH05 final: restoring a document notice retains its ephemeral source provenance', async () => {
  const f = await sourceNoticeFixture(), operation = 'Read restorable source';
  await f.scope.withStatus(operation, async () => { throw new Error('Retained generic error'); }, f.source);
  const first = f.owner.status;
  f.scope.restoreDocumentNotice();
  assert.notEqual(f.owner.status, first);
  const serialized = JSON.stringify({
    notices: [...f.owner.notifications.values()], remembered: [...f.owner.documentNotices.values()],
  });
  assert.doesNotMatch(serialized, /ephemeral-provider-reference|ephemeral-handle-reference/);
  replaceNoticeSource(f, 'provider');
  f.scope.renderSourceUnavailable();
  assert.match(readText(f.els.status), /Previous source/);
  await f.scope.withStatus(operation, async () => 'replacement result', f.source);
  assert.match(readText(f.els.status), /Retained generic error/);
});

test('shell correction SH05 final: an inactive owner retains provenance without reattributing an unrelated active workspace', async () => {
  const f = await sourceNoticeFixture(), action = f.scope.captureDocumentAction();
  const captured = f.scope.captureSourceScope(f.source);
  const other = { projectId: 'other', environment: { id: 'other', source: { kind: 'local', folderName: 'other' } } };
  f.scope.state = f.scope.viewStates.activate(other);
  f.scope.activeWorkspace = () => other;
  f.scope.setStatus('Other workspace History failure', 'error', true, false, { operation: 'history' });
  const otherStatus = f.scope.state.status;
  f.scope.retainDocumentNotice(action, 'Inactive source failure', 'error', false, 'Read inactive source', captured);
  assert.equal(f.scope.state.status, otherStatus);
  assert.doesNotMatch(readText(f.els.status), /Inactive source/);
  replaceNoticeSource(f, 'handle');
  f.scope.state = f.scope.viewStates.activate(f.context);
  f.scope.activeWorkspace = () => f.context;
  f.scope.restoreDocumentNotice();
  assert.match(readText(f.els.status), /Previous source/);
  assert.match(readText(f.els.status), /Inactive source failure/);
  assert.match(readText(f.els.status), /original-ref/);
  assert.equal(f.owner.sourceUnavailable, undefined);
});

for (const code of ['REGISTRY_UNAVAILABLE', 'REATTACH_INVALID', 'TRANSACTION_UNCONFIRMED', 'NATIVE_VALIDATION']) {
  test(`shell correction SH05 final: ${code} keeps its error/cause classification and never becomes a recovery banner`, async () => {
    const f = await sourceNoticeFixture();
    const cause = new Error('Exact retained cause');
    const error = Object.assign(new Error('Not a missing-file failure', { cause }), { code });
    await f.scope.withStatus('Validate scoped input', () => f.scope.sourceOperation(f.source, async () => { throw error; }), f.source);
    assert.equal(f.errors.at(-1), error);
    assert.equal(error.code, code);
    assert.equal(error.cause, cause);
    assert.equal(error.sourceUnavailable, undefined);
    assert.equal(f.owner.sourceUnavailable, undefined);
    replaceNoticeSource(f, 'provider');
    f.scope.renderSourceUnavailable();
    assert.equal(f.owner.sourceUnavailable, undefined);
    assert.equal(f.els.workspace.querySelector('.source-unavailable'), null);
    assert.match(readText(f.els.status), /Previous source/);
  });
}

test('shell correction SH05 final: non-source validation and History errors do not gain source provenance', async () => {
  const f = await sourceNoticeFixture();
  const error = Object.assign(new Error('Registry validation failed'), { code: 'REGISTRY_INVALID' });
  await f.scope.withStatus('Validate registry', async () => { throw error; });
  const original = f.owner.status;
  replaceNoticeSource(f, 'provider');
  f.scope.renderSourceUnavailable();
  assert.equal(f.owner.status, original);
  assert.doesNotMatch(readText(f.els.status), /Previous source/);
  assert.equal(error.sourceUnavailable, undefined);
});

function verifyFinalContractLabels(f, contracts, expected = new Map()) {
  const before = JSON.stringify(contracts), identities = contracts.map((contract) => contract.id);
  let labels;
  for (const order of [contracts, [...contracts].reverse(), [...contracts.slice(1), contracts[0]]]) {
    f.owner.contracts = { contracts: order };
    const actual = contracts.map((contract) => f.scope.contractLabel(contract));
    assert.equal(new Set(actual.map((label) => label.toLowerCase())).size, contracts.length);
    if (labels) assert.deepEqual(actual, labels);
    else labels = actual;
    for (const [id, label] of expected) assert.equal(actual[identities.indexOf(id)], label);
  }
  assert.equal(JSON.stringify(contracts), before);
  return labels;
}

for (const extension of ['bicepparam', 'tfvars', 'tfvars.json']) {
  test(`shell correction SH06 final: ${extension} generated labels are unique across independently suffixed groups`, async () => {
    const f = await fixture();
    const make = (id, file, name) => ({ id, paramFile: `bicep/infra/citadel-access-contracts/${file}`, name });
    verifyFinalContractLabels(f, [
      make('a', `finance \u2014 main.${extension}`, 'Same'),
      make('b', `other-a.${extension}`, 'Same'),
      make('c', `main.${extension}`, 'Same \u2014 finance'),
      make('d', `other-b.${extension}`, 'Same \u2014 finance'),
    ]);
  });
}

test('shell correction SH06 final: complete-set allocation protects existing explicit labels and terminates through occupied fallback suffixes', async () => {
  const f = await fixture(), path = 'bicep/infra/citadel-access-contracts/shared/main.bicepparam';
  const base = `Shared \u2014 ${path}`;
  const contracts = [{ id: 'first-source-id', paramFile: path, name: 'Shared' },
    { id: 'second-source-id', paramFile: path, name: 'Shared' }];
  const expected = new Map();
  for (let index = 2; index <= 24; index++) {
    const id = `explicit-${index}`, name = `${base} (${index})`;
    contracts.push({ id, paramFile: `bicep/infra/citadel-access-contracts/explicit-${index}.bicepparam`, name });
    expected.set(id, name);
  }
  const labels = verifyFinalContractLabels(f, contracts, expected);
  assert.equal(labels[0], base);
  assert.equal(labels[1], `${base} (25)`);
});

test('shell correction SH06 final: case-insensitive output collisions retain exact noncolliding conventional labels', async () => {
  const f = await fixture();
  verifyFinalContractLabels(f, [
    { id: 'east', paramFile: 'east/Shared.tfvars.json', name: 'Finance' },
    { id: 'west', paramFile: 'west/shared.tfvars.json', name: 'finance' },
    { id: 'research', paramFile: 'research/main.bicepparam', name: 'Research Enterprise' },
  ], new Map([['research', 'Research Enterprise']]));
});

test('shell correction SH06 final: four genuinely discovered files retain distinct labels, IDs, targets and exact source bytes', async (t) => {
  const { nativeLocalFixture } = await import('./_native-fixture.mjs');
  const { fixtureFiles, FIXTURE_ACCESS_PATH } = await import('./_terraform-export-fixture.mjs');
  const { createConfiguration } = await import('../shared/workspace-configuration.mjs');
  const files = fixtureFiles(), original = files[FIXTURE_ACCESS_PATH];
  const names = [
    'finance east \u2014 main.bicepparam',
    'finance-east \u2014 main.bicepparam',
    'Finance East \u2014 Main \u2014 finance east/main.bicepparam',
    'finance-east \u2014 main \u2014 finance-east.bicepparam',
  ];
  const aliases = names.map((name) => `bicep/infra/citadel-access-contracts/contracts/${name}`);
  for (const [index, alias] of aliases.entries()) {
    files[alias] = names[index].includes('/')
      ? original.replaceAll("'../main.bicep'", "'../../main.bicep'").replaceAll("'../policies/", "'../../policies/")
      : original;
  }
  const local = await nativeLocalFixture({ configuration: createConfiguration('bicep'), onlyFiles: files });
  t.after(local.close);
  const f = await fixture(), listing = await local.service.contracts();
  const rows = listing.contracts.filter((contract) => aliases.includes(contract.paramFile));
  assert.equal(rows.length, 4);
  assert(rows.every((contract) => !contract.error && contract.paramCount === 17));
  const labels = verifyFinalContractLabels(f, listing.contracts);
  assert.equal(new Set(rows.map((row) => labels[listing.contracts.indexOf(row)])).size, 4);
  for (const row of rows) {
    const opened = await local.service.contract(row.id);
    assert.equal(opened.id, row.id);
    assert.equal(opened.param.path, row.paramFile);
    assert.equal(opened.param.text, files[row.paramFile]);
    assert.equal((await local.provider.read(row.paramFile)).hash, opened.param.hash);
  }
  for (const [alias, text] of Object.entries(files)) assert.equal((await local.provider.read(alias)).text, text);
});
