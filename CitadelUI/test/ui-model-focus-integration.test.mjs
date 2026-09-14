import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { appSection, shellHarness, activate } from './fixtures/ui-review/shell-harness.mjs';
import { exportFixture, fixtureFiles, fixtureValues } from './_terraform-export-fixture.mjs';
import { nativeConfiguration, nativeLocalFixture, NATIVE_FILES } from './_native-fixture.mjs';
import { EXPORT_AREAS } from '../shared/terraform-contract.mjs';
import { assertNonsecretValues, validateNativeValues } from '../shared/terraform/schema.mjs';
import { sameNativeDraftBinding } from '../shared/terraform/drafts.mjs';
import { WorkspaceService } from '../web/js/workspace-service.mjs';
import { nativeEditContext } from '../web/js/native-controls.mjs';
import { renderParamDocument, renderOutlineNav } from '../web/js/paramview.mjs';
import { classifyValidation, editableValue, validateDocument } from '../web/js/validation.mjs';
import { APIM_SKUS, LOGIC_APPS_TEMPLATE } from '../web/js/azuremeta.mjs';
import { queueOperation } from '../web/js/preview.mjs';

const SEARCH_NAME = 'Search the model catalogue, or type your own deployment name';
const bicepPath = EXPORT_AREAS.find((area) => area.id === 'llm').path;
const nativePath = 'llm-backend-onboarding/operator.tfvars';
const jsonPath = 'llm-backend-onboarding/second.tfvars.json';
const editName = (model, backend) => `Edit model details: ${model} on backend ${backend}`;
const closeName = (model, backend) => `Close details for model ${model} on backend ${backend}`;

function named(root, name) {
  const matches = [...root.querySelectorAll('button, input, select, textarea')]
    .filter((node) => node.getAttribute('aria-label') === name);
  assert.equal(matches.length, 1, `One production control named ${name}`);
  return matches[0];
}

async function click(node) {
  node.focus();
  await activate(node);
}

