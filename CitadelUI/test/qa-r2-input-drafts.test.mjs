import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { installDom } from './_dom-stub.mjs';
import { renderValue } from '../web/js/fields.mjs';
import { exactNumber } from '../shared/terraform/parser.mjs';
import {
  captureContractEdits, clearEditorPending, editorPendingCount, hasParameterInputs,
  parameterInput, retainQuarantinedDraft, restoreContractEdits, setParameterInput,
} from '../web/js/contract-edit-state.mjs';

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
  f.input.value = '1.0e-';
  f.input.dispatch('input');
  f.input.dispatch('change');
  assert.equal(parameterInput(f.state, f.path).value, '1.0e-');
  assert.equal(editorPendingCount(f.state), 1);
  assert.equal(f.commits.length, 0);
  assert(f.input.validationMessage);
  f.input.value = '1.0e-20';
  f.input.dispatch('input');
  f.input.dispatch('change');
  assert.equal(f.commits[0].value.__tfNumber, '1.0e-20');
  assert.equal(hasParameterInputs(f.state), false);
});

test('R2-01 a native browser number buffer keeps its element instead of resetting hidden incomplete text', () => {
  const f = field(2, { type: 'int', name: 'units' });
  f.input.value = '';
  f.input.validity = { badInput: true };
  f.input.validationMessage = 'Enter a number.';
  f.input.dispatch('input');
  assert.equal(parameterInput(f.state, f.path).badInput, true);
  assert.equal(f.render(), f.input);
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
