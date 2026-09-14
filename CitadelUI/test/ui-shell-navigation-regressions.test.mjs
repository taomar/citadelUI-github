import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDom, loadDialogModule, readText } from './_dom-stub.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { fixtureFiles, FIXTURE_ACCESS_PATH, FIXTURE_SECOND_ACCESS_PATH } from './_terraform-export-fixture.mjs';
import { createConfiguration, configurationKey, configurationOf } from '../shared/workspace-configuration.mjs';
import { discoverWorkspace } from '../shared/citadel-core.mjs';
import { h, mount, clear } from '../web/js/dom.mjs';
import { focusEditorControl, preserveEditorFocus } from '../web/js/editor-focus.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { createDocumentActions } from '../web/js/document-action.mjs';
import { guardedHandler } from '../web/js/single-flight.mjs';
import { formatIcon } from '../web/js/format-icon.mjs';
import { environmentLocation, environmentSourceOf, isGitHubEnvironment } from '../web/js/registry.mjs';
import { describeWriteTarget } from '../web/js/branch-target.mjs';
import { withSourceUnavailable } from '../web/js/workspace-activation.mjs';
import { mutationComplete } from '../shared/mutation-outcome.mjs';
import * as edits from '../web/js/contract-edit-state.mjs';

const app = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function section(start, end) {
  const first = app.indexOf(start), last = app.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return app.slice(first, last);
}
const shellHandlers = [
  section('function createEditorState()', 'const viewStates ='),
  section('let pendingSince =', 'function currentWriteContext('),
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
  section('function flushParameterInputs()', 'function currentValidation('),
  section('function hasPolicyEdits(', 'function pendingKey('),
  section('async function discardAllPending(', 'async function choosePendingNavigation('),
  section('async function choosePendingNavigation(', 'async function applyPendingNavigation('),
  section('function areaButton(', 'function contractList('),
  section('function capturePolicyViewFocus(', 'async function savePolicy('),
  section('let openShellMenu =', 'async function openPendingReview('),
  section('function setConfigurationFormat(', 'function updateHeaderContext('),
].join('\n');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture() {
  const dom = installDom(), timers = new Map(), errors = [], prompts = [];
  const context = { projectId: 'shell-project', environment: { id: 'shell-workspace', label: 'Synthetic workspace' } };
  const els = { shell: dom.node(), workspace: dom.node('main'), sidebar: dom.node('nav'), status: dom.node(), modal: dom.modal };
  dom.root.append(els.workspace, els.sidebar, els.status);
  document.activeElement = dom.root;
  const query = els.workspace.querySelectorAll.bind(els.workspace);
  els.workspace.querySelectorAll = (selector) => selector === '[data-parameter-input]'
    ? query('input, select, textarea').filter((node) => node.dataset.parameterInput !== undefined)
    : query(selector);
  els.workspace.prepend = (...nodes) => {
    const previous = [...els.workspace.children];
    els.workspace.append(...nodes);
    els.workspace.children = [...nodes, ...previous];
  };
  let timerId = 0;
  const scope = {
    structuredClone, Map, Set, Event, h, mount, clear, ...edits, focusEditorControl, preserveEditorFocus,
    configurationKey, configurationOf, guardedHandler, queueMicrotask, formatIcon, withSourceUnavailable, mutationComplete,
    environmentSourceOf, environmentLocation, isGitHubEnvironment, describeWriteTarget,
    document: globalThis.document, els, documentGeneration: 1, policyPreviewToken: 0,
    pendingByDocument: new Map(), COMPACT_NAV: { matches: false }, api: {},
    activeWorkspace: () => context, captureDialogStatus: () => () => false,
    renderEditor: () => scope.render(),
    reportClientError: (error) => { if (error) errors.push(error); },
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    choiceDialog: async (options) => { prompts.push(options); return 'stay'; },
    selectArea() {}, openOther() {}, openWorkspaceSettings() {}, returnToSetup() {},
    openTerraformExportReview() { assert.fail('Focus movement must not activate export.'); },
    openParameterMigration() { assert.fail('Focus movement must not activate migration.'); },
  };
  vm.runInNewContext(shellHandlers, scope);
  scope.viewStates = new WorkspaceViewState(scope.createEditorState);
  scope.state = scope.viewStates.activate(context);
  Object.assign(scope.state, { documentGeneration: 1,
    current: { path: 'synthetic/current.tfvars', hash: 'original-hash' },
    projectLabel: 'Synthetic project',
    catalog: { files: [] },
  });
  scope.documentActions = createDocumentActions({
    views: scope.viewStates, currentOwner: () => scope.state, setStatus: scope.setStatus,
  });
  return { dom, scope, els, context, timers, errors, prompts, get owner() { return scope.state; } };
}

