import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { guardedHandler } from '../web/js/single-flight.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { environmentSourceOf } from '../web/js/registry.mjs';
import { saveStatusLine } from '../web/js/save-resolution.mjs';
import { mutationComplete } from '../shared/mutation-outcome.mjs';
import * as edits from '../web/js/contract-edit-state.mjs';

const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const handlers = [
  section('function createEditorState()', 'const viewStates ='),
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
  section('async function savePolicy()', '/* -------------------------------------------------------------- review/save */'),
  section('async function commitSave(', '/**\n * Ask what to do with a commit'),
].join('\n');
const preview = { before: 'old', after: 'reviewed', changed: true };
const applied = { applied: true, outcome: 'applied', changed: true, transactionId: 'synthetic-applied' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const dom = await loadDialogModule(), calls = [];
  const context = { environment: { id: 'r2-review', source: { kind: 'local', folderName: 'synthetic' } } };
  const scope = { structuredClone, Map, h, guardedHandler, ...edits, environmentSourceOf, saveStatusLine, mutationComplete,
    captureDialogStatus: dom.captureDialogStatus,
    activeWorkspace: () => context, showModal: dom.showDialog, closeModal: dom.closeDialog,
    writeContextNode: () => h('p', {}, 'Synthetic Alpha source'),
    renderDiff: () => ({ node: h('pre', {}, 'reviewed'), stats: { added: 1, removed: 1 } }),
    withLocalConflict: (_review, action) => action(),
    reportClientError: (error) => calls.push(['error', error.message]),
    workspaceRegistry: { removeDraft: async () => calls.push(['remove-draft']) },
    loadContract: async () => { calls.push(['reload-contract']); return true; },
    loadDocument: async () => { calls.push(['reload-document']); return true; },
    api: {
      previewPolicyPayload: async () => preview,
      savePolicy: async (payload) => { calls.push(['save-policy', structuredClone(payload)]); return applied; },
      save: async (...args) => { calls.push(['save-parameters', ...args]); return applied; },
    },
  };
  vm.runInNewContext(handlers, scope);
  scope.viewStates = new WorkspaceViewState(scope.createEditorState);
  const state = scope.state = scope.viewStates.activate(context);
  const select = (name) => {
    Object.assign(state, {
      current: { path: `${name}.bicepparam`, hash: `${name}-hash` },
      contract: { policy: { path: `${name}.xml`, hash: `${name}-policy-hash`, name: `${name}.xml` } },
      contractId: name, area: 'access-contracts', documentGeneration: state.documentGeneration + 1,
      operations: [{ op: 'set', path: ['label'], value: `${name}-draft` }],
      policyChanges: { variables: { audience: `${name}-draft` } }, policyRaw: null,
    });
    edits.invalidatePolicyPreview(state);
    state.status = { message: `${name} status`, tone: 'info' };
  };
  select('Alpha');
  scope.setStatus = (message, tone) => { state.status = message ? { message, tone } : null; };
  const press = async (text) => {
    const button = dom.modal.querySelectorAll('button').find((node) => readText(node) === text);
    assert(button, text);
    for (const listener of button.listeners.get('click') || []) await listener({ currentTarget: button, target: button });
  };
  const editPolicy = () => {
    state.policyChanges = { variables: { audience: 'newer-draft' } };
    edits.invalidatePolicyPreview(state);
  };
  const parameterReview = () => ({
    owner: state, document: state.current, context, operations: structuredClone(state.operations),
    ticket: scope.viewStates.ticket(), epoch: state.reviewEpoch, scope: scope.captureDocumentAction(),
  });
  return { dom, scope, state, calls, select, press, editPolicy, parameterReview };
}

for (const failure of [false, true]) {
  test(`R2-A2 late policy preview ${failure ? 'error' : 'success'} cannot publish over another document`, async () => {
    const f = await fixture(), hold = deferred();
    f.scope.api.previewPolicyPayload = () => hold.promise;
    const pending = f.scope.savePolicy();
    f.select('Beta');
    const status = f.state.status, document = f.state.current;
    if (failure) hold.reject(new Error('Alpha preview failed'));
    else hold.resolve(preview);
    await pending;
    assert.equal(f.state.current, document);
    assert.equal(f.state.status, status);
    assert.equal(f.dom.modal.open, false);
    if (failure) assert.match(f.state.documentNotices.get('Alpha.bicepparam').message, /Alpha preview failed/);
  });
}

