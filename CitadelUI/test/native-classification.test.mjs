import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { h, mount } from '../web/js/dom.mjs';
import { installDom, readText } from './_dom-stub.mjs';
import { classifyValidation, validateDocument } from '../web/js/validation.mjs';
import { previewDocument } from '../web/js/preview.mjs';
import { initializeNativeParser } from '../shared/terraform/parser.mjs';
import { validateNativeValues } from '../shared/terraform/schema.mjs';
import { configurationOf } from '../shared/workspace-configuration.mjs';
import { environmentSourceOf } from '../web/js/registry.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { createDocumentActions } from '../web/js/document-action.mjs';
import { pauseEditorForLoad } from '../web/js/editor-load.mjs';
import { captureDialogStatus } from '../web/js/dialog.mjs';
import { hasParameterInputs } from '../web/js/contract-edit-state.mjs';
import { nativeConfiguration, nativeLocalFixture, NATIVE_FILES } from './_native-fixture.mjs';

await initializeNativeParser();
const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const handlers = [
  section('function dirtyParams(', 'function pendingCount('),
  section('async function openReview(', 'async function commitSave('),
  section('function renderActions(', '/**\n * Context the masthead'),
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
].join('\n');
const alias = 'environments/development.tfvars';

async function fixture(t) {
  const f = await nativeLocalFixture({ configuration: nativeConfiguration(['deployment']), files: {
    'variables.tf': `${NATIVE_FILES['variables.tf']}
variable "advised" {
  type = string
  validation {
    condition = length(var.advised) > 1
    error_message = "Not evaluated locally."
  }
}
variable "unconsumed" { type = string }
variable "password" { type = string
  sensitive = true
  default = null
}
`,
    'main.tf': `${NATIVE_FILES['main.tf']}\noutput "advised" { value = var.advised }\n`,
    [alias]: `${NATIVE_FILES[alias]}advised = "original"\nunconsumed = "original"\n`,
  } });
  t.after(f.close);
  const document = await f.service.deployment(alias);
  const dom = installDom(), actions = dom.node(), workspace = dom.node('main');
  dom.root.append(actions, workspace);
  const state = { current: document, baselineValidation: [], operations: [], policyChanges: {},
    policyRaw: null, tab: 'params', reviewEpoch: 0 };
  const viewStates = new WorkspaceViewState(() => state); viewStates.activate(f.context);
  const calls = [], statuses = [], dialogs = [];
  const setStatus = (message, tone) => { if (message) statuses.push({ message, tone }); };
  const documentActions = createDocumentActions({
    views: viewStates, currentOwner: () => state, setStatus,
  });
  const scope = { state, viewStates, editorTransition: null, h, mount, structuredClone, classifyValidation, validateDocument, previewDocument,
    captureDialogStatus, hasParameterInputs, documentActions, document: globalThis.document, Event: globalThis.Event,
    validateNativeValues, configurationOf, environmentSourceOf,
    activeWorkspace: () => f.context, currentWriteContext: () => ({ format: 'terraform' }),
    pendingCount: () => state.operations.length, els: { tbActions: actions, workspace },
    setStatus,
    reportClientError: (error) => { calls.push({ error: error.code }); },
    guardedHandler: (action) => action, openWorkspaceSettings() {}, discardAllPending() {},
    withLocalConflict: (_review, action) => action(), showLocalOverwrite() {},
    writeContextNode: () => h('p', {}, 'Synthetic workspace'),
    renderDiff: (before, after) => ({ node: h('pre', {}, `${before}\n${after}`), stats: { added: 1, removed: 1 } }),
    showModal: (title) => { dialogs.push(title); }, closeModal() {},
    api: { preview: (...args) => { calls.push({ preview: args[0] }); return f.service.preview(...args); } },
  };
  vm.runInNewContext(handlers, scope);
  state.baselineValidation = scope.documentFindings(document);
  return { ...f, state, scope, calls, statuses, dialogs,
    reviewButton() {
      scope.renderActions();
      return actions.querySelectorAll('button').find((button) => readText(button) === 'Review & save');
    } };
}