test('shell regression F01: filtering replaces only results and preserves the native search node and selection', () => {
  const f = fixture();
  f.owner.catalog.files = ['finance-west', 'finance-east', 'research'].map((name) => ({
    path: `synthetic/${name}.bicepparam`, name: `${name}.bicepparam`,
  }));
  f.scope.renderSidebar();
  const filter = f.els.sidebar.querySelector('input');
  filter.focus();
  for (const value of ['f', 'finance', 'finance-east', '']) {
    filter.value = value;
    filter.setSelectionRange(value.length, value.length);
    filter.dispatch('input');
    assert.equal(f.els.sidebar.querySelector('input'), filter);
    assert.equal(document.activeElement, filter);
    assert.equal(filter.selectionStart, value.length);
    assert.equal(f.els.sidebar.querySelectorAll('.nav-item').length, value ? value === 'finance-east' ? 1 : 2 : 3);
  }
  filter.value = 'finance';
  filter.dispatch('input');
  filter.setSelectionRange(1, 5, 'backward');
  f.scope.renderSidebar();
  const replacement = f.els.sidebar.querySelector('input');
  assert.notEqual(replacement, filter);
  assert.equal(document.activeElement, replacement);
  assert.equal(replacement.value, 'finance');
  assert.equal(replacement.selectionStart, 1);
  assert.equal(replacement.selectionEnd, 5);
  assert.equal(replacement.selectionDirection, 'backward');
});

test('shell regression F06: pending navigation names the actual input and policy owners, excluding clean or foreign documents', async () => {
  const f = fixture();
  const pending = {
    workspaceKey: f.owner.workspaceKey, parameterPath: 'synthetic/owning-deployment.tfvars',
    policyPath: 'synthetic/owning-policy.xml', operations: [],
    parameterInputs: { '["ratio"]': { value: '1e-', composing: true } },
    policyChanges: {}, policyRaw: '<policies>unfinished',
  };
  f.scope.pendingByDocument.set('owned', pending);
  f.scope.pendingByDocument.set('foreign', { ...pending, workspaceKey: 'another-workspace', parameterPath: 'private/foreign.tfvars' });
  assert.equal(await f.scope.choosePendingNavigation({ destination: 'returning to workspaces' }), 'stay');
  const prompt = f.prompts[0], text = readText(prompt.context);
  assert.match(text, /synthetic\/owning-deployment\.tfvars/);
  assert.match(text, /synthetic\/owning-policy\.xml/);
  assert.doesNotMatch(text, /current\.tfvars|private\/foreign\.tfvars/);
  assert.match(text, /Discard affects all listed drafts in this workspace/);
  assert.match(prompt.message, /not through a reload or browser closure/);
  assert.deepEqual(Array.from(prompt.choices, (choice) => choice.value), ['stay', 'preserve', 'discard']);
  assert.equal(f.scope.pendingByDocument.get('owned'), pending);
  assert.equal(pending.parameterInputs['["ratio"]'].value, '1e-');
});

for (const change of ['none', 'draft', 'document']) {
  test(`shell regression draft discard retains captured ownership when ${change} changes during persistence`, async () => {
    const f = fixture(), ready = deferred();
    f.owner.operations = [{ op: 'set', path: ['name'], value: 'original-draft' }];
    const foreign = { workspaceKey: 'another-workspace', parameterPath: 'foreign.tfvars', operations: [{ op: 'set', path: ['name'], value: 'foreign' }] };
    f.scope.pendingByDocument.set('foreign', foreign);
    f.scope.workspaceRegistry = { removeDraft: () => ready.promise };
    const discarding = f.scope.discardAllPending();
    if (change === 'draft') f.owner.operations = [{ op: 'set', path: ['name'], value: 'newer-draft' }];
    if (change === 'document') f.owner.current = { path: 'synthetic/successor.tfvars' };
    ready.resolve();
    assert.equal(await discarding, change === 'none');
    assert.equal(f.owner.operations.length, change === 'none' ? 0 : 1);
    assert.equal(f.scope.pendingByDocument.get('foreign'), foreign);
  });
}

test('shell regression Tools menu survives the native focusout gap between its own items', async () => {
  const f = fixture(), menu = f.scope.toolsMenu(f.context);
  f.els.workspace.append(menu);
  const trigger = menu.querySelector('.shell-menu-trigger'), panel = menu.querySelector('.shell-menu-panel');
  trigger.click();
  assert.equal(panel.hidden, false);
  const target = panel.querySelectorAll('button').at(-1);
  document.activeElement = f.dom.root;
  menu.dispatch('focusout', { relatedTarget: target });
  await Promise.resolve();
  assert.equal(panel.hidden, false, 'An internal native focus transition must not hide the click target.');
  target.focus();
  const outside = h('button', {}, 'Outside');
  f.dom.root.append(outside);
  menu.dispatch('focusout', { relatedTarget: outside });
  outside.focus();
  await Promise.resolve();
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, outside);
});

