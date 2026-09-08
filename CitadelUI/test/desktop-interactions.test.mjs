import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { readFile } from 'node:fs/promises';
import { installDom, readText } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { picker } from '../web/js/picker.mjs';
import { renderValue } from '../web/js/fields.mjs';
import { renderLlmBackends } from '../web/js/llmview.mjs';
import { renderPolicy } from '../web/js/policyview.mjs';
import { editorField, preserveEditorFocus } from '../web/js/editor-focus.mjs';
import { createGitHubPanel } from '../web/js/github-setup.mjs';
import { createEnvironmentForm } from '../web/js/workspace-settings-view.mjs';
import { CONNECTION_PERSISTENCE_LABEL, connectionStorageDescription } from '../web/js/github-connections.mjs';
import { journeyNewBackends } from './_migration-journey-data.mjs';

const dom = installDom();
const viewport = dom.node();
globalThis.window = {
  addEventListener: (...args) => viewport.addEventListener(...args),
  removeEventListener: (...args) => viewport.removeEventListener(...args),
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
const { showDialog, closeDialog } = await import('../web/js/dialog.mjs');

beforeEach(() => {
  closeDialog();
  dom.root.replaceChildren(dom.modal);
  document.activeElement = dom.root;
});

function all(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => all(child, predicate))];
}
const control = (node, label) => all(node, (item) => item.getAttribute('aria-label') === label)[0];
const button = (node, label) => all(node, (item) => item.tagName === 'BUTTON' && readText(item) === label)[0];

function type(input, value) {
  input.focus();
  input.value = value;
  input.dispatch('input');
}

// Native Chromium coverage accompanies this event-order regression. A bare
// click callback would miss the document mousedown that originally reset input.
function mouseActivate(input, action, { child = action } = {}) {
  dom.root.dispatch('mousedown', { target: child });
  input.dispatch('blur', { relatedTarget: action });
  input.dispatch('focusout', { relatedTarget: action });
  action.focus();
  action.click();
}

test('picker sibling actions consume typed input after mousedown, blur and focus', () => {
  const chosen = [];
  const p = picker(['existing'], (value) => chosen.push(value));
  const action = p.action('Add', { class: 'btn' });
  dom.root.append(p.el, action);
  type(p.input, 'new-model');
  mouseActivate(p.input, action, { child: action.children[0] });
  assert.deepEqual(chosen, ['new-model']);
  assert.equal(p.input.getAttribute('aria-expanded'), 'false');
  assert.equal(dom.root.querySelectorAll('.mp-panel').length, 0);
  assert.equal((dom.root.listeners.get('mousedown') || []).length, 0);
});

test('picker outside cancellation, suggestions, Enter, Escape and closed choices keep their contracts', () => {
  const chosen = [];
  const p = picker(['eastus', 'westus2'], (value) => chosen.push(value), { value: 'eastus', freeText: false });
  const outside = dom.node('button');
  dom.root.append(p.el, outside);
  type(p.input, 'unlisted');
  p.input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(chosen, []);
  p.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(p.input.value, 'eastus');
  type(p.input, 'westus2');
  dom.root.dispatch('mousedown', { target: outside });
  assert.equal(p.input.value, 'eastus');
  assert.deepEqual(chosen, []);
  type(p.input, 'west');
  const suggestion = dom.root.querySelectorAll('.mp-item')[0];
  mouseActivate(p.input, suggestion);
  assert.deepEqual(chosen, ['westus2']);
  type(p.input, 'eastus');
  p.input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(chosen, ['westus2', 'eastus']);
});

test('actual LLM Add model uses the shared action boundary and keeps duplicate/empty constraints', () => {
  const operations = [];
  const view = renderLlmBackends(journeyNewBackends, {
    isOpen: (_key, fallback) => fallback, setOpen() {},
    onAppend: (path, value) => operations.push({ path, value }),
  });
  dom.root.append(view);
  const input = control(view, 'Search the model catalogue, or type your own deployment name');
  const add = button(view, 'Add model');
  type(input, 'desktop-custom-model');
  mouseActivate(input, add);
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0].path, ['llmBackendConfig', 0, 'supportedModels']);
  assert.equal(operations[0].value.name, 'desktop-custom-model');
  type(input, 'chat');
  mouseActivate(input, add);
  type(input, '   ');
  mouseActivate(input, add);
  assert.equal(operations.length, 1, 'duplicate and blank models still cannot be appended');
});

