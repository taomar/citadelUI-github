import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { installDom, readText } from './_dom-stub.mjs';
import { renderValue } from '../web/js/fields.mjs';
import { picker } from '../web/js/picker.mjs';
import { classifyValidation, validateDocument } from '../web/js/validation.mjs';
import { parameterInput, setParameterInput } from '../web/js/contract-edit-state.mjs';
import { previewDocumentText } from '../shared/citadel-core.mjs';
import { checkMigrationValue } from '../shared/migration-schema.mjs';
import { validateNativeValues } from '../shared/terraform/schema.mjs';
import { AZURE_REGION_CATALOG, AZURE_REGIONS, AZURE_REGION_NAMES } from '../shared/azure-regions.mjs';
import { regionOptionsFor } from '../web/js/fields.mjs';

let dom;
beforeEach(() => {
  dom = installDom();
  globalThis.window = dom.node();
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
});

function field(path, schema, value = 'eastus') {
  const state = { parameterInputs: {} }, writes = [];
  const context = {
    native: Boolean(schema?.native),
    inputDraft: (at) => parameterInput(state, at),
    onInputDraft: (at, input) => setParameterInput(state, at, input),
    onChange: (at, next) => {
      writes.push({ path: at, value: next });
      setParameterInput(state, at, null);
    },
  };
  const view = renderValue(value, path, context, schema);
  dom.root.append(view);
  const input = view.matches('input') ? view : view.querySelector('input');
  return { view, input, state, writes, path };
}

const type = (input, value) => { input.focus(); input.value = value; input.dispatch('input'); };
const settled = () => new Promise((resolve) => setTimeout(resolve, 5));

for (const [name, path, schema] of [
  ['primary', ['location'], { name: 'location', type: 'string', allowedValues: ['eastus'] }],
  ['API Center', ['apicLocation'], { name: 'apicLocation', type: 'string', allowedValues: ['', 'eastus'] }],
  ['nested', ['aiFoundryInstances', 0, 'location'], null],
  ['region spelling', ['secondaryRegion'], { name: 'secondaryRegion', type: 'string' }],
  ['native dropdown', ['location'], { name: 'location', type: 'string', allowedValues: ['eastus'], native: true }],
]) {
  test(`custom regions: ${name} accepts an unlisted region with no unsupported warning`, () => {
    const f = field(path, schema);
    type(f.input, 'future-region-999');
    assert.ok(readText(dom.root).includes('Use this region'));
    f.input.dispatch('keydown', { key: 'Enter' });
    assert.deepEqual(f.writes, [{ path, value: 'future-region-999' }]);
    assert.equal(parameterInput(f.state, path), null);
    assert.doesNotMatch(readText(f.view), /unsupported|not one of|reject|custom/i);
    f.input.dispatch('keydown', { key: 'Escape' });
  });
}

test('custom regions: clicking Review preserves and commits text before the action flushes inputs', async () => {
  const f = field(['location'], { name: 'location', type: 'string' });
  const review = dom.node('button');
  dom.root.append(review);
  type(f.input, 'westus3');
  assert.equal(parameterInput(f.state, f.path).value, 'westus3');
  dom.root.dispatch('mousedown', { target: review });
  assert.equal(f.input.value, 'westus3');
  f.input.dispatch('blur');
  review.focus();
  f.input.dispatch('change');
  await settled();
  assert.deepEqual(f.writes, [{ path: ['location'], value: 'westus3' }]);
});

test('custom regions: Tab commits without replacing the value on later blur', async () => {
  const f = field(['location'], null);
  type(f.input, 'newzealandnorth');
  f.input.dispatch('keydown', { key: 'Tab' });
  f.input.dispatch('blur');
  await settled();
  assert.deepEqual(f.writes, [{ path: ['location'], value: 'newzealandnorth' }]);
  assert.equal(f.input.value, 'newzealandnorth');
});

test('custom regions: plain outside blur commits and Escape cancels pending input', async () => {
  const f = field(['location'], null);
  const outside = dom.node('button'); dom.root.append(outside);
  type(f.input, 'malaysiawest');
  dom.root.dispatch('mousedown', { target: outside });
  outside.focus(); f.input.dispatch('blur');
  await settled();
  assert.deepEqual(f.writes, [{ path: ['location'], value: 'malaysiawest' }]);
  type(f.input, 'cancelled-region');
  f.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(f.input.value, 'malaysiawest');
  assert.equal(parameterInput(f.state, f.path), null);
  assert.equal(f.writes.length, 1);
});

test('custom regions: IME Enter cannot commit an unfinished region', () => {
  const f = field(['location'], null);
  type(f.input, 'austriaeast');
  f.input.dispatch('compositionstart');
  f.input.dispatch('keydown', { key: 'Enter', isComposing: true });
  assert.deepEqual(f.writes, []);
  f.input.dispatch('compositionend');
  f.input.dispatch('keydown', { key: 'Enter' });
  assert.equal(f.writes[0].value, 'austriaeast');
});

