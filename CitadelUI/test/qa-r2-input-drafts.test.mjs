import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDom } from './_dom-stub.mjs';
import { renderValue } from '../web/js/fields.mjs';
import { pauseEditorForLoad } from '../web/js/editor-load.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { exactNumber } from '../shared/terraform/parser.mjs';
import {
  captureContractEdits, clearEditorPending, editorPendingCount, hasParameterInputs,
  parameterInput, retainQuarantinedDraft, restoreContractEdits, setParameterInput,
} from '../web/js/contract-edit-state.mjs';

const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const inputHandlers = [
  section('function canLeaveIncompleteNumber()', 'function currentValidation('),
  section("window.addEventListener('beforeunload'", '/* -------------------------------------------------------------- edit context */'),
  section('async function withEditorLoad(', 'function rememberDocumentView('),
].join('\n');

const dom = installDom();
beforeEach(() => {
  dom.root.replaceChildren(dom.modal);
  document.activeElement = dom.root;
});

function editor() {
  return {
    workspaceKey: 'qa-workspace', current: { path: 'synthetic.bicepparam', hash: 'original-hash' },
    operations: [], parameterInputs: {}, inputScope: {},
    policyChanges: {}, policyRaw: null, quarantinedDrafts: new Map(),
  };
}

function field(value, schema = { type: 'string', name: 'label' }) {
  const state = editor(), commits = [], path = [schema.name];
  const ctx = {
    native: Boolean(schema.native), inputOwner: state.inputScope,
    inputDraft: (at) => parameterInput(state, at),
    onInputDraft: (at, input) => setParameterInput(state, at, input),
    onChange: (at, next) => {
      commits.push({ path: at, value: next });
      setParameterInput(state, at, null);
    },
  };
  const render = () => {
    const view = renderValue(value, path, ctx, schema);
    dom.root.append(view);
    return view.matches('input, textarea') ? view : view.querySelector('input, textarea');
  };
  const input = render();
  input.setCustomValidity = (message) => { input.validationMessage = message; };
  input.reportValidity = () => !input.validationMessage;
  return { state, commits, path, input, render };
}

for (const [label, value, schema] of [
  ['Bicep scalar', 'original', { type: 'string', name: 'environmentName' }],
  ['Bicep multiline', 'original\nterms', { type: 'string', name: 'productTerms' }],
  ['native scalar', 'original', { type: 'string', name: 'environment_name', native: true }],
  ['secure scalar', 'original', { type: 'string', name: 'secret', secure: true }],
]) {
  test(`R2-01 ${label} becomes pending immediately without a blur, commit or replacement`, () => {
    const f = field(value, schema);
    f.input.focus();
    f.input.value = 'memory-only typed text';
    f.input.setSelectionRange(4, 4);
    f.input.dispatch('input');
    assert.equal(editorPendingCount(f.state), 1);
    assert.equal(parameterInput(f.state, f.path).value, f.input.value);
    assert.equal(document.activeElement, f.input);
    assert.equal(f.input.selectionStart, 4);
    assert.equal(f.input.isConnected, true);
    assert.deepEqual(f.commits, []);
    assert.deepEqual(f.state.operations, []);
    if (schema.secure) assert.equal(f.input.type, 'password');
    f.input.value = value;
    f.input.dispatch('input');
    assert.equal(editorPendingCount(f.state), 0);
  });
}

test('R2-01 IME composition is protected immediately but never committed partway through composition', () => {
  const f = field('original');
  f.input.dispatch('compositionstart');
  f.input.value = '\u65e5\u672c';
  f.input.dispatch('input', { isComposing: true });
  f.input.dispatch('change');
  assert.equal(parameterInput(f.state, f.path).composing, true);
  assert.equal(editorPendingCount(f.state), 1);
  assert.deepEqual(f.commits, []);
  f.input.dispatch('compositionend');
  assert.equal(parameterInput(f.state, f.path).composing, false);
  f.input.dispatch('change');
  assert.equal(f.commits[0].value, '\u65e5\u672c');
  assert.equal(hasParameterInputs(f.state), false);
});