test('R2-A2 a new document generation retires a preview even if object identity is reused', async () => {
  const f = await fixture(), hold = deferred();
  f.scope.api.previewPolicyPayload = () => hold.promise;
  const pending = f.scope.savePolicy();
  f.state.documentGeneration += 1;
  const status = f.state.status = { message: 'New generation', tone: 'info' };
  hold.resolve(preview);
  await pending;
  assert.equal(f.state.status, status);
  assert.equal(f.dom.modal.open, false);
});

for (const raw of [false, true]) {
  test(`R2-A3 ${raw ? 'raw' : 'guided'} edits during preview retire the old approval without consuming the newer draft`, async () => {
    const f = await fixture(), hold = deferred();
    if (raw) { f.state.policyRaw = '<old />'; f.state.policyChanges = {}; }
    f.scope.api.previewPolicyPayload = () => hold.promise;
    const pending = f.scope.savePolicy();
    if (raw) { f.state.policyRaw = '<newer />'; edits.invalidatePolicyPreview(f.state); }
    else f.editPolicy();
    hold.resolve(preview);
    await pending;
    assert.equal(f.dom.modal.open, false);
    assert.equal(f.calls.some(([kind]) => kind === 'save-policy'), false);
    assert.match(f.state.status.message, /changed while previewing/);
    if (raw) assert.equal(f.state.policyRaw, '<newer />');
    else assert.equal(f.state.policyChanges.variables.audience, 'newer-draft');
  });
}

test('R2-A3 a newer edit after the review opens is rejected before any source mutation', async () => {
  const f = await fixture();
  await f.scope.savePolicy();
  f.editPolicy();
  await f.press('Save policy');
  assert.equal(f.calls.some(([kind]) => kind === 'save-policy'), false);
  assert.equal(f.state.policyChanges.variables.audience, 'newer-draft');
  assert.match(readText(f.dom.modal.querySelector('.modal-status')), /Review this policy again/);
});

test('R2-A3 an already started durable policy save retains a newer draft in quarantine', async () => {
  const f = await fixture(), hold = deferred();
  f.scope.api.savePolicy = (payload) => { f.calls.push(['save-policy', structuredClone(payload)]); return hold.promise; };
  await f.scope.savePolicy();
  const saving = f.press('Save policy');
  f.editPolicy();
  hold.resolve(applied);
  await saving;
  assert.equal(f.calls.find(([kind]) => kind === 'save-policy')[1].changes.variables.audience, 'Alpha-draft');
  assert.equal(f.state.policyChanges.variables.audience, 'newer-draft');
  assert.equal(f.state.quarantinedDrafts.get('Alpha.bicepparam')[0].policyChanges.variables.audience, 'newer-draft');
});

for (const policy of [false, true]) {
  test(`R2-A2 late durable ${policy ? 'policy' : 'parameter'} outcome stays with Alpha and leaves Beta intact`, async () => {
    const f = await fixture(), hold = deferred();
    let saving;
    if (policy) {
      f.scope.api.savePolicy = () => hold.promise;
      await f.scope.savePolicy();
      saving = f.press('Save policy');
    } else {
      f.scope.api.save = () => hold.promise;
      saving = f.scope.commitSave(f.parameterReview());
    }
    f.select('Beta');
    const status = f.state.status, operations = f.state.operations, policyChanges = f.state.policyChanges;
    f.dom.showDialog('Beta dialog', h('p', {}, 'Beta context'));
    hold.resolve(applied);
    await saving;
    assert.equal(f.state.status, status);
    assert.equal(f.state.operations, operations);
    assert.equal(f.state.policyChanges, policyChanges);
    assert.match(readText(f.dom.modal), /Beta dialog/);
    assert.match(f.state.documentNotices.get('Alpha.bicepparam').message, /Saved/);
    assert.equal(f.calls.some(([kind]) => kind.startsWith('reload') || kind === 'remove-draft'), false);
    f.select('Alpha');
    f.scope.restoreDocumentNotice();
    assert.match(f.state.status.message, /Saved/);
    f.dom.closeDialog();
  });
}
