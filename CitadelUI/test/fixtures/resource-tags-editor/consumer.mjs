import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appSection, shellHarness, activate } from '../ui-review/shell-harness.mjs';
import { nativeLocalFixture } from '../../_native-fixture.mjs';
import { readText } from '../../_dom-stub.mjs';
import { createConfiguration } from '../../../shared/workspace-configuration.mjs';
import { nativeEditContext } from '../../../web/js/native-controls.mjs';
import { renderParamDocument } from '../../../web/js/paramview.mjs';
import { classifyValidation, editableValue, validateDocument } from '../../../web/js/validation.mjs';
import { APIM_SKUS, LOGIC_APPS_TEMPLATE } from '../../../web/js/azuremeta.mjs';
import { queueOperation } from '../../../web/js/preview.mjs';
import { renderDiff } from '../../../web/js/diff.mjs';
import { tagsFiles, TAGS_PATH, SECOND_PATH } from './source.mjs';

export function named(root, name) {
  const controls = [...root.querySelectorAll('button, input, select, textarea')]
    .filter((node) => node.getAttribute('aria-label') === name || node.tagName === 'BUTTON' && readText(node) === name);
  assert.equal(controls.length, 1, `One control named ${name}`);
  return controls[0];
}

export async function click(control) {
  control.focus();
  await activate(control);
}

export function type(control, value) {
  control.focus();
  control.value = value;
  control.dispatch('input');
}

export async function tagsConsumer(t, options = {}) {
  const fixture = await nativeLocalFixture({ configuration: createConfiguration('bicep'), onlyFiles: tagsFiles(options) });
  t.after(fixture.close);
  const harness = await shellHarness({
    context: fixture.context, state: { current: null },
    api: Object.fromEntries(['deployment', 'preview', 'save'].map((method) =>
      [method, (...args) => fixture.service[method](...args)])),
    registry: { getDraft: async () => null },
  });
  const { scope, els, dom } = harness;
  els.modal = dom.modal;
  const createElement = document.createElement;
  document.createElement = (tag) => {
    const node = createElement(tag), matches = node.matches.bind(node);
    node.matches = (selector) => selector === '[data-parameter-input]'
      ? node.dataset.parameterInput !== undefined : matches(selector);
    return node;
  };
  let context;
  Object.assign(scope, {
    queueOperation, nativeEditContext, classifyValidation, editableValue, validateDocument, renderDiff,
    APIM_SKUS, LOGIC_APPS_TEMPLATE,
    currentWriteContext: () => ({ path: scope.state.current?.path, sourceKind: 'local', environment: fixture.environment }),
    renderActions() {}, renderSidebar() {}, renderStatus() {}, renderContextRail() {}, markCurrentSection() {},
    renderWorkspace: () => {
      const doc = scope.viewOf(scope.state.current);
      if (!doc) return;
      context = scope.editContext(doc);
      els.workspace.replaceChildren(renderParamDocument(doc, context));
    },
  });
  vm.runInContext([
    appSection('function pushOperation(', 'function canLeaveIncompleteNumber('),
    appSection('function currentValidation(', 'function hasPolicyEdits('),
    appSection('/* -------------------------------------------------------------- edit context */', '/* ------------------------------------------------------------------ sidebar */'),
    appSection('function localOverwriteNotice(', 'async function resolveUnsavedCommit('),
    appSection('function render() {', '/* ------------------------------------------------------------------ loading */'),
    appSection('async function loadDocument(', 'async function selectArea('),
  ].join('\n'), scope);
  scope.viewStates.createState = () => scope.createEditorState();
  assert.equal(await scope.loadDocument(TAGS_PATH), true, JSON.stringify(harness.statuses));
  return {
    ...harness, fixture, service: fixture.service, path: TAGS_PATH, nextPath: SECOND_PATH,
    context: () => context, named: (name) => named(els.workspace, name),
    source: await fixture.provider.read(TAGS_PATH),
    tags: () => scope.viewOf(scope.state.current).params.find((param) => param.name === 'tags').value,
  };
}
