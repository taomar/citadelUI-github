import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CATALOGUE, getSample } from '../src/catalogue/index.mjs';
import { buildConfigureModel } from '../src/view/models.mjs';
import {
  buildConfigureRenderContract,
  buildSourceInspectorContract,
  configureFieldControlId,
  renderConfigure,
  renderSourceInspector,
} from '../web/js/render/configure.mjs';
import { makeFixtureReader } from './helpers/fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../web/js/render/configure.mjs', import.meta.url));
const CSS_PATH = fileURLToPath(new URL('../web/css/configure.css', import.meta.url));

test('the integration surface exports the configure document and source inspector', () => {
  assert.equal(typeof renderConfigure, 'function');
  assert.equal(typeof renderSourceInspector, 'function');
  assert.equal(configureFieldControlId('hub.subscriptionId'), 'f-hub-subscriptionId');
});

test('the configure contract renders every declared field exactly once', () => {
  const read = makeFixtureReader();
  for (const sample of CATALOGUE.samples) {
    const configure = buildConfigureModel({ sample, read, hasSecret: () => true });
    const declared = configure.groups.flatMap((group) => group.fields.map((field) => field.path));
    const contract = buildConfigureRenderContract(configure);
    const rendered = contract.fields.map((field) => field.path);

    assert.equal(new Set(rendered).size, rendered.length, `${sample.id} duplicated a field control`);
    assert.deepEqual(
      [...rendered].sort(),
      [...declared].sort(),
      `${sample.id} did not retain one canonical control for every declared field`,
    );
  }
});

test('required, active conditional, secret, and advanced fields keep the binding order', () => {
  const field = (path, requirement, overrides = {}) => ({
    path,
    label: path,
    type: 'string',
    requirement,
    requirementReason: `${path} is needed.`,
    errors: [],
    needed: [],
    warnings: [],
    ...overrides,
  });
  const contract = buildConfigureRenderContract({
    blockingCount: 2,
    errorCount: 0,
    groups: [
      {
        fields: [
          field('defaults.value', 'optional'),
          field('credentials.key', 'secret', { type: 'secret', blocking: true }),
          field('conditional.inactive', 'conditional', { conditionActive: false }),
          field('required.value', 'mandatory', { blocking: true }),
          field('generated.value', 'generated'),
          field('conditional.active', 'conditional', { conditionActive: true }),
        ],
      },
    ],
  });

  assert.deepEqual(contract.sections.map((group) => group.id), ['required', 'conditional', 'secret', 'advanced']);
  assert.deepEqual(
    contract.fields.map((entry) => entry.path),
    [
      'required.value',
      'conditional.active',
      'credentials.key',
      'defaults.value',
      'conditional.inactive',
      'generated.value',
    ],
  );
  assert.equal(contract.sections.at(-1).collapsed, true);
  assert.equal(contract.firstBlockingPath, 'required.value', 'the missing action follows visual blocker order');
});

test('secret fields are password controls and never carry a model value', () => {
  const configure = buildConfigureModel({
    sample: getSample('weather-mcp-discovery'),
    read: makeFixtureReader(),
    hasSecret: () => true,
  });
  const contract = buildConfigureRenderContract(configure);
  const secret = contract.fields.find((field) => field.path === 'gatewayAccess.apiKey');

  assert.equal(secret.inputType, 'password');
  assert.equal(secret.value, '');
  assert.equal(secret.secretSet, true);
});

test('duplicate field paths fail before a second canonical control can render', () => {
  const duplicate = {
    path: 'hub.subscriptionId',
    label: 'Subscription ID',
    type: 'string',
    requirement: 'mandatory',
    requirementReason: 'Required.',
    errors: [],
    needed: [],
    warnings: [],
  };
  assert.throws(
    () => buildConfigureRenderContract({ groups: [{ fields: [duplicate, { ...duplicate }] }] }),
    /declared more than once/,
  );
});

test('the source contract emits only the selected cited cell', () => {
  const source = {
    state: 'ready',
    protected: true,
    editable: false,
    cells: [
      { cellIndex: 4, text: 'first', protected: true, editable: false },
      { cellIndex: 8, text: 'selected', protected: true, editable: false },
      { cellIndex: 12, text: 'last', protected: true, editable: false },
    ],
  };
  const contract = buildSourceInspectorContract(source, 8);

  assert.deepEqual(contract.cellIndexes, [4, 8, 12]);
  assert.equal(contract.cellCount, 3);
  assert.equal(contract.cells.length, 1);
  assert.equal(contract.cells[0].cellIndex, 8);
  assert.equal(contract.cells[0].text, 'selected');
  assert.equal(contract.editable, false);
});

test('the source contract falls back to the first cited cell without expanding the rest', () => {
  const source = {
    state: 'ready',
    cells: [
      { cellIndex: 2, text: 'first' },
      { cellIndex: 3, text: 'second' },
    ],
  };
  const contract = buildSourceInspectorContract(source, 999);

  assert.equal(contract.selectedCellIndex, 2);
  assert.deepEqual(contract.cells.map((cell) => cell.cellIndex), [2]);
});

test('the new slice contains no device-code surface and declares coarse target hooks', async () => {
  const [moduleText, css] = await Promise.all([
    readFile(MODULE_PATH, 'utf8'),
    readFile(CSS_PATH, 'utf8'),
  ]);

  assert.doesNotMatch(moduleText, /device[\s-]*(code|sign[\s-]*in)|devicelogin/i);
  assert.doesNotMatch(moduleText, /start-azure-login|cancel-azure-login/i);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /min-height: 2\.75rem/);
  assert.match(css, /\.dossier-configure\s*\{[\s\S]*?overflow: visible/);
  assert.match(css, /\.source-inspector-frame\s*\{[\s\S]*?max-block-size:[\s\S]*?overflow: auto/);
});
