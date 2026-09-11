import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDom, loadDialogModule } from './_dom-stub.mjs';
import { h } from '../web/js/dom.mjs';
import { pauseEditorForLoad } from '../web/js/editor-load.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { previewDocument, queueOperation } from '../web/js/preview.mjs';
import { captureContractEdits, clearEditorPending, editorPendingCount, restoreContractEdits } from '../web/js/contract-edit-state.mjs';
import { retainQuarantinedDraft, restoreQuarantinedDrafts, invalidatePolicyPreview } from '../web/js/contract-edit-state.mjs';
import { initializeNativeParser } from '../shared/terraform/parser.mjs';
import { assertNativeDraft, sameNativeDraftBinding } from '../shared/terraform/drafts.mjs';
import { assertNonsecretValues, validateNativeValues } from '../shared/terraform/schema.mjs';
import { configurationOf } from '../shared/workspace-configuration.mjs';
import { nativeConfiguration, nativeLocalFixture, NATIVE_FILES } from './_native-fixture.mjs';

await initializeNativeParser();
const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const handlers = [
  section('function createEditorState()', 'const viewStates ='),
  section('function draftContainsSecureValue(', 'function pushOperation('),
  section('function hasPolicyEdits(', '/* Pending edits live only in memory'),
  section('async function withEditorLoad(', 'let wired = false'),
  section('async function returnToSetup()', '// Nothing starts'),
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
].join('\n');
const clone = (value) => structuredClone(value);
const first = 'citadel-access-contracts/operator.tfvars', second = 'citadel-access-contracts/second.tfvars';
const policy = '<policies><inbound><base /><set-variable name="draft" value="first-only" /></inbound></policies>';
const deferred = () => {
  let resolve; const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, { choice = 'preserve', failure = null, pause = 'source' } = {}) {
  const f = await nativeLocalFixture({ configuration: nativeConfiguration([
    { area: 'access', valueAlias: first }, { area: 'access', valueAlias: second },
  ]), files: { [second]: NATIVE_FILES[first].replace('name = "synthetic-gateway"', 'name = "second-gateway"') } });
  t.after(f.close);
  const documents = new Map(await Promise.all([first, second].map(async (path) => [path, await f.service.deployment(path)])));
  const dom = installDom();
  const els = { workspace: dom.node('main'), sidebar: dom.node('nav'), contextRail: dom.node('aside'),
    tbActions: dom.node('header'), editorLoading: dom.node('div') };
  els.editorLoading.hidden = true;
  dom.root.append(...Object.values(els));
  const durable = new Map(), statuses = [], calls = [], frames = [], started = deferred(), release = deferred();
  let held = false, active = f.context;
  const scope = { document: globalThis.document, structuredClone, Map, h, pauseEditorForLoad,
    captureContractEdits, clearEditorPending, editorPendingCount, restoreContractEdits, configurationOf,
    retainQuarantinedDraft, restoreQuarantinedDrafts, invalidatePolicyPreview,
    assertNativeDraft, assertNonsecretValues, sameNativeDraftBinding, previewDocument,
    nativeValues: (doc) => Object.fromEntries(doc.params.filter((param) => param.value !== undefined).map((param) => [param.name, param.value])),
    documentFindings: (doc) => validateNativeValues(scope.nativeValues(doc), doc.schema.parameters),
    els, editorTransition: null, documentGeneration: 0, pendingByDocument: new Map(),
    activeWorkspace: () => active, requestAnimationFrame: (callback) => frames.push(callback),
    setStatus: (message, tone) => { scope.state.status = message ? { message, tone } : null; if (message) statuses.push({ message, tone }); },
    reportClientError: (error) => calls.push(['error', error.message]),
    choiceDialog: async () => choice, writeContextNode() {},
    workspaceRegistry: {
      async saveDraft(environmentId, alias, sourceHash, operations, nativeIdentity) {
        durable.set(`${environmentId}:${alias}`, clone({ sourceHash, operations, nativeIdentity }));
      },
      async getDraft(environmentId, alias) {
        if (alias === second && pause === 'draft' && !held) {
          held = true; started.resolve(); await release.promise;
        }
        if (alias === second && failure === 'draft') throw new Error('Draft storage read failed.');
        return clone(durable.get(`${environmentId}:${alias}`) || null);
      },
      async removeDraft(environmentId, alias) { durable.delete(`${environmentId}:${alias}`); },
    },
    api: { async deployment(path, context) {
      assert.equal(context, active);
      calls.push(['read', path]);
      if (path === second && pause === 'source' && !held) {
        held = true; started.resolve(); await release.promise;
      }
      if (path === second && failure === 'source') throw new Error('Selected native source could not be read.');
      return documents.get(path);
    } },
  };
  vm.runInNewContext(handlers, scope);
  const state = scope.createEditorState();
  state.current = documents.get(first);
  state.areas = [{ id: 'first', path: first, title: 'First Access' }, { id: 'second', path: second, title: 'Second Access' }];
  state.area = 'first';
  state.operations = [
    { op: 'set', path: ['product_terms'], value: 'baseline-before-delayed-navigation' },
    { op: 'set', path: ['services', 0, 'policy_xml'], value: policy },
  ];
  state.open.set('retained-section', true);
  scope.viewStates = new WorkspaceViewState(() => state);
  scope.state = scope.viewStates.activate(f.context);
  scope.render = () => {
    const document = previewDocument(scope.state.current, scope.state.operations);
    els.workspace.replaceChildren(
      h('input', { value: document.params.find((param) => param.name === 'product_terms')?.value || '' }),
      h('textarea', { value: document.params.find((param) => param.name === 'services')?.value[0].policy_xml || '' })
    );
    scope.editorTransition?.pause.refresh();
  };
  scope.render();
  await scope.persistParameterDraft();
  const unrelated = clone({ sourceHash: documents.get(second).hash, nativeIdentity: documents.get(second).nativeIdentity,
    operations: [{ op: 'set', path: ['product_terms'], value: 'independent-second-draft' }] });
  durable.set(`${f.environment.id}:${second}`, unrelated);
  return { ...f, state, scope, els, documents, dom, durable, statuses, calls, frames, started, release, unrelated,
    activate(context, state) { active = context; scope.state = scope.viewStates.activate(context); Object.assign(scope.state, state); },
    value: () => els.workspace.querySelector('input').value,
    policy: () => els.workspace.querySelector('textarea').value };
}

