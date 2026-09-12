import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, readText } from './_dom-stub.mjs';
import { renderValue } from '../web/js/fields.mjs';
import { renderParamDocument } from '../web/js/paramview.mjs';
import { nativeEditContext } from '../web/js/native-controls.mjs';
import * as editorFocus from '../web/js/editor-focus.mjs';
import { parameterInput, setParameterInput } from '../web/js/contract-edit-state.mjs';
import { exactNumber } from '../shared/terraform/parser.mjs';
import { sha256 } from '../shared/source-scope.mjs';
import { TerraformExportSession } from '../web/js/terraform-export-session.mjs';
import { openTerraformExport } from '../web/js/terraform-export-view.mjs';
import {
  exportFixture, fixtureChoices, fixtureFiles, fixtureValues, FIXTURE_ACCESS_PATH, FIXTURE_POLICY,
} from './_terraform-export-fixture.mjs';

let dom;
beforeEach(() => {
  dom = installDom();
  globalThis.window = dom.node();
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag), append = node.append.bind(node);
    // Native append coerces optional values; the base stub only accepts nodes.
    node.append = (...children) => append(...children.map((child) =>
      child instanceof Node ? child : document.createTextNode(String(child))));
    node.validity = { badInput: false };
    node.validationMessage = '';
    node.setCustomValidity = (message) => { node.validationMessage = message; };
    node.reportValidity = () => !node.validationMessage;
    node.scrollIntoView = (options) => { node.scrollOptions = options; };
    return node;
  };
});

function ordinary(value = 1, schema = { name: 'units', type: 'int' }) {
  const state = { parameterInputs: {}, inputScope: {} }, commits = [], path = [schema.name];
  const ctx = {
    native: Boolean(schema.native), inputOwner: state.inputScope,
    inputDraft: (at) => parameterInput(state, at),
    onInputDraft: (at, input) => setParameterInput(state, at, input),
    onChange: (at, next) => { commits.push({ path: at, value: next }); setParameterInput(state, at, null); },
  };
  const render = () => {
    const view = renderValue(value, path, ctx, schema);
    dom.root.append(view);
    return view.matches('input, textarea') ? view : view.querySelector('input, textarea');
  };
  const input = render();
  return { state, path, input, commits, render };
}

const button = (root, label) => root.querySelectorAll('button').find((node) => readText(node) === label);
const control = (root, key) => root.querySelectorAll('input, select, textarea, button, h2')
  .find((node) => node.dataset.exportFocus === key);
const numberKey = 'deployment:bicep/infra/main.bicepparam:target:soft_delete_retention_days';
const publisherKey = 'deployment:bicep/infra/main.bicepparam:target:apim_publisher_name';
const tagsKey = 'deployment:bicep/infra/main.bicepparam:source:["tags"]';

async function exporting({ ready = true, json = false, download } = {}) {
  const values = fixtureValues(), tags = structuredClone(values.deployment.tags);
  if (json) values.deployment.tags = { __expr: 'call', raw: "readEnvironmentVariable('SYNTHETIC_TAGS')" };
  const fixture = exportFixture(fixtureFiles(values));
  const session = new TerraformExportSession({
    contextProvider: () => fixture.context, registry: fixture.registry, activePath: FIXTURE_ACCESS_PATH,
  });
  await session.initialize();
  if (ready) {
    for (const [area, choices] of Object.entries(fixtureChoices())) {
      for (const [key, value] of Object.entries(choices)) session.setInput(area, key, value);
    }
    if (json) session.setInput('deployment', 'source:["tags"]', tags);
  }
  const surface = Object.fromEntries(['shell', 'workspace', 'areas', 'actions', 'rail', 'breadcrumb']
    .map((key) => [key, document.createElement('div')]));
  dom.root.append(surface.shell);
  surface.shell.append(...Object.entries(surface).filter(([key]) => key !== 'shell').map(([, node]) => node));
  surface.workspace.scrollTop = 0;
  const ui = await openTerraformExport({ session, surface, download, confirm: async () => true });
  return { ...fixture, session, surface, ui };
}

