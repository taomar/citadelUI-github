import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDialogModule, readText } from './_dom-stub.mjs';

const nativeTurn = () => new Promise((resolve) => setImmediate(resolve));

async function queuedDialog(t) {
  const dialog = await loadDialogModule();
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  // HTMLDialogElement.close() changes `open` now and queues its event as a task.
  dialog.modal.close = () => {
    if (!dialog.modal.open) return;
    dialog.modal.open = false;
    setImmediate(() => dialog.modal.dispatch('close'));
  };
  const flushFrames = () => {
    for (const callback of frames.splice(0)) callback();
  };
  const background = dialog.node('main');
  const opener = dialog.node('button');
  background.append(opener);
  dialog.root.append(background);
  opener.focus();
  t.after(async () => {
    dialog.closeDialog();
    await nativeTurn();
    flushFrames();
  });
  return { ...dialog, background, opener, flushFrames };
}

test('queued close: immediate reopening keeps the successor content and focus', async (t) => {
  const { showDialog, dismissDialog, modal, node, background, flushFrames } = await queuedDialog(t);
  showDialog('Import source', node(), [node('button')]);
  flushFrames();
  dismissDialog(false);
  await Promise.resolve();
  const next = node('button');
  showDialog('Source choices', node(), [next]);
  await nativeTurn();
  flushFrames();
  assert.equal(modal.open, true);
  assert.match(readText(modal), /Source choices/);
  assert.equal(background.inert, true);
  assert.equal(document.activeElement, next);
});

test('queued close: rapid close/reopen cycles do not let retired focus work run', async (t) => {
  const { showDialog, closeDialog, modal, node, flushFrames } = await queuedDialog(t);
  const retired = [];
  for (let index = 0; index < 3; index++) {
    const field = node('input');
    retired.push(field);
    showDialog(`Retired ${index}`, field, [], { initialFocus: field });
    closeDialog();
  }
  const current = node('input');
  showDialog('Current', current, [], { initialFocus: current });
  await nativeTurn();
  flushFrames();
  assert.match(readText(modal), /Current/);
  assert.equal(document.activeElement, current);
  assert(retired.every((field) => !field.focused), 'retired frame callbacks must not attempt to take focus');
});

test('queued close: true dismissal cleans the host and restores the original opener', async (t) => {
  const { showDialog, dismissDialog, modal, node, background, opener, flushFrames } = await queuedDialog(t);
  const answers = [];
  showDialog('Plain dialog', node(), [node('button')], { onDismiss: (value) => answers.push(value) });
  flushFrames();
  assert.equal(dismissDialog('finished'), true);
  await nativeTurn();
  flushFrames();
  assert.deepEqual(answers, ['finished']);
  assert.equal(modal.open, false);
  assert.equal(modal.children.length, 0);
  assert.equal(background.inert, false);
  assert.equal(document.activeElement, opener);
});

test('queued close: programmatic completion does not become a cancellation callback', async (t) => {
  const { showDialog, closeDialog, modal, node, background, opener, flushFrames } = await queuedDialog(t);
  let cancellations = 0;
  showDialog('Completing', node(), [], { onDismiss: () => { cancellations++; } });
  closeDialog();
  await nativeTurn();
  flushFrames();
  assert.equal(cancellations, 0);
  assert.equal(modal.open, false);
  assert.equal(modal.children.length, 0);
  assert.equal(background.inert, false);
  assert.equal(document.activeElement, opener);
});

test('queued close: Escape resumes nested Settings/help and native cancel dismisses the root', async (t) => {
  const { showDialog, modal, node, background, opener, flushFrames } = await queuedDialog(t);
  const settings = node();
  const field = node('input');
  field.value = 'Unfinished Settings value';
  const help = node('button');
  settings.append(field, help);
  showDialog('Settings', settings, [], { initialFocus: field });
  flushFrames();
  help.focus();
  showDialog('Help', node(), [node('button')], { stack: true });
  flushFrames();
  modal.dispatch('keydown', { key: 'Escape' });
  await nativeTurn();
  flushFrames();
  assert.equal(modal.open, true);
  assert.match(readText(modal), /Settings/);
  assert.equal(field.value, 'Unfinished Settings value');
  assert.equal(document.activeElement, help);
  assert.equal(background.inert, true);
  const cancel = modal.dispatch('cancel');
  assert.equal(cancel.defaultPrevented, true);
  await nativeTurn();
  flushFrames();
  assert.equal(modal.open, false);
  assert.equal(modal.children.length, 0);
  assert.equal(background.inert, false);
  assert.equal(document.activeElement, opener);
});

test('queued close: a retired nested-frame restoration cannot focus reused successor content', async (t) => {
  const { showDialog, dismissDialog, node, flushFrames } = await queuedDialog(t);
  const body = node();
  const previousOpener = node('button');
  body.append(previousOpener);
  showDialog('Settings', body);
  flushFrames();
  previousOpener.focus();
  showDialog('Help', node(), [node('button')], { stack: true });
  dismissDialog();
  const successor = node('input');
  body.append(successor);
  showDialog('Next step', body, [], { initialFocus: successor });
  previousOpener.focused = false;
  await nativeTurn();
  flushFrames();
  assert.equal(document.activeElement, successor);
  assert.equal(previousOpener.focused, false);
});

test('queued close: a browser focus callback may reopen without losing the new root opener', async (t) => {
  const { showDialog, dismissDialog, modal, node, opener, flushFrames } = await queuedDialog(t);
  showDialog('First', node(), [node('button')]);
  flushFrames();
  let reopened = false;
  const next = node('button');
  opener.addEventListener('focus', () => {
    if (reopened) return;
    reopened = true;
    showDialog('Opened by focus', node(), [next]);
  });
  const nativeClose = modal.close;
  modal.close = () => {
    nativeClose();
    opener.focus();
  };
  dismissDialog(false);
  await nativeTurn();
  flushFrames();
  assert.match(readText(modal), /Opened by focus/);
  assert.equal(document.activeElement, next);
  // Suppress the emulated browser restoration for the second close: the
  // dialog manager must still retain its own correct restoration target.
  modal.close = nativeClose;
  dismissDialog(false);
  await nativeTurn();
  flushFrames();
  assert.equal(document.activeElement, opener);
});

test('queued close: a synchronous dismissal callback may replace the current frame', async (t) => {
  const { showDialog, dismissDialog, modal, node, flushFrames } = await queuedDialog(t);
  const answers = [];
  const next = node('button');
  showDialog('First', node(), [], {
    onDismiss: (value) => {
      answers.push(value);
      showDialog('Callback successor', node(), [next]);
    },
  });
  dismissDialog(true);
  await nativeTurn();
  flushFrames();
  assert.deepEqual(answers, [true]);
  assert.equal(modal.open, true);
  assert.match(readText(modal), /Callback successor/);
  assert.equal(document.activeElement, next);
});