test('shell regression first-invalid review focuses the current replacement control and stops before another pending input', () => {
  const f = fixture(), firstPath = ['limits', 'units'], secondPath = ['other'];
  const firstKey = JSON.stringify(firstPath), secondKey = JSON.stringify(secondPath);
  edits.setParameterInput(f.owner, firstPath, { value: '' });
  edits.setParameterInput(f.owner, secondPath, { value: 'uncommitted' });
  let secondChanges = 0;
  const replacement = h('input', { dataset: { parameterInput: firstKey } });
  replacement.validationMessage = 'A whole-number value is required.';
  const details = h('details', {}, replacement);
  const second = h('input', { dataset: { parameterInput: secondKey }, onchange: () => { secondChanges += 1; } });
  const original = h('input', { dataset: { parameterInput: firstKey },
    onchange: () => mount(f.els.workspace, [details, second]) });
  f.els.workspace.append(original, second);
  assert.equal(f.scope.flushParameterInputs(), false);
  assert.equal(original.isConnected, false);
  assert.equal(document.activeElement, replacement);
  assert.equal(details.open, true);
  assert.equal(secondChanges, 0);
  assert.match(readText(f.els.status), /limits\.units: A whole-number value is required/);
  assert.equal(edits.parameterInput(f.owner, firstPath).value, '');
  assert.equal(edits.parameterInput(f.owner, secondPath).value, 'uncommitted');
});

test('shell regression composition rejection reveals its owning field without dispatching or consuming it', () => {
  const f = fixture(), path = ['name'], key = JSON.stringify(path);
  edits.setParameterInput(f.owner, path, { value: 'unfinished composition', composing: true });
  let changes = 0;
  const input = h('input', { dataset: { parameterInput: key }, onchange: () => { changes += 1; } });
  const details = h('details', {}, input);
  f.els.workspace.append(details);
  assert.equal(f.scope.flushParameterInputs(), false);
  assert.equal(document.activeElement, input);
  assert.equal(details.open, true);
  assert.equal(changes, 0);
  assert.match(readText(f.els.status), /name.*finish or discard.*composition.*retained in memory/);
  assert.equal(edits.parameterInput(f.owner, path).composing, true);
});

test('shell regression review does not dispatch or focus unavailable, disabled or read-only pending controls', () => {
  for (const gate of ['missing', 'disabled', 'readOnly']) {
    const f = fixture(), path = ['guarded'], key = JSON.stringify(path);
    edits.setParameterInput(f.owner, path, { value: 'retained' });
    const outside = h('button', {}, 'Outside');
    f.dom.root.append(outside);
    outside.focus();
    if (gate !== 'missing') {
      const input = h('input', { dataset: { parameterInput: key }, onchange: () => assert.fail('A guarded input cannot dispatch.') });
      input[gate] = true;
      f.els.workspace.append(input);
    }
    assert.equal(f.scope.flushParameterInputs(), false);
    assert.equal(document.activeElement, outside);
    assert.match(readText(f.els.status), /guarded/);
    assert.equal(edits.parameterInput(f.owner, path).value, 'retained');
  }
});

test('shell regression review retires ownership after blur or change without focusing a successor control', () => {
  for (const stage of ['blur', 'change']) {
    const f = fixture(), path = ['retained'], key = JSON.stringify(path);
    edits.setParameterInput(f.owner, path, { value: 'uncommitted' });
    const successor = h('button', {}, 'Successor');
    f.dom.root.append(successor);
    const retire = () => {
      f.owner.documentGeneration += 1;
      successor.focus();
    };
    const input = h('input', { dataset: { parameterInput: key }, onchange: stage === 'change' ? retire : () => assert.fail('Ownership ended at blur.') });
    f.els.workspace.append(input);
    if (stage === 'blur') { input.blur = retire; input.focus(); }
    assert.equal(f.scope.flushParameterInputs(), false);
    assert.equal(document.activeElement, successor);
    assert.equal(edits.parameterInput(f.owner, path).value, 'uncommitted');
  }
});

test('shell regression format icons preserve known format labels without confusing connection identity', () => {
  const f = fixture();
  f.els.configurationFormat = h('span');
  f.els.sourceKind = h('span', {}, 'GitHub');
  for (const [format, label] of [['bicep', 'Bicep'], ['terraform', 'Terraform']]) {
    f.scope.setConfigurationFormat(format);
    const icon = f.els.configurationFormat.querySelector('img');
    assert.equal(f.els.configurationFormat.hidden, false);
    assert.equal(readText(f.els.configurationFormat), label);
    assert.equal(icon.getAttribute('src'), `/icons/${format}.svg`);
    assert.equal(icon.getAttribute('alt'), '');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(readText(f.els.sourceKind), 'GitHub');
  }
  f.scope.setConfigurationFormat(null);
  assert.equal(f.els.configurationFormat.hidden, true);
  assert.equal(f.els.configurationFormat.children.length, 0);
});