test('UI inputs: blank integer remains a visible invalid draft; explicit zero alone commits zero', () => {
  const f = ordinary();
  f.input.value = ''; f.input.dispatch('input'); f.input.dispatch('change');
  assert.deepEqual(f.commits, []);
  assert.equal(parameterInput(f.state, f.path).value, '');
  assert.match(parameterInput(f.state, f.path).validationMessage, /blank.*zero/i);
  assert.equal(f.input.getAttribute('aria-invalid'), 'true');
  const error = document.getElementById(f.input.getAttribute('aria-describedby'));
  assert(error && !error.hidden);
  assert.match(readText(error), /number/i);
  f.input.value = '0'; f.input.dispatch('input'); f.input.dispatch('change');
  assert.deepEqual(f.commits, [{ path: ['units'], value: 0 }]);
  assert.equal(parameterInput(f.state, f.path), null);
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  assert.equal(error.hidden, true);
});

test('UI inputs: blank int expression fallback never becomes zero, empty source text or omission', () => {
  const f = ordinary('2');
  f.input.value = ''; f.input.dispatch('input'); f.input.dispatch('change');
  assert.deepEqual(f.commits, []);
  assert.equal(parameterInput(f.state, f.path).value, '');
  f.input.value = '0'; f.input.dispatch('input'); f.input.dispatch('change');
  assert.equal(f.commits[0].value, '0', 'The int() source fallback remains a string.');
});

for (const [value, message] of [
  ['1.5', /whole|integer/i], ['11', /10/], ['9007199254740993', /exact|safe/i],
  ['1.0000000000000001', /whole|fraction/i], ['1e-9999', /whole|fraction/i],
]) {
  test(`UI inputs: invalid integer ${value} is retained instead of staged`, () => {
    const f = ordinary(1, { type: 'int', name: 'units', minValue: 0, maxValue: 10 });
    f.input.value = value; f.input.dispatch('input'); f.input.dispatch('change');
    assert.deepEqual(f.commits, []);
    assert.equal(parameterInput(f.state, f.path).value, value);
    assert.match(f.input.validationMessage, message);
  });
}

test('UI inputs: whole-valued decimal and exponential spellings remain accepted', () => {
  const f = ordinary(1);
  for (const value of ['7.00', '1.2e1', '100e-2', '0.000e-9999']) {
    f.input.value = value; f.input.dispatch('input'); f.input.dispatch('change');
    assert.equal(f.input.getAttribute('aria-invalid'), null);
  }
  assert.deepEqual(f.commits.map((entry) => entry.value), [7, 12, 1, 0]);
});

test('UI inputs: native badInput retains its connected element, feedback and single Tab listener across repaint', () => {
  const f = ordinary();
  f.input.focus(); f.input.value = ''; f.input.validity.badInput = true;
  f.input.dispatch('input'); f.input.dispatch('change');
  const listeners = f.input.listeners.get('keydown').length;
  for (let index = 0; index < 3; index++) assert.equal(f.render(), f.input);
  assert.equal(f.input.listeners.get('keydown').length, listeners);
  assert.equal(f.input.isConnected, true);
  assert.equal(f.input.getAttribute('aria-invalid'), 'true');
  const error = document.getElementById(f.input.getAttribute('aria-describedby'));
  assert(error && !error.hidden);
  f.input.validity.badInput = false;
  f.input.value = '1'; f.input.dispatch('input');
  assert.equal(parameterInput(f.state, f.path), null);
  assert.equal(f.input.getAttribute('aria-invalid'), null);
});

test('UI inputs: exact native lexemes survive invalid edits, undo and a successful commit', () => {
  const f = ordinary(exactNumber('1'), { type: 'number', name: 'ratio', native: true, syntax: 'hcl-tfvars' });
  f.input.value = '1.0e-'; f.input.dispatch('input'); f.input.dispatch('change');
  assert.deepEqual(f.commits, []);
  assert.equal(parameterInput(f.state, f.path).value, '1.0e-');
  assert.equal(f.input.getAttribute('aria-invalid'), 'true');
  f.input.value = '1'; f.input.dispatch('input');
  assert.equal(parameterInput(f.state, f.path), null);
  assert.equal(f.input.getAttribute('aria-invalid'), null);
  f.input.value = '9007199254740993'; f.input.dispatch('input'); f.input.dispatch('change');
  assert.deepEqual(f.commits, [{ path: ['ratio'], value: { __tfNumber: '9007199254740993' } }]);
});

test('UI inputs: native omitted, null, schema-default and zero are separate explicit actions', () => {
  const changes = [], shape = { type: 'number', hasDefault: true, defaultValue: exactNumber('7'), required: false };
  const doc = { unit: { syntax: 'hcl-tfvars' }, params: [{ name: 'units', value: undefined }],
    schema: { parameters: { units: shape } } };
  const ctx = nativeEditContext(doc, { onChange: (path, value) => changes.push({ path, value }) });
  const value = renderValue(undefined, ['units'], ctx, shape);
  dom.root.append(value);
  assert.match(readText(value), /Not supplied; schema default: 7/);
  button(value, 'Set null').click();
  button(value, 'Use schema default').click();
  button(value, 'Set value').click();
  assert.deepEqual(changes.map((entry) => entry.value), [null, exactNumber('7'), exactNumber('0')]);
  assert.equal(doc.params[0].value, undefined);
});

