import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createDocumentActions } from '../web/js/document-action.mjs';
import { WorkspaceViewState } from '../web/js/workspace-view-state.mjs';

function fixture() {
  const views = new WorkspaceViewState(() => ({
    current: { path: 'synthetic/main.bicepparam', hash: 'same-hash' },
    contract: { policy: { path: 'synthetic/policy.xml', hash: 'same-policy-hash' } },
    documentGeneration: 7, policyRevision: 3, reviewEpoch: 2,
    documentNotices: new Map(), status: null,
  }));
  const context = { environment: { id: 'document-actions' } }, publications = [];
  let owner = views.activate(context);
  const actions = createDocumentActions({
    views, currentOwner: () => owner,
    setStatus(message, tone) {
      publications.push({ owner, message, tone });
      owner.status = { message, tone };
    },
  });
  return { views, context, actions, publications,
    get owner() { return owner; },
    activate(next = context) { owner = views.activate(next); return owner; },
    replaceOwner(next) { owner = next; },
  };
}

test('document actions: capture retains the existing owner, document, contract, generation and workspace ticket', () => {
  const f = fixture(), { owner } = f, notices = owner.documentNotices;
  const action = f.actions.captureDocumentAction();
  assert.deepEqual(Object.keys(action), ['owner', 'document', 'contract', 'generation', 'ticket']);
  assert.equal(action.owner, owner);
  assert.equal(action.document, owner.current);
  assert.equal(action.contract, owner.contract);
  assert.equal(action.generation, 7);
  assert.deepEqual(action.ticket, f.views.ticket());
  assert.equal(f.actions.ownsDocumentAction(action), true);
  assert.equal(owner.documentNotices, notices);
  assert.equal(f.views.views.size, 1);
  assert.equal(f.views.generation, action.ticket.generation);
  assert.equal(owner.documentGeneration, 7);
});

for (const boundary of ['document generation', 'same-hash document', 'same-hash contract', 'workspace ticket', 'other workspace', 'owner']) {
  test(`document actions: ${boundary} retires a captured action without merging independent identities`, () => {
    const f = fixture(), { owner } = f, action = f.actions.captureDocumentAction();
    if (boundary === 'document generation') owner.documentGeneration += 1;
    if (boundary === 'same-hash document') owner.current = { ...owner.current };
    if (boundary === 'same-hash contract') owner.contract = { ...owner.contract };
    if (boundary === 'workspace ticket') { f.views.leave(); f.activate(); }
    if (boundary === 'other workspace') f.activate({ environment: { id: 'successor' } });
    if (boundary === 'owner') f.replaceOwner({ ...owner });
    assert.equal(f.actions.ownsDocumentAction(action), false);
    assert.equal(owner.policyRevision, 3);
    assert.equal(owner.reviewEpoch, 2);
    assert.equal(owner.documentGeneration, boundary === 'document generation' ? 8 : 7);
    if (!['workspace ticket', 'other workspace'].includes(boundary)) assert.deepEqual(f.views.ticket(), action.ticket);
    assert.equal(f.publications.length, 0);
  });
}

test('document actions: policy revision and review epoch do not replace document ownership', () => {
  const f = fixture(), action = f.actions.captureDocumentAction();
  f.owner.policyRevision += 1;
  assert.equal(f.actions.ownsDocumentAction(action), true);
  f.owner.reviewEpoch += 1;
  assert.equal(f.actions.ownsDocumentAction(action), true);
  assert.equal(f.owner.documentGeneration, action.generation);
  assert.deepEqual(f.views.ticket(), action.ticket);
});

test('document actions: inactive-owner notice memory is separate from active status publication', () => {
  const f = fixture(), { owner } = f, action = f.actions.captureDocumentAction(), notices = owner.documentNotices;
  const successor = f.activate({ environment: { id: 'successor' } });
  const activeStatus = successor.status = { message: 'Successor status', tone: 'info' };
  assert.equal(f.actions.retainDocumentNotice(action, 'Confirmed old save', 'warn', true), undefined);
  assert.equal(f.publications.length, 0);
  assert.equal(successor.status, activeStatus);
  assert.deepEqual(owner.status, { message: 'Confirmed old save', tone: 'warn', outcome: true });
  assert.equal(owner.documentNotices, notices);
  assert.equal(notices.get(action.document.path), owner.status);
  assert.equal(successor.documentNotices.size, 0);
  f.activate();
  f.actions.restoreDocumentNotice();
  assert.deepEqual(owner.status, { message: 'Confirmed old save', tone: 'warn' });
  assert.equal(notices.size, 0);
  assert.deepEqual(f.publications, [{ owner, message: 'Confirmed old save', tone: 'warn' }]);
});

test('document actions: leave and reactivate retains memory feedback without reviving its old ticket', () => {
  const f = fixture(), action = f.actions.captureDocumentAction();
  f.views.leave(); f.activate();
  f.actions.retainDocumentNotice(action, 'Retained after reactivation', 'error');
  assert.equal(f.actions.ownsDocumentAction(action), false);
  assert.equal(f.publications.length, 0);
  assert.deepEqual(f.owner.status, { message: 'Retained after reactivation', tone: 'error', outcome: false });
  assert.equal(f.owner.documentNotices.get(action.document.path), f.owner.status);
});