async function consumer(t, format = 'bicep') {
  const values = fixtureValues();
  const backend = values.llm.llmBackendConfig[0];
  backend.supportedModels.push({ ...backend.supportedModels[0], name: 'second-model' });
  const files = fixtureFiles(values);
  const secondBicepPath = bicepPath.replace(/main\.bicepparam$/, 'second.bicepparam');
  files[secondBicepPath] = files[bicepPath].replaceAll('synthetic-east', 'other-backend').replaceAll('gpt-4.1', 'other-model');
  const fixture = format === 'bicep' ? exportFixture(files) : await nativeLocalFixture({
    configuration: nativeConfiguration(['deployment', 'llm', 'access',
      { area: 'llm', valueAlias: jsonPath, syntax: 'json-tfvars' }]),
    files: {
      [nativePath]: NATIVE_FILES[nativePath].replace('supported_models = [{', 'supported_models = [{ name = "model-b", capacity = 25 }, {'),
      [jsonPath]: '{ "apim_name": "synthetic-gateway", "managed_identity_client_id": "", "llm_backend_config": [{ "backend_id": "other-backend", "backend_type": "azure-openai", "endpoint": "https://other.invalid", "supported_models": [{ "name": "other-model" }] }] }\n',
    },
  });
  if (fixture.close) t.after(fixture.close);
  const service = fixture.service || new WorkspaceService({ contextProvider: () => fixture.context });
  const drafts = new Map();
  const harness = await shellHarness({
    context: fixture.context, state: { current: null },
    api: { deployment: (alias, context) => service.deployment(alias, { context }) },
    registry: {
      getDraft: async (id, alias) => drafts.get(`${id}:${alias}`) || null,
      saveDraft: async (id, alias, sourceHash, operations, nativeIdentity) => {
        drafts.set(`${id}:${alias}`, structuredClone({ path: alias, sourceHash, operations, nativeIdentity }));
      },
      removeDraft: async (id, alias) => { drafts.delete(`${id}:${alias}`); },
    },
  });
  const { scope, els, dom } = harness;
  els.modal = dom.modal;
  const contexts = [];
  Object.assign(scope, {
    queueOperation, nativeEditContext, classifyValidation, editableValue, validateDocument,
    APIM_SKUS, LOGIC_APPS_TEMPLATE, assertNonsecretValues, validateNativeValues, sameNativeDraftBinding,
    renderActions: () => harness.calls.push(['renderActions']),
    renderSidebar: () => harness.calls.push(['renderSidebar']),
    renderStatus: () => harness.calls.push(['renderStatus']),
    markCurrentSection: () => {},
    renderWorkspace: () => {
      const doc = scope.viewOf(scope.state.current);
      if (!doc) return;
      const context = scope.editContext(doc);
      contexts.push({ context, duringPaint: context.modelFocus.isCurrent() });
      els.workspace.replaceChildren(renderParamDocument(doc, context));
    },
    renderContextRail: () => {
      const doc = scope.viewOf(scope.state.current);
      if (!doc) return;
      const context = scope.editContext(doc);
      contexts.push({ context, duringPaint: context.modelFocus.isCurrent() });
      const nav = renderOutlineNav(doc, context, () => {}, 'tabs');
      els.contextRail.replaceChildren(...(nav ? [nav] : []));
    },
  });
  vm.runInContext([
    appSection('function pushOperation(', 'function canLeaveIncompleteNumber('),
    appSection('function currentValidation(', 'function hasPolicyEdits('),
    appSection('/* -------------------------------------------------------------- edit context */', '/* ------------------------------------------------------------------ sidebar */'),
    appSection('function render() {', '/* ------------------------------------------------------------------ loading */'),
    appSection('async function loadDocument(', 'async function selectArea('),
  ].join('\n'), scope);
  scope.viewStates.createState = () => scope.createEditorState();
  const alias = format === 'bicep' ? bicepPath : nativePath;
  assert.equal(await scope.loadDocument(alias), true, JSON.stringify(harness.statuses));
  const source = await fixture.provider.read(alias);
  return {
    ...harness, fixture, service, drafts, contexts, source, alias,
    nextAlias: format === 'bicep' ? secondBicepPath : jsonPath,
    binding: format === 'bicep'
      ? { root: 'llmBackendConfig', models: 'supportedModels', backend: 'synthetic-east', first: 'gpt-4.1', second: 'second-model' }
      : { root: 'llm_backend_config', models: 'supported_models', backend: 'synthetic-backend', first: 'model-b', second: 'model-a' },
    currentContext: () => contexts.at(-1).context,
    freshContext: () => scope.editContext(scope.viewOf(scope.state.current)),
  };
}