test('UI inputs: revealing an invalid field opens its disclosure and preserves the requested focus', () => {
  const f = ordinary();
  const details = document.createElement('details');
  dom.root.append(details); details.append(f.input);
  assert.equal(typeof editorFocus.focusEditorControl, 'function');
  assert.equal(editorFocus.focusEditorControl(f.input), true);
  assert.equal(details.open, true);
  assert.equal(document.activeElement, f.input);
  assert.equal(f.input.scrollOptions.block, 'center');
  f.input.disabled = true;
  assert.equal(editorFocus.focusEditorControl(f.input), false);
});

for (const [label, key] of [['string', publisherKey], ['integer', numberKey], ['JSON', tagsKey]]) {
  test(`UI export: unchanged or undo-to-original ${label} input does not require a native change event`, async () => {
    const f = await exporting({ json: label === 'JSON' });
    const input = control(f.ui.body, key), original = input.value;
    input.value = label === 'integer' ? '9' : `${original} changed`;
    input.dispatch('input');
    input.value = original; input.dispatch('input');
    input.dispatch('keydown', { key: 'Tab' });
    button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
    assert.match(readText(f.ui.body), /Review Terraform ZIP/);
    assert(button(f.ui.footer, 'Approve & export ZIP'));
  });
}

test('UI export: blank number does not remove the explicit choice; rejected review identifies and focuses it', async () => {
  const f = await exporting(), input = control(f.ui.body, numberKey);
  input.value = ''; input.dispatch('input'); input.dispatch('change');
  assert.match(readText(f.surface.areas), /1 unfinished input/);
  assert.doesNotMatch(readText(f.surface.areas), /All included settings are ready/);
  assert.equal(f.session.view().areas[0].choices['target:soft_delete_retention_days'], 7);
  assert.equal(control(f.ui.body, numberKey).value, '');
  control(f.surface.areas, 'area:access').click();
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert(!button(f.ui.footer, 'Approve & export ZIP'));
  assert.match(readText(f.ui.body), /soft_delete_retention_days/);
  assert.match(readText(f.ui.body), /blank.*zero/i);
  assert.equal(document.activeElement.dataset.exportFocus, numberKey);
  assert.equal(document.activeElement.getAttribute('aria-invalid'), 'true');
});

test('UI export: a wrong JSON type remains an invalid draft rather than replacing the saved choice', async () => {
  const f = await exporting({ json: true }), input = control(f.ui.body, tagsKey);
  const before = f.session.view().areas[0].choices['source:["tags"]'];
  input.value = '[]'; input.dispatch('input'); input.dispatch('change');
  assert.deepEqual(f.session.view().areas[0].choices['source:["tags"]'], before);
  assert.equal(input.value, '[]');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.match(input.validationMessage, /JSON object/);
});

test('UI export: field actions preserve native pointer focus until their explicit click', async () => {
  const f = await exporting({ ready: false });
  const input = control(f.ui.body, numberKey);
  input.value = '14'; input.dispatch('input');
  const useDefault = control(f.ui.body, `${numberKey}:default`);
  assert.equal(useDefault.dispatch('pointerdown', { button: 0 }).defaultPrevented, true);
  useDefault.click();
  assert.equal(f.session.view().areas[0].choices['target:soft_delete_retention_days'], 7);
  const next = control(f.ui.body, numberKey);
  next.value = '21'; next.dispatch('input');
  const revert = control(f.ui.body, `${numberKey}:revert`);
  assert.equal(revert.dispatch('pointerdown', { button: 0 }).defaultPrevented, true);
  revert.click();
  assert.equal(control(f.ui.body, numberKey).value, '7');
  assert.equal(f.session.view().areas[0].choices['target:soft_delete_retention_days'], 7);
});

