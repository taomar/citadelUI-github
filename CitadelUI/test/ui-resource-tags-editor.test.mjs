import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdits } from '../shared/bicepparam/edit.mjs';
import { parseBicepParam, nodeToValue } from '../shared/bicepparam/parser.mjs';
import { previewDocumentText } from '../shared/citadel-core.mjs';
import { queueOperation, previewDocument } from '../web/js/preview.mjs';
import { renderValue } from '../web/js/fields.mjs';
import { readText } from './_dom-stub.mjs';
import { nativeLocalFixture } from './_native-fixture.mjs';
import { createConfiguration } from '../shared/workspace-configuration.mjs';
import { tagsConsumer, named, type, click } from './fixtures/resource-tags-editor/consumer.mjs';
import { ROOT_TAGS, TAGS_PATH, tagsFiles } from './fixtures/resource-tags-editor/source.mjs';

const add = (key, value = '') => ({ op: 'addProperty', path: ['tags'], key, value });
const source = (tags, newline = '\n') => `// outside before\nparam tags = ${tags}\n// outside after\nparam untouched = 'exact'\n`.replaceAll('\n', newline);
const tags = (text) => nodeToValue(parseBicepParam(text).params.find((param) => param.name === 'tags').value);
const documentOf = (text) => ({ params: parseBicepParam(text).params.map((param) => ({ name: param.name, value: nodeToValue(param.value) })) });

for (const key of ['Owner', 'Purpose', 'cost-centre', 'Cost centre', "Team's cost", ' quoted ', 'true', 'false', 'null', 'a.b', '${literal}', 'constructor', '0', '1']) {
  test(`resource tags primitive: exact key ${JSON.stringify(key)} and string escaping survive preview`, () => {
    const before = source(ROOT_TAGS, '\r\n'), value = "single ' and \\ and ${literal}\nnew line";
    const after = previewDocumentText(before, [add(key, value)]);
    assert.equal(tags(after)[key], value);
    assert.deepEqual(tags(before)['azd-env-name'], tags(after)['azd-env-name']);
    assert(after.includes("SecurityControl: 'Ignore' // This comment belongs to SecurityControl.\r\n"));
    assert(!/(^|[^\r])\n/.test(after));
    assert(after.startsWith('// outside before\r\n'));
    assert(after.endsWith("// outside after\r\nparam untouched = 'exact'\r\n"));
  });
}

