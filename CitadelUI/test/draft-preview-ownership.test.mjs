import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { installDom } from './_dom-stub.mjs';
import { h, mount } from '../web/js/dom.mjs';
import { pauseEditorForLoad } from '../web/js/editor-load.mjs';
import { renderPolicy } from '../web/js/policyview.mjs';
import { setRawPolicyDraft } from '../web/js/policy-edit-state.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';
import * as edits from '../web/js/contract-edit-state.mjs';
import { configurationOf } from '../shared/workspace-configuration.mjs';
import { applyPolicyChanges, readPolicyControls, POLICY_VARIABLES } from '../shared/policy.mjs';

const source = (await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first >= 0 && last > first, start);
  return source.slice(first, last);
}
const handlers = [
  section('function createEditorState()', 'const viewStates ='),
  section('function draftContainsSecureValue(', 'function pushOperation('),
  section('function hasPolicyEdits(', '/* Pending edits live only in memory'),
  section('async function loadContract(', 'let policyPreviewToken ='),
  section('function pruneEmptyChanges(', 'async function savePolicy()'),
  section('function quarantineNotice()', '/**\n * Repaint the workspace.'),
  section('async function withEditorLoad(', 'let wired = false'),
  section('async function activateWorkspaceView(', '/**\n * Never leave the sheet empty.'),
  section('async function returnToSetup()', '// Nothing starts'),
].join('\n');
const xml = '<policies>\r\n  <inbound><base /><set-variable name="jwtRequired" value="false" /></inbound>\r\n</policies>';
const raw = '<policies><inbound><set-variable name="test-only-raw" value="retained-in-memory" /></inbound></policies>';
const operations = [{ op: 'set', path: ['label'], value: 'plain-draft' },
  { op: 'set', path: ['secureValue'], value: 'synthetic-secure-draft' }];
const clone = (value) => structuredClone(value);
const text = (node) => node ? `${node.textContent || ''}${node.children.map(text).join('')}` : '';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function workspace(id = 'one', profileId = 'bicep-one') {
  return { projectId: 'synthetic-project', environment: {
    id, source: { kind: 'local', folderName: 'synthetic' },
    configuration: { version: 1, revision: 1, format: 'bicep', profileId, units: [] },
  } };
}
function contract(id) {
  const dir = `bicep/infra/citadel-access-contracts/contracts/${id}`;
  return { id, name: id, param: {
    path: `${dir}/main.bicepparam`, hash: `parameter-${id}`, text: "param label = 'saved'\n",
    params: [{ name: 'label', value: 'saved' }, { name: 'secureValue', value: 'saved' }],
    schema: { parameters: { label: { secure: false }, secureValue: { secure: true } } },
  }, policy: { path: `${dir}/ai-product-policy.xml`, hash: `policy-${id}`, text: xml, controls: readPolicyControls(xml) } };
}