test('custom regions: expression fallbacks retain their source path and variable name', () => {
  const f = field(['location'], { name: 'location', type: 'string', allowedValues: ['eastus'] },
    { __expr: 'call', callee: 'readEnvironmentVariable', args: ['AZURE_LOCATION', 'eastus'] });
  type(f.input, 'austriaeast');
  f.input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(f.writes[0], { path: ['location', '__args', 1], value: 'austriaeast' });
  assert.equal(previewDocumentText("param location = readEnvironmentVariable('AZURE_LOCATION', 'eastus')\n",
    [{ op: 'set', ...f.writes[0] }]), "param location = readEnvironmentVariable('AZURE_LOCATION', 'austriaeast')\n");
});

test('custom regions: native string fields offer the full catalog without restricting text entry', () => {
  const f = field(['location'], { name: 'location', type: 'string', native: true });
  assert.equal(f.input.getAttribute('role'), 'combobox');
  type(f.input, 'austriaeast');
  f.input.dispatch('change');
  assert.equal(f.writes[0].value, 'austriaeast');
});

test('region catalog: every region dropdown includes public, Government and China names', () => {
  assert.equal(AZURE_REGION_CATALOG.verifiedAt, '2026-09-15');
  assert.equal(AZURE_REGIONS.length, 69);
  assert.equal(new Set(AZURE_REGIONS).size, AZURE_REGIONS.length);
  assert.equal(AZURE_REGION_NAMES.usdodcentral, 'US DoD Central');
  for (const [name, schema, path] of [
    ['primary', { name: 'location', type: 'string', allowedValues: ['eastus'] }, ['location']],
    ['API Center', { name: 'apicLocation', type: 'string', allowedValues: ['', 'westeurope'] }, ['apicLocation']],
    ['nested', null, ['aiFoundryInstances', 0, 'location']],
    ['native', { name: 'location', type: 'string', native: true }, ['location']],
  ]) {
    const values = regionOptionsFor(schema, path);
    for (const region of AZURE_REGIONS) assert.ok(values.includes(region), `${name} is missing ${region}`);
  }
  assert.ok(regionOptionsFor({ name: 'location', allowedValues: ['future-region-999'] }).includes('future-region-999'));
  assert.equal(regionOptionsFor({ name: 'regionCount', type: 'int' }), null);
});

test('custom regions: catalog omissions and region decorators do not become validation flags', () => {
  const doc = {
    params: [
      { name: 'location', value: 'austriaeast' }, { name: 'apicLocation', value: '' },
      { name: 'enableAPICenter', value: true }, { name: 'secondaryRegion', value: 'malaysiawest' },
    ],
    schema: { parameters: {
      location: { type: 'string', allowedValues: ['eastus'] },
      secondaryRegion: { type: 'string', allowedValues: ['eastus'] },
    } },
  };
  assert.deepEqual(validateDocument(doc), []);
  assert.deepEqual(classifyValidation(validateDocument(doc), [], new Set(['location'])), []);
  const other = { params: [{ name: 'sku', value: 'Unknown' }], schema: { parameters: { sku: { allowedValues: ['Known'] } } } };
  assert.equal(validateDocument(other)[0].severity, 'error');
});

test('custom regions: unrelated closed pickers continue to reject unlisted values', () => {
  const writes = [];
  const control = picker(['known'], (value) => writes.push(value), { value: 'known', freeText: false });
  dom.root.append(control.el);
  type(control.input, 'unlisted');
  control.input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(writes, []);
  control.input.dispatch('keydown', { key: 'Escape' });
  assert.equal(control.input.value, 'known');
});

test('custom regions: migration and export accept region strings without relaxing type or length checks', () => {
  const definition = { name: 'location', known: true, type: 'string', minLength: 1, allowedValues: ['eastus'] };
  assert.deepEqual(checkMigrationValue('austriaeast', definition), []);
  assert.match(checkMigrationValue(12, definition)[0], /literal string/);
  assert.match(checkMigrationValue('', definition)[0], /length/);
  assert.match(checkMigrationValue('unlisted', { ...definition, name: 'sku' })[0], /@allowed/);
});

test('custom regions: native top-level and nested region enums remain ordinary strings', () => {
  const region = { type: 'string', allowedValues: ['eastus'] };
  const parameters = {
    location: { ...region, required: true, nullable: false, validations: [] },
    resources: { type: 'array', item: { type: 'object', properties: { region } }, validations: [] },
  };
  assert.deepEqual(validateNativeValues({ location: 'austriaeast', resources: [{region:'malaysiawest'}] }, parameters), []);
  assert.ok(validateNativeValues({ location: 12 }, parameters).some((entry) => /string/.test(entry.message)));
  assert.ok(validateNativeValues({ location: null }, parameters).some((entry) => /nullable/.test(entry.message)));
  assert.ok(validateNativeValues({ tier: 'unlisted' }, {
    tier: { type: 'string', allowedValues: ['known'], validations: [] },
  }).some((entry) => /permitted/.test(entry.message)));
});