test('R2-01 an incomplete native number remains exact pending text until it can be parsed', () => {
  const f = field(exactNumber('1'), { type: 'number', name: 'ratio', native: true, syntax: 'hcl-tfvars' });
  f.input.focus();
  f.input.value = '1.0e-';
  f.input.setSelectionRange(5, 5);
  f.input.dispatch('input');
  f.input.dispatch('change');
  assert.equal(parameterInput(f.state, f.path).value, '1.0e-');
  assert.equal(editorPendingCount(f.state), 1);
  assert.equal(f.commits.length, 0);
  assert(f.input.validationMessage);
  assert.equal(f.input.type, 'text');
  assert.equal(f.input.isConnected, true);
  assert.equal(document.activeElement, f.input);
  assert.equal(f.input.value, '1.0e-');
  assert.equal(f.input.selectionStart, 5);
  f.input.value = '1.0e-20';
  f.input.dispatch('input');
  f.input.dispatch('change');
  assert.equal(f.commits[0].value.__tfNumber, '1.0e-20');
  assert.equal(hasParameterInputs(f.state), false);
});

test('R2-01 a native browser number buffer keeps its element instead of resetting hidden incomplete text', () => {
  const f = field(2, { type: 'int', name: 'units' });
  f.input.focus();
  f.input.value = '';
  f.input.validity = { badInput: true };
  f.input.validationMessage = 'Enter a number.';
  f.input.dispatch('input');
  assert.equal(parameterInput(f.state, f.path).badInput, true);
  assert.equal(f.render(), f.input);
  assert.equal(f.input.isConnected, true);
  assert.equal(document.activeElement, f.input);
  assert.equal(f.input.value, '');
  assert.equal(f.input.validationMessage, 'Enter a number.');
  f.input.dispatch('change');
  assert.equal(f.commits.length, 0);
});

test('R2-01 pending text snapshots remain document-owned, survive stashing, and are distinct in quarantine', () => {
  const state = editor(), path = ['environmentName'];
  state.operations = [{ op: 'set', path, value: 'last validated value' }];
  setParameterInput(state, path, { value: 'newer unblurred text' });
  assert.equal(editorPendingCount(state), 1, 'one field must not count twice');
  const snapshot = captureContractEdits(state);
  clearEditorPending(state);
  assert.equal(editorPendingCount(state), 0);
  assert.deepEqual(restoreContractEdits(state, snapshot), []);
  assert.equal(parameterInput(state, path).value, 'newer unblurred text');
  state.current = { ...state.current, hash: 'external-change' };
  assert.deepEqual(restoreContractEdits(state, snapshot), ['synthetic.bicepparam']);
  assert.equal(hasParameterInputs(state), false);
  retainQuarantinedDraft(state, snapshot, 'Source changed');
  snapshot.parameterInputs[JSON.stringify(path)].value = 'another retained value';
  retainQuarantinedDraft(state, snapshot, 'Source changed');
  assert.equal(state.quarantinedDrafts.get('synthetic.bicepparam').length, 2);
  assert.throws(() => restoreContractEdits({ ...editor(), workspaceKey: 'other-workspace' }, snapshot), /another workspace/);
});

function appInput(f) {
  const statuses = [], listeners = new Map();
  const notice = dom.node(), workspace = dom.node('main');
  dom.root.append(workspace, notice);
  workspace.append(f.input);
  const matches = f.input.matches.bind(f.input);
  f.input.matches = selector => selector === '[data-parameter-input]'
    ? f.input.dataset.parameterInput !== undefined : matches(selector);
  f.input.blur = () => {
    if (document.activeElement === f.input) document.activeElement = dom.root;
    f.input.dispatch('change');
  };
  const viewStates = new WorkspaceViewState(() => f.state);
  viewStates.activate({ environment: { id: 'c1-input', source: { kind: 'local' } } });
  const scope = {
    state: f.state, viewStates, document, Event, hasParameterInputs, editorPendingCount, pauseEditorForLoad,
    pendingByDocument: new Map(), editorTransition: null,
    els: { workspace, editorLoading: notice },
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    setStatus: (message, tone) => statuses.push({ message, tone }),
    captureDialogStatus: () => () => {},
    restoreStashedPending: () => false, render() {},
  };
  vm.runInNewContext(inputHandlers, scope);
  return { scope, statuses, notice,
    unload() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      listeners.get('beforeunload')(event);
      return event;
    },
  };
}