test('document actions: a stale document generation retains its notice without replacing newer owner status', () => {
  const f = fixture(), action = f.actions.captureDocumentAction();
  f.owner.documentGeneration += 1;
  const status = f.owner.status = { message: 'New document generation', tone: 'info' };
  f.actions.retainDocumentNotice(action, 'Old read failed', 'error');
  assert.equal(f.owner.status, status);
  assert.equal(f.publications.length, 0);
  assert.deepEqual(f.owner.documentNotices.get(action.document.path),
    { message: 'Old read failed', tone: 'error', outcome: false });
});

test('document actions: a reload error cannot erase a confirmed outcome notice or consume another document notice', () => {
  const f = fixture(), action = f.actions.captureDocumentAction(), notices = f.owner.documentNotices;
  const unrelated = { message: 'Other document', tone: 'info', outcome: false };
  notices.set('synthetic/other.bicepparam', unrelated);
  f.actions.retainDocumentNotice(action, 'Saved with receipt warning', 'warn', true);
  const confirmed = notices.get(action.document.path);
  f.actions.retainDocumentNotice(action, 'Reload failed', 'error');
  assert.equal(notices.get(action.document.path), confirmed);
  assert.equal(f.owner.status.message, 'Reload failed', 'The active error still has its own immediate feedback.');
  assert.equal(f.actions.restoreDocumentNotice(), undefined);
  assert.deepEqual(f.owner.status, { message: 'Saved with receipt warning', tone: 'warn' });
  assert.equal(notices.has(action.document.path), false);
  assert.equal(notices.get('synthetic/other.bicepparam'), unrelated);
  f.actions.restoreDocumentNotice();
  assert.equal(f.publications.length, 3, 'Restoring twice must not replay consumed feedback.');
});

test('document actions: later confirmed outcomes replace retained outcomes while ordinary notices replace only ordinary notices', () => {
  const f = fixture(), action = f.actions.captureDocumentAction();
  f.actions.retainDocumentNotice(action, 'First error', 'error');
  f.actions.retainDocumentNotice(action, 'Second error', 'error');
  assert.equal(f.owner.documentNotices.get(action.document.path).message, 'Second error');
  f.actions.retainDocumentNotice(action, 'Confirmed unchanged', 'info', true);
  f.actions.retainDocumentNotice(action, 'Confirmed applied', 'ok', true);
  assert.deepEqual(f.owner.documentNotices.get(action.document.path),
    { message: 'Confirmed applied', tone: 'ok', outcome: true });
});

test('document actions: explicit owner capture and policy-path fallback preserve the original notice shape', () => {
  const f = fixture(), predecessor = f.owner;
  predecessor.current = null;
  const policyPath = predecessor.contract.policy.path;
  f.activate({ environment: { id: 'successor' } });
  const action = f.actions.captureDocumentAction(predecessor);
  assert.equal(action.owner, predecessor);
  assert.deepEqual(action.ticket, f.views.ticket(), 'Capture still uses the supplied WorkspaceViewState ticket.');
  f.actions.retainDocumentNotice(action, 'Policy-only notice', 'warn');
  assert.deepEqual(predecessor.documentNotices.get(policyPath),
    { message: 'Policy-only notice', tone: 'warn', outcome: false });
  f.activate();
  f.actions.restoreDocumentNotice();
  assert.equal(predecessor.documentNotices.has(policyPath), true, 'Restore still selects the current document path only.');
  assert.equal(f.publications.length, 0);
  predecessor.current = { path: policyPath };
  f.actions.restoreDocumentNotice();
  assert.equal(predecessor.documentNotices.size, 0);
  assert.equal(f.publications.length, 1);
});

test('document actions: a pathless owner receives active feedback without allocating another notice store', () => {
  const f = fixture();
  f.owner.current = null; f.owner.contract = null; delete f.owner.documentNotices;
  f.actions.retainDocumentNotice(f.actions.captureDocumentAction(), 'Opening workspace failed', 'error');
  assert.equal(f.owner.documentNotices, undefined);
  assert.deepEqual(f.owner.status, { message: 'Opening workspace failed', tone: 'error' });
  assert.equal(f.publications.length, 1);
});

test('document actions: app facade preserves defaults, argument forwarding and return values', async () => {
  const source = await readFile(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function captureDocumentAction(');
  const end = source.indexOf('/* -------------------------------------------------------------- operations */', start);
  assert(start >= 0 && end > start);
  const f = fixture(), scope = { state: f.owner, documentActions: f.actions };
  vm.runInNewContext(source.slice(start, end), scope);
  const action = scope.captureDocumentAction();
  assert.equal(action.owner, f.owner);
  assert.equal(scope.ownsDocumentAction(action), true);
  assert.equal(scope.retainDocumentNotice(action, 'Facade notice', 'warn'), undefined);
  assert.equal(f.owner.documentNotices.get(action.document.path).outcome, false);
  assert.equal(scope.restoreDocumentNotice(), undefined);
  assert.equal(f.owner.status.message, 'Facade notice');
});
