import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { renderPolicy, rawXmlEditor } from '../web/js/policyview.mjs';
import { renderLlmBackends } from '../web/js/llmview.mjs';
import { MODEL_FIELD_GROUPS, MODEL_FIELDS, BACKEND_FIELD_GROUPS } from '../web/js/llmschema.mjs';
import { editorField } from '../web/js/editor-focus.mjs';
import {
  applyPolicyChanges, readPolicyControls, POLICY_VARIABLES, THROTTLE_SPECS,
} from '../shared/policy.mjs';
import { exactNumber, nativeLiteral } from '../shared/terraform/parser.mjs';

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
const button = (root, text) => all(root, (node) => node.tagName === 'BUTTON' && readText(node) === text)[0];
const wrap = (body) => `\uFEFF\uFEFF<policies>\r\n  <inbound>\r\n    <base />\r\n    <!-- Retain this byte-for-byte. -->\r\n${body}\r\n  </inbound>\r\n</policies>\r\n`;
const headers = (value) => wrap(`    <set-variable name="enableResponseHeaders" value="${value}" />`);
const onboardedModels = ['alpha', 'beta', 'gamma'].map((name) => ({ name, backends: ['primary'] }));

beforeEach(() => {
  dom.root.replaceChildren(dom.modal);
  document.activeElement = document.body;
});

function policyView(source, context = {}) {
  const changes = [], modes = [], opens = new Map();
  const view = renderPolicy({ path: 'synthetic\\policy.xml', text: source, controls: readPolicyControls(source) }, {
    policyMode: 'guided', policyVariables: POLICY_VARIABLES, throttleSpecs: THROTTLE_SPECS, onboardedModels,
    onPolicyChange: (change) => changes.push(change),
    onPolicyRaw: (text) => changes.push({ raw: text }),
    setPolicyMode: (mode) => modes.push(mode),
    isOpen: (key, fallback) => opens.has(key) ? opens.get(key) : fallback,
    setOpen: (key, value) => opens.set(key, value),
    ...context,
  });
  dom.root.append(view);
  return { view, changes, modes, opens };
}

for (const value of ['true', 'false', '1', '', '&quot;true&quot;', '@( true )', '@((bool)context.Variables[&quot;headers&quot;])']) {
  test(`UI policy-model: unsupported response-header representation stays visible and unmodified: ${value}`, () => {
    const source = headers(value);
    const controls = readPolicyControls(source);
    assert(controls.variables.enableResponseHeaders.present);
    assert.equal(controls.responseHeaders, undefined, 'Not a writable Boolean expression');
    const { view, changes } = policyView(source);
    assert.match(readText(view), /Response headers.*Inspect only.*enableResponseHeaders/);
    assert.match(readText(view), /preserved.*Raw XML/);
    assert(!all(view, (node) => node.type === 'checkbox' && node.getAttribute('aria-label') === 'Response headers').length);
    assert.deepEqual(changes, []);
    assert.equal(applyPolicyChanges(source, {}), source);
    assert.equal(applyPolicyChanges(source, { responseHeaders: false }), source,
      'A stale Boolean operation cannot reinterpret this source as a Boolean');
  });
}

for (const value of ['true', 'false', '&#116;rue']) {
  test(`UI policy-model: supported Boolean response-header expression owns only its original span: ${value}`, () => {
    const source = headers(`@(${value})`);
    const controls = readPolicyControls(source);
    assert.equal(controls.responseHeaders.value, value !== 'false');
    assert.deepEqual(controls.responseHeaders.span, controls.variables.enableResponseHeaders.span);
    const { view, changes } = policyView(source);
    const toggle = byName(view, 'Response headers');
    assert.equal(toggle.type, 'checkbox');
    assert.equal(toggle.checked, value !== 'false');
    assert.equal(applyPolicyChanges(source, { responseHeaders: toggle.checked }), source,
      'An unchanged logical value retains the original XML entity spelling');
    toggle.checked = !toggle.checked;
    toggle.dispatch('change');
    assert.deepEqual(changes, [{ control: 'responseHeaders', value: value === 'false' }]);
    const span = controls.responseHeaders.span;
    const saved = applyPolicyChanges(source, { responseHeaders: changes[0].value });
    assert.equal(saved, source.slice(0, span.start) + (changes[0].value ? 'true' : 'false') + source.slice(span.end));
    assert.deepEqual(Buffer.from(saved).subarray(0, 6), Buffer.from([239, 187, 191, 239, 187, 191]));
  });
}