for (const format of ['bicep', 'terraform']) {
  test(`model-focus consumer: ${format} actual body/outline contexts share one token through loading and painting`, async (t) => {
    const h = await consumer(t, format);
    const first = h.contexts[0].context;
    assert(h.contexts.length >= 2);
    assert(h.contexts.every(({ context }) => context.modelFocus === first.modelFocus));
    assert(h.contexts.every(({ duringPaint }) => duringPaint === false));
    assert.equal(first.modelFocus.root, h.els.workspace);
    assert.equal(first.modelFocus.isCurrent(), true);
    assert.notEqual(h.freshContext(), first);
    assert.equal(h.freshContext().modelFocus, first.modelFocus);
    assert.equal(h.freshContext().inputOwner, first.inputOwner);
    assert.equal(first.native === true, format === 'terraform');
    h.scope.render();
    assert.equal(h.currentContext().modelFocus, first.modelFocus);
    assert.equal(first.modelFocus.isCurrent(), true);
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });

  test(`model-focus consumer: ${format} disclosure rebuild focuses the same viewer's close and edit controls`, async (t) => {
    const h = await consumer(t, format);
    const { first, backend } = h.binding;
    const token = h.currentContext().modelFocus;
    const old = named(h.els.workspace, editName(first, backend));
    await click(old);
    assert.equal(old.isConnected, false);
    assert.equal(document.activeElement, named(h.els.workspace, closeName(first, backend)));
    assert.equal(h.currentContext().modelFocus, token);
    await click(document.activeElement);
    assert.equal(document.activeElement, named(h.els.workspace, editName(first, backend)));
    assert.equal(h.owner.operations.length, 0);
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });

  test(`model-focus consumer: ${format} actual accepted add/remove callbacks preserve their semantic destinations`, async (t) => {
    const h = await consumer(t, format);
    const previousWindow = globalThis.window, previousObserver = globalThis.MutationObserver;
    globalThis.window = new EventTarget();
    globalThis.MutationObserver = class {
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    };
    t.after(() => { globalThis.window = previousWindow; globalThis.MutationObserver = previousObserver; });
    const { backend, first, second } = h.binding;
    const token = h.currentContext().modelFocus;
    const input = named(h.els.workspace, SEARCH_NAME);
    input.value = 'consumer-added-model';
    input.dispatch('input');
    await click(named(h.els.workspace, `Add model to backend ${backend}`));
    assert.equal(document.activeElement, named(h.els.workspace, editName('consumer-added-model', backend)));
    assert.equal(h.owner.operations.length, 1);
    await click(named(h.els.workspace, `Remove model consumer-added-model from backend ${backend}`));
    assert.equal(document.activeElement, named(h.els.workspace, editName(second, backend)));
    await click(named(h.els.workspace, `Remove model ${first} from backend ${backend}`));
    assert.equal(document.activeElement, named(h.els.workspace, editName(second, backend)));
    assert.equal(h.currentContext().modelFocus, token);
    assert.equal(h.owner.current.params.find((param) => param.name === h.binding.root).value[0][h.binding.models].length, 2);
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });

  test(`model-focus consumer: ${format} a rejected container edit keeps the draft, original control and source`, async (t) => {
    const h = await consumer(t, format);
    const { root, models, first, backend } = h.binding;
    h.currentContext().onInputDraft([root, 0, models, 0, 'name'], { value: 'unfinished', composing: true });
    const remove = named(h.els.workspace, `Remove model ${first} from backend ${backend}`);
    await click(remove);
    assert.equal(document.activeElement, remove);
    assert.equal(h.owner.operations.length, 0);
    assert.equal(Object.values(h.owner.parameterInputs)[0].value, 'unfinished');
    assert.match(h.statuses.at(-1).message, /pending field input/);
    assert.equal(h.currentContext().modelFocus.isCurrent(), true, 'Focus eligibility is not write permission');
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });

  test(`model-focus consumer: ${format} ignored quarantined mutation does not masquerade as a successful focus move`, async (t) => {
    const h = await consumer(t, format);
    const { first, backend } = h.binding;
    h.scope.retainQuarantinedDraft(h.owner, h.scope.captureContractEdits(h.owner), 'Retained fixture source conflict', h.alias);
    const remove = named(h.els.workspace, `Remove model ${first} from backend ${backend}`);
    await click(remove);
    assert.equal(document.activeElement, remove);
    assert.equal(h.owner.operations.length, 0);
    assert.match(h.statuses.at(-1).message, /Retained fixture source conflict/);
    assert.equal(h.currentContext().modelFocus.isCurrent(), true);
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });

  test(`model-focus consumer: ${format} actual document loads retire disclosure and mutation callbacks without repainting the next document`, async (t) => {
    const h = await consumer(t, format);
    const previous = h.currentContext(), oldToken = previous.modelFocus;
    const staleToggle = named(h.els.workspace, editName(h.binding.first, h.binding.backend));
    const staleRemove = named(h.els.workspace, `Remove model ${h.binding.first} from backend ${h.binding.backend}`);
    assert.equal(await h.scope.loadDocument(h.nextAlias), true, JSON.stringify(h.statuses));
    const next = h.currentContext();
    assert.notEqual(next.modelFocus, oldToken);
    assert.equal(oldToken.isCurrent(), false);
    assert.equal(next.modelFocus.isCurrent(), true);
    const control = named(h.els.workspace, editName('other-model', 'other-backend'));
    control.focus();
    const paints = h.contexts.length, open = [...h.owner.open];
    await activate(staleToggle);
    await activate(staleRemove);
    assert.equal(h.contexts.length, paints);
    assert.deepEqual([...h.owner.open], open);
    assert.equal(h.owner.operations.length, 0);
    assert.equal(document.activeElement, control);
    assert.equal(previous.onRemove([h.binding.root, 0]), false);
    assert.equal(previous.rerender(), false);
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });
}

