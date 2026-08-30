/**
 * Preview layer tests.
 *
 * The point of these is the removal semantics: the server resolves operations
 * against the original text, so two removals queued in one batch must both
 * refer to original indices. A naive sequential splice would make the second
 * removal delete the wrong element.
 */
import { previewDocument, queueOperation, toOriginalIndex } from '../web/js/preview.mjs';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
}

function doc(value) {
  return {
    path: 'x.bicepparam',
    schema: { marker: true },
    outline: { sections: [] },
    params: [{ name: 'cfg', kind: 'object', value, raw: '', span: [0, 0], doc: null }],
  };
}

const value = () => ({
  list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  name: 'original',
});

// --- pass-through -----------------------------------------------------------

const base = doc(value());
check('no operations returns the same object', previewDocument(base, []) === base, true);
check('null operations returns the same object', previewDocument(base, null) === base, true);

// --- non-mutation -----------------------------------------------------------

const source = doc(value());
previewDocument(source, [{ op: 'set', path: ['cfg', 'name'], value: 'changed' }]);
check('source document is not mutated', source.params[0].value.name, 'original');

// --- carried fields ---------------------------------------------------------

const carried = previewDocument(doc(value()), [
  { op: 'set', path: ['cfg', 'name'], value: 'changed' },
]);
check('schema survives the spread', carried.schema.marker, true);
check('outline survives the spread', Array.isArray(carried.outline.sections), true);

// --- set --------------------------------------------------------------------

check(
  'set on a nested property',
  previewDocument(doc(value()), [{ op: 'set', path: ['cfg', 'name'], value: 'changed' }]).params[0]
    .value.name,
  'changed'
);

check(
  'set through an array index',
  previewDocument(doc(value()), [{ op: 'set', path: ['cfg', 'list', 1, 'id'], value: 'B' }]).params[0]
    .value.list.map((entry) => entry.id),
  ['a', 'B', 'c']
);

check(
  'set on the parameter root',
  previewDocument(doc(value()), [{ op: 'set', path: ['cfg'], value: 42 }]).params[0].value,
  42
);

// --- append / addProperty ---------------------------------------------------

check(
  'append extends an array',
  previewDocument(doc(value()), [{ op: 'append', path: ['cfg', 'list'], value: { id: 'd' } }])
    .params[0].value.list.map((entry) => entry.id),
  ['a', 'b', 'c', 'd']
);

check(
  'addProperty adds an absent key',
  previewDocument(doc(value()), [
    { op: 'addProperty', path: ['cfg'], key: 'added', value: true },
  ]).params[0].value.added,
  true
);

// --- removal ----------------------------------------------------------------

check(
  'a single removal drops the element',
  previewDocument(doc(value()), [{ op: 'remove', path: ['cfg', 'list', 1] }]).params[0].value.list.map(
    (entry) => entry.id
  ),
  ['a', 'c']
);

check(
  'two removals both address original indices',
  previewDocument(doc(value()), [
    { op: 'remove', path: ['cfg', 'list', 0] },
    { op: 'remove', path: ['cfg', 'list', 1] },
  ]).params[0].value.list.map((entry) => entry.id),
  ['c']
);

check(
  'a removal does not shift a later set',
  previewDocument(doc(value()), [
    { op: 'remove', path: ['cfg', 'list', 0] },
    { op: 'set', path: ['cfg', 'list', 2, 'id'], value: 'C' },
  ]).params[0].value.list.map((entry) => entry.id),
  ['b', 'C']
);

check(
  'appending after a removal lands at the end',
  previewDocument(doc(value()), [
    { op: 'remove', path: ['cfg', 'list', 0] },
    { op: 'append', path: ['cfg', 'list'], value: { id: 'd' } },
  ]).params[0].value.list.map((entry) => entry.id),
  ['b', 'c', 'd']
);

check(
  'removing an object key',
  'name' in
    previewDocument(doc(value()), [{ op: 'remove', path: ['cfg', 'name'] }]).params[0].value,
  false
);