test('UI policy-model: response-header comment examples cannot override or receive edits for the live declaration', () => {
  const example = '    <!-- <set-variable name="enableResponseHeaders" value="@(true)" /> -->';
  const source = wrap(`${example}\r\n    <set-variable name="enableResponseHeaders" value="@(false)" />`);
  const before = readPolicyControls(source);
  assert.equal(before.responseHeaders.value, false);
  const saved = applyPolicyChanges(source, { responseHeaders: true });
  assert(saved.includes(example));
  assert.equal(saved.replace(example, '').match(/value="@\(true\)"/g).length, 1);
  const commented = wrap(example);
  const { view, changes } = policyView(commented);
  assert.equal(readPolicyControls(commented).responseHeaders, undefined);
  assert.match(readText(view), /commented out; it is not active/);
  assert.deepEqual(changes, []);
  const stringLive = wrap(`${example}\r\n    <set-variable name="enableResponseHeaders" value="true" />`);
  assert.equal(readPolicyControls(stringLive).responseHeaders, undefined);
  assert.equal(applyPolicyChanges(stringLive, { responseHeaders: false }), stringLive);
});

test('UI policy-model: an unevaluated Boolean policy variable is inspect-only rather than shown as false', () => {
  const source = wrap('    <set-variable name="jwtRequired" value="@((bool)context.Variables[&quot;requireJwt&quot;])" />');
  const { view, changes } = policyView(source);
  assert.match(readText(view), /Require a JWTInspect onlyjwtRequired/);
  assert(byName(view, 'Require a JWT source value'));
  assert.deepEqual(changes, []);
});

function richPolicy() {
  return applyPolicyChanges(wrap(
    '    <set-variable name="allowedModels" value="alpha,beta" />\r\n' +
    '    <llm-token-limit tokens-per-minute="1000" token-quota="10000" token-quota-period="Daily" counter-key="@(context.Subscription.Id)" />'), {
    tokenLimits: { addModels: ['alpha', 'beta'] },
    rateLimit: { enable: true }, callQuota: { enable: true },
    rateLimits: { addModels: ['alpha', 'beta'] }, quotaLimits: { addModels: ['alpha', 'beta'] },
    contentSafety: { enable: true, addBlocklists: ['first-list', 'second-list'] },
  });
}

test('UI policy-model: all policy removals identify their exact target and retain their operation contract', () => {
  const { view, changes } = policyView(richPolicy());
  for (const [name, expected] of [
    ['Remove allowed model alpha', { control: 'allowedModels', value: 'beta' }],
    ['Remove token limit override for model alpha', { control: 'tokenLimits', removeModel: 'alpha' }],
    ['Remove request rate limit override for model beta', { control: 'rateLimits', removeModel: 'beta' }],
    ['Remove request quota override for model beta', { control: 'quotaLimits', removeModel: 'beta' }],
    ['Stop checking Violence in content safety', { control: 'contentSafety', removeCategory: 'Violence' }],
    ['Stop enforcing blocklist first-list', { control: 'contentSafety', removeBlocklist: 'first-list' }],
  ]) {
    const action = byName(view, name);
    assert(action, name);
    action.click();
    assert.deepEqual(changes.at(-1), expected);
  }
  const destructive = all(view, (node) => node.classList.contains('chip-x') || node.classList.contains('btn-destructive'));
  assert(destructive.length >= 12);
  assert(destructive.every((node) => node.getAttribute('aria-label')?.length > 12));
});

test('UI policy-model: policy advanced disclosures retain state and never produce a policy write', () => {
  const source = richPolicy();
  const { view, changes, opens } = policyView(source);
  const details = view.querySelectorAll('details');
  assert.equal(details.length, 2);
  for (const disclosure of details) {
    assert.equal(disclosure.open, false);
    assert.match(readText(disclosure.querySelector('summary')), /^Advanced request/);
    disclosure.open = true;
    disclosure.dispatch('toggle');
  }
  assert.deepEqual([...opens.values()], [true, true]);
  assert.deepEqual(changes, []);
  assert.equal(applyPolicyChanges(source, {}), source);
});

test('UI policy-model: per-model-only request limits do not invent a writable fallback row', () => {
  const source = wrap('    <choose><when condition="@((string)context.Variables[&quot;requestedModel&quot;] == &quot;alpha&quot;)">' +
    '<rate-limit-by-key calls="10" renewal-period="30" counter-key="alpha" /></when></choose>');
  const { view, changes } = policyView(source);
  assert.match(readText(view), /No fallback is configured/);
  assert.deepEqual(changes, []);
});

