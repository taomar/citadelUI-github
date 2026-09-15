import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDialogModule, readText } from './_dom-stub.mjs';
import { githubTokenHelpButton } from '../web/js/github-token-help.mjs';

for (const purpose of ['existing', 'create', 'source']) {
  test(`token help: ${purpose} opens a separate frame and Escape retains the unfinished form`, async (t) => {
    const dialog = await loadDialogModule();
    t.after(() => dialog.closeDialog());
    const form = dialog.node();
    const input = dialog.node('input');
    input.value = 'synthetic-secret-never-in-help';
    const help = githubTokenHelpButton({
      id: 'fixture-token', purpose, show: dialog.showDialog, dismiss: dialog.dismissDialog,
    });
    form.append(input, help);
    dialog.showDialog('Unfinished form', form);
    dialog.modal.querySelector('.modal-body').scrollTop = 81;
    help.click();
    assert.equal(help.getAttribute('aria-haspopup'), 'dialog');
    assert.match(readText(dialog.modal), /GitHub token help/);
    assert.doesNotMatch(readText(dialog.modal), /synthetic-secret-never-in-help/);
    assert.equal(dialog.modal.contains(input), false, 'the credential field stays in the retained parent, not the help overlay');
    const text = readText(dialog.modal);
    if (purpose === 'source') {
      assert.match(text, /Contents: Read-only/);
      assert.doesNotMatch(text, /Contents: Read and write|Administration: Read and write|All repositories/);
    } else if (purpose === 'create') {
      assert.match(text, /Administration: Read and write/);
      assert.match(text, /Discovery through readable repositories does not require write access/);
    } else {
      assert.match(text, /Contents: Read and write/);
      assert.match(text, /Only select repositories/);
      assert.doesNotMatch(text, /Administration: Read and write|All repositories/);
    }
    dialog.modal.dispatch('keydown', { key: 'Escape' });
    assert.equal(dialog.modal.open, true);
    assert.equal(dialog.modal.contains(input), true);
    assert.equal(input.value, 'synthetic-secret-never-in-help');
    assert.equal(dialog.modal.querySelector('.modal-body').scrollTop, 81);
    assert.match(readText(dialog.modal), /Unfinished form/);
  });
}