test('returning to the catalog retires old controls before asynchronous catalog reconciliation can accept edits', async (t) => {
  const f = await fixture(t), catalogStarted = deferred(), catalogReady = deferred();
  const expected = clone(f.state.operations), predecessor = f.state.current;
  f.els.shell = { dataset: { workspace: 'active' } };
  Object.assign(f.scope, { policyPreviewToken: 0, clearActiveWorkspace() {}, setSetupContext() {},
    updateHeaderContext() {}, renderStartupRecovery(error) { throw error; },
    init: async () => { catalogStarted.resolve(); await catalogReady.promise; } });
  const leaving = f.scope.returnToSetup();
  await catalogStarted.promise;
  assert.equal(f.els.workspace.querySelector('input'), null);
  assert.equal(f.els.workspace.querySelector('textarea'), null);
  assert.equal(f.els.workspace.querySelector('.banner').getAttribute('role'), 'status');
  assert.equal(f.state.current, predecessor);
  assert.deepEqual(clone(f.state.operations), expected);
  assert.deepEqual(f.durable.get(`${f.environment.id}:${first}`).operations, expected);
  assert.equal(f.scope.state.current, null);
  catalogReady.resolve();
  assert.equal(await leaving, true);
});

test('real disabled input lock preserves existing disabled states and covers controls rebuilt during loading', () => {
  const dom = installDom(), root = dom.node(), notice = dom.node();
  const editable = dom.node('input'), readOnlyAction = dom.node('button');
  readOnlyAction.disabled = true; root.append(editable, readOnlyAction); dom.root.append(root, notice);
  root.setAttribute('aria-busy', 'false');
  const lock = pauseEditorForLoad([root], notice, 'Opening document. Editing is paused.');
  assert.equal(editable.disabled, true); assert.equal(notice.hidden, false);
  const rebuilt = dom.node('textarea'); root.append(rebuilt); lock.refresh();
  assert.equal(rebuilt.disabled, true);
  lock.release();
  assert.equal(root.inert, false); assert.equal(root.getAttribute('aria-busy'), 'false');
  assert.equal(editable.disabled, false); assert.equal(rebuilt.disabled, false); assert.equal(readOnlyAction.disabled, true);
  assert.equal(notice.hidden, true);
  const next = pauseEditorForLoad([root], notice, 'Next document');
  lock.release();
  assert.equal(editable.disabled, true, 'An already-released predecessor must not unlock a later load.');
  next.release();
});