for (const [parameter, code] of [['advised', 'native-validation-unevaluated'], ['unconsumed', 'native-unconsumed']]) {
  test(`actual native classification, action and review preserve ${code} without claiming evaluation`, async (t) => {
    const f = await fixture(t);
    f.state.operations = [{ op: 'set', path: [parameter], value: 'reviewed-new-value' }];
    const findings = f.scope.currentValidation();
    assert.equal(findings.find((item) => item.param === parameter && item.code === code)?.severity, 'warning');
    assert.equal(f.scope.blockingValidation().length, 0);
    assert.equal(f.reviewButton().disabled, false);
    await f.scope.openReview();
    assert.deepEqual(f.dialogs, ['Review changes']);
    assert.deepEqual(f.calls, [{ preview: alias }]);
    const result = await f.service.save(alias, f.state.operations, f.state.current.hash, f.state.current.nativeIdentity);
    assert(result.archived);
    const reopened = await f.service.deployment(alias);
    assert.equal(reopened.params.find((entry) => entry.name === parameter).value, 'reviewed-new-value');
    assert.match(findings.find((item) => item.code === code).message, /not locally evaluated|does not establish a runtime effect/);
  });
}

test('native type errors still disable the actual action and cannot reach review', async (t) => {
  const f = await fixture(t);
  f.state.operations = [{ op: 'set', path: ['enabled'], value: 'not-a-boolean' }];
  assert.equal(f.scope.blockingValidation().some((entry) => entry.param === 'enabled'), true);
  assert.equal(f.reviewButton().disabled, true);
  await f.scope.openReview();
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.calls.length, 0);
  assert.match(f.statuses.at(-1).message, /Resolve .* validation error/);
});

test('an independent toolbar redraw cannot enable Review while the predecessor is loading', async (t) => {
  const f = await fixture(t);
  f.state.operations = [{ op: 'set', path: ['advised'], value: 'valid-but-paused' }];
  assert.equal(f.reviewButton().disabled, false);
  const pause = pauseEditorForLoad([f.scope.els.tbActions], h('p'), 'Opening document');
  f.scope.editorTransition = { pause };
  assert.equal(f.reviewButton().disabled, true);
  pause.release();
  f.scope.editorTransition = null;
  assert.equal(f.reviewButton().disabled, false);
});

test('sensitive native replacements are refused by the actual review service with the draft and source intact', async (t) => {
  const f = await fixture(t);
  const before = f.root.allFiles().find((file) => file.path === alias).bytes.slice();
  const operations = [{ op: 'set', path: ['password'], value: 'synthetic-sensitive-negative' }];
  f.state.operations = operations;
  await f.scope.openReview();
  assert.equal(f.dialogs.length, 0);
  assert.equal(f.calls.some((entry) => entry.error === 'NATIVE_FIELD_READ_ONLY'), true);
  assert.equal(f.statuses.at(-1).tone, 'error');
  assert.equal(f.state.operations, operations);
  assert.deepEqual(f.root.allFiles().find((file) => file.path === alias).bytes, before);
});

test('native warning preservation does not weaken edited Bicep warning classification', () => {
  const warning = { param: 'apimSubnetPrefix', path: ['apimSubnetPrefix'], severity: 'warning', message: 'Baseline network advisory' };
  assert.equal(classifyValidation([warning], [warning], new Set(['apimSubnetPrefix']))[0].severity, 'error');
  const dom = installDom();
  const state = { current: { format: 'bicep', params: [] }, baselineValidation: [warning],
    operations: [{ path: ['apimSubnetPrefix'] }] };
  const context = { state, classifyValidation, previewDocument, validateDocument: () => [warning], document: dom };
  vm.runInNewContext(section('function dirtyParams(', 'function hasPolicyEdits('), context);
  assert.equal(context.currentValidation(state.current)[0].severity, 'error');
});
