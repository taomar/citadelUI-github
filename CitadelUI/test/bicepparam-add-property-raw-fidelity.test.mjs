import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdits } from '../shared/bicepparam/edit.mjs';
import { parseBicepParam, nodeToValue } from '../shared/bicepparam/parser.mjs';
import { isRawExpr, quote, serializeValue } from '../shared/bicepparam/serialize.mjs';
import { encodeSourceText } from '../shared/source-text.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';

const EOLS = [['LF', '\n'], ['CRLF', '\r\n']];
const RAW_EOL_NAMES = ['LF', 'CRLF', 'mixed'];
const ALIAS = 'bicep/infra/main.bicepparam';
const TEMPLATE = 'bicep/infra/main.bicep';

function donorValue(kind) {
  const lines = ['string(', "  '''", 'first payload line', 'second payload line', "'''", ')'];
  const raw = lines.reduce((text, line, index) => text + (index
    ? kind === 'mixed' ? index % 2 ? '\r\n' : '\n' : kind === 'CRLF' ? '\r\n' : '\n'
    : '') + line, '');
  const donor = nodeToValue(parseBicepParam(`param donor = ${raw}\n`).params[0].value);
  assert.equal(donor.__expr, 'call');
  assert.equal(donor.callee, 'string');
  assert.equal(donor.raw, raw);
  assert.equal(typeof donor.args[0], 'string');
  return donor;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const SHAPES = [
  { name: 'direct', wrap: (value) => value, leaf: (value) => value,
    text: (raw) => raw },
  { name: 'object', wrap: (value) => ({ payload: value }), leaf: (value) => value.payload,
    text: (raw, eol) => `{${eol}    payload: ${raw}${eol}  }` },
  { name: 'array', wrap: (value) => [value], leaf: (value) => value[0],
    text: (raw, eol) => `[${eol}    ${raw}${eol}  ]` },
  { name: 'deep', wrap: (value) => ({ items: [{ payload: value }] }), leaf: (value) => value.items[0].payload,
    text: (raw, eol) => `{${eol}    items: [${eol}      {${eol}        payload: ${raw}${eol}      }${eol}    ]${eol}  }` },
];

const original = (eol) => [
  "using './main.bicep'", '// Unrelated prefix.',
  'param ordinaryObject = {', "  Kept: 'same' // Keep this inline comment.", '}',
  '// Unrelated suffix.', "param untouched = 'exact \\' and \\${literal}'", '',
].join(eol);
const expectedInsertion = (before, entries, eol) => before.replace(`${eol}}${eol}`,
  `${eol}${entries.map(([key, rendered]) => `  ${key}: ${rendered}`).join(eol)}${eol}}${eol}`);
const parsedObject = (text) => nodeToValue(parseBicepParam(text).params.find((param) => param.name === 'ordinaryObject').value);
const sourceSnapshot = (fixture) => Object.fromEntries(fixture.root.allFiles().map(({ path, bytes }) => [path, bytes.slice()]));
const sourceWrites = (fixture) => fixture.root.owner.trace.filter((event) => /write|create|remove/i.test(event.operation));

test('raw property fidelity: omitted newline preserves primitive, fallback, key and quote golden bytes', () => {
  const cases = [
    [undefined, 'null'], [null, 'null'], [true, 'true'], [false, 'false'],
    [17, '17'], [-0, '0'], [0.25, '0.25'], [NaN, '0'], [Infinity, '0'], [-Infinity, '0'],
    [Symbol('unsupported'), 'null'], [1n, 'null'], [() => 1, 'null'],
    [[], '[]'], [{}, '{}'], ['', "''"],
    ["'\\${literal}\r\n\t", "'\\'\\\\\\${literal}\\r\\n\\t'"],
    [{ normal: 1, 'a-b': false }, "{\n  normal: 1\n  'a-b': false\n}"],
    [[1, { item: 'two' }], "[\n  1\n  {\n    item: 'two'\n  }\n]"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(serializeValue(value), expected);
    assert.equal(serializeValue(value, 0, undefined), expected);
    assert.equal(serializeValue(value, 0, '\n'), expected);
  }
  assert.equal(quote("'\\${literal}\r\n\t"), "'\\'\\\\\\${literal}\\r\\n\\t'");
  assert.equal(quote(12), "'12'");
  assert.equal(isRawExpr({ __expr: 'call', raw: '' }), true);
  for (const value of [null, [], { raw: 'reference' }, { __expr: 'call', raw: 1 }]) assert.equal(isRawExpr(value), false);
});

for (const rawKind of RAW_EOL_NAMES) {
  test(`raw property fidelity: ${rawKind} parser-derived expressions bypass all serializer newline options verbatim`, () => {
    const donor = freeze(donorValue(rawKind)), before = structuredClone(donor);
    for (const level of [0, 1, 3]) for (const eol of [undefined, '\n', '\r\n']) {
      assert.equal(serializeValue(donor, level, eol), donor.raw);
    }
    for (const shape of SHAPES) {
      const value = freeze(shape.wrap(donor));
      assert.equal(serializeValue(value, 1), shape.text(donor.raw, '\n'));
      assert.equal(serializeValue(value, 1, '\n'), shape.text(donor.raw, '\n'));
    }
    assert.deepEqual(donor, before);
  });
}

for (const [targetName, eol] of EOLS) {
  test(`raw property fidelity: ${targetName} generated scaffolding has its own newline, not literal string payload newlines`, () => {
    const value = freeze({ list: [1, { 'quoted-key': 'literal\nline\r\n' }], empty: {}, tail: false });
    const before = structuredClone(value);
    const lines = ['{', '    list: [', '      1', '      {', "        'quoted-key': 'literal\\nline\\r\\n'",
      '      }', '    ]', '    empty: {}', '    tail: false', '  }'];
    assert.equal(serializeValue(value, 1, eol), lines.join(eol));
    assert.equal(serializeValue(value, 1), lines.join('\n'));
    assert.deepEqual(value, before);
  });

  for (const rawKind of RAW_EOL_NAMES) for (const shape of SHAPES) {
    test(`raw property fidelity: ${targetName} target / ${rawKind} raw / ${shape.name} property retains bytes and multiline payload`, () => {
      const donor = donorValue(rawKind), value = freeze(shape.wrap(donor)), snapshot = structuredClone(value);
      const before = original(eol);
      const after = applyEdits(before, [{ op: 'addProperty', path: ['ordinaryObject'], key: 'Copied', value }]);
      const copied = shape.leaf(parsedObject(after).Copied);
      assert.equal(copied.raw, donor.raw, 'Opaque expression bytes are independent of target newline.');
      assert.equal(copied.args[0], donor.args[0], 'No carriage return may be added to the parsed multiline payload.');
      const expectedValue = shape.text(donor.raw, eol);
      assert.equal(serializeValue(value, 1, eol), expectedValue, 'Only collection scaffolding uses the explicit newline.');
      assert.equal(after, expectedInsertion(before, [['Copied', expectedValue]], eol));
      assert.deepEqual(value, snapshot);
    });
  }

  for (const rawKind of RAW_EOL_NAMES) {
    test(`raw property fidelity service: ${targetName} target / ${rawKind} raw preview, save, reload and History undo are exact`, async (t) => {
      const donor = donorValue(rawKind), before = original(eol), bom = targetName === 'CRLF';
      const operations = freeze(SHAPES.map((shape) => ({
        op: 'addProperty', path: ['ordinaryObject'], key: shape.name, value: shape.wrap(donor),
      })));
      const inputSnapshot = structuredClone(operations);
      const expected = expectedInsertion(before, SHAPES.map((shape) => [shape.name, shape.text(donor.raw, eol)]), eol);
      const f = await nativeLocalFixture({ configuration: createConfiguration('bicep'), onlyFiles: {
        [ALIAS]: encodeSourceText(before, { bom }),
        [TEMPLATE]: 'param ordinaryObject object\nparam untouched string\n',
      } });
      t.after(f.close);
      const originals = sourceSnapshot(f), source = await f.provider.read(ALIAS);
      const preview = await f.service.preview(ALIAS, operations, source.hash);
      assert.deepEqual(sourceSnapshot(f), originals);
      assert.deepEqual(sourceWrites(f), []);
      assert.equal(preview.after, expected);
      const saved = await f.service.save(ALIAS, operations, source.hash);
      const reloaded = await f.service.deployment(ALIAS);
      const values = reloaded.params.find((param) => param.name === 'ordinaryObject').value;
      for (const shape of SHAPES) {
        const copied = shape.leaf(values[shape.name]);
        assert.equal(copied.raw, donor.raw);
        assert.equal(copied.args[0], donor.args[0]);
      }
      const after = await f.provider.read(ALIAS);
      assert.deepEqual(after.bytes, encodeSourceText(expected, { bom }));
      assert.deepEqual(Object.keys(sourceSnapshot(f)).sort(), Object.keys(originals).sort());
      assert.deepEqual((await f.provider.read(TEMPLATE)).bytes, originals[TEMPLATE]);
      const history = await f.service.history();
      const transaction = history.transactions.find((item) => item.transactionId === saved.archived);
      assert(transaction, 'The actual saved transaction must be present in History.');
      await f.service.restoreTransaction(transaction.transactionId);
      assert.deepEqual(sourceSnapshot(f), originals);
      assert.deepEqual(operations, inputSnapshot);
    });
  }
}
