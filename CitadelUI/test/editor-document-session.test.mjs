import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDom } from './_dom-stub.mjs';
import { createDocumentActions } from '../web/js/document-action.mjs';
import { createEditorDocumentSession } from '../web/js/editor-document-session.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import { pauseEditorForLoad } from '../web/js/editor-load.mjs';
import { captureDialogStatus } from '../web/js/dialog.mjs';
import { sameNativeDraftBinding } from '../shared/terraform/drafts.mjs';
import { configurationKey, configurationOf } from '../shared/workspace-configuration.mjs';
import { mutationComplete } from '../shared/mutation-outcome.mjs';
import { environmentSourceOf } from '../web/js/registry.mjs';
import { withSourceUnavailable } from '../web/js/workspace-activation.mjs';
import * as edits from '../web/js/contract-edit-state.mjs';

const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const appAdapters = [
  section('function createEditorState()', 'const viewStates ='),
  section('async function withStatus(', '/* -------------------------------------------------------------- operations */'),
  section('async function restoreParameterDraft(', 'function pushOperation('),
  section('function canLeaveIncompleteNumber(', 'function flushParameterInputs('),
  section('async function withEditorLoad(', 'function rememberDocumentView('),
  section('async function loadContract(', 'async function selectContract('),
  section('async function loadDocument(', 'async function selectArea('),
].join('\n');

function deferred(t) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  t?.after(() => resolve());
  return { promise, resolve, reject };
}

function contract(name) {
  return { id: name, param: {
    path: `synthetic/${name}.bicepparam`, hash: `${name}-hash`, text: "param label = 'saved'\n",
    params: [{ name: 'label', value: 'saved' }], schema: { parameters: { label: { secure: false } } },
  }, policy: { path: `synthetic/${name}.xml`, hash: `${name}-policy-hash`, text: '<policies />' } };
}

function fixture() {
  const dom = installDom(), events = [], statuses = [], errors = [], renders = [], frames = [], draftReads = [];
  const els = { workspace: dom.node('main'), sidebar: dom.node('nav'), contextRail: dom.node('aside'),
    tbActions: dom.node('header'), editorLoading: dom.node() };
  els.editorLoading.hidden = true;
  dom.root.append(...Object.values(els));
  const input = dom.node('input'), disabled = dom.node('button');
  input.value = 'connected predecessor input'; input.dataset.editorFocus = 'label';
  disabled.disabled = true;
  els.workspace.append(input, disabled);
  const predecessor = contract('predecessor');
  let target = contract('target'), context = { environment: { id: 'editor-session' } };
  const findings = [{ severity: 'warning', message: 'Document findings' }];
  const validation = [{ severity: 'info', message: 'Contract validation' }];
  const scope = {
    document: globalThis.document, Map, structuredClone, ...edits,
    configurationKey, configurationOf, environmentSourceOf, withSourceUnavailable, mutationComplete,
    createDocumentActions, createEditorDocumentSession, pauseEditorForLoad, captureDialogStatus, sameNativeDraftBinding,
    els, editorTransition: null, documentGeneration: 40,
    activeWorkspace: () => context,
    reportClientError: (error) => errors.push(error),
    setStatus(message, tone) {
      scope.state.status = message ? { message, tone } : null;
      statuses.push({ message, tone });
    },
    render() {
      renders.push({ document: scope.state.current, contract: scope.state.contract, operations: scope.state.operations });
      events.push('render');
      scope.editorTransition?.pause.refresh();
    },
    restoreStashedPending() { events.push('restore-stash'); return false; },
    refreshPolicyPreview: async () => { events.push('policy-preview'); },
    requestAnimationFrame: (callback) => { events.push('frame'); frames.push(callback); },
    validateDocument: () => validation,
    documentFindings: () => findings,
    workspaceRegistry: { getDraft: async () => null },
    api: {
      contract: async (_id, capturedContext) => {
        events.push('contract-read'); assert.equal(capturedContext, context); return target;
      },
      accessContractTargets: async (capturedContext) => {
        events.push('targets-read'); assert.equal(capturedContext, context); return { writable: true };
      },
      deployment: async (_path, capturedContext) => {
        events.push('document-read'); assert.equal(capturedContext, context); return target.param;
      },
      onboardedModels: async () => { events.push('models-read'); return { models: [] }; },
      policyVariables: async () => { events.push('variables-read'); return {}; },
    },
  };
  vm.runInNewContext(appAdapters, scope);
  scope.viewStates = new WorkspaceViewState(scope.createEditorState);
  scope.state = scope.viewStates.activate(context);
  Object.assign(scope.state, { current: predecessor.param, contract: predecessor, contractId: predecessor.id,
    area: 'access-contracts', documentGeneration: 40, policyRevision: 5, reviewEpoch: 3,
    operations: [{ op: 'set', path: ['label'], value: 'queued predecessor' }],
    onboardedModels: [{ name: 'already loaded' }], tab: 'policy' });
  const restore = scope.restoreParameterDraft;
  scope.restoreParameterDraft = (doc, owner) => {
    draftReads.push({ doc, owner }); events.push('draft-read'); return restore(doc, owner);
  };
  vm.runInNewContext(section('const documentActions =', 'const els ='), scope);
  input.blur = () => { events.push('blur'); document.activeElement = dom.root; };
  input.focus();
  const invoke = (kind, options = {}) => kind === 'contract'
    ? scope.loadContract(target.id, options.preserved, options.preserveOptions, options.transition)
    : scope.loadDocument(target.param.path, options);
  return { dom, scope, els, input, disabled, predecessor, events, statuses, errors, renders, frames, draftReads,
    findings, validation, invoke,
    get owner() { return scope.state; },
    get target() { return target; }, set target(next) { target = next; },
    get context() { return context; },
    activate(next) { context = next; scope.state = scope.viewStates.activate(next); return scope.state; },
  };
}