// --- resilience -------------------------------------------------------------

check(
  'an unknown parameter is ignored',
  previewDocument(doc(value()), [{ op: 'set', path: ['missing'], value: 1 }]).params[0].value.name,
  'original'
);

check(
  'a stale path is ignored',
  previewDocument(doc(value()), [
    { op: 'set', path: ['cfg', 'list', 9, 'deep', 'id'], value: 'x' },
  ]).params[0].value.list.length,
  3
);

// --- index translation ------------------------------------------------------

check('translation with no removals', toOriginalIndex(2, []), 2);
check('translation past one earlier removal', toOriginalIndex(1, [0]), 2);
check('translation past two earlier removals', toOriginalIndex(0, [0, 1]), 2);
check('translation is unaffected by a later removal', toOriginalIndex(0, [2]), 0);
check('translation past a straddling pair', toOriginalIndex(1, [0, 3]), 2);

// --- queue semantics --------------------------------------------------------
//
// The server resolves operations against spans of the original text, so an
// element appended in this batch has no span to address. Edits to it must fold
// into the pending append instead of becoming operations of their own.

const qdoc = doc(value());
const queue = (ops, op) => queueOperation(ops, op, qdoc);

check(
  'a plain set is queued',
  queue([], { op: 'set', path: ['cfg', 'name'], value: 'x' }),
  [{ op: 'set', path: ['cfg', 'name'], value: 'x' }]
);

check(
  'a repeated set on one path collapses',
  queue(queue([], { op: 'set', path: ['cfg', 'name'], value: 'x' }), {
    op: 'set',
    path: ['cfg', 'name'],
    value: 'y',
  }).length,
  1
);

check(
  'removing a property after editing it replaces the edit',
  queue(queue([], { op: 'set', path: ['cfg', 'name'], value: 'x' }), {
    op: 'remove',
    path: ['cfg', 'name'],
  }),
  [{ op: 'remove', path: ['cfg', 'name'] }]
);

check(
  'restoring a removed original property becomes one set',
  queue(queue([], { op: 'remove', path: ['cfg', 'name'] }), {
    op: 'addProperty',
    path: ['cfg'],
    key: 'name',
    value: 'restored',
  }),
  [{ op: 'set', path: ['cfg', 'name'], value: 'restored' }]
);

check(
  'removing a newly added property cancels the pending addition',
  queue(queue([], { op: 'addProperty', path: ['cfg'], key: 'optional', value: 1 }), {
    op: 'remove',
    path: ['cfg', 'optional'],
  }),
  []
);

check(
  'sets on different paths both survive',
  queue(queue([], { op: 'set', path: ['cfg', 'name'], value: 'x' }), {
    op: 'set',
    path: ['cfg', 'list', 0, 'id'],
    value: 'A',
  }).length,
  2
);

// A screen-relative index is rewritten to the index the file still holds.
check(
  'an index is translated past a pending removal',
  queue([{ op: 'remove', path: ['cfg', 'list', 0] }], {
    op: 'set',
    path: ['cfg', 'list', 1, 'id'],
    value: 'C',
  })[1].path,
  ['cfg', 'list', 2, 'id']
);

// The load-bearing case: add a backend, then edit it.
const added = queue([], {
  op: 'append',
  path: ['cfg', 'list'],
  value: { id: 'new', models: [] },
});
check('the append is queued', added.length, 1);

const edited = queue(added, { op: 'set', path: ['cfg', 'list', 3, 'id'], value: 'renamed' });
check('editing an appended element does not add an operation', edited.length, 1);
check('editing an appended element rewrites the append', edited[0].value.id, 'renamed');

const nested = queue(added, {
  op: 'append',
  path: ['cfg', 'list', 3, 'models'],
  value: { name: 'gpt-4o' },
});
check('adding a model to an appended backend stays one operation', nested.length, 1);
check('the model lands inside the pending backend', nested[0].value.models, [{ name: 'gpt-4o' }]);