for (const [label, change] of [
  ['input owner', (h) => h.scope.clearEditorPending(h.owner)],
  ['document generation', (h) => { h.owner.documentGeneration += 1; }],
  ['contract owner', (h) => { h.owner.contract = { id: 'different-contract', param: h.owner.current }; }],
  ['workspace ticket', (h) => { h.scope.state = h.scope.viewStates.activate(h.context); }],
  ['viewer root', (h) => { h.els.workspace = h.dom.node('main'); h.dom.root.append(h.els.workspace); }],
  ['parameter view', (h) => { h.owner.tab = 'raw'; }],
]) {
  test(`model-focus consumer: a real ${label} change invalidates the captured token and view callbacks`, async (t) => {
    const h = await consumer(t);
    const previous = h.currentContext();
    change(h);
    assert.equal(previous.modelFocus.isCurrent(), false);
    const paints = h.contexts.length, open = [...h.owner.open];
    assert.equal(previous.setOpen('retired-view-disclosure', true), false);
    assert.equal(previous.rerender(), false);
    assert.deepEqual([...h.owner.open], open);
    assert.equal(h.contexts.length, paints);
    assert.notEqual(h.freshContext().modelFocus, previous.modelFocus);
  });
}

for (const [label, start, end] of [
  ['painting', (h) => { h.owner.paintingEditor = true; }, (h) => { h.owner.paintingEditor = false; }],
  ['loading', (h) => { h.scope.editorTransition = { pause: { refresh() {} } }; }, (h) => { h.scope.editorTransition = null; }],
  ['native modal', (h) => h.dom.modal.showModal(), (h) => h.dom.modal.close()],
]) {
  test(`model-focus consumer: ${label} suspends focus eligibility without rotating a valid owner during context construction`, async (t) => {
    const h = await consumer(t);
    const token = h.currentContext().modelFocus;
    start(h);
    assert.equal(token.isCurrent(), false);
    assert.equal(h.freshContext().modelFocus, token);
    assert.equal(h.freshContext().modelFocus, token);
    end(h);
    assert.equal(token.isCurrent(), true);
  });
}

test('model-focus consumer: another activated workspace has independent document, input and viewer tokens', async (t) => {
  const h = await consumer(t);
  const previous = h.currentContext(), oldOwner = h.owner;
  const other = exportFixture(fixtureFiles());
  other.context.environment.id = 'second-real-fixture';
  h.scope.activeWorkspace = () => other.context;
  h.scope.state = h.scope.viewStates.activate(other.context);
  assert.notEqual(h.scope.state, oldOwner);
  assert.equal(await h.scope.loadDocument(h.alias), true, JSON.stringify(h.statuses));
  const next = h.currentContext();
  assert.notEqual(next.modelFocus, previous.modelFocus);
  assert.notEqual(next.inputOwner, previous.inputOwner);
  assert.equal(previous.modelFocus.isCurrent(), false);
  assert.equal(next.modelFocus.isCurrent(), true);
  assert.equal(previous.onAppend([h.binding.root], {}), false);
  assert.equal(previous.setOpen('other-workspace', true), false);
  assert.equal(previous.rerender(), false);
  assert.equal(h.scope.state.operations.length, 0);
});