test('actual policy budget action consumes the model without changing the existing fallback', () => {
  const changes = [];
  const limits = { mode: 'universal', universal: { attributes: {} }, perModel: [] };
  const original = structuredClone(limits);
  const view = renderPolicy({ path: 'fixture.xml', text: '<policies />', controls: { tokenLimits: limits } }, {
    policyMode: 'guided', onboardedModels: [{ name: 'chat', backends: ['aif'] }],
    onPolicyChange: (change) => changes.push(change),
  });
  dom.root.append(view);
  const input = all(view, (node) => node.getAttribute('role') === 'combobox')[0];
  type(input, 'chat');
  mouseActivate(input, button(view, 'Give this model its own budget'));
  assert.deepEqual(changes, [{ control: 'tokenLimits', addModel: 'chat' }]);
  assert.deepEqual(limits, original, 'the existing policy remains the mutation pipeline input');
});

for (const [kind, initial, value] of [['text', 'before', 'after'], ['number', 3, 7]]) {
  for (const shiftKey of [false, true]) {
    test(`${kind} Tab commit restores the field before native ${shiftKey ? 'backward' : 'forward'} traversal`, () => {
      const root = dom.node('main');
      dom.root.append(root);
      let current = initial;
      let commits = 0;
      const context = {
        onChange: (path, next) => {
          assert.deepEqual(path, ['setting']);
          current = next;
          commits += 1;
          preserveEditorFocus(root, render);
        },
      };
      function render() { root.replaceChildren(renderValue(current, ['setting'], context, { name: 'setting' })); }
      render();
      const original = control(root, 'Value for setting');
      original.focus();
      original.value = String(value);
      if (kind === 'text') original.setSelectionRange(1, 3, 'backward');
      const event = original.dispatch('keydown', { key: 'Tab', shiftKey });
      const replacement = control(root, 'Value for setting');
      assert.equal(commits, 1);
      assert.equal(current, value);
      assert.notEqual(replacement, original);
      assert.equal(document.activeElement, replacement);
      assert.equal(event.defaultPrevented, false, 'the browser still owns Tab order');
      if (kind === 'text') assert.deepEqual(
        [replacement.selectionStart, replacement.selectionEnd, replacement.selectionDirection], [1, 3, 'backward']);
    });
  }
}

test('nested model fields have distinct stable focus addresses, including optional numeric fields', () => {
  const root = dom.node('main');
  dom.root.append(root);
  const entries = structuredClone(journeyNewBackends);
  const changes = [];
  const write = (path, value) => {
    changes.push({ path, value });
    let target = { llmBackendConfig: entries };
    for (const part of path.slice(0, -1)) target = target[part];
    target[path.at(-1)] = value;
    preserveEditorFocus(root, render);
  };
  function render() {
    root.replaceChildren(renderLlmBackends(entries, {
      isOpen: (key, fallback) => key.includes('-m-') ? true : fallback,
      setOpen() {}, onChange: write, onAddProperty: (path, key, value) => write([...path, key], value),
    }));
  }
  render();
  const capacities = all(root, (node) => node.getAttribute('aria-label') === 'Capacity');
  assert.equal(new Set(capacities.map((node) => node.dataset.editorFocus)).size, 3);
  capacities[2].focus();
  capacities[2].value = '75';
  capacities[2].dispatch('keydown', { key: 'Tab' });
  assert.deepEqual(changes, [{ path: ['llmBackendConfig', 1, 'supportedModels', 1, 'capacity'], value: 75 }]);
  assert.equal(document.activeElement.dataset.editorFocus, capacities[2].dataset.editorFocus);
  const timeouts = all(root, (node) => node.getAttribute('aria-label') === 'Timeout (s)');
  assert.equal(timeouts.length, 3);
  timeouts[0].focus();
  timeouts[0].value = '45';
  timeouts[0].dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(entries[0].supportedModels[0].timeout, 45);
});

