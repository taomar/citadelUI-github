import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { previewDocument, queueOperation } from '../web/js/preview.mjs';
import { assertNativeDraft, sameNativeDraftBinding } from '../shared/terraform/drafts.mjs';
import { applyNativeEdits, exactNumber, initializeNativeParser, parseNativeValues } from '../shared/terraform/parser.mjs';
import { nativePreview } from '../shared/terraform/review.mjs';
import { assertNonsecretConfiguration, parseNativeSchema, validateNativeValues } from '../shared/terraform/schema.mjs';
import { nativeConfiguration, nativeLocalFixture } from './_native-fixture.mjs';
import { historyEntry } from '../web/js/history-entry.mjs';

await initializeNativeParser();

test('a departing workspace status timer cannot clear the newly active workspace notice', async () => {
  const source = await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  const callbacks = [], rendered = [];
  const context = { state: {}, statusTimer: null, pendingTicker: null,
    clearTimeout() {}, setTimeout(fn) { callbacks.push(fn); return callbacks.length; },
    renderStatus() { rendered.push(context.state.status); } };
  vm.runInNewContext([
    source.slice(source.indexOf('function setStatus('), source.indexOf('function renderStatus(')),
    source.slice(source.indexOf('function removeStatusNotice('), source.indexOf('function resolveOperationStatus(')),
  ].join('\n'), context);
  context.setStatus('Previous workspace saved.');
  const previous = context.state;
  context.state = { status: { message: 'Current workspace needs attention.', tone: 'error' } };
  callbacks[0]();
  assert.equal(previous.status, null);
  assert.equal(context.state.status.message, 'Current workspace needs attention.');
  assert.equal(rendered.length, 1);
});

test('workspace generations isolate same-alias drafts, policy buffers and stale tickets across both formats', () => {
  const state = new WorkspaceViewState(() => ({ operations: [], policyRaw: null, open: new Map() }));
  const bicep = { environment: { id: 'bicep' } };
  const native = { environment: { id: 'native', configuration: nativeConfiguration(['deployment']) } };
  const one = state.activate(bicep), ticket = state.ticket();
  one.operations.push({ op: 'set', path: ['name'], value: 'bicep-draft' });
  one.policyRaw = '<policies><inbound /></policies>';
  one.open.set('section', true);
  const two = state.activate(native);
  two.operations.push({ op: 'set', path: ['name'], value: 'native-draft' });
  two.policyRaw = '<policies><backend /></policies>';
  assert.equal(state.isCurrent(ticket), false);
  assert.equal(state.activate(bicep), one);
  assert.equal(one.policyRaw, '<policies><inbound /></policies>');
  assert.equal(one.open.get('section'), true);
  state.leave();
  assert.equal(state.isCurrent(state.ticket()), false);
  assert.equal(state.activate(native), two);
});

test('native draft proof distinguishes head changes from schema/unit retargeting and blocks sensitive buffers', async (t) => {
  const f = await nativeLocalFixture({ configuration: nativeConfiguration(['deployment']) });
  t.after(f.close);
  const document = await f.service.deployment('environments/development.tfvars');
  const operations = [{ op: 'set', path: ['environment_name'], value: 'pending' }];
  assertNativeDraft(f.configuration, document.path, operations, document.nativeIdentity);
  assert.equal(sameNativeDraftBinding(document.nativeIdentity, { ...document.nativeIdentity, head: 'different-head', hash: 'b'.repeat(64) }), true);
  assert.equal(sameNativeDraftBinding(document.nativeIdentity, { ...document.nativeIdentity, dependencies: [] }), false);
  assert.throws(() => assertNativeDraft(nativeConfiguration(['deployment']), document.path, operations, document.nativeIdentity), { code: 'NATIVE_DRAFT_IDENTITY' });
  assert.throws(() => assertNativeDraft(f.configuration, document.path, [{ op: 'set', path: ['password'], value: 'synthetic-sensitive' }], document.nativeIdentity), { code: 'NATIVE_SENSITIVE_FILE' });
  assert.throws(() => assertNativeDraft(f.configuration, document.path, operations, { ...document.nativeIdentity, version: 99 }), { code: 'NATIVE_DRAFT_IDENTITY' });
});