for (const kind of ['contract', 'document']) {
  test(`editor document session: ${kind} forwards the gate promise and transition without another async boundary`, () => {
    const result = Promise.resolve(false), calls = [], transition = {};
    const session = createEditorDocumentSession({
      loadGate: { run: (...args) => { calls.push(args); return result; } },
    });
    const actual = kind === 'contract'
      ? session.loadContract('target', null, undefined, transition)
      : session.loadDocument('target', { transition });
    assert.equal(actual, result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], transition);
    assert.match(calls[0][0], /Editing is paused until loading finishes/);
    assert.equal(typeof calls[0][1], 'function');
  });

  test(`editor document session: ${kind} blurs before capture and accepts source, draft and selection together`, async (t) => {
    const f = fixture(), owner = f.owner, previousInputScope = owner.inputScope;
    const sourceReady = deferred(t), draftEntered = deferred(), draftReady = deferred(t), contexts = [];
    const original = f.scope.api[kind === 'contract' ? 'contract' : 'deployment'];
    f.scope.api[kind === 'contract' ? 'contract' : 'deployment'] = async (...args) => {
      contexts.push(args.at(-1)); await sourceReady.promise; return original(...args);
    };
    f.scope.workspaceRegistry.getDraft = async (workspaceId, path) => {
      assert.equal(workspaceId, owner.workspaceId); assert.equal(path, f.target.param.path);
      draftEntered.resolve(); await draftReady.promise;
      return { sourceHash: f.target.param.hash, operations: [{ op: 'set', path: ['label'], value: 'stored target draft' }] };
    };
    f.input.blur = () => {
      assert.equal(f.input.disabled, false);
      assert.equal(owner.documentGeneration, 40);
      owner.operations[0].value = 'committed on blur';
      f.events.push('blur'); document.activeElement = f.dom.root;
    };
    const selection = { area: 'target-area', contract: null, contractId: null, accessTargets: null };
    const loading = f.invoke(kind, { selection });
    assert.equal(f.scope.documentGeneration, 41, 'The app caller can capture the new generation immediately.');
    assert.equal(owner.documentGeneration, 41);
    assert.equal(f.events[0], 'blur');
    assert.equal(f.input.disabled, true);
    assert.equal(f.input.isConnected, true);
    assert.equal(owner.current, f.predecessor.param);
    assert.equal(owner.area, 'access-contracts');
    assert.equal(owner.operations[0].value, 'committed on blur');
    if (kind === 'contract') assert(f.events.includes('targets-read'), 'The access-target read is not serialized behind the contract read.');
    sourceReady.resolve(); await draftEntered.promise;
    const staged = f.draftReads[0].owner;
    assert.notEqual(staged, owner);
    assert.equal(staged.workspaceKey, owner.workspaceKey);
    assert.notEqual(staged.quarantinedDrafts, owner.quarantinedDrafts);
    assert.equal(owner.current, f.predecessor.param);
    assert.equal(owner.inputScope, previousInputScope);
    draftReady.resolve();
    assert.equal(await loading, true);
    assert.deepEqual(contexts, [f.context]);
    assert.equal(owner.current, f.target.param);
    assert.equal(owner.operations[0].value, 'stored target draft');
    assert.notEqual(owner.inputScope, previousInputScope);
    assert.deepEqual(structuredClone(owner.parameterInputs), {});
    assert.equal(owner.policyRaw, null);
    assert.equal(owner.policyRevision, 6);
    assert.equal(owner.reviewEpoch, 3);
    assert.equal(owner.baselineValidation, kind === 'contract' ? f.validation : f.findings);
    assert.equal(owner.contract, kind === 'contract' ? f.target : null);
    assert.equal(owner.area, kind === 'contract' ? 'access-contracts' : 'target-area');
    assert.equal(f.input.disabled, false);
    assert.equal(f.disabled.disabled, true);
    assert.equal(f.els.editorLoading.hidden, true);
    assert.equal(f.scope.editorTransition, null);
    assert.equal(f.errors.length, 0);
  });

  for (const phase of ['source', 'draft']) {
    test(`editor document session: failed ${kind} ${phase} returns false, reports once and releases the predecessor controls`, async () => {
      const f = fixture(), owner = f.owner, pending = edits.captureContractEdits(owner);
      const error = new Error(`Synthetic ${phase} failure`);
      if (phase === 'source') f.scope.api[kind === 'contract' ? 'contract' : 'deployment'] = async () => { throw error; };
      else f.scope.workspaceRegistry.getDraft = async () => { throw error; };
      assert.equal(await f.invoke(kind, { selection: { area: 'must-not-publish' } }), false);
      assert.equal(owner.current, f.predecessor.param);
      assert.equal(owner.contract, f.predecessor);
      assert.equal(owner.area, 'access-contracts');
      assert.deepEqual(edits.captureContractEdits(owner), pending);
      assert.equal(owner.documentGeneration, 41, 'Failure does not roll back the shared generation.');
      assert.deepEqual(f.errors, [error]);
      assert.equal(owner.status.message, error.message);
      assert.equal(owner.documentNotices.get(f.predecessor.param.path).message, error.message);
      assert.equal(f.input.isConnected, true);
      assert.equal(f.input.disabled, false);
      assert.equal(f.input.value, 'connected predecessor input');
      assert.equal(f.els.editorLoading.hidden, true);
      assert.equal(f.scope.editorTransition, null);
    });

    for (const boundary of ['document generation', 'workspace ticket', 'other workspace']) {
      for (const failure of [false, true]) {
        test(`editor document session: delayed ${kind} ${phase} ${failure ? 'error' : 'success'} cannot reclaim ${boundary}`, async (t) => {
          const f = fixture(), originalOwner = f.owner, entered = deferred(), ready = deferred(t);
          if (phase === 'source') {
            f.scope.api[kind === 'contract' ? 'contract' : 'deployment'] = async () => {
              entered.resolve(); await ready.promise; return kind === 'contract' ? f.target : f.target.param;
            };
          } else f.scope.workspaceRegistry.getDraft = async () => {
            entered.resolve(); await ready.promise;
            return { sourceHash: 'obsolete-hash', operations: [{ op: 'set', path: ['label'], value: 'obsolete durable draft' }] };
          };
          const loading = f.invoke(kind, { selection: { area: 'stale-selection' } });
          await entered.promise;
          const ticket = f.scope.viewStates.ticket(), generation = f.scope.documentGeneration;
          if (boundary === 'document generation') {
            f.scope.documentGeneration += 1;
            originalOwner.documentGeneration = f.scope.documentGeneration;
          } else if (boundary === 'workspace ticket') {
            f.scope.viewStates.leave(); f.activate(f.context);
          } else {
            f.activate({ environment: { id: 'successor-workspace' } });
            Object.assign(f.owner, { current: contract('successor').param, documentGeneration: 99 });
          }
          f.owner.operations = [{ op: 'set', path: ['label'], value: 'newer owner draft' }];
          edits.setParameterInput(f.owner, ['label'], { value: 'newer unblurred text', composing: true });
          f.scope.setStatus('Newer owner status', 'info');
          const current = f.owner.current, contractOwner = f.owner.contract;
          const pending = edits.captureContractEdits(f.owner), publications = f.statuses.length;
          if (boundary === 'document generation') assert.deepEqual(f.scope.viewStates.ticket(), ticket);
          else assert.equal(f.scope.documentGeneration, generation);
          if (failure) ready.reject(new Error('Retired load failed'));
          else ready.resolve();
          assert.equal(await loading, false);
          assert.equal(f.owner.current, current);
          assert.equal(f.owner.contract, contractOwner);
          assert.notEqual(f.owner.area, 'stale-selection');
          assert.deepEqual(edits.captureContractEdits(f.owner), pending);
          assert.equal(f.statuses.length, publications, 'Inactive error memory must not publish into the active status surface.');
          assert.equal(f.draftReads.length, phase === 'source' ? 0 : 1);
          assert.equal(f.errors.length, failure ? 1 : 0);
          assert.equal(f.renders.some((render) => render.document === f.target.param), false);
          assert.equal(f.input.disabled, false);
          assert.equal(f.els.editorLoading.hidden, true);
          if (failure) assert.equal(originalOwner.documentNotices.get(f.predecessor.param.path).message, 'Retired load failed');
        });
      }
    }
  }

  test(`editor document session: ${kind} keeps staging quarantine scoped to the target without replacing the owner's map`, async () => {
    const f = fixture(), owner = f.owner, map = owner.quarantinedDrafts;
    const targetSnapshot = { ...edits.captureContractEdits(owner), parameterPath: f.target.param.path };
    edits.retainQuarantinedDraft(owner, targetSnapshot, 'Target retained', f.target.param.path);
    edits.retainQuarantinedDraft(owner, edits.captureContractEdits(owner), 'Predecessor retained');
    const before = structuredClone(map);
    f.scope.workspaceRegistry.getDraft = async () => { assert.fail('Quarantined target must not reload its durable draft.'); };
    assert.equal(await f.invoke(kind), true);
    assert.deepEqual([...f.draftReads[0].owner.quarantinedDrafts.keys()], [f.target.param.path]);
    assert.equal(owner.quarantinedDrafts, map);
    assert.deepEqual(map, before);
    assert.equal(owner.quarantinedDraft, map.get(f.target.param.path)[0]);
    assert.equal(owner.operations.length, 0);
  });

  test(`editor document session: ${kind} refuses a concurrent or foreign transition before reading or capturing`, async (t) => {
    const f = fixture(), ready = deferred(t), entered = deferred();
    f.scope.api[kind === 'contract' ? 'contract' : 'deployment'] = async () => {
      entered.resolve(); await ready.promise; return kind === 'contract' ? f.target : f.target.param;
    };
    const loading = f.invoke(kind);
    await entered.promise;
    const generation = f.scope.documentGeneration;
    assert.equal(await f.invoke(kind), false);
    assert.equal(await f.invoke(kind, { transition: {} }), false);
    assert.equal(f.scope.documentGeneration, generation);
    assert.equal(f.events.filter((event) => event === 'blur').length, 1);
    assert.equal(f.input.disabled, true, 'Refused re-entry cannot release the original pause.');
    ready.resolve(); assert.equal(await loading, true);
    assert.equal(f.scope.editorTransition, null);
  });

  test(`editor document session: ${kind} preserves an incomplete browser number before any load capture`, async () => {
    const f = fixture(), owner = f.owner;
    f.input.type = 'number'; f.input.value = ''; f.input.validity = { badInput: true };
    edits.setParameterInput(owner, ['units'], { value: '', badInput: true, validationMessage: 'Enter a number.' });
    const pending = edits.captureContractEdits(owner), scope = owner.inputScope;
    assert.equal(await f.invoke(kind), false);
    assert.equal(owner.documentGeneration, 40);
    assert.equal(f.scope.documentGeneration, 40);
    assert.equal(owner.inputScope, scope);
    assert.deepEqual(edits.captureContractEdits(owner), pending);
    assert.equal(f.input.isConnected, true);
    assert.equal(f.input.disabled, false);
    assert.equal(f.input.validity.badInput, true);
    assert.equal(f.events.some((event) => event.endsWith('-read')), false);
    assert.match(owner.status.message, /Complete or discard the incomplete number/);
  });
}