test('edit focus restoration does not hijack another control, dialog or disabled replacement', () => {
  const root = dom.node('main');
  const outside = h('button', {}, 'Outside');
  dom.root.append(root, outside);
  const render = (disabled = false) => {
    const next = renderValue('value', ['setting'], { onChange() {} }, null);
    next.disabled = disabled;
    root.replaceChildren(next);
  };
  render();
  outside.focus();
  preserveEditorFocus(root, render);
  assert.equal(document.activeElement, outside);
  root.children[0].focus();
  preserveEditorFocus(root, () => { render(); showDialog('Help', h('div'), [outside]); });
  assert.equal(document.activeElement, outside);
  closeDialog();
  root.children[0].focus();
  preserveEditorFocus(root, () => render(true));
  assert.equal(document.activeElement, dom.root);
});

test('pre-Tab commits ignore unchanged, cancelled, composing, readonly, disabled and combobox controls', () => {
  for (const options of [{}, { key: 'Enter' }, { defaultPrevented: true }, { isComposing: true },
    { disabled: true }, { readOnly: true }, { role: 'combobox' }]) {
    let changes = 0;
    const field = editorField(h('input', {
      type: 'text', value: 'initial', role: options.role, onchange: () => { changes += 1; },
    }), ['field']);
    field.disabled = options.disabled;
    field.readOnly = options.readOnly;
    if (Object.keys(options).length) field.value = 'edited';
    field.dispatch('keydown', { key: 'Tab', ...options });
    assert.equal(changes, 0, JSON.stringify(options));
  }
});

test('removing an edited input cannot commit its reentrant native change twice', () => {
  let changes = 0;
  const field = editorField(h('input', {
    type: 'text', value: 'before',
    onchange: () => {
      changes += 1;
      if (changes === 1) field.dispatch('change', { isTrusted: true });
    },
  }), ['field']);
  field.value = 'after';
  field.dispatch('keydown', { key: 'Tab' });
  assert.equal(changes, 1);
  field.dispatch('change', { isTrusted: true });
  assert.equal(changes, 2, 'ordinary native changes outside the Tab commit remain enabled');
});

async function panel(options = {}) {
  const result = createGitHubPanel({
    sessions: null, listRepositories: async () => ({ repositories: [] }),
    connections: async () => ({ profiles: [], vault: { available: false } }),
    ...options,
  });
  await new Promise(setImmediate);
  return result;
}

for (const method of ['Close', 'Escape']) {
  test(`Settings token help ${method} returns to the same unfinished GitHub form and opener`, async () => {
    const github = await panel();
    const labelInput = h('input', { id: 'unfinished-environment', value: 'Unfinished environment' });
    const form = createEnvironmentForm({
      labelInput, pathInput: h('input'), addButton: h('button'),
      createGitHubPanel: () => github.root,
    });
    showDialog('Workspace settings', form.root);
    form.chooseSource('github');
    const name = control(github.root, 'New connection name');
    name.value = 'Unfinished connection';
    const opener = button(form.root, 'How to create this token');
    opener.focus();
    opener.click();
    assert.match(readText(dom.modal), /Create a GitHub access token/);
    if (method === 'Close') button(dom.modal, 'Close').click();
    else dom.modal.dispatch('keydown', { key: 'Escape' });
    assert.equal(dom.modal.open, true);
    assert(dom.modal.contains(form.root));
    assert.equal(labelInput.value, 'Unfinished environment');
    assert.equal(name.value, 'Unfinished connection');
    assert.equal(button(form.root, 'GitHub repository').getAttribute('aria-pressed'), 'true');
    assert.equal(github.root.parentElement.hidden, false);
    assert.equal(document.activeElement, opener);
    github.dispose();
  });
}

