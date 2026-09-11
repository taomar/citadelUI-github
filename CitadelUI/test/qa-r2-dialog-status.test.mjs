import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDialogModule, readText } from './_dom-stub.mjs';

test('R2-05 failed action feedback is inside the owning live region with its original context and retry control', async () => {
  const dom = await loadDialogModule();
  const body = dom.node('section');
  body.textContent = 'Writing to synthetic workspace / policy.xml';
  const save = dom.node('button');
  save.textContent = 'Save policy';
  dom.showDialog('Review policy changes', body, [save]);
  const announce = dom.captureDialogStatus();
  assert.equal(announce('Synthetic write failed. The draft is retained.', 'error'), true);
  const notice = dom.modal.querySelector('.modal-status');
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.getAttribute('aria-live'), 'polite');
  assert.equal(notice.hidden, false);
  assert.match(readText(dom.modal), /Writing to synthetic workspace/);
  assert.match(readText(notice), /write failed/);
  assert.equal(save.isConnected, true);
  assert.equal(save.disabled, false);
  announce('Retrying the reviewed write.');
  assert.match(readText(notice), /Retrying/);
  announce(null);
  assert.equal(notice.hidden, true);
  dom.closeDialog();
});

test('R2-05 an old asynchronous reporter cannot announce in a replacement or closed modal', async () => {
  const dom = await loadDialogModule();
  dom.showDialog('First review', dom.node());
  const announce = dom.captureDialogStatus();
  dom.showDialog('Another task', dom.node());
  assert.equal(announce('Old write failed', 'error'), false);
  assert.equal(dom.modal.querySelector('.modal-status').hidden, true);
  assert.doesNotMatch(readText(dom.modal), /Old write/);
  dom.closeDialog();
  assert.equal(announce('Still old', 'error'), false);
});

test('R2-05 a stacked confirmation keeps feedback with the original review and preserves inertness', async () => {
  const dom = await loadDialogModule();
  const background = dom.node('main');
  dom.root.append(background);
  dom.showDialog('First review', dom.node());
  const announce = dom.captureDialogStatus();
  dom.showDialog('Confirm another decision', dom.node(), [], { stack: true });
  announce('Original action failed', 'error');
  assert.doesNotMatch(readText(dom.modal), /Original action/);
  assert.equal(background.inert, true);
  dom.dismissDialog();
  assert.match(readText(dom.modal), /Original action failed/);
  assert.equal(dom.modal.querySelector('.modal-status').hidden, false);
  assert.equal(background.inert, true);
  dom.closeDialog();
  assert.equal(background.inert, false);
});