test('UI export: a reentrant native change during a field-action repaint cannot replace its explicit default', async () => {
  const f = await exporting({ ready: false }), input = control(f.ui.body, numberKey);
  input.value = '14'; input.dispatch('input');
  const replace = f.ui.body.replaceChildren.bind(f.ui.body);
  let blurred = false;
  f.ui.body.replaceChildren = (...children) => {
    if (!blurred) {
      blurred = true;
      assert.equal(input.isConnected, true);
      input.dispatch('change', { isTrusted: true });
    }
    replace(...children);
  };
  control(f.ui.body, `${numberKey}:default`).click();
  assert.equal(blurred, true);
  assert.equal(f.session.view().areas[0].choices['target:soft_delete_retention_days'], 7);
  assert.equal(control(f.ui.body, numberKey).value, '7');
  const next = control(f.ui.body, numberKey);
  next.value = '21'; next.dispatch('input');
  assert.equal(control(f.ui.body, `${numberKey}:revert`).hidden, false);
  control(f.ui.body, `${numberKey}:revert`).click();
  assert.equal(f.session.view().areas[0].choices['target:soft_delete_retention_days'], 7);
  assert.equal(control(f.ui.body, numberKey).value, '7');
});

test('UI export: native hidden number buffer stays intact while a review rejection reveals its error', async () => {
  const f = await exporting(), input = control(f.ui.body, numberKey);
  input.value = ''; input.validity.badInput = true; input.dispatch('input'); input.dispatch('change');
  control(f.surface.areas, 'area:access').click();
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert(document.activeElement === input, 'The retained native number control receives focus.');
  assert.equal(input.validity.badInput, true);
  assert.equal(input.isConnected, true);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(f.session.view().areas[0].choices['target:soft_delete_retention_days'], 7);
});

test('UI export: invalid JSON remains visible, described and focused; excluded-area input does not block other areas', async () => {
  const f = await exporting({ json: true }), input = control(f.ui.body, tagsKey);
  input.value = '['; input.dispatch('input'); input.dispatch('change');
  control(f.surface.areas, 'area:access').click();
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert.equal(document.activeElement.dataset.exportFocus, tagsKey);
  assert.equal(document.activeElement.value, '[');
  assert.match(readText(f.ui.body), /JSON/);
  const error = document.getElementById(document.activeElement.getAttribute('aria-describedby'));
  assert(error && !error.hidden);
  const include = control(f.surface.areas, 'include:deployment');
  include.checked = false; include.dispatch('change'); await f.ui.whenIdle();
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert.equal(f.ui.body.querySelectorAll('.tf-review-file').length, 2);
  button(f.ui.footer, 'Back to mapping').click();
  const reinclude = control(f.surface.areas, 'include:deployment');
  reinclude.checked = true; reinclude.dispatch('change'); await f.ui.whenIdle();
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert(!button(f.ui.footer, 'Approve & export ZIP'));
  assert.equal(document.activeElement.dataset.exportFocus, tagsKey);
});

test('UI export: default and Revert input actions resolve only their own invalid field', async () => {
  const f = await exporting({ ready: false }), input = control(f.ui.body, numberKey);
  input.value = ''; input.dispatch('input'); input.dispatch('change');
  control(f.ui.body, `${numberKey}:default`).click();
  assert.equal(control(f.ui.body, numberKey).value, '7');
  assert.equal(f.session.view().areas[0].choices['target:soft_delete_retention_days'], 7);
  const next = control(f.ui.body, numberKey);
  next.value = ''; next.dispatch('input'); next.dispatch('change');
  control(f.ui.body, `${numberKey}:revert`).click();
  assert.equal(control(f.ui.body, numberKey).value, '7');
  assert.equal(control(f.ui.body, numberKey).getAttribute('aria-invalid'), null);
  assert.equal(document.activeElement.dataset.exportFocus, numberKey);
});

test('UI export: review focuses its heading at the top and Back restores a separate mapping position', async () => {
  const f = await exporting();
  f.surface.workspace.scrollTop = 812;
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert.equal(f.surface.workspace.scrollTop, 0);
  assert.equal(document.activeElement.id, 'tf-review-heading');
  f.surface.workspace.scrollTop = 245;
  button(f.ui.footer, 'Back to mapping').click();
  assert.equal(f.surface.workspace.scrollTop, 812);
  assert.equal(document.activeElement.dataset.exportFocus, 'Review ZIP');
});