for (const options of [{ parameters: false, policy: true }, { parameters: true, policy: false }]) {
  test(`editor document session: contract reload preserves only the requested editor drafts (${JSON.stringify(options)})`, async () => {
    const f = fixture();
    f.target = structuredClone(f.predecessor);
    f.owner.policyRaw = '<policies>memory-only raw draft</policies>';
    edits.setParameterInput(f.owner, ['label'], { value: 'unblurred draft', composing: true });
    const snapshot = edits.captureContractEdits(f.owner);
    assert.equal(await f.invoke('contract', { preserved: snapshot, preserveOptions: options }), true);
    assert.deepEqual(structuredClone(f.owner.operations), options.parameters ? snapshot.operations : []);
    assert.deepEqual(structuredClone(f.owner.parameterInputs), options.parameters ? snapshot.parameterInputs : {});
    assert.equal(f.owner.policyRaw, options.policy ? snapshot.policyRaw : null);
    assert.equal(f.owner.quarantinedDraft, null);
    assert.equal(f.owner.reviewEpoch, 3);
    assert.equal(f.events.includes('policy-preview'), false);
  });
}

test('editor document session: changed contract bytes quarantine queued, input and raw drafts independently of other documents', async () => {
  const f = fixture(), owner = f.owner;
  f.target = structuredClone(f.predecessor);
  f.target.param.hash = 'changed-parameters'; f.target.policy.hash = 'changed-policy';
  owner.policyRaw = '<policies>retained raw text</policies>';
  edits.setParameterInput(owner, ['label'], { value: 'newer composing input', composing: true });
  const snapshot = edits.captureContractEdits(owner), unrelated = { ...snapshot, parameterPath: 'synthetic/other.bicepparam' };
  edits.retainQuarantinedDraft(owner, unrelated, 'Other document', unrelated.parameterPath);
  const other = structuredClone(owner.quarantinedDrafts.get(unrelated.parameterPath));
  assert.equal(await f.invoke('contract', { preserved: snapshot }), true);
  const retained = owner.quarantinedDrafts.get(snapshot.parameterPath)[0];
  assert.deepEqual(retained.operations, snapshot.operations);
  assert.deepEqual(retained.parameterInputs, snapshot.parameterInputs);
  assert.equal(retained.policyRaw, snapshot.policyRaw);
  assert.deepEqual(owner.quarantinedDrafts.get(unrelated.parameterPath), other);
  assert.equal(owner.operations.length, 0);
  assert.equal(owner.policyRaw, null);
  snapshot.operations[0].value = 'changed after capture';
  assert.equal(retained.operations[0].value, 'queued predecessor');
});

