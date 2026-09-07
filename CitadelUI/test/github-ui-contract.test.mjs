/**
 * The History panel, the compare/copy target binding, and the narrow layout.
 *
 * These three defects share a cause: browser state that was read again after an
 * await, or read from the wrong source shape. The reconciliation and the guard
 * are pure modules precisely so they can be exercised here without a DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { historyEntry } from '../web/js/history-entry.mjs';
import { createCompareSession } from '../web/js/compare-session.mjs';
import { loadDialogModule } from './_dom-stub.mjs';

const app = readFileSync(new URL('../web/js/app.mjs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/css/components.css', import.meta.url), 'utf8');

/* --------------------------------------------------------------- history */

test('a GitHub update renders its timestamp and offers Undo by commit', () => {
  const entry = historyEntry({
    transactionId: '2b0d0f6e-1111-4222-8333-444455556666',
    id: 'a'.repeat(40),
    commit: 'a'.repeat(40),
    parent: 'b'.repeat(40),
    status: 'committed',
    targetLabel: 'parameter-edit',
    aliases: ['bicep/infra/main.bicepparam'],
    files: [{ alias: 'bicep/infra/main.bicepparam' }],
    committedAt: '2026-02-01T00:00:00Z',
    completedAt: '2026-02-01T00:00:00Z',
    canUndo: true,
  });
  assert.equal(entry.status, 'committed');
  assert.deepEqual(entry.aliases, ['bicep/infra/main.bicepparam']);
  assert.equal(entry.timestamp, '2026-02-01T00:00:00Z');
  // An edit is not a creation, so the label and the post-undo behaviour differ.
  assert.equal(entry.isCreation, false);
  assert.equal(entry.canUndo, true);
  // The revert endpoint takes a commit; the audit UUID is not a commit SHA.
  assert.equal(entry.id, 'a'.repeat(40));
});

test('a GitHub deletion is undoable and is not mistaken for a creation', () => {
  const entry = historyEntry({
    transactionId: '2b0d0f6e-1111-4222-8333-444455556666',
    commit: 'c'.repeat(40),
    status: 'committed',
    targetLabel: 'history-restore',
    aliases: ['bicep/infra/removable.bicepparam'],
    files: [{ alias: 'bicep/infra/removable.bicepparam' }],
    committedAt: '2026-02-02T00:00:00Z',
    canUndo: true,
  });
  assert.equal(entry.canUndo, true);
  assert.equal(entry.isCreation, false);
  assert.equal(entry.timestamp, '2026-02-02T00:00:00Z');
});

test('a GitHub contract creation is labelled as one', () => {
  const entry = historyEntry({
    commit: 'd'.repeat(40),
    status: 'committed',
    targetLabel: 'contract-create',
    aliases: ['a.bicepparam', 'a.bicep'],
    files: [{ alias: 'a.bicepparam' }, { alias: 'a.bicep' }],
    committedAt: '2026-02-03T00:00:00Z',
    canUndo: true,
  });
  assert.equal(entry.isCreation, true);
  assert.equal(entry.canUndo, true);
  assert.deepEqual(entry.aliases, ['a.bicepparam', 'a.bicep']);
});

test('a GitHub merge commit states that it cannot be undone', () => {
  const entry = historyEntry({
    commit: 'e'.repeat(40),
    status: 'committed',
    targetLabel: 'parameter-edit',
    files: [{ alias: 'bicep/infra/main.bicepparam' }],
    committedAt: '2026-02-04T00:00:00Z',
    canUndo: false,
  });
  assert.equal(entry.canUndo, false);
});