test('UI policy-model: expert mode is explicit, publishes scoped focus addresses, and switches through the caller', () => {
  const source = headers('true');
  const { view, changes, modes } = policyView(source);
  const raw = button(view, 'Raw XML (expert)'), guided = button(view, 'Guided');
  assert(raw && guided);
  assert.equal(guided.getAttribute('aria-pressed'), 'true');
  assert.equal(raw.getAttribute('aria-pressed'), 'false');
  assert(raw.dataset.editorFocus.startsWith('policy:"synthetic\\\\policy.xml":'));
  raw.click(); guided.click();
  assert.deepEqual(modes, ['raw', 'guided']);
  assert.deepEqual(changes, [], 'Mode buttons do not discard or write directly');
  assert.match(readText(view), /tag balance, not APIM expression types/);
  assert.match(readText(view), /explicitly confirm discarding/);
});

test('UI policy-model: embedded native XML keeps Terraform markers, entities and line endings on render', () => {
  const xml = '\uFEFF<policies>\r\n<inbound><set-header name="x"><value>${literal} %{literal} &amp; &quot;</value></set-header></inbound>\r\n</policies>\r\n';
  const expected = nativeLiteral(xml, 'hcl');
  const changes = [];
  const view = rawXmlEditor({ text: xml }, { onPolicyRaw: (value) => changes.push(value) });
  dom.root.append(view);
  assert.equal(view.querySelector('textarea').value, xml);
  assert.equal(nativeLiteral(xml, 'hcl'), expected);
  assert.deepEqual(changes, []);
});

const backendFixture = () => [
  { backendId: 'primary', backendType: 'ai-foundry', endpoint: 'https://primary.example.invalid/',
    supportedModels: [{ name: 'alpha', capacity: 100, retirementDate: '2028-01-01', additionalNote: 'preserve' }, { name: 'beta', capacity: 25 }] },
  { backendId: 'secondary', backendType: 'external', endpoint: 'https://secondary.example.invalid/', supportedModels: [{ name: 'alpha', capacity: 1 }] },
];
function modelView(initial = backendFixture(), overrides = {}) {
  const entries = structuredClone(initial), opens = new Map(), operations = [];
  const host = dom.node();
  dom.root.append(host);
  const root = overrides.llmBinding?.root || 'llmBackendConfig';
  const apply = (op, path, value, key) => {
    operations.push({ op, path, value, key });
    assert.equal(path[0], root);
    const parent = path.slice(1, ['append', 'addProperty'].includes(op) ? undefined : -1)
      .reduce((object, part) => object[part], entries);
    if (op === 'append') parent.push(value);
    else if (op === 'remove') Array.isArray(parent) ? parent.splice(path.at(-1), 1) : delete parent[path.at(-1)];
    else if (op === 'addProperty') parent[key] = value;
    else parent[path.at(-1)] = value;
    render();
  };
  const ctx = {
    isOpen: (key, fallback) => opens.has(key) ? opens.get(key) : fallback,
    setOpen: (key, value) => opens.set(key, value),
    rerender: () => render(),
    onChange: (path, value) => apply('set', path, value),
    onAppend: (path, value) => apply('append', path, value),
    onRemove: (path) => apply('remove', path),
    onAddProperty: (path, key, value) => apply('addProperty', path, value, key),
    ...overrides,
  };
  function render() { host.replaceChildren(renderLlmBackends(entries, ctx)); }
  render();
  return { host, ctx, entries, opens, operations, render };
}

test('UI policy-model: model disclosure preserves focus, target headings and source values', () => {
  const before = backendFixture();
  const ui = modelView(before);
  const open = byName(ui.host, 'Edit model details: alpha on backend primary');
  open.focus(); open.click();
  assert.equal(document.activeElement.className, 'lm-editor-toggle');
  assert.match(readText(ui.host.querySelector('.lm-editor')), /alphaIdentity.*Deployment & capacity/);
  const advanced = ui.host.querySelector('.lm-editor').querySelector('details');
  assert.equal(advanced.open, false);
  assert.match(readText(advanced), /Endpoint & request.*Lifecycle & routing.*Additional source fields.*additionalNote/);
  advanced.open = true; advanced.dispatch('toggle'); ui.render();
  assert.equal(ui.host.querySelector('.lm-editor').querySelector('details').open, true);
  const close = ui.host.querySelector('.lm-editor-toggle');
  close.focus(); close.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Edit model details: alpha on backend primary');
  assert.deepEqual(ui.operations, []);
  assert.deepEqual(ui.entries, before);
});