for (const available of [false, true]) {
  test(`Settings persistence has a real label and accurate copy with storage available=${available}`, async () => {
    const github = await panel({ connections: async () => ({ profiles: [], vault: { available } }) });
    const persist = all(github.root, (node) => node.id === 'setup-github-persist')[0];
    assert.equal(persist.parentElement.tagName, 'LABEL');
    assert.equal(persist.parentElement.getAttribute('for'), persist.id);
    assert.equal(readText(persist.parentElement), CONNECTION_PERSISTENCE_LABEL);
    assert.equal(persist.disabled, !available);
    assert.equal(persist.checked, false);
    assert.match(readText(github.root), /Session only/);
    assert.doesNotMatch(readText(github.root), /never stores it/);
    if (available) {
      persist.checked = true;
      persist.dispatch('change');
      assert.match(readText(github.root), /will be saved encrypted on this Citadel server/);
      persist.checked = false;
      persist.dispatch('change');
      assert.match(readText(github.root), /Session only/);
    } else assert.match(readText(github.root), /no usable credential key/);
    github.dispose();
  });
}

test('connected persistence wording uses actual saved metadata rather than the requested checkbox', async () => {
  const github = await panel({ connections: async () => ({ profiles: [], vault: { available: true } }) });
  await github.selection.connect({ login: 'fixture', persisted: true });
  assert.match(readText(github.root), /credential is saved encrypted/);
  await github.selection.connect({ login: 'fixture', persisted: false });
  assert.match(readText(github.root), /Session only/);
  assert.doesNotMatch(readText(github.root), /credential is saved encrypted/);
  assert.match(connectionStorageDescription({ available: true, persist: true, saved: true }), /saved encrypted/);
  github.dispose();
});

test('a storage lookup failure is visible and is not misreported as a missing credential key', async () => {
  const github = await panel({ connections: async () => { throw new Error('Fixture service unavailable'); } });
  assert.match(readText(github.root), /Saved connections could not be loaded: Fixture service unavailable/);
  assert.match(readText(github.root), /disabled until storage availability is confirmed/);
  assert.doesNotMatch(readText(github.root), /no usable credential key/);
  assert.equal(document.getElementById('setup-github-persist'), null, 'the detached panel is not globally indexed');
  assert(all(github.root, (node) => node.id === 'setup-github-persist')[0].disabled);
  github.dispose();
});

for (const persist of [false, true]) {
  test(`Settings sends only the chosen persistence mode (${persist}) and clears the submitted token`, async () => {
    const requests = [];
    const github = await panel({
      connections: async () => ({ profiles: [], vault: { available: true } }),
      sessions: {
        subscribe: () => () => {}, isCurrent: () => true,
        connectProfile: async (request) => {
          requests.push(request);
          return { account: { login: 'fixture', persisted: request.persist }, generation: 1 };
        },
      },
    });
    control(github.root, 'New connection name').value = 'Fixture connection';
    const token = control(github.root, 'GitHub fine-grained personal access token');
    token.value = 'synthetic-token-only';
    const checkbox = all(github.root, (node) => node.id === 'setup-github-persist')[0];
    checkbox.checked = persist;
    checkbox.dispatch('change');
    const connect = button(github.root, 'Connect GitHub');
    for (const listener of connect.listeners.get('click')) await listener({});
    assert.deepEqual(requests, [{ name: 'Fixture connection', token: 'synthetic-token-only', persist }]);
    assert.equal(token.value, '');
    assert.equal(github.selection.connected, true);
    assert.match(readText(github.root), persist ? /credential is saved encrypted/ : /Session only/);
    github.dispose();
  });
}

test('both segmented controls have an inset keyboard outline independent of selected styling', async () => {
  const css = await readFile(new URL('../web/css/components.css', import.meta.url), 'utf8');
  assert.match(css, /\.setup-source-choice \.btn:focus-visible,\s*\.setup-help-tabs \.btn:focus-visible\s*\{[^}]*outline: 2px solid currentColor;[^}]*outline-offset: -4px;/);
});