test('opening from Settings and closing a pending-changes dialog cannot strand or release the editor load lock', async () => {
  const dom = await loadDialogModule(), root = dom.node('main'), notice = dom.node();
  const input = dom.node('input');
  root.append(input); dom.root.append(root, notice);
  dom.showDialog('Settings', dom.node(), []);
  assert.equal(root.inert, true);
  const pause = pauseEditorForLoad([root], notice, 'Opening workspace');
  dom.closeDialog();
  assert.equal(root.inert, false, 'Dialog owns inert; the load lock must not restore that obsolete state.');
  assert.equal(input.disabled, true);
  dom.showDialog('Unsaved changes', dom.node(), []);
  dom.closeDialog();
  assert.equal(input.disabled, true, 'Closing a dialog cannot re-enable the predecessor.');
  pause.release();
  assert.equal(root.inert, false); assert.equal(input.disabled, false);
});

test('a field-commit repaint updates editor content without detaching the area navigation click target', () => {
  const dom = installDom(), sidebar = dom.node('nav'), workspace = dom.node('main'), target = dom.node('button');
  sidebar.append(target); dom.root.append(sidebar, workspace);
  const calls = [];
  const state = { current: { params: [{ name: 'label', value: 'old' }] }, operations: [], reviewEpoch: 0 };
  const context = { state, queueOperation, els: { sidebar, workspace, shell: { dataset: { workspace: 'active' } } },
    editorTransition: null, setStatus() {}, persistParameterDraft: async () => calls.push('persist'),
    preserveEditorFocus: (_root, action) => action(),
    renderSidebar: () => { throw new Error('Area navigation must remain mounted during the field commit.'); },
    renderActions: () => calls.push('actions'), renderWorkspace: () => calls.push('editor'),
    renderContextRail: () => calls.push('context'), markCurrentSection: () => calls.push('section') };
  vm.runInNewContext([
    section('function pushOperation(', 'function dirtyParams('),
    section('function renderEditor(', '/* ------------------------------------------------------------------ loading */'),
  ].join('\n'), context);
  context.pushOperation({ op: 'set', path: ['label'], value: 'typed-before-navigation' });
  assert.equal(target.parentElement, sidebar);
  assert.equal(state.operations[0].value, 'typed-before-navigation');
  assert.deepEqual(calls, ['persist', 'actions', 'editor', 'context', 'section']);
});

test('integrated native navigation commits pre-navigation text before stashing and keeps parameter/policy/durable state aligned', async (t) => {
  const f = await fixture(t);
  const input = f.els.workspace.querySelector('input');
  input.value = 'typed-before-navigation';
  input.blur = () => {
    assert.equal(input.disabled, false);
    f.state.operations = queueOperation(f.state.operations, { op: 'set', path: ['product_terms'], value: input.value }, f.state.current);
    globalThis.document.activeElement = f.dom.root;
  };
  globalThis.document.activeElement = input;
  const navigating = f.scope.selectArea('second');
  await f.started.promise;
  assert.equal(f.els.workspace.getAttribute('aria-busy'), 'true');
  assert.equal(input.disabled, true);
  assert.equal(f.els.workspace.querySelector('textarea').disabled, true);
  assert.equal(f.els.editorLoading.hidden, false);
  assert.equal(f.state.current.path, first);
  assert.equal(f.state.area, 'first', 'The predecessor owns the visible form until a target is ready.');
  const preserved = f.durable.get(`${f.environment.id}:${first}`);
  assert.equal(preserved.operations.find((operation) => operation.path[0] === 'product_terms').value, 'typed-before-navigation');
  assert.equal(preserved.operations.find((operation) => operation.path[0] === 'services').value, policy);
  f.release.resolve();
  assert.equal(await navigating, true);
  assert.equal(f.state.current.path, second); assert.equal(f.state.area, 'second');
  assert.equal(f.value(), 'independent-second-draft');
  assert.equal(f.els.workspace.inert, false);
  assert.equal(f.els.workspace.querySelector('input').disabled, false);
  assert.equal(await f.scope.selectArea('first'), true);
  assert.equal(f.value(), 'typed-before-navigation'); assert.equal(f.policy(), policy);
  assert.deepEqual(clone(f.state.operations), preserved.operations);
  assert.deepEqual(f.durable.get(`${f.environment.id}:${second}`), f.unrelated);
  assert.equal(f.state.open.get('retained-section'), true);
  assert.equal(f.els.editorLoading.hidden, true);
});