for (const [shape, literal] of [
  ['bare', '{}'], ['spaced', '{ }'], ['comment-only', '{\n  // Keep this empty-object explanation.\n}'],
  ['inline-comment', '{ /* Keep this explanation. */ }'], ['root-shaped', ROOT_TAGS],
]) {
  for (const newline of ['\n', '\r\n']) {
    test(`resource tags primitive: ordered additions into ${shape} with ${JSON.stringify(newline)} preserve trivia`, () => {
      const before = source(literal, newline), operations = [add('Owner', 'one'), add('Purpose', 'two'), add('cost-centre', 'three')];
      const after = previewDocumentText(before, operations), values = tags(after);
      assert.deepEqual(Object.keys(values).slice(-3), ['Owner', 'Purpose', 'cost-centre']);
      assert.deepEqual([values.Owner, values.Purpose, values['cost-centre']], ['one', 'two', 'three']);
      for (const comment of before.match(/\/\/[^\r\n]*|\/\*[^]*?\*\//g) || []) assert(after.includes(comment));
      if (newline === '\r\n') assert(!/(^|[^\r])\n/.test(after));
    });
  }
}

for (const literal of ["{\n  Existing: 'original'\n}", "{ Existing: 'original' }", "{ Existing: 'original', Second: 'two' }"]) {
  test(`resource tags primitive: remove all originals then add before save for ${JSON.stringify(literal)}`, () => {
    const before = source(literal, '\r\n'), doc = documentOf(before);
    const edits = [...Object.keys(tags(before)).map((key) => ({ op: 'remove', path: ['tags', key] })), add('Owner', 'new'), add('Purpose', '')];
    const queued = edits.reduce((operations, operation) => queueOperation(operations, operation, doc), []);
    const after = previewDocumentText(before, queued);
    assert.deepEqual(tags(after), { Owner: 'new', Purpose: '' });
    assert.deepEqual(previewDocument(doc, queued).params[0].value, tags(after));
  });
}

test('resource tags primitive: normal add, edit, remove and restore combinations fold through the unchanged operation queue', () => {
  const before = source(ROOT_TAGS), doc = documentOf(before);
  const edits = [add('cost centre', 'new'), { op: 'set', path: ['tags', 'cost centre'], value: 'edited' },
    add('temporary', 'gone'), { op: 'remove', path: ['tags', 'temporary'] },
    { op: 'remove', path: ['tags', 'SecurityControl'] }, add('SecurityControl', 'Restored'),
    { op: 'set', path: ['tags', 'azd-env-name', '__args', 1], value: 'changed fallback' }];
  const queued = edits.reduce((operations, operation) => queueOperation(operations, operation, doc), []);
  const after = previewDocumentText(before, queued);
  const expected = previewDocument(doc, queued).params[0].value;
  assert.deepEqual({ ...tags(after), 'azd-env-name': undefined }, { ...expected, 'azd-env-name': undefined });
  assert.deepEqual(tags(after)['azd-env-name'].args, expected['azd-env-name'].args);
  assert.equal(tags(after)['azd-env-name'].callee, expected['azd-env-name'].callee);
  assert.equal(tags(after)['cost centre'], 'edited');
  assert.equal(tags(after).temporary, undefined);
  assert.equal(tags(after).SecurityControl, 'Restored');
  assert(after.includes("'azd-env-name': readEnvironmentVariable('AZURE_ENV_NAME', 'changed fallback')"));
});

test('resource tags primitive: genuine overlapping writes, duplicate additions and non-object targets still fail closed', () => {
  const before = source(ROOT_TAGS);
  for (const operations of [
    [add('Owner'), add('Owner')],
    [add('SecurityControl')],
    [{ op: 'set', path: ['tags'], value: {} }, add('Owner')],
    [{ op: 'set', path: ['tags', 'SecurityControl'], value: 'changed' }, { op: 'remove', path: ['tags', 'SecurityControl'] }],
    [{ op: 'set', path: ['tags', 'SecurityControl'], value: 'one' }, { op: 'set', path: ['tags', 'SecurityControl'], value: 'two' }],
  ]) assert.throws(() => applyEdits(before, operations), /unique|Conflicting/);
  assert.throws(() => applyEdits("param tags = readEnvironmentVariable('TAGS')", [add('Owner')]), /not an object/);
  assert.throws(() => applyEdits('param tags = []', [add('Owner')]), /not an object/);
});

test('resource tags primitive: existing set, array append/remove and addParam semantics remain surgical', () => {
  const before = "param tags = {}\nparam count = 1 // intact\nparam list = [\n  'first'\n  'second'\n]\n";
  const operations = [add('Team', 'one'), { op: 'set', path: ['count'], value: 2 },
    { op: 'remove', path: ['list', 0] }, { op: 'append', path: ['list'], value: 'third' },
    { op: 'addParam', name: 'extra', value: "quote ' and ${literal}" }];
  const after = previewDocumentText(before, operations);
  assert(after.includes('param count = 2 // intact\n'));
  const parsed = Object.fromEntries(parseBicepParam(after).params.map((param) => [param.name, nodeToValue(param.value)]));
  assert.deepEqual(parsed.list, ['second', 'third']);
  assert.equal(parsed.extra, "quote ' and ${literal}");
  assert.equal(parsed.tags.Team, 'one');
  assert.equal(applyEdits(before, []), before);
});

test('resource tags primitive: independent nested property groups preserve ordering, comments and CRLF', () => {
  const before = "param tags = {\r\n  First: { /* first explanation */ }\r\n  Second: {\r\n    Old: 'remove'\r\n  }\r\n}\r\n";
  const operations = [
    { op: 'addProperty', path: ['tags', 'First'], key: 'x-y', value: 'one' },
    { op: 'remove', path: ['tags', 'Second', 'Old'] },
    { op: 'addProperty', path: ['tags', 'Second'], key: 'two', value: 'two' },
    { op: 'addProperty', path: ['tags', 'First'], key: 'last', value: 'three' },
    add('Outer', 'four'),
  ];
  const after = previewDocumentText(before, operations);
  assert.deepEqual(tags(after), { First: { 'x-y': 'one', last: 'three' }, Second: { two: 'two' }, Outer: 'four' });
  assert(after.includes('/* first explanation */'));
  assert(!/(^|[^\r])\n/.test(after));
  assert.throws(() => applyEdits(before, [{ op: 'remove', path: ['tags', 'First'] }, operations[0]]), /Conflicting/);
});

for (const literal of [ROOT_TAGS, '{}', '{\n  // Keep this documentation when adding the first tag.\n}']) {
  test(`resource tags service: ${literal === ROOT_TAGS ? 'root-shaped' : 'empty'} BOM/CRLF preview, save, reload and undo retain exact bytes`, async (t) => {
    const files = tagsFiles({ tags: literal });
    const f = await nativeLocalFixture({ configuration: createConfiguration('bicep'), onlyFiles: files });
    t.after(f.close);
    const before = await f.provider.read(TAGS_PATH);
    const snapshot = f.root.allFiles().map(({ path, bytes }) => ({ path, bytes: bytes.slice() }));
    const operations = [add('Owner', "user's ${literal}"), add('Purpose', ''), add('cost-centre', '42')];
    const preview = await f.service.preview(TAGS_PATH, operations, before.hash);
    assert.deepEqual((await f.provider.read(TAGS_PATH)).bytes, before.bytes);
    assert.equal(f.root.owner.trace.filter((entry) => entry.operation === 'write').length, 0);
    const saved = await f.service.save(TAGS_PATH, operations, before.hash);
    const reloaded = await f.service.deployment(TAGS_PATH);
    assert.equal(reloaded.params.find((param) => param.name === 'tags').value['cost-centre'], '42');
    const after = await f.provider.read(TAGS_PATH);
    assert.equal(after.text, preview.after);
    assert.equal(after.bom, true);
    assert(!/(^|[^\r])\n/.test(after.text));
    for (const file of snapshot.filter((file) => file.path !== TAGS_PATH)) assert.deepEqual((await f.provider.read(file.path)).bytes, file.bytes);
    await f.service.restoreTransaction(saved.archived);
    assert.deepEqual((await f.provider.read(TAGS_PATH)).bytes, before.bytes);
  });
}

test('resource tags UI: empty object offers labelled addition, no invented entries and logical keyboard focus', async (t) => {
  const f = await tagsConsumer(t, { tags: '{}' });
  assert.match(readText(f.els.workspace), /No tags in this object/);
  assert.deepEqual(Object.keys(f.tags()), []);
  type(f.named('New tag name'), 'Owner');
  type(f.named('New tag value'), 'chosen explicitly');
  f.named('New tag value').dispatch('keydown', { key: 'Enter' });
  assert.equal(f.tags().Owner, 'chosen explicitly');
  assert.equal(f.owner.operations[0].op, 'addProperty');
  assert.equal(document.activeElement, f.named('New tag name'));
  assert.deepEqual(Object.keys(f.owner.parameterInputs), []);
  await click(f.named('Remove tag Owner'));
  assert.deepEqual([...f.owner.operations], []);
  assert.deepEqual(f.tags(), {});
  assert.equal(document.activeElement, f.named('New tag name'));
  assert.deepEqual((await f.fixture.provider.read(TAGS_PATH)).bytes, f.source.bytes);
});

test('resource tags UI: arbitrary keys and values, expression fallback, removal and source-derived entries use normal operations', async (t) => {
  const f = await tagsConsumer(t);
  assert.deepEqual(Object.keys(f.tags()), ['azd-env-name', 'SecurityControl']);
  for (const [key, value] of [['Purpose', 'arbitrary'], ['cost-centre', "user's ${literal}"], ['Location', 'not-a-region']]) {
    type(f.named('New tag name'), key);
    type(f.named('New tag value'), value);
    await click(f.named('Add tag'));
    assert.equal(f.tags()[key], value);
  }
  const location = f.named('Value for tags.Location');
  assert.equal(location.tagName, 'INPUT');
  type(location, 'still arbitrary');
  location.dispatch('change');
  assert.equal(f.tags().Location, 'still arbitrary');
  const expr = f.named('Value for tags.azd-env-name.entry 2');
  type(expr, 'new fallback');
  expr.dispatch('change');
  assert.equal(f.tags()['azd-env-name'].__expr, 'call');
  assert.equal(f.tags()['azd-env-name'].args[1], 'new fallback');
  await click(f.named('Remove tag SecurityControl'));
  assert.equal(document.activeElement, f.named('Remove tag Purpose'));
  const preview = await f.service.preview(TAGS_PATH, f.owner.operations, f.source.hash);
  assert(preview.after.includes("'cost-centre': 'user\\'s \\${literal}'"));
  assert(preview.after.includes("'azd-env-name': readEnvironmentVariable('AZURE_ENV_NAME', 'new fallback')"));
});

for (const key of ['', '   ', 'SecurityControl', '__proto__', '__expr', '__args', '__tfNumber']) {
  test(`resource tags UI: invalid name ${JSON.stringify(key)} is visible and never staged or written`, async (t) => {
    const f = await tagsConsumer(t);
    type(f.named('New tag name'), key);
    type(f.named('New tag value'), 'retained input');
    const drafts = [...f.storedDrafts];
    await click(f.named('Add tag'));
    assert.deepEqual([...f.owner.operations], []);
    assert.deepEqual([...f.storedDrafts], drafts);
    assert.equal(f.named('New tag value').value, 'retained input');
    assert.equal(f.named('New tag name').getAttribute('aria-invalid'), 'true');
    const error = document.getElementById(f.named('New tag name').getAttribute('aria-describedby'));
    assert(error && !error.hidden && readText(error));
    assert.equal(document.activeElement, f.named('New tag name'));
    assert.deepEqual((await f.fixture.provider.read(TAGS_PATH)).bytes, f.source.bytes);
  });
}

test('resource tags UI: duplicate pending additions remain rejected after a normal repaint', async (t) => {
  const f = await tagsConsumer(t);
  type(f.named('New tag name'), "Team's cost");
  type(f.named('New tag value'), 'one');
  await click(f.named('Add tag'));
  const operations = JSON.stringify(f.owner.operations);
  type(f.named('New tag name'), "Team's cost");
  type(f.named('New tag value'), 'not silently overwritten');
  f.scope.render();
  assert.equal(f.named('New tag name').value, "Team's cost");
  await click(f.named('Add tag'));
  assert.equal(JSON.stringify(f.owner.operations), operations);
  assert.equal(f.tags()["Team's cost"], 'one');
  assert.match(readText(f.els.workspace), /already exists/);
  f.scope.render();
  assert.match(readText(f.els.workspace), /already exists/);
  assert.equal(f.named('New tag name').getAttribute('aria-invalid'), 'true');
});

test('resource tags UI: unfinished addition survives re-render and prevents review without automatically adding a tag', async (t) => {
  const f = await tagsConsumer(t);
  type(f.named('New tag name'), 'retained');
  type(f.named('New tag value'), 'unfinished value');
  f.scope.render();
  assert.equal(f.named('New tag name').value, 'retained');
  assert.equal(f.named('New tag value').value, 'unfinished value');
  await f.scope.openReview();
  assert.deepEqual([...f.owner.operations], []);
  assert.match(f.statuses.at(-1).message, /Add tag/);
  assert.equal(f.dom.modal.open, false);
  type(f.named('New tag name'), '');
  type(f.named('New tag value'), '');
  assert.deepEqual(Object.keys(f.owner.parameterInputs), []);
});

test('resource tags UI: rejected container edits preserve unrelated input and the addition buffers', async (t) => {
  const f = await tagsConsumer(t);
  f.context().onInputDraft(['apimSkuUnits'], { value: '1e-', badInput: true });
  type(f.named('New tag name'), 'Owner');
  type(f.named('New tag value'), 'kept');
  const inputs = JSON.stringify(f.owner.parameterInputs);
  await click(f.named('Add tag'));
  assert.equal(JSON.stringify(f.owner.parameterInputs), inputs);
  assert.deepEqual([...f.owner.operations], []);
  assert.match(f.statuses.at(-1).message, /pending field input/);
  assert.equal(document.activeElement, f.named('Add tag'));
});

test('resource tags UI: composing inputs cannot be consumed by Add tag', async (t) => {
  const f = await tagsConsumer(t), name = f.named('New tag name');
  name.dispatch('compositionstart');
  type(name, 'composing name');
  await click(f.named('Add tag'));
  assert.deepEqual([...f.owner.operations], []);
  assert.equal(f.owner.parameterInputs['["tags",0]'].value, 'composing name');
  assert.match(f.statuses.at(-1).message, /composition/);
  name.dispatch('compositionend');
  await click(f.named('Add tag'));
  assert.equal(f.tags()['composing name'], '');
});

test('resource tags UI: quarantine rejects addition and removal without consuming inputs or moving focus', async (t) => {
  const f = await tagsConsumer(t);
  type(f.named('New tag name'), 'Owner');
  type(f.named('New tag value'), 'kept');
  f.scope.retainQuarantinedDraft(f.owner, f.scope.captureContractEdits(f.owner), 'Synthetic changed-source quarantine', TAGS_PATH);
  const inputs = JSON.stringify(f.owner.parameterInputs);
  await click(f.named('Add tag'));
  assert.equal(JSON.stringify(f.owner.parameterInputs), inputs);
  await click(f.named('Remove tag SecurityControl'));
  assert.deepEqual([...f.owner.operations], []);
  assert.match(f.statuses.at(-1).message, /quarantine/);
  assert.equal(document.activeElement, f.named('Remove tag SecurityControl'));
});

test('resource tags UI: retired render/document callbacks cannot mutate their successor or claim its focus', async (t) => {
  const f = await tagsConsumer(t);
  const remove = f.named('Remove tag SecurityControl'), addButton = f.named('Add tag');
  type(f.named('New tag name'), 'uncommitted');
  f.scope.render();
  await click(remove);
  await click(addButton);
  assert.deepEqual([...f.owner.operations], []);
  assert.equal(f.named('New tag name').value, 'uncommitted');
  const oldContent = f.els.workspace.querySelector('.resource-tags');
  f.scope.clearEditorPending(f.owner);
  await f.scope.loadDocument(f.nextPath);
  const nextOperations = f.owner.operations;
  f.els.workspace.append(oldContent);
  await click(named(oldContent, 'Remove tag SecurityControl'));
  assert.equal(f.owner.operations, nextOperations);
  assert.deepEqual(f.tags(), { Other: 'second document' });
});

test('resource tags UI: reentrant actions during the real app paint leave both source and pending inputs untouched', async (t) => {
  const f = await tagsConsumer(t);
  type(f.named('New tag name'), 'retained during paint');
  type(f.named('New tag value'), 'kept');
  const inputs = JSON.stringify(f.owner.parameterInputs);
  const addButton = f.named('Add tag'), removeButton = f.named('Remove tag SecurityControl');
  const paint = f.scope.renderWorkspace;
  let attempted = false;
  f.scope.renderWorkspace = () => {
    assert.equal(f.owner.paintingEditor, true);
    attempted = true;
    addButton.click();
    removeButton.click();
    paint();
  };
  f.scope.render();
  assert(attempted);
  assert.deepEqual([...f.owner.operations], []);
  assert.equal(JSON.stringify(f.owner.parameterInputs), inputs);
  assert.equal(f.named('New tag name').value, 'retained during paint');
  assert.deepEqual((await f.fixture.provider.read(TAGS_PATH)).bytes, f.source.bytes);
});

test('resource tags UI: modal, non-parameter and other workspace owners cannot accept a retained tag action', async (t) => {
  const f = await tagsConsumer(t), button = f.named('Remove tag SecurityControl');
  f.dom.modal.showModal();
  await click(button);
  assert.deepEqual([...f.owner.operations], []);
  f.dom.modal.close();
  f.owner.tab = 'raw';
  await click(button);
  assert.deepEqual([...f.owner.operations], []);
  f.owner.tab = 'params';
  const other = { projectId: 'other', environment: { id: 'other', source: { kind: 'local', folderName: 'other' } } };
  f.scope.state = f.scope.viewStates.activate(other);
  f.scope.activeWorkspace = () => other;
  await click(button);
  assert.deepEqual([...f.owner.operations], []);
  assert.deepEqual([...f.scope.state.operations], []);
});

test('resource tags UI: read-only rendering, non-tag objects, whole-object expressions and native maps retain their original roles', async (t) => {
  const f = await tagsConsumer(t);
  const readOnly = renderValue(f.tags(), ['tags'], { ...f.context(), readOnly: true }, { type: 'object' });
  f.els.workspace.append(readOnly);
  assert.equal(readOnly.querySelectorAll('button').length, 0);
  assert([...readOnly.querySelectorAll('input, textarea')].every((input) => input.disabled));
  const ordinary = renderValue({}, ['ordinaryObject'], f.context(), { type: 'object' });
  assert.equal(readText(ordinary), 'No properties.');
  const expression = renderValue({ __expr: 'reference', raw: 'sharedTags' }, ['tags'], f.context(), { type: 'object' });
  assert.match(readText(expression), /Preserved exactly/);
  assert.equal(expression.querySelectorAll('button').length, 0);
  const native = renderValue({}, ['tags'], { ...f.context(), native: true, newValue: () => '' }, { collection: 'map' });
  assert.match(readText(native), /Add mapping/);
  assert.doesNotMatch(readText(native), /Add tag/);
});

test('resource tags UI: actual app review/save reloads the admitted tag operations and service undo restores the original bytes', async (t) => {
  const f = await tagsConsumer(t, { tags: '{}' });
  type(f.named('New tag name'), 'Cost centre');
  type(f.named('New tag value'), "user's ${literal}");
  await click(f.named('Add tag'));
  type(f.named('New tag name'), 'Purpose');
  await click(f.named('Add tag'));
  assert.deepEqual((await f.fixture.provider.read(TAGS_PATH)).bytes, f.source.bytes);
  await f.scope.openReview();
  assert.equal(f.dom.modal.open, true);
  assert.match(readText(f.dom.modal), /Review changes/);
  await click(named(f.dom.modal, 'Save changes'));
  assert.equal(f.dom.modal.open, false);
  assert.equal(f.tags()['Cost centre'], "user's ${literal}");
  assert.equal(f.tags().Purpose, '');
  assert.deepEqual([...f.owner.operations], []);
  const history = await f.service.history();
  await f.service.restoreTransaction(history.transactions[0].transactionId);
  await f.scope.loadDocument(TAGS_PATH);
  assert.deepEqual(f.tags(), {});
  assert.deepEqual((await f.fixture.provider.read(TAGS_PATH)).bytes, f.source.bytes);
});