function fixture() {
  const dom = installDom(), contracts = new Map(['A', 'B'].map((id) => [id, contract(id)]));
  let active = workspace(), previewHook = null;
  const durable = new Map(), writes = [], statuses = [], previews = [];
  const els = { shell: { dataset: { workspace: 'active' } }, workspace: dom.node('main'),
    sidebar: dom.node('nav'), contextRail: dom.node('aside'), tbActions: dom.node('header'), editorLoading: dom.node() };
  dom.root.append(els.workspace, els.sidebar, els.contextRail, els.tbActions, els.editorLoading);
  const scope = { structuredClone, Map, h, mount, pauseEditorForLoad, ...edits, setRawPolicyDraft, renderPolicy,
    configurationOf, document: globalThis.document, els, pendingByDocument: new Map(),
    editorTransition: null, documentGeneration: 0, policyPreviewToken: 0,
    activeWorkspace: () => active, environmentSourceOf: (environment) => environment.source,
    clearActiveWorkspace() {}, setSetupContext() {}, updateHeaderContext() {}, renderActions() {},
    requestAnimationFrame() {}, writeContextNode() {}, reportClientError(error) { throw error; },
    renderStartupRecovery(error) { throw error; }, init: async () => {}, choiceDialog: async () => 'preserve',
    validateDocument: () => [], documentFindings: () => [], viewOf: (doc) => doc,
    decoratePolicy: (node) => node, sheetStrip: () => h('header'), renderParamDocument: () => h('div'), editContext: () => ({}),
    workspaceRegistry: {
      listProjects: async () => [{ id: active.projectId, label: 'Synthetic' }],
      getDraft: async (id, path) => clone(durable.get(`${id}:${path}`) || null),
      removeDraft: async (id, path) => { durable.delete(`${id}:${path}`); },
      saveDraft: async (id, path, sourceHash, changes) => {
        const draft = clone({ sourceHash, operations: changes });
        writes.push(draft); durable.set(`${id}:${path}`, draft);
      },
    },
    api: {
      resetWorkspace() {}, health: async () => ({ ok: true }), focus: async () => ({ areas: [] }),
      deployments: async () => ({ files: [...contracts.values()].map(({ param }) => ({ path: param.path })) }),
      history: async () => ({ transactions: [] }), accessContractTargets: async () => ({}),
      contract: async (id) => clone(contracts.get(id)),
      deployment: async (path) => clone([...contracts.values()].find((item) => item.param.path === path).param),
      previewPolicy: async (path, changes, hash, context) => {
        const policy = [...contracts.values()].find((item) => item.policy.path === path).policy;
        assert.equal(hash, policy.hash);
        const after = applyPolicyChanges(policy.text, changes);
        const result = { after, controls: readPolicyControls(after) };
        const call = { path, changes: clone(changes), hash, context, result };
        previews.push(call);
        return previewHook ? previewHook(call) : result;
      },
    },
  };
  scope.setStatus = (message, tone) => {
    scope.state.status = message ? { message, tone } : null;
    if (message) statuses.push({ message, tone });
  };
  scope.withStatus = async (_label, action) => {
    try { return await action(); } catch (error) { scope.setStatus(error.message, 'error'); return undefined; }
  };
  vm.runInNewContext(handlers, scope);
  scope.viewStates = new WorkspaceViewState(scope.createEditorState);
  const seed = (state) => {
    if (!state.current) {
      const first = clone(contracts.get('A'));
      Object.assign(state, { current: first.param, contract: first, contractId: 'A', tab: 'policy',
        policyVariables: POLICY_VARIABLES, onboardedModels: [{ name: 'ready' }] });
    }
  };
  scope.state = scope.viewStates.activate(active); seed(scope.state);
  scope.render = () => {
    if (els.shell.dataset.workspace === 'active' && scope.state.contract) scope.renderContractsArea({});
    scope.editorTransition?.pause.refresh();
  };
  scope.render();
  return {
    scope, contracts, durable, writes, statuses, previews, els,
    get state() { return scope.state; },
    set preview(hook) { previewHook = hook; },
    async reopen(next = active) {
      await scope.returnToSetup();
      active = next; scope.state = scope.viewStates.activate(active); seed(scope.state);
      await scope.activateWorkspaceView(active);
    },
    jwt: () => els.workspace.querySelectorAll('.pol-field')
      .find((node) => text(node.querySelector('.toggle-label')) === 'Require a JWT')?.querySelector('input'),
    raw: () => els.workspace.querySelector('textarea')?.value,
  };
}

test('draft ownership: unchanged-source catalog roundtrips retain mixed secure, plain and raw edits only in memory', async () => {
  const f = fixture();
  f.state.operations = clone(operations); f.state.policyRaw = raw; f.state.policyMode = 'raw';
  await f.scope.persistParameterDraft();
  for (let index = 0; index < 3; index++) {
    await f.reopen();
    assert.deepEqual(clone(f.state.operations), operations);
    assert.equal(f.state.policyRaw, raw); assert.equal(f.raw(), raw);
    assert.equal(f.state.quarantinedDraft, null);
  }
  assert.equal(f.writes.length, 0); assert.equal(f.durable.size, 0);
  assert.equal(f.contracts.get('A').policy.text, xml);
});

for (const mode of ['raw', 'guided']) for (const changed of ['parameter', 'policy', 'both']) {
  test(`draft ownership: ${mode} and secure drafts survive ${changed} quarantine and repeated reopen`, async () => {
    const f = fixture(), changes = { variables: { jwtRequired: true } };
    f.state.operations = clone(operations); f.state.policyMode = mode;
    if (mode === 'raw') f.state.policyRaw = raw;
    else f.state.policyChanges = clone(changes);
    if (changed !== 'policy') f.contracts.get('A').param.hash = 'external-parameter';
    if (changed !== 'parameter') f.contracts.get('A').policy.hash = 'external-policy';
    await f.reopen();
    const original = clone(f.state.quarantinedDraft);
    assert.deepEqual(original.operations, operations);
    assert.equal(original.policyRaw, mode === 'raw' ? raw : null);
    assert.deepEqual(original.policyChanges, mode === 'guided' ? changes : {});
    for (let index = 0; index < 3; index++) {
      await f.reopen();
      assert.deepEqual(clone(f.state.quarantinedDraft), original);
      assert.equal(f.state.quarantinedDrafts.get(f.state.current.path).length, 1);
      assert.deepEqual(clone(f.state.operations), changed === 'policy' ? operations : []);
      assert.equal(f.state.policyRaw, changed === 'parameter' && mode === 'raw' ? raw : null);
      assert.match(text(f.els.workspace), /Discard retained draft/);
    }
    assert.equal(f.writes.length, 0); assert.equal(f.durable.size, 0);
    assert.equal(f.scope.canPersistAllPending(), false);
  });
}

