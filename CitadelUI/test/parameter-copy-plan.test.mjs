import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceService, STALE_SOURCE_MESSAGE } from '../web/js/workspace-service.mjs';
import { parameterCopyPlan } from '../web/js/parameter-copy-plan.mjs';

const sourceHash = 'a'.repeat(64), targetHash = 'b'.repeat(64);
const sourceAlias = 'bicep/source.bicepparam', targetAlias = 'bicep/target.bicepparam';
const before = "using './main.bicep'\r\n// target-owned\r\nparam zeta = 'target'\r\nparam alpha = 9\r\n";
const after = "using './main.bicep'\r\n// target-owned\r\nparam zeta = 'source'\r\nparam alpha = 0\r\n";
const zeta = Object.freeze({ name: 'zeta', source: 'source', target: 'target', status: 'different' });
const alpha = Object.freeze({ name: 'alpha', source: 0, target: 9, status: 'different' });
const identical = Object.freeze({ name: 'same', source: false, target: false, status: 'identical' });
const missing = Object.freeze({ name: 'missing', source: 'donor-only', target: undefined, status: 'missing' });
const incompatible = Object.freeze({ name: 'incompatible', source: 1, target: 'one', status: 'incompatible' });
const parameters = Object.freeze([zeta, identical, alpha, missing, incompatible]);
const names = Object.freeze(['alpha', 'missing', 'zeta', 'same', 'alpha', 'incompatible', 'typedAbsent']);
const expectedPlan = {
  selected: [zeta, alpha],
  operations: [{ op: 'set', path: ['zeta'], value: 'source' }, { op: 'set', path: ['alpha'], value: 0 }],
  changed: ['zeta', 'alpha'],
};

test('parameter copy plan: matches the independently characterized incumbent selection and operations', () => {
  assert.deepEqual(parameterCopyPlan(parameters, names), expectedPlan);
  assert.equal(parameterCopyPlan(parameters, names).selected[0], zeta);
});

test('parameter copy plan: empty, unmatched and non-different selections produce no operations', () => {
  for (const selection of [[], ['typedAbsent'], ['same', 'missing', 'incompatible'], [' ZETA', 'ZETA', 42]]) {
    assert.deepEqual(parameterCopyPlan(parameters, selection), { selected: [], operations: [], changed: [] });
  }
  assert.deepEqual(parameterCopyPlan([], names), { selected: [], operations: [], changed: [] });
});

test('parameter copy plan: duplicate comparison rows survive while repeated names do not multiply them', () => {
  const other = Object.freeze({ name: 'zeta', source: 'second occurrence', target: 'target', status: 'different' });
  assert.deepEqual(parameterCopyPlan([zeta, other, alpha], ['alpha', 'zeta', 'zeta']), {
    selected: [zeta, other, alpha],
    operations: [
      { op: 'set', path: ['zeta'], value: 'source' },
      { op: 'set', path: ['zeta'], value: 'second occurrence' },
      { op: 'set', path: ['alpha'], value: 0 },
    ],
    changed: ['zeta', 'zeta', 'alpha'],
  });
});

test('parameter copy plan: preserves literal and expression values without evaluation, cloning or comparison', () => {
  const values = Object.freeze({
    empty: '', flag: false, zero: 0, nullable: null,
    list: Object.freeze(['\u00e9', 2, false, null]),
    object: Object.freeze({ second: 2, first: 1 }),
    expression: Object.freeze({ __expr: 'call', callee: 'readEnvironmentVariable', args: Object.freeze(['SYNTHETIC', 'fallback']) }),
  });
  const rows = Object.freeze(Object.entries(values).map(([name, source]) => Object.freeze({ name, source, target: source, status: 'different' })));
  const selection = Object.freeze(['expression', 'object', 'list', 'nullable', 'zero', 'flag', 'empty']);
  const expected = {
    selected: rows,
    operations: [
      { op: 'set', path: ['empty'], value: '' },
      { op: 'set', path: ['flag'], value: false },
      { op: 'set', path: ['zero'], value: 0 },
      { op: 'set', path: ['nullable'], value: null },
      { op: 'set', path: ['list'], value: ['\u00e9', 2, false, null] },
      { op: 'set', path: ['object'], value: { second: 2, first: 1 } },
      { op: 'set', path: ['expression'], value: { __expr: 'call', callee: 'readEnvironmentVariable', args: ['SYNTHETIC', 'fallback'] } },
    ],
    changed: ['empty', 'flag', 'zero', 'nullable', 'list', 'object', 'expression'],
  };
  const plan = parameterCopyPlan(rows, selection), next = parameterCopyPlan(rows, selection);
  assert.deepEqual(plan, expected);
  assert.deepEqual(next, expected);
  assert.notEqual(plan.selected, rows);
  assert.notEqual(plan.operations, next.operations);
  assert.notEqual(plan.changed, next.changed);
  for (const [index, row] of rows.entries()) {
    assert.equal(plan.selected[index], row);
    assert.equal(plan.operations[index].value, row.source);
  }
});