test('shell regression document context follows the policy tab without claiming a default policy file', () => {
  const f = fixture();
  for (const field of ['projectName', 'environmentName', 'documentLabel', 'repoPath', 'localPath', 'localPathLabel', 'sourceKind', 'writeTarget']) {
    f.els[field] = h('span');
  }
  f.els.localPathCopy = h('button');
  f.els.shell.dataset.workspace = 'active';
  Object.assign(f.scope, { environmentLocation, environmentSourceOf, isGitHubEnvironment, describeWriteTarget });
  vm.runInNewContext(section('function setSourceLine(', '/**\n * The sheet\'s masthead'), f.scope);
  f.owner.contract = { id: 'finance', name: 'Finance', paramFile: f.owner.current.path,
    policy: { path: 'synthetic/finance-policy.xml' } };
  for (const [tab, path] of [['params', f.owner.current.path], ['policy', f.owner.contract.policy.path], ['raw', f.owner.current.path]]) {
    f.owner.tab = tab;
    f.scope.updateHeaderContext();
    assert.equal(f.els.repoPath.textContent, path);
    assert.equal(f.els.repoPath.title, path);
    assert.equal(f.els.documentLabel.textContent, 'Finance');
  }
  f.owner.tab = 'policy';
  f.owner.contract.policy = null;
  f.scope.updateHeaderContext();
  assert.equal(f.els.repoPath.textContent, 'No policy file selected');
});

test('shell regression desktop breakpoints wait for owner bootstrap and preserve later rendering gates', () => {
  const calls = [], listeners = [], media = { addEventListener: (_event, callback) => listeners.push(callback) };
  const scope = { els: {}, window: { matchMedia: () => media }, COMPACT_NAV: media,
    updateHeaderContext: () => calls.push('header'), renderSidebar: () => calls.push('sidebar'),
    renderEditor: () => calls.push('editor'), renderStatus: () => calls.push('status') };
  vm.runInNewContext(section('function render() {', 'function renderEditor() {') +
    section('function renderAfterBootstrap()', 'function renderContextRail()'), scope);
  assert.equal(listeners.length, 2);
  for (const listener of listeners) assert.doesNotThrow(() => listener());
  assert.deepEqual(calls, []);
  scope.els.shell = { dataset: { workspace: 'setup' } };
  for (const listener of listeners) {
    listener();
    assert.deepEqual(calls.splice(0), ['header']);
  }
  scope.els.shell.dataset.workspace = 'active';
  for (const listener of listeners) {
    listener();
    assert.deepEqual(calls.splice(0), ['header', 'sidebar', 'editor', 'status']);
  }
  for (const workflow of ['migration', 'terraform-export']) {
    scope.els.shell.dataset.workspace = workflow;
    for (const listener of listeners) listener();
    assert.deepEqual(calls, []);
  }
});

test('shell regression F09: resolved operation notices preserve unrelated errors, active work and another document', () => {
  const f = fixture(), scope = f.scope;
  scope.setStatus('Export draft blocker', 'error', true, false, { operation: 'export', path: null });
  scope.setStatus('History failed', 'error', true, false, { operation: 'history', path: null });
  scope.setStatus('Reading source', 'info', true, true, { operation: 'source', path: null });
  scope.setStatus('Other document blocker', 'error', true, false, { operation: 'export', path: 'synthetic/other.tfvars' });
  scope.resolveOperationStatus('export');
  assert.doesNotMatch(readText(f.els.status), /Export draft blocker|Other document blocker/);
  assert.match(readText(f.els.status), /History failed/);
  assert.match(readText(f.els.status), /Reading source/);
  assert.equal(f.owner.notifications.size, 3);
  assert.equal(f.els.status.getAttribute('aria-busy'), 'true');
  assert.equal(f.els.status.querySelectorAll('button').length, 1, 'Active work cannot be dismissed.');
  scope.resolveOperationStatus('source');
  assert.equal(f.owner.notifications.size, 3, 'Resolving an admission error must not clear in-flight work.');
});

test('shell regression F09: a failed retry remains visible until that operation succeeds', async () => {
  const f = fixture(), operation = 'Reading owned document';
  const failed = f.scope.captureDocumentAction();
  f.scope.retainDocumentNotice(failed, 'Earlier read failed', 'error', false, operation);
  f.scope.setStatus('Unrelated failed action', 'error', true, false, { operation: 'unrelated' });
  const ready = deferred();
  const run = f.scope.withStatus(operation, () => ready.promise);
  assert.match(readText(f.els.status), /Previous attempt: Earlier read failed/);
  assert.match(readText(f.els.status), /Unrelated failed action/);
  ready.resolve('accepted');
  assert.equal(await run, 'accepted');
  assert.doesNotMatch(readText(f.els.status), /Earlier read failed|Reading owned document/);
  assert.match(readText(f.els.status), /Unrelated failed action/);
  assert.equal(f.owner.documentNotices.has(f.owner.current.path), false);
});