test('draft ownership: independent documents and workspace configurations do not replace or resurrect discarded quarantine', async () => {
  const f = fixture(), firstWorkspace = workspace();
  f.state.policyRaw = raw; f.contracts.get('A').policy.hash = 'external-A';
  await f.reopen();
  const owner = f.state, pathA = f.state.current.path;
  await f.scope.selectContract('B');
  f.state.policyRaw = raw.replace('test-only-raw', 'draft-B');
  f.contracts.get('B').policy.hash = 'external-B';
  await f.reopen();
  const pathB = f.state.current.path;
  assert.equal(f.state.quarantinedDrafts.size, 2);
  await f.scope.selectContract('A');
  const discard = f.els.workspace.querySelectorAll('button').find((node) => text(node) === 'Discard retained draft');
  await discard.listeners.get('click')[0]();
  assert.equal(f.state.quarantinedDrafts.has(pathA), false);
  assert.equal(f.state.quarantinedDrafts.has(pathB), true);
  await f.scope.selectContract('B'); await f.scope.selectContract('A');
  assert.equal(f.state.quarantinedDraft, null, 'An unrelated stashed document must not resurrect the discarded draft.');
  const pendingB = clone(f.state.quarantinedDrafts.get(pathB));
  for (const next of [workspace('two'), workspace('one', 'bicep-two')]) {
    await f.reopen(next);
    assert.notEqual(f.state, owner); assert.equal(f.state.quarantinedDrafts.size, 0);
    assert.throws(() => edits.restoreContractEdits(f.state, edits.captureContractEdits(owner)), /another workspace configuration/);
    f.state.policyRaw = raw.replace('test-only-raw', `other-${next.environment.configuration.profileId}`);
    await f.scope.stashCurrentPending();
    assert.equal(owner.quarantinedDrafts.get(pathB)[0].policyRaw, pendingB[0].policyRaw);
  }
  await f.reopen(firstWorkspace);
  assert.equal(f.state, owner); assert.equal(f.state.quarantinedDrafts.has(pathA), false);
  await f.scope.selectContract('B');
  assert.deepEqual(clone(f.state.quarantinedDrafts.get(pathB)), pendingB);
});

test('draft ownership: reverted source does not automatically reapply a quarantined durable parameter draft', async () => {
  const f = fixture(), path = f.state.current.path, hash = f.state.current.hash;
  f.state.operations = [clone(operations[0])]; await f.scope.persistParameterDraft();
  f.contracts.get('A').param.hash = 'external';
  await f.reopen();
  assert.equal(f.state.operations.length, 0); assert(f.state.quarantinedDraft);
  f.contracts.get('A').param.hash = hash;
  await f.reopen(); await f.reopen();
  assert.equal(f.state.operations.length, 0); assert(f.state.quarantinedDraft);
  assert.equal(f.durable.get(`one:${path}`).operations[0].value, 'plain-draft');
});

for (const completion of ['success', 'error']) for (const destination of ['document', 'reloaded-policy', 'workspace']) {
  test(`policy preview ownership: delayed ${completion} cannot publish after changing ${destination}`, async () => {
    const f = fixture(), pending = deferred();
    f.preview = () => pending.promise;
    f.state.policyChanges = { variables: { jwtRequired: true } };
    const request = f.scope.refreshPolicyPreview();
    if (destination === 'document') await f.scope.selectContract('B');
    if (destination === 'reloaded-policy') {
      f.contracts.get('A').policy.hash = 'new-policy';
      await f.scope.loadContract('A', edits.captureContractEdits(f.state));
    }
    if (destination === 'workspace') await f.reopen(workspace('two'));
    const before = clone(f.state.status), rendered = text(f.els.workspace);
    if (completion === 'success') pending.resolve({ after: '<policies>obsolete-A</policies>', controls: {} });
    else pending.reject(new Error('obsolete-A-error'));
    await request;
    assert.equal(f.state.policyPreview, null); assert.equal(f.state.policyPreviewError, null);
    assert.deepEqual(clone(f.state.status), before); assert.equal(text(f.els.workspace), rendered);
    assert.equal(f.jwt()?.checked, false);
  });
}