test('model-focus consumer: actual native field input and render preserve the current input owner, raw text and caret', async (t) => {
  const h = await consumer(t, 'terraform');
  const { root, models, first, backend } = h.binding;
  await click(named(h.els.workspace, editName(first, backend)));
  const key = JSON.stringify([[root, 0, models, 0, 'name'], 0]);
  const control = [...h.els.workspace.querySelectorAll('input')].find((node) => node.dataset.editorFocus === key);
  assert(control);
  control.focus();
  control.value = 'native-caret-draft';
  control.setSelectionRange(3, 8, 'backward');
  control.dispatch('input');
  assert.equal(Object.values(h.owner.parameterInputs).length, 1);
  const context = h.currentContext();
  context.rerender();
  const replacement = [...h.els.workspace.querySelectorAll('input')].find((node) => node.dataset.editorFocus === key);
  assert.notEqual(replacement, control);
  assert.equal(document.activeElement, replacement);
  assert.equal(replacement.value, 'native-caret-draft');
  assert.deepEqual([replacement.selectionStart, replacement.selectionEnd, replacement.selectionDirection], [3, 8, 'backward']);
  assert.equal(h.currentContext().modelFocus, context.modelFocus);
  assert.equal(h.currentContext().inputOwner, context.inputOwner);
  assert.equal(h.owner.operations.length, 0);
  assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
});

test('model-focus consumer: an intervening focus claim after the actual repaint is not stolen by model restoration', async (t) => {
  const h = await consumer(t);
  const outside = h.dom.node('button');
  h.dom.root.append(outside);
  const renderRail = h.scope.renderContextRail;
  h.scope.renderContextRail = () => { renderRail(); outside.focus(); };
  await click(named(h.els.workspace, editName(h.binding.first, h.binding.backend)));
  assert.equal(document.activeElement, outside);
  assert.equal(h.currentContext().modelFocus.isCurrent(), true);
});

test('model-focus consumer: a native modal opened during the actual repaint prevents background fallback focus', async (t) => {
  const h = await consumer(t);
  const modalControl = h.dom.node('button');
  h.dom.modal.append(modalControl);
  const renderRail = h.scope.renderContextRail;
  h.scope.renderContextRail = () => {
    renderRail();
    h.dom.modal.showModal();
    modalControl.focus();
  };
  await click(named(h.els.workspace, editName(h.binding.first, h.binding.backend)));
  assert.equal(document.activeElement, modalControl);
  assert.equal(h.els.workspace.inert, false, 'Native top-layer exclusion is not an inert attribute');
  assert.equal(h.currentContext().modelFocus.isCurrent(), false);
});

test('model-focus consumer: temporary read-only workspace modes cannot inherit main model focus or view callbacks', async (t) => {
  const h = await consumer(t);
  const previous = h.currentContext();
  const temporary = h.dom.node('section'), control = h.dom.node('button');
  temporary.append(control);
  h.els.workspace.replaceChildren(temporary);
  h.els.shell.dataset.workspace = 'terraform-export';
  control.focus();
  assert.equal(previous.modelFocus.isCurrent(), false);
  assert.equal(previous.rerender(), false);
  assert.equal(previous.setOpen('temporary-view', true), false);
  assert.equal(document.activeElement, control);
  assert.equal(temporary.isConnected, true);
});

async function mutationConsumer(t, format) {
  const h = await consumer(t, format === 'bicep' ? 'bicep' : 'terraform');
  if (format === 'json') {
    assert.equal(await h.scope.loadDocument(jsonPath), true, JSON.stringify(h.statuses));
    h.alias = jsonPath;
    h.source = await h.fixture.provider.read(jsonPath);
    h.binding = { root: 'llm_backend_config', models: 'supported_models', first: 'other-model', backend: 'other-backend' };
  }
  return h;
}

// The browser replay covers actual navigation; this fixture isolates admission.
function retireEditableView(h, mode) {
  if (mode === 'raw') h.owner.tab = 'raw';
  else h.els.shell.dataset.workspace = mode;
  const successor = h.dom.node('section'), control = h.dom.node('button');
  successor.append(control);
  h.els.workspace.replaceChildren(successor);
  control.focus();
  return { successor, control };
}

function mutationState(h) {
  return JSON.stringify({ operations: h.owner.operations, inputs: h.owner.parameterInputs, drafts: [...h.drafts] });
}