test('UI policy-model: removing models focuses the next model and then the add-model control', () => {
  const ui = modelView(backendFixture().slice(0, 1));
  let remove = byName(ui.host, 'Remove model alpha from backend primary');
  remove.focus(); remove.click();
  assert.match(document.activeElement.getAttribute('aria-label'), /Edit model details: beta/);
  remove = byName(ui.host, 'Remove model beta from backend primary');
  remove.focus(); remove.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Search the model catalogue, or type your own deployment name');
  assert.equal(document.activeElement.getAttribute('aria-description'), 'Adds a model to backend primary.');
  assert.deepEqual(ui.entries[0].supportedModels, []);
  assert.deepEqual(ui.operations.map(({ op, path }) => ({ op, path })), [
    { op: 'remove', path: ['llmBackendConfig', 0, 'supportedModels', 0] },
    { op: 'remove', path: ['llmBackendConfig', 0, 'supportedModels', 0] },
  ]);
});

test('UI policy-model: expanded removal uses the same target and focus contract as a collapsed model', () => {
  const ui = modelView();
  const open = byName(ui.host, 'Edit model details: alpha on backend primary');
  open.focus(); open.click();
  const remove = byName(ui.host, 'Remove model alpha from backend primary');
  assert.equal(readText(remove), 'Remove model');
  remove.focus(); remove.click();
  assert.equal(ui.entries[0].supportedModels[0].name, 'beta');
  assert.notEqual(document.activeElement, document.body);
  assert.match(document.activeElement.getAttribute('aria-label'), /beta.*primary/);
});

test('UI policy-model: backend removal names its consequences and focuses the successor or Add backend', () => {
  const ui = modelView();
  let remove = byName(ui.host, 'Remove backend primary and its 2 models');
  remove.focus(); remove.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Backend secondary');
  remove = byName(ui.host, 'Remove backend secondary and its 1 model');
  remove.focus(); remove.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Add backend');
  assert.deepEqual(ui.entries, []);
});

test('UI policy-model: rejected owned callbacks do not transfer focus or mutate a different model list', () => {
  const ui = modelView(backendFixture(), { onRemove: () => false });
  const remove = byName(ui.host, 'Remove model alpha from backend primary');
  remove.focus(); remove.click();
  assert.equal(document.activeElement, remove);
  assert.deepEqual(ui.entries, backendFixture());
  assert.deepEqual(ui.operations, []);
});

test('UI policy-model: provider selection and cancellation restore a usable focus destination', () => {
  const ui = modelView([]);
  let add = byName(ui.host, 'Add backend');
  add.focus(); add.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Cancel adding a backend');
  document.activeElement.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Add backend');
  assert.deepEqual(ui.operations, []);
  add = document.activeElement;
  add.click();
  const provider = ui.host.querySelector('.picker-item');
  provider.focus(); provider.click();
  assert.equal(ui.entries.length, 1);
  assert.equal(document.activeElement.getAttribute('aria-label'), `Backend ${ui.entries[0].backendId}`);
});

test('UI policy-model: read-only model inspection never offers a destructive action', () => {
  const ui = modelView(backendFixture(), { readOnly: true });
  const open = byName(ui.host, 'Inspect model details: alpha');
  assert(open);
  open.focus(); open.click();
  assert.equal(document.activeElement.className, 'lm-editor-toggle');
  assert(!ui.host.querySelector('.lm-x'));
  assert(!button(ui.host, 'Remove model'));
  assert(!button(ui.host, 'Remove backend'));
  assert(!button(ui.host, 'Add backend'));
  document.activeElement.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Inspect model details: alpha');
  assert.deepEqual(ui.operations, []);
});

test('UI policy-model: schema groups cover all model descriptors and native aliases without changing definitions', () => {
  const keys = new Set(MODEL_FIELD_GROUPS.flatMap((group) => group.keys));
  assert(MODEL_FIELDS.every((field) => keys.has(field.key)));
  for (const key of ['model_format', 'model_version', 'api_version', 'retirement_date', 'session_aware_model']) assert(keys.has(key));
  assert.equal(BACKEND_FIELD_GROUPS[1].label, 'Endpoint & authentication');
});