test('new optional objects, maps and arrays compose child edits into original-address native operations', async (t) => {
  const f = await nativeLocalFixture({ configuration: nativeConfiguration(['deployment']) });
  t.after(f.close);
  const document = await f.service.deployment('environments/development.tfvars');
  let operations = [];
  for (const operation of [
    { op: 'set', path: ['optional_object'], value: { label: '', tags: {} } },
    { op: 'set', path: ['optional_object', 'label'], value: 'nested-new' },
    { op: 'addProperty', path: ['optional_object', 'tags'], key: 'owner', value: 'synthetic' },
    { op: 'set', path: ['number_list'], value: [] },
    { op: 'append', path: ['number_list'], value: exactNumber('0.125') },
    { op: 'set', path: ['number_list', 0], value: exactNumber('0.2500') },
    { op: 'set', path: ['pair'], value: ['tuple', exactNumber('12.75')] },
  ]) operations = queueOperation(operations, operation, document);
  assert.equal(operations.length, 3);
  const result = nativePreview(document, operations);
  assert.deepEqual(result.parsed.value.optional_object, { label: 'nested-new', tags: { owner: 'synthetic' } });
  assert.deepEqual(result.parsed.value.number_list, [exactNumber('0.2500')]);
  assert.deepEqual(result.parsed.value.pair, ['tuple', exactNumber('12.75')]);
  operations = queueOperation(operations, { op: 'remove', path: ['optional_object'] }, document);
  assert.equal(operations.length, 2);
  assert.equal(Object.hasOwn(nativePreview(document, operations).parsed.value, 'optional_object'), false);
});

test('literal prototype-like map labels remain own data without changing JavaScript prototypes', () => {
  const document = { params: [{ name: 'mapping', value: {}, supplied: true }] };
  let operations = queueOperation([], { op: 'addProperty', path: ['mapping'], key: '__proto__', value: 'literal' }, document);
  const value = previewDocument(document, operations).params[0].value;
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(value.__proto__, 'literal');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.prototype.literal, undefined);
  const source = 'mapping = {}\n';
  assert.equal(parseNativeValues(applyNativeEdits(source, operations)).value.mapping.__proto__, 'literal');
});

test('native contains number validation uses exact decimal equality, not JS rounding or lexical equality', () => {
  const schema = parseNativeSchema('variable "ratio" {\n type = number\n validation {\n condition = contains([2, 0.125], var.ratio)\n error_message = "Choose an exact value."\n }\n}\n');
  for (const value of ['2.0', '0.1250']) assert.equal(validateNativeValues({ ratio: exactNumber(value) }, schema).filter((finding) => finding.severity === 'error').length, 0);
  assert.equal(validateNativeValues({ ratio: exactNumber('0.125000000000000000001') }, schema).filter((finding) => finding.severity === 'error').length, 1);
});

test('known-sensitive schema/dependency literals are blocked, while external references are not evaluated', () => {
  for (const source of [
    'locals { password = "synthetic-sensitive" }\n',
    'locals { input = { secret_value = "synthetic-sensitive", reference = var.value } }\n',
    'variable "credential" {\n type = string\n sensitive = true\n default = "synthetic-sensitive"\n}\n',
  ]) assert.throws(() => assertNonsecretConfiguration(source), { code: 'NATIVE_SENSITIVE_FILE' });
  assert.doesNotThrow(() => assertNonsecretConfiguration('locals { input = { (var.key) = var.value, password = var.external_secret } }\n'));
});

test('native creation has a real scoped History undo affordance without masquerading as a Bicep contract', async (t) => {
  const f = await nativeLocalFixture({ configuration: nativeConfiguration([{ area: 'deployment', valueAlias: 'environments/new.tfvars', allowCreate: true }]) });
  t.after(f.close);
  const document = await f.service.deployment('environments/new.tfvars');
  const saved = await f.service.save(document.path, [{ op: 'set', path: ['environment_name'], value: 'new' }], null, document.nativeIdentity);
  const entry = historyEntry(await f.store.getTransaction(f.environment.id, saved.archived));
  assert.equal(entry.nativeCreation, true);
  assert.equal(entry.isCreation, true);
  assert.equal(entry.canUndo, true);
});