test('policy preview ownership: a same-hash reload and raw transition retire an older edit revision', async () => {
  const f = fixture(), pending = deferred();
  f.preview = (call) => f.previews.length === 1 ? pending.promise : call.result;
  f.state.policyChanges = { variables: { jwtRequired: true } };
  const request = f.scope.refreshPolicyPreview();
  await f.scope.loadContract('A', edits.captureContractEdits(f.state));
  assert.equal(f.jwt().checked, true);
  f.scope.policyContext().setPolicyMode('raw'); await tick();
  const projection = f.state.policyPreview;
  assert.match(f.raw(), /name="jwtRequired" value="true"/);
  pending.resolve({ after: xml, controls: readPolicyControls(xml) }); await request;
  assert.equal(f.state.policyPreview, projection);
  assert.match(f.raw(), /name="jwtRequired" value="true"/);
});

test('policy preview ownership: raw typing invalidates both late completion paths without replacing the textarea', async () => {
  for (const fail of [false, true]) {
    const f = fixture(), pending = deferred();
    f.state.policyMode = 'raw'; f.state.policyChanges = { variables: { jwtRequired: true } };
    f.preview = () => pending.promise;
    const request = f.scope.refreshPolicyPreview();
    const before = f.state.policyRevision;
    f.scope.policyContext().onPolicyRaw(raw);
    assert.equal(f.state.policyRevision, before + 1);
    if (fail) pending.reject(new Error('retired'));
    else pending.resolve({ after: xml, controls: readPolicyControls(xml) });
    await request; f.scope.render();
    const textarea = f.els.workspace.querySelector('textarea');
    f.scope.policyContext().onPolicyRaw(`${raw}\n`);
    assert.equal(f.els.workspace.querySelector('textarea'), textarea);
    assert.equal(f.state.policyRaw, `${raw}\n`); assert.equal(f.state.policyPreview, null);
    assert.equal(f.state.policyPreviewError, null);
  }
});

test('policy preview ownership: retained Require a JWT controls, raw projection and review agree after catalog reopen', async () => {
  const f = fixture();
  assert.equal(f.jwt().checked, false);
  f.scope.foldPolicyChange({ control: 'variable', key: 'jwtRequired', value: true });
  await tick(); assert.equal(f.jwt().checked, true);
  for (let index = 0; index < 3; index++) {
    await f.reopen();
    assert.equal(f.state.policyChanges.variables.jwtRequired, true);
    assert.equal(f.jwt().checked, true);
    assert.match(f.raw(), /name="jwtRequired" value="true"/);
    assert.equal(f.state.policyPreview.text, applyPolicyChanges(f.state.contract.policy.text, f.state.policyChanges));
    assert(edits.ownsPolicyPreview(f.state, f.state.policyPreview.identity));
  }
  assert.equal(f.writes.length, 0); assert.equal(f.contracts.get('A').policy.text, xml);
});

test('policy preview ownership: failed document navigation restores and recomputes the predecessor guided draft', async () => {
  const f = fixture();
  f.scope.foldPolicyChange({ control: 'variable', key: 'jwtRequired', value: true }); await tick();
  f.scope.api.contract = async () => { throw new Error('synthetic load failure'); };
  assert.equal(await f.scope.selectContract('B'), false);
  await tick();
  assert.equal(f.state.contractId, 'A'); assert.equal(f.state.policyChanges.variables.jwtRequired, true);
  assert.equal(f.jwt().checked, true); assert.match(f.raw(), /name="jwtRequired" value="true"/);
  assert.equal(f.scope.editorTransition, null);
});

test('policy preview ownership: parameter-save reload keeps guided controls and raw projection on the owned policy draft', async () => {
  const f = fixture();
  f.state.operations = clone(operations);
  f.scope.foldPolicyChange({ control: 'variable', key: 'jwtRequired', value: true }); await tick();
  const saved = edits.captureContractEdits(f.state);
  f.contracts.get('A').param.hash = 'committed-parameter';
  await f.scope.loadContract('A', saved, { parameters: false, policy: true });
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.state.policyChanges.variables.jwtRequired, true);
  assert.equal(f.jwt().checked, true); assert.match(f.raw(), /name="jwtRequired" value="true"/);
  assert.equal(f.state.quarantinedDraft, null);
});