for (const failure of ['source', 'draft']) {
  test(`a failed native ${failure} load restores the exact predecessor selection and parameter/policy draft`, async (t) => {
    const f = await fixture(t, { failure, pause: failure });
    const expected = clone(f.state.operations), current = f.state.current;
    const navigating = f.scope.selectArea('second');
    await f.started.promise;
    assert.equal(f.state.current, current);
    f.release.resolve();
    assert.equal(await navigating, false);
    assert.equal(f.state.current, current); assert.equal(f.state.area, 'first');
    assert.deepEqual(clone(f.state.operations), expected);
    assert.equal(f.value(), 'baseline-before-delayed-navigation'); assert.equal(f.policy(), policy);
    assert.equal(f.els.workspace.inert, false); assert.equal(f.els.editorLoading.hidden, true);
    assert.equal(f.statuses.at(-1).tone, 'error');
    assert.deepEqual(f.durable.get(`${f.environment.id}:${second}`), f.unrelated);
  });
}

test('cancelling native navigation keeps original parameter/policy buffers and performs no target read', async (t) => {
  const f = await fixture(t, { choice: 'stay' });
  const expected = clone(f.state.operations), current = f.state.current;
  assert.equal(await f.scope.selectArea('second'), false);
  assert.equal(f.state.current, current); assert.equal(f.state.area, 'first');
  assert.deepEqual(clone(f.state.operations), expected);
  assert.equal(f.value(), 'baseline-before-delayed-navigation'); assert.equal(f.policy(), policy);
  assert.equal(f.els.workspace.inert, false); assert.equal(f.els.editorLoading.hidden, true);
  assert.equal(f.calls.some(([kind]) => kind === 'read'), false);
});

test('native draft ownership: quarantine survives repeated unit navigation without reapplying obsolete value bindings', async (t) => {
  const f = await fixture(t, { pause: 'none' }), pending = clone(f.state.operations);
  const originalIdentity = clone(f.state.current.nativeIdentity);
  const before = await f.provider.read(first);
  await f.provider.write(first, new TextEncoder().encode(`${before.text}\n# External edit\n`), { expectedHash: before.hash });
  f.documents.set(first, await f.service.deployment(first));
  assert.equal(await f.scope.loadDocument(first, { preserve: true }), true);
  assert.equal(f.state.operations.length, 0);
  const retained = clone(f.state.quarantinedDrafts.get(first));
  assert(retained.some((draft) => JSON.stringify(draft.operations) === JSON.stringify(pending)));
  assert(retained.some((draft) => JSON.stringify(draft.nativeIdentity) === JSON.stringify(originalIdentity)));
  assert(retained.some((draft) => draft.parameterHash === before.hash));
  for (let index = 0; index < 3; index++) {
    assert.equal(await f.scope.selectArea('second'), true);
    assert.equal(f.state.quarantinedDraft, null);
    assert.equal(f.value(), 'independent-second-draft');
    assert.equal(await f.scope.selectArea('first'), true);
    assert.equal(f.state.operations.length, 0);
    assert.deepEqual(clone(f.state.quarantinedDrafts.get(first)), retained);
  }
  assert.deepEqual(f.durable.get(`${f.environment.id}:${second}`), f.unrelated);
  assert.equal((await f.provider.read(first)).text, `${before.text}\n# External edit\n`);
});

for (const pause of ['source', 'draft']) {
  test(`a workspace generation change during ${pause} loading cannot install or quarantine another view`, async (t) => {
    const f = await fixture(t, { pause });
    const expected = clone(f.state.operations);
    const navigating = f.scope.selectArea('second');
    await f.started.promise;
    const otherContext = { ...f.context, environment: { ...f.environment, id: 'another-native-workspace' } };
    const other = f.scope.createEditorState();
    other.current = f.documents.get(second);
    other.area = 'other';
    other.operations = [{ op: 'set', path: ['product_terms'], value: 'other-workspace-draft' }];
    f.scope.viewStates.createState = () => other;
    f.activate(otherContext, other);
    f.release.resolve();
    assert.equal(await navigating, false);
    assert.equal(f.scope.state, other); assert.equal(other.current.path, second);
    assert.equal(other.operations[0].value, 'other-workspace-draft');
    assert.equal(other.quarantinedDraft, null);
    assert.deepEqual(f.durable.get(`${f.environment.id}:${first}`).operations, expected);
    assert.equal(f.els.workspace.inert, false);
    f.activate(f.context, f.state);
    assert.equal(await f.scope.loadDocument(first, { preserve: true }), true);
    assert.equal(f.value(), 'baseline-before-delayed-navigation'); assert.equal(f.policy(), policy);
    assert.deepEqual(clone(f.state.operations), expected);
  });
}