check(
  'a property can be added to an appended element',
  queue(added, { op: 'addProperty', path: ['cfg', 'list', 3], key: 'priority', value: 1 })[0].value
    .priority,
  1
);

check(
  'removing an appended element drops its append',
  queue(added, { op: 'remove', path: ['cfg', 'list', 3] }),
  []
);

check(
  'removing a model from an appended backend keeps one operation',
  queue(nested, { op: 'remove', path: ['cfg', 'list', 3, 'models', 0] })[0].value.models,
  []
);

// Two appends, then an edit to the first of them.
const two = queue(added, { op: 'append', path: ['cfg', 'list'], value: { id: 'second' } });
check(
  'the first appended element is addressable',
  queue(two, { op: 'set', path: ['cfg', 'list', 3, 'id'], value: 'first!' })[0].value.id,
  'first!'
);
check(
  'the second appended element is addressable',
  queue(two, { op: 'set', path: ['cfg', 'list', 4, 'id'], value: 'second!' })[1].value.id,
  'second!'
);

// A removal and an append together: the appended element shifts on screen but
// still resolves to the right pending operation.
const mixed = queue(
  queue([], { op: 'remove', path: ['cfg', 'list', 0] }),
  { op: 'append', path: ['cfg', 'list'], value: { id: 'fresh' } }
);
check(
  'an append after a removal is still addressable at its screen index',
  queue(mixed, { op: 'set', path: ['cfg', 'list', 2, 'id'], value: 'edited' })[1].value.id,
  'edited'
);

check(
  'an unresolvable appended index is ignored',
  queue([], { op: 'set', path: ['cfg', 'list', 9, 'id'], value: 'x' }),
  []
);

// The queue and the preview must agree.
check(
  'queue and preview agree on an appended edit',
  previewDocument(qdoc, nested).params[0].value.list.map((entry) => entry.id),
  ['a', 'b', 'c', 'new']
);
check(
  'queue and preview agree on a nested append',
  previewDocument(qdoc, nested).params[0].value.list[3].models,
  [{ name: 'gpt-4o' }]
);



// --- call arguments (environment fallbacks) ---------------------------------
// `int(readEnvironmentVariable('X','1'))` is the dominant shape in bicep/infra.
// Editing its fallback addresses a call argument, which the preview must walk
// the same way the server's resolvePath does, or the control snaps back.

const envCall = (varName, fallback) => ({
  __expr: 'call',
  callee: 'readEnvironmentVariable',
  args: [varName, fallback],
  raw: `readEnvironmentVariable('${varName}', '${fallback}')`,
});

const castCall = (inner) => ({ __expr: 'call', callee: 'int', args: [inner], raw: 'int(...)' });

{
  const d = doc(envCall('APIC_SKU', 'Free'));
  const out = previewDocument(d, [{ op: 'set', path: ['cfg', '__args', 1], value: 'Standard' }]);
  check('env fallback edit is visible', out.params[0].value.args[1], 'Standard');
  check('env fallback edit does not mutate source', d.params[0].value.args[1], 'Free');
  check('env variable name is untouched', out.params[0].value.args[0], 'APIC_SKU');
}

{
  const d = doc(castCall(envCall('APIM_SKU_UNITS', '1')));
  const out = previewDocument(d, [
    { op: 'set', path: ['cfg', '__args', 0, '__args', 1], value: '4' },
  ]);
  check('cast-wrapped fallback edit is visible', out.params[0].value.args[0].args[1], '4');
  check('cast-wrapped source is untouched', d.params[0].value.args[0].args[1], '1');
}

{
  // A path that claims a call where there is none must not throw.
  const d = doc({ plain: 'value' });
  const out = previewDocument(d, [{ op: 'set', path: ['cfg', 'plain', '__args', 1], value: 'x' }]);
  check('args path on a non-call is ignored', out.params[0].value.plain, 'value');
}

console.log(`${passed} passed / ${failed} failed`);
process.exit(failed ? 1 : 0);