const mutationEntries = [
  ['change', (context, path) => context.onChange([...path, 'name'], 'retired-name')],
  ['append', (context, path) => context.onAppend(path.slice(0, -1), { name: 'retired-append' })],
  ['remove', (context, path) => context.onRemove(path)],
  ['add property', (context, path) => context.onAddProperty(path, 'retiredField', 'retired-property')],
  ['buffered input', (context, path) => context.onInputDraft([...path, 'name'], { value: 'retired-input' })],
  ['object fields', (context, path) => context.applyObject(path, { name: 'retired-object' }, ['name'])],
];

for (const [format, mode] of [
  ['bicep', 'raw'], ['terraform', 'raw'], ['json', 'raw'], ['bicep', 'terraform-export'],
]) {
  test(`model-mutation consumer: ${format} synthetic retained Remove preserves its ${mode} successor and draft`, async (t) => {
    const h = await mutationConsumer(t, format);
    const retained = named(h.els.workspace, `Remove model ${h.binding.first} from backend ${h.binding.backend}`);
    const { successor, control } = retireEditableView(h, mode);
    const before = mutationState(h), paints = h.contexts.length;
    assert.equal(retained.isConnected, false);
    await activate(retained);
    assert.equal(mutationState(h), before);
    assert.equal(h.contexts.length, paints);
    assert.equal(successor.isConnected, true);
    assert.equal(document.activeElement, control);
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });
}

for (const mode of ['raw', 'terraform-export']) {
  for (const [entry, mutate] of mutationEntries) {
    test(`model-mutation consumer: a retired ${mode} context rejects ${entry} without repaint or focus theft`, async (t) => {
      const h = await consumer(t), previous = h.currentContext();
      const { successor, control } = retireEditableView(h, mode);
      const before = mutationState(h), paints = h.contexts.length;
      mutate(previous, [h.binding.root, 0, h.binding.models, 0]);
      assert.equal(mutationState(h), before);
      assert.equal(h.contexts.length, paints);
      assert.equal(successor.isConnected, true);
      assert.equal(document.activeElement, control);
      assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
    });
  }

  test(`model-mutation consumer: constructing a fresh context in ${mode} does not grant parameter mutations`, async (t) => {
    const h = await consumer(t);
    const { successor, control } = retireEditableView(h, mode);
    const context = h.freshContext(), before = mutationState(h), paints = h.contexts.length;
    assert.equal(context.modelFocus.isCurrent(), false);
    assert.equal(context.onRemove([h.binding.root, 0, h.binding.models, 0]), false);
    assert.equal(mutationState(h), before);
    assert.equal(h.contexts.length, paints);
    assert.equal(successor.isConnected, true);
    assert.equal(document.activeElement, control);
  });
}

test('model-mutation consumer: a valid modal owner may edit while model focus is temporarily suspended', async (t) => {
  const h = await consumer(t), context = h.currentContext(), token = context.modelFocus;
  const modalControl = h.dom.node('button');
  h.dom.modal.append(modalControl);
  h.dom.modal.showModal();
  modalControl.focus();
  assert.equal(token.isCurrent(), false);
  context.onChange([h.binding.root, 0, h.binding.models, 0, 'name'], 'valid-modal-edit');
  assert.equal(h.owner.operations.length, 1);
  assert.equal(h.owner.operations[0].value, 'valid-modal-edit');
  assert.equal(document.activeElement, modalControl);
  assert.equal(h.currentContext().modelFocus, token);
  h.dom.modal.close();
  assert.equal(token.isCurrent(), true);
  assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
});

test('model-mutation consumer: painting retains its mutation guard and resumes valid edits without rotating focus', async (t) => {
  const h = await consumer(t), context = h.currentContext(), token = context.modelFocus;
  h.owner.paintingEditor = true;
  const before = mutationState(h);
  for (const [, mutate] of mutationEntries.slice(0, 5)) {
    mutate(context, [h.binding.root, 0, h.binding.models, 0]);
  }
  assert.equal(mutationState(h), before);
  assert.equal(h.freshContext().modelFocus, token);
  assert.equal(token.isCurrent(), false);
  h.owner.paintingEditor = false;
  context.onAppend([h.binding.root, 0, h.binding.models], { name: 'valid-after-paint' });
  assert.equal(h.owner.operations.length, 1);
  assert.equal(h.owner.operations[0].op, 'append');
  assert.equal(h.currentContext().modelFocus, token);
  assert.equal(token.isCurrent(), true);
  assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
});