for (const changed of ['head', 'dependencies', 'hash']) {
  test(`editor document session: native preserve distinguishes changed ${changed} from unchanged bindings`, async () => {
    const f = fixture(), owner = f.owner;
    const identity = { version: 1, configuration: 'synthetic-profile', unitId: 'synthetic-unit',
      valueAlias: owner.current.path, syntax: 'hcl-tfvars', hash: 'a'.repeat(64), head: 'a'.repeat(40),
      dependencies: [{ alias: 'synthetic/variables.tf', hash: 'b'.repeat(64) }] };
    Object.assign(owner.current, { format: 'terraform', nativeIdentity: identity });
    edits.setParameterInput(owner, ['ratio'], { value: '1.0e-', composing: false });
    const pending = edits.captureContractEdits(owner);
    f.target = structuredClone(f.predecessor);
    if (changed === 'hash') f.target.param.hash = 'new-source-hash';
    else if (changed === 'head') f.target.param.nativeIdentity.head = 'c'.repeat(40);
    else f.target.param.nativeIdentity.dependencies[0].hash = 'c'.repeat(64);
    assert.equal(await f.invoke('document', { preserve: true }), true);
    assert.equal(owner.tab, 'params');
    if (changed === 'head') {
      assert.deepEqual(structuredClone(owner.operations), pending.operations);
      assert.deepEqual(structuredClone(owner.parameterInputs), pending.parameterInputs);
      assert.equal(owner.quarantinedDraft, null);
    } else {
      assert.equal(owner.operations.length, 0);
      assert.deepEqual(owner.quarantinedDraft.operations, pending.operations);
      assert.equal(owner.quarantinedDraft.parameterInputs['["ratio"]'].value, '1.0e-');
    }
    assert.equal(f.predecessor.param.nativeIdentity, identity);
    assert.equal(identity.dependencies[0].hash, 'b'.repeat(64));
  });
}