test('C1 UI: composition and a queued edit remain pending through actual review flush and unload protection', () => {
  const f = field('original'), app = appInput(f), current = f.state.current;
  f.state.operations = [{ op: 'set', path: f.path, value: 'validated queued value' }];
  f.input.focus();
  f.input.dispatch('compositionstart');
  f.input.value = '\u65e5\u672c';
  f.input.dispatch('input', { isComposing: true });
  f.input.dispatch('keydown', { key: 'Tab', isComposing: true });
  assert.equal(editorPendingCount(f.state), 1);
  assert.equal(app.unload().prevented, true);
  assert.equal(app.scope.flushParameterInputs(), false);
  assert.match(app.statuses.at(-1).message, /finish or discard.*retained in memory/);
  assert.equal(parameterInput(f.state, f.path).composing, true);
  assert.equal(parameterInput(f.state, f.path).value, '\u65e5\u672c');
  assert.deepEqual(f.commits, []);
  assert.equal(f.state.current, current);
  assert.equal(f.state.operations[0].value, 'validated queued value');
  f.input.dispatch('compositionend');
  assert.equal(parameterInput(f.state, f.path).composing, false);
  assert.deepEqual(f.commits, [], 'Composition end records input; it is not a source commit.');
  assert.equal(app.scope.flushParameterInputs(), true);
  assert.deepEqual(f.commits, [{ path: f.path, value: '\u65e5\u672c' }]);
  assert.equal(hasParameterInputs(f.state), false);
  assert.equal(app.unload().prevented, true, 'The queued operation still owns unload protection.');
  clearEditorPending(f.state);
  assert.equal(app.unload().prevented, false);
});

test('C1 UI: an incomplete browser number blocks actual navigation without replacing its connected native control', async () => {
  const f = field(2, { type: 'int', name: 'units' }), app = appInput(f);
  f.input.focus();
  f.input.value = '';
  f.input.validity = { badInput: true };
  f.input.validationMessage = 'Enter a number.';
  f.input.dispatch('input');
  const current = f.state.current, snapshot = captureContractEdits(f.state), scope = f.state.inputScope;
  let loads = 0;
  assert.equal(await app.scope.withEditorLoad('Opening', async () => { loads += 1; }), false);
  assert.equal(loads, 0);
  assert.equal(app.scope.editorTransition, null);
  assert.equal(f.state.current, current);
  assert.equal(f.state.inputScope, scope);
  assert.deepEqual(captureContractEdits(f.state), snapshot);
  for (let index = 0; index < 3; index++) assert.equal(f.render(), f.input);
  assert.equal(f.input.isConnected, true);
  assert.equal(f.input.type, 'number');
  assert.equal(f.input.value, '', 'A native badInput does not expose its hidden incomplete lexeme through value.');
  assert.equal(f.input.validity.badInput, true);
  assert.equal(f.input.validationMessage, 'Enter a number.');
  assert.equal(f.input.disabled, false);
  assert.deepEqual(f.commits, []);
  assert.equal(app.unload().returnValue, '');
  assert.match(app.statuses.at(-1).message, /incomplete number.*text remains in the field/);
});

test('C1 UI: pausing the editor preserves exact native numeric draft text, focus and caret until release', () => {
  const f = field(exactNumber('1'), { type: 'number', name: 'ratio', native: true, syntax: 'hcl-tfvars' });
  f.input.focus();
  f.input.value = '1.0e-';
  f.input.setSelectionRange(2, 5, 'backward');
  f.input.dispatch('input');
  f.input.dispatch('change');
  const snapshot = captureContractEdits(f.state), notice = dom.node();
  dom.root.append(notice);
  const pause = pauseEditorForLoad([dom.root], notice, 'Opening a reviewed source');
  assert.equal(f.input.disabled, true);
  assert.equal(dom.root.getAttribute('aria-busy'), 'true');
  pause.refresh();
  assert.deepEqual(captureContractEdits(f.state), snapshot);
  pause.release();
  pause.release();
  assert.equal(f.input.disabled, false);
  assert.equal(dom.root.getAttribute('aria-busy'), null);
  assert.equal(notice.hidden, true);
  assert.equal(f.input.isConnected, true);
  assert.equal(document.activeElement, f.input);
  assert.equal(f.input.value, '1.0e-');
  assert.deepEqual([f.input.selectionStart, f.input.selectionEnd, f.input.selectionDirection], [2, 5, 'backward']);
  assert.deepEqual(f.commits, []);
});

test('C1 UI: a memory-only input stashed under another document still owns unload protection', () => {
  const f = field('original'), app = appInput(f);
  setParameterInput(f.state, f.path, { value: 'unblurred other-document input', composing: true });
  const snapshot = captureContractEdits(f.state);
  app.scope.pendingByDocument.set('other-document', snapshot);
  clearEditorPending(f.state);
  assert.equal(editorPendingCount(f.state), 0);
  assert.equal(app.unload().prevented, true);
  assert.equal(snapshot.parameterInputs[JSON.stringify(f.path)].value, 'unblurred other-document input');
  assert.equal(snapshot.parameterInputs[JSON.stringify(f.path)].composing, true);
  app.scope.pendingByDocument.delete('other-document');
  assert.equal(app.unload().prevented, false);
});