test('local journal rows keep their existing eligibility rules', () => {
  // An edit of an existing file restores prior bytes.
  const edit = historyEntry({
    transactionId: 'local-1',
    status: 'committed',
    timestamp: '2026-01-01T00:00:00Z',
    files: [{ alias: 'bicep/infra/main.bicepparam', existed: true }],
  });
  assert.equal(edit.canUndo, true);
  assert.equal(edit.isCreation, false);
  assert.equal(edit.id, 'local-1');
  assert.equal(edit.timestamp, '2026-01-01T00:00:00Z');

  // A contract creation is undone by removing what it created.
  const created = historyEntry({
    transactionId: 'local-2',
    status: 'committed',
    targetLabel: 'contract-create',
    files: [{ alias: 'a.bicepparam', existed: false }, { alias: 'a.bicep', existed: false }],
  });
  assert.equal(created.canUndo, true);
  assert.equal(created.isCreation, true);

  // An interrupted transaction is recovered, not undone.
  const interrupted = historyEntry({
    transactionId: 'local-3',
    status: 'committing',
    files: [{ alias: 'bicep/infra/main.bicepparam', existed: true }],
  });
  assert.equal(interrupted.canUndo, false);

  // New files written by something other than a contract creation stay
  // ineligible, exactly as before.
  const unlabelled = historyEntry({
    transactionId: 'local-4',
    status: 'committed',
    files: [{ alias: 'x.bicepparam', existed: false }],
  });
  assert.equal(unlabelled.canUndo, false);
});

test('the History panel consumes the normalized entry, not raw file bookkeeping', () => {
  const panel = app.slice(app.indexOf('async function openHistory'), app.indexOf('async function openEnvironmentCompare'));
  assert.match(panel, /const entry = historyEntry\(transaction\)/);
  assert.match(panel, /entry\.canUndo/);
  assert.match(panel, /api\.restoreTransaction\(entry\.id\)/);
  // Reading `existed` here is what hid Undo on every GitHub commit.
  assert.doesNotMatch(panel, /\.existed/);
});

/* ---------------------------------------------------------------- compare */

test('a reviewed copy keeps the target it was reviewed against', () => {
  const session = createCompareSession();
  const reviewed = session.review('env-a');
  assert.equal(reviewed.targetId, 'env-a');
  // The user changes the selector to B while the preview loads. A second review
  // is refused, and the bound target is unchanged, so the confirmation can only
  // write to A.
  assert.equal(session.review('env-b'), null);
  assert.equal(session.reviewed.targetId, 'env-a');
  assert.equal(session.locked, true);

  session.release();
  assert.equal(session.locked, false);
  assert.equal(session.review('env-b').targetId, 'env-b');
});

test('a compare response for a superseded target is discarded', () => {
  const session = createCompareSession();
  const first = session.begin('env-a');
  const second = session.begin('env-b');
  // A slow response for A arrives after the user moved to B.
  assert.equal(session.isStale(first), true);
  assert.equal(session.isStale(second), false);

  // Returning to A supersedes B in turn.
  const third = session.begin('env-a');
  assert.equal(session.isStale(second), true);
  assert.equal(session.isStale(third), false);
});

test('beginning a review supersedes any compare still in flight', () => {
  const session = createCompareSession();
  const pending = session.begin('env-a');
  session.review('env-a');
  assert.equal(session.isStale(pending), true);
});