for (const stale of [false, true]) {
  test(`editor document session: contract acceptance awaits guided preview${stale ? ' and retires publication when superseded' : ''}`, async (t) => {
    const f = fixture(), ready = deferred(t), entered = deferred();
    f.target = structuredClone(f.predecessor);
    f.owner.policyChanges = { variables: { jwtRequired: true } };
    const preserved = edits.captureContractEdits(f.owner);
    f.owner.documentViews.set(f.target.param.path, { open: [], tab: 'policy', scrollTop: 123, focus: 'label' });
    f.scope.refreshPolicyPreview = async () => { entered.resolve(); await ready.promise; };
    const loading = f.invoke('contract', { preserved });
    await entered.promise;
    assert.equal(f.owner.current, f.target.param);
    assert.equal(f.owner.policyChanges.variables.jwtRequired, true);
    assert.equal(f.frames.length, 0);
    assert.equal(f.renders.length, 0);
    assert.equal(f.input.disabled, true);
    if (stale) {
      f.scope.documentGeneration += 1;
      f.owner.documentGeneration = f.scope.documentGeneration;
    }
    ready.resolve();
    assert.equal(await loading, !stale);
    assert.equal(f.frames.length, stale ? 0 : 1);
    assert.equal(f.renders.length, stale ? 0 : 1);
    assert.equal(f.input.disabled, false);
  });
}