test('shell regression F09: a stale completion cannot resolve a successor document notice or a confirmed outcome', async () => {
  const f = fixture(), action = f.scope.captureDocumentAction();
  f.scope.retainDocumentNotice(action, 'Confirmed save with a recovery requirement', 'error', true, 'read');
  f.scope.documentActions.resolveDocumentNotice(action, 'read');
  assert.equal(f.owner.documentNotices.get(action.document.path).outcome, true);
  const ready = deferred(), run = f.scope.withStatus('old-read', () => ready.promise);
  f.owner.current = { path: 'synthetic/successor.tfvars', hash: 'successor' };
  f.owner.documentGeneration += 1;
  f.scope.setStatus('Successor needs attention', 'error', true);
  ready.resolve();
  await run;
  assert.match(readText(f.els.status), /Successor needs attention/);
  assert.equal(f.owner.documentNotices.get(action.document.path).outcome, true);
});

test('shell regression F09: a retired pending escalation cannot repaint another workspace or detach its focused dismiss control', () => {
  const f = fixture();
  f.scope.setStatus('Old workspace read', 'info', true, true);
  const escalate = [...f.timers.values()][0];
  f.scope.state = f.scope.viewStates.activate({ environment: { id: 'successor-workspace' } });
  f.scope.setStatus('Successor workspace error', 'error', true);
  const dismiss = f.els.status.querySelector('button');
  dismiss.focus();
  escalate();
  assert.equal(f.els.status.querySelector('button'), dismiss);
  assert.equal(document.activeElement, dismiss);
  assert.match(readText(f.els.status), /Successor workspace error/);
});

test('shell regression source recovery accepts only inert metadata for the owning document and keeps its drafts', () => {
  const f = fixture(), action = f.scope.captureDocumentAction();
  edits.setParameterInput(f.owner, ['ratio'], { value: '1e-', composing: true });
  const error = new Error('Original provider failure');
  error.sourceUnavailable = {
    kind: 'permission', path: f.owner.current.path, message: '<img src=x onerror=alert(1)>',
    guidance: 'Choose the same source again from Settings.', actions: ['unexpected-action'],
  };
  f.scope.presentSourceUnavailable(action, error, 'read');
  const panel = f.els.workspace.querySelector('.source-unavailable');
  assert(panel);
  assert.match(readText(panel), /Original provider failure/);
  assert.match(readText(panel), /<img src=x onerror=alert\(1\)>/);
  assert.equal(panel.querySelectorAll('img').length, 0);
  assert.equal(panel.querySelectorAll('button').length, 2);
  assert.equal(edits.parameterInput(f.owner, ['ratio']).value, '1e-');
  const original = f.owner.sourceUnavailable;
  f.scope.presentSourceUnavailable(action, { ...error, sourceUnavailable: { ...error.sourceUnavailable, kind: 'unknown' } }, 'read');
  assert.equal(f.owner.sourceUnavailable, original);
  f.owner.current = { path: 'synthetic/new.tfvars' };
  f.scope.presentSourceUnavailable(action, error, 'read');
  assert.equal(f.owner.sourceUnavailable, original, 'An old failed read cannot replace a successor recovery state.');
});

test('shell regression source classification preserves original errors and excludes validation, mirror and transaction outcomes', () => {
  const f = fixture(), source = f.scope.captureSourceScope({ context: f.context, path: f.owner.current.path });
  for (const [name, code, kind] of [
    ['NotFoundError', '', 'missing-file'], ['Error', 'NATIVE_VALUE_MISSING', 'missing-file'],
    ['NotAllowedError', '', 'permission'], ['Error', 'FOLDER_PERMISSION_DENIED', 'permission'],
    ['Error', 'GITHUB_SESSION_EXPIRED', 'connection'], ['Error', 'CONNECTION_MISMATCH', 'connection'],
    ['Error', 'WORKSPACE_SOURCE_UNAVAILABLE', 'unavailable'],
    ['Error', 'REATTACH_SYNC_PENDING', null], ['Error', 'REGISTRY_SYNC_PENDING', null],
    ['NotFoundError', 'REGISTRY_SYNC_PENDING', null], ['NotAllowedError', 'NATIVE_REVIEW_STALE', null],
    ['Error', 'NATIVE_REVIEW_STALE', null], ['Error', 'NATIVE_ROOT_SIGNATURE', null],
    ['Error', 'NATIVE_SENSITIVE_FILE', null], ['Error', 'NATIVE_PARSE', null],
    ['Error', 'TRANSACTION_PENDING', null], ['TypeError', '', null],
  ]) {
    const cause = Object.assign(new Error('Underlying file detail'), { name: 'NotFoundError' });
    const error = Object.assign(new Error('Original error', { cause }), { name, code });
    assert.equal(f.scope.annotateSourceFailure(error, source), error);
    assert.equal(error.cause, cause);
    assert.equal(error.code, code);
    assert.equal(error.sourceUnavailable?.kind || null, kind, `${name}/${code}`);
    if (kind) assert.equal(error.sourceUnavailable.path, f.owner.current.path);
  }
});