test('the compare flow binds one target across preview, confirm and copy', () => {
  const flow = app.slice(
    app.indexOf('async function openEnvironmentCompare'),
    app.indexOf('async function chooseSourceKind')
  );
  assert.match(flow, /const bound = session\.review\(select\.value\)/);
  assert.match(flow, /api\.previewCopy\(\s*targetId/);
  assert.match(flow, /api\.copyParameters\(\s*targetId/);
  assert.match(flow, /api\.compareEnvironment\(targetId/);
  assert.match(flow, /select\.disabled = true/);
  assert.match(flow, /session\.isStale\(token\)/);
  // Re-reading the selector after an await is the defect itself.
  assert.doesNotMatch(flow, /previewCopy\(select\.value/);
  assert.doesNotMatch(flow, /copyParameters\(\s*select\.value/);
});

/* ------------------------------------------------------- new project source */

test('a new project offers both sources for its first environment', () => {
  const flow = app.slice(app.indexOf("'Creating project\\u2026'"), app.indexOf("}, 'New project')"));
  assert.match(flow, /chooseSourceKind\(/);
  assert.match(flow, /attachGitHubProject\(\{ projectLabel: label, environmentLabel \}\)/);
  // The folder picker is still the local path, but no longer the only path.
  assert.match(flow, /if \(kind === 'github'\)/);
  assert.ok(flow.indexOf("kind === 'github'") < flow.indexOf('showDirectoryPicker'));
});

test('the GitHub project picker is the same panel the settings page uses', () => {
  const helper = app.slice(app.indexOf('function attachGitHubProject'), app.indexOf('async function openWorkspaceSettingsContent'));
  assert.match(helper, /createGitHubPanel\(/);
  assert.match(helper, /attachGitHubEnvironment\(\{/);
  assert.match(helper, /projectLabel,/);
  assert.match(helper, /repositoryId: selection\.repositoryId/);
  assert.match(helper, /sourceBranch: selection\.sourceBranch/);
  // A failed attachment leaves the picker open rather than closing on error.
  assert.match(helper, /operation-error/);
});

/* --------------------------------------------------- new project cancellation */

test('a dialog refuses dismissal while the work it started is in flight', async () => {
  const { showDialog, dismissDialog, modal, node } = await loadDialogModule();
  let dismissed = null;
  let attaching = true;
  showDialog('Repository for Citadel', node(), [], {
    onDismiss: (value) => {
      dismissed = value;
    },
    preventDismiss: () => attaching,
  });
  assert.equal(modal.open, true);

  // Cancel, Escape and the backdrop all funnel through `dismissDialog`.
  assert.equal(dismissDialog(false), false);
  assert.equal(dismissed, null, 'a refused dismissal must not report itself as cancelled');
  modal.dispatch('keydown', { key: 'Escape' });
  assert.equal(dismissed, null, 'Escape must not cancel an operation in flight');
  modal.dispatch('cancel');
  assert.equal(dismissed, null, 'the browser cancel event must not either');
  modal.dispatch('click', { target: modal, clientX: 500, clientY: 500 });
  assert.equal(dismissed, null, 'the backdrop must not either');
  assert.equal(modal.open, true, 'the dialog stays open while it refuses');

  // Once the work reaches a terminal state the dialog answers normally.
  attaching = false;
  assert.equal(dismissDialog(false), true);
  assert.equal(dismissed, false);
  assert.equal(modal.open, false);
});

test('a dialog with no guard dismisses as it always did', async () => {
  const { showDialog, dismissDialog, node } = await loadDialogModule();
  let dismissed = null;
  showDialog('Plain', node(), [], {
    onDismiss: (value) => {
      dismissed = value;
    },
  });
  assert.equal(dismissDialog('closed'), true);
  assert.equal(dismissed, 'closed');
});

test('the new-project attach dialog cannot answer false once attaching', () => {
  const helper = app.slice(
    app.indexOf('function attachGitHubProject'),
    app.indexOf('async function openWorkspaceSettingsContent')
  );
  // A `false` answer tells the caller nothing was created. While an attachment
  // is in flight that is not knowable, so the dialog refuses instead.
  assert.match(helper, /preventDismiss: refuseWhileAttaching/);
  assert.match(helper, /const refuseWhileAttaching = \(\) => \{\s*\n\s*if \(!attaching\) return false;/);
  // Cancel is disabled *and* guarded, and the flag is set before the await.
  assert.match(helper, /attaching = true;\s*\n\s*cancelButton\.disabled = true;/);
  assert.ok(
    helper.indexOf('attaching = true;') < helper.indexOf('await attachGitHubEnvironment'),
    'the guard must be set before the attachment starts'
  );
  // Both exits clear it, so the dialog can never be stuck refusing.
  assert.match(helper, /let attaching = false;/);
  assert.equal(
    (helper.match(/^\s+attaching = false;$/gm) || []).length,
    2,
    'the guard must be cleared on both the success and the failure path'
  );
  assert.match(helper, /if \(refuseWhileAttaching\(\)\) return;\s*\n\s*finish\(false\)/);
});

/* ------------------------------------------------------------ narrow layout */


test('the setup datasheet stacks and un-indents at the narrow breakpoint', () => {
  const narrow = styles.slice(styles.indexOf('@media (max-width: 48rem)'));
  const block = narrow.slice(0, narrow.indexOf('@media', 1));
  // A label and a repository name cannot share a row at 320px.
  assert.match(block, /\.workspace-setup label,\s*\n\s*\.setup-actions \{\s*\n\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(block, /\.setup-actions > \* \{\s*\n\s*grid-column: 1;/);
  // The control-column indent is what pushed the second source option out of
  // the sheet, which clips instead of scrolling.
  assert.match(block, /\.setup-source-choice \{[^}]*margin-left: 0;/s);
  assert.match(block, /\.setup-source-choice \{[^}]*grid-template-columns: 1fr 1fr;/s);
  // The token field and its two fixed-width actions cannot share a row either.
  assert.match(block, /\.setup-inline \{\s*\n\s*flex-wrap: wrap;/);
  assert.match(block, /\.setup-inline \.ctl \{\s*\n\s*flex: 1 0 100%;/);
});

test('the token dialog contains its own overflow instead of clipping prose', () => {
  // A three-column spec with nowrap cells used to widen the whole dialog body,
  // which then clipped the numbered steps beside it.
  assert.match(styles, /\.setup-help-spec-scroller \{[^}]*overflow-x: auto;/s);
  assert.match(styles, /\.setup-help-spec-scroller:focus-visible/);
  assert.match(styles, /\.setup-help-body \{[^}]*grid-template-columns: minmax\(0, 1fr\);/s);
  assert.match(styles, /\.setup-help-method \{[^}]*min-width: 0;/s);
  // The scroller is a real focusable region, so it is reachable by keyboard.
  const setup = readFileSync(new URL('../web/js/github-setup.mjs', import.meta.url), 'utf8');
  assert.match(setup, /class: 'setup-help-spec-scroller', tabindex: '0'/);
});

test('a hidden source panel never narrates the visible one', () => {
  const context = readFileSync(new URL('../web/js/workspace-context.mjs', import.meta.url), 'utf8');
  const catalog = readFileSync(new URL('../web/js/workspace-catalog.mjs', import.meta.url), 'utf8');
  // The original defect: two source panels rendered at once, one hidden, with
  // the hidden one's status line routed into the shared page description — so
  // the local source was described in terms of an access token.
  //
  // v4 removes the condition rather than handling it. The landing screen has no
  // source toggle and no hidden panel: it is a catalogue, and choosing a source
  // happens inside a stepper that renders exactly one step at a time. So the
  // assertions are structural — the panels are gone, and the step function is
  // selected by name rather than by hiding its siblings.
  assert.doesNotMatch(context, /setup-source-github/);
  assert.doesNotMatch(context, /githubWrapper|localPanel/);
  assert.doesNotMatch(context, /onMessage: \(text\) => \{\s*\n\s*message\.textContent = text/);
  assert.match(catalog, /\}\)\[state\.step\]\(\);/);
  // One source is chosen, and the flow branches on it rather than showing both.
  assert.match(catalog, /if \(state\.kind === 'local'\) return \['source', 'details', 'review'\];/);
});

test('the wide setup layout keeps its two-column datasheet', () => {
  const wide = styles.slice(0, styles.indexOf('@media (max-width: 48rem)'));
  assert.match(wide, /\.workspace-setup label \{[^}]*grid-template-columns: minmax\(8rem, 10rem\) minmax\(0, 1fr\);/s);
  assert.match(wide, /\.setup-source-choice \{[^}]*margin-left: calc\(10rem \+ var\(--sp-5\)\);/s);
});