for (const completion of ['success', 'error', 'stale success', 'stale error', 'other-owner error']) {
  test(`editor document session: optional suggestions finish after accepted rendering with ${completion}`, async (t) => {
    const f = fixture(), owner = f.owner, ready = deferred(t), entered = deferred();
    owner.onboardedModels = [];
    f.scope.api.onboardedModels = async () => { f.events.push('models-read'); entered.resolve(); await ready.promise; return { models: [{ name: 'suggested' }] }; };
    f.scope.api.policyVariables = async () => ({ variables: ['variable'], throttles: ['throttle'], semanticCache: {}, contentSafety: {} });
    let settled = false;
    const loading = f.invoke('contract').then((result) => { settled = true; return result; });
    await entered.promise;
    assert.equal(owner.current, f.target.param);
    assert.equal(f.renders.length, 1);
    assert.equal(f.events.indexOf('render') < f.events.indexOf('models-read'), true);
    assert.equal(settled, false, 'Rendering does not turn the optional refresh into detached work.');
    assert.equal(f.input.disabled, true);
    if (completion.startsWith('stale')) {
      f.scope.documentGeneration += 1; owner.documentGeneration = f.scope.documentGeneration;
      owner.onboardedModels = [{ name: 'newer same-owner suggestions' }];
    }
    if (completion === 'other-owner error') {
      f.activate({ environment: { id: 'successor' } });
      f.owner.onboardedModels = [{ name: 'successor suggestions' }];
    }
    if (completion.endsWith('error')) ready.reject(new Error('Optional suggestion read failed'));
    else ready.resolve();
    assert.equal(await loading, true, 'The document was already accepted before suggestion completion.');
    assert.equal(f.input.disabled, false);
    assert.equal(f.errors.length, 0, 'Keep the existing optional-suggestion fallback; do not change status policy here.');
    if (completion === 'success') {
      assert.equal(owner.onboardedModels[0].name, 'suggested');
      assert.deepEqual(owner.policyVariables, ['variable']);
      assert.deepEqual(owner.throttleSpecs, ['throttle']);
      assert.equal(f.renders.length, 2);
    } else {
      assert.equal(f.renders.length, 1);
      if (completion === 'stale success') assert.equal(owner.onboardedModels[0].name, 'newer same-owner suggestions');
      else assert.deepEqual(structuredClone(owner.onboardedModels), []);
      if (completion === 'other-owner error') assert.equal(f.owner.onboardedModels[0].name, 'successor suggestions');
    }
  });
}