test('shell regression a confirmed same-source read retires only its unavailability, not unrelated errors or confirmed outcomes', async () => {
  const f = fixture(), source = { context: f.context, path: f.owner.current.path };
  edits.setParameterInput(f.owner, ['ratio'], { value: '1e-' });
  const error = Object.assign(new Error('Owned source missing'), { name: 'NotFoundError' });
  await f.scope.withStatus('Reading owned source', () => f.scope.sourceOperation(source, async () => { throw error; }), source);
  assert(f.els.workspace.querySelector('.source-unavailable'));
  f.scope.setStatus('Unrelated history failure', 'error', true, false, { operation: 'history' });
  const action = f.scope.captureDocumentAction();
  f.scope.retainDocumentNotice(action, 'Confirmed save needs recovery', 'error', true, 'outcome');
  await f.scope.withStatus('Reading restored source', async () => ({ path: source.path }), source);
  assert.equal(f.els.workspace.querySelector('.source-unavailable'), null);
  assert.equal(f.owner.sourceUnavailable, null);
  assert.doesNotMatch(readText(f.els.status), /Owned source missing/);
  assert.match(readText(f.els.status), /Unrelated history failure/);
  assert.equal(f.owner.documentNotices.get(source.path).outcome, true);
  assert.equal(edits.parameterInput(f.owner, ['ratio']).value, '1e-');
});

test('shell regression unconfirmed mutation outcomes do not declare a missing source recovered', async () => {
  const f = fixture(), source = { context: f.context, path: f.owner.current.path };
  await f.scope.withStatus('Reading owned source', () => f.scope.sourceOperation(source, async () => {
    throw Object.assign(new Error('Missing'), { name: 'NotFoundError' });
  }), source);
  const original = f.owner.sourceUnavailable;
  for (const status of ['pending', 'indeterminate', 'recovery-required']) {
    await f.scope.withStatus('Writing owned source', async () => ({ status, applied: false }), { ...source, mutation: true });
    assert.equal(f.owner.sourceUnavailable, original);
  }
});

test('shell regression source recovery actions cannot follow a changed connection or a different document', async () => {
  for (const change of ['source', 'document']) {
    const f = fixture();
    let recoveries = 0;
    f.scope.openWorkspaceSettings = () => { recoveries += 1; };
    const source = { context: f.context, path: f.owner.current.path };
    await f.scope.withStatus('Reading source', () => f.scope.sourceOperation(source, async () => {
      throw Object.assign(new Error('Missing'), { name: 'NotFoundError' });
    }), source);
    const button = f.els.workspace.querySelector('.source-unavailable').querySelector('button');
    if (change === 'source') f.context.environment.source = { kind: 'github', fullName: 'synthetic/another', repositoryId: 22,
      sourceBranch: 'main', workingBranch: 'other', connectionProfileId: 'replacement' };
    else f.owner.current = { path: 'synthetic/another.tfvars' };
    await button.click();
    assert.equal(recoveries, 0);
  }
});

test('shell regression a late source error stays with its original owner and does not replace a successor view', async () => {
  const f = fixture(), original = f.owner, ready = deferred(), source = { context: f.context, path: f.owner.current.path };
  const running = f.scope.withStatus('Reading original source', () => f.scope.sourceOperation(source, () => ready.promise), source);
  f.scope.state = f.scope.viewStates.activate({ environment: { id: 'successor' } });
  f.scope.state.current = { path: 'synthetic/successor.tfvars' };
  f.scope.setStatus('Successor status', 'info', true);
  ready.reject(Object.assign(new Error('Original source missing'), { name: 'NotFoundError' }));
  await running;
  assert.equal(original.sourceUnavailable.path, source.path);
  assert.equal(f.els.workspace.querySelector('.source-unavailable'), null);
  assert.match(readText(f.els.status), /Successor status/);
});

test('shell regression draft-store failures after source reads are not relabelled as missing source files', async () => {
  const f = fixture(), source = { context: f.context, path: f.owner.current.path };
  const error = Object.assign(new Error('The draft object store is unavailable'), { name: 'NotFoundError' });
  await f.scope.withStatus('Loading source and draft', async () => {
    await f.scope.sourceOperation(source, async () => ({ path: source.path }));
    throw error;
  }, source);
  assert.equal(error.sourceUnavailable, undefined);
  assert.equal(f.owner.sourceUnavailable, undefined);
  assert.equal(f.els.workspace.querySelector('.source-unavailable'), null);
  assert.match(readText(f.els.status), /draft object store is unavailable/);
});