test('UI policy-model: native grouping preserves exact numeric lexemes and additional declared inputs', () => {
  const initial = [{ backend_id: 'native', backend_type: 'external', endpoint: 'https://native.example.invalid/',
    supported_models: [{ name: 'native-model', model_format: 'OpenAI', model_version: 'native-version', session_aware_model: true,
      capacity: exactNumber('9007199254740993'), api_version: 'v1', retirement_date: '2030-01-01', extra_input: 'keep' }] }];
  const descriptors = Object.keys(initial[0].supported_models[0]).map((key) => ({ key, label: key }));
  const ui = modelView(initial, {
    native: true, llmBinding: { root: 'llm_backend_config', id: 'backend_id', type: 'backend_type', models: 'supported_models' },
    nativeBackendFields: (_entry, path) => h('div', {},
      h('div', { class: 'lf' }, h('span', { class: 'lf-label' }, 'Backend id'),
        editorField(h('input', { 'aria-label': 'Backend id', value: 'native' }), [...path, 'backend_id']))),
    nativeModelFields: descriptors,
    renderModelField: (descriptor, value, path) => editorField(h('div', { class: 'lf' },
      h('input', { 'aria-label': descriptor.label, value: value?.__tfNumber || value })), path),
    nativeDisplay: (value) => value?.__tfNumber || value || 'Not supplied',
  });
  assert.match(readText(ui.host), /OpenAI.*native-version.*9007199254740993.*stateful/);
  const open = ui.host.querySelector('.lm-name');
  open.focus(); open.click();
  assert.match(readText(ui.host), /Deployment & capacity.*Endpoint & request.*Lifecycle & routing.*Additional native inputs/);
  assert.equal(byName(ui.host, 'capacity: model native-model on backend native').value, '9007199254740993');
  assert.equal(byName(ui.host, 'extra_input: model native-model on backend native').value, 'keep');
  assert.deepEqual(ui.entries, initial);
  assert.deepEqual(ui.operations, []);
});

test('UI policy-model: adding a model from a closing picker portal still focuses the new model', () => {
  const ui = modelView(backendFixture().slice(0, 1));
  const search = byName(ui.host, 'Search the model catalogue, or type your own deployment name');
  search.focus();
  search.value = 'new-model';
  search.dispatch('input');
  const option = dom.root.querySelector('.mp-item-free');
  assert(option);
  option.focus(); option.click();
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Edit model details: new-model on backend primary');
  assert.equal(ui.entries[0].supportedModels.at(-1).name, 'new-model');
  assert.equal(ui.operations.length, 1);
});

test('UI policy-model: detached disclosures cannot update the next document view state', () => {
  const ui = modelView();
  const open = ui.host.querySelector('.lm-name');
  open.focus(); open.click();
  const details = ui.host.querySelector('.lm-editor').querySelector('details');
  const before = [...ui.opens];
  ui.host.replaceChildren();
  details.open = true; details.dispatch('toggle');
  assert.deepEqual([...ui.opens], before);
});

test('UI policy-model: retained backend credentials remain discoverable without becoming active defaults', () => {
  const initial = backendFixture().slice(0, 1);
  initial[0].authConfig = { namedValueKey: 'saved-reference', keyVaultSecretUri: 'https://synthetic.example.invalid/secret-reference' };
  initial[0].circuitBreaker = { enabled: false };
  const ui = modelView(initial);
  const retained = ui.host.querySelectorAll('details')
    .find((node) => readText(node.querySelector('summary')).startsWith('Retained credential configuration'));
  assert(retained);
  assert.equal(retained.open, false);
  assert.match(readText(retained), /not required by the selected authentication/);
  assert.equal(byName(retained, 'Named value key: backend primary').value, 'saved-reference');
  assert.match(readText(ui.host), /Additional source fields.*circuitBreaker/);
  assert.deepEqual(ui.entries, initial);
  assert.deepEqual(ui.operations, []);
});

test('UI policy-model: native model details can close even when no identity field is declared', () => {
  const ui = modelView([{ backendId: 'native', supportedModels: [{ capacity: exactNumber('1.00') }] }], {
    native: true, nativeModelFields: [{ key: 'capacity', label: 'Capacity' }],
    nativeBackendFields: () => h('div', {}),
    nativeDisplay: (value) => value?.__tfNumber || 'Not supplied',
    renderModelField: (descriptor, value) => h('input', { 'aria-label': descriptor.label, value: value.__tfNumber }),
  });
  const open = ui.host.querySelector('.lm-name');
  open.focus(); open.click();
  assert.equal(document.activeElement.className, 'lm-editor-toggle');
  document.activeElement.click();
  assert.equal(document.activeElement.className, 'lm-name');
  assert.deepEqual(ui.operations, []);
});