for (const retirement of ['none', 'generation', 'ticket', 'disabled', 'hidden']) {
  test(`editor document session: remembered frame honors ${retirement} and the real focus adapter`, async () => {
    const f = fixture(), remembered = { open: new Map([['retained-section', true]]), tab: 'policy', scrollTop: 123, focus: 'label' };
    f.owner.documentViews.set(f.target.param.path, remembered);
    assert.equal(await f.invoke('contract'), true);
    assert.equal(f.frames.length, 1);
    assert.notEqual(f.owner.open, remembered.open);
    assert.deepEqual([...f.owner.open], [...remembered.open]);
    assert.equal(f.owner.tab, 'policy');
    assert.equal(document.activeElement, f.els.workspace, 'An unremembered document opens at its workspace heading.');
    document.activeElement = f.dom.root;
    f.els.workspace.scrollTop = 17;
    f.input.setSelectionRange(3, 9, 'backward');
    if (retirement === 'generation') f.scope.documentGeneration += 1;
    if (retirement === 'ticket') { f.scope.viewStates.leave(); f.activate(f.context); }
    if (retirement === 'disabled') f.input.disabled = true;
    if (retirement === 'hidden') f.input.hidden = true;
    f.frames[0]();
    assert.equal(f.els.workspace.scrollTop, ['generation', 'ticket'].includes(retirement) ? 17 : 123);
    assert.equal(document.activeElement, retirement === 'none' ? f.input : f.dom.root);
    assert.equal(f.input.isConnected, true);
    assert.equal(f.input.selectionStart, 3); assert.equal(f.input.selectionEnd, 9);
    assert.equal(f.input.selectionDirection, 'backward');
    if (retirement === 'none') assert.equal(f.input.focusOptions.preventScroll, true);
  });
}

test('editor document session: an accepted-publication exception propagates unchanged and still releases the load pause', async () => {
  const f = fixture(), error = new Error('Synthetic validation adapter failure');
  f.scope.validateDocument = () => { throw error; };
  await assert.rejects(f.invoke('contract'), (actual) => actual === error);
  assert.equal(f.owner.current, f.target.param, 'Do not invent transactional rollback for the existing publication sequence.');
  assert.equal(f.owner.contract, f.target);
  assert.equal(f.input.disabled, false);
  assert.equal(f.disabled.disabled, true);
  assert.equal(f.els.editorLoading.hidden, true);
  assert.equal(f.scope.editorTransition, null);
});
