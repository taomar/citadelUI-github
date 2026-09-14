import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { renderPolicy } from '../web/js/policyview.mjs';
import { renderLlmBackends } from '../web/js/llmview.mjs';
import { applyPolicyChanges, readPolicyControls, decodePolicyAttribute, POLICY_VARIABLES } from '../shared/policy.mjs';

const dom = installDom();
const viewport = dom.node();
globalThis.window = {
  addEventListener: (...args) => viewport.addEventListener(...args),
  removeEventListener: (...args) => viewport.removeEventListener(...args),
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
const all = (node, predicate) => [
  ...(predicate(node) ? [node] : []),
  ...node.children.flatMap((child) => all(child, predicate)),
];
const byName = (root, name) => all(root, (node) => node.getAttribute('aria-label') === name)[0];
const example = '    <!-- <set-variable name="enableResponseHeaders" value="@(true)" /> -->';
const source = (value) => '\uFEFF\uFEFF<policies>\r\n  <inbound>\r\n' + example + '\r\n' +
  `    <set-variable name="enableResponseHeaders" value="${value}" />\r\n` +
  '    <set-variable name="jwtAudience" value="retained&amp;quot;&amp;value)" />\r\n  </inbound>\r\n</policies>\r\n';

beforeEach(() => {
  dom.root.replaceChildren(dom.modal);
  dom.modal.replaceChildren();
  dom.modal.close();
  document.activeElement = document.body;
});

for (const [value, expected] of [
  ['@(true', '@(true'], ['@(false', '@(false'], ['@(&#116;rue', '@(true'],
  ['literal)', 'literal)'], [')', ')'], ['@(', '@('], ['@(true))', '@(true))'],
  ['literal&#41;', 'literal)'], ['@(false&#41;', '@(false)'],
  ['&#64;&#40;true&#41;', '@(true)'], ['@{return true;}', '@{return true;}'],
  ['&amp;quot;literal&amp;quot;)', '&quot;literal&quot;)'],
  ['&quot;literal&quot;)', '"literal")'], ['&lt;literal&gt;)', '<literal>)'],
]) {
  test(`UI policy-model corrections: full inspect-only attribute and mutation refusal: ${value}`, () => {
    const xml = source(value);
    const controls = readPolicyControls(xml);
    const variable = controls.variables.enableResponseHeaders;
    assert.equal(variable.commented, false);
    assert.equal(variable.sourceValue, expected);
    assert.equal(controls.responseHeaders, undefined);
    const changes = [];
    const view = renderPolicy({ path: 'test\\policy.xml', text: xml, controls }, {
      policyMode: 'guided', policyVariables: POLICY_VARIABLES,
      onPolicyChange: (change) => changes.push(change), setPolicyMode: () => {},
    });
    assert.equal(readText(byName(view, 'Response headers source value')), expected);
    assert.match(readText(view), /Inspect only/);
    assert(!byName(view, 'Response headers'));
    if (expected.startsWith('@')) assert.match(readText(view), /only toggles complete Boolean expressions/);
    assert.deepEqual(changes, []);
    for (const operation of [{}, { responseHeaders: true }, { responseHeaders: false }])
      assert.deepEqual(Buffer.from(applyPolicyChanges(xml, operation)), Buffer.from(xml));
  });
}

for (const body of ['true', 'false', '&#116;rue', '&#x66;alse']) {
  test(`UI policy-model corrections: complete Boolean edits retain the live body span and all other bytes: ${body}`, () => {
    const xml = source(`@(${body})`);
    const controls = readPolicyControls(xml);
    const enabled = decodePolicyAttribute(body) === 'true';
    assert.equal(controls.responseHeaders.value, enabled);
    assert.equal(controls.variables.enableResponseHeaders.sourceValue, `@(${decodePolicyAttribute(body)})`);
    const { start, end } = controls.responseHeaders.span;
    assert.equal(xml.slice(start, end), body);
    assert.equal(applyPolicyChanges(xml, { responseHeaders: enabled }), xml);
    const changed = applyPolicyChanges(xml, { responseHeaders: !enabled });
    assert.equal(changed, xml.slice(0, start) + String(!enabled) + xml.slice(end));
    assert(changed.includes(example));
    assert.deepEqual(Buffer.from(changed).subarray(0, 6), Buffer.from(xml).subarray(0, 6));
    assert(!/(?<!\r)\n/.test(changed));
  });
}

test('UI policy-model corrections: commented examples and generic variable spans keep their established behavior', () => {
  const xml = source('@(false');
  const generic = readPolicyControls(xml).variables.jwtAudience;
  assert.equal(generic.value, 'retained&quot;&value');
  assert.equal(generic.sourceValue, 'retained&quot;&value)');
  assert.equal(xml.slice(generic.span.start, generic.span.end), 'retained&amp;quot;&amp;value');
  assert.equal(applyPolicyChanges(xml, { variables: { jwtAudience: generic.value } }), xml);
  const changed = applyPolicyChanges(xml, { variables: { jwtAudience: 'updated' } });
  assert.equal(changed, xml.slice(0, generic.span.start) + 'updated' + xml.slice(generic.span.end));
  const commented = '<policies><inbound><!-- <set-variable name="enableResponseHeaders" value="@(false" /> --></inbound></policies>';
  assert.equal(readPolicyControls(commented).variables.enableResponseHeaders.sourceValue, '@(false');
  assert.equal(readPolicyControls(commented).variables.enableResponseHeaders.commented, true);
  assert.equal(applyPolicyChanges(commented, { responseHeaders: true }), commented);
});

test('UI policy-model corrections: a legacy inspection payload reports absent full source rather than inventing it', () => {
  const xml = source('literal)');
  const controls = readPolicyControls(xml);
  delete controls.variables.enableResponseHeaders.sourceValue;
  const view = renderPolicy({ path: 'test\\policy.xml', text: xml, controls }, {
    policyMode: 'guided', onPolicyChange: () => { throw new Error('Inspection must not mutate.'); },
    setPolicyMode: () => {},
  });
  assert.equal(readText(byName(view, 'Response headers source value')), 'Full attribute representation unavailable in this view.');
  assert.match(readText(view), /Raw XML \(expert\) to inspect the complete attribute/);
});

function mount(id, options = {}) {
  const host = h('section', { id });
  (options.modal ? dom.modal : dom.root).append(host);
  if (options.modal) dom.modal.showModal();
  const initial = [{
    backendId: 'primary', backendType: 'ai-foundry', endpoint: 'https://test.invalid/',
    supportedModels: [{ name: 'alpha', capacity: 100 }, { name: 'beta', capacity: 25 }],
  }];
  const state = { entries: structuredClone(initial), calls: [], operations: [], opens: new Map(), current: true };
  const scope = { root: host, isCurrent: () => state.current };
  function render() {
    const context = options.freshContext ? { ...ctx } : ctx;
    if (options.rebuildMount) {
      const inner = h('div', {}, renderLlmBackends(state.entries, context));
      host.replaceChildren(inner);
    } else host.replaceChildren(renderLlmBackends(state.entries, context));
  }
  function remove(path) {
    state.calls.push(path);
    if (options.mode === 'reject') return false;
    if (options.mode === 'ignore') return;
    if (options.mode === 'reject-redraw') { render(); return false; }
    if (options.mode === 'dialog') {
      dom.modal.replaceChildren(h('button', { id: 'dialog-owner' }, 'Dialog owns focus'));
      dom.modal.showModal();
      document.getElementById('dialog-owner').focus();
      return false;
    }
    if (options.mode === 'outside') {
      render();
      const outside = h('button', { id: 'outside-owner' }, 'New owner');
      dom.root.append(outside);
      outside.focus();
      return false;
    }
    if (options.mode === 'stale') { state.current = false; render(); return false; }
    const parent = path.slice(1, -1).reduce((object, key) => object[key], state.entries);
    parent.splice(path.at(-1), 1);
    state.operations.push(path);
    render();
    return true;
  }
  const ctx = {
    readOnly: Boolean(options.readOnly),
    ...(options.explicitScope ? { modelFocus: scope } : {}),
    isOpen: (key, fallback) => state.opens.has(key) ? state.opens.get(key) : fallback,
    setOpen: (key, value) => state.opens.set(key, value), rerender: render,
    onRemove: remove,
    onAppend: (path, value) => {
      state.calls.push(path);
      if (options.mode === 'reject') return false;
      if (options.mode === 'ignore') return;
      if (options.mode === 'stale') { state.current = false; render(); return false; }
      const parent = path.slice(1).reduce((object, key) => object[key], state.entries);
      parent.push(value);
      state.operations.push(path);
      render();
      return true;
    },
    onChange: () => { throw new Error('Unexpected scalar mutation.'); },
    onAddProperty: () => { throw new Error('Unexpected property mutation.'); },
  };
  render();
  return { host, state, initial, render };
}

for (const modal of [false, true]) {
  test(`UI policy-model corrections: expand and close stay in the clicked readonly viewer, modal=${modal}`, () => {
    const first = mount('first', { readOnly: true });
    const second = mount('second', { readOnly: true, modal });
    const open = byName(second.host, 'Inspect model details: alpha');
    open.focus(); open.click();
    assert(second.host.contains(document.activeElement));
    assert.equal(document.activeElement.className, 'lm-editor-toggle');
    document.activeElement.click();
    assert(second.host.contains(document.activeElement));
    assert.equal(document.activeElement.getAttribute('aria-label'), 'Inspect model details: alpha');
    assert.deepEqual(first.state.entries, first.initial);
    assert.deepEqual(second.state.entries, second.initial);
    assert.deepEqual(first.state.operations, []);
    assert.deepEqual(second.state.operations, []);
  });
}

for (const mode of ['accept', 'reject', 'ignore', 'reject-redraw', 'dialog', 'outside']) {
  test(`UI policy-model corrections: structural callback keeps its owning view or explicit new focus: ${mode}`, () => {
    const first = mount('first');
    const second = mount('second', { mode });
    const remove = byName(second.host, 'Remove model alpha from backend primary');
    remove.focus(); remove.click();
    if (mode === 'dialog') assert.equal(document.activeElement.id, 'dialog-owner');
    else if (mode === 'outside') assert.equal(document.activeElement.id, 'outside-owner');
    else assert(second.host.contains(document.activeElement));
    assert.equal(second.state.calls.length, 1);
    assert.deepEqual(first.state.entries, first.initial);
    if (mode !== 'accept') {
      assert.deepEqual(second.state.entries, second.initial);
      assert.deepEqual(second.state.operations, []);
    } else assert.equal(second.state.entries[0].supportedModels[0].name, 'beta');
  });
}

for (const mode of ['accept', 'reject', 'ignore']) {
  test(`UI policy-model corrections: a closing portal resolves only its owner, callback=${mode}`, () => {
    const first = mount('first');
    const second = mount('second', { mode });
    const search = byName(second.host, 'Search the model catalogue, or type your own deployment name');
    search.focus(); search.value = 'new-model'; search.dispatch('input');
    const option = dom.root.querySelector('.mp-item-free');
    option.focus(); option.click();
    assert(second.host.contains(document.activeElement));
    assert.equal(document.activeElement.getAttribute('aria-label'), mode === 'accept'
      ? 'Edit model details: new-model on backend primary'
      : 'Search the model catalogue, or type your own deployment name');
    assert.deepEqual(first.state.entries, first.initial);
    assert.deepEqual(document.body.dataset, {}, 'BODY is never tagged with a model address.');
  });
}

test('UI policy-model corrections: an explicit owner scopes rebuilt contexts and mounts without widening to BODY', () => {
  mount('first');
  const second = mount('second', { explicitScope: true, freshContext: true, rebuildMount: true });
  const open = byName(second.host, 'Edit model details: alpha on backend primary');
  open.focus(); open.click();
  assert.equal(document.activeElement.className, 'lm-editor-toggle');
  assert(second.host.contains(document.activeElement));
  const remove = byName(second.host, 'Remove model alpha from backend primary');
  remove.focus(); remove.click();
  assert(second.host.contains(document.activeElement));
  assert.match(document.activeElement.getAttribute('aria-label'), /beta/);
});

test('UI policy-model corrections: a changed captured owner forbids replacement and portal focus', () => {
  mount('first');
  const second = mount('second', { mode: 'stale', explicitScope: true, freshContext: true });
  const remove = byName(second.host, 'Remove model alpha from backend primary');
  remove.focus(); remove.click();
  assert.equal(document.activeElement, document.body);
  assert.deepEqual(second.state.entries, second.initial);
  const third = mount('third', { mode: 'stale', explicitScope: true });
  const search = byName(third.host, 'Search the model catalogue, or type your own deployment name');
  search.focus(); search.value = 'uncommitted'; search.dispatch('input');
  const option = dom.root.querySelector('.mp-item-free');
  option.focus(); option.click();
  assert.equal(document.activeElement, document.body);
  assert.deepEqual(third.state.entries, third.initial);
});

test('UI policy-model corrections: an unrelated fresh context cannot inherit a path-only focus address', () => {
  mount('first');
  const second = mount('second', { freshContext: true });
  const open = byName(second.host, 'Edit model details: alpha on backend primary');
  open.focus(); open.click();
  assert.equal(document.activeElement, document.body, 'A new unregistered owner needs the explicit scoped contract, not a global match.');
  assert.deepEqual(second.state.operations, []);
});

test('UI policy-model corrections: an incomplete explicit focus contract fails visibly', () => {
  assert.throws(() => renderLlmBackends([], { modelFocus: { root: dom.root } }), /modelFocus requires/);
});

test('UI policy-model corrections: context prototype methods and callback receivers remain compatible', () => {
  const host = dom.node();
  dom.root.append(host);
  class Context {
    #opens = new Map();
    #entries = [{ backendId: 'primary', backendType: 'ai-foundry', endpoint: 'https://test.invalid/',
      supportedModels: [{ name: 'alpha' }, { name: 'beta' }] }];
    writes = 0;
    isOpen(key, fallback) { return this.#opens.has(key) ? this.#opens.get(key) : fallback; }
    setOpen(key, value) { this.#opens.set(key, value); }
    rerender() { host.replaceChildren(renderLlmBackends(this.#entries, this)); }
    onRemove(path) {
      assert.equal(this, ctx);
      this.#entries[0].supportedModels.splice(path.at(-1), 1);
      this.writes++;
      this.rerender();
      return true;
    }
  }
  const ctx = new Context();
  ctx.rerender();
  const open = byName(host, 'Edit model details: alpha on backend primary');
  open.focus(); open.click();
  assert.equal(document.activeElement.className, 'lm-editor-toggle');
  const remove = byName(host, 'Remove model alpha from backend primary');
  remove.focus(); remove.click();
  assert.equal(ctx.writes, 1);
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Close details for model beta on backend primary');
  document.activeElement.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Edit model details: beta on backend primary');
});