test('shell regression F14: deferred and parsed flat contracts have unique identities and open their exact source', async (t) => {
  const files = fixtureFiles();
  const f = await nativeLocalFixture({ configuration: createConfiguration('bicep'), onlyFiles: files });
  t.after(f.close);
  const parsed = await discoverWorkspace(f.provider);
  const deferredCatalog = await discoverWorkspace(f.provider, { scope: new Set() });
  const parsedContracts = parsed.files.filter((file) => file.contract);
  const deferredContracts = deferredCatalog.files.filter((file) => file.contract);
  assert.deepEqual(deferredContracts.map((file) => [file.path, file.contract.id]),
    parsedContracts.map((file) => [file.path, file.contract.id]));
  assert.equal(new Set(parsedContracts.map((file) => file.contract.id)).size, parsedContracts.length);
  const catalog = await f.service.contracts();
  const shell = fixture();
  shell.owner.contracts = catalog;
  const labels = catalog.contracts.map(shell.scope.contractLabel);
  assert.equal(new Set(labels).size, labels.length);
  for (const path of [FIXTURE_ACCESS_PATH, FIXTURE_SECOND_ACCESS_PATH]) {
    const entry = catalog.contracts.find((contract) => contract.paramFile === path);
    assert(entry);
    assert.equal(entry.id, path.slice(path.indexOf('/citadel-access-contracts/') + '/citadel-access-contracts/'.length));
    const opened = await f.service.contract(entry.id);
    assert.equal(opened.param.path, path);
    assert.equal(opened.param.text, files[path]);
  }
  const template = catalog.contracts.find((entry) => entry.id === '__template');
  assert.equal(template.isTemplate, true);
  assert.equal(template.paramFile, 'bicep/infra/citadel-access-contracts/main.bicepparam');
  const before = new Map(f.root.allFiles().map((file) => [file.path, Array.from(file.bytes)]));
  await assert.rejects(f.service.restoreContract('__template'), /History/);
  assert.deepEqual(new Map(f.root.allFiles().map((file) => [file.path, Array.from(file.bytes)])), before);
});

test('shell regression F14: conventional directory contract identity and policy resolution remain unchanged', async (t) => {
  const files = fixtureFiles(), directory = 'bicep/infra/citadel-access-contracts/contracts/conventional';
  files[`${directory}/main.bicepparam`] = files[FIXTURE_ACCESS_PATH].replaceAll("'../", "'../../");
  files[`${directory}/ai-product-policy.xml`] = '<policies><inbound><base /></inbound></policies>';
  const f = await nativeLocalFixture({ configuration: createConfiguration('bicep'), onlyFiles: files });
  t.after(f.close);
  const catalog = await discoverWorkspace(f.provider);
  const contract = catalog.files.find((entry) => entry.path === `${directory}/main.bicepparam`).contract;
  assert.equal(contract.id, 'contracts/conventional');
  assert.equal(contract.isTemplate, false);
  assert.equal((await f.service.contract('contracts/conventional')).param.path, `${directory}/main.bicepparam`);
});

for (const interruption of ['none', 'outside-focus', 'intervening-key', 'owner', 'dialog']) {
  test(`shell regression policy focus: an async paint respects ${interruption}`, async () => {
    const f = fixture(), ready = deferred();
    const key = `policy:${JSON.stringify('synthetic/policy["quoted"].xml')}:${JSON.stringify(['mode', 'guided'])}`;
    const makeControl = () => h('input', { value: 'retained selection', dataset: { editorFocus: key } });
    const control = makeControl(), outside = h('button', {}, 'Outside');
    f.els.workspace.append(control);
    f.dom.root.append(outside);
    f.owner.contract = { policy: { path: 'synthetic/policy["quoted"].xml', hash: 'policy-hash' } };
    f.owner.tab = 'policy';
    f.owner.policyChanges = { variables: { jwtRequired: true } };
    f.scope.api.previewPolicy = () => ready.promise;
    f.scope.render = () => mount(f.els.workspace, f.owner.policyPreviewPending ? h('p', {}, 'Reading preview') : makeControl());
    control.focus();
    control.setSelectionRange(2, 7, 'backward');
    const running = f.scope.refreshPolicyPreview();
    if (interruption === 'outside-focus') outside.focus();
    if (interruption === 'intervening-key') f.dom.root.dispatch('keydown', { key: 'Tab' });
    if (interruption === 'owner') f.owner.current = { path: 'synthetic/successor.tfvars' };
    if (interruption === 'dialog') { f.els.modal.open = true; outside.focus(); }
    ready.resolve({ after: '<policies />', controls: {} });
    await running;
    if (interruption === 'none') {
      const replacement = f.els.workspace.querySelector('input');
      assert.equal(document.activeElement, replacement);
      assert.equal(replacement.selectionStart, 2);
      assert.equal(replacement.selectionEnd, 7);
      assert.equal(replacement.selectionDirection, 'backward');
    } else {
      assert.notEqual(document.activeElement, f.els.workspace.querySelector('input'));
      if (interruption === 'outside-focus' || interruption === 'dialog') assert.equal(document.activeElement, outside);
    }
    for (const type of ['focusin', 'keydown', 'pointerdown']) assert.equal(f.dom.root.listeners.get(type)?.length || 0, 0);
  });
}

