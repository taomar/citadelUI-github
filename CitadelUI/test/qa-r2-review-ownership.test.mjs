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
  const dom = await loadDialogModule(), calls = [], statuses = [];
  let context = { environment: { id: 'r2-review', source: { kind: 'local', folderName: 'synthetic' } } };
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
  scope.state = scope.viewStates.activate(context);
  const select = (name) => {
    const state = scope.state;
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
  scope.setStatus = (message, tone) => {
    scope.state.status = message ? { message, tone } : null;
    statuses.push(scope.state.status);
  };
  const press = async (text) => {
    const button = dom.modal.querySelectorAll('button').find((node) => readText(node) === text);
    assert(button, text);
    for (const listener of button.listeners.get('click') || []) await listener({ currentTarget: button, target: button });
  };
  const editPolicy = () => {
    const state = scope.state;
    state.policyChanges = { variables: { audience: 'newer-draft' } };
    edits.invalidatePolicyPreview(state);
  };
  const parameterReview = () => ({
    owner: scope.state, document: scope.state.current, context, operations: structuredClone(scope.state.operations),
    ticket: scope.viewStates.ticket(), epoch: scope.state.reviewEpoch, scope: scope.captureDocumentAction(),
  });
  return { dom, scope, calls, statuses, select, press, editPolicy, parameterReview,
    get state() { return scope.state; }, get context() { return context; },
    activate(next) { context = next; scope.state = scope.viewStates.activate(next); },
  };
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
    let submitted;
    f.scope.api.previewPolicyPayload = (payload, context) => {
      submitted = payload;
      assert.equal(context, f.context);
      return hold.promise;
    };
    const pending = f.scope.savePolicy();
    const captured = structuredClone(submitted);
    if (raw) { f.state.policyRaw = '<newer />'; edits.invalidatePolicyPreview(f.state); }
    else {
      f.state.policyChanges.variables.audience = 'newer-draft';
      edits.invalidatePolicyPreview(f.state);
    }
    assert.deepEqual(structuredClone(submitted), captured, 'The reviewed payload was copied before preview began, not at Save click.');
    assert.equal(submitted.path, 'Alpha.xml');
    assert.equal(submitted.expectedHash, 'Alpha-policy-hash');
    if (raw) assert.equal(submitted.text, '<old />');
    else assert.equal(submitted.changes.variables.audience, 'Alpha-draft');
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

for (const policy of [false, true]) for (const failure of [false, true]) {
  test(`R2-A2 late durable ${policy ? 'policy' : 'parameter'} ${failure ? 'error' : 'outcome'} stays with Alpha and leaves Beta intact`, async () => {
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
    if (failure) hold.reject(new Error('Alpha durable save failed'));
    else hold.resolve(applied);
    await saving;
    assert.equal(f.state.status, status);
    assert.equal(f.state.operations, operations);
    assert.equal(f.state.policyChanges, policyChanges);
    assert.match(readText(f.dom.modal), /Beta dialog/);
    const expected = failure ? /Alpha durable save failed/ : /Saved/;
    assert.match(f.state.documentNotices.get('Alpha.bicepparam').message, expected);
    assert.equal(f.calls.some(([kind]) => kind.startsWith('reload') || kind === 'remove-draft'), false);
    f.select('Alpha');
    f.scope.restoreDocumentNotice();
    assert.match(f.state.status.message, expected);
    f.dom.closeDialog();
  });
}

function changeOwnership(f, boundary) {
  const owner = f.state, document = owner.current, contract = owner.contract;
  const generation = owner.documentGeneration, revision = owner.policyRevision, epoch = owner.reviewEpoch;
  const ticket = f.scope.viewStates.ticket();
  if (boundary === 'document generation') owner.documentGeneration += 1;
  else if (boundary === 'same-hash reopen') {
    owner.current = { ...document };
    owner.contract = { ...contract, policy: { ...contract.policy } };
    owner.documentGeneration += 1;
  } else if (boundary === 'workspace ticket') {
    f.scope.viewStates.leave();
    f.activate(f.context);
  } else if (boundary === 'other workspace') {
    f.activate({ environment: { ...f.context.environment, id: 'r2-successor' } });
    f.select('Beta');
  } else if (boundary === 'policy revision') edits.invalidatePolicyPreview(owner);
  else if (boundary === 'review epoch') owner.reviewEpoch += 1;
  else assert.fail(`Unknown ownership boundary: ${boundary}`);

  if (boundary !== 'other workspace') {
    assert.equal(f.state, owner);
    assert.equal(owner.current.hash, document.hash);
    assert.equal(owner.contract.policy.hash, contract.policy.hash);
    assert.equal(owner.documentGeneration, generation + (['document generation', 'same-hash reopen'].includes(boundary) ? 1 : 0));
    assert.equal(owner.policyRevision, revision + (boundary === 'policy revision' ? 1 : 0));
    assert.equal(owner.reviewEpoch, epoch + (boundary === 'review epoch' ? 1 : 0));
    if (boundary !== 'same-hash reopen') {
      assert.equal(owner.current, document);
      assert.equal(owner.contract, contract);
    }
    if (boundary !== 'workspace ticket') assert.deepEqual(f.scope.viewStates.ticket(), ticket);
    else {
      assert.equal(f.scope.viewStates.ticket().key, ticket.key);
      assert(f.scope.viewStates.ticket().generation > ticket.generation);
    }
  }
}

for (const boundary of ['document generation', 'same-hash reopen', 'workspace ticket', 'other workspace', 'policy revision', 'review epoch']) {
  for (const failure of [false, true]) {
    test(`C1 UI: delayed policy review ${failure ? 'error' : 'success'} observes separate ${boundary}`, async () => {
      const f = await fixture(), hold = deferred(), owner = f.state;
      let payload;
      f.scope.api.previewPolicyPayload = (reviewed) => { payload = reviewed; return hold.promise; };
      const pending = f.scope.savePolicy(), captured = structuredClone(payload);
      changeOwnership(f, boundary);
      const draft = edits.captureContractEdits(f.state), current = f.state.current;
      f.scope.setStatus('Successor edit status', 'info');
      const status = f.state.status, publications = f.statuses.length;
      if (failure) hold.reject(new Error('Captured policy preview failed'));
      else hold.resolve(preview);
      await pending;
      assert.deepEqual(structuredClone(payload), captured);
      assert.equal(f.state.current, current);
      assert.deepEqual(edits.captureContractEdits(f.state), draft);
      assert.equal(f.dom.modal.open, false);
      assert.equal(f.calls.some(([kind]) => kind === 'save-policy'), false);
      if (['policy revision', 'review epoch'].includes(boundary)) {
        assert.match(f.state.status.message, failure ? /Captured policy preview failed/ : /draft changed while previewing/);
        assert.equal(f.state.status.tone, failure ? 'error' : 'info');
      } else if (boundary === 'workspace ticket' && failure) {
        assert.equal(f.statuses.length, publications, 'An old ticket cannot publish status into the active view.');
        assert.equal(f.statuses.at(-1), status);
        assert.equal(f.state.status, owner.documentNotices.get('Alpha.bicepparam'), 'The reused owner still retains its document notice in memory.');
      } else assert.equal(f.state.status, status);
      if (failure) assert.match(owner.documentNotices.get('Alpha.bicepparam').message, /Captured policy preview failed/);
    });
  }
}

for (const policy of [false, true]) {
  for (const boundary of ['document generation', 'same-hash reopen', 'workspace ticket', 'other workspace']) {
    for (const failure of [false, true]) {
      test(`C1 UI: delayed ${policy ? 'policy' : 'parameter'} save ${failure ? 'error' : 'success'} cannot reclaim ${boundary}`, async () => {
        const f = await fixture(), hold = deferred(), entered = deferred(), owner = f.state;
        const kind = policy ? 'save-policy' : 'save-parameters';
        f.scope.api[policy ? 'savePolicy' : 'save'] = (...args) => {
          f.calls.push([kind, ...args]);
          entered.resolve();
          return hold.promise;
        };
        if (policy) await f.scope.savePolicy();
        const saving = policy ? f.press('Save policy') : f.scope.commitSave(f.parameterReview());
        await entered.promise;
        changeOwnership(f, boundary);
        const current = f.state.current, draft = edits.captureContractEdits(f.state);
        f.scope.setStatus('Successor document status', 'info');
        const status = f.state.status, publications = f.statuses.length;
        f.dom.showDialog('Successor dialog', h('p', {}, 'Successor context'));
        const frame = f.dom.modal.querySelector('.modal-status');
        if (failure) hold.reject(new Error('Original save failed'));
        else hold.resolve(applied);
        await saving;
        assert.equal(f.state.current, current);
        if (boundary === 'workspace ticket') {
          assert.equal(f.statuses.length, publications);
          assert.equal(f.statuses.at(-1), status);
          assert.equal(f.state.status, owner.documentNotices.get('Alpha.bicepparam'));
        } else assert.equal(f.state.status, status);
        assert.deepEqual(edits.captureContractEdits(f.state), draft);
        assert.equal(f.dom.modal.querySelector('.modal-status'), frame);
        assert.equal(frame.hidden, true);
        assert.match(readText(f.dom.modal), /Successor dialog/);
        assert.equal(f.calls.filter(([type]) => type === kind).length, 1);
        assert.equal(f.calls.some(([type]) => type.startsWith('reload') || type === 'remove-draft'), false);
        assert.match(owner.documentNotices.get('Alpha.bicepparam').message, failure ? /Original save failed/ : /Saved/);
      });
    }
  }
}

for (const policy of [false, true]) {
  test(`C1 UI: durable ${policy ? 'policy' : 'parameter'} save quarantines newer queued, unblurred and raw drafts together`, async () => {
    const f = await fixture(), entered = deferred(), hold = deferred();
    const kind = policy ? 'save-policy' : 'save-parameters';
    f.scope.api[policy ? 'savePolicy' : 'save'] = (...args) => {
      f.calls.push([kind, structuredClone(args.slice(0, -1))]);
      entered.resolve();
      return hold.promise;
    };
    if (policy) await f.scope.savePolicy();
    const saving = policy ? f.press('Save policy') : f.scope.commitSave(f.parameterReview());
    await entered.promise;
    f.state.operations = [{ op: 'set', path: ['label'], value: 'new queued value' }];
    edits.setParameterInput(f.state, ['label'], { value: 'new unblurred value' });
    f.state.policyRaw = '<policies><!-- newer raw draft --></policies>';
    f.state.policyChanges = {};
    edits.invalidatePolicyPreview(f.state);
    const newer = edits.captureContractEdits(f.state);
    hold.resolve(applied);
    await saving;
    const submitted = f.calls.find(([type]) => type === kind)[1];
    if (policy) assert.equal(submitted[0].changes.variables.audience, 'Alpha-draft');
    else assert.equal(submitted[1][0].value, 'Alpha-draft');
    const retained = f.state.quarantinedDrafts.get('Alpha.bicepparam');
    assert.equal(retained.length, 1);
    assert.deepEqual(retained[0].operations, newer.operations);
    assert.deepEqual(retained[0].parameterInputs, newer.parameterInputs);
    assert.equal(retained[0].policyRaw, newer.policyRaw);
    assert.equal(edits.editorPendingCount(f.state), 2);
    assert.equal(f.calls.some(([type]) => type === 'remove-draft'), false);
    assert.equal(f.calls.filter(([type]) => type === kind).length, 1);
  });

  test(`C1 UI: review epoch invalidates ${policy ? 'policy' : 'parameter'} approval before mutation without changing document generation`, async () => {
    const f = await fixture(), review = f.parameterReview(), generation = f.state.documentGeneration;
    if (policy) await f.scope.savePolicy();
    const revision = f.state.policyRevision, before = edits.captureContractEdits(f.state);
    f.state.reviewEpoch += 1;
    if (policy) await f.press('Save policy');
    else await f.scope.commitSave(review);
    assert.equal(f.state.documentGeneration, generation);
    assert.equal(f.state.policyRevision, revision);
    assert.deepEqual(edits.captureContractEdits(f.state), before);
    assert.equal(f.calls.some(([kind]) => kind.startsWith('save-')), false);
    assert.match(f.state.status.message, /Review|review/);
  });

  test(`C1 UI: a successor dialog frame does not cancel the same-document durable ${policy ? 'policy' : 'parameter'} save`, async () => {
    const f = await fixture(), hold = deferred(), entered = deferred();
    const action = f.scope.captureDocumentAction(), kind = policy ? 'save-policy' : 'save-parameters';
    f.scope.api[policy ? 'savePolicy' : 'save'] = () => { f.calls.push([kind]); entered.resolve(); return hold.promise; };
    if (policy) await f.scope.savePolicy();
    else f.dom.showDialog('Parameter approval', h('p', {}, 'Reviewed source'));
    const saving = policy ? f.press('Save policy') : f.scope.commitSave(f.parameterReview());
    await entered.promise;
    f.dom.showDialog('Same-document successor', h('p', {}, 'Do not close this frame'));
    const frame = f.dom.modal.querySelector('.modal-status'), revision = f.state.policyRevision;
    assert.equal(f.scope.ownsDocumentAction(action), true);
    hold.resolve(applied);
    await saving;
    assert.equal(f.dom.modal.open, true);
    assert.equal(f.dom.modal.querySelector('.modal-status'), frame);
    assert.equal(frame.hidden, true);
    assert.match(readText(f.dom.modal), /Same-document successor/);
    assert.equal(f.calls.filter(([type]) => type === kind).length, 1);
    assert.equal(f.calls.filter(([type]) => type === 'reload-contract').length, 1);
    assert.match(f.state.status.message, /Saved/);
    assert.equal(f.state.documentGeneration, action.generation);
    assert.equal(f.state.policyRevision, revision + (policy ? 1 : 0));
  });
}

test('C1 UI: a policy revision alone does not invalidate an unchanged parameter approval', async () => {
  const f = await fixture(), review = f.parameterReview(), ticket = f.scope.viewStates.ticket();
  f.editPolicy();
  const newerPolicy = structuredClone(f.state.policyChanges), revision = f.state.policyRevision;
  await f.scope.commitSave(review);
  assert.equal(f.calls.filter(([kind]) => kind === 'save-parameters').length, 1);
  assert.equal(f.state.operations.length, 0);
  assert.deepEqual(f.state.policyChanges, newerPolicy);
  assert.equal(f.state.policyRevision, revision);
  assert.equal(f.state.reviewEpoch, review.epoch);
  assert.equal(f.state.documentGeneration, review.scope.generation);
  assert.deepEqual(f.scope.viewStates.ticket(), ticket);
  assert.equal(f.state.quarantinedDrafts.size, 0);
});

test('C1 UI: new unblurred input after parameter review blocks saving the older queued payload', async () => {
  const f = await fixture(), review = f.parameterReview();
  f.dom.showDialog('Parameter approval', h('p', {}, 'Reviewed Alpha'));
  edits.setParameterInput(f.state, ['label'], { value: 'typed after approval', composing: true });
  const snapshot = edits.captureContractEdits(f.state);
  await f.scope.commitSave(review);
  assert.equal(f.calls.some(([kind]) => kind === 'save-parameters'), false);
  assert.deepEqual(edits.captureContractEdits(f.state), snapshot);
  assert.equal(f.state.operations[0].value, 'Alpha-draft');
  assert.equal(f.state.parameterInputs['["label"]'].value, 'typed after approval');
  assert.equal(f.state.parameterInputs['["label"]'].composing, true);
  assert.match(f.state.status.message, /draft changed after preview/);
  assert.equal(f.calls.some(([kind]) => kind === 'remove-draft'), false);
});

test('C1 UI: new raw policy text after approval cannot be substituted into the reviewed save', async () => {
  const f = await fixture();
  f.state.policyRaw = '<policies><!-- reviewed --></policies>';
  f.state.policyChanges = {};
  await f.scope.savePolicy();
  f.state.policyRaw = '<policies><!-- typed after approval --></policies>';
  edits.invalidatePolicyPreview(f.state);
  const snapshot = edits.captureContractEdits(f.state);
  await f.press('Save policy');
  assert.equal(f.calls.some(([kind]) => kind === 'save-policy'), false);
  assert.deepEqual(edits.captureContractEdits(f.state), snapshot);
  assert.match(readText(f.dom.modal.querySelector('.modal-status')), /Review this policy again/);
  assert.equal(f.dom.modal.open, true);
});