function serviceFixture(outcome = { applied: true, outcome: 'applied' }) {
  const target = { environment: { id: 'target', label: 'Target' }, provider: {} };
  const comparison = {
    source: { hash: sourceHash, schema: { parameters: {
      zeta: { type: 'string' }, alpha: { type: 'int' }, same: { type: 'bool' },
      missing: { type: 'string' }, incompatible: { type: 'int' }, typedAbsent: { type: 'string' },
      secure: { type: 'string', secure: true },
    } } },
    destination: { hash: targetHash, text: before, bytes: new TextEncoder().encode(`\uFEFF${before}`), bom: true },
    parameters, targetAlias, target,
  };
  const previews = [], commits = [];
  const service = new WorkspaceService({
    contextProvider: () => ({ environment: { id: 'source' }, provider: {} }),
    registry: {},
    coordinator: {
      validateRequest: async (files, options) => { previews.push({ files, options }); },
      commit: async (files, options) => { commits.push({ files, options }); return outcome; },
    },
  });
  service.compareEnvironment = async () => comparison;
  return { service, comparison, previews, commits };
}

test('L2 parameter copy: incumbent preview and commit preserve comparison order and exact adapter bytes', async () => {
  const f = serviceFixture();
  const preview = await f.service.previewCopy('target', sourceAlias, names, sourceHash);
  assert.deepEqual(preview, {
    before, after, changed: true, selected: expectedPlan.changed, sourceHash, targetHash,
    targetLabel: 'Target', targetAlias, bom: true,
  });
  assert.deepEqual(f.previews, [{
    files: [{ alias: targetAlias, beforeHash: targetHash, after: new TextEncoder().encode(`\uFEFF${after}`) }],
    options: { context: f.comparison.target, action: 'environment-copy' },
  }]);
  assert.equal(f.commits.length, 0);
  await f.service.copyParameters('target', sourceAlias, names, sourceHash, targetHash);
  assert.deepEqual(f.commits, [{
    files: [{
      alias: targetAlias, before: f.comparison.destination.bytes, beforeHash: targetHash,
      after: new TextEncoder().encode(`\uFEFF${after}`), changed: expectedPlan.changed,
    }],
    options: { context: f.comparison.target, action: 'environment-copy' },
  }]);
  assert.equal(f.previews.length, 1, 'Commit keeps its own coordinator path, without an added preview-budget call.');
});

for (const selection of [[], ['same'], ['missing'], ['incompatible'], ['typedAbsent']]) {
  test(`L2 parameter copy: ${JSON.stringify(selection)} keeps unchanged preview distinct from commit refusal`, async () => {
    const f = serviceFixture();
    const preview = await f.service.previewCopy('target', sourceAlias, selection, sourceHash);
    assert.deepEqual(preview, {
      before, after: before, changed: false, selected: [], sourceHash, targetHash,
      targetLabel: 'Target', targetAlias, bom: true,
    });
    await assert.rejects(f.service.copyParameters('target', sourceAlias, selection, sourceHash, targetHash),
      { name: 'Error', message: 'No compatible differences were selected.' });
    assert.deepEqual(f.previews, []);
    assert.deepEqual(f.commits, []);
  });
}

test('L2 parameter copy: validation stays before planning with incumbent names and hash errors', async () => {
  const f = serviceFixture();
  for (const selection of [['secure'], ['unknown'], ['zeta', 'unknown'], [' zeta'], ['ZETA'], [null], [42]]) {
    const expected = { name: 'Error', message: 'Secure or untyped parameters cannot be copied between environments.' };
    await assert.rejects(f.service.previewCopy('target', sourceAlias, selection, sourceHash), expected);
    await assert.rejects(f.service.copyParameters('target', sourceAlias, selection, sourceHash, targetHash), expected);
  }
  for (const [selection, message] of [
    [null, "Cannot read properties of null (reading 'some')"],
    [undefined, "Cannot read properties of undefined (reading 'some')"],
    ['zeta', 'names.some is not a function'],
    [{}, 'names.some is not a function'],
  ]) {
    await assert.rejects(f.service.previewCopy('target', sourceAlias, selection, sourceHash), { name: 'TypeError', message });
    await assert.rejects(f.service.copyParameters('target', sourceAlias, selection, sourceHash, targetHash), { name: 'TypeError', message });
  }
  const stale = { code: 'SOURCE_CHANGED', message: STALE_SOURCE_MESSAGE };
  await assert.rejects(f.service.previewCopy('target', sourceAlias, null, 'stale'), stale);
  await assert.rejects(f.service.copyParameters('target', sourceAlias, null, 'stale', targetHash), stale);
  await assert.rejects(f.service.copyParameters('target', sourceAlias, ['secure'], sourceHash, 'stale'), stale);
  assert.deepEqual(f.previews, []);
  assert.deepEqual(f.commits, []);
});

for (const outcome of ['unchanged', 'pending', 'indeterminate', 'recovery-required']) {
  test(`L2 parameter copy: planning retains the coordinator's ${outcome} outcome and provenance`, async () => {
    const applied = ['unchanged', 'pending'].includes(outcome) ? false : null;
    const result = {
      outcome, applied, changed: false, files: [], warnings: ['Retained coordinator warning'],
      intended: { environmentId: 'target', branch: 'selected-branch' },
      plannedFiles: [{ alias: targetAlias, hash: 'c'.repeat(64) }],
      ...(outcome === 'pending' ? { pending: true } : {}),
      ...(outcome === 'indeterminate' ? { indeterminate: true } : {}),
      ...(outcome === 'recovery-required' ? { recoveryRequired: true } : {}),
    };
    const f = serviceFixture(result);
    assert.deepEqual(await f.service.copyParameters('target', sourceAlias, names, sourceHash, targetHash), result);
    assert.equal(f.commits.length, 1);
    assert.deepEqual(f.commits[0].files[0].changed, ['zeta', 'alpha']);
  });
}