const batchTarget = {
  subscriptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceGroupName: 'batch-target-rg',
  name: 'batch-target-apim',
};
const batchOperations = () => Object.entries(batchTarget).map(([key, value]) =>
  ({ op: 'set', path: ['apim', key], value }));
const batchRoutes = [
  ['object application', (h) => h.currentContext().applyObject(['apim'], batchTarget, Object.keys(batchTarget))],
  ['shared batch queue', (h) => h.scope.pushOperations(batchOperations())],
];

function batchSnapshot(h) {
  return JSON.stringify({
    mutations: mutationState(h),
    quarantine: h.owner.quarantinedDraft,
    quarantines: [...h.owner.quarantinedDrafts],
    values: h.scope.viewOf(h.owner.current).params.map(({ name, value }) => [name, value]),
  });
}

for (const [route, apply] of batchRoutes) {
  for (const state of ['quarantine', 'painting', 'pending inputs', 'quarantine with buffers', 'painting with buffers']) {
    test(`model-batch consumer: ${route} rejects ${state} without partial mutation or buffer loss`, async (t) => {
      const h = await consumer(t), context = h.currentContext();
      context.onChange([h.binding.root, 0, h.binding.models, 0, 'name'], 'existing-working-edit');
      if (state.includes('buffers') || state === 'pending inputs') {
        h.currentContext().onInputDraft(['apim', 'name'], { value: 'uncommitted buffer', composing: true });
      }
      if (state.startsWith('quarantine')) {
        h.scope.retainQuarantinedDraft(h.owner, h.scope.captureContractEdits(h.owner),
          'Retained batch source conflict', h.alias);
      }
      if (state.startsWith('painting')) h.owner.paintingEditor = true;
      await new Promise((resolve) => setImmediate(resolve));
      const before = batchSnapshot(h), paints = h.contexts.length, statuses = h.statuses.length;
      const focused = document.activeElement;
      const result = apply(h);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(batchSnapshot(h), before);
      assert.equal(result, false);
      assert.equal(h.contexts.length, paints);
      assert.equal(document.activeElement, focused);
      if (state.startsWith('quarantine')) {
        assert.equal(h.statuses.at(-1).message, 'Retained batch source conflict');
        assert.equal(h.statuses.at(-1).tone, 'error');
      } else if (state === 'pending inputs') {
        assert.equal(h.statuses.at(-1).message, 'Finish or discard the pending field input before applying multiple changes.');
        assert.equal(h.statuses.at(-1).tone, 'error');
      } else {
        assert.equal(h.statuses.length, statuses, 'Painting rejects before attempting an interactive status update.');
      }
      assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
    });
  }
}

for (const modal of [false, true]) {
  test(`model-batch consumer: a valid ${modal ? 'modal-suspended' : 'active'} owner applies all three target fields`, async (t) => {
    const h = await consumer(t), context = h.currentContext(), token = context.modelFocus;
    let modalControl;
    if (modal) {
      modalControl = h.dom.node('button');
      h.dom.modal.append(modalControl);
      h.dom.modal.showModal();
      modalControl.focus();
      assert.equal(token.isCurrent(), false);
    }
    const result = context.applyObject(['apim'], batchTarget, Object.keys(batchTarget));
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(result, false);
    assert.deepEqual(JSON.parse(JSON.stringify(h.owner.operations)), batchOperations());
    const values = h.scope.viewOf(h.owner.current).params.find((param) => param.name === 'apim').value;
    for (const [key, value] of Object.entries(batchTarget)) assert.equal(values[key], value);
    assert.equal(h.currentContext().modelFocus, token);
    if (modal) {
      assert.equal(document.activeElement, modalControl);
      assert.equal(h.dom.modal.open, true);
      h.dom.modal.close();
    }
    assert.equal(token.isCurrent(), true);
    assert.deepEqual(await h.fixture.provider.read(h.alias), h.source);
  });
}