test('shell regression policy disclosure state is forwarded only to its captured owner', () => {
  const f = fixture(), context = f.scope.policyContext(), key = 'policy:["owned.xml"]:["block","jwt"]';
  assert.equal(context.isOpen(key, false), false);
  context.setOpen(key, true);
  assert.equal(context.isOpen(key, false), true);
  f.owner.current = { path: 'synthetic/successor.tfvars' };
  context.setOpen(key, false);
  assert.equal(f.owner.open.get(key), true);
});

for (const change of ['none', 'draft', 'document', 'contract', 'cancel']) {
  test(`shell regression raw-to-guided confirmation preserves its captured draft and focus when ${change} changes`, () => {
    const f = fixture(), closed = [], paints = [], messages = [];
    const raw = '<policies><inbound><base /></inbound></policies>';
    const path = 'synthetic/raw-policy.xml';
    const key = `policy:${JSON.stringify(path)}:${JSON.stringify(['mode', 'guided'])}`;
    f.owner.contract = { policy: { path, hash: 'policy-hash' } };
    f.owner.tab = 'policy';
    f.owner.policyMode = 'raw';
    f.owner.policyRaw = raw;
    const mode = h('button', { dataset: { editorFocus: key } }, 'Guided');
    f.els.workspace.append(mode);
    mode.focus();
    let prompt;
    f.scope.showModal = (title, body, actions) => { prompt = { title, body, actions }; };
    f.scope.closeModal = (options = {}) => closed.push(options);
    f.scope.captureDialogStatus = () => (message, tone) => messages.push({ message, tone });
    f.scope.refreshPolicyPreview = (focus) => paints.push(focus);
    f.scope.policyContext().setPolicyMode('guided');
    assert.equal(prompt.title, 'Discard hand-edited XML?');
    assert.equal(f.owner.policyRaw, raw, 'Opening a confirmation must not consume the draft.');
    assert.equal(f.owner.policyMode, 'raw');
    if (change === 'draft') f.owner.policyRaw = `${raw}\n<!-- newer draft -->`;
    if (change === 'document') f.owner.current = { path: 'synthetic/successor.tfvars' };
    if (change === 'contract') f.owner.contract = { policy: { path: 'synthetic/successor.xml', hash: 'next' } };
    const retained = f.owner.policyRaw;
    prompt.actions[change === 'cancel' ? 0 : 1].click();
    if (change === 'none') {
      assert.equal(f.owner.policyRaw, null);
      assert.equal(f.owner.policyMode, 'guided');
      assert.equal(closed.length, 1);
      assert.equal(closed[0].restoreFocus, false, 'The policy paint owns the logical mode-control focus handoff.');
      assert.equal(paints.length, 1);
      assert.equal(paints[0].key, key);
      assert.equal(messages.length, 0);
    } else {
      assert.equal(f.owner.policyRaw, retained);
      assert.equal(f.owner.policyMode, 'raw');
      assert.equal(paints.length, 0);
      assert.equal(closed.length, change === 'cancel' ? 1 : 0);
      if (change === 'cancel') assert.notEqual(closed[0].restoreFocus, false);
      else {
        assert.equal(messages.length, 1);
        assert.equal(messages[0].tone, 'error');
        assert.match(messages[0].message, /owning policy or its draft changed/);
      }
    }
  });
}

test('shell regression dialog focus starts at its stage heading and preserves explicit initial focus precedence', async () => {
  const d = await loadDialogModule();
  const body = d.node(), primary = d.node('button'), field = d.node('input');
  body.append(field);
  d.showDialog('Review the owning source', body, [primary]);
  assert.equal(document.activeElement, document.getElementById(d.modal.getAttribute('aria-labelledby')));
  assert.equal(primary.focused, false);
  d.showDialog('Enter a value', body, [primary], { initialFocus: field });
  assert.equal(document.activeElement, field);
  d.closeDialog();
});

test('shell regression dialog Back restores prior scroll and opener while busy Escape cannot dismiss its action', async () => {
  const d = await loadDialogModule(), body = d.node(), opener = d.node('button'), action = d.node('button');
  body.append(opener);
  d.showDialog('History', body);
  d.modal.querySelector('.modal-body').scrollTop = 240;
  opener.focus();
  d.showDialog('Recovery details', d.node(), [action], { stack: true });
  action.setAttribute('aria-busy', 'true');
  assert.equal(d.dismissDialog(), false);
  assert.match(readText(d.modal), /still running/);
  assert.match(readText(d.modal), /Recovery details/);
  action.removeAttribute('aria-busy');
  assert.equal(d.dismissDialog(), true);
  assert.equal(d.modal.querySelector('.modal-body').scrollTop, 240);
  assert.equal(document.activeElement, opener);
  d.closeDialog();
});