test('UI export: shared format icons decorate known source and target headings without renaming them', async () => {
  const f = await exporting();
  const heading = document.getElementById('tf-export-heading');
  assert.equal(readText(heading), 'Azure Deployment - Terraform export');
  assert.equal(heading.querySelector('img').getAttribute('src'), '/icons/terraform.svg');
  assert.equal(f.ui.body.querySelector('.tf-source-selection').querySelector('img').getAttribute('src'), '/icons/bicep.svg');
  for (const icon of f.ui.body.querySelectorAll('img')) {
    assert.equal(icon.getAttribute('alt'), '');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
  }
  const source = control(f.ui.body, 'source:deployment');
  source.value = ''; source.dispatch('change'); await f.ui.whenIdle();
  assert.equal(f.ui.body.querySelector('.tf-source-selection').querySelectorAll('img').length, 0,
    'An unselected source is not assigned a format symbol.');
  const restore = control(f.ui.body, 'source:deployment');
  restore.value = 'bicep/infra/main.bicepparam'; restore.dispatch('change'); await f.ui.whenIdle();
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert.equal(readText(document.activeElement), 'Review Terraform ZIP');
  assert.equal(document.activeElement.querySelector('img').getAttribute('src'), '/icons/terraform.svg');
});

test('UI export: a retained input removed by a source reload stays blocked with focused recovery, never reapplied', async () => {
  const f = await exporting({ json: true }), input = control(f.ui.body, tagsKey);
  input.value = '['; input.dispatch('input'); input.dispatch('change');
  f.root.put('bicep/infra/main.bicepparam', fixtureFiles()['bicep/infra/main.bicepparam']);
  button(f.ui.footer, 'Reload saved source').click(); await f.ui.whenIdle();
  assert.equal(control(f.ui.body, tagsKey), undefined);
  f.surface.workspace.scrollTop = 700;
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  assert(!button(f.ui.footer, 'Approve & export ZIP'));
  assert.equal(f.surface.workspace.scrollTop, 0);
  assert.equal(document.activeElement.dataset.exportFocus, 'export-notice');
  assert.match(readText(document.activeElement), /no longer offers this input.*Exit export/);
  assert.equal(Object.hasOwn(f.session.view().areas[0].choices, 'source:["tags"]'), false);
});

test('UI export: review and download keep exact ZIP, literal policy escaping and all source bytes', async () => {
  let downloaded;
  const f = await exporting({ download: async (file) => { downloaded = file; } });
  const before = f.root.allFiles().map(({ path, bytes }) => ({ path, bytes: Array.from(bytes) }));
  button(f.ui.footer, 'Review ZIP').click(); await f.ui.whenIdle();
  const review = f.session.view().review;
  assert.equal(review.files.length, 3);
  const access = review.files.find((file) => file.path.includes('access-contracts'));
  assert.match(access.text, /\$\$\{not_a_terraform_expression\}/);
  assert.match(access.text, /%%\{not_a_directive\}/);
  assert(FIXTURE_POLICY.includes('${not_a_terraform_expression}'));
  button(f.ui.footer, 'Approve & export ZIP').click(); await f.ui.whenIdle();
  assert.equal(await sha256(downloaded.bytes), review.zipHash);
  assert.equal(downloaded.bytes.length, review.size);
  assert.deepEqual(f.root.allFiles().map(({ path, bytes }) => ({ path, bytes: Array.from(bytes) })), before);
  assert(!f.root.owner.trace.some((entry) => /write|create|remove/i.test(entry.operation)));
});

test('UI explanations: absent parameter blocks never reach native append as null or undefined', () => {
  const view = renderParamDocument({
    params: [{ name: 'environmentName', value: 'synthetic', kind: 'string', doc: [] }],
  }, {
    allParameters: true, schemaFor: () => ({ type: 'string' }), pendingFor: () => false,
    findingsFor: () => [], isOpen: () => true, setOpen: () => {}, onChange: () => {},
  });
  dom.root.append(view);
  view.querySelector('.explain-trigger').focus();
  const text = readText(dom.root.querySelector('.explain-body'));
  assert.match(text, /environmentName.*Typestring/);
  assert.doesNotMatch(text, /null|undefined/);
});

test('UI explanations: nested optional children disappear without erasing literal sentinel words or zero', async () => {
  const { explains } = await import('../web/js/explain.mjs?ui-input-export-optional-children');
  const trigger = document.createElement('button');
  explains(trigger, () => [null, undefined, false, ['Literal null and undefined ', 0, [null]]]);
  dom.root.append(trigger); trigger.focus();
  assert.equal(readText(dom.root.querySelector('.explain-body')), 'Literal null and undefined 0');
  dom.root.dispatch('keydown', { key: 'Escape' });
  assert(!dom.root.querySelector('.explain-open'));
  assert(document.activeElement === trigger, 'Escape dismisses the explanation without stranding focus on BODY.');
});
